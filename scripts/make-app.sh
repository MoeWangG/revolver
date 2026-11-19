#!/usr/bin/env bash
#
# 生成可双击的 macOS 桌面入口：dist/Waker.app
#
# 设计上只做"点火 + 开窗"，不接管进程生命周期：
#   - 三个常驻服务（看板 / 记忆中心 / 记忆 worker）+ 一个每 5 分钟的模型守门
#     （LM Studio：启服务、载 bge-m3 与 laya、缺模型才下载）仍由 launchd 托管，
#     开机自启、崩溃自愈；
#   - 双击时**已经在跑的绝不重启**——重启会杀掉正在执行的任务，也不会有任何收益；
#   - 服务没起来时才通过 launchctl 拉起，等端口就绪后打开看板。
#
# 为什么双击里不能直接 spawn node：
#   Finder 启动的进程没有终端环境（PATH 极短、没有 NODE_OPTIONS/PI_HOME），
#   而 plist 里已经写好了这些变量。走 launchctl 等于复用那份经过验证的环境，
#   也避免 app 与 launchd 两套管理器抢同一个端口（error.log 里的 EADDRINUSE 就是这么来的）。
#
# 用法：
#   bash scripts/make-app.sh             生成 dist/Waker.app
#   bash scripts/make-app.sh --install   生成后复制到 /Applications
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="${ROOT}/dist/Waker.app"
BUNDLE_ID="com.waker.launcher"
VERSION="2.0.0"

INSTALL=0
for a in "$@"; do
  case "$a" in
    --install) INSTALL=1 ;;
    -h|--help) sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知参数：$a（可用：--install）"; exit 1 ;;
  esac
done

[[ -f "${ROOT}/bin/waker.ts" ]] || { echo "找不到 ${ROOT}/bin/waker.ts，请在 revolver 仓库内运行"; exit 1; }
[[ -f "${ROOT}/scripts/register-launchd.sh" ]] || { echo "缺少 scripts/register-launchd.sh"; exit 1; }
[[ -d "${ROOT}/web/dist" ]] || echo "提示：web/dist 不存在，看板会空白。可先执行 pnpm web:build"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

# ———————————————————————————— 启动脚本 ————————————————————————————
# 用带引号的 heredoc 原样写入，再替换 __ROOT__：运行时的 $HOME / $UID 必须留到双击时再展开。
cat > "$APP/Contents/MacOS/Waker" <<'LAUNCHER'
#!/bin/bash
# Waker 桌面入口：保证服务在跑，然后把看板打开。
# 由 scripts/make-app.sh 生成，改逻辑请改那边，别直接改这里（会被覆盖）。
set -uo pipefail

ROOT="__ROOT__"
PORT="8787"
MEM_PORT="8971"
LM_PORT="1234"
LA_DIR="$HOME/Library/LaunchAgents"
LOG_DIR="$HOME/.waker/logs"
UID_NUM="$(id -u)"
LABELS=(com.waker.board com.waker.memory com.waker.memory-worker com.waker.lms-guard)

alert() { osascript -e "display alert \"Waker\" message \"$1\" as critical" >/dev/null 2>&1; }
notify() { osascript -e "display notification \"$1\" with title \"Waker\"" >/dev/null 2>&1; }
port_up() { curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$1/"; }

# 项目目录被移动或删掉时，注册脚本已经不可用，先说清楚再退出
if [[ ! -f "$ROOT/scripts/register-launchd.sh" ]]; then
  alert "找不到项目目录：$ROOT\n请重新运行 bash scripts/make-app.sh 生成桌面入口。"
  exit 1
fi

# 1) 已经在跑：只开窗。**不碰进程** —— 双击一次就杀掉正在跑的任务是最不能接受的副作用。
if port_up "$PORT"; then
  open "http://127.0.0.1:$PORT"
  exit 0
fi

# 2) 服务还没注册过：先问一句再注册（此时本来就什么都没跑，unload/load 无副作用）
missing=0
for l in "${LABELS[@]}"; do
  [[ -f "$LA_DIR/$l.plist" ]] || missing=1
done

if (( missing )); then
  choice=$(osascript -e 'display dialog "服务还未注册为后台常驻。\n\n将注册四个服务：\n· 看板（含定时任务调度、飞书渠道、话题路由）\n· 记忆中心\n· 记忆 worker\n· 模型守门（LM Studio 1234：向量 bge-m3 + 仲裁 laya）" buttons {"取消","注册并启动"} default button "注册并启动" with title "Waker"' 2>/dev/null || true)
  case "$choice" in
    *注册并启动*) ;;
    *) exit 0 ;;
  esac
  mkdir -p "$LOG_DIR"
  if ! bash "$ROOT/scripts/register-launchd.sh" >"$LOG_DIR/app-launch.log" 2>&1; then
    alert "服务注册失败。\n日志：$LOG_DIR/app-launch.log"
    exit 1
  fi
  notify "服务已注册并启动"
