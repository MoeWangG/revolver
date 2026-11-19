/**
 * 话题询问卡片的单测：卡片结构 + 回调解析。
 *
 * 为什么要测这个：卡片回调在真实环境里很难复现（要租户开事件订阅、要人点按钮），
 * 一旦"按钮塞的 value"和"回调里读的位置"对不上，表现是**点了没反应**，
 * 而且在日志里几乎看不到痕迹。所以把这对契约钉死在测试里。
 */
import {
  buildTopicAskCard,
  buildTopicCardState,
  buildTopicListCard,
  composeTopicAsk,
  composeTopicList,
  parseTopicCardAction,
  parseTopicCardContext,
  parseTopicChoose,
  parseTopicListRequest,
  parseTopicNone,
  parseTopicPick,
  type TopicListItem,
} from '../src/channels/topicCard.ts';

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

const BODY = '**这句话可能接着下面某条旧话题**\n\n**当前在聊**：《内容持续输出卡点分析》';
const askInput = {
  body: BODY,
  currentTitle: '内容持续输出卡点分析',
  candidates: [
    { id: 'aaaa1111', title: 'esp32-cam' },
    { id: 'bbbb2222', title: '树莓派AI问答机落地' },
  ],
};
const card = buildTopicAskCard(askInput);
const els = ((card.body as Record<string, any>).elements ?? []) as Array<Record<string, any>>;

console.log('buildTopicAskCard');

check('schema 是 2.0（与 mdCard 产出的卡片同版本）', card.schema === '2.0', String(card.schema));
check('正文原样进第一个 markdown 元素', els[0]?.tag === 'markdown' && els[0]?.content === BODY);
check(
  '中间有分割线',
  els.some((e) => e.tag === 'hr'),
);
const buttons = els.filter((e) => e.tag === 'button');
check('候选 2 条 + 留在当前 + 看全部话题 + 以上都不是 = 5 个按钮', buttons.length === 5, String(buttons.length));
check(
  '第一个按钮直接写话题名「切到《esp32-cam》」（不是"切回去"这种方位词）',
  (buttons[0]?.text as Record<string, any>)?.content === '切到《esp32-cam》',
  JSON.stringify(buttons[0]?.text),
);
check(
  '第二个按钮是第二个候选',
  (buttons[1]?.text as Record<string, any>)?.content === '切到《树莓派AI问答机落地》',
);
check(
  '「留在」按钮写清留在哪条话题',
  (buttons[2]?.text as Record<string, any>)?.content === '留在《内容持续输出卡点分析》',
  JSON.stringify(buttons[2]?.text),
);
check(
  '最后是「看看全部话题」',
  (buttons[3]?.text as Record<string, any>)?.content === '看看全部话题',
);
check(
  '再补一个「以上都不是」（负样本，比"留在当前"更明确）',
  (buttons[4]?.text as Record<string, any>)?.content === '以上都不是',
  JSON.stringify(buttons[4]?.text),
);
check(
  '没有混用 1.0 的 action 容器（2.0 里会被整条拒收）',
  !els.some((e) => e.tag === 'action'),
);
check(
  '候选按钮回调是 k=topicChoose + sid',
  buttons.slice(0, 2).every(
    (b) =>
      Array.isArray(b.behaviors) &&
      b.behaviors.length === 1 &&
      b.behaviors[0]?.type === 'callback' &&
      b.behaviors[0]?.value?.k === 'topicChoose' &&
      typeof b.behaviors[0]?.value?.sid === 'string',
  ),
  JSON.stringify(buttons.slice(0, 2).map((b) => b.behaviors)),
);
check(
  '「留在」按钮的 k=topic / answer=no',
  buttons[2]?.behaviors?.[0]?.value?.k === 'topic' && buttons[2]?.behaviors?.[0]?.value?.answer === 'no',
);
check(
  '「看全部话题」的 k=topicList（不改指针，混用会被当成回答）',
  buttons[3]?.behaviors?.[0]?.value?.k === 'topicList' &&
    buttons[3]?.behaviors?.[0]?.value?.answer === undefined,
  JSON.stringify(buttons[3]?.behaviors),
);
check(
  '「以上都不是」的 k=topicNone（与留在当前分开：前者是负样本）',
  buttons[4]?.behaviors?.[0]?.value?.k === 'topicNone',
  JSON.stringify(buttons[4]?.behaviors),
);
check(
  '卡片 JSON 可序列化且在预算内',
  JSON.stringify(card).length < 4000,
  `${JSON.stringify(card).length} 字节`,
);

