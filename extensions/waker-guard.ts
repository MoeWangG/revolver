/**
 * waker-guard — 权限门禁扩展
 *
 * Pi 内核默认 YOLO：`executePreparedToolCall` 对内置工具无条件执行，没有审批层。
 * 本扩展补上这道缺口，采用双通道：
 *
 *   通道一（策略拦截）：`tool_call` 事件返回 `{ block: true, reason }`，
 *           覆盖命令前缀白名单、命令黑名单、路径白/黑名单、高危人工确认。
 *   通道二（执行隔离）：注册同名 `bash` 覆盖内置实现，改走 `docker run --rm`，
 *           这是 Pi 独有能力（OpenCode 不可替换内置工具）。
 *
 * 两条通道叠加而非二选一：拦截在前，通过后才进入（可能的）沙箱执行。
 *
 * 环境变量：WAKER_ID、WAKER_POLICY_DIR（由 Runner 注入）。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { Ctx, ExtensionAPI, ToolCallEvent } from '@earendil-works/pi-coding-agent';

const WAKER_ID = process.env.WAKER_ID ?? '';
const POLICY_DIR = process.env.WAKER_POLICY_DIR ?? '';

interface Policy {
  wakerId: string;
  wakerName: string;
  cwd: string;
  toolAllow?: string[];
  toolDeny?: string[];
  commandAllow?: string[];
  commandDeny?: string[];
  pathAllow?: string[];
  pathDeny?: string[];
  requireConfirm?: string[];
  sandbox: boolean;
  sandboxImage?: string;
  sandboxNetwork?: boolean;
  commandTimeoutMs?: number;
  /** 是否允许该员工修改自己的档案（waker-selfedit 扩展提供工具）。 */
  selfEdit?: boolean;
  /** 是否允许该员工操作浏览器（browser-mcp 扩展提供 `browser` 工具）。 */
  browser?: boolean;
}

function loadPolicy(): Policy | null {
  if (!WAKER_ID || !POLICY_DIR) return null;
  const p = `${POLICY_DIR}/${WAKER_ID}.policy.json`;
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as Policy;
  } catch (e) {
    console.error('[waker-guard] 策略解析失败:', (e as Error)?.message ?? e);
    return null;
  }
}

const POLICY = loadPolicy();
const CWD = POLICY?.cwd ?? process.cwd();
/** 命令超时**上限**（策略值，硬天花板）。 */
const TIMEOUT_MS = POLICY?.commandTimeoutMs ?? 120_000;

/**
 * 本次命令实际使用的超时。
 *
 * **模型自己声明的 `timeout`（bash 工具参数，单位秒）优先**，但不得突破策略上限。
 * 之前这里被整个忽略，用的是模块级常量 —— 模型说"20 秒"，实际按策略跑 5~10 分钟。
 * 实测代价：一次全盘 grep（模型其实只给了 20s）跑满 300s，紧接着下一条命令又跑满剩余预算，
 * 10 分钟的任务超时被吃光，任务以「执行超时（600000ms）」结束，用户看到机器人哑掉十分钟。
 * 现在模型能给自己上保险：给 20s 就 20s 掐掉，它当场改小范围重试。
 */
function effectiveTimeoutMs(requested?: unknown): number {
  const n = typeof requested === 'number' ? requested : Number(requested);
  if (!Number.isFinite(n) || n <= 0) return TIMEOUT_MS;
  return Math.max(1000, Math.min(Math.round(n * 1000), TIMEOUT_MS));
}

/** 正在执行的子进程。外层（runner 超时）杀 pi 时顺手清掉， */
/** 否则 `sh -c` 孙进程会变孤儿继续跑 —— 一个全盘 grep 能拖垮整台机器。 */
const running = new Set<ChildProcess>();
process.on('SIGTERM', () => {
  for (const c of running) {
    try {
      c.kill('SIGKILL');
    } catch {
      /* 可能已退出 */
    }
  }
});

/** 相对路径按工作目录解析，绝对路径原样返回。 */
function absolutize(p: string): string {
  if (!p) return CWD;
  return p.startsWith('/') ? p : resolve(CWD, p);
}

function matchesAny(haystack: string, needles: string[] | undefined): boolean {
  if (!needles?.length) return false;
  const lower = haystack.toLowerCase();
  return needles.some((n) => n && lower.includes(String(n).toLowerCase()));
}

/**
 * 命令片段匹配：**按词边界**，不是裸子串。
 *
 * 裸子串会误伤，实测：黑名单里的 `"rm "` 命中了
 * `cd ~/work/platform && node x.mjs` 里的 `platfo|rm |`，
 * 于是该岗位在项目目录下执行任何命令都被判"包含被禁止的片段"。
 *
 * 现在要求片段两侧是"非单词字符"或字符串边界：`"rm "` 仍命中 `rm -rf /tmp`、`; rm x`，
 * 但不再命中 `platform ` / `form `。`-` 与 `_` 算单词字符（`rm-safe` 不是 `rm`）。
 *
 * 片段里的正则元字符会被转义——策略里本来就有 `:(){` 这种 fork-bomb 片段，
 * 当正则用会直接抛异常。
 */
