/**
 * 会话自动命名：聊到第 3 轮，让模型读前几轮，给会话起一个名字。
 *
 * 为什么是第 3 轮，而不是第 1 轮：
 *   首条消息常常是「你好」「帮我看下这个」——从一句里起名只会得到「你好」。
 *   三轮之后话题基本成形，取名既准确，也不必多问用户一句。
 *
 * 为什么在答复返回后才跑，且不 await：
 *   用户等的是答复，不是会话名。这次调用放后台，失败也只当没这回事。
 *   与 sessionSummary 的区别：会话卡可以等闲置，命名不能等——否则用户一直看到
 *   「默认会话」「会话 2」，正是这个功能要解决的问题。
 *
 * 为什么写 `name` 而不是 `title`：
 *   看板与对话窗都以 `name` 为准，`title` 只有部分是"优先显示"。写 `name` 一处生效，
 *   不必再让每个界面各自判断该显示哪个字段。
 */
import type { WakerRecord } from '../types.ts';
import { listSessions, patchSession } from './sessions.ts';
import { readSessionMessages, type ChatMessage } from './sessionHistory.ts';

/** 聊到第几轮开始起名。 */
export const AUTO_NAME_ROUND = 3;
/** 名字长度上限：看板一行放得下，再长也会被截断。 */
export const NAME_MAX_CHARS = 16;

export interface AutoNameInput {
  rec: WakerRecord;
  sessionId: string;
  /**
   * 本轮是会话里的第几轮。
   * 由调用方在 `touchSession` **之前**读出（那里会 +1），否则时序一错就永远凑不齐第 3 轮。
   */
  round: number;
  /** 与主对话同一套 LLM 参数（模型 / provider / api key）。 */
  args: string[];
  timeoutMs: number;
  /** 一次性调用。由 runner 注入，避免本模块反向依赖 runner / compact 形成循环导入。 */
  runOnce: (
    rec: WakerRecord,
    args: string[],
    prompt: string,
    timeoutMs: number,
  ) => Promise<{ out: string; err: string }>;
}

/**
 * 这个名字是不是"系统给的默认名"。
 *
 * 只有默认名被覆盖才算改进。存量数据里有些会话的名字是加入 `nameSource` 之前
 * 手动改的（写库时没留来源），按形态判断才不会把「职业与副业规划」这种
 * 已经很好的名字换成模型起的名字。
 */
export function isDefaultName(name: string): boolean {
  const s = String(name ?? '').trim();
  if (!s) return true;
  if (s === '默认会话') return true;
  if (/^会话\s*\d+$/.test(s)) return true;
  if (/^飞书(私聊|群聊)$/.test(s)) return true;
  if (/^飞书文档评论/.test(s)) return true;
  if (/^(定时|API)·/.test(s)) return true;
  return false;
}

/**
 * 这个名字看起来是不是"首句被截断"。
 *
 * 存量数据里有一批名字是早期直接拿首句截 18 字落库的（那时还没有 `nameFrom` 字段），
 * 列表里长成「你可能能从记忆里找到，我们之前聊到如…」——和原文没区别。
 * `deriveTitle` 截断时一定补省略号，所以"以省略号结尾"是这类名字的稳定特征。
 */
export function looksDerivedName(name: string): boolean {
  const s = String(name ?? '').trim();
  if (!s) return false;
  if (s.endsWith('…') || s.endsWith('...')) return true;
  // 另一种截断：模型给的名字本来更长，被 `cleanSessionName` 硬切到 16 字——
  // 表现是"顶到上限且结尾不是标点"，例如「Refactoring UI s」。同样是没法认的名字。
  return s.length >= NAME_MAX_CHARS && !/[。．.！!？?、，,]$/.test(s);
}

/**
 * 列表里该显示哪个名字。
 *
 * 优先级：**真名字**（模型起的 / 用会话卡生成的）> 首条消息派生的 `title` > 兜底名。
 *
 * 为什么必须单独一个函数：`title` 会被每轮消息覆写成"用户这句话的前 18 字"，
 * 于是 `title || name` 会让 `/topics` 里所有会话都显示成用户最后说的那句原文
 * （实测就是这样，模型认真起的名字一次都没露过面）。真名字存在时，`title` 只是噪声。
 */
export function displayNameOf(s: {
  name?: string;
  title?: string;
  nameSource?: 'auto' | 'manual';
  nameFrom?: 'derive' | 'messages' | 'card';
}): string {
  const name = String(s.name ?? '').trim();
  const title = String(s.title ?? '').trim();
  if (s.nameSource || (s.nameFrom && s.nameFrom !== 'derive')) return name || title;
  if (title && isDefaultName(name)) return title;
  return name || title;
}

/**
 * 该不该起名。**纯函数**，便于单测与事后解释。
 *
 * 看四件事：开关、轮次、名字有没有归属（自动起过 / 用户改过）、
 * 现在的名字是不是默认名（已经有意义的名字不动）。
 * 用 `>=` 而不是 `===`：某一轮模型没给有效输出时，下一轮还能补上，
 * 不必因为一次失败就让会话永久停在「默认会话」。
 */