else
  # 3) 已注册但没在跑：kickstart（不带 -k，运行中的 job 是 no-op，不会打断正在进行的工作）
  notify "正在启动服务…"
  for l in "${LABELS[@]}"; do
    launchctl kickstart "gui/$UID_NUM/$l" >/dev/null 2>&1 \
      || launchctl bootstrap "gui/$UID_NUM" "$LA_DIR/$l.plist" >/dev/null 2>&1 \
      || launchctl load -w "$LA_DIR/$l.plist" >/dev/null 2>&1 \
      || true
  done
fi

# 4) 等看板端口就绪（最多 30 秒）。冷启动要拉起 node 并加载三个渠道，10 秒内通常不够稳。
for _ in $(seq 1 60); do
  port_up "$PORT" && break
  sleep 0.5
done

if port_up "$PORT"; then
  open "http://127.0.0.1:$PORT"
  port_up "$MEM_PORT" || notify "记忆中心还在启动，稍后刷新看板即可"
  # 1234 是 LM Studio（向量 + 仲裁模型）。守门服务每 5 分钟会把它拉起来，
  # 这里只提示不等待：模型加载慢不该挡住看板打开。
  port_up "$LM_PORT" || notify "本地模型服务还没就绪，话题路由稍后会降级，守门服务正在接管"
else
  alert "看板启动超时（30 秒）。\n日志：$LOG_DIR/board.error.log"
  exit 1
fi
LAUNCHER
sed -i '' "s|__ROOT__|${ROOT}|g" "$APP/Contents/MacOS/Waker"
chmod +x "$APP/Contents/MacOS/Waker"

# ———————————————————————————— Info.plist ————————————————————————————
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>Waker</string>
  <key>CFBundleDisplayName</key>
  <string>Waker 看板</string>
  <key>CFBundleIdentifier</key>
  <string>${BUNDLE_ID}</string>
  <key>CFBundleExecutable</key>
  <string>Waker</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>${VERSION}</string>
  <key>CFBundleVersion</key>
  <string>${VERSION}</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
  <key>LSMinimumSystemVersion</key>
  <string>12.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>LSApplicationCategoryType</key>
  <string>public.app-category.productivity</string>
</dict>
</plist>
PLIST

