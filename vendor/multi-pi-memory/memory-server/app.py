"""memory-server FastAPI 入口"""
import asyncio
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from fastapi import FastAPI, Request, UploadFile, File
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
import uvicorn
import numpy as np

from config import load_config
import store
import queue_db
import extract_core
from embedder import Embedder
from extractor import Extractor
from retrieval import Retriever, _group_of
import stability


async def _embed_async(texts: list[str]):
    """把同步的 embedding 调用挪到线程池执行。

    LM Studio 在跑生成任务时, embedding 请求会排队; 若在事件循环里同步等待,
    整个记忆服务（连 /api/status 健康检查）都会假死。挪到线程后事件循环始终可响应。
    """
    return await asyncio.to_thread(embedder.embed, texts)


async def _embed_for_write(texts: list[str]):
    """**写入路径专用**：向量化失败时返回 None，而不是写降级向量。

    2026-10-11 起 embedder 不再静默降级（那会留下永远搜不到的垃圾向量，外部还看不出来）。
    写入路径的目标是"别丢内容"：向量算不出来就存 `embedding=NULL`，记忆本身仍完整，
    只是暂时不可召回；补算走 `POST /api/reembed`。
    """
    try:
        return await _embed_async(texts)
    except Exception as e:
        print(f"[memory] ⚠ 写入向量化失败({e})：本条按“无向量”入库，可用 POST /api/reembed 补算")
        return None


def _uses_lmstudio(c: dict) -> bool:
    """embedding 或 extract 任一为 lmstudio 时, 才需要启动自愈守护。"""
    def p(sec):
        return (c.get(sec, {}).get("provider") or "lmstudio").lower()
    return p("embedding") == "lmstudio" or p("extract") == "lmstudio"


app = FastAPI(title="pi memory-server")
# 供 /api/ping 报告运行时长（进程启动即固定，不随请求变化）
_STARTED = time.time()

cfg = load_config()
embedder = Embedder(cfg)
extractor = Extractor(cfg)
retriever = Retriever(cfg)

# 抽取队列(落盘 SQLite)。默认 ON: 抽取改由独立 worker.py 进程消费,
# HTTP 端点只入队不等待 → pi 永远不被模型推理堵住。
# 兼容: extract.mode=sync 时退回旧行为(同步抽取, 会阻塞)。
extract_mode = (cfg.get("extract", {}).get("mode") or "queue").lower()
queue_db.init_db()

# 启动 LM Studio 自愈守护线程(仅当后端是 lmstudio 时需要; 云端 provider 无此概念)
_daemon = stability.start_daemon() if _uses_lmstudio(cfg) else None

# 让**召回**用的嵌入模型常驻显存(写入慢没关系, 召回必须快)。
# 见 stability.start_resident_keeper 的注释: LM Studio 的 JIT 模型每次请求后就被卸载
# → 每次召回都要重新加载(实测 0.55s); 显式常驻后 0.01~0.02s。
if _uses_lmstudio(cfg) and (cfg.get("embedding", {}) or {}).get("keep_resident", True):
    _ec = cfg.get("embedding", {}) or {}
    stability.start_resident_keeper(
        embedder.model,
        lambda: embedder.embed(["keepalive"]),      # 极轻探针: 常驻时约 15ms
        interval=float(_ec.get("resident_check_seconds", 120)),
        slow_ms=float(_ec.get("resident_slow_ms", 200)),
    )

# 维度守卫: 库中向量维度与当前 embedding 配置不符时, 明确告警
# (换 embedding 模型后未重建索引是最常见的隐性故障)
def _check_dim_guard():
    try:
        _, mat = store.load_embeddings()
        if mat.size == 0:
            return
        db_dim = mat.shape[1]
        want = embedder.dim
        if want and db_dim != want:
            print(f"\n⚠️  维度不匹配: 库中向量为 {db_dim} 维, 但当前 embedding 模型 "
                  f"{embedder.model} 输出 {want} 维。\n"
                  f"    请运行: arch -arm64 .venv/bin/python reembed.py\n"
                  f"    (否则检索结果会不正确)\n")
    except Exception as e:
        print(f"[dim-guard] 检查失败: {type(e).__name__}: {e}")


_check_dim_guard()

WEB_DIR = Path(__file__).parent / "web"
app.mount("/static", StaticFiles(directory=str(WEB_DIR)), name="static")

