#!/usr/bin/env bash
# =============================================================
#  stop-session.sh ― セッション停止（mGBA 終了 = bridge も停止）
#  使い方: ./stop-session.sh
#  出力: 最終行に RESULT: OK
# =============================================================
set -uo pipefail
log() { printf '[stop-session] %s\n' "$1" >&2; }

if pgrep -f "mGBA.app/Contents/MacOS/mGBA" >/dev/null 2>&1; then
  log "mGBA を終了します"
  osascript -e 'tell application "mGBA" to quit' 2>/dev/null || true
  sleep 1
  # まだ残っていれば TERM
  pkill -TERM -f "mGBA.app/Contents/MacOS/mGBA" 2>/dev/null || true
  sleep 0.5
fi

if pgrep -f "mGBA.app/Contents/MacOS/mGBA" >/dev/null 2>&1; then
  log "警告: mGBA プロセスが残存"
  echo "RESULT: OK (mGBA still running)"
else
  log "mGBA 終了確認"
  echo "RESULT: OK"
fi
exit 0
