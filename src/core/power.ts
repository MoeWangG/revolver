/**
 * 任务运行期间阻止 Mac 空闲睡眠。
 *
 * **为什么需要**：waker 的活动辄几十秒到几分钟（长会话更久），macOS 默认几分钟无操作就睡——
 * 一睡，pi 子进程被挂起，飞书那边就是"@ 了没反应"，定时任务也会整批错过。
 *
 * **为什么是 `caffeinate -i -w <pid>`**：
 * - `caffeinate` 是 macOS 自带的电源断言工具，不装任何东西；
 * - `-w <pid>` 让断言**随被监视的 pi 进程退出而自动解除**——不用记着清理，
 *   任务被终止（SIGTERM/SIGKILL）、正常结束、甚至崩溃，断言都会跟着消失，不会泄漏；
 * - 用 `-i`（防空闲睡眠）而不是 `-s`（防系统睡眠）：合盖睡眠在电池供电下系统**强制执行**，
 *   `-s` 只在接电源时有效——这个限制要如实告诉用户，而不是假装防住了。
 *
 * 边界（都是刻意选择）：
 * - **不防合盖**：电池下系统会强制睡眠，防不住就是防不住，文档里写明；
 * - **不碰 `pmset`**：全局改电源策略影响整台机器，越权了；
 * - `WAKER_NO_CAFFEINATE=1` 可整体关闭（比如你想让 Mac 该睡就睡）。
 *  caffeinate 不存在（非 macOS / 被删）时静默跳过，绝不因此挡住任务。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { loadConfig, saveConfig } from './config.ts';

const CAFFEINATE = '/usr/bin/caffeinate';

/** 在 `pid`（pi 子进程）存活期间阻止系统空闲睡眠。 */
export function keepAwakeWhile(pid: number | undefined, label: string): void {
  if (!pid) return;
  if (process.platform !== 'darwin') return;
  if (process.env.WAKER_NO_CAFFEINATE === '1') return;
  if (!existsSync(CAFFEINATE)) return;
  try {
    const guard = spawn(CAFFEINATE, ['-i', '-w', String(pid)], { stdio: 'ignore' });
    guard.on('error', (e) => console.error(`[power] caffeinate 启动失败（${label}）:`, (e as Error).message));
    // 正常路径：pi 退出 → caffeinate 随 -w 自动退出 → 断言解除。打一行日志方便确认没有泄漏。
    guard.on('exit', () => console.log(`[power] 防睡眠断言已随任务结束释放（${label}）`));
    console.log(`[power] 任务运行期间阻止空闲睡眠（${label}，断言绑定 pid=${pid}）`);
  } catch (e) {
    console.error(`[power] 防睡眠启动失败（${label}）:`, (e as Error)?.message ?? e);
  }
}

// ——————————————————————————————————————————————————————————————
// 常驻防睡眠开关（看板「工具 → 系统」里的那个开关）
// ——————————————————————————————————————————————————————————————

/**
 * 常驻断言的状态。给 CLI 与看板共用，所以字段都做成"能直接显示"的。
 */
export interface SleepGuardStatus {
  /** 这台机器/这个进程能不能持断言（非 macOS、找不到 caffeinate、被环境变量关掉都不行）。 */
  supported: boolean;
  /** 配置里的开关（用户在界面上点的那个）。 */
  enabled: boolean;
  /** 断言进程**真的在跑**（enabled 但 active=false 说明没起来）。 */
  active: boolean;
  /** caffeinate 进程 pid。 */
  pid?: number;
  /** 什么时候开的（ISO 时间）。 */
  since?: string;
  /** 当前状态的补充说明（不支持的原因 / 起来了但失效了）。 */
  note?: string;
}

/** 常驻断言进程。为 null 表示没起。 */
let persistent: { child: ChildProcess; pid: number; since: string } | null = null;

/** 当前环境不支持常驻断言的原因（null = 支持）。 */
function unsupportedReason(): string | null {
  if (process.platform !== 'darwin') return `当前系统（${process.platform}）没有 caffeinate，只有 macOS 能防睡眠`;
  if (process.env.WAKER_NO_CAFFEINATE === '1') return 'WAKER_NO_CAFFEINATE=1 已把防睡眠整体关闭（含任务期间那一路）';
  if (!existsSync(CAFFEINATE)) return `找不到 ${CAFFEINATE}`;
  return null;
}

