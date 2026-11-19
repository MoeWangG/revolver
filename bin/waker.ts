#!/usr/bin/env -S node --experimental-strip-types
/**
 * waker — 本地数字员工平台命令行入口
 *
 * 设计取向：所有能力都能在终端完成，Web 看板只是可选的可视化层。
 * 这保证"能被我操控"这一诉求不依赖任何 GUI。
 */
import { spawn } from 'node:child_process';
import {
  PLATFORM_ROOT,
  AGENTS_DIR,
  DATA_DIR,
  POLICY_DIR,
  BROKER_PID_FILE,
  PI_AGENTS_DIR,
  PI_BIN,
  MEMORY_SERVER,
  agentDir,
  ensureDirs,
} from '../src/core/paths.ts';
import { writeCompiledArtifacts } from '../src/core/identity.ts';
import { createWaker } from '../src/core/create.ts';
import { importPiWaker, importLine, importTips, listImportablePiAgents } from '../src/core/importPi.ts';
import { compactConfig, compactSession, sessionSize } from '../src/core/compact.ts';
import { CONFIG_FILE, configFileExists, loadConfig, saveConfig } from '../src/core/config.ts';
import { keepAwakeWhile } from '../src/core/power.ts';
import { loadAllWakers, loadWaker } from '../src/core/registry.ts';
import { describeWaker } from '../src/core/identity.ts';
import { runWaker, compileOnly, llmArgs } from '../src/core/runner.ts';
import { listTasks, buildSnapshot } from '../src/scheduler/board.ts';
import { createAutomation, loadAutomations } from '../src/scheduler/cron.ts';
import { startGateway } from '../src/gateway/http.ts';
import { linkExtensions } from '../src/core/link.ts';
import { DEFAULT_BROKER_PORT, probeBroker, startBroker, type BrokerStatus } from '../src/core/browserBroker.ts';
import { runMcpStdio } from '../src/core/browserStdio.ts';
import {
  listSessions,
  createSession,
  resolveSession,
  touchSession,
  clearSession,
  deleteSession,
  isDeletable,
} from '../src/core/sessions.ts';
import { deleteMemory, findSuspicious, formatRow, listMemories } from '../src/core/memoryAdmin.ts';
import { acquireSessionLock } from '../src/core/sessionLock.ts';
import { isEditable, writeAgentFile } from '../src/core/files.ts';
import { EDITABLE_FILES } from '../src/types.ts';
import { appendFileSync, existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [, , cmd = 'help', ...rest] = process.argv;

/** 看板地址（CLI 与看板是同机的两个进程；需要"常驻状态"的命令走 HTTP 问看板）。 */
const BOARD_URL = process.env.WAKER_BOARD_URL ?? 'http://127.0.0.1:8787';

function printHelp(): void {
  console.log(`waker — 本地数字员工平台（内核：Pi）

用法:
  waker agent list                     列出全部员工
  waker agent inspect <id>             查看单个员工的档案与诊断
  waker agent new <id> [--role "职责"] [--cwd 目录]   创建员工（立即可用）
  waker import [<piId>] [--cwd 目录]   列出 / 导入本机的 Pi agent 为平台员工
  waker config [<key> <value>]         平台开关（piAgents: 是否自动纳管 Pi 侧 agent，默认 off）
  waker compile <id>                   编译身份与策略产物（不执行）
  waker chat <id> [--new|--session <sid>]       与该员工交互式对话（--new 新开会话）
  waker say <id> "<message>" [--session <sid>]  说一句话（默认会话或指定会话）
  waker sessions <id>                  列出该员工的全部会话
  waker sessions <id> --clear <sid>    清空该会话上下文（保留会话；默认会话只能清空不能删）
  waker sessions <id> --delete <sid>   删除会话（默认会话除外）
  waker compact <id> [--session <sid>] [--force] [--status]  会话瘦身（压成纪要，默认按阈值判断）
  waker identity <id>                  看档案自改开关、备份版本与最近留痕
  waker identity <id> restore <文件> [时间戳片段]  回滚某份档案（员工自改改坏了用）
  waker power [on|off|status]          常驻防睡眠开关（挂在看板进程上，看板退出即释放）
  waker browser [start|stop|status|mcp-stdio] [--port 8790]  浏览器通道（Chrome 扩展 → 常驻 broker → agent / CodeBuddy）
  waker channels                       列出各员工配置的渠道（飞书）
  waker run <id> "<prompt>"            执行一次独立任务（不进会话）
  waker cron add <id> "<cron>" "<prompt>"   注册定时任务
  waker cron list                      列出定时任务
  waker tasks [n]                      查看最近任务
  waker memory review [--ns <ns>]      列出记忆库里的可疑条目（可能已过期/碎片）
  waker memory rm <id>...              按 id 删除记忆
  waker memory rm --transient --yes    批量删除可疑条目
  waker board [--port 8787]            启动看板与调度器
  waker doctor                         环境与依赖自检
  waker link                           软链扩展到 ~/.pi/agent/extensions/

示例:
  waker agent new reviewer
  waker run reviewer "检查 src/core 下的错误处理是否完整"
  waker cron add reviewer "0 9 * * *" "生成昨日代码变更简报"
`);
}

function cmdAgentList(): void {
  const all = loadAllWakers();
  if (!all.length) {
    console.log(`还没有任何员工。用 \`waker agent new <id>\` 创建，档案目录：${AGENTS_DIR}`);
    return;
  }
  for (const rec of all) {
    const d = rec.def;
    const flag = d.enabled ? '启用' : '停用';
    const errs = rec.issues.filter((i) => i.level === 'error').length;
    console.log(`${d.id.padEnd(16)} ${d.name.padEnd(16)} ${flag}  沙箱:${d.policy.sandbox ? '开' : '关'}  ${errs ? `错误${errs}` : ''}`);
    console.log(`${''.padEnd(16)} ${d.role}`);
  }
}

function cmdAgentInspect(id: string): void {
  const rec = loadWaker(id);
  if (!rec) {
    console.error(`未找到员工：${id}`);
    process.exit(1);
  }
  console.log(JSON.stringify(describeWaker(rec), null, 2));
}

/**
 * 列出 / 导入本机的 Pi agent。
 *
 * 不带 id 时**只列清单**，不批量导入：导入意味着"这个我要长期维护"，
 * 顺手把一堆 agent 全导进来只会让名册重新变乱。
 */
function cmdImport(id: string | undefined, inline: { cwd?: string; list: boolean }): void {
  if (!id || inline.list) {
    const items = listImportablePiAgents();
    if (!items.length) {
      console.log(`本机没有 Pi agent（目录：${PI_AGENTS_DIR}）`);
      return;
    }
    console.log('本机 Pi agent：');
    for (const b of items) console.log(`  ${importLine(b)}`);
    console.log(`\n导入：waker import <id> [--cwd 目录]（导入后在 agents/<id>/ 生成平台档案，Pi 侧文件保留）`);
    return;
  }

  const { rec } = importPiWaker(id, { cwd: inline.cwd });
  console.log(`已导入员工：${rec.def.name}（${rec.def.id}）`);
  console.log(`  岗位：${rec.def.role}`);
  for (const t of importTips(rec)) console.log(`  · ${t}`);
  console.log(`\n现在就能对话：waker chat ${rec.def.id}`);
}

/**
 * 会话瘦身：把长上下文压成纪要。
 *
 * 默认按阈值判断（未达阈值只报告不压），`--force` 强制压，`--status` 只看大小不动手。
 * 自动瘦身在每次任务结束后按同一套阈值跑，这个命令是手动/排障入口。
 */
async function cmdCompact(id: string, inline: { session?: string; force: boolean; status: boolean }): Promise<void> {
  const rec = loadWaker(id);
  if (!rec) {
    console.error(`未找到员工：${id}`);
    process.exit(1);
  }
  const session = resolveSession(id, inline.session);
  const cfg = compactConfig();
  const size = sessionSize(session.piSessionId);
  console.log(`员工 ${id} · 会话 ${session.id}（${session.name}）`);
  console.log(`  上下文：约 ${size.tokens} token（${size.bytes} 字节 / ${size.files} 个文件）`);
  console.log(`  阈值：超 ${cfg.maxTokens} 触发，压到 ${cfg.keepTokens}；自动瘦身${cfg.enabled ? '已开' : '已关'}`);
  if (inline.status) return;

  if (!inline.force && size.tokens < cfg.maxTokens) {
    console.log('  未达阈值，不压缩（要强制压：--force）');
    return;
  }
  console.log('  开始压缩（调用 pi 原生压缩：记录里插一个压缩节点，历史一条不删）…');
  const r = await compactSession(rec, session.id, llmArgs(rec));
  if ('skipped' in r) {
    console.log(`  跳过：${r.skipped}`);
    return;
  }
  console.log(`  完成：${r.tokensBefore} token → 压缩内容 ${r.memo.length} 字（写进会话记录，历史完整保留）`);
  console.log(`  摘要留档：${r.memoPath}`);
  const after = sessionSize(r.piSessionId);
  console.log(`  现在上下文：约 ${after.tokens} token（下一轮从压缩节点之后开始加载）`);
}

/** 平台级开关（目前只有"是否自动纳管 Pi 侧 agent"）。 */
function cmdConfig(key?: string, value?: string): void {
  if (!key) {
    const c = loadConfig();
    console.log(`配置文件：${CONFIG_FILE}${configFileExists() ? '' : '（尚未创建，当前全是默认值）'}`);
    console.log(`  piAgents  ${c.piAgents ? 'on ' : 'off'}  自动纳管 Pi 侧 agent（~/.pi/agent/agents/*.md）`);
    console.log('\n改：waker config piAgents on|off');
    return;
  }
  if (key !== 'piAgents') {
    console.error(`未知配置项：${key}（可用：piAgents）`);
    process.exit(1);
  }
  if (!value) {
    console.log(loadConfig().piAgents ? 'on' : 'off');
    return;
  }
  const v = ['on', 'true', '1', 'yes'].includes(value)
    ? true
    : ['off', 'false', '0', 'no'].includes(value)
      ? false
      : null;
  if (v === null) {
    console.error('取值只能是 on / off');
    process.exit(1);
  }
  const c = saveConfig({ piAgents: v });
  console.log(`已更新：piAgents = ${c.piAgents ? 'on' : 'off'}`);
  if (c.piAgents) {
    console.log('注意：打开后 Pi 侧全部 agent 会以只读（Pi 徽标）形式出现在名册里。');
    console.log('      如果只是想用其中某一个，建议用 waker import 逐个导入（导入后可改策略、可归档）。');
  }
}

/**
 * 创建员工档案。
 *
 * 支持 `--role` / `--cwd` 直接把岗位写进档案，避免创建出来是个
 * "请填写岗位职责" 的空壳、还得手动改 YAML 才能用。
 * 创建后立即编译，省掉一步，做到"创建完就能对话"。
 */
function cmdAgentNew(id: string, inline: { role?: string; cwd?: string; name?: string }): void {
  // 创建逻辑在 core/create.ts，与 HTTP 网关共用，避免两条路径分叉
  const rec = createWaker({ id, role: inline.role, cwd: inline.cwd, name: inline.name });
  const dir = agentDir(id);
  const hasRole = Boolean(inline.role?.trim());

  console.log(`已创建员工：${dir}`);
  console.log(`  岗位：${rec.def.role}`);
  console.log(`  工作目录：${rec.def.cwd}`);
  if (!hasRole) {
    console.log(`\n提示：未指定 --role，档案是占位内容。可直接编辑 ${dir}/identity.md，或重建时带上：`);
    console.log(`  waker agent new ${id} --role "你要它做的事" --cwd "${rec.def.cwd}"`);
  }
  console.log(`\n现在就能对话：waker chat ${id}`);
  console.log(`或单轮：      waker say ${id} "你好"`);
}

/**
 * 交互式对话：把终端交给 pi 的 TUI，身份与门禁照常生效。
 *
 * 关键点是用 `--session-id waker-<id>` 给每个员工固定一个会话，
 * 这样每次 chat 都是"同一个人"在跟你说话，而不是每次重新开始。
 */
interface ChatOptions {
  /** 不绑定会话，pi 开一个全新临时会话（用完即弃）。 */
  fresh?: boolean;
  /** 指定已有会话 id。 */
  sessionId?: string;
  /** 新建一个会话再进入。 */
  newSession?: boolean;
}

async function cmdChat(id: string, opts: ChatOptions): Promise<void> {
  const rec = loadWaker(id);
  if (!rec) {
    console.error(`未找到员工：${id}`);
    process.exit(1);
  }
  writeCompiledArtifacts(rec);

  // pi 在非 TTY 下会自动降级为 print 模式（只输出一次就退出）。
  // 与其让用户以为"起不来"，不如提前讲清楚。
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log('当前不是交互终端，pi 会降级为单次输出。要真正对话请在终端里运行本命令，或用：');
    console.log(`  waker say ${id} "你要说的话"\n`);
  }

  // 会话解析：--new 新建；--session <id> 指定；否则落到默认会话
  const session = opts.newSession ? createSession(id) : resolveSession(id, opts.sessionId);
  console.log(`会话：${session.name}（${session.id}）`);

  const args: string[] = [];
  if (!opts.fresh) args.push('--session-id', session.piSessionId);
  args.push(...llmArgs(rec));
  if (rec.def.policy.toolAllow?.length) args.push('--tools', rec.def.policy.toolAllow.join(','));

  // 与 runner.ts 一致：剥离宿主注入的 NODE_OPTIONS，避免无关 shim 干扰 pi
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    WAKER_ID: id,
    WAKER_POLICY_DIR: POLICY_DIR,
    WAKER_MEMORY_SERVER: MEMORY_SERVER,
  };
  delete env.NODE_OPTIONS;

  // 交互式对话会长时间占着会话，先拿跨进程锁——否则"CLI 在聊、看板也在聊同一个会话"
  // 会同时写同一个 pi 会话文件（进程内队列管不到这种情况，因为它们是两个进程）。
  let unlockCross: (() => void) | null = null;
  if (!opts.fresh) {
    try {
      const lock = await acquireSessionLock(session.piSessionId, {
        waitMs: 60_000,
        onWait: (holderPid) => console.log(`会话正被进程 ${holderPid ?? '未知'} 占用，等待中（最多 60s）…`),
      });
      unlockCross = lock.release;
    } catch (e) {
      console.error((e as Error)?.message ?? String(e));
      console.error('可以换一个会话继续：waker chat ' + id + ' --new');
      process.exit(1);
    }
  }

  const child = spawn(PI_BIN, args, {
    cwd: rec.def.cwd,
    env,
    stdio: 'inherit', // TUI 直接接管终端
  });
  // 交互会话同样是长跑，别让 Mac 半路睡着
  keepAwakeWhile(child.pid, `chat/${rec.def.id}`);

  return new Promise((resolvePromise) => {
    child.on('exit', () => {
      unlockCross?.();
      resolvePromise();
    });
  });
}

