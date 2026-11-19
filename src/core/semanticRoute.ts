/**
 * 把"一个会话"翻译成"一段可以求向量的文本"，一次性批量取向量。
 *
 * 为什么要单独一层：
 *   会话文本由「标题 + 最近几条用户消息」拼成，拼接规则改了会影响判定效果，
 *   所以它得和"怎么求向量"分开，才好在测试里断言。
 *
 * 一次调用只发一个 HTTP 请求（消息 + 当前会话 + 候选会话一起批量），
 * 而不是每个会话一次——后者 N 个会话就是 N 次往返，全都等在收消息的路径上。
 */
import type { SessionMeta } from './sessions.ts';
import { readSessionMessages } from './sessionHistory.ts';
import { displayNameOf } from './sessionName.ts';
import { cosine, type SemanticInput } from './topicRouter.ts';
import { embedTexts, type EmbeddingConfig } from './embeddings.ts';

/**
 * 会话切成若干"语义块"：标题 + 话题起点 + 最近几条用户消息。
 *
 * 为什么不合成一段、而要保持分块：
 *   一个会话里往往混着多个话题（旧金山、linkdin、AI 工具…），拼成一段再求向量
 *   会被**平均掉**——实测「旧金山有哪些小众景点」对这样的会话只有 0.574，
 *   单看那句「旧金山有什么好玩的吗」却是 0.7 以上。
 *   所以判定用**块间最大相似度**，而不是段落平均。这也是 RAG 的常规做法。
 */
export function sessionChunks(session: SessionMeta, limit = 6): string[] {
  const out: string[] = [];
  const push = (t: string): void => {
    const s = t.trim().slice(0, 200);
    if (s && !out.includes(s)) out.push(s);
  };

  push(displayNameOf(session) || '');
  // 会话卡本身就是"这段在聊什么"的提要，性价比最高的一块
  const card = (session.cardSummary ?? '').trim();
  if (card) push(card.slice(0, 300));

  try {
    const msgs = readSessionMessages(session.wakerId, session.id, 40);
    const users = msgs.filter((m) => m.role === 'user' && m.text.trim());

    // **均匀抽样**而不是只取首尾：话题常常出现在中段。
    // 实测踩过：一个 58 条消息的会话里「创业」在中段，只抽首条+最近三条时
    // 完全抽不到，导致"想聊聊创业"被判成继续聊旧金山。
    const n = Math.min(limit, users.length);
    const idx: number[] = [];
    for (let i = 0; i < n; i += 1) {
      idx.push(n === 1 ? 0 : Math.round((i * (users.length - 1)) / (n - 1)));
    }
    for (const i of idx) push(users[i]!.text);

    // 助手回复里话题往往更明确（"我建议你…"比"我想问…"更利于判断在聊什么）
    const lastAssistant = [...msgs].reverse().find((m) => m.role === 'assistant' && m.text.trim());
    if (lastAssistant) push(lastAssistant.text);
  } catch {
    /* 读不到就只用标题，判定会自然退化为保守 */
  }

  return out.slice(0, limit + 3);
}

/** 调试用：把块拼成一段可读文本。 */
export function sessionText(session: SessionMeta): string {
  return sessionChunks(session).join('\n');
}

/**
 * 候选会话每个只取几块。
 *
 * 为什么不是全量：全量 10 个会话就是 **81 块**，bge-m3 在 M5 上要 3.4s，
 * 一旦超过 embedding 超时这条链路就整个降级成词面（实测：网页端跳转建议从不弹出）。
 * 而"这段是不是在聊那个旧话题"靠的是**标题 + 会话卡 + 一条抽样**，3 块足够；
 * 再多的块边际收益极低，却把耗时线性推高。
 */
const CANDIDATE_CHUNK_LIMIT = 1;

/**
 * 取本轮判定所需的向量。
 *
 * 返回 null 表示"语义不可用"（服务没起、模型没加载、超时），
 * 调用方必须据此退回词面判定——**语义是增强，不是依赖**。
 *
 * 拆成两次请求（当前会话 / 候选会话）而不是一次大批量，是为了**可部分降级**：
 *  - 第一批挂了 → 真的没有语义信号，返回 null；
 *  - 只有候选批挂了 → 丢掉候选，仍能回答"这句和当前话题像不像"（继续 / 新话题仍可判）。
 * 一次性大批量做不到这一点：中间任何一块失败，整批都没有向量。
 */
export async function semanticInputFor(args: {
  message: string;
  active: SessionMeta;
  candidates: SessionMeta[];
  cfg: EmbeddingConfig;
  continueThreshold: number;
  switchThreshold: number;
  unrelatedThreshold: number;
}): Promise<SemanticInput | null> {
  const activeChunks = sessionChunks(args.active);

  // 第一批：消息 + 当前会话的全部块。判"是否继续"必须准，这块不能省。
  const core = await embedTexts([args.message, ...activeChunks], args.cfg);
  if (!core || core.length !== activeChunks.length + 1) return null;
  const message = core[0]!;
  const active = core.slice(1);

  // 第二批：候选会话的少量块。失败只丢候选，不影响上面那批。
  const candChunks = args.candidates.map((s) => sessionChunks(s, CANDIDATE_CHUNK_LIMIT));
  const flat = candChunks.flat();
  const candVecs = flat.length ? await embedTexts(flat, args.cfg) : [];
  const candidates: SemanticInput['candidates'] = [];
  if (candVecs && candVecs.length === flat.length) {
    let at = 0;
    for (let i = 0; i < args.candidates.length; i += 1) {
      const n = candChunks[i]!.length;
      const vecsOf = candVecs.slice(at, at + n);
      at += n;
      if (vecsOf.length === n && n > 0) candidates.push({ sessionId: args.candidates[i]!.id, vecs: vecsOf });
    }
  }

  return {
    message,
    active,
    candidates,
    continueThreshold: args.continueThreshold,
    switchThreshold: args.switchThreshold,
    unrelatedThreshold: args.unrelatedThreshold,
  };
}

