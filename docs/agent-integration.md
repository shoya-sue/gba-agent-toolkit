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
├── lib/prompt.mjs            # 判断プロンプト・観測整形（状態要約/行動候補/履歴/先読み, #11）
├── policies/demo-policy.mjs  # 「判断」の決定的デモ
├── policies/llm-policy.mjs   # 「判断」のローカル LLM 実接続（★自律プレイ）
├── policies/claude-policy.mjs # 「判断」の Claude API(vision) 接続（#11）
├── policies/select.mjs       # POLICY=demo|llm|claude の選択（play-loop/playthrough 共通）
├── play-loop.mjs             # 知覚→判断→行動 ループ PoC（policy 切替可）
├── eval-policies.mjs         # 判断ポリシーの同一シーン比較評価（#11）
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
- `POLICY=claude`: `policies/claude-policy.mjs` の **Claude API（vision）判断**（#11）

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

### 判断の強化（Issue #11）: プロンプト改善 / Claude 接続 / 比較評価

#### プロンプト・観測整形の改善（`lib/prompt.mjs`、`llm` / `claude` 共通）
#8 の素朴なプロンプト（ボタン一覧＋frame/title）を以下で強化した。インターフェース `(observation)=>{buttons,note}` は不変・ハーネス無改造。
- **状態要約**: `observation.state`（#12 の HP/座標/フラグ, `STATE_MAP` 指定時）を `hp=12, map=3, x=5` の 1 行で提示
- **行動候補**: 各ボタンの一般的な意味（A=決定/会話送り、B=キャンセル、Start=メニュー/タイトル送り…）を列挙
- **直近履歴と効果**: 直前 6 ステップの行動と「その後に画面/状態が変わったか」（画面 PNG ハッシュ比較）を提示。直近が空振り続きなら「同じ操作を繰り返すな」と警告 → 素朴判断の典型的失敗（効かないボタンの連打）を抑止
- **先読み**: 次の数ステップの `plan` を出させ、その先頭を実行（`{"scene","plan","buttons","reason"}`）。vision 時はまずシーン種別（title/menu/dialogue/field/battle）とカーソル位置を把握させる
- note に `scene=` / `plan=` を付記してログ（`steps.jsonl`）から判断過程を追える

| 環境変数 | 意味 | 既定 |
|---|---|---|
| `AGENT_LOOKAHEAD` | 先読み plan のステップ数（0 で無効＝従来の単発 JSON） | `3`（最大 8） |
| `AGENT_GOAL` | ゲーム固有の目標（例 `"start a new game and reach the field"`） | なし |

#### Claude API（vision）接続（`POLICY=claude`）
画面 PNG（＋状態要約・履歴）を Claude に渡して次のボタンを決める。世界知識・画面理解が強く、軽量ローカルモデルの「画面は読めるが判断が素朴」を補う。

```bash
# 1) SDK 導入（agent/ 配下・初回のみ。他ポリシーやユニットテストには不要）
cd agent && npm install && cd ..
# 2) 認証: ANTHROPIC_API_KEY を環境に設定（または `ant auth login` のプロファイル）。キーはコミットしない
# 3) 実行（mGBA + bridge 稼働中）
POLICY=claude node agent/play-loop.mjs 20
POLICY=claude CLAUDE_EFFORT=low AGENT_GOAL="start a new game" node agent/playthrough.mjs 300
```

| 環境変数 | 意味 | 既定 |
|---|---|---|
| `CLAUDE_MODEL` | モデル ID（例 `claude-sonnet-5-5` / `claude-haiku-5-5` で低コスト化） | `claude-opus-5-5` |
| `CLAUDE_VISION` | `0` で画面を送らず text のみ（ベースライン比較用） | `1`（画面添付） |
| `CLAUDE_EFFORT` | `low`/`medium`/`high`/`xhigh`/`max`（思考の深さ＝1 ステップの遅延/コスト） | `medium` |
| `CLAUDE_FALLBACKS` | `0` で安全分類器 refusal 時のサーバ側フォールバック（`fallbacks:"default"`）を無効化 | 有効 |

- 起動前に `models.retrieve` で疎通確認（失敗時は exit 2。毎ステップ空振りしない）
- 不正 JSON はリトライ、認証/権限/不正リクエストは即「何も押さない」、`stop_reason=refusal` も安全側（何も押さない）
- **送信データ**: 画面 PNG（240×160）と状態テキストのみ。ROM・セーブは送らない。ただし画面は外部 API（Anthropic）へ送信されるため、気になる場合は `POLICY=llm`（ローカル完結）を使う
- 1 ステップ 1 リクエスト。長時間 `playthrough` はステップ数×料金になるので `STEP_DELAY_MS`・`CLAUDE_MODEL`・`CLAUDE_EFFORT` で調整する

#### vision モデル / 判断ポリシーの比較評価（`eval-policies.mjs`）
**同一シーン（セーブステート）から**各ポリシーを N ステップずつ走らせ、同じ物差しで進行度を比較する。

```bash
# 現在の画面を slot 9 に保存して全ポリシー共通の開始点にする（EVAL_FROM_SLOT=n で既存 slot を使用）
EVAL_POLICIES="demo,llm@qwen2.5:7b,llm@moondream+vision,llm@llama3.2-vision+vision,llm@qwen2.5vl+vision,claude+text,claude" \
EVAL_REPEATS=2 node agent/eval-policies.mjs 20
# → 進行度順の Markdown 表を出力し、runs/eval-<ts>/report.json と各ステップ JSONL を保存
```
- 仕様: `kind[@model][+vision|+text]`（kind = `demo`/`llm`/`claude`。`claude` は既定で vision）。疎通できないポリシーはスキップ
- 指標: **画面数**（訪れた相異なる画面 = 進行の幅・主指標）/ **進捗 step**（操作が効いた回数）/ **最長無進捗**（空振り・詰まりの深さ）/ reward（`STATE_MAP` の報酬合計, #12）/ 無操作・エラー数 / 平均判断時間
- 順位: reward → 画面数 → 進捗 step の降順（同点は最長無進捗の昇順）
- 推奨シーン: ①タイトル→ニューゲーム（メニュー操作）②会話送り ③フィールド移動（`STATE_MAP` で座標/マップ ID を読むと reward で進行を測れる）
- 候補 vision モデル（ollama）: `moondream`（軽量・#10 で使用）/ `llama3.2-vision`（11B）/ `qwen2.5vl`（7B）。text ベースライン: `qwen2.5:7b`

> 実 ROM での評価結果（表）はこの節に追記する。

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
