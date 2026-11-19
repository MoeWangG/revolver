/**
 * 「以某条历史消息为基础」——回复 / 引用。
 *
 * 两种动作的差别是**意图**，格式只差一个标记词：
 * - `回复`：我针对这一段说，请就它作答；
 * - `引用`：把这一段作为背景参考。
 *
 * 为什么拼装放在前端、而且只有这一份实现：
 * 我们讨论过"前端拼给人看、后端拼给模型看"的方案，但那意味着**同一套格式在两处维护**，
 * 迟早漂移（本项目已经吃过一次"估算口径两处不一致"的亏）。现在只有这一个 composer，
 * 拼好的文本直接当 `message` 发给 `/api/talk`，于是：
 *   · 任务流水里记录的就是模型真正收到的（含引用来源，便于回溯）；
 *   · 会话文件里也是它，刷新后重新读出来还能渲染回"引用块"（`parseQuoted` 负责反解）。
 *
 * 格式（改动时 compose/parse 必须同时改）：
 *
 * ```
 * 【回复此条】（你说的）
 * > 引用的第一行
 * > 引用的第二行
 *
 * 我真正要说的话
 * ```
 */
export type QuoteMode = 'reply' | 'quote';

/**
 * 可被引用的消息：只声明需要的字段。
 * （`Msg` 定义在 AgentChatDialog 组件内部，这里不反向依赖组件。）
 */
export interface QuotableMessage {
  role: 'user' | 'agent' | 'system';
  text: string;
  at?: string;
}

/** 被引用的一条消息（只取渲染与提示需要的字段）。 */
export interface QuoteRef {
  text: string;
  /** 引用的是谁说的：自己 or 员工。 */
  from: 'me' | 'agent';
  /** 原消息时间（仅用于展示）。 */
  at?: string;
}

export interface ComposedMessage {
  /** 真正发给模型的文本。 */
  text: string;
  /** 引用块里展示的原文（给人看，不含标记）。 */
  displayQuote: string;
  mode: QuoteMode;
}

const MARK: Record<QuoteMode, string> = { reply: '【回复此条】', quote: '【引用此条】' };
const FROM_LABEL: Record<QuoteRef['from'], string> = { me: '我说的', agent: '你说的' };

/**
 * 引用原文的长度上限。
 * 会话历史本来就在模型的上下文里，这里的引用只是"明确指向哪一条"，
 * 不是把原文再喂一遍——所以截断对模型理解没有损失，却能避免一条引用吃掉几千 token。
 */
const QUOTE_MAX = 1500;

/** 组装成一条带引用的消息。 */
export function composeQuoted(reply: string, quote: QuoteRef, mode: QuoteMode): ComposedMessage {
  const body = quote.text.trim();
  const clipped = body.length > QUOTE_MAX ? `${body.slice(0, QUOTE_MAX)}…（原文更长，此处截断）` : body;
  const quoted = clipped
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
  return {
    text: `${MARK[mode]}（${FROM_LABEL[quote.from]}）\n${quoted}\n\n${reply.trim()}`,
    displayQuote: clipped,
    mode,
  };
}

/** 从一条消息里反解出引用块（历史消息重新载入时用）。 */
export function parseQuoted(text: string): { mode: QuoteMode; from: QuoteRef['from']; quote: string; rest: string } | null {
  const m = /^【(回复此条|引用此条)】（(我说的|你说的)）\n((?:>[^\n]*\n)+)\n?([\s\S]*)$/.exec(text);
  if (!m) return null;
  const quote = (m[3] ?? '')
    .split('\n')
    .filter((l) => l.startsWith('>'))
    .map((l) => l.replace(/^>\s?/, ''))
    .join('\n');
  return {
    // 注意捕获组里**没有书名括号**（`(回复此条|引用此条)`），别拿带括号的字面量比
    mode: m[1] === '回复此条' ? 'reply' : 'quote',
    from: m[2] === '我说的' ? 'me' : 'agent',
    quote,
    rest: (m[4] ?? '').trim(),
  };
}

/** 供「回复 / 引用」按钮取原文。 */
export function quoteSource(m: QuotableMessage): QuoteRef | null {
  const text = (m.text ?? '').trim();
  if (!text) return null;
  return { text, from: m.role === 'user' ? 'me' : 'agent', at: m.at };
}
