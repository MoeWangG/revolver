import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PI_AGENT_HOME } from './paths.ts';
import { resolveSession } from './sessions.ts';

/** 一步执行痕迹：工具调用或思考。 */
export interface ChatStep {
  kind: 'tool' | 'thinking';
  /** 工具名（thinking 为空）。 */
  name?: string;
  /** 一行摘要：折叠时显示的那一句。 */
  summary: string;
  /** **完整**内容：展开后原样展示（不做截断）。 */
  detail: string;
}

/**
 * 用户在消息里附的图片（`{type:"image", mimeType, data}` 内容块）。
 *
 * **只给元数据，不带 base64**：一张截图 base64 动辄 1–3MB，实测有 13MB 的带图会话，
 * 把这些塞进历史响应会让每次开窗都传几十 MB、浏览器内存翻几倍。
 * 前端按 `line + index` 到 `/api/agents/:id/sessions/:sid/messages/:line/images/:index` 取二进制。
 */
export interface ChatImage {
  /** 图片 MIME（pi 写在块顶层的 `mimeType`；老数据缺失时按 png 处理）。 */
  mimeType: string;
  /** 该条记录在 jsonl 文件里的**行号**（0 基）。文件只追加不改写，行号稳定。 */
  line: number;
  /** 同一条消息里的第几张（0 基）。 */
  index: number;
}

/** 一条可展示的对话消息。 */
export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  text: string;
  /** 消息时间（ISO8601）。 */
  at: string;
  /**
   * 该答复正文之前的执行步骤（工具调用等）。
   * 同一次提问产生的多条 assistant 消息会被合并到这一条上。
   */
  steps?: ChatStep[];
  /** 这条消息里附的图片（按出现顺序）。文字为空但有图时，前端仍要画一个气泡。 */
  images?: ChatImage[];
  /**
   * 带这个字段的是**上下文压缩节点**（`role: 'system'`，不是对话消息）：
   * pi 在压缩时往会话记录里插了一条 `type:"compaction"`，这里把它作为**分隔标记**读出来，
   * 让界面上能看出"瘦身发生在哪、原文一条没少"。
   *
   * 为什么必须显示：用户第一次遇到压缩时，界面上的历史整段消失（旧实现是"改名归档 + 种回摘要"），
   * 看起来就是"记录被删了"。现在的实现不动记录，但**必须让人看见这件事发生过**，
   * 否则还是会怀疑数据丢了（2026-10-11 真实投诉）。
   */
  compaction?: {
    /** 压缩前约多少 token。 */
    tokensBefore: number;
    /** 压缩内容（摘要）的字数。 */
    summaryChars: number;
  };
}

/**
 * 在 pi 的会话目录里按 **pi 会话 id** 精确定位会话文件。
 * 文件名形如 `<timestamp>_<piSessionId>.jsonl`，散落在各 project slug 子目录下。
 */
function findSessionFile(piSessionId: string): string | null {
  const root = join(PI_AGENT_HOME, 'sessions');
  if (!existsSync(root)) return null;
  const suffix = `_${piSessionId}.jsonl`;
  let best: { path: string; mtime: number } | null = null;
  for (const sub of readdirSync(root)) {
    const dir = join(root, sub);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(suffix)) continue;
      const p = join(dir, f);
      try {
        const mtime = statSync(p).mtimeMs;
        if (!best || mtime > best.mtime) best = { path: p, mtime };
      } catch {
        /* 跳过读不到的文件 */
      }
    }
  }
  return best?.path ?? null;
}

/** 扫描会话根目录一次，建立 `pi 会话 id → 最新文件` 索引（每会话都去遍历目录会很浪费）。 */
function indexSessionFiles(): Map<string, { path: string; mtime: number }> {
  const root = join(PI_AGENT_HOME, 'sessions');
  const out = new Map<string, { path: string; mtime: number }>();
  if (!existsSync(root)) return out;
  for (const sub of readdirSync(root)) {
    const dir = join(root, sub);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const f of readdirSync(dir)) {
      const i = f.lastIndexOf('_');
      if (i < 0 || !f.endsWith('.jsonl')) continue;
      const id = f.slice(i + 1, -'.jsonl'.length);
      const p = join(dir, f);
      try {
        const mtime = statSync(p).mtimeMs;
        const cur = out.get(id);
        if (!cur || mtime > cur.mtime) out.set(id, { path: p, mtime });
      } catch {
        /* 跳过读不到的 */
      }
    }
  }
  return out;
}

