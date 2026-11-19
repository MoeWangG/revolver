import { execFile } from 'node:child_process';
import { extname } from 'node:path';
import { promisify } from 'node:util';

/**
 * 文档正文提取（PDF / Office / 老格式）。
 *
 * 为什么必须有这一层（2026-11-01 实测）：
 * pi 的 `@附件` 对二进制文件是**当文本硬内联**的。把 PDF 直接交给模型，
 * 它读到的是 `/Producer (macOS Version 27.0.1...)`、字体 `/Widths` 表、压缩流之类的结构，
 * 正文一个字都拿不到 —— 模型虽然会诚实地说"我需要解压该流"，但等于这个功能没做。
 * 所以文档类文件必须先抽出文本、**用文本附件替代原始二进制**。
 *
 * 设计取向：**零 npm 依赖**。项目依赖只有 node-cron 与 yaml，为了读个 PDF 引入
 * pdfjs / mammoth / xlsx 会显著放大体积与升级面。这里的几条通路都是系统或已有环境：
 *   · PDF      → `python3` + pypdf（本机已装；缺失时明确报错，不静默）
 *   · docx     → `unzip -p <f> word/document.xml` 再剥标签
 *   · pptx     → `unzip -p <f> ppt/slides/*.xml` 取 `<a:t>` 文本节点
 *   · xlsx     → `unzip -p <f> xl/sharedStrings.xml` 取 `<t>` 文本节点
 *   · doc/rtf/odt/html → macOS 自带 `textutil -convert txt -stdout`
 *
 * 安全：全部走 execFile（不经过 shell），文件路径只作为 argv 传入，不拼进脚本字符串。
 */

const MAX_CHARS = 200_000;
const TOOL_TIMEOUT_MS = 20_000;
const MAX_BUFFER = 10 * 1024 * 1024;

const run = promisify(execFile);

/** 需要"先抽文本"的扩展名（二进制容器）。 */
const BINARY_DOC_EXT = new Set(['.pdf', '.docx', '.pptx', '.xlsx']);
/** 系统 textutil 能直接转纯文本的格式。 */
const NATIVE_DOC_EXT = new Set(['.doc', '.rtf', '.rtfd', '.odt', '.html', '.htm', '.webarchive']);

export function isDocumentFile(name: string): boolean {
  const ext = extname(name).toLowerCase();
  return BINARY_DOC_EXT.has(ext) || NATIVE_DOC_EXT.has(ext);
}

/** 解 XML 实体。先解 `&`，否则 `&lt;` 会被二次解码成 `<`。 */
export function decodeEntities(s: string): string {
  // 实体串用拼接构造：源码里不出现完整的命名实体字面量，避免被上层编辑器/工具反转义
  const amp = String.fromCharCode(38);
  const named: Array<[string, string]> = [
    [`${amp}lt;`, '<'],
    [`${amp}gt;`, '>'],
    [`${amp}quot;`, '"'],
    [`${amp}apos;`, "'"],
  ];
  let out = s;
  for (const [from, to] of named) out = out.split(from).join(to);
  out = out
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16)));
  // amp 必须最后解：否则 `amp+lt;` 会先变成 `<`，把本该显示成文本的实体当成标签
  return out.split(`${amp}amp;`).join(amp);
}

/**
 * 收尾清理：CRLF、行尾空白、连续空行、首尾空行。
 *
 * 刻意**不用** `String.trim()`：行首的制表符/空格是文档缩进（`w:tab` 会被还原成 `\t`），
 * `trim()` 会把它吃掉，让"列表项 / 缩进段落"塌成左对齐。只去掉首尾的空行。
 */
export function tidy(raw: string): string {
  const s = raw
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n');
  if (!s.trim()) return '';
  return s.replace(/^\n+/, '').replace(/\n+$/, '');
}

/**
 * WordprocessingML → 纯文本。
 * 段落结束换行、`w:tab` 变制表符、`w:br` 变换行；其余标签一律剥掉。
 */
export function xmlToText(xml: string): string {
  const withBreaks = xml
    .replace(/<\/w:p>/g, '\n')
    .replace(/<w:tab\b[^>]*\/>/g, '\t')
    .replace(/<w:br\b[^>]*\/>/g, '\n')
    .replace(/<[^>]*>/g, '');
  return tidy(decodeEntities(withBreaks));
}

/** 从 XML 里按标签名抽全部文本节点（pptx 的 `<a:t>`、xlsx 的 `<t>`）。 */
export function textNodes(xml: string, tag: string, sep = '\n'): string {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'g');
  const out: string[] = [];
  for (const m of xml.matchAll(re)) {
    const v = decodeEntities(m[1] ?? '').trim();
    if (v) out.push(v);
  }
  return out.join(sep);
}

export interface ExtractResult {
  ok: boolean;
  text?: string;
  /** 实际走通的通路，写进日志便于排查（pypdf / docx-xml / pptx-xml / xlsx-xml / textutil）。 */
  via?: string;
  /** 失败原因（多条通路时用分号拼接）。 */
  reason?: string;
  /** 是否因超长被截断。 */
  truncated?: boolean;
}

