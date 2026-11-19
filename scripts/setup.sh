#!/usr/bin/env bash
#
# 一步装完。重复执行安全（幂等）。
#
#   bash scripts/setup.sh
#
# 装什么：模型内核（pi）、依赖、网页界面、Pi 扩展软链、waker 命令、
#         第一个员工、跨会话记忆服务。
# 不需要你选任何东西；机器上缺什么它会自己补，补不了（例如没装 Node、没网）
# 会明确告诉你差什么、怎么补，不会静默跳过。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="${WAKER_BIN_DIR:-$HOME/.local/bin}"
MEM_DIR="$ROOT/vendor/multi-pi-memory"
MEM_SERVER="$MEM_DIR/memory-server"
MEM_PORT="8971"

ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
die()  { printf '  \033[31m✗\033[0m %s\n' "$1" >&2; exit 1; }
step() { printf '\n\033[1m%s\033[0m\n' "$1"; }

echo
echo "Revolver · 安装"
echo "  目录：$ROOT"

# ---------- ① Node ----------
step "① Node（运行环境）"
if ! command -v node >/dev/null 2>&1; then
  if command -v brew >/dev/null 2>&1; then
    warn "未找到 node，尝试用 Homebrew 安装"
    brew install node >/dev/null 2>&1 || die "node 安装失败，请手动装 Node 22+（https://nodejs.org）"
  else
    die "未找到 node。请先装 Node 22+：https://nodejs.org（macOS 也可以 brew install node）"
  fi
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || die "需要 Node 22 以上，当前 $(node --version)。升级：https://nodejs.org"
ok "node $(node --version)"

# ---------- ② pnpm ----------
step "② pnpm（装依赖用）"
if ! command -v pnpm >/dev/null 2>&1; then
  if command -v corepack >/dev/null 2>&1; then
    corepack enable >/dev/null 2>&1 || true
  fi
  if ! command -v pnpm >/dev/null 2>&1; then
    npm i -g pnpm --loglevel=error >/dev/null 2>&1 || die "pnpm 安装失败，请手动执行：npm i -g pnpm"
  fi
fi
ok "pnpm $(pnpm --version)"

# ---------- ③ Pi 内核 ----------
step "③ 模型内核（pi）"
if command -v pi >/dev/null 2>&1; then
  ok "pi 已安装（$(pi --version 2>/dev/null | head -1)）"
else
  warn "未找到 pi，正在安装（npm i -g @earendil-works/pi-coding-agent）"
  if npm i -g @earendil-works/pi-coding-agent --loglevel=error >/dev/null 2>&1; then
    ok "pi 已安装（$(pi --version 2>/dev/null | head -1)）"
  else
    warn "pi 安装失败：看板仍可打开，但无法对话。稍后手动执行 npm i -g @earendil-works/pi-coding-agent"
    warn "（常见原因：npm 全局目录不可写，或网络问题）"
  fi
fi

# ---------- ④ 依赖与控制台 ----------
step "④ 依赖与网页界面"
(cd "$ROOT" && pnpm install --frozen-lockfile >/dev/null)
ok "根依赖"
(cd "$ROOT/web" && pnpm install --frozen-lockfile >/dev/null)
ok "控制台依赖"
(cd "$ROOT/web" && pnpm build >/dev/null)
ok "控制台已构建（web/dist）"

# ---------- ⑤ Pi 扩展 ----------
step "⑤ 接入 Pi 扩展"
bash "$ROOT/scripts/link.sh" >/dev/null
ok "已软链到 ${PI_HOME:-$HOME/.pi}/agent/extensions"

# ---------- ⑥ 命令行 ----------
step "⑥ waker 命令"
mkdir -p "$BIN_DIR"
bash "$ROOT/scripts/install-cli.sh" "$BIN_DIR/waker" >/dev/null
ok "$BIN_DIR/waker"
case ":$PATH:" in
  *":$BIN_DIR:"*) ok "$BIN_DIR 已在 PATH 中" ;;
  *) warn "把下面这行加进 ~/.zshrc（然后新开一个终端），否则打不了 waker 命令"
     echo "     export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac

