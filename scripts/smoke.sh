#!/usr/bin/env bash
#
# Fresh-clone smoke test. Runs entirely inside the repo plus a temp demo
# directory: no agents/, no data/, no ~/.pi.
#
#   bash scripts/smoke.sh
#
# Exit code 0 means: typecheck, tests, console build and the demo board all work.
#
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${WAKER_SMOKE_PORT:-8899}"
DEMO="${TMPDIR:-/tmp}/revolver-smoke"
FAILED=0

pass() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$1"; FAILED=$((FAILED + 1)); }
step() { printf '\n\033[1m%s\033[0m\n' "$1"; }

cleanup() {
  if [ -n "${BOARD_PID:-}" ]; then
    kill "$BOARD_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

step "① 仓库卫生"
# 只把"真实用户名"当成问题；/Users/me、/Users/you、/Users/x、/Users/... 是占位符
BAD_PATHS="$(git -C "$ROOT" ls-files -z 2>/dev/null \
  | xargs -0 grep -hoE '/Users/[A-Za-z0-9._-]+/' 2>/dev/null \
  | sort -u | grep -vE '^/Users/(me|you|x|\.\.\.)/$' || true)"
if [ -n "$BAD_PATHS" ]; then
  fail "发现个人绝对路径：$(echo "$BAD_PATHS" | tr '\n' ' ')"
else
  pass "无个人绝对路径（只有占位符）"
fi
if git -C "$ROOT" ls-files -z 2>/dev/null | xargs -0 grep -nE "sk-[A-Za-z0-9]{16,}" 2>/dev/null | grep -q .; then
  fail "发现疑似 API key"
else
  pass "无明文 API key"
fi

step "② 运行时"
if command -v node >/dev/null 2>&1; then
  MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$MAJOR" -ge 22 ] && pass "node $(node --version)" || fail "node 需要 22+，当前 $(node --version)"
else
  fail "未找到 node"
fi
command -v pnpm >/dev/null 2>&1 && pass "pnpm $(pnpm --version)" || fail "未找到 pnpm"
if command -v pi >/dev/null 2>&1; then
  pass "pi $(pi --version 2>/dev/null | head -1)"
else
  printf '  \033[33m!\033[0m pi 未安装（看板可跑，对话需要）\n'
fi

step "③ 依赖与类型"
(cd "$ROOT" && pnpm install --frozen-lockfile >/dev/null 2>&1) && pass "根依赖" || fail "根依赖安装失败"
(cd "$ROOT/web" && pnpm install --frozen-lockfile >/dev/null 2>&1) && pass "控制台依赖" || fail "控制台依赖安装失败"
(cd "$ROOT" && pnpm exec tsc -p tsconfig.json --noEmit) && pass "tsc 0 error" || fail "类型检查失败"

step "④ 单元测试"
if (cd "$ROOT" && npm test >/tmp/revolver-smoke-test.log 2>&1); then
  OK="$(grep -cE '通过|passed' /tmp/revolver-smoke-test.log || true)"
  pass "npm test 通过（${OK} 个测试文件有输出）"
else
  fail "npm test 失败，日志：/tmp/revolver-smoke-test.log"
fi

step "⑤ 控制台构建"
(cd "$ROOT/web" && pnpm build >/tmp/revolver-smoke-build.log 2>&1) && pass "web/dist" || fail "前端构建失败，日志：/tmp/revolver-smoke-build.log"

step "⑥ 演示看板"
node "$ROOT/scripts/demo-seed.mjs" "$DEMO" >/dev/null 2>&1 && pass "演示数据已生成" || fail "演示数据生成失败"
if [ -f "$ROOT/web/dist/index.html" ]; then
  WAKER_AGENTS="$DEMO/agents" WAKER_DATA="$DEMO/data" PI_HOME="$DEMO/pi" \
    node --experimental-strip-types "$ROOT/bin/waker.ts" board --port "$PORT" >/tmp/revolver-smoke-board.log 2>&1 &
  BOARD_PID=$!

  READY=0
  for _ in $(seq 1 30); do
    if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then READY=1; break; fi
    sleep 1
  done
  if [ "$READY" = "1" ]; then
    SESSIONS="$(curl -fsS "http://127.0.0.1:${PORT}/api/sessions" | grep -o '"sessionId"' | wc -l | tr -d ' ')"
    [ "$SESSIONS" -ge 1 ] && pass "看板响应，${SESSIONS} 个会话" || fail "看板没有会话数据"
    curl -fsS "http://127.0.0.1:${PORT}/api/board" >/dev/null 2>&1 && pass "/api/board 可读" || fail "/api/board 失败"
  else
    fail "看板 30 秒内未就绪，日志：/tmp/revolver-smoke-board.log"
  fi
else
  fail "缺少 web/dist，跳过看板检查"
fi

echo
if [ "$FAILED" -eq 0 ]; then
  printf '\033[32mSMOKE PASS\033[0m — 这套代码可以在干净机器上安装并运行。\n'
  exit 0
fi
printf '\033[31mSMOKE FAIL\033[0m — %s 项失败，先看上面的日志路径。\n' "$FAILED"
exit 1
