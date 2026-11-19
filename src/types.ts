/**
 * Waker Platform — 核心类型契约
 *
 * 这份文件是「外壳」与「Pi Extension」之间的唯一契约。
 * 外壳负责读写 waker.yaml 并编译出 policy.json；Extension 只消费 policy.json，
 * 因此 Extension 侧不需要 Node 依赖图，加载极快（关键：before_agent_start 串行 await）。
 */

/** 权限策略。字段缺省即"放行"，除 sandbox 外均遵循最小权限原则按需收紧。 */
export interface WakerPolicy {
  /** 允许的工具名白名单（含通配符 *）。为空表示不限制。 */
  toolAllow?: string[];
  /** 显式禁止的工具名黑名单，优先级高于白名单。 */
  toolDeny?: string[];
  /** bash 命令前缀白名单，例如 ["ls","cat","git","node","npm"]。 */
  commandAllow?: string[];
  /** 命中即拦截的命令片段（大小写不敏感子串匹配）。 */
  commandDeny?: string[];
  /** 可读写目录白名单（绝对路径，最长前缀匹配）。 */
  pathAllow?: string[];
  /** 命中即拒绝的路径片段（保护 .ssh / .aws / 凭据类）。 */
  pathDeny?: string[];
  /** 需要人工确认的高危动作描述，命中时挂起等待批准。 */
  requireConfirm?: string[];
  /** bash 是否改走 Docker 容器执行。 */
  sandbox: boolean;
  /** 沙箱镜像，默认 alpine:3.20（体积小、启动快）。 */
  sandboxImage?: string;
  /** 容器是否允许外网访问。默认关闭，防止数据外泄。 */
  sandboxNetwork?: boolean;
  /** 单条命令超时毫秒数，默认 120000。 */
  commandTimeoutMs?: number;
  /**
   * 是否允许员工**操作浏览器**（经常驻 browser-broker，见 src/core/browserBroker.ts）。
   *
   * 默认 **false**。开启后它拿到 `browser` 工具（一条命令 DSL：goto / snapshot / click / fill…），
   * 操作对象是**你当前 Chrome 里扩展所连的那个标签页**——不是无头浏览器，复用真实登录态。
   * 因此风险有两层：
   * - 页面操作不可逆（误点删除 / 发布）；
   * - 标签页是共享的，同一时刻只该有一个任务在操作（broker 已串行化，但仍建议
   *   `requireConfirm` 保留"发布 / 对外发送"这类动作）。
   *
   * 开启后 runner 会把工具名并进 `--tools`，guard 也会在工具白名单之前放行；
   * 漏任一处都会变成"注册了但模型看不见"。
   */
  browser?: boolean;
  /**
   * 是否允许员工**修改自己的档案**（SOUL / identity / persona / bible / MEMORY 五份）。
   *
   * 默认 **false**。开启后它拿到 `waker_self_edit` 工具，但受三条不依赖它自觉的硬约束：
   * - **改不了 `waker.yaml`** —— 权限（toolAllow / pathAllow / commandAllow / 本开关本身）
   *   都不在可改文件之列，它无法自我扩权、也无法给自己解除门禁；
   * - **写前强制备份**到 `data/identity-history/<id>/`（可回滚）；
   * - **每次修改留痕**到 `data/selfedit.jsonl`（含它自己写的理由）。
   *
   * 语义上是"允许它改写自己的人设"，不是"允许它改自己的权限"。改动**下一次对话生效**
   * （身份在 pi 进程启动时装载，当前对话仍是旧人设）。
   */
  selfEdit?: boolean;
}

/**
 * 该员工独立的大模型配置。
 * 非敏感项写在 waker.yaml；`apiKey` 建议放 `agents/<id>/secrets.json`（已 gitignore）。
 */
export interface LlmConfig {
  /** 供应方，如 deepseek / anthropic / google。传给 pi 的 --provider。 */
  provider?: string;
  /** 模型标识，如 deepseek-v4-pro。传给 pi 的 --model。 */
  model?: string;
  /** 该员工的独立 API Key。传给 pi 的 --api-key。 */
  apiKey?: string;
  /** 自定义接入点（预留，pi 侧由 provider 定义决定）。 */
  baseUrl?: string;
  /** 思考档位：off/minimal/low/medium/high/xhigh/max。 */
  thinking?: string;
}

