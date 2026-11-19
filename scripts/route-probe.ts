#!/usr/bin/env node
/**
 * 话题判定排查器：把"每个候选会话的最大块相似度"摊开看。
 *
 * 用途：当判定结果不符合预期（该切没切 / 不该切却切了），先跑它，
 * 分清是**阈值不合适**还是会话文本混了多个话题。
 *
 * 用法：
 *   node --experimental-strip-types scripts/route-probe.ts <agentId> <sessionId> "<这句话>"
 */
import { loadWaker } from '../src/core/registry.ts';
import { listSessions } from '../src/core/sessions.ts';
import { semanticInputFor, sessionChunks } from '../src/core/semanticRoute.ts';
import { DEFAULT_EMBEDDING } from '../src/core/embeddings.ts';
import { cosine } from '../src/core/topicRouter.ts';
import { DEFAULT_SESSION_CONFIG } from '../src/types.ts';

const [agentId, sessionId, ...rest] = process.argv.slice(2);
const message = rest.join(' ').trim();
if (!agentId || !sessionId || !message) {
  console.error('用法：node --experimental-strip-types scripts/route-probe.ts <agentId> <sessionId> "<这句话>"');
  process.exit(1);
}

const rec = loadWaker(agentId);
if (!rec) {
  console.error(`找不到员工：${agentId}`);
  process.exit(1);
}
const cfg = rec.def.session ?? DEFAULT_SESSION_CONFIG;
const all = listSessions(agentId);
const current = all.find((s) => s.id === sessionId);
if (!current) {
  console.error(`该员工没有会话 ${sessionId}；现有：${all.map((s) => s.id).join(', ')}`);
  process.exit(1);
}
const others = all.filter((s) => s.id !== current.id).slice(0, 8);
const S = cfg.semantic;

const input = await semanticInputFor({
  message,
  active: current,
  candidates: others,
  cfg: DEFAULT_EMBEDDING,
  continueThreshold: S.continueThreshold,
  switchThreshold: S.switchThreshold,
  unrelatedThreshold: S.unrelatedThreshold,
});
if (!input) {
  console.error('语义不可用（LM Studio 未响应 / 模型未加载）');
  process.exit(1);
}

const maxCos = (v: number[], chunks: number[][]): number =>
  chunks.reduce((m, x) => Math.max(m, cosine(v, x)), 0);

console.log(`员工：${agentId}   模式：${cfg.mode}   模型：${DEFAULT_EMBEDDING.model}`);
console.log(`这句话：${message}`);
console.log(`阈值：continue=${S.continueThreshold}  switch=${S.switchThreshold}  unrelated=${S.unrelatedThreshold}\n`);

const sActive = maxCos(input.message, input.active);
console.log(
  `当前会话 ${current.id}「${current.title || current.name}」最大相似度 ${sActive.toFixed(3)}` +
    `  ${sActive >= S.continueThreshold ? '→ 继续' : '→ 不够继续'}`,
);
console.log(`  块数 ${input.active.length}，各块相似度：${input.active
  .map((v) => cosine(input.message, v).toFixed(3))
  .join(' / ')}`);
console.log(`  块内容：${sessionChunks(current)
  .map((t) => t.replace(/\s+/g, ' ').slice(0, 24))
  .join(' | ')}\n`);

console.log('候选会话（按最大块相似度降序）：');
const ranked = input.candidates
  .map((c) => ({
    c,
    sim: maxCos(input.message, c.vecs),
    session: others.find((s) => s.id === c.sessionId),
  }))
  .sort((a, b) => b.sim - a.sim);

for (const { c, sim, session } of ranked) {
  const enough = sim >= S.switchThreshold;
  const gapOk = sim >= sActive + 0.08;
  const mark = enough && gapOk ? '✅ 可切回' : enough ? '⚠️ 够相似但没拉开' : '低于切换线';
  console.log(
    `  ${sim.toFixed(3)}  ${c.sessionId}「${session?.title || session?.name || '?'}」  ${mark}\n` +
      `         块: ${sessionChunks(session ?? current)
        .map((t) => t.replace(/\s+/g, ' ').slice(0, 20))
        .join(' | ')}`,
  );
}
