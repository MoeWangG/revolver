/**
 * 会话卡：给"要不要切回这个话题"提供 200 字摘要。
 *
 * 三条硬约束，全部来自成本与延迟的账：
 *
 * 1. **闲置时生成，不在询问时生成。**
 *    询问发生在收消息的关键路径上，多一次推理就是多 8~15 秒等待——比不问还糟。
 *    把成本挪到没人等的时刻，询问时只读现成的卡。
 *
 * 2. **不打开目标会话。**
 *    只把最近 N 条消息作为**文本**塞进 prompt，用不带 `--session-id` 的一次性调用跑。
 *    这样既不和用户下一轮抢同一把会话锁，输入端也被钉死在 N 条（不会把全量历史当输入）。
 *
 * 3. **全局串行 1，不占用户任务的并发名额。**
 *    后台任务不需要并行；串行天然无撞车，也不会让用户发消息排在"生成摘要"后面。
 *    频次靠三道闸门控制：闲置时长、新增条数、单会话每日上限 + 全平台每小时上限。
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SummaryConfig, WakerRecord } from '../types.ts';
import { DATA_DIR } from './paths.ts';
import { listSessions, patchSession, resolveSession, type SessionMeta } from './sessions.ts';
import { readSessionMessages, type ChatMessage } from './sessionHistory.ts';
// 只借纯函数（判断"这名字有没有人起过" / 清洗模型给的名字）；sessionName 不反向依赖本模块
import { cleanSessionName, isDefaultName, looksDerivedName } from './sessionName.ts';
import { llmArgs } from './runner.ts';
import { runPiOnce } from './compact.ts';
import { loadAllWakers } from './registry.ts';

/** 每次生成的留痕：这份"投入"要能查，而不是靠估。 */
const LOG_FILE = join(DATA_DIR, 'summary.jsonl');

export interface SummaryGates {
  idleMinutes: number;
  minNewMessages: number;
  perSessionDaily: number;
  globalHourly: number;
}

export function gatesOf(cfg: SummaryConfig): SummaryGates {
  return {
    idleMinutes: cfg.idleMinutes,
    minNewMessages: cfg.minNewMessages,
    perSessionDaily: cfg.perSessionDaily,
    globalHourly: cfg.globalHourly,
  };
}

/**
 * 该不该现在给这个会话生成摘要。**纯函数**，便于单测与事后解释。
 * 顺序：先看有没有待办，再看闲不闲，再看够不够多，最后看额度。
 */
export function shouldSummarize(
  input: {
    now: number;
    dirtyAt?: string;
    dirtyCount?: number;
    summariesToday: number;
    globalThisHour: number;
    busy: boolean;
  },
  g: SummaryGates,
): { ok: boolean; reason: string } {
  if (input.busy) return { ok: false, reason: '正在生成中' };
  if (!input.dirtyAt) return { ok: false, reason: '没有待摘要标记' };
  const idleMs = input.now - Date.parse(input.dirtyAt);
  if (!Number.isFinite(idleMs) || idleMs < g.idleMinutes * 60_000) {
    return { ok: false, reason: `闲置不足 ${g.idleMinutes} 分钟` };
  }
  const fresh = input.dirtyCount ?? 0;
  if (fresh < g.minNewMessages) {
    return { ok: false, reason: `新增 ${fresh} 条，不足 ${g.minNewMessages}` };
  }
  if (input.summariesToday >= g.perSessionDaily) return { ok: false, reason: '已达单会话每日上限' };
  if (input.globalThisHour >= g.globalHourly) return { ok: false, reason: '已达全平台每小时上限' };
  return { ok: true, reason: '可以生成' };
}

/**
 * 去掉对"人判断话题"没有帮助的噪声：表格、代码块、链接、强调符号。
 *
 * 为什么必须做：实测把 markdown 表格从中间截断，用户看到的是
 * `| 文档 | 链接 | 原权限 → 现权限 | |---|---|---|`，完全无法判断要不要切回去。
 */