/** 单轮对话：在指定会话里说一句，保留上下文，适合脚本调用。 */
async function cmdSay(id: string, message: string, opts: ChatOptions): Promise<void> {
  const session = opts.newSession ? createSession(id) : resolveSession(id, opts.sessionId);
  const task = await runWaker({
    wakerId: id,
    prompt: message,
    source: 'cli',
    sessionId: opts.fresh ? undefined : session.piSessionId,
    wakerSessionId: session.id,
  });
  touchSession(id, session.id);
  if (task.blockedCount) {
    console.log(`门禁拦截：${task.blockedCount} 次`);
    for (const line of task.guardLog ?? []) console.log(`  · ${line}`);
  }
  if (task.result) console.log(`\n${task.result}`);
  if (task.status === 'failed') {
    console.error(`\n失败：${task.error}`);
    process.exit(1);
  }
}

/** 列出员工的全部会话。 */
function cmdSessions(id: string): void {
  if (!loadWaker(id)) {
    console.error(`未找到员工：${id}`);
    process.exit(1);
  }
  const list = listSessions(id);
  console.log(`员工 ${id} 的会话（${list.length}）：`);
  for (const s of list) {
    const at = s.lastActiveAt.slice(0, 19).replace('T', ' ');
    console.log(`  ${s.id.padEnd(10)} ${s.name.padEnd(18)} 消息 ${String(s.messageCount).padStart(3)}  最近 ${at}`);
  }
}

