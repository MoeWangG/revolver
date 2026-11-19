/**
 * 话题切换的**可点按钮卡片**、点击后的状态卡，以及回调解析。
 *
 * 为什么单独一个文件：卡片 JSON 的结构与"点哪个按钮算什么意思"是一对契约，
 * 放在一起才不会出现"按钮改了 value、解析没改"这种静默错位。
 * 解析函数写成纯函数，可以直接单测——卡片回调在真实环境里很难复现。
 *
 * **文字退路只活在纯文本里**：卡片正文只放问题本身，按钮就是那几条路；
 * 「回 1 / 回 2 / …」只在**卡片发不出去回落纯文本**时出现（见 `composeTopicAsk`）。
 * 之所以还要留它：卡片回调依赖租户开启 `card.action.trigger` 事件订阅，
 * 没开或权限不足时，纯文本里的编号是唯一入口。
 */

/** 「留在当前话题」按钮的标记（沿用旧名 `topic`，值仍是 yes/no）。 */
const KIND = 'topic';

/** 候选话题按钮：点了就切到这条会话（带 sid）。 */
const CHOOSE_KIND = 'topicChoose';

/** 「看看全部话题」按钮的标记：它不改指针，只是换一条路（列出列表卡）。 */
const LIST_KIND = 'topicList';

/**
 * 「以上都不是」按钮：一个**高质量负样本**。
 *
 * 用户点它等于说"候选排序错了"，比"留在当前"强得多——后者可能只是不想切。
 * 后续调权重/阈值时，这批样本是最稀缺的标签。
 */
const NONE_KIND = 'topicNone';

export type TopicAnswer = 'yes' | 'no';

/**
 * 卡片状态。发问时是 `ask`，点完按钮后进入后三种之一。
 *
 * 为什么用"替换卡片"而不是"把按钮置灰"：飞书卡片 2.0 的 `button` 没有 disabled 语义，
 * 置灰只能靠改色（视觉上仍是可点的），删掉按钮才是真的点不到。
 * 顺带还能写清"你点了哪个""正在做什么"——这正是用户抱怨"不知道是不是卡死"的地方。
 */
export type TopicCardPhase = 'processing' | 'done' | 'expired' | 'failed';

/** 卡片外层的公共骨架（`update_multi` 是后续 patch 能生效的前提）。 */
function cardOf(elements: Array<Record<string, unknown>>): Record<string, unknown> {
  return {
    schema: '2.0',
    config: { wide_screen_mode: true, update_multi: true },
    body: { elements },
  };
}

/** 询问卡上的一个候选话题（顺序 = 按钮顺序 = 纯文本「回 N」的序号）。 */
export interface AskCandidate {
  id: string;
  /** 会话标题；直接写进按钮，用户不用猜"切回去"是切到哪。 */
  title: string;
}

export interface TopicAskInput {
  body: string;
  /** 当前会话标题：用于「留在《X》」——必须写清留下来是哪条。 */
  currentTitle: string;
  /** 候选话题（最多 3 条）。 */
  candidates: AskCandidate[];
}

/**
 * 构造询问卡片：正文（markdown）+ 分隔线 + N 个候选按钮 + 「留在《当前》」+「看看全部话题」。
 *
 * 结构按**卡片 JSON 2.0**（与 mdCard.ts 产出的卡片同版本），两条实测约束：
 *  1. `button` 直接放在 `body.elements` 里，**不套 `action` 容器**——
 *     `action` 是 1.0 的写法，混用在 2.0 里会被接口整条拒收；
 *  2. 2.0 的按钮回调走 `behaviors: [{type:'callback', value}]`，
 *     回调体里的 `action.value` 就是这里塞的 value。
 *
 * 为什么不给"一个猜测 + 两条死路"（2026-11-08 用户反馈）：`切回去 / 就在这儿继续`
 * 这两个词都没写清**切到哪条、留在哪条**，而只有一个猜测意味着判错时用户无从纠正。
 * 现在把语义最像的 2~3 条直接摆成按钮（文案带标题），另给「留在《当前》」和
 * 「看看全部话题」。判错的代价从"进错会话"降为"点另一个按钮"。
 *
 * 按钮竖排（不套 `column_set`）：少一层容器就少一个可能被拒的字段，手机上也更好点。
 */
