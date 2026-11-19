import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { DATA_DIR } from '../core/paths.ts';
import { prepareFileForModel } from '../core/attachments.ts';

/**
 * 飞书入站消息的媒体归一化层。
 *
 * 为什么单独成文件（2026-10-31 用户报障「发图片聊天没反应」）：
 * 原来 `onMessage` 的第一件事是 `if (msg.message_type !== 'text') return`，
 * 图片 / 文件 / 语音 / 表情包全被**静默丢弃** —— 没有日志、没有表情回应、没有回复，
 * 用户唯一的观察就是「消息石沉大海」。而渠道层的职责边界是"把 IM 消息翻译成
 * 一次模型调用"，翻译不了的也必须翻译成一句**人能看懂的话**，不能直接吞掉。
 *
 * 所以这里把「解析」与「下载」分开：
 *  · `parseFeishuMessage` 是**纯函数**（无 IO、无网络），消息类型的分支全在这里，
 *    单测只测它就能覆盖所有类型；
 *  · `materialize` 负责把 image_key / file_key 落成本地文件，失败只降级成 note。
 *
 * 支持范围（本轮）：
 *   · 进模型：text、image、post（图文富文本）、file
 *   · 转成可读文本：share_chat、share_user、location
 *   · 明确提示不支持：audio、media（视频）、sticker、merge_forward、interactive 及未知类型
 */

/** 附件落地目录。放在 DATA_DIR 下，随实例隔离（WAKER_DATA 可覆盖）。 */
export const INBOX_DIR = join(DATA_DIR, 'feishu-inbox');

/** 残留附件保留时长：任务结束会立即删，这里只是兜底（进程崩溃等异常路径）。 */
export const INBOX_TTL_MS = 24 * 60 * 60 * 1000;

export { DEFAULT_ATTACHMENT_PROMPT } from '../core/attachments.ts';

/** 飞书单文件上限 100 MB（`im.v1.messageResource.get` 的官方限制）。 */
const MAX_RESOURCE_BYTES = 100 * 1024 * 1024;

const MIME_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'image/tiff': '.tiff',
};

/** 去掉飞书文本里的 @ 提及占位符。 */
export function stripMentions(s: string): string {
  return s
    .replace(/@_user_\d+/g, '')
    .replace(/@_all/g, '')
    .trim();
}

/** 从飞书消息 content（JSON 串）取纯文本，去掉 @ 提及标记。 */
export function extractText(content: unknown): string {
  if (typeof content !== 'string') return '';
  try {
    const obj = JSON.parse(content) as { text?: string };
    return stripMentions(obj.text ?? '');
  } catch {
    return '';
  }
}

/** 解析结果：img/file 仍是飞书的 key，下载是异步的，所以纯函数只负责分类。 */
export interface ParsedMessage {
  /** 归一化后的提示词（图片/文件消息这里通常为空，由上层补默认话术）。 */
  text: string;
  /** 需要下载的图片 key（image 消息、post 里的 img 节点）。 */
  imageKeys: string[];
  /** 需要下载的文件。 */
  files: Array<{ key: string; name?: string }>;
  /** 无法处理时的用户可见说明；非空时上层直接回这句，不进模型。 */
  note?: string;
  /** 确实应当静默忽略（如 system 提示），但需要上层留一行日志。 */
  ignore?: boolean;
}

interface FeishuMessageLike {
  message_id?: string;
  message_type?: string;
  content?: string;
}

/** post（富文本）里一行的元素收集。 */
function collectPostNode(node: unknown, acc: { text: string[]; images: string[] }): void {
  if (Array.isArray(node)) {
    for (const n of node) collectPostNode(n, acc);
    return;
  }
  if (!node || typeof node !== 'object') return;
  const el = node as Record<string, unknown>;
  const tag = String(el.tag ?? '');
  switch (tag) {
    case 'text':
    case 'code_block':
      if (el.text) acc.text.push(String(el.text));
      return;
    case 'a': {
      const label = String(el.text ?? '');
      const href = String(el.href ?? '');
      acc.text.push(href && href !== label ? `${label} ${href}` : label);
      return;
    }
    case 'at':
      acc.text.push(`@${String(el.user_name ?? el.user_id ?? '')}`);
      return;
    case 'emotion':
      acc.text.push('[表情]');
      return;
    case 'hr':
      acc.text.push('\n---\n');
      return;
    case 'img':
      if (el.image_key) acc.images.push(String(el.image_key));
      return;
    case 'media':
      // 视频节点的封面图先收下（模型能看封面），视频本体本轮不支持，由上层 note 说明
      if (el.image_key) acc.images.push(String(el.image_key));
      return;
    default:
      // 未知 tag：继续往里找 content，避免整段富文本被丢掉
      if (el.content) collectPostNode(el.content, acc);
  }
}

