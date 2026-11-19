import { createRequire } from 'node:module';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_ARBITER_CONFIG, DEFAULT_SESSION_CONFIG } from '../types.ts';
import type { FeishuChannelConfig, SessionConfig, WakerRecord } from '../types.ts';
import { DATA_DIR, PI_AGENT_HOME, ROUTING_LOG } from '../core/paths.ts';
import {
  clearSession,
  listSessions,
  patchSession,
  resolveSession,
  resolveSessionByKey,
  touchSession,
  type SessionMeta,
} from '../core/sessions.ts';
import {
  bumpReject,
  chambersOf,
  conversationKeyOf,
  clearPending,
  getConversation,
  openNewChamber,
  resetReject,
  resolveConversationSession,
  setActive,
  setPending,
  type PendingAsk,
} from '../core/conversations.ts';
import {
  decideRoute,
  decideAskGate,
  decideTimeWindow,
  deriveTitle,
  strongSemanticPick,
  type RouteDecision,
  type RouteSession,
  type SemanticInput,
} from '../core/topicRouter.ts';
import { readSessionMessages } from '../core/sessionHistory.ts';
import { parseExternalKey } from './types.ts';
import { markSessionDirty, recapText } from '../core/sessionSummary.ts';
import { displayNameOf } from '../core/sessionName.ts';
import {
  arbiterSwitchConsistent,
  rankCandidatesBySemantic,
  semanticInputFor,
  semanticScoreOf,
} from '../core/semanticRoute.ts';
import {
  ensureIndexed,
  loadCache,
  scoreSessions,
  semanticFromIndex,
  type SessionScore,
} from '../core/sessionIndex.ts';
import { embedTexts, type EmbeddingConfig } from '../core/embeddings.ts';
import {
  appendDecision,
  candidateSnapshots,
  newDecisionId,
  type AnswerKind,
} from '../core/decisionLog.ts';
import {
  arbitrate,
  arbitratePair,
  decisionFromArbiter,
  matchExplicitNewTopic,
  type ArbiterResult,
  type ArbiterTurn,
} from '../core/topicArbiter.ts';
import { DEFAULT_TIMEOUT, runWaker } from '../core/runner.ts';
import { hasMarkdown, markdownToCards } from './mdCard.ts';
import {
  buildTopicCardState,
  composeTopicAsk,
  composeTopicList,
  parseTopicCardAction,
  parseTopicCardContext,
  parseTopicChoose,
  parseTopicListRequest,
  parseTopicNone,
  parseTopicPick,
  type TopicAnswer,
  type TopicCardPhase,
  type TopicListItem,
} from './topicCard.ts';
import {
  cleanupInbox,
  DEFAULT_ATTACHMENT_PROMPT,
  extractText,
  materialize,
  parseFeishuMessage,
  removeAttachments,
} from './feishuMedia.ts';
import type { Channel, ChannelStatus } from './types.ts';

/* 飞书 SDK 无类型声明，渠道层内部按结构化动态使用 */
type Any = any;

/**
 * 解析飞书 SDK：优先环境变量显式指定，其次复用本机 `feishu-bot` 已装的依赖，
 * 最后按常规解析。全部失败则渠道标记为 error（不抛错、不影响平台其他部分）。
 */
function loadLarkSdk(): Any | null {
  const bases = [process.env.WAKER_FEISHU_SDK, join(PI_AGENT_HOME, 'feishu-bot', 'package.json'), import.meta.url].filter(
    Boolean,
  ) as string[];
  for (const base of bases) {
    try {
      return createRequire(base)('@larksuiteoapi/node-sdk');
    } catch {
      /* 换下一个来源 */
    }
  }
  return null;
}

const MAX_CHARS = 4000;

/** 询问卡最多列几个候选话题：再多按钮就成一堵墙，剩下的交给「看看全部话题」。 */
const ASK_CANDIDATES = 3;

/** 语义调用参数（索引与现场切块共用同一套端点/模型）。 */
function embedCfgOf(cfg: SessionConfig): EmbeddingConfig {
  return {
    enabled: true,
    baseUrl: cfg.semantic.baseUrl,
    model: cfg.semantic.model,
    timeoutMs: cfg.semantic.timeoutMs,
  };
}

/**
 * 会话控制命令：IM 里直接发给机器人的指令，**不进模型**。
 *
 * 为什么要有：飞书里没法像 CLI 那样另开会话，聊久了上下文只会越来越长
 * （既费 token，也容易把旧话题带进新问题）。发一条命令就能把当前会话清零，
 * 下一条消息当全新话题处理；会话条目本身保留（key/映射/命名都不丢）。
 *
 * 只认**精确匹配**（允许结尾带标点）：用户正常说"帮我清空一下这个文档"不该被当成命令。
 */
const CLEAR_COMMANDS = new Set(['/clear', '/reset', '清空', '清空对话', '清空上下文', '忘掉之前的对话']);
const HELP_COMMANDS = new Set(['/help', '/?', '/帮助']);
/** 话题相关命令（仅 topic 模式下生效；single 模式不暴露，免得误用）。 */
const TOPIC_COMMANDS = new Set(['/topics', '/topic', '话题', '话题列表']);
const BACK_COMMANDS = new Set(['/back', '退回']);

/**
 * 把用户的确认回复归一化。
 * 只认**显式选择**：把"好的""行"当成"切过去"是危险的——那可能只是他在应声。
 */
function normalizeAnswer(text: string): 'yes' | 'no' | null {
  const t = text.trim().toLowerCase().replace(/[。！!？?，,、\s]/g, '');
  if (/^(1|y|yes|是|要|切|切回|切过去|切回去)$/.test(t)) return 'yes';
  if (/^(2|n|no|否|不|不用|不要|就在这|在这|继续)$/.test(t)) return 'no';
  return null;
}

