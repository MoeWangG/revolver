#!/usr/bin/env node
/**
 * 验收截图工具：打开看板 → 按文本给需求点加**红框 + 标签** → 截图落盘。
 *
 * 为什么要有这个脚本：
 *  1. 看板类改动靠肉眼验收不可复现，"改了什么"和"看到什么"容易对不上；
 *  2. 截图要能进版本记录（`web/public/verify/`），让后来的人知道这一版长什么样；
 *  3. 手点截图会漏标需求点，于是把"标注"也变成代码。
 *
 * 用法：
 *   node scripts/verify-shot.mjs <url> <out.png> '{"marks":[{"text":"今日提问","label":"① 今日提问次数"}]}'
 *
 * 标注规则：按文本找到**最内层**节点，再向上最多 4 层找可标注的容器
 * （带 `title` 的 KPI、`header`、或可点击卡片），没找到就用父节点。
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9333;

const [url, out, marksJson] = process.argv.slice(2);
if (!url || !out) {
  console.error('用法: node scripts/verify-shot.mjs <url> <out.png> \'{"scrollTo":"验收","marks":[...]}\'');
  process.exit(1);
}
const payload = marksJson ? JSON.parse(marksJson) : {};
const marks = payload.marks ?? [];
/** 可选：先滚到某个文本所在位置再截图（长页面验收截图常需要）。 */
const scrollTo = payload.scrollTo ?? '';
/** 可选：截图前点一下包含该文本的最内层元素（用来打开会话弹窗等）。 */
const clickText = payload.click ?? '';
/** 可选：往输入框里敲一段字（走 CDP insertText，React 的 onChange 会正常触发）。 */
const typeText = payload.type ?? '';
/** 输入框选择器，默认对话窗里的 textarea。 */
const typeSelector = payload.typeSelector ?? 'textarea';
/** 可选：敲完字按 ⌘+Enter 提交（与界面里的发送快捷键一致）。 */
const submit = payload.submit === true;
/** 提交后等多久再截图：话题判定 + 首屏渲染都要时间。 */
const waitAfterSubmit = Number(payload.waitAfterSubmit ?? 4000);
/** 可选：提交之后再点一下某段文字（例如建议条上的「就在这儿发」）。 */
const afterClick = payload.afterClick ?? '';
/** afterClick 之后等多久再截图（等模型答完）。 */
const waitAfterClick = Number(payload.waitAfterClick ?? 3000);
/**
 * 可选：在 click 之后、打字之前执行一段脚本（例如临时 stub 掉 `/route`）。
 *
 * 用于验收"交互本身"而不污染真实数据：把判定换成固定返回，
 * 就能稳定复现"切过去""开新会话"这些分支，而这条消息只落进临时会话。
 */
const script = payload.script ?? '';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitCdp() {
  for (let i = 0; i < 50; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (res.ok) return (await res.json()).webSocketDebuggerUrl;
    } catch {
      /* 还没起来 */
    }
    await sleep(200);
  }
  throw new Error('Chrome CDP 未就绪');
}

/** 极简 CDP 客户端：按 id 匹配响应。 */
function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();
  const ready = new Promise((res, rej) => {
    ws.addEventListener('open', () => res());
    ws.addEventListener('error', (e) => rej(new Error(`ws error: ${e.message ?? e}`)));
  });
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve: ok, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else ok(msg.result);
    }
  });
  return {
    ready,
    send(method, params = {}, sessionId) {
      const id = nextId++;
      const payload = { id, method, params };
      if (sessionId) payload.sessionId = sessionId;
      return new Promise((ok, reject) => {
        pending.set(id, { resolve: ok, reject });
        ws.send(JSON.stringify(payload));
      });
    },
    close() {
      ws.close();
    },
  };
}

const inject = (marksList, scrollToText) => `
(async () => {
  const style = document.createElement('style');
  style.textContent = '.wv-anno{outline:3px solid #e11d48 !important;outline-offset:3px;position:relative}'
    + '.wv-anno::before{content:attr(data-wv);position:absolute;top:-22px;left:-3px;background:#e11d48;color:#fff;'
    + 'font:11px/1.6 -apple-system,PingFang SC,sans-serif;padding:1px 6px;border-radius:4px;white-space:nowrap;z-index:99999}';
  document.head.appendChild(style);

  // 找标注目标：优先"自己的文本节点就包含这段字"的元素（有子元素的标题行也能命中），
  // 找不到再退回"叶子节点"。可点击元素直接标它自己——否则两个按钮会一起被圈进同一个容器。
  const ownText = (el) => [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('');
  const findBox = (text) => {
    const all = [...document.querySelectorAll('body *')];
    const hit =
      all.find((el) => ownText(el).includes(text)) ??
      all.find((el) => el.children.length === 0 && (el.textContent || '').trim().includes(text));
    if (!hit) return null;
    const btn = hit.closest('button, a[href]');
    if (btn) return btn;
    let el = hit;
    for (let i = 0; i < 4 && el; i += 1) {
      if (el.hasAttribute && el.hasAttribute('title')) return el;
      if (el.tagName === 'HEADER') return el;
      el = el.parentElement;
    }
    return hit.parentElement || hit;
  };

  // 长页面：不滚动（有些页面会在数据刷新后把滚动位置重置），
  // 而是算出目标区域的绝对坐标，交给 CDP 的 captureBeyondViewport 直接裁那一块。
  let clip = null;
  if (${JSON.stringify(scrollToText)}) {
    const target = findBox(${JSON.stringify(scrollToText)});
    if (target) {
      const r = target.getBoundingClientRect();
      clip = { x: 0, y: Math.max(0, r.top + window.scrollY - 220), width: window.innerWidth, height: 900, scale: 1 };
    }
  }

  const found = [];
  for (const m of ${JSON.stringify(marksList)}) {
    const el = findBox(m.text);
    if (!el) { found.push({ text: m.text, ok: false }); continue; }
    el.classList.add('wv-anno');
    el.setAttribute('data-wv', m.label || m.text);
    found.push({ text: m.text, ok: true, box: el.getBoundingClientRect().toJSON() });
  }
  return JSON.stringify({ found, vw: innerWidth, vh: innerHeight, clip });
})()
`;

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    '--force-device-scale-factor=2',
    '--window-size=1440,950',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=/tmp/waker-verify-profile-${Date.now()}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);

