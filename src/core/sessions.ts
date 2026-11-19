import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR, PI_AGENT_HOME, SESSIONS_FILE } from './paths.ts';

/** 读目录；不存在或不可读时返回空数组（会话清理不该因为一个坏目录整体失败）。 */
function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * 一个员工的会话。**员工与会话是一对多**——这是与旧版最大的区别：
 * 旧版把会话写死成 `waker-<id>`，一个员工只有一个会话，没有新建/切换/命名。
 */
export interface SessionMeta {
  /** 平台内部会话 id（短）。`default` 为保留值。 */
  id: string;
  wakerId: string;
  /** 显示名，可重命名。 */
  name: string;
  /** 传给 pi `--session-id` 的值，决定上下文落在哪个 pi 会话文件。 */
  piSessionId: string;
  createdAt: string;
  lastActiveAt: string;
  /** 累计消息数，粗略反映会话活跃度。 */
  messageCount: number;
  /** 话题标题：给用户看的短名，由首条消息派生，不调模型。 */
  title?: string;
  /**
   * 名字的来源：auto = 模型在第 3 轮起的，manual = 用户自己改的。
   * 都没有就是系统默认名（「默认会话」「会话 2」）。
   *
   * 有了它，自动命名就知道"这个名字已经有人定过了"，不会反复覆盖用户的选择。
   */
  nameSource?: 'auto' | 'manual';
  /**
   * 名字是怎么来的：`derive` = 建会话时截用户首句前 18 字，`messages` = 模型读对话起的，
   * `card` = 用会话卡首行生成的。
   *
   * `nameSource` 只分"自动/手动"，答不出"这个名字值不值得再升级"。首句派生的名字常常是
   * 「你可能能从记忆里找到…」这种元话语，对判断"要不要切回这个话题"毫无帮助，
   * 所以升级只许单向走 derive → messages → card，`manual` 永不覆盖。
   */
  nameFrom?: 'derive' | 'messages' | 'card';
  /** 接续自哪个会话：开新弹巢时记录，用于展示"接续自 X"。 */
  parentId?: string;
  /** 这一轮的提问已被转到另一个会话（源会话留痕，不删消息）。 */
  transferredTo?: string;
  /**
   * 会话卡：给用户看的话题摘要（≤200 字），由闲置时的后台调用生成。
   * 与 pi 自己的 compaction 摘要不是一回事——那份是给模型看的，这份是给人判断"要不要切回"用的。
   */
  cardSummary?: string;
  /** 卡片生成时间。 */
  cardAt?: string;
  /** 卡片覆盖到第几条消息（对照 messageCount 判断是否过期）。 */
  cardCovered?: number;
  /**
   * 离场快照（episode）上次拍到了第几条有效对话。
   *
   * 与 `cardCovered` 分开记：卡片是"给人看的摘要"，游标按平台 messageCount 算；
   * 快照是"给召回用的身份指纹"，游标按**过滤掉流程噪声后的对话条数**算——
   * 两者口径不同，共用一个游标会让增量算错（漏摘或重摘）。
   */
  episodeCovered?: number;
  /** 最近一次快照完成的时间（ISO8601）。 */
  episodeAt?: string;
  /** 有新消息待摘要的时间戳；为空表示没有待办。 */
  dirtyAt?: string;
  /** 自上次摘要以来新增的消息条数（够多才值得重算）。 */
  dirtyCount?: number;
  /**
   * 外部渠道的会话标识（如 `feishu:u_<open_id>` / `feishu:g_<chat_id>`）。
   * 有它就能把同一个飞书会话稳定映射到同一个平台会话。
   */
  externalKey?: string;
}

type Store = Record<string, SessionMeta[]>;

export const DEFAULT_SESSION_ID = 'default';

/** 默认会话对应的 pi 会话 id。与旧版本保持一致，兼容既有对话与飞书映射。 */
export function defaultPiSessionId(wakerId: string): string {
  return `waker-${wakerId}`;
}

function ensureFile(): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  if (!existsSync(SESSIONS_FILE)) writeFileSync(SESSIONS_FILE, '{}\n', 'utf-8');
}