/** 飞书渠道配置。**每个 bot 可以是一套独立的飞书应用**。 */
export interface FeishuChannelConfig {
  enabled?: boolean;
  /** 该飞书机器人服务的员工 id（默认即承载此配置的员工自身）。 */
  agent?: string;
  /** 该 bot 的飞书应用 App ID。 */
  appId?: string;
  /** 该 bot 的飞书应用 App Secret（建议放 secrets.json）。 */
  appSecret?: string;
  /** 允许私聊的 open_id 列表（空 = 不允许任何人）。 */
  allowedUsers?: string[];
  /** 允许使用的群 chat_id 列表。 */
  allowedChats?: string[];
  /** 允许响应**所有群消息**（无需把 chat_id 加进白名单）。 */
  allowAllChats?: boolean;
  /**
   * 收到消息时先给原消息加的表情（飞书 `emoji_type`，如 `THUMBSUP` / `OK` / `DONE`），
   * 作为"已收到、正在处理"的即时反馈；留空或不填用默认 `THUMBSUP`。
   * 注意：表情只能加在**用户发的消息**上，且需要应用具备表情回复权限。
   */
  ackEmoji?: string;
  /** 允许响应**所有私聊**（无需把 open_id 加进白名单）。 */
  allowAllUsers?: boolean;
}

/** 该员工独立的渠道配置。渠道逻辑由 Channel 层消费。 */
export interface ChannelsConfig {
  feishu?: FeishuChannelConfig;
}

/** 岗位员工档案（agents/<id>/waker.yaml 的反序列化形态）。 */
export interface WakerDef {
  /** 唯一标识，对应目录名 agents/<id>/。只允许 [a-z0-9-_]。 */
  id: string;
  /** 显示名，应体现岗位或服务对象，例如"官网前端维护"。 */
  name: string;
  /** 一句话岗位描述，用于列表卡片副标题。 */
  role: string;
  /** 模型标识，可填 auto 交给 pi 路由。 */
  model: string;
  /** 工作目录，同时是文件系统隔离边界。 */
  cwd: string;
  /** 停用后不再接受任何触发。 */
  enabled: boolean;
  policy: WakerPolicy;
  /**
   * 员工来源：
   * - `local`：项目内 `agents/<id>/` 目录式档案（可编辑、可版本化）；
   * - `pi`：纳管自 Pi 的 `~/.pi/agent/agents/<name>.md`（只读，改由 Pi 侧维护）。
   */
  origin?: 'local' | 'pi';
  /** 是否把 MEMORY.md 纳入 git 版本化快照。 */
  memoryVersioning?: boolean;
  /** 附加注入的系统提示（可选），会排在 identity/persona/bible 之后。 */
  extraPrompt?: string;
  /** 该员工独立的大模型配置（缺省时用 model 字段 / pi 默认）。 */
  llm?: LlmConfig;
  /** 该员工独立的渠道配置（如各自一套飞书应用凭证）。 */
  channels?: ChannelsConfig;
  /**
   * 会话策略。缺省等价于 single，即旧行为：一个渠道永远一个会话。
   * 注意它只决定"这次带哪段历史"，不碰人设、权限、记忆与 runner。
   */
  session?: SessionConfig;
}

/**
 * 会话策略（revolver 的核心开关）。
 *
 * 边界：**只影响上下文装在哪**。一旦这里能改身份或能力，
 * 它就从"会话模式"变成了"另一种 agent"，平台会分裂成两套调试路径。
 */