/** 从参数数组里取 `--flag value` 的值。 */
function pickFlag(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

/** 列出各员工配置的渠道（只读配置，不建立连接）。 */
function cmdChannels(): void {
  const rows: string[] = [];
  // 一个飞书应用只能由一个员工接入：重复的只会有先者真正连上，其余在启动时被拒
  const ownerOfApp = new Map<string, string>();
  for (const rec of loadAllWakers()) {
    const fs = rec.def.channels?.feishu;
    if (!fs) continue;
    const appId = fs.appId?.trim();
    let warn = '';
    if (fs.enabled && appId) {
      const owner = ownerOfApp.get(appId);
      if (owner) warn = `   ⚠ appId 与「${owner}」重复，此员工不会接入（一个飞书应用只能由一个员工使用）`;
      else ownerOfApp.set(appId, rec.def.id);
    }
    rows.push(
      `  ${rec.def.id.padEnd(16)} 飞书 ${(fs.enabled ? '启用' : '停用').padEnd(4)} agent=${(fs.agent ?? rec.def.id).padEnd(14)} appId=${fs.appId ?? '(未配)'} secret=${fs.appSecret ? '已配' : '未配'}${warn}`,
    );
  }
  if (!rows.length) {
    console.log('没有员工配置渠道。在 agents/<id>/waker.yaml 的 channels.feishu 下配置，密钥放同目录 secrets.json。');
    return;
  }
  console.log('已配置的渠道：');
  console.log(rows.join('\n'));
  console.log('\n渠道随 `waker board` 一起启动；运行状态见看板或 GET /api/channels。');
}

function cmdTasks(n = '20'): void {
  const tasks = listTasks({ limit: Number(n) || 20 });
  if (!tasks.length) {
    console.log('暂无任务记录');
    return;
  }
  for (const t of tasks) {
    const dur = t.durationMs ? `${(t.durationMs / 1000).toFixed(1)}s` : '-';
    const blocked = t.blockedCount ? ` 拦截${t.blockedCount}` : '';
    console.log(`${t.status.padEnd(9)} ${t.wakerId.padEnd(14)} ${t.source.padEnd(5)} ${dur.padStart(7)}${blocked}  ${t.prompt.slice(0, 60)}`);
  }
}

function cmdCronList(): void {
  const list = loadAutomations();
  if (!list.length) {
    console.log('暂无定时任务');
    return;
  }
  for (const a of list) {
    const triggers = a.triggers.map((t) => (t.kind === 'cron' ? t.cron : t.kind === 'once' ? `once@${t.at}` : t.kind)).join(',');
    console.log(`${a.id.slice(0, 8)}  ${a.name.padEnd(20)} ${a.wakerId.padEnd(14)} [${triggers}]  已跑${a.runCount ?? 0}次 ${a.enabled ? '' : '(停用)'}`);
  }
}

async function cmdDoctor(): Promise<void> {
  const snap = await buildSnapshot();
  const { health } = snap;
  const line = (label: string, ok: boolean, hint: string): void => {
    console.log(`${ok ? '✓' : '✗'} ${label.padEnd(16)} ${ok ? '正常' : hint}`);
  };
  line('pi', health.pi, '未找到 pi 可执行文件，请检查 PATH');
  line('docker', health.docker, '未运行，沙箱将不可用（策略里 sandbox: false 可忽略）');
  line('memory-server', health.memoryServer, '未启动，跨会话记忆不生效（执行 scripts/bootstrap.sh）');
  console.log(`\n数据目录：${DATA_DIR}`);
  console.log(`员工目录：${AGENTS_DIR}`);
  console.log(`策略产物：${POLICY_DIR}`);
  console.log(`员工数量：${loadAllWakers().length}`);
}

/**
 * 记忆库运维：`review` 挑出可疑条目（人工判断），`rm` 删除。
 *
 * 刻意**不做**自动 TTL：记忆一旦入库就会被反复注入后续会话，误删长期记忆的代价
 * 远大于多留几条垃圾。先用"抽取侧约束 + 人工审阅"把问题压住，见 memoryAdmin.ts。
 */
async function cmdMemory(args: string[]): Promise<void> {
  const sub = args[0];

  if (sub === 'review') {
    const ns = pickFlag(args, '--ns');
    const limitIdx = args.indexOf('--limit');
    const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) || 2000 : 2000;
    const rows = await listMemories({ namespace: ns, limit });
    const suspects = findSuspicious(rows);
    const list = args.includes('--all') ? rows.map((row) => ({ row, why: '（--all 全量列出）' })) : suspects;
    console.log(`共 ${rows.length} 条记忆${ns ? `（归属 ${ns}）` : ''}；可疑 ${suspects.length} 条\n`);
    for (const s of list) console.log(`  ${formatRow(s.row)}   ← ${s.why}`);
    if (!list.length) {
      console.log('  没有可疑条目。');
      return;
    }
    console.log('\n逐条删：waker memory rm <id> ...');
    if (suspects.length && !args.includes('--all')) console.log('批量删：waker memory rm --transient --yes');
    return;
  }

  if (sub === 'rm') {
    if (args.includes('--transient')) {
      if (!args.includes('--yes')) {
        console.log('批量删除需显式确认：waker memory rm --transient --yes');
        return;
      }
      const suspects = findSuspicious(await listMemories({}));
      let n = 0;
      for (const s of suspects) {
        if (await deleteMemory(s.row.id)) n += 1;
      }
      console.log(`已删除 ${n} 条可疑记忆`);
      return;
    }
    const ids = args.slice(1).filter((a) => !a.startsWith('--'));
    if (!ids.length) return printHelp();
    let ok = 0;
    for (const id of ids) {
      if (await deleteMemory(id)) ok += 1;
    }
    console.log(`已删除 ${ok}/${ids.length} 条`);
    return;
  }

  printHelp();
}