function readStore(): Store {
  ensureFile();
  try {
    const raw = readFileSync(SESSIONS_FILE, 'utf-8').trim();
    return raw ? (JSON.parse(raw) as Store) : {};
  } catch {
    return {};
  }
}

function writeStore(store: Store): void {
  ensureFile();
  writeFileSync(SESSIONS_FILE, `${JSON.stringify(store, null, 2)}\n`, 'utf-8');
}

function makeDefault(wakerId: string): SessionMeta {
  const now = new Date().toISOString();
  return {
    id: DEFAULT_SESSION_ID,
    wakerId,
    name: '默认会话',
    piSessionId: defaultPiSessionId(wakerId),
    createdAt: now,
    lastActiveAt: now,
    messageCount: 0,
  };
}

function byActivityDesc(a: SessionMeta, b: SessionMeta): number {
  return a.lastActiveAt < b.lastActiveAt ? 1 : a.lastActiveAt > b.lastActiveAt ? -1 : 0;
}

/** 列出员工全部会话：默认会话置顶，其余按最近活跃倒序。默认会话不存在时自动补上。 */
export function listSessions(wakerId: string): SessionMeta[] {
  const store = readStore();
  const list = store[wakerId] ?? [];
  if (!list.length) {
    const created = makeDefault(wakerId);
    store[wakerId] = [created];
    writeStore(store);
    return [created];
  }
  const def = list.find((s) => s.id === DEFAULT_SESSION_ID);
  const rest = list.filter((s) => s.id !== DEFAULT_SESSION_ID).sort(byActivityDesc);
  return def ? [def, ...rest] : rest;
}

/** 解析一个会话：给定 id 存在则返回它，否则回落到默认会话（并确保默认会话存在）。 */
export function resolveSession(wakerId: string, sessionId?: string): SessionMeta {
  const list = listSessions(wakerId);
  if (sessionId) {
    const hit = list.find((s) => s.id === sessionId);
    if (hit) return hit;
  }
  return list.find((s) => s.id === DEFAULT_SESSION_ID) ?? list[0]!;
}

/** 新建会话。返回新建的会话元数据。 */
export function createSession(wakerId: string, name?: string): SessionMeta {
  const store = readStore();
  const list = store[wakerId] ?? [];
  if (!list.some((s) => s.id === DEFAULT_SESSION_ID)) list.push(makeDefault(wakerId));

  const seq = list.filter((s) => s.id !== DEFAULT_SESSION_ID).length + 1;
  const now = new Date().toISOString();
  const id = randomUUID().slice(0, 8);
  const created: SessionMeta = {
    id,
    wakerId,
    name: name?.trim() || `会话 ${seq}`,
    piSessionId: `waker-${wakerId}-${id}`,
    createdAt: now,
    lastActiveAt: now,
    messageCount: 0,
  };
  list.push(created);
  store[wakerId] = list;
  writeStore(store);
  return created;
}

/** 重命名会话。手动改过的名字打上标记，自动命名不再覆盖。 */
export function renameSession(wakerId: string, sessionId: string, name: string): SessionMeta | null {
  const store = readStore();
  const list = store[wakerId] ?? [];
  const hit = list.find((s) => s.id === sessionId);
  if (!hit) return null;
  hit.name = name.trim() || hit.name;
  hit.nameSource = 'manual';
  writeStore(store);
  return hit;
}

/** 局部更新会话元数据（标题、接续关系、跳转留痕）。 */
export function patchSession(wakerId: string, sessionId: string, patch: Partial<SessionMeta>): SessionMeta | null {
  const store = readStore();
  const hit = (store[wakerId] ?? []).find((s) => s.id === sessionId);
  if (!hit) return null;
  Object.assign(hit, patch);
  writeStore(store);
  return hit;
}

/**
 * 标记会话活跃：更新 lastActiveAt 并累加消息数。
 * 在每次对话落一次，用于看板按活跃度排序。
 */
export function touchSession(wakerId: string, sessionId: string, added = 1): void {
  const store = readStore();
  const list = store[wakerId] ?? [];
  const hit = list.find((s) => s.id === sessionId);
  if (!hit) return;
  hit.lastActiveAt = new Date().toISOString();
  hit.messageCount += added;
  writeStore(store);
}

