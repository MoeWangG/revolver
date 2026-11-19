import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { SESSION_VECTORS_FILE } from './paths.ts';
import { readSessionMessages } from './sessionHistory.ts';
import { displayNameOf } from './sessionName.ts';
import { embedTexts, type EmbeddingConfig } from './embeddings.ts';
import { cosine, type SemanticInput } from './topicRouter.ts';
import { episodeChunks, episodesMtime, isFlowNoise } from './episode.ts';
import type { SessionMeta } from './sessions.ts';

/**
 * 会话向量索引：把每个会话里**用户说过的话**全部向量化，落成一个可增量更新的文件。
 *
 * 为什么不再每次现场切 4 块（2026-11-10）：现场只有算力给每个候选 4 块，
 * 一旦真正相关的那句没被抽中，分数就凭空低一截——这是"该切没切"最主要的来源。
 * 全量索引把这件事拆成两半：写入时慢慢算（后台、增量、失败可重试），
 * 查询时只 embed 这一句 + 在已算好的向量里算余弦（纯内存，毫秒级）。
 *
 * 打分**不按"块越多越占优"**：
 *  - `vmax`：最像的那块（排序主信号，不会被长会话占便宜）；
 *  - `bg`：该会话所有块的平均相似度（去掉"同领域处处都高"的背景）；
 *  - `support`：去重后的 top-3 均值（多次支持才是真的在聊，但只是佐证）；
 *  - `lex`：标题命中（专名靠词面）。
 * 综合 `S = 0.6(vmax-bg) + 0.25(support-bg) + 0.15·lex`，**不求和**，
 * 否则一个 147 条的会话凑三个 0.55 就能压过逐字命中的 1.00。
 */

export interface IndexChunk {
  /** 稳定键：sha1(wakerId + sid + text)。文本不变就不会重复写。 */
  key: string;
  sid: string;
  role: 'title' | 'card' | 'user' | 'episode';
  text: string;
  vec: number[];
}

export interface SessionScore {
  id: string;
  /** 最像的那块。 */
  vmax: number;
  /** 该会话所有块的平均相似度（背景）。 */
  bg: number;
  /** 去重后 top-3 的均值。 */
  support: number;
  /** 标题命中 0~1。 */
  lex: number;
  /** 综合分，仅用于排序。 */
  score: number;
  /** 索引里这个会话有多少块（诊断用）。 */
  chunks: number;
}

interface CacheBucket {
  /**
   * 两个文件 mtime 拼成的戳：向量文件之外，**快照文件**变了也要失效。
   * 只盯 session-vectors.jsonl 会让新拍的快照在缓存过期前一直看不见（实测踩过）。
   */
  stamp: string;
  bySid: Map<string, IndexChunk[]>;
}

const BUCKETS = new Map<string, CacheBucket>();

/** 每次最多索引多少条消息：太多会把一次后台任务拖到几分钟。 */
const MAX_MESSAGES_PER_SESSION = 800;
/** 批量 embed 的大小：bge-m3 单条约 42ms，32 条 ≈ 1.3s，失败整批重试也便宜。 */
const EMBED_BATCH = 32;
/** 太短的消息（"嗯""好的"）没有话题信息，只制造噪声。 */
const MIN_TEXT = 4;

function keyOf(wakerId: string, sid: string, text: string): string {
  return createHash('sha1').update(`${wakerId}\u0000${sid}\u0000${text}`).digest('hex').slice(0, 20);
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

/** 一个会话参与索引的块：标题 / 会话卡 / 全部用户消息（去重、去掉过短的）。 */
export function collectChunks(wakerId: string, session: SessionMeta): IndexChunk[] {
  const out: IndexChunk[] = [];
  const seen = new Set<string>();
  const push = (role: IndexChunk['role'], raw: string): void => {
    const text = String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, 400);
    if (text.length < MIN_TEXT) return;
    const norm = normalize(text);
    if (!norm || seen.has(norm)) return;
    seen.add(norm);
    out.push({ key: keyOf(wakerId, session.id, text), sid: session.id, role, text, vec: [] });
  };

  push('title', displayNameOf(session));
  push('card', session.cardSummary ?? '');
  try {
    const msgs = readSessionMessages(wakerId, session.id, MAX_MESSAGES_PER_SESSION);
    // 流程噪声（询问卡回退文本、切换提示、纯数字选项）不是话题内容：
    // 索引进去只会让"这句像不像旧会话"多出一批假命中（实测「2」「留在当前」这类被当成了对话）。
    for (const m of msgs) if (m.role === 'user' && !isFlowNoise(m.text, m.role)) push('user', m.text);
  } catch {
    /* 读不到就只用标题/卡，索引自然是浅的 */
  }
  return out;
}

function readFileLines(): string[] {
  try {
    if (!existsSync(SESSION_VECTORS_FILE)) return [];
    return readFileSync(SESSION_VECTORS_FILE, 'utf-8').split('\n');
  } catch {
    return [];
  }
}