let client;
try {
  const wsUrl = await waitCdp();
  client = connect(wsUrl);
  await client.ready;

  const { targetId } = await client.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true });
  await client.send('Page.enable', {}, sessionId);
  await client.send('Page.navigate', { url }, sessionId);
  // 看板首屏要拉 /api/board + 会话列表 + 用量，给足时间；固定等待比监听事件稳
  await sleep(6000);

  if (clickText) {
    const clicked = await client.send(
      'Runtime.evaluate',
      {
        expression: `(() => {
          const leaf = [...document.querySelectorAll('body *')]
            .find((el) => el.children.length === 0 && (el.textContent || '').trim().includes(${JSON.stringify(clickText)}));
          if (!leaf) return 'not-found';
          leaf.click();
          return 'clicked: ' + (leaf.textContent || '').trim().slice(0, 60);
        })()`,
        returnByValue: true,
      },
      sessionId,
    );
    console.log(clicked.result.value);
    await sleep(1500);
  }

  if (script) {
    // 传进来的是一段函数体/箭头函数，必须**调用**它：直接 eval 只会得到函数对象（也就是 `{}`）
    const r = await client.send(
      'Runtime.evaluate',
      { expression: `(${script})()`, returnByValue: true, awaitPromise: true },
      sessionId,
    );
    if (r.exceptionDetails) console.error(`脚本抛错：${r.exceptionDetails.text ?? ''}`);
    console.log(`脚本：${JSON.stringify(r.result?.value ?? null)}`);
    await sleep(500);
  }

  if (typeText) {
    const focused = await client.send(
      'Runtime.evaluate',
      {
        expression: `(() => {
          const el = document.querySelector(${JSON.stringify(typeSelector)});
          if (!el) return 'not-found';
          el.focus();
          return 'focused';
        })()`,
        returnByValue: true,
      },
      sessionId,
    );
    console.log(`输入框 ${focused.result.value}`);
    // 用 insertText 而不是直接改 value：受控组件只认真实输入事件
    await client.send('Input.insertText', { text: typeText }, sessionId);
    await sleep(300);
  }

  if (submit) {
    // ⌘+Enter（modifiers=4 是 Meta）。界面的 onKeyDown 就是这么接的。
    for (const type of ['keyDown', 'keyUp']) {
      await client.send(
        'Input.dispatchKeyEvent',
        { type, modifiers: 4, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 },
        sessionId,
      );
    }
    await sleep(waitAfterSubmit);
  }

  if (afterClick) {
    const clicked = await client.send(
      'Runtime.evaluate',
      {
        expression: `(() => {
          const own = (el) => [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('');
          const all = [...document.querySelectorAll('body *')];
          const hit = all.find((el) => own(el).includes(${JSON.stringify(afterClick)}))
            ?? all.find((el) => el.children.length === 0 && (el.textContent || '').trim().includes(${JSON.stringify(afterClick)}));
          if (!hit) return 'not-found';
          const btn = hit.closest('button, a[href]') ?? hit;
          btn.click();
          return 'clicked: ' + (btn.textContent || '').trim().slice(0, 40);
        })()`,
        returnByValue: true,
      },
      sessionId,
    );
    console.log(clicked.result.value);
    await sleep(waitAfterClick);
  }

  const res = await client.send(
    'Runtime.evaluate',
    { expression: inject(marks, scrollTo), returnByValue: true, awaitPromise: true },
    sessionId,
  );
  const info = JSON.parse(res.result.value);

  const shot = await client.send(
    'Page.captureScreenshot',
    info.clip
      ? { format: 'png', clip: info.clip, captureBeyondViewport: true }
      : { format: 'png' },
    sessionId,
  );
  const file = resolve(out);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, Buffer.from(shot.data, 'base64'));

  const missed = info.found.filter((f) => !f.ok).map((f) => f.text);
  console.log(`已截图 ${file}（${info.vw}×${info.vh}，标注 ${info.found.length - missed.length}/${info.found.length}）`);
  if (missed.length) console.error(`未找到的标注目标：${missed.join('、')}`);
} finally {
  client?.close();
  chrome.kill('SIGKILL');
  await sleep(300);
  for (const dir of ['/tmp']) {
    // 清理临时 profile（保留其它目录）
    try {
      const { readdirSync } = await import('node:fs');
      for (const name of readdirSync(dir)) {
        if (name.startsWith('waker-verify-profile-')) rmSync(`${dir}/${name}`, { recursive: true, force: true });
      }
    } catch {
      /* 忽略 */
    }
  }
}
