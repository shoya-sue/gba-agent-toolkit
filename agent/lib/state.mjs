#!/usr/bin/env node
// =============================================================
//  lib/state.mjs ― 実ゲーム状態アドレス読取と報酬設計 (Epic #13 / #12)
//
//  「今どういう状態か（HP/座標/フラグ）」を数値で読み、進捗・報酬シグナル
//  として判断（#11 LLM 判断強化）と完走判定（#15）へ供給する土台。
//
//  設計の要点:
//    - ゲーム固有の RAM マップ（アドレス・意味）は ROM 依存 → 記述子(descriptor)
//      と報酬仕様(rewardSpec)を **データ(JSON state-map)として外出し** し、
//      本モジュールはゲーム非依存の純粋ロジックに徹する。
//    - メモリ読取の副作用は readState() のみに閉じ込め、パース/署名/報酬/差分は
//      すべて純粋・同期・決定的にしてユニットテスト可能にする。
//    - read8/16/32・read_range の返り値テキストは mcp-mgba のフォーマットに
//      厳密依存しないよう、数値/16進バイト列を頑健に抽出する（実機差異に強く）。
//    - アドレス特定は「行動前後のメモリ差分観測」で候補を絞る古典手法を
//      diffSnapshots / narrowByComparison として提供する（scripts/scan-memory.mjs）。
// =============================================================

// ─────────────── パーサ（read 返り値テキスト → 数値/バイト） ───────────────

/**
 * read8/16/32 の返り値テキストからスカラ値を抽出する。
 * mcp-mgba の実フォーマットは "0x<ADDR>: <DEC> (0x<HEXVAL>)"（先頭にアドレス）。
 * 先頭のアドレスラベルを除去してから値を取る（アドレスを値と誤読しない）。
 * "0x2A" / "42" / "Value: 42" 等の簡易フォーマットにも頑健。
 * @param {string|number|null} text
 * @returns {number|null} 抽出できなければ null
 */
export function parseScalar(text) {
  if (text == null) return null;
  if (typeof text === 'number') return Number.isFinite(text) ? text : null;
  // 先頭のアドレスラベル（0x..: で始まる場合のみ）を除去。簡易形 "0x2A"（colon 無し）は残す。
  const s = String(text).replace(/^\s*0x[0-9a-fA-F]+:\s*/, '');
  // 値: 括弧内16進 (0x..) を最優先 → 素の 0x.. → 10進 の順。
  const paren = s.match(/\(0x([0-9a-fA-F]+)\)/);
  if (paren) return parseInt(paren[1], 16);
  const hex = s.match(/0x([0-9a-fA-F]+)/);
  if (hex) return parseInt(hex[1], 16);
  const dec = s.match(/-?\d+/);
  if (dec) return parseInt(dec[0], 10);
  return null;
}

/**
 * read_range の返り値テキストから 16進バイト列を抽出する。
 * mcp-mgba の実フォーマットは "0x<ADDR> [<N> bytes]:\n<hex...>"。
 * ヘッダ（最後の ':' まで）を除いて実バイト列だけを取る
 * （"[12 bytes]" の 12 やアドレスを誤ってバイトに含めない）。
 * ':' を含まない簡易形 "47 42 41" / "0x00 0xFF" もそのまま拾える。
 * @param {string|null} text
 * @returns {Uint8Array}
 */
export function parseByteRange(text) {
  if (text == null) return new Uint8Array(0);
  let s = String(text);
  const colon = s.lastIndexOf(':');
  if (colon >= 0) s = s.slice(colon + 1);
  const pairs = s.replace(/0x/gi, ' ').match(/\b[0-9a-fA-F]{2}\b/g) || [];
  return Uint8Array.from(pairs.map((h) => parseInt(h, 16)));
}

/**
 * 16進文字列("0x02000000")・10進文字列・数値のいずれでもアドレスを数値化する。
 * @param {string|number} a
 * @returns {number|null}
 */
export function parseAddress(a) {
  if (typeof a === 'number') return Number.isFinite(a) ? a : null;
  if (typeof a !== 'string') return null;
  const s = a.trim();
  if (/^0x[0-9a-fA-F]+$/.test(s)) return parseInt(s, 16);
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  return null;
}

// ─────────────── 記述子の正規化・値の解釈 ───────────────

/**
 * state-map の生記述子を正規化する。
 * @param {{name:string, address:string|number, size?:number, signed?:boolean,
 *          endian?:'le'|'be', bytes?:number, encoding?:'ascii', mask?:number,
 *          scale?:number, offset?:number}} d
 * @returns {object} 正規化済み記述子（address は数値化）
 */
