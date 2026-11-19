#!/usr/bin/env bash
#
# v1 -> v2 停机迁移。
#
# 设计原则：
#   1. 默认 dry-run，只打印将要执行的动作，加 --yes 才真正执行
#   2. 只复制不移动：v1 的数据原地保留，随时可回滚
#   3. 排除顶层 data 用锚定写法 /data，否则会误伤 vendor 下的记忆库
#   4. extensions 有意不复制，由 v2 首次启动重建软链
#
# 用法：
#   bash scripts/migrate-to-v2.sh          # 看计划
#   bash scripts/migrate-to-v2.sh --yes    # 真正执行
#
set -euo pipefail

# 目标目录已从 platform-v2 改名为 revolver（2026-10-22）。
SRC=${WAKER_V1_DIR:-~/work/platform}
DST=${WAKER_V2_DIR:-~/work/revolver}
PI_V1=${WAKER_PI_HOME:-$HOME/.pi}
PI_V2=${WAKER_PI_HOME_V2:-$HOME/.pi-v2}
BOARD_PORT=${WAKER_BOARD_PORT:-8788}
MEM_URL=${WAKER_MEMORY_SERVER:-http://127.0.0.1:8971}
BACKUP_DIR=${WAKER_BACKUP_DIR:-$HOME/backups}
LA=$HOME/Library/LaunchAgents
STAMP=$(date +%Y%m%d-%H%M)

APPLY=0
for a in "$@"; do
  [[ $a == "--yes" ]] && APPLY=1
done

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
warn() { printf '  ! %s\n' "$*"; }
run() {
  printf '  + %s\n' "$*"
  if [[ $APPLY -eq 1 ]]; then "$@"; fi
}

say "0 前置校验"
if [[ ! -d $SRC ]]; then echo "找不到 v1 目录: $SRC"; exit 1; fi
if [[ ! -d $PI_V1/agent/sessions ]]; then echo "找不到 pi 会话目录: $PI_V1/agent/sessions"; exit 1; fi
if [[ -d $DST ]]; then echo "v2 目录已存在: ${DST}（请先移走，避免覆盖）"; exit 1; fi
echo "  v1     = $SRC"
echo "  v2     = $DST"
echo "  pi v1  = $PI_V1"
echo "  pi v2  = $PI_V2"
echo "  端口   = $BOARD_PORT"
echo "  记忆   = ${MEM_URL}（共享，不迁移）"
if [[ $APPLY -eq 1 ]]; then
  echo "  模式   = 执行"
else
  warn "当前是 dry-run，不会改动任何文件；真正执行请加 --yes"
fi

say "1 备份（含 data，不含依赖）"
run mkdir -p "$BACKUP_DIR"
run tar -czf "$BACKUP_DIR/waker-v1-full-$STAMP.tar.gz" \
  --exclude node_modules --exclude web/node_modules \
  -C "$(dirname "$SRC")" "$(basename "$SRC")"
run cp "$SRC/vendor/multi-pi-memory/memory-server/data/memory.db" \
  "$BACKUP_DIR/memory-v1-$STAMP.db"

say "2 停机：卸下看板并禁止自启"
if [[ -f "$LA/com.waker.board.plist" ]]; then
  run launchctl unload "$LA/com.waker.board.plist"
  run mv "$LA/com.waker.board.plist" "$LA/com.waker.board.plist.disabled-by-v2"
else
  warn "未找到 $LA/com.waker.board.plist（可能未由 launchd 托管）"
fi
# launchctl unload 之后进程可能还在收尾。先等它自己退出，超时再 SIGTERM，
# 确认彻底退出后才允许复制，否则会复制到写了一半的会话与流水。
if pgrep -f 'waker.ts board' >/dev/null 2>&1; then
  warn "看板进程未立即退出，等待最多 10 秒"
  if [[ $APPLY -eq 1 ]]; then
    for _ in $(seq 1 10); do
      pgrep -f 'waker.ts board' >/dev/null 2>&1 || break
      sleep 1
    done
    if pgrep -f 'waker.ts board' >/dev/null 2>&1; then
      warn "仍在运行，发送 SIGTERM"
      pkill -f 'waker.ts board' || true
      sleep 2
    fi
    if pgrep -f 'waker.ts board' >/dev/null 2>&1; then
      warn "进程仍未退出，已中止："
      pgrep -fl 'waker.ts board' || true
      exit 1
    fi
    echo "  看板已停止，可以开始复制"
  else
    pgrep -fl 'waker.ts board' || true
    echo "  （dry-run：正式执行时会等待并回收该进程）"
  fi
else
  echo "  未发现运行中的看板进程"
fi

say "3 复制代码（锚定排除顶层 data，保住 vendor 下的记忆库）"
run rsync -a --exclude node_modules --exclude web/node_modules \
  --exclude /data --exclude .git \
  "$SRC/" "$DST/"

say "4 复制平台数据与员工档案"
run rsync -a "$SRC/data/" "$DST/data/"
run rsync -a "$SRC/agents/" "$DST/agents/"

say "5 复制 pi 必搬项（extensions 不复制）"
run mkdir -p "$PI_V2/agent"
run rsync -a \
  "$PI_V1/agent/sessions" \
  "$PI_V1/agent/skills" \
  "$PI_V1/agent/agents" \
  "$PI_V1/agent/rules" \
  "$PI_V1/agent/prompts" \
  "$PI_V1/agent/wal" \
  "$PI_V2/agent/"
# feishu-bot 里装着飞书 SDK：渠道层从 $PI_AGENT_HOME/feishu-bot 动态加载它，
# 不搬这一份，三个飞书渠道会全部静默置为 error，且日志里一个字都不留。
if [[ -d "$PI_V1/agent/feishu-bot" ]]; then
  run rsync -a "$PI_V1/agent/feishu-bot" "$PI_V2/agent/"
fi
for f in auth.json settings.json models.json models-store.json; do
  if [[ -f "$PI_V1/agent/$f" ]]; then
    run cp "$PI_V1/agent/$f" "$PI_V2/agent/$f"
  else
    warn "缺少 $PI_V1/agent/${f}，跳过"
  fi
done
warn "复制到 $PI_V2 只是快照备份：运行时 pi 固定用 ~/.pi，不会读这份（见文档第八节）"
warn "extensions 有意不复制；必须手工跑一次 link，把 ~/.pi/agent/extensions 重建为指向 $DST/extensions"

# 扩展目录里除平台软链外，还可能有别的项目放进去的实体文件（codeisland / orca-* / wal 等）。
# 只复制实体文件，跳过软链 —— 软链必须由 v2 的 link 命令重建，否则会指回 v1 源码。
if [[ -d "$PI_V1/agent/extensions" && -d "$PI_V2/agent/extensions" ]]; then
  for f in "$PI_V1/agent/extensions"/*.ts; do
    [[ -e "$f" ]] || continue
    [[ -L "$f" ]] && continue
    run cp -p "$f" "$PI_V2/agent/extensions/"
  done
fi

say "6 写入 v2 环境文件"
if [[ -f "$DST/.env.v2" ]]; then
  warn "$DST/.env.v2 已存在，跳过"
else
  # 不写 PI_HOME：pi 的 CLI 不认它，写了会造成「平台去 A 找、pi 往 B 写」，
  # 表现为新建会话发完消息界面空白（2026-10-22 实测）。
  echo "  将写入 $DST/.env.v2:"
  echo "    WAKER_BOARD_PORT=$BOARD_PORT"
  echo "    WAKER_MEMORY_SERVER=$MEM_URL"
  if [[ $APPLY -eq 1 ]]; then
    printf 'WAKER_BOARD_PORT=%s\nWAKER_MEMORY_SERVER=%s\n' \
      "$BOARD_PORT" "$MEM_URL" > "$DST/.env.v2"
  fi
fi

say "6b 安装依赖并重建扩展软链"
run sh -c "cd '$DST' && pnpm install --prefer-offline"
run sh -c "cd '$DST' && set -a && . ./.env.v2 && set +a && node --experimental-strip-types bin/waker.ts link"
warn "waker link 不是启动时自动执行的：漏了它，策略门禁、身份注入、记忆扩展都不会生效"

say "7 数据完整性校验"
if [[ $APPLY -eq 1 ]]; then
  a=$(find "$PI_V1/agent/sessions" -name '*.jsonl' | wc -l | tr -d ' ')
  b=$(find "$PI_V2/agent/sessions" -name '*.jsonl' | wc -l | tr -d ' ')
  echo "  v1 会话文件 $a 个 / v2 会话文件 $b 个"
  if [[ "$a" != "$b" ]]; then
    echo "  会话文件数量不一致，已中止"
    exit 1
  fi
  du -sh "$PI_V1/agent/sessions" "$PI_V2/agent/sessions" || true
  echo "  任务流水行数：v1 $(wc -l < "$SRC/data/tasks.jsonl" 2>/dev/null || echo 0) / v2 $(wc -l < "$DST/data/tasks.jsonl" 2>/dev/null || echo 0)"
else
  echo "  （dry-run 跳过实际比对）"
fi

say "8 v2 建立独立版本历史"
run git -C "$DST" init
run git -C "$DST" add -A
run git -C "$DST" commit -m "start v2.0 from v1.0.0 with migrated data"

say "脚本结束，以下为手工收尾"
cat <<EOF

  1. 启动 v2 验证
       cd $DST && set -a && . ./.env.v2 && set +a
       waker board --port $BOARD_PORT

  2. 逐项确认
       - 会话列表完整，点开旧会话能看到历史消息
       - 任务流水与用量统计有历史
       - 飞书发一条消息能收到，且落进正确的旧会话
       - $PI_V1 与 $SRC/data 在 v2 运行后不再变化

  3. 命令重定向
       bash $SRC/scripts/install-cli.sh /usr/local/bin/waker1
       bash $DST/scripts/install-cli.sh  /usr/local/bin/waker

  4. 注册 v2 的 launchd
       bash $DST/scripts/register-launchd.sh --board-only
       两个前提，缺一个就会出事：
       - 脚本必须把 .env.v2 注入 plist 的 EnvironmentVariables。
         launchd 不继承终端环境，少了 PI_HOME，v2 会去读写 v1 的 ~/.pi
       - 必须 --board-only。否则记忆服务的 plist 会被重写到 $DST/vendor，
         而记忆库留在原处，v2 会连上一个空库

  5. 回滚
       launchctl unload $LA/com.waker.board.plist 2>/dev/null || true
       mv $LA/com.waker.board.plist.disabled-by-v2 $LA/com.waker.board.plist
       launchctl load $LA/com.waker.board.plist

EOF
