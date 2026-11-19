import type {
  AgentFileView,
  AgentPermissions,
  ArchitectureView,
  Automation,
  BoardSnapshot,
  ChannelConfigView,
  ChannelStatus,
  FeishuChannelConfigView,
  PiAgentBrief,
  PlatformConfig,
  PluginEntry,
  RuntimeView,
  SessionMeta,
  SessionUsage,
  SessionView,
  SleepGuardStatus,
  TaskRecord,
  TodoAssignee,
  TodoView,
  UsageView,
  WakerDetail,
  WakerProfile,
} from './types';

/** 开发态走 Vite 代理，生产态与网关同源。 */
const BASE = '';

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`${path} 请求失败：HTTP ${res.status}`);
  return (await res.json()) as T;
}

export function fetchBoard(): Promise<BoardSnapshot> {
  return getJson<BoardSnapshot>('/api/board');
}

/** 话题建议：只判定不执行，发送前调用。 */
export interface TopicSuggestion {
  action: 'continue' | 'switch' | 'new';
  confidence: number;
  reason: string;
  regime: 'semantic' | 'lexical' | 'timeWindow';
  current: { id: string; title: string };
  target?: { id: string; title: string; recap: string; similarity?: number };
}

export async function suggestTopic(
  wakerId: string,
  sessionId: string,
  message: string,
): Promise<TopicSuggestion> {
  const res = await fetch(`${BASE}/api/agents/${encodeURIComponent(wakerId)}/route`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, message }),
  });
  if (!res.ok) throw new Error(`话题判定失败：HTTP ${res.status}`);
  return (await res.json()) as TopicSuggestion;
}

/** 渠道运行状态（飞书等）。 */
export function fetchChannels(): Promise<ChannelStatus[]> {
  return getJson<ChannelStatus[]>('/api/channels');
}

/** 会话粒度列表：看板主列表用它。 */
export function fetchSessionList(): Promise<SessionView[]> {
  return getJson<SessionView[]>('/api/sessions');
}

// —— 渠道配置（看板编辑 bot 的飞书信息）——

export function fetchChannelConfig(wakerId: string): Promise<ChannelConfigView> {
  return getJson<ChannelConfigView>(`/api/agents/${encodeURIComponent(wakerId)}/channel`);
}

export async function saveChannelConfig(
  wakerId: string,
  feishu: FeishuChannelConfigView,
  appSecret?: string,
): Promise<ChannelConfigView> {
  const res = await fetch(`${BASE}/api/agents/${encodeURIComponent(wakerId)}/channel`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ feishu, appSecret }),
  });
  const body = (await res.json()) as ChannelConfigView & { error?: string };
  if (!res.ok) throw new Error(body.error ?? '保存渠道配置失败');
  return body;
}

/** 按最新配置重建并重启全部渠道。 */
export async function reloadChannels(): Promise<ChannelStatus[]> {
  const res = await fetch(`${BASE}/api/channels/reload`, { method: 'POST' });
  return (await res.json()) as ChannelStatus[];
}

// —— 会话历史 ——

/** 一步执行痕迹：工具调用或思考。 */
export interface ChatStep {
  kind: 'tool' | 'thinking';
  /** 工具名（thinking 为空）。 */
  name?: string;
  /** 一行摘要：折叠时显示。 */
  summary: string;
  /** 完整内容：展开时显示（后端不截断）。 */
  detail: string;
}

/**
 * 历史消息里附的图片。**不含 base64**：服务端只给定位用的行号与序号，
 * 图片本体走 {@link sessionImageUrl} 按需取（一张截图 base64 1–3MB，不能塞进历史响应）。
 */
export interface ChatImage {
  mimeType: string;
  /** 该条记录在 pi 会话文件里的行号（0 基）。 */
  line: number;
  /** 同一条消息里的第几张（0 基）。 */
  index: number;
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  text: string;
  /** 消息时间（ISO8601）。 */
  at: string;
  /** 该答复正文之前的执行步骤（工具调用等）。 */
  steps?: ChatStep[];
  /** 这条消息里附的图片（文字可能为空，只有图）。 */
  images?: ChatImage[];
  /** 有它就是「上下文压缩节点」标记（对话在此处被压缩过，记录一条没少）。 */
  compaction?: { tokensBefore: number; summaryChars: number };
}

