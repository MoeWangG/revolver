/**
 * `waker browser mcp-stdio` —— 把 broker 的 HTTP 出口翻译成 MCP stdio。
 *
 * 用途：CodeBuddy / Claude Desktop 这类只认 stdio 的 MCP 客户端，也能用同一个浏览器。
 * 它们 spawn 本命令，本命令再转发给常驻 broker；**browser server 只被 broker 持有一份**，
 * 所以外部客户端和 revolver 的 agent 共享同一条 Chrome 连接，不会再互杀 9009。
 *
 * 协议要点（MCP stdio）：
 * - 每行一条 JSON-RPC 消息（换行分隔，不是 Content-Length）；
 * - stdout **只能**写 JSON-RPC，日志一律走 stderr，否则客户端解析会崩；
 * - 通知（没有 id）不回复。
 */
import { createInterface } from 'node:readline';

import { BROKER, callBroker } from './browserClient.ts';
import { BROWSER_TOOLS } from './browserTools.ts';

const PROTOCOL_VERSION = '2024-11-05';

interface RpcMessage {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
}

function write(msg: unknown): void {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function reply(id: number | string, result: unknown): void {
  write({ jsonrpc: '2.0', id, result });
}

function replyError(id: number | string, code: number, message: string): void {
  write({ jsonrpc: '2.0', id, error: { code, message } });
}

function log(msg: string): void {
  process.stderr.write(`[browser-mcp-stdio] ${msg}\n`);
}

/**
 * 处理一条消息。**不阻塞** readline：浏览器调用本身在 broker 里串行，
 * 这里若再串行，长任务会把 initialize/ping 也堵住。
 */
async function handle(msg: RpcMessage): Promise<void> {
  if (msg.id === undefined) return; // 通知

  const id = msg.id;
  switch (msg.method) {
    case 'initialize':
      reply(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'waker-browser', version: '2.0.0' },
      });
      return;

    case 'ping':
      reply(id, {});
      return;

    case 'tools/list':
      reply(id, {
        tools: BROWSER_TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.parameters,
        })),
      });
      return;

    case 'tools/call': {
      const name = String(msg.params?.name ?? '');
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
      const result = await callBroker(name, args);
      reply(id, { content: result.content, isError: result.isError });
      return;
    }

    default:
      replyError(id, -32601, `Method not found: ${msg.method ?? '(none)'}`);
  }
}

/** 入口：读 stdin 直到 EOF。 */
export async function runMcpStdio(port = BROKER.port): Promise<void> {
  log(`转发到 broker http://127.0.0.1:${port}`);
  const rl = createInterface({ input: process.stdin });

  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg: RpcMessage;
    try {
      msg = JSON.parse(line) as RpcMessage;
    } catch {
      log(`收到非 JSON 行，已忽略：${line.slice(0, 120)}`);
      return;
    }
    void handle(msg).catch((e: unknown) => {
      const text = (e as Error)?.message ?? String(e);
      if (msg.id !== undefined) replyError(msg.id, -32603, text);
      else log(`处理失败：${text}`);
    });
  });

  await new Promise<void>((resolve) => rl.on('close', resolve));
}
