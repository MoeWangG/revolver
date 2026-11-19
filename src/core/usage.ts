import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PI_AGENT_HOME } from './paths.ts';
import { loadAllWakers } from './registry.ts';
import { computeCost, pricingFingerprint, priceOf, type ModelPrice, type TokenParts } from './pricing.ts';

/**
 * 使用统计。
 *
 * 数据源是 **pi 原生会话文件**（`~/.pi/agent/sessions/<slug>/<ts>_<piSessionId>.jsonl`）：
 * 每条 assistant 消息都带 `model` 与 `usage`（token 明细）。平台不重复记账，只做只读聚合，
 * 于是 CLI / 看板 / 外部渠道产生的消耗都能统计到。
 *
 * 费用**按模型价格表计算**（见 pricing.ts）；价格表未覆盖的模型回退到 pi 记录的 cost。
 */

export interface UsageDay {
  /** YYYY-MM-DD（本地时区）。 */
  date: string;
  tokens: number;
  cost: number;
  /** 该日有消耗的 assistant 消息条数。 */
  runs: number;
  /** 该日命中的员工数。 */
  wakers: number;
}

export interface UsagePeriod {
  tokens: number;
  cost: number;
  runs: number;
}

export interface UsageView {
  /** 按日期升序、已补齐无消耗的空缺日期。 */
  days: UsageDay[];
  totals: { today: UsagePeriod; week: UsagePeriod; month: UsagePeriod; all: UsagePeriod };
  /** 参与统计的会话文件数（有消耗的）。 */
  files: number;
  /** 统计窗口覆盖的天数。 */
  windowDays: number;
  updatedAt: string;
}

/** 单个模型的用量。 */
export interface ModelUsage {
  model: string;
  tokens: number;
  cost: number;
  /** cost 的算法：价格表算出 / 取自 pi 记录。 */
  source: 'table' | 'recorded';
  /** 价格表命中时的单价（USD / 1M tokens）。 */
  price?: ModelPrice;
}

/** 一个会话的用量。 */
export interface SessionUsage {
  piSessionId: string;
  tokens: number;
  cost: number;
  /** assistant 消息条数。 */
  runs: number;
  /** 混合模型时为 'mixed'。 */
  source: 'table' | 'recorded' | 'mixed';
  models: ModelUsage[];
}

/** 一条 assistant 消息的用量。 */
interface Entry {
  date: string;
  piSessionId: string;
  model: string;
  tok: TokenParts;
  /** 费用（USD）：优先按价格表计算。 */
  cost: number;
  source: 'table' | 'recorded';
}

interface CachedFile {
  /** 价格表指纹：单价变了要重算费用。 */
  fingerprint: string;
  mtimeMs: number;
  size: number;
  entries: Entry[];
}

const cache = new Map<string, CachedFile>();

