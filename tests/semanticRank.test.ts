/**
 * 候选重排的单测：仲裁之前必须按**语义相似度**排，而不是按"谁最近活跃"。
 *
 * 为什么钉这个：2026-11-08 飞书实测，用户只发「esp32-cam」想切回同名旧会话，
 * 那条会话语义相似度 1.0、按活跃度却排第 8，而仲裁只读前 5 个候选 ——
 * 模型根本没看到它，只能答"新话题"，用户的原话是"记忆没切到我想要的那条"。
 * 这组用例守的就是"最像的那条一定会出现在前 5 个里"。
 */
import { arbiterSwitchConsistent, rankCandidatesBySemantic, semanticScoreOf } from '../src/core/semanticRoute.ts';
import type { SemanticInput } from '../src/core/topicRouter.ts';

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

type Cand = { id: string };

/** 构造一个最小可用的语义输入；向量都是二维，余弦值一眼能算。 */
function sem(message: number[], candidates: Array<{ sessionId: string; vecs: number[][] }>): SemanticInput {
  return {
    message,
    active: [[1, 0]],
    candidates,
    continueThreshold: 0.58,
    switchThreshold: 0.6,
    unrelatedThreshold: 0.42,
  };
}

const V = {
  /** 与本句完全一致 → 余弦 1 */
  same: [1, 0],
  /** 完全无关 → 余弦 0 */
  none: [0, 1],
  /** 0.7071 */
  half: [Math.SQRT1_2, Math.SQRT1_2],
};

console.log('semanticScoreOf');

{
  const s = sem(V.same, [
    { sessionId: 'a', vecs: [V.none] },
    { sessionId: 'esp32', vecs: [V.half, V.same] },
  ]);
  check('块间取最大（同一会话里最像的那块说了算）', semanticScoreOf(s, 'esp32') === 1, String(semanticScoreOf(s, 'esp32')));
  check('无关候选得 0 而不是被丢掉', semanticScoreOf(s, 'a') === 0, String(semanticScoreOf(s, 'a')));
  check('没有向量的会话 → undefined（调用方据此保持原顺序）', semanticScoreOf(s, 'missing') === undefined);
  check('sem 为 null → undefined（语义不可用时不排序）', semanticScoreOf(null, 'esp32') === undefined);
}

console.log('rankCandidatesBySemantic');

{
  const candidates: Cand[] = [{ id: 'recent' }, { id: 'middle' }, { id: 'best' }];
  const s = sem(V.same, [
    { sessionId: 'recent', vecs: [V.none] },
    { sessionId: 'middle', vecs: [V.half] },
    { sessionId: 'best', vecs: [V.same] },
  ]);
  const ranked = rankCandidatesBySemantic(candidates, s);
  check(
    '按相似度降序：最像的排最前',
    ranked.map((c) => c.id).join(',') === 'best,middle,recent',
    ranked.map((c) => c.id).join(','),
  );
  check('不修改入参数组（调用方还要拿原顺序做别的事）', candidates.map((c) => c.id).join(',') === 'recent,middle,best');
}

{
  // 回归用例：8 个候选、最像的那个排第 8，必须进得了仲裁的前 5 个
  const candidates: Cand[] = Array.from({ length: 8 }, (_, i) => ({ id: `s${i + 1}` }));
  candidates[7] = { id: 'esp32-cam' };
  const s = sem(V.same, [
    ...candidates.slice(0, 7).map((c) => ({ sessionId: c.id, vecs: [V.none] })),
    { sessionId: 'esp32-cam', vecs: [V.same] },
  ]);
  const ranked = rankCandidatesBySemantic(candidates, s);
  check(
    '「排第 8 但最像」的旧话题被顶到第 1（否则仲裁模型看不到它）',
    ranked[0]!.id === 'esp32-cam',
    ranked.map((c) => c.id).join(','),
  );
  check(
    '前 5 个（仲裁的读取窗口）里包含它',
    ranked.slice(0, 5).some((c) => c.id === 'esp32-cam'),
    ranked.slice(0, 5).map((c) => c.id).join(','),
  );
  check('其余候选一个不丢（排序不是过滤）', ranked.length === candidates.length, String(ranked.length));
}

{
  const candidates: Cand[] = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const s = sem(V.same, [
    { sessionId: 'b', vecs: [V.same] },
    { sessionId: 'c', vecs: [V.half] },
  ]);
  const ranked = rankCandidatesBySemantic(candidates, s);
  check(
    '没有向量的候选保持原顺序、排在后面',
    ranked.map((c) => c.id).join(',') === 'b,c,a',
    ranked.map((c) => c.id).join(','),
  );
}

{
  const candidates: Cand[] = [{ id: 'a' }, { id: 'b' }];
  check('sem 为 null → 原样返回（语义不可用时行为不变）', rankCandidatesBySemantic(candidates, null) === candidates);
  const empty = sem(V.same, []);
  check('候选向量一个都没有 → 原样返回（不瞎排）', rankCandidatesBySemantic(candidates, empty) === candidates);
}

console.log('arbiterSwitchConsistent（仲裁的 switch 必须有语义背书）');

{
  /** 造一个与 message=[1,0] 余弦恰为 cos 的二维向量。 */
  const vec = (cos: number): number[] => [cos, Math.sqrt(Math.max(0, 1 - cos * cos))];
  const s = (ranked: number[]): SemanticInput =>
    sem(
      [1, 0],
      ranked.map((cos, i) => ({ sessionId: `s${i}`, vecs: [vec(cos)] })),
    );

  check(
    '领先够（0.90 vs 当前 0.60）→ 采纳',
    arbiterSwitchConsistent({
      sem: s([0.9, 0.5]),
      rankedIds: ['s0', 's1'],
      targetSessionId: 's0',
      activeScore: 0.6,
    }) === true,
  );
  check(
    '实测 03:35 那条：0.697 vs 当前 0.656（只领先 0.041）→ 丢弃',
    arbiterSwitchConsistent({
      sem: s([0.697, 0.5]),
      rankedIds: ['s0', 's1'],
      targetSessionId: 's0',
      activeScore: 0.656,
    }) === false,
  );
  check(
    '同一句对《esp32-cam》0.656 vs 当前 0.584（领先 0.072）→ 值得问一次',
    arbiterSwitchConsistent({
      sem: s([0.656, 0.5]),
      rankedIds: ['s0', 's1'],
      targetSessionId: 's0',
      activeScore: 0.584,
    }) === true,
  );
  check(
    '目标排在语义第 4 → 丢弃',
    arbiterSwitchConsistent({
      sem: s([0.9, 0.8, 0.7, 0.6]),
      rankedIds: ['s0', 's1', 's2', 's3'],
      targetSessionId: 's3',
      activeScore: 0.2,
    }) === false,
  );
  check(
    '离语义第一名差太远（0.80 vs 0.90）→ 丢弃',
    arbiterSwitchConsistent({
      sem: s([0.9, 0.8]),
      rankedIds: ['s0', 's1'],
      targetSessionId: 's1',
      activeScore: 0.2,
    }) === false,
  );
  check(
    '语义不可用 → 保留仲裁（不假装能判）',
    arbiterSwitchConsistent({
      sem: null,
      rankedIds: ['s0'],
      targetSessionId: 's0',
      activeScore: 0.1,
    }) === true,
  );
  check(
    '目标没有向量 → 丢弃',
    arbiterSwitchConsistent({
      sem: s([0.9]),
      rankedIds: ['s0', 'ghost'],
      targetSessionId: 'ghost',
      activeScore: 0.1,
    }) === false,
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
