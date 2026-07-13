# agent/ ― AI Agent サンプルハーネス (Phase 3)

`screenshot → 判断 → press_buttons` のループを回し、MCP サーバ経由で GBA を自律操作する最小実装。
セーブステートを使った試行錯誤・分岐探索のサンプルも含む。

関連 Issue: [#5 Phase 3: MCP / Agent 連携](https://github.com/shoya-sue/gba-agent-toolkit/issues/5) ／ 手順: [docs/agent-integration.md](../docs/agent-integration.md)

## 構成
```
agent/
├── lib/mcp-client.mjs        # mcp-mgba を stdio 駆動する MCP クライアント（共有基盤）
├── lib/ollama-client.mjs     # ローカル LLM(ollama) の最小 HTTP クライアント
├── lib/progress.mjs          # 進捗・完走判定の純粋ロジック（#15）
├── lib/progress.test.mjs     # progress 純粋関数のユニットテスト（node:test, 21件）
├── lib/recovery.mjs          # 自己修復エスカレーション論理（#16）
├── lib/recovery.test.mjs     # recovery 純粋関数のユニットテスト（node:test, 13件）
├── policies/demo-policy.mjs      # 「判断」の決定的デモ
├── policies/llm-policy.mjs       # 「判断」のローカル LLM 実接続（★自律プレイ）
├── policies/llm-policy.test.mjs  # llm-policy 純粋関数のユニットテスト（node:test, 21件）
├── play-loop.mjs                 # 知覚→判断→行動 ループ PoC（POLICY で切替）
├── playthrough.mjs               # プレイスルー・テストハーネス基盤（長時間ループ・記録・再開・進捗/完走判定・自己修復, #14/#15/#16）
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

# プレイスルー・テストハーネス（長時間自律プレイ・記録/再開・進捗/完走判定, #14/#15）
SNAPSHOT_EVERY=25 node playthrough.mjs 500             # 最大500ステップ, 25毎にスクショ+checkpoint
POLICY=llm OLLAMA_MODEL=qwen2.5:7b node playthrough.mjs 300   # ローカル LLM で長時間自律
RESUME=1 node playthrough.mjs 500                     # 直近 checkpoint(セーブステート)から再開
# 完走条件つき（title に 'THE END' が出たら completed で正常終了）
COMPLETE_TITLE_CONTAINS="THE END" STUCK_STEPS=20 node playthrough.mjs 2000
#   記録: runs/<runId>/（meta.json=config+summary / steps.jsonl / screenshots）。Ctrl+C で安全に finalize
#   env: MAX_SECONDS / STEP_DELAY_MS(既定250) / SNAPSHOT_EVERY(既定25) / CHECKPOINT_SLOT / MAX_FAILURES
#        ADVANCE_FRAMES(既定0。実mGBAはリアルタイム進行のため frameAdvance 非対応ビルドでは呼ばない)
#   進捗/完走判定(#15): STUCK_STEPS(既定12・N無進捗でスタック信号) / STUCK_ABORT_STEPS(既定0=無効) /
#        COMPLETE_TITLE_CONTAINS / COMPLETE_STATE="flag=val"(#12連携) / COMPLETE_SCREEN_HASHES="h1,h2"
#        進捗=画面PNGハッシュ/状態/title の変化で判定（frame は常に進むので単独では進捗と見なさない）
#   自己修復(#16): RECOVER(既定1=ON,0で無効) / RECOVER_MAX_TOTAL(既定12) / FAIL_RECOVER_AFTER(既定2) /
#        RESTART_ROM=<ROM絶対パス>(指定時のみ最終手段のセッション再起動を有効化)
#        梯子: alt-input(別入力探索)→load-state(直近checkpoint復帰)→reset→restart-session。
#        詰まり(stuck)と切断/クラッシュの両方で自動発動。総上限で give-up（無限ループ防止）

# ユニットテスト（mGBA/ollama 不要・純粋関数のみ）
node --test policies/llm-policy.test.mjs              # llm-policy 正規化/JSON抽出 21件
node --test playthrough.test.mjs                     # playthrough ループ制御/サマリ 11件
node --test lib/progress.test.mjs                    # 進捗・完走判定 21件（#15）
node --test lib/recovery.test.mjs                    # 自己修復エスカレーション 13件（#16）
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

### 進捗・完走判定（#15, 2026-07-13・実機 FF ROM）
- **進捗検出**: 画面 PNG ハッシュ/title の変化で「進んだか」を判定（frame は常に進むので単独では進捗と見なさない）。12 ステップ中 4 進捗を検出。
- **スタック信号**: 画面が 4 ステップ不変で ⚠ スタック信号を発火（`STUCK_STEPS` しきい値、最大無進捗 8）。
- **完結検出**: `COMPLETE_TITLE_CONTAINS=DAWNOFS` で title 一致→ `stop=completed`・exit 0 で正常終了。不一致条件では偽陽性なし（completed=false）。
- 判定結果は `steps.jsonl`（progressed/reasons/noProgressStreak/stuck/frameFrozen/completed）と `meta.json` summary（progressSteps/stuckSignals/maxNoProgressStreak/completed）に記録。
- **状態ベース判定（HP/座標/フラグ）は #12（状態アドレス読取）連携でプラガブル**（`COMPLETE_STATE`・`observation.state`）。現状は画面/title ベースで稼働。

### 自己修復・再トライ（#16, 2026-07-13・実機 FF ROM）
- **梯子（エスカレーション）**: `alt-input`（別入力探索）→ `load-state`（直近 checkpoint 復帰）→ `reset`（ソフトリセット）→ `restart-session`（ROM 指定時のみ）。詰まり中は `STUCK_STEPS` 毎に 1 段ずつ上る。進捗が再開すると梯子はリセット。総試行 `RECOVER_MAX_TOTAL` で give-up（無限ループ防止）。
- **2 トリガ**: (1) スタック（#15 の無進捗信号）、(2) 連続失敗（bridge 切断/クラッシュ→ ping で死活確認→ mcp-mgba 再接続、ダメなら `RESTART_ROM` 指定時にセッション再起動）。
- **実機検証**: 詰まり検出→ `alt-input`('B') で **進捗が再開**（stuck 解消、19/24 進捗）。発動は `steps.jsonl`（`recovery`）と `meta.json`（`recoveries`/`recoveryByStrategy`/`recoveryGiveUp`）に記録。escalation 順序・上限・give-up は unit 13 件で検証。`load-state`/`reset` は Phase 1 検証済プリミティブ、`restart-session` は launcher スクリプト経由（ROM 必須・opt-in）。

## 参考実装
- [`minpeter/pss-mgba`](https://github.com/minpeter/pss-mgba)（Pokemon 自律ハーネス, TS）
- [`jmurth1234/ClaudePlayer`](https://github.com/jmurth1234/ClaudePlayer)（Claude + PyBoy, MIT）
