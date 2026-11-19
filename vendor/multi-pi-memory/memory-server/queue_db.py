"""抽取任务队列: SQLite 持久化 + 多进程安全

设计要点
--------
- **持久化**: 任务落盘, 进程崩溃/重启不丢任务(比内存队列强)
- **多进程安全**: SQLite WAL 模式 + `BEGIN IMMEDIATE` 原子认领,
  多个 worker 并发也不会重复消费
- **崩溃恢复**: 启动时把卡在 `running` 超时的任务打回 `pending`
- **入队即返回**: 生产者(HTTP 端点)只做一次 INSERT, 毫秒级返回

状态机
------
pending ──claim──> running ──成功──> done
                      │
                      ├──失败(未超次数)──> pending (下次重试)
                      └──失败(超次数)────> failed
"""
import json
import sqlite3
import time
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent / "data"
DB_PATH = DATA_DIR / "memory.db"

# 同一任务最多尝试几次, 超过进 failed
MAX_ATTEMPTS = 3
# 心跳超时: 任务的 claimed_at 超过这个时间没被刷新 → 判定 worker 已死。
# 长任务靠 touch() 续命, 所以这个值只需覆盖「worker 两次心跳之间」的间隔。
HEARTBEAT_TIMEOUT_SEC = 120
# 保留旧名字供外部引用(不再使用其原语义)
STALE_RUNNING_SEC = HEARTBEAT_TIMEOUT_SEC


def _conn() -> sqlite3.Connection:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=30, isolation_level=None)
    # WAL: 读写不互相阻塞, 这是"读不被写堵住"的关键
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=30000")
    conn.execute("PRAGMA synchronous=NORMAL")
    return conn


def init_db():
    """建队列表。幂等, 可重复调用。"""
    conn = _conn()
    try:
        conn.execute("""CREATE TABLE IF NOT EXISTS extract_queue (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT DEFAULT '',
            project TEXT DEFAULT '',
            payload TEXT NOT NULL,        -- JSON: [{role, content}, ...]
            status TEXT NOT NULL DEFAULT 'pending',
            attempts INTEGER NOT NULL DEFAULT 0,
            error TEXT DEFAULT '',
            created_at REAL NOT NULL,
            claimed_at REAL,
            finished_at REAL
        )""")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_q_status ON extract_queue(status, id)")
    finally:
        conn.close()


def enqueue(messages: list[dict], session_id: str = "", project: str = "") -> int:
    """入队。O(1) 一次 INSERT, 调用方立即返回。返回任务 id。"""
    conn = _conn()
    try:
        cur = conn.execute(
            "INSERT INTO extract_queue (session_id, project, payload, status, created_at) "
            "VALUES (?, ?, ?, 'pending', ?)",
            (session_id, project, json.dumps(messages, ensure_ascii=False), time.time()),
        )
        return int(cur.lastrowid)
    finally:
        conn.close()


def claim() -> dict | None:
    """原子认领一个待处理任务。没有则返回 None。

    用 BEGIN IMMEDIATE 拿写锁: 同一时刻只有一个 worker 能认领到同一条,
    避免多 worker 重复消费。
    """
    conn = _conn()
    try:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute(
            "SELECT id, session_id, project, payload, attempts FROM extract_queue "
            "WHERE status='pending' ORDER BY id LIMIT 1"
        ).fetchone()
        if not row:
            conn.execute("COMMIT")
            return None
        tid = row[0]
        conn.execute(
            "UPDATE extract_queue SET status='running', claimed_at=?, attempts=attempts+1 WHERE id=?",
            (time.time(), tid),
        )
        conn.execute("COMMIT")
        return {
            "id": tid,
            "session_id": row[1],
            "project": row[2],
            "messages": json.loads(row[3]),
            "attempts": row[4] + 1,
        }
    except Exception:
        try:
            conn.execute("ROLLBACK")
        except Exception:
            pass
        raise
    finally:
        conn.close()


def peek_pending(limit: int = 50) -> list[dict]:
    """看队列里有什么（**不认领**）。用于"攒够再跑"的批处理规划。

    为什么需要 peek 而不是直接 claim：认领后状态就变成 running，不处理就得打回；
    而我们要先判断"这一批够不够 extract.min_tokens、最久的那条等够 max_wait 了吗"，
    不够就**原样留在队列里**（写入可以慢，但绝不能把还没到点的任务抓在手里）。
    """
    conn = _conn()
    try:
        rows = conn.execute(
            "SELECT id, session_id, project, payload, created_at FROM extract_queue "
            "WHERE status='pending' ORDER BY id LIMIT ?", (limit,)).fetchall()
    finally:
        conn.close()
    return [{"id": r[0], "session_id": r[1], "project": r[2],
             "messages": json.loads(r[3] or "[]"), "created_at": r[4]} for r in rows]


