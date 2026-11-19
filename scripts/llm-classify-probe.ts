/**
 * 生成式模型做话题裁决的对照实验（替代 laya 的 systemone）。
 *
 * 为什么另起一个：
 *   laya 是编码器，5 选 1 时概率近似均匀（实测 18 条判对 0 条、16 条最高概率 <0.4）。
 *   这里换成能读文本的指令模型，直接走 chat/completions，prompt 用生产同一套
 *   `buildArbiterPrompt()`（当前会话卡 + 最近两轮 + 候选），不另造口径。
 *
 * 评测集分两半，缺一不可：
 *   1. **真实 18 条**：全部人工答案是「留在当前」，测它会不会乱判；
 *   2. **构造 8 条 NEW**：另一半，测它是不是一律说 CONTINUE（只会 say yes 的模型没有价值）。
 *
 * 用法：
 *   node --experimental-strip-types scripts/llm-classify-probe.ts gemma-4-26b-a4b-it-mlx
 */
import { readFileSync } from 'node:fs';
import { listSessions } from '../src/core/sessions.ts';
import { readSessionMessages } from '../src/core/sessionHistory.ts';
import { buildArbiterPrompt, type ArbiterInput } from '../src/core/topicArbiter.ts';
import type { SessionMeta } from '../src/core/sessions.ts';

const BASE = process.env.WAKER_LLM_BASE_URL ?? 'http://127.0.0.1:1234/v1';
const MODEL = process.argv[2] ?? 'gemma-4-26b-a4b-it-mlx';

interface Row {
  evt?: string;
  id?: string;
  message?: string;
  active?: { id?: string };
  candidates?: Array<{ id?: string }>;
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

/** 构造的"真新话题"：同一批会话、同一套候选，只换用户这句话。 */
const SYNTH_NEW = [
  '换个话题，帮我看看 K8s 的 ingress 怎么配',
  '明天上海会下雨吗',
  '我下个月的日本行程还没定，帮我排一下',
  '帮我写本周的周报',
  '先不说这个了，帮我改一下 SOUL.md 的语气',
  '最近半导体股票还能买吗',
  '推荐几本学 Rust 的书',
  '孩子学校要开家长会，怎么跟老师沟通比较好',
];

function turnsOf(s: SessionMeta): Array<{ role: 'user' | 'assistant'; text: string }> {
  try {
    return readSessionMessages('chat', s.id, 8)
      .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.text.trim())
      .slice(-2)
      .map((m) => ({ role: m.role as 'user' | 'assistant', text: m.text.replace(/\s+/g, ' ').slice(0, 200) }));
  } catch {
    return [];
  }
}

async function classify(input: ArbiterInput): Promise<{ out: string; ms: number; raw: string }> {
  const { system, user } = buildArbiterPrompt(input);
  const t0 = Date.now();
  try {
    const r = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: 0,
        max_tokens: 64,
      }),
    });
    const data = (await r.json()) as {
      choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>;
      error?: { message?: string };
    };
    const msg = data.choices?.[0]?.message;
    const raw = (msg?.content?.trim() || msg?.reasoning_content?.trim() || data.error?.message || '(空)').trim();
    const hits = raw.match(/CONTINUE|NEW|SWITCH\s*#?\s*\d+/gi) ?? [];
    return { out: hits.length ? hits[hits.length - 1]!.toUpperCase() : `?${raw.slice(0, 20)}`, ms: Date.now() - t0, raw };
  } catch (e) {
    return { out: '!err', ms: Date.now() - t0, raw: (e as Error)?.message ?? String(e) };
  }
}

let realOk = 0;
let realTotal = 0;
let synthOk = 0;
let synthTotal = 0;
const times: number[] = [];

// 一半：真实样本，人工答案全是"留在当前"
let activeForSynth: SessionMeta | null = null;
let candsForSynth: SessionMeta[] = [];
for (const r of routes) {
  const fin = finals.get(r.id!);
  if (!fin) continue;
  const active = byId.get(r.active!.id!);
  if (!active) continue;
  const cands = (r.candidates ?? [])
    .map((c) => (c.id ? byId.get(c.id) : undefined))
    .filter((s): s is SessionMeta => Boolean(s) && s!.id !== active.id)
    .slice(0, 3);
  if (!cands.length) continue;
  activeForSynth = active;
  candsForSynth = cands;

  const out = await classify({ message: r.message!, active, candidates: cands, recent: turnsOf(active) });
  times.push(out.ms);
  realTotal += 1;
  const ok = out.out.startsWith('CONTINUE');
  if (ok) realOk += 1;
  console.log(`真实 ${ok ? '✓' : '✗'} ${String(out.ms).padStart(5)}ms  ${out.out.padEnd(10)} 「${r.message!.slice(0, 26)}」`);
}

// 另一半：构造的新话题（同一会话、同一候选）
if (activeForSynth) {
  for (const msg of SYNTH_NEW) {
    const out = await classify({ message: msg, active: activeForSynth, candidates: candsForSynth, recent: turnsOf(activeForSynth) });
    times.push(out.ms);
    synthTotal += 1;
    const ok = out.out.startsWith('NEW');
    if (ok) synthOk += 1;
    console.log(`构造 ${ok ? '✓' : '✗'} ${String(out.ms).padStart(5)}ms  ${out.out.padEnd(10)} 「${msg}」`);
  }
}

times.sort((a, b) => a - b);
const p50 = times[Math.floor(times.length / 2)] ?? 0;
const p90 = times[Math.floor(times.length * 0.9)] ?? 0;
console.log(`\n模型 ${MODEL}`);
console.log(`真实集（应 CONTINUE）：${realOk}/${realTotal}`);
console.log(`构造集（应 NEW）    ：${synthOk}/${synthTotal}`);
console.log(`延迟 p50=${p50}ms p90=${p90}ms`);
