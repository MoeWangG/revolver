#!/usr/bin/env bash
#
# 把 waker 安装为全局命令。
# 之所以需要包装脚本而不是直接软链：bin/waker.ts 需要 node 的
# --experimental-strip-types 才能直接运行 TS，shebang 在部分环境下不可靠。
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="$(command -v node)"
TARGET="${1:-/usr/local/bin/waker}"

if [[ -z "$NODE_BIN" ]]; then
  echo "未找到 node" >&2
  exit 1
fi

chmod +x "$ROOT/bin/waker.ts"

if ! mkdir -p "$(dirname "$TARGET")" 2>/dev/null; then
  echo "无法写入 $(dirname "$TARGET")，请改用 sudo：sudo bash $0 $TARGET" >&2
  exit 1
fi

cat > "$TARGET" <<EOF
#!/usr/bin/env bash
exec "$NODE_BIN" --experimental-strip-types "$ROOT/bin/waker.ts" "\$@"
EOF

if ! chmod +x "$TARGET" 2>/dev/null; then
  echo "无法设置执行权限，请改用 sudo：sudo bash $0 $TARGET" >&2
  exit 1
fi

echo "已安装 waker -> $TARGET"
echo
echo "验证："
echo "  waker doctor"
echo "  waker agent new <id>"
echo "  waker chat <id>"
