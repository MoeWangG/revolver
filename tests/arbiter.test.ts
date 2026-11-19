/**
 * 小模型仲裁层的单测。
 *
 * 只测纯函数（prompt 构造 / 输出解析 / 决策翻译）与"关掉就不联网"的降级路径，
 * 不调模型、不读文件——判定链路一旦不可复现，就再也答不出"为什么这次切了"。
 *
 * 运行：node --experimental-strip-types tests/arbiter.test.ts
 */
import {
  arbitrate,
  buildArbiterPrompt,
  buildSystemOneRequest,
  decisionFromArbiter,
  matchExplicitNewTopic,
  parseArbiterOutput,
  parseSystemOneAnswers,
} from '../src/core/topicArbiter.ts';
import type { SessionMeta } from '../src/core/sessions.ts';
import type { RouteDecision } from '../src/core/topicRouter.ts';

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

const mk = (id: string, title: string, extra: Partial<SessionMeta> = {}): SessionMeta => ({
  id,
  wakerId: 'chat',
  name: title,
  title,
  piSessionId: `waker-chat-${id}`,
  createdAt: '2026-10-20T00:00:00.000Z',
  lastActiveAt: '2026-10-25T00:00:00.000Z',
  messageCount: 10,
  ...extra,
});

const active = mk('734e8785', '我想聊聊创业', {
  messageCount: 42,
  cardSummary: 'AI 随身拍照设备的硬件选型、充电宝与 Type-C 供电、云服务与 App 分工。',
});

const others = [
  mk('1ca6730a', '飞书私聊', { messageCount: 58 }),
  mk('fe7b2f0a', '职业与副业规划', { messageCount: 6 }),
];

const base: RouteDecision = {
  action: 'continue',
  confidence: 0.379,
  signals: {
    gapHours: 6.5,
    overlapActive: 0,
    overlapBest: 0,
    bestSessionId: '1ca6730a',
    regime: 'semantic',
    semanticActive: 0.55,
    semanticBest: 0.533,
  },
  reason: '语义信号不足（当前 0.55、间隔 6.5h），留在当前会话',
};

// —————————— 1. 显式指令 ——————————
console.log('matchExplicitNewTopic');

{
  const r = matchExplicitNewTopic('新话题');
  check('裸「新话题」命中且无标题', r !== null && r.title === undefined, JSON.stringify(r));
}
{
  const r = matchExplicitNewTopic('新话题：怎么跟老板谈涨薪');
  check('「新话题：标题」取出标题', r?.title === '怎么跟老板谈涨薪', JSON.stringify(r));
}
{
  const r = matchExplicitNewTopic('换个话题，帮我看看 K8s 的 ingress 怎么配');
  check('「换个话题，…」命中', r?.title === '帮我看看 K8s 的 ingress 怎么配', JSON.stringify(r));
}
check('「说点别的」命中', matchExplicitNewTopic('说点别的') !== null);
check('「另一个话题」命中', matchExplicitNewTopic('另一个话题 聊聊理财') !== null);
{
  const r = matchExplicitNewTopic('你上次说的那个「新话题」功能是什么');
  check('句中提到「新话题」不算指令', r === null, JSON.stringify(r));
}
{
  const r = matchExplicitNewTopic('新话题这个功能怎么用');
  check('「新话题这个功能怎么用」是在提问，不算指令', r === null, JSON.stringify(r));
}
check('普通问句不命中', matchExplicitNewTopic('重量多少来着') === null);

// —————————— 2. prompt 构造 ——————————
console.log('buildArbiterPrompt');