/** 历史消息里某张图片的直链（直接给 `<img src>` 用）。 */
export function sessionImageUrl(wakerId: string, sessionId: string, line: number, index: number): string {
  return (
    `${BASE}/api/agents/${encodeURIComponent(wakerId)}/sessions/${encodeURIComponent(sessionId)}` +
    `/messages/${line}/images/${index}`
  );
}

/** 读取某会话的历史对话（从 pi 原生会话文件还原）。 */
export function fetchSessionMessages(wakerId: string, sessionId: string): Promise<ChatMessage[]> {
  return getJson<ChatMessage[]>(
    `/api/agents/${encodeURIComponent(wakerId)}/sessions/${encodeURIComponent(sessionId)}/messages`,
  );
}

/** 某会话的用量：token 与费用（含按模型拆分，费用按模型价格表计算）。 */
export function fetchSessionUsage(wakerId: string, sessionId: string): Promise<SessionUsage> {
  return getJson<SessionUsage>(
    `/api/agents/${encodeURIComponent(wakerId)}/sessions/${encodeURIComponent(sessionId)}/usage`,
  );
}

// —— 技能（per-profile 勾选）——

export interface SkillInfo {
  name: string;
  description: string;
}

export interface AgentSkillsView {
  all: SkillInfo[];
  /** null = 未配置（沿用 pi 默认发现）。 */
  enabled: string[] | null;
}

/** 员工简表（用于下拉选择）。 */
export interface WakerBrief {
  id: string;
  name: string;
  role: string;
  enabled: boolean;
  origin?: string;
}

export function fetchWakers(): Promise<WakerBrief[]> {
  return getJson<WakerBrief[]>('/api/wakers');
}

/** 创建定时任务（看板里选员工）。 */
export async function createAutomation(input: {
  name?: string;
  wakerId: string;
  cron: string;
  prompt: string;
}): Promise<void> {
  const res = await fetch(`${BASE}/api/automations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const body = (await res.json()) as { error?: string };
    throw new Error(body.error ?? '创建失败');
  }
}

export function fetchAgentSkills(wakerId: string): Promise<AgentSkillsView> {
  return getJson<AgentSkillsView>(`/api/agents/${encodeURIComponent(wakerId)}/skills`);
}

export async function saveAgentSkills(wakerId: string, enabled: string[]): Promise<void> {
  const res = await fetch(`${BASE}/api/agents/${encodeURIComponent(wakerId)}/skills`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
  if (!res.ok) throw new Error('保存技能失败');
}

// —— 插件入口 与 定时任务 ——

export function fetchPlugins(): Promise<PluginEntry[]> {
  return getJson<PluginEntry[]>('/api/plugins');
}

export function fetchAutomations(): Promise<Automation[]> {
  return getJson<Automation[]>('/api/automations');
}

export async function toggleAutomation(id: string, enabled: boolean): Promise<void> {
  await fetch(`${BASE}/api/automations/${encodeURIComponent(id)}/toggle`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
}

export async function removeAutomation(id: string): Promise<void> {
  await fetch(`${BASE}/api/automations/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

// —— 待办 ——

export async function createTodo(input: {
  wakerId: string;
  title: string;
  /** ISO8601。 */
  dueAt: string;
  assignee?: TodoAssignee;
  detail?: string;
}): Promise<TodoView> {
  const res = await fetch(`${BASE}/api/todos`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const body = (await res.json()) as { error?: string };
    throw new Error(body.error ?? '新建待办失败');
  }
  return (await res.json()) as TodoView;
}

/** 结束：真的做完了（与关闭区分）。 */
export async function todoDone(id: string, note?: string): Promise<void> {
  await fetch(`${BASE}/api/todos/${encodeURIComponent(id)}/done`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ note }),
  });
}

/** 关闭：不做了 / 建错了。 */
export async function todoDismiss(id: string): Promise<void> {
  await fetch(`${BASE}/api/todos/${encodeURIComponent(id)}/dismiss`, { method: 'POST' });
}

