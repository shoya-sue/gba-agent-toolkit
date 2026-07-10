# Agent 連携ガイド（Phase 3: MCP / Agent 連携）

> Issue [#5 Phase 3](https://github.com/shoya-sue/gba-agent-toolkit/issues/5) の成果物。
> AI Agent が **MCP 経由で GBA を自律操作**するための接続手順とサンプルハーネス。

## 全体像

```
AI Agent（Claude Code / Desktop / 将来ローカル LLM）
   │  MCP (stdio)
mcp-mgba
   │  JSON-RPC / TCP 127.0.0.1:8765
mGBA + bridge.lua
   │
GBA ROM
```

## 1. 前提: セッション起動

まず mGBA + bridge.lua を起動しておく（Phase 2 ランチャー or スクリプト）:

```bash
./launcher/start-session.sh --rom /path/to/your.gba
# → RESULT: OK（8765 OPEN + mgba_ping → pong）
```

## 2. MCP サーバを Agent に登録

### Claude Code
```bash
claude mcp add mgba --scope user mcp-mgba
# 環境変数（既定でOK）: MGBA_HOST=127.0.0.1 / MGBA_PORT=8765
```

### Claude Desktop（`claude_desktop_config.json`）
```json
{
  "mcpServers": {
    "mgba": {
      "command": "mcp-mgba",
      "env": { "MGBA_HOST": "127.0.0.1", "MGBA_PORT": "8765" }
    }
  }
}
```

登録後、Agent からツール（`mgba_screenshot` / `mgba_press_buttons` / `mgba_read_range` / `mgba_save_state` …）が使える。ツール仕様は [docs/api-reference.md](api-reference.md)。

## 3. サンプルハーネス（`agent/`）

Claude Code の MCP 接続を使わずとも、`mcp-mgba` を直接駆動して Agent ループを再現・検証できる。

```
agent/
├── lib/mcp-client.mjs        # mcp-mgba を stdio 駆動する MCP クライアント（共有基盤）
├── policies/demo-policy.mjs  # 「判断」の実装（★LLM 差し替え点）
├── play-loop.mjs             # 知覚→判断→行動 ループ PoC
└── trial-and-error.mjs       # セーブステート試行錯誤・分岐探索
```

### 知覚→判断→行動ループ
```bash
node agent/play-loop.mjs 6      # 6 ステップ
```
各ステップで **screenshot + get_info（知覚）→ policy（判断）→ press_buttons（行動）** を実行。
- 判断は `policies/demo-policy.mjs` の `demoPolicy`（決定的なデモ）。
- **★拡張点**: `play-loop.mjs` の `const policy = demoPolicy;` を LLM ポリシーに差し替えれば自律プレイに移行できる。`observation.screenshotPath`（PNG）と `observation.info` を LLM に渡し `{buttons:[...]}` を推論させる（`llmPolicyStub` が雛形）。

### セーブステート試行錯誤
```bash
node agent/trial-and-error.mjs
```
**save_state で分岐点を固定 → 分岐 A を試す → load_state で巻き戻す → 分岐 B を試す → 比較**、という失敗時やり直し・分岐探索の基本パターンを実演。

## 4. 検証記録（2026-07-10・実機）
- **play-loop.mjs**: 6 ステップ全てで 知覚→判断→行動 が成立（frame 11009→14070、各ステップで screenshot 保存）
- **trial-and-error.mjs**: save@frame 18481 → 分岐 A（Right,Right,A）→ `load_state` で frame 18496 に**巻き戻し成功** → 分岐 B（Left,B,Start）→ 比較。試行錯誤パターン成立

→ **DoD「Agent が自 ROM で『画面認識 → 入力』ループを実行できる」を実データで達成**。

## セキュリティ
接続は `127.0.0.1` 固定・単一ホスト前提。詳細は [docs/SECURITY.md](SECURITY.md)。

## 参考
- `minpeter/pss-mgba` / `jmurth1234/ClaudePlayer`（Agent プレイの先行例）
