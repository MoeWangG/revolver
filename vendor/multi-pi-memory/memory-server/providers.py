"""推理后端抽象层 —— 让记忆系统支持本地 LM Studio 与任意 OpenAI 兼容端点

设计目标 (2026-10-01):
  用户分享场景下, 不能强制别人装 LM Studio + 下 7.5GB 模型。
  故抽象出 provider 层:
    - lmstudio  : 本地, 零成本, 隐私, 带自愈守护(见 stability.py)
    - openai    : 任意 OpenAI 兼容端点(OpenAI / DeepSeek / 硅基流动 / Ollama / vLLM ...)

统一接口:
  EmbeddingProvider.embed(texts) -> np.ndarray (n, dim)
  ChatProvider.chat(messages, ...) -> str

关键差异处理:
  - LM Studio 有"空闲卸载/内存护栏"问题, 需要 ensure_loaded 自愈;
    云端 provider 无此概念, ensure_loaded 恒为 True。
  - embedding 维度由模型决定, 换模型必须重建索引, 由 dim 校验兜底。
"""
import os
import time

import httpx
import numpy as np


def _resolve_env(value):
    """支持 ${ENV_NAME} 形式从环境变量取值(便于不把 api key 写进配置文件)。"""
    if isinstance(value, str) and value.startswith("${") and value.endswith("}"):
        return os.environ.get(value[2:-1], "")
    return value


class BaseEmbedding:
    provider_name = "base"

    def __init__(self, cfg: dict):
        self.model = cfg.get("model", "")
        self.dim = int(cfg.get("dim", 0))
        self.base_url = str(cfg.get("base_url", "")).rstrip("/")
        self.api_key = _resolve_env(cfg.get("api_key", "")) or ""
        self.batch = int(cfg.get("batch_size", 16))
        self.timeout = float(cfg.get("timeout", 120))

    def ensure_loaded(self) -> bool:
        """确保模型可用。云端 provider 无需加载, 恒 True。"""
        return True

    def probe(self) -> bool:
        """模型是否**此刻可服务**（健康检查用）。云端恒 True；LM Studio 覆盖为 HTTP 探活。"""
        return True

    def unload(self):
        pass

    def _headers(self) -> dict:
        h = {"Content-Type": "application/json"}
        if self.api_key:
            h["Authorization"] = f"Bearer {self.api_key}"
        return h

    def _post_embeddings(self, texts: list[str]) -> list[list[float]]:
        """底层请求。trust_env=False 很关键: 否则本地回环请求可能被系统代理劫持(实测 502)。"""
        resp = httpx.post(
            f"{self.base_url}/embeddings",
            json={"model": self.model, "input": texts},
            headers=self._headers(),
            timeout=self.timeout,
            trust_env=False,
        )
        resp.raise_for_status()
        items = sorted(resp.json().get("data", []), key=lambda x: x.get("index", 0))
        return [it.get("embedding") for it in items]

    def embed(self, texts: list[str]) -> np.ndarray:
        texts = [t for t in texts if t]
        if not texts:
            return np.zeros((0, self.dim or 1), dtype=np.float32)
        out_chunks = []
        for i in range(0, len(texts), self.batch):
            chunk = texts[i:i + self.batch]
            out_chunks.append(self._post_embeddings(chunk))
        flat = [v for c in out_chunks for v in c]
        arr = np.asarray(flat, dtype=np.float32)
        # 首次使用时用实际返回维度回填(配置没写 dim 的场景)
        if not self.dim and arr.size:
            self.dim = arr.shape[1]
        return np.nan_to_num(arr)


class OpenAIEmbedding(BaseEmbedding):
    """任意 OpenAI 兼容 /v1/embeddings 端点。"""
    provider_name = "openai"


