#!/usr/bin/env bash
#
# First-run setup: dependencies, console build, Pi extension symlinks and the
# `waker` command. Idempotent — safe to run again after a pull.
#
#   bash scripts/setup.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="${WAKER_BIN_DIR:-$HOME/.local/bin}"

ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
die()  { printf '  \033[31m✗\033[0m %s\n' "$1" >&2; exit 1; }

echo
echo "Revolver · setup"
echo "  repo: $ROOT"

# ---------- 1. Node ----------
echo
echo "① Node"
command -v node >/dev/null 2>&1 || die "未找到 node，请安装 Node.js 22+（https://nodejs.org）"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 22 ]; then
  die "需要 Node.js 22+，当前 $(node --version)"
fi
ok "node $(node --version)"

# ---------- 2. pnpm ----------
echo
echo "② pnpm"
if ! command -v pnpm >/dev/null 2>&1; then
  warn "未找到 pnpm，尝试用 corepack 启用"
  if command -v corepack >/dev/null 2>&1; then
    corepack enable >/dev/null 2>&1 || true
  fi
  command -v pnpm >/dev/null 2>&1 || die "请先安装 pnpm：npm i -g pnpm"
fi
ok "pnpm $(pnpm --version)"

# ---------- 3. Pi ----------
echo
echo "③ Pi（agent 内核）"
if command -v pi >/dev/null 2>&1; then
  ok "pi $(pi --version 2>/dev/null | head -1)"
else
  warn "未找到 pi。看板与演示可以先跑；真正对话前需要安装："
  echo "     npm i -g @earendil-works/pi-coding-agent"
fi

# ---------- 4. Dependencies ----------
echo
echo "④ 安装依赖"
(cd "$ROOT" && pnpm install --frozen-lockfile)
ok "根依赖"
(cd "$ROOT/web" && pnpm install --frozen-lockfile)
ok "控制台依赖"

# ---------- 5. Console build ----------
echo
echo "⑤ 构建控制台"
(cd "$ROOT/web" && pnpm build)
ok "web/dist"

# ---------- 6. Pi extensions ----------
echo
echo "⑥ 软链 Pi 扩展"
bash "$ROOT/scripts/link.sh"
ok "~/.pi/agent/extensions"

# ---------- 7. CLI ----------
echo
echo "⑦ 安装 waker 命令"
mkdir -p "$BIN_DIR"
bash "$ROOT/scripts/install-cli.sh" "$BIN_DIR/waker"
case ":$PATH:" in
  *":$BIN_DIR:"*) ok "$BIN_DIR 已在 PATH" ;;
  *) warn "把下面这行加进 ~/.zshrc 或 ~/.bashrc："
     echo "     export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac

# ---------- 8. First teammate ----------
echo
echo "⑧ 第一个员工"
if [ -d "$ROOT/agents/assistant" ]; then
  ok "agents/assistant 已存在，跳过"
else
  node --experimental-strip-types "$ROOT/bin/waker.ts" agent new assistant
  ok "agents/assistant"
fi

echo
echo "完成。下一步："
echo "  waker doctor                 # 环境自检"
echo "  waker chat assistant         # 和它对话（需要 pi）"
echo "  waker board --port 8787      # 打开 http://127.0.0.1:8787"
echo
echo "只看界面、不动你的数据："
echo "  bash scripts/demo.sh         # 演示数据 + 端口 8799"
echo
echo "可选：跨会话记忆服务（Python 3.9+，需要 LM Studio 或任意 OpenAI 兼容端点）"
echo "  bash vendor/multi-pi-memory/memory-server/install.sh"
echo
