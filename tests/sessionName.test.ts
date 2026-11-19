/**
 * 会话自动命名的纯函数测试：闸门、提示词、输出清洗。
 *
 * 不测"模型起得像不像人名"——那要真调用，属于验收。这里只钉住三件会反复坏的事：
 * 什么时候该花钱、喂进去的文本干不干净、模型带回的引号和句号有没有被剥掉。
 */
import {
  AUTO_NAME_ROUND,
  buildNamePrompt,
  cleanSessionName,
  displayNameOf,
  isDefaultName,
  looksDerivedName,
  shouldAutoName,
} from '../src/core/sessionName.ts';
import type { ChatMessage } from '../src/core/sessionHistory.ts';

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

console.log('isDefaultName：哪些名字算「没人起过」');

const nameCases: Array<[string, boolean, string]> = [
  ['默认会话', true, '兜底会话'],
  ['会话 7', true, '序号名'],
  ['会话7', true, '序号名没空格'],
  ['飞书私聊', true, '渠道默认名'],
  ['飞书群聊', true, '渠道默认名'],
  ['飞书文档评论 docx', true, '文件评论默认名'],
  ['定时·日报 2026-10-23', true, '定时任务占位名'],
  ['API·probe 2026-10-23', true, 'API 触发占位名'],
  ['', true, '空名当作没有名字'],
  ['职业与副业规划', false, '像人起的名字'],
  ['会话命名方案', false, '带「会话」但不是序号'],
  ['飞书私聊排查', false, '以渠道名开头但有内容'],
];
for (const [name, want, why] of nameCases) {
  const got = isDefaultName(name);
  check(`${why}：${JSON.stringify(name)} → ${want}`, got === want, `实际：${got}`);
}

console.log('\nshouldAutoName：闸门');

check(
  '第 2 轮 → 还不起名',
  !shouldAutoName({ enabled: true, round: AUTO_NAME_ROUND - 1, name: '默认会话' }),
);
check('第 3 轮 → 起名', shouldAutoName({ enabled: true, round: AUTO_NAME_ROUND, name: '默认会话' }));
check(
  '前面几轮都失败过，第 4 轮 → 仍然补上',
  shouldAutoName({ enabled: true, round: AUTO_NAME_ROUND + 1, name: '会话 3' }),
);
check(
  '已自动命名过 → 不覆盖',
  !shouldAutoName({ enabled: true, round: AUTO_NAME_ROUND + 2, name: '默认会话', nameSource: 'auto' }),
);
check(
  '用户手动改过 → 不覆盖',
  !shouldAutoName({ enabled: true, round: AUTO_NAME_ROUND, name: '默认会话', nameSource: 'manual' }),
);
check(
  '存量会话已有好名字 → 不覆盖',
  !shouldAutoName({ enabled: true, round: AUTO_NAME_ROUND + 3, name: '职业与副业规划' }),
);
check(
  '开关关闭 → 一次都不跑',
  !shouldAutoName({ enabled: false, round: AUTO_NAME_ROUND, name: '默认会话' }),
);
check(
  '首句派生的名字不算名字 → 第 3 轮仍然起名',
  shouldAutoName({ enabled: true, round: AUTO_NAME_ROUND, name: '你可能能从记忆里找到，我们之前聊到如…', nameFrom: 'derive' }),
);
check(
  '首句派生的名字，但轮次不够 → 还不起名',
  !shouldAutoName({ enabled: true, round: AUTO_NAME_ROUND - 1, name: '随便截的一句', nameFrom: 'derive' }),
);
check(
  '首句派生 + 用户手动改过 → 不覆盖',
  !shouldAutoName({
    enabled: true,
    round: AUTO_NAME_ROUND,
    name: '我自己起的',
    nameSource: 'manual',
    nameFrom: 'derive',
  }),
);
check(
  '已经用会话卡命过名 → 不再用对话起名（card 比 messages 更准）',
  !shouldAutoName({ enabled: true, round: AUTO_NAME_ROUND + 3, name: '树莓派装系统', nameSource: 'auto', nameFrom: 'card' }),
);
check(
  '模型起过名（messages 档）→ 不重复起名',
  !shouldAutoName({ enabled: true, round: AUTO_NAME_ROUND + 3, name: '树莓派装系统', nameSource: 'auto', nameFrom: 'messages' }),
);

console.log('\ndisplayNameOf：列表里显示哪个名字');