/** 载入某个员工的向量缓存（按文件 mtime 自动失效）。 */
export function loadCache(wakerId: string): Map<string, IndexChunk[]> {
  let vectorsMtime = 0;
  try {
    vectorsMtime = existsSync(SESSION_VECTORS_FILE) ? statSync(SESSION_VECTORS_FILE).mtimeMs : 0;
  } catch {
    vectorsMtime = 0;
  }
  const stamp = `${vectorsMtime}:${episodesMtime()}`;
  const hit = BUCKETS.get(wakerId);
  if (hit && hit.stamp === stamp) return hit.bySid;

  const bySid = new Map<string, IndexChunk[]>();
  for (const line of readFileLines()) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as { k?: string; sid?: string; w?: string; role?: string; t?: string; v?: number[] };
      if (row.w !== wakerId || !row.sid || typeof row.k !== 'string' || !Array.isArray(row.v) || !row.v.length) continue;
      const chunk: IndexChunk = {
        key: row.k,
        sid: row.sid,
        role: row.role === 'title' || row.role === 'card' || row.role === 'episode' ? row.role : 'user',
        text: String(row.t ?? ''),
        vec: row.v,
      };
      const list = bySid.get(row.sid) ?? [];
      list.push(chunk);
      bySid.set(row.sid, list);
    } catch {
      /* 坏行跳过：索引是增强，不能因为一行损坏就整体不可用 */
    }
  }

  // 合并离场快照（episode）：单独一个文件存，重建消息索引时不该把快照一起清掉。
  // 合并进 bySid 之后，召回侧（semanticFromIndex / scoreSessions）不用改就能用上——
  // 它们本来就会遍历一个会话的全部块。
  for (const [sid, list] of episodeChunks(wakerId)) {
    const bucket = bySid.get(sid) ?? [];
    for (const c of list) bucket.push({ key: c.key, sid: c.sid, role: 'episode', text: c.text, vec: c.vec });
    bySid.set(sid, bucket);
  }

  BUCKETS.set(wakerId, { stamp, bySid });
  return bySid;
}

/**
 * 增量索引：只算缓存里没有的块。
 *
 * 任何一批失败就**停在原地**（已写入的保留、剩下的下次再来），
 * 绝不让索引失败冒泡到消息路径。
 */
export async function ensureIndexed(
  wakerId: string,
  sessions: SessionMeta[],
  cfg: EmbeddingConfig,
): Promise<{ added: number; total: number; sessionsIndexed: number }> {
  const bySid = loadCache(wakerId);
  const pending: IndexChunk[] = [];
  for (const s of sessions) {
    const existing = new Set((bySid.get(s.id) ?? []).map((c) => c.key));
    for (const c of collectChunks(wakerId, s)) {
      if (!existing.has(c.key)) pending.push(c);
    }
  }
  if (!pending.length) {
    return { added: 0, total: 0, sessionsIndexed: countIndexed(bySid, sessions) };
  }

  let added = 0;
  for (let i = 0; i < pending.length; i += EMBED_BATCH) {
    const batch = pending.slice(i, i + EMBED_BATCH);
    const vecs = await embedTexts(
      batch.map((c) => c.text),
      cfg,
    );
    if (!vecs) break; // 服务不可用：留着下次
    try {
      mkdirSync(dirname(SESSION_VECTORS_FILE), { recursive: true });
    } catch {
      /* 已存在 */
    }
    const lines: string[] = [];
    batch.forEach((c, j) => {
      const vec = vecs[j];
      if (!vec?.length) return;
      lines.push(
        JSON.stringify({
          k: c.key,
          sid: c.sid,
          w: wakerId,
          role: c.role,
          t: c.text.slice(0, 120),
          // 5 位小数足够区分，体积比原值小一半
          v: vec.map((x) => Number(x.toFixed(5))),
        }),
      );
      added += 1;
    });
    if (lines.length) appendFileSync(SESSION_VECTORS_FILE, `${lines.join('\n')}\n`, 'utf-8');
  }

  BUCKETS.delete(wakerId); // mtime 已变，下一次 loadCache 重新读
  return { added, total: pending.length, sessionsIndexed: countIndexed(loadCache(wakerId), sessions) };
}

function countIndexed(bySid: Map<string, IndexChunk[]>, sessions: SessionMeta[]): number {
  return sessions.filter((s) => (bySid.get(s.id)?.length ?? 0) > 0).length;
}

/**
 * 单会话打分。纯函数，测试直接断言。
 *
 * `support` 的"去重"是**按块之间**算的：同一句话被复述三次时，向量几乎相同，
 * 不能让它们把一个名额刷成三次（实测这类复述在 IM 里很常见：好了吗 / 现在呢 / 好了没）。
 */
