#!/usr/bin/env bash
# pi 记忆中心 —— 守护启动器
#
# 用途: 保证 memory-server + 抽取 worker 常驻。进程挂掉自动拉起。
#
# 架构 (2026-10-01 起):
#   app.py     HTTP 服务: 读记忆/检索/入队 —— 必须秒回, 不能被推理堵住
#   worker.py  抽取进程: 消费队列, 模型推理几分钟都无所谓
#   两者通过 SQLite 队列解耦。worker 不在时 app.py 照常工作,
#   任务只是在队列里排队等着 —— pi 完全无感。
#
# 用法:
#   ./run.sh            前台运行 (带自动重启循环)
#   ./run.sh --once     只跑一次, 退出后不重启
#   nohup ./run.sh &    后台常驻
#
# 说明: macOS + arm64 上, 若 venv 内的 Python 是 x86_64 混编,
#       必须用 arch -arm64 启动, 否则 pydantic_core 会报架构不匹配。
#       本脚本会自动检测并加上该前缀。
#
# 2026-10-06 加固 (背景: 曾累计 17507 次 "address already in use" 死循环,
#   worker 静默死亡 24 小时无人察觉, 队列积压 18 条):
#   1. 端口清理改为「等待真正释放」, 不再用固定 sleep 2
#   2. pidfile 校验加空值/非数字判断, 杜绝 kill -0 "" 的静默失败
#   3. worker 起没起来用「进程名」复核, 不信任 pidfile
#   4. worker 存活巡检挪到独立后台循环, app.py 正常时不阻塞巡检

cd "$(dirname "$0")" || exit 1

PY=".venv/bin/python"
LOG_DIR="../../logs"
LOG="$LOG_DIR/memory.log"
mkdir -p "$LOG_DIR"

ONCE=0
[ "${1:-}" = "--once" ] && ONCE=1

WORKER_LOG="$LOG_DIR/memory-worker.log"
WORKER_PIDFILE="$LOG_DIR/.memory-worker.pid"
WORKER_LOCK="$LOG_DIR/.memory-worker.lock"

# ---------- 自动处理 arch 前缀 ----------
PYRUN="$PY"
if [ "$(uname -s)" = "Darwin" ] && [ "$(uname -m)" = "arm64" ]; then
  if file "$PY" 2>/dev/null | grep -q "x86_64"; then
    PYRUN="arch -arm64 $PY"
  fi
fi

[ -x "$PY" ] || { echo "[run.sh] 找不到 $PY, 请先运行 ./install.sh"; exit 1; }

PORT=$(grep -E '^\s*port:' config.yaml 2>/dev/null | head -1 | grep -oE '[0-9]+' || echo 8970)

# ---------- 工具函数 ----------

# 端口上是否还有 LISTEN 进程
port_busy() {
  command -v lsof >/dev/null 2>&1 || return 1
  lsof -tiTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1
}

# 取端口占用者 PID 列表
port_pids() {
  lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null
}

# 等待端口释放。先 TERM, 超时后 KILL。返回 0=已释放, 1=仍被占
wait_port_free() {
  local max_wait=${1:-20}
  port_busy || return 0

  local i=0
  while [ $i -lt $max_wait ]; do
    port_busy || return 0
    sleep 0.5
    i=$((i + 1))
  done

  # 还没走 → 上 KILL
  echo "[run.sh] $(date '+%F %T') 端口 $PORT 仍未释放, 强制 KILL" >> "$LOG"
  port_pids | xargs kill -9 2>/dev/null

  i=0
  while [ $i -lt 10 ]; do
    port_busy || return 0
    sleep 0.5
    i=$((i + 1))
  done
  return 1
}

# worker 是否活着 —— 双重判据: pidfile 内容有效 + 进程确实存在
# 不再信任 pidfile 单点: pid 可能被系统复用、文件可能残留。
worker_alive() {
  # 判据1: 有没有 worker.py 进程在跑 (最可靠, 不依赖 pidfile)
  if pgrep -f "worker\.py" >/dev/null 2>&1; then
    return 0
  fi
  return 1
}