/**
 * 删除会话。
 *
 * **默认会话不允许删**：它是兜底会话（`resolveSession` 找不到指定会话时回落到它，
 * `waker say` / `chat` 不带参数、以及按外部 key 建会话时都以它为基准）。删掉之后，
 * 下一次任何"不指定会话"的调用都会把它重新建出来——用户看到的就是"删了又回来"。
 * 想重置上下文请用 `clearSession`。
 */
export function deleteSession(wakerId: string, sessionId: string): boolean {
  if (sessionId === DEFAULT_SESSION_ID) return false;
  const store = readStore();
  const list = store[wakerId] ?? [];
  const next = list.filter((s) => s.id !== sessionId);
  if (next.length === list.length) return false;
  store[wakerId] = next;
  writeStore(store);
  return true;
}

/** 删掉某员工的全部会话条目（删员工时清理孤儿；pi 原生会话文件不动）。 */
export function dropWakerSessions(wakerId: string): number {
  const store = readStore();
  const n = store[wakerId]?.length ?? 0;
  if (n) {
    delete store[wakerId];
    writeStore(store);
  }
  return n;
}

/** 该会话是否可删（默认会话不可删，只能清空）。 */
export function isDeletable(sessionId: string): boolean {
  return sessionId !== DEFAULT_SESSION_ID;
}

/**
 * 清空会话上下文：把该会话对应的 pi 会话文件**改名归档**，并重置消息计数。
 *
 * 为什么是"改名"而不是删文件：归档后仍可人工翻回来（`*.jsonl.cleared-<时间戳>`），
 * 而 pi 只认 `.jsonl`，所以对它来说上下文已经归零。会话条目本身保留——它承载的
 * 会话 key、外部映射、命名都不该因为"想清空上下文"而丢失。
 */
export function clearSession(wakerId: string, sessionId: string): { ok: boolean; files: number } {
  const session = resolveSession(wakerId, sessionId);
  if (session.id !== sessionId) return { ok: false, files: 0 };

  const root = join(PI_AGENT_HOME, 'sessions');
  let files = 0;
  if (existsSync(root)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    for (const dir of safeReaddir(root)) {
      const full = join(root, dir);
      try {
        if (!statSync(full).isDirectory()) continue;
      } catch {
        continue;
      }
      for (const f of safeReaddir(full)) {
        // 文件名形如 `<ts>_<piSessionId>.jsonl`；用后缀匹配避免误伤别的会话
        if (!f.endsWith(`_${session.piSessionId}.jsonl`)) continue;
        try {
          renameSync(join(full, f), join(full, `${f}.cleared-${stamp}`));
          files += 1;
        } catch {
          /* 单个文件失败不影响其他 */
        }
      }
    }
  }

  const store = readStore();
  const hit = (store[wakerId] ?? []).find((s) => s.id === sessionId);
  if (hit) {
    hit.messageCount = 0;
    hit.lastActiveAt = new Date().toISOString();
    writeStore(store);
  }
  return { ok: true, files };
}

/**
 * 按外部渠道 key 解析会话：命中则复用，未命中则新建一个带 externalKey 的会话。
 * 渠道入站消息靠它把"一个飞书会话"稳定映射到"一个平台会话"。
 */
export function resolveSessionByKey(wakerId: string, key: string, name?: string): SessionMeta {
  const store = readStore();
  const list = store[wakerId] ?? [];
  const hit = list.find((s) => s.externalKey === key);
  if (hit) return hit;

  if (!list.some((s) => s.id === DEFAULT_SESSION_ID)) list.push(makeDefault(wakerId));
  const seq = list.filter((s) => s.id !== DEFAULT_SESSION_ID).length + 1;
  const now = new Date().toISOString();
  const id = randomUUID().slice(0, 8);
  const created: SessionMeta = {
    id,
    wakerId,
    name: name?.trim() || `外部会话 ${seq}`,
    piSessionId: `waker-${wakerId}-${id}`,
    createdAt: now,
    lastActiveAt: now,
    messageCount: 0,
    externalKey: key,
  };
  list.push(created);
  store[wakerId] = list;
  writeStore(store);
  return created;
}