{
  const solo = buildTopicAskCard({ body: BODY, currentTitle: '当前话题', candidates: [] });
  const b = (((solo.body as Record<string, any>).elements ?? []) as Array<Record<string, any>>).filter(
    (e) => e.tag === 'button',
  );
  check('没有候选时只剩「留在…」+「看全部话题」+「以上都不是」', b.length === 3, String(b.length));
}

console.log('composeTopicAsk（卡片正文与纯文本退路必须分开）');

{
  const ask = composeTopicAsk(askInput);
  check(
    '卡片正文里没有「回 1」——编号只属于纯文本退路',
    !JSON.stringify(ask.card).includes('回 **1**'),
    JSON.stringify(ask.card),
  );
  check(
    '退路按按钮同序编号：1..N 候选，N+1 留当前，N+2 看全部',
    ask.fallback.includes('回 **1** 切到《esp32-cam》') &&
      ask.fallback.includes('回 **2** 切到《树莓派AI问答机落地》') &&
      ask.fallback.includes('回 **3** 留在《内容持续输出卡点分析》') &&
      ask.fallback.includes('回 **4** 看全部话题') &&
      ask.fallback.includes('回 **5** 以上都不是'),
    ask.fallback,
  );
  check('退路自成一体：正文在它里面', ask.fallback.startsWith(BODY));
  check(
    '退路里的编号不在卡片里重复出现（卡片只有按钮）',
    (ask.card.body as Record<string, any>).elements.filter((e: Record<string, any>) => e.tag === 'button').length === 5 &&
      !JSON.stringify(ask.card).includes('回 **5**'),
  );
  const empty = composeTopicAsk({ body: BODY, currentTitle: '当前话题', candidates: [] });
  check(
    '没有候选时退路是「回 1 留在当前 / 回 2 看全部 / 回 3 都不是」',
    empty.fallback.includes('回 **1** 留在《当前话题》') &&
      empty.fallback.includes('回 **2** 看全部话题') &&
      empty.fallback.includes('回 **3** 以上都不是'),
    empty.fallback,
  );
}

console.log('buildTopicCardState（点完按钮后的卡片状态）');

{
  const els = (c: Record<string, unknown>) => ((c.body as Record<string, any>).elements ?? []) as Array<Record<string, any>>;
  const md = (c: Record<string, unknown>) => String(els(c)[0]?.content ?? '');

  const processing = buildTopicCardState('processing', '切回去');
  check(
    'processing：按钮全部消失（2.0 没有 disabled，删掉才防误点）',
    !els(processing).some((e) => e.tag === 'button'),
  );
  check('processing：写明点了哪个', md(processing).includes('已选择：切回去'), md(processing));
  check('processing：有「正在处理」的进度表达', md(processing).includes('⏳'), md(processing));

  const done = buildTopicCardState('done', '切回去');
  check('done：无按钮 + 已处理完成', !els(done).some((e) => e.tag === 'button') && md(done).includes('已处理完成'), md(done));

  const expired = buildTopicCardState('expired', '就在这儿继续');
  check('expired：无按钮 + 说明已处理过', !els(expired).some((e) => e.tag === 'button') && md(expired).includes('已经处理过'), md(expired));
  check(
    'expired 且不知道点了哪个时，不编造按钮名',
    md(buildTopicCardState('expired')).includes('已收到你的选择') && !md(buildTopicCardState('expired')).includes('已选择：'),
    md(buildTopicCardState('expired')),
  );

  const failed = buildTopicCardState('failed', '切回去');
  check('failed：⚠️ 且提示重发', md(failed).includes('⚠️') && md(failed).includes('重发'), md(failed));

  check(
    '状态卡保持 2.0 + update_multi（否则后续 patch 不生效）',
    processing.schema === '2.0' &&
      (processing.config as Record<string, any>)?.update_multi === true,
  );
  check('状态卡在预算内', JSON.stringify(processing).length < 1000, `${JSON.stringify(processing).length} 字节`);
}

console.log('parseTopicCardAction');

