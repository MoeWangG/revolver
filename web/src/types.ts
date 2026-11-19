export type TaskSource = 'cli' | 'cron' | 'im' | 'api' | 'web';

export type TaskStatus = 'arrived' | 'queued' | 'running' | 'awaiting' | 'success' | 'failed' | 'cancelled';

/** 员工来源：项目内档案，或纳管自 Pi 的 agent / subagent profile。 */
export type WakerOrigin = 'local' | 'pi';

export interface TaskRecord {
  taskId: string;
  wakerId: string;
  source: TaskSource;
  status: TaskStatus;
  prompt: string;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  sessionRef?: string;
  pid?: number;
  error?: string;
  result?: string;
  blockedCount?: number;
  groupRunId?: string;
}

export interface WakerSummary {
  id: string;
  name: string;
  role: string;
  enabled: boolean;
  todayTasks: number;
  running: number;
  origin?: WakerOrigin;
  /** 是否已设置自定义头像（未设置时前端回退到首字母）。 */
  avatar?: boolean;
  /** 是否已开启浏览器能力（policy.browser），名册上直接显示开关状态用。 */
  browser?: boolean;
}

// —— 使用统计（token / 费用）——

export interface UsageDay {
  date: string;
  tokens: number;
  cost: number;
  runs: number;
  /** 当日有消耗的员工数，用于热力图强度。 */
  wakers: number;
}

export interface UsagePeriod {
  tokens: number;
  cost: number;
  runs: number;
}

export interface UsageView {
  days: UsageDay[];
  totals: { today: UsagePeriod; week: UsagePeriod; month: UsagePeriod; all: UsagePeriod };
  files: number;
  windowDays: number;
  updatedAt: string;
}

/** POST /api/agents 的返回，即员工档案摘要。 */
export interface WakerDetail {
  id: string;
  name: string;
  role: string;
  model: string;
  cwd: string;
  enabled: boolean;
  origin?: WakerOrigin;
  sandbox: boolean;
  hasIdentity: boolean;
  hasPersona: boolean;
  hasBible: boolean;
  issues: Array<{ level: string; field: string; message: string }>;
}

/** 员工基本信息（Agent 设置里可改名/岗位/模型）。 */
export interface WakerProfile {
  id: string;
  name: string;
  role: string;
  model: string;
  cwd: string;
  enabled: boolean;
  origin: WakerOrigin;
  /** 纳管自 Pi 的 profile 为只读。 */
  editable: boolean;

  /**
   * 后端在改动有副作用时回的提醒（目前只有换工作目录：pi 会话按目录存放）。
   * 必须转达给用户——不说，"会话列表变短"就会被当成"记录丢了"。
   */
  warnings?: string[];
}

/**
 * 权限视图（Agent 设置 · 权限）。取的是**生效值**（后端 registry 解析后的结果）。
 *
 * 两个"空"的语义不一样，界面上必须写清楚：
 * - `pathAllow` 为空 = **不限制**（可读写整个文件系统）；
 * - `pathDeny` 为空 = 不再额外保护，`.ssh`/`.env` 这类凭据也会被放行。
 */
export interface AgentPermissions {
  id: string;
  editable: boolean;
  pathAllow: string[];
  pathDeny: string[];
  /** 员工可否修改自己的档案（waker_self_edit 工具）。 */
  selfEdit: boolean;
  /** 员工可否操作浏览器（browser 工具，经常驻 broker）。 */
  browser: boolean;
  /** 工作目录：白名单条目以它为基准，也用于提示"白名单没覆盖它自己的目录"。 */
  cwd: string;
  /** 保存后后端回的副作用提醒。 */
  warnings?: string[];
}

/**
 * 常驻防睡眠状态（工具 → 系统）。
 *
 * `enabled` 是配置里的开关，`active` 是断言进程真的在跑——两者不一致时必须让人看见
 * （常见于：开关开了但环境不支持、或断言进程被手动 kill 掉）。
 */
export interface SleepGuardStatus {
  supported: boolean;
  enabled: boolean;
  active: boolean;
  pid?: number;
  since?: string;
  note?: string;
}

