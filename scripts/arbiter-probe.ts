#!/usr/bin/env node
/**
 * 小模型「话题判定」对照测试。
 *
 * 用途：验证某个本地小模型能否替代/补位模糊带的判定（见 docs/会话切换.md）。
 * 只打 LM Studio 的 /v1/chat/completions，不读写任何平台数据。
 *
 * 用法：
 *   node --experimental-strip-types scripts/arbiter-probe.ts laya-multilingual
 *   node --experimental-strip-types scripts/arbiter-probe.ts model-a model-b
 */

const BASE = process.env.WAKER_LLM_BASE_URL ?? 'http://127.0.0.1:1234/v1';
const TIMEOUT_MS = Number(process.env.WAKER_LLM_TIMEOUT ?? 60_000);

type Expect = 'CONTINUE' | 'NEW';

interface Sample {
  expect: Expect;
  text: string;
  /** 陷阱样本：考察是"看到词"还是"读懂意图"。 */
  trap?: boolean;
}

const CONTEXT = `当前会话：《我想聊聊创业》
最近在聊：AI 随身拍照设备的硬件选型（ESP32-S3 摄像头、AirPods 按压）、充电宝与 Type-C 供电、云服务与 App 的分工；期间还让助手用浏览器验证过一个功能。
其他会话：1ca6730a《飞书私聊》（58 条，日常杂事）

判断规则：
- 延续上面话题（追问细节、补充条件、回答刚才的问题）→ CONTINUE
- 宣布或要求开始一个与上面无关的新主题 → NEW
- 只提到「新话题」这三个字、但不是在要求换话题 → CONTINUE

示例：
「新话题」→ NEW
「换个话题，帮我看看 K8s」→ NEW
「重量多少来着」→ CONTINUE
「你上次说的那个『新话题』功能是什么」→ CONTINUE

只输出一个词：CONTINUE 或 NEW。不要解释。`;

const SAMPLES: Sample[] = [
  // —— 正例：明确要求换话题（真实样本 + 构造）
  { expect: 'NEW', text: '新话题' },
  { expect: 'NEW', text: '换个话题，帮我看看 K8s 的 ingress 怎么配' },
  { expect: 'NEW', text: '说点别的，你觉得我该不该换工作' },
  { expect: 'NEW', text: '另外问个事，我家路由器老是断线' },
  { expect: 'NEW', text: '新话题：怎么跟老板谈涨薪' },
  // —— 负例：真实连续追问（取自 waker-chat 734e8785）
  { expect: 'CONTINUE', text: '重量多少来着' },
  { expect: 'CONTINUE', text: '市面上有没有类似的产品已经在卖了？然后他们卖的怎么样？' },
  { expect: 'CONTINUE', text: '我没太懂你所说的云服务是个什么东西，或者云函数。' },
  { expect: 'CONTINUE', text: '我有MacBook。然后还有一个问题，就是如果买镜头是什么？' },
  { expect: 'CONTINUE', text: '关于Type C的充电线，我看了没有你说的这种型号的标识，我不知道该怎么办。' },
  { expect: 'CONTINUE', text: '我记得你之前操作过我已经登录了的浏览器，你再看一下是不是还能继续操作？' },
  { expect: 'CONTINUE', text: '我这个DeepSeek的API有了搜索功能，你看是不是能用？' },
  { expect: 'CONTINUE', text: '我看了一下，充电宝一般都很少有这种小电流保持充电状态的能力，所以你可能得想个办法。' },
  // —— 陷阱：短句 / 提词
  { expect: 'CONTINUE', text: '好', trap: true },
  { expect: 'CONTINUE', text: '继续', trap: true },
  { expect: 'CONTINUE', text: '你上次说的那个「新话题」功能是什么', trap: true },
];

