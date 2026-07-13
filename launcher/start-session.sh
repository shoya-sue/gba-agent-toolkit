#!/usr/bin/env bash
# =============================================================
#  start-session.sh ― 「Start 一発」オーケストレーション (Phase 2 中核)
#
#  mGBA 起動 → ROM ロード → bridge.lua 自動ロード → 疎通確認 までを
#  1 コマンドで実行する。Tauri ランチャーの Rust バックエンドから
#  invoke される（GUI 無しでも単体実行・検証可能）。
#
#  Phase 0 知見: bridge.lua は GUI ロードのみ。qt.ini [recentScripts] に
#  事前登録 → File > Load recent script の AX クリックで自動ロード
#  （画面ロック中でも成功）。
#
#  使い方:
#    ./start-session.sh --rom <ROM> [--port 8765] [--bind 127.0.0.1] \
#                       [--bridge <bridge.lua>] [--mgba <mGBA.app>]
#  出力: 進捗は stderr、最終行に `RESULT: OK` / `RESULT: ERROR <msg>` を stdout。
#  終了コード: 0=OK / 1=起動失敗 / 2=引数不正
# =============================================================
set -uo pipefail

# ── デフォルト値 ──────────────────────────────────────────────
ROM=""
PORT="8765"
BIND="127.0.0.1"
MUTE="0"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BRIDGE="$REPO_ROOT/mcp-server/mgba-bridge/bridge.lua"
MGBA_APP="/opt/homebrew/opt/mgba/mGBA.app"
QT_INI="$HOME/.config/mgba/qt.ini"
TIMEOUT_SEC="20"

log() { printf '[start-session] %s\n' "$1" >&2; }
fail() { echo "RESULT: ERROR $1"; exit "${2:-1}"; }

# ── 引数パース ────────────────────────────────────────────────
while [ $# -gt 0 ]; do
  case "$1" in
    --rom)    ROM="$2"; shift 2;;
    --port)   PORT="$2"; shift 2;;
    --bind)   BIND="$2"; shift 2;;
    --bridge) BRIDGE="$2"; shift 2;;
    --mgba)   MGBA_APP="$2"; shift 2;;
    --mute)   MUTE="1"; shift;;
    --no-mute) MUTE="0"; shift;;
    *) echo "RESULT: ERROR unknown arg: $1"; exit 2;;
  esac
done

# ── 事前検証 ──────────────────────────────────────────────────
[ -n "$ROM" ] || { echo "RESULT: ERROR --rom is required"; exit 2; }
# port は 1-65535 の整数のみ
case "$PORT" in
  ''|*[!0-9]*) echo "RESULT: ERROR PORT must be an integer 1-65535: $PORT"; exit 2;;
esac
{ [ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ]; } || { echo "RESULT: ERROR PORT out of range 1-65535: $PORT"; exit 2; }
# bind は localhost 系のみ許可（外部公開事故の防止）
case "$BIND" in
  127.0.0.1|localhost|::1) : ;;
  *) echo "RESULT: ERROR BIND must be localhost/127.0.0.1/::1 (got: $BIND)"; exit 2;;
esac
[ -f "$ROM" ] || fail "ROM not found: $ROM" 1
[ -f "$BRIDGE" ] || fail "bridge.lua not found: $BRIDGE" 1
[ -d "$MGBA_APP" ] || fail "mGBA.app not found: $MGBA_APP" 1

# ── 既に稼働中なら短絡 ────────────────────────────────────────
if nc -z "$BIND" "$PORT" 2>/dev/null; then
  log "port $BIND:$PORT は既に OPEN（bridge 稼働中）→ 短絡成功"
  echo "RESULT: OK (already running)"
  exit 0
fi

# ── 1) qt.ini [recentScripts] に bridge.lua を冪等登録 ────────
log "qt.ini に bridge.lua を登録: $BRIDGE"
mkdir -p "$(dirname "$QT_INI")"
touch "$QT_INI"
python3 - "$QT_INI" "$BRIDGE" <<'PY'
import sys, re, io
ini_path, bridge = sys.argv[1], sys.argv[2]
try:
    with io.open(ini_path, 'r', encoding='utf-8') as f:
        text = f.read()
except FileNotFoundError:
    text = ''
lines = text.splitlines()
# [recentScripts] セクションを探す
out, in_sec, done = [], False, False
i = 0
new_sec = ['[recentScripts]', '0=%s' % bridge]
result = []
if '[recentScripts]' in text:
    # 既存セクションの 0= を bridge に置換（先頭に）
    sec_start = None
    for idx, ln in enumerate(lines):
        if ln.strip() == '[recentScripts]':
            sec_start = idx; break
    # セクション終端（次の [ ... ] か EOF）
    sec_end = len(lines)
    for idx in range(sec_start+1, len(lines)):
        if re.match(r'^\[.*\]\s*$', lines[idx]):
            sec_end = idx; break
    # 既存エントリから bridge を除外し、先頭に bridge を置いて採番し直す
    entries = []
    for ln in lines[sec_start+1:sec_end]:
        m = re.match(r'^\d+=(.*)$', ln.strip())
        if m and m.group(1) != bridge:
            entries.append(m.group(1))
    entries = [bridge] + entries
    rebuilt = ['[recentScripts]'] + ['%d=%s' % (k, v) for k, v in enumerate(entries)]
    result = lines[:sec_start] + rebuilt + lines[sec_end:]
