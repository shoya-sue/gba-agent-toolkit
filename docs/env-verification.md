# 環境検証記録 (Phase 0)

> Issue [#2 Phase 0: 環境検証・接続確認](https://github.com/shoya-sue/gba-agent-toolkit/issues/2) の検証結果。
> 検証日: 2026-07-10 ／ 環境: macOS (Apple Silicon), Homebrew 6.0.9, Node v24.9.0

## 自動検証済み ✅

### mGBA
| 項目 | 結果 |
|---|---|
| 導入 | `brew install mgba` 完了 |
| バージョン | **0.10.5**（`/opt/homebrew/Cellar/mgba/0.10.5_2/mGBA.app`） |
| GUI バイナリ | `/opt/homebrew/Cellar/mgba/0.10.5_2/mGBA.app/Contents/MacOS/mGBA`（`mgba-qt` 単体は無し） |
| CLI バイナリ | `/opt/homebrew/bin/mgba` |
| **Lua スクリプティング** | **有効** — formula 依存に `lua`、`scripting.h`/`internal/script/lua.h`/`script/socket.h` ヘッダあり、v0.10.5（v0.10+ で標準） |

### mcp-mgba（GBA MCP 土台に採用）
| 項目 | 結果 |
|---|---|
| 導入 | `npm install -g mcp-mgba` 完了（`~/.nvm/.../bin/mcp-mgba`） |
| bridge.lua | 同梱確認（`.../mcp-mgba/lua/bridge.lua` + `json.lua`）。本リポジトリ `mcp-server/mgba-bridge/` に vendor 済み |
| 接続方式 | newline-delimited JSON-RPC over TCP `127.0.0.1:8765`、フレームコールバック駆動 |
| ライセンス | **MIT** |
| 版数 | installed **v0.3.3** / vendored `bridge.lua`・`json.lua` は導入版と**一致**（diff 差分なし） |

### MCP サーバ稼働確認（自動テスト済み）
`mcp-mgba` を stdio MCP サーバとして起動し、`initialize` + `tools/list` に応答することを実測:
- serverInfo=`mcp-mgba`、protocolVersion=`2024-11-05`
- **19 ツール**を列挙: `mgba_ping` / `mgba_get_info` / `mgba_screenshot` / `mgba_read8|16|32` / `mgba_write8|16|32` / `mgba_read_range` / `mgba_write_range` / `mgba_press_buttons` / `mgba_advance_frames` / `mgba_pause` / `mgba_unpause` / `mgba_reset` / `mgba_save_state` / `mgba_load_state` / `mgba_write`
- bridge 未接続時は `WARNING: could not connect to mGBA bridge (127.0.0.1:8765)` を出しつつサーバは正常稼働 → **サーバ側は完成**、残りは mGBA 側 GUI ロードのみ
- 接続テストは `./scripts/test-connection.sh` で PASS/FAIL 判定可能（bridge 稼働後に実行）

### 比較評価
| 項目 | mcp-mgba | struktured-labs/mgba-mcp |
|---|---|---|
| 言語 | TypeScript | Python |
| 対応機種 | GBA | GB/GBC/GBA |
| button input | ✓ | ✗ |
| headless | ✗ | ✓ (xvfb) |
| ライセンス | MIT | README記載のみ（LICENSEファイルなし） |
| **採用** | **✓ GBA土台** | GB/GBC は Phase 4 で PyBoy 採用 |

## 実機で残る手順 ⏳（GUI + 自ROM が必要）
bridge.lua のロードは **GUI 操作のみ**（CLI 起動オプション無し）のため、以下は実機で実施:
1. `mGBA.app` を起動し、**自ROMを読み込む**（ROM無しは `emu` 未定義でクラッシュ）
2. `Tools > Scripting…` → `File > Load script` で `mcp-server/mgba-bridge/bridge.lua` をロード
3. Console に `bridge listening on 127.0.0.1:8765` を確認
4. 別ターミナルで `mcp-mgba` 起動 → `claude mcp add mgba --scope user mcp-mgba`
5. Claude Code から `mgba_ping`(→pong) / `mgba_get_info` / `mgba_screenshot`

手順詳細: [docs/phase0-setup.md](phase0-setup.md)

## 完了条件 (DoD) 進捗
- [x] mGBA の Lua 有効性が確定（**有効**）
- [x] MCP 土台の選定・ライセンス確認・接続方式の確立
- [x] mcp-mgba 導入・bridge.lua 配置（導入版と一致）・セットアップ手順書
- [x] **mcp-mgba MCP サーバの稼働確認**（`tools/list` で 19 ツール応答）＋接続テストスクリプト `scripts/test-connection.sh`
- [ ] 自ROMで `ping`/`get_info`/`screenshot` が通る ← **実機GUI操作待ち**（mGBAで自ROMロード→`bridge.lua`をScriptingでLoad→`./scripts/test-connection.sh`）

> **自動化限界の明記**: `bridge.lua` のロードは mGBA GUI の `Tools > Scripting` のみ（CLI/config 起動オプション無しを実機確認済み: `--bios`/`--savestate`/`--config` 等のみ）。かつ実 ROM が必要。この 1 ステップのみユーザー実機操作が必須で、自動化不能。完了後 `test-connection.sh` が PASS を返せば Phase 0 DoD 完全達成。
