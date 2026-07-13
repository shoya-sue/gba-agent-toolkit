#!/usr/bin/env node
// =============================================================
//  scripts/scan-memory.mjs ― 実ゲーム状態アドレス特定支援 (Epic #13 / #12)
//
//  ゲーム固有の HP/座標/フラグ等のアドレスを「行動前後のメモリ差分観測」で
//  絞り込むための半自動ツール。lib/state.mjs の純粋ロジック
//  （parseByteRange / diffSnapshots / narrowByComparison）を再利用する。
//
//  典型ワークフロー（例: HP アドレスの特定）:
//    1) 戦闘前など基準状態で:  node scripts/scan-memory.mjs snapshot before.json
//    2) ゲーム内でダメージを受けるなど「HP が減る」操作を手動 or agent で実行
//    3) 減少後に:              node scripts/scan-memory.mjs snapshot after.json
//    4) 減ったアドレスを抽出:  node scripts/scan-memory.mjs diff before.json after.json decreased
//    5) 候補を確認（安定読取）: node scripts/scan-memory.mjs watch 0x0200XXXX 2 8
//    → 候補が絞れたら agent/state-maps/<game>.local.json に記述子として登録する。
//
//  前提: mGBA + bridge.lua(127.0.0.1:8765) 稼働（launcher/start-session.sh）。
//  ※ アドレス・ROM タイトルは一般化 or <game>.local.json（.gitignore 済）で別管理。
// =============================================================
import { readFileSync, writeFileSync } from 'node:fs';
import { MgbaMcpClient, sleep } from '../agent/lib/mcp-client.mjs';
import { parseByteRange, parseScalar, diffSnapshots, narrowByComparison } from '../agent/lib/state.mjs';

// GBA の作業 RAM 既定領域: EWRAM 先頭から DEFAULT_LEN バイト（env で調整可）。
const DEFAULT_START = parseInt(process.env.SCAN_START || '0x02000000', 16);
const DEFAULT_LEN = parseInt(process.env.SCAN_LEN || '0x2000', 16); // 8KB（広げると遅い）
const CHUNK = Math.max(16, parseInt(process.env.SCAN_CHUNK || '128', 10));

/** 領域 [start, start+len) を CHUNK 分割で読み、{address: byteValue} を返す（バイト粒度）。 */
async function snapshotRegion(client, start, len) {
  const snap = {};
  for (let off = 0; off < len; off += CHUNK) {
    const addr = start + off;
    const n = Math.min(CHUNK, len - off);
    let bytes;
    try { bytes = parseByteRange(await client.readRange(addr, n)); }
    catch { bytes = new Uint8Array(0); }
    for (let i = 0; i < bytes.length && i < n; i++) snap[addr + i] = bytes[i];
  }
  return snap;
}

async function withClient(fn) {
  const client = new MgbaMcpClient();
  await client.connect();
  const pong = await client.ping();
  if (!/pong/i.test(pong)) {
    console.error('✗ bridge に接続できません。launcher/start-session.sh で起動してください。');
    client.close();
    process.exit(2);
  }
  try { return await fn(client); }
  finally { client.close(); await sleep(80); }
}

function loadSnap(path) {
  const obj = JSON.parse(readFileSync(path, 'utf8'));
  return obj.snapshot ?? obj; // {snapshot:{...}} でも生 {...} でも可
}

async function cmdSnapshot(outPath, startHex, lenHex) {
  const start = startHex ? parseInt(startHex, 16) : DEFAULT_START;
  const len = lenHex ? parseInt(lenHex, 16) : DEFAULT_LEN;
  await withClient(async (client) => {
    const snapshot = await snapshotRegion(client, start, len);
    writeFileSync(outPath, JSON.stringify(
      { start, len, count: Object.keys(snapshot).length, snapshot }, null, 0));
    console.log(`✓ snapshot: 0x${start.toString(16)}..+0x${len.toString(16)} ` +
      `(${Object.keys(snapshot).length} bytes) → ${outPath}`);
  });
}

function cmdDiff(fileA, fileB, relation) {
  const before = loadSnap(fileA);
  const after = loadSnap(fileB);
  const d = diffSnapshots(before, after);
  const rel = relation || 'changed';
  const list = rel === 'changed' ? d.changed
    : rel === 'increased' ? d.increased
      : rel === 'decreased' ? d.decreased
        : rel === 'unchanged' ? d.unchanged : d.changed;
  console.log(`diff ${fileA} → ${fileB}: changed=${d.changed.length} ` +
    `increased=${d.increased.length} decreased=${d.decreased.length}`);
  console.log(`── ${rel} 候補 (${list.length}) ──`);
  for (const addr of list.slice(0, 200)) {
    console.log(`  0x${Number(addr).toString(16).padStart(8, '0')}: ${before[addr]} → ${after[addr]}`);
  }
  if (list.length > 200) console.log(`  …他 ${list.length - 200} 件`);
}

// 保存済み候補リストと 2 スナップショットから、relation でさらに絞る（反復スキャン）。
function cmdNarrow(candFile, fileA, fileB, relation) {
  const cands = JSON.parse(readFileSync(candFile, 'utf8')).map(Number);
  const before = loadSnap(fileA);
  const after = loadSnap(fileB);
  const out = narrowByComparison(cands, before, after, relation || 'changed');
  console.log(`narrow: ${cands.length} → ${out.length} (${relation || 'changed'})`);
  for (const a of out) console.log(`  0x${a.toString(16).padStart(8, '0')}`);
}

async function cmdWatch(addrHex, sizeStr, countStr, delayStr) {
  const addr = parseInt(addrHex, 16);
  const size = Math.max(1, parseInt(sizeStr || '1', 10));
  const count = Math.max(1, parseInt(countStr || '8', 10));
  const delay = Math.max(50, parseInt(delayStr || '300', 10));
  await withClient(async (client) => {
    console.log(`watch 0x${addr.toString(16)} size=${size} ×${count}`);
    for (let i = 0; i < count; i++) {
      let v;
      try {
        if (size === 4) v = parseScalar(await client.read32(addr));
        else if (size === 2) v = parseScalar(await client.read16(addr));
        else v = parseScalar(await client.read8(addr));
      } catch (e) { v = `ERR ${e.message}`; }
      console.log(`  [${i}] = ${v}`);
      await sleep(delay);
    }
  });
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case 'snapshot': await cmdSnapshot(args[0] || 'snapshot.json', args[1], args[2]); break;
    case 'diff': cmdDiff(args[0], args[1], args[2]); break;
    case 'narrow': cmdNarrow(args[0], args[1], args[2], args[3]); break;
    case 'watch': await cmdWatch(args[0], args[1], args[2], args[3]); break;
    default:
      console.log(`使い方:
  node scripts/scan-memory.mjs snapshot <out.json> [startHex] [lenHex]
  node scripts/scan-memory.mjs diff <before.json> <after.json> [changed|increased|decreased|unchanged]
  node scripts/scan-memory.mjs narrow <cands.json> <before.json> <after.json> [relation]
  node scripts/scan-memory.mjs watch <addrHex> <size(1|2|4)> [count] [delayMs]
env: SCAN_START(0x02000000) SCAN_LEN(0x2000) SCAN_CHUNK(128)`);
      process.exit(cmd ? 1 : 0);
  }
}

main().catch((e) => { console.error('FATAL', e); process.exit(2); });
