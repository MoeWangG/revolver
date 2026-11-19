import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR, PI_AGENT_HOME } from './paths.ts';

/**
 * 模型价格表。
 *
 * 价格来源（后者被前者覆盖）：
 *  1. `data/pricing.json` —— 平台侧覆盖文件，可手工改单价；
 *  2. pi 的模型目录 `~/.pi/agent/models-store.json`、`models.json`（各自带 cost）。
 *
 * 单位统一为 **USD / 1M tokens**，与 pi 的模型定义保持一致。
 */

export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface PricedModel extends ModelPrice {
  /** 单价来自哪里：平台覆盖文件，还是 pi 的模型目录。 */
  source: 'override' | 'pi';
  /** 模型展示名（pi 里有就带上）。 */
  name?: string;
}

/** 一次调用的 token 构成。 */
export interface TokenParts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

const OVERRIDE_FILE = join(DATA_DIR, 'pricing.json');
const PI_MODEL_FILES = [join(PI_AGENT_HOME, 'models-store.json'), join(PI_AGENT_HOME, 'models.json')];

interface PricingCache {
  fingerprint: string;
  map: Map<string, PricedModel>;
}

let cache: PricingCache | null = null;

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function toPrice(cost: unknown): ModelPrice | null {
  if (!cost || typeof cost !== 'object') return null;
  const c = cost as Record<string, unknown>;
  return { input: num(c.input), output: num(c.output), cacheRead: num(c.cacheRead), cacheWrite: num(c.cacheWrite) };
}

/** 用相关文件的 mtime+size 做指纹：任何一处价格变动都能让缓存失效。 */
export function pricingFingerprint(): string {
  return [OVERRIDE_FILE, ...PI_MODEL_FILES]
    .map((f) => {
      try {
        const st = statSync(f);
        return `${st.mtimeMs}:${st.size}`;
      } catch {
        return 'none';
      }
    })
    .join('|');
}

/**
 * 从 pi 的模型目录抽取 `模型 id → 单价`。
 * 兼容 `{ providers: { p: { models: [] } } }`（models.json）
 * 与 `{ p: { models: [] } }`（models-store.json）两种层级。
 */
function collectPiPrices(into: Map<string, PricedModel>): void {
  for (const file of PI_MODEL_FILES) {
    if (!existsSync(file)) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, 'utf-8'));
    } catch {
      continue;
    }
    const walk = (node: unknown, depth: number): void => {
      if (!node || typeof node !== 'object' || depth > 3) return;
      const obj = node as Record<string, unknown>;
      if (Array.isArray(obj.models)) {
        for (const item of obj.models) {
          if (!item || typeof item !== 'object') continue;
          const m = item as Record<string, unknown>;
          const id = typeof m.id === 'string' ? m.id : null;
          if (!id) continue;
          const price = toPrice(m.cost);
          if (!price) continue;
          // 先出现的文件更权威（models-store 早于 models.json）
          if (into.has(id)) continue;
          into.set(id, { ...price, source: 'pi', name: typeof m.name === 'string' ? m.name : undefined });
        }
        return;
      }
      for (const v of Object.values(obj)) walk(v, depth + 1);
    };
    walk(raw, 0);
  }
}

/** 平台覆盖文件：`{ "模型id": { input, output, cacheRead, cacheWrite } }`，`_` 开头的键忽略。 */
function loadOverrides(into: Map<string, PricedModel>): void {
  if (!existsSync(OVERRIDE_FILE)) return;
  try {
    const raw = JSON.parse(readFileSync(OVERRIDE_FILE, 'utf-8')) as Record<string, unknown>;
    for (const [id, v] of Object.entries(raw)) {
      if (id.startsWith('_')) continue;
      const price = toPrice(v);
      if (price) into.set(id, { ...price, source: 'override' });
    }
  } catch {
    /* 覆盖文件坏了就忽略，不影响展示 */
  }
}

export function loadPricing(): Map<string, PricedModel> {
  const fp = pricingFingerprint();
  if (cache && cache.fingerprint === fp) return cache.map;
  const map = new Map<string, PricedModel>();
  collectPiPrices(map);
  loadOverrides(map);
  cache = { fingerprint: fp, map };
  return map;
}

/** 归一化模型名：去掉 provider 前缀并小写，便于宽松匹配。 */
function normalize(model: string): string {
  return model.trim().toLowerCase().replace(/^[^/]+\//, '');
}

/** 查模型单价：先精确匹配，再按归一化名匹配。查不到返回 undefined。 */
export function priceOf(model: string): PricedModel | undefined {
  const map = loadPricing();
  const exact = map.get(model);
  if (exact) return exact;
  const n = normalize(model);
  for (const [id, p] of map) {
    if (normalize(id) === n) return p;
  }
  return undefined;
}

/**
 * 按模型单价计算费用（USD）。
 * 价格表未覆盖该模型时返回 null —— 由调用方决定回退到 pi 记录的 cost。
 */
export function computeCost(model: string, t: TokenParts): number | null {
  const p = priceOf(model);
  if (!p) return null;
  return (t.input * p.input + t.output * p.output + t.cacheRead * p.cacheRead + t.cacheWrite * p.cacheWrite) / 1e6;
}
