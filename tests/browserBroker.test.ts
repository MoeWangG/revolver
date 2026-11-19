/**
 * browser-broker 的单测。
 *
 * 用 `tests/fixtures/fake-mcp-server.ts` 冒充 `@browsermcp/mcp`，所以**不碰真浏览器**：
 * 这里要钉死的是通道契约，不是网页操作。
 *
 * 覆盖：转发、串行化（浏览器单标签页语义）、超时、上游 isError 透传、
 *      未知工具拒绝、队列上限、status 探测。
 *
 * 运行：node --experimental-strip-types tests/browserBroker.test.ts
 */
import { fileURLToPath } from 'node:url';

import { startBroker, type Broker, type ToolResult } from '../src/core/browserBroker.ts';
import { probeBroker } from '../src/core/browserClient.ts';
import { BROWSER_TOOL_NAMES, BROWSER_TOOLS, withBrowserTools } from '../src/core/browserTools.ts';

const FIXTURE = fileURLToPath(new URL('./fixtures/fake-mcp-server.ts', import.meta.url));
const UPSTREAM = { upstreamCommand: process.execPath, upstreamArgs: ['--experimental-strip-types', FIXTURE] };

let pass = 0;
let fail = 0;

function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.error(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
  }
}

function text(result: ToolResult): string {
  return result.content
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text as string)
    .join('\n');
}

async function withBroker(
  fn: (broker: Broker) => Promise<void>,
  opts: { callTimeoutMs?: number; queueLimit?: number } = {},
): Promise<void> {
  const broker = await startBroker({ port: 0, quiet: true, ...UPSTREAM, ...opts });
  try {
    await fn(broker);
  } finally {
    await broker.close();
  }
}

async function main(): Promise<void> {
  // 0. 工具清单是三方共用的事实源（pi 扩展 / stdio 桥 / broker 白名单），先钉住形状。
  // 2.x 起上游只有一个 `browser`（参数是多行命令 DSL），工具数变化必须在这里显式确认。
  check('工具清单只有 browser 一个', BROWSER_TOOL_NAMES.length === 1 && BROWSER_TOOL_NAMES[0] === 'browser', BROWSER_TOOL_NAMES.join(','));
  check(
    'guard 判权能识别它（名字是 browser，不再有 browser_ 前缀）',
    BROWSER_TOOL_NAMES.every((n) => n === 'browser' || n.startsWith('browser_')),
    BROWSER_TOOL_NAMES.join(','),
  );
  check(
    'browser 的唯一参数是 commands（v2 DSL）',
    (() => {
      const props = (BROWSER_TOOLS[0]?.parameters as { properties?: Record<string, unknown> }).properties ?? {};
      return Object.keys(props).join(',') === 'commands';
    })(),
  );
  check(
    '每个工具都有 object 类型的 JSON Schema',
    BROWSER_TOOLS.every((t) => t.description && (t.parameters as { type?: string }).type === 'object'),
  );
  const merged = withBrowserTools(['read', 'bash']);
  check(
    'withBrowserTools 只追加、不重复、不改原数组',
    merged.length === 2 + BROWSER_TOOL_NAMES.length &&
      withBrowserTools(merged).length === merged.length &&
      merged.slice(0, 2).join(',') === 'read,bash',
    merged.join(','),
  );

  // 1. 基本转发：工具名与参数原样到上游，结果原样回来
  await withBroker(async (broker) => {
    const r = await broker.callTool('browser', { mode: 'ok', ms: 10 });
    check('转发 tools/call 并取回文本', !r.isError && text(r).includes('ok max='), text(r));
  });

  // 2. 串行化：两个并发调用绝不能同时打到上游（单标签页会点错元素）
  await withBroker(async (broker) => {
    const [a, b] = await Promise.all([
      broker.callTool('browser', { mode: 'concurrency', ms: 120 }),
      broker.callTool('browser', { mode: 'concurrency', ms: 120 }),
    ]);
    check(
      '并发调用被串行化（上游同时只有 1 个在跑）',
      text(a).includes('max=1') && text(b).includes('max=1'),
      `${text(a)} | ${text(b)}`,
    );
  });

  // 3. 超时：上游慢于上限时必须明确失败，而不是让调用方干等
  await withBroker(
    async (broker) => {
      const startedAt = Date.now();
      const r = await broker.callTool('browser', { mode: 'slow', ms: 3000 });
      const cost = Date.now() - startedAt;
      check('超时被掐断且标明是超时', r.isError && text(r).includes('超时'), `${text(r)}（${cost}ms）`);
      check('超时生效时间接近上限，不是等满上游', cost < 2500, `${cost}ms`);
    },
    { callTimeoutMs: 400 },
  );

  // 4. 上游 isError 透传（不是所有失败都是通道问题）
  await withBroker(async (broker) => {
    const r = await broker.callTool('browser', { mode: 'fail' });
    check('上游 isError 原样透传', r.isError && text(r).includes('boom'), text(r));
  });

  // 5. 未知工具：在 broker 层就拒，不浪费一次浏览器往返
  await withBroker(async (broker) => {
    const res = await fetch(`http://127.0.0.1:${broker.port}/call`, {
      method: 'POST',
      body: JSON.stringify({ name: 'browser_navigate', args: {} }),
    });
    const body = (await res.json()) as ToolResult;
    check('未知工具被拒绝（HTTP 400）', res.status === 400 && body.isError === true, `HTTP ${res.status}`);
  });

  // 6. 队列上限：满了就拒，不让请求无限堆积
  await withBroker(
    async (broker) => {
      const first = broker.callTool('browser', { mode: 'slow', ms: 600 });
      const second = await broker.callTool('browser', { mode: 'ok', ms: 10 });
      await first;
      check('队列满时明确拒绝', second.isError && text(second).includes('正忙'), text(second));
    },
    { queueLimit: 1, callTimeoutMs: 3000 },
  );

  // 7. status：能自证上游活着、队列空闲
  await withBroker(async (broker) => {
    await broker.callTool('browser', { mode: 'ok', ms: 10 });
    const st = await probeBroker(broker.port);
    check('probeBroker 能读到状态', st?.ok === true, JSON.stringify(st));
    check('上游进程 pid 可查', typeof st?.upstream.pid === 'number', JSON.stringify(st?.upstream));
    check('队列已空闲', st?.queue.active === false && st?.queue.waiting === 0, JSON.stringify(st?.queue));
  });

  // 8. 上游没起时（端口空）不抛异常，给可执行的提示
  const empty = await probeBroker(1);
  check('探测不存在的 broker 返回 null', empty === null);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

void main();