# 注入日志(内存)
inject_log: list[dict] = []


def _cat_list() -> list[str]:
    # thesis / evidence：MemHub 认知库同步进来的论点与论据
    # 单列两类，是为了让检索时能把「用户档案」与「认知库」区分开，
    # 避免 agent 注入的 top_n 上下文被认知内容挤占。
    return ["fact", "preference", "goal", "decision", "knowledge",
            "thesis", "evidence"]


def _log_inject(query: str, results: list[dict]):
    """记录一次注入的前因后果。

    为什么要记 category 和门槛：
    用户想判断「门槛调得合不合理」，必须能看见「这条为什么进来 /
    那条为什么没进来」。只记分数和内容做不到 —— 看不出分类，
    也就无法判断哪类偏多、哪类被卡掉。
    """
    inject_log.insert(0, {
        "time": time.strftime("%Y-%m-%d %H:%M:%S"),
        "query": query[:80],
        "count": len(results),
        "hits": [{"content": r["content"][:60],
                  "full": r["content"],
                  "category": r["category"],
                  "group": _group_of(r["category"]),
                  "threshold": retriever._min_for(
                      r["category"], _group_of(r["category"])),
                  "score": r["final_score"]} for r in results],
    })
    del inject_log[200:]


# ==================== 页面 ====================

@app.get("/", response_class=HTMLResponse)
async def index():
    return (WEB_DIR / "index.html").read_text(encoding="utf-8")


# ==================== 核心 API ====================

@app.post("/api/extract")
async def api_extract(data: dict):
    """把对话消息**入队**, 立即返回(毫秒级)。

    ★ 关键改动 (2026-10-01): 这里以前是同步抽取, 模型推理几分钟 →
      堵住 uvicorn 事件循环 → pi 连读记忆都要排队 → 卡死 pi。
      实测: 空闲读 0.33s, 抽取进行中读 33.8s (慢 100 倍)。

      现在只做一次 SQLite INSERT 就返回, 真正的抽取由 worker.py
      独立进程消费队列完成 —— 推理多久都与 pi 无关。

    去重策略(在 worker 里执行, 与同步模式共用 extract_core):
      1) 精确匹配: content 完全相同直接跳过
      2) 语义去重: 向量 cosine > DEDUP_SIM 视为同一条
    """
    messages = data.get("messages") or []
    if not messages:
        return JSONResponse({"error": "messages 不能为空"}, status_code=400)
    # namespace: 记忆归属的"人/员工"(multi-pi-memory)。沿用 project 字段存储, 二者都接受。
    project = (data.get("namespace") or data.get("project") or "").strip()
    session_id = data.get("session_id", "")

    # 兼容开关: extract.mode=sync 时退回旧行为(会阻塞, 仅调试用)
    if extract_mode == "sync":
        return await _extract_sync(messages, project, session_id)

    try:
        tid = queue_db.enqueue(messages, session_id=session_id, project=project)
        return {"queued": True, "job_id": tid, "extracted": [],
                "note": "已入队, 由 worker.py 异步抽取"}
    except Exception as e:
        # 入队失败不影响 pi: 降级为丢弃, 只记日志
        print(f"[extract] 入队失败: {type(e).__name__}: {e}")
        return {"queued": False, "extracted": [], "error": f"{type(e).__name__}: {e}"}


async def _extract_sync(messages: list, project: str, session_id: str):
    """同步抽取(旧行为, 阻塞事件循环)。用线程池包裹, 至少不卡住其他请求。"""
    import anyio
    try:
        result = await anyio.to_thread.run_sync(
            lambda: extract_core.extract_and_store(
                messages, project, session_id, extractor, embedder, cfg
            )
        )
        if result.get("dup_skipped"):
            print(f"[extract] 去重跳过 {result['dup_skipped']} 条")
        return result
    except Exception as e:
        print(f"[extract] 失败: {type(e).__name__}: {e}")
        return {"extracted": [], "error": f"{type(e).__name__}: {e}"}