export function buildTopicAskCard(input: TopicAskInput): Record<string, unknown> {
  const choose = input.candidates.map(
    (c): Record<string, unknown> => ({
      tag: 'button',
      text: { tag: 'plain_text', content: `切到《${c.title}》` },
      type: 'default',
      behaviors: [{ type: 'callback', value: { k: CHOOSE_KIND, sid: c.id } }],
    }),
  );
  return cardOf([
    { tag: 'markdown', content: input.body },
    { tag: 'hr' },
    ...choose,
    {
      tag: 'button',
      text: { tag: 'plain_text', content: `留在《${input.currentTitle}》` },
      type: 'default',
      behaviors: [{ type: 'callback', value: { k: KIND, answer: 'no' } }],
    },
    {
      tag: 'button',
      text: { tag: 'plain_text', content: '看看全部话题' },
      type: 'default',
      behaviors: [{ type: 'callback', value: { k: LIST_KIND } }],
    },
    {
      tag: 'button',
      text: { tag: 'plain_text', content: '以上都不是' },
      type: 'default',
      behaviors: [{ type: 'callback', value: { k: NONE_KIND } }],
    },
  ]);
}

/** 解析「以上都不是」：不改指针，也不留在当前——只记一次"候选全错"。 */
export function parseTopicNone(payload: unknown): boolean {
  const p = payload as Record<string, any> | null | undefined;
  if (!p) return false;
  const value = valueOf(p?.event?.action?.value ?? p?.action?.value ?? p?.event?.value ?? p?.value);
  return value?.k === NONE_KIND;
}

/**
 * 解析候选话题按钮的回调：返回要切到的会话 id。
 *
 * 与「留在当前」（`topic`）和「看看全部话题」（`topicList`）分开认——
 * 这条是**唯一会同时搬指针 + 接续原话**的回调，认错就等于把用户送进错的会话。
 */
export function parseTopicChoose(payload: unknown): string | null {
  const p = payload as Record<string, any> | null | undefined;
  if (!p) return null;
  const value = valueOf(p?.event?.action?.value ?? p?.action?.value ?? p?.event?.value ?? p?.value);
  if (!value || value.k !== CHOOSE_KIND) return null;
  const sid = typeof value.sid === 'string' ? value.sid.trim() : '';
  return sid || null;
}

/**
 * 解析「看看全部话题」的回调。
 *
 * 与「留在当前」、`切到这儿` 分开认：这条回调**不改指针、不动 pending**，
 * 只负责把列表卡发出来，所以不能和另外两种混用一个 kind。
 */
export function parseTopicListRequest(payload: unknown): boolean {
  const p = payload as Record<string, any> | null | undefined;
  if (!p) return false;
  const value = valueOf(p?.event?.action?.value ?? p?.action?.value ?? p?.event?.value ?? p?.value);
  return value?.k === LIST_KIND;
}

/** 话题列表里的一条：序号与 `/resume 序号` 严格同序。 */
export interface TopicListItem {
  index: number;
  id: string;
  title: string;
  /** 「7 小时前 · 130 条」这种一眼能比的元信息。 */
  meta: string;
  /** 展开后看到的内容：会话卡摘要，没有卡就是最近几条原话。 */
  recap: string;
  current?: boolean;
}

/** 列表卡片上「切到这儿」按钮的标记。与 yes/no 的 `topic` 分开，两条回调互不干扰。 */
const PICK_KIND = 'topicPick';