export function scoreSessionChunks(queryVec: number[], chunks: IndexChunk[]): {
  vmax: number;
  bg: number;
  support: number;
} {
  if (!chunks.length) return { vmax: 0, bg: 0, support: 0 };
  const scored = chunks
    .map((c) => ({ vec: c.vec, role: c.role, s: cosine(queryVec, c.vec) }))
    .filter((x) => Number.isFinite(x.s))
    .sort((a, b) => b.s - a.s);
  if (!scored.length) return { vmax: 0, bg: 0, support: 0 };

  const vmax = scored[0]!.s;
  // 背景分只统计普通块。episode 是"整段对话的压缩表示"，对任何一句都天然更像，
  // 混进均值会把所有会话的 bg 一起抬高，等于把快照带来的那点信号又抵掉。
  const plain = scored.filter((x) => x.role !== 'episode');
  const bgBase = plain.length ? plain : scored;
  const bg = bgBase.reduce((sum, x) => sum + x.s, 0) / bgBase.length;

  const picked: Array<{ vec: number[]; s: number }> = [];
  for (const cand of scored) {
    if (picked.length >= 3) break;
    if (picked.some((p) => cosine(cand.vec, p.vec) > 0.97)) continue; // 近重复：只算一次
    picked.push(cand);
  }
  const support = picked.reduce((sum, x) => sum + x.s, 0) / picked.length;
  return { vmax, bg, support };
}

/**
 * 标题命中分：只发一个会话名/专名时，词面比向量可靠。
 * 完全相等 → 1；互相包含 → 0.5；其余 0（不做模糊匹配，避免"周报"命中"周报复盘"以外的噪声）。
 */
export function titleMatchScore(title: string, message: string): number {
  const t = normalize(title);
  const m = normalize(message);
  if (!t || !m) return 0;
  if (t === m) return 1;
  if (t.length >= 3 && (m.includes(t) || t.includes(m))) return 0.5;
  return 0;
}

/**
 * 专名命中：消息里的英文词/型号（`kid-qa-box`、`esp32-cam`、`tof`）出现在这个会话的任一块里。
 *
 * 为什么只认这类词：中文二元组重叠太普遍（"产品""方案""怎么"），拿它做词面分等于把所有
 * 会话一起抬起来；而型号/专名几乎不会误伤，命中即强信号。
 * 为什么需要它：实测「kid-qa-box 的 README 改好了吗」——正确的《树莓派AI问答机落地》
 * 在向量上只有 0.592，被《AI产品四问清单》0.639 压住；而 `kid-qa-box` 是**确定性证据**，
 * 不该被一个领域相似的会话顶掉。
 */
export function properNounScore(texts: string[], message: string): number {
  const words = [...String(message ?? '').toLowerCase().matchAll(/[a-z0-9][a-z0-9_+-]{2,}/g)].map((m) => m[0]);
  if (!words.length) return 0;
  const bag = texts.map(normalize).join('\n');
  if (!bag) return 0;
  const hit = words.filter((w) => bag.includes(normalize(w))).length;
  return hit / words.length;
}

/** 综合分：只用于排序，不改变任何阈值含义。 */
export function combineScore(vmax: number, bg: number, support: number, lex: number): number {
  return 0.6 * (vmax - bg) + 0.25 * (support - bg) + 0.15 * lex;
}

export function scoreSessions(args: {
  queryVec: number[];
  message: string;
  sessions: SessionMeta[];
  bySid: Map<string, IndexChunk[]>;
}): SessionScore[] {
  const out: SessionScore[] = [];
  for (const s of args.sessions) {
    const chunks = args.bySid.get(s.id);
    if (!chunks?.length) continue;
    const { vmax, bg, support } = scoreSessionChunks(args.queryVec, chunks);
    // 词面信号取"标题"与"专名出现在任一块"的较大者：episode 摘要里同样写着专名，
    // 只认标题会让快照带来的确定性证据白白丢掉（实测见 properNounScore 注释）。
    const lex = Math.max(
      titleMatchScore(displayNameOf(s), args.message),
      properNounScore(
        chunks.map((c) => c.text),
        args.message,
      ),
    );
    out.push({
      id: s.id,
      vmax,
      bg,
      support,
      lex,
      score: combineScore(vmax, bg, support, lex),
      chunks: chunks.length,
    });
  }
  return out.sort((a, b) => b.score - a.score);
}

/**
 * 用索引拼出判定所需的 `SemanticInput`：每个会话的**全部块**都参与，
 * 于是 `decideSemantic` 的"块间取最大"不用再现场 embed 一遍。
 */
export function semanticFromIndex(args: {
  queryVec: number[];
  active: SessionMeta;
  sessions: SessionMeta[];
  bySid: Map<string, IndexChunk[]>;
  continueThreshold: number;
  switchThreshold: number;
  unrelatedThreshold: number;
}): SemanticInput | null {
  const activeVecs = (args.bySid.get(args.active.id) ?? []).map((c) => c.vec);
  if (!activeVecs.length) return null; // 当前会话还没索引到：不能拿 0 分去判"不像"
  const candidates = args.sessions
    .filter((s) => s.id !== args.active.id)
    .map((s) => ({ sessionId: s.id, vecs: (args.bySid.get(s.id) ?? []).map((c) => c.vec) }))
    .filter((c) => c.vecs.length > 0);
  if (candidates.length < 2) return null; // 太少就没有比较意义
  return {
    message: args.queryVec,
    active: activeVecs,
    candidates,
    continueThreshold: args.continueThreshold,
    switchThreshold: args.switchThreshold,
    unrelatedThreshold: args.unrelatedThreshold,
  };
}
