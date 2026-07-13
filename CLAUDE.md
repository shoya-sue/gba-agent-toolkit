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
- Epic #1 / Phase 0〜4（#2〜#6）/ 後続 #8(LLM実接続)・#9(tauri build)・#10(実ROM検証) / セッションログ #7 → **すべて close 済（2026-07-13）**
- **次期(OPEN) — 自律プレイスルー完走テスト**: **Epic #13**（現状は「起動＋操作」止まり → 自立稼働でゲームを一通りプレイして完結を保証）配下に #14 ハーネス基盤 / #15 進捗・完走判定 / #16 スタック検出・リカバリ・再トライ(self-healing 中核) / #17 E2E完走+合否レポート。判断・状態の基盤: #11(LLM判断強化)・#12(状態アドレス読取)。各 Issue に推奨 `model:*` / `effort:*` ラベル

## 現状 (2026-07-13) — ロードマップ完遂・全 issue close
全 Phase(0〜4) ＋ 後続 enhancement(#8/#9) ＋ 実 ROM 検証(#10) ＋ 品質基盤 まで完了。**OPEN issue は 0 件**。
- **Phase 0〜4 ✅**（#2〜#6, close）: 環境検証 / GBA コア API(`verify-phase1.mjs` 10/10) / Tauri ランチャー / MCP・Agent 連携 / GB・GBC(PyBoy `test_pyboy_api.py` 12/12)
- **#8 ✅**（`517328d`）ローカル LLM(ollama) ポリシー実接続（`agent/policies/llm-policy.mjs`、text/vision、`POLICY=llm` 切替。監査後ハードニング済）
- **#9 ✅**（`baf0e8d`）`tauri build` で `.app`/`.dmg` バンドル。**空白パスで Lua `require("json")` 破綻→空白なしパス（`~/.config/gba-agent-toolkit/mgba-bridge/`）へ stage** する対策
- **#10 ✅**（`22363cc`）自己所有 GBA ROM で基本 API **6/6**・自律ループ text **8/8**+vision **5/5**（画面把握を目視＋vision LLM 読取で確認）/ GB 公開ROM 12/12。ランナー `scripts/verify-phase10.sh`（拡張子で GBA/GB 自動判定・ROM 非依存プローブ）
- **品質基盤 ✅**（`9b26b3e`）`agent/policies/llm-policy.test.mjs`(node:test 21件) + GitHub Actions CI(`.github/workflows/ci.yml`、Node 構文/テスト・Python py_compile、実行成功)
- **セキュリティ ✅**: CSP 設定・入力検証(port/bind)・JS 外部化。vendored bridge.lua 非改変（信頼境界=localhost単一ユーザー）。`docs/SECURITY.md`
- 検証記録 `docs/env-verification.md` / 全体 INDEX `docs/INDEX.md`
- **運用知見**: bridge.lua は ROM ロード後のみ有効（`emu` 未定義クラッシュ回避）。`qt.ini [recentScripts]` 事前登録 + `File > Load recent script` の AX クリックで自動ロード可（画面ロック中も可）

## 機能サマリ（Agent が使える操作）
- **GBA（mGBA + mcp-mgba, `bridge.lua` TCP:8765 localhost）**: `mgba_ping` / `mgba_get_info`(frame・title) / `mgba_screenshot`(240×160 PNG) / `mgba_press_buttons` / `mgba_read_range`・`read8/16/32` / `mgba_save_state`・`load_state` / `advance_frames` / `reset`
- **GB/GBC（PyBoy + Python MCP, `mcp-server/pyboy/`）**: `pyboy_*` 10ツール（画面160×144 PNG/ndarray・8ボタン入力・メモリ read・save/load state）。GB(DMG)/GBC(CGB) 両対応・**GBA 非対応**
- **ランチャー（Tauri v2, `launcher/`）**: 「ROM選択→Start」で mGBA+ROM+bridge 自動ロード+MCP疎通を一括起動。`.app`/`.dmg` 配布（`start-session.sh`/`stop-session.sh`）
- **Agent ハーネス（`agent/`）**: `play-loop.mjs`(知覚→判断→行動) / `trial-and-error.mjs`(セーブステート分岐探索) / policies(`demo`=決定的 / `llm`=ローカル LLM ollama text/vision)。**判断関数の差し替えだけで LLM 自律プレイに拡張**（ハーネス無改造）

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
