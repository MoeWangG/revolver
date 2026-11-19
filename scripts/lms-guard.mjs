#!/usr/bin/env node
/**
 * lms-guard — 本地推理服务守门：保证 1234 上的 LM Studio "在跑、模型在加载态"。
 *
 * ## 为什么需要它
 *
 * 平台有两处能力寄生在 LM Studio（`http://127.0.0.1:1234/v1`），它们都**不会**因为
 * 服务挂了而报错——只会静默降级，比崩溃更难发现：
 *   1. 话题召回 / 仲裁：`bge-m3` 算余弦，`laya` 走 `/v1/systemone` 决策；
 *      两个都不在时，路由退回词面 Jaccard + 固定阈值，"换话题"判断明显变钝。
 *   2. 记忆中心：`embedding.base_url` 指向同一处，嵌入挂了召回就空。
 *
 * 实测过的最坑形态是"LM Studio 进程开着，但 `laya` 是 `not-loaded`"——
 * 端口探活 200，看板一切正常，只有仲裁层悄悄退化成阈值判定。
 * 所以判据不能是"端口通"，必须是 `/api/v0/models` 里每个必需模型的 `state === loaded`。
 *
 * ## 它做什么（按顺序，每一步都幂等）
 *
 *   1. 探 `/api/v0/models`；不通就 `lms server start`，再不通就后台打开 LM Studio，等 120s
 *   2. 缺哪个模型就 `lms get <repo> --gguf -y` 下载（首次装机才会走到）
 *   3. 有但没加载就 `lms load <key> --identifier <key> --gpu max -y`
 *   4. 复探确认，把每个模型最终状态打成一行
 *
 * ## 怎么跑
 *
 *   node scripts/lms-guard.mjs            # 手动
 *   由 launchd `com.waker.lms-guard` 每 5 分钟跑一次（StartInterval，不是常驻）
 *
 * 退出码：0 = 全部就绪（含"无需动作"）；1 = 有模型没就绪（错误详情在日志）。
 * 单飞锁在 `~/.waker/lms-guard.lock`：下载可能跑几分钟，不能每 5 分钟叠一个。
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const BASE = (process.env.WAKER_LLM_BASE_URL ?? 'http://127.0.0.1:1234/v1').replace(/\/+$/, '');
/**
 * `/api/v0/*` 在**根**上，不在 `/v1` 下：打 `/v1/api/v0/models` 会 200 回
 * `{"error":"Unexpected endpoint or method..."}`——HTTP 是通的，但解析出来没有 data，
 * 于是"模型全都不存在"，守门会去下载已经装好的模型（本次就踩了）。
 */
const ROOT = BASE.replace(/\/v1$/, '');
const EMBED = process.env.WAKER_EMBED_MODEL ?? 'text-embedding-bge-m3';
const ARBITER = process.env.WAKER_ARBITER_MODEL ?? 'laya';

/** 必需模型 → 缺失时的下载来源（gguf 仓库；`lms get` 会挑默认量化）。可用环境变量改。 */
const REQUIRED = [
  { key: EMBED, repo: process.env.WAKER_EMBED_REPO ?? 'gpustack/bge-m3-GGUF' },
  { key: ARBITER, repo: process.env.WAKER_ARBITER_REPO ?? 'ggml-org/Laya-GGUF' },
];

const LOCK = join(homedir(), '.waker', 'lms-guard.lock');
/** 下载失败的时间戳：30 分钟内不再尝试，避免网络不通时每轮都卡满超时。 */
const DOWNLOAD_FAILED = join(homedir(), '.waker', 'lms-guard.download-failed');
const DOWNLOAD_BACKOFF_MS = 30 * 60_000;
const LMS = [
  process.env.LMS_BIN,
  join(homedir(), '.lmstudio', 'bin', 'lms'),
  '/usr/local/bin/lms',
  '/opt/homebrew/bin/lms',
].find((p) => p && existsSync(p));

const log = (msg) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 跑一条命令，永不抛：把 stdout/stderr 尾部带回去，排障不靠猜。 */
function run(cmd, args, timeoutMs = 60_000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      const tail = (s) => String(s ?? '').trim().split('\n').slice(-3).join(' | ');
      resolve({ ok: !err, out: tail(stdout), err: err ? tail(stderr) || err.message : '' });
    });
  });
}

/** 探服务：返回 Map<modelId, state>；服务不通返回 null。 */
async function probeModels() {
  try {
    const r = await fetch(`${ROOT}/api/v0/models`, { signal: AbortSignal.timeout(2500) });
    if (!r.ok) return null;
    const body = await r.json();
    const rows = Array.isArray(body?.data) ? body.data : null;
    if (!rows) return null; // 端口通但不是 LM Studio（或被代理劫持）：当作不可用，交给启动分支
    return new Map(rows.map((m) => [String(m.id), String(m.state ?? '')]));
  } catch {
    return null;
  }
}

