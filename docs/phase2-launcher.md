# Phase 2: ランチャー GUI (Tauri v2) 設計・検証記録

> Issue [#4 Phase 2](https://github.com/shoya-sue/gba-agent-toolkit/issues/4) の成果物。
> 目的: 人間の初期セットアップを **「ROM 選択 → Start」1 ボタン**に集約する（既存 OSS に無い自作レイヤー）。

## アーキテクチャ

```
┌─────────────────────────────────────────────┐
│  Tauri v2 App (launcher/)                    │
│  ┌──────────────┐   invoke   ┌────────────┐  │
│  │ ui/index.html│ ─────────▶ │ src/main.rs│  │
│  │ (ROM/Start)  │            │ (commands) │  │
│  └──────────────┘            └─────┬──────┘  │
└────────────────────────────────────┼─────────┘
                                     │ bash
                          ┌──────────▼───────────┐
                          │ start-session.sh     │  ← Start オーケストレーション中核
                          │  1. qt.ini 登録       │
                          │  2. mGBA+ROM 起動     │
                          │  3. AX で bridge ロード│
                          │  4. 8765 ポーリング    │
                          │  5. mcp-mgba ping     │
                          └──────────┬───────────┘
                                     ▼
                       mGBA + bridge.lua (127.0.0.1:8765)
                                     ▼
                       AI Agent の MCP クライアントが接続
```

**設計判断**: Start の実処理を **シェルスクリプト (`start-session.sh`) に分離**し、Rust コマンドはその実行・結果パース・設定永続化のみを担う。これにより:
- GUI 無しでもオーケストレーションを単体実行・CI 検証できる
- Phase 0 で確立した「qt.ini `[recentScripts]` + AX メニュークリック」を再利用できる

## Rust コマンド (`src-tauri/src/main.rs`)
| コマンド | 役割 |
|---|---|
| `pick_rom` | macOS ネイティブのファイル選択（`osascript` "choose file"・プラグイン不要） |
| `start_session(rom, port, bind)` | `start-session.sh` を実行し `RESULT: OK/ERROR` を判定 |
| `stop_session` | `stop-session.sh`（mGBA 終了） |
| `load_config` / `save_config` | `~/.config/gba-agent-toolkit/launcher.json` に永続化 |

## 検証記録（2026-07-10）

### 1. Start オーケストレーションのコールドスタート実機検証 ✅
```
$ ./launcher/stop-session.sh          → RESULT: OK / 8765 closed
$ ./launcher/start-session.sh --rom <ROM>
[start-session] qt.ini に bridge.lua を登録
[start-session] mGBA 起動 + ROM ロード
[start-session] Tools > Scripting… を開く
[start-session] File > Load recent script → bridge.lua をクリック
[start-session] port 127.0.0.1:8765 OPEN ✓
[start-session] mgba_ping → pong ✓
RESULT: OK   (EXIT=0)
```
→ **DoD「Start 一発で mGBA + bridge.lua + MCP が起動し Agent から接続可能」を実データで達成**。

### 2. Tauri v2 アプリのコンパイル検証 ✅
```
$ cargo build   → Finished dev profile in 50.07s（tauri 2.11.5, エラーなし）
$ ls target/debug/gba-agent-launcher   → 23MB 実行可能バイナリ
```

## 配布ビルド（.app / .dmg・Issue #9）

### resources 同梱
`tauri.conf.json` の `bundle.resources`（マップ形式）で、スクリプトと bridge を `.app/Contents/Resources/` に同梱する:
```json
"resources": {
  "../start-session.sh":  "scripts/start-session.sh",
  "../stop-session.sh":   "scripts/stop-session.sh",
  "../../mcp-server/mgba-bridge/bridge.lua": "mgba-bridge/bridge.lua",
  "../../mcp-server/mgba-bridge/json.lua":   "mgba-bridge/json.lua"
}
```
Rust 側 `resolve_resource()` が、実行時に **バンドル Resources**（配布時）→ **`CARGO_MANIFEST_DIR/..`**（開発時）の順で解決する。

### アイコン・ビルド
```bash
cd launcher && npm install
npx tauri icon /path/to/1024.png        # icon.icns / icon.ico / png 一式を生成
npx tauri build                          # target/release/bundle/ に .app と .dmg
```

### ⚠️ 空白パス問題と staging（重要な発見）
`.app` のパス（`.../GBA Agent Launcher.app/...`）には**空白が含まれ**、mGBA の Lua が
`bridge.lua` 内の `require("json")` を解決する際に**ロードが破綻**する（空白なしパスなら成功と実証）。

**対策**: Rust `start_session` が起動時に、同梱 `bridge.lua`＋`json.lua` を**空白を含まない**
`~/.config/gba-agent-toolkit/mgba-bridge/` へ複製（`stage_bridge()`）し、その複製パスを
`--bridge` で渡す。`bridge.lua` と `json.lua` は必ず同居させる（`require("json")` が同フォルダ前提）。

### 検証記録（2026-07-10）
- `npx tauri build` → **`.app`(8.2MB) と `.dmg`(2.7MB) を生成**（tauri 2.11.5, release）
- `.app/Contents/Resources/` に `scripts/{start,stop}-session.sh` + `mgba-bridge/{bridge,json}.lua` を同梱確認
- **配布形態の疎通**: 同梱スクリプトを、staging 先（空白なし）の bridge で実行 → `port 8765 OPEN` → `mgba_ping`→`pong` → `RESULT: OK`（＝修正後 Rust が取る経路を再現し成立）

## 制約・今後
- **macOS 専用**（AX/osascript 依存）。Linux/Windows は bridge.lua ロード方式の別実装が必要。
- 署名 / notarization は未実施（配布時は Gatekeeper 対策として要検討。別 issue 候補）。
- GUI ウィンドウの実クリック通し（`.app` ダブルクリック→Start）は画面ロック等の制約で本記録では未実施。オーケストレーション中核と配布形態の疎通は上記で実証済み。
- 初回 AX 操作には macOS の**アクセシビリティ権限**付与が必要。
