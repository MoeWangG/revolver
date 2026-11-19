/**
 * 最小类型垫片。
 *
 * 本机未安装 `@earendil-works/pi-coding-agent` 的 node_modules（Pi 以 ambient 方式在运行时提供），
 * 因此这里声明 ExtensionAPI 的**最小可用子集**，让 tsc 能检查我们的扩展代码。
 *
 * 运行时不会加载本文件（`import type` 在编译后被完全擦除），纯粹为静态检查服务。
 * 若后续 Pi 发布了官方类型，直接删掉本文件即可。
 */
declare module '@earendil-works/pi-coding-agent' {
  export interface Ctx {
    /** 当前工作目录，Pi 保证存在。 */
    cwd: string;
    /** 非交互模式（print/json/rpc）下为 false，使用 ui 相关 API 前必须判断。 */
    hasUI?: boolean;
    ui?: {
      notify(message: string, level?: 'info' | 'error'): void;
    };
    appendSystemPrompt?(text: string): void;
    /**
     * 触发 pi 原生上下文压缩（不 await，完成走回调）。
     *
     * 压缩会在会话记录里插一条 `compaction` 节点（摘要），**之前的记录一条不删**，
     * 下一轮装配上下文时从该节点之后开始加载 —— 这正是平台要的语义，
     * 所以平台自己不再实现压缩（见 core/compact.ts 顶部的教训说明）。
     */
    compact?(options?: CompactOptions): void;
    sessionManager?: {
      getSessionId?(): string;
      getSessionFile?(): string | null;
    };
  }

  export interface BeforeAgentStartEvent {
    prompt?: string;
    systemPrompt?: string;
  }

  export interface SessionStartEvent {
    type: 'session_start';
  }

  /** pi 原生压缩完成后触发；`compactionEntry` 就是写进会话记录的那个压缩节点。 */
  export interface SessionCompactEvent {
    type: 'session_compact';
    compactionEntry: {
      id?: string;
      summary?: string;
      tokensBefore?: number;
      firstKeptEntryId?: string;
    };
    fromExtension: boolean;
    reason: 'manual' | 'threshold' | 'overflow';
    willRetry: boolean;
  }

  /** ctx.compact() 的入参：只给回调，不给指令（指令走 customInstructions）。 */
  export interface CompactOptions {
    customInstructions?: string;
    onComplete?: (result: {
      summary: string;
      firstKeptEntryId: string;
      tokensBefore: number;
      estimatedTokensAfter?: number;
    }) => void;
    onError?: (error: Error) => void;
  }

  export interface ToolCallEvent {
    toolName: string;
    /**
     * 工具参数。**pi 0.84 起的字段名是 `input`**（`args` 是更老的写法）。
     *
     * 这个字段名踩过坑：guard 原来只读 `args`，永远拿到 undefined，
     * 路径白名单因此静默失效（`read /etc/hosts` 一路放行）。两个都声明，
     * 让代码里"两个都认"的兼容写法也有类型支撑。
     */
    input?: Record<string, unknown>;
    args?: Record<string, unknown>;
    toolCallId?: string;
  }

  export interface AgentToolResult<T = unknown> {
    content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>;
    details?: T;
  }

  export interface ExtensionAPI {
    registerTool(tool: Record<string, unknown>): void;
    registerCommand(name: string, command: Record<string, unknown>): void;
    on(event: string, handler: (event: never, ctx: Ctx) => unknown): void;
    getAllTools?(): Array<{ name: string }>;
  }
}