/** 可编辑的档案文件视图。 */
export interface AgentFileView {
  name: string;
  path: string;
  exists: boolean;
  content: string;
  bytes: number;
  updatedAt: string | null;
}

/** 员工会话（员工 1:N 会话）。 */
export interface SessionMeta {
  id: string;
  /** 话题标题（首条消息派生）。界面优先显示它，没有就退回 name。 */
  title?: string;
  wakerId: string;
  name: string;
  piSessionId: string;
  createdAt: string;
  lastActiveAt: string;
  messageCount: number;
}

/** 看板的会话视图：以会话语义聚合，而不是每次消息一条。 */
export interface SessionView {
  wakerId: string;
  wakerName: string;
  origin: WakerOrigin;
  sessionId: string;
  name: string;
  source: TaskSource;
  messageCount: number;
  lastActiveAt: string;
  lastPrompt?: string;
  lastResult?: string;
  lastStatus?: TaskStatus;
  externalKey?: string;
  /** 该会话是否有任务正在运行（显示转圈）。 */
  running?: boolean;
  /** 该会话累计 token 数。 */
  tokens?: number;
  /** 该会话累计费用（USD，按模型价格表计算）。 */
  cost?: number;
  /** 该会话的 assistant 消息条数。 */
  runs?: number;
}

// —— 会话用量（按模型拆分）——

export interface ModelPriceView {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** 单价来源：平台价格表覆盖 / pi 模型目录。 */
  source: 'override' | 'pi';
  name?: string;
}

export interface ModelUsage {
  model: string;
  tokens: number;
  cost: number;
  /** cost 的算法：价格表算出 / 取自 pi 记录。 */
  source: 'table' | 'recorded';
  /** 命中价格表时的单价（USD / 1M tokens）。 */
  price?: ModelPriceView;
}

export interface SessionUsage {
  piSessionId: string;
  sessionId?: string;
  name?: string;
  tokens: number;
  cost: number;
  runs: number;
  source: 'table' | 'recorded' | 'mixed';
  models: ModelUsage[];
}

/** 插件入口（挂到看板上、点击跳转的本机页面）。 */
export interface PluginEntry {
  name: string;
  url: string;
  desc?: string;
}

/** 定时任务。 */
export interface Automation {
  id: string;
  name: string;
  wakerId: string;
  promptTemplate: string;
  triggers: Array<{ kind: string; cron?: string; at?: string; name?: string }>;
  enabled: boolean;
  runCount: number;
  createdAt: string;
}

/** 飞书渠道配置视图（不含密钥明文）。 */
export interface FeishuChannelConfigView {
  enabled?: boolean;
  /** 该机器人服务的员工 id。 */
  agent?: string;
  appId?: string;
  allowedUsers?: string[];
  allowedChats?: string[];
  allowAllChats?: boolean;
  allowAllUsers?: boolean;
}

export interface ChannelConfigView {
  feishu: FeishuChannelConfigView | null;
  hasAppSecret: boolean;
  path: string;
}

/** 渠道运行状态。 */
export interface ChannelStatus {
  kind: string;
  wakerId: string;
  agentId: string;
  name: string;
  state: 'starting' | 'running' | 'stopped' | 'error';
  error?: string;
  startedAt?: string;
}

/** 运行中的 pi 子进程（运行时视图，来自 GET /api/runtime）。 */
export interface ProcView {
  taskId: string;
  wakerId: string;
  source: TaskSource;
  /** 所属平台会话 id（独立任务为空）。 */
  sessionId?: string;
  prompt: string;
  startedAt: string;
  /** 已运行毫秒（服务端按请求时刻计算）。 */
  elapsedMs: number;
  pid?: number;
  /** 最近的输出尾部（stdout + stderr）。 */
  tail: string;
  /** 已发出终止信号，等待退出。 */
  cancelling?: boolean;
}

export interface RuntimeView {
  generatedAt: string;
  /** 网关进程运行秒数。 */
  uptime: number;
  memoryMb: number;
  procs: ProcView[];
  /** 执行队列：同会话串行 + 每员工/全局并发上限。 */
  queue?: {
    running: number;
    waiting: number;
    maxTotal: number;
    maxPerWaker: number;
    queued: Array<{ taskId: string; wakerId: string; key: string }>;
  };
}

