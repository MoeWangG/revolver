"""LM Studio 稳定性加固 —— 自愈守护 + 统一模型生命周期管理

背景 (2026-09-28):
  LM Studio 作为本地推理后端存在若干不稳定点, 会导致记忆系统静默失效:
    1) 空闲 TTL 到期后自动卸载模型 -> chat/embeddings 请求返回 400/404
    2) 32G 机器上大模型会触发内存护栏, 加载失败(insufficient system resources)
    3) 加载是异步的, 刚 load 完立刻请求会打到 "Model is unloaded."
    4) 服务重启后模型不会自动回来 -> 首轮请求必然失败
    5) HuggingFace 直连不通, 只能走 LM Studio Hub
  历史教训: 上述问题曾造成"自动抽取 100% 失败却无任何告警"。

本模块提供:
  - ensure(model): 确保模型在线, 带重试+退避+幂等
  - guard: 低层调用封装, 命中"未加载"类错误时自动重载并重试
  - HealthDaemon: 后台线程定期巡检并保活
  - 统一 _lms / _is_loaded 实现, 供 embedder/extractor 复用

设计原则:
  - 任何失败都要**打日志**, 绝不静默 (这是历史最大教训)
  - 不 unload 其他模型, 避免干扰用户正在进行的会话
  - 所有网络请求 trust_env=False (历史 bug: 走代理导致 127.0.0.1 502)
"""
import subprocess
import threading
import time
from pathlib import Path

import httpx

from config import load_config

# ---- 全局状态 ----
_lock = threading.Lock()
_last_fail: dict[str, float] = {}       # model -> 上次加载失败时间
_state: dict[str, dict] = {}            # model -> {loaded, last_check, failures}
_loaded_cache: dict[str, tuple[float, bool]] = {}  # model -> (ts, loaded) 减轻 lms ps 压力


def _lms() -> str:
    """定位 lms CLI。"""
    import shutil
    for p in (Path.home() / ".lmstudio/bin/lms",
              Path.home() / ".local/bin/lms",
              "/usr/local/bin/lms", "/opt/homebrew/bin/lms"):
        if p.exists():
            return str(p)
    return shutil.which("lms") or "lms"


def _norm_id(s: str) -> str:
    """归一化模型标识符。

    LM Studio 在重复加载同一模型时会生成带实例后缀的标识符(如 bge-m3:2),
    比对时需去掉 ":N" 后缀, 否则会误判为“未加载”而重复拉起。
    """
    return (s or "").strip().split(":")[0]


def is_loaded(model: str, cache_ttl: float = 3.0) -> bool:
    """模型是否已在 LM Studio 内存中。

    lms ps 是子进程调用(约 100-300ms), 加 3s 缓存避免高频请求时反复 spawn。
    """
    now = time.time()
    hit = _loaded_cache.get(model)
    if hit and now - hit[0] < cache_ttl:
        return hit[1]
    want = _norm_id(model)
    try:
        out = subprocess.run([_lms(), "ps"], capture_output=True,
                             text=True, timeout=30).stdout
        loaded = False
        for line in out.splitlines():
            parts = line.split()
            if not parts or parts[0] == "IDENTIFIER":
                continue
            if _norm_id(parts[0]) == want:
                loaded = True
                break
    except Exception as e:
        print(f"[stability] lms ps 失败: {e}")
        loaded = False
    _loaded_cache[model] = (now, loaded)
    return loaded


def list_loaded() -> list[str]:
    """当前已加载的所有模型标识符(已排除表头)。"""
    try:
        out = subprocess.run([_lms(), "ps"], capture_output=True,
                             text=True, timeout=30).stdout
        ids = []
        for line in out.splitlines():
            parts = line.split()
            if not parts or parts[0] == "IDENTIFIER" or line.startswith("-"):
                continue
            ids.append(parts[0])
        return ids
    except Exception:
        return []


