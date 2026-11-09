# 自律プレイスルー E2E 完走テスト + 合否レポート（#17）

> Epic [#13](https://github.com/shoya-sue/gba-agent-toolkit/issues/13)（自律プレイスルー完走テスト）の総仕上げ。
> ハーネス基盤（#14）・進捗/完走判定（#15）・スタック検出リカバリ（#16）・状態読取（#12）を
> **1 コマンドで統合実行**し、「起動 → 一通りプレイ → 完結」を自立稼働で実行して **合否レポート** を出す。

## 構成
| ファイル | 役割 |
|---|---|
| `scripts/verify-playthrough.sh` | 統合ランナー。mGBA+ROM+bridge 起動 → E2E 実行 → セッション停止（失敗・中断時も停止） |
| `scripts/verify-playthrough.mjs` | シナリオ → `agent/playthrough.mjs` 実行 → `runs/<id>/report.{json,md}` 生成。`--report-only` で既存ランから再生成 |
| `agent/lib/report.mjs` | シナリオ正規化・env 変換・マイルストーン到達判定・合否判定・Markdown 整形（純粋ロジック, unit 11 件） |
| `agent/scenarios/example.json` | 完走シナリオのテンプレート。実ゲームは `agent/scenarios/<game>.local.json`（.gitignore 済） |

## 完走シナリオ定義
シナリオ JSON に「対象ゲーム・開始〜完結の想定フロー・完結条件」を書く（スキーマは `example.json` の `_schema`）。

| キー | 内容 |
|---|---|
| `game` | 対象ゲーム名（レポート表示用） |
| `flow` | 開始〜完結の想定フロー（説明用。判定には使わない） |
| `milestones` | 中間地点（定義順）。`titleContains` / `state:{field,equals}`（#12）/ `screenHashes` のいずれか。レポートの **到達点** に最遠到達を出す |
| `completion` | **完結条件**（いずれか一致で PASS）。`titleContains` / `state:"field=value"` / `screenHashes`（エンディング画面の `screenHash`）。`stateMap` の `completion` も合流 |
| `stateMap` | 状態読取 state-map のパス（#12, 任意） |
| `run` | `maxSteps` / `maxSeconds` / `policy`(`demo`\|`llm`) / `env`（`STUCK_STEPS`・`RECOVER_MAX_TOTAL` 等の追加 env） |

- 完結条件が 1 つも無いシナリオは PASS 判定が不可能なため、ランナーは **前提不足（exit 2）** で実行しない。
- コマンドラインで渡した env（例 `POLICY=demo STEPS=50`）はシナリオ値より優先される。
- エンディング画面の `screenHash` は、一度エンディングまで到達したランの `runs/<id>/steps.jsonl` から拾える。

## 前提（ローカル実機のみ・CI 対象外）
実機 mGBA / 自己所有 ROM / ローカル LLM に依存するため **CI では実行しない**（CI は `report.test.mjs` 等の純粋ロジックのみ）。
1. **mGBA GUI**: mGBA v0.10+（`/opt/homebrew/opt/mgba/mGBA.app`）＋ `mcp-mgba`（`npm install -g mcp-mgba`）。
   bridge.lua の自動ロード条件は [phase2-launcher.md](phase2-launcher.md) / [phase0-setup.md](phase0-setup.md)（`./scripts/check-mgba.sh` で環境検証）。
   実行中は mGBA ウィンドウを閉じない（リアルタイム進行。画面ロック中も可）。
2. **LLM**（`policy: "llm"` の場合）: [ollama](https://ollama.com/) 起動済み・モデル取得済み（`OLLAMA_MODEL`、vision は `OLLAMA_VISION=1`）。
   手順は [agent-integration.md](agent-integration.md)。`POLICY=demo` なら LLM 不要（ただし完走はまず不可能＝FAIL レポートの確認用）。
3. **ROM 配置**: 自己所有カートリッジから吸い出した `.gba` を `roms/` に置く（`.gitignore` 済・**配布/コミット禁止**）。
4. **シナリオ/state-map**: `agent/scenarios/example.json` を `agent/scenarios/<game>.local.json` にコピーして完結条件等を記入。
   状態ベース判定を使う場合は [state-reading.md](state-reading.md) の手順で `agent/state-maps/<game>.local.json` を作る。

## 実行
```bash
# E2E 完走テスト（起動 → 自律プレイ → 完結判定 → 合否レポート → 停止）
./scripts/verify-playthrough.sh roms/mygame.gba agent/scenarios/mygame.local.json
# 一時上書き（例: LLM モデル指定・ステップ上限）
POLICY=llm OLLAMA_MODEL=qwen2.5:7b STEPS=5000 ./scripts/verify-playthrough.sh roms/mygame.gba agent/scenarios/mygame.local.json
# 既存ランからレポートだけ再生成（Ctrl+C 中断後・ハーネス異常終了後の事後確認）
node scripts/verify-playthrough.mjs --report-only runs/e2e-<timestamp> agent/scenarios/mygame.local.json
```
終了コード: **0 = PASS（完結到達）** / **1 = FAIL**（理由・到達点はレポート） / **2 = 前提不足**（ROM・シナリオ・完結条件・mGBA 起動）。

## 合否レポート（`runs/<id>/report.md` / `report.json`）
| 項目 | 内容 |
|---|---|
| 判定 | **PASS** は `summary.completed` かつ `stopReason=completed` のときのみ。それ以外は FAIL |
| 停止理由 | `completed` / `max-steps` / `time-budget` / `interrupted` / `too-many-failures` / `stuck` / `no-summary`（finalize 前の異常終了）と説明文 |
| 到達点 | 最終ステップ・frame・title・最終状態（#12）・最後に進捗したステップ・最遠マイルストーン（到達/未到達一覧） |
| リカバリ回数 | 総数・戦略別（`alt-input`/`load-state`/`reset`/`restart-session`/`reconnect`）・give-up 有無（#16） |
| 所要 | 開始/終了時刻・経過時間 |
| スクショ / ログ | `screenshots/`（定期 + `final.png`）・`steps.jsonl`・`meta.json` のパス |

停止した場合も（上限打ち切り・切断・stuck・ハーネス異常終了）、`steps.jsonl` から到達点を復元してレポートに残す。
ROM 指定時は self-healing の最終手段 `restart-session` を有効化する（`RESTART_ROM` を自動設定）。
