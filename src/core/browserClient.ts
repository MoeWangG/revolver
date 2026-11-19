/**
 * broker 的 HTTP 客户端（pi 扩展与 stdio 桥共用）。
 *
 * 只依赖 node 内置：这个文件会被 pi 扩展 import，必须保持零项目依赖，
 * 否则扩展加载会拖进整条 src 依赖图。
 *
 * **错误必须可诊断**：区分"桥没起"（ECONNREFUSED）与"浏览器没连"（上游返回 isError）。
 * 前者以前要人手动 `waker browser start`；后者在 2.x 里通常意味着 Chrome 没开或扩展没启用
 * （扩展连的是常驻守护进程 127.0.0.1:9010，不再需要手点 Connect）。
 *
 * **桥没起时自己点火**（见 ensureBroker）：agent 只有 policy.browser 这个能力开关，
 * 没有执行 `waker` 命令的权限（commandAllow 里也不该有——`waker` 能干的事远超浏览器）。
 * 所以"broker 需要人先手动起"这条链路对 agent 是死路：它只会反复拿到"桥不可达"。
 * 这里在首次调用失败后就地拉起一个 detached broker 并重试一次，员工侧零配置。
 */
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { BrokerStatus, ToolResult } from './browserBroker.ts';

export const BROKER = {
  host: process.env.WAKER_BROWSER_HOST ?? '127.0.0.1',
  port: Number(process.env.WAKER_BROWSER_PORT ?? 8790) || 8790,
};

const CALL_TIMEOUT_MS = 150_000;
/** 拉起 broker 后等它就绪的上限。冷启动要跑 node + strip-types，给足余量。 */
const AUTOSTART_WAIT_MS = 8000;

export interface CallOptions {
  port?: number;
  timeoutMs?: number;
}

export interface EnsureOptions {
  /**
   * 拉起用的命令行入口。默认按 `WAKER_BROWSER_ENTRY` → 仓库内 `bin/waker.ts`。
   * 测试注入假入口，保证不碰真 broker 的上游（9009）。
   */
  entry?: string;
  /** 等就绪上限（毫秒）。 */
  waitMs?: number;
}

function offlineResult(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** 仓库根：`src/core/` 上两级；构建后 `dist/core/` 上两级同样是仓库根。 */
function platformRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

function dataDir(): string {
  return process.env.WAKER_DATA ?? join(platformRoot(), 'data');
}

function post(
  port: number,
  name: string,
  args: Record<string, unknown>,
  timeoutMs: number,
): Promise<Response> {
  return fetch(`http://${BROKER.host}:${port}/call`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, args }),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

let ensuring: Promise<BrokerStatus | null> | null = null;

/**
 * 确保 broker 在跑：已跑直接返回；没跑就后台拉起 `waker browser start` 并等它监听。
 *
 * **单飞**：同一进程内并发调用只拉起一次，避免 3 个工具调用同时 spawn 3 个 broker
 * 互相抢 8790（后者会 EADDRINUSE，前面那个刚监听的反而被搅乱）。
 *
 * 任何失败都返回 null，由调用方决定文案——这里不抛异常，也不终止任务。
 */
export async function ensureBroker(port = BROKER.port, opts: EnsureOptions = {}): Promise<BrokerStatus | null> {
  const alive = await probeBroker(port, 800);
  if (alive) return alive;
  if (process.env.WAKER_BROWSER_AUTOSTART === '0') return null;

  ensuring ??= launch(port, opts).finally(() => {
    ensuring = null;
  });
  return ensuring;
}

async function launch(port: number, opts: EnsureOptions): Promise<BrokerStatus | null> {
  const entry = opts.entry ?? process.env.WAKER_BROWSER_ENTRY ?? join(platformRoot(), 'bin', 'waker.ts');
  if (!existsSync(entry)) return null;

  const dir = dataDir();
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    /* 建不出来不影响拉起，只是拿不到日志 */
  }

  let logFd: number | null = null;
  try {
    logFd = openSync(join(dir, 'browser-broker.log'), 'a');
  } catch {
    logFd = null;
  }

  // Node 23 起 strip-types 默认开启，再传会打警告；22 必须显式传。
  const major = Number(process.versions.node.split('.')[0]);
  const args = [
    ...(major >= 23 ? [] : ['--experimental-strip-types']),
    entry,
    'browser',
    'start',
    '--port',
    String(port),
  ];

  try {
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: ['ignore', logFd ?? 'ignore', logFd ?? 'ignore'],
      // 带上 WAKER_DATA / WAKER_BROWSER_PORT：broker 必须与调用方指向同一份数据与端口
      env: process.env,
    });
    child.unref();
    try {
      writeFileSync(join(dir, 'browser-broker.pid'), String(child.pid ?? ''), 'utf-8');
    } catch {
      /* pid 文件写不了只影响 `waker browser stop` 的兜底路径，不影响服务本身 */
    }
  } catch {
    return null;
  } finally {
    if (logFd !== null) {
      try {
        closeSync(logFd);
      } catch {
        /* ignore */
      }
    }
  }

  return waitReady(port, opts.waitMs ?? AUTOSTART_WAIT_MS);
}

async function waitReady(port: number, waitMs: number): Promise<BrokerStatus | null> {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    const st = await probeBroker(port, 600);
    if (st) return st;
  }
  return null;
}

/** 调用一个浏览器工具。任何传输层失败都折成 `isError` 结果，不抛异常。 */
export async function callBroker(
  name: string,
  args: Record<string, unknown> = {},
  opts: CallOptions = {},
): Promise<ToolResult> {
  const port = opts.port ?? BROKER.port;
  const timeoutMs = opts.timeoutMs ?? CALL_TIMEOUT_MS;

  let res: Response | null = null;
  let lastError = '';
  try {
    res = await post(port, name, args, timeoutMs);
  } catch (e) {
    lastError = (e as Error)?.message ?? String(e);
    // 桥没起 → 就地拉起，然后重试一次。agent 因此不需要任何命令权限。
    if (await ensureBroker(port)) {
      try {
        res = await post(port, name, args, timeoutMs);
      } catch (e2) {
        lastError = (e2 as Error)?.message ?? String(e2);
        res = null;
      }
    }
  }

  if (!res) {
    return offlineResult(
      `浏览器桥不可达（${BROKER.host}:${port}），自动拉起 broker 也没成功。\n` +
        `  手动排查：waker browser status → waker browser start\n` +
        `  启动日志：${join(dataDir(), 'browser-broker.log')}\n` +
        `  （若 broker 已起，检查端口是否一致：WAKER_BROWSER_PORT）\n原始错误：${lastError}`,
    );
  }

  const body = (await res.json().catch(() => null)) as ToolResult | { error?: string } | null;
  if (!res.ok) {
    const detail = body && 'error' in (body as { error?: string }) ? (body as { error?: string }).error : `HTTP ${res.status}`;
    return offlineResult(`浏览器调用被 broker 拒绝：${detail}`);
  }
  if (!body || !Array.isArray((body as ToolResult).content)) {
    return offlineResult('浏览器桥返回了无法解析的内容');
  }
  return body as ToolResult;
}

/** 探测 broker 状态；没起返回 null。 */
export async function probeBroker(port = BROKER.port, timeoutMs = 1500): Promise<BrokerStatus | null> {
  try {
    const res = await fetch(`http://${BROKER.host}:${port}/status`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const body = (await res.json()) as BrokerStatus;
    return body?.ok ? body : null;
  } catch {
    return null;
  }
}
