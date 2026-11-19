import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WakerRecord } from '../types.ts';
import { DATA_DIR, MEMORY_SERVER, PI_AGENT_HOME, PI_BIN, POLICY_DIR } from './paths.ts';
import { resolveSession } from './sessions.ts';
import { loadConfig, type ContextConfig } from './config.ts';
import { keepAwakeWhile } from './power.ts';

/**
 * 会话上下文压缩（瘦身）：**平台只观察与手动触发，实现交给 pi 原生 compaction。**
 *
 * ## 这里的教训（2026-10-11，务必保留这段）
 *
 * 平台原先自己实现压缩：摘要 → `clearSession` 把会话文件**改名归档** → 用同一个
 * `--session-id` 把纪要"种回"一个新会话。后果是**用户的对话记录整段消失**：
 * 界面里 199KB 历史只剩两条"上下文备忘"，归档那份还带 `.cleared-` 后缀不再被索引。
 * 用户的原话是「可以瘦身，但不能改我的对话记录，否则我脑子里的记忆也会消失；
 * 可以在对话记录中间加个压缩后的内容，下一轮加载 history 时从压缩内容刚开始加载」。
 *
 * 而这**就是 pi 原生的 compaction 语义**，且默认开启：
 * - 压缩时在**同一个** JSONL 里插一条 `type: "compaction"` 记录（`summary` 即压缩内容），
 *   之前的记录一条不删；
 * - 装配上下文时用 `getLatestCompactionEntry()` 找边界，**从压缩处之后**开始加载。
 *
 * 所以这里的职责收窄成三件事：
 * 1. `sessionSize` / `shouldCompact`：算 token、做**观测与提示**（不干预）；
 * 2. `compactSession`（`--force` / HTTP 强制压缩）：带 `WAKER_FORCE_COMPACT` 跑一次
 *    轻量 run，由 `extensions/waker-compact.ts` 调 `ctx.compact()` 触发原生压缩；
 * 3. 压缩后的摘要从**会话记录本身**读出来（compaction 记录里就有），落一份到
 *    `data/context/` 供人工核对。
 *
 * **任何情况下都不再改名、移动、删除用户的会话文件。**
 */
export interface CompactResult {
  piSessionId: string;
  /** 压缩内容（pi 写在会话记录里的那份摘要，原样读回）。 */
  memo: string;
  /** 归档的 pi 会话文件数——**恒为 0**：不再归档任何文件。 */
  archivedFiles: number;
  /** 压缩前的估算 token。 */
  tokensBefore: number;
  /** 压缩后的估算 token。 */
  tokensAfter: number;
  /** 摘要留档路径（data/context/<id>/ 下的 md）。 */
  memoPath: string;
}

export interface CompactSkip {
  skipped: string;
}

/** 强制压缩那次 run 的超时（只跑一次 LLM 摘要，通常十几秒）。 */
const FORCE_COMPACT_TIMEOUT_MS = 240_000;

