/**
 * broker 自启的单测。
 *
 * 钉死的是这条契约：**agent 只有 policy.browser，没有 `waker` 命令权限**，
 * 所以"broker 得有人手动起"对它等于死路。callBroker 在第一次连不上时必须
 * 自己把 broker 拉起来，并在同一次工具调用内重试成功。
 *
 * 用 `tests/fixtures/fake-broker-http.ts` 冒充 broker：真 broker 的上游是
 * `@browsermcp/mcp`（会去连 Chrome 侧的常驻 daemon 9010），测试里绝不能起它——
 * 会往用户真实标签页里发命令。
 * 入口通过 `WAKER_BROWSER_ENTRY` 注入，覆盖 callBroker 内部那条不带 opts 的自启路径。
 *
 * 运行：node --experimental-strip-types tests/browserClientAutostart.test.ts
 */
import { execSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { callBroker, ensureBroker, probeBroker } from '../src/core/browserClient.ts';
import type { ToolResult } from '../src/core/browserBroker.ts';

const FIXTURE = fileURLToPath(new URL('./fixtures/fake-broker-http.ts', import.meta.url));
/** 高位端口，避开 8790 与 CI 上可能被占用的常用端口。 */
const PORT = 18992;

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

async function waitPort(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probeBroker(port, 400)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

/**
 * 列出还活着的 fixture 进程。
 *
 * 为什么不能直接数 `pgrep -f fake-broker-http` 的行数：发起查询的
 * `sh -c pgrep -f fake-broker-http` 自己的命令行里也含这个字符串，
 * pgrep 会把它（以及 pgrep 自身）一起列出来 —— macOS 上恰好不算，
 * Linux CI 上就多出 1~2 个，于是"单飞只拉起一个"必然误判为失败。
 * 所以按命令行二次过滤：必须含 fixture 名字，且不是 pgrep / sh -c 包装层。
 */
function fakeBrokerPids(): number[] {
  const out = (() => {
    try {
      return execSync('pgrep -f fake-broker-http || true', { encoding: 'utf-8' });
    } catch {
      return '';
    }
  })();
  const self = new Set([process.pid, process.ppid]);
  return out
    .split('\n')
    .map((s) => Number(s.trim()))
    .filter((pid) => Number.isInteger(pid) && pid > 0 && !self.has(pid))
    .filter((pid) => {
      try {
        const cmd = execSync(`ps -o command= -p ${pid}`, { encoding: 'utf-8' }).trim();
        return /fake-broker-http/.test(cmd) && !/\bpgrep\b|\bsh -c\b/.test(cmd);
      } catch {
        return false; // 进程刚好退出了
      }
    });
}

async function ensureDown(): Promise<void> {
  if (await probeBroker(PORT, 400)) {
    await fetch(`http://127.0.0.1:${PORT}/shutdown`, { method: 'POST' }).catch(() => undefined);
  }
  for (let i = 0; i < 30; i += 1) {
    if (!(await probeBroker(PORT, 300))) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  // 兜底：shutdown 没生效就按命令行特征清掉（只匹配 fixture 进程，不碰真 waker，也不误杀查询自身）
  for (const pid of fakeBrokerPids()) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* 已退出 */
    }
  }
  await new Promise((r) => setTimeout(r, 150));
}

/** 数一下还有几个 fixture 进程活着（验证单飞没重复 spawn）。 */
function liveFakeBrokers(): number {
  return fakeBrokerPids().length;
}

async function main(): Promise<void> {
  // callBroker 内部走 ensureBroker(port) 不带 opts —— 靠这个环境变量把入口换成 fixture
  process.env.WAKER_BROWSER_ENTRY = FIXTURE;
  await ensureDown();

  // 前提校验：fixture 自己得能起、能应答、能关；否则后面失败原因会被误读
  const sanity = spawn(
    process.execPath,
    ['--experimental-strip-types', FIXTURE, 'browser', 'start', '--port', String(PORT)],
    { detached: true, stdio: 'ignore' },
  );
  sanity.unref();
  check('fixture 能独立监听（前提校验）', await waitPort(PORT, 6000), 'fixture 没起来，后续用例不可信');
  await ensureDown();
  check('fixture 可关闭（冷启动前置条件成立）', (await probeBroker(PORT, 300)) === null);

  // 1. 冷启动：ensureBroker 应拉起并返回 status
  const started = await ensureBroker(PORT, { entry: FIXTURE, waitMs: 6000 });
  check('ensureBroker 冷启动能拉起 broker', started !== null && started.ok === true);
  check('拉起后只有 1 个 broker 进程', liveFakeBrokers() === 1, `存活 ${liveFakeBrokers()} 个`);

  // 2. 已就绪时不重复拉起
  const again = await ensureBroker(PORT, { entry: FIXTURE, waitMs: 1000 });
  check('broker 已就绪时直接返回、不重复拉起', again !== null && liveFakeBrokers() === 1, `存活 ${liveFakeBrokers()} 个`);
  await ensureDown();

  // 3. 核心用例：agent 视角——桥没起，一次 callBroker 就成功（内部自启 + 重试）
  const cold = await callBroker('browser', { commands: 'get url' }, { port: PORT, timeoutMs: 3000 });
  const coldText = text(cold);
  check('桥没起时一次 callBroker 即调通（自动拉起）', cold.isError !== true && /pong from/.test(coldText), coldText);
  await ensureDown();

  // 4. 并发单飞：3 个并发调用只应拉起 1 个 broker
  const results = await Promise.all([
    callBroker('browser', { commands: 'get url' }, { port: PORT, timeoutMs: 3000 }),
    callBroker('browser', { commands: 'goto https://example.com' }, { port: PORT, timeoutMs: 3000 }),
    callBroker('browser', { commands: 'snapshot -i' }, { port: PORT, timeoutMs: 3000 }),
  ]);
  check(
    '并发调用全部成功',
    results.every((r) => r.isError !== true && /pong from/.test(text(r))),
    results.map((r) => text(r)).join(' | '),
  );
  check('并发只拉起一个 broker（单飞）', liveFakeBrokers() === 1, `存活 ${liveFakeBrokers()} 个`);
  await ensureDown();

  // 5. 总开关：显式关闭时不拉起，且报错仍可诊断
  process.env.WAKER_BROWSER_AUTOSTART = '0';
  check('WAKER_BROWSER_AUTOSTART=0 时 ensureBroker 不拉起', (await ensureBroker(PORT, { entry: FIXTURE, waitMs: 1000 })) === null);
  const denied = await callBroker('browser', { commands: 'get url' }, { port: PORT, timeoutMs: 1200 });
  const deniedText = text(denied);
  check(
    '关闭自启时报错可诊断（含手动命令与日志路径）',
    denied.isError === true && /waker browser start/.test(deniedText) && /browser-broker\.log/.test(deniedText),
    deniedText,
  );
  delete process.env.WAKER_BROWSER_AUTOSTART;

  await ensureDown();
  check('清理后无残留 fixture 进程', liveFakeBrokers() === 0, `存活 ${liveFakeBrokers()} 个`);

  console.log(`\n${pass} 通过 / ${fail} 失败`);
  if (fail > 0) process.exit(1);
}

void main();
