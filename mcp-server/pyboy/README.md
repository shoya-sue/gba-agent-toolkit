# mcp-server/pyboy/ ― GB/GBC 経路（PyBoy + Python MCP, Phase 4）

GBA 経路（mGBA + `mcp-mgba`, TypeScript）とは**別トラック**の GB/GBC 実装。
[PyBoy](https://github.com/Baekalfen/PyBoy)（v2.7.0, LGPL-3.0-only）を土台に、AI Agent の
3 系統（画面取得 / 入力送信 / メモリ読取）＋セーブステートを Python `mcp` SDK で MCP 化する。

関連 Issue: [#6 Phase 4](https://github.com/shoya-sue/gba-agent-toolkit/issues/6)

## 構成
```
mcp-server/pyboy/
├── pyboy_bridge.py     # PyBoy をラップする共通ロジック（screen/button/memory/save_state）
├── mcp_server.py       # Python mcp SDK で MCP(stdio) サーバ化（pyboy_* ツール群）
├── test_pyboy_api.py   # GB(DMG)/GBC(CGB) 両モードの API 検証
└── requirements.txt    # pyboy / mcp / pillow
```

## セットアップ
```bash
# PyBoy は Python 3.9〜3.13 対応（3.14 は wheel 未提供のことがある）
python3.13 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

## 検証（GB/GBC 基本 API）
```bash
.venv/bin/python test_pyboy_api.py /path/to/your.gb    # or .gbc
```
GB(DMG) と GBC(CGB) の両モードで、画面取得 / 入力送信 / メモリ読取 / セーブステートを検証。

## MCP サーバとして使う
```bash
# 単体起動（stdio）
.venv/bin/python mcp_server.py

# Claude Code に登録
claude mcp add pyboy --scope user -- /abs/path/.venv/bin/python /abs/path/mcp_server.py
```

### 提供ツール（`pyboy_*`）
`pyboy_ping` / `pyboy_load_rom(rom_path, cgb)` / `pyboy_get_info` / `pyboy_screenshot` /
`pyboy_press_buttons(buttons, delay)` / `pyboy_read8(address)` / `pyboy_read_range(address, length)` /
`pyboy_tick(count)` / `pyboy_save_state(slot)` / `pyboy_load_state(slot)`

> Agent はまず `pyboy_load_rom` で ROM をロードしてから他ツールを使う（GBA 経路の bridge.lua が
> ROM 先読みを要するのと同様）。ツール命名は GBA 側 `mgba_*` と対を成す `pyboy_*`。

## 検証記録（2026-07-10・libbet.gb で実測）
- `test_pyboy_api.py`: **12/12 PASS**（GB(DMG) 6 + GBC(CGB) 6）
  - 画面: 160×144 PNG ×3 連続 + ndarray(144,160,4)
  - 入力: a/b/up/down/left/right/start/select 全受理・フレーム進行
  - メモリ: `read_range(0x0134,15)` → "LIBBET"（`get_info` と一致）
  - セーブ: `save_state` → WRAM 書換 → `load_state` で復元（決定的検証）
- `mcp_server.py`: MCP クライアントで **10 ツール** 応答・`load_rom`/`read_range`("LIBBET")/`screenshot`(有効 PNG) を end-to-end 確認

## ライセンス / 帰属
- **PyBoy**: LGPL-3.0-only（`pip` 経由で利用。改変せず動的リンク相当の利用）
- **mcp (Python SDK)**: MIT
- **Pillow**: HPND
- 検証 ROM **libbet.gb**（"Libbet and the Magic Floor", Damian Yerrick）: **zlib License**。テスト目的で利用し**リポジトリにはコミットしない**（`.gitignore` で `*.gb` 除外）。本番は自己所有カートリッジ由来 ROM を使用。
