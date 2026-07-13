# agent/ ― AI Agent サンプルハーネス (Phase 3)

`screenshot → 判断 → press_buttons` のループを回し、MCP サーバ経由で GBA を自律操作する最小実装。
セーブステートを使った試行錯誤・分岐探索のサンプルも含む。

関連 Issue: [#5 Phase 3: MCP / Agent 連携](https://github.com/shoya-sue/gba-agent-toolkit/issues/5) ／ 手順: [docs/agent-integration.md](../docs/agent-integration.md)

## 構成
```
agent/
├── lib/mcp-client.mjs        # mcp-mgba を stdio 駆動する MCP クライアント（共有基盤）
├── lib/ollama-client.mjs     # ローカル LLM(ollama) の最小 HTTP クライアント
├── policies/demo-policy.mjs      # 「判断」の決定的デモ
├── policies/llm-policy.mjs       # 「判断」のローカル LLM 実接続（★自律プレイ）
├── policies/llm-policy.test.mjs  # llm-policy 純粋関数のユニットテスト（node:test, 21件）
├── play-loop.mjs                 # 知覚→判断→行動 ループ PoC（POLICY で切替）
├── playthrough.mjs               # プレイスルー・テストハーネス基盤（長時間ループ・記録・再開, #14）
├── playthrough.test.mjs          # playthrough 純粋ヘルパーのユニットテスト（node:test, 11件）
└── trial-and-error.mjs           # セーブステート試行錯誤・分岐探索
```

## 使い方
```bash
# 前提: mGBA + bridge.lua 稼働（../launcher/start-session.sh --rom <ROM>）
node play-loop.mjs 6                                   # 決定的デモで 6 ステップ
POLICY=llm OLLAMA_MODEL=qwen2.5:7b node play-loop.mjs 20   # ローカル LLM(text) 自律 20 ステップ
POLICY=llm OLLAMA_MODEL=moondream OLLAMA_VISION=1 node play-loop.mjs 20  # vision LLM(画面添付)
node trial-and-error.mjs                              # save→分岐A→load→分岐B の試行錯誤

# プレイスルー・テストハーネス（長時間自律プレイ・記録/再開, #14）
SNAPSHOT_EVERY=25 node playthrough.mjs 500             # 最大500ステップ, 25毎にスクショ+checkpoint
POLICY=llm OLLAMA_MODEL=qwen2.5:7b node playthrough.mjs 300   # ローカル LLM で長時間自律
RESUME=1 node playthrough.mjs 500                     # 直近 checkpoint(セーブステート)から再開
#   記録: runs/<runId>/（meta.json=config+summary / steps.jsonl / screenshots）。Ctrl+C で安全に finalize
#   env: MAX_SECONDS / STEP_DELAY_MS(既定250) / SNAPSHOT_EVERY(既定25) / CHECKPOINT_SLOT / MAX_FAILURES
#        ADVANCE_FRAMES(既定0。実mGBAはリアルタイム進行のため frameAdvance 非対応ビルドでは呼ばない)

# ユニットテスト（mGBA/ollama 不要・純粋関数のみ）
node --test policies/llm-policy.test.mjs              # llm-policy 正規化/JSON抽出 21件
node --test playthrough.test.mjs                     # playthrough ループ制御/サマリ 11件
```

## ローカル LLM 自律プレイ（Issue #8）
`policies/llm-policy.mjs` が [ollama](https://ollama.com/) のローカル LLM に observation を渡し、
次に押すボタンを JSON 推論する。`VALID_BUTTONS` への正規化・不正値フィルタ・リトライ・安全 fallback 付き。
- `POLICY=llm` で有効化。`OLLAMA_MODEL` でモデル、`OLLAMA_VISION=1` で画面 PNG 添付（vision モデル）。
- 別バックエンドも `(observation)=>{buttons,note}` を実装して `play-loop.mjs` の `policy` に渡すだけ（ハーネス無改造）。
- 手順詳細: [../docs/agent-integration.md](../docs/agent-integration.md)

## 検証（2026-07-10・実機）
- `play-loop.mjs`(demo): 6 ステップ全てで 知覚→判断→行動 成立（frame 11009→14070）
- `trial-and-error.mjs`: save@18481 → 分岐A → `load_state`→18496 巻戻り成功 → 分岐B → 比較
- **LLM(text, qwen2.5:7b)**: 20 ステップ自律走行、全ステップ LLM がボタン決定（Down×18/Start×2、frame→36872）
- **LLM(vision, moondream + 画面PNG)**: 5 ステップ走行、画面添付で判断（無効出力は安全 fallback で処理）

## 参考実装
- [`minpeter/pss-mgba`](https://github.com/minpeter/pss-mgba)（Pokemon 自律ハーネス, TS）
- [`jmurth1234/ClaudePlayer`](https://github.com/jmurth1234/ClaudePlayer)（Claude + PyBoy, MIT）