class LMStudioEmbedding(BaseEmbedding):
    """本地 LM Studio。叠加自愈(ensure_loaded)与无语义降级的明确告警。"""
    provider_name = "lmstudio"

    def __init__(self, cfg: dict):
        super().__init__(cfg)
        self.auto_load = bool(cfg.get("auto_load", True))
        self.ttl = int(cfg.get("ttl_seconds", 0))

    def ensure_loaded(self) -> bool:
        import stability
        if not self.auto_load:
            # 只看 lms ps 不够：**嵌入模型在 `lms ps` 里根本不出现**（那是 generation 模型的
            # 列表），于是恒判"未加载"，embed() 静默降级成 hash 向量 —— 检索等于瞎搜，
            # 而且不报错。 先做一次 HTTP 探活：只要 /v1/models 认这个模型就直接用，
            # LM Studio 会在真正调用时按需加载（实测直连 /v1/embeddings 立即返回真实向量）。
            if self._probe_http():
                return True
            return stability.is_loaded(self.model)
        s = _stability_cfg()
        return stability.ensure(self.model, ttl=self.ttl,
                                retries=int(s.get("auto_load_retry", 3)),
                                backoff=float(s.get("retry_backoff", 5)))

    def probe(self) -> bool:
        """健康检查口：模型此刻能不能服务（HTTP 探活，不碰 `lms ps`）。"""
        return self._probe_http()

    def _probe_http(self) -> bool:
        """HTTP 探活: 嵌入端点是否认这个模型。比 lms ps 可靠, 且不碰 CLI。"""
        if not self.base_url:
            return False
        try:
            from stability import _norm_id
            with httpx.Client(trust_env=False, timeout=min(float(self.timeout), 10)) as c:
                r = c.get(f"{self.base_url}/models")
                if r.status_code != 200:
                    return False
                ids = [str(m.get("id", "")) for m in (r.json().get("data") or [])]
                want = _norm_id(self.model)
                return any(_norm_id(i) == want for i in ids)
        except Exception:
            return False

    def unload(self):
        import subprocess
        import stability
        try:
            subprocess.run([stability._lms(), "unload", self.model],
                           capture_output=True, text=True, timeout=30)
        except Exception:
            pass

    def _post_embeddings(self, texts: list[str]) -> list[list[float]]:
        """LM Studio 特化: 命中"模型未加载"时自动重载并重试一次。"""
        import stability
        try:
            return super()._post_embeddings(texts)
        except httpx.HTTPStatusError as e:
            if stability.is_unloaded_error(e):
                print("[embedder] 模型已卸载, 重新加载后重试...")
                stability.reset_backoff(self.model)
                self.ensure_loaded()
                return super()._post_embeddings(texts)
            raise


class BaseChat:
    provider_name = "base"

    def __init__(self, cfg: dict):
        self.model = cfg.get("model", "")
        self.temperature = float(cfg.get("temperature", 0.2))
        self.max_tokens = int(cfg.get("max_tokens", 3000))
        self.base_url = str(cfg.get("base_url", "")).rstrip("/")
        self.api_key = _resolve_env(cfg.get("api_key", "")) or ""
        self.timeout = float(cfg.get("timeout", 300))

    def ensure_loaded(self) -> bool:
        return True

    def probe(self) -> bool:
        """**模型是否可服务**（健康检查用）。

        默认返回 True（云端 provider 没有"加载"概念）。LMStudioChat 会覆盖成 HTTP 探活：
        比 `lms ps` 可靠 —— 那个 CLI 又慢又会挂（实测 >8s 无输出），而且对"按需加载"的
        模型一律报未加载，于是 /api/health 无脑报红，外面看着像"记忆没启动"。
        """
        return True

    def _headers(self) -> dict:
        h = {"Content-Type": "application/json"}
        if self.api_key:
            h["Authorization"] = f"Bearer {self.api_key}"
        return h

    def chat(self, system: str, user: str) -> str:
        """发一轮对话, 返回模型输出的正文(兼容 reasoning_content 回退)。"""
        resp = httpx.post(
            f"{self.base_url}/chat/completions",
            json={
                "model": self.model,
                "messages": [
                    {"role": "system", "content": system},
                    # 部分本地模型模板强制要求存在 user 消息, 仅发 system 会 400。
                    {"role": "user", "content": user},
                ],
                "temperature": self.temperature,
                "max_tokens": self.max_tokens,
            },
            headers=self._headers(),
            timeout=self.timeout,
            trust_env=False,
        )
        resp.raise_for_status()
        msg = resp.json()["choices"][0]["message"]
        return (msg.get("content") or msg.get("reasoning_content") or "").strip()


class OpenAIChat(BaseChat):
    provider_name = "openai"