/**
 * 档案自改的查看与回滚入口。
 *
 * 员工自己改档案时（`waker_self_edit`），平台会把旧版本备份到
 * `data/identity-history/<id>/`、每次修改记一行到 `data/selfedit.jsonl`。
 * 这个命令是那两处落盘的**唯一读取口**——没有它，备份就只是"写了不读"的摆设：
 * 员工改坏了自己的 SOUL，人却只能自己去翻目录找文件。
 */
function cmdIdentity(id: string, sub: string | undefined, args: string[]): void {
  const rec = loadWaker(id);
  if (!rec) {
    console.error(`未找到员工：${id}`);
    process.exit(1);
  }
  const dir = join(DATA_DIR, 'identity-history', id);
  const audit = join(DATA_DIR, 'selfedit.jsonl');

  // —— 回滚：restore <file> [<时间戳片段>] ——
  if (sub === 'restore') {
    const file = args[0] ?? '';
    if (!isEditable(file)) {
      console.error(`只能回滚这几份：${EDITABLE_FILES.join(' / ')}（waker.yaml 不在其中）`);
      process.exit(1);
    }
    if (!existsSync(dir)) {
      console.error(`没有 ${id} 的档案备份目录：${dir}`);
      process.exit(1);
    }
    const cands = readdirSync(dir)
      .filter((f) => f.startsWith(`${file}.`) && f.endsWith('.bak'))
      .sort();
    if (!cands.length) {
      console.error(`没有 ${file} 的历史备份`);
      process.exit(1);
    }
    const needle = args[1];
    const picked = needle ? cands.filter((f) => f.includes(needle)).pop() : cands[cands.length - 1];
    if (!picked) {
      console.error(`没有匹配 "${args[1]}" 的备份。可选：\n  ${cands.join('\n  ')}`);
      process.exit(1);
    }
    const content = readFileSync(join(dir, picked), 'utf-8');
    writeAgentFile(id, file, content); // 平台的正规写入口：写完顺手重新编译
    appendFileSync(
      audit,
      `${JSON.stringify({
        at: new Date().toISOString(),
        wakerId: id,
        file,
        action: 'restore',
        from: picked,
        by: 'cli',
      })}\n`,
      'utf-8',
    );
    console.log(`已回滚 ${id}/${file} ← ${picked}（已重新编译，下一个任务生效）`);
    return;
  }

  // —— 默认：看清单 + 最近留痕 ——
  console.log(`员工 ${id} · 档案自改`);
  console.log(`  开关：${rec.def.policy.selfEdit ? '已开启（有 waker_self_edit 工具）' : '关闭'}`);
  console.log(`  档案目录：${agentDir(id)}`);
  console.log(`  备份目录：${dir}${existsSync(dir) ? '' : '（还没有备份）'}`);

  if (existsSync(dir)) {
    const files = readdirSync(dir).filter((f) => f.endsWith('.bak'));
    if (files.length) {
      const byFile = new Map<string, string[]>();
      for (const f of files.sort()) {
        // 备份名是 `<档案名>.<时间戳>.bak`，而档案名本身带点（MEMORY.md），
        // 所以只能去掉末尾两段（时间戳 + bak），不能按第一个点切
        const name = f.split('.').slice(0, -2).join('.');
        byFile.set(name, [...(byFile.get(name) ?? []), f]);
      }
      console.log('\n  可回滚的版本：');
      for (const [name, list] of byFile) {
        console.log(`    ${name}：${list.length} 份，最新 ${list[list.length - 1]}`);
      }
      console.log(`  回滚：waker identity ${id} restore <文件名> [时间戳片段]`);
    }
  }

  if (existsSync(audit)) {
    const mine = readFileSync(audit, 'utf-8')
      .split('\n')
      .filter((l) => l.includes(`"${id}"`))
      .slice(-5);
    if (mine.length) {
      console.log('\n  最近留痕：');
      for (const line of mine) {
        try {
          const e = JSON.parse(line) as {
            at?: string;
            file?: string;
            action?: string;
            bytesBefore?: number;
            bytesAfter?: number;
            reason?: string;
          };
          const when = (e.at ?? '').slice(0, 19).replace('T', ' ');
          const size = e.action === 'restore' ? '回滚' : `${e.bytesBefore ?? 0}→${e.bytesAfter ?? 0} 字节`;
          console.log(`    ${when} ${e.file} ${size}${e.reason ? `：${e.reason}` : ''}`);
        } catch {
          /* 坏行跳过 */
        }
      }
    }
  }
}

