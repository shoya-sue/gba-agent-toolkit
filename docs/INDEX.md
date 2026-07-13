# gba-agent-toolkit ドキュメント INDEX

> Phase 4 成果物（Issue [#6](https://github.com/shoya-sue/gba-agent-toolkit/issues/6)）。
> 採用リポジトリ・API エンドポイント・詰まった点・ライセンスを 1 枚に集約。

## プロジェクト概要
GBA/GB/GBC を **AI Agent が MCP 経由で自律操作**するツールキット。人間は GUI で「ROM 選択 → Start」するだけ。
設計思想・全体像は [README.md](../README.md) / リポジトリ [CLAUDE.md](../CLAUDE.md)。

## ドキュメント一覧
| ドキュメント | 内容 |
|---|---|
| [phase0-setup.md](phase0-setup.md) | mGBA × mcp-mgba 接続手順 |
| [env-verification.md](env-verification.md) | Phase 0 環境検証記録 |
| [api-reference.md](api-reference.md) | GBA コア API 仕様（3 系統＋セーブステート） |
| [phase2-launcher.md](phase2-launcher.md) | Tauri ランチャー設計・検証 |
| [agent-integration.md](agent-integration.md) | MCP/Agent 連携・接続手順 |
| [state-reading.md](state-reading.md) | 実ゲーム状態アドレス読取・報酬設計（#12） |
| [SECURITY.md](SECURITY.md) | スレットモデル・セキュリティ方針 |
| **INDEX.md**（本書） | 全体 INDEX |

## 採用リポジトリ / 技術スタック
| 領域 | 採用 | ライセンス | 備考 |
|---|---|---|---|
| GBA エミュ | [mGBA](https://github.com/mgba-emu/mgba) v0.10.5 | MPL-2.0 | Lua スクリプティング（v0.10+） |
| GBA MCP 土台 | [`dmang-dev/mcp-mgba`](https://www.npmjs.com/package/mcp-mgba) v0.3.3 | MIT | `bridge.lua`(TCP:8765) + Node MCP。`mcp-server/mgba-bridge/` に vendor |
| GB/GBC エミュ | [PyBoy](https://github.com/Baekalfen/PyBoy) v2.7.0 | LGPL-3.0-only | GB/GBC 専用・**GBA 非対応** |
| GB/GBC MCP | [`mcp` (Python SDK)](https://github.com/modelcontextprotocol/python-sdk) | MIT | `mcp-server/pyboy/` |
| スクショ | Pillow | HPND | PyBoy 経路の PNG 保存 |
| ランチャー | [Tauri](https://tauri.app/) v2 (2.11.5) | MIT/Apache-2.0 | `launcher/` |
| 検証 ROM(GBA) | [jsmolka/gba-tests](https://github.com/jsmolka/gba-tests) | MIT | 公開テスト ROM |
| 検証 ROM(GB) | [libbet.gb](https://github.com/pinobatch/libbet)（"Libbet and the Magic Floor", Damian Yerrick） | zlib | 公開 homebrew。**非コミット** |

> 比較検討した `struktured-labs/mgba-mcp` は button input 無し・正式 LICENSE ファイル無し（README 記載のみ）のため不採用。GBA は button input を持つ `mcp-mgba`(MIT) を採用。

## API エンドポイント一覧
### GBA 経路（`mcp-mgba`, TCP 127.0.0.1:8765）
`mgba_ping` / `mgba_get_info` / `mgba_screenshot` / `mgba_read8|16|32` / `mgba_read_range` /
`mgba_write8|16|32` / `mgba_write_range` / `mgba_press_buttons` / `mgba_advance_frames` /
`mgba_save_state` / `mgba_load_state` / `mgba_reset` / `mgba_pause` / `mgba_unpause`（計 19、詳細 [api-reference.md](api-reference.md)）

### GB/GBC 経路（`mcp-server/pyboy`, stdio）
`pyboy_ping` / `pyboy_load_rom` / `pyboy_get_info` / `pyboy_screenshot` / `pyboy_press_buttons` /
`pyboy_read8` / `pyboy_read_range` / `pyboy_tick` / `pyboy_save_state` / `pyboy_load_state`（計 10、詳細 [../mcp-server/pyboy/README.md](../mcp-server/pyboy/README.md)）

## 詰まった点（トラブルシュート要約）
| 事象 | 解決 |
|---|---|
| bridge.lua が GUI ロードのみ・CLI 起動不可 | `qt.ini [recentScripts]` 事前登録 + `File > Load recent script` の AX メニュークリック（**画面ロック中でも可**） |
| bridge.lua が `emu` 未定義でクラッシュ | ROM を先にロードしてから bridge をロード |
| `check-mgba.sh` が `pipefail`+`grep -q` で SIGPIPE 141 | `brew list --versions mgba` で判定 |
| macOS に `timeout` 無し | `gtimeout` or 手動 `kill` フォールバック |
| `mcp-mgba` が nvm node で PATH 不足時 exit 127 | シェル PATH に nvm bin を追加（`env node` shebang） |
| PyBoy `frame_count` が `load_state` で巻き戻らない | frame_count はラッパ側カウンタでステート対象外。save/load の検証は **WRAM 書換→復元**で行う |
| Python 3.14 で PyBoy wheel 未提供 | Python 3.13 の venv を使用 |

## 検証状況（Phase 0〜4・すべて実機実測）
| Phase | 検証 | 結果 |
|---|---|---|
| 0 | mGBA×mcp-mgba 疎通 | `ping`→`pong` / `get_info`→ライブ値 / `screenshot`→240×160 |
| 1 | GBA コア API | `verify-phase1.mjs` → **10/10 PASS** |
| 2 | ランチャー Start | `start-session.sh` コールドスタート → `RESULT: OK` / `cargo build` 成功 |
| 3 | Agent ループ | `play-loop.mjs`(6 step) / `trial-and-error.mjs`(load 巻戻り) 成立 |
| 4 | GB/GBC(PyBoy) | `test_pyboy_api.py` → **12/12 PASS**（GB/GBC 両モード）/ MCP サーバ 10 ツール疎通 |

## ROM 取り扱い方針
自己所有カートリッジから吸い出した ROM のみ使用・**配布しない**。検証には公開テスト/homebrew ROM（jsmolka/gba-tests, libbet）を使用し、いずれも**リポジトリにコミットしない**（`.gitignore` で ROM/セーブ系除外）。
