#!/usr/bin/env bash
#
# Start the board against an isolated demo workspace.
# Nothing here touches your real agents/, data/ or ~/.pi.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${WAKER_DEMO_PORT:-8799}"
DIR="${WAKER_DEMO_DIR:-${TMPDIR:-/tmp}/revolver-demo}"

node "${ROOT}/scripts/demo-seed.mjs" "${DIR}"

if [[ ! -f "${ROOT}/web/dist/index.html" ]]; then
  echo "→ 未找到 web/dist，先构建控制台"
  (cd "${ROOT}/web" && npm install --silent && npm run build)
fi

export WAKER_AGENTS="${DIR}/agents"
export WAKER_DATA="${DIR}/data"
export PI_HOME="${DIR}/pi"

echo
echo "看板: http://127.0.0.1:${PORT}"
echo "演示数据: ${DIR}"
echo

exec node --experimental-strip-types "${ROOT}/bin/waker.ts" board --port "${PORT}"
