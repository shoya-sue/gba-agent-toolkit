// =============================================================
//  llm-policy.test.mjs ― extractJson と normalizeButtons のユニットテスト
//
//  Node 標準の node:test と node:assert/strict を使用（外部依存なし）
// =============================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractJson, normalizeButtons } from './llm-policy.mjs';

// ============= extractJson テスト =============

test('extractJson: 正常な JSON を解析', () => {
  const json = extractJson('{"buttons":["A"],"reason":"test"}');
  assert.deepStrictEqual(json, { buttons: ['A'], reason: 'test' });
});

test('extractJson: 前後にゴミが付いた JSON を抽出', () => {
  const text = 'ノイズ{"buttons":["A"],"reason":"test"}末尾';
  const json = extractJson(text);
  assert.deepStrictEqual(json, { buttons: ['A'], reason: 'test' });
});

test('extractJson: 複数オブジェクトで最初のバランス塊を取得', () => {
  const text = '{"buttons":["A"]}後続{"buttons":["B"]}';
  const json = extractJson(text);
  assert.deepStrictEqual(json, { buttons: ['A'] });
});

test('extractJson: ネストした波括弧を正しく処理', () => {
  const json = extractJson('{"data":{"nested":{"value":1}},"buttons":["A"]}');
  assert.deepStrictEqual(json, { data: { nested: { value: 1 } }, buttons: ['A'] });
});

test('extractJson: 解析不能な JSON は null を返す', () => {
  const json = extractJson('{"invalid": json}');
  assert.strictEqual(json, null);
});

test('extractJson: 完結していない波括弧は null を返す', () => {
  const json = extractJson('{"incomplete":');
  assert.strictEqual(json, null);
});

test('extractJson: 非文字列入力は null を返す', () => {
  assert.strictEqual(extractJson(123), null);
  assert.strictEqual(extractJson(null), null);
  assert.strictEqual(extractJson(undefined), null);
  assert.strictEqual(extractJson({ obj: true }), null);
});

test('extractJson: 空文字列は null を返す', () => {
  assert.strictEqual(extractJson(''), null);
});

test('extractJson: JSON.parse 直後の成功パス', () => {
  // JSON.parse が直接成功するケース
  const json = extractJson('{"buttons":["Start"],"reason":"menu"}');
  assert.deepStrictEqual(json, { buttons: ['Start'], reason: 'menu' });
});

// ============= normalizeButtons テスト =============

test('normalizeButtons: 小文字を正準形に変換', () => {
  const result = normalizeButtons(['a', 'b', 'start']);
  assert.deepStrictEqual(result, ['A', 'B', 'Start']);
});

test('normalizeButtons: 別名 u/d を正準形に変換', () => {
  const result = normalizeButtons(['u', 'd']);
  assert.deepStrictEqual(result, ['Up', 'Down']);
});

test('normalizeButtons: 未知の値はスキップ', () => {
  const result = normalizeButtons(['a', 'unknown', 'b']);
  assert.deepStrictEqual(result, ['A', 'B']);
});

test('normalizeButtons: 重複を除去', () => {
  const result = normalizeButtons(['a', 'A', 'a']);
  assert.deepStrictEqual(result, ['A']);
});

test('normalizeButtons: 4個以上は最初の3個まで', () => {
  const result = normalizeButtons(['a', 'b', 'up', 'down', 'left']);
  assert.deepStrictEqual(result, ['A', 'B', 'Up']);
});

test('normalizeButtons: 非配列入力は空配列を返す', () => {
  assert.deepStrictEqual(normalizeButtons(null), []);
  assert.deepStrictEqual(normalizeButtons(undefined), []);
  assert.deepStrictEqual(normalizeButtons('not an array'), []);
  assert.deepStrictEqual(normalizeButtons({ a: 1 }), []);
  assert.deepStrictEqual(normalizeButtons(123), []);
});

test('normalizeButtons: 非文字列要素は混在でもスキップ', () => {
  const result = normalizeButtons(['a', 123, null, 'b', undefined, 'start']);
  assert.deepStrictEqual(result, ['A', 'B', 'Start']);
});

test('normalizeButtons: 空配列は空配列を返す', () => {
  assert.deepStrictEqual(normalizeButtons([]), []);
});

test('normalizeButtons: スペース含む小文字は正規化される', () => {
  // trim() で前後スペースを削除してから小文字化して正規化
  const result = normalizeButtons([' a ', ' start ']);
  assert.deepStrictEqual(result, ['A', 'Start']);
});

test('normalizeButtons: 大文字も小文字化してから正規化', () => {
  const result = normalizeButtons(['A', 'START', 'Up']);
  assert.deepStrictEqual(result, ['A', 'Start', 'Up']);
});

test('normalizeButtons: select/l/r の正準化', () => {
  const result = normalizeButtons(['select', 'l', 'r']);
  assert.deepStrictEqual(result, ['Select', 'L', 'R']);
});

test('normalizeButtons: 実際の LLM 出力シミュレーション', () => {
  // LLM が返すかもしれない形式
  const result = normalizeButtons(['a', 'up', 'left']);
  assert.deepStrictEqual(result, ['A', 'Up', 'Left']);
});
