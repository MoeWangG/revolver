/**
 * `parseRunError` 的单测。
 *
 * 它要回答的问题只有一个：**这一轮 pi 的模型调用到底失败没有？**
 *
 * 为什么不用退出码：pi 遇到 provider 报错（400 上下文超限、鉴权失败…）时只往会话记录里
 * 写一条 `stopReason:"error"` 的 assistant 消息，**进程仍以 0 退出**。2026-11-07 事故里
 * 连续三次 400 全被记成 success、result 为空，界面上只剩「（无回复）」。
 *
 * 所以判定必须同时满足：最后一条 assistant 记录、`stopReason === 'error'`、且写于本轮开始之后。
 */
import { parseRunError } from '../src/core/sessionHistory.ts';

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

const T0 = Date.parse('2026-11-07T09:02:51.917Z');
const iso = (ms: number): string => new Date(ms).toISOString();
const userLine = (at: number): string =>
  JSON.stringify({ type: 'message', timestamp: iso(at), message: { role: 'user', content: [] } });
const assistantLine = (at: number, stopReason: string, errorMessage?: string): string =>
  JSON.stringify({
    type: 'message',
    timestamp: iso(at),
    message: { role: 'assistant', stopReason, errorMessage, content: [] },
  });

console.log('parseRunError');
{
  const errored = parseRunError(
    [userLine(T0), assistantLine(T0 + 1000, 'error', '400: maximum context length is 1048576')].join('\n'),
    T0,
  );
  check('本轮 400 → 抓到错误原文', Boolean(errored?.includes('maximum context length')), String(errored));

  check(
    '本轮正常回答 → 无错误',
    parseRunError([userLine(T0), assistantLine(T0 + 1000, 'stop')].join('\n'), T0) === null,
  );

  check(
    '上一轮的旧错误不能算到本轮',
    parseRunError(assistantLine(T0 - 60_000, 'error', 'old 400'), T0) === null,
  );

  check('本轮还没写出 assistant 记录 → 不误判', parseRunError(userLine(T0), T0) === null);

  check(
    'error 但没给原因时有兜底文案',
    parseRunError(assistantLine(T0 + 1, 'error'), T0) === '模型调用失败（pi 未给出原因）',
  );

  check(
    '坏行被跳过、继续往上找',
    parseRunError(['{坏 JSON', assistantLine(T0 + 1, 'error', 'boom')].join('\n'), T0) === 'boom',
  );

  check('空尾部不抛错', parseRunError('', T0) === null);

  check(
    '压缩节点等非 message 记录被忽略',
    parseRunError([JSON.stringify({ type: 'compaction', timestamp: iso(T0 + 5), summary: 'x' })].join('\n'), T0) ===
      null,
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
