import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { TaskRecord, TaskSource, WakerRecord } from '../types.ts';
import { MEMORY_SERVER, PI_AGENT_HOME, PI_BIN, POLICY_DIR } from './paths.ts';
import { loadWaker } from './registry.ts';
import { writeCompiledArtifacts } from './identity.ts';
import { createTask, updateTask, getTask } from '../scheduler/board.ts';
import { getEnabledSkills, skillDir } from './skills.ts';
import { appendProcOutput, finishProc, registerProc } from './procs.ts';
import { maybeCompact, runPiOnce } from './compact.ts';
import { lastRunError } from './sessionHistory.ts';
import { maybeAutoNameSession } from './sessionName.ts';
import { listSessions } from './sessions.ts';
import { acquire } from './queue.ts';
import { acquireSessionLock } from './sessionLock.ts';
import { keepAwakeWhile } from './power.ts';
import { withBrowserTools } from './browserTools.ts';

export interface RunOptions {
  wakerId: string;
  prompt: string;
  source: TaskSource;
  /** 整体超时毫秒，默认 10 分钟。 */
  timeoutMs?: number;
  groupRunId?: string;
  /**
   * pi 会话 ID。传入后同一员工的多次调用共享同一会话，
   * 从而实现"持续对话"而非每次都从零开始。
   */
  sessionId?: string;
  /** 平台会话 id，写入任务流水，供看板按会话聚合（与 pi 会话 id 不是一回事）。 */
  wakerSessionId?: string;
  /** 由哪条定时任务触发：写进任务流水，看板据此统计该任务的成功 / 失败次数。 */
  automationId?: string;
  /**
   * 要作为附件交给 pi 的本地文件**绝对路径**（图片、文档等）。
   *
   * 必须拼成**独立的 argv 位置参数** `@/abs/path`，不能写进 prompt 字符串：
   * 2026-10-31 实测 `-p "看下这张图 @/abs/x.png"` 的 user content 里只有 text、
   * input 仅 209 tokens —— `@` 引用写在 `-p` 的文本里**不会被解析**；
   * 而 `-p @/abs/x.png "看下这张图"` 才会生成 `{"type":"image","data":"iVBOR..."}`。
   *
   * 关键收益：内联发生在 pi 解析 argv 的阶段，**不经过 agent 的工具权限**。
   * 实测 `--no-tools` 时依然能看图，所以即使 waker 的 toolAllow 里没有 read，
   * 图片附件也不会被 pathAllow 拦掉。
   */
  attachments?: string[];
}

/** 单次执行的默认超时上限。渠道层（如飞书的"还在处理中"提示）会引用它，别各处写死。 */
export const DEFAULT_TIMEOUT = 10 * 60 * 1000;
const RESULT_MAX = 8000;

/**
 * 组装该员工 LLM 相关参数。**per-profile 配置优先**，缺省回落到 model 字段（auto 交给 pi 路由）。
 * 对应 pi 的 --provider / --model / --api-key / --thinking。
 */
export function llmArgs(rec: WakerRecord): string[] {
  const out: string[] = [];
  const llm = rec.def.llm;
  const model = llm?.model ?? rec.def.model;
  if (llm?.provider) out.push('--provider', llm.provider);
  if (model && model !== 'auto') out.push('--model', model);
  if (llm?.apiKey) out.push('--api-key', llm.apiKey);
  if (llm?.thinking) out.push('--thinking', llm.thinking);
  return out;
}

/**
 * 在 pi 的会话目录里找该工作目录下最近修改的会话文件。
 * 用于把任务流水与 pi 原生 JSONL 会话关联，便于事后回溯完整对话。
 */
function findLatestSession(cwd: string): string | null {
  const sessionsDir = join(PI_AGENT_HOME, 'sessions');
  if (!existsSync(sessionsDir)) return null;
  const slug = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  let best: { path: string; mtime: number } | null = null;
  try {
    for (const dir of readdirSync(sessionsDir)) {
      if (!dir.includes(slug.slice(0, 40))) continue;
      const full = join(sessionsDir, dir);
      if (!statSync(full).isDirectory()) continue;
      for (const f of readdirSync(full)) {
        if (!f.endsWith('.jsonl')) continue;
        const p = join(full, f);
        const mtime = statSync(p).mtimeMs;
        if (!best || mtime > best.mtime) best = { path: p, mtime };
      }
    }
  } catch {
    return null;
  }
  return best?.path ?? null;
}

