/**
 * 用 `data/decisions.jsonl` 里**留存的真实场景**回放，对比新旧排序的 top-1 命中。
 *
 * 数据来源与口径：
 *  - `route` 事件给我们"当时的原话 + 当时的当前会话"；
 *  - `final` 事件给我们**人类答案**：`stay` = 用户拒绝了推荐、留在当前，
 *    `switch` = 用户真的切到了某个会话。
 *  所以 ground truth 是"用户最后落在哪个会话"，评测的是**排序准不准**（不含阈值）。
 *
 * 用法（必须隔离数据目录，脚本会真拍快照、调模型）：
 *   cp data/sessions.json data/session-vectors.jsonl /tmp/ep-eval/
 *   WAKER_DATA=/tmp/ep-eval node --experimental-strip-types scripts/episode-eval.ts --backfill
 */
import { readFileSync } from 'node:fs';
import { loadCache, scoreSessions } from '../src/core/sessionIndex.ts';
import { listSessions } from '../src/core/sessions.ts';
import { embedTexts } from '../src/core/embeddings.ts';
import { displayNameOf } from '../src/core/sessionName.ts';
import { loadWaker } from '../src/core/registry.ts';
import { snapshotOnLeave, readEpisodes } from '../src/core/episode.ts';

const argv = process.argv.slice(2);
const backfill = argv.includes('--backfill');

interface Row {
  evt?: string;
  id?: string;
  at?: string;
  message?: string;
  active?: { id?: string; name?: string };
  kind?: string;
  sessionId?: string;
  /** ask 事件：当时链路提议的动作（new / switch）。 */
  proposed?: string;
  /** route 事件：当时的语义分。 */
  semantic?: { active?: number; best?: number };
}

const rows: Row[] = readFileSync('data/decisions.jsonl', 'utf-8')
  .split('\n')
  .filter(Boolean)
  .map((l) => {
    try {
      return JSON.parse(l) as Row;
    } catch {
      return {};
    }
  });

const routes = rows.filter((r) => r.evt === 'route' && r.id && r.message && r.active?.id);
const finals = new Map(rows.filter((r) => r.evt === 'final' && r.id).map((r) => [r.id!, r]));
const asks = new Map(rows.filter((r) => r.evt === 'ask' && r.id).map((r) => [r.id!, r]));

const sessions = listSessions('chat');

if (backfill) {
  console.log(`给 ${sessions.length} 个会话补快照（已有增量的会自己跳过）…`);
  for (const s of sessions) {
    const r = await snapshotOnLeave({ wakerId: 'chat', sessionId: s.id, to: 'eval' });
    console.log(`  ${s.id} ${displayNameOf(s).slice(0, 16)}：${r.ok ? `ok ${r.chars}字 ${r.ms}ms` : r.skipped}`);
  }
  console.log(`episodes 共 ${readEpisodes('chat').length} 条\n`);
}

const rec = loadWaker('chat');
const embedCfg = {
  enabled: true,
  baseUrl: rec?.def.session?.semantic.baseUrl ?? 'http://127.0.0.1:1234/v1',
  model: rec?.def.session?.semantic.model ?? 'text-embedding-bge-m3',
  timeoutMs: rec?.def.session?.semantic.timeoutMs ?? 6000,
};

const bySid = loadCache('chat');
const noEp = new Map([...bySid.entries()].map(([k, v]) => [k, v.filter((c) => c.role !== 'episode')] as const));

const nameOf = (id: string): string => {
  const s = sessions.find((x) => x.id === id);
  return s ? displayNameOf(s).slice(0, 18) : id;
};

let total = 0;
let hitNew = 0;
let hitOld = 0;
const detail: string[] = [];

for (const r of routes) {
  const fin = finals.get(r.id!);
  if (!fin) continue;
  const truth = fin.kind === 'switch' && fin.sessionId ? fin.sessionId : r.active!.id!;
  const msg = r.message!;
  const q = await embedTexts([msg], embedCfg);
  if (!q?.[0]) {
    console.error('embedding 不可用');
    process.exit(1);
  }

  const withEp = scoreSessions({ queryVec: q[0], message: msg, sessions, bySid });
  const without = scoreSessions({ queryVec: q[0], message: msg, sessions, bySid: noEp });
  const topNew = withEp[0]?.id;
  const topOld = without[0]?.id;

  total += 1;
  if (topNew === truth) hitNew += 1;
  if (topOld === truth) hitOld += 1;

  const wanted = truth === r.active!.id ? '留在当前' : `切到《${nameOf(truth)}》`;
  const proposed = asks.get(r.id!)?.proposed;
  const semActive = r.semantic?.active;
  const semBest = r.semantic?.best;
  // 两个层次分开看：排序（该把谁排第一）与链路（发不发卡）
  const sortOk = topNew === truth;
  const chainFired = proposed && proposed !== 'continue';
  const chainErr = chainFired && truth === r.active!.id;

  detail.push(
    `[${String(total).padStart(2)}] ${sortOk ? '排序✓' : '排序✗'} ${chainErr ? '链路✗' : '链路✓'} ` +
      `「${msg.replace(/\s+/g, ' ').slice(0, 40)}」\n` +
      `     当时会话：${nameOf(r.active!.id!)}  语义 active=${semActive?.toFixed(3) ?? '-'} best=${semBest?.toFixed(3) ?? '-'}\n` +
      `     当时链路：${chainFired ? `发卡提议「${proposed}」` : '直接继续'}（你最终：${fin.kind}）\n` +
      `     人工答案：${wanted}（${fin.kind}）\n` +
      `     新方案 top1：${nameOf(topNew ?? '-')} ${withEp[0]?.score.toFixed(3) ?? '-'}`,
  );
}

console.log(detail.join('\n'));
console.log(
  `\n共 ${total} 条可回放场景（${routes.length} 条判定，其中 ${routes.length - total} 条缺终态）`,
);
console.log(`排序 top-1 与人工答案一致：新方案 ${hitNew}/${total}，旧排序 ${hitOld}/${total}`);