async function ask(model: string, text: string): Promise<{ pred: string; ms: number; raw: string }> {
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ctrl.signal,
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: CONTEXT },
          { role: 'user', content: `用户新消息：「${text}」` },
        ],
        temperature: 0,
        max_tokens: 96,
      }),
    });
    const data = (await r.json()) as {
      choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>;
      error?: { message?: string };
    };
    const msg = data.choices?.[0]?.message;
    // thinking 模型会把结论写在 content，把思考写在 reasoning_content；两者取其一，再取最后一个匹配
    const raw = (msg?.content?.trim() || msg?.reasoning_content?.trim() || data.error?.message || '(空)').trim();
    const hits = raw.match(/CONTINUE|NEW/gi) ?? [];
    const last = hits.length ? hits[hits.length - 1]!.toUpperCase() : '';
    return { pred: last || `?(${raw.slice(0, 24)})`, ms: Date.now() - t0, raw };
  } catch (e) {
    return { pred: `!(err)`, ms: Date.now() - t0, raw: (e as Error)?.message ?? String(e) };
  } finally {
    clearTimeout(timer);
  }
}

/** 留出集：措辞与 few-shot 示例不重合，用来检验泛化而不是背答案。 */
const HOLDOUT: Sample[] = [
  { expect: 'NEW', text: '先放一放，帮我看看合同里的竞业条款' },
  { expect: 'NEW', text: '聊点别的：孩子不肯写作业怎么办' },
  { expect: 'NEW', text: '新主题：帮我写个周报' },
  { expect: 'NEW', text: '明天上海会下雨吗' },
  { expect: 'CONTINUE', text: '刚才那个电池方案再解释一下' },
  { expect: 'CONTINUE', text: '为什么要用 Type-C 而不是 Micro USB' },
  { expect: 'CONTINUE', text: '这个充电宝多少钱' },
  { expect: 'CONTINUE', text: '嗯嗯' },
];

/** 难样本：换思路但同话题、指代依赖、边界。这才是区分"会做选择题"和"真判断"的地方。 */
const HARD: Sample[] = [
  { expect: 'CONTINUE', text: '换个思路，ESP32 保留但摄像头换成 ToF' },
  { expect: 'CONTINUE', text: '你说得对，那按第二方案来' },
  { expect: 'CONTINUE', text: '刚才那个充电宝的 3C 认证，是不是必须有' },
  { expect: 'CONTINUE', text: '好，那你继续' },
  { expect: 'NEW', text: '先不说硬件了，帮我改一下 SOUL.md 的语气' },
  { expect: 'NEW', text: '对了，我下个月的日本行程还没定' },
];

const GROUPS: Array<{ name: string; items: Sample[] }> = [
  { name: '训练集（few-shot 覆盖）', items: SAMPLES },
  { name: '留出集（措辞未出现）', items: HOLDOUT },
  { name: '难样本（换思路 / 指代 / 边界）', items: HARD },
];

const argv = process.argv.slice(2);
const dry = argv.includes('--dry');
const models = argv.filter((a) => a !== '--dry');
if (!models.length) {
  console.error('用法：node --experimental-strip-types scripts/arbiter-probe.ts <model> [model2 ...] [--dry]');
  process.exit(1);
}
if (dry) {
  console.log('=== system ===\n' + CONTEXT);
  console.log('\n=== user（每条样本都按这个形状拼） ===');
  console.log('用户新消息：「<这句>」');
  process.exit(0);
}

for (const model of models) {
  console.log(`\n=== ${model} ===`);
  for (const g of GROUPS) {
    console.log(`--- ${g.name} ---`);
    let ok = 0;
    let trapOk = 0;
    let trapTotal = 0;
    const lat: number[] = [];
    for (const s of g.items) {
      const { pred, ms, raw } = await ask(model, s.text);
      const hit = pred === s.expect;
      if (hit) ok += 1;
      if (s.trap) {
        trapTotal += 1;
        if (hit) trapOk += 1;
      }
      lat.push(ms);
      const mark = hit ? '✓' : '✗';
      console.log(
        `${mark} ${pred.padEnd(9)} 期望 ${s.expect.padEnd(9)} ${String(ms).padStart(5)}ms  ${s.text.slice(0, 28)}` +
          (hit || s.trap ? '' : `   raw=${raw.slice(0, 30)}`),
      );
    }
    const avg = lat.reduce((a, b) => a + b, 0) / lat.length;
    console.log(
      `准确率 ${ok}/${g.items.length} (${((ok / g.items.length) * 100).toFixed(0)}%)` +
        (trapTotal ? `  陷阱 ${trapOk}/${trapTotal}` : '') +
        `  平均延迟 ${avg.toFixed(0)}ms`,
    );
  }
}
