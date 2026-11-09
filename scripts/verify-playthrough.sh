#!/usr/bin/env bash
# =============================================================
#  verify-playthrough.sh ― 自律プレイスルー E2E 完走テスト統合ランナー (Epic #13 / #17)
#
#  「起動 → 一通りプレイ → 完結」を自立稼働で実行し、合否レポートを出す。
#    1) launcher/start-session.sh で mGBA + ROM + bridge.lua 起動
#    2) scripts/verify-playthrough.mjs: シナリオ → playthrough.mjs
#       （ハーネス #14 + 進捗/完走判定 #15 + スタック検出リカバリ #16 + 状態読取 #12）
#       → runs/<id>/report.{json,md} に合否レポート
#    3) launcher/stop-session.sh でセッション停止（失敗・中断時も実施）
#
#  使い方: ./scripts/verify-playthrough.sh <roms/NAME.gba> [agent/scenarios/<game>.local.json]
#          （シナリオ省略時は SCENARIO env、無ければ agent/scenarios/example.json）
#  終了コード: 0=PASS（完結到達） / 1=FAIL（理由・到達点はレポート） / 2=前提不足
#
#  ※ 実機 mGBA / 自己所有 ROM / (POLICY=llm なら ollama) 依存のため CI 対象外・ローカル実行のみ。
#  ※ ROM は自己所有カートリッジの吸い出しのみ（roms/ は .gitignore 済）
# =============================================================
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

ROM="${1:-}"
SCENARIO_PATH="${2:-${SCENARIO:-$ROOT/agent/scenarios/example.json}}"

if [ -z "$ROM" ]; then
  echo "usage: $0 <ROM path (.gba/.agb)> [scenario.json]"
  echo "  例: $0 roms/mygame.gba agent/scenarios/mygame.local.json"
  exit 2
fi
if [ ! -f "$ROM" ]; then
  echo "ROM not found: $ROM"
  echo "  ROM は roms/ に配置してください（.gitignore 済で非コミット）"
  exit 2
fi
if [ ! -f "$SCENARIO_PATH" ]; then
  echo "scenario not found: $SCENARIO_PATH"
  exit 2
fi

base="$(basename "$ROM")"; ext="${base##*.}"; [ "$ext" = "$base" ] && ext=""
ext="$(printf '%s' "$ext" | tr '[:upper:]' '[:lower:]')"
case "$ext" in
  gba|agb) ;;
  *)
    echo "✗ 未対応の拡張子: .$ext（E2E 完走テストは GBA/mGBA 経路のみ。playthrough.mjs は mcp-mgba 前提）"
    exit 2
    ;;
esac

ROM_ABS="$(cd "$(dirname "$ROM")" && pwd)/$(basename "$ROM")"

echo "▶ [E2E] 自律プレイスルー完走テスト: $ROM"
echo "  シナリオ: $SCENARIO_PATH"
echo "  1) mGBA + bridge.lua 起動（start-session.sh）"
if ! "$ROOT/launcher/start-session.sh" --rom "$ROM_ABS"; then
  echo "✗ start-session.sh 失敗（mGBA/bridge 起動不可）"
  exit 2
fi
trap '"$ROOT/launcher/stop-session.sh" >/dev/null 2>&1 || true' EXIT

echo "  2) 自律プレイ → 合否レポート（verify-playthrough.mjs）"
rc=0
node "$ROOT/scripts/verify-playthrough.mjs" "$SCENARIO_PATH" --rom "$ROM_ABS" || rc=$?

echo "  3) セッション停止（stop-session.sh）"
exit "$rc"