def ensure(model: str, ttl: int = 3600, retries: int = 3,
           backoff: float = 5.0) -> bool:
    """确保模型在线。已在线直接返回 True; 否则加载, 带重试与指数退避。

    ttl <= 0 时以【常驻】方式加载(不传 --ttl), 模型不会被空闲卸载。
    这是推荐模式: 避免 TTL 到期后反复卸载/重载(实测曾因此产生 94 次无意义 revive)。

    加载失败后 60s 内不重复尝试(避免每条消息都阻塞在加载上)。
    返回是否成功。
    """
    if not model:
        return False
    if is_loaded(model):
        return True

    with _lock:
        # 再过一次(可能在等锁期间已被别的线程加载)
        if is_loaded(model):
            return True
        now = time.time()
        if now - _last_fail.get(model, 0) < 60:
            return False

        for attempt in range(1, retries + 1):
            try:
                mode = "常驻" if ttl <= 0 else f"ttl={ttl}s"
                print(f"[stability] 加载 {model} (第 {attempt}/{retries} 次, {mode})")
                cmd = [_lms(), "load", model, "-y"]
                if ttl > 0:
                    cmd += ["--ttl", str(ttl)]
                r = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
                # 加载完成后稍等, 避免竞态(接口已就绪但模型仍在初始化)
                if r.returncode == 0:
                    for _ in range(10):
                        _loaded_cache.pop(model, None)
                        if is_loaded(model, cache_ttl=0):
                            # 冒烟测试: 确认接口真的可用
                            if _smoke_test(model):
                                print(f"[stability] ✓ {model} 已就绪")
                                _state.setdefault(model, {})["failures"] = 0
                                return True
                        time.sleep(1)
                err = (r.stderr or r.stdout or "").strip()[:200]
                print(f"[stability] 加载失败: {err}")
                if "insufficient system resources" in err.lower():
                    print("[stability] 提示: 内存不足被护栏拦下, 需换更小模型或调低上下文")
                    _last_fail[model] = time.time()
                    return False
            except Exception as e:
                print(f"[stability] 加载异常: {type(e).__name__}: {e}")
            if attempt < retries:
                time.sleep(backoff * attempt)  # 指数退避: 5s, 10s

        _last_fail[model] = time.time()
        _state.setdefault(model, {})["failures"] = \
            _state.setdefault(model, {}).get("failures", 0) + 1
        return False


def _smoke_test(model: str) -> bool:
    """确认模型接口真的能出结果(而不只是 ps 里显示已加载)。"""
    base = load_config().get("embedding", {}).get("base_url",
                                                  "http://127.0.0.1:1234/v1").rstrip("/")
    try:
        if "embed" in model.lower() or "bge" in model.lower() or "nomic" in model.lower():
            r = httpx.post(f"{base}/embeddings",
                           json={"model": model, "input": ["ping"]},
                           timeout=30, trust_env=False)
        else:
            r = httpx.post(f"{base}/chat/completions",
                           json={"model": model,
                                 "messages": [{"role": "user", "content": "ping"}],
                                 "max_tokens": 1},
                           timeout=60, trust_env=False)
        return r.status_code == 200
    except Exception:
        return False


def is_unloaded_error(e: Exception) -> bool:
    """判断异常是否为"模型未加载"(而非其他 400)。"""
    if isinstance(e, httpx.HTTPStatusError) and e.response is not None:
        body = (e.response.text or "").lower()
        code = e.response.status_code
        if code in (400, 404, 503) and any(
            k in body for k in ("unloaded", "no models loaded",
                                "model is not loaded", "no model loaded",
                                "model_not_found")
        ):
            return True
    return False


def reset_backoff(model: str):
    """清空失败退避, 用于错误重试路径上立即再试。"""
    _last_fail.pop(model, None)


def stats() -> dict:
    """暴露给 /api/status 的健康信息。"""
    return {
        "loaded": list_loaded(),
        "state": {k: dict(v) for k, v in _state.items()},
        "backoff": {k: round(time.time() - v, 1) for k, v in _last_fail.items()},
    }