/** 顺延：默认一天。 */
export async function todoSnooze(id: string, ms?: number): Promise<void> {
  await fetch(`${BASE}/api/todos/${encodeURIComponent(id)}/snooze`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ms }),
  });
}

export function fetchTask(taskId: string): Promise<TaskRecord> {
  return getJson<TaskRecord>(`/api/tasks/${taskId}`);
}

/** 终止任务：只停止后续执行，不撤销已产生的文件变更。 */
export async function cancelTask(taskId: string): Promise<void> {
  const res = await fetch(`${BASE}/api/tasks/${encodeURIComponent(taskId)}/cancel`, { method: 'POST' });
  if (!res.ok) throw new Error('终止失败');
}

/** 运行时视图：本进程拉起的 pi 子进程 + 实时输出尾部。 */
export function fetchRuntime(): Promise<RuntimeView> {
  return getJson<RuntimeView>('/api/runtime');
}

/**
 * 架构与版本：分层说明 + 服务端版本 + 更新记录（服务端每次重读 CHANGELOG.md）。
 *
 * 不复用 `getJson`：升级后网关没重启时，旧网关会把未知 `/api/*` 落到 SPA 回退，
 * 回一段 HTML 且状态码 200——`res.json()` 抛出的 "Unexpected token '<'" 对用户毫无信息量。
 * 这里先看 content-type，把话说清楚。
 */
