#!/usr/bin/env bash
# =============================================================
#  verify-phase10.sh ― 自己所有 ROM で全 Phase 通し確認 (#10)
#
#  拡張子から GBA / GB(C) 経路を自動判定し、実 ROM で主要 API が
#  end-to-end に通ることを ROM 非依存で検証する。
#
#    - .gba/.agb → GBA: start-session.sh で mGBA+bridge 起動 →
#                  verify-phase10-gba.mjs（ping/info/screenshot/press/
#                  read_range/save+load）→ stop-session.sh
#    - .gb/.gbc  → GB/GBC: PyBoy venv で test_pyboy_api.py（両モード）
#
#  使い方: ./scripts/verify-phase10.sh <roms/NAME.gba|.gb|.gbc>
#  終了コード: 0=PASS / 1=FAIL / 2=前提不足
#
#  ※ ROM は自己所有カートリッジの吸い出しのみ（roms/ は .gitignore 済）
# =============================================================
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

ROM="${1:-}"
if [ -z "$ROM" ]; then
  echo "usage: $0 <ROM path (.gba/.agb/.gb/.gbc)>"
  echo "  例: $0 roms/mygame.gba"
  exit 2
fi
if [ ! -f "$ROM" ]; then
  echo "ROM not found: $ROM"
  echo "  ROM は roms/ に配置してください（.gitignore 済で非コミット）"
  exit 2
fi

# 拡張子を小文字化して判定
ext="${ROM##*.}"
ext="$(printf '%s' "$ext" | tr '[:upper:]' '[:lower:]')"

case "$ext" in
  gba|agb)
    echo "▶ [GBA] 実 ROM 通し確認: $ROM"
    echo "  1) mGBA + bridge.lua 起動（start-session.sh）"
    if ! "$ROOT/launcher/start-session.sh" --rom "$ROM"; then
      echo "✗ start-session.sh 失敗（mGBA/bridge 起動不可）"
      exit 2
    fi
    echo "  2) ROM 非依存 API プローブ（verify-phase10-gba.mjs）"
    rc=0
    node "$ROOT/scripts/verify-phase10-gba.mjs" || rc=$?
    echo "  3) セッション停止（stop-session.sh）"
    "$ROOT/launcher/stop-session.sh" >/dev/null 2>&1 || true
    exit "$rc"
    ;;
  gb|gbc)
    echo "▶ [GB/GBC] 実 ROM 通し確認: $ROM"
    VENV="$ROOT/mcp-server/pyboy/.venv"
    PY="$VENV/bin/python"
    if [ ! -x "$PY" ]; then
      echo "✗ PyBoy venv 未構築: $VENV"
      echo "  構築: python3.13 -m venv $VENV && $VENV/bin/pip install -r mcp-server/pyboy/requirements.txt"
      exit 2
    fi
    "$PY" "$ROOT/mcp-server/pyboy/test_pyboy_api.py" "$ROM"
    ;;
  *)
    echo "✗ 未対応の拡張子: .$ext （対応: .gba .agb .gb .gbc）"
    exit 2
    ;;
esac
