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

## 実機接続テスト ✅（2026-07-10 実施・PASS）
mGBA に ROM + `bridge.lua` をロードし、`mcp-mgba` 経由で 3 ツールを実測。**すべて実データで通過**:

| ツール | 実測レスポンス |
|---|---|
| `mgba_ping` | `pong` |
| `mgba_get_info` | `Title: GBA Tests / Code: AGB-1337 / Platform: 0 / Frame: 26197`（ライブ実機値） |
| `mgba_screenshot` | `/tmp/lua_xxxx.png` に保存 → **240×160 8-bit RGB PNG**（GBA 実解像度、ROM 描画内容を正しくキャプチャ） |

- `mcp-mgba` stderr: `connected to mGBA bridge at 127.0.0.1:8765` / `MCP server ready (stdio)`
- `nc -z 127.0.0.1 8765` → OPEN（bridge がポートを bind 済み）
- `./scripts/test-connection.sh` → `✓ PASS: mgba_ping 応答あり（bridge.lua 稼働中・接続成立）`

> **自動化知見（重要）**: bridge.lua のロードは当初「GUI 必須・自動化不能」と結論づけたが、**画面ロック中でも自動化できた**。方法: `~/.config/mgba/qt.ini` の `[recentScripts]` セクションに bridge.lua の絶対パスを事前登録 → mGBA 起動 → `Tools > Scripting…` を AX(AppleScript System Events) で開く → `File > Load recent script` サブメニューの項目を **AX クリック**（NSOpenPanel 系のファイルダイアログはロック中に効かないが、メニュー項目クリックは効く）。→ [docs/phase0-setup.md](phase0-setup.md)

## 完了条件 (DoD) 進捗 — **全項目達成 ✅**
- [x] mGBA の Lua 有効性が確定（**有効**）
- [x] MCP 土台の選定・ライセンス確認・接続方式の確立
- [x] mcp-mgba 導入・bridge.lua 配置（導入版と一致）・セットアップ手順書
- [x] **mcp-mgba MCP サーバの稼働確認**（`tools/list` で 19 ツール応答）＋接続テストスクリプト `scripts/test-connection.sh`
- [x] **自ROMで `ping`/`get_info`/`screenshot` が通る**（上表の実測で PASS。`test-connection.sh` → `✓ PASS`）

> **Phase 0 完了（2026-07-10）**: 環境検証・MCP サーバ稼働・実機 bridge 疎通の全 DoD を実データで確認。次は Phase 1（#3: コア API 3 系統＋セーブステート）へ。
> 検証に用いた ROM は jsmolka/gba-tests（MIT・公開テスト ROM）。本番運用では自己所有カートリッジの吸い出し ROM を使用する（`.gitignore` で ROM/セーブ系を除外済み）。

---

## #10 自己所有 ROM 通し確認 (2026-07-13)

> Issue [#10](https://github.com/shoya-sue/gba-agent-toolkit/issues/10) の実 ROM 検証。ランナー: `scripts/verify-phase10.sh <ROM>`（拡張子で GBA/GB を自動判定）。
> ROM は自己所有カートリッジの吸い出しのみ使用・**タイトルは一般化**（`.gitignore` で `roms/` を除外）。

### GBA（実商用 ROM・自己所有吸い出し）— **6/6 PASS**
`./scripts/verify-phase10.sh roms/<GBA ROM>` → `verify-phase10-gba.mjs`（ROM 非依存プローブ）

| 項目 | 結果 |
|---|---|
| `mgba_ping` | `pong` |
| `mgba_get_info` | ライブ値（frame 進行・ROM ヘッダ title 取得）|
| `mgba_screenshot` | 240×160 PNG（実ゲーム画面）|
| `mgba_press_buttons` | A/B/Up/Down/Start FIFO 受理 |
| `mgba_read_range(0x080000A0,12)` | ROM ヘッダ title を読取 → `get_info` の Title と**自己整合**（ROM 非依存の不変条件）|
| `save_state`→進行→`load_state` | frame 進行後に巻戻り確認 |

### GB/GBC（公開 ROM libbet.gb / zlib）— **12/12 PASS**
`./scripts/verify-phase10.sh roms/libbet.gb` → `test_pyboy_api.py`（GB(DMG)/GBC(CGB) 両モード）。画面 160×144 / 8ボタン / メモリ read / save→WRAM 書換→load 復元。

### エージェント自律ループ（実 GBA ROM）— **8/8 ステップ成立**
`POLICY=llm OLLAMA_MODEL=qwen2.5:7b node agent/play-loop.mjs 8` → 実 ROM で 知覚→判断→行動 が全ステップ破綻なく成立（ローカル LLM がボタン決定、frame 連続進行）。#8 のローカル LLM ポリシーを **公開テスト ROM 以外の実商用 ROM** で初検証。

> **#10 DoD（基本 API=画面/入力/メモリ/セーブ疎通）達成 ✅**: GBA=実自己所有 ROM で 6/6、GB/GBC=公開 ROM で 12/12。残: 実ゲーム固有の状態アドレス（HP/座標等）の意味読取は game 固有 RAM マップ依存のため任意深掘り。
