# 🎮 gba-agent-toolkit

**ゲームボーイアドバンス（GBA）/ ゲームボーイ（GB/GBC）のゲームを、AI Agent が自律操作するためのツールキット。**

人間は GUI で「ROM 選択 → Start」するだけ。以降の **画面認識・状況判断・入力送信はすべて API/MCP 経由で AI Agent（将来的にローカル LLM）が行う** ことを前提に設計しています。

> ⚠️ **ROM の取り扱いについて**
> 本ツールは **自己所有カートリッジから自分で吸い出した ROM のみ** を対象とします。**ROM は同梱・配布しません**。ROM ファイル・セーブデータは `.gitignore` で除外済みです。

---

## 設計思想

- 利用主体は人間ではなく **AI Agent**。
- GUI は人間による **初期セットアップのみ** を担う。
- 各機能は「人間が遊ぶための機能」ではなく「**Agent が画面を見て・状況を読み取り・入力を送るためのインターフェース**」として設計する。

## アーキテクチャ（想定）

```
AI Agent (Claude Code / 将来ローカル LLM)
   │  MCP (JSON-RPC over stdio)
   ▼
MCP Server ─┬─ GBA:    dmang-dev/mcp-mgba (TypeScript, MIT)
   ▲        │            └ bridge.lua (TCP:8765) ── mGBA ── ROM
   │        └─ GB/GBC: PyBoy + Python mcp (別トラック)
   │
Tauri ランチャー: 「ROM 選択 → Start」で上記を一括起動（sidecar）
```

## 技術スタック

| 領域 | 採用 | 備考 |
|---|---|---|
| GBA エミュ | **mGBA v0.10+**（MPL-2.0, Lua 有効） | メモリ/入力/スクショ/セーブステート |
| GBA MCP 土台 | **`dmang-dev/mcp-mgba`**（TypeScript, MIT, npm） | bridge.lua(TCP:8765) + Node MCP サーバ |
| GB/GBC エミュ | **PyBoy v2.7.0**（PyPI, GB/GBC 専用・GBA 非対応） | Phase 4 で別トラック統合 |
| ランチャー | **Tauri v2**（Apache-2.0, sidecar） | ROM 選択→Start の 1 ボタン起動 |
| Agent 連携 | **MCP**（TS `@modelcontextprotocol/sdk` / Python `mcp`） | ローカル LLM/Claude がツールを叩く標準 |

## ロードマップ

進捗は GitHub Issues で管理しています → **[Epic #1: ロードマップ](../../issues/1)**

| Phase | 内容 | Milestone | Issue | 状態 |
|---|---|---|---|---|
| 0 | 環境検証・接続確認 | M1 | [#2](../../issues/2) | ✅ 完了（2026-07-10） |
| 1 | コア API 3 系統＋セーブステート | M2 | [#3](../../issues/3) | ✅ 完了（2026-07-10） |
| 2 | ランチャー GUI (Tauri) | M3 | [#4](../../issues/4) | ✅ 完了（2026-07-10） |
| 3 | MCP / Agent 連携 | M4 | [#5](../../issues/5) | ✅ 完了（2026-07-10） |
| 4 | GB/GBC 対応・公開 | M5 | [#6](../../issues/6) | ⏭ 次 |

> **Phase 0 完了**: mGBA v0.10.5 + `mcp-mgba` v0.3.3（vendored `bridge.lua`）で実機疎通を確認。`mgba_ping`→`pong` / `mgba_get_info`→ライブ値 / `mgba_screenshot`→240×160 PNG。詳細は [docs/env-verification.md](docs/env-verification.md)。
>
> **Phase 1 完了**: コア API 3 系統（画面取得・入力送信・メモリ読取）＋セーブステートを実機検証（`scripts/verify-phase1.mjs` → **10/10 PASS**）。API 仕様は [docs/api-reference.md](docs/api-reference.md)。bind は `127.0.0.1` 固定。
>
> **Phase 2 完了**: Tauri v2 ランチャー（`launcher/`）。「ROM 選択 → Start」で mGBA + bridge.lua + MCP を一括起動。オーケストレーション `start-session.sh` をコールドスタート実機検証（`RESULT: OK`）、Tauri アプリは `cargo build` 成功。詳細は [docs/phase2-launcher.md](docs/phase2-launcher.md)。
>
> **Phase 3 完了**: MCP/Agent 連携。`agent/` に「知覚→判断→行動」ループ PoC（`play-loop.mjs`）とセーブステート試行錯誤サンプル（`trial-and-error.mjs`）を実装・実機検証。判断関数を差し替えるだけでローカル LLM 自律プレイに拡張可能。接続手順は [docs/agent-integration.md](docs/agent-integration.md)。セキュリティ方針は [docs/SECURITY.md](docs/SECURITY.md)。

各 Issue には推奨 Claude Code モデル（`model:opus` / `model:sonnet`）と effort（`effort:high` / `effort:medium`）ラベルが付与されています。

## ディレクトリ構成

```
gba-agent-toolkit/
├── launcher/      # Tauri ランチャー GUI（Phase 2）
├── mcp-server/    # MCP サーバ（GBA=mcp-mgba 連携 / GB/GBC=PyBoy, Phase 1・3・4）
├── agent/         # AI Agent サンプルハーネス（Phase 3）
├── scripts/       # 環境検証・補助スクリプト
└── docs/          # ドキュメント・ロードマップ
```

## セットアップ（Phase 0）

```bash
# mGBA 環境の検証（存在・バージョン・Lua 有効性の手掛かり）
./scripts/check-mgba.sh
```

詳細は [docs/env-verification.md](docs/env-verification.md) を参照。

## ライセンス

[MIT](LICENSE) © 2026 shoya-sue

流用元: mGBA (MPL-2.0) / dmang-dev/mcp-mgba (MIT) / PyBoy (要確認) / Tauri (Apache-2.0)
