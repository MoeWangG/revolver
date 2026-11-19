/**
 * 假 MCP upstream：只为 `tests/browserBroker.test.ts` 存在。
 *
 * 用「行分隔 JSON-RPC」模拟 `@browsermcp/mcp` 的 stdio 侧，**不连浏览器**。
 * 这样 broker 的转发、串行队列、超时、错误透传都能在没有 Chrome 的环境里复现。
 *
 * 支持的行为（通过 tools/call 的 arguments.mode 切换）：
 *   ok（默认）/ fail / slow / concurrency
 */
import { createInterface } from 'node:readline';

let inFlight = 0;
let maxInFlight = 0;

interface RpcRequest {
  id?: number;
  method?: string;
  params?: { name?: string; arguments?: Record<string, unknown> };
}

interface ToolResult {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  isError?: boolean;
}

function send(msg: unknown): void {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function result(id: number, payload: ToolResult): void {
  send({ jsonrpc: '2.0', id, result: payload });
}

const rl = createInterface({ input: process.stdin });

rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg: RpcRequest;
  try {
    msg = JSON.parse(line) as RpcRequest;
  } catch {
    return;
  }
  // 通知（无 id）不需要回复
  if (msg.id === undefined) return;
  const id = msg.id;

  void (async () => {
    if (msg.method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'fake-mcp', version: '0' },
        },
      });
      return;
    }
    if (msg.method === 'tools/list') {
      send({
        jsonrpc: '2.0',
        id,
        result: {
          tools: [
            {
              name: 'browser',
              description: 'fake',
              inputSchema: { type: 'object', properties: { commands: { type: 'string' } }, required: ['commands'] },
            },
          ],
        },
      });
      return;
    }
    if (msg.method !== 'tools/call') {
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } });
      return;
    }

    // 不校验工具名：broker 已经按真实工具清单过滤过，这里只验证转发与队列语义
    const args = msg.params?.arguments ?? {};
    const mode = String(args.mode ?? 'ok');
    if (mode === 'fail') {
      result(id, { content: [{ type: 'text', text: 'boom' }], isError: true });
      return;
    }
    if (mode === 'slow') {
      await new Promise((r) => setTimeout(r, Number(args.ms ?? 1000)));
      result(id, { content: [{ type: 'text', text: 'slow done' }] });
      return;
    }

    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, Number(args.ms ?? 100)));
    inFlight -= 1;
    // max 会随调用次数单调增长：broker 只要串行，这里永远是 1
    result(id, { content: [{ type: 'text', text: `ok max=${maxInFlight}` }] });
  })();
});