/**
 * 拉起一次员工执行。
 *
 * 关键点：身份与策略**不通过命令行参数传递**，而是先落盘成编译产物，
 * 再通过环境变量告诉 Extension 去哪儿读。这样命令行保持干净，
 * 也避免了长提示词超出 argv 长度限制。
 */
export async function runWaker(opts: RunOptions): Promise<TaskRecord> {
  const rec = loadWaker(opts.wakerId);
  const task = createTask(opts.wakerId, opts.prompt, opts.source, { automationId: opts.automationId });

  if (!rec) {
    return updateTask(task.taskId, {
      status: 'failed',
      error: `未找到员工档案：${opts.wakerId}`,
      endedAt: new Date().toISOString(),
    })!;
  }
  if (!rec.def.enabled) {
    return updateTask(task.taskId, {
      status: 'cancelled',
      error: `员工 ${opts.wakerId} 已停用`,
      endedAt: new Date().toISOString(),
    })!;
  }

  // 取执行权：同一 pi 会话严格串行，超配额则排队（排队期间任务标成 queued）。
  // 独立任务（无 sessionId）不与他人争会话，用 taskId 做键即可。
  const lease = await acquire({
    key: opts.sessionId ?? `task:${task.taskId}`,
    wakerId: rec.def.id,
    taskId: task.taskId,
    onWait: () => {
      updateTask(task.taskId, {
        status: 'queued',
        groupRunId: opts.groupRunId,
        sessionId: opts.wakerSessionId,
      });
    },
  });
  if (!lease.granted) {
    // 排队期间被取消：直接收尾，不要拉起 pi
    return updateTask(task.taskId, {
      status: 'cancelled',
      endedAt: new Date().toISOString(),
      error: '排队期间被取消',
    })!;
  }

  // 再取跨进程锁：CLI（另一个 node 进程）与看板用的是同一个 pi 会话，进程内队列看不见它。
  // 独立任务无会话、不与任何人争，跳过这层（也省掉一堆无意义的锁文件）。
  let unlockCross: (() => void) | null = null;
  if (opts.sessionId) {
    try {
      const lock = await acquireSessionLock(opts.sessionId, {
        onWait: (holderPid) => {
          console.log(`会话 ${opts.sessionId} 被进程 ${holderPid ?? '未知'} 占用，等待中…`);
          // 让等待在看板上可见（否则任务一直显示"已到达"，看起来像卡住）
          if (getTask(task.taskId)?.status !== 'queued') updateTask(task.taskId, { status: 'queued' });
        },
      });
      unlockCross = lock.release;
    } catch (e) {
      lease.release();
      return updateTask(task.taskId, {
        status: 'failed',
        endedAt: new Date().toISOString(),
        error: (e as Error)?.message ?? String(e),
      })!;
    }
  }

  try {
    return await spawnRun(task, rec, opts);
  } finally {
    // 必须在 finally：抛异常也要放锁，否则该会话永久卡死
    unlockCross?.();
    lease.release();
  }
}

/**
 * 拿到执行权之后的实际执行：编译产物 → spawn pi → 回收输出 → 落状态。
 *
 * 与 runWaker 分开是为了让"排队/释放"与"执行"各自成段——锁的 acquire/release
 * 一旦和执行逻辑缠在一起，很容易在异常路径上漏掉 release。
 */
