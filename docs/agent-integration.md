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
├── lib/ollama-client.mjs     # ローカル LLM(ollama) の最小 HTTP クライアント
├── policies/demo-policy.mjs  # 「判断」の決定的デモ
├── policies/llm-policy.mjs   # 「判断」のローカル LLM 実接続（★自律プレイ）
├── play-loop.mjs             # 知覚→判断→行動 ループ PoC（policy 切替可）
└── trial-and-error.mjs       # セーブステート試行錯誤・分岐探索
```

### 知覚→判断→行動ループ
```bash
node agent/play-loop.mjs 6      # 6 ステップ
```
各ステップで **screenshot + get_info（知覚）→ policy（判断）→ press_buttons（行動）** を実行。
判断は環境変数 `POLICY` で切替:
- `POLICY=demo`（既定）: `policies/demo-policy.mjs` の決定的デモ
- `POLICY=llm`: `policies/llm-policy.mjs` の**ローカル LLM 自律プレイ**

### ローカル LLM 自律プレイ（`POLICY=llm`・Issue #8）
[ollama](https://ollama.com/) のローカル LLM に observation を渡し、次に押すボタンを JSON で推論させる。

```bash
# 前提: ollama 起動済み（既定 http://127.0.0.1:11434）
# text モデル（状態テキストで判断）
POLICY=llm OLLAMA_MODEL=qwen2.5:7b node agent/play-loop.mjs 20

# vision モデル（画面 PNG を添付して判断）
ollama pull moondream            # or llama3.2-vision / qwen2.5vl
POLICY=llm OLLAMA_MODEL=moondream OLLAMA_VISION=1 node agent/play-loop.mjs 20
```

| 環境変数 | 意味 | 既定 |
|---|---|---|
| `POLICY` | `demo` / `llm` | `demo` |
| `OLLAMA_MODEL` | ollama モデル名 | `qwen2.5:7b` |
| `OLLAMA_VISION` | `1` で screenshot(PNG) を添付 | 無効 |
| `OLLAMA_HOST` | ollama エンドポイント | `http://127.0.0.1:11434` |

**仕組み**（`llm-policy.mjs`）: プロンプトに有効ボタン一覧＋現在状態（＋vision 時は画面 PNG）を与え、`format:json` で `{"buttons":["A"],"reason":"..."}` を推論 → **`VALID_BUTTONS` への正規化（大小文字/別名吸収）・不正値フィルタ・最大リトライ**を経てボタン確定。有効ボタンが得られない場合は安全側（何も押さない）。

> 別のバックエンドに差し替える場合も、`createLlmPolicy` 相当の `(observation)=>{buttons,note}` を実装して `play-loop.mjs` の `policy` に渡すだけ。ハーネス本体は無改造。

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
