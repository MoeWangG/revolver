import { MEMORY_SERVER } from './paths.ts';

/**
 * 记忆库的运维入口（只做两件事：查、删）。
 *
 * 为什么需要它：记忆一旦入库就会被**反复注入**后续会话，垃圾是长期成本；
 * 而自动 TTL 又会误删长期记忆——所以先给人一个"把可疑条目挑出来看一眼"的工具，
 * 用人工判断替代机器的猜测。配套的是抽取侧的约束（见 extractor.py 的提示词），
 * 两边一起把"库里不该有的东西"压下去。
 *
 * 数据在 memory-server（`/api/memories`），这里只是薄封装，不重复实现存储。
 */

export interface MemoryRow {
  id: string;
  content: string;
  category: string;
  source: string;
  /** 归属（存储上是 project 列）：空 = 未分类，`shared` = 全员可见，其余为员工 id。 */
  project: string;
  createdAt: number;
}

interface RawRow {
  id?: unknown;
  content?: unknown;
  category?: unknown;
  source?: unknown;
  project?: unknown;
  created_at?: unknown;
}

export async function listMemories(opts: { namespace?: string; limit?: number } = {}): Promise<MemoryRow[]> {
  const q = new URLSearchParams({ limit: String(opts.limit ?? 2000) });
  if (opts.namespace) q.set('namespace', opts.namespace);
  const res = await fetch(`${MEMORY_SERVER}/api/memories?${q.toString()}`);
  if (!res.ok) throw new Error(`记忆服务返回 HTTP ${res.status}（${MEMORY_SERVER} 是否在运行？）`);
  const body = (await res.json()) as { memories?: RawRow[] };
  return (body.memories ?? []).map((m) => ({
    id: String(m.id ?? ''),
    content: String(m.content ?? ''),
    category: String(m.category ?? ''),
    source: String(m.source ?? ''),
    project: String(m.project ?? ''),
    createdAt: typeof m.created_at === 'number' ? m.created_at : 0,
  }));
}

export async function deleteMemory(id: string): Promise<boolean> {
  const res = await fetch(`${MEMORY_SERVER}/api/memories/${encodeURIComponent(id)}`, { method: 'DELETE' });
  return res.ok;
}

/**
 * 可疑条目：大概率是"当时成立、现在已过期"或没有复用价值的碎片。
 *
 * 调参记要（第一版太宽，把 64/1611 条都标了，其中大量是「…是目前最成熟的降本策略」
 * 这类**实质论述**，只因为正文里出现"目前"就被判过期 —— 那种清单没人会看）。
 * 现在的三条规则都要求"高置信"：
 *   1. 碎片口令 —— 明确无复用意义；
 *   2. 瞬时状态 —— 只对**短句**判，且排除 evidence/thesis（认知库素材本就是长论述）；
 *   3. 完全重复 —— 同内容多条，注入时会占掉同一个名额。
 * 宁可漏，不可滥：这是给人看的清单，噪声会直接摧毁它的可信度。
 */
const FRAGMENT_RE = /记住.{0,4}词|无更多上下文/;
/** 瞬时状态：只判短句。长文本里出现"目前/正在"通常是论述而非状态。 */
const TRANSIENT_RE = /正在|目前|暂时|临时|调试中|还没|尚未/;
const TRANSIENT_MAX = 40;
/** 认知库素材与知识库文档不参与"瞬时"判断。 */
const DURABLE_CATEGORIES = new Set(['evidence', 'thesis', 'knowledge']);

export interface Suspicion {
  row: MemoryRow;
  /** 命中原因，便于人工判断该不该删。 */
  why: string;
}

export function findSuspicious(rows: MemoryRow[]): Suspicion[] {
  const out: Suspicion[] = [];
  const seen = new Map<string, MemoryRow>();

  for (const row of rows) {
    const text = row.content.trim();
    if (!text) {
      out.push({ row, why: '空内容' });
      continue;
    }
    if (FRAGMENT_RE.test(text)) {
      out.push({ row, why: '碎片口令，无可复用意义' });
      continue;
    }
    if (
      text.length <= TRANSIENT_MAX &&
      !DURABLE_CATEGORIES.has(row.category) &&
      TRANSIENT_RE.test(text)
    ) {
      out.push({ row, why: '短句里的进行时状态，可能已过期' });
      continue;
    }
    // 完全重复：注入时会同名次竞争，留一条即可
    const first = seen.get(text);
    if (first) {
      out.push({ row, why: `与 ${first.id} 内容完全重复` });
      continue;
    }
    seen.set(text, row);
  }
  return out;
}

export function formatRow(row: MemoryRow): string {
  const when = row.createdAt ? new Date(row.createdAt * 1000).toISOString().slice(0, 10) : '----------';
  const ns = row.project || '未分类';
  const text = row.content.replace(/\s+/g, ' ').slice(0, 70);
  return `${row.id}  ${when}  ${ns.padEnd(16)} ${row.category.padEnd(10)} ${text}`;
}
