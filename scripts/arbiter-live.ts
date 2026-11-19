/**
 * 生产配置下的仲裁冒烟：读 `agents/<id>/waker.yaml` 的 `session.arbiter`，
 * 直接用真实会话与候选跑一次 `arbitrate()`。
 *
 * 用途：换模型后确认"配置真的读到了、真的走了 chat 接口"。
 * registry 曾经不解析 `session.arbiter`，yaml 里改了也没生效（静默回落 laya），
 * 这个脚本就是那条链路的守门。
 *
 * 用法：
 *   node --experimental-strip-types scripts/arbiter-live.ts [wakerId] [sessionId]
 */
import { loadWaker } from '../src/core/registry.ts';
import { listSessions } from '../src/core/sessions.ts';
import { readSessionMessages } from '../src/core/sessionHistory.ts';
import { arbitratePair } from '../src/core/topicArbiter.ts';
import { DEFAULT_ARBITER_CONFIG } from '../src/types.ts';

const wakerId = process.argv[2] ?? 'chat';
const rec = loadWaker(wakerId);
if (!rec) {
  console.error(`找不到员工：${wakerId}`);
  process.exit(1);
}

const cfg = { ...DEFAULT_ARBITER_CONFIG, ...(rec.def.session?.arbiter ?? {}) };
console.log('生效配置：', JSON.stringify(cfg));

const sessions = listSessions(wakerId);
const active = sessions.find((s) => s.id === process.argv[3]) ?? sessions[0];
if (!active) {
  console.error('没有可用会话');
  process.exit(1);
}
const candidates = sessions.filter((s) => s.id !== active.id).slice(0, 3);
const recent = readSessionMessages(wakerId, active.id, 6)
  .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.text.trim())
  .slice(-2)
  .map((m) => ({ role: m.role as 'user' | 'assistant', text: m.text.replace(/\s+/g, ' ').slice(0, 200) }));

console.log(`当前会话：${active.id}  候选：${candidates.map((c) => c.id).join(', ')}\n`);

const probes = [
  '你把这些做到吧，我记得日志已经拉到本地了，你找找看',
  '改成 6-10 岁吧。不说几年级这么精确了。',
  '明天上海会下雨吗',
  '换个话题，帮我看看 K8s 的 ingress 怎么配',
];

for (const message of probes) {
  const t0 = Date.now();
  const pair = arbitratePair({ message, active, candidates, recent }, cfg);
  const r = await pair.main;
  const mainMs = Date.now() - t0;
  console.log(`${String(mainMs).padStart(5)}ms  ${(r?.action ?? 'null').padEnd(8)} ${r?.model ?? ''}  「${message}」`);
  if (r?.raw) console.log(`         raw: ${r.raw.replace(/\s+/g, ' ').slice(0, 80)}`);
  // 影子单独等：真实链路里它是 void 的，这里等只是为了把对照打出来
  const s = await pair.shadow;
  if (s) console.log(`         shadow: ${s.model} ${s.action} ${s.ms}ms`);
}
