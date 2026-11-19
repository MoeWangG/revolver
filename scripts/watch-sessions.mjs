#!/usr/bin/env node
/**
 * 会话落点观测器。
 *
 * 用途：验证「同一段对话确实被装进了另一个弹巢」——只看界面是不够的，
 * 界面会骗人（历史上出现过「后端 success、界面空白、内容其实写到了别的目录」）。
 * 这个脚本直接读任务流水，把每一轮对话实际落在哪个 pi 会话文件上打出来。
 *
 * 用法：
 *   node scripts/watch-sessions.mjs            # 实时跟随
 *   node scripts/watch-sessions.mjs --once     # 只回放已有记录
 *   node scripts/watch-sessions.mjs --last 20  # 只看最近 20 条
 *
 * 判读：
 *   🔀 会话切换 = 本轮与上一轮的会话文件不同（这就是"切换"的硬证据）
 *   ⏺  同弹巢   = 两轮落在同一个文件
 *   ⤳  同会话换路径 = 文件名相同但目录变了（迁移换 home 的痕迹，不是切换）
 *
 * 两个已经踩过的坑，都体现在实现里：
 *   1. 判据用**文件名**而不是全路径：迁移时同一个会话换过目录（~/.pi-v2 → ~/.pi），
 *      全路径比较会把「同会话换路径」误报成「换会话」。
 *   2. 只对**终态**记录判定：任务开始时先落一条 status=running 的记录，
 *      此时还没有 sessionRef，按「null ≠ 上一轮」判定就会打出假切换。
 *   3. 不用字节偏移增量读：任务流水会被原地更新，偏移量会读到半截记录。
 *      改成轮询 + 按 taskId 去重（后出现的覆盖先出现的），量级完全扛得住。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const DATA = process.env.WAKER_DATA ?? join(ROOT, 'data');
const TASKS = join(DATA, 'tasks.jsonl');

const argv = process.argv.slice(2);
const ONCE = argv.includes('--once');
const lastIdx = argv.indexOf('--last');
const LAST = lastIdx >= 0 ? Math.max(1, Number(argv[lastIdx + 1]) || 20) : 0;

/** 只有这些状态代表「这一轮真的结束了」，才具备判定意义。 */
const TERMINAL = new Set(['success', 'failed', 'cancelled']);

if (!existsSync(TASKS)) {
  console.error(`找不到任务流水：${TASKS}`);
  process.exit(1);
}

/** 同一 taskId 可能出现多行（running → success），后者覆盖前者。 */
function loadTasks() {
  const raw = readFileSync(TASKS, 'utf-8').split('\n');
  const byId = new Map();
  for (const line of raw) {
    const t = line.trim();
    if (!t) continue;
    try {
      const r = JSON.parse(t);
      if (r?.taskId) byId.set(r.taskId, r);
      else byId.set(`anonymous-${byId.size}`, r);
    } catch {
      /* 跳过坏行 */
    }
  }
  return [...byId.values()].sort((a, b) => {
    const ka = a.startedAt ?? a.createdAt ?? '';
    const kb = b.startedAt ?? b.createdAt ?? '';
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

/** 会话文件的可读状态：存在、大小、最后写入时间。 */
function fileState(p) {
  if (!p) return '(无会话文件)';
  if (!existsSync(p)) return `缺失 ${basename(p)}`;
  const st = statSync(p);
  return `${basename(p)}  ${(st.size / 1024).toFixed(1)}KB  mtime=${st.mtime.toISOString().slice(11, 19)}`;
}

const short = (id) => (id ?? '----').slice(0, 8);
function oneLine(s, n = 40) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

let prevFull = null; // 上一轮的完整路径（只用于展示"
let prevKey = null; // 上一轮文件名：判据只用它
let seq = 0;

/** 打印一条终态记录；返回是否发生了会话切换。 */
function report(rec) {
  const file = rec.sessionRef ?? null;
  const key = file ? basename(file) : null;

  // 没有会话文件的记录（独立任务）不参与判定，也不更新 prevKey，
  // 否则一次无会话的任务就会把它后面的一轮误标成切换。
  const switched = prevKey !== null && key !== null && key !== prevKey;
  const moved = !switched && key !== null && prevFull !== null && file !== prevFull;
  const mark = prevKey === null || key === null ? '   ' : switched ? '🔀 ' : moved ? '⤳  ' : '⏺  ';

  seq += 1;
  const when = (rec.startedAt ?? rec.createdAt ?? '').slice(11, 19);
  const flag = rec.status === 'success' ? '' : ` [${rec.status}]`;
  console.log(
    `${mark}#${String(seq).padStart(3)} ${when} ${String(rec.source ?? '-').padEnd(4)} ` +
      `sid=${short(rec.sessionId)}  ${fileState(file)}${flag}`,
  );

  if (switched) {
    console.log(`      ↳ 上一轮: ${prevKey}`);
    console.log(`      ↳ 本轮  : ${key}   ← 上下文换了容器`);
  } else if (moved) {
    console.log('      ↳ 同一会话，但文件路径变了：');
    console.log(`          ${prevFull}`);
    console.log(`          ${file}`);
    console.log('        （迁移换 home 的痕迹，不计入切换）');
  }

  if (rec.prompt) console.log(`      问: ${oneLine(rec.prompt)}`);
  if (rec.result && (switched || moved)) console.log(`      答: ${oneLine(rec.result, 60)}`);

  if (key !== null) {
    prevFull = file;
    prevKey = key;
  }
  return switched;
}

function header(sub) {
  console.log(`任务流水：${TASKS}`);
  console.log(sub);
  console.log('mark #  时间    来源 sessionId  会话文件\n');
}

function replay() {
  const all = loadTasks();
  const done = all.filter((r) => TERMINAL.has(r.status ?? ''));
  const start = LAST > 0 ? Math.max(0, done.length - LAST) : 0;
  const pick = done.slice(start);
  header(`共 ${all.length} 条任务、${done.length} 条终态，回放最近 ${pick.length} 条\n`);
  let switches = 0;
  for (const r of pick) if (report(r)) switches += 1;
  console.log(`\n合计：${pick.length} 条终态记录，其中会话切换 ${switches} 次`);
}

function follow() {
  const initial = loadTasks().filter((r) => TERMINAL.has(r.status ?? ''));
  // 以最后一条终态记录为基线，避免刚启动就把历史全打一遍
  for (const r of initial.slice(-1)) {
    const f = r.sessionRef ?? null;
    prevFull = f;
    prevKey = f ? basename(f) : null;
  }
  header(`等待新任务…（起点：${prevKey ?? '(空)'}）\n`);

  const seen = new Set();
  for (const r of initial) seen.add(r.taskId);

  const timer = setInterval(() => {
    let latest;
    try {
      latest = loadTasks();
    } catch {
      return; // 文件正在重写，下一轮再读
    }
    for (const r of latest) {
      if (!TERMINAL.has(r.status ?? '')) continue;
      if (seen.has(r.taskId)) continue;
      seen.add(r.taskId);
      report(r);
    }
  }, 1000);

  const stop = () => {
    clearInterval(timer);
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (ONCE || LAST > 0) replay();
else follow();
