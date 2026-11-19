/** 渠道类型。目前只有飞书，后续可扩展微信 / Discord / 钉钉。 */
export type ChannelKind = 'feishu';

/** 渠道运行状态，供看板与 CLI 展示。 */
export interface ChannelStatus {
  kind: ChannelKind;
  /** 承载该渠道配置的员工 id。 */
  wakerId: string;
  /** 该渠道实际服务的员工 id（可能是另一个员工）。 */
  agentId: string;
  /** 展示名。 */
  name: string;
  state: 'starting' | 'running' | 'stopped' | 'error';
  /** 最近一次错误信息。 */
  error?: string;
  startedAt?: string;
}

/**
 * 外部会话目标。平台存的是 `externalKey` 字符串，发送前才解析成"发给谁"。
 */
export interface ExternalTarget {
  kind: 'p2p' | 'group';
  /** p2p 为 open_id，group 为 chat_id。 */
  id: string;
}

/**
 * 解析 `externalKey`（`feishu:u_<open_id>` / `feishu:g_<chat_id>[:u_<open_id>]`）。
 *
 * 群聊在多话题模式下会是 `feishu:g_<chatId>:u_<userId>`：
 * **主动推送要发到 chat_id 那一段**，后面的用户后缀只用于会话隔离。
 */
export function parseExternalKey(key: string | undefined): ExternalTarget | null {
  if (!key?.startsWith('feishu:')) return null;
  const rest = key.slice('feishu:'.length);
  const cut = rest.indexOf(':');
  const head = cut === -1 ? rest : rest.slice(0, cut);
  if (head.startsWith('u_') && head.length > 2) return { kind: 'p2p', id: head.slice(2) };
  if (head.startsWith('g_') && head.length > 2) return { kind: 'group', id: head.slice(2) };
  return null;
}

/**
 * 渠道抽象：把外部 IM 的出入站统一到平台。
 *
 * 设计边界（对齐 Pie 的 Channels 层）：
 * - 入站：外部消息 → 解析出"会话 key" → 映射到平台会话 → 交给 runner 执行；
 * - 出站：执行结果 → 回帖到原外部会话；
 * - 本身不持有业务逻辑，只做协议翻译与会话映射。
 */
export interface Channel {
  readonly kind: ChannelKind;
  /** 承载该渠道配置的员工 id。 */
  readonly wakerId: string;
  status(): ChannelStatus;
  start(): Promise<void>;
  stop(): Promise<void>;
  /**
   * 主动推送一条消息到外部会话（待办到点/执行结果回发）。
   * 不支持该能力或渠道未连接时返回 false，调用方据此降级（写日志，不重试）。
   */
  notify?(externalKey: string, text: string): Promise<boolean>;
}