/**
 * 常驻防睡眠开关。
 *
 * **为什么 CLI 不自己起 caffeinate**：断言绑的是持有它的进程 pid（`-w`），
 * CLI 跑完就退出、断言跟着消失——等于点了个开关又立刻自己关掉。
 * 所以这个开关必须挂在**常驻的看板进程**上，CLI 只通过 HTTP 去改它。
 */
async function cmdPower(sub: string | undefined): Promise<void> {
  const action = (sub ?? 'status').trim().toLowerCase();
  if (!['on', 'off', 'status'].includes(action)) {
    console.error('用法：waker power [on|off|status]');
    process.exit(1);
  }
  const url = `${BOARD_URL}/api/power`;
  type Status = {
    supported: boolean;
    enabled: boolean;
    active: boolean;
    pid?: number;
    since?: string;
    note?: string;
  };

  const show = (s: Status): void => {
    const state = s.active
      ? `生效中（pid ${s.pid}${s.since ? `，自 ${s.since.slice(0, 19).replace('T', ' ')}` : ''}）`
      : s.enabled
        ? '开关是开的，但断言没在跑'
        : '已关闭';
    console.log(`常驻防睡眠：${state}`);
    console.log(`  这台机器是否支持：${s.supported ? '是' : '否'}`);
    if (s.note) console.log(`  说明：${s.note}`);
    console.log('  边界：只防空闲睡眠；合盖睡眠是系统强制的，软件拦不住。');
    if (s.active) console.log('  验证：pmset -g assertions | grep -i caffeinate');
  };

  try {
    const res =
      action === 'status'
        ? await fetch(url)
        : await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ preventSleep: action === 'on' }),
          });
    const body = (await res.json()) as Status & { error?: string };
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    show(body);
  } catch (e) {
    console.error(`连不上看板（${BOARD_URL}）：${(e as Error)?.message ?? e}`);
    console.error('常驻断言必须挂在看板进程上（CLI 自己退出就释放了）。先起看板：waker board 或 launchctl kickstart。');
    process.exit(1);
  }
}