/** 该 pi 会话 id 对应的 JSONL 文件（匹配规则与 `clearSession` 一致：`<ts>_<piSessionId>.jsonl`）。 */
function findSessionFiles(piSessionId: string): string[] {
  const root = join(PI_AGENT_HOME, 'sessions');
  const out: string[] = [];
  if (!existsSync(root)) return out;
  for (const dir of readdirSync(root)) {
    const full = join(root, dir);
    try {
      if (!statSync(full).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const f of readdirSync(full)) {
      if (f.endsWith(`_${piSessionId}.jsonl`)) out.push(join(full, f));
    }
  }
  return out;
}

export interface SessionSize {
  bytes: number;
  tokens: number;
  files: number;
  /** 估算口径：能读到 pi 记的 usage 就是权威值，否则退回字符估算。 */
  basis: 'usage' | 'chars' | 'bytes';
}

/**
 * 会话上下文大小。
 *
 * **口径必须跟 pi 一致，否则会误判**（2026-10-11 的教训）：
 * 旧实现按 `字节 / 3.5` 估，把 JSON 包裹、工具输出、thinking 段全算进去，
 * 于是一个真实 28,070 token 的会话被报成 56,920，直接触发了那次破坏性压缩。
 * 而 pi 自己判断要不要压缩时看的是：
 *   1. 最后一条 assistant 消息的 `usage.totalTokens`（它就是这么算的）；
 *   2. 拿不到 usage 时，用消息文本字符数 / 4 估算。
 * 所以这里按同样顺序取值——**宁可低估也不要虚高**，虚高会让人以为该压缩了。
 */
export function sessionSize(piSessionId: string): SessionSize {
  const files = findSessionFiles(piSessionId);
  let bytes = 0;
  for (const f of files) {
    try {
      bytes += statSync(f).size;
    } catch {
      /* 刚被归档走 */
    }
  }
  const base: SessionSize = { bytes, tokens: 0, files: files.length, basis: 'bytes' };
  if (!files.length) return base;

  // 取最新那个文件（与 sessionHistory 一致）
  let target = files[0] as string;
  let bestMtime = -1;
  for (const f of files) {
    try {
      const m = statSync(f).mtimeMs;
      if (m > bestMtime) {
        bestMtime = m;
        target = f;
      }
    } catch {
      /* 跳过读不到的文件 */
    }
  }

  let chars = 0;
  let usageTokens: number | null = null;
  try {
    for (const line of readFileSync(target, 'utf-8').split('\n')) {
      const t = line.trim();
      if (!t) continue;
      let e: Record<string, unknown>;
      try {
        e = JSON.parse(t) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (e.type !== 'message') continue;
      const msg = (e.message ?? {}) as { role?: string; content?: unknown; usage?: { totalTokens?: number } };
      if (msg.role === 'assistant' && typeof msg.usage?.totalTokens === 'number') {
        usageTokens = msg.usage.totalTokens; // 越靠后越新
      }
      const c = msg.content;
      if (typeof c === 'string') chars += c.length;
      else if (Array.isArray(c)) {
        for (const part of c) {
          if (!part || typeof part !== 'object') continue;
          const p = part as { text?: unknown; thinking?: unknown };
          if (typeof p.text === 'string') chars += p.text.length;
          if (typeof p.thinking === 'string') chars += p.thinking.length;
        }
      }
    }
  } catch {
    return base;
  }

  if (usageTokens !== null) return { bytes, tokens: usageTokens, files: files.length, basis: 'usage' };
  if (chars > 0) return { bytes, tokens: Math.round(chars / 4), files: files.length, basis: 'chars' };
  return { bytes, tokens: Math.round(bytes / 4), files: files.length, basis: 'bytes' };
}

/** 当前生效的瘦身参数。 */
export function compactConfig(): ContextConfig {
  return loadConfig().context;
}

/** 该会话是否已达到压缩阈值。 */
export function shouldCompact(piSessionId: string, cfg = compactConfig()): boolean {
  if (!cfg.enabled) return false;
  return sessionSize(piSessionId).tokens >= cfg.maxTokens;
}

/**
 * 从会话记录里读出最近一次压缩写入的摘要。
 *
 * 刻意**从记录本身**读，而不是自己再生成一份：pi 的 compaction 记录里
 * `summary` 就是它装配上下文时用的那份压缩内容，平台只是把它取出来给人看。
 * 这同时验证了两件事——记录里确实有一个"压缩节点"，且它前文一条没少。
 */
export interface CompactionNode {
  summary: string;
  tokensBefore: number;
  firstKeptEntryId: string | null;
  entryId: string | null;
  at: string | null;
}

export function readLastCompaction(piSessionId: string): CompactionNode | null {
  const files = findSessionFiles(piSessionId);
  if (!files.length) return null;
  // 取最新那个文件（与 sessionHistory 的定位规则一致）
  let target = files[0] as string;
  let bestMtime = -1;
  for (const f of files) {
    try {
      const m = statSync(f).mtimeMs;
      if (m > bestMtime) {
        bestMtime = m;
        target = f;
      }
    } catch {
      /* 跳过读不到的文件 */
    }
  }
  let node: CompactionNode | null = null;
  try {
    for (const line of readFileSync(target, 'utf-8').split('\n')) {
      const t = line.trim();
      if (!t.includes('"compaction"')) continue;
      try {
        const e = JSON.parse(t) as Record<string, unknown>;
        if (e.type !== 'compaction') continue;
        node = {
          summary: typeof e.summary === 'string' ? e.summary : '',
          tokensBefore: typeof e.tokensBefore === 'number' ? e.tokensBefore : 0,
          firstKeptEntryId: typeof e.firstKeptEntryId === 'string' ? e.firstKeptEntryId : null,
          entryId: typeof e.id === 'string' ? e.id : null,
          at: typeof e.timestamp === 'string' ? e.timestamp : typeof e.at === 'string' ? e.at : null,
        };
      } catch {
        /* 坏行跳过 */
      }
    }
  } catch {
    return null;
  }
  return node;
}

/**
 * 跑一次 pi 并回收输出。平台内部的一次性调用：不带会话、不带工具、不加载技能。
 *
 * 供 compact 与 sessionSummary 复用。**注意它默认不带 `--session-id`**，
 * 也就是每次都是一段全新的上下文——这正是"机器调用"想要的：
 * 既不污染用户会话，也不会把全量历史当成输入。
 */
export function runPiOnce(
  rec: WakerRecord,
  args: string[],
  prompt: string,
  timeoutMs: number,
  extraEnv: Record<string, string> = {},
): Promise<{ out: string; err: string }> {
  return new Promise((resolvePromise) => {
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      WAKER_ID: rec.def.id,
      WAKER_POLICY_DIR: POLICY_DIR,
      WAKER_MEMORY_SERVER: MEMORY_SERVER,
      // 这是平台内部的机器调用，不该沉淀成用户记忆
      WAKER_MEMORY_NO_EXTRACT: '1',
      // **必须带上 extraEnv**（2026-10-14 的坑：这里漏了它，于是 `WAKER_FORCE_COMPACT`
      // 永远传不进 pi 子进程 → `waker-compact` 扩展静默不触发 → 强制压缩"看起来跑了但什么都没发生"，
      // 而且连一行错误都没有，排查时完全靠猜。加个环境变量就该在 childEnv 里，别无第二处。
      ...extraEnv,
    };
    delete childEnv.NODE_OPTIONS;
    const child = spawn(PI_BIN, [...args, '-p', prompt], { cwd: rec.def.cwd, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    // 压缩要跑一次完整的 LLM 调用（动辄几十秒），同样别让 Mac 睡过去
    keepAwakeWhile(child.pid, `compact/${rec.def.id}`);
    let out = '';
    let err = '';
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolvePromise({ out: out.trim(), err: err.trim() });
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000).unref();
      finish();
    }, timeoutMs);
    child.stdout.on('data', (d) => {
      out += String(d);
    });
    child.stderr.on('data', (d) => {
      err += String(d);
    });
    child.on('error', () => {
      clearTimeout(timer);
      finish();
    });
    child.on('close', () => {
      clearTimeout(timer);
      if (!out.trim() && err.trim()) console.error(`[compact] pi 无输出，stderr：${err.trim().slice(0, 300)}`);
      finish();
    });
  });
}

