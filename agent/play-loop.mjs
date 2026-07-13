#!/usr/bin/env node
// =============================================================
//  play-loop.mjs ― 知覚→判断→行動 ループのサンプルハーネス (Phase 3 PoC)
//
//  AI Agent が GBA を自律操作する最小ループの雛形:
//    1. 知覚(perceive): screenshot + get_info（＋任意でメモリ読取）
//    2. 判断(decide)  : policy(observation) → 押すボタン（★LLM 差し替え点）
//    3. 行動(act)     : press_buttons → フレーム進行
//  を N ステップ繰り返す。judgment を demo-policy から差し替えるだけで
//  ローカル LLM 自律プレイに拡張できる構造。
//
//  前提: mGBA + bridge.lua(127.0.0.1:8765) 稼働（launcher/start-session.sh）。
//  使い方: node agent/play-loop.mjs [steps]
//    env: STATE_MAP=<path> 指定時は state-map(JSON) に従い HP/座標/フラグ を
//         読み、observation.state に載せる（#12・未指定なら状態なし＝従来通り）。
// =============================================================
import { mkdtempSync, existsSync, copyFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MgbaMcpClient, sleep } from './lib/mcp-client.mjs';
import { demoPolicy, VALID_BUTTONS } from './policies/demo-policy.mjs';
import { createLlmPolicy } from './policies/llm-policy.mjs';
import { ollamaHasModel } from './lib/ollama-client.mjs';
import { readState, parseStateMap } from './lib/state.mjs';

const STEPS = parseInt(process.argv[2] || '6', 10);
// 判断関数の選択:
//   POLICY=demo（既定）… 決定的デモ
//   POLICY=llm         … ローカル LLM(ollama)。OLLAMA_MODEL でモデル指定、
//                        OLLAMA_VISION=1 で画面 PNG を添付（vision モデル向け）
const POLICY = process.env.POLICY || 'demo';
const policy =
  POLICY === 'llm'
    ? createLlmPolicy({ vision: process.env.OLLAMA_VISION === '1' })
    : demoPolicy;

// 実ゲーム状態読取 (#12): STATE_MAP 指定時のみ HP/座標/フラグ を observation.state に載せる。
let stateMap = null;
if (process.env.STATE_MAP) {
  try { stateMap = parseStateMap(readFileSync(process.env.STATE_MAP, 'utf8')); }
  catch (e) { console.warn(`⚠ state-map 読込失敗（${process.env.STATE_MAP}）: ${e.message}`); }
}
const stateEnabled = !!(stateMap && stateMap.descriptors.length);

async function main() {
  const client = new MgbaMcpClient();
  await client.connect();

  const pong = await client.ping();
  if (!/pong/i.test(pong)) {
    console.error('✗ bridge に接続できません。launcher/start-session.sh で起動してください。');
    client.close();
    process.exit(2);
  }
  // POLICY=llm のときは ollama とモデルの存在を先に確認（毎ステップ失敗の空振り回避）
  if (POLICY === 'llm') {
    const mdl = process.env.OLLAMA_MODEL || 'qwen2.5:7b';
    if (!(await ollamaHasModel(mdl))) {
      console.error(
        `✗ ollama にモデル "${mdl}" が見つかりません（${process.env.OLLAMA_HOST || 'http://127.0.0.1:11434'}）。\n` +
        `  ollama 起動と \`ollama pull ${mdl}\` を確認してください。`
      );
      client.close();
      process.exit(2);
    }
  }
  const outDir = mkdtempSync(join(tmpdir(), 'gba-agent-loop-'));
  const policyLabel = POLICY === 'llm'
    ? `LLM(ollama ${process.env.OLLAMA_MODEL || 'qwen2.5:7b'}${process.env.OLLAMA_VISION === '1' ? ', vision' : ''})`
    : 'demo';
  console.log(`▶ 知覚→判断→行動 ループ開始（${STEPS} ステップ, policy=${policyLabel}）`);
  console.log(`  スクリーンショット保存先: ${outDir}\n`);

  for (let step = 0; step < STEPS; step++) {
    // 1. 知覚
    const info = await client.getInfo();
    const shot = await client.screenshot();
    let savedShot = null;
    if (shot && existsSync(shot)) {
      savedShot = join(outDir, `step${String(step).padStart(2, '0')}.png`);
      copyFileSync(shot, savedShot);
    }
    // 実ゲーム状態読取 (#12): state-map 指定時のみメモリを読む（未指定は null）。
    let gameState = null;
    if (stateEnabled) {
      try { gameState = await readState(client, stateMap.descriptors); }
      catch { gameState = null; }
    }
    const observation = { step, frame: info.frame, title: info.title, screenshotPath: savedShot, state: gameState };

    // 2. 判断（policy = デモ or ローカル LLM）
    const decision = await policy(observation);
    // policy が不正形（null / buttons 非配列）を返しても落とさず「何も押さない」に丸める
    const buttons = Array.isArray(decision?.buttons)
      ? decision.buttons.filter((b) => VALID_BUTTONS.includes(b))
      : [];
    const note = decision?.note ?? '';

    // 3. 行動
    if (buttons.length) await client.pressButtons(buttons);
    try { await client.advanceFrames(4); } catch { /* frameAdvance 非対応ビルドは無視 */ }
    await sleep(120);

    console.log(
      `step ${step}: frame=${info.frame} 知覚[${info.title}` +
      `${gameState ? ` | ${JSON.stringify(gameState)}` : ''}] ` +
      `→ 判断[${buttons.join('+') || '(なし)'}: ${note}] ` +
      `→ 行動✓ ${savedShot ? '📷' : ''}`
    );
  }

  console.log(`\n✓ ループ完了。全ステップで 知覚→判断→行動 が成立。`);
  console.log(`  screenshots: ${outDir}`);
  client.close();
  await sleep(100);
  process.exit(0);
}

main().catch((e) => { console.error('FATAL', e); process.exit(2); });
