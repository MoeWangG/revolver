/**
 * 更新记录解析的测试。
 *
 * 为什么值得单独测：这份解析结果直接显示在「本版变更」上，解析错了比没有这一页更糟——
 * 要么漏掉某条改动，要么把代码块里的示例条目当成真改动。只钉解析规则，不测渲染。
 */
import { parseChangelog } from '../src/core/architecture.ts';

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

console.log('parseChangelog：版本与日期');

const basic = parseChangelog(
  [
    '# 更新记录',
    '',
    '## [2.0.0] - 2026-10-25',
    '',
    '### 新增',
    '',
    '- 架构与版本页',
    '- 运行时接口',
    '',
    '## [1.0.0]',
    '',
    '- 首版',
    '',
  ].join('\n'),
);

check('两个版本都被识别', basic.length === 2, `实际 ${basic.length} 条`);
check('顺序与文件一致（新在前）', basic[0]?.version === '2.0.0' && basic[1]?.version === '1.0.0');
check('日期被解析', basic[0]?.date === '2026-10-25', `实际 ${basic[0]?.date}`);
check('没有日期时留空', basic[1]?.date === undefined, `实际 ${basic[1]?.date}`);
check('主标题不产生版本条目', !basic.some((r) => r.version.includes('更新记录')));

console.log('\nparseChangelog：分节与条目');

check('同一节的两条都收下', basic[0]?.items.length === 2, `实际 ${basic[0]?.items.length}`);
check('条目记下所属分节', basic[0]?.items[0]?.section === '新增', `实际 ${basic[0]?.items[0]?.section}`);
check('条目正文去掉项目符号', basic[0]?.items[0]?.text === '架构与版本页', `实际 ${basic[0]?.items[0]?.text}`);
check('没写分节的条目分节为空串', basic[1]?.items[0]?.section === '', `实际 ${basic[1]?.items[0]?.section}`);

const bullets = parseChangelog(['## [3.0.0]', '### 修复', '* 星号也算', '-   前后有空格   '].join('\n'));
check('星号项目符号也认', bullets[0]?.items[0]?.text === '星号也算');
check('条目正文 trim', bullets[0]?.items[1]?.text === '前后有空格', `实际 ${JSON.stringify(bullets[0]?.items[1]?.text)}`);

console.log('\nparseChangelog：不该被当成条目的内容');

const fenced = parseChangelog(
  [
    '## [2.0.0]',
    '',
    '```md',
    '## [9.9.9] - 2099-01-01',
    '- 这是格式示例，不是真条目',
    '```',
    '',
    '- 真条目',
  ].join('\n'),
);
check('代码块里的版本标题不产生版本', fenced.length === 1, `实际 ${fenced.length} 条`);
check('代码块里的项目符号不计入', fenced[0]?.items.length === 1, `实际 ${fenced[0]?.items.length}`);
check('代码块之后的条目照常解析', fenced[0]?.items[0]?.text === '真条目');

const linkDefs = parseChangelog(['## [2.0.0]', '- 一条', '', '[2.0.0]: https://example.com/compare'].join('\n'));
check('末尾的链接定义行被忽略', linkDefs[0]?.items.length === 1, `实际 ${linkDefs[0]?.items.length}`);

const empty = parseChangelog('');
check('空文件返回空数组', Array.isArray(empty) && empty.length === 0);

const orphan = parseChangelog(['- 没有版本标题的条目', '## [1.1.0]', '- 正常条目'].join('\n'));
check('版本标题之前的条目被丢弃', orphan[0]?.items.length === 1, `实际 ${orphan[0]?.items.length}`);

console.log(`\n${pass} 通过，${fail} 失败`);
if (fail) process.exitCode = 1;
