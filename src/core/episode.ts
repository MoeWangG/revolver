/**
 * 离场快照（Episode）——一个会话的"身份指纹"。
 *
 * 解决什么：会话切换发生时，被离开的那段对话要能以**一个整体**留在召回里。
 * 现有索引是"每条用户消息一块"（sessionIndex），长会话混着多个话题时，
 * 旧话题会把分数拉高、背景分被摊平，表现为"明明换了话题却还认得旧会话"。
 *
 * 做法：指针从 A 挪到 B 时，对 A 的**新增部分**做一次摘要，拼上最后两轮原文，
 * 求一个向量，作为 A 的一块高权重表示（role='episode'）。
 * 它不是给用户看的会话卡（那是 cardSummary），而是给召回用的：
 * 下次开口时，"这句像不像 A 那段"由它回答。
 *
 * 三条硬约束，与 sessionSummary 同一套账：
 *  1. **不在切换的关键路径上等**：调用方 fire-and-forget，失败静默，聊天不受影响；
 *  2. **只做增量**：游标 `episodeCovered` 记到第几条，反复切换不会反复摘要（省 token）；
 *  3. **流程噪声一律不进**：询问卡、切换提示、纯数字选项都不是话题内容。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { EPISODES_FILE } from './paths.ts';
import { patchSession, resolveSession } from './sessions.ts';
import { readSessionMessages, type ChatMessage } from './sessionHistory.ts';
import { embedTexts } from './embeddings.ts';
import { loadWaker } from './registry.ts';
import { runPiOnce } from './compact.ts';
import { llmArgs } from './runner.ts';
import { denoise } from './sessionSummary.ts';

export interface Episode {
  at: string;
  wakerId: string;
  sid: string;
  /** 切去的会话；用户只是离开（关窗 / 换渠道）时为空。 */
  to?: string;
  /** 覆盖区间 [from, covered)：第几条有效对话到第几条。 */
  from: number;
  covered: number;
  /** 这段在聊什么（≤160 字）。 */
  summary: string;
  /** 最后两轮原文（「用户：…」「助手：…」），给摘要兜底细节。 */
  tail: string[];
  /** 向量；embed 不可用时为空数组，召回侧自动跳过。 */
  vec: number[];
}

/** 召回侧只需要这三样，避免 sessionIndex 反向依赖本模块的生成逻辑。 */
export interface EpisodeChunk {
  key: string;
  sid: string;
  text: string;
  vec: number[];
}

/**
 * 流程噪声：这些东西进摘要或向量只会污染"这段在聊什么"。
 *
 * 全部来自实测：飞书询问卡的回退文本、切换后的提示行、卡片按钮的纯数字回答。
 * `role === 'system'` 也一并排除（压缩节点按设计没有正文，却有 role）。
 */
const NOISE_PREFIXES = [
  '已切到《',
  '已从《',
  '已退回《',
  '已在新会话《',
  '已处理完成',
  '话题判定：',
  '好，就在当前话题里回答',
];

const NOISE_EXACT = new Set(['留在当前', '以上都不是', '看看全部话题', '不切', '取消']);

/** 「回 1..N」的卡片选项：纯数字，最多两位。 */
const PICK_RE = /^[0-9]{1,2}$/;

export function isFlowNoise(text: string, role?: string): boolean {
  if (role === 'system') return true;
  const t = String(text ?? '').trim();
  if (!t) return true;
  if (PICK_RE.test(t)) return true;
  if (NOISE_EXACT.has(t)) return true;
  return NOISE_PREFIXES.some((p) => t.startsWith(p));
}

/**
 * 会话里**参与快照**的有效对话：只留 user / assistant，去掉流程噪声。
 * 读不到就返回空数组——快照是增强，读失败不该抛到切换路径上。
 */
export function dialogueOf(wakerId: string, sessionId: string, limit = 20_000): ChatMessage[] {
  try {
    return readSessionMessages(wakerId, sessionId, limit).filter(
      (m) => (m.role === 'user' || m.role === 'assistant') && m.text.trim() && !isFlowNoise(m.text, m.role),
    );
  } catch {
    return [];
  }
}

/** 送进向量的文本：摘要在前（主语），最后两轮原文在后（细节兜底）。 */
export function episodeVectorText(summary: string, tail: string[]): string {
  return [summary.trim(), ...tail].filter(Boolean).join('\n').slice(0, 1200);
}