# ———————————————————————————— 图标（可选） ————————————————————————————
# 没有 ImageMagick / rsvg，就自己算像素：深色圆角底 + 一个六孔弹巢。
# 失败不阻断——图标只是观感，app 仍可用。
build_icon() {
  local iconset="$1" png="$2"
  local js; js="$(mktemp -t waker-icon)"

  cat > "$js" <<'ICONJS'
const fs = require('fs');
const zlib = require('zlib');

const S = 1024;
const px = Buffer.alloc(S * S * 4);
const PAD = 100;                 // macOS 图标规范：四周留白，圆角外透明
const BOX = S - PAD * 2;
const RADIUS = 185;
const cx = S / 2, cy = S / 2;

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const clampA = (d) => clamp01(0.5 - d);          // 距离 → 抗锯齿透明度（1px 过渡带）
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

function sdRoundRect(x, y) {
  const qx = Math.abs(x - cx) - (BOX / 2 - RADIUS);
  const qy = Math.abs(y - cy) - (BOX / 2 - RADIUS);
  const ax = Math.max(qx, 0), ay = Math.max(qy, 0);
  return Math.sqrt(ax * ax + ay * ay) + Math.min(Math.max(qx, qy), 0) - RADIUS;
}

const RING_R = 300;              // 弹巢外接圆
const RING_W = 13;               // 环线宽的一半
const HOLE_R = 62, HOLE_DIST = 168, CENTER_R = 78;

function ringDistance(x, y) {
  const dx = x - cx, dy = y - cy;
  const rad = Math.hypot(dx, dy);
  const ang = Math.atan2(dy, dx);
  const sector = Math.PI / 3;
  const rel = (((ang % sector) + sector) % sector) - sector / 2;
  const edge = (RING_R * Math.cos(Math.PI / 6)) / Math.cos(rel);  // 该方向上的六边形半径
  return Math.abs(rad - edge) - RING_W;
}

const holes = [{ x: cx, y: cy, r: CENTER_R }];
for (let k = 0; k < 6; k++) {
  const ang = (k * Math.PI) / 3 - Math.PI / 2;
  holes.push({ x: cx + Math.cos(ang) * HOLE_DIST, y: cy + Math.sin(ang) * HOLE_DIST, r: HOLE_R });
}

const FG = [233, 236, 245];
for (let y = 0; y < S; y++) {
  const t = y / S;
  const bg = [35 + (11 - 35) * t, 38 + (13 - 38) * t, 50 + (18 - 50) * t];  // 自上而下的暗蓝渐变
  for (let x = 0; x < S; x++) {
    const i = (y * S + x) * 4;
    const aBg = clampA(sdRoundRect(x + 0.5, y + 0.5));
    if (aBg <= 0) { px[i + 3] = 0; continue; }
    let col = bg.slice();
    for (const h of holes) {
      const a = clampA(Math.hypot(x + 0.5 - h.x, y + 0.5 - h.y) - h.r);
      if (a > 0) col = mix(col, FG, a);
    }
    const aRing = clampA(ringDistance(x + 0.5, y + 0.5));
    if (aRing > 0) col = mix(col, FG, aRing);
    px[i] = col[0]; px[i + 1] = col[1]; px[i + 2] = col[2];
    px[i + 3] = Math.round(aBg * 255);
  }
}

// —— PNG 编码（无第三方依赖）——
const table = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const raw = Buffer.alloc((S * 4 + 1) * S);
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0;                       // filter: none
  px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0);
ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

fs.writeFileSync(
  process.argv[2],
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]),
);
ICONJS

  node "$js" "$png" || { rm -f "$js"; return 1; }
  rm -f "$js"

  mkdir -p "$iconset"
  local s
  for s in 16 32 128 256 512; do
    sips -z "$s" "$s" "$png" --out "$iconset/icon_${s}x${s}.png" >/dev/null 2>&1 || return 1
    local d=$((s * 2))
    sips -z "$d" "$d" "$png" --out "$iconset/icon_${s}x${s}@2x.png" >/dev/null 2>&1 || return 1
  done
  iconutil -c icns "$iconset" -o "$APP/Contents/Resources/AppIcon.icns" >/dev/null 2>&1
}

TMPDIR_ICON="$(mktemp -d -t waker-iconset)"
if command -v node >/dev/null 2>&1 && command -v sips >/dev/null 2>&1 && command -v iconutil >/dev/null 2>&1; then
  # iconutil 只认以 .iconset 结尾的目录名：名字不对会一声不吭地失败（本次就踩了）
  if build_icon "$TMPDIR_ICON/AppIcon.iconset" "$TMPDIR_ICON/waker-1024.png"; then
    echo "  ✓ 图标已生成"
  else
    echo "  - 图标生成失败，使用系统通用图标"
    rm -f "$APP/Contents/Resources/AppIcon.icns"
  fi
else
  echo "  - 缺少 node/sips/iconutil，跳过图标"
fi
rm -rf "$TMPDIR_ICON"

# ———————————————————————————— 落盘校验 ————————————————————————————
# ad-hoc 签名：让 Finder 双击时不弹"无法验证开发者"。自签名对本地脚本够用。
codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || echo "  - codesign 失败（不影响双击运行）"

plutil -lint "$APP/Contents/Info.plist" >/dev/null || { echo "Info.plist 非法"; exit 1; }
[[ -x "$APP/Contents/MacOS/Waker" ]] || { echo "启动脚本不可执行"; exit 1; }

echo "已生成：$APP"

if (( INSTALL )); then
  if cp -R "$APP" /Applications/ 2>/dev/null; then
    echo "已安装：/Applications/Waker.app"
  else
    echo "复制到 /Applications 失败（可能需要管理员权限），可手动拖入"
  fi
fi

cat <<EOF

用法：
  双击「Waker」（或 open "$APP"）
  服务已在跑 → 直接打开 http://127.0.0.1:8787
  服务没跑   → 通过 launchctl 拉起四个服务，就绪后自动打开看板

手动启停服务：
  bash scripts/register-launchd.sh stop      # 停
  bash scripts/register-launchd.sh           # 注册并启动
EOF
