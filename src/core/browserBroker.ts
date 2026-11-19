/**
 * browser-broker — 浏览器能力的**唯一持有者**。
 *
 * ## 上游在 2.x 换了架构（2026-11-08 对齐）
 *
 * 1.x：MCP server 自己起 ws 服务在 9009，Chrome 扩展连进来；server 启动还会
 * `lsof -ti:9009 | xargs kill -9`，所以多进程会互相杀。
 * 2.x：改为 Chrome 侧一个常驻守护进程 `daemon.js`（`127.0.0.1:9010`）持有扩展连接，
 * MCP server 反过来是它的客户端。**9009 与手点 Connect 都成为历史**。
 *
 * 那 broker 还留着做什么？两件在 2.x 里依然必要的事：
 *   - **串行化**：浏览器是单标签页，两个调用同时点会点错。revolver 每次任务新起 pi 进程，
 *     没有这一层就是多个进程同时操作同一个标签页；
 *   - **多前端共享一个出口**：HTTP `127.0.0.1:8790`（`/status` `/tools` `/call`）给 pi 扩展，
 *     同一份 HTTP 由 `waker browser mcp-stdio` 转成 MCP stdio 给 CodeBuddy 等外部客户端。
 *     否则每个 pi 进程各 spawn 一个 upstream，各自维护一份 `tools/list` 缓存，版本一错就全灭。
 *
 * ## 失败语义
 *
 * 浏览器没连时上游会回 `No tab is connected` / `No connection to browser extension` /
 * `There's no tab yet`（2.x 的措辞）。这不是 broker 坏了，必须区分开，
 * 否则使用方会去重启 broker、重启 Chrome，越查越远。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createInterface } from 'node:readline';

import { BROWSER_TOOL_NAMES } from './browserTools.ts';

/** 默认端口：避开 8787（看板）、9009（browsermcp 的 ws）。 */
export const DEFAULT_BROKER_PORT = 8790;

const DEFAULT_UPSTREAM_COMMAND = 'npx';
/**
 * **钉死版本**：`@latest` 从 1.x 跳到 2.x 时把 13 个工具改成一个 `browser`（命令 DSL），
 * 不钉住就会出现"昨天能用今天全 Unknown tool"——本次事故就是这么来的。
 * 升级时同步改 `browserTools.ts` 并跑 `tests/browserBroker.test.ts`。
 */
const DEFAULT_UPSTREAM_ARGS = ['-y', '@browsermcp/mcp@2.4.0'];
/** 单次浏览器操作的上限：navigate 冷启动偶尔要十几秒，给足。 */
const DEFAULT_CALL_TIMEOUT_MS = 120_000;
const INIT_TIMEOUT_MS = 30_000;
/** 排队上限：超过就拒，不让人对着"没反应"猜。 */
const DEFAULT_QUEUE_LIMIT = 8;
const MAX_BODY_BYTES = 4 * 1024 * 1024;

export interface ToolContent {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

export interface ToolResult {
  content: ToolContent[];
  isError: boolean;
}

export interface BrokerStatus {
  ok: true;
  version: string;
  uptimeMs: number;
  upstream: {
    command: string;
    args: string[];
    pid: number | null;
    alive: boolean;
    /** true=最近一次调用成功；false=上游说没连标签页；null=还没调过。 */
    extensionConnected: boolean | null;
    lastError: string | null;
  };
  queue: { active: boolean; waiting: number; limit: number };
  callTimeoutMs: number;
}

export interface StartBrokerOptions {
  port?: number;
  host?: string;
  upstreamCommand?: string;
  upstreamArgs?: string[];
  callTimeoutMs?: number;
  queueLimit?: number;
  /** 静默模式：不往 stderr 打启动日志（测试用）。 */
  quiet?: boolean;
}

export interface Broker {
  host: string;
  port: number;
  status(): BrokerStatus;
  callTool(name: string, args?: Record<string, unknown>): Promise<ToolResult>;
  close(): Promise<void>;
}

interface PendingEntry {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/** 与 browsermcp 子进程的 stdio JSON-RPC 连接（每行一条消息）。 */
class Upstream {
  private child: ChildProcess | null = null;
  private readonly pending = new Map<number, PendingEntry>();
  private seq = 0;
  private starting: Promise<void> | null = null;
  private initialized = false;
  private stderrTail = '';
  lastError: string | null = null;
  extensionConnected: boolean | null = null;

  readonly command: string;
  readonly args: string[];