/** 相对时间，给 /topics 与询问话术用。 */
function relTime(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.round(h / 24)} 天前`;
}

/** 单行截断（用于摘要展示，不引入额外依赖）。 */
function clip(s: string, n = 90): string {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/** 把云文档评论的富文本 elements 拍平成纯文本（@提及丢弃，正文与链接保留）。 */
function elementsToText(elements: unknown): string {
  if (!Array.isArray(elements)) return '';
  return elements
    .map((el) => {
      const e = el as { type?: string; text_run?: { text?: string }; docs_link?: { url?: string } };
      if (e.type === 'text_run') return e.text_run?.text ?? '';
      if (e.type === 'docs_link') return e.docs_link?.url ?? '';
      return '';
    })
    .join('')
    .trim();
}

/**
 * 一次话题卡片点击的**同步判定结果**。
 *
 * 单独成类型是因为它跨了两步：ack（同步、决定卡片长什么样）与干活（异步、几十秒）。
 * 判定只做一次，两步共用同一份结果，避免 ack 说"处理中"、实际却因为 pending 已失效什么都没跑。
 */
interface CardClick {
  /** 点了哪个按钮；不是话题卡片的按钮则为 null。 */
  answer: TopicAnswer | null;
  /** 点了话题列表卡上的「切到这儿」时，目标会话 id。 */
  pickSessionId?: string;
  /** 点了询问卡上某个候选话题：「切到《X》」。 */
  chooseSessionId?: string;
  /** 点了「以上都不是」：候选全错的负样本，只记账 + 留在当前。 */
  rejectAll?: boolean;
  /** 点了询问卡上的「看看全部话题」：只发列表卡，不改指针也不重放原话。 */
  wantTopicList?: boolean;
  /** 确实有待答提问的会话键；没找到就是空串。 */
  key: string;
  pending?: PendingAsk;
  /** 该会话是否已有任务在跑（此时不改卡片、保留按钮）。 */
  busy: boolean;
  /** 那张卡片的消息 id，回复与卡片更新都挂在它下面。 */
  messageId: string;
}

/**
 * 飞书渠道：一个实例对应一套飞书应用（appId/appSecret），
 * 入站消息映射到平台会话后交给 runner 执行，结果回帖。
 */
export class FeishuChannel implements Channel {
  readonly kind = 'feishu' as const;
  readonly wakerId: string;
  /** 该机器人实际服务的员工（默认即承载此配置的员工）。 */
  private readonly agentId: string;
  private readonly name: string;
  private readonly cfg: FeishuChannelConfig;
  private client: Any = null;
  private ws: Any = null;
  private state: ChannelStatus['state'] = 'stopped';
  private error?: string;
  private startedAt?: string;
  /**
   * 同一会话正在处理中 → 直接回一句"稍后再发"。key → 开始时间。
   *
   * 注意：**正确性不靠它**。同一 pi 会话的串行由平台队列（`core/queue.ts`）保证；
   * 这里只做"快速反馈"——否则用户连发两条只会石沉大海，等轮到第二条才回话，体感更差。
   *
   * 存**开始时间**而不是布尔：只回一句"还在处理中"会让人以为卡死了（实测用户会追问
   * "上一个任务是什么时候发起的？为什么到现在没处理完？"），带上已运行时长才有信息量。
   */
  private readonly busy = new Map<string, number>();

  /**
   * 已处理过的事件 id（message_id / comment_id）→ 时间戳，用于**幂等去重**。
   * **落盘持久化**（`data/feishu-seen.json`），因为飞书的重投会跨进程、跨很长的时间。
   *
   * 为什么必须有（2026-10-12 实测事故：同一个问题被回了两条不同答案）：
   * 飞书长连接要求客户端收到事件后**回 ack**，而 SDK 是在 `eventDispatcher.invoke()`
   * **全部 await 完**之后才回（`@larksuiteoapi/node-sdk` 的 `[ws] receive message` 分支：
   * 先 invoke、再 sendMessage 回包）。我们的 handler 原先"等整个任务跑完才返回"，
   * ack 必然迟到 → 飞书按自己的重试计划重投。**实测到两档间隔**：
   *   · +18~19 秒：短任务（4.4s / 6.6s / 7.3s）的重投落在忙锁释放后 → 被完整跑第二遍；
   *   · **+1 小时 4 秒**：用户 01:06:31 与 01:07:37 两条提问，在 02:06:35 / 02:07:41
   *     被原样重跑一次——用户的原话是"2:07 的问题，我在 1:06 问过，为什么又出现了"。
   *
   * 关键结论：**重投窗口是小时级，去重必须持久化**。第一版只做了"内存 + 10 分钟窗口"，
   * 被 1 小时后的重投直接绕过（而且进程一重启就清空）。现在写盘、窗口 24 小时。
   *
   * 这是第二层防线；第一层是 handler 立即返回、不阻塞 ack（见 `start()`），从源头消除重投。
   */
  private seen = new Map<string, number>();

  /** 去重文件（data/feishu-seen.json，随进程重启保持）。 */
  private static readonly SEEN_FILE = join(DATA_DIR, 'feishu-seen.json');

  /** 去重保留窗口：覆盖飞书小时级的重投链，24 小时足够且不会无限膨胀。 */
  private static readonly SEEN_TTL_MS = 24 * 60 * 60 * 1000;

  /** 去重表上限，超出按时间淘汰最旧的（防止文件无限增长）。 */
  private static readonly SEEN_MAX = 5000;

  /** 从磁盘载入去重表（构造时一次）。 */
  private loadSeen(): void {
    try {
      if (!existsSync(FeishuChannel.SEEN_FILE)) return;
      const raw = JSON.parse(readFileSync(FeishuChannel.SEEN_FILE, 'utf-8')) as Record<string, number>;
      const now = Date.now();
      for (const [k, t] of Object.entries(raw)) {
        if (typeof t === 'number' && now - t < FeishuChannel.SEEN_TTL_MS) this.seen.set(k, t);
      }
    } catch (e) {
      console.error(`[feishu:${this.wakerId}] 读取去重表失败（忽略，视为空表）:`, (e as Error)?.message ?? e);
    }
  }

  /** 写回去重表；先按窗口和数量上限裁剪。 */
  private saveSeen(): void {
    try {
      const now = Date.now();
      for (const [k, t] of this.seen) if (now - t > FeishuChannel.SEEN_TTL_MS) this.seen.delete(k);
      const entries = [...this.seen.entries()].sort((a, b) => b[1] - a[1]).slice(0, FeishuChannel.SEEN_MAX);
      writeFileSync(FeishuChannel.SEEN_FILE, `${JSON.stringify(Object.fromEntries(entries))}\n`, 'utf-8');
    } catch (e) {
      console.error(`[feishu:${this.wakerId}] 写去重表失败（不影响本次处理）:`, (e as Error)?.message ?? e);
    }
  }

  /** 该事件是否已处理过。首次见到返回 false 并登记；重复返回 true。 */
  private isDuplicate(eventId: string): boolean {
    const hit = this.seen.get(eventId);
    if (hit && Date.now() - hit < FeishuChannel.SEEN_TTL_MS) return true;
    this.seen.set(eventId, Date.now());
    this.saveSeen();
    return false;
  }

  /**
   * 事件太旧就丢弃——**这是挡住"晚到重投"的关键闸门**。
   *
   * 为什么单靠"按 id 去重"不够：去重表是本次部署之后才开始记的，
   * 而飞书可能已经为你**一小时前**的消息排好了下一轮重投；
   * 那轮重投带的是同一个 message_id 没错，但我们的表里没有它的记录（事故发生在部署之前）→ 还是会被执行。
   *
   * 所以再加一道**与状态无关**的判断：拿消息自身的创建时间比现在。
   * 真人发消息到被处理的延迟是毫秒级（飞书推、我们收），所以只要它比"现在"老 10 分钟以上，
   * 就一定是重投，不可能是新消息——直接丢，且不落去重表（下一轮重投同样会被这条规则拦住）。
   */
  private static readonly STALE_EVENT_MS = 10 * 60 * 1000;

  /** 事件原始时间（ms）是否已过期。拿不到时间就当作新事件（宁可执行，不要误丢）。 */
  private isStale(createTime: unknown, kind: string, id: string): boolean {
    const ms = typeof createTime === 'string' || typeof createTime === 'number' ? Number(createTime) : 0;
    if (!ms || Number.isNaN(ms)) return false;
    // 飞书给的是毫秒时间戳；个别事件给秒级，按量级兜一下
    const ts = ms < 1e12 ? ms * 1000 : ms;
    const age = Date.now() - ts;
    if (age <= FeishuChannel.STALE_EVENT_MS) return false;
    console.log(
      `[feishu:${this.wakerId}] 忽略过期${kind} ${id}：原始时间 ${new Date(ts).toISOString()}，` +
        `比现在早 ${Math.round(age / 60000)} 分钟（飞书重投，不是新消息）`,
    );
    return true;
  }

  /**
   * 给**用户的原消息**加个表情，作为"已收到、正在处理"的即时反馈。
   *
   * 实测得到的两条边界（别踩）：
   *  - 表情只能加在**用户发的消息**上：对机器人自己发的消息调用会返回
   *    `231017 This operation is not supported for this message type`；
   *  - 所以**文档评论没有这条路**（评论接口没有表情能力），那边只能靠"还在处理中"的回帖。
   *
   * 失败必须**不影响主流程**：缺 `im:message.reaction` 权限、表情名不被支持时只记一条日志。
   * 表情名可用 `channels.feishu.ackEmoji` 覆盖，默认 `THUMBSUP`(👍)；首次成功后会固化，
   * 之后不再试错（避免每条消息多打几次 API）。
   */
  private async reactAck(messageId: string): Promise<void> {
    if (!this.client || !messageId) return;
    const preferred = (this.cfg.ackEmoji ?? '').trim() || 'THUMBSUP';
    const candidates = this.ackEmojiOk ? [preferred] : [preferred, 'OK', 'THUMBSUP', 'DONE'];
    for (const emoji of candidates) {
      let res: Any;
      try {
        res = await this.client.im.v1.messageReaction.create({
          path: { message_id: messageId },
          data: { reaction_type: { emoji_type: emoji } },
        });
      } catch (e) {
        // 权限或网络问题：换表情名也没用，直接放弃（不影响回复）
        console.error(`[feishu:${this.wakerId}] 加收到表情失败:`, (e as Error)?.message ?? e);
        return;
      }
      if (!res || res.code === 0) {
        if (!this.ackEmojiOk) {
          this.ackEmojiOk = true;
          console.log(`[feishu:${this.wakerId}] 收到消息的表情已启用：${emoji}`);
        }
        return;
      }
      console.error(`[feishu:${this.wakerId}] 表情 ${emoji} 被拒：${res.code} ${res.msg}`);
    }
  }

  /** 表情是否已确认可用（首次成功后固化，避免每条消息重试一串候选）。 */
  private ackEmojiOk = false;

  /**
   * 处理会话控制命令（`/clear` 等）。命中并已回执返回 true，调用方据此跳过执行。
   *
   * 只改**当前外部会话对应的那个平台会话**——私聊清私聊、某个群清那个群，
   * 不会去动默认会话或别的群。
   */
  private async handleSessionCommand(
    text: string,
    externalKey: string,
    messageId: string,
    sessionName: string,
  ): Promise<boolean> {
    const raw = text.trim();
    const key = raw.toLowerCase().replace(/[。！!？?，,]+$/, '');
    const topicMode = this.sessionCfg.mode !== 'single';
    /** topic 模式的"当前会话"取映射表 active；single 模式仍是 externalKey 对应的那个。 */
    const current = (): SessionMeta =>
      resolveConversationSession({
        wakerId: this.agentId,
        key: externalKey,
        displayName: sessionName,
        mode: this.sessionCfg.mode,
      }).session;

    // /new [标题] —— 显式开新话题，不询问
    if (topicMode && /^\/new(\s|$)/i.test(key)) {
      const title = raw.replace(/^\/new\s*/i, '').trim();
      const from = current();
      const opened = openNewChamber(this.agentId, externalKey, title || undefined);
      if (from.id !== opened.session.id) {
        patchSession(this.agentId, from.id, { transferredTo: opened.session.id });
      }
      await this.reply(
        messageId,
        `已开新话题《${displayNameOf(opened.session)}》。下一条消息装进这个会话。\n` +
          '（/topics 看历史话题，/back 退回上一个）',
      );
      return true;
    }

    // /topics —— 列出这个窗口装过的会话
    if (topicMode && TOPIC_COMMANDS.has(key)) {
      await this.sendTopicList(messageId, externalKey);
      return true;
    }

    // /resume <序号> —— 切回某个历史话题
    if (topicMode && /^\/resume(\s|$)/i.test(key)) {
      const n = Number(raw.replace(/^\/resume\s*/i, '').trim());
      const chambers = this.agentSessions();
      const target = chambers[n - 1];
      if (!target) {
        await this.reply(messageId, `没有第 ${Number.isFinite(n) && n > 0 ? n : '?'} 个话题。回 /topics 看列表。`);
        return true;
      }
      const from = current();
      // 点到当前话题：不报"已切到"，也不写「接续自自己」的留痕。
      if (from.id === target.id) {
        await this.reply(messageId, `《${displayNameOf(target)}》就是当前话题，不用切。`);
        return true;
      }
      patchSession(this.agentId, from.id, { transferredTo: target.id });
      setActive(this.agentId, externalKey, target.id);
      // 用户自己动手切过了 → 询问配额重新计数。
      // 不重置的话，连续拒绝 2 次（可能是被错误建议逼的）就永久不再问，功能等于废掉。
      resetReject(this.agentId, externalKey);
      const recap = await this.recapOf(target.id);
      await this.reply(messageId, `已切到《${displayNameOf(target)}》。${recap ? `\n${recap}` : ''}`);
      return true;
    }

    // /back —— 退回上一个话题
    if (topicMode && BACK_COMMANDS.has(key)) {
      const conv = getConversation(this.agentId, externalKey);
      const chambers = chambersOf(this.agentId, externalKey);
      const idx = chambers.findIndex((s) => s.id === conv?.activeSessionId);
      const prev = idx >= 0 ? chambers[idx + 1] : undefined;
      if (!prev) {
        await this.reply(messageId, '没有更早的话题了。回 /topics 看列表。');
        return true;
      }
      setActive(this.agentId, externalKey, prev.id);
      await this.reply(messageId, `已退回《${displayNameOf(prev)}》。`);
      return true;
    }

    const isClear = CLEAR_COMMANDS.has(key);
    if (!isClear && !HELP_COMMANDS.has(key)) return false;

    const session = current();
    if (!isClear) {
      const extra = topicMode
        ? '/new [标题] —— 开一个新话题\n/topics —— 列出这个窗口的话题\n' +
          '/resume 序号 —— 切回某个话题\n/back —— 退回上一个话题\n'
        : '';
      await this.reply(
        messageId,
        `可用的会话命令：\n${extra}` +
          '/clear —— 清空本会话上下文（会话保留，下一条消息当新话题处理）\n' +
          '（只影响这个飞书会话，不会动别处）',
      );
      return true;
    }

    const r = clearSession(this.agentId, session.id);
    await this.reply(
      messageId,
      r.ok
        ? `已清空本会话上下文（归档 ${r.files} 个 pi 会话文件；会话保留，映射与命名不变）。` +
            `下一条消息我当新话题处理。`
        : '清空失败：没找到对应会话。',
    );
    console.log(`[feishu:${this.wakerId}] 按命令清空会话 ${session.id}（归档 ${r.files} 个文件）`);
    return true;
  }

  /**
   * 发话题列表卡（`/topics` 与询问卡上的「看看全部话题」共用）。
   *
   * 两条入口的差别只有 externalKey 从哪来：命令来自当前消息，按钮回调来自
   * 「哪个窗口有待答提问」的探测。列表内容与「切到这儿」的行为必须完全一致，
   * 所以只写这一份。
   */
  private async sendTopicList(messageId: string, externalKey: string): Promise<void> {
    const conv = getConversation(this.agentId, externalKey);
    // 列**该员工全部会话**，不只这个窗口装过的：
    // 用户要的是"找回原来聊过的那件事"，不该因为他当时在网页里聊就找不到。
    const chambers = this.agentSessions();
    if (!chambers.length) {
      await this.reply(messageId, '这个窗口还没有历史话题。');
      return;
    }
    // 每条的摘要进折叠面板：光有标题，相近的两个话题根本分不清谁是谁。
    // 卡片只放前 15 个：再多就是一屏点不完，序号仍与 `/resume` 全量列表一致。
    const shown = chambers.slice(0, 15);
    const items: TopicListItem[] = [];
    let pendingCards = 0;
    for (let i = 0; i < shown.length; i += 1) {
      const s = shown[i]!;
      const recap = this.recapForList(s);
      if (!recap.hasCard) {
        pendingCards += 1;
        // 缺卡的会话顺手记一笔，后台扫描器（闲置 10 分钟、每次只跑一个）下一轮补上。
        // 不在这里同步生成：8 张卡就是 8 次推理，用户等不起。
        markSessionDirty(this.agentId, s.id, DEFAULT_SESSION_CONFIG.summary.minNewMessages);
      }
      items.push({
        index: i + 1,
        id: s.id,
        title: displayNameOf(s),
        meta: `${relTime(s.lastActiveAt)} · ${s.messageCount} 条`,
        recap: recap.text,
        current: conv?.activeSessionId === s.id,
      });
    }
    const { card, fallback } = composeTopicList(items, chambers.length, pendingCards);
    await this.sendRich('reply', messageId, fallback, card);
  }

  // —————————————— topic 模式：换弹巢 ——————————————

  /**
   * topic 模式下的一轮对话。
   *
   * 顺序不能反：**待确认优先**。否则用户在回答"要不要切"时，那句"1"会被当成
   * 新话题再判定一次，直接套娃。
   */
  private async handleTopicTurn(args: {
    text: string;
    /** 本次消息携带的附件（图片/文件）绝对路径，随这一轮一起交给 pi。 */
    attachments?: string[];
    externalKey: string;
    messageId: string;
    displayName: string;
  }): Promise<void> {
    const { text, attachments, externalKey, messageId, displayName } = args;
    const wakerId = this.agentId;
    const cfg = this.sessionCfg;

    const existing = getConversation(wakerId, externalKey);
    if (existing?.pending) {
      const pendingAsk = existing.pending;
      const ids = pendingAsk.candidateIds ?? [];
      // 新版卡片一定带 candidateIds（可能是空数组）；旧卡片（升级前发出的）没有这个字段。
      // 两种卡片的数字含义不同，必须分开判，否则升级瞬间正在回答的那张卡会错位。
      const isNewCard = Array.isArray(pendingAsk.candidateIds);
      const plain = text.trim().replace(/[。！!？?，,、\s]/g, '');
      const n = /^\d+$/.test(plain) ? Number(plain) : 0;
      // 从发卡到用户回复的间隔：账本里用它区分"想了一下才选"和"秒回"
      const latencyMs = pendingAsk.askedAt ? Date.now() - Date.parse(pendingAsk.askedAt) : undefined;

      // 新卡片的编号与按钮同序：1..N = 切到第 N 条候选，N+1 = 留在当前，N+2 = 看全部话题。
      // 卡片发不出去时这是唯一入口，所以数字映射必须和 `composeTopicAsk` 的退路逐字对应。
      if (isNewCard && n >= 1 && n <= ids.length) {
        this.logDecisionAnswer(pendingAsk.decisionId, externalKey, 'candidate', {
          sid: ids[n - 1],
          via: 'number',
          latencyMs,
        });
        await this.applyPending(
          externalKey,
          { ...pendingAsk, action: 'switch', targetSessionId: ids[n - 1]! },
          messageId,
          displayName,
        );
        return;
      }
      if (isNewCard && n === ids.length + 1) {
        this.logDecisionAnswer(pendingAsk.decisionId, externalKey, 'stay', { via: 'number', latencyMs });
        bumpReject(wakerId, externalKey);
        const stay = resolveSession(wakerId, existing.activeSessionId);
        this.logDecisionFinal(pendingAsk.decisionId, externalKey, 'stay', stay, 'ask-rejected');
        const out = await this.runIn(stay, pendingAsk.message);
        await this.reply(messageId, `**好，留在《${displayNameOf(stay)}》继续**\n\n${out}`);
        return;
      }
      if (
        (isNewCard && n === ids.length + 2) ||
        (!isNewCard && /^(3|话题列表|\/?topics?)$/i.test(plain))
      ) {
        this.logDecisionAnswer(pendingAsk.decisionId, externalKey, 'list', { via: 'number', latencyMs });
        this.logDecisionFinal(pendingAsk.decisionId, externalKey, 'list', undefined, 'ask-list');
        await this.sendTopicList(messageId, externalKey);
        return;
      }
      // 「以上都不是」：卡片发不出去时的文字入口（N+3 / 直接说这几个字）
      if ((isNewCard && n === ids.length + 3) || /^以上都不是$/.test(plain)) {
        this.logDecisionAnswer(pendingAsk.decisionId, externalKey, 'none', { via: 'number', latencyMs });
        bumpReject(wakerId, externalKey);
        const stay = resolveSession(wakerId, existing.activeSessionId);
        this.logDecisionFinal(pendingAsk.decisionId, externalKey, 'stay', stay, 'candidates-all-wrong');
        const out = await this.runIn(stay, pendingAsk.message);
        await this.reply(messageId, `**收到，这次候选都不对**\n\n${out}`);
        return;
      }

      // 旧卡片（存量 pending 没有 candidateIds）沿用 1 = 切 / 2 = 留
      const ans = normalizeAnswer(text);
      if (ans === 'yes') {
        this.logDecisionAnswer(pendingAsk.decisionId, externalKey, 'candidate', {
          sid: pendingAsk.targetSessionId,
          via: 'text-yes',
          latencyMs,
        });
        await this.applyPending(externalKey, pendingAsk, messageId, displayName);
        return;
      }
      if (ans === 'no') {
        this.logDecisionAnswer(pendingAsk.decisionId, externalKey, 'stay', { via: 'text-no', latencyMs });
        bumpReject(wakerId, externalKey);
        const stay = resolveSession(wakerId, existing.activeSessionId);
        this.logDecisionFinal(pendingAsk.decisionId, externalKey, 'stay', stay, 'ask-rejected');
        const out = await this.runIn(stay, pendingAsk.message);
        await this.reply(messageId, `**好，留在《${displayNameOf(stay)}》继续**\n\n${out}`);
        return;
      }
      // 说了别的 → 放弃这次询问，按新问题走（这也是重要负样本：候选里没有他想要的）
      this.logDecisionAnswer(pendingAsk.decisionId, externalKey, 'text', {
        typed: text.slice(0, 200),
        latencyMs,
      });
      clearPending(wakerId, externalKey);
    }

    const { session } = resolveConversationSession({
      wakerId,
      key: externalKey,
      displayName,
      mode: cfg.mode,
    });

    // 带附件的消息**不进话题路由**，直接落在当前会话。
    // 两个原因：
    //  1. 询问卡是纯文本交互，`setPending` 只存 prompt 字符串，回答时附件早已被清理，
    //     用户回了「切过去」之后模型看到的是没有图的问题 —— 比不切更糟；
    //  2. 图片本身没有可靠的语义文本可判定话题（默认话术「帮我看看这个」判什么都像新话题）。
    // 代价是"发图时想顺手切话题"要分两步做，这个取舍明确写在 CHANGELOG 里。
    if (attachments?.length) {
      const out = await this.runIn(session, text, attachments);
      await this.reply(messageId, out);
      return;
    }

    // 显式换话题：句首出现「新话题 / 换个话题 / 说点别的」就直接开新弹巢，不调模型、不问。
    // 这是**指令**不是**内容**，向量天生读不懂——踩过：「新话题」三个字与 42 条的创业会话
    // 余弦 0.55，落在模糊带 → 静默继续 → 用户以为功能坏了。0 延迟、0 成本、确定性。
    const explicit = matchExplicitNewTopic(text);
    if (explicit) {
      const title = explicit.title ? deriveTitle(explicit.title) : undefined;
      const opened = openNewChamber(wakerId, externalKey, title);
      patchSession(wakerId, session.id, { transferredTo: opened.session.id });
      if (!title) {
        await this.reply(messageId, `已开新话题《${displayNameOf(opened.session)}》。想聊什么？`);
        return;
      }
      const out = await this.runIn(opened.session, explicit.title!);
      await this.reply(messageId, `**已开新话题《${title}》**\n\n${out}`);
      return;
    }

    // 候选覆盖该员工全部会话（不只本窗口装过的），否则"网页里聊过的创业话题"
    // 在飞书里永远找不回来——实测就是这个原因导致该切没切。
    const chambers = this.agentSessions();
    // 先不截断：索引模式要按分数挑候选，按活跃度截 8 个会把"很久没动但正是这个"的会话切掉。
    const candidates = chambers.filter((s) => s.id !== session.id);

    // 后台增量索引：写入时把每句话算好，查询时只 embed 这一句。
    // 整库首次建可能要几十秒，所以**绝不 await**，这一轮先用现有缓存（不足则回落到现场切块）。
    void this.refreshSessionIndex(chambers);

    let semantic: SemanticInput | null = null;
    let ranked: SessionMeta[] = [];
    let sessionScores: SessionScore[] | null = null;
    let indexUsed = false;

    if (cfg.mode === 'topic' && cfg.semantic.enabled === 'auto') {
      const indexed = await this.indexRanking({ text, active: session, sessions: chambers, cfg });
      if (indexed) {
        semantic = indexed.sem;
        ranked = indexed.ranked;
        sessionScores = indexed.scores;
        indexUsed = true;
      } else {
        // 索引还不完整（首次启动）：退回原来的现场切块，行为与 2.2.9 一致
        const live = candidates.slice(0, 8);
        semantic = await semanticInputFor({
          message: text,
          active: session,
          candidates: live,
          cfg: {
            enabled: true,
            baseUrl: cfg.semantic.baseUrl,
            model: cfg.semantic.model,
            timeoutMs: cfg.semantic.timeoutMs,
          },
          continueThreshold: cfg.semantic.continueThreshold,
          switchThreshold: cfg.semantic.switchThreshold,
          unrelatedThreshold: cfg.semantic.unrelatedThreshold,
        });
        ranked = rankCandidatesBySemantic(live, semantic);
      }
    }

    let decision =
      cfg.mode === 'timeWindow'
        ? decideTimeWindow({
            now: Date.now(),
            lastActiveAt: session.lastActiveAt,
            idleSplitHours: cfg.idleSplitHours,
          })
        : decideRoute({
            message: text,
            now: Date.now(),
            active: this.routeSessionOf(session),
            candidates: candidates.map((s) => this.routeSessionOf(s)),
            config: { idleSplitHours: cfg.idleSplitHours },
            semantic: semantic ?? undefined,
          });

    // 向量只负责召回上面的 candidates；最终「继续 / 新话题 / 切回哪个」交给小模型。
    // timeWindow 刻意不看内容，跳过；仲裁不可用它返回 null，decision 保持阈值判定的结果。
    //
    // **喂给仲裁的顺序必须是"像不像"，不是"谁最近聊过"**：仲裁只读前 5 个候选，
    // 按活跃度排时最像的旧话题常常进不了选项。实测 2026-11-08：用户发「esp32-cam」
    // 想切回同名旧会话，它按活跃度排第 8、语义相似度 1.0，模型只看到另外 5 个 → 判"新话题"。
    //
    // 而"几乎逐字命中旧话题"这种确定性证据要**优先于小模型**：同一批实测里，
    // 补上候选后 laya 仍在这个输入上近乎均匀地瞎猜（confidence 0.056，会挑到播客）。
    // 所以先看 strongSemanticPick，命中了就不再问模型；没命中才走仲裁。
    const strongTarget = strongSemanticPick(decision.signals);
    let arbiter: ArbiterResult | null = null;
    /** 仲裁这一票最后有没有生效：写进账本，调门禁时先看被丢掉的那些。 */
    let arbiterVerdict: 'strong' | 'keep' | 'drop' | null = null;
    if (strongTarget) {
      arbiterVerdict = 'strong';
      decision = {
        ...decision,
        action: 'switch',
        targetSessionId: strongTarget,
        confidence: 0.9,
        reason:
          `语义几乎逐字命中旧话题（${(decision.signals.semanticBest ?? 0).toFixed(2)}` +
          ` vs 当前 ${(decision.signals.semanticActive ?? 0).toFixed(2)}）`,
      };
    } else if (cfg.mode !== 'timeWindow') {
      const arbiterInput = {
        message: text,
        active: session,
        candidates: ranked,
        recent: this.recentTurnsOf(session.id),
      };
      const arbiterCfg = { ...DEFAULT_ARBITER_CONFIG, ...(cfg.arbiter ?? {}) };
      const pair = arbitratePair(arbiterInput, arbiterCfg);
      arbiter = await pair.main;
      // 主模型结果确定后再挂影子（影子可能早就算完了，then 会立刻执行）。
      // 不能放在 await 之前：那时 arbiter 还是 null，取不到对照里的"主答案"。
      const mainAnswer = arbiter
        ? { action: arbiter.action, target: arbiter.targetSessionId }
        : null;
      void pair.shadow.then((shadow) => {
        if (!shadow) return;
        this.logShadow({
          externalKey,
          sessionId: session.id,
          message: text,
          mainModel: arbiterCfg.model,
          main: mainAnswer,
          shadow,
        });
      });
      // 仲裁有"一票改成 switch"的权力，但它实测不可靠（44 次判定里只有 3 次目标与语义最像的一致，
      // 自报 confidence 0.06~0.4，却按 0.75 放行）。所以 switch 必须有语义背书：
      // 目标在语义前 3、离第一名 ≤0.05、且比当前会话像 ≥0.08；不满足就丢弃这次意见，退回阈值判定。
      // 这条挡的正是 03:35「摄像头装到了开发板上」被切去《周报复盘》（只领先 0.041）那种误切。
      if (arbiter) {
        const ok =
          arbiter.action !== 'switch' ||
          arbiterSwitchConsistent({
            sem: semantic,
            rankedIds: ranked.map((s) => s.id),
            targetSessionId: arbiter.targetSessionId ?? '',
            activeScore: decision.signals.semanticActive ?? 0,
          });
        if (ok) {
          arbiterVerdict = 'keep';
          decision = decisionFromArbiter(arbiter, decision, session.id);
        } else {
          arbiterVerdict = 'drop';
          console.log(
            `[feishu:${this.wakerId}] 忽略仲裁的切换建议 → ${arbiter.targetSessionId}` +
              `（语义不背书：best ${(decision.signals.semanticBest ?? 0).toFixed(2)}` +
              ` vs 当前 ${(decision.signals.semanticActive ?? 0).toFixed(2)}）`,
          );
        }
      }
    }

    this.logRoute(
      externalKey,
      session.id,
      decision,
      cfg.semantic.enabled === 'auto' && semantic === null,
      arbiter,
    );

    const conv = getConversation(wakerId, externalKey);
    // 能不能不问就落指针，统一由询问门判：`autoSwitch: false` 时恒为 ask，
    // 拒绝配额用尽也只是 stay（不切），不会滑到下面的 auto 分支。
    const gate = decideAskGate({
      ask: cfg.ask,
      autoSwitch: cfg.autoSwitch !== false,
      rejectStreak: conv?.rejectStreak ?? 0,
      rejectLimit: cfg.rejectLimit,
    });

    // 决策账本：一条消息一个 id，后续 ask / answer / final 都挂在它上面。
    // 与 routing.jsonl 的区别是这里带候选分数与询问门快照，专门用于"能不能更好"。
    const decisionId = newDecisionId();
    this.logDecisionRoute(decisionId, externalKey, {
      text,
      session,
      semantic,
      semanticModel: cfg.semantic.model,
      ranked,
      strongTarget,
      arbiter,
      arbiterVerdict,
      decision,
      gate,
      cfg,
      rejectStreak: conv?.rejectStreak ?? 0,
      sessionScores,
      indexUsed,
    });

    // 低置信不切（fail-open）：宁可少切一次，也不要因为一次模糊判断把用户搬到别的会话。
    // 没有这一步，"置信度不足"会顺着下面的 auto 分支变成"静默切换"——正好反了。
    if (decision.action !== 'continue' && decision.confidence < 0.5) {
      this.logDecisionFinal(decisionId, externalKey, 'stay', session, 'low-confidence');
      const out = await this.runIn(session, text);
      await this.reply(messageId, out);
      return;
    }

    if (decision.action === 'continue') {
      this.logDecisionFinal(decisionId, externalKey, 'stay', session, 'continue');
      const out = await this.runIn(session, text);
      await this.reply(messageId, out);
      return;
    }

    const target =
      decision.action === 'switch' ? chambers.find((s) => s.id === decision.targetSessionId) : undefined;

    // 目标找不到、或目标就是当前会话 —— 按"继续"作答，既不问也不切。
    // 为什么不能放过去：下面 switch 落空时会掉进 auto 分支的 openNewChamber，
    // 等于把"切回自己"变成"白开一个新弹巢"，正是最贵的错。
    if (decision.action === 'switch' && (!target || target.id === session.id)) {
      this.logDecisionFinal(decisionId, externalKey, 'stay', session, 'invalid-target');
      const out = await this.runIn(session, text);
      await this.reply(messageId, out);
      return;
    }

    if (gate === 'ask') {
      // 列**多个**候选（最多 3 条，按语义相似度排序），而不是只摆一个猜测：
      // 判错时用户点另一个按钮就能纠正。仲裁指向的那条必须在列表里且排第一，
      // 否则"第一个选项"本身就是错的。
      let shown = ranked.slice(0, ASK_CANDIDATES);
      if (target && !shown.some((s) => s.id === target.id)) {
        shown = [target, ...shown.slice(0, ASK_CANDIDATES - 1)];
      }
      setPending(wakerId, externalKey, {
        action: decision.action,
        targetSessionId: target?.id,
        message: text,
        askedAt: new Date().toISOString(),
        reason: decision.reason,
        candidateIds: shown.map((s) => s.id),
        decisionId,
      });
      // 账本里的 ask 事件：用户实际看到的候选（顺序 = 按钮顺序），
      // 后面 answer/final 用它算"推荐准不准、用户改成了哪条"。
      appendDecision({
        evt: 'ask',
        id: decisionId,
        at: new Date().toISOString(),
        key: externalKey,
        shown: shown.map((s, i) => {
          const score = semanticScoreOf(semantic, s.id);
          return { rank: i + 1, id: s.id, name: displayNameOf(s), score: score === undefined ? null : Number(score.toFixed(3)) };
        }),
        proposed: decision.action,
        proposedTarget: target?.id ?? null,
        cardButtons: shown.length + 2,
      });
      const body = this.askText(decision.action, session, text, shown.length);
      await this.replyAskCard(messageId, body, session, shown);
      return;
    }

    // 询问配额用尽：不再打扰，也不替用户换会话（"退化成不切"，不是"退化成直接切"）
    if (gate === 'stay') {
      this.logDecisionFinal(decisionId, externalKey, 'stay', session, 'ask-quota-exhausted');
      const out = await this.runIn(session, text);
      await this.reply(messageId, out);
      return;
    }

    // auto 模式：直接切，但必须告知（用户得知道自己现在踩在哪块地上）
    let prefix = '';
    let next: SessionMeta;
    if (decision.action === 'switch' && target) {
      setActive(wakerId, externalKey, target.id);
      patchSession(wakerId, session.id, { transferredTo: target.id });
      next = target;
      prefix = `**已切到《${displayNameOf(target)}》**\n\n`;
      this.logDecisionFinal(decisionId, externalKey, 'switch', target, 'auto-switch');
    } else {
      const opened = openNewChamber(wakerId, externalKey, deriveTitle(text));
      patchSession(wakerId, session.id, { transferredTo: opened.session.id });
      next = opened.session;
      prefix = `**已开新话题《${displayNameOf(next)}》**\n\n`;
      this.logDecisionFinal(decisionId, externalKey, 'new', next, 'auto-new');
    }
    const out = await this.runIn(next, text);
    await this.reply(messageId, `${prefix}${out}`);
  }

  /** 用户点了"切回去/开新话题"之后：落指针、留痕、把原话带过去并直接作答。 */
  private async applyPending(
    externalKey: string,
    pending: {
      action: 'switch' | 'new';
      targetSessionId?: string;
      message: string;
      /** 决策账本 id（老 pending 可能没有）。 */
      decisionId?: string;
      askedAt?: string;
    },
    messageId: string,
    displayName: string,
  ): Promise<void> {
    const wakerId = this.agentId;
    // 先清掉待答状态：文字回答和按钮回答共用这条路径，重复触发（连点两下 / 手快既点按钮又回 1）
    // 必须只能生效一次，否则会把同一句话跑两遍、甚至把指针连着搬两次。
    clearPending(wakerId, externalKey);
    const conv = getConversation(wakerId, externalKey);
    const current = conv
      ? resolveSession(wakerId, conv.activeSessionId)
      : resolveConversationSession({ wakerId, key: externalKey, displayName, mode: this.sessionCfg.mode }).session;

    let target: SessionMeta;
    let note: string;
    if (pending.action === 'switch' && pending.targetSessionId) {
      const picked = resolveSession(wakerId, pending.targetSessionId);
      // 落指针前再比一次：卡片发出到用户点确认之间，指针可能已经变了——
      // 人在看板/网页手动切到了目标，或目标被删后 resolveSession 回落成默认会话
      // （正好就是当前这块弹巢）。这时 setActive 是空转，还会写出「接续自自己」的留痕，
      // 所以退化成"就在这边说"，不报告一次并不存在的切换。
      if (picked.id === current.id) {
        this.logDecisionFinal(pending.decisionId, externalKey, 'stay', current, 'target-is-current');
        const out = await this.runIn(current, pending.message);
        await this.reply(
          messageId,
          `《${displayNameOf(current)}》就是当前话题，没有切换。\n` +
            `你说：「${clip(pending.message, 60)}」\n────────\n${out}`,
        );
        return;
      }
      target = picked;
      setActive(wakerId, externalKey, target.id);
      // 接受了一次切换 = 询问功能对用户有效，连续拒绝计数清零
      resetReject(wakerId, externalKey);
      patchSession(wakerId, current.id, { transferredTo: target.id });
      this.logDecisionFinal(pending.decisionId, externalKey, 'switch', target, 'ask-accepted');
      const recap = (await this.recapOf(target.id)).split('\n').slice(0, 4).join('\n');
      note = `**已切到《${displayNameOf(target)}》**${recap ? `\n\n**上次到这里**\n${recap}` : ''}`;
    } else {
      const opened = openNewChamber(wakerId, externalKey, deriveTitle(pending.message));
      patchSession(wakerId, current.id, { transferredTo: opened.session.id });
      target = opened.session;
      this.logDecisionFinal(pending.decisionId, externalKey, 'new', target, 'ask-accepted');
      note = `**已开新话题《${displayNameOf(target)}》**`;
    }

    const out = await this.runIn(target, pending.message);
    await this.reply(
      messageId,
      `${note}\n你说：「${clip(pending.message, 60)}」\n────────\n${out}`,
    );
  }

  /**
   * 列表卡上「切到这儿」：只落指针，**不重放任何用户原话**。
   *
   * 与 `applyPending` 的本质区别：那条路径有一句"待答的原话"，切过去要接着作答；
   * 列表卡没有原话——用户只是想让下一条消息装进另一块弹巢。
   * 目标就是当前会话时同样只说一句实话，不报"已切到"。
   */
  private async applyPick(
    sessionId: string,
    key: string,
    messageId: string,
    decisionId?: string,
  ): Promise<void> {
    const wakerId = this.agentId;
    if (!key) {
      if (messageId) await this.reply(messageId, '这条卡片对应的窗口已经找不到了。回 /topics 重新列一次。');
      return;
    }
    if (this.busy.has(key)) {
      if (messageId) await this.reply(messageId, `${this.busyHint(key)}请稍后再点。`);
      return;
    }
    const target = listSessions(wakerId).find((s) => s.id === sessionId);
    if (!target) {
      if (messageId) await this.reply(messageId, '这个话题已经不在了。回 /topics 重新列一次。');
      return;
    }
    const conv = getConversation(wakerId, key);
    const current = conv ? resolveSession(wakerId, conv.activeSessionId) : undefined;
    if (current?.id === target.id) {
      this.logDecisionFinal(decisionId, key, 'stay', target, 'pick-is-current');
      if (messageId) await this.reply(messageId, `《${displayNameOf(target)}》就是当前话题，不用切。`);
      return;
    }
    if (current) patchSession(wakerId, current.id, { transferredTo: target.id });
    setActive(wakerId, key, target.id);
    // 从列表里自己挑了话题 → 同「接受切换」，连续拒绝计数清零（否则拒绝 2 次后永不再问）
    resetReject(wakerId, key);
    this.logDecisionFinal(decisionId, key, 'switch', target, 'manual-pick');
    const recap = (await this.recapOf(target.id)).split('\n').slice(0, 4).join('\n');
    if (messageId) {
      await this.reply(messageId, `已切到《${displayNameOf(target)}》。${recap ? `\n\n${recap}` : ''}`);
    }
  }

  /**
   * 一次卡片点击的**同步判定**：点了哪个按钮、属于哪个窗口、提问还在不在、忙不忙。
   *
   * 为什么必须是同步的：`card.action.trigger` 的 ack 里可以**顺手带回一张新卡片**，
   * 那是"按钮消失 / 写明点了哪个 / ⏳ 处理中"唯一不产生额外请求的做法（见 `cardAckOf`）。
   * 而 ack 迟到会被飞书重投（理由见 start() 里的长注释），所以这里只读内存与本地文件，
   * 不做任何网络请求。
   *
   * 回调体里**没有** `chat_type`，算不出唯一的 externalKey —— 只能把候选键都试一遍，
   * 取"确实有待答提问"的那个，绝不猜。
   */
  private planCardAction(event: Any): CardClick {
    const answer = parseTopicCardAction(event);
    const pickSessionId = parseTopicPick(event) ?? undefined;
    const chooseSessionId = parseTopicChoose(event) ?? undefined;
    const wantTopicList = parseTopicListRequest(event);
    const rejectAll = parseTopicNone(event);
    const { chatId, openId, messageId } = parseTopicCardContext(event);
    const wakerId = this.agentId;

    // 群聊按发言人 → 群聊整体（single 模式与早期键）→ 私聊；空键丢掉
    const keys = [
      conversationKeyOf({ kind: 'group', userId: openId, chatId, mode: this.sessionCfg.mode }),
      `feishu:g_${chatId}`,
      conversationKeyOf({ kind: 'p2p', userId: openId, chatId, mode: this.sessionCfg.mode }),
    ].filter((k, i, arr) => k && k !== 'feishu:g_' && k !== 'feishu:u_' && arr.indexOf(k) === i);

    // 询问卡上的「看看全部话题」：不回答 yes/no，也不改指针，只需要能对回一个窗口发列表卡。
    // 同样**不看 pending**：那张卡可能已经处理过，列表照样该能列出来。
    if (wantTopicList) {
      const listKey = keys.find((k) => Boolean(getConversation(wakerId, k))) ?? '';
      return { answer: null, wantTopicList: true, key: listKey, busy: false, messageId };
    }

    // 「以上都不是」：不改指针，只记一次"候选全错"（最有价值的负样本）。
    if (rejectAll) {
      let noneKey = '';
      let nonePending: PendingAsk | undefined;
      for (const k of keys) {
        const conv = getConversation(wakerId, k);
        if (conv?.pending) {
          noneKey = k;
          nonePending = conv.pending;
          break;
        }
      }
      if (!noneKey) noneKey = keys.find((k) => Boolean(getConversation(wakerId, k))) ?? '';
      return { answer: null, rejectAll: true, key: noneKey, pending: nonePending, busy: false, messageId };
    }

    // 询问卡上的候选话题（「切到《X》」）：**优先找有待答提问的窗口**（要接续原话作答）；
    // 找不到就退化成"只搬指针"——卡片可能已经过期，但切话题本身仍然有意义。
    if (chooseSessionId) {
      let chooseKey = '';
      let choosePending: PendingAsk | undefined;
      for (const k of keys) {
        const conv = getConversation(wakerId, k);
        if (conv?.pending) {
          chooseKey = k;
          choosePending = conv.pending;
          break;
        }
      }
      if (!chooseKey) chooseKey = keys.find((k) => Boolean(getConversation(wakerId, k))) ?? '';
      return {
        answer: null,
        chooseSessionId,
        key: chooseKey,
        pending: choosePending,
        busy: !!chooseKey && this.busy.has(chooseKey),
        messageId,
      };
    }

    // 列表卡上的「切到这儿」：**不看 pending**。那张卡可能是几分钟前发的，
    // 期间用户还发过别的消息；只要能把卡片对回这个窗口，目标 id 由卡片自己带。
    if (pickSessionId) {
      const pickKey = keys.find((k) => Boolean(getConversation(wakerId, k))) ?? '';
      return {
        answer: null,
        pickSessionId,
        key: pickKey,
        busy: !!pickKey && this.busy.has(pickKey),
        messageId,
      };
    }

    let key = '';
    let pending: PendingAsk | undefined;
    for (const k of keys) {
      const conv = getConversation(wakerId, k);
      if (conv?.pending) {
        key = k;
        pending = conv.pending;
        break;
      }
    }

    return { answer, key, pending, busy: !!key && this.busy.has(key), messageId };
  }

  /** 用户点的那个按钮叫什么。`no` 现在明确叫「留在当前话题」（旧文案「就在这儿继续」没说清留下的是哪条）。 */
  private chosenLabel(answer: TopicAnswer, pending?: PendingAsk): string | undefined {
    if (answer === 'no') return '留在当前话题';
    if (!pending) return undefined;
    return pending.action === 'new' ? '开新话题' : '切回去';
  }

  /**
   * ack 回给飞书的内容：toast + **更新后的卡片**。
   *
   * 只给 toast 是不够的（实测反馈：按钮不变灰、不显示点了什么、不知道还在不在处理）。
   * 三种情形对应三种"别让用户猜"：
   *  - 能处理 → 卡片进 `processing` 态：按钮消失（2.0 没有 disabled 语义，删掉才真的点不到）、
   *    写明"已选择：X"、加 ⏳ 说明正在接着回答；
   *  - 上一条还在跑 → **保留原按钮**，只给警告 toast。此时把卡片刷成"处理中"就是撒谎；
   *  - 提问已经没了（被文字回答 / 过期）→ 进 `expired` 态，别留下能点却没反应的按钮。
   *
   * 返回值会被 WS 客户端原样塞进 ack 的 data 里回给飞书；`card.type='raw'` 的 data
   * 就是整张新卡片。卡片在本地生成，不发网络请求，所以不违反"ack 必须立刻返回"。
   */
  private cardAckOf(click: CardClick): Any {
    // 「看看全部话题」：原卡片不动（用户可能还想点候选），只回一句 toast
    if (click.wantTopicList) {
      return { toast: { type: 'info', content: '正在列出全部话题…' } };
    }
    // 「以上都不是」：不替换卡片（用户可能还要看候选），只说收到
    if (click.rejectAll) {
      return { toast: { type: 'info', content: '已记下：这次候选都不对' } };
    }
    // 询问卡上的候选：有 pending 就"切过去并接着答"，没有就只搬指针
    if (click.chooseSessionId) {
      const hit = listSessions(this.agentId).find((s) => s.id === click.chooseSessionId);
      if (!hit) return { toast: { type: 'warning', content: '这个话题已经不在了' } };
      const label = `切到《${displayNameOf(hit)}》`;
      if (click.busy) return { toast: { type: 'warning', content: '上一条还在处理，稍后再点' } };
      return click.pending
        ? {
            toast: { type: 'info', content: `已选择：${label}，正在处理…` },
            card: { type: 'raw', data: buildTopicCardState('processing', label) },
          }
        : { toast: { type: 'info', content: `正在${label}…` } };
    }
    // 列表卡：只回 toast，**不替换原卡片**——那张卡上还有别的话题可以点
    if (click.pickSessionId) {
      const hit = listSessions(this.agentId).find((s) => s.id === click.pickSessionId);
      return {
        toast: {
          type: hit ? 'info' : 'warning',
          content: hit ? `正在切到《${displayNameOf(hit)}》…` : '这个话题已经不在了',
        },
      };
    }
    // 不是话题卡片的按钮（以后别的卡片也走这条链）：静默忽略，别打扰用户
    if (!click.answer) return {};
    const label = this.chosenLabel(click.answer, click.pending);

    if (!click.key || !click.pending) {
      return {
        toast: { type: 'warning', content: '这次提问已经处理过了' },
        ...(click.messageId ? { card: { type: 'raw', data: buildTopicCardState('expired', label) } } : {}),
      };
    }
    if (click.busy) {
      return { toast: { type: 'warning', content: '上一条还在处理，稍后再点' } };
    }
    return {
      toast: { type: 'info', content: `已选择：${label}，正在处理…` },
      card: { type: 'raw', data: buildTopicCardState('processing', label) },
    };
  }

  /**
   * 真正干活：切会话 / 开新话题，然后作答。
   *
   * 三处与 IM 消息不同，都是会踩坑的地方：
   *  1. **必须立刻返回**：ack 迟到会被飞书重投（理由见 start() 里的长注释），
   *     所以入口只做 fire-and-forget，真正的回复走 REST 另发一条；
   *  2. `open_message_id` 是**那张卡片**的消息 id，回复直接挂在它下面，
   *     视觉上就贴在提问旁边；
   *  3. 干完必须把卡片从 ⏳ 刷成终态，否则"处理中"会一直留在历史里（见 `settleCard`）。
   */
  private async runCardAction(click: CardClick): Promise<void> {
    const { answer, key, pending, messageId, pickSessionId, chooseSessionId, wantTopicList } = click;
    // 真机排查全靠这一行：卡片回调里没有"消息原文"可看，出问题时只有日志能说明
    // 「点到了什么 / 有没有对应窗口 / 是不是在忙」。
    const what = wantTopicList
      ? '看全部话题'
      : click.rejectAll
        ? '以上都不是'
        : chooseSessionId
          ? `切到 ${chooseSessionId}`
          : pickSessionId
            ? `切到 ${pickSessionId}`
            : answer;
    console.log(
      `[feishu:${this.wakerId}] 卡片点击：${what}` +
        `${key ? '' : '（没有可对应的窗口）'}${click.busy ? '（忙，未处理）' : ''}`,
    );
    // 「看看全部话题」：只发列表卡。不改指针、不重放原话；pending 留着，用户可能再点候选
    if (wantTopicList) {
      this.logDecisionAnswer(pending?.decisionId, key, 'list', { via: 'button' });
      await this.sendTopicList(messageId, key);
      return;
    }
    // 「以上都不是」：记负样本，然后留在当前继续作答（不切、不重放）
    if (click.rejectAll) {
      if (!key || !pending) {
        if (messageId) await this.reply(messageId, '这次提问已经处理过了。直接说要聊什么就行。');
        return;
      }
      this.logDecisionAnswer(pending.decisionId, key, 'none', {
        via: 'button',
        latencyMs: pending.askedAt ? Date.now() - Date.parse(pending.askedAt) : undefined,
      });
      bumpReject(this.agentId, key);
      clearPending(this.agentId, key);
      const conv = getConversation(this.agentId, key);
      const stay = conv ? resolveSession(this.agentId, conv.activeSessionId) : resolveSession(this.agentId);
      this.logDecisionFinal(pending.decisionId, key, 'stay', stay, 'candidates-all-wrong');
      this.busy.set(key, Date.now());
      try {
        const out = await this.runIn(stay, pending.message);
        await this.reply(messageId, `**收到，这次候选都不对**\n\n${out}`);
      } finally {
        this.busy.delete(key);
        await this.settleCard(messageId, 'done', '以上都不是');
      }
      return;
    }
    // 询问卡上的候选：有 pending 就带原话切过去并作答，没有就只落指针
    if (chooseSessionId) {
      if (key && pending) {
        this.logDecisionAnswer(pending.decisionId, key, 'candidate', {
          sid: chooseSessionId,
          via: 'button',
          latencyMs: pending.askedAt ? Date.now() - Date.parse(pending.askedAt) : undefined,
        });
        if (click.busy) {
          if (messageId) await this.reply(messageId, `${this.busyHint(key)}请稍后再点。`);
          return;
        }
        this.busy.set(key, Date.now());
        let ok = true;
        const targetRec = listSessions(this.agentId).find((s) => s.id === chooseSessionId);
        const label = targetRec ? `切到《${displayNameOf(targetRec)}》` : '切到所选话题';
        try {
          await this.applyPending(
            key,
            { ...pending, action: 'switch', targetSessionId: chooseSessionId },
            messageId,
            '飞书',
          );
        } catch (e) {
          ok = false;
          console.error(`[feishu:${this.wakerId}] 候选话题处理失败:`, (e as Error)?.message ?? e);
          await this.reply(messageId, `处理失败：${(e as Error)?.message ?? e}`);
        } finally {
          this.busy.delete(key);
          await this.settleCard(messageId, ok ? 'done' : 'failed', label);
        }
      } else {
        await this.applyPick(chooseSessionId, key, messageId, pending?.decisionId);
      }
      return;
    }
    // 列表卡：只落指针，没有"原话"要接着答
    if (pickSessionId) {
      await this.applyPick(pickSessionId, key, messageId, pending?.decisionId);
      return;
    }
    if (!answer) return;

    // 提问已被文字回答 / 过期 / 不是这个窗口的卡片：不猜，说清楚就行
    if (!key || !pending) {
      if (messageId) await this.reply(messageId, '这次提问已经处理过了。直接说要聊什么就行。');
      return;
    }
    if (click.busy) {
      if (messageId) await this.reply(messageId, `${this.busyHint(key)}请稍后再点。`);
      return;
    }

    const label = this.chosenLabel(answer, pending);
    this.busy.set(key, Date.now());
    let ok = true;
    try {
      if (answer === 'yes') {
        this.logDecisionAnswer(pending.decisionId, key, 'candidate', {
          sid: pending.targetSessionId,
          via: 'button',
          latencyMs: pending.askedAt ? Date.now() - Date.parse(pending.askedAt) : undefined,
        });
        await this.applyPending(key, pending, messageId, '飞书');
      } else {
        // 就在这儿继续：拒绝记一次（连续拒绝到阈值就不再问了），再把原话在这个会话里答掉
        const conv = getConversation(this.agentId, key);
        const stay = conv ? resolveSession(this.agentId, conv.activeSessionId) : resolveSession(this.agentId);
        this.logDecisionAnswer(pending.decisionId, key, 'stay', {
          via: 'button',
          latencyMs: pending.askedAt ? Date.now() - Date.parse(pending.askedAt) : undefined,
        });
        this.logDecisionFinal(pending.decisionId, key, 'stay', stay, 'ask-rejected');
        bumpReject(this.agentId, key);
        clearPending(this.agentId, key);
        const out = await this.runIn(stay, pending.message);
        await this.reply(messageId, `**好，留在《${displayNameOf(stay)}》继续**\n\n${out}`);
      }
    } catch (e) {
      ok = false;
      console.error(`[feishu:${this.wakerId}] 卡片选择处理失败:`, (e as Error)?.message ?? e);
      await this.reply(messageId, `处理失败：${(e as Error)?.message ?? e}`);
    } finally {
      this.busy.delete(key);
      await this.settleCard(messageId, ok ? 'done' : 'failed', label);
    }
  }

  /**
   * 把询问卡片刷成终态（`done` / `failed`）。
   *
   * **best-effort**：这是整条链路里唯一依赖额外接口能力的一步（`im.v1.message.patch`
   * 对 2.0 卡片是否放行、以及租户权限）。失败只记日志——答案的回复已经发出去了，
   * 卡片停在 ⏳ 也不丢信息，只是多一行"正在处理"的旧痕。
   */
  private async settleCard(messageId: string, phase: TopicCardPhase, label?: string): Promise<void> {
    if (!this.client || !messageId) return;
    try {
      const res = await this.client.im.v1.message.patch({
        path: { message_id: messageId },
        data: { content: JSON.stringify(buildTopicCardState(phase, label)) },
      });
      if (res && res.code !== 0) {
        console.error(`[feishu:${this.wakerId}] 更新询问卡片被拒: ${res.code} ${res.msg}`);
      } else {
        console.log(`[feishu:${this.wakerId}] 询问卡片已更新为 ${phase}`);
      }
    } catch (e) {
      console.error(`[feishu:${this.wakerId}] 更新询问卡片失败（不影响回复）:`, (e as Error)?.message ?? e);
    }
  }

  /**
   * 询问话术：**说清"现在在哪、可能去哪"**，不用"切回去 / 就在这儿"这种方位词。
   *
   * **必须带 markdown 语法**：飞书的回复通道只在检测到 markdown 时才转成卡片
   * （见 sendRich 里的 hasMarkdown 分支），纯文本会退化成一大段文字。
   *
   * 2026-11-08 用户反馈的两处迷惑性：① 正文里 `**上次到这里**` 和会话卡自带的那行重复，
   * 同一句话出现两次；② 「切回去 / 就在这儿继续」都没写清切到哪条、留在哪条。
   * 现在摘要不再进正文（候选有独立按钮，列表卡里还能展开看），正文只交代现场，
   * 目标由按钮标题承担。
   */
  private askText(
    action: 'switch' | 'new',
    current: SessionMeta,
    message: string,
    candidateCount: number,
  ): string {
    return [
      action === 'switch' ? '**这句话可能接着下面某条旧话题**' : '**这看着像个新话题**',
      `**当前在聊**：《${displayNameOf(current)}》`,
      `你刚说：「${clip(message, 40)}」`,
      candidateCount > 0
        ? `下面按「像不像」排了 ${candidateCount} 条，点标题切过去；都不是就留在当前。`
        : '没有找到相近的旧话题。',
    ].join('\n');
  }

  /**
   * 发**带按钮的**询问卡片：N 个候选 + 「留在《当前》」+「看看全部话题」。
   *
   * 卡片的正文**只有问题**：编号那行只出现在纯文本退路里——租户没订阅
   * `card.action.trigger` 时按钮点了没反应，退路里的编号是唯一入口（见 `composeTopicAsk`）。
   */
  private async replyAskCard(
    messageId: string,
    body: string,
    current: SessionMeta,
    candidates: SessionMeta[],
  ): Promise<void> {
    const { card, fallback } = composeTopicAsk({
      body,
      currentTitle: displayNameOf(current),
      candidates: candidates.map((s) => ({ id: s.id, title: displayNameOf(s) })),
    });
    await this.sendRich('reply', messageId, fallback, card);
  }

  /**
   * 读会话卡；没有卡或卡片过期就退回原文摘录。
   *
   * 询问这条路径上不允许有第二次推理——所以这里只读，不生成。
   * 卡由后台在"没人等的时刻"预生成（见 core/sessionSummary）。
   */
  private async recapOf(sessionId: string): Promise<string> {
    return recapText(this.agentId, sessionId);
  }

  /**
   * 列表卡里每条展开看到的内容。
   *
   * 有新鲜卡 → 直接用卡（那是一段真正的摘要）；没有 → **不假装是摘要**，
   * 只给最近一句用户原话并写明"还没有摘要"。
   * 之前这里退回的是 4 条完整对照（你：… 我：…），用户的原话是"看着像原文不像总结"。
   */
  private recapForList(s: SessionMeta): { text: string; hasCard: boolean } {
    // 存量卡里可能带一行「摘要：」标签（生成时没剥），展示时也顺手剥掉
    const card = (s.cardSummary ?? '').trim().replace(/^(摘要|总结|小结)\s*[:：]\s*/, '');
    const behind = s.messageCount - (s.cardCovered ?? 0);
    if (card && behind <= 6) return { text: card, hasCard: true };
    let last = '';
    try {
      const msgs = readSessionMessages(this.agentId, s.id, 8).filter((m) => m.role === 'user' && m.text.trim());
      last = msgs[msgs.length - 1]?.text ?? '';
    } catch {
      /* 读不到就只给提示 */
    }
    const brief = last.replace(/\s+/g, ' ').trim().slice(0, 60);
    return {
      text: brief ? `还没有摘要（后台会补）。最近在问：${brief}` : '还没有摘要（后台会补）。',
      hasCard: false,
    };
  }

  /** 该员工全部会话，按最近活跃倒序（不算窗口归属）。 */
  private agentSessions(): SessionMeta[] {
    return listSessions(this.agentId).sort((a, b) =>
      a.lastActiveAt < b.lastActiveAt ? 1 : a.lastActiveAt > b.lastActiveAt ? -1 : 0,
    );
  }

  /** 上次触发后台索引的时间（5 分钟一次，避免每条消息都重新扫会话）。 */
  private indexTickAt = 0;

  /**
   * 索引模式的判定输入：**全部会话的所有块**都参与，查询只 embed 这一句。
   *
   * 返回 null 的三种情况都要老实退回现场切块：
   *  - 索引里的会话太少（<3）或覆盖率 <60%：样本不全，结论会偏；
   *  - 当前会话还没索引到：拿 0 分去判"不像"会误开新话题；
   *  - 嵌入服务不可用。索引是增强，不是依赖。
   */
  private async indexRanking(args: {
    text: string;
    active: SessionMeta;
    sessions: SessionMeta[];
    cfg: SessionConfig;
  }): Promise<{ sem: SemanticInput; ranked: SessionMeta[]; scores: SessionScore[] } | null> {
    try {
      const bySid = loadCache(this.agentId);
      const indexed = args.sessions.filter((s) => (bySid.get(s.id)?.length ?? 0) > 0).length;
      if (indexed < 3 || indexed / Math.max(1, args.sessions.length) < 0.6) return null;
      const q = await embedTexts([args.text], embedCfgOf(args.cfg));
      const queryVec = q?.[0];
      if (!queryVec?.length) return null;

      const sem = semanticFromIndex({
        queryVec,
        active: args.active,
        sessions: args.sessions,
        bySid,
        continueThreshold: args.cfg.semantic.continueThreshold,
        switchThreshold: args.cfg.semantic.switchThreshold,
        unrelatedThreshold: args.cfg.semantic.unrelatedThreshold,
      });
      if (!sem) return null;

      const scores = scoreSessions({ queryVec, message: args.text, sessions: args.sessions, bySid });
      if (!scores.length) return null;
      const byId = new Map(args.sessions.map((s) => [s.id, s]));
      const ranked = scores.map((x) => byId.get(x.id)).filter((s): s is SessionMeta => Boolean(s));
      return { sem, ranked, scores };
    } catch {
      return null;
    }
  }

  /** 后台增量索引：只算缓存里没有的块，失败静默（下一轮再来）。 */
  private async refreshSessionIndex(sessions: SessionMeta[]): Promise<void> {
    const now = Date.now();
    if (now - this.indexTickAt < 5 * 60_000) return;
    this.indexTickAt = now;
    try {
      const r = await ensureIndexed(this.agentId, sessions, embedCfgOf(this.sessionCfg));
      if (r.added) {
        console.log(
          `[feishu:${this.wakerId}] 会话索引 +${r.added} 块` +
            `（覆盖 ${r.sessionsIndexed}/${sessions.length} 个会话）`,
        );
      }
    } catch (e) {
      console.error(`[feishu:${this.wakerId}] 会话索引失败（不影响对话）:`, (e as Error)?.message ?? e);
    }
  }

  /**
   * 当前会话最近两轮完整问答。
   *
   * 必须是**成对**的：像「你说得对，那按第二方案来」这种，只看用户消息根本判不出在说什么。
   * 读失败就返回空数组——仲裁那边会少一截上下文，但不会因此报错。
   */
  private recentTurnsOf(sessionId: string): ArbiterTurn[] {
    try {
      return readSessionMessages(this.agentId, sessionId, 10)
        .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.text.trim())
        .slice(-4)
        .map((m) => ({ role: m.role as 'user' | 'assistant', text: m.text.replace(/\s+/g, ' ').slice(0, 200) }));
    } catch {
      return [];
    }
  }

  /** 把一个会话转成判定用的输入（标题 + 少量原话）。 */
  private routeSessionOf(s: SessionMeta): RouteSession {
    let sample: string[] = [];
    try {
      sample = readSessionMessages(this.agentId, s.id, 6)
        .filter((m) => m.role === 'user' && m.text.trim())
        .slice(-3)
        .map((m) => m.text.slice(0, 200));
    } catch {
      /* 读不到就只用标题，判定会自动退化为保守 */
    }
    return { sessionId: s.id, title: displayNameOf(s), lastActiveAt: s.lastActiveAt, sample };
  }

  /**
   * 决策账本：判定事件（候选分数、仲裁原始概率、询问门、最终决策）。
   *
   * 与 `routing.jsonl` 的差别是**面向优化**而不是面向排查：
   * routing 只回答"当时判了什么"，这里还要能回答"用户看到哪几个候选、有没有更好的"。
   */
  private logDecisionRoute(
    id: string,
    key: string,
    a: {
      text: string;
      session: SessionMeta;
      semantic: Awaited<ReturnType<typeof semanticInputFor>>;
      semanticModel: string;
      ranked: SessionMeta[];
      strongTarget?: string;
      arbiter: ArbiterResult | null;
      arbiterVerdict: 'strong' | 'keep' | 'drop' | null;
      decision: RouteDecision;
      gate: 'ask' | 'auto' | 'stay';
      cfg: SessionConfig;
      rejectStreak: number;
      /** 索引模式的综合分（不传则用语义相似度打分）。 */
      sessionScores?: SessionScore[] | null;
      /** 这一轮是否走了全量索引。 */
      indexUsed?: boolean;
    },
  ): void {
    const r3 = (v?: number): number | undefined => (typeof v === 'number' ? Number(v.toFixed(3)) : undefined);
    appendDecision({
      evt: 'route',
      id,
      at: new Date().toISOString(),
      key,
      wakerId: this.agentId,
      channel: 'feishu',
      // 原话截 500 字：优化时要看"这句话到底像什么"，只留分数是没法复盘的
      message: a.text.slice(0, 500),
      messageLength: a.text.length,
      active: { id: a.session.id, name: displayNameOf(a.session) },
      idleHours: r3(a.decision.signals.gapHours),
      semantic: {
        available: a.semantic !== null,
        model: a.semanticModel,
        regime: a.decision.signals.regime,
        active: r3(a.decision.signals.semanticActive),
        best: r3(a.decision.signals.semanticBest),
      },
      candidates: candidateSnapshots({
        ranked: a.ranked,
        nameOf: (s) => displayNameOf(s),
        // 索引模式下记综合分（去背景 + 支持度 + 标题命中），否则记语义相似度。
        // 两种分数不可混看，所以同时写 `index.used` 区分。
        scoreOf: (sid) => {
          const hit = a.sessionScores?.find((x) => x.id === sid);
          return hit ? Number(hit.score.toFixed(3)) : semanticScoreOf(a.semantic, sid);
        },
      }),
      index: { used: !!a.indexUsed, scored: a.sessionScores?.length ?? 0 },
      strongMatch: a.strongTarget ?? null,
      arbiter: a.arbiter
        ? {
            model: a.arbiter.model,
            ms: a.arbiter.ms,
            action: a.arbiter.action,
            target: a.arbiter.targetSessionId ?? null,
            // keep/drop 是这轮新增的语义背书结果：调门禁时先看被丢掉的那些对不对
            verdict: a.arbiterVerdict,
            raw: a.arbiter.raw.slice(0, 600),
          }
        : null,
      decision: {
        action: a.decision.action,
        target: a.decision.targetSessionId ?? null,
        confidence: r3(a.decision.confidence),
        reason: a.decision.reason,
      },
      askGate: {
        gate: a.gate,
        ask: a.cfg.ask,
        autoSwitch: a.cfg.autoSwitch !== false,
        rejectLimit: a.cfg.rejectLimit,
        rejectStreak: a.rejectStreak,
      },
    });
  }

  /** 决策账本：用户的选择。`text` 表示"没选卡片、直接说了别的"。 */
  private logDecisionAnswer(
    id: string | undefined,
    key: string,
    kind: AnswerKind,
    extra: Record<string, unknown> = {},
  ): void {
    if (!id) return;
    appendDecision({ evt: 'answer', id, at: new Date().toISOString(), key, kind, ...extra });
  }

  /** 决策账本：最终落点（这句话最后被答在哪个会话）。 */
  private logDecisionFinal(
    id: string | undefined,
    key: string,
    kind: 'switch' | 'new' | 'stay' | 'list',
    session: SessionMeta | undefined,
    why?: string,
  ): void {
    if (!id) return;
    appendDecision({
      evt: 'final',
      id,
      at: new Date().toISOString(),
      key,
      kind,
      sessionId: session?.id,
      sessionName: session ? displayNameOf(session) : undefined,
      why,
    });
  }

  /** 判定流水：写失败也绝不影响对话。 */
  private logRoute(
    externalKey: string,
    activeSessionId: string,
    decision: RouteDecision,
    degraded = false,
    arbiter: ArbiterResult | null = null,
  ): void {
    try {
      appendFileSync(
        ROUTING_LOG,
        `${JSON.stringify({
          at: new Date().toISOString(),
          wakerId: this.agentId,
          key: externalKey,
          activeSessionId,
          action: decision.action,
          target: decision.targetSessionId,
          confidence: Number(decision.confidence.toFixed(3)),
          // 语义没生效时必须留痕：否则调阈值的人会拿词面分数去解释语义配置
          semanticUnavailable: degraded,
          // 仲裁一旦生效，判定就从确定性变成概率性：模型、原始输出、耗时都得留
          arbiter: arbiter
            ? {
                model: arbiter.model,
                action: arbiter.action,
                target: arbiter.targetSessionId,
                ms: arbiter.ms,
                raw: arbiter.raw.slice(0, 80),
              }
            : undefined,
          signals: decision.signals,
          reason: decision.reason,
        })}\n`,
        'utf-8',
      );
    } catch {
      /* 观测日志写失败不影响对话 */
    }
  }

  /**
   * 影子模型的对照行：主模型判了什么、影子判了什么，一行自洽。
   *
   * 为什么单独一行而不是塞进 `logRoute`：影子是异步的，写主日志时它多半还没回来。
   * 一条消息一行（不靠 id 关联），A/B 脚本直接统计 `agree` 即可。
   */
  private logShadow(args: {
    externalKey: string;
    sessionId: string;
    message: string;
    mainModel: string;
    main: { action: string; target?: string } | null;
    shadow: ArbiterResult;
  }): void {
    try {
      appendFileSync(
        ROUTING_LOG,
        `${JSON.stringify({
          source: 'shadow',
          at: new Date().toISOString(),
          wakerId: this.agentId,
          key: args.externalKey,
          activeSessionId: args.sessionId,
          message: args.message.slice(0, 60),
          main: args.main
            ? { model: args.mainModel, action: args.main.action, target: args.main.target }
            : { model: args.mainModel, action: '(unavailable)' },
          shadow: {
            model: args.shadow.model,
            action: args.shadow.action,
            target: args.shadow.targetSessionId,
            ms: args.shadow.ms,
            raw: args.shadow.raw.slice(0, 80),
          },
          agree: Boolean(args.main) && args.main!.action === args.shadow.action,
        })}\n`,
        'utf-8',
      );
    } catch {
      /* 观测日志写失败不影响对话 */
    }
  }

  /** 在指定会话里跑一轮，并在首轮补一个标题。 */
  private async runIn(session: SessionMeta, text: string, attachments?: string[]): Promise<string> {
    const task = await runWaker({
      wakerId: this.agentId,
      prompt: text,
      source: 'im',
      attachments,
      sessionId: session.piSessionId,
      wakerSessionId: session.id,
    });
    touchSession(this.agentId, session.id);
    if (!session.title) {
      // 纯附件消息的 prompt 是默认话术（"帮我看看这个"），拿它当标题毫无信息量
      patchSession(this.agentId, session.id, {
        title: deriveTitle(attachments?.length ? '图片/文件' : text),
      });
    }
    // 只打标记、不做推理：摘要留给闲置时的后台扫描器
    markSessionDirty(this.agentId, session.id, 2);
    return task.result || task.error || '(无输出)';
  }

  /** 「上一个任务还在处理中」的措辞：带已运行时长与单次上限，别让人空等。 */
  private busyHint(externalKey: string): string {
    const startedAt = this.busy.get(externalKey);
    const sec = startedAt ? Math.max(0, Math.round((Date.now() - startedAt) / 1000)) : 0;
    const mm = Math.floor(sec / 60);
    const dur = mm > 0 ? `${mm} 分 ${sec % 60} 秒` : `${sec} 秒`;
    return `上一个任务还在处理中（已运行 ${dur}，单次执行上限 ${Math.round(DEFAULT_TIMEOUT / 60000)} 分钟，超时会自动结束并告诉你）——`;
  }

  /**
   * 同一个 appId 已被别的员工占用时的提示。
   *
   * 一个飞书应用只能有一条长连接在收事件（多开会互相争抢：要么都回造成重复，
   * 要么随机一方回造成"谁答不确定"）。所以这里**直接拒绝启动**，把问题摆在
   * 渠道状态里，而不是让它悄悄抢。
   */
  private readonly conflictWith?: string;

  /** 会话策略：只决定这一句装进哪个弹巢，不碰人设与权限。 */
  private readonly sessionCfg: SessionConfig;

  constructor(rec: WakerRecord, cfg: FeishuChannelConfig, conflictWith?: string) {
    this.wakerId = rec.def.id;
    this.cfg = cfg;
    this.agentId = cfg.agent?.trim() || rec.def.id;
    this.name = `${rec.def.name} · 飞书`;
    this.conflictWith = conflictWith;
    this.sessionCfg = rec.def.session ?? DEFAULT_SESSION_CONFIG;
    // 去重表落盘、跨重启存活（飞书重投可能晚一小时才到，内存窗口挡不住）
    this.loadSeen();
  }

  status(): ChannelStatus {
    return {
      kind: this.kind,
      wakerId: this.wakerId,
      agentId: this.agentId,
      name: this.name,
      state: this.state,
      error: this.error,
      startedAt: this.startedAt,
    };
  }

  async start(): Promise<void> {
    if (this.state === 'running' || this.state === 'starting') return;
    if (this.conflictWith) {
      this.state = 'error';
      this.error = `appId ${this.cfg.appId} 已被员工「${this.conflictWith}」接入，已拒绝启动`;
      console.error(
        `[feishu:${this.wakerId}] ${this.error}。一个飞书应用只能由一个员工接入；` +
          `多员工请各自建一个飞书应用（各自 appId/appSecret）。`,
      );
      return;
    }
    if (!this.cfg.appId || !this.cfg.appSecret) {
      this.state = 'error';
      this.error = '缺少 appId / appSecret（检查 waker.yaml 与 secrets.json）';
      return;
    }
    // 兜底清理上次异常退出（崩溃 / 被强杀）留下的附件目录：
    // 正常路径在任务结束时已即时删除，这里只处理"没走到 finally"的残留。
    try {
      const removed = cleanupInbox();
      if (removed > 0) console.log(`[feishu:${this.wakerId}] 清理残留附件 ${removed} 个`);
    } catch {
      /* 清理失败不影响渠道启动 */
    }
    const lark = loadLarkSdk();
    if (!lark) {
      this.state = 'error';
      this.error = '未找到 @larksuiteoapi/node-sdk（可设 WAKER_FEISHU_SDK 指向它）';
      return;
    }

    this.client = new lark.Client({ appId: this.cfg.appId, appSecret: this.cfg.appSecret });
    // 先用一次 REST 调用校验凭证：避免"长连接地址连上了但鉴权失败"却长期停在 starting
    try {
      await this.client.request({ method: 'GET', url: '/open-apis/bot/v3/info', data: {} });
    } catch (e) {
      this.state = 'error';
      this.error = `应用凭证校验失败：${(e as Error)?.message ?? e}`;
      console.error(`[feishu:${this.wakerId}]`, this.error);
      return;
    }
    // 注意：这两个 handler **必须立刻返回、不能 await 任务**（2026-10-12 修）。
    // SDK 是在 invoke 完成后才回 ack（见 `@larksuiteoapi/node-sdk` 的 WS receive 分支），
    // 而任务动辄几秒到几十秒 —— ack 迟到，飞书就当没收到，**约 19 秒后重投**该事件；
    // 重投时若第一个任务已结束（忙锁已释放），同一个问题就会被完整跑第二遍、回两条不同答案。
    // 我们的回复走的是上层 REST（`message.reply`），不依赖事件回包的 data 字段，
    // 所以"立即 ack + 后台跑任务"是安全的；用户侧的"已收到"即时反馈由 reactAck 的 👍 给。
    const dispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': (event: Any) => {
        void this.onMessage(event).catch((e) => {
          console.error(`[feishu:${this.wakerId}] 消息处理异常:`, (e as Error)?.message ?? e);
        });
      },
      // 云文档评论里 @ 机器人（v1 事件：体在 notice_meta 里，正文要再查一次）
      'drive.notice.comment_add_v1': (event: Any) => {
        void this.onDocComment(event).catch((e) => {
          console.error(`[feishu:${this.wakerId}] 文档评论处理异常:`, (e as Error)?.message ?? e);
        });
      },
      // 卡片按钮回调（话题切换卡上的「切回去 / 就在这儿继续」）。
      // 与消息事件是**两条独立的事件链**：返回值不会被当成回复内容，
      // 且 ack 同样要求立刻产生（理由见上面的长注释），所以这里仍是 fire-and-forget，
      // 真正的回复走 REST 另发一条。
      // 返回值会被 WS 客户端塞进 ack 的 data 里回给飞书，所以顺手带回 **toast + 新卡片**：
      // 用户点完立刻看到"已选择：切回去 · ⏳ 正在接着回答"，不必等到模型那几十秒，
      // 也不会因为按钮还亮着而怀疑自己没点中。处理本身仍在后台跑。
      'card.action.trigger': (event: Any) => {
        const click = this.planCardAction(event);
        if (
          click.answer ||
          click.pickSessionId ||
          click.chooseSessionId ||
          click.wantTopicList ||
          click.rejectAll
        ) {
          void this.runCardAction(click).catch((e) => {
            console.error(`[feishu:${this.wakerId}] 卡片回调处理异常:`, (e as Error)?.message ?? e);
          });
        }
        return this.cardAckOf(click);
      },
    });
    this.ws = new lark.WSClient({
      appId: this.cfg.appId,
      appSecret: this.cfg.appSecret,
      loggerLevel: lark.LoggerLevel?.warn ?? 2,
      autoReconnect: true,
      onReady: () => {
        this.state = 'running';
        console.log(`[feishu:${this.wakerId}] 长连接已建立`);
      },
      onError: (err: unknown) => {
        this.state = 'error';
        this.error = `长连接错误：${(err as Error)?.message ?? String(err)}`;
      },
    });
    this.state = 'starting';
    this.startedAt = new Date().toISOString();
    this.error = undefined;
    // WSClient.start 会持续保持连接、不返回；因此不 await，由回调更新状态
    void this.ws.start({ eventDispatcher: dispatcher }).catch((e: unknown) => {
      this.state = 'error';
      this.error = `长连接建立失败：${(e as Error)?.message ?? e}`;
      console.error(`[feishu:${this.wakerId}]`, this.error);
    });
  }

  async stop(): Promise<void> {
    try {
      this.ws?.close({ force: true });
    } catch {
      /* 可能已断开 */
    }
    this.ws = null;
    this.client = null;
    this.state = 'stopped';
  }

  /**
   * 白名单：私聊按 open_id，群聊按 chat_id；未配置即拒绝（默认拒绝所有人）。
   * `allowAllChats` / `allowAllUsers` 可整体放开对应方向。
   */
  private allowed(isP2p: boolean, openId: string, chatId: string): boolean {
    if (isP2p) {
      if (this.cfg.allowAllUsers) return true;
      const users = this.cfg.allowedUsers ?? [];
      return users.length > 0 && users.includes(openId);
    }
    if (this.cfg.allowAllChats) return true;
    const chats = this.cfg.allowedChats ?? [];
    return chats.length > 0 && chats.includes(chatId);
  }

  private async onMessage(event: Any): Promise<void> {
    const msg = event?.message;
    if (!msg?.message_id) return;

    // 两道闸门（见字段注释）：先按"事件太旧"挡晚到的重投，再按 id 挡快速重投。
    if (this.isStale(msg.create_time, '消息', msg.message_id)) return;
    if (this.isDuplicate(`msg:${msg.message_id}`)) {
      console.log(`[feishu:${this.wakerId}] 忽略重复事件 message_id=${msg.message_id}（飞书重投，已处理过）`);
      return;
    }

    const isP2p = msg.chat_type === 'p2p';
    const chatId = String(msg.chat_id ?? '');
    const openId = String(event?.sender?.sender_id?.open_id ?? '');

    // 类型归一化（2026-10-31 修）。原来这里是 `if (message_type !== 'text') return`，
    // 图片 / 文件 / 语音 / 表情包在**去重、白名单、加表情之前**就被丢掉，
    // 用户侧唯一的观察就是「消息石沉大海」，日志里也查不到任何痕迹。
    // 现在的契约：要么翻译成 text + 附件交给模型，要么回一句人能看懂的话，不许吞。
    const parsed = parseFeishuMessage(msg);
    if (parsed.ignore) {
      console.log(`[feishu:${this.wakerId}] 忽略系统消息 type=${msg.message_type} id=${msg.message_id}`);
      return;
    }

    if (!this.allowed(isP2p, openId, chatId)) {
      console.log(`[feishu:${this.wakerId}] 未授权消息已忽略 open_id=${openId} chat_id=${chatId}`);
      return;
    }

    // 先给原消息加个表情：命令执行动辄几十秒，没有这一步用户不知道"到底收到没有"。
    // 放在忙锁判断**之前** —— 排队场景下"我看到了、在排队"也应该有反馈。
    // 非文本消息同样需要这个反馈：否则"不支持"和"没收到"在用户眼里完全一样。
    await this.reactAck(msg.message_id);

    const hasMedia = parsed.imageKeys.length > 0 || parsed.files.length > 0;
    if (!hasMedia && !parsed.text) {
      // 明确不支持的类型（语音/视频/表情包/卡片…）：说清楚，不进模型。
      await this.reply(msg.message_id, parsed.note ?? '这条消息我看不懂，麻烦换种方式发一次。');
      return;
    }

    // 附件落盘：能下多少算多少，失败原因回给用户，而不是让整条消息没有下文。
    let attachments: string[] = [];
    let downloadNote: string | undefined;
    if (hasMedia) {
      // 这一步最容易把"修好的静默"重新变回静默：下载链路抛错（网络、权限、
      // client 已 stop）时，异常只会被 start() 里注册的 .catch 记进日志，用户侧没反应。
      // 所以必须自己兜住，并把原因回给用户。
      if (!this.client) {
        await this.reply(msg.message_id, '渠道还没就绪，稍等一下再发一次。');
        return;
      }
      try {
        const got = await materialize(this.client, msg.message_id, parsed);
        attachments = got.attachments;
        downloadNote = got.note;
      } catch (e) {
        await this.reply(msg.message_id, `附件下载失败：${(e as Error)?.message ?? e}`);
        return;
      }
      if (!attachments.length) {
        await this.reply(msg.message_id, downloadNote ?? '附件下载失败，麻烦重发一次。');
        return;
      }
    }

    // 纯附件没有配文时补一句默认话术：空 prompt 会让模型答非所问。
    const text = parsed.text || (hasMedia ? DEFAULT_ATTACHMENT_PROMPT : '');
    if (!text) return;

    // 外部会话 key → 平台会话。群聊在非 single 模式下按发言人分指针，
    // 规则集中在 conversationKeyOf 里（纯函数，有单测）。
    const externalKey = conversationKeyOf({
      kind: isP2p ? 'p2p' : 'group',
      userId: openId,
      chatId,
      mode: this.sessionCfg.mode,
    });
    if (this.busy.has(externalKey)) {
      removeAttachments(attachments);
      await this.reply(msg.message_id, `${this.busyHint(externalKey)}请稍后再发。`);
      return;
    }

    // 会话控制命令（如 /clear）：**不进模型**，直接改会话状态并回执。
    // 放在忙锁之后：正在执行时不动会话文件，免得和 pi 的写入打架。
    // 只对纯文本生效：`/clear` 后面挂着图片时它是内容，不是命令。
    if (!attachments.length) {
      const handled = await this.handleSessionCommand(
        text,
        externalKey,
        msg.message_id,
        isP2p ? '飞书私聊' : '飞书群聊',
      );
      if (handled) return;
    }

    const displayName = isP2p ? '飞书私聊' : '飞书群聊';
    this.busy.set(externalKey, Date.now());
    try {
      if (this.sessionCfg.mode !== 'single') {
        if (downloadNote) await this.reply(msg.message_id, `（${downloadNote}）`);
        await this.handleTopicTurn({
          text,
          attachments,
          externalKey,
          messageId: msg.message_id,
          displayName,
        });
      } else {
        // single：保持旧行为不变（一个渠道一个会话）
        const session = resolveSessionByKey(this.agentId, externalKey, displayName);
        const task = await runWaker({
          wakerId: this.agentId,
          prompt: text,
          source: 'im',
          attachments,
          sessionId: session.piSessionId,
          wakerSessionId: session.id,
        });
        touchSession(this.agentId, session.id);
        const body = task.result || task.error || '(无输出)';
        await this.reply(msg.message_id, downloadNote ? `${body}\n\n（${downloadNote}）` : body);
      }
    } finally {
      this.busy.delete(externalKey);
      // 附件只服务于这一次调用：pi 启动时已把图片内联进内容块、文件也已读完。
      // 留在盘上只会越积越多（data 目录是长期存在的）。
      removeAttachments(attachments);
    }
  }

  /**
   * 云文档评论里 @ 机器人。
   *
   * 与 IM 消息有两处根本不同：
   *  1. 事件体**不含评论正文**，只有 `comment_id`，必须再查一次评论；
   *  2. 回复要走**评论回复接口**（`fileCommentReply`）——IM 的 `message.reply` 在评论区无效。
   */
  private async onDocComment(raw: Any): Promise<void> {
    // v1 事件体在不同接入方式下可能被包在 event 里，两种形态都兜住
    const e = raw?.event?.notice_meta ? raw.event : raw;
    const meta = e?.notice_meta;
    const fileType = String(meta?.file_type ?? '');
    const fileToken = String(meta?.file_token ?? '');
    const commentId = String(e?.comment_id ?? '');
    const openId = String(meta?.from_user_id?.open_id ?? '');
    if (!fileToken || !commentId || !fileType) return;

    // 只响应真正 @ 了机器人的评论，否则任何一条评论都会触发
    if (e?.is_mentioned !== true) return;
    if (meta?.notice_type !== 'add_comment' && meta?.notice_type !== 'add_reply') return;

    // 两道闸门，同 IM 消息（见字段注释）：评论事件同样会被飞书重投。
    // 时间字段按 SDK 自己的取值顺序兜（normalizeComment 就是 create_time → notice_meta.timestamp → action_time）
    if (this.isStale(e?.create_time ?? meta?.timestamp ?? e?.action_time, '评论', commentId)) return;
    if (this.isDuplicate(`comment:${commentId}`)) {
      console.log(`[feishu:${this.wakerId}] 忽略重复评论事件 comment_id=${commentId}（飞书重投，已处理过）`);
      return;
    }

    // 文档评论没有 chat_id，白名单按用户判断（默认仍是拒绝）
    const userAllowed = this.cfg.allowAllUsers === true || (this.cfg.allowedUsers ?? []).includes(openId);
    if (!userAllowed) {
      console.log(
        `[feishu:${this.wakerId}] 文档评论未授权已忽略 open_id=${openId} file=${fileType}:${fileToken}`,
      );
      return;
    }

    const text = await this.fetchCommentText(fileToken, fileType, commentId);
    if (!text) {
      console.log(`[feishu:${this.wakerId}] 文档评论正文为空，已忽略 comment_id=${commentId}`);
      return;
    }

    // 同一篇文档的评论串成一个平台会话，上下文才连贯
    const externalKey = `feishu:doc_${fileToken}`;
    if (this.busy.has(externalKey)) {
      await this.replyComment(fileToken, fileType, commentId, `${this.busyHint(externalKey)}请稍后再 @ 我。`, openId);
      return;
    }
    this.busy.set(externalKey, Date.now());
    try {
      const session = resolveSessionByKey(this.agentId, externalKey, `飞书文档评论 ${fileType}`);
      const task = await runWaker({
        wakerId: this.agentId,
        prompt: text,
        source: 'im',
        sessionId: session.piSessionId,
        wakerSessionId: session.id,
      });
      touchSession(this.agentId, session.id);
      await this.replyComment(fileToken, fileType, commentId, task.result || task.error || '(无输出)', openId);
    } finally {
      this.busy.delete(externalKey);
    }
  }

  /** 取该评论下**最后一条**回复的正文（即 @ 机器人那句）。 */
  private async fetchCommentText(fileToken: string, fileType: string, commentId: string): Promise<string> {
    if (!this.client) return '';
    try {
      const res = await this.client.drive.v1.fileComment.get({
        path: { file_token: fileToken, comment_id: commentId },
        params: { file_type: fileType },
      });
      const replies = res?.data?.reply_list?.replies ?? [];
      const last = replies[replies.length - 1];
      return elementsToText(last?.content?.elements);
    } catch (e) {
      console.error(`[feishu:${this.wakerId}] 拉取评论失败:`, (e as Error)?.message ?? e);
      return '';
    }
  }

  /**
   * 回复云文档评论（超长自动分片；评论框不渲染 Markdown，按纯文本发）。
   *
   * 评论回复有多种"被飞书拒绝"的正当情况，最典型的是文档评论区不允许回复
   * （`1069302 The comment section does not allow replies`）。**不能只打日志**——
   * 那样答案就死在这里，用户只看到"@ 了机器人但没反应"。
   * 所以失败时回落到**私聊**把内容发给提问的人（openId 由事件带上来）。
   */
  private async replyComment(
    fileToken: string,
    fileType: string,
    commentId: string,
    text: string,
    openId = '',
  ): Promise<void> {
    if (!this.client) return;
    const chunks =
      text.length <= MAX_CHARS ? [text] : (text.match(new RegExp(`[\\s\\S]{1,${MAX_CHARS}}`, 'g')) ?? [text]);
    let failedReason = '';
    for (const chunk of chunks) {
      try {
        await this.client.drive.v1.fileCommentReply.create({
          path: { file_token: fileToken, comment_id: commentId },
          params: { file_type: fileType },
          data: { content: { elements: [{ type: 'text_run', text_run: { text: chunk } }] } },
        });
      } catch (e) {
        failedReason = (e as Error)?.message ?? String(e);
        console.error(`[feishu:${this.wakerId}] 评论回复失败:`, failedReason);
      }
    }
    if (!failedReason) return;

    // 兜底一：**新开一条评论并 @ 提问者**。
    // 实测某些文档的评论区「允许新增评论、但不允许回复」（错误码 1069302，连回复自己刚发的评论也被拒），
    // 这种情况下新评论是唯一还能进评论区的路径，且 @ 之后对方仍会收到通知。
    // 只在单条能发完时用：多段会在文档里开出一串新线程，那不如走私聊。
    if (openId && chunks.length === 1) {
      const note = '（本该回复在你那条评论下，但该文档的评论区不允许回复，故新开一条并 @ 你）\n\n';
      if (await this.commentMentioning(fileToken, fileType, openId, `${note}${text}`)) {
        console.log(`[feishu:${this.wakerId}] 评论回复被拒，已改为新开评论并 @ 提问者`);
        return;
      }
    }

    // 兜底二：私聊。评论区和文档都发不出去时，至少让答案送达。
    if (!openId) {
      console.error(`[feishu:${this.wakerId}] 评论回复失败且事件里没有 open_id，无法兜底，内容已丢弃`);
      return;
    }
    console.log(`[feishu:${this.wakerId}] 评论回复被拒且新评论也失败，已改走私聊兜底 open_id=${openId}`);
    await this.sendToUser(
      openId,
      `（这条本该回复在你那条文档评论下，但飞书拒绝了对该评论的回复：${failedReason}）\n\n${text}`,
    );
  }

  /**
   * 新开一条评论并 @ 指定用户（评论回复被拒时的第一兜底）。
   *
   * 注意 `user_id_type=open_id` 必须带上，否则 `person` 元素里的 open_id 会被当成 user_id 解析。
   * 返回是否发送成功。
   */
  private async commentMentioning(
    fileToken: string,
    fileType: string,
    openId: string,
    text: string,
  ): Promise<boolean> {
    if (!this.client || !openId) return false;
    try {
      await this.client.drive.v1.fileComment.create({
        path: { file_token: fileToken },
        params: { file_type: fileType, user_id_type: 'open_id' },
        data: {
          reply_list: {
            replies: [
              {
                content: {
                  elements: [
                    { type: 'person', person: { user_id: openId } },
                    { type: 'text_run', text_run: { text: ` ${text}` } },
                  ],
                },
              },
            ],
          },
        },
      });
      return true;
    } catch (e) {
      console.error(`[feishu:${this.wakerId}] 新开评论兜底也失败:`, (e as Error)?.message ?? e);
      return false;
    }
  }

  /**
   * 发一条消息：有 Markdown 就走**交互卡片**（渲染加粗 / 标题 / 列表 / 代码块），
   * 没有则保持纯文本短消息。
   *
   * 关键设计：**卡片发不出去就自动回落纯文本**。渲染是加分项，答案丢失不是。
   * 老租户不支持 `interactive`、接口权限异常、或卡片被判定超限时，
   * 用户至少还能收到一坨带 `**` 的原文，而不是什么都没有。
   */
  private async sendRich(
    kind: 'reply' | 'dm' | 'chat',
    to: string,
    text: string,
    /** 明确给定卡片时直接用（带按钮的卡片不能靠 markdown 自动转换得到）。 */
    card?: Record<string, unknown>,
  ): Promise<void> {
    if (!this.client || !to) return;
    if (!card && !text) return;
    if (!card && !hasMarkdown(text)) {
      await this.sendPlain(kind, to, text);
      return;
    }
    const cards = card ? [card] : markdownToCards(text);
    for (const card of cards) {
      try {
        if (kind === 'reply') {
          await this.client.im.v1.message.reply({
            path: { message_id: to },
            data: { msg_type: 'interactive', content: JSON.stringify(card) },
          });
        } else {
          await this.client.im.v1.message.create({
            params: { receive_id_type: kind === 'chat' ? 'chat_id' : 'open_id' },
            data: { receive_id: to, msg_type: 'interactive', content: JSON.stringify(card) },
          });
        }
      } catch (e) {
        // 打**响应体**而不是 axios 的 `message`：卡片被拒时真正的理由（哪个字段不认识）
        // 只在 response.data 里，只打 "Request failed with status code 400" 等于没打。
        const body = (e as Any)?.response?.data;
        const detail = body ? JSON.stringify(body).slice(0, 400) : ((e as Error)?.message ?? String(e));
        console.error(`[feishu:${this.wakerId}] 卡片发送失败（${detail}），回落纯文本`);
        await this.sendPlain(kind, to, text);
        return;
      }
    }
  }

  /** 纯文本发送，超长按字符分片（卡片路径已在 markdownToCards 里按元素边界分过包）。 */
  private async sendPlain(kind: 'reply' | 'dm' | 'chat', to: string, text: string): Promise<void> {
    if (!this.client || !to || !text) return;
    const chunks =
      text.length <= MAX_CHARS ? [text] : (text.match(new RegExp(`[\\s\\S]{1,${MAX_CHARS}}`, 'g')) ?? [text]);
    for (const chunk of chunks) {
      try {
        if (kind === 'reply') {
          await this.client.im.v1.message.reply({
            path: { message_id: to },
            data: { content: JSON.stringify({ text: chunk }), msg_type: 'text' },
          });
        } else {
          await this.client.im.v1.message.create({
            params: { receive_id_type: kind === 'chat' ? 'chat_id' : 'open_id' },
            data: { receive_id: to, msg_type: 'text', content: JSON.stringify({ text: chunk }) },
          });
        }
      } catch (e) {
        const what = kind === 'reply' ? '回帖' : '私聊';
        console.error(`[feishu:${this.wakerId}] ${what}发送失败:`, (e as Error)?.message ?? e);
      }
    }
  }

  /** 私聊发消息。**兜底通道**：评论回复被拒时用它保证答案还能送达（内容按 Markdown 渲染）。 */
  private async sendToUser(openId: string, text: string): Promise<void> {
    await this.sendRich('dm', openId, text);
  }

  /** 回帖（含 Markdown 渲染），超长自动分片。 */
  private async reply(messageId: string, text: string): Promise<void> {
    await this.sendRich('reply', messageId, text);
  }

  /**
   * 主动推送到外部会话（待办到点后的执行结果）。
   *
   * 与入站回复的区别：这里只有 externalKey，没有 message_id 可回帖，
   * 所以走 `create`；群聊必须用 `chat_id`，私聊用 `open_id`（见 `parseExternalKey`）。
   */
  async notify(externalKey: string, text: string): Promise<boolean> {
    const target = parseExternalKey(externalKey);
    if (!target || !this.client || !text.trim()) return false;
    try {
      await this.sendRich(target.kind === 'p2p' ? 'dm' : 'chat', target.id, text);
      return true;
    } catch (e) {
      console.error(`[feishu:${this.wakerId}] 主动推送失败:`, (e as Error)?.message ?? e);
      return false;
    }
  }
}
