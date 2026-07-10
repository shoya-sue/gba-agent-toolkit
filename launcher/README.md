# launcher

**Tauri v2** 製のランチャー GUI（Phase 2）。

人間による初期セットアップを **1 ボタン化** する唯一のレイヤー。「ROM 選択 → Start」を押すと、裏で以下を統合起動する:

1. mGBA 起動
2. `bridge.lua` 自動ロード
3. MCP サーバ起動

外部バイナリ(mGBA)は Tauri の **sidecar** 方式で起動。設定（ROM パス / ポート / bind アドレス）を永続化する。

関連 Issue: [#4 Phase 2: ランチャー GUI (Tauri)](https://github.com/shoya-sue/gba-agent-toolkit/issues/4)