/**
 * 这句与某个候选会话的最大块相似度（没有该候选的向量 → undefined）。
 * 与 `decideSemantic` 用同一把尺子（块间取最大），避免"排序用平均、判定用最大"两套刻度。
 */
export function semanticScoreOf(
  sem: SemanticInput | null | undefined,
  sessionId: string,
): number | undefined {
  if (!sem) return undefined;
  const hit = sem.candidates.find((c) => c.sessionId === sessionId);
  if (!hit || !hit.vecs.length) return undefined;
  return hit.vecs.reduce((m, v) => Math.max(m, cosine(sem.message, v)), 0);
}

/**
 * 把候选按**与本句的语义相似度**重排，而不是沿用"谁最近活跃"。
 *
 * 为什么必须重排（2026-11-08 飞书实测）：仲裁模型只读前 `MAX_CANDIDATES`(5) 个候选，
 * 而候选来自 `agentSessions()` 的活跃度倒序。用户只发「esp32-cam」想切回同名旧会话时，
 * 那条会话按活跃度排第 8、语义相似度却是 **1.0** —— 它根本没进模型的选项，
 * 模型只能答"新话题"。用户看到的是"记忆没切到我想要的那条"。
 *
 * 没有分数的候选保持原顺序排在后面（不进 sort，避免用 -1 哨兵和负相似度混淆）。
 */
export function rankCandidatesBySemantic<T extends { id: string }>(
  candidates: T[],
  sem: SemanticInput | null | undefined,
): T[] {
  if (!sem || !sem.candidates.length) return candidates;
  const scored: Array<{ item: T; score: number }> = [];
  const rest: T[] = [];
  for (const c of candidates) {
    const score = semanticScoreOf(sem, c.id);
    if (score === undefined) rest.push(c);
    else scored.push({ item: c, score });
  }
  if (!scored.length) return candidates;
  scored.sort((a, b) => b.score - a.score);
  return [...scored.map((x) => x.item), ...rest];
}

/**
 * 仲裁的 switch 至少要比当前会话像这么多，才允许动指针。
 *
 * 比 `decideSemantic` 静默切换用的 0.08 更松一点（0.05），因为这条门的**下游是询问卡**：
 * 过线只是"问一句"，不是"直接搬"。实测两个相邻样本：
 *  · 「我拿到硬件了，摄像头装到了开发板上」对《esp32-cam》0.656、对当前《周报》0.584 →
 *    领先 0.072，值得问一次；
 *  · 同一句在旧会话里对《周报》0.697、对当前《esp32-cam》0.656 → 只领先 0.041，
 *    就是那次把用户送进周报的误切，必须挡住。
 * 0.05 正好卡在两者之间。
 */
export const SWITCH_MIN_GAP = 0.05;
/** 与语义第一名允许的最大差距：仲裁挑的目标不能离"最像的那条"太远。 */
const SWITCH_MAX_DRIFT = 0.05;

/**
 * 仲裁给出的 switch 是否可信。
 *
 * 为什么需要它（2026-11-08 实测）：44 次仲裁里只有 **3 次** switch 目标与语义最像的会话一致，
 * 模型自报 `confidence` 普遍在 0.06~0.4（`decisionFromArbiter` 却按 0.75 放行）。
 * 当晚 03:35 那条「我拿到硬件了，摄像头装到了开发板上」被切成《周报复盘定时推送》：
 * 语义只有 0.697、只领先当前 0.041 —— 按 `decideSemantic` 的规则本来就该"留在当前"，
 * 是仲裁把它改成了 switch，用户点「切回去」后原话被答在了周报会话里。
 *
 * 三条约束缺一不可：
 *  1. 目标必须在语义前 `topK`（默认 3）——排除"看起来像但其实不相关"的候选；
 *  2. 与语义第一名差距 ≤ 0.05 —— 排第 3 且分数差一大截的不算"最像"；
 *  3. 领先当前会话 ≥ `minGap`（默认 0.05）—— 差距太薄说明本来就不该切。
 *
 * 语义不可用时返回 true：那套刻度无从比较，保留原行为（仲裁是增强，不是依赖）。
 */
export function arbiterSwitchConsistent(args: {
  sem: SemanticInput | null | undefined;
  /** 已按相似度排好序的候选 id。 */
  rankedIds: string[];
  targetSessionId: string;
  /** 当前会话与这句的相似度（来自 RouteSignals.semanticActive）。 */
  activeScore: number;
  topK?: number;
  minGap?: number;
}): boolean {
  const { sem, rankedIds, targetSessionId, activeScore, topK = 3, minGap = SWITCH_MIN_GAP } = args;
  if (!sem) return true;
  const idx = rankedIds.indexOf(targetSessionId);
  if (idx < 0 || idx >= topK) return false;
  const target = semanticScoreOf(sem, targetSessionId);
  if (target === undefined) return false;
  const best = semanticScoreOf(sem, rankedIds[0] ?? '') ?? target;
  return target >= best - SWITCH_MAX_DRIFT && target - activeScore >= minGap;
}
