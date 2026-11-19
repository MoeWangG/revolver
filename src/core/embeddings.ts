/**
 * 文本向量：调本地 LM Studio 的 OpenAI 兼容接口（记忆服务用的同一个 embedding 模型）。
 *
 * 三条设计约束：
 *   1. **不依赖记忆服务本体**——直接打 LM Studio，避免把判定耦合到 memory-server 的接口变更上；
 *   2. **失败必须可判**：任何异常都返回 null，由调用方退回词面判定，绝不抛到对话路径；
 *   3. **带缓存**：会话文本几乎不变，每条消息都重算等于白烧 CPU。缓存按「模型+文本」做键。
 *
 * 为什么选本地而不是云端 embedding：判定在收消息的关键路径上，
 * 本地一次 1024 维批量调用约 40ms，云端要加上网络往返与配额风险。
 */
import { createHash } from 'node:crypto';

export interface EmbeddingConfig {
  enabled: boolean;
  /** OpenAI 兼容端点，需要带 /v1。 */
  baseUrl: string;
  model: string;
  timeoutMs: number;
}

export const DEFAULT_EMBEDDING: EmbeddingConfig = {
  enabled: true,
  baseUrl: process.env.WAKER_EMBED_BASE_URL ?? 'http://127.0.0.1:1234/v1',
  model: process.env.WAKER_EMBED_MODEL ?? 'text-embedding-bge-m3',
  /**
   * 6s 而不是 2s（2026-11-05 实测）：bge-m3 在 M5 上约 42ms/条，
   * 一次 81 条（10 个会话的语义块）要 **3.4s**，2s 必超时。
   * 超时的代价不是"慢一点"，而是**整条语义链路降级成词面**——
   * 中文短句的词面重合几乎是 0，于是判定永远返回"继续"，网页端的跳转建议从来弹不出来。
   */
  timeoutMs: 6000,
};

/** 单条文本送去向量的上限：太长既慢又没必要，判定只需要"话题大意"。 */
const MAX_CHARS = 1200;
const MAX_CACHE = 800;

const CACHE = new Map<string, number[]>();

function cacheKey(cfg: EmbeddingConfig, text: string): string {
  return `${cfg.model}|${createHash('sha1').update(text).digest('hex')}`;
}

function put(key: string, vec: number[]): void {
  if (CACHE.size >= MAX_CACHE) {
    // 简单的 FIFO 淘汰：够用，且不会让内存无界增长
    const first = CACHE.keys().next();
    if (!first.done) CACHE.delete(first.value);
  }
  CACHE.set(key, vec);
}

/** 供测试与诊断：当前缓存条目数。 */
export function embeddingCacheSize(): number {
  return CACHE.size;
}

/**
 * 批量取向量。返回顺序与输入一致；**任何一条失败都整体返回 null**，
 * 因为"部分向量"会让相似度比较失去意义（下标对不齐）。
 */
export async function embedTexts(texts: string[], cfg: EmbeddingConfig = DEFAULT_EMBEDDING): Promise<number[][] | null> {
  if (!cfg.enabled || !texts.length) return null;

  const prepared = texts.map((t) => String(t ?? '').slice(0, MAX_CHARS));
  const keys = prepared.map((t) => cacheKey(cfg, t));
  const missIdx = keys.map((k, i) => (CACHE.has(k) ? -1 : i)).filter((i) => i >= 0);

  if (missIdx.length) {
    const payload = missIdx.map((i) => prepared[i]!);
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
      const res = await fetch(`${cfg.baseUrl.replace(/\/$/, '')}/embeddings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: cfg.model, input: payload }),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!res.ok) return null;
      const data = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
      const vecs = data.data ?? [];
      if (vecs.length !== payload.length) return null;
      missIdx.forEach((i, j) => {
        const v = vecs[j]?.embedding;
        if (Array.isArray(v) && v.length) put(keys[i]!, v);
      });
    } catch {
      // 超时 / 连接失败 / 模型未加载：一律降级，不冒泡
      return null;
    }
  }

  const out = keys.map((k) => CACHE.get(k));
  if (out.some((v) => !v)) return null;
  return out as number[][];
}

// 余弦相似度放在 topicRouter 里：判定逻辑与它的度量应该在一起，
// 这个文件只负责"文本 → 向量"的传输与缓存。
