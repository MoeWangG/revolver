/**
 * 话题仲裁：把「继续 / 新话题 / 切回哪个」交给本地小模型判。
 *
 * 为什么要有这一层（2026-10-25）：
 *   向量只能给出"像不像"的分数。实测 50 条路由里 46% 落在 0.42~0.58 的模糊带，
 *   而模糊带的置信度封顶 0.45 < 调用方的 0.5 门槛——于是这些消息既不切也不问，
 *   静默留在原会话。最典型的一条是用户只发了「新话题」三个字：
 *   它和 42 条的创业会话余弦 0.55（语义上没错，两段都在谈"聊天"），
 *   但它是**指令**，不是**内容**，向量空间里没有这个维度。
 *
 * 分工：
 *   - 向量（semanticRoute）：从 N 个会话里召回 3~5 个"像的"——token 随会话数线性涨，必须预筛；
 *   - 小模型（本文件）：在这几个候选里做决定，读得懂指代与意图；
 *   - 询问卡（channels/feishu）：用户点确认才落指针，所以判错的代价只是"多问一句"。
 *
 * 降级：关掉配置、服务没起、超时、输出解析不了 —— 一律返回 null，
 * 调用方退回原来的阈值判定。**仲裁是增强，不是依赖。**
 */
import type { SessionMeta } from './sessions.ts';
import { sessionChunks } from './semanticRoute.ts';
import { displayNameOf } from './sessionName.ts';
import type { ArbiterConfig } from '../types.ts';
import type { RouteDecision } from './topicRouter.ts';

export interface ArbiterTurn {
  role: 'user' | 'assistant';
  text: string;
}

export interface ArbiterInput {
  message: string;
  active: SessionMeta;
  /** 已由向量召回的候选，顺序即 prompt 里的编号。 */
  candidates: SessionMeta[];
  /** 最近两轮完整问答：指代（「按第二方案来」）必须看到助手上一句才判得动。 */
  recent: ArbiterTurn[];
}

export interface ArbiterResult {
  action: 'continue' | 'new' | 'switch';
  targetSessionId?: string;
  /** 模型原始输出，写进 routing.jsonl 供归因。 */
  raw: string;
  ms: number;
  model: string;
}

/** 最多编号几个候选：再多就是让模型做无意义的排除。 */
const MAX_CANDIDATES = 5;
const MAX_CARD = 200;
const MAX_TURN = 160;

/**
 * 显式换话题的说法。命中就不调模型——确定性优先，也省掉 1s。
 * 注意只匹配**句首**：句中出现「新话题」多半是在讨论这个词本身。
 */
const NEW_TOPIC_RE = /^(新话题|换个?话题|说点别的|另一个话题)\s*([：:，,]?\s*)/;

/** 紧跟在指令后面、说明"这句是在问这个词"的字眼。 */
const META_QUESTION_RE = /^(这|那|是|的|功能|怎么|为什么|什么|啥|咋)/;

/** 命中显式指令时返回标题（可能为空）。null = 没命中。 */
export function matchExplicitNewTopic(text: string): { title?: string } | null {
  const t = String(text ?? '').trim();
  const m = t.match(NEW_TOPIC_RE);
  if (!m) return null;
  const sep = (m[2] ?? '').trim();
  const rest = t.slice(m[0].length).trim();
  // 没有分隔符、后面紧跟「这/那/功能/怎么」→ 在问「新话题」这个词本身，不是要求换话题。
  // 例：「新话题这个功能怎么用」必须留在当前会话，否则每聊一次功能就开一个新弹巢。
  if (!sep && META_QUESTION_RE.test(rest)) return null;
  return { title: rest || undefined };
}

/** 候选的一句话介绍：会话卡 > 标题+条数。 */
function brief(s: SessionMeta): string {
  const card = (s.cardSummary ?? '').trim().slice(0, MAX_CARD);
  const title = displayNameOf(s);
  return card ? `《${title}》${card}` : `《${title}》（${s.messageCount} 条）`;
}

/**
 * 判定所需的现场描述：当前会话 / 在聊什么 / 最近两轮 / 候选列表。
 *
 * systemone（决策模型）与 chat（对话模型）两条接口共用这一段，
 * 避免"改了 prompt 却只改一边"导致同一条消息两种判定。
 */