@app.post("/api/inject")
async def api_inject(data: dict):
    """注入检索: 以 query 检索记忆, 返回注入 system 的文本

    namespace 指定"谁在看" —— 只召回该 namespace 的个人记忆(知识库仍全局可见)。
    """
    query = (data.get("query") or "").strip()
    if not query:
        return {"context": "", "results": []}
    namespace = (data.get("namespace") or data.get("project") or "").strip()
    try:
        qv = (await _embed_async([query]))[0]
        results = retriever.search(query, qv, namespace=namespace or None)
        _log_inject(query, results)
        return {"context": retriever.build_inject_context(results), "results": results}
    except Exception as e:
        # 注入在对话关键路径上: 任何异常都必须降级为空上下文, 绝不能 500
        print(f"[inject] 检索失败, 降级为空上下文: {type(e).__name__}: {e}")
        return {"context": "", "results": [], "error": f"{type(e).__name__}: {e}"}


@app.post("/api/search")
async def api_search(data: dict):
    """agent 主动检索(仅知识库或全部)"""
    query = (data.get("query") or "").strip()
    if not query:
        return JSONResponse({"error": "query 不能为空"}, status_code=400)
    try:
        qv = embedder.embed([query])[0]
        source = data.get("source")  # "knowledge" | "memory" | None(全部)
        namespace = (data.get("namespace") or data.get("project") or "").strip()
        results = retriever.search(query, qv, source=source, n=data.get("n") or 8,
                                   namespace=namespace or None)
        return {"results": results}
    except Exception as e:
        print(f"[search] 检索失败: {type(e).__name__}: {e}")
        return {"results": [], "error": f"{type(e).__name__}: {e}"}


# ==================== 记忆管理 ====================

@app.get("/api/memories")
async def api_memories(category: str | None = None, source: str | None = None, limit: int = 500,
                       namespace: str | None = None):
    """列出记忆；传 namespace 只看该命名空间（不传则全部）。"""
    return {"memories": store.list_memories(limit=limit, category=category, source=source,
                                            namespace=namespace)}


@app.post("/api/memories")
async def api_add_memory(data: dict):
    content = (data.get("content") or "").strip()
    if not content:
        return JSONResponse({"error": "内容不能为空"}, status_code=400)
    category = data.get("category", "fact")
    if category not in _cat_list():
        return JSONResponse({"error": f"category 非法: {category}"}, status_code=400)
    # 手动保存同样归属某个命名空间（存储上即 project 列）
    ns = (data.get("namespace") or data.get("project") or "").strip()
    vecs = await _embed_for_write([content])
    mem = store.add_memory(content, category=category, source="manual", project=ns,
                           embedding=None if vecs is None else vecs[0])
    return {"memory": mem, "embedded": vecs is not None}


@app.delete("/api/memories/{mid}")
async def api_delete_memory(mid: str):
    store.delete_memory(mid)
    return {"status": "ok"}


# ==================== 知识库 ====================

def _chunk_text(text: str, max_len: int = 500) -> list[str]:
    """按段落切块, 超长再按句切"""
    text = text.strip()
    if not text:
        return []
    chunks = []
    for para in text.split("\n\n"):
        para = para.strip()
        if not para:
            continue
        if len(para) <= max_len:
            chunks.append(para)
            continue
        # 按句切
        for sent in para.replace("。", "。\n").replace("！", "！\n").replace("？", "？\n").split("\n"):
            sent = sent.strip()
            if sent:
                chunks.append(sent[:max_len])
    return [c for c in chunks if c]


async def _import_text(text: str, title: str) -> dict:
    """切块 → 向量化 → 入库(category=knowledge), 返回 {added, chunks}"""
    chunks = _chunk_text(text)
    if not chunks:
        return {"added": 0, "chunks": 0}
    # 每块带标题前缀, 提升检索命中率
    tagged = [f"[{title}] {c}" for c in chunks]
    vecs = await _embed_for_write(tagged)
    existing = {m["content"] for m in store.list_memories(limit=5000)}
    added = 0
    for content, v in zip(tagged, vecs or [None] * len(tagged)):
        if content in existing:
            continue
        store.add_memory(content, category="knowledge", source="knowledge", embedding=v)
        added += 1
    return {"added": added, "chunks": len(chunks)}


@app.post("/api/knowledge")
async def api_add_knowledge(data: dict):
    """导入知识库文档(粘贴文本): 切块 → 向量化 → 入库(category=knowledge)"""
    text = (data.get("text") or "").strip()
    if not text:
        return JSONResponse({"error": "文本不能为空"}, status_code=400)
    title = (data.get("title") or "").strip()[:60] or f"文档{int(time.time())}"
    return await _import_text(text, title)


