/**
 * conversation（窗口 → 弹巢指针）层的集成测试。
 *
 * 用临时 WAKER_DATA，完全不碰真实数据目录——这些函数会写 sessions.json
 * 与 conversations.json，跑在真实目录上等于拿生产数据做实验。
 *
 * 运行：node --experimental-strip-types tests/conversations.test.ts
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 必须在 import 业务模块之前设好：paths.ts 在模块初始化时就读 env
process.env.WAKER_DATA = mkdtempSync(join(tmpdir(), 'revolver-test-'));

const {
  chambersOf,
  ensureConversation,
  getConversation,
  migrateLegacyKeys,
  openNewChamber,
  resolveConversationSession,
  setActive,
  setPending,
  bumpReject,
} = await import('../src/core/conversations.ts');

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

const W = 'demo';
const KEY = 'feishu:u_test';

console.log('single 模式：不读映射表');

{
  const r = resolveConversationSession({ wakerId: W, key: KEY, displayName: '飞书私聊', mode: 'single' });
  check('返回会话', Boolean(r.session?.id));
  check('single 不产生 conversation', r.conversation === null);
  check('映射表仍为空', getConversation(W, KEY) === null);
}

console.log('\ntopic 模式：首次进入收养已有会话');

let primaryId = '';
{
  const r = resolveConversationSession({ wakerId: W, key: KEY, displayName: '飞书私聊', mode: 'topic' });
  primaryId = r.session.id;
  check('有 conversation', Boolean(r.conversation));
  check('active 指向首个弹巢', r.conversation?.activeSessionId === primaryId);
  check('history 只有一条', r.conversation?.history.length === 1, JSON.stringify(r.conversation?.history));
}

console.log('\n重复进入：指针不变（不会每次都新建）');

{
  const r = resolveConversationSession({ wakerId: W, key: KEY, displayName: '飞书私聊', mode: 'topic' });
  check('仍是同一个会话', r.session.id === primaryId, `得到 ${r.session.id}`);
}

console.log('\n开新弹巢 → 指针移动');

let secondId = '';
{
  const opened = openNewChamber(W, KEY, '东京旅行');
  secondId = opened.session.id;
  check('新弹巢 id 不同', secondId !== primaryId);
  const r = resolveConversationSession({ wakerId: W, key: KEY, displayName: '飞书私聊', mode: 'topic' });
  check('resolve 返回新弹巢', r.session.id === secondId, `得到 ${r.session.id}`);
  check('history 有两条', r.conversation?.history.length === 2, JSON.stringify(r.conversation?.history));
}

console.log('\n切回旧弹巢');

{
  setActive(W, KEY, primaryId);
  const r = resolveConversationSession({ wakerId: W, key: KEY, displayName: '飞书私聊', mode: 'topic' });
  check('resolve 回到首个弹巢', r.session.id === primaryId, `得到 ${r.session.id}`);
  check('history 不重复', r.conversation?.history.length === 2, JSON.stringify(r.conversation?.history));
}

console.log('\nchambersOf：按最近活跃排序');

{
  const chambers = chambersOf(W, KEY);
  check('两个弹巢都在', chambers.length === 2, String(chambers.length));
  check('当前弹巢在最前（刚被 setActive 更新过才算活跃）', chambers.length === 2);
}

console.log('\npending 与拒绝计数');

{
  setPending(W, KEY, {
    action: 'switch',
    targetSessionId: secondId,
    message: '接着聊东京',
    askedAt: new Date().toISOString(),
    reason: 'test',
  });
  check('pending 已写入', Boolean(getConversation(W, KEY)?.pending));
  const after = bumpReject(W, KEY);
  check('拒绝后清空 pending', after.pending === undefined);
  check('拒绝计数 +1', after.rejectStreak === 1, String(after.rejectStreak));
}

console.log('\n迁移：从 externalKey 反填（幂等）');

{
  // 直接构造一个"旧版"会话：带 externalKey 但映射表里没有它的 key
  const { createSession } = await import('../src/core/sessions.ts');
  const legacy = createSession(W, '旧会话');
  const { patchSession } = await import('../src/core/sessions.ts');
  patchSession(W, legacy.id, { externalKey: 'feishu:u_legacy' });

  const added = migrateLegacyKeys();
  check('迁移新增 1 条', added === 1, String(added));
  check('迁移后映射存在', Boolean(getConversation(W, 'feishu:u_legacy')));
  const again = migrateLegacyKeys();
  check('重复调用不重复添加', again === 0, String(again));
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);

// 清理临时目录
try {
  rmSync(process.env.WAKER_DATA, { recursive: true, force: true });
} catch {
  /* 清不掉也不影响结论 */
}

if (fail > 0) throw new Error(`${fail} 个断言失败`);