{
  const { system, user } = buildArbiterPrompt({
    message: '新话题',
    active,
    candidates: others,
    recent: [
      { role: 'user', text: '市面上有没有类似的产品已经在卖了？' },
      { role: 'assistant', text: '有几家在卖，但都不支持小电流保活。' },
    ],
  });
  check('带当前会话标题', system.includes('《我想聊聊创业》'), system.slice(0, 80));
  check('带会话卡摘要', system.includes('AI 随身拍照设备'), '');
  check('带用户与助手两轮', system.includes('用户：市面上') && system.includes('助手：有几家'), '');
  check('候选按编号列出', system.includes('1. 《飞书私聊》') && system.includes('2. 《职业与副业规划》'), '');
  check('带 few-shot 与输出约束', system.includes('SWITCH 编号') && system.includes('只输出一个词'), '');
  check('user 带原话', user.includes('「新话题」'), user);
}
{
  const many = Array.from({ length: 8 }, (_, i) => mk(`s${i}`, `会话${i}`));
  const { system } = buildArbiterPrompt({ message: 'x', active, candidates: many, recent: [] });
  check('候选最多编号 5 个', system.includes('5. 《会话4》') && !system.includes('6. 《会话5》'), '');
  check('没有最近对话时不出现"最近两轮"', !system.includes('最近两轮'), '');
}

// —————————— 2.5 决策模型接口（laya） ——————————
console.log('buildSystemOneRequest / parseSystemOneAnswers');

{
  const req = buildSystemOneRequest(
    { message: '上次说的那趟日本行怎么样', active, candidates: others, recent: [] },
    'laya',
  );
  const q = req.questions as Record<string, any>;
  check('带 model', req.model === 'laya');
  check(
    'state 带当前会话与用户原话',
    String(req.state).includes('《我想聊聊创业》') && String(req.state).includes('日本行'),
    String(req.state).slice(0, 60),
  );
  check(
    '只问一个问题（where）：current + c1..cN + next',
    Object.keys(q.where.criteria).join(',') === 'current,c1,c2,next',
    Object.keys(q.where.criteria).join(','),
  );
  check('current 选项写明当前会话名', String(q.where.criteria.current).includes('我想聊聊创业'), q.where.criteria.current);
  check('候选描述用标题', String(q.where.criteria.c1).includes('飞书私聊'), q.where.criteria.c1);
  check('state 控制在决策模型的输入预算内', String(req.state).length <= 220, `${String(req.state).length} 字`);
}

{
  const r = parseSystemOneAnswers({ answers: { where: { choice: 'current' } } }, others);
  check('where=current → continue', r?.action === 'continue');
  const r2 = parseSystemOneAnswers({ answers: { where: { choice: 'next' } } }, others);
  check('where=next → new', r2?.action === 'new');
  const r3 = parseSystemOneAnswers({ answers: { where: { choice: 'c2' } } }, others);
  check('where=c2 → 第二个候选', r3?.action === 'switch' && r3.targetSessionId === 'fe7b2f0a', JSON.stringify(r3));
  check('where 越界 → null（不瞎切）', parseSystemOneAnswers({ answers: { where: { choice: 'c9' } } }, others) === null);
}
{
  const r = parseSystemOneAnswers({ answers: { action: { choice: 'new', probabilities: { new: 0.9 } } } }, others);
  check('choice=new → new', r?.action === 'new');
}
{
  const r = parseSystemOneAnswers({ answers: { action: { choice: 'switch' }, target: { choice: 'c2' } } }, others);
  check('switch + c2 指向第二个候选', r?.action === 'switch' && r.targetSessionId === 'fe7b2f0a', JSON.stringify(r));
}
{
  const r = parseSystemOneAnswers({ answers: { action: { choice: 'switch' }, target: { choice: 'none' } } }, others);
  check('switch 但没给候选 → 退回 continue（不瞎切）', r?.action === 'continue', JSON.stringify(r));
}
{
  const r = parseSystemOneAnswers({ answers: { action: { choice: 'switch' }, target: { choice: 'c9' } } }, others);
  check('编号越界也退回 continue', r?.action === 'continue');
}
check('缺 answers → null', parseSystemOneAnswers({}, others) === null);
check('choice 不在枚举 → null', parseSystemOneAnswers({ answers: { action: { choice: 'maybe' } } }, others) === null);

// —————————— 3. 输出解析 ——————————
console.log('parseArbiterOutput');