@app.post("/api/knowledge/upload")
async def api_upload_knowledge(file: UploadFile = File(...)):
    """导入知识库文档(上传文件, 支持 md/txt): 读取 → 切块 → 向量化 → 入库"""
    filename = file.filename or ""
    suffix = Path(filename).suffix.lower()
    if suffix not in (".md", ".markdown", ".txt", ""):
        return JSONResponse({"error": f"不支持的文件类型: {suffix or '(无扩展名)'}, 仅支持 md/txt"}, status_code=400)
    try:
        raw = await file.read()
    except Exception as e:
        return JSONResponse({"error": f"读取文件失败: {e}"}, status_code=400)
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        try:
            text = raw.decode("gbk")
        except UnicodeDecodeError:
            return JSONResponse({"error": "文件编码无法识别, 请使用 UTF-8 编码"}, status_code=400)
    title = Path(filename).stem[:60]
    result = await _import_text(text, title)
    return {"title": title, "filename": filename, **result}


@app.get("/api/knowledge")
async def api_knowledge():
    mems = store.list_memories(source="knowledge", limit=1000)
    # 按标题聚合计数
    from collections import Counter
    titles = Counter(
        (m["content"].split("]")[0].strip("[").strip() if "]" in m["content"] else "未命名")
        for m in mems
    )
    return {"documents": [{"title": t, "chunks": c} for t, c in titles.items()],
            "total_chunks": len(mems)}


# ==================== 状态与配置 ====================

@app.get("/api/ping")
async def api_ping():
    """轻量存活探针：**不碰** stability / lms / embedding。

    为什么要单独开一个：`/api/status` 会同步调 `lms ps`（子进程，最长 30s），
    外部探活用 1~2s 超时会误判"服务已死"——看板的记忆灯就是这样间歇性闪红的。
    探活只该回答"你还活着吗"，不该回答"你的模型都加载了吗"。
    """
    return {"ok": True, "uptime": round(time.time() - _STARTED, 1)}


_EMB_CACHE: dict = {"at": 0.0, "ok": True, "degraded": 0, "error": ""}


async def _embedding_health() -> dict:
    """嵌入是否**真的**可用 + 库里有多少条降级向量。结果缓存 60s。

    为什么必须真探一次：老代码用 `stability.is_loaded()`（内部走 `lms ps`），
    而 **`lms ps` 根本不列嵌入模型**，于是永远返回 loaded=false ——
    外部（含看板、用户）看着像"记忆没启动"，实际检索是好的。
    """
    now = time.time()
    if now - _EMB_CACHE["at"] < 60:
        return {"model": embedder.model, "dim": embedder.dim, "base_url": embedder.base_url,
                "ok": _EMB_CACHE["ok"], "degraded_rows": _EMB_CACHE["degraded"],
                "error": _EMB_CACHE["error"], "cached": True,
                # 常驻保活状态**每次现取**：它每 2 分钟变一次，被 60s 缓存冻住就看不到真相了
                # （2026-10-11 修：缓存路径漏了这个字段，板子上"常驻"一栏一直空着）
                "resident": stability.resident_stats()}
    ok, err = True, ""
    try:
        ok = await asyncio.to_thread(embedder.probe)
        if not ok:
            err = "不可服务（模型未安装 / LM Studio 未启动）"
    except Exception as e:
        ok, err = False, f"{type(e).__name__}: {e}"
    try:
        degraded = await asyncio.to_thread(lambda: len(store.degraded_rows()))
    except Exception:
        degraded = -1
    _EMB_CACHE.update({"at": now, "ok": ok, "degraded": degraded, "error": err})
    return {"model": embedder.model, "dim": embedder.dim, "base_url": embedder.base_url,
            "ok": ok, "degraded_rows": degraded, "error": err, "cached": False,
            # 常驻保活状态: last_ms 就是"召回要付的固定开销", 超过 200ms 说明被卸载了
            "resident": stability.resident_stats()}


