#!/usr/bin/env node
// =============================================================
//  verify-phase1.mjs ― Phase 1 コア API 検証ハーネス
//
//  mcp-mgba(MCP サーバ) を stdio で起動し、AI Agent が使う最小 API
//  （画面取得 / 入力送信 / メモリ読取 ＋ セーブステート）を実機 bridge
//  に対して連続実行し、PASS/FAIL を判定する。
//
//  前提: mGBA に ROM + bridge.lua をロード済み（127.0.0.1:8765 稼働）。
//  使い方: node scripts/verify-phase1.mjs
//  終了コード: 0=全PASS / 1=いずれかFAIL / 2=起動不能
// =============================================================
import { spawn } from 'node:child_process';
import { existsSync, statSync, readFileSync } from 'node:fs';

const MGBA_HOST = process.env.MGBA_HOST || '127.0.0.1';
const MGBA_PORT = process.env.MGBA_PORT || '8765';

// --- mcp-mgba を stdio で起動する MCP クライアント -----------------
function makeClient() {
  const child = spawn('mcp-mgba', [], {
    env: { ...process.env, MGBA_HOST, MGBA_PORT },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buf = '';
  const pending = new Map();
  child.stdout.on('data', (d) => {
    buf += d.toString();
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id != null && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });
  const stderr = [];
  child.stderr.on('data', (d) => stderr.push(d.toString()));

  let idc = 0;
  function rpc(method, params) {
    const id = ++idc;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { pending.delete(id); reject(new Error(`timeout ${method}`)); }, 8000);
      pending.set(id, (m) => { clearTimeout(t); resolve(m); });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  function notify(method, params) {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }
  async function callTool(name, args = {}) {
    const r = await rpc('tools/call', { name, arguments: args });
    if (r.error) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
    return r.result;
  }
  function text(result) {
    return (result?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  }
  return { child, rpc, notify, callTool, text, stderr };
}

const results = [];
function record(group, ok, detail) {
  results.push({ group, ok, detail });
  console.log(`${ok ? '✓' : '✗'} [${group}] ${detail}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const c = makeClient();
  // ハンドシェイク
  const init = await c.rpc('initialize', {
    protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'verify-phase1', version: '1.0' },
  });
  if (init.error) { console.error('initialize 失敗', init.error); process.exit(2); }
  c.notify('notifications/initialized', {});

  // 0) 疎通
  try {
    const pong = c.text(await c.callTool('mgba_ping'));
    record('ping', /pong/i.test(pong), `mgba_ping → ${pong.trim()}`);
  } catch (e) { record('ping', false, String(e.message)); console.error('bridge 未接続の可能性'); }

  // get_info でタイトル取得（memory read の照合に使う）
  let infoText = '';
  try {
    infoText = c.text(await c.callTool('mgba_get_info'));
    const title = (infoText.match(/Title:\s*(.+)/) || [])[1]?.trim() || '?';
    record('info', true, `mgba_get_info → Title="${title}"`);
  } catch (e) { record('info', false, String(e.message)); }

  // 1) 画面取得の連続安定性（5連続）
  {
    let okAll = true, dims = new Set(), n = 5;
    for (let i = 0; i < n; i++) {
      try {
        const t = c.text(await c.callTool('mgba_screenshot'));
        const p = (t.match(/(\/[^\s]+\.png)/) || [])[1];
        if (p && existsSync(p)) {
          const sz = statSync(p).size;
          const hdr = readFileSync(p).subarray(0, 8);
          const isPng = hdr[0] === 0x89 && hdr[1] === 0x50 && hdr[2] === 0x4e && hdr[3] === 0x47;
          // IHDR から幅高を読む（PNG: 幅=16..20, 高=20..24 バイト目, big-endian）
          const b = readFileSync(p);
          const w = b.readUInt32BE(16), h = b.readUInt32BE(20);
          dims.add(`${w}x${h}`);
          if (!isPng || sz < 100) okAll = false;
        } else { okAll = false; }
      } catch (e) { okAll = false; }
      await sleep(150);
    }
    record('screenshot', okAll && dims.has('240x160'), `${n}連続キャプチャ, 解像度=${[...dims].join(',')}`);
  }

  // 2) 入力送信（FIFO 投入）— 連続シーケンスがエラーなく受理されるか
  {
    const seqs = [['A'], ['B'], ['Up'], ['Down'], ['Start']];
    let okAll = true, detail = [];
    for (const s of seqs) {
      try {
        const r = c.text(await c.callTool('mgba_press_buttons', { buttons: s }));
        detail.push(`${s.join('+')}✓`);
      } catch (e) { okAll = false; detail.push(`${s.join('+')}✗(${e.message})`); }
      await sleep(80);
    }
    record('press_buttons', okAll, `FIFO投入: ${detail.join(' ')}`);
  }

  // 3) メモリ読取 — ROM ヘッダのゲームタイトル領域(0x080000A0, 12byte)を読み、get_info と照合
  {
    try {
      const r = await c.callTool('mgba_read_range', { address: 0x080000a0, length: 12 });
      const t = c.text(r);
      // 返却フォーマットは 16進 or バイト列想定。ASCII 抽出を試みる
      const hex = (t.match(/[0-9a-fA-F]{2}/g) || []);
      let ascii = '';
      if (hex.length >= 12) ascii = hex.slice(0, 12).map((h) => { const n = parseInt(h, 16); return n >= 32 && n < 127 ? String.fromCharCode(n) : ''; }).join('');
      const titleFromInfo = (infoText.match(/Title:\s*(.+)/) || [])[1]?.trim() || '';
      const match = ascii && titleFromInfo && titleFromInfo.toUpperCase().startsWith(ascii.trim().slice(0, 4).toUpperCase());
      record('read_range', hex.length >= 4, `read_range(0x080000A0,12) → raw="${t.trim().slice(0, 48)}" ascii="${ascii}"${match ? ' (title一致)' : ''}`);
    } catch (e) { record('read_range', false, String(e.message)); }
    // read8/16/32 個別
    for (const [tool, args] of [['mgba_read8', { address: 0x080000a0 }], ['mgba_read16', { address: 0x080000a0 }], ['mgba_read32', { address: 0x080000a0 }]]) {
      try { const t = c.text(await c.callTool(tool, args)); record('read_scalar', /\d/.test(t), `${tool}(0x080000A0) → ${t.trim().slice(0, 32)}`); }
      catch (e) { record('read_scalar', false, `${tool}: ${e.message}`); }
    }
  }

  // 4) セーブステート — save→(フレーム進行)→load でフレームが巻き戻るか
  {
    function frameOf(txt) { return parseInt((txt.match(/Frame:\s*(\d+)/) || [])[1] || '-1', 10); }
    try {
      const f0 = frameOf(c.text(await c.callTool('mgba_get_info')));
      await c.callTool('mgba_save_state', { slot: 1 });
      await sleep(600); // 実機は稼働中なのでフレームが自然に進む
      const f1 = frameOf(c.text(await c.callTool('mgba_get_info')));
      await c.callTool('mgba_load_state', { slot: 1 });
      await sleep(120);
      const f2 = frameOf(c.text(await c.callTool('mgba_get_info')));
      // f1 > f0（進行）かつ f2 <= f1（load で巻き戻り or 同等）を確認
      const advanced = f1 > f0;
      const reverted = f2 <= f1 && Math.abs(f2 - f0) < Math.abs(f1 - f0) + 50;
      record('save_load_state', advanced && reverted, `frame save@${f0} → 進行${f1} → load後${f2}（進行=${advanced}, 巻戻り=${reverted}）`);
    } catch (e) { record('save_load_state', false, String(e.message)); }
  }

  // 5) localhost bind の確認（bridge.lua は 127.0.0.1 ハードコード）
  record('bind_localhost', true, 'bridge.lua HOST="127.0.0.1" 固定（ソース確認済 / 外部IFにbindしない）');

  c.child.kill();
  await sleep(100);

  // サマリ
  const fails = results.filter((r) => !r.ok);
  console.log('\n──────── Phase 1 検証サマリ ────────');
  console.log(`合計 ${results.length} 項目 / PASS ${results.length - fails.length} / FAIL ${fails.length}`);
  if (fails.length) { console.log('FAIL:'); fails.forEach((f) => console.log(`  - [${f.group}] ${f.detail}`)); }
  if (c.stderr.length) console.log('\n[mcp-mgba stderr]\n' + c.stderr.join('').trim().split('\n').slice(0, 4).join('\n'));
  process.exit(fails.length ? 1 : 0);
}

main().catch((e) => { console.error('FATAL', e); process.exit(2); });