export async function fetchArchitecture(): Promise<ArchitectureView> {
  const res = await fetch(`${BASE}/api/architecture`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const type = res.headers.get('content-type') ?? '';
  if (!type.includes('application/json')) {
    throw new Error('接口返回的不是 JSON（看板进程多半还是旧版本，重启后即可）');
  }
  return (await res.json()) as ArchitectureView;
}

export function runWaker(wakerId: string, prompt: string): Promise<TaskRecord> {
  return fetch(`${BASE}/api/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ wakerId, prompt }),
  }).then((r) => r.json() as Promise<TaskRecord>);
}

/** 创建员工。后端错误（如 id 已存在）会以 Error 抛出，便于弹窗直接显示。 */
export async function createWaker(input: {
  id: string;
  name?: string;
  role?: string;
  cwd?: string;
}): Promise<WakerDetail> {
  const res = await fetch(`${BASE}/api/agents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  const body = (await res.json()) as WakerDetail & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `创建失败：HTTP ${res.status}`);
  return body;
}

export async function archiveWaker(wakerId: string): Promise<void> {
  const res = await fetch(`${BASE}/api/agents/${encodeURIComponent(wakerId)}`, { method: 'DELETE' });
  if (!res.ok) throw new Error('归档失败');
}

// —— 本机 Pi agent 导入 ——

/** 可导入的本机 Pi agent（含"已导入"标记）。 */
export function fetchPiAgents(): Promise<PiAgentBrief[]> {
  return getJson<PiAgentBrief[]>('/api/pi-agents');
}

/** 导入本机 Pi agent 为平台员工。后端错误（同名已存在等）以 Error 抛出。 */
export async function importPiAgent(input: { id: string; cwd?: string }): Promise<WakerDetail> {
  const res = await fetch(`${BASE}/api/agents/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  const body = (await res.json()) as WakerDetail & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `导入失败：HTTP ${res.status}`);
  return body;
}

// —— 平台级配置 ——

export function fetchConfig(): Promise<PlatformConfig> {
  return getJson<PlatformConfig>('/api/config');
}

export async function saveConfig(patch: Partial<PlatformConfig>): Promise<PlatformConfig> {
  const res = await fetch(`${BASE}/api/config`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  const body = (await res.json()) as PlatformConfig & { error?: string };
  if (!res.ok) throw new Error(body.error ?? '保存配置失败');
  return body;
}

// —— 员工基本信息（名称 / 岗位 / 模型）——

export function fetchProfile(wakerId: string): Promise<WakerProfile> {
  return getJson<WakerProfile>(`/api/agents/${encodeURIComponent(wakerId)}/profile`);
}

/** 改名/岗位/模型。Pi 纳管的 profile 会被后端拒绝。 */
export async function saveProfile(
  wakerId: string,
  patch: { name?: string; role?: string; model?: string; cwd?: string },
): Promise<WakerProfile> {
  const res = await fetch(`${BASE}/api/agents/${encodeURIComponent(wakerId)}/profile`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  const body = (await res.json()) as WakerProfile & { error?: string };
  if (!res.ok) throw new Error(body.error ?? '保存失败');
  return body;
}

export function fetchAgentFiles(wakerId: string): Promise<AgentFileView[]> {
  return getJson<AgentFileView[]>(`/api/agents/${encodeURIComponent(wakerId)}/files`);
}

// —— 常驻防睡眠（工具 → 系统）——

export function fetchPower(): Promise<SleepGuardStatus> {
  return getJson<SleepGuardStatus>('/api/power');
}

/**
 * 开关常驻防睡眠。
 *
 * 断言挂在**看板进程**上（`caffeinate -w <看板 pid>`），所以看板退出就自动释放、
 * 重启会按配置自动恢复——不需要（也不应该）让前端去管进程。
 */
export async function savePreventSleep(preventSleep: boolean): Promise<SleepGuardStatus> {
  const res = await fetch(`${BASE}/api/power`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ preventSleep }),
  });
  const body = (await res.json()) as SleepGuardStatus & { error?: string };
  if (!res.ok) throw new Error(body.error ?? '切换失败');
  return body;
}

// —— 权限（可读写目录范围 + 档案自改）——

export function fetchPermissions(wakerId: string): Promise<AgentPermissions> {
  return getJson<AgentPermissions>(`/api/agents/${encodeURIComponent(wakerId)}/permissions`);
}

/** 保存权限。后端用 yaml 原地改键并**立即重编译**（guard 读的就是编译产物）。 */
export async function savePermissions(
  wakerId: string,
  patch: { pathAllow?: string[]; pathDeny?: string[]; selfEdit?: boolean; browser?: boolean },
): Promise<AgentPermissions> {
  const res = await fetch(`${BASE}/api/agents/${encodeURIComponent(wakerId)}/permissions`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  const body = (await res.json()) as AgentPermissions & { error?: string };
  if (!res.ok) throw new Error(body.error ?? '保存权限失败');
  return body;
}

/** 保存档案文件。服务端会在保存后重新编译，返回的 recompiled 用于提示生效状态。 */
export async function saveAgentFile(wakerId: string, name: string, content: string): Promise<{ recompiled: boolean }> {
  const res = await fetch(`${BASE}/api/agents/${encodeURIComponent(wakerId)}/files/${encodeURIComponent(name)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  const body = (await res.json()) as { recompiled?: boolean; error?: string };
  if (!res.ok) throw new Error(body.error ?? '保存失败');
  return { recompiled: Boolean(body.recompiled) };
}

export interface TalkResponse {
  status: string;
  result?: string;
  /** 本次答复用到的执行步骤（工具调用等）。 */
  steps?: ChatStep[];
  blockedCount: number;
  guardLog: string[];
  error?: string;
  taskId: string;
  sessionId: string;
  sessionName: string;
}

/**
 * 在指定会话内与员工对话。不传 sessionId 落到默认会话。
 *
 * `attachments` 来自 {@link uploadAttachment}，服务端只在这一轮内使用，用完即删。
 * 带上 `name`（原始文件名）是为了让会话文件里那行 `【附件：…】` 是人能读的名字，
 * 而不是 `m3k2j1-a1b2c3d4-____.png` 这种清洗后的 id。
 */
export function talkAgent(
  wakerId: string,
  message: string,
  sessionId?: string,
  attachments?: Array<{ id: string; name?: string }>,
): Promise<TalkResponse> {
  return fetch(`${BASE}/api/talk`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      wakerId,
      message,
      sessionId,
      attachments: attachments?.length ? attachments : undefined,
    }),
  }).then((r) => r.json() as Promise<TalkResponse>);
}