/**
 * 停掉常驻断言。
 *
 * 正常情况下不需要显式调用：断言绑的是**本进程 pid**（`-w`），进程一死 caffeinate 自动退出。
 * 这里保留显式停止能力，用于"用户关掉开关"和"进程正常退出前收尾"。
 */
export function stopSleepGuard(): void {
  if (!persistent) return;
  try {
    persistent.child.kill();
  } catch {
    /* 可能已经退出了 */
  }
  persistent = null;
  console.log('[power] 常驻防睡眠断言已停止');
}

/**
 * 读状态。**不启动任何东西**，可以随便调（看板每次打开工具弹窗都会问）。
 */
export function getSleepGuard(): SleepGuardStatus {
  const enabled = loadConfig().preventSleep === true;
  const why = unsupportedReason();
  const active = persistent !== null;
  const base: SleepGuardStatus = { supported: why === null, enabled, active };
  if (active && persistent) {
    base.pid = persistent.pid;
    base.since = persistent.since;
  }
  if (why) base.note = why;
  else if (enabled && !active) base.note = '开关是开的，但断言进程没在跑（重新开关一次即可；看板重启也会按配置自动恢复）';
  return base;
}

/**
 * 开关常驻防睡眠。
 *
 * 写入 `data/config.json` 的 `preventSleep`，并立即起停断言。**返回写入后的真实状态**——
 * 不支持的环境里开关会照样被记下来，但 `active=false` + `note` 说明为什么，
 * 不假装成功了。
 */
export function setPreventSleep(on: boolean): SleepGuardStatus {
  // 开关本身永远记下来：换成能用的环境（或去掉 WAKER_NO_CAFFEINATE）后下次启动就生效，
  // 不用要求用户"到那台机器上再点一次"。
  saveConfig({ preventSleep: on });
  if (on) startAssertion();
  else stopSleepGuard();
  return getSleepGuard();
}

/** 真正起断言。不碰配置，失败只打日志（调用方用 `getSleepGuard()` 看结果）。 */
function startAssertion(): void {
  if (persistent) return;
  if (unsupportedReason()) return;

  try {
    // 参数取舍：
    // - `-i` 防空闲睡眠（电池下也有效，这是主力）；
    // - `-s` 防系统睡眠（**仅接电源有效**，电池下系统会忽略它）；
    // - `-w <本进程 pid>` 让断言随看板进程死掉自动解除，不会留孤儿；
    // - 不加 `-d`：屏幕该黑就黑，用户要的是"机器别睡"，不是"屏幕别关"。
    const child = spawn(CAFFEINATE, ['-i', '-s', '-w', String(process.pid)], { stdio: 'ignore' });
    // **必须 unref**：断言绑的是我们自己，不 unref 的话 Node 会等这个子进程退出才肯退出——
    // 而它只在（我们退出后）才退，CLI 里就是一个必然的死锁。
    child.unref();
    child.on('error', (e) => {
      console.error('[power] 常驻防睡眠启动失败:', (e as Error).message);
      if (persistent?.child === child) persistent = null;
    });
    child.on('exit', () => {
      if (persistent?.child === child) {
        persistent = null;
        console.log('[power] 常驻防睡眠断言已结束（进程退出，配置仍是开启）');
      }
    });
    persistent = { child, pid: child.pid ?? -1, since: new Date().toISOString() };
    console.log(`[power] 常驻防睡眠已开启（caffeinate -i -s，绑定本进程 pid=${process.pid}）`);
  } catch (e) {
    console.error('[power] 常驻防睡眠启动异常:', (e as Error)?.message ?? e);
  }
}

/**
 * 看板启动时调它：按配置恢复上次的开关状态。
 *
 * 只在启动时起断言、**不写配置**——开关是用户点过的，重启不该再去动 `config.json`。
 */
export function applySleepGuard(): SleepGuardStatus {
  if (loadConfig().preventSleep === true) startAssertion();
  return getSleepGuard();
}

/** 进程正常退出前收尾。`-w` 已经能兜住，这只是让 `pmset` 立刻干净。 */
process.on('exit', () => {
  try {
    persistent?.child.kill();
  } catch {
    /* 忽略 */
  }
});