class LMStudioChat(BaseChat):
    """本地 LM Studio chat。叠加自愈。"""
    provider_name = "lmstudio"

    def __init__(self, cfg: dict):
        super().__init__(cfg)
        self.auto_load = bool(cfg.get("auto_load", True))
        self.ttl = int(cfg.get("ttl_seconds", 0))

    def ensure_loaded(self) -> bool:
        import stability
        if not self.auto_load:
            return True
        s = _stability_cfg()
        return stability.ensure(self.model, ttl=self.ttl,
                                retries=int(s.get("auto_load_retry", 3)),
                                backoff=float(s.get("retry_backoff", 5)))

    def _is_loaded(self) -> bool:
        import stability
        return stability.is_loaded(self.model, cache_ttl=0)

    def load_now(self, ttl: int = 600) -> bool:
        """**立刻把这个模型加载起来**（`lms load`），不管 auto_load 怎么配。

        为什么必须有它：`auto_load: false` 时 `ensure_loaded()` 是个**空操作**（直接 True），
        所以 `chat()` 里那句"模型已卸载 → 重新加载后重试"其实从来没真加载过 ——
        于是请求照样 400（实测：抽取整批失败，日志里连着 4 次
        `Model unloaded.` / `Failed to load model ... Operation canceled`）。
        而触发时机恰好最坏：模型被 TTL 卸载的同一瞬间请求到了。

        ttl<=0 → 常驻不卸载；ttl>0 → 空闲这么多秒后自动卸载（抽取模型体积大，
        用 TTL 比常驻更合理：**按需加载 + 用完自己走**）。
        """
        import stability
        return stability.ensure(self.model, ttl=ttl, retries=2, backoff=2.0)

    def probe(self) -> bool:
        """HTTP 探活：`/v1/models` 认这个模型就视为可服务（LM Studio 按需加载）。

        先看配置：`auto_load: false` 时系统本就依赖按需加载，"未预加载"不是故障。
        """
        if not self.auto_load:
            return True
        return self._probe_http()

    def _probe_http(self) -> bool:
        if not self.base_url:
            return False
        try:
            with httpx.Client(trust_env=False, timeout=min(float(self.timeout), 10)) as c:
                r = c.get(f"{self.base_url}/models")
                if r.status_code != 200:
                    return False
                ids = [str(m.get("id", "")) for m in (r.json().get("data") or [])]
                from stability import _norm_id
                want = _norm_id(self.model)
                return any(_norm_id(i) == want for i in ids)
        except Exception:
            return False

    def chat(self, system: str, user: str) -> str:
        """LM Studio 特化: 覆盖"刚被卸载"的竞态, 整体重试一次。"""
        import stability
        attempts = 2 if self.auto_load else 1
        last = None
        for attempt in range(attempts):
            if attempt > 0 or not self._is_loaded():
                self.ensure_loaded()
            try:
                return super().chat(system, user)
            except httpx.HTTPStatusError as e:
                last = e
                if stability.is_unloaded_error(e):
                    print("[extractor] 模型已卸载, 真正加载一次后重试…")
                    stability.reset_backoff(self.model)
                    self.load_now(ttl=600)   # 原来调的是空操作，等于没重试
                    continue
                raise
        if last:
            raise last
        return ""


def _stability_cfg() -> dict:
    from config import load_config
    return load_config().get("stability", {})


def detect_local_backends() -> dict:
    """探测本机可用的推理后端(供 setup 向导使用)。"""
    found = {}
    for name, url in (("lmstudio", "http://127.0.0.1:1234/v1"),
                      ("ollama", "http://127.0.0.1:11434/v1")):
        try:
            r = httpx.get(f"{url}/models", timeout=3, trust_env=False)
            if r.status_code == 200:
                ids = [m.get("id", "") for m in r.json().get("data", [])]
                found[name] = {"base_url": url, "models": ids}
        except Exception:
            pass
    return found


def build_embedding(emb_cfg: dict):
    """按配置构造 embedding provider。provider 缺省为 lmstudio(向后兼容)。"""
    p = (emb_cfg.get("provider") or "lmstudio").lower()
    if p in ("openai", "openai-compatible", "openai_compatible"):
        return OpenAIEmbedding(emb_cfg)
    return LMStudioEmbedding(emb_cfg)


def build_chat(chat_cfg: dict):
    """按配置构造 chat provider。"""
    p = (chat_cfg.get("provider") or "lmstudio").lower()
    if p in ("openai", "openai-compatible", "openai_compatible"):
        return OpenAIChat(chat_cfg)
    return LMStudioChat(chat_cfg)
