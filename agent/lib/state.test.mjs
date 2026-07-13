#!/usr/bin/env node
// =============================================================
//  lib/state.test.mjs ― state.mjs 純粋ロジックの回帰テスト (#12)
//  外部依存なし。readState は fake client（read8/16/32/readRange を持つ）で検証。
//  実行: node --test agent/lib/state.test.mjs
// =============================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseScalar, parseByteRange, parseAddress,
  normalizeDescriptor, applyDescriptor, decodeBytes,
  readState, stateSignature, computeReward,
  diffSnapshots, narrowByComparison, parseStateMap,
} from './state.mjs';

// ── parseScalar ─────────────────────────────────────────────
test('parseScalar: 10進テキスト', () => assert.equal(parseScalar('42'), 42));
test('parseScalar: 16進 0x 接頭を優先', () => assert.equal(parseScalar('0x2A'), 42));
test('parseScalar: ラベル付きテキストから抽出', () => assert.equal(parseScalar('Value: 255'), 255));
test('parseScalar: 負値', () => assert.equal(parseScalar('-7'), -7));
test('parseScalar: 数値そのまま', () => assert.equal(parseScalar(99), 99));
test('parseScalar: null/非数は null', () => {
  assert.equal(parseScalar(null), null);
  assert.equal(parseScalar('no number here'), null);
});
// 実 mcp-mgba フォーマット（"0x<ADDR>: <DEC> (0x<HEXVAL>)"）— アドレスを値と誤読しない
test('parseScalar: 実 read8 形式（アドレスラベル付き）', () => {
  assert.equal(parseScalar('0x80000A0: 70 (0x46)'), 70);
});
test('parseScalar: 実 read16 形式', () => {
  assert.equal(parseScalar('0x80000A0: 17990 (0x4646)'), 17990);
});
test('parseScalar: 実 read32 形式（大きなアドレスを値にしない）', () => {
  assert.equal(parseScalar('0x80000A0: 640763462 (0x26314646)'), 640763462);
});
test('parseScalar: 実形式で値0（アドレス非0）を正しく0に', () => {
  assert.equal(parseScalar('0x2000010: 0 (0x0)'), 0);
});

// ── parseByteRange ──────────────────────────────────────────
test('parseByteRange: 16進ペア列を Uint8Array に', () => {
  assert.deepEqual(Array.from(parseByteRange('47 42 41')), [0x47, 0x42, 0x41]);
});
test('parseByteRange: 0x 接頭を除去して抽出', () => {
  assert.deepEqual(Array.from(parseByteRange('0x00 0xFF 0x10')), [0x00, 0xff, 0x10]);
});
test('parseByteRange: null は空配列', () => assert.equal(parseByteRange(null).length, 0));
// 実 mcp-mgba read_range 形式（"0x<ADDR> [<N> bytes]:\n<hex>"）— ヘッダの "12" を拾わない
test('parseByteRange: 実 read_range 形式（ヘッダ除去）', () => {
  const txt = '0x80000A0 [12 bytes]:\n46 46 31 26 32 44 41 57 4E 4F 46 53';
  assert.deepEqual(
    Array.from(parseByteRange(txt)),
    [0x46, 0x46, 0x31, 0x26, 0x32, 0x44, 0x41, 0x57, 0x4e, 0x4f, 0x46, 0x53],
  );
});
test('parseByteRange: 実形式は長さ N と一致（余分な先頭バイトなし）', () => {
  assert.equal(parseByteRange('0x2000000 [4 bytes]:\n01 02 03 04').length, 4);
});

// ── parseAddress ────────────────────────────────────────────
test('parseAddress: 16進文字列', () => assert.equal(parseAddress('0x02000000'), 0x02000000));
test('parseAddress: 10進文字列', () => assert.equal(parseAddress('1024'), 1024));
test('parseAddress: 数値', () => assert.equal(parseAddress(256), 256));
test('parseAddress: 不正は null', () => assert.equal(parseAddress('xyz'), null));

// ── normalizeDescriptor ─────────────────────────────────────
test('normalizeDescriptor: 既定値と address 数値化', () => {
  const d = normalizeDescriptor({ name: 'hp', address: '0x02000010' });
  assert.equal(d.name, 'hp');
  assert.equal(d.address, 0x02000010);
  assert.equal(d.size, 1);
  assert.equal(d.signed, false);
  assert.equal(d.endian, 'le');
});