export interface SessionConfig {
  /**
   * single     = 一个渠道一个会话（旧行为）
   * topic      = 同渠道按话题换会话，判定后用询问确认
   * timeWindow = 只看时间：隔了 idleSplitHours 就换，不问也不看内容
   */
  mode: 'single' | 'topic' | 'timeWindow';
  /** 超过这么多小时无活动才考虑开新话题。0 = 不按时间判断。 */
  idleSplitHours: number;
  /** 换弹巢前是否询问。never = 直接切并告知。 */
  ask: 'always' | 'never';
  /** 连续拒绝多少次后停止询问，退化成不切。 */
  rejectLimit: number;
  /**
   * 是否允许"不问就切"。缺省 true（旧行为）。
   *
   * false = 判定为 NEW / SWITCH 时**一律先问**，且询问配额用尽后也不落指针（留在当前会话）。
   * 它是硬约束：同时配了 `ask: never` 时以它为准，避免"不许自动切"被另一项配置悄悄忽略。
   */
  autoSwitch?: boolean;
  /**
   * 聊到第 3 轮时，是否让模型给会话起个名字（覆盖「默认会话」「会话 2」这类默认名）。
   * 缺省开启；设成 false 则只保留用户手动改的名字。
   */
  autoName?: boolean;
  /** 话题摘要（会话卡）的生成策略。 */
  summary: SummaryConfig;
  /** 语义判定（向量）配置。 */
  semantic: SemanticConfig;
  /**
   * 小模型仲裁配置。
   *
   * 向量只负责"从 N 个会话里召回 3~5 个像的"，最终"继续 / 新话题 / 切回哪个"
   * 由这个小模型判。**不配置就退回纯阈值判定**（旧行为），所以它是可选增强。
   */
  arbiter?: ArbiterConfig;
}

/**
 * 小模型仲裁配置。
 *
 * 为什么敢让模型直接决定会话归属：下游还有 `ask: always` 的询问卡。
 * 判错的代价是"多问一句"，不是把用户搬到错误的会话里。
 */
export interface ArbiterConfig {
  /** 关掉即回到"只看向量阈值"的旧行为。 */
  enabled: boolean;
  /** OpenAI 兼容端点（需带 /v1）。与 embedding 共用 LM Studio 即可。 */
  baseUrl: string;
  model: string;
  /** 单次判定超时。超时一律当 CONTINUE（宁可少切，不可误切）。 */
  timeoutMs: number;
  /**
   * 用哪种接口问模型：
   *  - `systemone`：决策模型（如 laya）专用的 `/v1/systemone`，返回**概率**而不是文本；
   *  - `chat`：普通对话小模型，走 `/v1/chat/completions`，要求它输出 CONTINUE / NEW / SWITCH n；
   *  - `auto`（默认）：先试 systemone，不通再退 chat。
   *
   * 为什么要有这个开关（2026-11-05 实测）：laya 是 ModernBERT 决策模型，
   * **不对 chat/completions 开放**（那三个端点一律回 "No models loaded"），
   * 早先按对话模型接入，于是仲裁 100% 失败、静默降级，日志里只有一行 fetch failed。
   */
  api?: 'systemone' | 'chat' | 'auto';
  /**
   * 影子模型：与主模型跑**同一道题**，结果只落日志，不参与任何判定。
   *
   * 为什么需要：换模型没有离线数据支撑就没法说谁更好。主模型对用户可见，
   * 影子模型提供同一批消息上的独立答案，事后用 `routing.jsonl` 的 `shadow` 行算一致率。
   *
   * 两条硬约束：
   *  1. **不参与主链路等待**——影子慢不该让用户多等（见 `arbitratePair`）；
   *  2. 独立超时，失败静默：它挂了只少一条对照数据，不能影响问答。
   */
  shadow?: {
    enabled: boolean;
    baseUrl: string;
    model: string;
    timeoutMs: number;
    api: 'systemone' | 'chat' | 'auto';
  };
}

/**
 * 缺省仲裁配置：laya 约 450MB，常驻后单次判定 0.6~2.8s。
 *
 * 超时给 6s 而不是 3s：真实 prompt 带会话卡 + 候选列表 + 两轮原文，
 * 比实验室里的短 prompt 长得多（实测 20 条真实模糊带里最长 2.8s）。
 * 卡在 3s 会把"判得出但慢"的样本全变成降级，等于白接。
 */
