#!/usr/bin/env bash
#
# 把 Waker 的常驻服务注册为 macOS launchd：开机自启 + 崩溃自动重启。
#   1. 看板          com.waker.board          http://127.0.0.1:8787
#   2. 记忆中心      com.waker.memory         http://127.0.0.1:8971
#   3. 记忆 worker   com.waker.memory-worker  （抽取队列，独立进程）
#   4. 模型守门      com.waker.lms-guard      每 5 分钟（不常驻）确保 LM Studio
#                    （1234）在跑、向量 bge-m3 与仲裁 laya 已加载；缺模型自动下载
#
# 用法：
#   bash scripts/register-launchd.sh          注册/更新（幂等）
#   bash scripts/register-launchd.sh stop     暂时停止
#   bash scripts/register-launchd.sh remove   卸载（不再自启）
#
# launchd 不继承终端注入的 NODE_OPTIONS / PYTHONPATH，所以 IDE 的 shim
# 不会污染常驻服务——这也是它比 nohup 更可靠的地方。
#
set -euo pipefail

# 参数里除动作外还支持 --board-only：只注册看板，不碰记忆服务的 plist。
# v2 与 v1 共用同一个记忆库，重写 memory plist 会让它指向 v2 的空库。
BOARD_ONLY=0
ARGS=()
for a in "$@"; do
  if [[ "$a" == "--board-only" ]]; then
    BOARD_ONLY=1
  else
    ARGS+=("$a")
  fi