def claim_ids(ids: list[int]) -> list[dict]:
    """原子认领**指定**的一批任务（语义同 claim，只是认哪几条由调用方决定）。

    批处理必须按 id 认领：队列里可能混着不同员工/会话的任务，
    连续调 claim() 会把别家的任务也抓走，跨命名空间混着抽取就串味了。
    """
    if not ids:
        return []
    conn = _conn()
    try:
        conn.execute("BEGIN IMMEDIATE")
        qs = ",".join("?" * len(ids))
        rows = conn.execute(
            f"SELECT id, session_id, project, payload, attempts FROM extract_queue "
            f"WHERE id IN ({qs}) AND status='pending' ORDER BY id", ids).fetchall()
        for r in rows:
            conn.execute(
                "UPDATE extract_queue SET status='running', claimed_at=?, attempts=attempts+1 WHERE id=?",
                (time.time(), r[0]),
            )
        conn.execute("COMMIT")
    except Exception:
        try:
            conn.execute("ROLLBACK")
        except Exception:
            pass
        raise
    finally:
        conn.close()
    return [{"id": r[0], "session_id": r[1], "project": r[2],
             "messages": json.loads(r[3] or "[]"), "attempts": r[4] + 1} for r in rows]


def finish(tid: int, error: str = ""):
    """标记任务完成; 有 error 则按重试次数决定回到 pending 还是 failed"""
    conn = _conn()
    try:
        if error:
            row = conn.execute("SELECT attempts FROM extract_queue WHERE id=?", (tid,)).fetchone()
            attempts = row[0] if row else MAX_ATTEMPTS
            if attempts >= MAX_ATTEMPTS:
                conn.execute(
                    "UPDATE extract_queue SET status='failed', error=?, finished_at=? WHERE id=?",
                    (error[:500], time.time(), tid),
                )
            else:
                conn.execute(
                    "UPDATE extract_queue SET status='pending', error=?, claimed_at=NULL WHERE id=?",
                    (error[:500], tid),
                )
        else:
            # 任务成功 → 抹掉原始对话内容。
            # payload 是完整的原始对话，可能含凭据/隐私；抽完就没用了，
            # 留着只会让敏感数据长期驻盘（甚至会随备份/仓库外流）。
            # 2026-10-01: 实测在 queue 里发现了明文 GitHub token 才加的这一手。
            conn.execute(
                "UPDATE extract_queue SET status='done', error='', finished_at=?, payload='[]' "
                "WHERE id=?",
                (time.time(), tid),
            )
    finally:
        conn.close()


def requeue_stale():
    """把卡在 running 超时的任务打回 pending。worker 启动时和运行中都会调用。

    2026-10-06 修复的时序漏洞
    ------------------------
    修复前: 本函数只在 worker 启动时调一次, 且阈值 900s。后果是一个
    25 分钟的死区:
        T+0     worker A 被 kill, 任务 X 卡在 running
        T+30s   守护脚本拉起 worker B
        T+30s   worker B 调 requeue_stale() —— X 只卡了 30s < 900s, 收回不了
        ...     worker B 继续消费 pending 队列, 而 X 永远没人管
    实测发生过: 任务 #105 被这样孤立在 running 里。

    现在靠 touch() 心跳: worker 每轮循环刷新 claimed_at, 只要没刷新超过
    HEARTBEAT_TIMEOUT_SEC 就说明持有者已死, 无论 worker 重启多少次都能收回。
    """
    conn = _conn()
    try:
        cutoff = time.time() - HEARTBEAT_TIMEOUT_SEC
        cur = conn.execute(
            "UPDATE extract_queue SET status='pending', claimed_at=NULL "
            "WHERE status='running' AND (claimed_at IS NULL OR claimed_at < ?)",
            (cutoff,),
        )
        return cur.rowcount
    finally:
        conn.close()


def touch(tid: int):
    """心跳: 刷新任务的 claimed_at, 表示「我还活着, 正在处理它」。

    长任务(模型推理可能几分钟)靠它续命, 避免被 requeue_stale() 误判成死任务。
    """
    conn = _conn()
    try:
        conn.execute(
            "UPDATE extract_queue SET claimed_at=? WHERE id=? AND status='running'",
            (time.time(), tid),
        )
    finally:
        conn.close()


def purge_done(keep_hours: int = 24):
    """清理已完成的旧任务, 避免表无限增长。"""
    conn = _conn()
    try:
        cutoff = time.time() - keep_hours * 3600
        cur = conn.execute(
            "DELETE FROM extract_queue WHERE status='done' AND finished_at < ?", (cutoff,)
        )
        return cur.rowcount
    finally:
        conn.close()


def stats() -> dict:
    """队列状态, 给 /api/health 用"""
    conn = _conn()
    try:
        rows = conn.execute(
            "SELECT status, COUNT(*) FROM extract_queue GROUP BY status"
        ).fetchall()
        out = {s: 0 for s in ("pending", "running", "done", "failed")}
        for s, c in rows:
            out[s] = c
        # 最老 pending 任务的等待时长
        row = conn.execute(
            "SELECT MIN(created_at) FROM extract_queue WHERE status='pending'"
        ).fetchone()
        out["oldest_pending_age"] = round(time.time() - row[0], 1) if row and row[0] else 0.0
        return out
    finally:
        conn.close()


if __name__ == "__main__":
    init_db()
    print("extract_queue 已就绪:", stats())


def vacuum():
    """回收空闲页 —— 让 SQLite 真正覆写已删除数据的字节。

    finish() 会把完成任务的 payload 抹成 '[]'，但 SQLite 的页管理不会立刻
    覆写磁盘上的旧字节，明文可能仍残留在空闲页里。VACUUM 会重建整库。
    2026-10-01: 在 queue 里发现明文 token 残留后加的这一手。
    """
    conn = _conn()
    try:
        conn.execute("VACUUM")
        return True
    except Exception:
        return False
    finally:
        conn.close()