export const DEFAULT_ARBITER_CONFIG: ArbiterConfig = {
  enabled: true,
  baseUrl: process.env.WAKER_LLM_BASE_URL ?? 'http://127.0.0.1:1234/v1',
  model: process.env.WAKER_ARBITER_MODEL ?? 'laya',
  timeoutMs: 6000,
  // auto = 先走决策模型的 systemone，不通再退 chat。laya 走前者，换对话小模型走后者。
  api: (process.env.WAKER_ARBITER_API as ArbiterConfig['api']) ?? 'auto',
};

/**
 * 语义判定配置。
 *
 * 阈值是**另一套刻度**：余弦相似度 0.55/0.72 与词面 Jaccard 的 0.12/0.22 不可互换。
 * 所以 routing 流水里必须记下本次用的是哪套刻度（regime），否则调参会拿错尺子。
 */
export interface SemanticConfig {
  /** auto = 先试语义、失败退回词面；off = 只用词面。 */
  enabled: 'auto' | 'off';
  /** OpenAI 兼容端点（需带 /v1）。 */
  baseUrl: string;
  model: string;
  timeoutMs: number;
  continueThreshold: number;
  switchThreshold: number;
  unrelatedThreshold: number;
}

/**
 * 会话卡生成策略。
 *
 * 为什么是"闲置时生成"而不是"询问时生成"：询问在收消息的关键路径上，
 * 多一次推理就是多 8~15 秒等待。把成本挪到没人等的时刻，询问时只读现成的。
 */
export interface SummaryConfig {
  /** 指定模型；留空继承该员工的 llm.model。 */
  model?: string;
  /** 摘要字数上限。 */
  maxChars: number;
  /** 最后一条消息之后闲置多久才生成。 */
  idleMinutes: number;
  /** 自上次摘要以来至少新增多少条消息才重算（防续聊一句就重算）。 */
  minNewMessages: number;
  /** 单会话每天最多生成几次。 */
  perSessionDaily: number;
  /** 全平台每小时最多几次（防批量清理时的风暴）。 */
  globalHourly: number;
  /** 单次调用超时。超时即放弃，保留旧卡。 */
  timeoutMs: number;
}

/** 缺省会话策略。registry 会补齐，这里给"没有档案字段时"的兜底（如 Pi 纳管档案）。 */
export const DEFAULT_SESSION_CONFIG: SessionConfig = {
  mode: 'single',
  idleSplitHours: 8,
  ask: 'always',
  rejectLimit: 2,
  autoSwitch: true,
  autoName: true,
  summary: {
    maxChars: 200,
    idleMinutes: 10,
    minNewMessages: 4,
    perSessionDaily: 6,
    globalHourly: 20,
    timeoutMs: 15000,
  },
  semantic: {
    enabled: 'auto',
    baseUrl: 'http://127.0.0.1:1234/v1',
    model: 'text-embedding-bge-m3',
    // 6s（2026-11-05 实测）：原来 2s 会稳定超时——10 个会话的语义块一次要 3~4s，
    // 超时即降级成词面，中文短句词面重合接近 0，判定永远返回"继续"（网页端建议从不弹出）。
    // 现在候选只取少量块 + 分两批，稳态首次约 1.5s，仍留足余量给冷启动。
    timeoutMs: 6000,
    // 阈值按 bge-m3 实测标定（2026-10-23）：
    //   无关文本的余弦基线在 0.38~0.44，同话题换词约 0.64~0.66。
    // 所以"继续"线放在 0.58，"切回"线放在 0.60（只比继续略高，靠 +0.08 的差值条件防误切），
    // "无关"线放在 0.45。换成别的 embedding 模型必须重新标定。
    continueThreshold: 0.58,
    switchThreshold: 0.6,
    unrelatedThreshold: 0.45,
  },
};

/** 档案完整性检查结果。不阻断加载，只提示。 */
export interface WakerIssue {
  level: 'warn' | 'error';
  field: string;
  message: string;
}

