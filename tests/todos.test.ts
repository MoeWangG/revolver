/**
 * 待办的纯函数与存取测试。
 *
 * 钉住四件最容易坏的事：
 *  1. 到期 / 过期的判定边界（提前 24h 算"到期"，超过 dueAt 才是"过期"）；
 *  2. 顺延的基准时刻（过期任务不能把过期时间再往后挪一天）；
 *  3. externalKey 解析（群聊多话题的 `:u_` 后缀不能当成发送目标）；
 *  4. JSONL 读写的状态迁移（结束 / 关闭 / 顺延不改错对象）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// paths.ts 在 import 时读 env，必须**先**设置再用动态 import 加载
const DATA = mkdtempSync(join(tmpdir(), 'waker-todos-'));
process.env.WAKER_DATA = DATA;

const { DUE_LEAD_MS, createTodo, dismissTodo, finishTodo, listTodos, nextSnoozeAt, snoozeTodo, todoPhase, getTodo } =
  await import('../src/core/todos.ts');
const { parseExternalKey } = await import('../src/channels/types.ts');

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

const HOUR = 3600 * 1000;
const NOW = new Date('2026-11-03T02:00:00.000Z');
const iso = (ms: number): string => new Date(NOW.getTime() + ms).toISOString();

console.log('todoPhase：到期窗口与过期');

check('两天后 → 未到期', todoPhase({ status: 'pending', dueAt: iso(48 * HOUR) }, NOW) === 'pending');
check('12 小时后 → 到期（提前 24h 窗口）', todoPhase({ status: 'pending', dueAt: iso(12 * HOUR) }, NOW) === 'due');
check('恰好在到期窗口起点 → 到期', todoPhase({ status: 'pending', dueAt: iso(DUE_LEAD_MS) }, NOW) === 'due');
check('刚过截止 1 秒 → 过期', todoPhase({ status: 'pending', dueAt: iso(-1000) }, NOW) === 'overdue');
check('已完成的任务不因时间变红', todoPhase({ status: 'done', dueAt: iso(-1000) }, NOW) === 'done');
check('已关闭的任务不再提醒', todoPhase({ status: 'dismissed', dueAt: iso(-1000) }, NOW) === 'dismissed');
check('坏时间不闪（当作未到期）', todoPhase({ status: 'pending', dueAt: '不是时间' }, NOW) === 'pending');

console.log('nextSnoozeAt：顺延的基准');

const future = iso(48 * HOUR);
check(
  '未到期时从原截止往后推',
  nextSnoozeAt(future, NOW.getTime(), 24 * HOUR) === new Date(Date.parse(future) + 24 * HOUR).toISOString(),
);
const past = iso(-48 * HOUR);
check(
  '已过期时从"现在"往后推，而不是把过期时间再往后挪',
  nextSnoozeAt(past, NOW.getTime(), 24 * HOUR) === new Date(NOW.getTime() + 24 * HOUR).toISOString(),
);

console.log('parseExternalKey：主动推送往哪儿发');

const p2p = parseExternalKey('feishu:u_ou_abc');
check('私聊 → open_id', p2p?.kind === 'p2p' && p2p.id === 'ou_abc');
const group = parseExternalKey('feishu:g_oc_123');
check('群聊 → chat_id', group?.kind === 'group' && group.id === 'oc_123');
const topic = parseExternalKey('feishu:g_oc_123:u_ou_abc');
check('群聊多话题 → 仍然发到 chat_id（丢掉 :u_ 后缀）', topic?.kind === 'group' && topic.id === 'oc_123');
check('非飞书 key → null', parseExternalKey('slack:C123') === null);
check('空 key → null', parseExternalKey(undefined) === null);

console.log('存取与状态迁移');

const created = createTodo({
  wakerId: 'chat',
  title: '给 Jennie 加悄悄话模式',
  dueAt: iso(24 * HOUR),
  detail: '三条路全堵死：log / cache / history',
});
check('创建后能查到', listTodos().some((t) => t.id === created.id));
check('默认执行者是人', created.assignee === 'human');
check('默认来源是看板', created.source === 'web');
check('缺 dueAt 或者时间非法 → 抛错', (() => {
  try {
    createTodo({ wakerId: 'chat', title: 'x', dueAt: '明天' });
    return false;
  } catch {
    return true;
  }
})());

const done = finishTodo(created.id, '做完了，验收通过');
check('结束 → done', done?.status === 'done');
check('结束留下完成时间', Boolean(done?.doneAt));
check('结束保留备注', done?.note === '做完了，验收通过');

const second = createTodo({ wakerId: 'chat', title: '写三篇内容骨架', dueAt: iso(-HOUR) });
const snoozed = snoozeTodo(second.id, 24 * HOUR, NOW);
check('顺延后仍是 pending', snoozed?.status === 'pending');
check('顺延把 dueAt 推到 now+1d', snoozed?.dueAt === new Date(NOW.getTime() + 24 * HOUR).toISOString());
check('顺延计数 +1', snoozed?.snoozedCount === 1);
check('已完成的任务点顺延不会复活', snoozeTodo(created.id, 24 * HOUR, NOW)?.status === 'done');

const third = createTodo({ wakerId: 'chat', title: '误建的任务', dueAt: iso(48 * HOUR) });
check('关闭 → dismissed', dismissTodo(third.id)?.status === 'dismissed');

check('dueOnly 只返回到/过期的', (() => {
  const dueList = listTodos({ dueOnly: true, now: NOW });
  return dueList.every((t) => {
    const p = todoPhase(t, NOW);
    return p === 'due' || p === 'overdue';
  });
})());
check('getTodo 能按 id 取回最新状态', getTodo(created.id)?.status === 'done');

rmSync(DATA, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