check('NEW', parseArbiterOutput('NEW', others)?.action === 'new');
check('前后空白与换行', parseArbiterOutput('  CONTINUE\n', others)?.action === 'continue');
check('小写也认', parseArbiterOutput('continue', others)?.action === 'continue');
{
  const r = parseArbiterOutput('SWITCH 2', others);
  check('SWITCH 2 指向第 2 个候选', r?.action === 'switch' && r.targetSessionId === 'fe7b2f0a', JSON.stringify(r));
}
{
  const r = parseArbiterOutput('SWITCH 9', others);
  check('编号越界退回 CONTINUE（不瞎切）', r?.action === 'continue', JSON.stringify(r));
}
{
  const r = parseArbiterOutput('SWITCH', others);
  check('SWITCH 无编号退回 CONTINUE', r?.action === 'continue', JSON.stringify(r));
}
{
  const r = parseArbiterOutput('规则里说 NEW，但这一句是 CONTINUE', others);
  check('thinking 复述时取最后一个结论', r?.action === 'continue', JSON.stringify(r));
}
check('空输出返回 null', parseArbiterOutput('', others) === null);
check('无关文本返回 null', parseArbiterOutput('我不确定', others) === null);

// —————————— 4. 决策翻译 ——————————
console.log('decisionFromArbiter');

{
  const d = decisionFromArbiter({ action: 'continue', raw: 'CONTINUE', ms: 600, model: 'laya' }, base, active.id);
  check('continue 置信度 0.9 且清掉 target', d.action === 'continue' && d.confidence === 0.9 && !d.targetSessionId);
  check('continue 保留原 signals 便于归因', d.signals.semanticActive === 0.55);
}
{
  const d = decisionFromArbiter(
    { action: 'switch', targetSessionId: '1ca6730a', raw: 'SWITCH 1', ms: 700, model: 'laya' },
    base,
    active.id,
  );
  check('switch 置信度 0.75 且带目标', d.action === 'switch' && d.confidence === 0.75 && d.targetSessionId === '1ca6730a');
}
{
  const d = decisionFromArbiter(
    { action: 'switch', targetSessionId: active.id, raw: 'SWITCH 1', ms: 700, model: 'laya' },
    base,
    active.id,
  );
  // 曾经翻成 new：目标指向自己时白开一个弹巢，正是这条链路里最贵的错误。
  check('切回自己 = 继续（不新开弹巢、不打转）', d.action === 'continue' && !d.targetSessionId, d.action);
  check('切回自己的 reason 说清楚是"目标即当前"', d.reason.includes('目标即当前'), d.reason);
}
{
  const d = decisionFromArbiter({ action: 'new', raw: 'NEW', ms: 500, model: 'laya' }, base, active.id);
  check('new 置信度 0.75（够过询问门槛，不假装确定）', d.action === 'new' && d.confidence === 0.75);
  check('reason 带模型与耗时', d.reason.includes('仲裁') && d.reason.includes('laya'));
}

// —————————— 5. 降级 ——————————
console.log('arbitrate 降级');

{
  const r = await arbitrate(
    { message: '新话题', active, candidates: others, recent: [] },
    { enabled: false, baseUrl: 'http://127.0.0.1:59999/v1', model: 'x', timeoutMs: 100 },
  );
  check('关掉即返回 null，不联网', r === null);
}
{
  const r = await arbitrate(
    { message: '新话题', active, candidates: others, recent: [] },
    { enabled: true, baseUrl: 'http://127.0.0.1:59999/v1', model: 'x', timeoutMs: 300 },
  );
  check('服务不可达返回 null（调用方退回阈值判定）', r === null);
}
{
  // 实测踩过：用户回「b」（上一轮的选项）被小模型判成 NEW，白开一个弹巢
  const r = await arbitrate(
    { message: 'b', active, candidates: others, recent: [] },
    { enabled: true, baseUrl: 'http://127.0.0.1:59999/v1', model: 'x', timeoutMs: 300 },
  );
  check('1~2 字消息直接 CONTINUE，不联网也不开新弹巢', r?.action === 'continue' && r.raw === '(too-short)');
}

console.log(`\n通过 ${pass} / ${pass + fail}`);
if (fail) process.exit(1);