/** 带诊断信息的完整档案。 */
export interface WakerRecord {
  def: WakerDef;
  /** 档案目录绝对路径（Pi 来源时即 profile 文件路径）。 */
  dir: string;
  /** 来源，便于调用方区分本地档案与纳管的 Pi profile。 */
  origin?: 'local' | 'pi';
  files: {
    /** 人设总纲：这个员工"是谁"的浓缩定义，装配时排在最前。 */
    soul: string | null;
    /** 职责范围：我是谁、服务对象、主要职责。 */
    identity: string | null;
    /** 工作风格与产出格式偏好。 */
    persona: string | null;
    /** 红线、禁止操作、需人工确认的动作。 */
    bible: string | null;
    /** 长期记忆，纳入 git 版本化。 */
    memory: string | null;
  };
  issues: WakerIssue[];
}

/** 可在看板中编辑的档案文件名（白名单，防止路径穿越）。 */
export const EDITABLE_FILES = ['SOUL.md', 'identity.md', 'persona.md', 'bible.md', 'MEMORY.md'] as const;
export type EditableFile = (typeof EDITABLE_FILES)[number];

/** 任务来源。与看板筛选维度一一对应。 */
export type TaskSource = 'cli' | 'cron' | 'im' | 'api' | 'web';

/**
 * 任务生命周期。
 * awaiting 是"等待人工确认"，语义上**不是失败**。
 */
export type TaskStatus =
  | 'arrived'
  | 'queued'
  | 'running'
  | 'awaiting'
  | 'success'
  | 'failed'
  | 'cancelled';

/** 任务流水记录。JSONL 追加写，一行一条。 */
export interface TaskRecord {
  taskId: string;
  wakerId: string;
  source: TaskSource;
  status: TaskStatus;
  /** 实际下发给 pi 的 prompt。 */
  prompt: string;
  /** 触发时刻，ISO8601。 */
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  /** pi 原生会话 JSONL 路径，用于回溯完整对话。 */
  sessionRef?: string;
  /** pi 子进程 PID，便于 terminate。 */
  pid?: number;
  error?: string;
  /** pi 的最终文本输出（截断存储）。 */
  result?: string;
  /** 拦截/确认事件计数，用于看板标注风险。 */
  blockedCount?: number;
  /** 门禁拦截明细原文，便于排查策略配置错误。 */
  guardLog?: string[];
  /** 所属 Group 运行（如有）。 */
  groupRunId?: string;
  /** 由哪条定时任务触发（看板据此统计"这条任务的成败次数"）。 */
  automationId?: string;
  /** 所属平台会话 id（看板按会话聚合时用；独立任务为空）。 */
  sessionId?: string;
}

/** 待办执行者：agent 到点自己跑；human 到点提醒人。 */
export type TodoAssignee = 'agent' | 'human';

/**
 * 待办的**存储**状态。
 *
 * 到期(due) / 过期(overdue) **不入库**：它们由 `dueAt` 与当前时间派生，
 * 入库就需要后台定时扫库改状态——服务没开的时候状态还会停在旧值。
 */
export type TodoStatus = 'pending' | 'running' | 'done' | 'dismissed' | 'failed';

/** 派生视图阶段 = 存储状态 + 由时间算出的 due / overdue。 */
export type TodoPhase = TodoStatus | 'due' | 'overdue';

/**
 * 一条待办。人类待办与 agent 待办是**同一种对象**，只差 assignee：
 * automation 只是"到点拉起 agent"的执行器，不该被拿来当待办本身。
 */
export interface TodoRecord {
  id: string;
  wakerId: string;
  assignee: TodoAssignee;
  title: string;
  detail?: string;
  /** 截止时刻，ISO8601（UTC 存储，展示按本地时区）。 */
  dueAt: string;
  status: TodoStatus;
  /** 这条待办是从哪留下的（看板 / 飞书 / CLI）。 */
  source: TaskSource;
  createdAt: string;
  updatedAt?: string;
  doneAt?: string;
  /** 完成时留的一句话（"做完了，结果如何"），用于回看。 */
  note?: string;
  /** 平台会话 id：agent 到点执行时**沿用**这个会话，上下文不断。 */
  sessionId?: string;
  /** 外部渠道 key（如 `feishu:u_xxx`）：执行结果回发到原窗口。 */
  externalKey?: string;
  /**
   * 留下这条待办时的任务流水 id。
   * 看板靠它反查那轮的用户原话，从而**定位到会话里的具体一条消息**，
   * 而不是只把会话打开（TODO 里只有一句话，上下文全在那条消息附近）。
   */
  sourceTaskId?: string;
  /** agent 执行产生的任务流水 id。 */
  taskId?: string;
  /** agent 执行结果（截断）与失败原因。 */
  result?: string;
  error?: string;
  /** 已顺延次数，仅用于展示"这条被推迟过几次"。 */
  snoozedCount?: number;
}

