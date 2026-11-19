import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type {
  ChannelsConfig,
  LlmConfig,
  SessionConfig,
  WakerDef,
  WakerIssue,
  WakerPolicy,
  WakerRecord,
} from '../types.ts';
import { AGENTS_DIR, CHANNELS_DIR, PLATFORM_ROOT, agentDir, safeId } from './paths.ts';
import { listPiProfileIds, listPiProfiles, loadPiProfile, splitFrontmatter, type PiProfile } from './piProfiles.ts';
import { piAgentsEnabled } from './config.ts';

const DEFAULT_POLICY: WakerPolicy = {
  sandbox: false,
  pathDeny: ['.ssh', '.aws', '.npmrc', '.netrc', 'id_rsa', '.pypirc', '.docker/config.json'],
  commandDeny: ['rm -rf /', 'mkfs', ':(){', 'chmod -R 777 /', 'dd if='],
  commandTimeoutMs: 120_000,
};

// —— 配置解析辅助 ——

function asMap(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function optStr(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function optBool(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
}

function optStrArr(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.filter((x): x is string => typeof x === 'string');
}

/** 只保留有值的键，用于让 secrets.json 精确覆盖 waker.yaml 的对应字段。 */
function definedOnly(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ''));
}

/** 密钥来源：优先平台侧 `data/channels/<id>.secret.json`，回退 `agents/<id>/secrets.json`。 */
function readSecrets(id: string, dir: string): Record<string, unknown> {
  const candidates = [join(CHANNELS_DIR, `${safeId(id)}.secret.json`), dir ? join(dir, 'secrets.json') : ''];
  for (const p of candidates) {
    if (!p || !existsSync(p)) continue;
    try {
      return asMap(JSON.parse(readFileSync(p, 'utf-8')));
    } catch {
      /* 损坏则继续找下一个来源 */
    }
  }
  return {};
}

/** 渠道配置来源：优先平台侧 `data/channels/<id>.json`，回退 `agents/<id>/channel.json`。 */
function readChannelFile(id: string, dir: string): Record<string, unknown> {
  const candidates = [join(CHANNELS_DIR, `${safeId(id)}.json`), dir ? join(dir, 'channel.json') : ''];
  for (const p of candidates) {
    if (!p || !existsSync(p)) continue;
    try {
      return asMap(JSON.parse(readFileSync(p, 'utf-8')));
    } catch {
      /* 损坏则继续找下一个来源 */
    }
  }
  return {};
}

/** 解析 per-profile 的 LLM 配置：waker.yaml 打底，secrets.json 覆盖敏感项。 */
function parseLlm(raw: Record<string, unknown>, secrets: Record<string, unknown>): LlmConfig | undefined {
  const merged = { ...asMap(raw.llm), ...definedOnly(asMap(secrets.llm)) };
  if (!Object.keys(merged).length) return undefined;
  return {
    provider: optStr(merged.provider),
    model: optStr(merged.model),
    apiKey: optStr(merged.apiKey),
    baseUrl: optStr(merged.baseUrl),
    thinking: optStr(merged.thinking),
  };
}

/** 解析 per-profile 的渠道配置（当前为飞书），每个 bot 可挂一套独立应用凭证。 */
function parseChannels(
  raw: Record<string, unknown>,
  secrets: Record<string, unknown>,
  channelCfg: Record<string, unknown>,
): ChannelsConfig | undefined {
  // 优先级：waker.yaml < channel.json（看板编辑）< secrets.json（密钥）
  const fsRaw = {
    ...asMap(asMap(raw.channels).feishu),
    ...definedOnly(asMap(channelCfg.feishu)),
    ...definedOnly(asMap(asMap(secrets).feishu)),
  };
  if (!Object.keys(fsRaw).length) return undefined;
  return {
    feishu: {
      enabled: optBool(fsRaw.enabled),
      agent: optStr(fsRaw.agent),
      appId: optStr(fsRaw.appId),
      appSecret: optStr(fsRaw.appSecret),
      allowedUsers: optStrArr(fsRaw.allowedUsers),
      allowedChats: optStrArr(fsRaw.allowedChats),
      allowAllChats: optBool(fsRaw.allowAllChats),
      allowAllUsers: optBool(fsRaw.allowAllUsers),
      ackEmoji: optStr(fsRaw.ackEmoji),
    },
  };
}