/** 超过此体积的会话文件跳过，避免同步读阻塞看板。 */
const MAX_FILE_BYTES = 32 * 1024 * 1024;

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** 本地时区的 YYYY-MM-DD。 */
function localDate(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/**
 * 列出会话文件。传 `filter` 时**按文件名预筛**（`<ts>_<piSessionId>.jsonl`），
 * 只返回目标会话——看板列表只需几个会话，没必要把全部历史文件都读一遍。
 */
function listSessionFiles(filter?: Set<string>): string[] {
  const root = join(PI_AGENT_HOME, 'sessions');
  if (!existsSync(root)) return [];
  const out: string[] = [];
  let subs: string[] = [];
  try {
    subs = readdirSync(root);
  } catch {
    return [];
  }
  for (const sub of subs) {
    const dir = join(root, sub);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    let files: string[] = [];
    try {
      files = readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      if (filter && !filter.has(piSessionIdOf(f))) continue;
      out.push(join(dir, f));
    }
  }
  return out;
}

/** 文件名形如 `<timestamp>_<piSessionId>.jsonl`，取出 piSessionId。 */
function piSessionIdOf(file: string): string {
  const base = file.split('/').pop() ?? file;
  const noExt = base.replace(/\.jsonl$/, '');
  const idx = noExt.indexOf('_');
  return idx >= 0 ? noExt.slice(idx + 1) : noExt;
}

function parseFile(file: string): Entry[] {
  let st;
  try {
    st = statSync(file);
  } catch {
    return [];
  }
  if (st.size > MAX_FILE_BYTES) return [];

  const fp = pricingFingerprint();
  const hit = cache.get(file);
  if (hit && hit.fingerprint === fp && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.entries;

  const piSessionId = piSessionIdOf(file);
  const entries: Entry[] = [];
  let raw = '';
  try {
    raw = readFileSync(file, 'utf-8');
  } catch {
    return [];
  }

  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const entry = JSON.parse(t) as {
        type?: string;
        timestamp?: string;
        usage?: {
          input?: number;
          output?: number;
          cacheRead?: number;
          cacheWrite?: number;
          totalTokens?: number;
          cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number };
        };
        message?: {
          model?: string;
          timestamp?: number;
          usage?: {
            input?: number;
            output?: number;
            cacheRead?: number;
            cacheWrite?: number;
            totalTokens?: number;
            cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number };
          };
        };
      };

      // 压缩节点（`type:"compaction"`）**也要记账**：它是真金白银的一次 LLM 调用
      // （实测 5 万 token 的会话压一次 ≈ 2.6 万 token，flash 约 $0.004），
      // 但它的 usage 挂在**节点自己**身上而不是 message 上，旧代码整类跳过 → 费用被漏掉。
      // 它没有 model 字段，所以标成 `(压缩)` 单独成桶，费用取 pi 记录的 cost（价格表算不出来）。
      const isCompaction = entry.type === 'compaction';
      if (entry.type !== 'message' && !isCompaction) continue;
      const usage = isCompaction ? entry.usage : entry.message?.usage;
      if (!usage) continue;
      const tsRaw =
        entry.timestamp ??
        (typeof entry.message?.timestamp === 'number' ? new Date(entry.message.timestamp).toISOString() : null);
      if (!tsRaw) continue;
      const d = new Date(tsRaw);
      if (Number.isNaN(d.getTime())) continue;

      const tok: TokenParts = {
        input: num(usage.input),
        output: num(usage.output),
        cacheRead: num(usage.cacheRead),
        cacheWrite: num(usage.cacheWrite),
        total: 0,
      };
      tok.total = num(usage.totalTokens) || tok.input + tok.output + tok.cacheRead + tok.cacheWrite;

      // 压缩节点没有 model 字段（pi 不在节点里记），单独成桶以便在看板上分辨这笔钱花在哪
      const model = isCompaction
        ? '(压缩)'
        : typeof entry.message?.model === 'string'
          ? entry.message.model
          : '(unknown)';
      const byTable = computeCost(model, tok);
      const recorded =
        num(usage.cost?.total) ||
        num(usage.cost?.input) + num(usage.cost?.output) + num(usage.cost?.cacheRead) + num(usage.cost?.cacheWrite);

      entries.push({
        date: localDate(d),
        piSessionId,
        model,
        tok,
        cost: byTable ?? recorded,
        source: byTable !== null ? 'table' : 'recorded',
      });
    } catch {
      /* 坏行跳过 */
    }
  }

  cache.set(file, { fingerprint: fp, mtimeMs: st.mtimeMs, size: st.size, entries });
  return entries;
}

/**
 * pi 会话 id → 员工 id：会话 id 形如 `waker-<id>` 或 `waker-<id>-<短后缀>`。
 * 员工 id 本身可能含 `-`（如 Public-Opinion），故取**最长前缀匹配**。
 */
function matchWaker(piSessionId: string, ids: string[]): string | null {
  const rest = piSessionId.startsWith('waker-') ? piSessionId.slice('waker-'.length) : piSessionId;
  let best: string | null = null;
  for (const id of ids) {
    if (rest === id || rest.startsWith(`${id}-`)) {
      if (!best || id.length > best.length) best = id;
    }
  }
  return best;
}