/** 把 post 的二维 content 拍平成文本 + 图片 key（按行拼接，保留段落）。 */
function parsePost(content: unknown): { text: string; images: string[] } {
  if (typeof content !== 'string') return { text: '', images: [] };
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(content) as Record<string, unknown>;
  } catch {
    return { text: '', images: [] };
  }
  // 收事件时通常是扁平结构；发送时（以及部分老版本）会包一层语言 key，两种都兜住
  const body = (raw.zh_cn ?? raw.en_us ?? raw.ja_jp ?? raw) as Record<string, unknown>;
  const title = String(body.title ?? '').trim();
  const rows = body.content;
  const images: string[] = [];
  if (!Array.isArray(rows)) return { text: title, images };

  const lines = rows.map((row) => {
    const acc = { text: [] as string[], images: [] as string[] };
    collectPostNode(row, acc);
    images.push(...acc.images);
    return acc.text.join('');
  });
  const bodyText = lines.filter((l) => l.trim().length > 0).join('\n').trim();
  return { text: [title, bodyText].filter(Boolean).join('\n'), images };
}

/**
 * 把一条飞书消息解析成 `text / imageKeys / files / note`。
 *
 * 纯函数：不读盘、不发请求，解析失败也只返回 note，**不抛错**
 * （事件处理里抛错只会留一行日志，用户侧依然是「没反应」）。
 */
export function parseFeishuMessage(msg: FeishuMessageLike): ParsedMessage {
  const type = String(msg.message_type ?? '');
  const content = msg.content;
  const empty: ParsedMessage = { text: '', imageKeys: [], files: [] };

  if (type === 'text') return { ...empty, text: extractText(content) };

  if (type === 'image') {
    let key = '';
    try {
      key = String((JSON.parse(String(content ?? '{}')) as { image_key?: string }).image_key ?? '');
    } catch {
      /* 落到下面的解析失败提示 */
    }
    if (!key) return { ...empty, note: '这张图片解析失败（缺少 image_key），麻烦重发一次。' };
    return { ...empty, imageKeys: [key] };
  }

  if (type === 'post') {
    const { text, images } = parsePost(content);
    if (!text && images.length === 0) {
      return { ...empty, note: '这条图文消息解析失败，麻烦换成文字或图片重新发一次。' };
    }
    return { ...empty, text, imageKeys: images };
  }

  if (type === 'file') {
    let key = '';
    let name = '';
    try {
      const obj = JSON.parse(String(content ?? '{}')) as { file_key?: string; file_name?: string };
      key = String(obj.file_key ?? '');
      name = String(obj.file_name ?? '');
    } catch {
      /* 落到下面的解析失败提示 */
    }
    if (!key) return { ...empty, note: '这个文件解析失败（缺少 file_key），麻烦重发一次。' };
    return { ...empty, files: [{ key, name: name || undefined }] };
  }

  if (type === 'share_chat') {
    let id = '';
    try {
      id = String((JSON.parse(String(content ?? '{}')) as { chat_id?: string }).chat_id ?? '');
    } catch {
      /* 忽略 */
    }
    return { ...empty, text: `[用户分享了一个群聊]${id ? ` chat_id=${id}` : ''}` };
  }

  if (type === 'share_user') {
    let id = '';
    try {
      id = String((JSON.parse(String(content ?? '{}')) as { user_id?: string }).user_id ?? '');
    } catch {
      /* 忽略 */
    }
    return { ...empty, text: `[用户分享了一个联系人]${id ? ` user_id=${id}` : ''}` };
  }

  if (type === 'location') {
    try {
      const obj = JSON.parse(String(content ?? '{}')) as {
        name?: string;
        latitude?: string;
        longitude?: string;
      };
      const name = String(obj.name ?? '').trim();
      const lat = String(obj.latitude ?? '').trim();
      const lng = String(obj.longitude ?? '').trim();
      const where = [name, lat && lng ? `(${lat}, ${lng})` : ''].filter(Boolean).join(' ');
      return { ...empty, text: `[用户分享了一个位置]${where ? ` ${where}` : ''}` };
    } catch {
      return { ...empty, text: '[用户分享了一个位置]' };
    }
  }

  if (type === 'audio') {
    return { ...empty, note: '语音消息暂不支持（需要先开通语音识别能力）。麻烦把内容打出来发我。' };
  }
  if (type === 'media') {
    return { ...empty, note: '视频消息暂不支持（只能拿到封面，看不到内容）。可以截图关键画面发我。' };
  }
  if (type === 'sticker') {
    return { ...empty, note: '表情包暂不支持（飞书不开放表情包资源下载）。' };
  }
  if (type === 'merge_forward') {
    return { ...empty, note: '合并转发的消息暂不支持，麻烦把关键几条直接发我。' };
  }
  if (type === 'interactive') {
    return { ...empty, note: '卡片消息暂不支持，麻烦把卡片里的内容用文字发我。' };
  }
  if (type === 'system') {
    // 入群/改名这类系统提示：不该打扰用户，但要留一行日志，避免又变成"静默"
    return { ...empty, ignore: true };
  }

  return { ...empty, note: `暂不支持 ${type || '未知'} 类型的消息。` };
}