/**
 * 手动强制压缩（`waker compact --force` / `POST /api/agents/:id/compact`）。
 *
 * 做法：**不自己压缩**，而是带 `WAKER_FORCE_COMPACT` 跑一次轻量 run，
 * 由 `extensions/waker-compact.ts` 在会话开始时调 pi 原生 `ctx.compact()`。
 * 压缩完成后从**会话记录本身**读出那份摘要（compaction 节点），落档供人工核对。
 *
 * 整个过程**不写、不改名、不删除任何会话文件**。
 */
export async function compactSession(
  rec: WakerRecord,
  platformSessionId: string,
  piArgs: string[],
): Promise<CompactResult | CompactSkip> {
  const session = resolveSession(rec.def.id, platformSessionId);
  const piSessionId = session.piSessionId;
  const before = sessionSize(piSessionId);
  if (!before.files) return { skipped: `会话 ${platformSessionId} 没有可压缩的历史文件` };

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = join(DATA_DIR, 'context', rec.def.id);
  mkdirSync(dir, { recursive: true });
  const memoPath = join(dir, `${platformSessionId}-${stamp}.md`);

  // 记下压缩前已有的节点，便于回执里说清"这次到底有没有压"
  const prevNode = readLastCompaction(piSessionId);

  const { out, err } = await runPiOnce(
    rec,
    ['--session-id', piSessionId, '--no-tools', '--no-skills', ...piArgs],
    '（平台触发上下文压缩：这轮不需要你回答任何内容，压缩完成后直接结束即可。）',
    FORCE_COMPACT_TIMEOUT_MS,
    { WAKER_FORCE_COMPACT: piSessionId },
  );

  const node = readLastCompaction(piSessionId);
  if (!node) {
    // 走到这里说明 pi 没写出压缩节点。**别自己编原因**（曾经写过"pi 判定还不需要压缩"，
    // 而真实原因可能是 cwd 不对、压到一半被打断、或"整段就是一整轮、无法切分"），
    // 把 pi 自己的输出原样带回来，排查才有依据。
    const size = sessionSize(piSessionId);
    // **out 与 err 都要带上**：只显示其中之一会被模型那句"收到"遮住真正的错误
    //（2026-10-14 踩过：压缩其实失败了，但回执里只看到模型的正常回答，白查半天）。
    const clean = (s: string): string => s.replace(/\s+/g, ' ').trim();
    const errPart = clean(err).slice(0, 400);
    const outPart = clean(out).slice(0, 160);
    return {
      skipped:
        `pi 未写入压缩节点（当前约 ${size.tokens} token，按 ${size.basis} 估算）。` +
        (errPart ? `pi stderr：${errPart}` : '') +
        (outPart ? `｜pi stdout：${outPart}` : '') +
        (!errPart && !outPart ? '（pi 无任何输出）' : '') +
        ' 常见原因：① 会话还小（pi 保留最近约 2 万 token）；② 整段上下文集中在一轮里、' +
        'pi 不从一轮中间切；③ pi 进程 cwd 与会话所属 cwd 不一致；④ 压缩被中断（进程提前退出）。',
    };
  }
  if (prevNode?.entryId && node.entryId === prevNode.entryId) {
    const said = (out || err || '').replace(/\s+/g, ' ').trim().slice(0, 160);
    return {
      skipped:
        '压缩没有产生新的压缩节点（记录未变化，通常是刚压过、pi 认为当前没有可切的历史）' +
        (said ? `｜pi 输出：${said}` : ''),
    };
  }

  const after = sessionSize(piSessionId);
  writeFileSync(
    memoPath,
    [
      '# 会话上下文压缩留档',
      '',
      `- 员工：${rec.def.id}`,
      `- 平台会话：${platformSessionId}（pi: ${piSessionId}）`,
      `- 时间：${new Date().toISOString()}`,
      `- 压缩前：约 ${before.tokens} token（${before.bytes} 字节）`,
      `- 压缩后：约 ${after.tokens} token（${after.bytes} 字节）`,
      `- 压缩节点：${node.entryId ?? '(未知)'}${node.at ? ` @ ${node.at}` : ''}`,
      `- 保留的近期条目起点：${node.firstKeptEntryId ?? '(无)'}`,
      '',
      '> 这份摘要由 pi 写入会话记录的 compaction 节点，**对话记录一条未删**；',
      '> 本文件只是留档，方便人工核对压了什么。',
      '',
      '---',
      '',
      node.summary,
      '',
    ].join('\n'),
    'utf-8',
  );

  return {
    piSessionId,
    memo: node.summary,
    archivedFiles: 0,
    tokensBefore: node.tokensBefore || before.tokens,
    tokensAfter: after.tokens,
    memoPath,
  };
}

/**
 * 任务结束后调它：**只观测，不干预**。
 *
 * 压缩由 pi 在装配上下文时自己判断并执行（阈值 = 模型上下文窗口 − reserveTokens，
 * 见 pi 的 DEFAULT_COMPACTION_SETTINGS），平台的任务后置钩子没有需要动手的地方——
 * 唯一有价值的是：超过平台自己的告警线时留一条日志，让人知道这个会话已经很长了。
 */
export async function maybeCompact(
  rec: WakerRecord,
  platformSessionId: string | undefined,
  _piArgs: string[],
): Promise<CompactResult | CompactSkip> {
  if (!platformSessionId) return { skipped: '独立任务无会话' };
  const cfg = compactConfig();
  if (!cfg.enabled) return { skipped: '平台侧上下文告警已关闭（config.context.enabled=false）' };
  const session = resolveSession(rec.def.id, platformSessionId);
  if (!shouldCompact(session.piSessionId, cfg)) return { skipped: '未达告警线' };
  const size = sessionSize(session.piSessionId);
  return {
    skipped:
      `会话已 ${size.tokens} token（超过告警线 ${cfg.maxTokens}）：` +
      '压缩由 pi 自行完成，对话记录只增不减（用 waker compact --force 可立刻压）',
  };
}
