/**
 * browser-mcp — 把常驻 broker 的浏览器能力挂到 pi 上
 *
 * ## 为什么不是"扩展里直接起一个 browser server"
 *
 * revolver 每个任务新起一个 pi 进程。若各自 spawn 一个 `@browsermcp/mcp`，就会有 N 个
 * MCP 客户端同时往同一个 Chrome 守护进程（2.x 的 `daemon.js`，127.0.0.1:9010）发命令——
 * 浏览器是单标签页，两个调用同时点元素谁也不知道点中了什么；而且每个进程各缓存一份
 * `tools/list`，版本一错就整批失败。所以浏览器只由 `waker browser start` 起的常驻 broker
 * 持有，本扩展只是它的**调用方**（HTTP 转发 + 串行化，见 src/core/browserBroker.ts）。
 *
 * ## 工具只有一个
 *
 * `@browsermcp/mcp` 2.x 把 13 个原子工具合并成单个 `browser`，参数是多行命令 DSL。
 * 清单在 `src/core/browserTools.ts`（唯一事实源）。
 *
 * ## 谁能用
 *
 * 只看 `policy.browser`（默认 false）。这与 `selfEdit` 同一套思路：
 * 能力开关在岗位档案里，由人显式打开；打开后 runner 会把工具名并进 `--tools`，
 * guard 也会在工具白名单判定**之前**放行——漏了任何一处，工具都会"注册了但模型看不见"。
 *
 * 未开启时不注册任何工具：既不加系统提示，也不占 `--tools` 名额。
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

/**
 * 为什么不直接 `import ... from '../src/core/...'`
 *
 * 本扩展经 `scripts/link.sh` 软链到 `~/.pi/agent/extensions/` 后由 pi 用 jiti 加载。
 * jiti 下 `import.meta.url` 是**软链路径**（不是真实仓库路径），静态相对导入会被解析成
 * `~/.pi/agent/src/core/...`（不存在）→ pi 退出码 1，任务全线失败；
 * 而且报错是"扩展加载失败"，不是"浏览器工具不可用"，极易误判成浏览器/网络问题。
 *
 * 先 realpath 还原成仓库真实路径，再按绝对路径 import：软链、实体拷贝、换台机器都成立。
 * 类型仍走 `typeof import(...)` 的静态解析，运行时不额外加载任何东西。
 */
const EXT_DIR = dirname(realpathSync(fileURLToPath(import.meta.url)));

type BrowserClientModule = typeof import('../src/core/browserClient.ts');
type BrowserToolsModule = typeof import('../src/core/browserTools.ts');

const { BROKER, callBroker } = (await import(
  pathToFileURL(resolve(EXT_DIR, '../src/core/browserClient.ts')).href
)) as BrowserClientModule;
const { BROWSER_TOOLS } = (await import(
  pathToFileURL(resolve(EXT_DIR, '../src/core/browserTools.ts')).href
)) as BrowserToolsModule;

const WAKER_ID = process.env.WAKER_ID ?? '';
const POLICY_DIR = process.env.WAKER_POLICY_DIR ?? '';

interface Policy {
  browser?: boolean;
}

function loadPolicy(): Policy | null {
  if (!WAKER_ID || !POLICY_DIR) return null;
  const p = join(POLICY_DIR, `${WAKER_ID}.policy.json`);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as Policy;
  } catch (e) {
    console.error('[browser-mcp] 策略解析失败:', (e as Error)?.message ?? e);
    return null;
  }
}

const POLICY = loadPolicy();

export default function browserMcp(pi: ExtensionAPI): void {
  if (POLICY?.browser !== true) return;

  console.error(
    `[browser-mcp] 已为 ${WAKER_ID} 注册 ${BROWSER_TOOLS.length} 个浏览器工具（broker ${BROKER.host}:${BROKER.port}）`,
  );

  for (const tool of BROWSER_TOOLS) {
    pi.registerTool({
      name: tool.name,
      label: tool.name,
      description: tool.description,
      // JSON Schema 与 pi 的 TSchema 结构兼容（selfEdit 也是这么传的），这里只做类型收窄
      parameters: tool.parameters as never,
      // 显式 any：parameters 收窄成 never 后 Static<never> 推断不出参数类型
      execute: async (_id: string, params: any) => {
        const args = (params ?? {}) as Record<string, unknown>;
        const result = await callBroker(tool.name, args);
        return {
          content: result.content.map((c) =>
            c.type === 'image'
              ? { type: 'image' as const, data: c.data ?? '', mimeType: c.mimeType ?? 'image/png' }
              : { type: 'text' as const, text: c.text ?? '' },
          ),
          details: {},
        };
      },
    });
  }
}
