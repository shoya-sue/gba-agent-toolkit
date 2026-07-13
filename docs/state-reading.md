# 実ゲーム状態アドレス読取と報酬設計 (#12)

> Epic [#13](https://github.com/shoya-sue/gba-agent-toolkit/issues/13)（自律プレイスルー完走テスト）の依存基盤。
> 「今どういう状態か（HP/座標/フラグ）」を数値で読み、**進捗・報酬シグナル**として
> 判断（[#11](https://github.com/shoya-sue/gba-agent-toolkit/issues/11) LLM 判断強化）と
> 完走判定（[#15](https://github.com/shoya-sue/gba-agent-toolkit/issues/15)）へ供給する。

## 設計方針
- **ゲーム固有の RAM マップは ROM 依存** → アドレス・報酬・完結条件を **データ(JSON state-map)** に外出し。
  コードはゲーム非依存に保つ。実アドレス／ROM タイトルは一般化 or `agent/state-maps/<game>.local.json`
  （`.gitignore` 済）で**別管理**し、リポジトリには一般化テンプレート
  [`agent/state-maps/example.json`](../agent/state-maps/example.json) のみコミットする。
- メモリ読取の副作用は `readState()` のみに閉じ込め、パース／署名／報酬／差分は
  **純粋・決定的**（`agent/lib/state.mjs`）にしてユニットテストで担保（40 ケース）。
- read8/16/32・read_range の返り値テキストは mcp-mgba のフォーマットに厳密依存しないよう
  頑健にパース（16進/10進/バイト列）。

## 構成
| ファイル | 役割 |
|---|---|
| `agent/lib/state.mjs` | 純粋ロジック（パーサ／記述子解釈／状態署名／報酬計算／メモリ差分）＋ `readState`（唯一の副作用） |
| `agent/lib/state.test.mjs` | 上記の回帰テスト（node:test・40 ケース） |
| `agent/state-maps/example.json` | state-map の一般化テンプレート（スキーマ説明つき） |
| `scripts/scan-memory.mjs` | アドレス特定支援（行動前後のメモリ差分観測） |
| `agent/playthrough.mjs` / `agent/play-loop.mjs` | `STATE_MAP` 指定時に状態を読み `observation.state` に載せる（後方互換フック） |

## state-map スキーマ
```jsonc
{
  "game": "識別名",
  "descriptors": [                       // 読取フィールド
    { "name": "hp", "address": "0x0200XXXX", "size": 2, "endian": "le" },
    { "name": "flag", "address": "0x0200YYYY", "size": 1, "mask": 1 },
    { "name": "name", "address": "0x0200ZZZZ", "bytes": 6, "encoding": "ascii" }
  ],
  "reward": [                            // 前後状態の差分 → 報酬
    { "field": "hp",   "mode": "delta",    "weight": 1 },
    { "field": "flag", "mode": "flag",     "weight": 10 }
  ],
  "signatureKeys": ["hp", "flag"],       // 進捗署名に使うキー（省略=全フィールド）
  "completion": [ { "field": "flag", "equals": 1 } ]  // 一致で完走
}
```
- **size**: 1/2/4（`read8/16/32`）。`bytes`+`encoding:"ascii"` で文字列（`read_range`）。
- **signed / endian(le|be) / mask / scale / offset** で生値を補正。
- **報酬 mode**: `delta`（差分そのもの）/ `increase`（増加のみ）/ `decrease`（減少の絶対値）/
  `change`（変化で1）/ `flag`（0→非0 の立ち上がりで1）。`weight` で重み付け。

## 使い方
```bash
# 状態を読みながら自律ループ（play-loop / playthrough 共通で STATE_MAP を指定）
STATE_MAP=agent/state-maps/dawn-of-souls.local.json node agent/play-loop.mjs 20
STATE_MAP=agent/state-maps/dawn-of-souls.local.json node agent/playthrough.mjs 200
```
- 指定時のみメモリを読む。未指定なら従来通り状態なし（`observation.state = null`）。
- `playthrough.mjs` は各ステップの `state` / `reward` を `runs/<id>/steps.jsonl` に、
  合算（`totalReward` / `rewardSteps` / `lastState` / `stateFields`）を `meta.json` summary に記録。
- 状態変化は画面ハッシュに加えて**進捗信号**にもなる（`signatureKeys` で対象を限定可）。
- `completion` は完走判定（[#15](https://github.com/shoya-sue/gba-agent-toolkit/issues/15) の `stateEquals`）に合流。

## アドレス特定ワークフロー（メモリ差分観測）
GBA 作業 RAM: **EWRAM 0x02000000–0x0203FFFF** / **IWRAM 0x03000000–0x03007FFF**。
`scripts/scan-memory.mjs` で「変化した値」を前後スナップショット差分から絞り込む古典手法:

```bash
# 例: メニューカーソルや HP など「操作で確実に変わる値」を特定する
node scripts/scan-memory.mjs snapshot before.snapshot.json    # 基準状態
#  → ゲーム内で対象を変化させる操作（カーソル移動・被ダメージ 等）
node scripts/scan-memory.mjs snapshot after.snapshot.json     # 変化後
node scripts/scan-memory.mjs diff before.snapshot.json after.snapshot.json decreased
#  → 候補アドレスを watch で安定確認
node scripts/scan-memory.mjs watch 0x0200XXXX 2 8
#  → 絞れたら <game>.local.json の descriptors に登録
```
- `*.snapshot.json` は `.gitignore` 済（中間生成物）。
- 反復絞り込み（`narrow`）で候補を段階的に減らせる（増えた→減った→不変 の連続適用）。

## 検証
- **純粋ロジック**: `node --test agent/lib/state.test.mjs` → 40/40 pass。
  全体 `git ls-files '*.test.mjs' | xargs node --test`（+state）→ 106/106 pass。
- **実 ROM ライブ**: mGBA 起動（`launcher/start-session.sh --rom <ROM>`）→
  `scan-memory` でアドレス特定 → `STATE_MAP` 指定でループ実行し `observation.state` に
  数値が安定して載り、`reward` が状態変化に反応することを確認する。
  （実アドレスは `<game>.local.json` に保存し非コミット。）
