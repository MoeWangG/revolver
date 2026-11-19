/**
 * 话题判定的单测。
 *
 * 只测纯函数（topicRouter），不碰文件系统与模型——判定逻辑一旦依赖外部服务，
 * 就再也没法回答"为什么这次切了"。
 *
 * 运行：node --experimental-strip-types tests/routing.test.ts
 */
import {
  decideRoute,
  deriveTitle,
  overlap,
  strongSemanticPick,
  tokenize,
  type RouteSession,
  type RouteSignals,
} from '../src/core/topicRouter.ts';

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
const now = Date.parse('2026-10-22T12:00:00.000Z');
const ago = (h: number) => new Date(now - h * HOUR).toISOString();

const active: RouteSession = {
  sessionId: 'A',
  title: '播客标题',
  lastActiveAt: ago(0.2),
  sample: ['这个播客标题再口语一点', '标题第二版偏硬，需要更口语'],
};

const oldTopic: RouteSession = {
  sessionId: 'B',
  title: '东京旅行行程',
  lastActiveAt: ago(30),
  sample: ['东京三天怎么安排', '第二天想去浅草寺和晴空塔'],
};

console.log('decideRoute');

// 1) 明确同话题 → 继续
{
  const d = decideRoute({ message: '播客标题第三版，再口语一点', now, active, candidates: [oldTopic] });
  check('同话题继续', d.action === 'continue', `得到 ${d.action}｜${d.reason}`);
  check('同话题置信度高', d.confidence >= 0.5, `confidence=${d.confidence}`);
}

// 2) 很久没动 + 完全无关 → 新话题
{
  const staleActive: RouteSession = { ...active, lastActiveAt: ago(20) };
  const d = decideRoute({
    message: '明天东京会下雨吗',
    now,
    active: staleActive,
    candidates: [],
    config: { idleSplitHours: 8 },
  });
  check('久未活动且无关 → 新话题', d.action === 'new', `得到 ${d.action}｜${d.reason}`);
}

// 3) 命中旧话题且比当前更相关 → 切回
{
  const d = decideRoute({
    message: '东京行程第二天改成浅草寺',
    now,
    active: { ...active, lastActiveAt: ago(0.1) },
    candidates: [oldTopic],
  });
  check('命中旧话题 → 切换', d.action === 'switch', `得到 ${d.action}｜${d.reason}`);
  check('切换目标正确', d.targetSessionId === 'B', `target=${d.targetSessionId}`);
}

// 4) 时间短 + 无关：模糊区，必须继续（fail-open），且置信度低到不该询问
{
  const d = decideRoute({ message: '明天东京会下雨吗', now, active, candidates: [] });
  check('模糊区留在当前', d.action === 'continue', `得到 ${d.action}｜${d.reason}`);
  check('模糊区置信度 < 0.5（不打扰用户）', d.confidence < 0.5, `confidence=${d.confidence}`);
}

// 5) idleSplitHours=0 时关闭时间信号：即便无关也不开新话题
{
  const d = decideRoute({
    message: '明天东京会下雨吗',
    now,
    active: { ...active, lastActiveAt: ago(100) },
    candidates: [],
    config: { idleSplitHours: 0 },
  });
  check('idleSplitHours=0 关闭时间信号', d.action === 'continue', `得到 ${d.action}`);
}

// 6) 空样本不应崩，且判定为继续（保守）
{
  const empty: RouteSession = { sessionId: 'E', lastActiveAt: ago(1), sample: [] };
  const d = decideRoute({ message: '随便说点什么', now, active: empty, candidates: [] });
  check('空样本保守处理', d.action === 'continue', `得到 ${d.action}`);
}

console.log('\ntokenize / overlap');
{
  const a = tokenize('播客标题要口语一点');
  const b = tokenize('播客标题再口语');
  const c = tokenize('东京旅行行程安排');
  check('同话题重合度高于无关话题', overlap(a, b) > overlap(a, c), `${overlap(a, b).toFixed(3)} vs ${overlap(a, c).toFixed(3)}`);
  check('虚词不产生噪声 token', !tokenize('这个那个然后').has('这个'), [...tokenize('这个那个然后')].join(','));
}

console.log('\nstrongSemanticPick（几乎逐字命中旧话题时，不让小模型改判）');
{
  const sig = (best?: number, active?: number, id?: string): RouteSignals => ({
    gapHours: 0.02,
    overlapActive: 0,
    overlapBest: 0,
    bestSessionId: id,
    regime: 'semantic',
    semanticActive: active,
    semanticBest: best,
  });
  check('1.00 vs 0.66 → 命中（实测 esp32-cam 的形状）', strongSemanticPick(sig(1, 0.66, 'esp32')) === 'esp32');
  check('只到 0.94 → 不命中（留给模型判）', strongSemanticPick(sig(0.94, 0.3, 'x')) === undefined);
  check('领先不够（0.96 vs 0.8）→ 不命中', strongSemanticPick(sig(0.96, 0.8, 'x')) === undefined);
  check('没有候选 id → 不命中', strongSemanticPick(sig(1, 0.2)) === undefined);
  check(
    '词面模式不生效（那套刻度没有可比分数）',
    strongSemanticPick({ ...sig(1, 0.1, 'x'), regime: 'lexical' }) === undefined,
  );
}

console.log('\nderiveTitle');
{
  check('短句直接用作标题', deriveTitle('播客标题') === '播客标题');
  check('按句号截断', deriveTitle('帮我改标题。要更口语') === '帮我改标题');
  check('超长截断带省略号', deriveTitle('这是一个非常非常长的话题标题需要被截断处理').endsWith('…'));
  check('空消息有兜底', deriveTitle('   ') === '未命名话题');
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
// 用抛出代替 process.exit：这个文件不在 tsconfig include 里，
// 引入 node 类型反而会让编辑器报错；未捕获异常同样返回非零退出码。
if (fail > 0) throw new Error(`${fail} 个断言失败`);
