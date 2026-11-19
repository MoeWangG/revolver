import { channelManager } from '../channels/manager.ts';
import { runWaker } from '../core/runner.ts';
import { createSession, resolveSession, touchSession } from '../core/sessions.ts';
import { getTodo, listTodos, updateTodo } from '../core/todos.ts';
import type { TaskRecord, TodoRecord } from '../types.ts';

/** 扫描间隔。到期精度到分钟级够用，30s 也不会给本机带来负担。 */
const TICK_MS = 30_000;

let timer: NodeJS.Timeout | null = null;
/** 上一轮还没跑完就不叠下一轮（runWaker 可能排队很久）。 */
let ticking = false;

export function startTodoScheduler(): void {
  if (timer) return;
  timer = setInterval(() => void tick(), TICK_MS);
  timer.unref?.();
  void tick();
}

export function stopTodoScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    await runDueAgentTodos();
  } catch (e) {
    console.error('[todos] 扫描失败:', (e as Error)?.message ?? e);
  } finally {
    ticking = false;
  }
}

/** 组装给 agent 的 prompt：只给任务本身，要求直接做、直接交付。 */
function buildPrompt(t: TodoRecord): string {
  return [
    '这是你之前给自己留下的一条任务，现在到点了。',
    '直接执行，不要反问「要我做吗」；做完用一两句话说明做了什么、结果如何。',
    '',
    `任务：${t.title}`,
    ...(t.detail ? ['', `说明：${t.detail}`] : []),
  ].join('\n');
}

async function notifyResult(t: TodoRecord, task: TaskRecord): Promise<void> {
  if (!t.externalKey) return;
  const ok = task.status === 'success';
  const body = ok ? task.result ?? '(无输出)' : task.error ?? '执行失败（无原因）';
  const text = [`⏰ **任务到期：${t.title}**`, '', body].join('\n');
  const sent = await channelManager.notify(t.wakerId, t.externalKey, text);
  if (!sent) {
    // 回发失败不影响任务本身；日志留痕，看板里仍能看到结果。
    console.log(`[todos] 结果未能回发到 ${t.externalKey}（渠道未连接或未配置）`);
  }
}

/**
 * 执行所有已到点的 agent 待办。
 *
 * 与人类待办的差别：**agent 任务不提前提醒，只在 dueAt 到点后跑**；
 * 人类待办的「到期」窗口（提前一天变橙）是给眼睛看的，不是给执行器看的。
 */
export async function runDueAgentTodos(now: Date = new Date()): Promise<number> {
  const nowMs = now.getTime();
  const due = listTodos({ assignee: 'agent', status: 'pending', now }).filter((t) => {
    const at = Date.parse(t.dueAt);
    return Number.isFinite(at) && at <= nowMs;
  });

  let ran = 0;
  for (const item of due) {
    // 二次确认：上一轮 tick 可能已经把它标成 running/done，避免同一任务跑两遍
    if (getTodo(item.id)?.status !== 'pending') continue;

    updateTodo(item.id, { status: 'running' });
    ran += 1;

    const t = getTodo(item.id)!;
    const session = t.sessionId
      ? resolveSession(t.wakerId, t.sessionId)
      : createSession(t.wakerId, `任务·${t.title}`);

    let task: TaskRecord;
    try {
      task = await runWaker({
        wakerId: t.wakerId,
        prompt: buildPrompt(t),
        source: 'cron',
        sessionId: session.piSessionId,
        wakerSessionId: session.id,
      });
    } catch (e) {
      updateTodo(t.id, {
        status: 'failed',
        error: (e as Error)?.message ?? String(e),
        sessionId: session.id,
      });
      await notifyResult(t, {
        taskId: '',
        wakerId: t.wakerId,
        source: 'cron',
        status: 'failed',
        prompt: '',
        createdAt: new Date().toISOString(),
        error: (e as Error)?.message ?? String(e),
      });
      continue;
    }

    touchSession(t.wakerId, session.id, 2);
    const ok = task.status === 'success';
    updateTodo(t.id, {
      status: ok ? 'done' : 'failed',
      doneAt: ok ? new Date().toISOString() : undefined,
      taskId: task.taskId,
      result: task.result?.slice(0, 4000) || undefined,
      error: task.error,
      sessionId: session.id,
    });
    await notifyResult(getTodo(t.id)!, task);
  }
  return ran;
}