/**
 * 话题选择卡片：**每条一个折叠面板**。
 *
 * 为什么不是纯文字列表（`/topics` 的原样）：用户的原话是"标题很短、相近话题分不清"，
 * 而区分度不在标题长短，在于**能不能就地展开看到那段在聊什么**。
 * 折叠面板把摘要藏在一次点击之后，列表仍然能一屏看完。
 *
 * 结构约束与 `buildTopicAskCard` 一致：卡片 JSON 2.0、按钮直挂 `elements`、
 * 不套 1.0 的 `action` 容器（混用会被接口整条拒收）。
 */
export function buildTopicListCard(
  items: TopicListItem[],
  total = items.length,
  /** 其中多少个还没有会话卡（卡片里要说清，否则用户会以为摘要坏了）。 */
  pendingCards = 0,
): Record<string, unknown> {
  const panelOf = (it: TopicListItem): Record<string, unknown> => {
    const elements: Array<Record<string, unknown>> = [
      { tag: 'markdown', content: it.recap.trim() || '（这段还没有摘要，点「切到这儿」接着聊就有了）' },
    ];
    if (it.current) {
      elements.push({ tag: 'markdown', content: '**当前就在这个话题里**' });
    } else {
      elements.push({
        tag: 'button',
        text: { tag: 'plain_text', content: '切到这儿' },
        type: 'default',
        behaviors: [{ type: 'callback', value: { k: PICK_KIND, sid: it.id } }],
      });
    }
    return {
      tag: 'collapsible_panel',
      expanded: false,
      header: {
        title: {
          tag: 'markdown',
          content: `**${it.index}. ${it.title}**　${it.meta}${it.current ? '　·　当前' : ''}`,
        },
        vertical_align: 'center',
      },
      elements,
    };
  };

  return cardOf([
    {
      tag: 'markdown',
      content:
        `**这个窗口装过 ${total} 个话题**` +
        (pendingCards > 0 ? `（${pendingCards} 个还没摘要，后台在补）` : '') +
        '　点开看摘要，再点「切到这儿」直接过去',
    },
    ...items.map(panelOf),
    { tag: 'markdown', content: '也可以回 `/resume 序号` 切过去，`/back` 退回上一个。' },
  ]);
}

/**
 * 列表卡的**两个产物**：卡片 + 纯文本退路。
 *
 * 退路不是敷衍版：卡片发不出去（租户没开 `interactive` / 接口权限异常）时，
 * 它就是用户唯一能看到的版本，所以每行必须带「序号 + 标题 + 时间条数 + 摘要首句」。
 */
export function composeTopicList(
  items: TopicListItem[],
  total = items.length,
  pendingCards = 0,
): { card: Record<string, unknown>; fallback: string } {
  const lines: string[] = [
    `这个窗口装过 ${total} 个话题：` + (pendingCards > 0 ? `（${pendingCards} 个还没摘要，后台在补）` : ''),
  ];
  for (const it of items) {
    lines.push(`${it.index}. ${it.title}（${it.meta}）${it.current ? '  ← 当前' : ''}`);
    const brief = it.recap
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)[0];
    if (brief) lines.push(`    ${brief.slice(0, 60)}`);
  }
  if (total > items.length) lines.push(`……另有 ${total - items.length} 个话题，回 /topics 之后再滚一轮才看得到。`);
  lines.push('', '回 /resume 序号 切过去，/back 退回上一个。');
  return { card: buildTopicListCard(items, total, pendingCards), fallback: lines.join('\n') };
}

/** 解析列表卡上「切到这儿」的回调：只认自己塞的 kind，拿不到就 null（绝不猜）。 */
export function parseTopicPick(payload: unknown): string | null {
  const p = payload as Record<string, any> | null | undefined;
  if (!p) return null;
  const value = valueOf(p?.event?.action?.value ?? p?.action?.value ?? p?.event?.value ?? p?.value);
  if (!value || value.k !== PICK_KIND) return null;
  const sid = typeof value.sid === 'string' ? value.sid.trim() : '';
  return sid || null;
}

