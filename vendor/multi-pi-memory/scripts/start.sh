#!/usr/bin/env bash
# 启动 multi-pi-memory：HTTP 服务(app.py) + 抽取 worker(worker.py)
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

# 首次运行：用示例配置生成 config.yaml（仓库里不发布本机配置）
if [ ! -f "$ROOT/memory-server/config.yaml" ] && [ -f "$ROOT/memory-server/config.example.yaml" ]; then
  cp "$ROOT/memory-server/config.example.yaml" "$ROOT/memory-server/config.yaml"
  echo "已从 config.example.yaml 生成 config.yaml（按需修改 embedding 后端）"
fi

# ---------- 选 Python：优先本目录 venv，其次本机已有 pi-memory 的 venv ----------
PY="${WAKER_MEMORY_PYTHON:-}"
if [ -z "$PY" ]; then
  if [ -x "$ROOT/memory-server/.venv/bin/python" ]; then
    PY="$ROOT/memory-server/.venv/bin/python"
  elif [ -x "${PI_MEMORY_HOME:-$HOME/pi-memory}/memory-server/.venv/bin/python" ]; then
    # 复用本机已有 pi-memory 的虚拟环境（依赖一致，省一次安装）
    PY="${PI_MEMORY_HOME:-$HOME/pi-memory}/memory-server/.venv/bin/python"
  else
    PY="$(command -v python3)"
  fi
fi
[ -x "$PY" ] || { echo "找不到可用的 Python，请设置 WAKER_MEMORY_PYTHON"; exit 1; }

PORT=$(grep -E '^\s*port:' "$ROOT/memory-server/config.yaml" 2>/dev/null | head -1 | grep -oE '[0-9]+' || echo 8971)

if lsof -tiTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "端口 $PORT 已在监听，先执行 ./scripts/stop.sh"
  exit 0
fi

cd "$ROOT/memory-server"
nohup "$PY" -u app.py > /tmp/multi-memory.log 2>&1 &
sleep 3
nohup "$PY" -u worker.py > /tmp/multi-worker.log 2>&1 &

echo "multi-pi-memory 已启动"
echo "  地址：http://127.0.0.1:$PORT"
echo "  日志：/tmp/multi-memory.log · /tmp/multi-worker.log"
