# Phase 0 セットアップ手順書（mGBA × mcp-mgba 接続）

> Issue [#2 Phase 0](https://github.com/shoya-sue/gba-agent-toolkit/issues/2) の実接続手順。
> 検証土台に **`dmang-dev/mcp-mgba`**（TypeScript, MIT）を採用。

## 構成

```
Claude Code / Desktop
   │  MCP (stdio)
mcp-mgba (Node, `mcp-mgba` npm)
   │  newline-delimited JSON-RPC over TCP 127.0.0.1:8765
mGBA + bridge.lua (Tools > Scripting でロード)
   │
GBA ROM（自己所有カートリッジから吸い出したもの）
```

## 手順

### 1. mGBA 導入（Lua スクリプティング必須 = v0.10+）
```bash
brew install mgba
mgba-qt --version   # 0.10 以上であること（Lua有効の目安）
```
- 確実なLua確認: mGBA GUI を起動 → メニューに **`Tools > Scripting…`** が存在するか。
- 無ければ Lua 無効ビルド → ソースからの再ビルドを検討（Phase 0 TODO 11）。

### 2. mcp-mgba 導入
```bash
npm install -g mcp-mgba
mcp-mgba --help    # 導入確認（stdio MCPサーバ）
```

### 3. mGBA で bridge.lua をロード（**GUI操作・CLI起動オプションは無い**）
1. mGBA(mgba-qt) を起動
2. **先に GBA ROM を読み込む**（ROMが無いと `emu` グローバル未定義でクラッシュ）
3. `Tools > Scripting…` を開く
4. `File > Load script` で **`bridge.lua`** を選択
5. Scripting Console に次が出れば成功:
   ```
   [mcp-mgba] bridge listening on 127.0.0.1:8765
   [mcp-mgba] frame callback registered — bridge is active
   ```

> `bridge.lua` の入手: `mcp-mgba` パッケージ同梱（`npm root -g`/`mcp-mgba`配下の `lua/bridge.lua`）、または本リポジトリ `mcp-server/` に配置予定。

### 4. Claude Code に MCP 登録
```bash
claude mcp add mgba --scope user mcp-mgba
```
環境変数（既定でOK）: `MGBA_HOST=127.0.0.1` / `MGBA_PORT=8765`

### 5. 接続テスト（DoD）
Claude Code から順に呼ぶ:
- `mgba_ping` → `pong` が返れば接続成立
- `mgba_get_info` → ROMタイトル/コード/フレーム数
- `mgba_screenshot` → 画面キャプチャ（PNG）

3つが自ROMで通れば **Phase 0 完了**。

## 提供ツール（mcp-mgba）
`mgba_ping` / `mgba_get_info` / `mgba_read8|16|32` / `mgba_write8|16|32` / `mgba_read_range` / `mgba_write_range` / `mgba_press_buttons` / `mgba_advance_frames` / `mgba_pause` / `mgba_unpause` / `mgba_reset` / `mgba_screenshot` / `mgba_save_state` / `mgba_load_state`

## ライセンス
- mGBA: MPL-2.0 ／ mcp-mgba: **MIT** ／ mgba-mcp（比較対象）: README記載のみ（正式LICENSEファイルなし）