function describeState(
  input: ArbiterInput,
  picked: SessionMeta[],
): { about: string; turns: string; list: string } {
  // "这段在聊什么"优先用会话卡；没有卡片才去读语义块（标题 + 抽样消息）。
  // 顺序不能反：sessionChunks 会读 jsonl，而卡片是现成的，能省一次文件 IO。
  const card = (input.active.cardSummary ?? '').trim().slice(0, MAX_CARD);
  const about =
    card ||
    sessionChunks(input.active)
      .filter((c) => c !== displayNameOf(input.active))
      .slice(0, 3)
      .map((c) => c.replace(/\s+/g, ' ').slice(0, 120))
      .join(' / ') ||
    '（暂无摘要）';

  const turns = input.recent
    .slice(-4)
    .map((t) => `${t.role === 'user' ? '用户' : '助手'}：${t.text.replace(/\s+/g, ' ').slice(0, MAX_TURN)}`)
    .join('\n');

  const list = picked.map((s, i) => `${i + 1}. ${brief(s)}`).join('\n') || '（无）';
  return { about, turns, list };
}

/** 构造 chat 接口的 prompt。纯函数，测试直接断言。 */
export function buildArbiterPrompt(input: ArbiterInput): { system: string; user: string } {
  const { message, active, candidates } = input;
  const picked = candidates.slice(0, MAX_CANDIDATES);
  const { about, turns, list } = describeState(input, picked);

  const system = [
    `当前会话：《${displayNameOf(active)}》`,
    `这段在聊：${about}`,
    turns ? `最近两轮：\n${turns}` : '',
    `可能相关的旧话题：\n${list}`,
    '',
    '判断规则：',
    '- 延续当前话题（追问细节、补充条件、回答刚才的问题）→ CONTINUE',
    '- 明显是在说上面某个旧话题 → SWITCH 编号',
    '- 与当前话题、旧话题都无关 → NEW',
    '- 只是提到「新话题」三个字、但不是在要求换话题 → CONTINUE',
    '',
    '示例：',
    '「新话题」→ NEW',
    '「换个话题，帮我看看 K8s」→ NEW',
    '「重量多少来着」→ CONTINUE',
    '「换个思路，ESP32 保留但摄像头换成 ToF」→ CONTINUE',
    '「你上次说的那个『新话题』功能是什么」→ CONTINUE',
    '（旧话题 1 是「日本行程」时）「上次说的那趟日本行」→ SWITCH 1',
    '',
    '只输出一个词：CONTINUE 或 NEW 或 SWITCH 编号。不要解释。',
  ]
    .filter((l) => l !== '')
    .join('\n');

  return { system, user: `用户新消息：「${message.trim().slice(0, 400)}」` };
}

/**
 * 决策模型的提问口径（`/v1/systemone` 的 `criteria`）。
 *
 * 与 chat 版 prompt 说的其实是同一件事，只是**不再要求它"输出一个词"**——
 * laya 这类 ModernBERT 决策模型没有生成能力，只能对给定的选项给概率。
 */
export const SYSTEM_ONE_ACTION_CRITERIA: Record<string, string> = {
  continue: '沿用当前会话：追问、补充条件、回答刚才的问题；或只是在谈论「新话题」这个词',
  new: '与当前、旧话题都无关，是新话题',
  switch: '是在接着上面某个旧话题说',
};

/**
 * 决策模型的**输入预算**：≤ 512 token（llama.cpp 的单批上限）。
 *
 * 为什么这么紧（2026-11-05 实测）：laya 这类双向编码器不能像对话模型那样分批喂 context，
 * **整段输入必须在一个物理 batch 里**。实测 state 342 字 = 565 token 直接被拒
 * （`input is too large to process. increase the physical batch size (current batch size: 512)`）；
 * 136 字正常返回。所以这里按字符硬裁，宁少给信息，也不能整条判定失效。
 */
const MAX_STATE_CHARS = 220;
const MAX_MSG_CHARS = 70;
const MAX_TITLE_CHARS = 14;

/** 候选摘要的截断长度：标题单独不够用（「AI产品四问清单与飞书授权」看不出是不是在聊树莓派）。 */
const MAX_CAND_BRIEF = 12;

/** 候选的一行说明：标题 + 摘要前若干字。没有摘要就只给标题。 */
function candLine(s: SessionMeta, i: number): string {
  const title = displayNameOf(s).slice(0, MAX_TITLE_CHARS);
  const card = (s.cardSummary ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_CAND_BRIEF);
  return `c${i + 1}《${title}》${card}`;
}

/**
 * systemone 的 `state`：当前话题 + 这句 + 旧话题（标题 **+ 一段摘要**）。
 *
 * 为什么必须带摘要：只给标题时，「切回树莓派那个项目」面对标题《AI产品四问清单与飞书授权》
 * 会被判成 NEW（实测）。而摘要能把"这段到底在聊什么"补上——这也是预算里最值钱的 12 个字。
 */