/**
 * 批量取各会话的"最后一次问答"（只看文件**尾部**，不读全量）。
 *
 * 看板列表每行那两句摘要用它，而不是用任务流水——摘要代表"这个会话里说了什么"，
 * 真源就是 pi 会话文件。这样**清空会话后摘要会一起消失**，不会留下"看着还有上下文、
 * 点进去却是空的"的错位（流水仍完整保留在 tasks.jsonl 里供回溯，只是不再当摘要用）。
 */
export function lastExchanges(piSessionIds: string[], tailBytes = 64 * 1024): Map<string, { prompt?: string; result?: string }> {
  const index = indexSessionFiles();
  const out = new Map<string, { prompt?: string; result?: string }>();

  for (const id of piSessionIds) {
    const hit = index.get(id);
    if (!hit) continue;
    let raw = '';
    try {
      const st = statSync(hit.path);
      const start = Math.max(0, st.size - tailBytes);
      const len = st.size - start;
      const buf = Buffer.alloc(len);
      const fd = openSync(hit.path, 'r');
      try {
        readSync(fd, buf, 0, len, start);
      } finally {
        closeSync(fd);
      }
      raw = buf.toString('utf-8');
      const lines = raw.split('\n');
      if (start > 0) lines.shift(); // 从中间截断时首行多半是半截 JSON，丢掉

      let prompt: string | undefined;
      let result: string | undefined;
      for (let i = lines.length - 1; i >= 0 && (result === undefined || prompt === undefined); i -= 1) {
        const t = lines[i]!.trim();
        if (!t) continue;
        let entry: { type?: string; message?: { role?: string; content?: Array<{ type?: string; text?: string }> } };
        try {
          entry = JSON.parse(t);
        } catch {
          continue;
        }
        if (entry.type !== 'message') continue;
        const role = entry.message?.role;
        if (role !== 'user' && role !== 'assistant') continue;
        const text = (entry.message?.content ?? [])
          .filter((c) => c?.type === 'text' && typeof c.text === 'string')
          .map((c) => c.text as string)
          .join('')
          .trim();
        if (!text) continue;
        if (role === 'assistant' && result === undefined) result = text;
        else if (role === 'user' && prompt === undefined) prompt = text;
      }
      if (prompt !== undefined || result !== undefined) out.set(id, { prompt, result });
    } catch {
      /* 读不到就当没有 */
    }
  }
  return out;
}

/**
 * 从会话文件尾部判断"这一轮模型调用是不是失败了"。
 *
 * 为什么必须有这道判定：pi 把 provider 的错误（如 400 上下文超限）写成一条
 * `stopReason: "error"` 的 assistant 记录，**进程仍然以 0 退出**。runWaker 只判退出码，
 * 于是连续三次 400 全被记成 `success`、`result` 为空 —— 用户界面只剩"（无回复）"，
 * 看板却显示成功（2026-11-07 真实事故）。
 *
 * 纯函数，单测直接喂尾部文本：只看**最后一条 assistant**，且必须写于本轮开始之后
 * —— 上一轮的旧错误不能被算到这一次头上，本轮没写出 assistant 记录时也不能乱认。
 */
export function parseRunError(tail: string, sinceMs: number): string | null {
  const lines = tail.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const t = lines[i]!.trim();
    if (!t) continue;
    let entry: {
      type?: string;
      timestamp?: string;
      message?: { role?: string; stopReason?: string; errorMessage?: string };
    };
    try {
      entry = JSON.parse(t) as typeof entry;
    } catch {
      continue;
    }
    if (entry.type !== 'message') continue;
    if (entry.message?.role !== 'assistant') continue;
    const at = Date.parse(String(entry.timestamp ?? ''));
    if (!Number.isFinite(at) || at < sinceMs) return null;
    if (entry.message.stopReason !== 'error') return null;
    const msg = String(entry.message.errorMessage ?? '').trim();
    return msg || '模型调用失败（pi 未给出原因）';
  }
  return null;
}

/**
 * 读该 pi 会话文件尾部（最多 64KB）再判定，避免每次任务结束都读十几 MB 的会话文件。
 */