else:
    # セクションが無ければ末尾に追加
    result = lines + ([''] if lines and lines[-1].strip() else []) + new_sec
with io.open(ini_path, 'w', encoding='utf-8') as f:
    f.write('\n'.join(result) + '\n')
print('qt.ini updated', file=sys.stderr)
PY

# ── 1.5) qt.ini [General] mute を冪等に設定（ゲーム音のミュート）──
log "qt.ini [General] mute=$MUTE を設定"
python3 - "$QT_INI" "$MUTE" <<'PY'
import sys, re, io
ini_path, mute = sys.argv[1], sys.argv[2]
# mute は "1"（ミュート）/ "0"（解除）のみ許可
mute = '1' if mute == '1' else '0'
try:
    with io.open(ini_path, 'r', encoding='utf-8') as f:
        text = f.read()
except FileNotFoundError:
    text = ''
lines = text.splitlines()
# [General] セクションを探す（無ければ先頭に作る）
sec_start = None
for idx, ln in enumerate(lines):
    if ln.strip() == '[General]':
        sec_start = idx; break
if sec_start is None:
    lines = ['[General]', 'mute=%s' % mute, ''] + lines
else:
    sec_end = len(lines)
    for idx in range(sec_start + 1, len(lines)):
        if re.match(r'^\[.*\]\s*$', lines[idx]):
            sec_end = idx; break
    # 既存 mute= を置換、無ければセクション先頭に追加（冪等）
    replaced = False
    for idx in range(sec_start + 1, sec_end):
        if re.match(r'^\s*mute\s*=', lines[idx]):
            lines[idx] = 'mute=%s' % mute; replaced = True; break
    if not replaced:
        lines.insert(sec_start + 1, 'mute=%s' % mute)
with io.open(ini_path, 'w', encoding='utf-8') as f:
    f.write('\n'.join(lines) + '\n')
print('qt.ini [General] mute set to %s' % mute, file=sys.stderr)
PY

# ── 2) mGBA を ROM 付きで起動 ────────────────────────────────
log "mGBA 起動 + ROM ロード: $ROM"
open -a "$MGBA_APP" "$ROM" || fail "failed to launch mGBA" 1

# mGBA プロセスと ROM ロードを待つ
for _ in $(seq 1 20); do
  if pgrep -f "mGBA.app/Contents/MacOS/mGBA" >/dev/null 2>&1; then break; fi
  sleep 0.3
done
sleep 1.5   # ROM 初期化を待つ（bridge は emu 定義後でないとクラッシュ）

# ── 3) bridge.lua を AX メニュークリックで自動ロード ─────────
log "Tools > Scripting… を開く"
osascript -e 'tell application "System Events" to tell process "mGBA" to set frontmost to true' 2>/dev/null
osascript -e 'tell application "System Events" to tell process "mGBA" to click menu item "Scripting..." of menu 1 of menu bar item "Tools" of menu bar 1' 2>/dev/null \
  || log "警告: Scripting メニュークリックに失敗（既に開いている可能性）"
sleep 1.2
log "File > Load recent script → bridge.lua をクリック"
osascript -e 'tell application "System Events" to tell process "mGBA" to click menu item 1 of menu 1 of menu item "Load recent script" of menu 1 of menu bar item "File" of menu bar 1' 2>/dev/null \
  || fail "Load recent script のクリックに失敗（recentScripts 未登録の可能性）" 1

# ── 4) ポート開放をポーリング ────────────────────────────────
log "port $BIND:$PORT の OPEN を待機（最大 ${TIMEOUT_SEC}s）"
opened=0
for _ in $(seq 1 $((TIMEOUT_SEC * 2))); do
  if nc -z "$BIND" "$PORT" 2>/dev/null; then opened=1; break; fi
  sleep 0.5
done
[ "$opened" = 1 ] || fail "bridge がポートを開きませんでした ($BIND:$PORT)" 1
log "port $BIND:$PORT OPEN ✓"

# ── 5) MCP 経路の疎通確認（mcp-mgba ping）────────────────────
MCP="$(command -v mcp-mgba 2>/dev/null || true)"
if [ -n "$MCP" ]; then
  log "mcp-mgba 経由で疎通確認（ping）"
  PROBE="$(mktemp)"
  {
    printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"start-session","version":"0"}}}'
    printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized"}'
    printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"mgba_ping","arguments":{}}}'
  } > "$PROBE"
  GT="$(command -v gtimeout || true)"
  if [ -n "$GT" ]; then OUT="$(MGBA_HOST="$BIND" MGBA_PORT="$PORT" "$GT" 12 "$MCP" < "$PROBE" 2>&1)"
  else OUT="$(MGBA_HOST="$BIND" MGBA_PORT="$PORT" "$MCP" < "$PROBE" 2>&1 &  p=$!; sleep 8; kill "$p" 2>/dev/null; wait "$p" 2>/dev/null)"; fi
  rm -f "$PROBE"
  if printf '%s' "$OUT" | grep -qi 'pong'; then
    log "mgba_ping → pong ✓"
    echo "RESULT: OK"
    exit 0
  else
    log "警告: ping 応答が得られず（bridge はポートを開いている）"
    echo "RESULT: OK (port open, ping unconfirmed)"
    exit 0
  fi
else
  log "mcp-mgba が PATH に無し（bridge はポートを開いている）"
  echo "RESULT: OK (port open, mcp-mgba not on PATH)"
  exit 0
fi
