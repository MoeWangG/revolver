"""独立抽取 worker —— 平行于 pi 的进程, 从队列取任务慢慢处理

为什么要有这个进程
------------------
改造前: 抽取在 HTTP 请求里同步跑, 模型推理几分钟 → 堵住 uvicorn 事件循环
        → pi 连"读记忆"都要排队等 → 卡死 pi。
        实测: 空闲读 0.33s, 抽取进行中读 33.8s (慢 100 倍)。

改造后: HTTP 端点只往 SQLite 队列 INSERT 一行就返回(毫秒级)。
        这个进程慢慢消费队列, 抽多久都跟 pi 无关。

进程模型
--------
    pi ──POST /api/extract (毫秒返回)──> SQLite 队列 <──claim── worker.py
                                              │
                                              └──> 模型推理(几分钟) ──> 入库

崩溃恢复
--------
- 任务落盘 SQLite, worker 崩了任务还在
- 启动时把 running 超时的任务打回 pending
- 拿到任务后即使 worker 被杀, 超时后也会被重新认领

用法
----
    python worker.py              # 前台, 看日志
    python worker.py --once       # 处理完当前队列就退出(测试用)
"""
import argparse
import logging
import signal
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import queue_db
from config import load_config
from embedder import Embedder
from extractor import Extractor
import extract_core

POLL_INTERVAL = 3.0          # 队列空时睡多久再问
IDLE_DEEP_SLEEP_AFTER = 20   # 连续空转多少次后加大间隔(省 CPU)
DEEP_SLEEP_INTERVAL = 15.0
# 心跳间隔: 必须显著小于 queue_db.HEARTBEAT_TIMEOUT_SEC(120s),
# 否则正常跑着的长任务会被 requeue_stale() 误判回收。
HEARTBEAT_INTERVAL = 20.0
# 空转时多久做一次孤儿任务回收 —— 不能只依赖启动时那一次,
# 因为拉起新 worker 往往发生在旧任务刚卡住的瞬间(详见 queue_db.requeue_stale)
REQUEUE_SCAN_EVERY_IDLE = 10
# ★ 任务之间主动歇一会儿: worker 和 pi 可能共用同一个 LM Studio,
#   连着跑会让 pi 的注入/回忆请求排队等模型。留个空档让 pi 优先。
COOLDOWN_BETWEEN_JOBS = 2.0
# 队列里只有 1 条任务时, 先等一会儿再消费 —— 单条任务往往是
# 用户刚聊完就关会话留下的尾巴, 稍等能避开 pi 下一次启动的注入窗口。
PICKUP_DELAY = 1.5

log = logging.getLogger("worker")


# ★ 抽取攒批（2026-11-11 起）
# 写入可以慢, 但别每 2 轮就把 6.9GB 模型拉起来跑 90 秒 —— 攒够 token 再启动。
# 触发条件三者取其一:
#   攒够 min_tokens / 最久的那条等够 max_wait_seconds / 攒到 max_merge_tokens 上限。
# 没到点就原样留在队列里(peek, 不认领), 所以召回永远不被抽取排队拖累。
DEFAULT_MIN_TOKENS = 3000
DEFAULT_MAX_WAIT_SECONDS = 1800.0
DEFAULT_MAX_MERGE_TOKENS = 12000
DEFAULT_MAX_JOBS_PER_BATCH = 12


def est_tokens(messages: list[dict]) -> int:
    """粗估 token 数: CJK 约 1 token/字, 其余约 1/4。只用于判断"攒够没"。"""
    n = 0
    for m in messages:
        s = str(m.get("content") or "")
        cjk = sum(1 for ch in s if "一" <= ch <= "鿿")
        n += cjk + (len(s) - cjk) // 4
    return n