export function lastRunError(piSessionId: string, sinceMs: number, tailBytes = 64 * 1024): string | null {
  const file = findSessionFile(piSessionId);
  if (!file) return null;
  try {
    const st = statSync(file);
    const start = Math.max(0, st.size - tailBytes);
    const len = st.size - start;
    if (len <= 0) return null;
    const buf = Buffer.alloc(len);
    const fd = openSync(file, 'r');
    try {
      readSync(fd, buf, 0, len, start);
    } finally {
      closeSync(fd);
    }
    const lines = buf.toString('utf-8').split('\n');
    if (start > 0) lines.shift(); // 从中间截断时首行多半是半截 JSON，丢掉
    return parseRunError(lines.join('\n'), sinceMs);
  } catch {
    return null;
  }
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** 摘要里优先展示的参数键（最贴近"它到底做了什么"）。 */
const PREFERRED_ARG_KEYS = ['command', 'path', 'filePath', 'file_path', 'pattern', 'query', 'url', 'prompt', 'name'];

/**
 * 把工具参数拆成「一行摘要 + 完整内容」。
 *
 * 摘要用于折叠态（截断），`detail` **完整保留**——展开后能看到原始参数，
 * 不为省几十个字符把关键信息切掉。
 */
function describeArgs(args: unknown): { summary: string; detail: string } {
  if (args == null) return { summary: '', detail: '' };
  if (typeof args === 'string') return { summary: oneLine(args).slice(0, 160), detail: args };
  if (typeof args !== 'object') {
    const s = String(args);
    return { summary: oneLine(s).slice(0, 160), detail: s };
  }

  const o = args as Record<string, unknown>;
  const keys = Object.keys(o);
  // 单键字符串（如 bash 的 command）：直接给原文，既不埋没信息也不加 JSON 噪声
  const only = keys.length === 1 ? o[keys[0]!] : undefined;
  if (typeof only === 'string' && only.trim()) {
    return { summary: oneLine(only).slice(0, 160), detail: only };
  }

  let detail = '';
  try {
    detail = JSON.stringify(o, null, 2);
  } catch {
    detail = String(o);
  }
  for (const k of PREFERRED_ARG_KEYS) {
    const v = o[k];
    if (typeof v === 'string' && v.trim()) return { summary: oneLine(v).slice(0, 160), detail };
  }
  const firstStr = Object.values(o).find((v) => typeof v === 'string' && v.trim());
  const summary = typeof firstStr === 'string' ? oneLine(firstStr).slice(0, 160) : oneLine(detail).slice(0, 160);
  return { summary, detail };
}

/**
 * 读取某个平台会话的历史对话（从 pi 原生会话文件还原）。
 *
 * 展示口径：
 *  - 只取 user / assistant 的**文本**作为正文；
 *  - assistant 的 `toolCall` / `thinking` 收成 `steps`，由前端在正文前以引用格式展示；
 *  - **同一次提问下的多条 assistant 消息合并成一条答复**，于是"工具调用 → 最终回答"
 *    呈现为一个气泡（步骤在前、正文在后），而不是刷出一串碎片消息。
 */
export function readSessionMessages(wakerId: string, sessionId?: string, limit = 200): ChatMessage[] {
  const session = resolveSession(wakerId, sessionId);
  const file = findSessionFile(session.piSessionId);
  if (!file) return [];

  const out: ChatMessage[] = [];
  let raw = '';
  try {
    raw = readFileSync(file, 'utf-8');
  } catch {
    return [];
  }

  // 保留行号：图片二进制不随历史下发，前端要靠 `line + index` 回取（见 ChatImage 注释）
  const lines = raw.split('\n');
  for (let lineNo = 0; lineNo < lines.length; lineNo += 1) {
    const t = lines[lineNo]!.trim();
    if (!t) continue;
    try {
      const entry = JSON.parse(t) as {
        type?: string;
        timestamp?: string;
        summary?: string;
        tokensBefore?: number;
        message?: {
          role?: string;
          timestamp?: number;
          content?: Array<{
            type?: string;
            text?: string;
            thinking?: string;
            name?: string;
            arguments?: unknown;
            /** image 块：pi 把 MIME 和 base64 都放在顶层。 */
            mimeType?: string;
            data?: string;
          }>;
        };
      };

      // 压缩节点：作为**分隔标记**放进消息流（不是消息），让界面能标出"这里压过一次"。
      // pi 用它来裁剪上下文（从该节点之后装配），但记录本身完整，所以这里只是"读出来展示"。
      if (entry.type === 'compaction') {
        out.push({
          role: 'system',
          text: '',
          at: entry.timestamp ?? '',
          compaction: {
            tokensBefore: typeof entry.tokensBefore === 'number' ? entry.tokensBefore : 0,
            summaryChars: typeof entry.summary === 'string' ? entry.summary.length : 0,
          },
        });
        continue;
      }

      if (entry.type !== 'message') continue;
      const role = entry.message?.role;
      if (role !== 'user' && role !== 'assistant') continue;

      const texts: string[] = [];
      const steps: ChatStep[] = [];
      const images: ChatImage[] = [];
      for (const c of entry.message?.content ?? []) {
        if (c.type === 'text' && typeof c.text === 'string') {
          texts.push(c.text);
        } else if (c.type === 'image') {
          // 图片块以前被整块丢掉：用户在网页发图、刷新后聊天记录里只剩一行
          // `【附件：<随机 id>】`，看不到自己发过什么（真实投诉）。
          images.push({
            mimeType: typeof c.mimeType === 'string' && c.mimeType.startsWith('image/') ? c.mimeType : 'image/png',
            line: lineNo,
            index: images.length,
          });
        } else if (c.type === 'toolCall') {
          const { summary, detail } = describeArgs(c.arguments);
          steps.push({ kind: 'tool', name: typeof c.name === 'string' ? c.name : 'tool', summary, detail });
        } else if (c.type === 'thinking' && typeof c.thinking === 'string') {
          steps.push({
            kind: 'thinking',
            summary: oneLine(c.thinking).slice(0, 140),
            detail: c.thinking.trim(),
          });
        }
      }

      const at =
        entry.timestamp ??
        (typeof entry.message?.timestamp === 'number' ? new Date(entry.message.timestamp).toISOString() : '');
      const text = texts.join('').trim();

      if (role === 'user') {
        // 纯图片消息没有 text：不能因为"没文字"就把整条消息丢掉
        if (text || images.length) out.push({ role: 'user', text, at, ...(images.length ? { images } : {}) });
        continue;
      }

      // assistant：并入上一条答复（同一回合），保持"步骤在前、正文在后"
      const last = out[out.length - 1];
      if (last && last.role === 'assistant') {
        if (steps.length) last.steps = [...(last.steps ?? []), ...steps];
        if (text) last.text = last.text ? `${last.text}\n\n${text}` : text;
        if (at) last.at = at;
      } else {
        if (!text && !steps.length) continue;
        out.push({ role: 'assistant', text, at, ...(steps.length ? { steps } : {}) });
      }
    } catch {
      /* 坏行跳过 */
    }
  }

  // 丢掉既无正文也无步骤的空答复；**压缩节点必须留下**（它按设计就没有正文）
  return out
    .filter((m) => m.text.trim() || (m.steps?.length ?? 0) > 0 || (m.images?.length ?? 0) > 0 || m.compaction)
    .slice(-limit);
}

/** 单张图上限：与附件上传上限一致，防止被构造的会话文件撑爆内存。 */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** 取 jsonl 里第 n 行（0 基）。用 indexOf 逐行找，避免为一张图 split 整个几十 MB 的文件。 */
function readLineAt(buf: Buffer, n: number): string | null {
  if (!Number.isInteger(n) || n < 0) return null;
  let start = 0;
  for (let i = 0; i < n; i += 1) {
    const nl = buf.indexOf(0x0a, start);
    if (nl < 0) return null;
    start = nl + 1;
  }
  const end = buf.indexOf(0x0a, start);
  return buf.subarray(start, end < 0 ? buf.length : end).toString('utf-8');
}

/**
 * 按 `ChatImage` 的 `line + index` 取出图片二进制。
 *
 * 为什么按需取而不内联进历史：见 `ChatImage` 的注释（体积）。行号稳定前提是
 * pi 只追加写会话文件——`core/compact.ts` 也遵循这一点（压缩只插节点，不改写旧行）。
 */
export function readSessionImage(
  wakerId: string,
  sessionId: string | undefined,
  line: number,
  index: number,
): { mimeType: string; data: Buffer } | null {
  if (!Number.isInteger(line) || line < 0 || !Number.isInteger(index) || index < 0) return null;
  const session = resolveSession(wakerId, sessionId);
  const file = findSessionFile(session.piSessionId);
  if (!file) return null;

  let buf: Buffer;
  try {
    buf = readFileSync(file);
  } catch {
    return null;
  }
  const raw = readLineAt(buf, line);
  if (!raw) return null;

  let entry: {
    type?: string;
    message?: { content?: Array<{ type?: string; mimeType?: string; data?: string }> };
  };
  try {
    entry = JSON.parse(raw);
  } catch {
    return null;
  }
  if (entry.type !== 'message') return null;

  let seen = 0;
  for (const c of entry.message?.content ?? []) {
    if (c?.type !== 'image') continue;
    if (seen !== index) {
      seen += 1;
      continue;
    }
    if (typeof c.data !== 'string' || !c.data) return null;
    const data = Buffer.from(c.data, 'base64');
    if (!data.length || data.length > MAX_IMAGE_BYTES) return null;
    const mimeType = typeof c.mimeType === 'string' && c.mimeType.startsWith('image/') ? c.mimeType : 'image/png';
    return { mimeType, data };
  }
  return null;
}