function period(days: UsageDay[]): UsagePeriod {
  const acc: UsagePeriod = { tokens: 0, cost: 0, runs: 0 };
  for (const d of days) {
    acc.tokens += d.tokens;
    acc.cost += d.cost;
    acc.runs += d.runs;
  }
  return acc;
}

export interface UsageOptions {
  /** 统计窗口天数（含今天），默认 365 天。 */
  days?: number;
  /** 只看某个员工。 */
  wakerId?: string;
}

export function buildUsage(opts: UsageOptions = {}): UsageView {
  const windowDays = Math.min(Math.max(Math.round(opts.days ?? 365), 7), 730);
  const ids = loadAllWakers().map((r) => r.def.id);

  const byDate = new Map<string, UsageDay & { wakerSet: Set<string> }>();
  let files = 0;

  for (const file of listSessionFiles()) {
    const entries = parseFile(file);
    if (!entries.length) continue;
    let used = false;
    for (const e of entries) {
      if (opts.wakerId && matchWaker(e.piSessionId, ids) !== opts.wakerId) continue;
      used = true;
      const cur =
        byDate.get(e.date) ?? { date: e.date, tokens: 0, cost: 0, runs: 0, wakers: 0, wakerSet: new Set<string>() };
      cur.tokens += e.tok.total;
      cur.cost += e.cost;
      cur.runs += 1;
      const wid = matchWaker(e.piSessionId, ids);
      if (wid) cur.wakerSet.add(wid);
      byDate.set(e.date, cur);
    }
    if (used) files += 1;
  }

  const days: UsageDay[] = [];
  const today = new Date();
  for (let i = windowDays - 1; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
    const key = localDate(d);
    const hit = byDate.get(key);
    days.push({
      date: key,
      tokens: hit?.tokens ?? 0,
      cost: hit?.cost ?? 0,
      runs: hit?.runs ?? 0,
      wakers: hit ? hit.wakerSet.size : 0,
    });
  }

  return {
    days,
    totals: {
      today: period(days.slice(-1)),
      week: period(days.slice(-7)),
      month: period(days.slice(-30)),
      all: period(days),
    },
    files,
    windowDays,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * 按 pi 会话 id 聚合用量（含模型维度）。
 * 传 `filter` 时只算给定会话——看板会话列表用它避免无谓遍历。
 */
export function usageBySession(filter?: Iterable<string>): Map<string, SessionUsage> {
  const want = filter ? new Set(filter) : null;
  const out = new Map<string, SessionUsage>();

  for (const file of listSessionFiles(want ?? undefined)) {
    for (const e of parseFile(file)) {
      if (want && !want.has(e.piSessionId)) continue;
      let s = out.get(e.piSessionId);
      if (!s) {
        s = { piSessionId: e.piSessionId, tokens: 0, cost: 0, runs: 0, source: 'recorded', models: [] };
        out.set(e.piSessionId, s);
      }
      s.tokens += e.tok.total;
      s.cost += e.cost;
      s.runs += 1;

      let m = s.models.find((x) => x.model === e.model);
      if (!m) {
        m = { model: e.model, tokens: 0, cost: 0, source: e.source, price: priceOf(e.model) };
        s.models.push(m);
      }
      m.tokens += e.tok.total;
      m.cost += e.cost;
    }
  }

  for (const s of out.values()) {
    s.models.sort((a, b) => b.tokens - a.tokens);
    const tables = s.models.filter((m) => m.source === 'table').length;
    s.source = tables === 0 ? 'recorded' : tables === s.models.length ? 'table' : 'mixed';
  }
  return out;
}

/** 单个会话的用量（无记录时返回全零，便于前端直接渲染）。 */
export function sessionUsage(piSessionId: string): SessionUsage {
  return (
    usageBySession([piSessionId]).get(piSessionId) ?? {
      piSessionId,
      tokens: 0,
      cost: 0,
      runs: 0,
      source: 'recorded',
      models: [],
    }
  );
}
