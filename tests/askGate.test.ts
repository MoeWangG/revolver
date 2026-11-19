/**
 * 询问门（ask gate）的单测。
 *
 * 它只回答一件事：这一轮判定结果**能不能不问就落指针**。
 * 平台最怕的从来不是多问一句，而是不问就把用户搬到别的会话——
 * 所以 autoSwitch: false 必须是硬约束，不能被 rejectLimit 或 ask: never 绕开。
 *
 * 运行：node --experimental-strip-types tests/askGate.test.ts
 */
import { decideAskGate } from '../src/core/topicRouter.ts';

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

console.log('decideAskGate');

// 1) 默认：ask: always 且没拒绝过 → 先问
{
  const gate = decideAskGate({ ask: 'always', autoSwitch: true, rejectStreak: 0, rejectLimit: 2 });
  check('默认先问', gate === 'ask', `得到 ${gate}`);
}

// 2) 拒绝配额用尽 → 既不再问，也不切（"退化成不切"，不是"退化成直接切"）
{
  const gate = decideAskGate({ ask: 'always', autoSwitch: true, rejectStreak: 2, rejectLimit: 2 });
  check('拒绝配额用尽 → 留在原会话', gate === 'stay', `得到 ${gate}`);
}

// 3) ask: never 是用户显式选择 → 允许直接切
{
  const gate = decideAskGate({ ask: 'never', autoSwitch: true, rejectStreak: 0, rejectLimit: 2 });
  check('ask: never → 直接切', gate === 'auto', `得到 ${gate}`);
}

// 4) autoSwitch: false 是硬约束：拒绝过多少次都仍然要问
{
  const gate = decideAskGate({ ask: 'always', autoSwitch: false, rejectStreak: 99, rejectLimit: 2 });
  check('禁止自动切换 → 永远先问', gate === 'ask', `得到 ${gate}`);
}

// 5) 且它压过 ask: never —— 两个配置打架时，"不许自动切"不能被悄悄忽略
{
  const gate = decideAskGate({ ask: 'never', autoSwitch: false, rejectStreak: 0, rejectLimit: 2 });
  check('禁止自动切换压过 ask: never', gate === 'ask', `得到 ${gate}`);
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail > 0) throw new Error(`${fail} 个断言失败`);
