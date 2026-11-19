"""本地 embedding 客户端

2026-10-01 重构: 真正的请求逻辑下沉到 providers.py,
本文件只保留"对外稳定接口", 供 app.py / backfill.py 使用。

历史教训(见 FIXES-20260913.md):
  - 配置的 embedding 模型从未安装时, 曾经静默降级到 hash 向量,
    导致检索等于瞎搜却毫无报错。
  - httpx 默认走系统代理, 会让 127.0.0.1 请求被劫持成 502,
    故 provider 层统一 trust_env=False。

2026-10-11 再修: **彻底去掉静默降级**。
  之前失败时返回 hash 向量(全非负、无语义), 服务不中断但那条记忆永远搜不到；
  实测库里真躺了 3 条这样的垃圾向量，而且用户从外部完全看不出来。
  现在重试 3 次(间隔退避, 每次都会重新 HTTP 探活以触发按需加载)后**抛错**:
    - 写入路径: 存 embedding=NULL(记忆仍在, 只是暂时不可召回, 可 /api/reembed 补算);
    - 查询路径: 明确报错, 而不是拿噪声去比出"看似合理"的假分数。
  为什么会被判 400: LM Studio 把按需加载/刚被卸载的模型请求直接回 400,
  属于瞬时状态, 退避重试后基本都能成。
"""
import time

import numpy as np

import providers
from config import load_config


class EmbeddingUnavailable(RuntimeError):
    """嵌入不可用（重试后仍失败）。调用方据此决定"存 NULL"还是"明确失败"。"""


class Embedder:
    def __init__(self, cfg=None):
        cfg = cfg or load_config()
        emb = cfg.get("embedding", {})
        self._provider = providers.build_embedding(emb)
        self.model = self._provider.model
        self.dim = self._provider.dim
        self.base_url = self._provider.base_url
        self.batch = self._provider.batch
        self.provider_name = self._provider.provider_name
        # 未显式配置 dim 时, 用最近一次真实返回值回填
        if not self.dim:
            self.dim = int(emb.get("dim", 0)) or 1024

    def ensure_loaded(self) -> bool:
        return self._provider.ensure_loaded()

    def probe(self) -> bool:
        """模型此刻可服务？（健康检查口，走 HTTP 探活，不碰 lms ps）"""
        return self._provider.probe()

    def _is_loaded(self) -> bool:
        try:
            import stability
            return stability.is_loaded(self.model, cache_ttl=0)
        except Exception:
            return True

    def unload(self):
        self._provider.unload()

    def embed(self, texts: list[str]) -> np.ndarray:
        """向量化一批文本, 返回 (n, dim) float32。

        失败时退避重试（每次都会重新探活以触发按需加载），仍失败**抛 EmbeddingUnavailable**。
        """
        texts = [t for t in texts if t]
        if not texts:
            return np.zeros((0, self.dim), dtype=np.float32)
        last = "未知原因"
        for attempt in range(3):
            try:
                if not self._provider.ensure_loaded():
                    last = f"{self.model} 无法加载"
                else:
                    arr = self._provider.embed(texts)
                    if arr.size:
                        self.dim = arr.shape[1]  # 以真实维度为准
                    return arr
            except Exception as e:
                last = f"{type(e).__name__}: {e}"
            if attempt < 2:
                time.sleep(0.5 * (attempt + 1))
        print(f"[embedder] ✗ {last}；重试 3 次仍失败，本次**不产出向量**（不写降级 hash，避免污染检索）")
        raise EmbeddingUnavailable(last)

    def _fallback_embed(self, texts: list[str]) -> np.ndarray:
        """确定性 hash 向量。

        **已不再被 embed() 使用**（2026-10-11 起改为抛错）。保留它是为了排障时能人工
        对照"降级向量长什么样"：全部分量非负，而真实语义向量必然含负分量——
        `store.degraded_rows()` 就是按这条判据把历史垃圾向量挑出来的。
        """
        import hashlib
        out = np.zeros((len(texts), self.dim), dtype=np.float32)
        for i, t in enumerate(texts):
            seed = hashlib.blake2b(t.encode("utf-8"), digest_size=64).digest()
            data = b""
            while len(data) < self.dim:  # 迭代哈希扩展字节流
                data += seed
                seed = hashlib.blake2b(seed).digest()
            out[i] = np.frombuffer(data[:self.dim], dtype=np.uint8).astype(np.float32) / 255.0
        return out