/** 附件上传的返回。`kind` 决定前端怎么预览（图片给缩略图，其余给文件名）。 */
export interface UploadResponse {
  id: string;
  name: string;
  size: number;
  kind: 'image' | 'document' | 'other';
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(new Error('读取文件失败'));
    // 走 data URL：服务端会剥掉前缀，这里省一次手工 base64 编码
    fr.readAsDataURL(file);
  });
}

/**
 * 上传一个附件，拿到后续 `/api/talk` 用的 id。
 *
 * 为什么用 base64 JSON 而不是 multipart：Node 没有内置 multipart 解析，
 * 手写边界切分在中文文件名与分块边界上最容易出错；本平台是本地访问，
 * 33% 的体积膨胀换来实现简单可靠，这笔账是划算的。
 */
export async function uploadAttachment(file: File): Promise<UploadResponse> {
  const dataBase64 = await fileToBase64(file);
  const res = await fetch(`${BASE}/api/upload`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: file.name, dataBase64 }),
  });
  const body = (await res.json()) as UploadResponse & { error?: string };
  if (!res.ok) throw new Error(body.error ?? '上传失败');
  return body;
}

// —— 会话（员工 1:N 会话）——

export function fetchSessions(wakerId: string): Promise<SessionMeta[]> {
  return getJson<SessionMeta[]>(`/api/agents/${encodeURIComponent(wakerId)}/sessions`);
}

export async function createSession(wakerId: string, name?: string): Promise<SessionMeta> {
  const res = await fetch(`${BASE}/api/agents/${encodeURIComponent(wakerId)}/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  const body = (await res.json()) as SessionMeta & { error?: string };
  if (!res.ok) throw new Error(body.error ?? '新建会话失败');
  return body;
}

export async function renameSession(wakerId: string, sid: string, name: string): Promise<SessionMeta> {
  const res = await fetch(`${BASE}/api/agents/${encodeURIComponent(wakerId)}/sessions/${encodeURIComponent(sid)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  const body = (await res.json()) as SessionMeta & { error?: string };
  if (!res.ok) throw new Error(body.error ?? '重命名失败');
  return body;
}

export async function deleteSession(wakerId: string, sid: string): Promise<void> {
  const res = await fetch(`${BASE}/api/agents/${encodeURIComponent(wakerId)}/sessions/${encodeURIComponent(sid)}`, {
    method: 'DELETE',
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? '删除会话失败');
  }
}

/** 清空会话上下文（保留会话本身）：pi 会话文件改名归档 + 消息计数归零。 */
export async function clearSession(wakerId: string, sid: string): Promise<{ files: number }> {
  const res = await fetch(
    `${BASE}/api/agents/${encodeURIComponent(wakerId)}/sessions/${encodeURIComponent(sid)}/clear`,
    { method: 'POST' },
  );
  const body = (await res.json().catch(() => ({}))) as { files?: number; error?: string };
  if (!res.ok) throw new Error(body.error ?? '清空失败');
  return { files: body.files ?? 0 };
}

// —— 使用统计（token / 费用）——

/** 使用统计。数据源是 pi 原生会话文件，后端只读聚合。 */
export function fetchUsage(days = 182, wakerId?: string): Promise<UsageView> {
  const q = new URLSearchParams({ days: String(days) });
  if (wakerId) q.set('wakerId', wakerId);
  return getJson<UsageView>(`/api/usage?${q.toString()}`);
}

// —— 员工头像 ——

/** 头像地址。传 version 可破除浏览器缓存（设置头像后立即生效）。 */
export function avatarUrl(wakerId: string, version?: string | number): string {
  const base = `${BASE}/api/avatars/${encodeURIComponent(wakerId)}`;
  return version === undefined ? base : `${base}?v=${encodeURIComponent(String(version))}`;
}

export async function saveAvatar(wakerId: string, dataUrl: string): Promise<void> {
  const res = await fetch(`${BASE}/api/avatars/${encodeURIComponent(wakerId)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ dataUrl }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? '保存头像失败');
  }
}

export async function deleteAvatar(wakerId: string): Promise<void> {
  const res = await fetch(`${BASE}/api/avatars/${encodeURIComponent(wakerId)}`, { method: 'DELETE' });
  if (!res.ok) throw new Error('清除头像失败');
}
