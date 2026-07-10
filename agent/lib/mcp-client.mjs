// =============================================================
//  mcp-client.mjs ― mcp-mgba を stdio で駆動する軽量 MCP クライアント
//
//  AI Agent サンプルハーネスの共有基盤。mcp-mgba(MCP サーバ) を子プロセス
//  として起動し、tools/call をラップした高レベル API を提供する。
//  実際のツール群は mGBA + bridge.lua(127.0.0.1:8765) に中継される。
// =============================================================
import { spawn } from 'node:child_process';

export class MgbaMcpClient {
  constructor({ host = '127.0.0.1', port = '8765', command = 'mcp-mgba' } = {}) {
    this.host = host;
    this.port = String(port);
    this.command = command;
    this.child = null;
    this._buf = '';
    this._pending = new Map();
    this._idc = 0;
    this.stderr = [];
  }

  async connect() {
    this.child = spawn(this.command, [], {
      env: { ...process.env, MGBA_HOST: this.host, MGBA_PORT: this.port },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdout.on('data', (d) => this._onData(d));
    this.child.stderr.on('data', (d) => this.stderr.push(d.toString()));
    this.child.on('error', (e) => {
      for (const [, rej] of this._pending.values()) rej(e);
    });
    await this._rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'gba-agent-harness', version: '1.0' },
    });
    this._notify('notifications/initialized', {});
    return this;
  }

  _onData(d) {
    this._buf += d.toString();
    let nl;
    while ((nl = this._buf.indexOf('\n')) >= 0) {
      const line = this._buf.slice(0, nl).trim();
      this._buf = this._buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id != null && this._pending.has(msg.id)) {
        const { resolve } = this._pending.get(msg.id);
        this._pending.delete(msg.id);
        resolve(msg);
      }
    }
  }

  _rpc(method, params) {
    const id = ++this._idc;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`RPC timeout: ${method}`));
      }, 10000);
      this._pending.set(id, {
        resolve: (m) => { clearTimeout(t); resolve(m); },
        reject: (e) => { clearTimeout(t); reject(e); },
      });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  _notify(method, params) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  async _call(name, args = {}) {
    const r = await this._rpc('tools/call', { name, arguments: args });
    if (r.error) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
    return (r.result?.content || [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n');
  }

  // ── 高レベル API（3 系統 ＋ セーブステート） ──────────────────
  ping() { return this._call('mgba_ping'); }

  async getInfo() {
    const text = await this._call('mgba_get_info');
    const frame = parseInt((text.match(/Frame:\s*(\d+)/) || [])[1] || '-1', 10);
    const title = (text.match(/Title:\s*(.+)/) || [])[1]?.trim() || '';
    return { text, frame, title };
  }

  /** スクリーンショットを撮り、保存された PNG のパスを返す */
  async screenshot() {
    const text = await this._call('mgba_screenshot');
    return (text.match(/(\/[^\s]+\.png)/) || [])[1] || null;
  }

  pressButtons(buttons) { return this._call('mgba_press_buttons', { buttons }); }
  readRange(address, length) { return this._call('mgba_read_range', { address, length }); }
  read8(address) { return this._call('mgba_read8', { address }); }
  read16(address) { return this._call('mgba_read16', { address }); }
  read32(address) { return this._call('mgba_read32', { address }); }
  saveState(slot) { return this._call('mgba_save_state', { slot }); }
  loadState(slot) { return this._call('mgba_load_state', { slot }); }
  advanceFrames(count) { return this._call('mgba_advance_frames', { count }); }
  reset() { return this._call('mgba_reset'); }

  close() {
    if (this.child) this.child.kill();
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
