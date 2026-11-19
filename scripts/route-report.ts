#!/usr/bin/env node
/**
 * 推荐质量周报（只读，不改任何配置）。
 *
 * 数据源：`data/decisions.jsonl`（route → ask → answer → final，同一 id 串起来）。
 * 回答四个问题：
 *   1. 推荐准不准：用户点的候选排第几（rank 分布）；
 *   2. 该不该问：stay / text / none 的占比（打扰率）；
 *   3. 有没有把人送错：点了"留在当前/都不是"之后又切走的比例；
 *   4. 贵不贵：发卡到回应的延迟。
 *
 * 用法：node --experimental-strip-types scripts/route-report.ts [--json]
 */
import { existsSync, readFileSync } from 'node:fs';
import { DECISIONS_LOG } from '../src/core/paths.ts';

interface Evt {
  evt: 'route' | 'ask' | 'answer' | 'final';
  id: string;
  at: string;
  [k: string]: any;
}

function load(): Map<string, Evt[]> {
  const by = new Map<string, Evt[]>();
  if (!existsSync(DECISIONS_LOG)) return by;
  for (const line of readFileSync(DECISIONS_LOG, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as Evt;
      if (!e?.id || !e?.evt) continue;
      const list = by.get(e.id) ?? [];
      list.push(e);
      by.set(e.id, list);
    } catch {
      /* 坏行跳过 */
    }
  }
  return by;
}

const groups = [...load().values()];
const routes = groups.map((g) => g.find((e) => e.evt === 'route')).filter(Boolean) as Evt[];
const answered = routes
  .map((r) => {
    const g = groups.find((x) => x[0]!.id === r.id)!;
    return {
      route: r,
      ask: g.find((e) => e.evt === 'ask'),
      answer: g.find((e) => e.evt === 'answer'),
      final: g.find((e) => e.evt === 'final'),
    };
  })
  .filter((x) => x.answer || x.final);

const dist = (arr: string[]): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const k of arr) out[k] = (out[k] ?? 0) + 1;
  return out;
};

const asked = answered.filter((x) => x.ask);
const kinds = dist(asked.map((x) => String(x.answer?.kind ?? 'none-answered')));

/** 用户点了候选时，它在卡片上的名次。不在候选列表里记 99。 */
const ranks: number[] = [];
const mislead: Array<{ id: string; at: string; top1: string; chosen: string }> = [];
for (const x of asked) {
  const sid = x.answer?.sid;
  if (x.answer?.kind !== 'candidate' || !sid) continue;
  const cands = (x.route.candidates ?? []) as Array<{ id: string; name: string }>;
  const idx = cands.findIndex((c) => c.id === sid);
  ranks.push(idx >= 0 ? idx + 1 : 99);
  const top1 = cands[0];
  if (top1 && top1.id !== sid) {
    mislead.push({ id: x.route.id, at: x.route.at, top1: top1.name, chosen: sid });
  }
}

const decided = answered.filter((x) => x.final);
const finalKinds = dist(decided.map((x) => String(x.final?.kind ?? '?')));
// 用户明确说"不对"（留在当前 / 都不是 / 直接说别的）之后，仍被切走的次数
const wrongMove = decided.filter(
  (x) => x.final?.kind === 'switch' && ['stay', 'none', 'text'].includes(String(x.answer?.kind ?? '')),
).length;

const latencies = asked
  .map((x) => Number(x.answer?.latencyMs))
  .filter((n) => Number.isFinite(n) && n >= 0)
  .sort((a, b) => a - b);
const median = latencies.length ? latencies[Math.floor(latencies.length / 2)] : undefined;

const summary = {
  decisions: routes.length,
  answered: answered.length,
  asked: asked.length,
  askRate: routes.length ? Number((asked.length / routes.length).toFixed(3)) : 0,
  answers: kinds,
  candidateRanks: dist(ranks.map((r) => (r > 3 ? 'not-in-card' : `rank${r}`))),
  top1Mislead: mislead.length,
  top1MisleadRate: ranks.length ? Number((mislead.length / ranks.length).toFixed(3)) : 0,
  final: finalKinds,
  movedAfterReject: wrongMove,
  latencyMs: { median, p90: latencies.length ? latencies[Math.floor(latencies.length * 0.9)] : undefined },
  examples: mislead.slice(-5),
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(`决策 ${summary.decisions} 条 · 发卡 ${summary.asked} 条（${(summary.askRate * 100).toFixed(1)}%）`);
  console.log(`回答：${JSON.stringify(summary.answers)}`);
  console.log(`候选名次：${JSON.stringify(summary.candidateRanks)}`);
  console.log(`top-1 与用户选择不一致：${summary.top1Mislead} 次（${(summary.top1MisleadRate * 100).toFixed(1)}%）`);
  console.log(`最终落点：${JSON.stringify(summary.final)} · 说完"不对"仍被切走：${summary.movedAfterReject} 次`);
  console.log(`响应中位 ${summary.latencyMs.median ?? '-'}ms / p90 ${summary.latencyMs.p90 ?? '-'}ms`);
  if (summary.examples.length) {
    console.log('最近几例排错：');
    for (const e of summary.examples) console.log(`  ${e.at} top1=《${e.top1}》 用户选了 ${e.chosen}`);
  }
}
