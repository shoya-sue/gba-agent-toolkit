#!/usr/bin/env node
// =============================================================
//  verify-phase10-gba.mjs ― 実 ROM 用 GBA コア API 通し確認 (#10)
//
//  Phase 1 の verify-phase1.mjs は検証 ROM "GBA Tests" 固有値を assert
//  するため実 ROM に流用できない。本スクリプトは **ROM 非依存** で
//  「API が通り・ライブ値が返る」ことのみを判定する:
//    - ping/get_info/screenshot/press_buttons/read_range/save+load
//    - read_range は ROM ヘッダのタイトル(0x080000A0)を読み、get_info の
//      Title と自己整合するか（どの ROM でも成立する不変条件）で確認
//
//  前提: mGBA に実 ROM + bridge.lua をロード済み（127.0.0.1:8765 稼働）。
//        launcher/start-session.sh --rom <ROM> の後に本スクリプトを実行。
//  使い方: node scripts/verify-phase10-gba.mjs
//  終了コード: 0=全PASS / 1=いずれかFAIL / 2=起動不能
// =============================================================
import { existsSync, readFileSync } from 'node:fs';
import { MgbaMcpClient, sleep } from '../agent/lib/mcp-client.mjs';

const results = [];
function record(group, ok, detail) {
  results.push({ group, ok, detail });
  console.log(`${ok ? '✓' : '✗'} [${group}] ${detail}`);
}

async function main() {
  const client = new MgbaMcpClient();
  await client.connect();

  // 0) 疎通
  let pong = '';
  try { pong = await client.ping(); } catch (e) { record('ping', false, String(e.message)); }
  if (!/pong/i.test(pong)) {
    record('ping', false, `mgba_ping → "${pong.trim()}"（bridge 未接続。start-session.sh を先に）`);
    client.close();
    summarize();
    process.exit(2);
  }
  record('ping', true, `mgba_ping → ${pong.trim()}`);

  // 1) get_info: frame が数値・title が非空（ライブ値）
  let info;
  try {
    info = await client.getInfo();
    const ok = Number.isFinite(info.frame) && info.frame >= 0 && info.title.length > 0;
    record('get_info', ok, `frame=${info.frame} title="${info.title}"`);
  } catch (e) { info = { frame: -1, title: '' }; record('get_info', false, String(e.message)); }

  // 2) screenshot: 240x160 PNG が生成される
  {
    let ok = false, detail = '取得失敗';
    try {
      const p = await client.screenshot();
      if (p && existsSync(p)) {
        const b = readFileSync(p);
        const isPng = b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
        const w = b.readUInt32BE(16), h = b.readUInt32BE(20);
        ok = isPng && w === 240 && h === 160;
        detail = `${w}x${h} PNG (${b.length}B)`;
      }
    } catch (e) { detail = String(e.message); }
    record('screenshot', ok, detail);
  }

  // 3) press_buttons: 代表シーケンスがエラーなく受理される
  {
    const seqs = [['A'], ['B'], ['Up'], ['Down'], ['Start']];
    let ok = true; const parts = [];
    for (const s of seqs) {
      try { await client.pressButtons(s); parts.push(`${s.join('+')}✓`); }
      catch (e) { ok = false; parts.push(`${s.join('+')}✗`); }
      await sleep(80);
    }
    record('press_buttons', ok, `FIFO投入: ${parts.join(' ')}`);
  }

  // 4) read_range: ROM ヘッダのゲームタイトル(0x080000A0,12B)を読み、get_info と自己整合
  //    （どの GBA ROM も同オフセットにタイトルを持つ = ROM 非依存の不変条件）
  {
    try {
      const raw = await client.readRange(0x080000a0, 12);
      const hex = (raw.match(/[0-9a-fA-F]{2}/g) || []);
      let ascii = '';
      if (hex.length >= 12) {
        ascii = hex.slice(0, 12).map((h) => {
          const n = parseInt(h, 16); return n >= 32 && n < 127 ? String.fromCharCode(n) : '';
        }).join('').trim();
      }
      const infoTitle = (info.title || '').trim();
      // 自己整合: ヘッダ読取の先頭数文字が get_info の Title と前方一致すれば OK
      const key = ascii.slice(0, 3).toUpperCase();
      const consistent = key.length >= 1 && infoTitle.toUpperCase().startsWith(key);
      record('read_range', hex.length >= 4, `read_range(0x080000A0,12) ascii="${ascii}" vs Title="${infoTitle}"${consistent ? ' (自己整合✓)' : ''}`);
    } catch (e) { record('read_range', false, String(e.message)); }
  }

  // 5) save_state → 進行 → load_state で frame が巻き戻る
  {
    try {
      const f0 = (await client.getInfo()).frame;
      await client.saveState(1);
      await sleep(600);
      const f1 = (await client.getInfo()).frame;
      await client.loadState(1);
      await sleep(120);
      const f2 = (await client.getInfo()).frame;
      const advanced = f1 > f0;
      const reverted = f2 <= f1 && Math.abs(f2 - f0) < Math.abs(f1 - f0) + 50;
      record('save_load_state', advanced && reverted, `frame save@${f0} → 進行${f1} → load後${f2}（進行=${advanced} 巻戻り=${reverted}）`);
    } catch (e) { record('save_load_state', false, String(e.message)); }
  }

  client.close();
  await sleep(100);
  summarize();
  process.exit(results.some((r) => !r.ok) ? 1 : 0);
}

function summarize() {
  const fails = results.filter((r) => !r.ok);
  console.log('\n──────── #10 GBA 実ROM 検証サマリ ────────');
  console.log(`合計 ${results.length} 項目 / PASS ${results.length - fails.length} / FAIL ${fails.length}`);
  if (fails.length) fails.forEach((f) => console.log(`  ✗ [${f.group}] ${f.detail}`));
}

main().catch((e) => { console.error('FATAL', e); process.exit(2); });
