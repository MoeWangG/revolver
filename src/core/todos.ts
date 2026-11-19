import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { TaskSource, TodoAssignee, TodoPhase, TodoRecord, TodoStatus } from '../types.ts';
import { DATA_DIR, TODOS_FILE } from './paths.ts';

/** 距截止多久开始算「到期」（橙黄提醒）。默认提前一天。 */
export const DUE_LEAD_MS = 24 * 60 * 60 * 1000;
/** 「稍后提醒」默认顺延时长。 */
export const DEFAULT_SNOOZE_MS = 24 * 60 * 60 * 1000;

function ensureFile(): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  if (!existsSync(TODOS_FILE)) writeFileSync(TODOS_FILE, '', 'utf-8');
}

/** 读全部待办，坏行跳过（与 tasks.jsonl 的容错风格一致）。 */
export function readTodos(): TodoRecord[] {
  ensureFile();
  const raw = readFileSync(TODOS_FILE, 'utf-8');
  const out: TodoRecord[] = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as TodoRecord);
    } catch {
      /* 忽略坏行：一条脏数据不该让整个待办区打不开 */
    }
  }
  return out;
}

/** JSONL 无法原地改，读-改-写全量（待办量级小，可忽略开销）。 */
function writeTodos(list: TodoRecord[]): void {
  ensureFile();
  writeFileSync(TODOS_FILE, `${list.map((t) => JSON.stringify(t)).join('\n')}${list.length ? '\n' : ''}`, 'utf-8');
}

/**
 * 派生阶段：到期 / 过期**不存库**，由 dueAt 与当前时间算。
 *
 * 入库就要后台定时扫库改状态，服务没开时状态还会停在旧值；
 * 纯函数也没有"哪台机器时钟不对"之外的失败模式，便于单测。
 */
export function todoPhase(
  t: Pick<TodoRecord, 'status' | 'dueAt'>,
  now: Date = new Date(),
  leadMs: number = DUE_LEAD_MS,
): TodoPhase {
  if (t.status !== 'pending') return t.status;
  const due = Date.parse(t.dueAt);
  if (!Number.isFinite(due)) return 'pending';
  const ms = now.getTime();
  if (ms > due) return 'overdue';
  if (ms >= due - leadMs) return 'due';
  return 'pending';
}

/**
 * 顺延后的截止时刻。
 *
 * 以「现在」和「原截止」中**较晚**的那个为基准：已经过期的任务点「+1 天」，
 * 应该是从现在起算一天，而不是把过期时间往后挪一天（那可能仍是过期）。
 */
export function nextSnoozeAt(dueAt: string, nowMs: number, addMs: number = DEFAULT_SNOOZE_MS): string {
  const due = Date.parse(dueAt);
  const base = Number.isFinite(due) && due > nowMs ? due : nowMs;
  return new Date(base + addMs).toISOString();
}

/** 列表排序：过期最前，其次到期、执行中、未到期，最后是终态。 */
const PHASE_RANK: Record<TodoPhase, number> = {
  overdue: 0,
  due: 1,
  running: 2,
  pending: 3,
  failed: 4,
  done: 5,
  dismissed: 6,
};

export interface TodoFilter {
  wakerId?: string;
  assignee?: TodoAssignee;
  status?: TodoStatus;
  /** 只看已到/已过期的（供调度器与看板角标用）。 */
  dueOnly?: boolean;
  limit?: number;
  now?: Date;
}

