import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { DATA_DIR } from './paths.ts';
import { extractDocumentText, isDocumentFile } from '../channels/docExtract.ts';

/**
 * 附件落盘与"给模型前加工"的公共层。
 *
 * 两个渠道（飞书、看板 web 聊天）拿到附件后的处理完全一致：
 *   1. 二进制先落盘（渠道各自负责下载/接收）；
 *   2. 图片交给 pi —— pi 按**文件头**只会认 JPEG/PNG/GIF/WEBP/BMP，对它认识的格式
 *      生成 image 内容块走视觉通道；**HEIC/HEIF 必须先转 JPEG**（见下方事故记录）；
 *   3. 文档**先抽正文**再以 `.txt` 替代原文件 —— 二进制直接给 pi 会被当文本硬内联，
 *      模型只能读到 `/Producer`、`/Widths` 这类结构（2026-11-01 实测）；
 *   4. 其它二进制（zip/tiff/dmg…）**一律拦下**，只回一句人话说明，不进上下文。
 * 这段逻辑只该有一份，否则两条渠道迟早行为漂移（比如以后加 rar 支持只改了一边）。
 *
 * 2026-11-07 事故：`.heic` 被算作图片、原样 `@` 给 pi，而 pi 不认 HEIC →
 * 掉进"文本文件"分支用 utf-8 把 4.6MB 二进制读进上下文 → 单条消息请求 375 万
 * token，超过模型 104 万上限直接 400；pi 的自动压缩也救不回来（压缩边界只能落在
 * 消息边界，这条巨型消息被整条保留）。所以这里的"格式不支持"判断**不能靠扩展名猜**，
 * 必须有：转码 → 拦下 → 绝不内联。
 */

/** web 端上传目录。与飞书的 `feishu-inbox` 分开：生命周期与清理策略不同。 */
export const WEB_INBOX_DIR = join(DATA_DIR, 'web-inbox');

/** 残留保留时长（上传后没发送、进程崩溃等异常路径的兜底）。 */
export const INBOX_TTL_MS = 24 * 60 * 60 * 1000;

/** 单文件上限。与飞书下载上限一致，避免两边口径不一。 */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/** 单条消息最多附件数：每张图约 1–2k tokens，再多会把上下文挤爆。 */
export const MAX_ATTACHMENTS_PER_MESSAGE = 6;

/** 纯附件消息没有配文时的默认话术（空 prompt 会让模型答非所问）。 */
export const DEFAULT_ATTACHMENT_PROMPT = '帮我看看这个。';

export type AttachmentKind = 'image' | 'document' | 'other';

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.heic', '.heif']);
/** Apple 的 HEIC/HEIF：pi 不认，必须先转 JPEG 再交出去。 */
const HEIF_EXT = new Set(['.heic', '.heif']);

/** `/api/talk` 的单个附件入参：`id` 用于定位 inbox 文件，`name` 用于写进会话文本。 */
export interface TalkAttachmentInput {
  id: string;
  /** 用户看到的原始文件名。缺失时调用方回落到 id。 */
  name?: string;
}

/**
 * 归一化 `/api/talk` 的 `attachments`。
 *
 * 同时接受 `string[]`（旧客户端）与 `{id,name}[]`（新客户端）：后者让会话文件里那行
 * `【附件：…】` 是**人能读懂的文件名**，而不是 `m3k2j1-a1b2c3d4-____.png` 这种清洗后的 id。
 * 空 id 一律丢弃——它指向 `sanitizeFileName('')` 的兜底值 `file`，语义是错的。
 */
export function normalizeTalkAttachments(
  input: unknown,
  max = MAX_ATTACHMENTS_PER_MESSAGE,
): TalkAttachmentInput[] {
  if (!Array.isArray(input)) return [];
  return input
    .slice(0, max)
    .map((x) => {
      if (typeof x === 'string') return { id: x.trim(), name: undefined };
      const o = (x ?? {}) as { id?: unknown; name?: unknown };
      return {
        id: String(o.id ?? '').trim(),
        name: typeof o.name === 'string' && o.name.trim() ? o.name : undefined,
      };
    })
    .filter((a) => a.id);
}

export function attachmentKind(name: string): AttachmentKind {
  const ext = extname(name).toLowerCase();
  if (IMAGE_EXT.has(ext)) return 'image';
  if (isDocumentFile(name)) return 'document';
  return 'other';
}

/**
 * 清洗文件名：只留字母数字与 `._-`，其余换成 `_`。
 * 中文会被抹成下划线 —— 这是有意的：文件名只用于**拼路径**，展示名存在别处；
 * 保留中文会在大小写不敏感文件系统与 URL 编码上引入不必要的坑。
 */
export function sanitizeFileName(name: string): string {
  const base = String(name ?? '')
    .split(/[/\\]/)
    .pop()
    ?.trim();
  const ext = extname(base ?? '').toLowerCase();
  const stem = (base ?? '').slice(0, Math.max(0, (base ?? '').length - ext.length));
  const safeStem = stem.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 60) || 'file';
  const safeExt = ext.replace(/[^A-Za-z0-9.]/g, '').slice(0, 12);
  return `${safeStem}${safeExt}`;
}

/**
 * 把附件 id 解析成 web-inbox 内的绝对路径。
 * **越界一律返回 null**：id 来自 HTTP 请求体，不能让 `../` 之类的值读到别处。
 */
export function webInboxPath(id: string): string | null {
  // 空 id 必须直接拒绝：sanitizeFileName('') 会兜底成 'file'，
  // 那样空 id 就会指向 inbox 里某个真实文件，语义上是错的。
  if (!String(id ?? '').trim()) return null;
  const name = sanitizeFileName(String(id ?? ''));
  if (!name) return null;
  const full = resolve(WEB_INBOX_DIR, name);
  const root = resolve(WEB_INBOX_DIR);
  if (full !== root && !full.startsWith(root + '/')) return null;
  return full;
}