export function denoise(text: string): string {
  return String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s*\|.*\|\s*$/gm, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')
    .replace(/[*_~`>]+/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/**
 * 从会话卡首行派生一个能在列表里一眼认出的短标题。
 *
 * 为什么不为此再调一次模型：会话卡第一行本来就要求写"这段在解决什么问题"，
 * 那是这条会话里信息量最高的一句；再花一次推理只换来两三个字的提升，不划算。
 * 本地派生还多两个好处：可单测、可解释（用户问"这名字哪来的"答得出）。
 */
export function titleFromSummary(summary: string, max = 14): string {
  const first =
    String(summary ?? '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(Boolean) ?? '';
  if (!first) return '';
  const s = first
    .replace(/^[*•\-–—\s]+/, '')
    .replace(/^\d+[.、)）]\s*/, '')
    .replace(/^(这段|目前|主要是|一句话|整体)\s*/, '')
    .replace(/[。．.!！?？；;：:，,、]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return '';
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * 能不能用会话卡给这条会话改名。
 *
 * 三条边界，都是踩过的坑：
 *  1. 手动命名永不覆盖；
 *  2. 已经用卡命过名的不再改，否则每生成一次卡列表里就跳一次名；
 *  3. **存量数据没有 `nameFrom`**：这时候只能按形态判断——把「职业与副业规划」这种
 *     早就有人起好的名字换成卡片首行，是退步（`isDefaultName` 的注释里记着这条教训）。
 */
export function canNameFromCard(s: {
  name?: string;
  nameSource?: 'auto' | 'manual';
  nameFrom?: 'derive' | 'messages' | 'card';
}): boolean {
  if (s.nameSource === 'manual') return false;
  if (s.nameFrom === 'card') return false;
  if (s.nameFrom) return true;
  // 存量数据没有 nameFrom：默认名可以改，"首句截断"（以省略号结尾）也可以改——
  // 后者正是列表里认不出话题的那批；真正的名字（「职业与副业规划」）不动。
  return isDefaultName(s.name ?? '') || looksDerivedName(s.name ?? '');
}

/** 构造摘要提示词。纯函数，便于测试"字数上限有没有传对"。 */
export function buildSummaryPrompt(messages: ChatMessage[], maxChars: number): string {
  const lines = messages.map(
    (m) => `${m.role === 'user' ? '用户' : '助手'}：${denoise(m.text).slice(0, 600)}`,
  );
  const bullets = maxChars >= 150 ? 3 : 2;
  return [
    '先把下面这段对话整理成两段：一行标题 + 一段摘要。',
    '',
    '第一行输出 `标题：` + 一个不超过 12 字的短语，用来在会话列表里一眼认出"这段在聊什么"。',
    '标题要求：写**话题本身**（人/物/目标），不是用户的原话；不要引号、不要句号、',
    '不要"关于""讨论""聊天""这件事"这类空话，不要人名+问句。',
    '',
    `第二段是不超过 ${maxChars} 字的中文摘要，用途是让用户判断"要不要切回这个话题继续聊"。`,
    '要求：',
    '1. 第一句说清这段在解决什么问题',
    `2. 再用 ${bullets} 条要点写已得出的结论或决定，只写结论，不复述过程`,
    '3. 最后一句写还没定下来的问题；没有就省略',
    '4. 不要输出表格、链接、代码块、客套话；不要用"用户说""助手说"这类转述',
    '',
    '对话：',
    ...lines,
  ].join('\n');
}

/**
 * 拆开模型输出：`标题：xxx` 那一行单独取出来，其余当摘要。
 *
 * 为什么放在同一个调用里：标题和摘要是同一份理解的两个输出，分两次调模型等于
 * 把同一段对话读两遍（每次 6 秒上下）。模型没给标题行也不要紧——退回正文，
 * 由 `titleFromSummary` 本地派生，功能不依赖模型听话。
 */
export function splitSummaryOutput(text: string): { title: string; summary: string } {
  const raw = String(text ?? '').trim();
  if (!raw) return { title: '', summary: '' };
  // 模型很爱在摘要前面再写一行「摘要：」，那是标签不是内容，留着会让卡片第一句就是这个
  const stripLabel = (t: string): string => t.replace(/^\s*(摘要|总结|小结)\s*[:：]\s*/, '').trim();
  const lines = raw.split(/\r?\n/);
  const head = lines.findIndex((l) => l.trim());
  if (head < 0) return { title: '', summary: '' };
  // 两种写法都认：`标题：xxx` 与 `【话题】xxx`。**必须**有冒号或方括号之一，
  // 否则正文明明以「标题党」开头也会被当成标题行。
  const m = lines[head]!.trim().match(/^(?:[【\[]\s*(标题|话题|topic)\s*[】\]]|(标题|话题|topic)\s*[:：])\s*(.*)$/i);
  if (!m) return { title: '', summary: stripLabel(raw) };
  return {
    title: cleanSessionName(m[3] ?? ''),
    summary: stripLabel(lines.slice(head + 1).join('\n')),
  };
}

function logSummary(rec: Record<string, unknown>): void {
  try {
    appendFileSync(LOG_FILE, `${JSON.stringify(rec)}\n`, 'utf-8');
  } catch {
    /* 留痕失败不影响生成 */
  }
}

interface SummaryLogRow {
  at: string;
  wakerId: string;
  sessionId: string;
  ok: boolean;
}

function readLog(): SummaryLogRow[] {
  if (!existsSync(LOG_FILE)) return [];
  try {
    return readFileSync(LOG_FILE, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .slice(-2000)
      .map((l) => {
        try {
          return JSON.parse(l) as SummaryLogRow;
        } catch {
          return null;
        }
      })
      .filter((r): r is SummaryLogRow => Boolean(r));
  } catch {
    return [];
  }
}

/** 今日各会话的生成次数 + 近一小时全平台次数（从留痕文件算，重启不丢）。 */
function counters(now: number): { bySession: Map<string, number>; thisHour: number } {
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  const hourAgo = now - 3_600_000;
  const bySession = new Map<string, number>();
  let thisHour = 0;
  for (const r of readLog()) {
    if (!r?.ok) continue;
    const t = Date.parse(r.at);
    if (!Number.isFinite(t)) continue;
    if (t >= hourAgo) thisHour += 1;
    if (t >= dayStart.getTime()) {
      const k = `${r.wakerId}:${r.sessionId}`;
      bySession.set(k, (bySession.get(k) ?? 0) + 1);
    }
  }
  return { bySession, thisHour };
}

/** 每轮结束后调用：只打标记，不做任何推理。 */
export function markSessionDirty(wakerId: string, sessionId: string, added = 2): void {
  const s = resolveSession(wakerId, sessionId);
  patchSession(wakerId, sessionId, {
    dirtyAt: new Date().toISOString(),
    dirtyCount: (s.dirtyCount ?? 0) + added,
  });
}

/** 生成一次会话卡。失败一律返回 ok:false，由调用方保留旧卡。 */
export async function summarizeSession(
  rec: WakerRecord,
  sessionId: string,
  cfg?: SummaryConfig,
): Promise<{ ok: boolean; skipped?: string; chars?: number; ms?: number }> {
  const conf = cfg ?? rec.def.session?.summary;
  if (!conf) return { ok: false, skipped: '未配置摘要策略' };

  const session = resolveSession(rec.def.id, sessionId);
  const msgs = readSessionMessages(rec.def.id, sessionId, 12).filter((m) => m.text.trim());
  if (msgs.length < 2) return { ok: false, skipped: '消息太少，不值得生成' };

  const prompt = buildSummaryPrompt(msgs, conf.maxChars);
  const args = ['--no-tools', '--no-skills', ...llmArgs(rec)];
  if (conf.model) {
    const i = args.indexOf('--model');
    if (i >= 0) args.splice(i, 2);
    args.push('--model', conf.model);
  }

  const started = Date.now();
  const { out, err } = await runPiOnce(rec, args, prompt, conf.timeoutMs, {
    // 机器调用，不沉淀成用户记忆
    WAKER_MEMORY_NO_EXTRACT: '1',
  });
  const ms = Date.now() - started;
  const text = denoise(out);

  if (!text) {
    logSummary({ at: new Date().toISOString(), wakerId: rec.def.id, sessionId, ok: false, ms, error: err.slice(0, 200) });
    return { ok: false, skipped: err ? `模型无输出：${err.slice(0, 120)}` : '模型无输出' };
  }

  // 标题行单独取出来，别让它混进摘要正文（否则卡片第一句就是"标题：xxx"）
  const { title: modelTitle, summary: body } = splitSummaryOutput(text);
  const summaryRaw = body || text;
  const summary = summaryRaw.length > conf.maxChars ? `${summaryRaw.slice(0, conf.maxChars)}…` : summaryRaw;
  patchSession(rec.def.id, session.id, {
    cardSummary: summary,
    cardAt: new Date().toISOString(),
    cardCovered: session.messageCount,
    dirtyAt: undefined,
    dirtyCount: 0,
  });
  // 顺手把标题升到"会话卡"这一档：`/topics` 列表显示的就是它。
  // 首句派生的「你可能能从记忆里找到…」在列表里等于没有信息。
  // 模型给了标题就用模型的（它是"话题短语"），没给才本地从摘要首行派生。
  if (canNameFromCard(session)) {
    const title = modelTitle || titleFromSummary(summary);
    if (title) patchSession(rec.def.id, session.id, { name: title, nameSource: 'auto', nameFrom: 'card' });
  }
  logSummary({
    at: new Date().toISOString(),
    wakerId: rec.def.id,
    sessionId,
    ok: true,
    ms,
    chars: summary.length,
    model: conf.model ?? rec.def.model,
    // 粗估：中文约 1.6 字/token。留痕只为"投入可查"，不用于计费
    estTokens: Math.round((prompt.length + summary.length) / 1.6),
  });
  return { ok: true, chars: summary.length, ms };
}

/**
 * 询问时读摘要：有新鲜卡用卡，没有就退回原文摘录。
 *
 * **这条路径不允许失败**——它挡在"用户要不要切回"的判断上，
 * 读不到卡也必须给出点东西，否则等于让用户盲选。
 */
export function recapText(wakerId: string, sessionId: string, fallbackMax = 80): string {
  const s = resolveSession(wakerId, sessionId);
  const card = s.cardSummary?.trim();
  const behind = s.messageCount - (s.cardCovered ?? 0);
  if (card && behind <= 6) return `上次到这里（摘要）：\n${card}`;

  try {
    const msgs = readSessionMessages(wakerId, sessionId, 8).filter((m) => m.text.trim()).slice(-4);
    if (!msgs.length) return '';
    const lines = msgs.map(
      (m) => `${m.role === 'user' ? '你' : '我'}：${denoise(m.text).slice(0, fallbackMax)}`,
    );
    return `上次到这里：\n${lines.join('\n')}`;
  } catch {
    return '';
  }
}

/**
 * 扫描器：每 intervalMs 挑一个"该生成"的会话，**全局串行**跑完再等下一轮。
 *
 * 串行而不是并发，是这次唯一刻意的性能选择：后台任务排队没有成本，
 * 而并发会让"本地模型被占满"和"用户任务排队"这两件事同时发生。
 */
export function startSummaryScanner(intervalMs = 60_000): () => void {
  let running = false;

  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const now = Date.now();
      const { bySession, thisHour } = counters(now);
      const candidates: Array<{ rec: WakerRecord; s: SessionMeta; cfg: SummaryConfig }> = [];

      for (const rec of loadAllWakers()) {
        // 只给 topic 模式生成：single 模式没有"切回"这个动作，卡片纯属浪费钱
        if (rec.def.session?.mode !== 'topic') continue;
        const cfg = rec.def.session?.summary;
        if (!cfg) continue;
        for (const s of listSessions(rec.def.id)) {
          if (!s.dirtyAt) continue;
          const verdict = shouldSummarize(
            {
              now,
              dirtyAt: s.dirtyAt,
              dirtyCount: s.dirtyCount,
              summariesToday: bySession.get(`${rec.def.id}:${s.id}`) ?? 0,
              globalThisHour: thisHour,
              busy: false,
            },
            gatesOf(cfg),
          );
          if (verdict.ok) candidates.push({ rec, s, cfg });
        }
      }

      // 一次只处理一个；剩下的下一分钟再来（顺序按 lastActiveAt 由 listSessions 保证）
      const pick = candidates[0];
      if (!pick) return;
      const r = await summarizeSession(pick.rec, pick.s.id, pick.cfg);
      if (r.ok) console.log(`[summary] ${pick.rec.def.id}/${pick.s.id} 生成会话卡 ${r.chars} 字，用时 ${r.ms}ms`);
      else if (r.skipped) console.log(`[summary] ${pick.rec.def.id}/${pick.s.id} 跳过：${r.skipped}`);
    } catch (e) {
      console.error('[summary] 生成失败:', (e as Error)?.message ?? e);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
