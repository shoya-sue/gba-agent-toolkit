# agent

AI Agent のサンプルハーネス（Phase 3, PoC）。

`screenshot → 判断 → press_buttons` のループを回し、MCP サーバ経由で GBA/GB を自律プレイする最小実装を置く。セーブステートを使った試行錯誤・分岐探索のサンプルもここに。

参考実装:
- [`minpeter/pss-mgba`](https://github.com/minpeter/pss-mgba)（Pokemon 自律ハーネス, TS）
- [`jmurth1234/ClaudePlayer`](https://github.com/jmurth1234/ClaudePlayer)（Claude + PyBoy, MIT）

関連 Issue: [#5 Phase 3: MCP / Agent 連携](https://github.com/shoya-sue/gba-agent-toolkit/issues/5)
