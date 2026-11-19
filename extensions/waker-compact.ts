/**
 * waker-compact — 上下文压缩的**旁路观察 + 手动触发**扩展
 *
 * ## 为什么不自己压缩
 *
 * 平台原先自己实现压缩：让模型摘要 → `clearSession` 把会话文件改名归档 →
 * 用同一个 `--session-id` 把纪要"种回"一个新会话。这么做的后果是
 * **用户的对话记录整段消失**（界面上只剩两条"上下文备忘"），
 * 而人的记忆是挂在那些原始对话上的 —— 2026-10-11 用户明确要求：
 * 「可以瘦身，但不能改我的对话记录；压缩内容放在记录中间，
 * 下一轮加载 history 时从压缩内容开始加载」。
 *
 * 而这正是 **pi 原生 compaction** 的行为：
 * - 压缩时在**同一个** JSONL 里插一条 `type: "compaction"` 记录（`summary` 字段就是压缩内容），
 *   之前的记录**一条不删**（`CompactionEntry.summary` + `firstKeptEntryId`）；
 * - 装配上下文时用 `getLatestCompactionEntry()` 定位边界，**从压缩处之后开始**加载；
 * - 默认就开着：`DEFAULT_COMPACTION_SETTINGS = { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 }`。
 *
 * 所以平台不再自己压缩，只做两件**不碰会话文件**的事：
 *
 * 1. **留痕**：监听 `session_compact`，把 token 数、触发原因、摘要写进
 *    `data/context/<id>/compactions.jsonl`，供人工核对"什么时候压过一次、压了什么"。
 * 2. **手动触发**：`WAKER_FORCE_COMPACT=<piSessionId>` 时，会话开始就调 `ctx.compact()`，
 *    让 `waker compact <id> --force` 走原生路径（见 core/compact.ts）。
 *
 * 环境变量（由 Runner 在 spawn pi 子进程时注入）：
 *   WAKER_ID                员工 id
 *   WAKER_POLICY_DIR        编译产物目录（其上一级即 data/）
 *   WAKER_FORCE_COMPACT     非空则本次会话启动时手动压缩一次
 */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { ExtensionAPI, SessionCompactEvent } from '@earendil-works/pi-coding-agent';

const WAKER_ID = process.env.WAKER_ID ?? '';
const POLICY_DIR = process.env.WAKER_POLICY_DIR ?? '';
const FORCE = process.env.WAKER_FORCE_COMPACT ?? '';
const DATA_DIR = POLICY_DIR ? dirname(POLICY_DIR) : '';

/** 压缩留痕文件（追加写，一行一次压缩）。 */
function ledgerPath(): string {
  const dir = join(DATA_DIR, 'context', WAKER_ID);
  mkdirSync(dir, { recursive: true });
  return join(dir, 'compactions.jsonl');
}

/** 从留痕里读回最近一次压缩的摘要（平台强制压缩的回执要用它，而不是自己编一句）。 */
export function readLedgerSummary(wakerId: string, dataDir: string): string {
  try {
    const lines = readFileSync(join(dataDir, 'context', wakerId, 'compactions.jsonl'), 'utf-8')
      .trim()
      .split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const row = JSON.parse(lines[i] ?? '') as { summary?: string };
      if (row.summary) return row.summary;
    }
  } catch {
    /* 没有留痕就算了 */
  }
  return '';
}

export default function wakerCompact(pi: ExtensionAPI): void {
  if (!WAKER_ID) return;
  // 加载即打点（只在强制路径上，平时静默）：用于确认"扩展到底有没有被加载、有没有拿到环境变量"。
  // 平台侧那次强制压缩曾出现"文档里说调了 compact()，但 stdout 里连一行扩展日志都没有"，
  // 没有这行打点就无法区分"扩展没加载"与"加载了但没触发"。
  if (FORCE) console.log(`[waker-compact] 已加载（WAKER_ID=${WAKER_ID}，FORCE=${FORCE}）`);

  // 1) 留痕：pi 每完成一次压缩就记一行。**只读会话文件，不写。**
  pi.on('session_compact', (event: SessionCompactEvent) => {
    try {
      const entry = event.compactionEntry as {
        id?: string;
        summary?: string;
        tokensBefore?: number;
        firstKeptEntryId?: string;
      };
      appendFileSync(
        ledgerPath(),
        `${JSON.stringify({
          at: new Date().toISOString(),
          wakerId: WAKER_ID,
          reason: event.reason,
          fromExtension: Boolean(event.fromExtension),
          tokensBefore: entry.tokensBefore ?? 0,
          summaryChars: (entry.summary ?? '').length,
          entryId: entry.id ?? null,
          firstKeptEntryId: entry.firstKeptEntryId ?? null,
          summary: entry.summary ?? '',
        })}\n`,
        'utf-8',
      );
      console.log(
        `[waker-compact] 已记录一次压缩（${event.reason}）：${entry.tokensBefore ?? 0} token → 摘要 ${(entry.summary ?? '').length} 字；对话记录未改动`,
      );
    } catch (e) {
      console.error('[waker-compact] 留痕失败:', (e as Error)?.message ?? e);
    }
  });

  // 2) 手动触发：只在平台明确要求的那一次 run 里生效（每次 run 都是新进程，不会重复触发）
  //
  // 时机选 `before_agent_start` 而不是 `session_start`：**实测 `session_start` 时会话文件
  // 还没装载进 session manager**，`getBranch()` 拿不到历史，于是 pi 报
  // "Nothing to compact (session too small)"。`before_agent_start` 时历史已就绪。
  // `compact()` 是 fire-and-forget（完成走回调），不会阻塞这个串行 await 的钩子。
  if (!FORCE) return;
  pi.on('before_agent_start', async (_event, ctx) => {
    console.log(`[waker-compact] 收到手动压缩请求（${FORCE}），调用 pi 原生 compact()`);
    // **必须等它跑完再放行本轮**（2026-10-14 定位出的坑）：
    // `ctx.compact()` 是 fire-and-forget，而压缩要自己调一次 LLM（十几万 token 的摘要要几十秒）。
    // 不等的话，本轮问答一结束 pi 就退出了，压缩被腰斩 → 会话记录里**没有压缩节点**，
    // 平台侧于是报告"pi 判定不需要压缩"（实测就是被这个假象误导了半天）。
    // pi 的 extension runner 是 `await handler(...)` 串行调用（runner.js 的 emit），
    // 所以这里返回一个等到回调触发才 resolve 的 Promise，就能把进程"按住"到压缩写完。
    // 只在这条显式强制路径上等待，正常任务完全不受影响。
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        resolve();
      };
      // 兜底：压缩卡住也不能把任务挂死（正常十几秒，给 5 分钟足够）
      const timer = setTimeout(() => {
        console.error('[waker-compact] 等压缩完成超时（300s），放行本轮（压缩可能未落盘）');
        finish();
      }, 300_000);
      try {
        ctx.compact?.({
          onComplete: (r) => {
            console.log(
              `[waker-compact] 压缩完成：${r.tokensBefore} → 约 ${r.estimatedTokensAfter ?? '?'} token；对话记录保留，历史仍完整可查`,
            );
            clearTimeout(timer);
            finish();
          },
          onError: (err) => {
            console.error('[waker-compact] 压缩失败:', err?.message ?? err);
            clearTimeout(timer);
            finish();
          },
        });
      } catch (e) {
        console.error('[waker-compact] 触发压缩失败:', (e as Error)?.message ?? e);
        clearTimeout(timer);
        finish();
      }
    });
  });
}
