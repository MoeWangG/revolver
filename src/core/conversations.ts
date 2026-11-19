/**
 * Conversation（对话 / 视图层）与 Session（会话 / 上下文层）的映射。
 *
 * 三层模型：
 *   agent  →  conversation（用户唯一感知的窗口）  →  session（弹巢，可多个）
 *
 * 为什么需要这张表：
 *   旧版把 `externalKey` 写在会话上，等于「一个渠道永远一个会话」——
 *   想切话题只能另开渠道，history 只增不减。要支持"同渠道换弹巢"，
 *   就必须把「这个窗口现在对准哪个会话」变成一个**可变的指针**，
 *   而指针不能存放在会话里（会话会变），只能单独存。
 *
 * 两种模式：
 *   - `single`：完全不读这张表，走旧的 resolveSessionByKey。零行为变化；
 *   - `topic` ：读这张表，active 指针决定这一句装进哪个弹巢。
 *
 * 回退语义（topic → single）：single 模式按 externalKey 找到的是**首个弹巢**，
 * 也就是当初这个渠道第一次建的那个会话。这是有意为之——
 * "冻结路由"应该回到原点，而不是随机停在某个半路的话题上。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { CONVERSATIONS_FILE, DATA_DIR, SESSIONS_FILE } from './paths.ts';
import {
  createSession,
  listSessions,
  patchSession,
  resolveSession,
  resolveSessionByKey,
  type SessionMeta,
} from './sessions.ts';

export type SessionMode = 'single' | 'topic' | 'timeWindow';

/**
 * 外部键的构造。
 *
 * 私聊按用户；群聊在非 single 模式下**再按发言人细分**——
 * 同一个群里 A 的话题不该被 B 的追问吸走。抽成纯函数是为了能测：
 * 群聊串台是这类功能里最难在真实环境复现、也最难事后归因的 bug。
 */
export function conversationKeyOf(args: {
  kind: 'p2p' | 'group';
  userId: string;
  chatId: string;
  mode: SessionMode;
}): string {
  const base = args.kind === 'p2p' ? `feishu:u_${args.userId}` : `feishu:g_${args.chatId}`;
  return args.kind === 'group' && args.mode !== 'single' ? `${base}:u_${args.userId}` : base;
}

/** 一次"要不要换弹巢"的提问，等待用户回答。 */
export interface PendingAsk {
  /** 建议的动作。continue 不会进这里。 */
  action: 'switch' | 'new';
  /** action=switch 时的目标会话。 */
  targetSessionId?: string;
  /** 触发这次提问的原话：确认后直接用它作答，用户不必重说。 */
  message: string;
  askedAt: string;
  reason: string;
  /**
   * 决策账本 id：把「发卡 → 用户点了什么 → 最后落在哪」串成一条。
   * 老 pending 可能没有这个字段（升级前写下），写账本时要容忍 undefined。
   */
  decisionId?: string;
  /**
   * 询问卡上列出的候选会话 id（顺序即卡片按钮顺序）。
   *
   * 用来支撑两件事：纯文本退路「回 1..N」要映射回具体会话；
   * 以及按钮点击时知道用户选的是哪一条。**缺省表示旧卡片**（只有 yes/no 两条路），
   * 存量 pending 反序列化后可能是 undefined，读取方必须容忍。
   */
  candidateIds?: string[];
}

export interface ConversationMeta {
  /** 渠道标识，如 `feishu:u_<openid>`。 */
  key: string;
  wakerId: string;
  /** 当前对准的会话（弹巢）。 */
  activeSessionId: string;
  /** 该窗口曾装过的会话；第一个是 externalKey 对应的"首个弹巢"。 */
  history: string[];
  /** 连续拒绝切换的次数：到阈值就停止询问，退化为 single 行为。 */
  rejectStreak: number;
  pending?: PendingAsk;
  updatedAt: string;
  lastRouteAt?: string;
}

type Store = Record<string, Record<string, ConversationMeta>>;

function ensureFile(): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  if (!existsSync(CONVERSATIONS_FILE)) writeFileSync(CONVERSATIONS_FILE, '{}\n', 'utf-8');
}

function readStore(): Store {
  ensureFile();
  try {
    const raw = readFileSync(CONVERSATIONS_FILE, 'utf-8').trim();
    return raw ? (JSON.parse(raw) as Store) : {};
  } catch {
    return {};
  }
}

