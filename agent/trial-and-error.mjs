#!/usr/bin/env node
// =============================================================
//  trial-and-error.mjs ― セーブステートを使った試行錯誤・分岐探索 (Phase 3)
//
//  AI Agent が「失敗したらやり直す／複数の分岐を比較する」ための基本パターン:
//    1. save_state で分岐点を固定
//    2. 分岐 A の入力列を試す → 結果を観測（フレーム/メモリ）
//    3. load_state で分岐点に巻き戻す
//    4. 分岐 B を試す → 結果を観測
//    5. 良い方を採用（ここでは観測値を比較してレポート）
//
//  前提: mGBA + bridge.lua(127.0.0.1:8765) 稼働。
//  使い方: node agent/trial-and-error.mjs
// =============================================================
import { MgbaMcpClient, sleep } from './lib/mcp-client.mjs';

const SLOT = 3;

/** 1 つの分岐を試す: 入力列を投入し、フレーム進行後の状態を観測して返す */
async function tryBranch(client, name, buttonSeq) {
  console.log(`\n─ 分岐 ${name}: [${buttonSeq.map((b) => b.join('+')).join(', ')}] を試行`);
  for (const buttons of buttonSeq) {
    await client.pressButtons(buttons);
    try { await client.advanceFrames(6); } catch {}
    await sleep(100);
  }
  const info = await client.getInfo();
  // 観測例: ROM ヘッダ先頭 4byte を読む（実ゲームでは HP/座標等の状態アドレスを読む）
  const mem = await client.readRange(0x03000000, 4); // IWRAM 先頭
  console.log(`  観測: frame=${info.frame} / IWRAM[0x03000000,4]="${mem.trim().slice(0, 40)}"`);
  return { name, frame: info.frame, mem };
}

async function main() {
  const client = new MgbaMcpClient();
  await client.connect();
  if (!/pong/i.test(await client.ping())) {
    console.error('✗ bridge 未接続。launcher/start-session.sh で起動してください。');
    client.close();
    process.exit(2);
  }

  console.log('▶ セーブステート分岐探索サンプル');
  const base = await client.getInfo();
  console.log(`  分岐点: frame=${base.frame} を slot ${SLOT} に save_state`);
  await client.saveState(SLOT);
  await sleep(150);

  // 分岐 A
  const a = await tryBranch(client, 'A', [['Right'], ['Right'], ['A']]);

  // 分岐点に巻き戻す
  console.log(`\n─ load_state(slot ${SLOT}) で分岐点へ巻き戻し`);
  await client.loadState(SLOT);
  await sleep(200);
  const reverted = await client.getInfo();
  console.log(`  巻き戻し後: frame=${reverted.frame}（save 時 ${base.frame} 付近に復元）`);

  // 分岐 B
  const b = await tryBranch(client, 'B', [['Left'], ['B'], ['Start']]);

  // 比較・採用（デモ: フレーム進行量で選ぶ。実際は報酬/状態で評価）
  console.log('\n──────── 分岐比較 ────────');
  console.log(`  A: frame=${a.frame} / B: frame=${b.frame}`);
  const revertOk = Math.abs(reverted.frame - base.frame) < 200;
  console.log(`  load_state による巻き戻し: ${revertOk ? '成功 ✓' : '要確認'}`);
  console.log(`  → save/load で分岐点を固定し複数手を試す試行錯誤パターンが成立`);

  client.close();
  await sleep(100);
  process.exit(revertOk ? 0 : 1);
}

main().catch((e) => { console.error('FATAL', e); process.exit(2); });