  constructor(command: string, args: string[]) {
    // 不用参数属性（TS parameter property）：node --experimental-strip-types 不支持
    this.command = command;
    this.args = args;
  }

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  get alive(): boolean {
    return this.child !== null && this.child.exitCode === null;
  }

  /** 确保子进程在跑且已完成 initialize。失败不缓存，下次调用会重试。 */
  async ensure(): Promise<void> {
    if (this.alive && this.initialized) return;
    if (!this.starting) {
      this.starting = this.start().finally(() => {
        this.starting = null;
      });
    }
    await this.starting;
  }

  private async start(): Promise<void> {
    if (!this.alive) this.spawnChild();
    await this.request(
      'initialize',
      {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'waker-browser-broker', version: '2.0.0' },
      },
      INIT_TIMEOUT_MS,
    );
    this.notify('notifications/initialized', {});
    this.initialized = true;
  }

  private spawnChild(): void {
    const child = spawn(this.command, this.args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;

    const rl = createInterface({ input: child.stdout! });
    rl.on('line', (line) => this.onLine(line));

    child.stderr?.on('data', (d: Buffer) => {
      // 只留尾部：npx 的报错很长，全留着没意义
      this.stderrTail = (this.stderrTail + d.toString()).slice(-4000);
    });

    child.on('error', (e) => {
      this.lastError = `无法启动上游（${this.command}）：${e.message}`;
      this.failAll(this.lastError);
      this.child = null;
      this.initialized = false;
    });

    child.on('exit', (code, signal) => {
      const tail = this.stderrTail.split('\n').filter(Boolean).slice(-2).join(' / ');
      this.lastError = `浏览器上游已退出（code=${code ?? 'null'}, signal=${signal ?? 'null'}）${tail ? `：${tail}` : ''}`;
      this.failAll(this.lastError);
      this.child = null;
      this.initialized = false;
    });
  }

  private onLine(line: string): void {
    if (!line.trim()) return;
    let msg: { id?: number; result?: unknown; error?: { message?: string } };
    try {
      msg = JSON.parse(line) as typeof msg;
    } catch {
      return;
    }
    if (msg.id === undefined) return; // 通知
    const entry = this.pending.get(msg.id);
    if (!entry) return;
    this.pending.delete(msg.id);
    clearTimeout(entry.timer);
    if (msg.error) entry.reject(new Error(msg.error.message ?? '上游返回错误'));
    else entry.resolve(msg.result);
  }

  request(method: string, params: unknown, timeoutMs = DEFAULT_CALL_TIMEOUT_MS): Promise<unknown> {
    const child = this.child;
    const stdin = child?.stdin;
    if (!child || child.exitCode !== null || !stdin) {
      return Promise.reject(new Error(this.lastError ?? '浏览器上游未运行'));
    }
    const id = ++this.seq;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} 超时（${timeoutMs}ms）`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e as Error);
      }
    });
  }

  private notify(method: string, params: unknown): void {
    this.child?.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  private failAll(reason: string): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
      this.pending.delete(id);
    }
  }

  kill(): void {
    const child = this.child;
    this.child = null;
    this.initialized = false;
    this.failAll('broker 正在关闭');
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* 已退出 */
        }
      }, 2000).unref();
    }
  }
}

/**
 * 上游表达"浏览器没连"的三代文案，都必须认（否则会被误报成"通道坏了"，让人去重启 broker）：
 * - 1.x 早期：`No tab is connected`
 * - 1.x 后期：`No connection to browser extension... click the 'Connect' button`
 * - 2.x：daemon 没起（`daemon ... not running/reachable`）
 *
 * **`There's no tab yet` 不算没连**：2.x 的 daemon 连上了但没有选中标签页，
 * 下一步是 `goto <url>` 或 `tab list`。把它算成"未连接"会让 `waker browser status`
 * 明明能用却报"未连接"，排查方向直接跑偏（这次就差点这么写）。
 */
function isExtensionOffline(text: string): boolean {
  return /no tab is connected|no connection to browser extension|daemon .*not (running|reachable)/i.test(text);
}

function normalizeResult(raw: unknown): ToolResult {
  const r = (raw ?? {}) as { content?: unknown; isError?: unknown };
  const content = Array.isArray(r.content) ? (r.content as ToolContent[]) : [];
  return {
    content: content.length ? content : [{ type: 'text', text: '(上游没有返回内容)' }],
    isError: r.isError === true,
  };
}

function textOf(result: ToolResult): string {
  return result.content
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text as string)
    .join('\n');
}

function writeJson(res: ServerResponse, code: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new Error('请求体过大');
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

/**
 * 启动 broker。端口被占用时**抛错**（由 CLI 判断"已在运行"还是"别的程序占了"）。
 */
export async function startBroker(opts: StartBrokerOptions = {}): Promise<Broker> {
  const host = opts.host ?? '127.0.0.1';
  const upstream = new Upstream(
    opts.upstreamCommand ?? DEFAULT_UPSTREAM_COMMAND,
    opts.upstreamArgs ?? DEFAULT_UPSTREAM_ARGS,
  );
  const callTimeoutMs = opts.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const queueLimit = opts.queueLimit ?? DEFAULT_QUEUE_LIMIT;
  const startedAt = Date.now();

  let chain: Promise<unknown> = Promise.resolve();
  let queued = 0;
  let active = false;

  async function doCall(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    await upstream.ensure();
    active = true;
    try {
      const raw = await upstream.request('tools/call', { name, arguments: args }, callTimeoutMs);
      const result = normalizeResult(raw);
      if (result.isError) {
        const text = textOf(result);
        upstream.lastError = text || '上游返回 isError';
        if (isExtensionOffline(text)) upstream.extensionConnected = false;
      } else {
        upstream.extensionConnected = true;
        upstream.lastError = null;
      }
      return result;
    } catch (e) {
      const text = (e as Error)?.message ?? String(e);
      upstream.lastError = text;
      if (isExtensionOffline(text)) upstream.extensionConnected = false;
      return { content: [{ type: 'text', text: `浏览器调用失败：${text}` }], isError: true };
    } finally {
      active = false;
    }
  }

  async function callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    if (queued >= queueLimit) {
      return {
        content: [
          {
            type: 'text',
            text: `浏览器正忙（排队 ${queued} 个，上限 ${queueLimit}）。浏览器是单标签页，只能一个一个来，稍后重试。`,
          },
        ],
        isError: true,
      };
    }
    queued += 1;
    const run = chain.then(() => doCall(name, args));
    // 失败不能断链：后续调用还必须能排上
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    try {
      return await run;
    } finally {
      queued -= 1;
    }
  }

  function status(): BrokerStatus {
    return {
      ok: true,
      version: '2.0.0',
      uptimeMs: Date.now() - startedAt,
      upstream: {
        command: upstream.command,
        args: upstream.args,
        pid: upstream.pid,
        alive: upstream.alive,
        extensionConnected: upstream.extensionConnected,
        lastError: upstream.lastError,
      },
      queue: { active, waiting: queued, limit: queueLimit },
      callTimeoutMs,
    };
  }

  const server: Server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? `${host}:0`}`);

        if (req.method === 'GET' && url.pathname === '/status') return writeJson(res, 200, status());
        if (req.method === 'GET' && url.pathname === '/tools') {
          return writeJson(res, 200, { tools: BROWSER_TOOL_NAMES });
        }
        if (req.method === 'POST' && url.pathname === '/call') {
          const body = JSON.parse((await readBody(req)) || '{}') as { name?: string; args?: Record<string, unknown> };
          const name = String(body.name ?? '');
          if (!BROWSER_TOOL_NAMES.includes(name)) {
            return writeJson(res, 400, { content: [{ type: 'text', text: `未知工具：${name || '(空)'}` }], isError: true });
          }
          const result = await callTool(name, body.args ?? {});
          return writeJson(res, 200, result);
        }
        if (req.method === 'POST' && url.pathname === '/shutdown') {
          writeJson(res, 200, { ok: true });
          setTimeout(() => void close(), 50).unref();
          return;
        }
        return writeJson(res, 404, { error: 'not found' });
      } catch (e) {
        return writeJson(res, 400, { error: (e as Error)?.message ?? String(e) });
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (e: Error): void => reject(e);
    server.once('error', onError);
    server.listen(opts.port ?? DEFAULT_BROKER_PORT, host, () => {
      server.off('error', onError);
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : (opts.port ?? DEFAULT_BROKER_PORT);

  let closed = false;
  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    upstream.kill();
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  if (!opts.quiet) {
    console.error(
      `[browser-broker] 已监听 http://${host}:${port}；上游：${upstream.command} ${upstream.args.join(' ')}\n` +
        '  上游首次调用时启动，并在 9009 等 Chrome 扩展连接（扩展里未点 Connect 会报 No tab is connected）。',
    );
  }

  return { host, port, status, callTool, close };
}

/** 探测 broker 是否在跑：实现放在 browserClient（扩展与 CLI 共用一份）。 */
export { probeBroker } from './browserClient.ts';