class HealthDaemon:
    """后台守护线程: 定期巡检关键模型, 掉线自动拉起。

    这解决了"LM Studio 空闲卸载后, 直到下次请求才发现坏了"的问题,
    并且服务重启后能自愈(不需要人工 lms load)。
    """

    def __init__(self, models: list[str], interval: int = 60, ttl: int = 3600,
                 cfg: dict | None = None):
        self.models = [m for m in models if m]
        self.interval = max(15, interval)
        self.ttl = ttl
        self.cfg = cfg or {}
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self.checks = 0
        self.revives = 0
        self.queue_alerts = 0
        self.queue_check: dict = {}

    def start(self):
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, daemon=True,
                                        name="lmstudio-health")
        self._thread.start()
        print(f"[stability] 守护线程已启动: 巡检 {self.models} 每 {self.interval}s")

    def stop(self):
        self._stop.set()

    def _run(self):
        # 启动时先立刻拉一遍(服务重启后模型通常不在)
        time.sleep(3)
        while not self._stop.is_set():
            try:
                self.checks += 1
                # 重要: 一次巡环最多拉起【一个】掉线模型。
                # 原因: LM Studio 默认 unloadPreviousJITModelOnLoad=true,
                # 加载新模型会把上一个踢掉。若同一轮里依次拉起 A 和 B,
                # 就会变为 A 挤掉 B -> 下轮 B 又挤掉 A 的无限互踢循环
                # (实测发生过 94 次无意义 revive)。故逐个拉起并等待下个周期。
                offline = [m for m in self.models if not is_loaded(m, cache_ttl=0)]
                if offline:
                    m = offline[0]
                    print(f"[stability] 巡检发现 {m} 不在线, 尝试拉起")
                    if ensure(m, ttl=self.ttl):
                        self.revives += 1
                        if len(offline) > 1:
                            print(f"[stability] 还有 {len(offline) - 1} 个待拉起, "
                                  f"本轮只处理一个(避免触发模型互踢), 下轮继续")

                # 队列积压巡检 —— 抓「worker 静默死亡」这种无症状故障。
                # 放在这里是因为本线程是全服务唯一常驻的定时器; 且积压
                # 与模型掉线不同, 不会互相干扰(不同表, 读操作)。
                try:
                    import queue_alert
                    self.queue_check = queue_alert.check(self.cfg)
                    if queue_alert.maybe_alert(self.cfg, self.queue_check):
                        self.queue_alerts += 1
                except Exception as e:
                    print(f"[stability] 队列巡检异常: {type(e).__name__}: {e}")
            except Exception as e:
                print(f"[stability] 守护线程异常: {type(e).__name__}: {e}")
            self._stop.wait(self.interval)


_daemon: HealthDaemon | None = None


def start_daemon():
    """按配置启动守护线程(幂等)。"""
    global _daemon
    if _daemon is not None:
        return _daemon
    cfg = load_config()
    st = cfg.get("stability", {})
    models = []
    emb = cfg.get("embedding", {}).get("model")
    ext = cfg.get("extract", {}).get("model")
    if emb and cfg.get("embedding", {}).get("auto_load", True):
        models.append(emb)
    if ext and cfg.get("extract", {}).get("auto_load", True):
        models.append(ext)
    _daemon = HealthDaemon(models,
                           interval=int(st.get("healthcheck_interval", 60)),
                           ttl=int(st.get("keepalive_ttl", 3600)),
                           cfg=cfg)
    _daemon.start()
    return _daemon


def daemon_stats() -> dict:
    if _daemon is None:
        return {"running": False}
    return {"running": _daemon._thread is not None and _daemon._thread.is_alive(),
            "models": _daemon.models, "interval": _daemon.interval,
            "checks": _daemon.checks, "revives": _daemon.revives,
            "queue_alerts": _daemon.queue_alerts,
            "queue_check": _daemon.queue_check}


# ---- 常驻保活（召回优先，写入可以慢） ----

_RESIDENT: dict = {"running": False, "model": "", "last_ms": 0.0,
                   "checked_at": 0.0, "loads": 0, "error": ""}


def resident_stats() -> dict:
    return dict(_RESIDENT)