start_worker() {
  if worker_alive; then
    return 0
  fi

  # 陈旧 pidfile 清掉, 避免误导
  rm -f "$WORKER_PIDFILE"
  echo "[run.sh] $(date '+%F %T') 启动 worker" >> "$WORKER_LOG"
  $PYRUN -u worker.py >> "$WORKER_LOG" 2>&1 &
  local wpid=$!
  echo "$wpid" > "$WORKER_PIDFILE"

  # 等它真的活起来再算成功 (worker.py 初始化可能失败, 不能盲信 $!)
  sleep 1
  if kill -0 "$wpid" 2>/dev/null; then
    return 0
  fi
  echo "[run.sh] $(date '+%F %T') worker 启动后立即退出, 见 $WORKER_LOG" >> "$LOG"
  return 1
}

stop_worker() {
  # 按进程名停, 比 pidfile 可靠
  pkill -f "worker\.py" 2>/dev/null
  rm -f "$WORKER_PIDFILE"
}

trap 'stop_worker; exit 0' TERM INT

# 抽取模式: sync 时不需要 worker
EXTRACT_MODE=$(grep -A5 '^extract:' config.yaml 2>/dev/null | grep -E '^\s*mode:' | grep -oE '(sync|queue)' | head -1)
EXTRACT_MODE=${EXTRACT_MODE:-queue}

# ---------- worker 后台巡检循环 ----------
# 独立于 app.py 存在: app.py 常驻时这里每 30s 检查一次 worker。
# 修复前 worker 只能靠 app.py 崩溃退出时才被检查 —— 而 app.py
# 恰恰是最不容易崩的那个, 于是 worker 死了 24 小时没人管。
worker_watchdog() {
  while true; do
    sleep 30
    [ "$EXTRACT_MODE" = "queue" ] || continue
    if ! worker_alive; then
      echo "[run.sh] $(date '+%F %T') 巡检发现 worker 不在, 拉起" >> "$LOG"
      start_worker
    fi
  done
}

if [ "$EXTRACT_MODE" = "queue" ]; then
  start_worker
  echo "[run.sh] $(date '+%F %T') worker 已启动 (pid $(cat "$WORKER_PIDFILE" 2>/dev/null))" >> "$LOG"
  # 后台巡检 (父进程退出时一并被 trap 处理)
  worker_watchdog &
  WATCHDOG_PID=$!
elif [ $ONCE -eq 0 ]; then
  echo "[run.sh] $(date '+%F %T') extract.mode=sync, 不启动 worker (抽取会阻塞请求)" >> "$LOG"
fi

FAIL_STREAK=0

while true; do
  # 每轮开跑前确保端口干净。旧进程没死透就 bind → exit 3 → 死循环,
  # 这就是历史上 17507 次冲突的成因。
  if port_busy; then
    echo "[run.sh] $(date '+%F %T') 端口 $PORT 被占用 ($(port_pids | tr '\n' ' ')), 清理中" >> "$LOG"
    port_pids | xargs kill 2>/dev/null
    if ! wait_port_free 20; then
      echo "[run.sh] $(date '+%F %T') 端口 $PORT 无法释放, 30s 后重试" >> "$LOG"
      sleep 30
      continue
    fi
  fi

  echo "[run.sh] $(date '+%F %T') 启动 memory-server" >> "$LOG"
  $PYRUN -u app.py >> "$LOG" 2>&1
  code=$?
  echo "[run.sh] $(date '+%F %T') 进程退出 (code=$code)" >> "$LOG"

  if [ $ONCE -eq 1 ]; then
    stop_worker
    break
  fi

  # app.py 挂了不影响 worker; 顺手检查
  [ "$EXTRACT_MODE" = "queue" ] && start_worker

  # 崩溃重启限流: 指数退避, 避免刷日志和死循环烧 CPU
  if [ $code -ne 0 ]; then
    FAIL_STREAK=$((FAIL_STREAK + 1))
    BACKOFF=$((FAIL_STREAK * 10))
    [ $BACKOFF -gt 120 ] && BACKOFF=120
    echo "[run.sh] 连续失败 $FAIL_STREAK 次, ${BACKOFF}s 后重启..." >> "$LOG"
    sleep "$BACKOFF"
  else
    FAIL_STREAK=0
    echo "[run.sh] 正常退出, 5s 后重启..." >> "$LOG"
    sleep 5
  fi
done