/** 构造摘要提示词。纯函数，方便单测断言"这版口径没被改坏"。 */
export function buildEpisodePrompt(messages: ChatMessage[]): string {
  const lines = messages.map(
    (m) => `${m.role === 'user' ? '用户' : '助手'}：${m.text.replace(/\s+/g, ' ').slice(0, 500)}`,
  );
  return [
    '把下面这段对话整理成一段不超过 160 字的中文摘要，用途是**下次判断"新的一句话是否属于这个会话"**。',
    '要求：',
    '1. 第一句写清这段在讨论什么对象（专名必须原样保留：产品名、项目名、技术名、地名）',
    '2. 再写已得出的结论或决定，只写结论，不复述过程',
    '3. 最后一句写停在哪（下一个待办或未定问题），没有就省略',
    '4. 不要输出标题、表格、链接、代码块、客套话；不要用"用户说""助手说"这类转述',
    '',
    '对话：',
    ...lines,
  ].join('\n');
}

/** 模型输出清洗：去标签、去 markdown、压空行，截到 160 字。 */
export function cleanEpisodeSummary(text: string): string {
  const s = denoise(text)
    .replace(/^\s*(摘要|总结|小结)\s*[:：]\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > 160 ? `${s.slice(0, 160)}…` : s;
}

interface StoredRow {
  at?: string;
  w?: string;
  sid?: string;
  to?: string;
  from?: number;
  covered?: number;
  s?: string;
  tail?: string[];
  v?: number[];
}

interface ReadCache {
  mtimeMs: number;
  byWaker: Map<string, Episode[]>;
}

let CACHE: ReadCache | null = null;

function readRows(): StoredRow[] {
  if (!existsSync(EPISODES_FILE)) return [];
  try {
    return readFileSync(EPISODES_FILE, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as StoredRow;
        } catch {
          return null;
        }
      })
      .filter((r): r is StoredRow => Boolean(r));
  } catch {
    return [];
  }
}

/** 快照文件的 mtime：索引缓存必须把它算进去，否则新快照要等到向量文件变动才可见。 */
export function episodesMtime(): number {
  try {
    return existsSync(EPISODES_FILE) ? statSync(EPISODES_FILE).mtimeMs : 0;
  } catch {
    return 0;
  }
}

function loadAll(): Map<string, Episode[]> {
  const mtimeMs = episodesMtime();
  if (CACHE && CACHE.mtimeMs === mtimeMs) return CACHE.byWaker;

  const byWaker = new Map<string, Episode[]>();
  for (const r of readRows()) {
    if (!r.w || !r.sid || !r.s) continue;
    const ep: Episode = {
      at: String(r.at ?? ''),
      wakerId: r.w,
      sid: r.sid,
      to: r.to,
      from: Number(r.from ?? 0),
      covered: Number(r.covered ?? 0),
      summary: r.s,
      tail: Array.isArray(r.tail) ? r.tail.filter((x): x is string => typeof x === 'string') : [],
      vec: Array.isArray(r.v) ? r.v : [],
    };
    const list = byWaker.get(r.w) ?? [];
    list.push(ep);
    byWaker.set(r.w, list);
  }
  CACHE = { mtimeMs, byWaker };
  return byWaker;
}

/** 某个员工全部快照（按写入顺序）。 */
export function readEpisodes(wakerId: string): Episode[] {
  return loadAll().get(wakerId) ?? [];
}

/** 某个会话的快照，最新的在后。 */
export function episodesOf(wakerId: string, sessionId: string): Episode[] {
  return readEpisodes(wakerId).filter((e) => e.sid === sessionId);
}

/** 供索引合并：把带向量的快照按会话分组。 */
export function episodeChunks(wakerId: string): Map<string, EpisodeChunk[]> {
  const out = new Map<string, EpisodeChunk[]>();
  for (const e of readEpisodes(wakerId)) {
    if (!e.vec.length) continue;
    const list = out.get(e.sid) ?? [];
    list.push({ key: `ep-${e.sid}-${e.covered}-${e.at}`, sid: e.sid, text: e.summary, vec: e.vec });
    out.set(e.sid, list);
  }
  return out;
}

function appendEpisode(ep: Episode): void {
  try {
    mkdirSync(dirname(EPISODES_FILE), { recursive: true });
  } catch {
    /* 已存在 */
  }
  appendFileSync(
    EPISODES_FILE,
    `${JSON.stringify({
      at: ep.at,
      w: ep.wakerId,
      sid: ep.sid,
      to: ep.to,
      from: ep.from,
      covered: ep.covered,
      s: ep.summary,
      tail: ep.tail,
      // 5 位小数足够区分，体积比原值小一半（与 session-vectors 的写法一致）
      v: ep.vec.map((x) => Number(x.toFixed(5))),
    })}\n`,
    'utf-8',
  );
  CACHE = null;
}

export interface SnapshotResult {
  ok: boolean;
  skipped?: string;
  chars?: number;
  ms?: number;
}

