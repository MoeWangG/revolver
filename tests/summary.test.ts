/**
 * 会话卡的纯函数测试：闸门、去噪、提示词。
 *
 * 不测"模型写得像不像摘要"——那需要真调用，属于验收而非单测。
 * 这里测的是"什么时候该花这次钱"和"喂给模型的文本干不干净"。
 */
import {
  buildSummaryPrompt,
  canNameFromCard,
  denoise,
  gatesOf,
  shouldSummarize,
  splitSummaryOutput,
  titleFromSummary,
  type SummaryGates,
} from '../src/core/sessionSummary.ts';

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

const G: SummaryGates = gatesOf({
  maxChars: 200,
  idleMinutes: 10,
  minNewMessages: 4,
  perSessionDaily: 6,
  globalHourly: 20,
  timeoutMs: 15000,
});
const MIN = 60_000;
const now = Date.parse('2026-10-22T12:00:00.000Z');
const ago = (min: number) => new Date(now - min * MIN).toISOString();

const base = { now, summariesToday: 0, globalThisHour: 0, busy: false };

console.log('shouldSummarize：闸门');

check('没有标记 → 不跑', !shouldSummarize({ ...base, dirtyAt: undefined, dirtyCount: 9 }, G).ok);
check(
  '闲置不足 → 不跑',
  !shouldSummarize({ ...base, dirtyAt: ago(3), dirtyCount: 9 }, G).ok,
);
check(
  '新增不足 → 不跑',
  !shouldSummarize({ ...base, dirtyAt: ago(30), dirtyCount: 3 }, G).ok,
);
check(
  '单会话每日上限 → 不跑',
  !shouldSummarize({ ...base, dirtyAt: ago(30), dirtyCount: 9, summariesToday: 6 }, G).ok,
);
check(
  '全平台每小时上限 → 不跑',
  !shouldSummarize({ ...base, dirtyAt: ago(30), dirtyCount: 9, globalThisHour: 20 }, G).ok,
);
check('正在跑 → 不跑', !shouldSummarize({ ...base, dirtyAt: ago(30), dirtyCount: 9, busy: true }, G).ok);
check(
  '全部满足 → 跑',
  shouldSummarize({ ...base, dirtyAt: ago(30), dirtyCount: 9 }, G).ok,
);

console.log('\nshouldSummarize：边界');

check(
  '刚好 10 分钟 → 跑（>= 而非 >）',
  shouldSummarize({ ...base, dirtyAt: ago(10), dirtyCount: 4 }, G).ok,
);
check(
  '刚好 4 条 → 跑',
  shouldSummarize({ ...base, dirtyAt: ago(11), dirtyCount: 4 }, G).ok,
);

console.log('\ndenoise：剥掉对判断无用的噪声');

const messy = [
  '搞定，两份都改好了。',
  '## 已改的两份文档',
  '| 文档 | 链接 | 原权限 → 现权限 |',
  '|---|---|---|',
  '| **自检清单** | https://example.com/docx/ABC123 | tenant_readable → tenant_editable |',
  '```js',
  'const a = 1;',
  '```',
  '[看这里](https://example.com/x)',
].join('\n');

const clean = denoise(messy);
check('表格行被移除', !clean.includes('|---|') && !clean.includes('原权限'), clean);
check('代码块被移除', !clean.includes('const a'), clean);
check('裸链接被移除', !clean.includes('http'), clean);
check('链接保留文字', clean.includes('看这里'), clean);
check('标题符号被移除', !clean.includes('##'), clean);
check('正文结论保留', clean.includes('两份都改好了'), clean);

console.log('\nbuildSummaryPrompt');

const msgs = [
  { role: 'user' as const, text: '帮我改标题', at: ago(60) },
  { role: 'assistant' as const, text: '改成这样…', at: ago(59) },
];
const p = buildSummaryPrompt(msgs, 200);
check('写明字数上限', p.includes('不超过 200 字'));
check('要求先给一行标题（标题与摘要同一次调用产出）', p.includes('标题：') && p.includes('不超过 12 字'));
check('标题要求写话题本身、不要原话', p.includes('不是用户的原话'));
check('带上了对话内容', p.includes('用户：帮我改标题') && p.includes('助手：改成这样'));
check('没有把上限写死成别的值', !p.includes('不超过 120 字'));