export function shouldAutoName(input: {
  enabled: boolean;
  round: number;
  name: string;
  nameSource?: 'auto' | 'manual';
  nameFrom?: 'derive' | 'messages' | 'card';
}): boolean {
  if (!input.enabled) return false;
  if (input.nameSource === 'manual') return false;
  // 这两个档已经是"有人认真起过名"，不再动（card 比 messages 更准，也不回退）
  if (input.nameFrom === 'messages' || input.nameFrom === 'card') return false;
  // 首句派生的名字**不算名字**：它只是把用户第一句话截了 18 字。
  // 实测最常见的是「你可能能从记忆里找到，我们之前聊到如…」—— 列表里两条这样的标题
  // 完全分不出谁是谁，正是要修的东西。所以这种会话仍然要起名一次（messages 档）。
  if (input.nameFrom === 'derive') return input.round >= AUTO_NAME_ROUND;
  // 存量数据：早期把首句截断后直接标成了 auto（没有 nameFrom），形态上与真名字没法区分，
  // 只能按"以省略号结尾"认。认出来就重起一次——否则这批会话永远停在原文标题上。
  if (input.nameSource === 'auto') return looksDerivedName(input.name) && input.round >= AUTO_NAME_ROUND;
  if (input.nameSource) return false;
  if (!isDefaultName(input.name)) return false;
  return input.round >= AUTO_NAME_ROUND;
}

/**
 * 把模型输出洗成能直接用的名字。
 *
 * 实测模型很爱输出「标题：xxx」「《xxx》」「xxx。」这类包装，
 * 原样落库会在列表里露出引号和句号，比没有名字还难看。
 */
export function cleanSessionName(raw: string, max = NAME_MAX_CHARS): string {
  let s = String(raw ?? '').trim();
  if (!s) return '';
  // 只取第一行：模型偶尔会写成「名字\n这样起的理由」
  s = s.split(/\r?\n/).map((x) => x.trim()).find(Boolean) ?? '';
  // 去掉「标题：」「会话名：」这类前缀
  s = s.replace(/^(会话名称|会话名|标题|名字|name)\s*[:：]\s*/i, '');
  // 去掉成对的书名号/引号/括号与句末标点
  s = s.replace(/^[《「『"'“（(]+/, '').replace(/[》」』"'”）。．.!！?？,，;；:：]+$/, '');
  s = s.replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return s.length > max ? s.slice(0, max) : s;
}

/** 会话名只关心"在聊什么"：贴一屏代码或长链接进来只会白烧 token。 */
function squash(text: string, max = 400): string {
  return String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** 构造起名提示词。纯函数，便于测试"喂了几条、限了几个字"。 */
export function buildNamePrompt(messages: ChatMessage[], maxChars = NAME_MAX_CHARS): string {
  const lines = messages.map((m) => `${m.role === 'user' ? '用户' : '助手'}：${squash(m.text)}`);
  return [
    '给下面这段对话起一个会话名，用来在会话列表里一眼认出"这段在聊什么"。',
    `要求：不超过 ${maxChars} 个字，一个短语；不要引号、不要标点结尾；`,
    '不要"关于""讨论""聊天"这类空话，不要复述第一句原话。',
    '只输出这个名字本身，不要任何解释。',
    '',
    '对话：',
    ...lines,
  ].join('\n');
}

/** 同时只跑一个：命名是后台小事，不值得和用户任务抢模型。 */
let running = false;

/**
 * 到达闸门就在后台起名。**同步判断、异步执行**：
 * 判断必须同步做（调用方马上会 touchSession 改变计数），执行不阻塞调用方。
 */
export function maybeAutoNameSession(input: AutoNameInput): void {
  const session = listSessions(input.rec.def.id).find((s) => s.id === input.sessionId);
  if (!session) return;
  const enabled = input.rec.def.session?.autoName !== false;
  if (
    !shouldAutoName({
      enabled,
      round: input.round,
      name: session.name,
      nameSource: session.nameSource,
      nameFrom: session.nameFrom,
    })
  ) {
    return;
  }
  if (running) return;

  running = true;
  void (async () => {
    try {
      const msgs = readSessionMessages(input.rec.def.id, input.sessionId, 10).filter((m) => m.text.trim());
      // 只有一问一答凑不出"在聊什么"，留给下一轮
      if (msgs.length < 2) return;
      const { out } = await input.runOnce(input.rec, input.args, buildNamePrompt(msgs), input.timeoutMs);
      const name = cleanSessionName(out);
      if (!name) return;
      // 写之前再确认一次：这期间用户可能已经手动改了名（manual）、被会话卡升过级（card），
      // 或者会话已被删。比同步闸门更宽的口径只在这里用——异步窗口里一切都可能变。
      const fresh = listSessions(input.rec.def.id).find((s) => s.id === input.sessionId);
      if (!fresh || fresh.nameSource === 'manual' || fresh.nameFrom === 'card') return;
      if (
        !shouldAutoName({
          enabled: true,
          round: AUTO_NAME_ROUND,
          name: fresh.name,
          nameSource: fresh.nameSource,
          nameFrom: fresh.nameFrom,
        })
      ) {
        return;
      }
      patchSession(input.rec.def.id, input.sessionId, { name, nameSource: 'auto', nameFrom: 'messages' });
      console.log(`[name] ${input.rec.def.id}/${input.sessionId} 会话命名为「${name}」`);
    } catch (e) {
      // 命名失败不影响任何主流程，留一行日志够定位
      console.warn('[name] 会话命名失败:', (e as Error)?.message ?? e);
    } finally {
      running = false;
    }
  })();
}
