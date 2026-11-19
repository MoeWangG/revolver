/**
 * 会话历史里的图片还原。
 *
 * 背景（真实投诉）：在网页对话窗里发图，聊天记录里看不到图，只剩一行
 * `【附件：m3k2j1-a1b2c3d4-____.png】`。原因是 `readSessionMessages` 只读 `text`
 * 内容块，`{type:"image"}` 被整块丢掉——而图片的 base64 **本来就完整存在** pi 会话文件里。
 *
 * 这层单测盯三件事：
 *  1. image 块要变成 `images` 元数据（行号 + 序号），且**不带** base64；
 *  2. 只有图没有文字的消息不能被"空正文"过滤掉；
 *  3. `readSessionImage` 能按 `line + index` 取回原始字节，越界/非图片行返回 null。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

// paths.ts 在**模块加载时**读这些环境变量，所以必须先设 env 再动态 import
const root = mkdtempSync(join(tmpdir(), 'waker-hist-'));
const piHome = join(root, 'pi');
const dataDir = join(root, 'data');
const sessionsDir = join(piHome, 'agent', 'sessions', '--tmp--');
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(dataDir, { recursive: true });

process.env.PI_HOME = piHome;
process.env.WAKER_DATA = dataDir;

const WAKER = 'testimg';
const PI_SESSION = `waker-${WAKER}`;
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

// 会话表：只有默认会话，pi 会话 id 固定成 waker-testimg
writeFileSync(
  join(dataDir, 'sessions.json'),
  JSON.stringify({
    [WAKER]: [
      {
        id: 'default',
        wakerId: WAKER,
        name: '默认会话',
        piSessionId: PI_SESSION,
        createdAt: '2026-11-01T00:00:00.000Z',
        lastActiveAt: '2026-11-01T00:00:00.000Z',
        messageCount: 2,
      },
    ],
  }),
  'utf-8',
);

const sessionFile = join(sessionsDir, `2026-11-01T03-59-35-531Z_${PI_SESSION}.jsonl`);
const lines: string[] = [
  // 0: 带图 + 文字（真实形态：pi 把 mimeType/data 放在块顶层）
  JSON.stringify({
    type: 'message',
    timestamp: '2026-11-01T03:59:40.000Z',
    message: {
      role: 'user',
      content: [
        { type: 'text', text: '帮我看看这个。\n\n【附件：截图.png】' },
        { type: 'image', mimeType: 'image/png', data: PNG_BYTES.toString('base64') },
      ],
    },
  }),
  // 1: 一条 assistant 文本，用来隔开行号
  JSON.stringify({
    type: 'message',
    timestamp: '2026-11-01T03:59:45.000Z',
    message: { role: 'assistant', content: [{ type: 'text', text: '看到了，是一张 1×1 的图。' }] },
  }),
  // 2: 只有图片、没有文字：不能因为"没有正文"被丢掉
  JSON.stringify({
    type: 'message',
    timestamp: '2026-11-01T04:00:00.000Z',
    message: { role: 'user', content: [{ type: 'image', data: PNG_BYTES.toString('base64') }] },
  }),
];
writeFileSync(sessionFile, `${lines.join('\n')}\n`, 'utf-8');

const { readSessionImage, readSessionMessages } = await import('../src/core/sessionHistory.ts');

const msgs = readSessionMessages(WAKER, 'default');

console.log('readSessionMessages：图片元数据');
check('用户消息被读出来（2 条）', msgs.filter((m) => m.role === 'user').length === 2, `实际 ${msgs.length}`);
check('第一条用户消息带 1 张图', msgs[0]?.images?.length === 1, JSON.stringify(msgs[0]?.images));
check('图片行号正确', msgs[0]?.images?.[0]?.line === 0, String(msgs[0]?.images?.[0]?.line));
check('图片序号从 0 开始', msgs[0]?.images?.[0]?.index === 0);
check('mimeType 原样保留', msgs[0]?.images?.[0]?.mimeType === 'image/png');
check(
  '元数据里不带 base64（否则历史响应会被撑爆）',
  !JSON.stringify(msgs).includes(PNG_BYTES.toString('base64').slice(0, 40)),
);

console.log('\nreadSessionMessages：纯图片消息');
const imgOnly = msgs.filter((m) => m.role === 'user')[1];
check('纯图片消息没有被丢掉', !!imgOnly, JSON.stringify(msgs.map((m) => m.role)));
check('纯图片消息 text 为空', imgOnly?.text === '', JSON.stringify(imgOnly?.text));
check('纯图片消息仍有 images', imgOnly?.images?.length === 1);
check('纯图片消息行号指向第 3 行', imgOnly?.images?.[0]?.line === 2, String(imgOnly?.images?.[0]?.line));
check('缺 mimeType 时回落 image/png', imgOnly?.images?.[0]?.mimeType === 'image/png');

console.log('\nreadSessionImage：按行号取二进制');
const got = readSessionImage(WAKER, 'default', 0, 0);
check('取到图片', !!got);
check('字节与原始一致', got?.data.equals(PNG_BYTES) === true, `len=${got?.data.length}`);
check('mimeType 正确', got?.mimeType === 'image/png');
check('索引越界返回 null', readSessionImage(WAKER, 'default', 0, 5) === null);
check('行号越界返回 null', readSessionImage(WAKER, 'default', 99, 0) === null);
check('负数行号返回 null', readSessionImage(WAKER, 'default', -1, 0) === null);
check('小数行号返回 null', readSessionImage(WAKER, 'default', 1.5, 0) === null);
check('非图片行（assistant 文本）返回 null', readSessionImage(WAKER, 'default', 1, 0) === null);
check('不传 sessionId 时落到默认会话', !!readSessionImage(WAKER, undefined, 0, 0));

rmSync(root, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
