# mgba-bridge (vendored)

mGBA の Lua スクリプティングで動く TCP ブリッジ。`Tools > Scripting > Load script` で `bridge.lua` を読み込むと、`127.0.0.1:8765` で MCP サーバ（`mcp-mgba`）からの JSON-RPC を受け、mGBA ネイティブ API へ橋渡しする。

## ファイル
- `bridge.lua` — ブリッジ本体（TCP:8765 待受・フレームコールバック）
- `json.lua` — JSON エンコード/デコード
- `LICENSE.mcp-mgba` — 流用元ライセンス（MIT）

## 出典・ライセンス
[`dmang-dev/mcp-mgba`](https://github.com/dmang-dev/mcp-mgba)（MIT License）の `lua/` から取り込み（vendored）。著作権表示は `LICENSE.mcp-mgba` を参照。更新時は上流に追従する。

## 使い方
[docs/phase0-setup.md](../../docs/phase0-setup.md) を参照。要点:
1. mGBA(mGBA.app) で **ROM を先に読み込む**（`emu` 未定義クラッシュ回避）
2. `Tools > Scripting…` → `File > Load script` で本 `bridge.lua` を選択
3. Console に `bridge listening on 127.0.0.1:8765` が出れば有効
4. 別途 `mcp-mgba`（npm）を起動し、Claude Code から `mgba_ping` で疎通確認
