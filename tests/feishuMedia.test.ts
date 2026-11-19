/**
 * 飞书消息归一化的单测。
 *
 * 为什么必须钉死这一层：2026-10-31 用户报障「发图片聊天没反应」，根因就是
 * `onMessage` 里一句 `if (message_type !== 'text') return` 把所有非文本消息静默丢弃。
 * 真实环境里复现这问题要去飞书发各种类型的消息，而**每一种类型都可能悄悄退回静默**，
 * 所以在纯函数层把「每类消息产出什么」全部固定下来：
 *  · 能进模型的：text / image / post / file
 *  · 转成文本的：share_chat / share_user / location
 *  · 必须给出可读提示的：audio / media / sticker / merge_forward / interactive / 未知类型
 *  · 唯一允许静默的：system（但要留日志标记）
 */
import { parseFeishuMessage, stripMentions, extractText } from '../src/channels/feishuMedia.ts';

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

const msg = (message_type: string, content: unknown) => ({
  message_id: 'om_test',
  message_type,
  content: typeof content === 'string' ? content : JSON.stringify(content),
});

console.log('stripMentions / extractText');
check('去掉 @_user_N 占位符', stripMentions('@_user_1 你好') === '你好', stripMentions('@_user_1 你好'));
check('去掉 @_all', stripMentions('@_all 开会') === '开会', stripMentions('@_all 开会'));
check('非法 JSON 返回空串', extractText('{not json') === '');
check('非字符串返回空串', extractText(undefined) === '');

console.log('\ntext');
const t = parseFeishuMessage(msg('text', { text: '@_user_1 帮我看下' }));
check('文本进入 text 字段', t.text === '帮我看下', t.text);
check('文本不带附件', t.imageKeys.length === 0 && t.files.length === 0);
check('文本没有 note', !t.note);

console.log('\nimage');
const img = parseFeishuMessage(msg('image', { image_key: 'img_v3_abc' }));
check('取出 image_key', img.imageKeys[0] === 'img_v3_abc', String(img.imageKeys[0]));
check('图片消息 text 为空（由上层补默认话术）', img.text === '');
check('图片消息没有 note', !img.note);
const imgBad = parseFeishuMessage(msg('image', { foo: 1 }));
check('缺 image_key 时给可读提示而不是静默', !!imgBad.note && imgBad.imageKeys.length === 0, imgBad.note);

console.log('\npost（富文本）');
const postFlat = parseFeishuMessage(
  msg('post', {
    title: '标题',
    content: [
      [{ tag: 'text', text: '第一段 ' }, { tag: 'text', text: '接上' }],
      [{ tag: 'img', image_key: 'img_v3_post' }],
    ],
  }),
);
check('同一行相邻 text 直接拼接', postFlat.text.includes('第一段 接上'), postFlat.text);
check('标题保留在首行', postFlat.text.startsWith('标题'), postFlat.text);
check('抽出 img 节点的 image_key', postFlat.imageKeys[0] === 'img_v3_post', String(postFlat.imageKeys[0]));

const postWrapped = parseFeishuMessage(
  msg('post', { zh_cn: { title: '', content: [[{ tag: 'text', text: '包裹结构' }]] } }),
);
check('兼容 zh_cn 包裹结构', postWrapped.text === '包裹结构', postWrapped.text);

const postEmpty = parseFeishuMessage(msg('post', { title: '', content: [] }));
check('空 post 给提示而不是当空消息丢掉', !!postEmpty.note, postEmpty.note);

console.log('\nfile');
const f = parseFeishuMessage(msg('file', { file_key: 'file_v2_x', file_name: '报告.pdf' }));
check('取出 file_key', f.files[0]?.key === 'file_v2_x', String(f.files[0]?.key));
check('保留原始文件名', f.files[0]?.name === '报告.pdf', String(f.files[0]?.name));
const fBad = parseFeishuMessage(msg('file', {}));
check('缺 file_key 时给可读提示', !!fBad.note, fBad.note);

console.log('\n转成文本的类型');
const chat = parseFeishuMessage(msg('share_chat', { chat_id: 'oc_1' }));
check('share_chat 带 chat_id', chat.text.includes('oc_1') && chat.text.includes('群聊'), chat.text);
const user = parseFeishuMessage(msg('share_user', { user_id: 'ou_1' }));
check('share_user 带 user_id', user.text.includes('ou_1') && user.text.includes('联系人'), user.text);
const loc = parseFeishuMessage(msg('location', { name: '公司', latitude: '1.2', longitude: '3.4' }));
check(
  'location 拼出名称与坐标',
  loc.text.includes('公司') && loc.text.includes('1.2') && loc.text.includes('3.4'),
  loc.text,
);

console.log('\n必须明确提示的类型');
for (const type of ['audio', 'media', 'sticker', 'merge_forward', 'interactive', 'unknown_type']) {
  const p = parseFeishuMessage(msg(type, {}));
  check(
    `${type} 有可读 note 且不会被静默丢弃`,
    !!p.note && !p.ignore && p.imageKeys.length === 0 && p.files.length === 0,
    String(p.note),
  );
}
check(
  '语音提示里说清"打出来发我"',
  (parseFeishuMessage(msg('audio', {})).note ?? '').includes('打出来'),
  parseFeishuMessage(msg('audio', {})).note,
);

console.log('\nsystem');
const sys = parseFeishuMessage(msg('system', { text: '某人加入了群聊' }));
check('system 标记为 ignore', sys.ignore === true);
check('system 不产生用户可见提示', !sys.note && !sys.text);

console.log('\ncontent 非法');
const broken = parseFeishuMessage(msg('text', '{bad json'));
check('非法 JSON 的 text 退化为空且不抛错', broken.text === '');
const brokenImg = parseFeishuMessage(msg('image', '{bad json'));
check('非法 JSON 的图片消息给出提示', !!brokenImg.note, brokenImg.note);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
