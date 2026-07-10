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

## 制約・今後
- **macOS 専用**（AX/osascript 依存）。Linux/Windows は bridge.lua ロード方式の別実装が必要。
- 配布バンドルでは `start-session.sh` を Tauri resources として同梱し、実行時に解決する必要がある（現状は開発実行前提で `CARGO_MANIFEST_DIR/..` から解決）。
- `tauri build`（.app/.dmg 生成）は本記録では未実施（`cargo build` によるコンパイル検証まで）。
- 初回 AX 操作には macOS の**アクセシビリティ権限**付与が必要。