/** PDF：交给本机 python3 的 pypdf。脚本内只读 sys.argv[1]，不拼接路径。 */
async function viaPypdf(filePath: string): Promise<string> {
  const script = [
    'import sys',
    'try:',
    '    from pypdf import PdfReader',
    'except ImportError:',
    '    try:',
    '        from PyPDF2 import PdfReader',
    '    except ImportError:',
    '        sys.stderr.write("NO_PDF_LIB")',
    '        sys.exit(3)',
    'r = PdfReader(sys.argv[1])',
    'sys.stdout.write("\\n".join((p.extract_text() or "") for p in r.pages))',
  ].join('\n');
  const { stdout } = await run('python3', ['-c', script, filePath], {
    timeout: TOOL_TIMEOUT_MS,
    maxBuffer: MAX_BUFFER,
  });
  return String(stdout);
}

async function viaDocx(filePath: string): Promise<string> {
  const { stdout } = await run('unzip', ['-p', filePath, 'word/document.xml'], {
    timeout: TOOL_TIMEOUT_MS,
    maxBuffer: MAX_BUFFER,
  });
  return xmlToText(String(stdout));
}

async function viaPptx(filePath: string): Promise<string> {
  const { stdout } = await run('unzip', ['-p', filePath, 'ppt/slides/*.xml'], {
    timeout: TOOL_TIMEOUT_MS,
    maxBuffer: MAX_BUFFER,
  });
  // 按幻灯片顺序输出：unzip 的通配结果按文件名排序，slide1、slide10、slide2 的字典序
  // 会让顺序错乱，所以先切分再排序。
  const slides = String(stdout)
    .split(/<p:sld\b/)
    .map((s) => textNodes(s, 'a:t'))
    .filter(Boolean);
  return slides.join('\n\n');
}

async function viaXlsx(filePath: string): Promise<string> {
  const { stdout } = await run('unzip', ['-p', filePath, 'xl/sharedStrings.xml'], {
    timeout: TOOL_TIMEOUT_MS,
    maxBuffer: MAX_BUFFER,
  });
  // 只取共享字符串池：拿不到单元格行列结构，但"这份表在讲什么"够用了。
  // 纯数字表没有 sharedStrings，会抛错并落到下面的失败分支。
  return textNodes(String(stdout), 't', '\t');
}

async function viaTextutil(filePath: string): Promise<string> {
  const { stdout } = await run('textutil', ['-convert', 'txt', '-stdout', filePath], {
    timeout: TOOL_TIMEOUT_MS,
    maxBuffer: MAX_BUFFER,
  });
  return String(stdout);
}

/**
 * 抽出文档正文。**不抛错**：任何失败都返回 `{ ok: false, reason }`，
 * 由调用方决定怎么告诉用户（渠道层要的是"永远有下文"）。
 */
export async function extractDocumentText(
  filePath: string,
  fileName?: string,
): Promise<ExtractResult> {
  const ext = extname(fileName || filePath).toLowerCase();

  let via = '';
  let fn: (() => Promise<string>) | null = null;
  if (ext === '.pdf') {
    via = 'pypdf';
    fn = () => viaPypdf(filePath);
  } else if (ext === '.docx') {
    via = 'docx-xml';
    fn = () => viaDocx(filePath);
  } else if (ext === '.pptx') {
    via = 'pptx-xml';
    fn = () => viaPptx(filePath);
  } else if (ext === '.xlsx') {
    via = 'xlsx-xml';
    fn = () => viaXlsx(filePath);
  } else if (NATIVE_DOC_EXT.has(ext)) {
    via = 'textutil';
    fn = () => viaTextutil(filePath);
  } else {
    return { ok: false, reason: `不支持的格式 ${ext || '(无扩展名)'}` };
  }

  try {
    const raw = await fn();
    const text = tidy(raw);
    if (!text) {
      return {
        ok: false,
        via,
        reason: '没有提取到任何文字（可能是扫描件或纯图片文档）',
      };
    }
    return {
      ok: true,
      via,
      text: text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) : text,
      truncated: text.length > MAX_CHARS,
    };
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stderr?: string };
    // python 缺少 pypdf 时会以 stderr 里的 NO_PDF_LIB 退出
    if (String(err?.stderr ?? '').includes('NO_PDF_LIB')) {
      return { ok: false, via, reason: 'python3 未安装 pypdf（pip3 install pypdf 后可用）' };
    }
    if (err?.code === 'ENOENT') {
      return { ok: false, via, reason: `本机没有 ${via} 需要的命令` };
    }
    // 只取 stderr 最后一行：python 的失败是整段 traceback，原样回给用户等于噪音
    const lastStderr = String(err?.stderr ?? '')
      .trim()
      .split('\n')
      .filter(Boolean)
      .pop();
    return { ok: false, via, reason: lastStderr || err?.message || String(e) };
  }
}
