# gba-agent-toolkit

## Overview
GBA/GB/GBC ゲームを **AI Agent（将来ローカル LLM）が自律操作** するツールキット。人間は GUI で「ROM 選択 → Start」するだけ。画面認識・判断・入力は API/MCP 経由で Agent が行う。

## Tech Stack
- **GBA エミュ**: mGBA v0.10+（MPL-2.0, Lua scripting）
- **GBA MCP 土台**: `dmang-dev/mcp-mgba`（TypeScript, MIT, npm）— `bridge.lua`(TCP:8765) + Node MCP サーバ
- **GB/GBC**: PyBoy v2.7.0（Phase 4, GB/GBC 専用・GBA 非対応）
- **ランチャー**: Tauri v2（sidecar）
- **Agent 連携**: MCP（TS `@modelcontextprotocol/sdk` / Python `mcp`）

## Project Structure
```
launcher/       # Tauri ランチャー GUI (Phase 2)
mcp-server/     # MCP サーバ層
  mgba-bridge/  # vendored bridge.lua/json.lua (mcp-mgba MIT)
agent/          # AI Agent サンプルハーネス (Phase 3)
scripts/        # 環境検証 (check-mgba.sh 等)
docs/           # ロードマップ・手順書・検証記録
```

## Roadmap (GitHub Issues)
- Epic #1 / Phase 0 #2 / Phase 1 #3 / Phase 2 #4 / Phase 3 #5 / Phase 4 #6
- 各 Issue に推奨 `model:*` / `effort:*` ラベル

## 現状 (2026-07-10)
- **Phase 0 完了 ✅**: mGBA v0.10.5（Lua有効）+ mcp-mgba v0.3.3（bridge.lua vendor済）で**実機疎通を確認**。`mgba_ping`→`pong` / `mgba_get_info`→ライブ値（`Title: GBA Tests / Frame: 26197`）/ `mgba_screenshot`→240×160 RGB PNG。`./scripts/test-connection.sh`→`✓ PASS`（検証記録 `docs/env-verification.md`）
- **Phase 1 完了 ✅**: コア API 3 系統（画面取得・入力送信・メモリ読取）＋セーブステートを実機検証。`scripts/verify-phase1.mjs`→**10/10 PASS**（メモリ読取で ROM タイトル "GBA Tests" を実読取・save/load でフレーム巻戻り確認）。API 仕様書 `docs/api-reference.md`。bind は `127.0.0.1` 固定
- **Phase 2 完了 ✅**: Tauri v2 ランチャー `launcher/`（`start-session.sh` オーケストレーション + Rust コマンド + `ui/index.html`）。「ROM選択→Start」で mGBA+ROM+bridge.lua 自動ロード+MCP疎通を一括実行。コールドスタート実機検証 `RESULT: OK`、`cargo build` 成功（tauri 2.11.5）。仕様 `docs/phase2-launcher.md`
- **Phase 3 完了 ✅**: MCP/Agent 連携。`agent/`（`lib/mcp-client.mjs` + `policies/demo-policy.mjs` + `play-loop.mjs` + `trial-and-error.mjs`）。知覚→判断→行動ループと セーブステート試行錯誤を実機検証（play-loop 6ステップ / trial-and-error で load 巻戻り成功）。判断関数の差し替えでローカル LLM 自律プレイに拡張可。手順 `docs/agent-integration.md`
- **セキュリティ**: レビュー実施→ CSP 設定・入力検証(port/bind)・JS 外部化を修正。vendored bridge.lua は非改変（信頼境界=localhost単一ユーザー、任意メモリ読取は中核機能）。方針は `docs/SECURITY.md`
- **次: Phase 4 (#6)** — GB/GBC(PyBoy) 対応・公開ドキュメント整備
- bridge.lua ロードは GUI 必須だが、`qt.ini [recentScripts]` 事前登録 + `File > Load recent script` の AX クリックで自動化可（画面ロック中も可）。Phase 2 の自動ロードはこの方式を採用。手順は `docs/phase0-setup.md`

## ROM 方針
自己所有カートリッジから吸い出した ROM のみ使用・**配布しない**（`.gitignore` で ROM/セーブ除外）。

## Commands
```bash
./scripts/check-mgba.sh          # mGBA 環境検証
npm install -g mcp-mgba          # MCP サーバ導入
mcp-mgba                         # MCP サーバ起動 (stdio, TCP:8765)
claude mcp add mgba --scope user mcp-mgba
```

## Conventions
- Commits: Conventional Commits（`feat:`/`fix:`/`docs:`/`chore:`）
- ROM/セーブ/BIOS は絶対にコミットしない