/** 可导入的本机 Pi agent（GET /api/pi-agents）。 */
export interface PiAgentBrief {
  id: string;
  name: string;
  role: string;
  model: string;
  tools: string[];
  enabled: boolean;
  /** 源文件绝对路径（~/.pi/agent/agents/<id>.md）。 */
  file: string;
  /** 平台侧是否已有同名档案（已有则不能再导入）。 */
  imported: boolean;
}

/** 平台级配置（GET/PUT /api/config）。 */
export interface PlatformConfig {
  /**
   * 是否自动纳管 Pi 侧 agent（默认 false）。
   * 打开后 Pi 的全部 agent 以只读（Pi 徽标）出现在名册里；平时用"导入"逐个收编。
   */
  piAgents: boolean;
}

/** 待办执行者：agent 到点自己做；human 到点提醒人。 */
export type TodoAssignee = 'agent' | 'human';
/** 存储状态。到期 / 过期不入库，由 dueAt 与当前时间派生。 */
export type TodoStatus = 'pending' | 'running' | 'done' | 'dismissed' | 'failed';
export type TodoPhase = TodoStatus | 'due' | 'overdue';

export interface TodoView {
  id: string;
  wakerId: string;
  assignee: TodoAssignee;
  title: string;
  detail?: string;
  /** 截止时刻（ISO UTC）。 */
  dueAt: string;
  status: TodoStatus;
  source: TaskSource;
  createdAt: string;
  updatedAt?: string;
  doneAt?: string;
  note?: string;
  sessionId?: string;
  externalKey?: string;
  /** 留下它的那轮任务 id：详情里据此取回用户原话，定位到会话里的具体一条消息。 */
  sourceTaskId?: string;
  taskId?: string;
  result?: string;
  error?: string;
  snoozedCount?: number;
}

export interface BoardSnapshot {
  generatedAt: string;
  counts: Record<TaskStatus, number>;
  tasks: TaskRecord[];
  /** 待办（人类 + agent 两类），看板靠它做到期提醒。 */
  todos: TodoView[];
  /** 定时任务：成功 / 失败执行次数，以及仍在计划中的任务数。 */
  cronStats: { success: number; failed: number; planned: number };
  /** 待办进度：今天处理掉的条数 + 今天该处理却还没做完的条数（截止≤今天，含逾期）。 */
  todoStats: { doneToday: number; pendingToday: number };
  wakers: WakerSummary[];
  health: {
    memoryServer: boolean;
    docker: boolean;
    pi: boolean;
  };
}

// —— 架构与版本（GET /api/architecture）——

/** 一条更新记录。 */
export interface ReleaseItem {
  /** 所属分节（新增 / 变更 / 修复…），没写分节时为空串。 */
  section: string;
  text: string;
}

/** 一个版本的更新记录（解析自 CHANGELOG.md）。 */
export interface ReleaseEntry {
  version: string;
  /** 没有日期时缺省（例如 Unreleased）。 */
  date?: string;
  items: ReleaseItem[];
}

/** 架构里的一个模块。 */
export interface ArchitectureNode {
  name: string;
  role: string;
  /** 主要文件或目录（相对仓库根）。 */
  path?: string;
}

/** 架构里的一层。 */
export interface ArchitectureLayer {
  id: string;
  title: string;
  caption: string;
  nodes: ArchitectureNode[];
}

export interface ArchitectureView {
  name: string;
  /** `package.json` 的版本。构建快照与运行时接口都读同一个文件。 */
  version: string;
  description: string;
  /** 仅运行时接口会带（这次读取的时间）；构建快照里刻意没有，避免每次构建都产生 diff。 */
  generatedAt?: string;
  layers: ArchitectureLayer[];
  releases: ReleaseEntry[];
  changelog: string;
  /** false = 仓库里没有更新记录文件，页面要如实说明。 */
  changelogFound: boolean;
}