/** 同一会话同时只跑一个快照：连续两次切换不该触发两次摘要。 */
const RUNNING = new Set<string>();

/** 摘要最多吃多少条增量：再多就只喂尾部，避免一次切换拖成十几秒。 */
const MAX_PROMPT_MESSAGES = 24;

/**
 * 切换时调用：给**被离开的会话**拍一张快照。
 *
 * 调用方必须 `void` 掉它（fire-and-forget）：这里会调模型，等它等于让用户等。
 * 失败一律返回 ok:false，不抛异常。
 */
export async function snapshotOnLeave(args: {
  wakerId: string;
  sessionId: string;
  to?: string;
}): Promise<SnapshotResult> {
  const guard = `${args.wakerId}:${args.sessionId}`;
  if (RUNNING.has(guard)) return { ok: false, skipped: '同一会话已有快照在跑' };
  RUNNING.add(guard);
  try {
    const rec = loadWaker(args.wakerId);
    if (!rec) return { ok: false, skipped: '员工不存在' };
    const cfg = rec.def.session;
    if (!cfg || cfg.mode !== 'topic') return { ok: false, skipped: '非 topic 模式' };

    const session = resolveSession(args.wakerId, args.sessionId);
    const all = dialogueOf(args.wakerId, args.sessionId);
    const covered = all.length;
    const prev = session.episodeCovered ?? 0;
    // 会话被清空 / 重建时计数会变小：游标回退，否则永远算不出增量
    const start = prev <= covered ? prev : 0;
    const fresh = all.slice(start);
    if (fresh.length < 2) return { ok: false, skipped: `新增 ${fresh.length} 条，不足一轮` };

    const kept = fresh.slice(-MAX_PROMPT_MESSAGES);
    const head: ChatMessage[] =
      fresh.length > kept.length
        ? [{ role: 'user', text: `（更早还有 ${fresh.length - kept.length} 条，此处省略）`, at: '' }]
        : [];
    const tail = kept
      .slice(-4)
      .map((m) => `${m.role === 'user' ? '用户' : '助手'}：${m.text.replace(/\s+/g, ' ').slice(0, 200)}`);

    const promptArgs = ['--no-tools', '--no-skills', ...llmArgs(rec)];
    if (cfg.summary.model) {
      const i = promptArgs.indexOf('--model');
      if (i >= 0) promptArgs.splice(i, 2);
      promptArgs.push('--model', cfg.summary.model);
    }

    const started = Date.now();
    const { out, err } = await runPiOnce(
      rec,
      promptArgs,
      buildEpisodePrompt([...head, ...kept]),
      cfg.summary.timeoutMs,
      // 机器调用，不沉淀成用户记忆
      { WAKER_MEMORY_NO_EXTRACT: '1' },
    );
    const summary = cleanEpisodeSummary(out);
    if (!summary) {
      return { ok: false, skipped: err ? `模型无输出：${err.slice(0, 120)}` : '模型无输出' };
    }

    const text = episodeVectorText(summary, tail);
    const vec =
      (await embedTexts([text], {
        enabled: cfg.semantic.enabled !== 'off',
        baseUrl: cfg.semantic.baseUrl,
        model: cfg.semantic.model,
        timeoutMs: cfg.semantic.timeoutMs,
      }))?.[0] ?? [];

    const at = new Date().toISOString();
    appendEpisode({
      at,
      wakerId: args.wakerId,
      sid: args.sessionId,
      to: args.to,
      from: start,
      covered,
      summary,
      tail,
      vec,
    });
    patchSession(args.wakerId, args.sessionId, { episodeAt: at, episodeCovered: covered });
    return { ok: true, chars: summary.length, ms: Date.now() - started };
  } catch (e) {
    return { ok: false, skipped: (e as Error)?.message ?? String(e) };
  } finally {
    RUNNING.delete(guard);
  }
}

/**
 * 开关：只有 topic 模式需要"切回旧话题"，其它模式拍了也没人查。
 * 由 conversations 在指针移动时调用，因此这里必须自己再判一次（调用方不该知道这些）。
 */
export function startSnapshot(args: { wakerId: string; sessionId: string; to?: string }): void {
  void snapshotOnLeave(args)
    .then((r) => {
      if (r.ok) console.log(`[episode] ${args.wakerId}/${args.sessionId} 快照 ${r.chars} 字，用时 ${r.ms}ms`);
      else if (r.skipped) console.log(`[episode] ${args.wakerId}/${args.sessionId} 跳过：${r.skipped}`);
    })
    .catch((e: unknown) => {
      console.error('[episode] 快照失败（不影响对话）:', (e as Error)?.message ?? e);
    });
}
