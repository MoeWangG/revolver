import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { AutomationDef, BoardSnapshot, SessionView, TaskRecord, TaskSource, TaskStatus } from '../types.ts';
import { AUTOMATIONS_FILE, DATA_DIR, MEMORY_SERVER, TASKS_FILE } from '../core/paths.ts';
import { loadAllWakers } from '../core/registry.ts';
import { hasAvatar } from '../core/avatars.ts';
import { listSessions } from '../core/sessions.ts';
import { lastExchanges } from '../core/sessionHistory.ts';
import { listTodos } from '../core/todos.ts';
import { usageBySession } from '../core/usage.ts';

/**
 * 「你自己发起的对话」来源。
 * cron / api 是系统或外部触发，算进"今日提问"会让数字虚高
 * （实测：两条定时任务流水把今日提问从 16 顶到 18）。
 */
const ASK_SOURCES = new Set<TaskSource>(['im', 'web', 'cli']);

const EMPTY_COUNTS: Record<TaskStatus, number> = {
  arrived: 0,
  queued: 0,
  running: 0,
  awaiting: 0,
  success: 0,
  failed: 0,
  cancelled: 0,
};

function ensureFile(): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  if (!existsSync(TASKS_FILE)) writeFileSync(TASKS_FILE, '', 'utf-8');
}

/** 读取全部任务，坏行跳过（与 WAL 的容错风格一致）。 */
export function readTasks(): TaskRecord[] {
  ensureFile();
  const raw = readFileSync(TASKS_FILE, 'utf-8');
  const out: TaskRecord[] = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as TaskRecord);
    } catch {
      /* 忽略坏行，避免一条脏数据打挂整个看板 */
    }
  }
  return out;
}

function writeTasks(tasks: TaskRecord[]): void {
  ensureFile();
  writeFileSync(TASKS_FILE, `${tasks.map((t) => JSON.stringify(t)).join('\n')}${tasks.length ? '\n' : ''}`, 'utf-8');
}

/** 追加一条任务。 */
export function appendTask(task: TaskRecord): TaskRecord {
  ensureFile();
  writeFileSync(TASKS_FILE, `${JSON.stringify(task)}\n`, { encoding: 'utf-8', flag: 'a' });
  return task;
}

export function createTask(
  wakerId: string,
  prompt: string,
  source: TaskSource,
  /** 附加字段（如定时任务的 automationId），与基础字段合并后落库。 */
  extra?: Partial<TaskRecord>,
): TaskRecord {
  return appendTask({
    taskId: randomUUID(),
    wakerId,
    source,
    status: 'arrived',
    prompt,
    createdAt: new Date().toISOString(),
    ...extra,
  });
}

/**
 * 局部更新任务。JSONL 无法原地改，采用读-改-写全量。
 * 任务量在千级时开销可忽略，换来的是可 grep / 可 diff 的纯文本流水。
 */
export function updateTask(taskId: string, patch: Partial<TaskRecord>): TaskRecord | null {
  const tasks = readTasks();
  const idx = tasks.findIndex((t) => t.taskId === taskId);
  if (idx === -1) return null;
  const next = { ...tasks[idx]!, ...patch };
  tasks[idx] = next;
  writeTasks(tasks);
  return next;
}

export function getTask(taskId: string): TaskRecord | null {
  return readTasks().find((t) => t.taskId === taskId) ?? null;
}

/**
 * 收尾上一轮进程遗留的 running / queued 任务。
 *
 * pi 子进程随宿主进程退出而退出，所以进程重启后这两个状态**一定是假的**——
 * 不清理的话看板会永远显示"运行中"，运行时的进程登记表里也找不到它。
 * 只该在网关启动时调用（CLI 是另一个进程，误判会覆盖看板正在跑的任务）。
 */
export function reapOrphanTasks(): number {
  const tasks = readTasks();
  let reaped = 0;
  for (const t of tasks) {
    if (t.status !== 'running' && t.status !== 'queued') continue;
    t.status = 'failed';
    t.endedAt = new Date().toISOString();
    t.error = '进程重启，任务已中断';
    reaped += 1;
  }
  if (reaped) writeTasks(tasks);
  return reaped;
}

export interface TaskFilter {
  wakerId?: string;
  source?: TaskSource;
  status?: TaskStatus;
  limit?: number;
}

