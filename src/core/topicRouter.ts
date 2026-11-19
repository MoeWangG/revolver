/**
 * 话题判定：这一句话该装进当前弹巢，还是换一个。
 *
 * 设计取向（与 CONCEPT 一致）：
 *   1. **只做判定，不做副作用**——不读文件、不写会话、不调模型，纯函数，可单测；
 *   2. **默认继续（fail-open）**：信号不够强就留在当前会话，静默比误切便宜；
 *   3. **可解释**：每个决定都带 signals 与 reason，用户问"为什么切了"要答得出。
 *
 * 为什么不在这里用 embedding：
 *   向量检索是"找到旧话题"的手段，需要外部服务；判定必须能在服务挂掉时继续工作。
 *   所以这一层只用**零成本信号**：时间间隔 + 词面重合。向量召回以后作为加分项接进来。
 */

export type RouteAction = 'continue' | 'switch' | 'new';

export interface RouteConfig {
  /** 超过这么多小时没动过，才考虑"这是新话题"。0 = 关闭时间信号。 */
  idleSplitHours: number;
  /** 与当前会话的重合度达到它，直接判定为继续。 */
  continueThreshold: number;
  /** 命中某个旧会话的最低重合度。 */
  switchThreshold: number;
  /** 低于它才算"与当前话题完全无关"。 */
  unrelatedThreshold: number;
}

export const DEFAULT_ROUTE_CONFIG: RouteConfig = {
  idleSplitHours: 8,
  continueThreshold: 0.12,
  switchThreshold: 0.22,
  unrelatedThreshold: 0.04,
};

/** 参与比较的一个会话。sample 是该会话的少量代表性文本（标题 + 最近几句话）。 */
export interface RouteSession {
  sessionId: string;
  title?: string;
  lastActiveAt: string;
  sample: string[];
}

export interface RouteInput {
  message: string;
  /** 当前时间（毫秒），显式传入以便测试。 */
  now: number;
  active: RouteSession;
  /** 同一渠道下的其他历史会话，用于判断"是不是该切回去"。 */
  candidates: RouteSession[];
  config?: Partial<RouteConfig>;
  /**
   * 语义信号。给了就走语义判定，没给就退回词面判定。
   *
   * 为什么是"可选"：向量服务可能没起、模型可能没加载。判定不能因此失败——
   * 那就变成"记忆服务挂了，切话题功能也跟着挂"，这种耦合必须避免。
   */
  semantic?: SemanticInput;
}

/** 语义判定所需的向量与阈值。阈值与词面阈值是两套刻度，不可混用。 */
export interface SemanticInput {
  message: number[];
  /** 当前会话的多个语义块（标题 / 话题起点 / 最近几条），判定取**最大**相似度。 */
  active: number[][];
  /** 候选会话同样按块给向量；一个会话里混着多个话题时，取最像的那块才准。 */
  candidates: Array<{ sessionId: string; vecs: number[][] }>;
  /** 与当前会话相似到多少算"同一话题"。 */
  continueThreshold: number;
  /** 命中旧话题的相似度下限。 */
  switchThreshold: number;
  /** 低于它才算"与当前话题无关"。 */
  unrelatedThreshold: number;
}

export interface RouteSignals {
  gapHours: number;
  overlapActive: number;
  overlapBest: number;
  bestSessionId?: string;
  /** 本次判定走的是哪套刻度——排查时必须知道，否则会拿词面阈值去解释语义分数。 */
  regime: 'semantic' | 'lexical' | 'timeWindow';
  semanticActive?: number;
  semanticBest?: number;
}

export interface RouteDecision {
  action: RouteAction;
  targetSessionId?: string;
  /** 0~1。低于 0.5 时调用方应当放弃询问，静默继续。 */
  confidence: number;
  signals: RouteSignals;
  reason: string;
}

/**
 * 中文没有空格，按"字二元组"切；英文/数字按词切。
 * 先剔除高频虚词，否则"这个""然后"会把所有句子都算成相关。
 */
const STOP_CHARS = new Set(
  '的了是在我有和就不也都这那你我他她它们个把被让给跟与或而但然后所以因为如果就还再又很太更最一些什么怎么这个那个'.split(''),
);

const ASCII_RE = /[a-z0-9][a-z0-9_+-]*/g;

