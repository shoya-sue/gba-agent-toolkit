#!/usr/bin/env bash
# =============================================================
#  check-mgba.sh ― mGBA 環境検証スクリプト (Phase 0)
#
#  目的: AI Agent 操作の土台となる mGBA が使える状態かを確認する。
#    - mGBA バイナリの存在・バージョン
#    - Lua スクリプティング有効性の手掛かり（v0.10+ で標準サポート）
#    - Homebrew formula 情報
#
#  注意: このスクリプトは ROM を一切扱わない。
#        吸い出し済み ROM は各自で用意すること（配布・同梱しない）。
# =============================================================
set -euo pipefail

green() { printf '\033[0;32m%s\033[0m\n' "$1"; }
yellow() { printf '\033[0;33m%s\033[0m\n' "$1"; }
red() { printf '\033[0;31m%s\033[0m\n' "$1"; }

echo "== mGBA 環境検証 (Phase 0) =="
echo

# --- 1. mGBA バイナリ検出 ---
MGBA_BIN=""
for cand in mgba mgba-qt; do
  if command -v "$cand" >/dev/null 2>&1; then
    MGBA_BIN="$cand"
    break
  fi
done

if [[ -z "$MGBA_BIN" ]]; then
  red "✗ mGBA バイナリ (mgba / mgba-qt) が PATH に見つかりません。"
  echo "  → 用意済みの mGBA.app 内バイナリのパスを PATH に通すか、'brew install mgba' を検討。"
else
  green "✓ mGBA バイナリ検出: $MGBA_BIN ($(command -v "$MGBA_BIN"))"
  echo "  version: $("$MGBA_BIN" --version 2>&1 | head -1 || echo '取得失敗')"
fi
echo

# --- 2. Lua スクリプティング有効性の手掛かり ---
echo "-- Lua スクリプティング (v0.10+ で標準) --"
if [[ -n "$MGBA_BIN" ]]; then
  VER_LINE="$("$MGBA_BIN" --version 2>&1 | head -1 || true)"
  # バージョン番号を抽出 (例: 0.10.5)
  VER="$(printf '%s' "$VER_LINE" | grep -oE '[0-9]+\.[0-9]+(\.[0-9]+)?' | head -1 || true)"
  if [[ -n "$VER" ]]; then
    MAJOR_MINOR="$(printf '%s' "$VER" | awk -F. '{print $1"."$2}')"
    if awk "BEGIN{exit !($MAJOR_MINOR >= 0.10)}"; then
      green "✓ v$VER → Lua スクリプティング対応バージョンの可能性が高い"
    else
      yellow "⚠ v$VER → v0.10 未満。Lua スクリプティング無効の可能性。ソースからの再ビルドを検討"
    fi
  else
    yellow "⚠ バージョン番号を取得できず。GUI の [Tools > Scripting] メニュー有無で手動確認を推奨"
  fi
else
  yellow "⚠ バイナリ未検出のため判定不可"
fi
echo "  ※確実な確認: mGBA GUI を起動し [Tools > Scripting] が存在するか / Lua スクリプトをロードできるか"
echo

# --- 3. Homebrew formula 情報 + GUI app + Lua ヘッダ根拠 ---
if command -v brew >/dev/null 2>&1; then
  echo "-- Homebrew --"
  if brew list --versions mgba >/dev/null 2>&1; then
    green "✓ brew formula 'mgba' インストール済み"
    PREFIX="$(brew --prefix mgba 2>/dev/null)"
    # GUI app パス
    APP="$(/bin/ls -d "$PREFIX"/mGBA.app 2>/dev/null | head -1)"
    [ -n "$APP" ] && green "✓ GUI app: $APP/Contents/MacOS/mGBA"
    # Lua スクリプティング有効の根拠（scripting ヘッダ / lua 依存）
    if /bin/ls "$PREFIX"/include/mgba/internal/script/lua.h >/dev/null 2>&1; then
      green "✓ Lua scripting 有効の根拠: internal/script/lua.h あり"
    fi
    DEPS="$(brew deps mgba 2>/dev/null)"
    if printf '%s\n' "$DEPS" | grep -qx lua; then
      green "✓ formula 依存に 'lua' を確認"
    fi
  else
    yellow "⚠ brew formula 'mgba' は未インストール（用意済み mGBA.app を使う場合は問題なし）"
  fi
  echo
fi

echo "== 次のステップ =="
echo "  1. dmang-dev/mcp-mgba を clone し lua/bridge.lua を自 ROM でロード"
echo "  2. TCP:8765 への接続 + mgba_ping / mgba_get_info / mgba_screenshot を確認"
echo "  3. 結果を docs/env-verification.md に記録"
echo "  → 詳細は Issue #2 (Phase 0) を参照"