def start_resident_keeper(model: str, probe, interval: float = 120.0, slow_ms: float = 200.0):
    """让模型**常驻显存**（只对 lmstudio 有意义，幂等）。

    为什么必须常驻：LM Studio 对"按需加载(JIT)"的模型会在**每次请求后按 TTL 卸载**
    —— 实测日志里 `Unloading model text-embedding-bge-m3 due to TTL expiration`
    紧跟在每一次 embed 之后，于是**每次召回都要重新加载模型**（0.55s）。
    显式 `lms load <model>`（不带 --ttl → 无 TTL 限制）则常驻，实测召回 0.01~0.02s。

    判定顺序（2026-10-11 重写，务必保留）：**先查状态，再考虑加载**。
    原实现只信"embed 慢"这个信号，而慢恰恰可能是"内存里堆了多份互相抢"造成的；
    `lms load` 又**不会复用已加载的那份，会新建一个实例** → 越压越慢、越慢越压，
    实测把 bge-m3 堆到 8 份（约 4.3GB 常驻）。现在每轮：
      1. `list_loaded()` 看实例数；
      2. >1 → 自愈卸载多余的（只留一份）；
      3. =1 → 已在内存里，探针只当健康指标，**不再加载**；
      4. =0 → 探针确认后加载，带冷却（≥interval）与熔断（连续 3 次失败就停手）。
    （顺带修正一个过时假设：`lms ps` **确实列得出嵌入模型**，当年"不列"的判断已不成立，
      所以没必要再靠延迟盲猜。）

    probe 必须极轻（嵌入一个短词，~15ms 常驻时）。
    """
    global _RESIDENT
    if _RESIDENT.get("running"):
        return
    _RESIDENT.update({"running": True, "model": model})
    cfg = load_config().get("embedding", {}) or {}

    def _loop():
        log = __import__("logging").getLogger("stability")
        fails = 0
        last_load = 0.0
        while True:
            # 启动先等一会儿，别和刚起来的进程抢模型
            time.sleep(min(20.0, interval))

            # ① 先看事实：这份模型在 LM Studio 里到底加载了几份（2026-10-11 补）。
            #    原实现只看"embed 慢不慢"，而**慢恰恰可能是"加载了多份互相抢内存"造成的**：
            #    于是每轮判定"需要保活" → lms load → 而 lms load **不会复用已加载的那份，
            #    会新建一个实例** → 更慢 → 下一轮再 load …
            #    实测堆到 8 份 bge-m3（约 4.3GB 常驻），且 `lms unload` 之外没有任何自愈。
            #    所以顺序必须是：查状态 → 有就不动（并清理多余）→ 真没有才加载。
            try:
                loaded = [i for i in list_loaded() if i == model or i.startswith(model + ":")]
            except Exception as e:
                _RESIDENT.update({"error": f"list_loaded 失败: {type(e).__name__}: {e}", "checked_at": time.time()})
                continue

            if len(loaded) > 1:
                # 自愈：只留一份，其余卸载（LM Studio 不会自动回收多实例）
                for extra in loaded[1:]:
                    try:
                        subprocess.run([_lms(), "unload", extra],
                                       capture_output=True, text=True, timeout=120)
                        log.info(f"{model} 存在 {len(loaded)} 份实例，卸载多余的 {extra}")
                    except Exception as e:
                        log.error(f"{model} 卸载多余实例 {extra} 失败: {e}")
                _RESIDENT.update({"loaded": True, "instances": 1, "cleaned": len(loaded) - 1,
                                  "checked_at": time.time(), "error": ""})
                continue

            # 探针只当**健康指标**用（常驻时约 15ms），不再拿它当"要不要加载"的依据
            t0 = time.time()
            try:
                probe()
            except Exception as e:
                _RESIDENT.update({"error": f"{type(e).__name__}: {e}", "checked_at": time.time()})
                continue
            ms = (time.time() - t0) * 1000

            if loaded:
                # 已经在内存里：健康。**什么都不做**（原来这里会因为"慢"再叠一份）
                _RESIDENT.update({"running": True, "loaded": True, "instances": len(loaded),
                                  "last_ms": round(ms, 1), "checked_at": time.time(), "error": ""})
                continue

            _RESIDENT.update({"loaded": False, "last_ms": round(ms, 1),
                              "checked_at": time.time(), "error": ""})
            if ms <= slow_ms:
                continue

            # ② 确实没加载才加载：带冷却与熔断，绝不无限叠实例
            now = time.time()
            if now - last_load < max(interval, 120):
                continue
            if fails >= 3:
                _RESIDENT["error"] = f"连续 {fails} 次 load 后仍判为未加载，已停止重试（避免堆实例）"
                continue
            last_load = now
            log.info(f"{model} 未加载(embed {ms:.0f}ms), lms load …")
            try:
                r = subprocess.run([_lms(), "load", model],
                                   capture_output=True, text=True, timeout=300)
                _RESIDENT["loads"] = int(_RESIDENT.get("loads", 0)) + 1
                if r.returncode == 0:
                    fails = 0
                    _RESIDENT["error"] = ""
                else:
                    fails += 1
                    _RESIDENT["error"] = f"load 失败: {(r.stderr or r.stdout or '').strip()[:200]}"
            except Exception as e:
                fails += 1
                _RESIDENT["error"] = f"load 失败: {type(e).__name__}: {e}"

    threading.Thread(target=_loop, daemon=True, name="resident-keeper").start()