async function spawnRun(task: TaskRecord, rec: WakerRecord, opts: RunOptions): Promise<TaskRecord> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT;
  const startedAt = new Date().toISOString();

  // 编译产物必须在 spawn 之前写好：Extension 加载时就会读，晚一步即 fail-open
  writeCompiledArtifacts(rec);

  updateTask(task.taskId, {
    status: 'running',
    startedAt,
    groupRunId: opts.groupRunId,
    sessionId: opts.wakerSessionId,
  });

  // 附件必须排在 prompt **之前**，且各占一个 argv（pi 的用法是 `[@files...] [messages...]`）。
  // 理由见 RunOptions.attachments：写进 prompt 字符串不会被解析成图片。
  const args = ['-p'];
  for (const file of opts.attachments ?? []) args.push(`@${file}`);
  args.push(opts.prompt);
  if (opts.sessionId) args.push('--session-id', opts.sessionId);
  args.push(...llmArgs(rec));
  // 纳管的 Pi profile 自带工具白名单，按其声明复现工具集。
  // 注意：`--tools` 是**整体替换**活跃工具集（pi 的 setActiveToolsByName 只认注册表里存在的名字），
  // 所以扩展注册的自定义工具必须显式列进去，否则它会"注册了但模型看不见"。
  // 2026-10-14 实测踩到：开了 selfEdit、工具也注册成功，但因为白名单里没有 waker_self_edit，
  // 模型完全不知道有这个工具，开关形同虚设。
  if (rec.def.policy.toolAllow?.length) {
    let tools = [...rec.def.policy.toolAllow];
    if (rec.def.policy.selfEdit && !tools.includes('waker_self_edit')) tools.push('waker_self_edit');
    // 浏览器工具同理：`--tools` 是整体替换，不并进去 = 扩展注册了也看不见。
    if (rec.def.policy.browser) tools = withBrowserTools(tools);
    args.push('--tools', tools.join(','));
  }
  // 只加载该员工勾选的技能（未配置则沿用 pi 的默认发现，不改变既有行为）
  const skills = getEnabledSkills(rec.def.id);
  if (skills) {
    args.push('--no-skills');
    for (const s of skills) args.push('--skill', skillDir(s));
  }

  // 剥离宿主注入的 NODE_OPTIONS：IDE/终端可能通过它注入依赖外部路径的 shim
  // （如防误删保护），被原样带进 pi 子进程会导致其启动即报错，与业务无关。
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    WAKER_ID: rec.def.id,
    /**
     * 待办定位用：扩展在 `todo_add` 里把这两个值一起写进 todos.jsonl，
     * 看板点「定位到来源消息」时就能精确跳回这一轮对话（而不是只打开会话）。
     */
    WAKER_TASK_ID: task.taskId,
    ...(opts.wakerSessionId ? { WAKER_SESSION_ID: opts.wakerSessionId } : {}),
    WAKER_POLICY_DIR: POLICY_DIR,
    // 记忆中心：指向 waker 自带的 multi 实例，扩展据此按员工隔离记忆
    WAKER_MEMORY_SERVER: MEMORY_SERVER,
  };
  delete childEnv.NODE_OPTIONS;

  const child = spawn(PI_BIN, args, {
    cwd: rec.def.cwd,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // pid 必须**立即**落到任务流水：否则运行期间点"终止"拿不到 pid，取消形同虚设
  updateTask(task.taskId, { pid: child.pid ?? undefined });
  // 任务跑多久，Mac 就醒多久（caffeinate -w 绑定 pi 进程，退出即自动解除）
  keepAwakeWhile(child.pid, `${rec.def.id}/${opts.source}`);
  registerProc({
    taskId: task.taskId,
    wakerId: rec.def.id,
    source: opts.source,
    sessionId: opts.wakerSessionId,
    prompt: opts.prompt,
    pid: child.pid ?? undefined,
    child,
  });

  let stdout = '';
  let stderr = '';
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
    // 给优雅退出 5s，之后强杀
    setTimeout(() => child.kill('SIGKILL'), 5000).unref();
  }, timeoutMs);

  child.stdout.on('data', (d) => {
    const s = String(d);
    stdout += s;
    appendProcOutput(task.taskId, s);
  });
  child.stderr.on('data', (d) => {
    const s = String(d);
    stderr += s;
    appendProcOutput(task.taskId, s);
  });

  const exitCode = await new Promise<number | null>((resolvePromise) => {
    child.on('error', () => resolvePromise(null));
    child.on('close', (code) => resolvePromise(code));
  });

  clearTimeout(timer);
  finishProc(task.taskId);

  // 运行期间被外部终止：保留 cancelled 语义，不要被下面的成功/失败判定覆盖
  if (getTask(task.taskId)?.status === 'cancelled') {
    return updateTask(task.taskId, {
      endedAt: new Date().toISOString(),
      durationMs: Date.now() - new Date(startedAt).getTime(),
      result: stdout.trim().slice(0, RESULT_MAX) || undefined,
    })!;
  }

  // 门禁拦截明细由 guard 扩展打到 stderr，这里原样回收，便于排查策略配置错误
  const guardLog = stderr
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.includes('[waker-guard] 已拦截'));
  const blockedCount = guardLog.length;
  const endedAt = new Date().toISOString();
  const durationMs = new Date(endedAt).getTime() - new Date(startedAt).getTime();

  /**
   * 模型侧失败也要算失败：pi 遇到 provider 报错（400 上下文超限、鉴权失败…）时
   * 只往会话记录里写一条 `stopReason:"error"` 的 assistant 消息，**退出码仍是 0**。
   * 只判退出码会把这种轮次记成 success、result 为空，看板与用户各说一套（2026-11-07 事故）。
   */
  const modelError =
    !timedOut && exitCode === 0 && opts.sessionId
      ? lastRunError(opts.sessionId, new Date(startedAt).getTime())
      : null;

  const failed = timedOut || exitCode !== 0 || modelError !== null;
  const result = stdout.trim().slice(0, RESULT_MAX);

  // 任务结束顺手看一眼这个会话有多长：**不 await** —— 回复马上要发给用户。
  // 这里只做观测（一次 statSync，零 API 开销）；压缩由 pi 自己在装配上下文时完成，
  // 平台不再动会话文件（见 core/compact.ts 顶部：曾经"归档+种回"毁掉了用户记录）。
  if (opts.wakerSessionId) {
    void maybeCompact(rec, opts.wakerSessionId, llmArgs(rec))
      .then((r) => {
        if ('skipped' in r && r.skipped.startsWith('会话已')) {
          console.log(`[compact] ${rec.def.id}/${opts.wakerSessionId}：${r.skipped}`);
        }
      })
      .catch((e: unknown) => {
        console.error('[compact] 上下文观测失败:', (e as Error)?.message ?? e);
      });

    // 第 3 轮答复已给出：顺带让模型给这个会话起个名字，**不 await**（用户等的是答复）。
    // 轮次必须在这里算：调用方是在 runWaker 返回之后才 touchSession（那里会 +1）。
    if (!failed) {
      const session = listSessions(rec.def.id).find((s) => s.id === opts.wakerSessionId);
      if (session) {
        maybeAutoNameSession({
          rec,
          sessionId: session.id,
          round: session.messageCount + 1,
          args: ['--no-tools', '--no-skills', ...llmArgs(rec)],
          timeoutMs: 20_000,
          runOnce: runPiOnce,
        });
      }
    }
  }

  return updateTask(task.taskId, {
    status: failed ? 'failed' : 'success',
    endedAt,
    durationMs,
    pid: child.pid ?? undefined,
    sessionRef: findLatestSession(rec.def.cwd) ?? undefined,
    blockedCount,
    guardLog: guardLog.length ? guardLog.slice(0, 20) : undefined,
    result: result || undefined,
    error: failed
      ? timedOut
        ? `执行超时（${timeoutMs}ms）`
        : modelError
          ? `模型侧报错：${modelError.slice(0, 600)}`
          : `pi 退出码 ${exitCode ?? 'unknown'}：${stderr.slice(0, 500)}`
      : undefined,
  })!;
}

/** 只编译不执行，便于巡检档案问题。 */
export function compileOnly(wakerId: string): { ok: boolean; message: string } {
  const rec = loadWaker(wakerId);
  if (!rec) return { ok: false, message: `未找到员工档案：${wakerId}` };
  const { policyPath, promptPath } = writeCompiledArtifacts(rec);
  const errs = rec.issues.filter((i) => i.level === 'error');
  if (errs.length) return { ok: false, message: `已生成但存在错误：${errs.map((e) => e.message).join('; ')}` };
  return { ok: true, message: `已生成\n  策略: ${policyPath}\n  提示: ${promptPath}` };
}