check(
  'event.action.value 对象 → yes',
  parseTopicCardAction({ event: { action: { value: { k: 'topic', answer: 'yes' } } } }) === 'yes',
);
check(
  'action.value → no',
  parseTopicCardAction({ action: { value: { k: 'topic', answer: 'no' } } }) === 'no',
);
check(
  'value 是 JSON 字符串也能认（飞书两种包法都出现过）',
  parseTopicCardAction({ event: { action: { value: '{"k":"topic","answer":"yes"}' } } }) === 'yes',
);
check('顶层 value', parseTopicCardAction({ value: { k: 'topic', answer: 'no' } }) === 'no');
check(
  '别的卡片的按钮 → null（不猜，别把会话搬错地方）',
  parseTopicCardAction({ event: { action: { value: { k: 'other', answer: 'yes' } } } }) === null,
);
check(
  'answer 不是 yes/no → null',
  parseTopicCardAction({ event: { action: { value: { k: 'topic', answer: 'maybe' } } } }) === null,
);
check('空载荷 → null', parseTopicCardAction(null) === null && parseTopicCardAction({}) === null);
check(
  '字符串不是 JSON → null（不能抛错）',
  parseTopicCardAction({ event: { action: { value: 'not-json' } } }) === null,
);

console.log('parseTopicListRequest');

check(
  'event.action.value 是 topicList → true',
  parseTopicListRequest({ event: { action: { value: { k: 'topicList' } } } }) === true,
);
check(
  'JSON 字符串包法也认（与 yes/no 同源的问题）',
  parseTopicListRequest({ event: { action: { value: '{"k":"topicList"}' } } }) === true,
);
check(
  'yes/no 的回调不能被误判成「看全部话题」',
  parseTopicListRequest({ event: { action: { value: { k: 'topic', answer: 'yes' } } } }) === false,
);
check(
  '列表卡「切到这儿」的回调也不能被误判',
  parseTopicListRequest({ event: { action: { value: { k: 'topicPick', sid: 'aaaa1111' } } } }) === false,
);
check('空载荷 → false（不抛错）', parseTopicListRequest(null) === false && parseTopicListRequest({}) === false);

console.log('parseTopicNone');

check('topicNone → true', parseTopicNone({ event: { action: { value: { k: 'topicNone' } } } }) === true);
check('JSON 字符串包法也认', parseTopicNone({ event: { action: { value: '{"k":"topicNone"}' } } }) === true);
check(
  '「留在当前」不能被当成"都不是"（负样本不能收错）',
  parseTopicNone({ event: { action: { value: { k: 'topic', answer: 'no' } } } }) === false,
);
check('topicList 也不能被误判', parseTopicNone({ event: { action: { value: { k: 'topicList' } } } }) === false);
check('空载荷 → false', parseTopicNone(null) === false && parseTopicNone({}) === false);

console.log('parseTopicChoose');

check(
  'event.action.value 是 topicChoose → sid',
  parseTopicChoose({ event: { action: { value: { k: 'topicChoose', sid: 'abc12345' } } } }) === 'abc12345',
);
check(
  'JSON 字符串包法也认',
  parseTopicChoose({ event: { action: { value: '{"k":"topicChoose","sid":"aaaa1111"}' } } }) === 'aaaa1111',
);
check(
  '「留在当前」的回调不能被当成选候选（否则会把用户送去别的会话）',
  parseTopicChoose({ event: { action: { value: { k: 'topic', answer: 'no' } } } }) === null,
);
check(
  '列表卡的「切到这儿」也不能被误判（两条路径行为不同：一个带原话作答，一个只搬指针）',
  parseTopicChoose({ event: { action: { value: { k: 'topicPick', sid: 'aaaa1111' } } } }) === null,
);
check(
  'sid 缺失或空白 → null（不猜目标）',
  parseTopicChoose({ event: { action: { value: { k: 'topicChoose', sid: '  ' } } } }) === null &&
    parseTopicChoose({ event: { action: { value: { k: 'topicChoose' } } } }) === null,
);
check('空载荷 → null', parseTopicChoose(null) === null && parseTopicChoose({}) === null);

console.log('parseTopicCardContext');

{
  const c = parseTopicCardContext({
    event: { context: { open_chat_id: 'oc_1', open_message_id: 'om_1' }, operator: { open_id: 'ou_1' } },
  });
  check('取 chat / message / open_id', c.chatId === 'oc_1' && c.messageId === 'om_1' && c.openId === 'ou_1');
}
{
  const c = parseTopicCardContext({ context: { chat_id: 'oc_2', message_id: 'om_2' }, operator: { user_id: 'u_2' } });
  check('兼容 chat_id / message_id / user_id 命名', c.chatId === 'oc_2' && c.messageId === 'om_2' && c.openId === 'u_2');
}
{
  const c = parseTopicCardContext({});
  check('缺字段给空串（调用方据此跳过，不拿 undefined 拼 key）', c.chatId === '' && c.openId === '' && c.messageId === '');
}

