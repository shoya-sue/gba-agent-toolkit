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

### エージェント自律ループ（実 GBA ROM）
- **text（qwen2.5:7b）— 8/8 ステップ成立**: `POLICY=llm node agent/play-loop.mjs 8` → 実 ROM で 知覚→判断→行動 が全ステップ破綻なく成立（frame 連続進行、実ゲームが「タイトル→ニューゲーム→クラス選択」まで進行）。#8 のローカル LLM ポリシーを **公開テスト ROM 以外の実商用 ROM** で初検証。
- **vision（moondream + 画面PNG添付）— 5/5 ステップ成立**: `POLICY=llm OLLAMA_MODEL=moondream OLLAMA_VISION=1 node agent/play-loop.mjs 5` → 画面 PNG を LLM に渡す経路が実 ROM で成立（ステップ毎に出力変化＝画像に反応）。
- **画面把握の一次確認**: 保存 PNG を目視（タイトル画面／クラス選択画面が正しく描画）＋ vision LLM が画面内容を読取（"Dawn of Souls" タイトル・warrior/thief/monk/red mage メニューを認識。作品名の誤認は軽量モデルの世界知識限界で、画面テキスト自体の読取は正確）。
  - → **知覚（画面キャプチャ・LLM への受け渡し）は確実に成立。判断の質はモデル依存**（強い vision / Claude へ差し替えで画面ベース判断を強化できる設計）。

> **#10 DoD（基本 API=画面/入力/メモリ/セーブ疎通）達成 ✅**: GBA=実自己所有 ROM で 6/6、GB/GBC=公開 ROM で 12/12。残: 実ゲーム固有の状態アドレス（HP/座標等）の意味読取は game 固有 RAM マップ依存のため任意深掘り。

---

## #12 実ゲーム状態アドレス読取・報酬設計 (2026-07-13)

> Issue [#12](https://github.com/shoya-sue/gba-agent-toolkit/issues/12)。#10 で残した「ゲーム固有状態の意味読取」を実装。
> 設計・使い方は [state-reading.md](state-reading.md)。実アドレス／ROM 依存マップは
> `agent/state-maps/<game>.local.json`（`.gitignore` 済）で別管理。

### 純粋ロジック — unit **112/112 PASS**
`agent/lib/state.mjs`（パーサ／記述子解釈／状態署名／報酬計算／メモリ差分）＋ `readState`。
`git ls-files '*.test.mjs' | xargs node --test`（+新規 `state.test.mjs` 46 件）→ 112/112。

### 実 ROM 検証（自己所有 GBA ROM・ライブ）
- **read 返り値フォーマットのライブ確定＋パーサ修正**: 実機で read8/16/32 は
  `"0x<ADDR>: <DEC> (0x<HEXVAL>)"`、read_range は `"0x<ADDR> [<N> bytes]:\n<hex...>"` と判明。
  当初パーサが**先頭アドレスを値と誤読**／ヘッダの `[N bytes]` を余分バイトに拾うバグを
  ライブ検証で発見→修正し、実フォーマットの回帰テストを追加（この 2 件は unit 46 に内包）。
  修正後 `readState` は ROM ヘッダを正しく数値化（title=ROM 名 / read8=先頭バイト値 等）。
- **動的状態アドレスの特定**: `scripts/scan-memory.mjs` の「行動前後メモリ差分（変化+復帰）」
  スキャン → 決定的トグルでの絞り込みで、EWRAM 上のメニュー選択インデックス
  （離散値・入力に完全連動）を特定。アニメーションの多い画面はノイズが乗るため、
  離散カーソル値を決定的操作で確定する手順が有効と確認。
- **observation 経由の参照（統合コードパスをライブ実演）**: `readState → observation.state →
  進捗署名(stateSignature) → 報酬(computeReward) → 完結(stateEquals)` を playthrough.mjs と
  同一関数で実行。制御入力で状態値を往復させ、**状態が安定して数値取得でき**、
  **報酬が変化に反応**（変化毎 +1）・**進捗信号 `reasons=state`**・**状態ベース完結**が
  すべて反応することを実証。実 `play-loop.mjs` を `STATE_MAP=<map>` 付きで実行し、
  `observation.state` が毎ステップ実 RAM 値で populate されることも確認。

> **#12 DoD 達成 ✅**: 実 ROM で状態が安定して数値取得でき、observation 経由で
> 報酬／進捗シグナル／完結条件として参照できる。実アドレスは `<game>.local.json` に非コミット。
