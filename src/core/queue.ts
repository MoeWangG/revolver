/**
 * 执行串行队列。
 *
 * 为什么需要：平台原先对并发**没有任何保护**——同一个员工可以被 cron、手动、看板
 * 同时拉起多个 pi 子进程。冲突的真实单位不是"员工"，而是**一个 pi 会话文件**：
 * 两个 pi 同时写 `..._waker-<id>.jsonl` 会互相踩，上下文就坏了。
 *
 * 所以锁按 **piSessionId** 粒度：
 *   - 同一个会话严格串行（排队而非拒绝，因为"连发两条消息"是常态）；
 *   - 同一员工的**不同会话**照常并行（定时任务每次新开会话，不该被飞书私聊堵住）。
 *
 * 另加两级上限兜底机器资源：每员工 3、全局 6，超出的一律排队。
 *
 * 边界：这是**进程内**队列。CLI（`waker say` / `run`）是独立进程，不在同一个队列里；
 * 真正跨进程的互斥需要文件锁/数据库锁，暂不做（看板进程是主要并发来源）。
 */

/** 每员工并发上限。 */
export const MAX_PER_WAKER = 3;
/** 全局并发上限。 */
export const MAX_TOTAL = 6;

export interface AcquireOptions {
  /** 互斥键，通常取 piSessionId；独立任务传一个唯一值即可（不会互相阻塞）。 */
  key: string;
  wakerId: string;
  taskId: string;
  /** 需要排队时回调一次，用于把任务标成 queued。 */
  onWait?: () => void;
}

export interface Lease {
  /** 真正拿到执行权（false = 排队期间被取消，调用方应直接收尾）。 */
  granted: boolean;
  release: () => void;
}

interface Waiter {
  key: string;
  wakerId: string;
  taskId: string;
  grant: (lease: Lease) => void;
}

const waiters: Waiter[] = [];
/** key → 正在占用它的 taskId。 */
const holding = new Map<string, string>();
const runningByWaker = new Map<string, number>();
let runningTotal = 0;

function canStart(wakerId: string): boolean {
  if (runningTotal >= MAX_TOTAL) return false;
  return (runningByWaker.get(wakerId) ?? 0) < MAX_PER_WAKER;
}

function start(w: Waiter): void {
  holding.set(w.key, w.taskId);
  runningTotal += 1;
  runningByWaker.set(w.wakerId, (runningByWaker.get(w.wakerId) ?? 0) + 1);
  w.grant({
    granted: true,
    release: () => finish(w.key, w.wakerId),
  });
}

function finish(key: string, wakerId: string): void {
  holding.delete(key);
  runningTotal = Math.max(runningTotal - 1, 0);
  const n = (runningByWaker.get(wakerId) ?? 1) - 1;
  if (n <= 0) runningByWaker.delete(wakerId);
  else runningByWaker.set(wakerId, n);
  pump();
}

/** 按 FIFO 重试队列：跳过仍占着会话或超出配额的，能起的先起。 */
function pump(): void {
  for (let i = 0; i < waiters.length; ) {
    const w = waiters[i]!;
    if (holding.has(w.key) || !canStart(w.wakerId)) {
      i += 1;
      continue;
    }
    waiters.splice(i, 1);
    start(w);
    // 不前进：同一轮里后面的也可能起得来
  }
}

export function acquire(opts: AcquireOptions): Promise<Lease> {
  return new Promise<Lease>((resolvePromise) => {
    const w: Waiter = { ...opts, grant: resolvePromise };
    if (!holding.has(opts.key) && canStart(opts.wakerId)) {
      start(w);
      return;
    }
    opts.onWait?.();
    waiters.push(w);
  });
}

/**
 * 取消一个**排队中**的任务。返回是否命中——命中说明它还没开始跑，
 * 调用方据此把状态落成 cancelled；正在跑的走 killProc 那条路。
 */
export function cancelWaiting(taskId: string): boolean {
  const i = waiters.findIndex((w) => w.taskId === taskId);
  if (i === -1) return false;
  const [w] = waiters.splice(i, 1);
  w!.grant({ granted: false, release: () => undefined });
  return true;
}

export interface QueueSnapshot {
  running: number;
  waiting: number;
  maxTotal: number;
  maxPerWaker: number;
  /** 排队中的任务（供看板展示"在等谁"）。 */
  queued: Array<{ taskId: string; wakerId: string; key: string }>;
}

export function queueSnapshot(): QueueSnapshot {
  return {
    running: runningTotal,
    waiting: waiters.length,
    maxTotal: MAX_TOTAL,
    maxPerWaker: MAX_PER_WAKER,
    queued: waiters.map((w) => ({ taskId: w.taskId, wakerId: w.wakerId, key: w.key })),
  };
}
