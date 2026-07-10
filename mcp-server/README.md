# mcp-server

AI Agent がゲームを操作するための **MCP サーバ** 層。

- **GBA 経路**: [`dmang-dev/mcp-mgba`](https://github.com/dmang-dev/mcp-mgba)（TypeScript, MIT）を土台に、`bridge.lua`(TCP:8765) 経由で mGBA と通信。
- **GB/GBC 経路**（Phase 4）: [PyBoy](https://github.com/Baekalfen/PyBoy) + Python `mcp` で別トラック実装。

提供予定ツール（mcp-mgba ベース）: `screenshot` / `press_buttons` / `advance_frames` / `read_range` / `write_range` / `save_state` / `load_state` / `pause` / `unpause` / `reset` / `get_info` / `ping`。

関連 Issue: [#3 Phase 1](https://github.com/shoya-sue/gba-agent-toolkit/issues/3) / [#5 Phase 3](https://github.com/shoya-sue/gba-agent-toolkit/issues/5) / [#6 Phase 4](https://github.com/shoya-sue/gba-agent-toolkit/issues/6)
