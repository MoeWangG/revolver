/**
 * Browser MCP 的工具清单（**唯一事实源**）。
 *
 * 三个消费方都从这里取，避免"建了工具但模型看不见"或"两边 schema 不一致"：
 * 1. `extensions/browser-mcp.ts` —— 注册成 pi 工具（给 revolver 的 agent 用）；
 * 2. `src/core/browserStdio.ts` —— CodeBuddy 等外部 MCP 客户端走 `waker browser mcp-stdio`；
 * 3. `src/core/browserBroker.ts` —— `/tools` 自检接口。
 *
 * ## 为什么只有一个 `browser` 工具（2026-11-08 对齐 @browsermcp/mcp 2.x）
 *
 * 1.x 是 13 个原子工具（`browser_navigate` / `browser_snapshot` / `browser_click` …）。
 * 2.x 把它们合并成一个 `browser`，参数是**多行命令 DSL**（`goto` / `snapshot -i` / `click e12` …）。
 * 照着 1.x 的名字注册，`--tools` 里全是上游不认识的名字，每次调用都回 `Unknown tool browser_snapshot`
 * —— 工具注册成功、模型也调了、结果必失败，排查时很容易误判成"扩展没连"。
 *
 * 2.x 的另一个变化是架构：扩展连的是常驻守护进程 `daemon.js`（`127.0.0.1:9010`），
 * MCP server 反过来是它的客户端。所以 broker 不再"持有 9009 等扩展来连"，
 * 只保留真正有用的那部分：**串行化**（浏览器是单标签页，两个调用同时点会点错）。
 *
 * 描述保留英文原文：这类"元素引用(ref)"语义用英文表述歧义更少，也与上游一致。
 */

export interface BrowserToolSpec {
  name: string;
  description: string;
  /** JSON Schema。既是 pi `registerTool.parameters`，也是 MCP `inputSchema`。 */
  parameters: Record<string, unknown>;
}

const COMMANDS_HELP = `Controls the user's Chrome. Runs one command per line, stopping at the first error. Actions print one ✓ line, reads print their output. Do many steps per call.
goto <url> | back | forward | reload
click <target>
fill <target> "<text>" [--submit]
type "<text>"
press <key>
select <target> "<value>"
check <target> | uncheck <target>
wait <ms> | wait --text "<text>" | wait <target>
tab list | tab new [<url>] | tab select <id> | tab close
snapshot [<target>] [-i] [--depth N]
find "<text>"
get text|value|count|url|title [<target>]
screenshot [<target>]
eval "<js function>"   # runs in the page
More (help <command>): scroll, hover, drag, upload, dialog, console, requests, request
Targets: e12 (a snapshot ref), getByRole('button', { name: 'Go' }), getByLabel/getByText/getByPlaceholder('…'), or CSS.
Quote text with spaces: "like this"`;

export const BROWSER_TOOLS: BrowserToolSpec[] = [
  {
    name: 'browser',
    description: COMMANDS_HELP,
    parameters: {
      type: 'object',
      properties: {
        commands: {
          type: 'string',
          description: 'Browser commands, one per line (see the tool description for the DSL).',
        },
      },
      required: ['commands'],
    },
  },
];

/** 工具名清单：runner 追加 `--tools`、guard 判权都靠它，避免手写字符串漏项。 */
export const BROWSER_TOOL_NAMES: string[] = BROWSER_TOOLS.map((t) => t.name);

/** 给 `--tools` 用：把浏览器工具并进已有名单（保持原有顺序，不重复）。 */
export function withBrowserTools(tools: string[]): string[] {
  const out = [...tools];
  for (const name of BROWSER_TOOL_NAMES) {
    if (!out.includes(name)) out.push(name);
  }
  return out;
}
