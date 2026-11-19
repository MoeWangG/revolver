/**
 * 冒充 broker 的 HTTP 面，专供 `tests/browserClientAutostart.test.ts`。
 *
 * 为什么不用真的 `waker browser start`：那会去拉起 `@browsermcp/mcp` 并抢 9009，
 * 在 CI 上必然失败，在本地会搅掉真实的 Chrome 连接。自启要验证的只是
 * "参数拼对了 + 起来后调用方能探到并调通"，所以这里只复刻 `/status` 与 `/call`。
 *
 * 调用形状与真 CLI 一致：`node fake-broker-http.ts browser start --port <N>`。
 */
import { createServer } from 'node:http';

const argv = process.argv.slice(2);
const portIdx = argv.indexOf('--port');
const port = portIdx >= 0 ? Number(argv[portIdx + 1]) : 18990;

const server = createServer((req, res) => {
  const send = (code: number, body: unknown): void => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  if (req.method === 'GET' && req.url === '/status') {
    return send(200, {
      ok: true,
      version: '2.0.0',
      uptimeMs: 1,
      upstream: {
        command: 'fake',
        args: [],
        pid: process.pid,
        alive: true,
        extensionConnected: true,
        lastError: null,
      },
      queue: { active: false, waiting: 0, limit: 4 },
      callTimeoutMs: 1000,
    });
  }

  if (req.method === 'POST' && req.url === '/call') {
    return send(200, { content: [{ type: 'text', text: `pong from ${process.pid}` }] });
  }

  if (req.method === 'POST' && req.url === '/shutdown') {
    send(200, { ok: true });
    setTimeout(() => process.exit(0), 20);
    return;
  }

  return send(404, { error: 'not found' });
});

server.listen(port, '127.0.0.1');