/**
 * `waker browser ...` —— 浏览器 broker 的启停与自检。
 *
 * 这里不执行任何浏览器动作（那些在 broker 的 HTTP 接口上），只负责
 * "把唯一的那份连接管起来"，并把状态讲清楚：上游活着没、扩展连了没。
 */
async function cmdBrowser(args: string[]): Promise<void> {
  const sub = args[0] ?? 'status';
  const portIdx = args.indexOf('--port');
  const port = portIdx >= 0 ? Number(args[portIdx + 1]) || DEFAULT_BROKER_PORT : DEFAULT_BROKER_PORT;

  if (sub === 'mcp-stdio') {
    await runMcpStdio(port);
    return;
  }

  if (sub === 'status') {
    const st = await probeBroker(port);
    if (!st) {
      console.log(`broker 未运行（127.0.0.1:${port}）。`);
      console.log('  · 起：waker browser start          （前台，Ctrl+C 退出）');
      console.log('  · 或：waker browser start --detach （后台）');
      console.log('  未运行时 agent 调 browser 工具会明确报"浏览器桥不可达"，不会静默失败。');
      return;
    }
    printBrokerStatus(st, port);
    return;
  }

  if (sub === 'start') {
    const existing = await probeBroker(port);
    if (existing) {
      console.log(`broker 已在运行（127.0.0.1:${port}）。`);
      printBrokerStatus(existing, port);
      return;
    }

    if (args.includes('--detach')) {
      const entry = process.argv[1];
      if (!entry) {
        console.error('无法定位 waker 入口（process.argv[1] 为空）');
        process.exit(1);
      }
      const child = spawn(
        process.execPath,
        [...process.execArgv, entry, 'browser', 'start', '--port', String(port)],
        { detached: true, stdio: 'ignore' },
      );
      child.unref();
      writeFileSync(BROKER_PID_FILE, String(child.pid ?? ''), 'utf-8');
      console.log(`broker 已后台启动（pid ${child.pid}，端口 ${port}）。`);
      console.log('下一步：确认 Chrome 已打开、Browser MCP 扩展已启用（2.x 的扩展连常驻 daemon 9010，不用点 Connect）。');
      return;
    }

    const broker = await startBroker({ port });
    writeFileSync(BROKER_PID_FILE, String(process.pid), 'utf-8');
    console.log(`broker 前台运行中（pid ${process.pid}，端口 ${broker.port}）。`);
    const shutdown = (): void => {
      void broker.close().then(() => {
        try {
          unlinkSync(BROKER_PID_FILE);
        } catch {
          /* 可能已被清掉 */
        }
        process.exit(0);
      });
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    // 常驻：直到收到信号（broker 自己管 HTTP 与上游生命周期）
    await new Promise<void>(() => {});
    return;
  }

  if (sub === 'stop') {
    const st = await probeBroker(port);
    if (!st) {
      console.log('broker 没在运行。');
      return;
    }
    // 优先 /shutdown：它会先杀上游；否则 9009 会被孤儿占着，下次启动又互相 kill
    try {
      await fetch(`http://127.0.0.1:${port}/shutdown`, {
        method: 'POST',
        signal: AbortSignal.timeout(3000),
      });
    } catch {
      /* 允许失败，下面按 pid 兜底 */
    }
    await new Promise((r) => setTimeout(r, 300));
    if (await probeBroker(port)) {
      try {
        const pid = Number(readFileSync(BROKER_PID_FILE, 'utf-8').trim());
        if (pid) process.kill(pid, 'SIGTERM');
      } catch {
        /* 没有 pid 文件就到此为止 */
      }
    }
    try {
      unlinkSync(BROKER_PID_FILE);
    } catch {
      /* ignore */
    }
    console.log('已停止 broker。');
    return;
  }

  console.error('用法：waker browser [start|stop|status|mcp-stdio] [--port 8790]');
  process.exit(1);
}

function printBrokerStatus(st: BrokerStatus, port: number): void {
  const ext = st.upstream.extensionConnected;
  const extText =
    ext === null ? '未验证（还没调用过）' : ext ? '已连接' : '未连接 → 确认 Chrome 已打开、Browser MCP 扩展已启用';
  console.log(`broker  http://127.0.0.1:${port}（已运行 ${Math.round(st.uptimeMs / 1000)}s）`);
  console.log(`  上游  ${st.upstream.command} ${st.upstream.args.join(' ')}`);
  console.log(`        pid=${st.upstream.pid ?? '-'} alive=${st.upstream.alive ? '是' : '否'}`);
  console.log(`  扩展  ${extText}`);
  console.log(`  队列  执行中=${st.queue.active ? '是' : '否'} 排队=${st.queue.waiting}/${st.queue.limit}`);
  console.log(`  超时  ${st.callTimeoutMs}ms`);
  if (st.upstream.lastError) console.log(`  最近错误  ${st.upstream.lastError}`);
}

async function main(): Promise<void> {
  ensureDirs();

  switch (cmd) {
    case 'agent':
      if (rest[0] === 'list') cmdAgentList();
      else if (rest[0] === 'inspect' && rest[1]) cmdAgentInspect(rest[1]);
      else if (rest[0] === 'new' && rest[1]) {
        const pick = (flag: string): string | undefined => {
          const i = rest.indexOf(flag);
          return i >= 0 ? rest[i + 1] : undefined;
        };
        cmdAgentNew(rest[1], { role: pick('--role'), cwd: pick('--cwd'), name: pick('--name') });
      }
      else printHelp();
      break;
    case 'import':
      cmdImport(rest[0], { cwd: pickFlag(rest, '--cwd'), list: rest.includes('--list') });
      break;
    case 'config':
      cmdConfig(rest[0], rest[1]);
      break;
    case 'compile': {
      if (!rest[0]) return printHelp();
      const r = compileOnly(rest[0]);
      console.log(r.message);
      if (!r.ok) process.exit(1);
      break;
    }
    case 'chat': {
      if (!rest[0]) return printHelp();
      await cmdChat(rest[0], {
        fresh: rest.includes('--fresh'),
        newSession: rest.includes('--new'),
        sessionId: pickFlag(rest, '--session'),
      });
      break;
    }
    case 'say': {
      if (!rest[0] || !rest[1]) return printHelp();
      const sid = pickFlag(rest, '--session');
      const opts: ChatOptions = { fresh: rest.includes('--fresh'), newSession: rest.includes('--new'), sessionId: sid };
      const message = rest
        .slice(1)
        .filter((x) => !x.startsWith('--') && x !== sid)
        .join(' ');
      await cmdSay(rest[0], message, opts);
      break;
    }
    case 'sessions': {
      if (!rest[0]) return printHelp();
      const clearId = pickFlag(rest, '--clear');
      if (clearId) {
        const r = clearSession(rest[0], clearId);
        console.log(
          r.ok ? `已清空会话 ${clearId}（归档 ${r.files} 个 pi 会话文件，会话本身保留）` : `未找到会话：${clearId}`,
        );
        if (!r.ok) process.exit(1);
        break;
      }
      const delId = pickFlag(rest, '--delete');
      if (delId) {
        if (!isDeletable(delId)) {
          console.error('默认会话是兜底会话，删除后会被立刻重建；要重置上下文请用 --clear。');
          process.exit(1);
        }
        console.log(deleteSession(rest[0], delId) ? `已删除会话 ${delId}` : `未找到会话：${delId}`);
        break;
      }
      cmdSessions(rest[0]);
      break;
    }
    case 'channels': {
      cmdChannels();
      break;
    }
    case 'identity': {
      if (!rest[0]) return printHelp();
      cmdIdentity(rest[0], rest[1], rest.slice(2));
      break;
    }
    case 'power':
      await cmdPower(rest[0]);
      break;
    case 'browser':
      await cmdBrowser(rest);
      break;
    case 'compact': {
      if (!rest[0]) return printHelp();
      await cmdCompact(rest[0], {
        session: pickFlag(rest, '--session'),
        force: rest.includes('--force'),
        status: rest.includes('--status'),
      });
      break;
    }
    case 'run': {
      if (!rest[0] || !rest[1]) return printHelp();
      const task = await runWaker({ wakerId: rest[0], prompt: rest.slice(1).join(' '), source: 'cli' });
      console.log(`\n状态：${task.status}${task.error ? `（${task.error}）` : ''}`);
      if (task.blockedCount) {
        console.log(`门禁拦截：${task.blockedCount} 次`);
        for (const line of task.guardLog ?? []) console.log(`  · ${line}`);
      }
      if (task.result) console.log(`\n${task.result}`);
      if (task.status === 'failed') process.exit(1);
      break;
    }
    case 'cron':
      if (rest[0] === 'list') cmdCronList();
      else if (rest[0] === 'add' && rest[1] && rest[2] && rest[3]) {
        const a = createAutomation({
          name: `${rest[1]} 定时`,
          wakerId: rest[1],
          promptTemplate: rest.slice(3).join(' '),
          triggers: [{ kind: 'cron', cron: rest[2] }],
          enabled: true,
        });
        console.log(`已注册定时任务 ${a.id.slice(0, 8)}：${a.name}`);
      } else printHelp();
      break;
    case 'tasks':
      cmdTasks(rest[0] ?? '20');
      break;
    case 'memory':
      await cmdMemory(rest);
      break;
    case 'board': {
      const portIdx = rest.indexOf('--port');
      const port = portIdx >= 0 ? Number(rest[portIdx + 1]) || 8787 : 8787;
      startGateway({ port, host: '127.0.0.1', withScheduler: true });
      break;
    }
    case 'doctor':
      await cmdDoctor();
      break;
    case 'link':
      linkExtensions();
      break;
    default:
      printHelp();
  }
}

main().catch((e) => {
  console.error('执行失败:', (e as Error)?.message ?? e);
  process.exit(1);
});

export { PLATFORM_ROOT };