export function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  const s = String(text ?? '').toLowerCase();

  for (const m of s.matchAll(ASCII_RE)) {
    if (m[0].length >= 2) out.add(m[0]);
  }

  // 只保留汉字，其余字符当分隔符
  const cjk = s.replace(/[^\u4e00-\u9fa5]/g, ' ');
  for (const seg of cjk.split(/\s+/)) {
    if (!seg) continue;
    for (let i = 0; i < seg.length; i += 1) {
      const ch = seg[i]!;
      if (STOP_CHARS.has(ch)) continue;
      if (i + 1 < seg.length) {
        const bi = seg.slice(i, i + 2);
        // 二元组里只要有一个是虚词就丢，避免"的是""然后"这类噪声
        if (!STOP_CHARS.has(bi[1]!)) out.add(bi);
      } else {
        out.add(ch);
      }
    }
  }
  return out;
}

/** Jaccard 重合度：交集 / 并集。对短句偏严格，正是我们要的（宁可少判相关）。 */
export function overlap(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  const union = a.size + b.size - inter;
  return union ? inter / union : 0;
}

function sessionTokens(s: RouteSession): Set<string> {
  return tokenize([s.title ?? '', ...(s.sample ?? [])].join(' '));
}

function hoursBetween(fromIso: string, now: number): number {
  const t = Date.parse(fromIso);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, (now - t) / 3_600_000);
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/**
 * 判定主逻辑。顺序很重要：
 *   先判"继续"，再判"切回旧话题"，最后才判"新话题"。
 *   因为三者的错误代价不对等——误继续只是省不了 token，误开新会话会让用户觉得"它忘了刚才"。
 */
export function decideRoute(input: RouteInput): RouteDecision {
  const cfg: RouteConfig = { ...DEFAULT_ROUTE_CONFIG, ...(input.config ?? {}) };
  // 语义优先；向量不可用时自动落到词面（调用方传 undefined 即表示"不可用"）
  if (input.semantic) return decideSemantic(input, cfg, input.semantic);
  const msgTok = tokenize(input.message);
  const activeTok = sessionTokens(input.active);
  const overlapActive = overlap(msgTok, activeTok);
  const gapHours = hoursBetween(input.active.lastActiveAt, input.now);

  let overlapBest = 0;
  let bestSessionId: string | undefined;
  for (const c of input.candidates) {
    if (c.sessionId === input.active.sessionId) continue;
    const ov = overlap(msgTok, sessionTokens(c));
    if (ov > overlapBest) {
      overlapBest = ov;
      bestSessionId = c.sessionId;
    }
  }

  const signals: RouteSignals = { gapHours, overlapActive, overlapBest, bestSessionId, regime: 'lexical' };

  // 1) 与当前话题有明显关联 —— 继续。这一条要尽量宽，它是"不出错"的兜底。
  if (overlapActive >= cfg.continueThreshold) {
    return {
      action: 'continue',
      confidence: clamp01(0.5 + overlapActive),
      signals,
      reason: `与当前话题重合 ${overlapActive.toFixed(2)} ≥ ${cfg.continueThreshold}`,
    };
  }

  // 2) 明显命中另一个会话，且比当前更相关 —— 切回去。
  if (bestSessionId && overlapBest >= cfg.switchThreshold && overlapBest >= overlapActive + 0.08) {
    return {
      action: 'switch',
      targetSessionId: bestSessionId,
      confidence: clamp01(overlapBest / (cfg.switchThreshold * 1.5)),
      signals,
      reason: `命中旧话题 ${overlapBest.toFixed(2)}，高于当前 ${overlapActive.toFixed(2)}`,
    };
  }

  // 3) 停了够久，且两边都不像 —— 新话题。
  if (cfg.idleSplitHours > 0 && gapHours >= cfg.idleSplitHours && overlapActive < cfg.unrelatedThreshold) {
    const byTime = clamp01(gapHours / (cfg.idleSplitHours * 2));
    const byNovelty = clamp01(1 - overlapActive);
    return {
      action: 'new',
      confidence: clamp01(0.4 * byTime + 0.6 * byNovelty) * (overlapBest > 0 ? 0.8 : 1),
      signals,
      reason: `间隔 ${gapHours.toFixed(1)}h ≥ ${cfg.idleSplitHours}h，且与当前重合仅 ${overlapActive.toFixed(2)}`,
    };
  }

  // 4) 模糊区：倾向继续，但置信度低，调用方可据此决定"要不要问一句"。
  const ambiguousConfidence = clamp01(
    (overlapActive / cfg.continueThreshold) * 0.4 + (bestSessionId ? 0 : 0.2),
  );
  return {
    action: 'continue',
    confidence: Math.min(ambiguousConfidence, 0.45),
    signals,
    reason: `信号不足（当前重合 ${overlapActive.toFixed(2)}、间隔 ${gapHours.toFixed(1)}h），留在当前会话`,
  };
}

