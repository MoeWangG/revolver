/**
 * 召回对照：同一句话，在"有离场快照 / 没有快照"两套索引下的排序差异。
 *
 * 用法（隔离数据目录）：
 *   WAKER_DATA=/tmp/ep-smoke node --experimental-strip-types scripts/episode-recall.ts "kid-qa-box 的 README 改好了吗"
 */
import { loadCache, scoreSessions } from '../src/core/sessionIndex.ts';
import { listSessions } from '../src/core/sessions.ts';
import { embedTexts, DEFAULT_EMBEDDING } from '../src/core/embeddings.ts';
import { displayNameOf } from '../src/core/sessionName.ts';

const query = process.argv[2] ?? '';
if (!query) {
  console.error('缺少查询语句');
  process.exit(1);
}

const sessions = listSessions('chat');
const bySid = loadCache('chat');
const noEp = new Map(
  [...bySid.entries()].map(([k, v]) => [k, v.filter((c) => c.role !== 'episode')] as const),
);

const q = await embedTexts([query], DEFAULT_EMBEDDING);
if (!q?.[0]) {
  console.error('embedding 不可用');
  process.exit(1);
}

const withEp = scoreSessions({ queryVec: q[0], message: query, sessions, bySid });
const without = scoreSessions({ queryVec: q[0], message: query, sessions, bySid: noEp });

const nameOf = (id: string): string => {
  const s = sessions.find((x) => x.id === id);
  return s ? `${displayNameOf(s).slice(0, 22)}(${id})` : id;
};

console.log(`查询：「${query}」\n`);
console.log('有快照：');
for (const s of withEp.slice(0, 5)) {
  console.log(`  ${s.score.toFixed(3)}  vmax=${s.vmax.toFixed(3)} bg=${s.bg.toFixed(3)} 块${s.chunks} ${nameOf(s.id)}`);
}
console.log('无快照：');
for (const s of without.slice(0, 5)) {
  console.log(`  ${s.score.toFixed(3)}  vmax=${s.vmax.toFixed(3)} bg=${s.bg.toFixed(3)} 块${s.chunks} ${nameOf(s.id)}`);
}
