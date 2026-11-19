import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from './paths.ts';

/**
 * 跨进程的会话锁。
 *
 * 进程内队列（`queue.ts`）只能管住**同一个进程**里的并发，而"同一个 pi 会话被两个
 * 进程同时写"恰恰是最容易踩的：`waker say chat` 与看板对话用的是同一个 `waker-chat`，
 * 但它们是两个 node 进程，各自的队列互不可见。所以这里补一层文件锁。
 *
 * 实现取的是"锁文件 + pid 存活检测"：
 *   - 用 `flag: 'wx'` 原子创建，天然互斥；
 *   - 文件里记 pid，发现锁的主进程已死就**清掉重抢**（否则崩溃一次就会永久卡住该会话）；
 *   - 轮询等待，超时报错而不是无限等。
 *
 * 为什么不用 flock/OS 锁：Node 没有可移植的 flock，且锁要能被"另一个已经崩溃的进程"
 * 解掉——文件 + pid 是这里唯一能自愈的做法。
 */

const LOCK_DIR = join(DATA_DIR, 'locks');
/** 轮询间隔：本地进程间争用，500ms 足够灵敏又不至于忙等。 */
const POLL_MS = 500;

function lockFile(key: string): string {
  // piSessionId 形如 waker-<id>-<hash>，正常不含特殊字符；兜个底避免路径穿越
  return join(LOCK_DIR, `${key.replace(/[^a-zA-Z0-9._-]/g, '_')}.lock`);
}

function ownerPid(file: string): number | null {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as { pid?: unknown };
    return typeof parsed.pid === 'number' ? parsed.pid : null;
  } catch {
    return null; // 内容坏了（写一半被杀）→ 视为无主，可抢
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 尝试拿锁，拿到返回释放函数，拿不到返回 null。 */
function tryAcquire(key: string): (() => void) | null {
  mkdirSync(LOCK_DIR, { recursive: true });
  const file = lockFile(key);
  const payload = JSON.stringify({ pid: process.pid, key, at: new Date().toISOString() });

  const write = (): boolean => {
    try {
      writeFileSync(file, payload, { flag: 'wx' });
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      return false;
    }
  };

  if (!write()) {
    const owner = ownerPid(file);
    // 无主内容或持锁进程已死 —— 清掉重抢一次，避免崩溃残留把会话永久锁死
    if (owner === null || !isAlive(owner)) {
      try {
        rmSync(file, { force: true });
      } catch {
        /* 别人刚清掉也无所谓 */
      }
      if (!write()) return null;
    } else {
      return null;
    }
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    // 只删自己的锁：极端情况下（超时被抢）别人的锁不能被误删
    if (ownerPid(file) !== process.pid) return;
    try {
      rmSync(file, { force: true });
    } catch {
      /* 已被清掉 */
    }
  };
}

export interface SessionLockOptions {
  /** 最长等待毫秒，默认 10 分钟（与任务默认超时一致）。 */
  waitMs?: number;
  /** 进入等待时回调一次，用于提示用户"在等谁"。 */
  onWait?: (holderPid: number | null) => void;
}

export interface SessionLock {
  release: () => void;
  /** 实际等待了多久（0 = 直接拿到）。 */
  waitedMs: number;
}

/**
 * 拿到某个 pi 会话的执行权（跨进程）。超时抛错——宁可让调用方明确失败，
 * 也不要无限期挂着让人以为"卡死了"。
 */
export async function acquireSessionLock(key: string, opts: SessionLockOptions = {}): Promise<SessionLock> {
  const waitMs = opts.waitMs ?? 10 * 60 * 1000;
  const started = Date.now();
  let notified = false;

  for (;;) {
    const release = tryAcquire(key);
    if (release) return { release, waitedMs: Date.now() - started };
    if (!notified) {
      notified = true;
      opts.onWait?.(ownerPid(lockFile(key)));
    }
    if (Date.now() - started >= waitMs) {
      throw new Error(`会话 ${key} 正被另一个进程占用（已等 ${Math.round(waitMs / 1000)}s 超时）`);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}
