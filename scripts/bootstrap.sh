#!/usr/bin/env bash
#
# 拉起平台依赖的外部服务。
# 只负责"把该开的开起来"，不改动任何已有配置。
#
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MEM_DIR="${ROOT}/vendor/multi-pi-memory/memory-server"
MEM_SCRIPT="${ROOT}/vendor/multi-pi-memory/scripts"
MEM_PORT="$(grep -E '^[[:space:]]*port:' "${MEM_DIR}/config.yaml" 2>/dev/null | head -1 | grep -oE '[0-9]+' || echo 8971)"

echo "== 依赖自检 =="

# 1. Pi 内核
if command -v pi >/dev/null 2>&1; then
  echo "✓ pi $(pi --version 2>/dev/null | head -1)"
else
  echo "✗ 未找到 pi，请先安装（https://github.com/earendil-works/pi）"
fi

# 2. Docker（仅沙箱策略需要）
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  echo "✓ docker 运行中"
else
  echo "· docker 未运行：sandbox: true 的员工将无法执行 bash（其余能力不受影响）"
fi

# 3. 记忆中心（multi-pi-memory，随平台分发在 vendor/ 下）
if curl -fsS "http://127.0.0.1:${MEM_PORT}/api/status" >/dev/null 2>&1; then
  echo "✓ 记忆中心已在 ${MEM_PORT}"
elif [[ -x "${MEM_SCRIPT}/start.sh" ]]; then
  echo "→ 正在启动记忆中心（${MEM_PORT}）"
  if bash "${MEM_SCRIPT}/start.sh" >/dev/null 2>&1; then
    echo "✓ 记忆中心已启动"
  else
    echo "· 记忆中心启动失败，跨会话记忆将不生效（可手动执行 vendor/multi-pi-memory/scripts/start.sh）"
  fi
else
  echo "· 未找到 vendor/multi-pi-memory（跨会话记忆不生效，不影响其余能力）"
fi

# 4. 本地推理（LM Studio）：向量 bge-m3 + 仲裁 laya 都在这里，缺了不会报错只会静默降级
echo
echo "== 本地推理（LM Studio 1234）=="
if [[ -x "${HOME}/.lmstudio/bin/lms" ]]; then
  node "${ROOT}/scripts/lms-guard.mjs" || echo "· 守门没跑通，话题路由会退化为词面判定（日志见上）"
else
  echo "· 未安装 LM Studio：语义召回 / 话题仲裁降级为词面判定（其余能力不受影响）"
fi

# 5. 扩展软链
echo
echo "== 扩展软链 =="
bash "${ROOT}/scripts/link.sh"