console.log('buildTopicListCard（折叠面板 + 就地切换）');

const items: TopicListItem[] = [
  {
    index: 1,
    id: 'aaaa1111',
    title: '树莓派 3b 装系统',
    meta: '7 小时前 · 130 条',
    recap: '排查摄像头不识别：换供电、改 config.txt。',
  },
  { index: 2, id: 'bbbb2222', title: 'ESP32 摄像头选型', meta: '3 天前 · 6 条', recap: '', current: true },
];

{
  const c = buildTopicListCard(items);
  const els = ((c.body as Record<string, any>).elements ?? []) as Array<Record<string, any>>;
  const panels = els.filter((e) => e.tag === 'collapsible_panel');
  const headerOf = (p: Record<string, any>) => String(p.header?.title?.content ?? '');

  check('每条话题一个折叠面板', panels.length === 2, String(panels.length));
  check('默认收起（一屏能看完全部标题）', panels.every((p) => p.expanded === false));
  check(
    '标题行带序号 + 标题 + 时间条数',
    headerOf(panels[0]!) === '**1. 树莓派 3b 装系统**　7 小时前 · 130 条',
    headerOf(panels[0]!),
  );
  check('当前话题多一个「当前」标记', headerOf(panels[1]!).endsWith('·　当前'), headerOf(panels[1]!));

  const btns = panels.flatMap((p) =>
    ((p.elements ?? []) as Array<Record<string, any>>).filter((e) => e.tag === 'button'),
  );
  check('只有「非当前」的话题有切换按钮', btns.length === 1, String(btns.length));
  check(
    '按钮回传 {k:"topicPick", sid}，与 yes/no 的 k:"topic" 分开',
    btns[0]?.behaviors?.[0]?.value?.k === 'topicPick' && btns[0]?.behaviors?.[0]?.value?.sid === 'aaaa1111',
    JSON.stringify(btns[0]?.behaviors),
  );
  check(
    '当前话题写明"就在这个话题里"，不给按钮',
    String(
      ((panels[1]!.elements ?? []) as Array<Record<string, any>>).map((e) => e.content ?? '').join(' '),
    ).includes('当前就在这个话题里'),
  );
  check('没有混用 1.0 的 action 容器', !JSON.stringify(c).includes('"action"'));
  check('卡片 JSON 可序列化且在预算内', JSON.stringify(c).length < 8000, `${JSON.stringify(c).length} 字节`);
}

console.log('composeTopicList（纯文本退路必须自带区分度）');

{
  const { fallback } = composeTopicList(items, 5);
  check('首行说清总数（不只是展示出来的条数）', fallback.startsWith('这个窗口装过 5 个话题：'), fallback);
  check('每行带序号 + 标题 + 时间条数', fallback.includes('1. 树莓派 3b 装系统（7 小时前 · 130 条）'), fallback);
  check('当前话题有「← 当前」标记', fallback.includes('2. ESP32 摄像头选型（3 天前 · 6 条）  ← 当前'), fallback);
  check('第二行是摘要首句（没有标题信息就靠它区分）', fallback.includes('排查摄像头不识别'), fallback);
  check('没有摘要时不留空行噪声', !fallback.includes('（这段还没有摘要'), fallback);
  check('截断时说明还有多少条', fallback.includes('另有 3 个话题'), fallback);
  check('保留 /resume 与 /back 入口', fallback.includes('/resume 序号') && fallback.includes('/back'), fallback);
}

console.log('parseTopicPick');

check(
  'event.action.value 对象 → sessionId',
  parseTopicPick({ event: { action: { value: { k: 'topicPick', sid: 'aaaa1111' } } } }) === 'aaaa1111',
);
check(
  'value 是 JSON 字符串也能认',
  parseTopicPick({ event: { action: { value: '{"k":"topicPick","sid":"bbbb2222"}' } } }) === 'bbbb2222',
);
check('顶层 value', parseTopicPick({ value: { k: 'topicPick', sid: 'cccc3333' } }) === 'cccc3333');
check(
  'yes/no 卡片的回调不会被当成 pick',
  parseTopicPick({ event: { action: { value: { k: 'topic', answer: 'yes' } } } }) === null,
);
check(
  'sid 缺失或空白 → null（不猜目标）',
  parseTopicPick({ value: { k: 'topicPick', sid: '   ' } }) === null && parseTopicPick({ value: { k: 'topicPick' } }) === null,
);
check('空载荷 → null', parseTopicPick(null) === null && parseTopicPick({}) === null);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
