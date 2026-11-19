/**
 * laya 的离线对照实验：**同一批真实样本，只改喂给它的 state**。
 *
 * 要回答的问题不是"它准不准"，而是"它到底是没判，还是判错"——
 * 以及"缺了哪块语义素材"。
 *
 * 三种 state：
 *   A 现状          `buildSystemOneState()`：标题 + 这句 + 旧话题标题摘要
 *   B 补「这段在聊」  加入当前会话卡的 100 字（这是 chat 版 prompt 有、systemone 没有的）
 *   C 补「最近两轮」  B 再加最后两条 user/assistant
 *
 * 用法（只读 decisions.jsonl + sessions.json，不写任何数据）：
 *   node --experimental-strip-types scripts/systemone-probe.ts
 */
import { readFileSync } from 'node:fs';
import { listSessions } from '../src/core/sessions.ts';
import { readSessionMessages } from '../src/core/sessionHistory.ts';
import { displayNameOf } from '../src/core/sessionName.ts';
import { buildSystemOneRequest, buildSystemOneState, type ArbiterInput } from '../src/core/topicArbiter.ts';
import type { SessionMeta } from '../src/core/sessions.ts';

const BASE = process.env.WAKER_LLM_BASE_URL ?? 'http://127.0.0.1:1234/v1';
const MODEL = process.env.WAKER_ARBITER_MODEL ?? 'laya';

/** 一行日志既可能是 route 也可能是 final，字段全可选，按需读。 */
interface Row {
  evt?: string;
  id?: string;
  message?: string;
  active?: { id?: string };
  candidates?: Array<{ id?: string; rank?: number }>;
  kind?: string;
  sessionId?: string;
}

const rows: Row[] = readFileSync('data/decisions.jsonl', 'utf-8')
  .split('\n')
  .filter(Boolean)
  .map((l) => {
    try {
      return JSON.parse(l) as Row;
    } catch {
      return {};
    }
  });

const finals = new Map(rows.filter((r) => r.evt === 'final' && r.id).map((r) => [r.id!, r]));
const routes = rows.filter((r) => r.evt === 'route' && !!r.message && !!r.active?.id);

const sessions = listSessions('chat');
const byId = new Map(sessions.map((s) => [s.id, s]));

function lastTurns(session: SessionMeta): string {
  try {
    return readSessionMessages('chat', session.id, 6)
      .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.text.trim())
      .slice(-2)
      .map((m) => `${m.role === 'user' ? '用户' : '助手'}：${m.text.replace(/\s+/g, ' ').slice(0, 70)}`)
      .join('\n');
  } catch {
    return '';
  }
}

async function ask(state: string, criteria: Record<string, string>): Promise<{ choice: string; probs: Record<string, number> }> {
  const r = await fetch(`${BASE}/systemone`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0,
      state,
      questions: { where: { type: 'choice', instructions: '这句话属于哪个话题？', criteria } },
    }),
  });
  const data = (await r.json()) as {
    answers?: Record<string, { choice?: string; probabilities?: Record<string, number> }>;
    error?: { message?: string };
  };
  const w = data.answers?.where;
  return { choice: w?.choice ?? `?${data.error?.message ?? 'no-answer'}`, probs: w?.probabilities ?? {} };
}

const fmt = (p: Record<string, number>, keys: string[]): string =>
  keys
    .map((k) => `${k}=${(p[k] ?? 0).toFixed(2)}`)
    .join(' ');

let n = 0;
let hitA = 0;
let hitB = 0;
let hitC = 0;
let hitD = 0;
let judgedA = 0;
let judgedD = 0;

for (const r of routes) {
  const fin = finals.get(r.id!);
  if (!fin) continue;
  const active = byId.get(r.active!.id!);
  if (!active) continue;
  const truth = fin.kind === 'switch' && fin.sessionId ? fin.sessionId : active.id;
  const cands = (r.candidates ?? [])
    .map((c) => (c.id ? byId.get(c.id) : undefined))
    .filter((s): s is SessionMeta => Boolean(s) && s!.id !== active.id)
    .slice(0, 3);
  if (!cands.length) continue;

  const input: ArbiterInput = {
    message: r.message!,
    active,
    candidates: cands,
    recent: [],
  };
  const req = buildSystemOneRequest(input, MODEL);
  const base = buildSystemOneState(input, cands);
  const criteria = (req.questions as { where: { criteria: Record<string, string> } }).where.criteria;
  const card = (active.cardSummary ?? '').trim().replace(/\s+/g, ' ').slice(0, 100);
  const turns = lastTurns(active);
  const stateB = card ? `${base.split('\n')[0]}\n这段在聊：${card}\n${base.split('\n').slice(1).join('\n')}` : base;
  const stateC = turns ? `${stateB}\n最近两轮：\n${turns}` : stateB;

  // D：**二分类**——只问"这句是不是接着当前话题说"。laya 是编码器，
  // 选项越多越接近均匀分布；二分类能看出它到底有没有"读懂的区分力"。
  const binary: Record<string, string> = {
    current: `接着当前话题《${displayNameOf(active).slice(0, 14)}》继续说`,
    next: '换了一件与当前话题无关的事',
  };

  const [a, b, c, d] = await Promise.all([
    ask(base, criteria),
    ask(stateB, criteria),
    ask(stateC, criteria),
    ask(stateB, binary),
  ]);
  const keys = ['current', 'next', ...cands.map((_, i) => `c${i + 1}`)];
  const want = truth === active.id ? 'current' : `c${cands.findIndex((s) => s.id === truth) + 1}`;

  n += 1;
  if (a.choice === want) hitA += 1;
  if (b.choice === want) hitB += 1;
  if (c.choice === want) hitC += 1;
  // "有没有给出判断"：最高概率 ≥0.4 才算它真的选了，否则等于弃权
  const maxA = Math.max(...Object.values(a.probs));
  if (Number.isFinite(maxA) && maxA >= 0.4) judgedA += 1;

  if (d.choice === 'current') hitD += 1;
  const maxD = Math.max(...Object.values(d.probs));
  if (Number.isFinite(maxD) && maxD >= 0.7) judgedD += 1;

  console.log(`[${String(n).padStart(2)}] 期望=${want}  「${r.message!.replace(/\s+/g, ' ').slice(0, 30)}」`);
  console.log(`   A(现状)      choice=${a.choice.padEnd(7)} ${fmt(a.probs, keys)}  max=${maxA.toFixed(2)}`);
  console.log(`   B(+在聊什么) choice=${b.choice.padEnd(7)} ${fmt(b.probs, keys)}`);
  console.log(`   C(+最近两轮) choice=${c.choice.slice(0, 20).padEnd(7)}(${stateC.length}字)`);
  console.log(`   D(二分类)    choice=${d.choice.padEnd(7)} current=${(d.probs.current ?? 0).toFixed(2)} next=${(d.probs.next ?? 0).toFixed(2)}`);
}

console.log(`\n共 ${n} 条。与人工答案一致：A=${hitA} B=${hitB} C=${hitC} D(二分类判 current)=${hitD}`);
console.log(`A 里"最高概率 ≥0.4"（算它真的做了判断）的条数：${judgedA}/${n}`);
console.log(`D 里"current 概率 ≥0.7"（算它真的敢说继续）的条数：${judgedD}/${n}`);