# ---------- ⑦ 跨会话记忆 ----------
step "⑦ 跨会话记忆"
PY=""
for cand in python3.12 python3.11 python3.10 python3.9 python3; do
  if command -v "$cand" >/dev/null 2>&1; then
    ver="$("$cand" -c 'import sys;print("%d.%d"%sys.version_info[:2])' 2>/dev/null || echo "")"
    if [ -n "$ver" ]; then
      major="${ver%%.*}"; minor="${ver##*.}"
      if [ "$major" -ge 3 ] && [ "$minor" -ge 9 ]; then PY="$cand"; break; fi
    fi
  fi
done
if [ -z "$PY" ]; then
  warn "没找到 Python 3.9+，跳过记忆模块（其它功能不受影响）"
  warn "想补上：brew install python@3.12，然后重跑本脚本"
elif [ ! -d "$MEM_SERVER" ]; then
  warn "仓库里没有 vendor/multi-pi-memory，跳过记忆模块"
else
  VENV_PY="$MEM_SERVER/.venv/bin/python"
  if [ ! -x "$VENV_PY" ]; then
    "$PY" -m venv "$MEM_SERVER/.venv" >/dev/null 2>&1 || die "创建 Python 虚拟环境失败"
    ok "已建虚拟环境（$($PY -V 2>&1)）"
  else
    ok "虚拟环境已存在"
  fi
  # macOS + arm64：Python 若是 x86_64 混编，pip 装出来的二进制会架构不匹配
  PYRUN="$VENV_PY"
  if [ "$(uname -s)" = "Darwin" ] && [ "$(uname -m)" = "arm64" ] && file "$VENV_PY" 2>/dev/null | grep -q "x86_64"; then
    PYRUN="arch -arm64 $VENV_PY"
  fi
  if $PYRUN -c "import fastapi" >/dev/null 2>&1; then
    ok "依赖已安装"
  else
    $PYRUN -m pip install -q --upgrade pip >/dev/null 2>&1 || true
    if $PYRUN -m pip install -q -r "$MEM_SERVER/requirements.txt" >/dev/null 2>&1; then
      ok "依赖已安装"
    elif $PYRUN -m pip install -q -r "$MEM_SERVER/requirements.txt" -i https://pypi.tuna.tsinghua.edu.cn/simple >/dev/null 2>&1; then
      ok "依赖已安装（走国内镜像）"
    else
      warn "记忆模块依赖安装失败（不影响其它功能）；可手动：$MEM_SERVER/install.sh"
    fi
  fi
  if [ ! -f "$MEM_SERVER/config.yaml" ] && [ -f "$MEM_SERVER/config.example.yaml" ]; then
    cp "$MEM_SERVER/config.example.yaml" "$MEM_SERVER/config.yaml"
    ok "已生成 config.yaml（默认接本机 LM Studio 1234）"
  else
    ok "config.yaml 已存在，保持不变"
  fi
  # 本机没有推理端点时不硬启：起了也只会报连接失败，反而让人以为坏了
  if curl -fsS -m 2 "http://127.0.0.1:1234/v1/models" >/dev/null 2>&1; then
    if curl -fsS -m 2 "http://127.0.0.1:${MEM_PORT}/api/status" >/dev/null 2>&1; then
      ok "记忆服务已在 ${MEM_PORT} 运行"
    elif bash "$MEM_DIR/scripts/start.sh" >/dev/null 2>&1; then
      ok "记忆服务已启动（127.0.0.1:${MEM_PORT}）"
    else
      warn "记忆服务启动失败，日志见 /tmp/multi-memory.log"
    fi
  else
    warn "本机没检测到 LM Studio（1234），记忆服务先不启动"
    warn "打开 LM Studio 后执行：bash vendor/multi-pi-memory/scripts/start.sh"
  fi
fi

# ---------- ⑧ 第一个员工 ----------
step "⑧ 第一个员工"
if [ -d "$ROOT/agents/assistant" ]; then
  ok "agents/assistant 已存在，跳过"
else
  node --experimental-strip-types "$ROOT/bin/waker.ts" agent new assistant >/dev/null
  ok "agents/assistant（五份档案 + waker.yaml，随时可改）"
fi

# ---------- 完成 ----------
step "装好了"
cat <<EOF

  下一步（任选其一）：

    打开网页看板         waker board --port 8787
                        然后浏览器打开 http://127.0.0.1:8787

    直接在终端聊天       waker chat assistant
                        第一次会让你选模型 / 登录，之后不用再配

  遇到问题先自检：
    waker doctor

  不想动自己的数据，只想先看看界面：
    bash scripts/demo.sh

EOF