/** 交给模型前的加工结果。`path` 为 `null` 表示这份附件不能用（原因在 `note` 里）。 */
export interface PreparedAttachment {
  path: string | null;
  note?: string;
}

/**
 * 文件头 8KB 内出现 NUL 就按二进制处理。
 *
 * 不能靠扩展名：`.zip`、`.tiff`、`.dmg`、无扩展名的可执行文件都会被 pi 当文本读，
 * 而代码、日志、CSV、SVG 这类文本必须继续放行 —— 所以判据只认内容。
 */
export function isBinaryFile(absPath: string, sampleBytes = 8192): boolean {
  let fd: number | null = null;
  try {
    fd = openSync(absPath, 'r');
    const buf = Buffer.alloc(sampleBytes);
    const n = readSync(fd, buf, 0, sampleBytes, 0);
    return buf.subarray(0, n).includes(0);
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* 关不掉不影响判定 */
      }
    }
  }
}

/**
 * HEIC/HEIF → JPEG（长边 2048，质量 82）。
 *
 * 用 macOS 自带的 `sips`，不引入 npm 图像库（libheif 编译依赖重、CI 装不上）；
 * 目标设备就是 M5 Mac，转一张 iPhone 照片约 200ms、输出 ~500KB（原图 4.6MB）。
 * 转出来的 jpg 与原件同目录，渠道的清理逻辑按目录前缀删，不会漏。
 * 非 macOS / 转换失败返回 `null`，由调用方明确告知用户 —— 绝不把原文件当文本塞进上下文。
 */
function transcodeHeifToJpeg(absPath: string): string | null {
  const out = `${absPath.replace(/\.[^./\\]+$/, '')}.jpg`;
  const r = spawnSync(
    'sips',
    ['-s', 'format', 'jpeg', '-Z', '2048', '-s', 'formatOptions', '82', absPath, '--out', out],
    { timeout: 30_000, stdio: 'ignore' },
  );
  if (r.status !== 0) return null;
  try {
    return statSync(out).size > 0 ? out : null;
  } catch {
    return null;
  }
}

/**
 * 交给模型前的加工：HEIC 转 JPEG、文档抽正文、其它二进制拦下，纯文本原样。
 *
 * 三条硬规则（都是踩过的坑）：
 *  1. **能转就转**：pi 只按文件头认 JPEG/PNG/GIF/WEBP/BMP，HEIC 不转就会被当文本硬读；
 *  2. **不能转就拦**：返回 `path: null` + `note`，宁可少一份附件也不炸整轮上下文；
 *  3. **文档抽正文失败仍原样交**：那是 PDF 抽不出字（扫描版），给模型至少还能看到文件名。
 */
export async function prepareFileForModel(absPath: string, name: string): Promise<PreparedAttachment> {
  const ext = extname(name).toLowerCase();

  if (HEIF_EXT.has(ext)) {
    const jpeg = transcodeHeifToJpeg(absPath);
    if (jpeg) return { path: jpeg };
    return {
      path: null,
      note: `「${name}」是 HEIC/HEIF，pi 读不了，本机也转不成 JPEG（需要 macOS 的 sips）；请改发 JPG 或 PNG`,
    };
  }

  if (isDocumentFile(name)) {
    const ex = await extractDocumentText(absPath, name);
    if (ex.ok && ex.text) {
      const txtPath = `${absPath}.txt`;
      writeFileSync(txtPath, `【${name}】\n\n${ex.text}`, 'utf-8');
      return { path: txtPath };
    }
    return {
      path: absPath,
      note:
        `「${name}」正文提取失败（${ex.reason ?? '未知原因'}），模型可能读不到内容；` +
        '若是扫描版 PDF，请把关键页面截图发我',
    };
  }

  // 走到这里还含 NUL 字节：pi 没有"二进制"概念，会整份当文本读进上下文（见文件头事故记录）
  if (isBinaryFile(absPath)) {
    const why = IMAGE_EXT.has(ext)
      ? `图片格式 ${ext} 不在 pi 可读范围内（只认 jpg/png/gif/webp/bmp）`
      : '是二进制文件，pi 读不了';
    return { path: null, note: `「${name}」${why}，已拦下没进上下文；要看内容请转成文本/图片/PDF` };
  }

  return { path: absPath };
}

/** 写入 web 上传的原始字节。返回落盘后的绝对路径。 */
export function writeWebInbox(fileName: string, data: Buffer): string {
  mkdirSync(WEB_INBOX_DIR, { recursive: true });
  const dest = join(WEB_INBOX_DIR, sanitizeFileName(fileName));
  writeFileSync(dest, data);
  return dest;
}

/** 只允许删 web-inbox 内的文件，避免被路径穿越利用。 */
export function removeWebInboxFile(path: string): void {
  const root = resolve(WEB_INBOX_DIR);
  const full = resolve(path);
  if (!full.startsWith(root + '/')) return;
  try {
    rmSync(full, { force: true });
  } catch {
    /* 删不掉不影响任务结果 */
  }
}

/** 清理过期残留（上传后没发送、任务被强杀）。返回删除数量。 */
export function cleanupWebInbox(maxAgeMs = INBOX_TTL_MS): number {
  if (!existsSync(WEB_INBOX_DIR)) return 0;
  const now = Date.now();
  let removed = 0;
  for (const name of readdirSync(WEB_INBOX_DIR)) {
    const p = join(WEB_INBOX_DIR, name);
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