export function buildSystemOneState(input: ArbiterInput, picked: SessionMeta[]): string {
  const head =
    `当前会话：《${displayNameOf(input.active).slice(0, MAX_TITLE_CHARS)}》\n` +
    `这句：${input.message.trim().replace(/\s+/g, ' ').slice(0, MAX_MSG_CHARS)}`;
  const lined = (n: number): string => `旧话题：${picked.slice(0, n).map(candLine).join(' ')}`;
  // 装不下就先砍候选：候选全砍掉就只剩"继续/新话题"两档，仍比没有判定好
  for (let n = picked.length; n > 0; n -= 1) {
    const state = `${head}\n${lined(n)}`;
    if (state.length <= MAX_STATE_CHARS) return state;
  }
  return head.slice(0, MAX_STATE_CHARS);
}

/**
 * 构造 `/v1/systemone` 请求体（决策模型专用）。
 *
 * 两个问题一次问完，避免"先判是否继续、再判切哪"的两轮往返：
 *  - `action`：continue / new / switch；
 *  - `target`：若在接旧话题，最像哪个候选（`none` = 不是接旧话题）。
 * 候选用 `c1..c5` 作键，回包按编号映射回会话 id —— 直接把 32 位 hash 当选项名会让模型难以区分。
 */
export function buildSystemOneRequest(input: ArbiterInput, model: string): Record<string, unknown> {
  const picked = input.candidates.slice(0, MAX_CANDIDATES);
  // **一次分类，而不是"先问 action 再问 target"**：
  // 拆两个问题时分类器会给出互相矛盾的答案（实测：action=continue 而 target=c1），
  // 而这两者本来就该是同一个判断——"这句话属于哪个话题"。
  const criteria: Record<string, string> = {
    current: `延续当前会话《${displayNameOf(input.active).slice(0, MAX_TITLE_CHARS)}》`,
  };
  picked.forEach((s, i) => {
    criteria[`c${i + 1}`] = candLine(s, i).replace(/^c\d+/, '');
  });
  criteria.next = '不是上面任何一个，是一件新的事';
  return {
    model,
    // **必须确定性**：不带 temperature 时同一条消息会摇摆（实测同一句一次判 switch、一次判 new），
    // 于是"点了建议却没切"看起来像 bug。分类任务不需要采样。
    temperature: 0,
    state: buildSystemOneState(input, picked),
    questions: {
      where: {
        type: 'choice',
        instructions: '这句话属于哪个话题？',
        criteria,
      },
    },
  };
}

/** `/v1/systemone` 的回包：每个问题给一个 choice 与全部选项的概率。 */
export interface SystemOneResponse {
  answers?: Record<
    string,
    { type?: string; choice?: string; probabilities?: Record<string, number>; confidence?: number }
  >;
}

/**
 * 把 systemone 的答案翻成仲裁结果。纯函数，测试直接断言。
 *
 * 两条保守规则：
 *  - 说要 switch 却没给有效候选（选了 none / 编号越界）→ 按 continue。
 *    "误切"和"误开新会话"都比"少切一次"更伤，这条与 decideRoute 的优先级一致；
 *  - 没有 `action` 答案 → null，交回调用方退回阈值判定。
 */
export function parseSystemOneAnswers(
  raw: unknown,
  candidates: SessionMeta[],
): { action: 'continue' | 'new' | 'switch'; targetSessionId?: string } | null {
  const answers = (raw as SystemOneResponse | null)?.answers;
  if (!answers) return null;
  const picked = candidates.slice(0, MAX_CANDIDATES);

  // 新格式：单个 `where` 分类（current / c1..cN / next）
  const where = answers.where?.choice;
  if (where) {
    if (where === 'current') return { action: 'continue' };
    if (where === 'next') return { action: 'new' };
    const m = /^c(\d+)$/.exec(String(where));
    const idx = m ? Number(m[1]) - 1 : -1;
    return idx >= 0 && idx < picked.length ? { action: 'switch', targetSessionId: picked[idx]!.id } : null;
  }

  // 旧格式（action + target）：留着兼容，便于灰度与回放旧数据
  const choice = answers.action?.choice;
  if (choice !== 'continue' && choice !== 'new' && choice !== 'switch') return null;
  if (choice !== 'switch') return { action: choice };
  const m = /^c(\d+)$/.exec(String(answers.target?.choice ?? ''));
  const idx = m ? Number(m[1]) - 1 : -1;
  if (idx >= 0 && idx < picked.length) return { action: 'switch', targetSessionId: picked[idx]!.id };
  return { action: 'continue' };
}

