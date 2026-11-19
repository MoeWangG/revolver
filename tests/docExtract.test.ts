/**
 * 文档正文提取的纯函数单测。
 *
 * 背景（2026-11-01）：pi 对二进制 `@附件` 是当文本硬内联的，PDF 直接交给模型时，
 * 它读到的是 `/Producer`、`/Widths` 这类结构，正文一个字都没有。所以文档必须先抽正文。
 * 这里钉死三件事：
 *  1. 扩展名分派（哪些算"需要抽文本的文档"，图片/压缩包不算）
 *  2. XML → 文本的还原质量（段落、制表、换行不能被吞掉）
 *  3. 实体解码顺序（先解 `amp` 会把 `amp+lt;` 变成真标签，必须最后解）
 *
 * 注意：测试里的实体串一律用 `amp` 拼接，不写完整字面量 —— 源码里出现完整实体
 * 字面量会被上层编辑器/工具二次反转义，把测试数据改坏。
 */
import { decodeEntities, isDocumentFile, textNodes, tidy, xmlToText } from '../src/channels/docExtract.ts';

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

const amp = String.fromCharCode(38);

console.log('isDocumentFile');
check('pdf 算文档', isDocumentFile('报告.pdf'));
check('docx 算文档', isDocumentFile('a.docx'));
check('pptx 算文档', isDocumentFile('a.pptx'));
check('xlsx 算文档', isDocumentFile('a.xlsx'));
check('老 doc 算文档', isDocumentFile('a.doc'));
check('rtf 算文档', isDocumentFile('a.rtf'));
check('大写扩展名也认', isDocumentFile('A.PDF'));
check('png 不算文档（图片走视觉通道）', !isDocumentFile('a.png'));
check('txt 不算文档（pi 已能直接内联）', !isDocumentFile('a.txt'));
check('zip 不算文档', !isDocumentFile('a.zip'));

console.log('\ndecodeEntities');
check('命名实体还原', decodeEntities(`${amp}lt;div${amp}gt;`) === '<div>', decodeEntities(`${amp}lt;div${amp}gt;`));
check('引号实体还原', decodeEntities(`${amp}quot;x${amp}quot;`) === '"x"');
check('数字实体还原', decodeEntities('&#65;&#66;') === 'AB', decodeEntities('&#65;&#66;'));
check('十六进制实体还原', decodeEntities('&#x41;&#x42;') === 'AB', decodeEntities('&#x41;&#x42;'));
check(
  'amp 最后解，不会被二次解码成标签',
  decodeEntities(`${amp}amp;lt;`) === `${amp}lt;`,
  decodeEntities(`${amp}amp;lt;`),
);

console.log('\ntidy');
check('CRLF 归一', tidy('a\r\nb') === 'a\nb', JSON.stringify(tidy('a\r\nb')));
check('行尾空白去掉', tidy('a   \nb') === 'a\nb', JSON.stringify(tidy('a   \nb')));
check('连续空行压成一行', tidy('a\n\n\n\nb') === 'a\n\nb', JSON.stringify(tidy('a\n\n\n\nb')));
check(
  '首尾空行去掉，但行首缩进保留',
  tidy('\n\n  a  \n\n') === '  a',
  JSON.stringify(tidy('\n\n  a  \n\n')),
);
check('全空白输入返回空串', tidy(' \n\t\n ') === '');

console.log('\nxmlToText（WordprocessingML）');
const wordXml =
  '<w:document><w:body>' +
  '<w:p><w:r><w:t>第一段</w:t></w:r></w:p>' +
  '<w:p><w:r><w:t>第二段</w:t></w:r></w:p>' +
  '</w:body></w:document>';
check('段落之间换行', xmlToText(wordXml) === '第一段\n第二段', JSON.stringify(xmlToText(wordXml)));
check(
  'w:tab 变制表符',
  xmlToText('<w:p><w:r><w:tab/><w:t>缩进</w:t></w:r></w:p>') === '\t缩进',
  JSON.stringify(xmlToText('<w:p><w:r><w:tab/><w:t>缩进</w:t></w:r></w:p>')),
);
check(
  'w:br 变换行',
  xmlToText('<w:p><w:r><w:t>上</w:t><w:br/><w:t>下</w:t></w:r></w:p>') === '上\n下',
  JSON.stringify(xmlToText('<w:p><w:r><w:t>上</w:t><w:br/><w:t>下</w:t></w:r></w:p>')),
);
check('标签全部剥掉', !/[<>]/.test(xmlToText(wordXml)), xmlToText(wordXml));
check(
  '文本里的实体还原成字符',
  xmlToText(`<w:p><w:r><w:t>a${amp}lt;b</w:t></w:r></w:p>`) === 'a<b',
  xmlToText(`<w:p><w:r><w:t>a${amp}lt;b</w:t></w:r></w:p>`),
);
check('空文档返回空串', xmlToText('<w:document><w:body></w:body></w:document>') === '');

console.log('\ntextNodes');
const slideXml = '<p:sld><a:t>标题</a:t><a:t>要点一</a:t></p:sld>';
check('默认用换行分隔', textNodes(slideXml, 'a:t') === '标题\n要点一', JSON.stringify(textNodes(slideXml, 'a:t')));
check('可指定分隔符', textNodes(slideXml, 'a:t', '\t') === '标题\t要点一');
check('空文本节点被跳过', textNodes('<a:t>甲</a:t><a:t>  </a:t><a:t>乙</a:t>', 'a:t') === '甲\n乙');
check('无匹配返回空串', textNodes('<x></x>', 'a:t') === '');

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