const long = buildSummaryPrompt([{ role: 'user' as const, text: 'x'.repeat(2000), at: ago(1) }], 200);
check('单条消息被截到 600 字以内', long.length < 1200, `len=${long.length}`);

console.log('\ntitleFromSummary：用会话卡首行当标题');

check('多行只取首行', titleFromSummary('树莓派 3b 装系统\n\n- 换供电') === '树莓派 3b 装系统');
check('去掉项目符号', titleFromSummary('- 排查树莓派摄像头') === '排查树莓派摄像头');
check('去掉序号', titleFromSummary('1. 排查树莓派摄像头') === '排查树莓派摄像头');
check('去掉「这段」前缀（摘要开头的套话）', titleFromSummary('这段在聊树莓派装系统') === '在聊树莓派装系统');
check('去掉句末标点', titleFromSummary('排查摄像头不识别。') === '排查摄像头不识别');
check('空卡 → 空串（调用方据此不改名）', titleFromSummary('') === '' && titleFromSummary('   \n  ') === '');
{
  const t = titleFromSummary('排查树莓派 3b 装系统时摄像头一直不识别');
  check('超长截到 14 字并留省略号', t.length === 15 && t.endsWith('…'), t);
}

console.log('canNameFromCard：谁能被会话卡改名');

console.log('splitSummaryOutput：标题行与摘要分开');

{
  const r = splitSummaryOutput('标题：树莓派 AI 问答机\n\n烧卡卡在跳过自定义配置。\n- 用自定义镜像会跳过设置');
  check('取出标题并清洗', r.title === '树莓派 AI 问答机', r.title);
  check('摘要不含标题行', !r.summary.includes('标题：') && r.summary.startsWith('烧卡卡在'), r.summary);
}
{
  const r = splitSummaryOutput('【话题】ESP32 摄像头\n结论：先做 OCR');
  check('兼容【话题：】写法', r.title === 'ESP32 摄像头', r.title);
}
{
  const r = splitSummaryOutput('烧卡卡在跳过自定义配置。\n- 用自定义镜像会跳过设置');
  check('模型没给标题行 → title 为空、正文原样保留', r.title === '' && r.summary.startsWith('烧卡卡在'), r.summary);
}
{
  const r = splitSummaryOutput('标题：DeepSeek 对话抓取\n摘要：要把 40 个对话抓下来落盘。');
  check('摘掉摘要体前面的「摘要：」标签', r.summary === '要把 40 个对话抓下来落盘。', r.summary);
}
{
  const r = splitSummaryOutput('摘要：\n要解决的是把当天对话抓取落盘。\n结论：批量失败');
  check('没有标题行时也要摘掉「摘要：」', r.title === '' && r.summary.startsWith('要解决的是'), r.summary);
}
check('空输出 → 两个空串', splitSummaryOutput('').title === '' && splitSummaryOutput('   ').summary === '');

check('没有名字（默认会话）→ 可以', canNameFromCard({ name: '默认会话' }) && canNameFromCard({}));
check('首句派生的名字 → 可以升级', canNameFromCard({ name: '你可能能从记忆里找到，我们之前聊到如…', nameFrom: 'derive' }));
check(
  '模型起的名字 → 可以升级（卡片看到的内容更多）',
  canNameFromCard({ name: '树莓派装系统', nameSource: 'auto', nameFrom: 'messages' }),
);
check('用户手动改名 → 永不覆盖', !canNameFromCard({ name: '我自己起的', nameSource: 'manual' }));
check(
  '已经用卡命过名 → 不再改（否则每次生成卡列表就跳一次名）',
  !canNameFromCard({ name: '树莓派装系统', nameSource: 'auto', nameFrom: 'card' }),
);
check(
  '存量数据（无 nameFrom）且名字已经很好 → 不动，别把好名字换成卡片首行',
  !canNameFromCard({ name: '职业与副业规划' }),
);
check(
  '存量数据里"首句截断"的名字（以省略号结尾）→ 允许用卡升级',
  canNameFromCard({ name: '你可能能从记忆里找到，我们之前聊到如…', nameSource: 'auto' }),
);

console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail > 0) throw new Error(`${fail} 个断言失败`);