/**
 * 解析模型输出。
 *
 * 取**最后一个**关键词匹配：thinking 模型常先复述规则再给结论，
 * 取第一个会把示例里的答案当成结果。编号越界视为瞎编 → 退回 CONTINUE
 * （误开新会话比误继续更伤用户，这条与 decideRoute 的优先级一致）。
 */
export function parseArbiterOutput(
  raw: string,
  candidates: SessionMeta[],
): { action: 'continue' | 'new' | 'switch'; targetSessionId?: string } | null {
  const hits = [...String(raw ?? '').matchAll(/(CONTINUE|NEW|SWITCH)\s*#?\s*(\d+)?/gi)];
  if (!hits.length) return null;
  const last = hits[hits.length - 1]!;
  const word = last[1]!.toUpperCase();
  if (word === 'NEW') return { action: 'new' };
  if (word === 'CONTINUE') return { action: 'continue' };
  const n = Number(last[2] ?? '');
  const target =
    Number.isFinite(n) && n >= 1 && n <= Math.min(candidates.length, MAX_CANDIDATES)
      ? candidates[n - 1]
      : undefined;
  return target ? { action: 'switch', targetSessionId: target.id } : { action: 'continue' };
}

/** systemone 不可用时只提示一次：配的是对话模型时，每条消息刷一行日志会淹没真正的问题。 */
let warnedSystemOne = false;

const baseUrlOf = (cfg: ArbiterConfig): string => cfg.baseUrl.replace(/\/+$/, '');

/** POST 一次并解析 JSON；非 2xx / 超时 / 网络错误统一返回 null（不抛）。 */
async function postJson(url: string, body: unknown, timeoutMs: number): Promise<unknown | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(500, timeoutMs));
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ctrl.signal,
      body: JSON.stringify(body),
    });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 决策模型接口：`POST /v1/systemone`。
 *
 * laya（ModernBERT，`type: decision`）只走这条——它对 `/v1/chat/completions` 一律回
 * `No models loaded`（那句话的意思是"没有 llm/vlm 实例"，不是没加载）。
 * 回包是**概率**，不是文本，所以解析也完全不同（见 parseSystemOneAnswers）。
 */
async function callSystemOne(
  input: ArbiterInput,
  cfg: ArbiterConfig,
  picked: SessionMeta[],
): Promise<ArbiterResult | null> {
  const t0 = Date.now();
  const data = await postJson(`${baseUrlOf(cfg)}/systemone`, buildSystemOneRequest(input, cfg.model), cfg.timeoutMs);
  const parsed = data ? parseSystemOneAnswers(data, picked) : null;
  if (!parsed) {
    if (!warnedSystemOne) {
      warnedSystemOne = true;
      console.warn(
        `[arbiter] ${cfg.model} 的 /v1/systemone 不可用（模型不是 decision 类型？），` +
          `本轮起退回 chat 接口；后续不再重复提示`,
      );
    }
    return null;
  }
  return { ...parsed, raw: JSON.stringify((data as SystemOneResponse).answers).slice(0, 400), ms: Date.now() - t0, model: cfg.model };
}

/** 对话模型接口：`POST /v1/chat/completions`，要求它输出 CONTINUE / NEW / SWITCH n。 */
async function callChat(
  input: ArbiterInput,
  cfg: ArbiterConfig,
  picked: SessionMeta[],
): Promise<ArbiterResult | null> {
  const { system, user } = buildArbiterPrompt({ ...input, candidates: picked });
  const t0 = Date.now();
  const data = await postJson(
    `${baseUrlOf(cfg)}/chat/completions`,
    {
      model: cfg.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0,
      // 只要一个词，但 thinking 模型会先写思考，给一点余量
      max_tokens: 32,
    },
    cfg.timeoutMs,
  );
  if (!data) {
    console.warn(`[arbiter] ${cfg.model} 的 /v1/chat/completions 不可用，本轮退回阈值判定`);
    return null;
  }
  const msg = (data as { choices?: Array<{ message?: { content?: string; reasoning_content?: string } }> }).choices?.[0]
    ?.message;
  const raw = (msg?.content?.trim() || msg?.reasoning_content?.trim() || '').trim();
  const parsed = parseArbiterOutput(raw, picked);
  if (!parsed) {
    // 解析不了就退回阈值判定。留原文是因为小模型偶尔会答成一句话，
    // 没有原文时只能猜"是超时还是答歪了"，实测排查全靠这条日志。
    console.warn(`[arbiter] ${cfg.model} 输出无法解析（${Date.now() - t0}ms）：${raw.slice(0, 120)}`);
    return null;
  }
  return { ...parsed, raw, ms: Date.now() - t0, model: cfg.model };
}

