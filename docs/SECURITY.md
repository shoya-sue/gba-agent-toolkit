# セキュリティ方針・スレットモデル

> gba-agent-toolkit のセキュリティ設計と、セキュリティレビュー（2026-07-10）への対応記録。

## スレットモデル（前提）

本ツールは **単一ユーザーのローカルマシン上**で、以下を前提に動作する:

- **利用主体は同一ホスト上の AI Agent**（Claude Code / Desktop / 将来ローカル LLM）。
- API サーバ（bridge.lua / mcp-mgba）は **`127.0.0.1` に固定 bind**。LAN・外部からは接続不可。
- ROM・エミュレータ・Agent はすべて**ユーザー本人の管理下**にある信頼済みプロセス。

→ 想定する主な脅威は「**意図しない外部公開**」と「**フロント/設定経由の不正入力**」。同一ホスト上の別の悪意あるプロセスは信頼境界の外（＝OS のユーザー分離・プロセス権限に委ねる）。

## 実施済みの対策

| 対策 | 内容 |
|---|---|
| **bind の localhost 固定** | `bridge.lua` が `HOST="127.0.0.1"` をハードコード。`mcp-mgba` も既定 `MGBA_HOST=127.0.0.1`。`start-session.sh`・`verify-phase1.mjs` は bind を `127.0.0.1/localhost/::1` に限定検証 |
| **Tauri CSP** | `csp: null` を廃し、`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:` を設定。フロント JS は外部ファイル化（インライン script 排除） |
| **入力検証** | port（1–65535 の整数）と bind（localhost 系のみ）を、フロント（`ui/main.js`）・シェル（`start-session.sh`）・検証スクリプト（`verify-phase1.mjs`）の各層で検証 |
| **XSS 対策** | フロントは `textContent` のみ使用（`innerHTML` 不使用） |
| **Tauri capability 最小化** | `capabilities/default.json` は `core:default` のみ。カスタムコマンド（`pick_rom`/`start_session`/`stop_session`/`load_config`/`save_config`）は `invoke_handler` 登録の 5 個に限定。ローカルフロントのみが呼び出す（外部 web コンテンツはロードしない） |
| **コマンド実行の安全性** | Rust は `Command::arg()` で引数を分離渡し（シェル展開を経由しない）。シェルは変数をダブルクォートで囲む |
| **秘密情報** | ハードコードされた鍵・トークンなし。ROM/セーブ/BIOS は `.gitignore` で除外 |

## 意図的に「制限しない」設計（レビュー指摘への回答）

セキュリティレビューで「bridge.lua の任意メモリ読取・任意パス screenshot を制限すべき」との指摘があったが、以下の理由で**制限しない**（＝設計判断）:

1. **任意メモリ読取は本ツールの中核機能**。AI Agent が GBA の任意アドレス（HP・座標・フラグ等）を読み取ることが目的そのもの（Phase 1 の 3 系統 API）。読取範囲を制限すると Agent の状態把握能力を損なう。スレットモデル上、呼び出し元（同一ホストの Agent）は信頼済み。
2. **`bridge.lua` は upstream `mcp-mgba`（MIT）の vendored コピー**であり、**改変しない方針**（導入版と diff 一致を保証し、バージョン追従を容易にするため）。パス検証等の強化は upstream への提案が筋。本リポジトリでは、**自作コードが untrusted なパスを screenshot に渡さない**（既定 `/tmp` 使用）ことで実害を回避する。

> 将来、信頼境界を「同一ホストの他プロセス」まで広げる（例: 公開 API 化）場合は、bridge 側のアドレス範囲検証・パス検証・認証トークンの導入を再検討する。

## レビュー対応サマリ（2026-07-10）
- CRITICAL（CSP null）: **修正済み**（CSP 設定＋JS 外部化）
- HIGH（bridge.lua パス/メモリ）: **文書化で対応**（vendored・信頼境界内・中核機能のため非改変。上記参照）
- HIGH（capabilities 明示）: **確認済み**（`core:default` のみ・カスタムコマンド 5 個限定）
- MEDIUM（port/bind 検証）: **修正済み**（3 層で検証）