check(
  '有模型起的名字 → 用 name，不用首条消息派生的 title',
  displayNameOf({ name: '父爱AI产品化与孩子隐私边界', nameSource: 'auto', title: '你可能能从记忆里找到，我们之前聊到如…' }) ===
    '父爱AI产品化与孩子隐私边界',
);
check(
  '用户手动改过 → 用 name',
  displayNameOf({ name: '我自己起的', nameSource: 'manual', title: '随便一句原文' }) === '我自己起的',
);
check(
  '会话卡起的名 → 用 name',
  displayNameOf({ name: 'skill触发与记忆边界', nameFrom: 'card', title: 'howtolivebetter 那个…' }) === 'skill触发与记忆边界',
);
check(
  '首句派生的 name（derive 档）+ 有 title → 仍然用 name（两者同源，name 是落库的那个）',
  displayNameOf({ name: '树莓派 3b 装系统', nameFrom: 'derive', title: '另外一件事儿…' }) === '树莓派 3b 装系统',
);
check(
  '默认名 + 有 title → 用 title（总比「飞书私聊」强）',
  displayNameOf({ name: '飞书私聊', title: '帮我把 web 端会话名补上' }) === '帮我把 web 端会话名补上',
);
check(
  '默认名 + 没 title → 用 name',
  displayNameOf({ name: '会话 3' }) === '会话 3',
);

console.log('\nlooksDerivedName：存量"首句截断"的名字');

check('以省略号结尾 → 认作首句截断', looksDerivedName('你可能能从记忆里找到，我们之前聊到如…'));
check('英文省略号也认', looksDerivedName('howtolivebetter 那个...'));
check('顶到 16 字且结尾不是标点 → 认作被硬截断', looksDerivedName('Refactoring UI s'));
check('满 16 字但以标点收尾 → 不认（那是完整的名字）', !looksDerivedName('这是一个完整的十六字长名字。'));
check('正常名字 → 不认', !looksDerivedName('职业与副业规划') && !looksDerivedName('AI+HR创业变现验证'));
check('空名 → 不认（那是"没名字"，走 isDefaultName 那条）', !looksDerivedName('') );
check(
  '存量 auto 名字是首句截断 → 第 3 轮重起一次',
  shouldAutoName({
    enabled: true,
    round: AUTO_NAME_ROUND,
    name: '另外一件事儿，我要用树莓派3b 给孩…',
    nameSource: 'auto',
  }),
);
check(
  '存量 auto 名字是真名字 → 不动',
  !shouldAutoName({ enabled: true, round: AUTO_NAME_ROUND + 5, name: 'AI产品四问清单与飞书授权', nameSource: 'auto' }),
);

console.log('\ncleanSessionName：剥包装');

const cases: Array<[string, string, string]> = [
  ['标题：MacBook 选购', 'MacBook 选购', '去「标题：」前缀'],
  ['会话名：「上下文压缩排查」', '上下文压缩排查', '同时去前缀与引号'],
  ['《会话命名方案》', '会话命名方案', '去书名号'],
  ['"上下文压缩排查。"', '上下文压缩排查', '去英文引号与句末句号'],
  ['  会话命名方案  ', '会话命名方案', '去首尾空白'],
  ['名字\n这样起是因为…', '名字', '只取第一行'],
  ['上下文压缩排查！', '上下文压缩排查', '去感叹号'],
  ['', '', '空输出 → 空串'],
  ['   \n  ', '', '纯空白 → 空串'],
];
for (const [raw, want, why] of cases) {
  const got = cleanSessionName(raw);
  check(`${why}：${JSON.stringify(raw)} → ${JSON.stringify(want)}`, got === want, `实际：${JSON.stringify(got)}`);
}

const long = '这是一个明显超过十六个字的会话名字用来测试截断行为';
const cut = cleanSessionName(long);
check('超长 → 截到 16 字', cut.length === 16, `实际长度：${cut.length}`);
check('超长 → 保留前缀而不是报错', long.startsWith(cut));

console.log('\nbuildNamePrompt：喂什么');

const msgs: ChatMessage[] = [
  { role: 'user', text: '帮我把 web 端的会话名补上', at: '2026-10-23T00:00:00.000Z' },
  { role: 'assistant', text: '好，先看 /api/talk 这条链路', at: '2026-10-23T00:00:01.000Z' },
  { role: 'user', text: '```ts\nconst a = 1\n```\n顺便把标题也改了', at: '2026-10-23T00:00:02.000Z' },
];
const prompt = buildNamePrompt(msgs);
check('带上字数上限', prompt.includes('16 个字'));
check('要求只输出名字', prompt.includes('只输出这个名字本身'));
check('用户话带「用户：」前缀', prompt.includes('用户：帮我把 web 端的会话名补上'));
check('助手话带「助手：」前缀', prompt.includes('助手：好，先看'));
check('代码块被压掉，不白烧 token', !prompt.includes('const a = 1'));
check('代码块后面的正文保留', prompt.includes('顺便把标题也改了'));

if (fail) {
  console.error(`\n${fail} 项失败，${pass} 项通过`);
  process.exit(1);
}
console.log(`\n全部通过（${pass} 项）`);
