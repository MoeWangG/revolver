/**
 * 语义判定的单测：用人工构造的向量，不依赖任何服务。
 *
 * 为什么用基向量：余弦只关心方向，`[1,0,0]` 与 `[0,1,0]` 正交（相似 0），
 * 这样每条用例的期望值可以手算，不用"跑一次看看结果"。
 */
import { cosine, decideRoute, type RouteSession, type SemanticInput } from '../src/core/topicRouter.ts';

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
const now = Date.parse('2026-10-23T00:00:00.000Z');
const ago = (h: number) => new Date(now - h * HOUR).toISOString();

const active: RouteSession = { sessionId: 'A', title: '播客标题', lastActiveAt: ago(0.2), sample: [] };
const oldTopic: RouteSession = { sessionId: 'B', title: '东京行程', lastActiveAt: ago(30), sample: [] };

const SEM = {
  continueThreshold: 0.55,
  switchThreshold: 0.72,
  unrelatedThreshold: 0.35,
};

function sem(message: number[], activeVec: number[], cands: Array<{ sessionId: string; vec: number[] }>): SemanticInput {
  return {
    message,
    active: [activeVec],
    candidates: cands.map((c) => ({ sessionId: c.sessionId, vecs: [c.vec] })),
    ...SEM,
  };
}

console.log('cosine');

check('同向 → 1', Math.abs(cosine([1, 0, 0], [2, 0, 0]) - 1) < 1e-9);
check('正交 → 0', Math.abs(cosine([1, 0, 0], [0, 1, 0])) < 1e-9);
check('反向 → -1', Math.abs(cosine([1, 0, 0], [-1, 0, 0]) + 1) < 1e-9);
check('长度不一致 → 0', cosine([1, 0], [1, 0, 0]) === 0);
check('空向量 → 0', cosine([], []) === 0);

console.log('\n语义分支');

// 1) 明显贴近当前话题 → 继续
{
  const d = decideRoute({
    message: 'x',
    now,
    active,
    candidates: [oldTopic],
    semantic: sem([0.98, 0.2, 0], [1, 0, 0], [{ sessionId: 'B', vec: [0, 1, 0] }]),
  });
  check('贴近当前 → continue', d.action === 'continue', `${d.action}｜${d.reason}`);
  check('regime 标为 semantic', d.signals.regime === 'semantic', d.signals.regime);
  check('置信度足够高（>=0.5）', d.confidence >= 0.5, String(d.confidence));
}

// 2) 更像旧话题 → 切回
{
  const d = decideRoute({
    message: 'x',
    now,
    active,
    candidates: [oldTopic],
    semantic: sem([0.15, 0.98, 0], [1, 0, 0], [{ sessionId: 'B', vec: [0, 1, 0] }]),
  });
  check('更像旧话题 → switch', d.action === 'switch', `${d.action}｜${d.reason}`);
  check('目标指向 B', d.targetSessionId === 'B', String(d.targetSessionId));
}

// 3) 两边都不像 + 隔得久 → 新话题
{
  const staleActive = { ...active, lastActiveAt: ago(20) };
  const d = decideRoute({
    message: 'x',
    now,
    active: staleActive,
    candidates: [],
    semantic: sem([0, 0, 1], [1, 0, 0], []),
    config: { idleSplitHours: 8 },
  });
  check('无关且久未活动 → new', d.action === 'new', `${d.action}｜${d.reason}`);
}

// 4) 模糊区（两边都在阈值下）→ 继续，且置信度低到不该询问
{
  const d = decideRoute({
    message: 'x',
    now,
    active,
    candidates: [oldTopic],
    semantic: sem([0.5, 0.5, 0.7], [1, 0, 0], [{ sessionId: 'B', vec: [0, 1, 0] }]),
  });
  check('模糊区 → continue', d.action === 'continue', `${d.action}｜${d.reason}`);
  check('模糊区置信度 < 0.5（不该打扰用户）', d.confidence < 0.5, String(d.confidence));
}

// 5) 多块取最大：会话里混着多个话题时，不能被无关的那块稀释
{
  const d = decideRoute({
    message: 'x',
    now,
    active,
    candidates: [oldTopic],
    semantic: {
      message: [0.15, 0.98, 0],
      // 当前会话两块：第一块完全无关，第二块就是本句（相似度应为 1）
      active: [
        [0, 0, 1],
        [0.15, 0.98, 0],
      ],
      // 候选两块：第一块无关，第二块正是旧话题
      candidates: [
        {
          sessionId: 'B',
          vecs: [
            [0, 0, 1],
            [0, 1, 0],
          ],
        },
      ],
      ...SEM,
    },
  });
  check('多块时当前会话取最大 → continue', d.action === 'continue', `${d.action}｜${d.reason}`);
  check('取到的是最像的那块（0.98 而非 0）', (d.signals.semanticActive ?? 0) > 0.9, String(d.signals.semanticActive));
}

// 6) 未给 semantic → 必须走词面（降级路径不能被语义改动带坏）
{
  const d = decideRoute({ message: '播客标题再口语一点', now, active: { ...active, lastActiveAt: ago(0.1), sample: ['播客标题再口语一点'] }, candidates: [] });
  check('无向量时退回词面', d.signals.regime === 'lexical', d.signals.regime);
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail > 0) throw new Error(`${fail} 个断言失败`);
