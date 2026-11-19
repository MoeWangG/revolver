/**
 * 网页端的"话题建议"：**只判定，不执行**。
 *
 * 为什么要单独一个入口，而不是复用 IM 那套流程：
 *   IM 是异步的，可以在收消息时直接问一句；网页是一次请求-响应，
 *   前端要在**发送之前**拿到判断结果，才能决定是弹卡片还是直接发。
 *   所以这里必须是无副作用的纯查询：不改 active 指针、不写会话、不调模型。
 */
import type { WakerRecord } from '../types.ts';
import { listSessions, resolveSession } from './sessions.ts';
import { displayNameOf } from './sessionName.ts';
import {
  cosine,
  DEFAULT_ROUTE_CONFIG,
  decideRoute,
  decideTimeWindow,
  tokenize,
  type RouteAction,
  type RouteSession,
} from './topicRouter.ts';
import { semanticInputFor } from './semanticRoute.ts';
import { recapText } from './sessionSummary.ts';
import { readSessionMessages } from './sessionHistory.ts';
import { appendFileSync } from 'node:fs';
import { arbitratePair, decisionFromArbiter, type ArbiterResult } from './topicArbiter.ts';
import { DEFAULT_ARBITER_CONFIG } from '../types.ts';
import { ROUTING_LOG } from './paths.ts';

/**
 * 判定流水也记网页端。
 *
 * 为什么必须记：网页端原来是**完全不落盘**的——用户说"点了没切成"，日志里一片空白，
 * 只能靠猜测。现在每次发送前的判定都写一行（`source: 'web'`），
 * 与飞书那边共用 `data/routing.jsonl`，排查时一条命令就能看清"当时判了什么、为什么"。
 * 写失败绝不影响发送。
 */
function logSuggestion(args: {
  wakerId: string;
  sessionId: string;
  suggestion: TopicSuggestion;
  arbiter: ArbiterResult | null;
  semanticUnavailable: boolean;
  /** 喂给决策模型的候选 id，排查"为什么没切回那个会话"时必须看这个。 */
  candidates: string[];
}): void {
  try {
    appendFileSync(
      ROUTING_LOG,
      `${JSON.stringify({
        at: new Date().toISOString(),
        source: 'web',
        wakerId: args.wakerId,
        key: args.sessionId,
        activeSessionId: args.sessionId,
        action: args.suggestion.action,
        target: args.suggestion.target?.id,
        confidence: Number(args.suggestion.confidence.toFixed(3)),
        semanticUnavailable: args.semanticUnavailable,
        arbiter: args.arbiter
          ? {
              model: args.arbiter.model,
              action: args.arbiter.action,
              target: args.arbiter.targetSessionId,
              ms: args.arbiter.ms,
              raw: args.arbiter.raw.slice(0, 120),
            }
          : undefined,
        candidates: args.candidates,
        reason: args.suggestion.reason,
      })}\n`,
      'utf-8',
    );
  } catch {
    /* 观测日志写失败不影响发送 */
  }
}

/**
 * 影子模型的对照行（网页端）。
 *
 * 与 IM 的 `logShadow` 同一套字段，`source: 'web-shadow'` 区分渠道；
 * A/B 脚本按 source 分开统计——网页是"发送前同步等"，IM 是异步，延迟分布不同。
 */
function logShadowSuggestion(args: {
  wakerId: string;
  sessionId: string;
  message: string;
  mainAnswer: { action: string; target?: string } | null;
  mainModel: string;
  shadow: ArbiterResult;
}): void {
  try {
    appendFileSync(
      ROUTING_LOG,
      `${JSON.stringify({
        source: 'web-shadow',
        at: new Date().toISOString(),
        wakerId: args.wakerId,
        key: args.sessionId,
        activeSessionId: args.sessionId,
        message: args.message.slice(0, 60),
        main: args.mainAnswer
          ? { model: args.mainModel, action: args.mainAnswer.action, target: args.mainAnswer.target }
          : { model: args.mainModel, action: '(unavailable)' },
        shadow: {
          model: args.shadow.model,
          action: args.shadow.action,
          target: args.shadow.targetSessionId,
          ms: args.shadow.ms,
          raw: args.shadow.raw.slice(0, 80),
        },
        agree: Boolean(args.mainAnswer) && args.mainAnswer!.action === args.shadow.action,
      })}\n`,
      'utf-8',
    );
  } catch {
    /* 影子日志写失败不影响发送 */
  }
}