class Worker:
    def __init__(self, cfg: dict):
        self.cfg = cfg
        self.extractor = Extractor(cfg)
        self.embedder = Embedder(cfg)
        self.running = True
        self.processed = 0
        self.failed = 0
        self.batches = 0
        ex = cfg.get("extract", {}) or {}
        self.min_tokens = int(ex.get("min_tokens", DEFAULT_MIN_TOKENS))
        self.max_wait = float(ex.get("max_wait_seconds", DEFAULT_MAX_WAIT_SECONDS))
        self.max_merge_tokens = int(ex.get("max_merge_tokens", DEFAULT_MAX_MERGE_TOKENS))
        self.max_jobs = int(ex.get("max_jobs_per_batch", DEFAULT_MAX_JOBS_PER_BATCH))

    def stop(self, *_):
        log.info("收到停止信号, 处理完当前任务后退出...")
        self.running = False

    def _plan_batch(self):
        """这一轮跑哪几条? 返回 (peek 列表, 估算 token, 最久等待秒) 或 None。

        **按 (员工 project, 会话 session) 分组**: 绝不能跨命名空间合并抽取 ——
        混着抽会把 A 员工的记忆写进 B 员工名下, 隔离就漏了。
        """
        pending = queue_db.peek_pending(limit=max(self.max_jobs * 4, 40))
        if not pending:
            return None
        now = time.time()
        groups: dict = {}
        for j in pending:
            groups.setdefault((j.get("project", ""), j.get("session_id", "")), []).append(j)

        ready = []
        for jobs in groups.values():
            jobs.sort(key=lambda j: j["id"])
            oldest_age = now - (jobs[0].get("created_at") or now)
            picked, tok = [], 0
            for j in jobs:
                if len(picked) >= self.max_jobs or tok >= self.max_merge_tokens:
                    break
                picked.append(j)
                tok += est_tokens(j["messages"])
            if tok >= self.min_tokens or oldest_age >= self.max_wait:
                ready.append((picked, tok, oldest_age))
        if not ready:
            return None
        # 先跑"最该跑"的: 等得最久的那组
        ready.sort(key=lambda x: -x[2])
        return ready[0]

    def run_one(self) -> bool:
        """认领并处理**一批**任务(攒够才跑)。真的跑了返回 True。"""
        plan = self._plan_batch()
        if plan is None:
            return False
        peeked, tok, age = plan

        # 消费前留个空档, 降低和 pi 抢模型的概率
        time.sleep(PICKUP_DELAY)
        jobs = queue_db.claim_ids([j["id"] for j in peeked])
        if not jobs:
            return False
        ids = [j["id"] for j in jobs]

        merged: list[dict] = []
        for j in jobs:
            merged.extend(j["messages"])
        self.batches += 1
        log.info(f"批次 #{self.batches} 开始: 合并 {len(jobs)} 个任务 / {len(merged)} 条消息 ≈{tok} token"
                 f"(最久等待 {age / 60:.1f} 分钟, 门槛 {self.min_tokens})")

        # 心跳线程: 模型推理可能几分钟, 期间必须不断刷新 claimed_at,
        # 否则会被 requeue_stale() 当成死任务收回 —— 导致同一任务被两个
        # worker 同时跑(重复抽取 + 重复入库)。
        hb_stop = threading.Event()
        hb = threading.Thread(target=self._heartbeat, args=(ids, hb_stop),
                              daemon=True, name=f"hb-{'-'.join(str(i) for i in ids[:3])}")
        hb.start()

        t0 = time.time()
        try:
            # 批次开始前先把抽取模型拉起来(带 TTL, 用完自己卸载)。
            # 不做这一步, 模型可能刚被 TTL 卸载, 请求同一瞬间到达就是 400, 整批白跑(实测踩过)。
            try:
                _lt = int((self.cfg.get("extract", {}) or {}).get("load_ttl_seconds", 600))
                if not self.extractor.load_now(_lt):
                    log.warning("抽取模型未能确认加载完成, 仍尝试执行(可能整批失败)")
            except Exception as e:
                log.warning(f"预加载抽取模型失败: {type(e).__name__}: {e}")
            # 推理可能耗时几分钟, 这里阻塞完全没问题 —— 只卡住本进程
            result = extract_core.extract_and_store(
                messages=merged,
                project=jobs[0].get("project", ""),
                session_id=jobs[0].get("session_id", ""),
                extractor=self.extractor,
                embedder=self.embedder,
                cfg=self.cfg,
            )
            elapsed = time.time() - t0
            got = len(result.get("extracted", []))
            dup = result.get("dup_skipped", 0)
            for tid in ids:
                queue_db.finish(tid, error="")
            self.processed += len(ids)
            log.info(f"批次完成: 入库 {got} 条, 去重跳过 {dup} 条, 耗时 {elapsed:.1f}s"
                     f"(单次推理均摊 {(elapsed / max(len(ids), 1)):.1f}s/任务)")
        except Exception as e:
            elapsed = time.time() - t0
            for tid in ids:
                queue_db.finish(tid, error=f"{type(e).__name__}: {e}")
            self.failed += len(ids)
            log.error(f"批次失败 ({elapsed:.1f}s): {type(e).__name__}: {e}")
        finally:
            hb_stop.set()
            hb.join(timeout=1)
        return True

    def _heartbeat(self, tids, stop: threading.Event):
        """周期性刷新 claimed_at, 直到任务结束。

        顺带做孤儿回收: 必须在本线程做, 不能放在 loop() 里 —— loop() 在
        处理任务期间是阻塞的(run_one 里跑完整推理), 期间看不到别的孤儿。
        实测: 旧 worker 被杀后, #106 卡在 running 要等 #105 跑完才被发现。
        """
        while not stop.wait(HEARTBEAT_INTERVAL):
            for tid in tids:
                try:
                    queue_db.touch(tid)
                except Exception as e:
                    log.warning(f"任务 #{tid} 心跳失败: {type(e).__name__}: {e}")
            try:
                n = queue_db.requeue_stale()
                if n:
                    log.warning(f"巡检发现 {n} 个孤儿任务(worker 曾崩溃), 已打回队列")
            except Exception as e:
                log.warning(f"孤儿任务回收失败: {type(e).__name__}: {e}")

    def loop(self, once: bool = False):
        idle = 0
        log.info("worker 就绪, 开始消费队列")
        while self.running:
            try:
                did = self.run_one()
            except Exception as e:
                # 认领环节本身的异常(比如 DB 锁), 不致命
                log.error(f"认领任务异常: {type(e).__name__}: {e}")
                did = False

            if did:
                idle = 0
                # 任务之间歇一下, 让 pi 的即时请求(注入/回忆)优先拿到模型
                time.sleep(COOLDOWN_BETWEEN_JOBS)
                continue
            if once:
                log.info("队列已空, --once 模式退出")
                break

            idle += 1
            # 周期性回收孤儿任务: 覆盖「worker 死后立刻被拉起」这个时序漏洞
            if idle % REQUEUE_SCAN_EVERY_IDLE == 0:
                try:
                    n = queue_db.requeue_stale()
                    if n:
                        log.warning(f"巡检发现 {n} 个孤儿任务(worker 曾崩溃), 已打回队列")
                        idle = 0
                except Exception as e:
                    log.error(f"孤儿任务回收异常: {type(e).__name__}: {e}")
            time.sleep(DEEP_SLEEP_INTERVAL if idle > IDLE_DEEP_SLEEP_AFTER else POLL_INTERVAL)

        log.info(f"worker 退出 (处理 {self.processed} 个, 失败 {self.failed} 个)")


def main():
    ap = argparse.ArgumentParser(description="记忆抽取队列 worker")
    ap.add_argument("--once", action="store_true", help="处理完当前队列即退出")
    ap.add_argument("--verbose", action="store_true", help="打印 debug 日志")
    args = ap.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s [worker] %(levelname)s %(message)s",
        datefmt="%H:%M:%S",
    )

    queue_db.init_db()
    stale = queue_db.requeue_stale()
    if stale:
        log.warning(f"发现 {stale} 个超时未完成的任务, 已打回队列重试")
    purged = queue_db.purge_done()
    if purged:
        log.info(f"清理了 {purged} 条历史完成任务")
    # 回收空闲页: 完成的任务虽然逻辑上已抹掉 payload, 但原始字节可能仍留在
    # SQLite 空闲页里, 需要 VACUUM 才能真正覆写。启动时做一次即可。
    queue_db.vacuum()

    cfg = load_config()
    w = Worker(cfg)
    signal.signal(signal.SIGTERM, w.stop)
    signal.signal(signal.SIGINT, w.stop)
    w.loop(once=args.once)


if __name__ == "__main__":
    main()
