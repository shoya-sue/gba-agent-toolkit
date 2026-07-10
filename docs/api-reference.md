# API リファレンス（Phase 1: コア API）

> Issue [#3 Phase 1](https://github.com/shoya-sue/gba-agent-toolkit/issues/3) の成果物。
> AI Agent が GBA を操作するための **最小 API セット**。土台は [`dmang-dev/mcp-mgba`](https://www.npmjs.com/package/mcp-mgba)（MIT）。
> すべて **MCP（stdio JSON-RPC）** ツールとして提供され、Agent は `tools/call` で呼ぶ。

## 全体像

```
AI Agent ──MCP(stdio)──▶ mcp-mgba ──JSON-RPC/TCP 127.0.0.1:8765──▶ mGBA + bridge.lua ──▶ GBA ROM
  (判断・入力)              (Node)                (localhost 固定)         (Lua)
```

- **接続先は常に `127.0.0.1:8765`（localhost 固定）**。`bridge.lua` が `HOST="127.0.0.1"` をハードコードしており、外部インターフェースには bind しない（`bridge.lua:16`）。
- Agent が実際に使うのは下記 **3 系統 ＋ セーブステート**。それ以外（`pause`/`unpause` 等）はビルド依存で欠落しうる（本環境の mGBA 0.10.5 では `pause`/`unpause`/`frameAdvance` が非対応）。

## 3 系統 ＋ セーブステート

### 1. 画面取得（Agent の「目」）
| ツール | 引数 | 返り値 | 備考 |
|---|---|---|---|
| `mgba_screenshot` | なし | `Screenshot saved: <path.png>` | **240×160 8-bit RGB PNG**。連続取得可（検証で5連続安定を確認） |

Agent はこの PNG を読み、画面状態を判断する。

### 2. 入力送信（Agent の「手」）
| ツール | 引数 | 返り値 | 備考 |
|---|---|---|---|
| `mgba_press_buttons` | `buttons: string[]` | 受理応答 | ボタン名: `A` `B` `Up` `Down` `Left` `Right` `Start` `Select` `L` `R`。内部は mGBA `setKeys`。連続シーケンスを FIFO 投入可 |

### 3. メモリ読取（Agent の「内部状態把握」）
| ツール | 引数 | 返り値 | 備考 |
|---|---|---|---|
| `mgba_read_range` | `address:int, length:int` | `0xADDR [N bytes]: HH HH ...` | 範囲一括読取 |
| `mgba_read8` | `address:int` | `0xADDR: DEC (0xHEX)` | 1 バイト |
| `mgba_read16` | `address:int` | 同上 | 2 バイト（LE） |
| `mgba_read32` | `address:int` | 同上 | 4 バイト（LE） |

**アドレス空間（GBA）の主な領域**:
| 範囲 | 用途 |
|---|---|
| `0x02000000–0x0203FFFF` | EWRAM（256KB, ゲーム状態の主保管先） |
| `0x03000000–0x03007FFF` | IWRAM（32KB, 高速） |
| `0x08000000–` | ROM（カートリッジ）。`0x080000A0` から 12 バイトがゲームタイトル |

### 4. セーブステート（試行錯誤・分岐探索の土台）
| ツール | 引数 | 備考 |
|---|---|---|
| `mgba_save_state` | `slot:int` | スロットに保存 |
| `mgba_load_state` | `slot:int` | スロットから復元。Agent は「分岐前に save → 探索 → 失敗なら load」で試行錯誤できる |

## 補助ツール
`mgba_ping`（疎通, →`pong`） / `mgba_get_info`（タイトル/コード/フレーム/capabilities） / `mgba_reset` / `mgba_write8|16|32` / `mgba_write_range` / `mgba_advance_frames`（`runFrame` 系, ビルド依存）。

> ビルドが提供する capability は `mgba_get_info` の `Capabilities present:` 行で確認できる。本環境: `currentFrame, platform, saveStateFile, saveStateSlot, getGameTitle, readRange, screenshot, reset, runFrame, loadStateFile, getGameCode, step, loadStateSlot, setKeys`（欠落: `frameAdvance, unpause, pause`）。

## セキュリティ / bind ポリシー
- **bind は localhost（`127.0.0.1`）固定**。LAN/外部からは接続不可。
- mcp-mgba も既定で `MGBA_HOST=127.0.0.1` / `MGBA_PORT=8765`。上書きは環境変数だが、外部公開は非推奨（Agent とエミュは同一ホスト前提）。

## 検証（Phase 1 DoD）
`scripts/verify-phase1.mjs` が実機 bridge に対して全系統を実行し PASS/FAIL 判定する。

```bash
# 前提: mGBA に ROM + bridge.lua をロード済み（127.0.0.1:8765 稼働）
node scripts/verify-phase1.mjs
```

**2026-07-10 実測結果（10/10 PASS）**:
- 画面取得: 5 連続キャプチャ・全て 240×160 PNG
- 入力送信: `A/B/Up/Down/Start` の FIFO 投入を全受理
- メモリ読取: `read_range(0x080000A0,12)` → `47 42 41 20 54 65 73 74 73` = ASCII **"GBA Tests"**（`get_info` のタイトルと一致）。`read8/16/32` も整合（0x47='G', 0x4247="GB"(LE), 0x20414247="GBA "(LE)）
- セーブステート: frame `1159701` で save → 進行 `1159741` → load 後 `1159711`（巻き戻り確認）
- bind: `127.0.0.1` 固定