export interface TopicSuggestion {
  action: RouteAction;
  confidence: number;
  reason: string;
  regime: 'semantic' | 'lexical' | 'timeWindow';
  current: { id: string; title: string };
  /** action=switch 时给出目标与摘要，前端据此渲染卡片。 */
  target?: { id: string; title: string; recap: string; similarity?: number };
}

function titleOf(id: string, fallback: string): string {
  return fallback || id;
}

function toRouteSession(s: ReturnType<typeof resolveSession>): RouteSession {
  let sample: string[] = [];
  try {
    sample = readSessionMessages(s.wakerId, s.id, 8)
      .filter((m) => m.role === 'user' && m.text.trim())
      .slice(-3)
      .map((m) => m.text.slice(0, 200));
  } catch {
    /* 读不到就只用标题 */
  }
  return { sessionId: s.id, title: displayNameOf(s), lastActiveAt: s.lastActiveAt, sample };
}

/**
 * 网页端**建议线**：比 IM 的自动判定宽松 0.05。
 *
 * 为什么可以更宽：网页端弹的是一条**可点可不点**的建议条（还有"就在这儿发"），
 * 误判的代价是一次点击；IM 那边要走询问配额、还会真的搬指针，必须更保守。
 * 实测（2026-11-05，chat 员工真实会话）："树莓派那个 3b…摄像头换 ToF" 最佳候选 0.597，
 * 而正式切换线是 0.60——差 0.003，用同一套阈值会让建议**永远弹不出来**。
 */
const WEB_SUGGEST_MARGIN = 0.05;

/**
 * 网页端判定的**总预算**（毫秒）。
 *
 * 为什么必须有硬上限：网页是"发送前同步等"，判定慢一点用户就只看到输入框卡住。
 * 实测（2026-11-05）LM Studio 忙时单条 embedding 要 2.8s、laya 要 0.7~1.3s，
 * 叠起来一次发送要等 5~8 秒——比飞书（异步、可慢慢判）体感差得多。
 * 所以这里给语义 800ms、仲裁 600ms 的独立预算，超时就按"判定不可用/仅词面"继续发，
 * 宁可少弹一次建议，也不能让发送卡住。
 */
const WEB_SEMANTIC_BUDGET_MS = 800;
const WEB_ARBITER_BUDGET_MS = 600;

/**
 * 词面重合度：消息的 token 有多少比例出现在这个会话里。
 *
 * 语义不可用时的排序依据。对「树莓派」「ToF」这类**专名**很有效——
 * 这也是"明明该切回旧话题却判成继续"最常见的原因：候选里根本没那个会话。
 */
function lexicalScore(message: string, session: ReturnType<typeof resolveSession>): number {
  const msg = tokenize(message);
  if (!msg.size) return 0;
  let sample: string[] = [];
  try {
    sample = readSessionMessages(session.wakerId, session.id, 3)
      .filter((m) => m.role === 'user')
      .map((m) => m.text);
  } catch {
    /* 读不到就只用标题与摘要 */
  }
  const bag = tokenize([displayNameOf(session), session.cardSummary ?? '', ...sample].join(' '));
  let hit = 0;
  for (const t of msg) if (bag.has(t)) hit += 1;
  return hit / msg.size;
}

/** 给决策模型挑候选：最多 3 个。有向量按相似度排，没有就按词面重合、再按最近活跃。 */
function rankCandidates(
  message: string,
  others: ReturnType<typeof listSessions>,
  semantic: Awaited<ReturnType<typeof semanticInputFor>>,
): ReturnType<typeof listSessions> {
  const LIMIT = 3;
  const byId = new Map(others.map((s) => [s.id, s]));
  if (semantic) {
    const maxCos = (v: number[], chunks: number[][]): number => chunks.reduce((m, x) => Math.max(m, cosine(v, x)), 0);
    const ranked = semantic.candidates
      .map((c) => ({ s: byId.get(c.sessionId), score: maxCos(semantic.message, c.vecs) }))
      .filter((x): x is { s: (typeof others)[number]; score: number } => Boolean(x.s))
      .sort((a, b) => b.score - a.score)
      .slice(0, LIMIT)
      .map((x) => x.s);
    // 候选批失败时 semantic.candidates 是空的（核心批成功、候选批超时）——
    // 这时**必须退回词面排序**，否则喂给决策模型的是"零个旧话题"，
    // 它只能判"继续 / 新话题"，于是"该切回旧话题"永远判不出来（实测踩到）。
    if (ranked.length) return ranked;
  }
  return [...others]
    .map((s) => ({ s, score: lexicalScore(message, s) }))
    .sort((a, b) =>
      b.score !== a.score
        ? b.score - a.score
        : a.s.lastActiveAt < b.s.lastActiveAt
          ? 1
          : a.s.lastActiveAt > b.s.lastActiveAt
            ? -1
            : 0,
    )
    .slice(0, LIMIT)
    .map((x) => x.s);
}