export function normalizeDescriptor(d = {}) {
  return {
    name: d.name,
    address: parseAddress(d.address),
    size: d.size ?? 1,
    signed: !!d.signed,
    endian: d.endian === 'be' ? 'be' : 'le',
    bytes: d.bytes ?? null,
    encoding: d.encoding ?? null,
    mask: d.mask ?? null,
    scale: d.scale ?? null,
    offset: d.offset ?? null,
  };
}

/**
 * 生スカラに mask・signed 変換・scale・offset を適用する（純粋）。
 * @param {number} raw
 * @param {object} d 正規化済み記述子（size/signed/mask/scale/offset）
 * @returns {number}
 */
export function applyDescriptor(raw, d = {}) {
  let v = raw;
  if (d.mask != null) v = v & d.mask;
  if (d.signed) {
    const bits = (d.size ?? 1) * 8;
    const half = 2 ** (bits - 1);
    const full = 2 ** bits;
    if (v >= half) v -= full;
  }
  if (d.scale != null) v = v * d.scale;
  if (d.offset != null) v = v + d.offset;
  return v;
}

/**
 * read_range バイト列を記述子に従い整数(le/be) or ASCII 文字列へ復号する（純粋）。
 * @param {Uint8Array|number[]} bytes
 * @param {object} d 正規化済み記述子
 * @returns {number|string}
 */
export function decodeBytes(bytes, d = {}) {
  const arr = Array.from(bytes ?? []);
  if (d.encoding === 'ascii') {
    return arr.filter((b) => b >= 32 && b < 127).map((b) => String.fromCharCode(b)).join('');
  }
  const be = d.endian === 'be';
  const n = arr.length;
  let v = 0;
  for (let i = 0; i < n; i++) v = v * 256 + arr[be ? i : n - 1 - i];
  return applyDescriptor(v, { ...d, size: n });
}

// ─────────────── 状態読取（唯一の副作用: client 注入） ───────────────

/**
 * 記述子群を読み、{name: value} の状態オブジェクトを作る。
 * 個々の read 失敗は値 null に丸めて全体は落とさない（1 アドレス不備で観測を壊さない）。
 * size<=4 は read8/16/32、それ以外/bytes 指定/encoding は read_range を使う。
 * @param {object} client MgbaMcpClient 互換（read8/16/32/readRange を持つ）
 * @param {object[]} descriptors 正規化前でも可（内部で normalize）
 * @param {{onError?:(d:object,e:Error)=>void}} [opts]
 * @returns {Promise<Record<string, number|string|null>>}
 */
export async function readState(client, descriptors = [], { onError } = {}) {
  const state = {};
  for (const raw of descriptors) {
    const d = normalizeDescriptor(raw);
    if (!d.name || d.address == null) continue;
    try {
      const useRange = d.encoding != null || d.bytes != null || d.size > 4;
      if (useRange) {
        const len = d.bytes ?? d.size;
        const bytes = parseByteRange(await client.readRange(d.address, len));
        state[d.name] = decodeBytes(bytes, d);
      } else {
        let txt;
        if (d.size === 4) txt = await client.read32(d.address);
        else if (d.size === 2) txt = await client.read16(d.address);
        else txt = await client.read8(d.address);
        const num = parseScalar(txt);
        state[d.name] = num == null ? null : applyDescriptor(num, d);
      }
    } catch (e) {
      state[d.name] = null;
      if (onError) onError(d, e);
    }
  }
  return state;
}

// ─────────────── 進捗署名（#15 の stateKey として使用） ───────────────

/**
 * 状態オブジェクトから進捗比較用の署名文字列を作る（決定的・キー昇順）。
 * null 値は署名から除外（不明を「変化」と誤検出しないため）。
 * @param {Record<string, any>|null} state
 * @param {string[]} [keys] 署名に使うキー（省略時は全キー）
 * @returns {string|null} 空なら null
 */
export function stateSignature(state, keys) {
  if (state == null) return null;
  const ks = (keys ?? Object.keys(state)).slice().sort();
  const parts = ks
    .filter((k) => state[k] != null)
    .map((k) => `${k}=${state[k]}`);
  return parts.length ? parts.join('|') : null;
}

// ─────────────── 報酬設計（前後状態 → 報酬シグナル・純粋） ───────────────