function matchesFragment(haystack: string, needles: string[] | undefined): boolean {
  if (!needles?.length) return false;
  const lower = haystack.toLowerCase();
  return needles.some((n) => {
    const frag = String(n ?? '').trim().toLowerCase();
    if (!frag) return false;
    const esc = frag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^a-z0-9_-])${esc}($|[^a-z0-9_-])`).test(lower);
  });
}

function startsWithAny(cmd: string, prefixes: string[] | undefined): boolean {
  if (!prefixes?.length) return true;
  const trimmed = cmd.trim();
  return prefixes.some((p) => trimmed === p || trimmed.startsWith(`${p} `) || trimmed.startsWith(p));
}

/**
 * bash 命令里**不该按"凭据"拦**的 pathDeny 片段。
 *
 * 为什么单独列：`node_modules` 经常作为"排除路径"出现在完全正常的命令里
 * （find 的 -not -path 里就常写它），把它当凭据拦会误伤正常检索；
 * 而它本身不是机密，只是索引噪声。
 */
const BENIGN_PATH_FRAGMENTS = new Set(['node_modules']);

/** 供 bash 用的凭据片段（pathDeny 去掉纯目录噪声）。 */
function bashPathDeny(p: Policy): string[] {
  return (p.pathDeny ?? []).filter((f) => !BENIGN_PATH_FRAGMENTS.has(String(f).trim().toLowerCase()));
}

/**
 * 会碰文件系统路径的工具。
 *
 * 为什么要带上 `ls` / `grep` / `find`（2026-10-14 补）：它们同样是**读**路径的入口，
 * 只拦 read 等于把"读取范围"交给这几个工具随意穿透。
 */
const PATH_TOOLS = new Set(['read', 'write', 'edit', 'ls', 'grep', 'find']);

/** 判定一次工具调用是否放行。返回 null 表示放行，否则给出拦截理由。 */
function evaluate(event: ToolCallEvent): { block: true; reason: string } | null {
  const name = event.toolName;
  // **参数在 `event.input`**（pi 0.84 起的字段名），不是 `event.args`。
  // 2026-10-14 实测踩坑：旧代码读 `event.args` → 永远拿到 undefined →
  // 路径判定里的 target 退化成 cwd（`resolve(cwd, '')` 就是 cwd），而 cwd 通常在
  // pathAllow 之内 → **路径白名单静默失效**：`read /etc/hosts` 一路放行，blockedCount 还是 0。
  // 两个字段都认，避免版本差异再造成这种"看着有校验、其实没生效"。
  const args = ((event.input ?? event.args) ?? {}) as Record<string, unknown>;
  const p = POLICY;
  if (!p) return null;

  // 0. 档案自改工具单独判，**必须先于工具白名单**。
  // 为什么：开了 selfEdit 的岗位通常同时配了 toolAllow（里面只列内置工具），
  // 若走白名单那一步，waker_self_edit 会被"不在白名单内"拦掉，开关等于没开。
  // 它自己的可改范围由扩展强制（只有那五份档案，且写不了一份 waker.yaml）。
  if (name === 'waker_self_edit') {
    if (p.selfEdit) return null;
    return { block: true, reason: '该岗位未开启档案自改（policy.selfEdit=false），不能用 waker_self_edit' };
  }

  // 0.5 浏览器工具：同一个坑（必须在工具白名单之前判）。
  // 开了 browser 的岗位往往也配了 toolAllow（里面只列内置工具），走白名单会把浏览器工具
  // 全拦掉，表现为"工具注册了、模型也调了、但每次都被门禁拒绝"。
  // 参数维度不需要再查：浏览器工具不碰文件系统，也不执行 shell。
  // 名字判据要同时认 `browser`（@browsermcp/mcp 2.x 的单一工具）与旧的 `browser_*`
  // ——只认前缀时 2.x 的 `browser` 会掉进下面的 toolAllow 白名单，直接被拒。
  if (name === 'browser' || name.startsWith('browser_')) {
    if (p.browser) return null;
    return { block: true, reason: '该岗位未开启浏览器能力（policy.browser=false），不能用 browser' };
  }

  // 1. 工具维度
  if (matchesAny(name, p.toolDeny)) return { block: true, reason: `工具 ${name} 已被该岗位的策略明确禁用` };
  if (p.toolAllow?.length && !matchesAny(name, p.toolAllow)) {
    return { block: true, reason: `工具 ${name} 不在该岗位的工具白名单内（允许：${p.toolAllow.join(', ')}）` };
  }

  // 2. 命令维度（bash）
  // 注意：tool_call 事件触发时 args 可能尚未解析完整（参数流式到达），
  // 此时 command 取不到值。拿不到命令原文就放行，交由工具替换层兜底——
  // 那里拿到的 params 是完整解析后的，才是可靠的拦截点。
  if (name === 'bash') {
    const cmd = typeof args.command === 'string' ? args.command.trim() : '';
    if (!cmd) return null;
    if (matchesFragment(cmd, p.commandDeny)) {
      return { block: true, reason: `命令包含被禁止的片段，已拦截：${cmd.slice(0, 120)}` };
    }
    if (!startsWithAny(cmd, p.commandAllow)) {
      return { block: true, reason: `命令前缀不在白名单内，已拦截。允许前缀：${p.commandAllow?.join(', ')}` };
    }
    // 凭据保护对 bash 也要生效：`cat ~/.ssh/id_rsa` 走的是 bash，不是 read 工具，
    // 之前 pathDeny 只拦 read/write/edit —— 等于给凭据留了后门。
    // 但排除 BENIGN_PATH_FRAGMENTS（纯目录噪声，常在命令里作"排除路径"出现）。
    if (matchesFragment(cmd, bashPathDeny(p))) {
      return { block: true, reason: `命令里出现了受保护的凭据路径片段，已拦截：${cmd.slice(0, 120)}` };
    }
    if (matchesFragment(cmd, p.requireConfirm)) {
      return { block: true, reason: `该命令属于需人工确认的高危动作（${cmd.slice(0, 80)}），请由人在 CLI 侧确认后再执行` };
    }
  }

  // 3. 路径维度（read / write / edit / ls / grep / find）
  if (PATH_TOOLS.has(name)) {
    // 未传 path 的工具（ls / grep / find 的 path 是可选的）默认作用于 cwd：
    // 显式用 '.' 解析，避免再出现"空串被解析成 cwd"那种隐式兜底。
    const raw = typeof args.path === 'string' && args.path.trim() ? args.path : '.';
    const target = absolutize(raw);
    if (matchesAny(target, p.pathDeny)) {
      return { block: true, reason: `目标路径命中保护名单，已拦截：${target}` };
    }
    if (p.pathAllow?.length && !p.pathAllow.some((allowed) => target.startsWith(absolutize(allowed)))) {
      return { block: true, reason: `目标路径越出该岗位的可读写目录：${target}` };
    }
  }

  return null;
}

/**
 * 命令准入判定。返回 null 表示放行，否则返回拦截原因。
 *
 * 这个函数在**工具替换层**调用（而不是 tool_call 事件层），
 * 因为只有 execute 收到的 params 才是完整解析后的参数。
 */
function checkCommand(cmd: string): string | null {
  const p = POLICY;
  if (!p) return null;
  if (!cmd) return '命令为空';
  if (matchesFragment(cmd, p.commandDeny)) return `命令包含被禁止的片段：${cmd.slice(0, 120)}`;
  if (!startsWithAny(cmd, p.commandAllow)) return `命令前缀不在白名单内，允许：${p.commandAllow?.join(', ')}`;
  if (matchesFragment(cmd, bashPathDeny(p))) return `命令里出现了受保护的凭据路径片段：${cmd.slice(0, 120)}`;
  if (matchesFragment(cmd, p.requireConfirm)) return `属于需人工确认的高危动作：${cmd.slice(0, 80)}`;
  return null;
}

/** 本地执行。宿主侧以参数数组传递、不经过 shell，命令内部由 sh 解释。 */
function runLocal(command: string, timeoutMs: number): Promise<string> {
  return new Promise((resolvePromise) => {
    const child = spawn('sh', ['-c', command], { cwd: CWD, shell: false });
    running.add(child);
    let out = '';
    let err = '';
    let settled = false;
    const finish = (text: string): void => {
      if (settled) return;
      settled = true;
      running.delete(child);
      resolvePromise(text);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(
        `${out}${err}\n[waker-guard] 命令超时（${timeoutMs}ms）已终止。` +
          `若是全盘扫描/网络目录导致的，请缩小范围（-maxdepth、指定目录、限定文件类型）后重试。`,
      );
    }, timeoutMs);

    child.stdout.on('data', (d) => {
      out += String(d);
    });
    child.stderr.on('data', (d) => {
      err += String(d);
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      finish(`执行失败：${e.message}`);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const body = [out, err].filter(Boolean).join('');
      finish(code === 0 ? body || '(无输出)' : `${body}\n[exit code ${code}]`);
    });
  });
}

/** 在一次性容器中执行命令。无外网、只读挂载之外的写入随容器销毁。 */
function runInSandbox(command: string, timeoutMs: number): Promise<string> {
  const image = POLICY?.sandboxImage ?? 'alpine:3.20';
  const network = POLICY?.sandboxNetwork ? 'bridge' : 'none';
  // 参数以数组传递，宿主侧不经过 shell，避免命令注入
  const dockerArgs = [
    'run',
    '--rm',
    `-v`,
    `${CWD}:/work`,
    '-w',
    '/work',
    '--network',
    network,
    image,
    'sh',
    '-c',
    command,
  ];

  return new Promise((resolvePromise) => {
    const child = spawn('docker', dockerArgs, { shell: false, cwd: CWD });
    running.add(child);
    let out = '';
    let err = '';
    let settled = false;

    const finish = (text: string): void => {
      if (settled) return;
      settled = true;
      running.delete(child);
      resolvePromise(text);
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(`${out}${err}\n[waker-guard] 命令超时（${timeoutMs}ms）已终止`);
    }, timeoutMs);

    child.stdout.on('data', (d) => {
      out += String(d);
    });
    child.stderr.on('data', (d) => {
      err += String(d);
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      finish(`[waker-guard] 沙箱启动失败（Docker 是否运行？）：${e.message}`);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const body = [out, err].filter(Boolean).join('');
      finish(code === 0 ? body || '(无输出)' : `${body}\n[exit code ${code}]`);
    });
  });
}

export default function wakerGuard(pi: ExtensionAPI): void {
  if (!POLICY) {
    if (WAKER_ID) console.error(`[waker-guard] 未找到 ${WAKER_ID} 的策略文件，门禁未启用（fail-open，请检查 waker compile）`);
    return;
  }

  pi.on('tool_call', (event: ToolCallEvent, _ctx: Ctx) => {
    try {
      const verdict = evaluate(event);
      if (verdict) {
        // 外壳侧通过 stderr 统计拦截次数，写入任务流水
        console.error(`[waker-guard] 已拦截 ${event.toolName}: ${verdict.reason}`);
        return verdict;
      }
      return undefined;
    } catch (e) {
      console.error('[waker-guard] 判定异常:', (e as Error)?.message ?? e);
      return undefined;
    }
  });

  // 覆盖内置 bash：无论是否开沙箱都注册，因为这里是唯一能拿到完整参数的拦截点。
  // 参数签名必须与内置一致（command / timeout），否则模型按原签名传参会得到 undefined。
  pi.registerTool({
    name: 'bash',
    description: POLICY.sandbox
      ? '在隔离的 Docker 容器中执行 Shell 命令（无外网、随容器销毁）'
      : '执行 Shell 命令（受该岗位的命令白名单约束）',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的 shell 命令' },
        timeout: { type: 'number', description: '超时秒数' },
      },
      required: ['command'],
    },
    execute: async (_id: string, params: { command?: string; timeout?: number }) => {
      const cmd = (params?.command ?? '').trim();
      const reason = checkCommand(cmd);
      if (reason) {
        console.error(`[waker-guard] 已拦截 bash: ${reason}`);
        return { content: [{ type: 'text' as const, text: `命令被岗位策略拦截，不要换写法绕过：${reason}` }], details: {} };
      }
      // 模型给的超时优先（策略值是天花板）；没给就按策略跑
      const timeoutMs = effectiveTimeoutMs(params?.timeout);
      try {
        const text = POLICY.sandbox ? await runInSandbox(cmd, timeoutMs) : await runLocal(cmd, timeoutMs);
        return { content: [{ type: 'text' as const, text }], details: {} };
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `执行失败：${(e as Error)?.message ?? e}` }], details: {} };
      }
    },
  });

  // 命令名同样避开 memory / wal / guard
  pi.registerCommand('wg', {
    description: '显示当前岗位生效的权限策略摘要',
    execute: async (_args: string, ctx: Ctx) => {
      const p = POLICY;
      const lines = [
        `员工：${p.wakerName} (${p.wakerId})`,
        `工作目录：${p.cwd}`,
        `沙箱：${p.sandbox ? `开启 (${p.sandboxImage ?? 'alpine:3.20'}, network=${p.sandboxNetwork ? 'on' : 'off'})` : '关闭'}`,
        `命令白名单：${p.commandAllow?.join(', ') ?? '(不限)'}`,
        `路径白名单：${p.pathAllow?.join(', ') ?? '(不限)'}`,
        `档案自改：${p.selfEdit ? '已开启（waker_self_edit）' : '关闭'}`,
        `需人工确认：${p.requireConfirm?.join(' / ') ?? '(无)'}`,
      ];
      const msg = lines.join('\n');
      if (ctx?.hasUI && ctx.ui) ctx.ui.notify(msg, 'info');
      else console.log(msg);
    },
  });
}
