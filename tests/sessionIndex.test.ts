/**
 * 会话向量索引的打分逻辑单测（纯函数，不调模型、不读文件）。
 *
 * 守的是"为什么不能对 top-3 求和"：长度偏置与复述偏置都会把用户送进错的会话，
 * 而这两种错误在线上看起来都像"模型抽风"，很难归因。所以把公式钉死。
 */
import {
  combineScore,
  scoreSessionChunks,
  scoreSessions,
  semanticFromIndex,
  titleMatchScore,
  type IndexChunk,
} from '../src/core/sessionIndex.ts';
import type { SessionMeta } from '../src/core/sessions.ts';

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

/** 与 [1,0] 余弦恰为 cos 的二维向量。 */
const vec = (cos: number): number[] => [cos, Math.sqrt(Math.max(0, 1 - cos * cos))];

function chunk(sid: string, text: string, cos: number): IndexChunk {
  return { key: `${sid}:${text}`, sid, role: 'user', text, vec: vec(cos) };
}

const mkSession = (id: string, name = id): SessionMeta => ({
  id,
  wakerId: 'chat',
  name,
  title: name,
  piSessionId: `pi-${id}`,
  createdAt: '2026-11-01T00:00:00.000Z',
  lastActiveAt: '2026-11-08T00:00:00.000Z',
  messageCount: 10,
});

console.log('scoreSessionChunks');

{
  // 三维：让"无关块之间"也互不相似（二维里任何两个向量都只差一个夹角，容易误撞近重复阈值）
  const q = [1, 0, 0];
  const mk = (x: number, y: number, z: number): IndexChunk => ({
    key: `${x}`,
    sid: 'a',
    role: 'user',
    text: 't',
    vec: [x, y, z],
  });
  const r = scoreSessionChunks(q, [
    mk(1, 0, 0),
    mk(0.2, Math.sqrt(1 - 0.04), 0),
    mk(0.3, 0, Math.sqrt(1 - 0.09)),
  ]);
  check('vmax = 最像那块', r.vmax === 1, String(r.vmax));
  check('bg = 全部块的平均（背景）', Math.abs(r.bg - 0.5) < 1e-9, String(r.bg));
  check('support = top3 均值', Math.abs(r.support - 0.5) < 1e-9, String(r.support));
  check('空块 → 全 0（不产生 NaN）', scoreSessionChunks(q, []).vmax === 0);
}

{
  // 同一句话被复述三次：不能把 support 刷成 1.0
  const dup = [chunk('a', '好了吗', 1), chunk('a', '好了吗?', 1), chunk('a', '好了没', 1), chunk('a', '周报', 0.5)];
  const r = scoreSessionChunks(vec(1), dup);
  check(
    '近重复块只算一次（复述不能刷 top3）',
    Math.abs(r.support - 0.75) < 1e-9,
    `support=${r.support}`,
  );
}

console.log('combineScore：为什么不求和');

{
  // 长会话：三块都"有点像" 0.55
  const long = combineScore(0.55, 0.55, 0.55, 0);
  // 短会话：一块逐字命中 1.0，其余不像（bg 被拉低）
  const short = combineScore(1.0, 0.4, 0.7, 0);
  check('长会话凑三个 0.55 → 综合分为 0', Math.abs(long) < 1e-9, String(long));
  check('短会话逐字命中 → 明显为正且高于长会话', short > long && short > 0.3, `short=${short.toFixed(3)} long=${long.toFixed(3)}`);
  check('单纯求和会反过来（0.55×3 > 1.0+0.2+0.15）', 1.65 > 1.35, '这正是要避免的偏置');
}

console.log('titleMatchScore');

check('标题完全一致 → 1', titleMatchScore('esp32-cam', 'esp32-cam') === 1);
check('大小写/标点无关', titleMatchScore('ESP32-CAM', 'esp32 cam。') === 1);
check('消息包含标题 → 0.5', titleMatchScore('周报复盘定时推送', '帮我把周报复盘定时推送改一下') === 0.5);
check('标题太短不参与包含判断', titleMatchScore('周报', '我') === 0);
check('无关 → 0', titleMatchScore('树莓派AI问答机落地', '明天天气') === 0);

console.log('scoreSessions：排序与诊断');

{
  const sessions = [mkSession('long', '杂谈'), mkSession('short', 'esp32-cam')];
  const bySid = new Map<string, IndexChunk[]>([
    ['long', [chunk('long', 'a', 0.55), chunk('long', 'b', 0.55), chunk('long', 'c', 0.55)]],
    ['short', [chunk('short', 'esp32', 1), chunk('short', '别的', 0.4)]],
  ]);
  const ranked = scoreSessions({ queryVec: vec(1), message: 'esp32-cam', sessions, bySid });
  check('逐字命中的短会话排第一（不被长会话的数量压过）', ranked[0]?.id === 'short', JSON.stringify(ranked.map((r) => r.id)));
  check('返回块数便于诊断', ranked[0]?.chunks === 2, String(ranked[0]?.chunks));
  check('没有向量的会话不参与排序', scoreSessions({ queryVec: vec(1), message: 'x', sessions, bySid }).length === 2);
}

console.log('semanticFromIndex');

{
  const active = mkSession('a', '当前');
  const sessions = [active, mkSession('b'), mkSession('c')];
  const bySid = new Map<string, IndexChunk[]>([
    ['a', [chunk('a', '当前内容', 0.6)]],
    ['b', [chunk('b', '旧话题', 0.8)]],
    ['c', [chunk('c', '另一个', 0.5)]],
  ]);
  const sem = semanticFromIndex({
    queryVec: vec(1),
    active,
    sessions,
    bySid,
    continueThreshold: 0.58,
    switchThreshold: 0.6,
    unrelatedThreshold: 0.45,
  });
  check('当前会话有向量时返回可用的 SemanticInput', sem !== null && sem.active.length === 1);
  check('候选排除当前会话', sem?.candidates.map((c) => c.sessionId).join(',') === 'b,c');
  check('阈值原样带过去（判定刻度不能被索引改动）', sem?.switchThreshold === 0.6 && sem?.continueThreshold === 0.58);
}

{
  const active = mkSession('a', '当前');
  const sessions = [active, mkSession('b'), mkSession('c')];
  const bySid = new Map<string, IndexChunk[]>([
    ['b', [chunk('b', '旧话题', 0.8)]],
    ['c', [chunk('c', '另一个', 0.5)]],
  ]);
  const sem = semanticFromIndex({
    queryVec: vec(1),
    active,
    sessions,
    bySid,
    continueThreshold: 0.58,
    switchThreshold: 0.6,
    unrelatedThreshold: 0.45,
  });
  check(
    '当前会话还没索引到 → null（拿 0 分判"不像"会误开新话题）',
    sem === null,
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
