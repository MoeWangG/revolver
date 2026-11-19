/**
 * 离场快照的一次性冒烟：真调模型 + 真 embed，落盘后读回来校验。
 *
 * 用法（必须在隔离数据目录里跑，避免写生产 data）：
 *   WAKER_DATA=/tmp/ep-smoke node --experimental-strip-types scripts/episode-smoke.ts <sessionId>
 */
import { episodeChunks, readEpisodes, snapshotOnLeave } from '../src/core/episode.ts';
import { dialogueOf } from '../src/core/episode.ts';

const sid = process.argv[2] ?? '';
if (!sid) {
  console.error('缺少 sessionId');
  process.exit(1);
}

const msgs = dialogueOf('chat', sid);
console.log(`有效对话 ${msgs.length} 条（已过滤流程噪声）`);
console.log('最后 3 条：');
for (const m of msgs.slice(-3)) console.log(`  ${m.role}: ${m.text.slice(0, 60)}`);

const r = await snapshotOnLeave({ wakerId: 'chat', sessionId: sid, to: 'smoke-target' });
console.log('snapshot:', r);

const eps = readEpisodes('chat');
console.log(`episodes.jsonl 共 ${eps.length} 条`);
for (const e of eps) {
  console.log(
    `  sid=${e.sid} 覆盖[${e.from},${e.covered}) 向量${e.vec.length}维 tail=${e.tail.length}条\n    摘要：${e.summary.slice(0, 100)}`,
  );
}
const chunks = episodeChunks('chat');
console.log('episodeChunks:', [...chunks.entries()].map(([k, v]) => `${k}:${v.length}`));