function writeStore(store: Store): void {
  ensureFile();
  writeFileSync(CONVERSATIONS_FILE, `${JSON.stringify(store, null, 2)}\n`, 'utf-8');
}

function nowIso(): string {
  return new Date().toISOString();
}

export function getConversation(wakerId: string, key: string): ConversationMeta | null {
  return readStore()[wakerId]?.[key] ?? null;
}

export function listConversations(wakerId: string): ConversationMeta[] {
  return Object.values(readStore()[wakerId] ?? {});
}

/** 写入一条会话映射（内部用；不校验会话是否存在）。 */
function upsert(wakerId: string, meta: ConversationMeta): ConversationMeta {
  const store = readStore();
  const bucket = (store[wakerId] ??= {});
  bucket[meta.key] = { ...meta, updatedAt: nowIso() };
  writeStore(store);
  return bucket[meta.key]!;
}

/**
 * 取（必要时创建）一个窗口的映射。
 *
 * 首次创建时优先**收养**已有的 externalKey 会话——这正是"从 single 切到 topic，
 * 当前会话原地成为首个弹巢"的实现点。没有它，切模式会让用户以为历史没了。
 */
export function ensureConversation(wakerId: string, key: string, displayName: string): ConversationMeta {
  const hit = getConversation(wakerId, key);
  if (hit) {
    // 自愈：active 指向的会话可能被用户删了
    const exists = listSessions(wakerId).some((s) => s.id === hit.activeSessionId);
    if (exists) return hit;
    const primary = resolveSessionByKey(wakerId, key, displayName);
    return upsert(wakerId, { ...hit, activeSessionId: primary.id, history: dedupe([primary.id, ...hit.history]) });
  }

  const primary = resolveSessionByKey(wakerId, key, displayName);
  return upsert(wakerId, {
    key,
    wakerId,
    activeSessionId: primary.id,
    history: [primary.id],
    rejectStreak: 0,
    updatedAt: nowIso(),
  });
}

function dedupe(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of list) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * 指针离开一个会话时，给**被离开的那个**拍一张离场快照。
 *
 * 为什么用动态 import：本模块是底层（渠道、网关、CLI 都依赖它），静态引入
 * episode 会把 runner / registry 整条依赖链拖进来，形成环的风险大于收益。
 * 为什么不等：这里在指针移动的同步路径上，摘要要调模型（6~15s），
 * 等它等于让用户等一次切换。
 */
function snapshotOnSwitch(wakerId: string, leftSessionId: string | undefined, to?: string): void {
  if (!leftSessionId || leftSessionId === to) return;
  void import('./episode.ts')
    .then((m) => m.startSnapshot({ wakerId, sessionId: leftSessionId, to }))
    .catch(() => {
      /* 快照是增强：动态加载失败不影响切换 */
    });
}

/**
 * 只记"这个窗口现在对着哪个会话"，**不建会话**。
 *
 * 为什么单独一个入口：`setActive` 找不到记录时会 `ensureConversation`，
 * 而后者会顺带创建一个会话——网页端只是想给快照留一条触发线索，
 * 不该因为多记一个指针就在列表里多出一个空弹巢。
 */
export function noteActiveWindow(wakerId: string, key: string, sessionId: string): void {
  const meta = getConversation(wakerId, key);
  if (!meta) {
    upsert(wakerId, {
      key,
      wakerId,
      activeSessionId: sessionId,
      history: [sessionId],
      rejectStreak: 0,
      updatedAt: nowIso(),
    });
    return;
  }
  if (meta.activeSessionId === sessionId) return;
  upsert(wakerId, {
    ...meta,
    activeSessionId: sessionId,
    history: dedupe([...meta.history, sessionId]),
    pending: undefined,
  });
  snapshotOnSwitch(wakerId, meta.activeSessionId, sessionId);
}

/** 把指针挪到某个已有会话。 */
export function setActive(wakerId: string, key: string, sessionId: string): ConversationMeta {
  const meta = getConversation(wakerId, key) ?? ensureConversation(wakerId, key, '对话');
  const next = upsert(wakerId, {
    ...meta,
    activeSessionId: sessionId,
    history: dedupe([...meta.history, sessionId]),
    pending: undefined,
  });
  snapshotOnSwitch(wakerId, meta.activeSessionId, sessionId);
  return next;
}

