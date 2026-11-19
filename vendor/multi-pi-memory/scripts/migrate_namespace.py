#!/usr/bin/env python3
"""把已有记忆按 `session_id` 反推所属员工，回填命名空间（存储上即 `project` 列）。

背景
----
早期抽取链路没有传命名空间，库内 `project` 全是空串 —— 所有员工的记忆混在一个库里。
好在每条记忆都留下了 `session_id`，而 waker 拉起的 pi 会话 id 形如：

    waker-<员工id>            （该员工的默认会话）
    waker-<员工id>-<短hash>   （该员工新建的会话 / 定时任务会话）

据此可以反推出绝大多数记忆的归属。反推不出来的（如独立使用 pi 的会话 `heartbeat`、
外部工具的临时会话）保留为空 —— 视为"公共/未分类"：按人隔离时不会被任何员工召回。

用法
----
    python3 scripts/migrate_namespace.py                 # 干跑，只报告
    python3 scripts/migrate_namespace.py --apply         # 真正写入
    python3 scripts/migrate_namespace.py --apply --db /path/to/memory.db
"""
from __future__ import annotations

import argparse
import json
import re
import sqlite3
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_DB = HERE.parent / "memory-server" / "data" / "memory.db"
PLATFORM_ROOT = HERE.parent.parent.parent  # platform/


def detect_wakers() -> list[str]:
    """收集员工 id：项目内 agents/ + data/sessions.json + 纳管的 Pi profile。"""
    ids: set[str] = set()

    agents_dir = PLATFORM_ROOT / "agents"
    if agents_dir.is_dir():
        for p in agents_dir.iterdir():
            if p.is_dir() and (p / "waker.yaml").exists():
                ids.add(p.name)

    sessions_file = PLATFORM_ROOT / "data" / "sessions.json"
    if sessions_file.exists():
        try:
            data = json.loads(sessions_file.read_text(encoding="utf-8"))
            ids.update(str(k) for k in data.keys())
        except Exception as e:  # noqa: BLE001
            print(f"  ! 读取 sessions.json 失败（忽略）：{e}")

    pi_agents = Path.home() / ".pi" / "agent" / "agents"
    if pi_agents.is_dir():
        for p in pi_agents.glob("*.md"):
            ids.add(p.stem)

    return sorted(i for i in ids if i and i not in {"settings"})


def infer_namespace(session_id: str, wakers: list[str]) -> str:
    """`waker-<id>` / `waker-<id>-<hash>` → `<id>`；取最长前缀匹配（员工 id 本身可能含 `-`）。"""
    if not session_id or not session_id.startswith("waker-"):
        return ""
    rest = session_id[len("waker-"):]
    best = ""
    for w in wakers:
        if rest == w or rest.startswith(w + "-"):
            if len(w) > len(best):
                best = w
    return best


def main() -> int:
    ap = argparse.ArgumentParser(description="按 session_id 回填记忆命名空间")
    ap.add_argument("--db", default=str(DEFAULT_DB), help=f"memory.db 路径（默认 {DEFAULT_DB}）")
    ap.add_argument("--apply", action="store_true", help="真正写库；不加则只干跑")
    ap.add_argument("--wakers", default="", help="手动指定员工 id（逗号分隔），默认自动探测")
    args = ap.parse_args()

    db = Path(args.db)
    if not db.exists():
        print(f"× 找不到数据库：{db}")
        return 1

    wakers = [w.strip() for w in args.wakers.split(",") if w.strip()] or detect_wakers()
    print(f"数据库：{db}")
    print(f"员工（{len(wakers)}）：{', '.join(wakers) or '(无)'}")

    conn = sqlite3.connect(db)
    rows = conn.execute("SELECT id, session_id, COALESCE(project, '') FROM memories").fetchall()
    print(f"记忆总数：{len(rows)}")

    by_ns: dict[str, int] = {}
    pending: list[tuple[str, str]] = []
    for mid, session_id, current in rows:
        ns = infer_namespace(session_id or "", wakers)
        by_ns[ns or "(未分类)"] = by_ns.get(ns or "(未分类)", 0) + 1
        # 只在"空 → 有值"时回填，不覆盖已有的（支持重复执行）
        if ns and not current:
            pending.append((ns, mid))

    print("\n反推结果分布：")
    for ns, n in sorted(by_ns.items(), key=lambda kv: -kv[1]):
        print(f"  {ns:<20} {n} 条")

    print(f"\n待回填：{len(pending)} 条")
    if not args.apply:
        print("（干跑模式，未写库；加 --apply 生效）")
        conn.close()
        return 0

    conn.executemany("UPDATE memories SET project = ? WHERE id = ?", pending)
    conn.commit()

    left = conn.execute("SELECT COUNT(*) FROM memories WHERE COALESCE(project,'') = ''").fetchone()[0]
    conn.close()
    print(f"✓ 已回填 {len(pending)} 条；剩余未分类 {left} 条（多为独立 pi 会话，按隔离规则不对任何员工可见）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
