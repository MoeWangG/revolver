#!/usr/bin/env bash
# 停止 multi-pi-memory（按端口杀 HTTP 服务 + 按进程名杀 worker）
set -uo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
PORT=$(grep -E '^\s*port:' "$ROOT/memory-server/config.yaml" 2>/dev/null | head -1 | grep -oE '[0-9]+' || echo 8971)

# 只杀本目录下的进程，避免误伤同名的其它实例（如 8970 的单例）
pkill -f "$ROOT/memory-server/worker.py" 2>/dev/null && echo "已停止 worker" || echo "worker 未在运行"

pids=$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)
if [ -n "$pids" ]; then
  # 服务可能正卡在阻塞调用上，TERM 无效时补 KILL
  echo "$pids" | xargs kill 2>/dev/null || true
  sleep 2
  left=$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)
  [ -n "$left" ] && echo "$left" | xargs kill -9 2>/dev/null || true
  echo "已停止 HTTP 服务（端口 $PORT）"
else
  echo "HTTP 服务未在运行（端口 $PORT）"
fi
