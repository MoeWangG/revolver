/**
 * 决策账本的纯函数与落盘测试。
 *
 * 为什么值得测：账本是**事后优化的唯一证据**。字段写错（比如把"没算过向量"写成 0 分）
 * 会让后面调阈值的人得出完全相反的结论，而这种错误在对话里看不出来。
 *
 * 运行：node --experimental-strip-types tests/decisionLog.test.ts
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// paths.ts 在模块加载时读 WAKER_DATA —— 必须在 import 之前改环境变量，
// 否则测试会往真实 data/ 目录写账本。
const dir = mkdtempSync(join(tmpdir(), 'waker-decisions-'));
process.env.WAKER_DATA = dir;
const { appendDecision, candidateSnapshots, newDecisionId } = await import('../src/core/decisionLog.ts');

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

console.log('newDecisionId');

{
  const a = newDecisionId(1762500000000, () => 0.5);
  const b = newDecisionId(1762500000000, () => 0.75);
  check('同一毫秒、不同随机数 → 不同 id（重投/群聊多人不会串号）', a !== b, `${a} vs ${b}`);
  check('id 里能看出时间（36 进制前缀）', a.startsWith((1762500000000).toString(36)), a);
  check('后缀固定 4 位十六进制', /^[0-9a-z]+-[0-9a-f]{4}$/.test(a), a);
  check('随机数取 0 时也不会少位', newDecisionId(1, () => 0).endsWith('-0000'), newDecisionId(1, () => 0));
}

console.log('candidateSnapshots');

{
  const ranked = [
    { id: 'esp32', name: 'esp32-cam' },
    { id: 'pi', name: '树莓派AI问答机落地' },
    { id: 'noVec', name: '没有向量的会话' },
  ];
  const scores: Record<string, number | undefined> = { esp32: 1, pi: 0.6971234, noVec: undefined };
  const snaps = candidateSnapshots({
    ranked,
    nameOf: (s) => s.name,
    scoreOf: (id) => scores[id],
  });
  check('保持传入顺序（= 语义名次），rank 从 1 开始', snaps.map((s) => s.rank).join(',') === '1,2,3');
  check('带名字与 id（复盘要能看"当时列了哪几条"）', snaps[0]?.name === 'esp32-cam' && snaps[0]?.id === 'esp32');
  check('分数保留 3 位小数', snaps[1]?.score === 0.697, String(snaps[1]?.score));
  check(
    '没有向量的候选**不写 score 字段**（0 分和"没算过"是两回事）',
    !('score' in snaps[2]!),
    JSON.stringify(snaps[2]),
  );
  check('limit 生效', candidateSnapshots({ ranked, nameOf: (s) => s.name, scoreOf: () => 0.5, limit: 2 }).length === 2);
}

console.log('appendDecision（落盘到 WAKER_DATA）');

{
  appendDecision({ evt: 'route', id: 't-0001', at: '2026-11-08T00:00:00.000Z', message: '你好' });
  appendDecision({ evt: 'answer', id: 't-0001', at: '2026-11-08T00:00:01.000Z', kind: 'candidate' });
  const lines = readFileSync(join(dir, 'decisions.jsonl'), 'utf-8').trim().split('\n');
  check('每条事件一行 JSONL', lines.length === 2, String(lines.length));
  const first = JSON.parse(lines[0]!);
  const second = JSON.parse(lines[1]!);
  check('同 id 串起 route → answer', first.id === 't-0001' && second.id === 't-0001' && first.evt === 'route');
  check('中文原样保存（不是转义成一堆 \\u）', lines[0]!.includes('你好'));
  check('追加写不会覆盖前一行', second.evt === 'answer' && second.kind === 'candidate');
}

rmSync(dir, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
