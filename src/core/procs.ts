import type { ChildProcess } from 'node:child_process';
import type { TaskSource } from '../types.ts';

/**
 * 运行中的 pi 子进程登记表（进程内单例）。
 *
 * 为什么需要它：任务流水（JSONL）是**事后**账本——`pid` 原先只在任务结束时才写入，
 * 于是"终止"按钮拿不到运行中的 pid，取消形同虚设；运行中的输出也完全不可见。
 * 登记表补上这块：spawn 即登记、输出实时入尾部缓冲、结束时注销。
 *
 * 边界：只能看见**本进程**拉起的子进程。CLI（`waker say` / `run`）是独立进程，
 * 它们的运行态不在登记表内——看板展示的是"看板进程自己拉起的那些执行"。
 */

/** 尾部输出保留的字符数。够看上下文，又不会让接口体无限增长。 */
const TAIL_MAX = 2000;

export interface RunningProc {
  taskId: string;
  wakerId: string;
  source: TaskSource;
  /** 所属平台会话 id（独立任务为空）。 */
  sessionId?: string;
  prompt: string;
  startedAt: string;
  /** 已运行毫秒。 */
  elapsedMs: number;
  pid?: number;
  /** 最近的 stdout + stderr 尾部。 */
  tail: string;
  /** 已被要求终止（SIGTERM 已发出，可能还在优雅退出）。 */
  cancelling?: boolean;
}

interface Entry extends RunningProc {
  child: ChildProcess;
}

const procs = new Map<string, Entry>();

export function registerProc(input: {
  taskId: string;
  wakerId: string;
  source: TaskSource;
  sessionId?: string;
  prompt: string;
  pid?: number;
  child: ChildProcess;
}): void {
  procs.set(input.taskId, {
    taskId: input.taskId,
    wakerId: input.wakerId,
    source: input.source,
    sessionId: input.sessionId,
    prompt: input.prompt,
    startedAt: new Date().toISOString(),
    elapsedMs: 0,
    pid: input.pid,
    tail: '',
    child: input.child,
  });
}

/** 追加一段输出（stdout / stderr 同一条流，保留尾部）。 */
export function appendProcOutput(taskId: string, chunk: string): void {
  const e = procs.get(taskId);
  if (!e) return;
  e.tail = (e.tail + chunk).slice(-TAIL_MAX);
}

export function finishProc(taskId: string): void {
  procs.delete(taskId);
}

export function getProc(taskId: string): RunningProc | null {
  return view(procs.get(taskId)) ?? null;
}

/** 当前全部运行中的进程，按启动时间升序（先跑的在前）。 */
export function listProcs(): RunningProc[] {
  return [...procs.values()].map(view).filter((p): p is RunningProc => p !== null);
}

/**
 * 终止某个运行中的任务：SIGTERM，5 秒后仍未退出则 SIGKILL。
 * 返回是否命中——未命中说明进程已结束（或不是本进程拉起的）。
 */
export function killProc(taskId: string): boolean {
  const e = procs.get(taskId);
  if (!e) return false;
  if (e.cancelling) return true;
  e.cancelling = true;
  try {
    e.child.kill('SIGTERM');
  } catch {
    /* 进程可能已退出 */
  }
  setTimeout(() => {
    // 仍然在表里说明没退干净，强杀
    if (procs.has(taskId)) {
      try {
        e.child.kill('SIGKILL');
      } catch {
        /* 忽略 */
      }
    }
  }, 5000).unref();
  return true;
}

function view(e: Entry | undefined): RunningProc | null {
  if (!e) return null;
  return {
    taskId: e.taskId,
    wakerId: e.wakerId,
    source: e.source,
    sessionId: e.sessionId,
    prompt: e.prompt,
    startedAt: e.startedAt,
    elapsedMs: Date.now() - new Date(e.startedAt).getTime(),
    pid: e.pid,
    tail: e.tail,
    cancelling: e.cancelling,
  };
}
