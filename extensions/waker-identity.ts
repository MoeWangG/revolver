/**
 * waker-identity — 岗位身份注入扩展
 *
 * 职责：把 agents/<id>/{identity,persona,bible}.md 装配好的提示词，注入到每个 session 的 system prompt。
 *
 * 两条硬性约束（来自对本机 memory.ts / wal.ts 的探查）：
 *
 * 1. before_agent_start 的所有 handler 是**串行 await** 的，这里绝不能做磁盘或网络 IO，
 *    否则会拖住整个 agent 启动。因此注入文本由外壳侧预先编译成 `<policy>/<id>.prompt.md`，
 *    本扩展只在**加载时**读一次进内存，运行时纯内存命中。
 *
 * 2. 必须与上游handoff 接力而非覆盖：返回 `{ systemPrompt: 原 + 追加 }`，
 *    不能直接返回自己的 systemPrompt，否则会抹掉 memory 扩展注入的上下文。
 *
 * 环境变量（由 Runner 在 spawn pi 子进程时注入）：
 *   WAKER_ID          员工 id
 *   WAKER_POLICY_DIR  编译产物目录
 */
import { existsSync, readFileSync } from 'node:fs';

import type { BeforeAgentStartEvent, Ctx, ExtensionAPI } from '@earendil-works/pi-coding-agent';

const WAKER_ID = process.env.WAKER_ID ?? '';
const POLICY_DIR = process.env.WAKER_POLICY_DIR ?? '';
const MARKER = `<!-- waker-identity:${WAKER_ID} -->`;

/** 编译产物路径。 */
function artifact(ext: string): string {
  return `${POLICY_DIR}/${WAKER_ID}.${ext}`;
}

function loadPrompt(): string {
  if (!WAKER_ID || !POLICY_DIR) return '';
  const p = artifact('prompt.md');
  if (!existsSync(p)) return '';
  try {
    return readFileSync(p, 'utf-8').trim();
  } catch (e) {
    console.error('[waker-identity] 读取身份文件失败:', (e as Error)?.message ?? e);
    return '';
  }
}

// 加载期一次性读入，之后全是内存读取，保证 before_agent_start 亚毫秒返回
const ROLE_PROMPT = loadPrompt();

export default function wakerIdentity(pi: ExtensionAPI): void {
  if (!ROLE_PROMPT) {
    if (WAKER_ID) {
      console.error(`[waker-identity] 未找到 ${WAKER_ID} 的编译产物，跳过注入（请先在 CLI 侧执行 waker compile）`);
    }
    return;
  }

  pi.on('before_agent_start', (event: BeforeAgentStartEvent, _ctx: Ctx) => {
    try {
      const base = event.systemPrompt ?? '';
      // 幂等：同一 session 可能被多次触发，含标记则不再追加，避免提示词无限膨胀
      if (base.includes(MARKER)) return undefined;
      return { systemPrompt: `${base}\n\n${MARKER}\n${ROLE_PROMPT}` };
    } catch (e) {
      console.error('[waker-identity] 注入异常:', (e as Error)?.message ?? e);
      return undefined;
    }
  });

  // 命令名需避开已占用的 memory / wal / guard
  pi.registerCommand('waker', {
    description: '显示当前生效的岗位身份摘要',
    execute: async (_args: string, ctx: Ctx) => {
      const head = ROLE_PROMPT.split('\n').slice(0, 12).join('\n');
      const msg = `当前员工：${WAKER_ID}\n${head}`;
      if (ctx?.hasUI && ctx.ui) ctx.ui.notify(msg, 'info');
      else console.log(msg);
    },
  });
}
