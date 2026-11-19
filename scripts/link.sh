#!/usr/bin/env bash
#
# 把自研 Pi 扩展软链进 ~/.pi/agent/extensions/。
# 沿用现有 memory.ts / wal.ts 的软链风格：单一事实源，两边各自演进不分叉。
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_DIR="$ROOT/extensions"
# 跟随 PI_HOME（与 src/core/paths.ts 一致），便于隔离测试或多实例
DEST_DIR="${PI_HOME:-$HOME/.pi}/agent/extensions"

mkdir -p "$DEST_DIR"

if [[ ! -d "$SRC_DIR" ]]; then
  echo "找不到扩展目录：$SRC_DIR" >&2
  exit 1
fi

linked=0
for src in "$SRC_DIR"/*.ts; do
  [[ -e "$src" ]] || continue
  name="$(basename "$src")"
  # .d.ts 是类型声明，不是运行时扩展，跳过
  [[ "$name" == *.d.ts ]] && continue
  dest="$DEST_DIR/$name"

  # 已是同一目标的软链则跳过，保持幂等
  if [[ -L "$dest" && "$(readlink "$dest")" == "$src" ]]; then
    echo "已链接：$name"
    linked=$((linked + 1))
    continue
  fi

  # 已存在同名实体文件：先备份再替换，绝不静默覆盖
  if [[ -e "$dest" && ! -L "$dest" ]]; then
    backup="$dest.bak-$(date +%m%d-%H%M%S)"
    echo "发现同名实体文件，已备份为 $(basename "$backup")" >&2
    mv "$dest" "$backup"
  fi

  ln -sfn "$src" "$dest"
  echo "已链接：$name -> $src"
  linked=$((linked + 1))
done

if [[ "$linked" -eq 0 ]]; then
  echo "没有找到任何待链接的扩展（$SRC_DIR/*.ts）" >&2
  exit 1
fi

cat <<'EOF'

软链完成。让扩展生效：
  - 在 pi 会话里执行 /reload
  - 或完全重启 pi

安全提示：软链后 Pi 会以宿主进程权限执行这些扩展，请只链接你审阅过的代码。
EOF