/** 「这句几乎逐字命中某条旧话题标题」的相似度下限。 */
export const STRONG_MATCH_SCORE = 0.95;
/** 且必须比当前会话像这么多，才允许绕过仲裁模型。 */
export const STRONG_MATCH_GAP = 0.25;

/**
 * 语义压倒性匹配：这句与某条旧会话几乎逐字相同（≥0.95 且领先当前 ≥0.25）时，
 * 直接给出该切回哪个会话。
 *
 * 为什么要这条"绕过小模型"的路（2026-11-08 实测）：用户只发一个标题/专名
 * （「esp32-cam」）时，决策模型拿到的只是一小段文本，各选项概率近乎均匀
 * （`confidence` 实测 0.056，同一模型还会把「明天天气怎么样」判成切回播客、
 * 把「现在几点了」判成切回父爱 AI 会话）。它对这个输入没有判断力，
 * 而"和某条会话标题几乎逐字相同"是确定性证据，不该被噪声覆盖。
 *
 * 只在语义模式下生效；词面模式没有可比分数，保持原样。
 */
export function strongSemanticPick(signals: RouteSignals): string | undefined {
  if (signals.regime !== 'semantic' || !signals.bestSessionId) return undefined;
  const best = signals.semanticBest ?? 0;
  const active = signals.semanticActive ?? 0;
  return best >= STRONG_MATCH_SCORE && best - active >= STRONG_MATCH_GAP
    ? signals.bestSessionId
    : undefined;
}