// ── applyDescriptor ─────────────────────────────────────────
test('applyDescriptor: signed 8bit の 2 の補数', () => {
  assert.equal(applyDescriptor(0xff, { size: 1, signed: true }), -1);
  assert.equal(applyDescriptor(0x80, { size: 1, signed: true }), -128);
});
test('applyDescriptor: mask → scale → offset の順適用', () => {
  // 0x1F3 & 0xFF = 0xF3(243)
  assert.equal(applyDescriptor(0x1f3, { size: 2, mask: 0xff }), 0xf3);
  assert.equal(applyDescriptor(10, { scale: 2, offset: 5 }), 25);
});
test('applyDescriptor: 変換なしは素通し', () => assert.equal(applyDescriptor(123, { size: 1 }), 123));

// ── decodeBytes ─────────────────────────────────────────────
test('decodeBytes: little-endian 整数', () => {
  // [0x10,0x27] LE = 0x2710 = 10000
  assert.equal(decodeBytes([0x10, 0x27], { endian: 'le' }), 10000);
});
test('decodeBytes: big-endian 整数', () => {
  assert.equal(decodeBytes([0x27, 0x10], { endian: 'be' }), 10000);
});
test('decodeBytes: ASCII 文字列', () => {
  assert.equal(decodeBytes([0x47, 0x42, 0x41], { encoding: 'ascii' }), 'GBA');
});

// ── readState（fake client 注入） ───────────────────────────
function fakeClient(map) {
  // map: { address: textToReturn }
  return {
    async read8(a) { return map[a] ?? '0'; },
    async read16(a) { return map[a] ?? '0'; },
    async read32(a) { return map[a] ?? '0'; },
    async readRange(a) { return map[a] ?? ''; },
  };
}
test('readState: size 別に read8/16/32 を呼び分けて値を得る', async () => {
  const client = fakeClient({ [0x10]: '100', [0x20]: '0x0100', [0x30]: '65536' });
  const state = await readState(client, [
    { name: 'hp', address: '0x10', size: 1 },
    { name: 'x', address: '0x20', size: 2 },
    { name: 'gold', address: '0x30', size: 4 },
  ]);
  assert.deepEqual(state, { hp: 100, x: 256, gold: 65536 });
});
test('readState: read 失敗は値 null に丸めて落とさない', async () => {
  const client = {
    async read8() { throw new Error('disconnected'); },
    async read16() { return '0'; }, async read32() { return '0'; }, async readRange() { return ''; },
  };
  let errs = 0;
  const state = await readState(client, [{ name: 'hp', address: '0x10', size: 1 }], { onError: () => errs++ });
  assert.equal(state.hp, null);
  assert.equal(errs, 1);
});
test('readState: encoding=ascii は read_range を使う', async () => {
  const client = fakeClient({ [0x080000a0]: '47 42 41 20 54 65 73 74 73' });
  const state = await readState(client, [
    { name: 'title', address: '0x080000A0', bytes: 9, encoding: 'ascii' },
  ]);
  assert.equal(state.title, 'GBA Tests');
});
test('readState: name/address 欠落記述子はスキップ', async () => {
  const client = fakeClient({ [0x10]: '5' });
  const state = await readState(client, [
    { name: 'ok', address: '0x10', size: 1 },
    { address: '0x20', size: 1 },        // name 無し
    { name: 'bad', address: 'xyz' },     // address 不正
  ]);
  assert.deepEqual(state, { ok: 5 });
});

// ── stateSignature ──────────────────────────────────────────
test('stateSignature: キー昇順・null 除外で決定的', () => {
  assert.equal(stateSignature({ b: 2, a: 1 }), 'a=1|b=2');
  assert.equal(stateSignature({ hp: 100, x: null }), 'hp=100');
  assert.equal(stateSignature({ x: null }), null);
  assert.equal(stateSignature(null), null);
});
test('stateSignature: signatureKeys 指定で部分署名', () => {
  assert.equal(stateSignature({ hp: 100, x: 5, y: 9 }, ['x', 'y']), 'x=5|y=9');
});

