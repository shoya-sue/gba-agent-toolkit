# agent/ ― AI Agent サンプルハーネス (Phase 3)

`screenshot → 判断 → press_buttons` のループを回し、MCP サーバ経由で GBA を自律操作する最小実装。
セーブステートを使った試行錯誤・分岐探索のサンプルも含む。

関連 Issue: [#5 Phase 3: MCP / Agent 連携](https://github.com/shoya-sue/gba-agent-toolkit/issues/5) ／ 手順: [docs/agent-integration.md](../docs/agent-integration.md)

## 構成
```
agent/
├── lib/mcp-client.mjs        # mcp-mgba を stdio 駆動する MCP クライアント（共有基盤）
├── policies/demo-policy.mjs  # 「判断」の実装（★将来 LLM に差し替える拡張点）
├── play-loop.mjs             # 知覚→判断→行動 ループ PoC
└── trial-and-error.mjs       # セーブステート試行錯誤・分岐探索
```

## 使い方
```bash
# 前提: mGBA + bridge.lua 稼働（../launcher/start-session.sh --rom <ROM>）
node play-loop.mjs 6         # 知覚→判断→行動 を 6 ステップ
node trial-and-error.mjs     # save→分岐A→load→分岐B の試行錯誤
```

## ローカル LLM への拡張
`play-loop.mjs` の `const policy = demoPolicy;` を LLM ポリシーに差し替えるだけ。
`observation.screenshotPath`(PNG) と `observation.info` を LLM に渡し `{buttons:[...]}` を推論させる（`policies/demo-policy.mjs` の `llmPolicyStub` が雛形）。ハーネス本体は無改造で自律プレイに移行できる。

## 検証（2026-07-10・実機）
- `play-loop.mjs`: 6 ステップ全てで 知覚→判断→行動 成立（frame 11009→14070）
- `trial-and-error.mjs`: save@18481 → 分岐A → `load_state`→18496 巻戻り成功 → 分岐B → 比較

## 参考実装
- [`minpeter/pss-mgba`](https://github.com/minpeter/pss-mgba)（Pokemon 自律ハーネス, TS）
- [`jmurth1234/ClaudePlayer`](https://github.com/jmurth1234/ClaudePlayer)（Claude + PyBoy, MIT）