/** 开一个新弹巢并指过去。title 给首条消息派生的短标题。 */
export function openNewChamber(wakerId: string, key: string, title?: string): {
  conversation: ConversationMeta;
  session: SessionMeta;
} {
  const meta = getConversation(wakerId, key) ?? ensureConversation(wakerId, key, '对话');
  const session = createSession(wakerId, title?.trim() || undefined);
  // 记下"这个名字只是首句截断"：后台拿到会话卡之后才能把它升级成真正的标题
  if (title?.trim()) patchSession(wakerId, session.id, { nameFrom: 'derive' });
  const conversation = upsert(wakerId, {
    ...meta,
    activeSessionId: session.id,
    history: dedupe([...meta.history, session.id]),
    pending: undefined,
    rejectStreak: 0,
  });
  // 开新弹巢 = 从旧会话跳出去：旧的那段同样要固化（否则它只有逐条消息索引，没有"整段"表示）
  snapshotOnSwitch(wakerId, meta.activeSessionId, session.id);
  return { conversation, session };
}

export function setPending(wakerId: string, key: string, pending: PendingAsk): ConversationMeta {
  const meta = getConversation(wakerId, key) ?? ensureConversation(wakerId, key, '对话');
  return upsert(wakerId, { ...meta, pending });
}

export function clearPending(wakerId: string, key: string): ConversationMeta {
  const meta = getConversation(wakerId, key) ?? ensureConversation(wakerId, key, '对话');
  return upsert(wakerId, { ...meta, pending: undefined });
}

export function bumpReject(wakerId: string, key: string): ConversationMeta {
  const meta = getConversation(wakerId, key) ?? ensureConversation(wakerId, key, '对话');
  return upsert(wakerId, { ...meta, rejectStreak: meta.rejectStreak + 1, pending: undefined });
}

export function resetReject(wakerId: string, key: string): ConversationMeta {
  const meta = getConversation(wakerId, key) ?? ensureConversation(wakerId, key, '对话');
  return upsert(wakerId, { ...meta, rejectStreak: 0 });
}

export function markRouted(wakerId: string, key: string): void {
  const meta = getConversation(wakerId, key);
  if (!meta) return;
  upsert(wakerId, { ...meta, lastRouteAt: nowIso() });
}

/** 该窗口装过的会话，按最近活跃倒序（供 /topics 与看板展示）。 */
export function chambersOf(wakerId: string, key: string): SessionMeta[] {
  const meta = getConversation(wakerId, key);
  if (!meta) return [];
  const all = new Map(listSessions(wakerId).map((s) => [s.id, s] as const));
  return meta.history
    .map((id) => all.get(id))
    .filter((s): s is SessionMeta => Boolean(s))
    .sort((a, b) => (a.lastActiveAt < b.lastActiveAt ? 1 : a.lastActiveAt > b.lastActiveAt ? -1 : 0));
}

/**
 * 存量迁移：把会话上的 externalKey 反向填进映射表。
 *
 * 幂等，可重复调用。只补"还没有映射"的 key，绝不覆盖用户已经切过的 active 指针。
 */
export function migrateLegacyKeys(): number {
  const store = readStore();
  let added = 0;
  const wakers = new Set<string>();
  // 从 sessions.json 反查需要迁移的 key：用 listSessions 无法枚举全部员工，
  // 所以直接读文件里的 wakerId 集合。
  try {
    const raw = JSON.parse(readFileSync(SESSIONS_FILE, 'utf-8')) as Record<string, SessionMeta[]>;
    for (const id of Object.keys(raw)) wakers.add(id);
  } catch {
    return 0;
  }

  for (const wakerId of wakers) {
    const bucket = (store[wakerId] ??= {});
    for (const s of listSessions(wakerId)) {
      if (!s.externalKey || bucket[s.externalKey]) continue;
      bucket[s.externalKey] = {
        key: s.externalKey,
        wakerId,
        activeSessionId: s.id,
        history: [s.id],
        rejectStreak: 0,
        updatedAt: nowIso(),
      };
      added += 1;
    }
  }
  if (added) writeStore(store);
  return added;
}

/** 解析：这个窗口这一句该装进哪个会话。single 模式完全不碰映射表。 */
export function resolveConversationSession(input: {
  wakerId: string;
  key: string;
  displayName: string;
  mode: SessionMode;
}): { session: SessionMeta; conversation: ConversationMeta | null } {
  if (input.mode === 'single') {
    return { session: resolveSessionByKey(input.wakerId, input.key, input.displayName), conversation: null };
  }
  const conversation = ensureConversation(input.wakerId, input.key, input.displayName);
  return { session: resolveSession(input.wakerId, conversation.activeSessionId), conversation };
}