// ── computeReward ───────────────────────────────────────────
test('computeReward: delta は差分そのもの', () => {
  const r = computeReward({ x: 10 }, { x: 13 }, [{ field: 'x', mode: 'delta' }]);
  assert.equal(r.total, 3);
});
test('computeReward: increase は増加のみ・weight 反映', () => {
  const up = computeReward({ hp: 20 }, { hp: 30 }, [{ field: 'hp', mode: 'increase', weight: 2 }]);
  assert.equal(up.total, 20);
  const down = computeReward({ hp: 30 }, { hp: 20 }, [{ field: 'hp', mode: 'increase' }]);
  assert.equal(down.total, 0);
});
test('computeReward: decrease は減少の絶対値', () => {
  assert.equal(computeReward({ hp: 30 }, { hp: 18 }, [{ field: 'hp', mode: 'decrease' }]).total, 12);
});
test('computeReward: flag は 0→非0 の立ち上がりで 1', () => {
  assert.equal(computeReward({ f: 0 }, { f: 1 }, [{ field: 'f', mode: 'flag' }]).total, 1);
  assert.equal(computeReward({ f: 1 }, { f: 1 }, [{ field: 'f', mode: 'flag' }]).total, 0);
});
test('computeReward: flag は prev 不明でも curr のみで判定', () => {
  assert.equal(computeReward(null, { f: 1 }, [{ field: 'f', mode: 'flag' }]).total, 1);
});
test('computeReward: 片方 null の非 flag は skip（0）', () => {
  const r = computeReward({ hp: null }, { hp: 30 }, [{ field: 'hp', mode: 'delta' }]);
  assert.equal(r.total, 0);
  assert.equal(r.components[0].skipped, true);
});
test('computeReward: 複数コンポーネント合算', () => {
  const r = computeReward(
    { hp: 20, gold: 100 }, { hp: 25, gold: 150 },
    [{ field: 'hp', mode: 'increase' }, { field: 'gold', mode: 'increase', weight: 0.1 }],
  );
  assert.equal(r.total, 5 + 50 * 0.1);
  assert.equal(r.components.length, 2);
});

// ── diffSnapshots / narrowByComparison ──────────────────────
test('diffSnapshots: changed/increased/decreased/unchanged 分類', () => {
  const d = diffSnapshots({ 100: 10, 200: 5, 300: 8 }, { 100: 12, 200: 3, 300: 8 });
  assert.deepEqual(d.increased, [100]);
  assert.deepEqual(d.decreased, [200]);
  assert.deepEqual(d.unchanged, [300]);
  assert.deepEqual(d.changed.sort((a, b) => a - b), [100, 200]);
});
test('diffSnapshots: before に無いアドレスは無視', () => {
  const d = diffSnapshots({ 100: 1 }, { 100: 2, 999: 5 });
  assert.deepEqual(d.changed, [100]);
});
test('narrowByComparison: decreased で HP 候補を絞る', () => {
  const cands = [100, 200, 300];
  const out = narrowByComparison(cands, { 100: 30, 200: 5, 300: 8 }, { 100: 18, 200: 5, 300: 9 }, 'decreased');
  assert.deepEqual(out, [100]);
});
test('narrowByComparison: same で不変アドレスを絞る', () => {
  const out = narrowByComparison([100, 200], { 100: 7, 200: 3 }, { 100: 7, 200: 4 }, 'same');
  assert.deepEqual(out, [100]);
});

// ── parseStateMap ───────────────────────────────────────────
test('parseStateMap: JSON 文字列から descriptors/reward を正規化', () => {
  const m = parseStateMap(JSON.stringify({
    game: 'demo',
    descriptors: [{ name: 'hp', address: '0x02000010', size: 2, signed: true }],
    reward: [{ field: 'hp', mode: 'increase' }],
    signatureKeys: ['hp'],
    completion: [{ field: 'cleared', equals: 1 }],
  }));
  assert.equal(m.game, 'demo');
  assert.equal(m.descriptors[0].address, 0x02000010);
  assert.equal(m.descriptors[0].size, 2);
  assert.equal(m.rewardSpec[0].mode, 'increase');
  assert.deepEqual(m.signatureKeys, ['hp']);
  assert.equal(m.completion[0].equals, 1);
});
test('parseStateMap: name/address 欠落記述子は除外', () => {
  const m = parseStateMap({ descriptors: [{ name: 'ok', address: '0x10' }, { size: 1 }] });
  assert.equal(m.descriptors.length, 1);
  assert.equal(m.descriptors[0].name, 'ok');
});
test('parseStateMap: 空入力でも安全なデフォルト', () => {
  const m = parseStateMap(null);
  assert.deepEqual(m.descriptors, []);
  assert.deepEqual(m.rewardSpec, []);
});