/**
 * 直前状態 prev と現状態 curr を報酬仕様 spec で評価し、報酬を算出する（純粋）。
 * spec = [{field, mode, weight}]:
 *   mode 'delta'    … 差分そのもの（増=正/減=負）
 *   mode 'increase' … 増加分のみ（減少は 0）
 *   mode 'decrease' … 減少分の絶対値（増加は 0）
 *   mode 'change'   … 変化したら 1
 *   mode 'flag'     … 0/falsy → 非0 の立ち上がりで 1（イベントフラグ用）
 * 片方が null（不明）のフィールドは 0 として skip（flag は curr のみで判定可）。
 * @param {Record<string,number>|null} prev
 * @param {Record<string,number>|null} curr
 * @param {Array<{field:string, mode?:string, weight?:number}>} spec
 * @returns {{total:number, components:Array<object>}}
 */
export function computeReward(prev, curr, spec = []) {
  const components = [];
  let total = 0;
  for (const r of spec) {
    if (!r || !r.field) continue;
    const mode = r.mode ?? 'delta';
    const w = r.weight ?? 1;
    const a = prev?.[r.field];
    const b = curr?.[r.field];
    let val = 0;
    let skipped = false;
    if (mode === 'flag') {
      // 立ち上がり: prev が falsy/不明 かつ curr が truthy
      if (b == null) { skipped = true; }
      else val = (!a && b) ? 1 : 0;
    } else if (a == null || b == null) {
      skipped = true;
    } else {
      const diff = b - a;
      switch (mode) {
        case 'increase': val = diff > 0 ? diff : 0; break;
        case 'decrease': val = diff < 0 ? -diff : 0; break;
        case 'change':   val = diff !== 0 ? 1 : 0; break;
        case 'delta':
        default:         val = diff; break;
      }
    }
    const reward = skipped ? 0 : val * w;
    total += reward;
    components.push({ field: r.field, mode, weight: w, value: val, reward, skipped });
  }
  return { total, components };
}

// ─────────────── メモリ差分スキャン（アドレス特定支援・純粋） ───────────────

/**
 * 2 つのメモリスナップショット {address:value} を比較する（純粋）。
 * HP が減ったアドレス等を特定するための最初の絞り込みに使う。
 * @param {Record<string|number, number>} before
 * @param {Record<string|number, number>} after
 * @returns {{changed:number[], increased:number[], decreased:number[], unchanged:number[]}}
 */
export function diffSnapshots(before = {}, after = {}) {
  const changed = [], increased = [], decreased = [], unchanged = [];
  for (const key of Object.keys(after)) {
    if (!(key in before)) continue;
    const a = before[key], b = after[key];
    const addr = Number(key);
    if (b === a) { unchanged.push(addr); continue; }
    changed.push(addr);
    (b > a ? increased : decreased).push(addr);
  }
  return { changed, increased, decreased, unchanged };
}

/**
 * 候補アドレス集合を、before→after の関係で絞り込む（反復スキャンの 1 段）。
 * relation: 'increased' | 'decreased' | 'same' | 'changed'
 * @param {number[]} candidates
 * @param {Record<string|number, number>} before
 * @param {Record<string|number, number>} after
 * @param {string} relation
 * @returns {number[]} 条件を満たす候補のみ
 */
export function narrowByComparison(candidates = [], before = {}, after = {}, relation = 'changed') {
  return candidates.filter((addr) => {
    const a = before[addr], b = after[addr];
    if (a == null || b == null) return false;
    switch (relation) {
      case 'increased': return b > a;
      case 'decreased': return b < a;
      case 'same':      return b === a;
      case 'changed':   return b !== a;
      default:          return false;
    }
  });
}

// ─────────────── state-map ローダ（データ→設定） ───────────────

/**
 * state-map オブジェクト（or JSON 文字列）を正規化して返す（純粋）。
 * 形式: { game?, descriptors:[...], reward:[...], signatureKeys?:[...],
 *         completion?:[{field, equals}] }
 * @param {object|string} src
 * @returns {{game:string|null, descriptors:object[], rewardSpec:object[],
 *            signatureKeys:string[]|null, completion:object[]}}
 */
export function parseStateMap(src) {
  const m = typeof src === 'string' ? JSON.parse(src) : (src ?? {});
  const rawDescriptors = m.descriptors ?? m.state ?? [];
  return {
    game: m.game ?? null,
    descriptors: rawDescriptors.map(normalizeDescriptor).filter((d) => d.name && d.address != null),
    rewardSpec: m.reward ?? m.rewardSpec ?? [],
    signatureKeys: m.signatureKeys ?? null,
    completion: m.completion ?? [],
  };
}