export function listTasks(filter: TaskFilter = {}): TaskRecord[] {
  let tasks = readTasks();
  if (filter.wakerId) tasks = tasks.filter((t) => t.wakerId === filter.wakerId);
  if (filter.source) tasks = tasks.filter((t) => t.source === filter.source);
  if (filter.status) tasks = tasks.filter((t) => t.status === filter.status);
  // 最新的排前面
  tasks.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  return filter.limit ? tasks.slice(0, filter.limit) : tasks;
}

/**
 * 依赖服务健康探测：读即用，失败视为不可用，不做重试。
 *
 * 打的是 `/api/ping` 而不是 `/api/status`：后者会同步调 `lms ps`（最长 30s），
 * 用 1~2s 超时探活必然误判"离线"——记忆灯就是这样间歇性闪红的。
 * 探活只该问"你还活着吗"。
 */
async function probe(url: string): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    const res = await fetch(`${url}/api/ping`, { signal: ctrl.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

const execFileAsync = promisify(execFile);

/**
 * 命令可用性探测。
 *
 * 两个关键点：
 *  1. **异步**——早先用 `execFileSync`，docker 不可用时每次都要卡满超时，
 *     把单线程事件循环堵死，导致同一时刻其它请求（如看板接口）排队假死；
 *  2. **缓存 60 秒**——探针没必要每 5 秒跑一次（看板轮询很密）。
 */
let healthCache: { at: number; docker: boolean; pi: boolean } | null = null;

async function probeCmd(cmd: string, args: string[], timeout: number): Promise<boolean> {
  try {
    // execFile 没有 stdio 选项：输出走管道，给个上限避免大输出撑爆内存
    await execFileAsync(cmd, args, { timeout, windowsHide: true, maxBuffer: 1024 * 1024 });
    return true;
  } catch {
    return false;
  }
}

async function probeTools(): Promise<{ docker: boolean; pi: boolean }> {
  if (healthCache && Date.now() - healthCache.at < 60_000) return healthCache;
  const [docker, pi] = await Promise.all([
    probeCmd('docker', ['info'], 3000),
    probeCmd('pi', ['--version'], 5000),
  ]);
  healthCache = { at: Date.now(), docker, pi };
  return healthCache;
}

/**
 * 本地日期键（YYYY-MM-DD）。
 *
 * 任务流水里存的是 UTC ISO，**不能直接 startsWith(UTC 日期)**：东八区早上 8 点前
 * 产生的任务会被算到"昨天"，晚上 8 点后又会被算到"明天"。按本地年月日切才符合直觉。
 */
function localDateKey(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 组装看板视图。 */
/**
 * 读 automations.json（缺失 / 损坏都视为空）。
 *
 * 不直接 `import { loadAutomations } from './cron.ts'`：那会形成
 * board → cron → runner → board 的三元循环依赖，启动顺序稍变就会炸。
 */
function readAutomationDefs(): AutomationDef[] {
  try {
    const parsed = JSON.parse(readFileSync(AUTOMATIONS_FILE, 'utf-8')) as unknown;
    return Array.isArray(parsed) ? (parsed as AutomationDef[]) : [];
  } catch {
    return [];
  }
}

export async function buildSnapshot(): Promise<BoardSnapshot> {
  const tasks = readTasks();
  const counts: Record<TaskStatus, number> = { ...EMPTY_COUNTS };
  for (const t of tasks) counts[t.status] = (counts[t.status] ?? 0) + 1;

  const today = localDateKey(new Date().toISOString());

  // 只统计**当前仍存在的**定时任务的执行（按 automationId 关联）：
  // 光按 source=cron 统计会把早已删掉的任务也算进去，出现"0 个任务却完成 62 次"的怪数。
  const automations = readAutomationDefs();
  const automationIds = new Set(automations.map((a) => a.id));
  const cronTasks = tasks.filter((t) => t.automationId && automationIds.has(t.automationId));
  const cronStats = {
    success: cronTasks.filter((t) => t.status === 'success').length,
    failed: cronTasks.filter((t) => t.status === 'failed').length,
    planned: automations.filter((a) => a.enabled).length,
  };
  /**
   * 待办进度只算**今天该处理的**：
   *  - 已完成 = 今天标记完成的；
   *  - 待完成 = 截止日期 ≤ 今天且还没做完（含逾期积压）——
   *    明天及以后的不算，否则"今日 0/2"里会混进 11-07、11-14 那两条，看着像今天欠了两件事。
   */
  const todosAll = listTodos();
  const dueTodayOrBefore = (t: (typeof todosAll)[number]): boolean => {
    const key = localDateKey(t.dueAt);
    return key !== '' && key <= today;
  };
  const todoStats = {
    doneToday: todosAll.filter((t) => t.status === 'done' && t.doneAt && localDateKey(t.doneAt) === today).length,
    pendingToday: todosAll.filter(
      (t) => (t.status === 'pending' || t.status === 'running') && dueTodayOrBefore(t),
    ).length,
  };
  const wakers = loadAllWakers().map((rec) => {
    const mine = tasks.filter((t) => t.wakerId === rec.def.id);
    return {
      id: rec.def.id,
      name: rec.def.name,
      role: rec.def.role,
      enabled: rec.def.enabled,
      origin: rec.def.origin ?? 'local',
      avatar: hasAvatar(rec.def.id),
      // 名册上直接显示浏览器开关状态：卡片上一个地球图标，点一下即切
      browser: rec.def.policy.browser === true,
      todayTasks: mine.filter((t) => ASK_SOURCES.has(t.source) && localDateKey(t.createdAt) === today).length,
      running: mine.filter((t) => t.status === 'running').length,
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    counts,
    tasks: tasks.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, 300),
    // 待办一并返回：看板每 5s 只轮询一次 board，不必再为提醒单开一个请求
    todos: todosAll.slice(0, 200),
    cronStats,
    todoStats,
    wakers,
    health: {
      memoryServer: await probe(MEMORY_SERVER),
      ...(await probeTools()),
    },
  };
}

/** 由外部渠道 key 推断消息来源；无 key 时回落到最近任务的来源。 */
function inferSource(externalKey: string | undefined, fallback: TaskSource | undefined): TaskSource {
  if (externalKey?.startsWith('feishu:')) return 'im';
  return fallback ?? 'cli';
}

/**
 * 以**会话**为粒度聚合看板视图：每个会话一行，附带最近一次消息与状态。
 *
 * 这是与旧版的根本区别——旧版把"每次消息"当成一行任务，列表被消息淹没；
 * 现在任务退回到会话内部，看板看到的是"一个会话在做什么、最后说了什么"。
 */
export function buildSessionList(): SessionView[] {
  const tasks = readTasks();
  const out: SessionView[] = [];
  const wakers = loadAllWakers();

  // 展开"员工 × 会话"，并按这批 pi 会话 id 精确聚合用量（避免统计无关会话）
  const pairs = wakers.flatMap((rec) => listSessions(rec.def.id).map((s) => ({ rec, s })));
  const piIds = pairs.map((p) => p.s.piSessionId);
  const usage = usageBySession(piIds);
  // 行摘要取自 pi 会话文件的尾部（会话内容的真源），而不是任务流水——
  // 否则"清空会话"之后列表里还留着上一轮的提问与答复，看着像仍有上下文。
  // 流水依旧完整保留在 tasks.jsonl 里供回溯，只是不再当摘要用。
  const lastEx = lastExchanges(piIds);

  for (const { rec, s } of pairs) {
    const mine = tasks
      .filter((t) => t.wakerId === rec.def.id && t.sessionId === s.id)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    const last = mine[0];
    // 有排队中/运行中的任务就标"运行中"，看板显示转圈
    const running = mine.some((t) => t.status === 'running' || t.status === 'queued' || t.status === 'arrived');
    const u = usage.get(s.piSessionId);
    out.push({
      wakerId: rec.def.id,
      wakerName: rec.def.name,
      origin: rec.def.origin ?? 'local',
      sessionId: s.id,
      name: s.name,
      source: inferSource(s.externalKey, last?.source),
      title: s.title,
      messageCount: s.messageCount,
      lastActiveAt: s.lastActiveAt,
      lastPrompt: lastEx.get(s.piSessionId)?.prompt,
      lastResult: lastEx.get(s.piSessionId)?.result,
      lastStatus: last?.status,
      externalKey: s.externalKey,
      running,
      tokens: u?.tokens ?? 0,
      cost: u?.cost ?? 0,
      runs: u?.runs ?? 0,
    });
  }
  return out.sort((a, b) => (a.lastActiveAt < b.lastActiveAt ? 1 : a.lastActiveAt > b.lastActiveAt ? -1 : 0));
}
