# launcher/ ― GBA Agent ランチャー (Tauri v2, Phase 2)

人間による初期セットアップを **「ROM 選択 → Start」の 1 ボタン**に集約する Tauri v2 アプリ。
Start 一発で **mGBA 起動 → ROM ロード → bridge.lua 自動ロード → MCP 疎通確認** までを実行する。

関連 Issue: [#4 Phase 2: ランチャー GUI (Tauri)](https://github.com/shoya-sue/gba-agent-toolkit/issues/4)

## 構成

```
launcher/
├── start-session.sh    # ★ Start オーケストレーション中核（GUI 無しでも単体実行・検証可能）
├── stop-session.sh     # セッション停止（mGBA 終了）
├── ui/index.html       # フロントエンド（ROM選択 / Port / Bind / Start / Stop / 状態表示）
├── package.json        # tauri dev/build 用（@tauri-apps/cli）
└── src-tauri/          # Tauri v2 バックエンド（Rust）
    ├── Cargo.toml
    ├── tauri.conf.json
    ├── build.rs
    ├── capabilities/default.json
    ├── icons/
    └── src/main.rs     # コマンド: pick_rom / start_session / stop_session / load_config / save_config
```

## Start の仕組み（Phase 0 知見の応用）

bridge.lua は mGBA GUI でしかロードできず CLI 起動オプションも無い。そこで:

1. `~/.config/mgba/qt.ini` の `[recentScripts]` に bridge.lua の絶対パスを**冪等登録**
2. mGBA を ROM 付きで起動（`open -a mGBA.app <ROM>`）
3. `Tools > Scripting…` → `File > Load recent script` を **AppleScript(AX) でメニュークリック**
   （ファイルダイアログを経由しないため画面ロック中でも成功）
4. `127.0.0.1:<port>` の OPEN をポーリング
5. `mcp-mgba` で `mgba_ping` → `pong` を確認

この一連を `start-session.sh` が実装し、Rust の `start_session` コマンドが `bash start-session.sh` を実行して `RESULT: OK`/`ERROR` をパースする。

## 使い方

### スクリプト単体（GUI 無し・検証用）
```bash
./start-session.sh --rom /path/to/your.gba          # Start 一発
./stop-session.sh                                    # 停止
# オプション: --port 8765 --bind 127.0.0.1 --bridge <bridge.lua> --mgba <mGBA.app>
```

### Tauri アプリ
```bash
npm install && npm run dev        # 開発起動（要 @tauri-apps/cli）
npm run build                     # 配布ビルド
cargo build --manifest-path src-tauri/Cargo.toml   # Rust 側のみコンパイル確認
```

## 設定の永続化
`~/.config/gba-agent-toolkit/launcher.json` に ROM パス / Port / Bind を保存。次回起動時に復元。

## 検証状況（Phase 2 DoD）
- ✅ `start-session.sh` をコールドスタートで実機検証: mGBA 停止 → Start → `RESULT: OK`（8765 OPEN + `mgba_ping`→`pong`）
- ✅ Tauri v2 アプリが `cargo build` 成功（`tauri 2.11.5`）
- 詳細は [docs/phase2-launcher.md](../docs/phase2-launcher.md)

## 既知の制約
- **macOS 専用**（AX 自動化 = System Events、`osascript`）。他 OS は bridge.lua ロード方式の別実装が必要。
- 実行時に `start-session.sh` を `CARGO_MANIFEST_DIR/..` から解決するため、配布バンドルでは Tauri resources 同梱が必要（今後の改善点）。
- 初回の AX 操作には **アクセシビリティ権限**（システム設定 > プライバシーとセキュリティ > アクセシビリティ）が必要。
