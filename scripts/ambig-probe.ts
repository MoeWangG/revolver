#!/usr/bin/env node
/**
 * 用历史真实数据回归「仲裁层」。
 *
 * 和 arbiter-probe 的区别：那个测的是 prompt 设计，**这个走真实代码路径**——
 * 直接把 messages.jsonl 里的原文、sessions.json 里的会话卡喂给
 * `topicArbiter.arbitrate()`，验的是"接进生产后还能不能判对"。
 *
 * 数据只读两处：data/routing.jsonl（判定流水）与 pi 的会话 jsonl（原文）。
 *
 * 用法：
 *   node --experimental-strip-types scripts/ambig-probe.ts
 *   node --experimental-strip-types scripts/ambig-probe.ts --lo 0.42 --hi 0.58
 *   node --experimental-strip-types scripts/ambig-probe.ts --model laya
 */
import fs from 'node:fs';
import path from 'node:path';
import { arbitrate } from '../src/core/topicArbiter.ts';
import type { SessionMeta } from '../src/core/sessions.ts';
import { DEFAULT_ARBITER_CONFIG } from '../src/types.ts';

const ROOT = '~/work/revolver';
const SESS_DIR = '~/.pi/agent/sessions';

const argv = process.argv.slice(2);
const num = (flag: string, dflt: number): number => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : dflt;
};
const pick = (flag: string): string | undefined => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};
const LO = num('--lo', 0.42);
const HI = num('--hi', 0.58);
const CFG = { ...DEFAULT_ARBITER_CONFIG, ...(pick('--model') ? { model: pick('--model')! } : {}) };

interface RoutingRow {
  at: string;
  wakerId: string;
  activeSessionId: string;
  action: string;
  confidence: number;
  signals?: { regime?: string; semanticActive?: number; semanticBest?: number; gapHours?: number };
}

interface MetaRow {
  id: string;
  title?: string;
  name: string;
  messageCount: number;
  lastActiveAt: string;
  cardSummary?: string;
}

const sessionsMeta = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/sessions.json'), 'utf-8')) as Record<
  string,
  MetaRow[]
>;

/** 补齐 SessionMeta 的必填字段；piSessionId 只用于展示，仲裁不读它。 */
function toMeta(wakerId: string, row: MetaRow): SessionMeta {
  return {
    id: row.id,
    wakerId,
    name: row.name,
    title: row.title,
    piSessionId: `waker-${wakerId}${row.id === 'default' ? '' : `-${row.id}`}`,
    createdAt: row.lastActiveAt,
    lastActiveAt: row.lastActiveAt,
    messageCount: row.messageCount,
    cardSummary: row.cardSummary,
  };
}

function findSessionFile(wakerId: string, sessionId: string): string | null {
  const suffix = sessionId === 'default' ? `_waker-${wakerId}.jsonl` : `_waker-${wakerId}-${sessionId}.jsonl`;
  let best: string | null = null;
  let bestM = 0;
  for (const d of fs.readdirSync(SESS_DIR)) {
    const dir = path.join(SESS_DIR, d);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(suffix)) continue;
      const p = path.join(dir, f);
      const m = fs.statSync(p).mtimeMs;
      if (m > bestM) {
        bestM = m;
        best = p;
      }
    }
  }
  return best;
}

interface Turn {
  ts: number;
  role: 'user' | 'assistant';
  text: string;
}

function turnsOf(file: string): Turn[] {
  const out: Turn[] = [];
  for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line) as { timestamp?: string; message?: { role?: string; content?: unknown } };
      const role = o.message?.role;
      if ((role !== 'user' && role !== 'assistant') || !o.timestamp) continue;
      const c = o.message?.content;
      let text = '';
      if (typeof c === 'string') text = c;
      else if (Array.isArray(c)) text = c.map((x) => (x as { text?: string })?.text ?? '').join(' ');
      text = text.replace(/\s+/g, ' ').trim();
      if (!text || text.includes('压缩成不超过') || text.includes('把下面这段对话压缩')) continue;
      out.push({ ts: Date.parse(o.timestamp), role, text });
    } catch {
      /* 跳过坏行 */
    }
  }
  return out.sort((a, b) => a.ts - b.ts);
}

const rows = fs
  .readFileSync(path.join(ROOT, 'data/routing.jsonl'), 'utf-8')
  .split('\n')
  .filter(Boolean)
  .map((l) => {
    try {
      return JSON.parse(l) as RoutingRow;
    } catch {
      return null;
    }
  })
  .filter((r): r is RoutingRow => !!r)
  .filter((r) => {
    const s = r.signals?.semanticActive;
    return r.signals?.regime === 'semantic' && typeof s === 'number' && s >= LO && s < HI;
  });

console.log(`模型 ${CFG.model}  模糊带 [${LO}, ${HI})  共 ${rows.length} 条\n`);

let newCount = 0;
let contCount = 0;
let switchCount = 0;
let degraded = 0;

for (const r of rows) {
  const meta = sessionsMeta[r.wakerId] ?? [];
  const cur = meta.find((s) => s.id === r.activeSessionId);
  const file = findSessionFile(r.wakerId, r.activeSessionId);
  if (!file) {
    console.log(`— ${r.at.slice(0, 16)} ${r.activeSessionId} 找不到会话文件，跳过\n`);
    degraded += 1;
    continue;
  }

  const turns = turnsOf(file);
  const at = Date.parse(r.at);
  // 判定与落盘的时间戳互有先后，取**最接近**的一条（不能只取 <=，会把这条本身错配成上一条）
  let idx = -1;
  let bestDiff = Infinity;
  for (let i = 0; i < turns.length; i += 1) {
    if (turns[i]!.role !== 'user') continue;
    const diff = Math.abs(turns[i]!.ts - at);
    if (diff < bestDiff && diff < 120_000) {
      bestDiff = diff;
      idx = i;
    }
  }
  if (idx < 0) {
    console.log(`— ${r.at.slice(0, 16)} ${r.activeSessionId} 没匹配到原文，跳过\n`);
    degraded += 1;
    continue;
  }

  const msg = turns[idx]!;
  const active = toMeta(r.wakerId, cur ?? { id: r.activeSessionId, name: r.activeSessionId, messageCount: 0, lastActiveAt: r.at });
  const candidates = meta.filter((s) => s.id !== r.activeSessionId).map((s) => toMeta(r.wakerId, s));

  const res = await arbitrate(
    {
      message: msg.text,
      active,
      candidates,
      recent: turns
        .slice(Math.max(0, idx - 4), idx)
        .filter((t) => t.role === 'user' || t.role === 'assistant')
        .map((t) => ({ role: t.role, text: t.text })),
    },
    CFG,
  );

  if (res?.action === 'new') newCount += 1;
  else if (res?.action === 'switch') switchCount += 1;
  else if (res?.action === 'continue') contCount += 1;
  else degraded += 1;

  const verdict = res ? `${res.action.toUpperCase()}${res.targetSessionId ? ` → ${res.targetSessionId}` : ''}` : '降级(null)';
  console.log(
    `${r.at.slice(5, 16)}  语义 ${(r.signals?.semanticActive ?? 0).toFixed(3)}  gap ${(r.signals?.gapHours ?? 0).toFixed(1)}h` +
      `  ${r.activeSessionId}《${active.title || active.name}》`,
  );
  console.log(`  原文：${msg.text.slice(0, 70)}`);
  console.log(`  → ${verdict}${res ? `  (${res.ms}ms)` : ''}\n`);
}

console.log(`汇总：NEW ${newCount} / SWITCH ${switchCount} / CONTINUE ${contCount} / 未判定 ${degraded}`);