/**
 * 一次询问卡的**两个产物**：卡片与纯文本退路（带「回 1..N」）。
 *
 * 为什么要拆开：这两个东西混用会出现"正文写着回 1 回 2、下面又摆着按钮"的重复
 * （实测被用户第一眼就挑出来）。退路串只在 `sendRich` 卡片发送失败时才会被发出去，
 * 所以它必须自带完整信息，而卡片正文不能再带上它。
 *
 * 编号与按钮顺序严格一致：`1..N` = 候选话题，`N+1` = 留在当前，`N+2` = 看全部话题。
 * 退路上的每一行都写话题标题（不是「切回去」这种方位词），否则用户还得回头数。
 */
export function composeTopicAsk(input: TopicAskInput): { card: Record<string, unknown>; fallback: string } {
  const n = input.candidates.length;
  const lines = input.candidates.map((c, i) => `回 **${i + 1}** 切到《${c.title}》`);
  lines.push(`回 **${n + 1}** 留在《${input.currentTitle}》`);
  lines.push(`回 **${n + 2}** 看全部话题`);
  lines.push(`回 **${n + 3}** 以上都不是`);
  return {
    card: buildTopicAskCard(input),
    fallback: `${input.body}\n\n---\n${lines.join('　')}`,
  };
}

/**
 * 点完按钮后的状态卡（无按钮）。
 *
 * `label` 是用户点的那个按钮名。**拿不到就不编**：`expired` 态下有时已经查不到
 * 原来的提问（被文字回答 / 过期清理），这时只写"已收到你的选择"，而不是猜
 * "切回去"还是"开新话题"。
 */
export function buildTopicCardState(phase: TopicCardPhase, label?: string): Record<string, unknown> {
  const picked = label ? `已选择：${label}` : '已收到你的选择';
  const mark = phase === 'failed' ? '⚠️' : '✅';
  const line =
    phase === 'processing'
      ? [`${mark} **${picked}**`, '⏳ 正在接着回答，结果稍后出现在下面…'].join('\n')
      : phase === 'done'
        ? `${mark} **${picked}** · 已处理完成`
        : phase === 'expired'
          ? `${mark} **${picked}** · 这次提问已经处理过`
          : `${mark} **${picked}** · 处理失败，麻烦重发一次`;
  return cardOf([{ tag: 'markdown', content: line }]);
}

/** 取回调体里的 value：飞书有时给对象，有时给 JSON 字符串，两种都认。 */
function valueOf(raw: unknown): Record<string, unknown> | null {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * 从卡片回调里解析用户的回答。
 *
 * 飞书的回调体在不同接入方式下有几种包法（`event.action.value` / `action.value` / `value`），
 * 这里都兜住，拿不到就返回 null——**绝不猜**。猜错的代价是把用户的会话搬错地方。
 */
export function parseTopicCardAction(payload: unknown): TopicAnswer | null {
  const p = payload as Record<string, any> | null | undefined;
  if (!p) return null;
  const value = valueOf(p?.event?.action?.value ?? p?.action?.value ?? p?.event?.value ?? p?.value);
  if (!value) return null;
  if (value.k !== KIND) return null;
  const answer = value.answer;
  return answer === 'yes' || answer === 'no' ? answer : null;
}

/**
 * 从卡片回调里取出"是哪个聊天、哪个人、哪条卡片消息"。
 *
 * 与 message 事件不同，卡片回调把这三样放在 `context` / `operator` 里。
 */
export function parseTopicCardContext(payload: unknown): {
  chatId: string;
  openId: string;
  messageId: string;
} {
  const p = payload as Record<string, any> | null | undefined;
  const ctx = p?.event?.context ?? p?.context ?? {};
  const op = p?.event?.operator ?? p?.operator ?? {};
  return {
    chatId: String(ctx.open_chat_id ?? ctx.chat_id ?? ''),
    openId: String(op.open_id ?? op.user_id ?? ''),
    messageId: String(ctx.open_message_id ?? ctx.message_id ?? ''),
  };
}