const LOCAL_ORIGIN = 'local' as const;

/**
 * 把未经校验的 YAML 对象收敛成 WakerDef。
 * 设计取向：**缺字段补默认并记 warn，只有致命缺失才 error**。
 * 这样单个档案写错不会导致整个 registry 加载失败。
 */
function normalize(
  id: string,
  raw: Record<string, unknown>,
  secrets: Record<string, unknown> = {},
  channelCfg: Record<string, unknown> = {},
): { def: WakerDef; issues: WakerIssue[] } {
  const issues: WakerIssue[] = [];
  const str = (key: string, fallback: string): string => {
    const v = raw[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (v !== undefined) issues.push({ level: 'warn', field: key, message: '缺失或非字符串，已使用默认值' });
    return fallback;
  };

  const rawPolicy = (raw.policy ?? {}) as Record<string, unknown>;
  const strArr = (v: unknown, field: string): string[] | undefined => {
    if (v === undefined) return undefined;
    if (!Array.isArray(v)) {
      issues.push({ level: 'warn', field, message: '应为数组，已忽略' });
      return undefined;
    }
    return v.filter((x): x is string => typeof x === 'string');
  };

  const policy: WakerPolicy = {
    sandbox: rawPolicy.sandbox === true,
    toolAllow: strArr(rawPolicy.toolAllow, 'policy.toolAllow'),
    toolDeny: strArr(rawPolicy.toolDeny, 'policy.toolDeny'),
    commandAllow: strArr(rawPolicy.commandAllow, 'policy.commandAllow'),
    commandDeny: strArr(rawPolicy.commandDeny, 'policy.commandDeny') ?? DEFAULT_POLICY.commandDeny,
    pathAllow: strArr(rawPolicy.pathAllow, 'policy.pathAllow'),
    pathDeny: strArr(rawPolicy.pathDeny, 'policy.pathDeny') ?? DEFAULT_POLICY.pathDeny,
    requireConfirm: strArr(rawPolicy.requireConfirm, 'policy.requireConfirm'),
    sandboxImage: typeof rawPolicy.sandboxImage === 'string' ? rawPolicy.sandboxImage : undefined,
    sandboxNetwork: rawPolicy.sandboxNetwork === true,
    commandTimeoutMs:
      typeof rawPolicy.commandTimeoutMs === 'number' ? rawPolicy.commandTimeoutMs : DEFAULT_POLICY.commandTimeoutMs,
    // 档案自改开关。这里的解析是**逐字段白名单**，不显式列出就会被静默丢掉（默认关闭）
    selfEdit: rawPolicy.selfEdit === true,
    // 浏览器能力开关。同上：漏这一行 = 界面上开了、yaml 里写了，但 guard 与 runner 永远看不到
    browser: rawPolicy.browser === true,
  };

  // 会话策略：**逐字段白名单**，与 policy 同样的取向——写错的字段回落默认并记 warn，
  // 只有 mode 拼错才会被静默纠正成 single（那是最安全的兜底）。
  const rawSession = (raw.session ?? {}) as Record<string, unknown>;
  let sessionMode: SessionConfig['mode'] = 'single';
  if (rawSession.mode !== undefined) {
    if (rawSession.mode === 'topic' || rawSession.mode === 'single' || rawSession.mode === 'timeWindow') {
      sessionMode = rawSession.mode;
    } else {
      issues.push({
        level: 'warn',
        field: 'session.mode',
        message: '只能是 single / topic / timeWindow，已按 single 处理',
      });
    }
  }
  const num = (v: unknown, d: number, min: number, max: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : d;
  /** 小数用这个：阈值是 0.55 这种，四舍五入会变成 1。 */
  const dec = (v: unknown, d: number, min: number, max: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : d;
  const rawSummary = (rawSession.summary ?? {}) as Record<string, unknown>;
  const rawSemantic = (rawSession.semantic ?? {}) as Record<string, unknown>;
  /**
   * 仲裁模型配置。**必须在这里解析**：`SessionConfig.arbiter` 一直有字段，
   * 但长期没进白名单，导致 waker.yaml 里写 `arbiter:` 会被静默丢弃、
   * 实际永远用 DEFAULT_ARBITER_CONFIG（laya）。换模型时踩过一次——以为改了配置，其实没生效。
   */
  const rawArbiter = (rawSession.arbiter ?? {}) as Record<string, unknown>;
  const session: SessionConfig = {
    mode: sessionMode,
    idleSplitHours:
      typeof rawSession.idleSplitHours === 'number' && rawSession.idleSplitHours >= 0
        ? rawSession.idleSplitHours
        : 8,
    ask: rawSession.ask === 'never' ? 'never' : 'always',
    rejectLimit:
      typeof rawSession.rejectLimit === 'number' && rawSession.rejectLimit > 0 ? rawSession.rejectLimit : 2,
    // 默认允许自动切（旧行为）；只有显式写 false 才变成"永远先问"
    autoSwitch: rawSession.autoSwitch !== false,
    // 默认开启：不配这项也该有名字，否则 web 端永远停在「默认会话」
    autoName: rawSession.autoName !== false,
    // 会话卡：缺省即用推荐值。全部夹在合理区间内，写错不会变成"每次都跑"或"永远不跑"。
    summary: {
      model:
        typeof rawSummary.model === 'string' && rawSummary.model.trim() ? rawSummary.model.trim() : undefined,
      maxChars: num(rawSummary.maxChars, 200, 80, 600),
      idleMinutes: num(rawSummary.idleMinutes, 10, 1, 240),
      minNewMessages: num(rawSummary.minNewMessages, 4, 2, 50),
      perSessionDaily: num(rawSummary.perSessionDaily, 6, 1, 50),
      globalHourly: num(rawSummary.globalHourly, 20, 1, 200),
      timeoutMs: num(rawSummary.timeoutMs, 15000, 3000, 120000),
    },
    arbiter: {
      enabled: rawArbiter.enabled !== false,
      baseUrl:
        typeof rawArbiter.baseUrl === 'string' && rawArbiter.baseUrl.trim()
          ? rawArbiter.baseUrl.trim()
          : 'http://127.0.0.1:1234/v1',
      model:
        typeof rawArbiter.model === 'string' && rawArbiter.model.trim() ? rawArbiter.model.trim() : 'laya',
      timeoutMs: num(rawArbiter.timeoutMs, 6000, 500, 30000),
      // auto = 先 systemone 后退 chat；换了指令模型必须显式写 chat，否则会先打 systemone 再超时
      api:
        rawArbiter.api === 'chat' || rawArbiter.api === 'systemone'
          ? rawArbiter.api
          : 'auto',
      // 影子模型：只落日志。默认关；开了之后主模型仍是对用户可见的那一个。
      shadow: (() => {
        const rawShadow = (rawArbiter.shadow ?? {}) as Record<string, unknown>;
        if (rawShadow.enabled !== true) return undefined;
        return {
          enabled: true,
          baseUrl:
            typeof rawShadow.baseUrl === 'string' && rawShadow.baseUrl.trim()
              ? rawShadow.baseUrl.trim()
              : 'http://127.0.0.1:1234/v1',
          model: typeof rawShadow.model === 'string' && rawShadow.model.trim() ? rawShadow.model.trim() : 'laya',
          // 影子不挡用户，给短超时：宁可少一条对照，也不要拖着一个 hang 住的请求
          timeoutMs: num(rawShadow.timeoutMs, 2000, 300, 10000),
          api:
            rawShadow.api === 'chat' || rawShadow.api === 'systemone'
              ? rawShadow.api
              : 'auto',
        };
      })(),
    },
    semantic: {
      enabled: rawSemantic.enabled === 'off' ? 'off' : 'auto',
      baseUrl:
        typeof rawSemantic.baseUrl === 'string' && rawSemantic.baseUrl.trim()
          ? rawSemantic.baseUrl.trim()
          : 'http://127.0.0.1:1234/v1',
      model:
        typeof rawSemantic.model === 'string' && rawSemantic.model.trim()
          ? rawSemantic.model.trim()
          : 'text-embedding-bge-m3',
      timeoutMs: num(rawSemantic.timeoutMs, 2000, 200, 15000),
      continueThreshold: dec(rawSemantic.continueThreshold, 0.58, 0.2, 0.95),
      switchThreshold: dec(rawSemantic.switchThreshold, 0.6, 0.3, 0.99),
      unrelatedThreshold: dec(rawSemantic.unrelatedThreshold, 0.45, 0.05, 0.8),
    },
  };

  const cwd = str('cwd', '');
  if (!cwd) issues.push({ level: 'error', field: 'cwd', message: '未指定工作目录，该员工无法安全执行文件操作' });
  else if (!existsSync(cwd)) issues.push({ level: 'warn', field: 'cwd', message: `目录不存在：${cwd}` });

  const def: WakerDef = {
    id,
    name: str('name', id),
    role: str('role', '未描述岗位'),
    model: str('model', 'auto'),
    cwd,
    enabled: raw.enabled !== false,
    origin: LOCAL_ORIGIN,
    policy,
    memoryVersioning: raw.memoryVersioning !== false,
    extraPrompt: typeof raw.extraPrompt === 'string' ? raw.extraPrompt : undefined,
    llm: parseLlm(raw, secrets),
    channels: parseChannels(raw, secrets, channelCfg),
    session,
  };

  return { def, issues };
}

/** 定位档案文件（SOUL / identity / persona / bible / MEMORY），缺哪个返回 null。 */
function locateMarkdown(dir: string): WakerRecord['files'] {
  const pick = (name: string): string | null => {
    const p = join(dir, name);
    return existsSync(p) ? p : null;
  };
  return {
    soul: pick('SOUL.md'),
    identity: pick('identity.md'),
    persona: pick('persona.md'),
    bible: pick('bible.md'),
    memory: pick('MEMORY.md'),
  };
}

/** 列出全部本地员工目录名。目录不存在时返回空数组而非抛错。 */
export function listWakerIds(): string[] {
  if (!existsSync(AGENTS_DIR)) return [];
  return readdirSync(AGENTS_DIR)
    .filter((n) => {
      try {
        return statSync(join(AGENTS_DIR, n)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();
}

/**
 * 合并本地员工与纳管的 Pi profile id，同名本地优先。
 *
 * **自动纳管默认关闭**（`config.piAgents`，见 core/config.ts）：Pi 侧的 agent 不自动出现，
 * 想用就走 `waker import <id>`。置 true 才回到"只读纳管"的行为。
 */
export function listAllWakerIds(): string[] {
  const ids = new Set(listWakerIds());
  if (piAgentsEnabled()) for (const id of listPiProfileIds()) ids.add(id);
  return [...ids].sort();
}

/** 加载单个本地员工档案（项目内 agents/<id>/）。找不到返回 null。 */
export function loadLocalWaker(id: string): WakerRecord | null {
  const dir = agentDir(id);
  const yamlPath = join(dir, 'waker.yaml');
  if (!existsSync(yamlPath)) return null;

  let raw: Record<string, unknown>;
  try {
    raw = (parseYaml(readFileSync(yamlPath, 'utf-8')) ?? {}) as Record<string, unknown>;
  } catch (e) {
    const err = e as Error;
    return {
      def: { ...({ id } as WakerDef) },
      dir,
      origin: LOCAL_ORIGIN,
      files: locateMarkdown(dir),
      issues: [{ level: 'error', field: 'waker.yaml', message: `解析失败：${err.message}` }],
    } as WakerRecord;
  }

  const { def, issues } = normalize(id, raw, readSecrets(id, dir), readChannelFile(id, dir));
  const files = locateMarkdown(dir);
  if (!files.identity) issues.push({ level: 'warn', field: 'identity.md', message: '缺少身份文件，注入将只有岗位元数据' });
  if (!files.bible) issues.push({ level: 'warn', field: 'bible.md', message: '缺少红线文件，员工缺少禁止项约束' });

  return { def, dir, origin: LOCAL_ORIGIN, files, issues };
}

/**
 * 把 Pi 的 agent / subagent profile 映射成 Waker 记录（**只读纳管**）。
 *
 * 映射规则：
 * - 正文 → SOUL（人设总纲）；frontmatter 在读取时剥离，不会注入提示词；
 * - model / tools → 运行参数，使其按 profile 自身的配置执行；
 * - 工作目录：Pi profile 未声明，默认以平台根作为文件系统边界。
 */
export function piProfileToRecord(p: PiProfile): WakerRecord {
  const def: WakerDef = {
    id: p.id,
    name: p.displayName,
    role: p.description,
    model: p.model,
    cwd: PLATFORM_ROOT,
    enabled: p.enabled,
    origin: 'pi',
    policy: {
      sandbox: false,
      toolAllow: p.tools.length ? p.tools : undefined,
      commandDeny: DEFAULT_POLICY.commandDeny,
      pathDeny: DEFAULT_POLICY.pathDeny,
      commandTimeoutMs: DEFAULT_POLICY.commandTimeoutMs,
    },
    // 纳管的 Pi agent 也能挂渠道：渠道配置在平台侧，不依赖它的目录
    channels: parseChannels({}, readSecrets(p.id, ''), readChannelFile(p.id, '')),
  };
  return {
    def,
    dir: p.file,
    origin: 'pi',
    files: { soul: p.file, identity: null, persona: null, bible: null, memory: null },
    issues: [],
  };
}

/**
 * 加载单个员工档案：先查本地档案，再查纳管的 Pi profile（后者需 `piAgents` 开关打开）。
 *
 * 自动纳管关闭时，未导入的 Pi agent 就"不存在"——这样名册干净，
 * 同一个 id 也不会既以 Pi 形式又以本地形式出现。
 */
export function loadWaker(id: string): WakerRecord | null {
  const local = loadLocalWaker(id);
  if (local) return local;
  if (!piAgentsEnabled()) return null;
  const pi = loadPiProfile(id);
  return pi ? piProfileToRecord(pi) : null;
}

/** 加载全部员工：本地档案 + （开关打开时的）Pi profile，同名本地优先。禁用者一并返回，由调用方决定是否过滤。 */
export function loadAllWakers(): WakerRecord[] {
  const out: WakerRecord[] = [];
  const seen = new Set<string>();
  for (const id of listWakerIds()) {
    const rec = loadLocalWaker(id);
    if (rec) {
      out.push(rec);
      seen.add(id);
    }
  }
  if (!piAgentsEnabled()) return out;
  for (const p of listPiProfiles()) {
    if (seen.has(p.id)) continue;
    out.push(piProfileToRecord(p));
  }
  return out;
}

/** 读取档案正文（不存在返回空串）。统一剥离 frontmatter，兼容 Pi profile 的单文件形态。 */
export function readRoleFile(rec: WakerRecord, key: keyof WakerRecord['files']): string {
  const p = rec.files[key];
  if (!p) return '';
  try {
    return splitFrontmatter(readFileSync(p, 'utf-8')).body;
  } catch {
    return '';
  }
}
