/**
 * 附件路径层的单测。
 *
 * 这层只有三件事，但每件都不能错：
 *  1. **路径穿越**：附件 id 直接来自 HTTP 请求体，`../` 必须被挡死 ——
 *     否则一个 POST 就能让服务端把任意文件当附件塞给模型、或者删掉任意文件。
 *  2. **扩展名判定**：图片走视觉通道、文档走抽文本，判错了就白做整套加工。
 *  3. **能不能交给模型**：HEIC 先转 JPEG、二进制一律拦下 ——
 *     2026-11-07 两张 HEIC 被当文本内联成 4.6MB，单条消息 375 万 token 直接 400。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  attachmentKind,
  isBinaryFile,
  normalizeTalkAttachments,
  prepareFileForModel,
  sanitizeFileName,
  webInboxPath,
  WEB_INBOX_DIR,
} from '../src/core/attachments.ts';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.error(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
  }
}

console.log('attachmentKind');
check('png 是图片', attachmentKind('a.png') === 'image');
check('大写 JPG 也是图片', attachmentKind('A.JPG') === 'image');
check('heic 是图片', attachmentKind('a.heic') === 'image');
check('pdf 是文档', attachmentKind('a.pdf') === 'document');
check('docx 是文档', attachmentKind('a.docx') === 'document');
check('zip 是 other', attachmentKind('a.zip') === 'other');
check('无扩展名是 other', attachmentKind('README') === 'other');

console.log('\nsanitizeFileName');
check('保留扩展名', sanitizeFileName('report.pdf').endsWith('.pdf'), sanitizeFileName('report.pdf'));
check(
  '路径分隔符被去掉',
  !sanitizeFileName('../../etc/passwd').includes('/'),
  sanitizeFileName('../../etc/passwd'),
);
check('反斜杠也被去掉', !sanitizeFileName('..\\..\\win.ini').includes('\\'));
check('中文被替换但扩展名保留', sanitizeFileName('报告.pdf').endsWith('.pdf'), sanitizeFileName('报告.pdf'));
check('空名有兜底', sanitizeFileName('') === 'file', sanitizeFileName(''));
check('超长名被截断', sanitizeFileName(`${'a'.repeat(200)}.png`).length <= 80);

console.log('\nwebInboxPath（路径穿越）');
check('普通文件名落在 inbox 内', (webInboxPath('a.png') ?? '').startsWith(WEB_INBOX_DIR));
check('`..` 被拒绝', webInboxPath('..') === null, String(webInboxPath('..')));
check('`../..` 被拒绝', webInboxPath('../..') === null, String(webInboxPath('../..')));
check('绝对路径被收敛到 inbox 内', (webInboxPath('/etc/passwd') ?? '').startsWith(WEB_INBOX_DIR));
check('空 id 返回 null', webInboxPath('') === null);
const deep = webInboxPath('../../../../tmp/evil.sh');
check(
  '深层穿越仍落在 inbox 内',
  deep !== null && deep.startsWith(WEB_INBOX_DIR) && !deep.includes('/tmp/evil'),
  String(deep),
);

console.log('\nnormalizeTalkAttachments（/api/talk 入参）');
{
  const legacy = normalizeTalkAttachments(['a.png', 'b.pdf']);
  check('旧客户端 string[] 仍可用', legacy.length === 2 && legacy[0]!.id === 'a.png');
  check('string[] 不带 name', legacy[0]!.name === undefined);

  const modern = normalizeTalkAttachments([{ id: 'x1', name: '验收截图.png' }]);
  check('新客户端保留原始文件名', modern[0]?.name === '验收截图.png', JSON.stringify(modern));

  check('空 id 被丢弃', normalizeTalkAttachments([{ id: '   ', name: 'a.png' }]).length === 0);
  check('非数组返回空', normalizeTalkAttachments(undefined).length === 0);
  check('null 元素不抛错', normalizeTalkAttachments([null]).length === 0);

  const blankName = normalizeTalkAttachments([{ id: 'x2', name: '   ' }]);
  check('纯空白 name 视为缺失', blankName[0]?.name === undefined, JSON.stringify(blankName));

  const many = normalizeTalkAttachments(Array.from({ length: 10 }, (_, i) => `f${i}.png`));
  check('超过上限被截断到 6', many.length === 6, String(many.length));
}

console.log('\nprepareFileForModel（交给模型前的格式判定）');
{
  const dir = mkdtempSync(join(tmpdir(), 'waker-attach-'));
  const bin = join(dir, 'a.zip');
  // 头是 PK 标记、后面是 NUL 填充：真实 zip 就是这样被 pi 当 utf-8 读进来的
  writeFileSync(bin, Buffer.concat([Buffer.from('PK'), Buffer.alloc(64)]));
  const code = join(dir, 'a.py');
  writeFileSync(code, 'print("hi")\n');
  const brokenHeic = join(dir, 'bad.heic');
  writeFileSync(brokenHeic, Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic'), Buffer.alloc(64)]));

  check('含 NUL 的文件被判为二进制', isBinaryFile(bin));
  check('纯文本不被判为二进制', !isBinaryFile(code));

  const okText = await prepareFileForModel(code, 'a.py');
  check('代码/文本附件原样放行', okText.path === code && !okText.note, JSON.stringify(okText));

  const rejected = await prepareFileForModel(bin, 'a.zip');
  check('二进制附件被拦下（不给路径）', rejected.path === null, JSON.stringify(rejected));
  check('拦下时说明原因', Boolean(rejected.note?.includes('已拦下')), String(rejected.note));

  const heic = await prepareFileForModel(brokenHeic, 'bad.heic');
  check('HEIC 转码失败时绝不退回原文件', heic.path === null, JSON.stringify(heic));
  check('HEIC 失败说明指向格式问题', Boolean(heic.note?.includes('HEIC')), String(heic.note));

  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