/** 距上次下载失败多久（毫秒）；不在退避窗口内返回 0。 */
function failedRecently() {
  try {
    const age = Date.now() - Number(readFileSync(DOWNLOAD_FAILED, 'utf-8').trim());
    return age >= 0 && age < DOWNLOAD_BACKOFF_MS ? age : 0;
  } catch {
    return 0;
  }
}

async function waitForServer(totalMs) {
  const deadline = Date.now() + totalMs;
  while (Date.now() < deadline) {
    const models = await probeModels();
    if (models) return models;
    await sleep(2000);
  }
  return null;
}

/** 服务不在：先问 CLI（能起服务就少开一个窗口），不行再开 App。 */
async function ensureServer() {
  let models = await probeModels();
  if (models) return models;

  if (LMS) {
    log('LM Studio 未响应 → lms server start');
    const r = await run(LMS, ['server', 'start'], 90_000);
    if (!r.ok) log(`  server start 未成功：${r.err || r.out}`);
    models = await waitForServer(30_000);
    if (models) return models;
  }

  log('仍未响应 → 后台打开 LM Studio（-g 不抢焦点）');
  await run('open', ['-gja', 'LM Studio'], 20_000);
  models = await waitForServer(120_000);
  if (!models) return null;
  return models;
}

async function main() {
  // —— 单飞：上一次还在下载/加载时直接退出，不要叠进程抢同一个 1234 ——
  mkdirSync(join(homedir(), '.waker'), { recursive: true });
  if (existsSync(LOCK)) {
    const pid = Number(readFileSync(LOCK, 'utf-8').trim());
    const alive = pid > 0 && (() => { try { process.kill(pid, 0); return true; } catch { return false; } })();
    if (alive) {
      log(`已有守卫在跑（pid ${pid}），本次跳过`);
      return 0;
    }
    log(`清理残留锁（pid ${pid} 已不在）`);
    rmSync(LOCK, { force: true });
  }
  writeFileSync(LOCK, String(process.pid));

  try {
    if (!LMS) {
      log('找不到 lms CLI（~/.lmstudio/bin/lms）：LM Studio 未安装？向量与仲裁都会降级');
      return 1;
    }

    let models = await ensureServer();
    if (!models) {
      log('LM Studio 启动失败：120s 内 /api/v0/models 仍不可达');
      return 1;
    }

    let bad = 0;
    for (const { key, repo } of REQUIRED) {
      if (!models.has(key)) {
        // 下载是最贵的一步：网络不通时每 5 分钟卡 10 分钟毫无意义，
        // 失败后 30 分钟内不再重试，日志里留明原因。
        const recent = failedRecently();
        if (recent) {
          log(`缺模型 ${key}，但 ${Math.round(recent / 60000)} 分钟前下载失败过，本次跳过（等下一次窗口）`);
          bad++;
          continue;
        }
        log(`缺模型 ${key} → lms get ${repo}（首次下载，可能要几分钟）`);
        const r = await run(LMS, ['get', repo, '--gguf', '-y'], 10 * 60_000);
        if (r.ok) {
          log(`  下载完成：${r.out}`);
          rmSync(DOWNLOAD_FAILED, { force: true });
        } else {
          log(`  下载失败：${r.err || r.out}`);
          writeFileSync(DOWNLOAD_FAILED, String(Date.now()));
        }
        models = (await probeModels()) ?? models;
        if (!models.has(key)) {
          log(`  ✗ ${key} 仍不在本机模型列表里`);
          bad++;
          continue;
        }
      }

      const state = models.get(key);
      if (state === 'loaded' || state === 'loading') {
        log(`✓ ${key} ${state}`);
        continue;
      }

      log(`${key} 状态 ${state || '未知'} → lms load`);
      const r = await run(LMS, ['load', key, '--identifier', key, '--gpu', 'max', '-y'], 5 * 60_000);
      if (!r.ok) log(`  load 输出：${r.err || r.out}`);
      models = (await probeModels()) ?? models;
      const after = models.get(key);
      if (after === 'loaded' || after === 'loading') log(`✓ ${key} ${after}`);
      else {
        log(`  ✗ ${key} 加载后仍是 ${after || '未知'}`);
        bad++;
      }
    }

    if (bad) {
      log(`有 ${bad} 个模型没就绪：话题仲裁 / 记忆召回会静默降级`);
      return 1;
    }
    log('全部就绪（embedding + 仲裁模型均在加载态）');
    return 0;
  } finally {
    rmSync(LOCK, { force: true });
  }
}

process.exitCode = await main();