/** 去掉路径里可能破坏文件名的字符，避免 key 里的特殊字符导致写盘失败。 */
function sanitize(s: string): string {
  return String(s ?? '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64);
}

function pickExt(contentType: unknown, hintName?: string): string {
  const ct = (String(contentType ?? '').split(';')[0] ?? '').trim().toLowerCase();
  const known = MIME_EXT[ct];
  if (known) return known;
  if (hintName) {
    const fromName = extname(hintName);
    if (fromName) return fromName;
  }
  return '';
}

function headerOf(res: unknown, key: string): unknown {
  const headers = (res as { headers?: Record<string, unknown> })?.headers;
  if (!headers) return undefined;
  return headers[key] ?? headers[key.toLowerCase()] ?? headers['Content-Type'];
}

/**
 * 下载单个飞书资源到 INBOX_DIR，返回**绝对路径**（pi 的 `@` 引用按 cwd 解析，
 * 相对路径会指向 agent 的工作目录，必须用绝对路径）。
 */
export async function downloadFeishuResource(
  client: any,
  messageId: string,
  fileKey: string,
  type: 'image' | 'file',
  hintName?: string,
): Promise<string> {
  mkdirSync(INBOX_DIR, { recursive: true });
  const res = await client.im.v1.messageResource.get({
    path: { message_id: messageId, file_key: fileKey },
    params: { type },
  });
  const size = Number(headerOf(res, 'content-length') ?? 0);
  if (size > MAX_RESOURCE_BYTES) {
    throw new Error(`文件超过 100MB 上限（${Math.round(size / 1024 / 1024)}MB）`);
  }
  const ext = pickExt(headerOf(res, 'content-type'), hintName);
  const dest = join(INBOX_DIR, `${sanitize(messageId)}-${sanitize(fileKey).slice(-16)}${ext}`);
  await res.writeFile(dest);
  return dest;
}

/**
 * 把解析结果里的 key 落成本地文件。
 *
 * 单个文件失败**不影响其他附件**，失败原因聚合成 note 回给用户 ——
 * 「图没发过来但模型还是回答了」比「整条消息没反应」好得多。
 */
export async function materialize(
  client: any,
  messageId: string,
  parsed: ParsedMessage,
): Promise<{ attachments: string[]; note?: string }> {
  const attachments: string[] = [];
  const failures: string[] = [];

  for (const key of parsed.imageKeys) {
    try {
      attachments.push(await downloadFeishuResource(client, messageId, key, 'image'));
    } catch (e) {
      failures.push(`图片下载失败：${(e as Error)?.message ?? e}`);
    }
  }
  for (const f of parsed.files) {
    const label = f.name ? `「${f.name}」` : '';
    try {
      const path = await downloadFeishuResource(client, messageId, f.key, 'file', f.name);
      // 文档先抽正文换成 .txt、HEIC 转 JPEG、二进制拦下（理由见 core/attachments.ts）
      const prepared = await prepareFileForModel(path, f.name ?? path);
      if (prepared.path) attachments.push(prepared.path);
      if (prepared.note) failures.push(`文件${label}：${prepared.note}`);
    } catch (e) {
      failures.push(`文件${label}下载失败：${(e as Error)?.message ?? e}`);
    }
  }

  return { attachments, note: failures.length ? failures.join('；') : undefined };
}

/** 任务结束后删掉本次附件；只允许删 INBOX_DIR 内的文件，避免被相对路径或外部路径利用。 */
export function removeAttachments(paths: string[]): void {
  for (const p of paths) {
    if (!p || !p.startsWith(INBOX_DIR)) continue;
    try {
      rmSync(p, { force: true });
    } catch {
      /* 删不掉不影响任务结果 */
    }
  }
}

/** 清理过期残留（进程崩溃、任务被强杀时留下的）。返回删除数量。 */
export function cleanupInbox(maxAgeMs = INBOX_TTL_MS): number {
  if (!existsSync(INBOX_DIR)) return 0;
  const now = Date.now();
  let removed = 0;
  for (const name of readdirSync(INBOX_DIR)) {
    const p = join(INBOX_DIR, name);
    try {
      if (now - statSync(p).mtimeMs > maxAgeMs) {
        rmSync(p, { force: true });
        removed += 1;
      }
    } catch {
      /* 单个失败不影响其余清理 */
    }
  }
  return removed;
}
