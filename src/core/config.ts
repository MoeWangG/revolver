import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from './paths.ts';

/**
 * 平台级配置（`data/config.json`）。
 *
 * 与 per-profile 的 `agents/<id>/waker.yaml` 是两层：
 * - `waker.yaml` 管**一个员工**（岗位、模型、策略、渠道）；
 * - 这里管**整个平台**的行为开关。
 *
 * `data/` 是运行期目录（已 gitignore），所以默认值写在代码里，
 * 文件只存"用户显式改过什么"——新克隆的仓库天然是默认行为。
 */
export const CONFIG_FILE = join(DATA_DIR, 'config.json');

export interface PlatformConfig {
  /**
   * 是否**自动纳管** Pi 侧的 agent profile（`~/.pi/agent/agents/*.md`）。
   *
   * 默认 **false**：Pi 那边的 agent 不会出现在看板名册里，`waker say <piId>` 也找不到它。
   * 想用某个本机 agent，走 `waker import <id>`（或看板「导入本机 agent」）——
   * 导入后它是**平台档案**，与 Pi 侧解耦：能改策略、能版本化、能归档。
   *
   * 置 true 等于回到"只读纳管"：Pi 侧全部 profile 以 `Pi` 徽标直接出现在名册里，
   * 人设正文可编辑，但名称/岗位/模型由 frontmatter 决定，且平台不能归档（只读）。
   */
  piAgents: boolean;

  /**
   * 会话自动瘦身（上下文压缩）。
   *
   * 对话是长跑的，pi 的会话文件只增不减：实测一条飞书私聊涨到 147KB（≈4 万 token），
   * 之后**每条新消息都把整段带上** —— 又贵，又容易把旧话题带进新问题。
   * 超过 `maxTokens` 就把历史压成一份 `keepTokens` 大小的纪要，归档原文、把纪要种回新会话。
   */
  context: ContextConfig;

  /**
   * **常驻**防睡眠（看板「工具 → 系统」里的开关）。
   *
   * 与"任务运行期间防睡眠"是两件事：那个是随每个 pi 子进程临时起落的断言，
   * 只覆盖"有任务在跑"的那几分钟；这个是**一直持有**的断言，
   * 关掉后立刻释放。默认 **false**（不改变系统原有行为）。
   *
   * 断言绑的是**看板进程 pid**，所以进程退出/崩溃时自动解除，不会留孤儿；
   * 看板重启会按这个配置自动恢复。合盖睡眠防不住（系统层面强制），见 power.ts。
   */
  preventSleep: boolean;
}

/** 会话瘦身参数。 */
export interface ContextConfig {
  /** 关掉就永远不自动压缩（手动 `waker compact` 仍可用）。 */
  enabled: boolean;
  /** 触发阈值：会话估算 token 超过它就压缩。默认 30000（≈100KB JSONL）。 */
  maxTokens: number;
  /** 压缩目标：纪要的规模上限（估算 token，同时作为纪要字数上限）。默认 6000。 */
  keepTokens: number;
}

const DEFAULT_CONTEXT: ContextConfig = { enabled: true, maxTokens: 30_000, keepTokens: 6000 };

const DEFAULTS: PlatformConfig = { piAgents: false, context: { ...DEFAULT_CONTEXT }, preventSleep: false };

/** 环境变量覆盖（临时开关，便于脚本与排障）：WAKER_PI_AGENTS=on|off */
function envPiAgents(): boolean | undefined {
  const v = (process.env.WAKER_PI_AGENTS ?? '').trim().toLowerCase();
  if (['1', 'on', 'true', 'yes'].includes(v)) return true;
  if (['0', 'off', 'false', 'no'].includes(v)) return false;
  return undefined;
}

/** 解析 context 段：**逐字段回落默认**，半截配置不会把阈值变成 0（阈值 0 = 每轮都压缩）。 */
export function parseContext(raw: unknown): ContextConfig {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const num = (k: keyof ContextConfig, dflt: number, min: number): number => {
    const v = o[k];
    return typeof v === 'number' && Number.isFinite(v) && v >= min ? v : dflt;
  };
  return {
    enabled: typeof o.enabled === 'boolean' ? o.enabled : DEFAULT_CONTEXT.enabled,
    maxTokens: num('maxTokens', DEFAULT_CONTEXT.maxTokens, 1000),
    keepTokens: num('keepTokens', DEFAULT_CONTEXT.keepTokens, 200),
  };
}

/** 按 mtime 缓存文件解析结果：`loadAllWakers()` 每次看板刷新都会问，不能每次读盘。 */
let cache: { mtimeMs: number; value: PlatformConfig } | null = null;

function readFileConfig(): PlatformConfig {
  if (!existsSync(CONFIG_FILE)) return { ...DEFAULTS };
  try {
    const st = statSync(CONFIG_FILE);
    if (cache && cache.mtimeMs === st.mtimeMs) return cache.value;
    const raw = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8')) as Record<string, unknown>;
    const value: PlatformConfig = {
      // 非布尔一律回落到默认，避免半截文件把平台带进意外状态
      piAgents: typeof raw.piAgents === 'boolean' ? raw.piAgents : DEFAULTS.piAgents,
      context: parseContext(raw.context),
      preventSleep: typeof raw.preventSleep === 'boolean' ? raw.preventSleep : DEFAULTS.preventSleep,
    };
    cache = { mtimeMs: st.mtimeMs, value };
    return value;
  } catch {
    // 文件损坏：用默认值，但不写回（避免把坏文件悄悄改掉）
    return { ...DEFAULTS };
  }
}

export function loadConfig(): PlatformConfig {
  const file = readFileConfig();
  const env = envPiAgents();
  return env === undefined ? file : { ...file, piAgents: env };
}

/** 是否自动纳管 Pi 侧的 agent（`loadWaker` / `loadAllWakers` 用它决定要不要扫 Pi 目录）。 */
export function piAgentsEnabled(): boolean {
  return loadConfig().piAgents;
}

/** 合并写入配置（保留文件里已有的未知键，便于将来加配置项而不丢用户改动）。 */
export function saveConfig(patch: Partial<PlatformConfig>): PlatformConfig {
  let raw: Record<string, unknown> = {};
  if (existsSync(CONFIG_FILE)) {
    try {
      raw = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8')) as Record<string, unknown>;
    } catch {
      raw = {};
    }
  }
  // 丢掉值为 undefined 的键：否则 { context: undefined } 会把文件里已有的 context 段冲掉（回落默认）
  const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as Partial<PlatformConfig>;
  const next = { ...raw, ...clean };
  // context 逐字段合并：只改 maxTokens 时不该把 keepTokens 冲掉
  if (clean.context) next.context = { ...parseContext(raw.context), ...clean.context };
  writeFileSync(CONFIG_FILE, `${JSON.stringify(next, null, 2)}\n`, 'utf-8');
  cache = null; // 让下一次读取重新解析
  return loadConfig();
}

/** 配置文件是否真实存在过（用于 CLI/看板提示"这是默认值还是你设过"）。 */
export function configFileExists(): boolean {
  return existsSync(CONFIG_FILE);
}