/**
 * 给"在这一句发送之前"一个建议。
 *
 * single 模式直接返回 continue：网页端本来就能手动切会话，不需要额外提示。
 */
export async function suggestForSession(
  rec: WakerRecord,
  sessionId: string,
  message: string,
): Promise<TopicSuggestion> {
  // 必须确认这个会话真的存在。resolveSession 找不到时会回落到默认会话，
  // 那样算出来的"当前话题"是默认会话的，建议会指向错误方向（实测踩到过）。
  const exists = listSessions(rec.def.id).some((s) => s.id === sessionId);
  if (!exists) {
    return {
      action: 'continue',
      confidence: 0,
      reason: `会话 ${sessionId} 不存在，跳过建议`,
      regime: 'lexical',
      current: { id: sessionId, title: sessionId },
    };
  }

  const current = resolveSession(rec.def.id, sessionId);
  const cfg = rec.def.session;
  const base: TopicSuggestion = {
    action: 'continue',
    confidence: 0,
    reason: '未启用话题切换',
    regime: 'lexical',
    current: { id: current.id, title: titleOf(current.id, displayNameOf(current)) },
  };
  if (!cfg || cfg.mode === 'single') return { ...base, reason: '该员工为 single 模式（一个渠道一个会话）' };

  const others = listSessions(rec.def.id).filter((s) => s.id !== current.id);

  let decision;
  /** 语义没拿到（服务挂了 / 超时）→ 记进流水，否则调阈值的人会拿词面分数解释语义配置。 */
  let semanticUnavailable = false;
  // 语义结果要跨出 else 块：仲裁挑候选时也要按"像不像"排序
  let semantic: Awaited<ReturnType<typeof semanticInputFor>> = null;
  if (cfg.mode === 'timeWindow') {
    decision = decideTimeWindow({
      now: Date.now(),
      lastActiveAt: current.lastActiveAt,
      idleSplitHours: cfg.idleSplitHours,
    });
  } else {
    semantic =
      cfg.semantic.enabled === 'auto'
        ? await semanticInputFor({
            message,
            active: current,
            candidates: others.slice(0, 6),
            cfg: {
              enabled: true,
              baseUrl: cfg.semantic.baseUrl,
              model: cfg.semantic.model,
              // 网页端不能按飞书那套 6s 来等：那是异步链路，这边是"发送前同步"
              timeoutMs: Math.min(cfg.semantic.timeoutMs, WEB_SEMANTIC_BUDGET_MS),
            },
            continueThreshold: cfg.semantic.continueThreshold,
            switchThreshold: cfg.semantic.switchThreshold,
            unrelatedThreshold: cfg.semantic.unrelatedThreshold,
          })
        : null;
    semanticUnavailable = cfg.semantic.enabled === 'auto' && !semantic;
    decision = decideRoute({
      message,
      now: Date.now(),
      active: toRouteSession(current),
      candidates: others.map(toRouteSession),
      config: { idleSplitHours: cfg.idleSplitHours },
      semantic: semantic ?? undefined,
    });
  }

  // 小模型仲裁：与飞书同一条链路（决策模型走 /v1/systemone，约 200ms）。
  // 向量只能给"像不像"，"这句到底是在接旧话题还是新开一段"要靠它。
  const arbiterCfg = {
    ...DEFAULT_ARBITER_CONFIG,
    ...(cfg.arbiter ?? {}),
    timeoutMs: Math.min((cfg.arbiter ?? DEFAULT_ARBITER_CONFIG).timeoutMs ?? DEFAULT_ARBITER_CONFIG.timeoutMs, WEB_ARBITER_BUDGET_MS),
  };
  let arbiterInfo: ArbiterResult | null = null;
  let arbCandidateIds: string[] = [];
  if (cfg.mode !== 'timeWindow' && arbiterCfg.enabled) {
    const recent = readSessionMessages(rec.def.id, current.id, 6)
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .slice(-2)
      .map((m) => ({ role: m.role as 'user' | 'assistant', text: m.text }));
    // 决策模型的输入预算只够 3 个候选（每个还要带一段摘要），所以**先排序再喂**：
    // 有向量就按"像不像"排，没有就按最近活跃排——随便截前 3 个等于让模型看不到对的那个。
    const arbCandidates = rankCandidates(message, others, semantic);
    arbCandidateIds = arbCandidates.map((s) => s.id);
    const pair = arbitratePair({ message, active: current, candidates: arbCandidates, recent }, arbiterCfg);
    const arb = await pair.main;
    if (arb) {
      arbiterInfo = arb;
      decision = decisionFromArbiter(arb, decision, current.id);
    }
    // 影子只落日志，不 await：网页是"发送前同步等"，多 1ms 都是卡顿
    const mainAnswer = arb ? { action: arb.action, target: arb.targetSessionId } : null;
    void pair.shadow.then((shadow) => {
      if (!shadow) return;
      logShadowSuggestion({ wakerId: rec.def.id, sessionId: current.id, message, mainAnswer, mainModel: arbiterCfg.model, shadow });
    });
  }

  const signals = decision.signals;
  const best = signals.semanticBest ?? signals.overlapBest;
  const activeSim = signals.semanticActive ?? signals.overlapActive;

  // 仲裁判"新话题"时，再加一道向量闸门：向量认为"明显还在当前话题"就不弹。
  // 网页建议条是**主动打断**，误弹一次就是一次打扰；IM 那边有询问配额与拒绝计数兜。
  const vectorSaysContinue =
    signals.regime === 'semantic'
      ? (signals.semanticActive ?? 0) >= cfg.semantic.continueThreshold
      : (signals.overlapActive ?? 0) >= DEFAULT_ROUTE_CONFIG.continueThreshold;
  if (decision.action === 'new' && vectorSaysContinue) {
    decision = {
      ...decision,
      action: 'continue' as const,
      reason: `仲裁判新话题，但向量仍在当前话题（${activeSim.toFixed(2)}），不打扰`,
    };
  }
  const switchLine =
    (signals.regime === 'semantic' ? cfg.semantic.switchThreshold : DEFAULT_ROUTE_CONFIG.switchThreshold) -
    WEB_SUGGEST_MARGIN;

  // 建议线：判定说"继续"，但某个旧话题已经明显更近（压建议线且高出当前 0.08）→ 抬成建议。
  // 只影响**弹出哪条建议**，不改任何会话状态：接受才动 active 指针。
  const promoted =
    decision.action === 'continue' && !!signals.bestSessionId && best >= switchLine && best >= activeSim + 0.08;
  const action: RouteAction = decision.action === 'switch' || promoted ? 'switch' : decision.action;
  const targetId = decision.targetSessionId ?? (promoted ? signals.bestSessionId : undefined);

  const suggestion: TopicSuggestion = {
    action,
    confidence: promoted ? Math.max(decision.confidence, 0.5) : decision.confidence,
    reason: promoted
      ? `建议线命中（${best.toFixed(2)} ≥ ${switchLine.toFixed(2)}，当前 ${activeSim.toFixed(2)}）`
      : decision.reason,
    regime: signals.regime,
    current: base.current,
  };

  if (action === 'switch' && targetId) {
    const target = others.find((s) => s.id === targetId);
    if (target) {
      suggestion.target = {
        id: target.id,
        // 必须与会话列表同一个取值（title || name）：两处名字不一致时，
        // 界面会一边显示「树莓派AI问答机落地」、一边显示「另外一件事儿，我要用树莓派3b…」，
        // 用户根本不知道自己切到了哪（实测踩到）。
        title: target.title || target.name,
        recap: recapText(rec.def.id, target.id),
        similarity: best,
      };
    } else {
      // 目标取不到就别硬给建议，否则会弹出"切到一个不存在的会话"
      suggestion.action = 'continue';
      suggestion.confidence = decision.confidence;
    }
  }

  logSuggestion({
    wakerId: rec.def.id,
    sessionId: current.id,
    suggestion,
    arbiter: arbiterInfo,
    semanticUnavailable,
    candidates: arbCandidateIds,
  });
  return suggestion;
}
