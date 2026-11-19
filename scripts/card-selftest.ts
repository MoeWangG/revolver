/**
 * 话题卡片自测：把带按钮的卡片**真发一条**到白名单里的第一个用户。
 *
 * 为什么需要真发：卡片 JSON 是接口侧的约定，本地类型检查管不到——
 * 2.0 里混进 1.0 的字段（比如 `action` 容器）会被整条拒收，
 * 而这条错误只出现在发送调用的返回值里，测试里伪造不出来。
 *
 * 用法：
 *   node --experimental-strip-types scripts/card-selftest.ts chat          # 只打印 JSON，不发
 *   node --experimental-strip-types scripts/card-selftest.ts chat --send   # 真发一条
 *
 * 发出去后点任意按钮，正确反应是回一句「这次提问已经处理过了」——
 * 说明 `card.action.trigger` 回调链路通了（没有待答提问时的兜底话术）。
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONVERSATIONS_FILE, PI_AGENT_HOME } from '../src/core/paths.ts';
import { loadWaker } from '../src/core/registry.ts';
import { buildTopicAskCard, buildTopicCardState } from '../src/channels/topicCard.ts';

type Any = any;

function loadLark(): Any | null {
  const bases = [process.env.WAKER_FEISHU_SDK, join(PI_AGENT_HOME, 'feishu-bot', 'package.json')].filter(
    Boolean,
  ) as string[];
  for (const base of bases) {
    try {
      return createRequire(base)('@larksuiteoapi/node-sdk');
    } catch {
      /* 换下一个来源 */
    }
  }
  return null;
}

const args = process.argv.slice(2);
const send = args.includes('--send');
/**
 * 发完再把它 patch 成「已处理完成」。
 *
 * 为什么单独验这一步：完成态靠 `im.v1.message.patch`，它对 2.0 卡片的支持
 * 本地测不出来（只有接口返回码能说明）。被拒的话卡片会停在 ⏳，
 * 那时就该走降级（不刷终态、用回帖说明），所以上线前必须真打一次。
 */
const patch = args.includes('--patch');
const wakerId = args.find((a) => !a.startsWith('--')) ?? 'chat';

const rec = loadWaker(wakerId);
if (!rec) {
  console.error(`找不到员工 ${wakerId}`);
  process.exit(1);
}
const cfg = rec.def.channels?.feishu;
if (!cfg?.appId || !cfg.appSecret) {
  console.error(`员工 ${wakerId} 没有完整的飞书应用凭证（appId / appSecret）`);
  process.exit(1);
}
/**
 * 白名单为空时（很多档案用的是 allowAllUsers），从会话映射里捞出这个人。
 *
 * 注意 open_id **按应用隔离**：同一个人的 open_id 在不同 bot 下不一样，
 * 所以只能读**这个员工**的会话键，不能拿别的员工的来试。
 */
function openIdFromConversations(id: string): string | null {
  try {
    const all = JSON.parse(readFileSync(CONVERSATIONS_FILE, 'utf-8')) as Record<string, Record<string, unknown>>;
    for (const key of Object.keys(all[id] ?? {})) {
      const m = /^feishu:(?:u|g_[^:]+:u)_(ou_[A-Za-z0-9]+)$/.exec(key);
      if (m?.[1]) return m[1];
    }
  } catch {
    /* 没有这张表也不致命 */
  }
  return null;
}

const target = cfg.allowedUsers?.[0] ?? openIdFromConversations(wakerId);
if (!target) {
  console.error('拿不到收件人 open_id（既没配 allowedUsers，也没有历史会话键）——先给这个 bot 发一条消息再跑');
  process.exit(1);
}

const body = [
  '**这是一张自测卡片**（按钮接线检查，不是真的在问你问题）',
  '点下面任意一个按钮，正确反应是：卡片当场变成「✅ 已收到你的选择 · 这次提问已经处理过」，',
  '同时回一句「这次提问已经处理过了」。',
  '如果点了毫无动静（卡片不变、也没有回帖），说明租户没订阅 `card.action.trigger` 事件。',
].join('\n');

const card = buildTopicAskCard(body, '切回去');
const json = JSON.stringify(card);
console.log(`card JSON ${Buffer.byteLength(json, 'utf-8')} 字节，目标 open_id=${target}`);
if (!send) {
  console.log(json);
  console.log('\n（只打印，未发送。加 --send 真发一条）');
  process.exit(0);
}

const lark = loadLark();
if (!lark) {
  console.error('未找到 @larksuiteoapi/node-sdk（可设 WAKER_FEISHU_SDK 指向它）');
  process.exit(1);
}

const client = new lark.Client({ appId: cfg.appId, appSecret: cfg.appSecret });
try {
  const resp = await client.im.v1.message.create({
    params: { receive_id_type: 'open_id' },
    data: { receive_id: target, msg_type: 'interactive', content: json },
  });
  const code = resp?.code ?? resp?.data?.code ?? 0;
  if (code !== 0) {
    console.error(`发送被拒：code=${code} msg=${resp?.msg ?? resp?.data?.msg}`);
    process.exit(1);
  }
  const messageId = resp?.data?.message_id as string | undefined;
  console.log(`已发送，message_id=${messageId ?? '(未知)'}`);
  console.log('去飞书点一下按钮：卡片变成「已收到你的选择」+ 回一句「这次提问已经处理过了」= 回调通了。');

  if (patch && messageId) {
    const state = buildTopicCardState('done', '切回去');
    try {
      const r = await client.im.v1.message.patch({
        path: { message_id: messageId },
        data: { content: JSON.stringify(state) },
      });
      const code = r?.code ?? 0;
      if (code === 0) console.log('patch 成功：卡片已刷成「✅ 已选择：切回去 · 已处理完成」');
      else console.error(`patch 被拒：code=${code} msg=${r?.msg ?? ''}（完成态需降级）`);
    } catch (e) {
      console.error('patch 抛错：', (e as Error)?.message ?? e);
    }
  }
} catch (e) {
  console.error('发送抛错：', (e as Error)?.message ?? e);
  process.exit(1);
}