export function listTodos(filter: TodoFilter = {}): TodoRecord[] {
  const now = filter.now ?? new Date();
  let list = readTodos();
  if (filter.wakerId) list = list.filter((t) => t.wakerId === filter.wakerId);
  if (filter.assignee) list = list.filter((t) => t.assignee === filter.assignee);
  if (filter.status) list = list.filter((t) => t.status === filter.status);
  if (filter.dueOnly) {
    list = list.filter((t) => {
      const p = todoPhase(t, now);
      return p === 'due' || p === 'overdue';
    });
  }
  list.sort((a, b) => {
    // 归档态按完成时间倒序（最近处理的在上）；活跃项按 dueAt 升序
    const pa = todoPhase(a, now);
    const pb = todoPhase(b, now);
    const ra = PHASE_RANK[pa];
    const rb = PHASE_RANK[pb];
    if (ra !== rb) return ra - rb;
    if (pa === 'done' || pa === 'dismissed') {
      return (b.doneAt ?? b.updatedAt ?? b.createdAt) < (a.doneAt ?? a.updatedAt ?? a.createdAt) ? -1 : 1;
    }
    return a.dueAt < b.dueAt ? -1 : a.dueAt > b.dueAt ? 1 : 0;
  });
  return filter.limit ? list.slice(0, filter.limit) : list;
}

export interface CreateTodoInput {
  wakerId: string;
  title: string;
  /** ISO8601。人类可读格式由调用方（扩展 / 前端）先规范化。 */
  dueAt: string;
  assignee?: TodoAssignee;
  detail?: string;
  source?: TaskSource;
  sessionId?: string;
  externalKey?: string;
  /** 留下它的那轮任务 id（用于跳回对话里的具体一条消息）。 */
  sourceTaskId?: string;
}

export function createTodo(input: CreateTodoInput): TodoRecord {
  if (!Number.isFinite(Date.parse(input.dueAt))) {
    throw new Error(`无法识别的截止时间：${input.dueAt}（需要 ISO8601）`);
  }
  const now = new Date().toISOString();
  const todo: TodoRecord = {
    id: randomUUID(),
    wakerId: input.wakerId,
    assignee: input.assignee ?? 'human',
    title: input.title.trim(),
    detail: input.detail?.trim() || undefined,
    dueAt: new Date(input.dueAt).toISOString(),
    status: 'pending',
    source: input.source ?? 'web',
    createdAt: now,
    updatedAt: now,
    sessionId: input.sessionId,
    externalKey: input.externalKey,
    sourceTaskId: input.sourceTaskId,
  };
  ensureFile();
  writeFileSync(TODOS_FILE, `${JSON.stringify(todo)}\n`, { encoding: 'utf-8', flag: 'a' });
  return todo;
}

export function getTodo(id: string): TodoRecord | null {
  return readTodos().find((t) => t.id === id) ?? null;
}

export function updateTodo(id: string, patch: Partial<TodoRecord>): TodoRecord | null {
  const list = readTodos();
  const idx = list.findIndex((t) => t.id === id);
  if (idx === -1) return null;
  const next = { ...list[idx]!, ...patch, updatedAt: new Date().toISOString() };
  list[idx] = next;
  writeTodos(list);
  return next;
}

/** 结束：真的做完了（与「关闭」区分——关闭表示不做了/误建）。 */
export function finishTodo(id: string, note?: string): TodoRecord | null {
  return updateTodo(id, {
    status: 'done',
    doneAt: new Date().toISOString(),
    note: note?.trim() || undefined,
  });
}

/** 关闭：不做了 / 建错了。不会产生"完成"记录。 */
export function dismissTodo(id: string): TodoRecord | null {
  return updateTodo(id, { status: 'dismissed', doneAt: new Date().toISOString() });
}

/** 稍后提醒：只改 dueAt，状态保持 pending。 */
export function snoozeTodo(id: string, addMs: number = DEFAULT_SNOOZE_MS, now: Date = new Date()): TodoRecord | null {
  const cur = getTodo(id);
  if (!cur) return null;
  if (cur.status !== 'pending') return cur;
  return updateTodo(id, {
    dueAt: nextSnoozeAt(cur.dueAt, now.getTime(), addMs),
    snoozedCount: (cur.snoozedCount ?? 0) + 1,
  });
}

/** 看板角标用：到/过期的数量。 */
export function dueCount(now: Date = new Date()): number {
  return listTodos({ dueOnly: true, now }).length;
}