/**
 * 调模型判一次。任何异常 / 超时 / 解析失败都返回 null —— 调用方据此退回阈值判定，
 * **绝不让一个不稳定的组件挡在用户等待的路径上**。
 *
 * 接口按 `cfg.api` 选：decision 模型（laya）走 `/v1/systemone`，对话模型走
 * `/v1/chat/completions`；`auto` 先试前者、不通再试后者。
 */
export async function arbitrate(input: ArbiterInput, cfg: ArbiterConfig): Promise<ArbiterResult | null> {
  if (!cfg.enabled) return null;
  // 极短消息（1~2 字）不送模型：信息量不足以判断，而误开新会话的代价更高。
  // 实测踩过：用户回「b」（上一轮的选项）被判成 NEW，白开一个弹巢。
  // 这一条也顺带省掉每天几十次无意义的推理。
  if (input.message.trim().length <= 2) {
    return { action: 'continue', raw: '(too-short)', ms: 0, model: cfg.model };
  }
  const picked = input.candidates.slice(0, MAX_CANDIDATES);
  const api = cfg.api ?? 'auto';

  if (api !== 'chat') {
    const viaSystemOne = await callSystemOne(input, cfg, picked);
    if (viaSystemOne) return viaSystemOne;
    if (api === 'systemone') return null;
  }
  return callChat(input, cfg, picked);
}

/**
 * 主 + 影子：主模型的结果给调用方用，影子模型**在主模型之后**再跑、只落日志。
 *
 * 为什么是"之后"而不是"并行"（2026-11-11 实测）：
 *   LM Studio 是单进程推理服务，26B 主模型和 laya 同时打进去会互相排队——
 *   并行那一版实测主模型三次里有两次被拖到 **6005ms 超时**（无影子时是 274ms）。
 *   Promise 层并行救不了资源竞争，只有真正串行才不会让用户多等。
 *
 * 调用方式：`await pair.main` 拿结果；`void pair.shadow.then(...)` 记日志。
 * shadow 这个 Promise 在 main 结束后才会发起请求，所以永不拖慢主链路。
 */
export function arbitratePair(
  input: ArbiterInput,
  mainCfg: ArbiterConfig,
): { main: Promise<ArbiterResult | null>; shadow: Promise<ArbiterResult | null> } {
  const main = arbitrate(input, mainCfg);
  const s = mainCfg.shadow;
  const shadow = main.then((mainRes) => {
    if (!s?.enabled) return null;
    // 主模型超时/不可用时也照跑：那正是最需要对照数据的时刻
    void mainRes;
    return arbitrate(input, {
      enabled: true,
      baseUrl: s.baseUrl,
      model: s.model,
      timeoutMs: s.timeoutMs,
      api: s.api,
    }).catch(() => null);
  });
  return { main, shadow };
}

/**
 * 把仲裁结果翻成路由决策。
 *
 * 置信度统一压在 0.75：够过调用方 0.5 的"敢动用户会话"门槛，
 * 又不假装比模型本身更有把握。合并方式用 `ask: always` 询问卡兜底，
 * 所以这里**故意不设 0.95**——那是"我很确定"的意思，没人能给。
 */
export function decisionFromArbiter(
  r: ArbiterResult,
  base: RouteDecision,
  activeSessionId: string,
): RouteDecision {
  const tag = `仲裁(${r.model} ${r.ms}ms)`;
  if (r.action === 'continue') {
    return { ...base, action: 'continue', targetSessionId: undefined, confidence: 0.9, reason: `${tag}：继续` };
  }
  // 目标就是当前会话：用户本意是"聊这个"，只是措辞看起来像在指旧话题。
  // 必须退化成 continue，不能落进下面的 new 兜底——那会白开一个弹巢，
  // 而这条链路里"误开新会话"是代价最高的错误（见 parseArbiterOutput 的注释）。
  if (r.action === 'switch' && r.targetSessionId === activeSessionId) {
    return {
      ...base,
      action: 'continue',
      targetSessionId: undefined,
      confidence: 0.75,
      reason: `${tag}：目标即当前话题，按继续`,
    };
  }
  if (r.action === 'switch' && r.targetSessionId) {
    return {
      ...base,
      action: 'switch',
      targetSessionId: r.targetSessionId,
      confidence: 0.75,
      reason: `${tag}：切回旧话题`,
    };
  }
  return { ...base, action: 'new', targetSessionId: undefined, confidence: 0.75, reason: `${tag}：新话题` };
}
