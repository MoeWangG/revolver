/**
 * 时间窗模式 与 群聊键 的单测。
 *
 * 这两块都很容易"看起来对、实际串台"：
 *   - 时间窗只看间隔，一旦掺进内容判断就不可解释了；
 *   - 群聊键少拼一个发言人，A 的话题就会被 B 的追问吸走。
 */
import { decideTimeWindow } from '../src/core/topicRouter.ts';

// conversationKeyOf 是纯函数，但所在模块会读 data 目录，所以先指到临时目录
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.WAKER_DATA ??= mkdtempSync(join(tmpdir(), 'revolver-modes-'));

const { conversationKeyOf } = await import('../src/core/conversations.ts');

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

const HOUR = 3_600_000;
const now = Date.parse('2026-10-23T12:00:00.000Z');
const ago = (h: number) => new Date(now - h * HOUR).toISOString();

console.log('decideTimeWindow');

{
  const d = decideTimeWindow({ now, lastActiveAt: ago(0.2), idleSplitHours: 8 });
  check('刚聊过 → continue', d.action === 'continue', `${d.action}｜${d.reason}`);
  check('regime 标为 timeWindow', d.signals.regime === 'timeWindow', d.signals.regime);
}
{
  const d = decideTimeWindow({ now, lastActiveAt: ago(9), idleSplitHours: 8 });
  check('隔夜 → new', d.action === 'new', `${d.action}｜${d.reason}`);
  check('到点即换，置信度高（不该再问）', d.confidence >= 0.9, String(d.confidence));
}
{
  const d = decideTimeWindow({ now, lastActiveAt: ago(100), idleSplitHours: 0 });
  check('idleSplitHours=0 → 永不换', d.action === 'continue', `${d.action}｜${d.reason}`);
}
{
  // 边界：刚好到点
  const d = decideTimeWindow({ now, lastActiveAt: ago(8), idleSplitHours: 8 });
  check('刚好 8 小时 → 换（>= 而非 >）', d.action === 'new', d.action);
}

console.log('\nconversationKeyOf：群聊按发言人分指针');

{
  const a = conversationKeyOf({ kind: 'group', userId: 'A', chatId: 'C', mode: 'topic' });
  const b = conversationKeyOf({ kind: 'group', userId: 'B', chatId: 'C', mode: 'topic' });
  check('同群不同人在 topic 模式下键不同', a !== b, `${a} vs ${b}`);
  check('键里带发言人', a.includes('u_A') && b.includes('u_B'), `${a} / ${b}`);
}
{
  const a = conversationKeyOf({ kind: 'group', userId: 'A', chatId: 'C', mode: 'single' });
  const b = conversationKeyOf({ kind: 'group', userId: 'B', chatId: 'C', mode: 'single' });
  check('single 模式同群共用一个键（旧行为不变）', a === b, `${a} vs ${b}`);
  check('single 键不带发言人后缀', !a.includes(':u_A'), a);
}
{
  const a = conversationKeyOf({ kind: 'p2p', userId: 'A', chatId: 'C', mode: 'topic' });
  check('私聊键只按用户', a === 'feishu:u_A', a);
}
{
  const t = conversationKeyOf({ kind: 'group', userId: 'A', chatId: 'C', mode: 'timeWindow' });
  check('timeWindow 也按发言人分（同样会换弹巢）', t.includes(':u_A'), t);
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);

try {
  if (process.env.WAKER_DATA?.includes('revolver-modes-')) {
    rmSync(process.env.WAKER_DATA, { recursive: true, force: true });
  }
} catch {
  /* 清不掉不影响结论 */
}

if (fail > 0) throw new Error(`${fail} 个断言失败`);