/** 看板的会话视图：以会话语义聚合，而不是"每次消息一条任务"。 */
export interface SessionView {
  wakerId: string;
  wakerName: string;
  origin: 'local' | 'pi';
  sessionId: string;
  name: string;
  /** 话题标题（首条消息派生）。看板优先显示它，没有就退回 name。 */
  title?: string;
  /** 最近一次活动的来源渠道。 */
  source: TaskSource;
  messageCount: number;
  lastActiveAt: string;
  lastPrompt?: string;
  lastResult?: string;
  lastStatus?: TaskStatus;
  externalKey?: string;
  /** 该会话是否有任务正在运行（看板显示转圈）。 */
  running?: boolean;
  /** 该会话累计 token 数（来自 pi 会话文件）。 */
  tokens?: number;
  /** 该会话累计费用（USD，按模型价格表计算）。 */
  cost?: number;
  /** 该会话的 assistant 消息条数。 */
  runs?: number;
}

/** 触发方式定义。一个任务最多可注册多个触发。 */
export type TriggerSpec =
  | { kind: 'cron'; cron: string; timezone?: string; maxRuns?: number; until?: string }
  | { kind: 'once'; at: string; timezone?: string }
  | { kind: 'api'; name: string }
  | { kind: 'event'; source: string; filter?: Record<string, unknown> };

/** 已注册的自动任务。 */
export interface AutomationDef {
  id: string;
  name: string;
  wakerId: string;
  /** 每次触发都执行的固定目标描述，支持 {{field}} 占位符。 */
  promptTemplate: string;
  triggers: TriggerSpec[];
  enabled: boolean;
  /** 已执行次数，用于 maxRuns 限制。 */
  runCount: number;
  createdAt: string;
}

/** Group 成员席位：谁执行、谁验收。 */
export interface GroupMember {
  wakerId: string;
  /** 该成员承担的子任务说明。 */
  brief: string;
  /** 是否为主修改者。同一目录只能有一位主修改者，防止并发覆盖。 */
  isPrimaryWriter?: boolean;
  /** 该成员是否只读（评审者）。 */
  readOnly?: boolean;
}

/** 多员工协作编排定义。 */
export interface GroupDef {
  id: string;
  title: string;
  /** 负责拆解与汇总的成员 id。 */
  leaderId: string;
  members: GroupMember[];
  /** 需要人工确认的阶段名。 */
  confirmStages?: string[];
}

/** Extension 消费的编译后策略（写进 policy.json）。 */
export interface CompiledPolicy extends WakerPolicy {
  wakerId: string;
  wakerName: string;
  cwd: string;
  compiledAt: string;
}

/** 看板聚合视图。 */
export interface BoardSnapshot {
  generatedAt: string;
  counts: Record<TaskStatus, number>;
  tasks: TaskRecord[];
  /** 待办（含人类与 agent 两类）。看板靠它做到期提醒，不额外请求接口。 */
  todos: TodoRecord[];
  /** 定时任务执行情况：成功 / 失败次数，以及仍在计划中的任务数。 */
  cronStats: { success: number; failed: number; planned: number };
  /** 待办进度：今天处理掉的条数 + 今天该处理却还没做完的条数（截止≤今天，含逾期）。 */
  todoStats: { doneToday: number; pendingToday: number };
  wakers: Array<{
    id: string;
    name: string;
    role: string;
    enabled: boolean;
    todayTasks: number;
    running: number;
    /** 来源：本地档案或纳管的 Pi profile。 */
    origin?: 'local' | 'pi';
    /** 是否已设置自定义头像。 */
    avatar?: boolean;
  }>;
  health: {
    memoryServer: boolean;
    docker: boolean;
    pi: boolean;
  };
}
