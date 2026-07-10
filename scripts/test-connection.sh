#!/usr/bin/env bash
# =============================================================
#  test-connection.sh ― mcp-mgba ↔ bridge.lua ↔ mGBA 接続テスト (Phase 0 DoD)
#
#  前提: mGBA で ROM をロードし、Tools > Scripting で
#        mcp-server/mgba-bridge/bridge.lua を実行済みであること。
#  本スクリプトは mcp-mgba(MCPサーバ)を起動し、mgba_ping / mgba_get_info を
#  呼んで bridge の疎通を PASS/FAIL 判定する。ROM は扱わない。
# =============================================================
set -uo pipefail

MCP="$(command -v mcp-mgba || true)"
if [ -z "$MCP" ]; then
  echo "✗ mcp-mgba が PATH にありません。'npm install -g mcp-mgba' を実行してください。"
  exit 1
fi

TMP="$(mktemp)"
{
  printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"phase0-test","version":"0"}}}'
  printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized"}'
  printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"mgba_ping","arguments":{}}}'
  printf '%s\n' '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"mgba_get_info","arguments":{}}}'
} > "$TMP"

run_probe() {
  if command -v timeout >/dev/null 2>&1; then
    timeout 12 "$MCP" < "$TMP"
  elif command -v gtimeout >/dev/null 2>&1; then
    gtimeout 12 "$MCP" < "$TMP"
  else
    "$MCP" < "$TMP" &
    local p=$!
    sleep 8
    kill "$p" 2>/dev/null
    wait "$p" 2>/dev/null
  fi
}

OUT="$(run_probe 2>&1)"
rm -f "$TMP"

if printf '%s' "$OUT" | grep -qiE 'pong|"connected"[[:space:]]*:[[:space:]]*true'; then
  echo "✓ PASS: mgba_ping 応答あり（bridge.lua 稼働中・接続成立）"
  title="$(printf '%s' "$OUT" | grep -oE '"title"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1)"
  [ -n "$title" ] && echo "  ROM: $title"
  echo "  → Phase 0 DoD 達成。Phase 1 (#3) へ。"
  exit 0
elif printf '%s' "$OUT" | grep -qiE 'ECONNREFUSED|could not connect'; then
  echo "✗ FAIL: mGBA bridge に接続できません (127.0.0.1:8765)。"
  echo "  1) mGBA(mGBA.app) を起動し、自ROMを読み込む"
  echo "  2) Tools > Scripting… → File > Load script で:"
  echo "     $(cd "$(dirname "$0")/.." && pwd)/mcp-server/mgba-bridge/bridge.lua"
  echo "  3) Console に 'bridge listening on 127.0.0.1:8765' を確認後、本スクリプトを再実行"
  exit 2
else
  echo "? 判定不能。MCP サーバ生応答(先頭):"
  printf '%s\n' "$OUT" | head -15
  exit 3
fi
