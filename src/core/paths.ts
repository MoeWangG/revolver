import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** 项目根（src/core 的上两级）。 */
export const PLATFORM_ROOT = resolve(here, '..', '..');

/** Pi 的扩展目录。新扩展以软链方式投放，不复制代码。 */
export const PI_HOME = process.env.PI_HOME ?? join(homedir(), '.pi');
export const PI_AGENT_HOME = join(PI_HOME, 'agent');
export const PI_EXTENSIONS_DIR = join(PI_AGENT_HOME, 'extensions');

/**
 * Pi 本地已有的 agent / subagent profile 目录（`~/.pi/agent/agents/*.md`）。
 * 这是 Pi 生态里既有的资产，Waker 只读取纳管、不接管其生命周期。
 */
export const PI_AGENTS_DIR = process.env.PI_AGENTS_DIR ?? join(PI_AGENT_HOME, 'agents');

/** 平台数据目录。可用 WAKER_DATA 覆盖以便多实例隔离。 */
export const DATA_DIR = process.env.WAKER_DATA ?? join(PLATFORM_ROOT, 'data');

/** 员工档案目录。 */
export const AGENTS_DIR = process.env.WAKER_AGENTS ?? join(PLATFORM_ROOT, 'agents');

/** 自研扩展源码目录（软链的源端）。 */
export const EXTENSIONS_SRC_DIR = join(PLATFORM_ROOT, 'extensions');

export const TASKS_FILE = join(DATA_DIR, 'tasks.jsonl');
/**
 * 待办表（JSONL 追加写）。
 *
 * 与 tasks.jsonl 分开：tasks 是**已发生的执行流水**（不可变账本），
 * todos 是**尚未发生的意图**（会改状态、会被顺延）。混在一起会让"回溯"与"待办"互相污染。
 */
export const TODOS_FILE = join(DATA_DIR, 'todos.jsonl');
/** 员工会话表：员工与会话是一对多。 */
export const SESSIONS_FILE = join(DATA_DIR, 'sessions.json');
/**
 * 对话表：窗口（渠道）→ 当前会话的指针。
 *
 * 与 sessions.json 分开是因为语义不同：sessions 是"有哪些弹巢"（内容），
 * conversations 是"这个窗口现在对准哪个弹巢"（指针）。指针会频繁变，
 * 混在一起会让会话表每次切换都被整篇重写。
 */
export const CONVERSATIONS_FILE = join(DATA_DIR, 'conversations.json');
/** 话题判定流水：每次路由决定一行，用于回看"为什么切/为什么没切"。 */
export const ROUTING_LOG = join(DATA_DIR, 'routing.jsonl');
/**
 * 离场快照（episode）：每次会话切换时，把被离开的那段对话固化成一块可召回的表示。
 *
 * 与 `session-vectors.jsonl` 分开存：那边是"每条消息一块"的常规索引，
 * 这边是"一段对话一块"的高权重表示，重建/清空其中一个时不该影响另一个。
 */
export const EPISODES_FILE = join(DATA_DIR, 'episodes.jsonl');
/**
 * 决策账本：**一次推荐从"判了什么"到"用户点了什么、最后落在哪"的完整闭环**。
 *
 * 与 `routing.jsonl` 的区别：那边是"判定瞬间的快照"（只回答为什么切/没切）；
 * 这边是**事件流**，用同一个 `id` 串起 route → ask → answer → final 四步，
 * 用来回答"自动推荐准不准、用户是接受还是纠正、纠正在哪一步发生"。
 * 只有带上用户的选择，阈值和候选排序才有可优化的依据。
 */
export const DECISIONS_LOG = join(DATA_DIR, 'decisions.jsonl');
/**
 * 会话向量索引：每条用户消息（+ 标题 + 会话卡）一行，含向量。
 *
 * 与 `routing.jsonl` / `decisions.jsonl` 的职责不同：那两个是**判定的记账**，
 * 这个是为了**不重复算**——写入时增量 embed，查询时只算这一句。
 */
export const SESSION_VECTORS_FILE = join(DATA_DIR, 'session-vectors.jsonl');
/**
 * 渠道配置目录（平台侧）。按员工 id 存放，**与员工目录解耦**，
 * 这样纳管的 Pi agent（没有自己的目录）也能挂飞书渠道。
 */
export const CHANNELS_DIR = join(DATA_DIR, 'channels');
export const AUTOMATIONS_FILE = join(DATA_DIR, 'automations.json');
export const GROUPS_FILE = join(DATA_DIR, 'groups.json');
export const WAKERS_INDEX = join(DATA_DIR, 'wakers.json');
export const POLICY_DIR = join(DATA_DIR, 'policy');
/** browser-broker 的 pid 文件（`waker browser stop` 用）。 */
export const BROKER_PID_FILE = join(DATA_DIR, 'browser-broker.pid');
/**
 * 员工头像目录。**与档案目录解耦**，这样纳管的 Pi 员工（本身没有平台档案目录）
 * 也能拥有自己的头像，且归档本地员工时不会误删头像文件。
 */
export const AVATARS_DIR = join(DATA_DIR, 'avatars');
/**
 * 归档区：删员工时**移动**档案目录到这里，而不是直接删除。
 * 误删是不可逆的，移动之后随时能搬回来；目录名带时间戳，同一个 id 可以归档多次。
 */
export const ARCHIVE_DIR = join(DATA_DIR, 'archived');

/** 已有资产（复用，不重建）。默认与 pi-web-extensions README 一致。 */
/**
 * 记忆中心地址。
 *
 * 默认指向 **waker 自带的 multi-pi-memory 实例**（8971，按员工命名空间隔离）；
 * 仍可用 `WAKER_MEMORY_SERVER` / `PI_MEMORY_SERVER` 覆盖（例如指回原来的单例 8970）。
 */
export const MEMORY_SERVER =
  process.env.WAKER_MEMORY_SERVER ?? process.env.PI_MEMORY_SERVER ?? 'http://127.0.0.1:8971';
export const WAL_DIR = process.env.PI_WAL_DIR ?? join(PI_AGENT_HOME, 'wal');

export const PI_BIN = process.env.PI_BIN ?? 'pi';

/** 员工 id 白名单：只允许安全字符，杜绝路径穿越。 */
export function safeId(raw: string): string {
  return String(raw).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'unknown';
}

export function agentDir(id: string): string {
  return join(AGENTS_DIR, safeId(id));
}

export function policyFile(id: string): string {
  return join(POLICY_DIR, `${safeId(id)}.policy.json`);
}

export function ensureDirs(): void {
  for (const d of [DATA_DIR, AGENTS_DIR, POLICY_DIR, PI_EXTENSIONS_DIR, CHANNELS_DIR, AVATARS_DIR, ARCHIVE_DIR]) {
    mkdirSync(d, { recursive: true });
  }
}
