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
- **Phase 0 進行中**: mGBA v0.10.5 導入・Lua有効確認済 / mcp-mgba 導入・bridge.lua vendor済 / セットアップ手順書 `docs/phase0-setup.md`
- 残: 実機GUIで自ROMロード → bridge.lua ロード → `mgba_ping`/`get_info`/`screenshot`（`docs/env-verification.md` の DoD 参照）

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