/** 余弦相似度。-1~1；长度不一致视为不可比，返回 0。 */
export function cosine(a: number[], b: number[]): number {
  if (!a?.length || !b?.length || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d ? dot / d : 0;
}

/**
 * 语义判定。与词面版的**顺序完全一致**（先继续、再切回、最后新话题），
 * 只有刻度和理由不同——这样"为什么切了"在两种模式下都能用同一套话解释。
 */
function decideSemantic(input: RouteInput, cfg: RouteConfig, sem: SemanticInput): RouteDecision {
  /** 块间取最大：一个会话里混着多个话题时，平均会稀释信号。 */
  const maxCos = (v: number[], chunks: number[][]): number =>
    chunks.reduce((m, x) => Math.max(m, cosine(v, x)), 0);

  const sActive = maxCos(sem.message, sem.active);
  let sBest = 0;
  let bestId: string | undefined;
  for (const c of sem.candidates) {
    const s = maxCos(sem.message, c.vecs);
    if (s > sBest) {
      sBest = s;
      bestId = c.sessionId;
    }
  }

  const gapHours = hoursBetween(input.active.lastActiveAt, input.now);
  const signals: RouteSignals = {
    gapHours,
    overlapActive: 0,
    overlapBest: 0,
    bestSessionId: bestId,
    regime: 'semantic',
    semanticActive: sActive,
    semanticBest: sBest,
  };

  // 置信度映射：刚好压线 → 0.55（够格进入"询问"），接近 1 → 接近 1。
  // 起点定在 0.55 而不是 0.4：调用方以 0.5 为"敢不敢动用户会话"的门槛，
  // 若起点 0.4，阈值附近的正确判断会被当成低置信丢弃（实测踩到过）。
  const confOf = (s: number, thr: number): number =>
    clamp01(0.55 + ((s - thr) / Math.max(1e-6, 1 - thr)) * 0.45);

  // 1) 与当前话题语义接近 —— 继续
  if (sActive >= sem.continueThreshold) {
    return {
      action: 'continue',
      confidence: confOf(sActive, sem.continueThreshold),
      signals,
      reason: `语义相似 ${sActive.toFixed(2)} ≥ ${sem.continueThreshold}`,
    };
  }

  // 2) 明显更像另一个会话 —— 切回
  if (bestId && sBest >= sem.switchThreshold && sBest >= sActive + 0.08) {
    return {
      action: 'switch',
      targetSessionId: bestId,
      confidence: confOf(sBest, sem.switchThreshold),
      signals,
      reason: `旧话题语义相似 ${sBest.toFixed(2)}，高于当前 ${sActive.toFixed(2)}`,
    };
  }

  // 3) 停了够久且两边都不像 —— 新话题
  if (cfg.idleSplitHours > 0 && gapHours >= cfg.idleSplitHours && sActive < sem.unrelatedThreshold) {
    const byTime = clamp01(gapHours / (cfg.idleSplitHours * 2));
    const byNovelty = clamp01(1 - sActive);
    // 若某个旧话题虽然没到切换线但明显高于"无关"，说明可能是旧话题换了说法，压一下置信度
    const damp = sBest > 0.4 ? 0.8 : 1;
    return {
      action: 'new',
      confidence: clamp01(0.4 * byTime + 0.6 * byNovelty) * damp,
      signals,
      reason: `间隔 ${gapHours.toFixed(1)}h ≥ ${cfg.idleSplitHours}h，且与当前语义相似仅 ${sActive.toFixed(2)}`,
    };
  }

  // 4) 模糊区：留在当前，置信度压低（低于 0.5 调用方就不该拿它去问用户）
  return {
    action: 'continue',
    confidence: Math.min(clamp01((sActive / Math.max(sem.continueThreshold, 0.01)) * 0.4), 0.45),
    signals,
    reason: `语义信号不足（当前 ${sActive.toFixed(2)}、间隔 ${gapHours.toFixed(1)}h），留在当前会话`,
  };
}

/**
 * 时间窗模式：只看"隔了多久"，不看话题也不用问。
 *
 * 与 topic 模式的本质区别是它**刻意不做内容判断**——这条模式的价值就是可预测
 * （到点必换）。掺进语义判断反而会让"我明明隔了一夜却没换"变得无法解释。
 */
export function decideTimeWindow(args: {
  now: number;
  lastActiveAt: string;
  idleSplitHours: number;
}): RouteDecision {
  const gapHours = hoursBetween(args.lastActiveAt, args.now);
  const signals: RouteSignals = {
    gapHours,
    overlapActive: 0,
    overlapBest: 0,
    regime: 'timeWindow',
  };

  if (args.idleSplitHours > 0 && gapHours >= args.idleSplitHours) {
    return {
      action: 'new',
      confidence: 0.95,
      signals,
      reason: `间隔 ${gapHours.toFixed(1)}h ≥ ${args.idleSplitHours}h（时间窗到点即换）`,
    };
  }
  return {
    action: 'continue',
    confidence: 0.95,
    signals,
    reason: `间隔 ${gapHours.toFixed(1)}h < ${args.idleSplitHours}h，沿用当前会话`,
  };
}

/**
 * 询问门：这一轮判定（NEW / SWITCH）能不能落指针。
 *
 * 三种回答：
 *   ask  = 先问用户（发卡片）
 *   auto = 不问，直接切并告知（只有 `ask: never` 且允许自动切时）
 *   stay = 不问也不切，留在当前会话作答
 *
 * 顺序是刻意的：`autoSwitch: false` 放在最前面，因为它是**不许自动切**的硬约束。
 * 若先判 `ask: never` 或 `rejectStreak`，两个配置打架时"不许自动切"就会被悄悄忽略——
 * 正是这次要修的问题：拒绝配额用尽后反而是不问直接切。
 */
export function decideAskGate(args: {
  ask: 'always' | 'never';
  /** 是否允许不问就切。false = 永远先问。 */
  autoSwitch: boolean;
  rejectStreak: number;
  rejectLimit: number;
}): 'ask' | 'auto' | 'stay' {
  if (!args.autoSwitch) return 'ask';
  if (args.ask === 'never') return 'auto';
  if (args.rejectStreak >= args.rejectLimit) return 'stay';
  return 'ask';
}

/** 从一段文字里抽一个短标题，够用就行，不调模型。 */
export function deriveTitle(message: string, max = 18): string {
  const t = String(message ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#>*`_~\[\]()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return '未命名话题';
  // 取第一个句子，超长再截断
  const first = t.split(/[。！？!?；;\n]/)[0]!.trim() || t;
  return first.length > max ? `${first.slice(0, max)}…` : first;
}