done
if [[ ${#ARGS[@]} -gt 0 ]]; then set -- "${ARGS[@]}"; else set --; fi

ACTION="${1:-start}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LA_DIR="${HOME}/Library/LaunchAgents"
LOG_DIR="${HOME}/.waker/logs"
PORT="${WAKER_BOARD_PORT:-8787}"

# 隔离变量必须写进 plist：launchd 不继承终端环境。
# 少了 PI_HOME，v2 的看板会去读写 ~/.pi（即 v1 的数据），等于跨版本污染。
EXTRA_ENV_XML=""
if [[ -f "${ROOT}/.env.v2" ]]; then
  while IFS='=' read -r k v; do
    [[ -z "$k" || "$k" == \#* ]] && continue
    EXTRA_ENV_XML+="    <key>${k}</key>
    <string>${v}</string>
"
  done < "${ROOT}/.env.v2"
fi
NODE_BIN="$(command -v node)"

MEM_DIR="${ROOT}/vendor/multi-pi-memory/memory-server"
MEM_PY="${WAKER_MEMORY_PYTHON:-}"
if [[ -z "${MEM_PY}" ]]; then
  if [[ -x "${MEM_DIR}/.venv/bin/python" ]]; then
    MEM_PY="${MEM_DIR}/.venv/bin/python"
  elif [[ -x "${HOME}/Document/pi/pi-memory/memory-server/.venv/bin/python" ]]; then
    MEM_PY="${HOME}/Document/pi/pi-memory/memory-server/.venv/bin/python"
  else
    MEM_PY="$(command -v python3)"
  fi
fi
MEM_PORT="$(grep -E '^[[:space:]]*port:' "${MEM_DIR}/config.yaml" 2>/dev/null | head -1 | grep -oE '[0-9]+' || echo 8971)"

LABELS=(com.waker.board com.waker.memory com.waker.memory-worker com.waker.lms-guard)

unload_all() {
  for l in "${LABELS[@]}"; do
    launchctl unload "${LA_DIR}/${l}.plist" >/dev/null 2>&1 || true
  done
}

case "${ACTION}" in
  stop)
    unload_all
    echo "已停止：${LABELS[*]}（重新登录后仍会自启）"
    exit 0
    ;;
  remove)
    unload_all
    for l in "${LABELS[@]}"; do rm -f "${LA_DIR}/${l}.plist"; done
    echo "已卸载：${LABELS[*]}（不再自启）"
    exit 0
    ;;
  start) ;;
  *)
    echo "用法：bash scripts/register-launchd.sh [start|stop|remove]"
    exit 1
    ;;
esac

[[ -x "${NODE_BIN}" ]] || { echo "找不到 node，无法注册看板"; exit 1; }
if [[ ${BOARD_ONLY} -eq 0 ]]; then
  [[ -x "${MEM_PY}" ]] || { echo "找不到可用的 Python，可设 WAKER_MEMORY_PYTHON"; exit 1; }
  [[ -f "${MEM_DIR}/app.py" ]] || { echo "找不到记忆中心：${MEM_DIR}/app.py"; exit 1; }
fi

mkdir -p "${LA_DIR}" "${LOG_DIR}"

# write_plist <label> <日志名> <工作目录> <命令...>
write_plist() {
  local label="$1" logname="$2" workdir="$3"
  shift 3
  local plist="${LA_DIR}/${label}.plist"
  {
    cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
EOF
    for arg in "$@"; do
      printf '    <string>%s</string>\n' "$arg"
    done
    cat <<EOF
  </array>
  <key>WorkingDirectory</key>
  <string>${workdir}</string>
  <key>RunAtLoad</key>
  <true/>
EOF
    # 常驻服务用 KeepAlive（崩溃自愈）；周期脚本必须用 StartInterval——
    # KeepAlive 会让"跑完就退出"的守门脚本每 10s 重启一次，等于空转。
    if [[ -n "${START_INTERVAL:-}" ]]; then
      cat <<EOF
  <key>StartInterval</key>
  <integer>${START_INTERVAL}</integer>
EOF
    else
      cat <<EOF
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
EOF
    fi
    cat <<EOF
  <key>StandardOutPath</key>
  <string>${LOG_DIR}/${logname}.log</string>
  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/${logname}.error.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${HOME}/.local/bin</string>
${EXTRA_ENV_XML}  </dict>
</dict>
</plist>
EOF
  } > "${plist}"

  launchctl unload "${plist}" >/dev/null 2>&1 || true
  launchctl load "${plist}"
  echo "  ✓ ${label}   日志 ${LOG_DIR}/${logname}.log"
}

echo "注册常驻服务："
write_plist com.waker.board board "${ROOT}" \
  "${NODE_BIN}" --experimental-strip-types "${ROOT}/bin/waker.ts" board --port "${PORT}"

if [[ ${BOARD_ONLY} -eq 0 ]]; then
  write_plist com.waker.memory memory "${MEM_DIR}" \
    "${MEM_PY}" -u app.py

  write_plist com.waker.memory-worker memory-worker "${MEM_DIR}" \
    "${MEM_PY}" -u worker.py
else
  echo "  - 跳过记忆服务与 worker（--board-only）；它们继续由原 plist 托管，共享同一记忆库"
fi

# 模型守门：周期跑（300s），跑完就退出。它自己负责启服务/载模型/缺模型才下载，
# 所以 LM Studio 没开、模型没加载、模型被 TTL 卸掉这三种情况都能自愈。
START_INTERVAL="${WAKER_LMS_GUARD_INTERVAL:-300}" \
  write_plist com.waker.lms-guard lms-guard "${ROOT}" \
  "${NODE_BIN}" "${ROOT}/scripts/lms-guard.mjs"

cat <<EOF

完成。常驻服务已交由 launchd 托管（开机自启 / 崩溃自动重启）：
  看板        http://127.0.0.1:${PORT}
  记忆中心    http://127.0.0.1:${MEM_PORT}
  模型守门    每 ${WAKER_LMS_GUARD_INTERVAL:-300}s 一次（LM Studio 1234 + bge-m3 + laya）

查看状态   launchctl list | grep com.waker
看板日志   tail -f ${LOG_DIR}/board.log
记忆日志   tail -f ${LOG_DIR}/memory.log
守门日志   tail -f ${LOG_DIR}/lms-guard.log
停止       bash scripts/register-launchd.sh stop
卸载       bash scripts/register-launchd.sh remove
EOF
