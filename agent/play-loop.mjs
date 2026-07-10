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
// =============================================================
import { mkdtempSync, existsSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MgbaMcpClient, sleep } from './lib/mcp-client.mjs';
import { demoPolicy, VALID_BUTTONS } from './policies/demo-policy.mjs';

const STEPS = parseInt(process.argv[2] || '6', 10);
// 判断関数（★ここを llmPolicy に差し替えれば自律プレイ）
const policy = demoPolicy;

async function main() {
  const client = new MgbaMcpClient();
  await client.connect();

  const pong = await client.ping();
  if (!/pong/i.test(pong)) {
    console.error('✗ bridge に接続できません。launcher/start-session.sh で起動してください。');
    client.close();
    process.exit(2);
  }
  const outDir = mkdtempSync(join(tmpdir(), 'gba-agent-loop-'));
  console.log(`▶ 知覚→判断→行動 ループ開始（${STEPS} ステップ）`);
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
    const observation = { step, frame: info.frame, title: info.title, screenshotPath: savedShot };

    // 2. 判断（policy = 将来 LLM）
    const decision = policy(observation);
    const buttons = (decision.buttons || []).filter((b) => VALID_BUTTONS.includes(b));

    // 3. 行動
    if (buttons.length) await client.pressButtons(buttons);
    try { await client.advanceFrames(4); } catch { /* frameAdvance 非対応ビルドは無視 */ }
    await sleep(120);

    console.log(
      `step ${step}: frame=${info.frame} 知覚[${info.title}] ` +
      `→ 判断[${buttons.join('+') || '(なし)'}: ${decision.note}] ` +
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