@app.post("/api/reembed")
async def api_reembed():
    """把库里的**降级向量**（hash 垃圾向量，全非负）重算回真实向量。

    何时用：embedding 曾失败过（模型未加载 / 瞬时 4xx）的那些条目 —— 它们在检索里等于不存在。
    """
    rows = await asyncio.to_thread(store.degraded_rows)
    if not rows:
        return {"reembedded": 0, "degraded_rows": 0}
    fixed = 0
    for r in rows:
        try:
            vecs = await _embed_async([r["content"]])
        except Exception as e:
            return JSONResponse({"error": f"向量化仍失败（已修 {fixed}/{len(rows)}）：{e}"}, status_code=503)
        store.update_embedding(r["id"], vecs[0])
        fixed += 1
    _EMB_CACHE["at"] = 0.0  # 让下一次 status 重新统计
    return {"reembedded": fixed, "degraded_rows": len(rows) - fixed}


@app.get("/api/status")
async def api_status():
    # stability.stats() 内部会 `lms ps`（同步子进程，最长 30s）。挪到线程执行，
    # 否则它会堵住事件循环，连 /api/ping 都一并变慢。
    stability_info = await asyncio.to_thread(
        lambda: {"daemon": stability.daemon_stats(), "models": stability.stats()})
    return {"stats": store.stats(),
            "embedding": await _embedding_health(),
            "extract": {"model": extractor.model},
            "retrieval": {k: getattr(retriever, k) for k in
                          ("top_n", "min_score", "cliff_ratio", "keyword_boost", "k_candidates", "quota")},
            "retrieval_min": {
                # 线上实际生效的分层召回门槛，便于排查"为何某条没被召回"
                "cat_min": retriever.cat_min,
                "group_min": retriever.group_min,
                "effective": {c: retriever._min_for(c, _group_of(c))
                              for c in ("preference", "goal", "decision", "fact",
                                        "thesis", "evidence", "knowledge")},
            },
            "stability": stability_info}


@app.get("/api/health")
async def api_health():
    """主动健康检查: 探测模型是否可用(供外部监控/排障用)。"""
    if _uses_lmstudio(cfg):
        # 两个都用 **HTTP 探活**（`probe()`）：`lms ps` 又慢又会挂，而且对按需加载的模型
        # 一律报未加载 —— 于是 /api/health 无脑 ok:false，外面看着像"记忆没启动"。
        # 真实判据应该是"这个模型现在能不能被我调用"，不是"它在不在显存里"。
        emb_ok = await asyncio.to_thread(embedder.probe)
        ext_ok = await asyncio.to_thread(extractor.probe)
    else:
        emb_ok = ext_ok = True  # 云端 provider: 不探测加载状态
    daemon = stability.daemon_stats() if _uses_lmstudio(cfg) else {"running": False}
    try:
        q = queue_db.stats()
    except Exception as e:
        q = {"error": f"{type(e).__name__}: {e}"}
    return {"ok": emb_ok and ext_ok,
            "providers": {"embedding": embedder.provider_name,
                          "extract": extractor.provider_name},
            "embedding": {"model": embedder.model, "dim": embedder.dim, "loaded": emb_ok},
            "extract": {"model": extractor.model, "loaded": ext_ok,
                        "mode": extract_mode},
            "queue": q,
            "queue_alert": (daemon.get("queue_check") or {}),
            "daemon": daemon}


@app.get("/api/logs")
async def api_logs():
    return {"logs": inject_log}


@app.get("/api/config")
async def api_get_config():
    return {"config": cfg}


@app.post("/api/config")
async def api_set_config(data: dict):
    """更新检索参数并保存到 config.yaml"""
    global retriever
    r = cfg.setdefault("retrieval", {})
    for k in ("top_n", "min_score", "cliff_ratio", "keyword_boost", "k_candidates"):
        if k in data:
            r[k] = data[k]
    import yaml
    from config import CONFIG_PATH
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        yaml.dump(cfg, f, allow_unicode=True, default_flow_style=False, sort_keys=False)
    retriever = Retriever(cfg)
    return {"status": "ok", "retrieval": {k: getattr(retriever, k) for k in
                                          ("top_n", "min_score", "cliff_ratio", "keyword_boost", "k_candidates")}}


def main():
    server = cfg.get("server", {})
    host = server.get("host", "127.0.0.1")
    port = server.get("port", 8970)
    print(f"\npi memory-server: http://{host}:{port}")
    print(f"  embedding: {embedder.model} (dim={embedder.dim})")
    uvicorn.run(app, host=host, port=port, log_level="warning")


if __name__ == "__main__":
    main()
