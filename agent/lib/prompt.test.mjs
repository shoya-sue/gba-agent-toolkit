// prompt.mjs（判断プロンプト・観測整形, #11）のユニットテスト。外部依存なし。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  summarizeState, createActionHistory, formatHistory, buildDecisionPrompt, ACTION_HINTS,
} from './prompt.mjs';

test('summarizeState: キーをソートして 1 行に整形', () => {
  assert.equal(summarizeState({ x: 5, hp: 12, name: 'AB' }), 'hp=12, name="AB", x=5');
});

test('summarizeState: null/非オブジェクトは空文字', () => {
  assert.equal(summarizeState(null), '');
  assert.equal(summarizeState(3), '');
});

test('summarizeState: maxKeys 超過は件数表示・長い値は切り詰め', () => {
  const s = summarizeState({ a: 1, b: 2, c: 3 }, { maxKeys: 2 });
  assert.equal(s, 'a=1, b=2, ...(+1)');
  const long = summarizeState({ arr: Array.from({ length: 50 }, (_, i) => i) });
  assert.ok(long.endsWith('...'));
  assert.ok(long.length < 70);
});

test('history: 次の観測で直前行動の effect を確定（changed / no-change / unknown）', () => {
  const h = createActionHistory();
  h.observe({ screenHash: 'a' });
  h.record(['A'], 'go');
  h.observe({ screenHash: 'b' });         // 画面変化
  h.record(['B']);
  h.observe({ screenHash: 'b' });         // 不変
  h.record(['Up']);
  h.observe({});                          // 署名なし
  const l = h.list();
  assert.deepEqual(l.map((i) => i.effect), ['changed', 'no-change', 'unknown']);
  assert.equal(l[0].reason, 'go');
});

test('history: 状態キーの変化も changed とみなす', () => {
  const h = createActionHistory();
  h.observe({ screenHash: 'a', stateKey: 's1' });
  h.record(['A']);
  h.observe({ screenHash: 'a', stateKey: 's2' });
  assert.equal(h.list()[0].effect, 'changed');
});

test('history: size 上限で古いものから捨てる', () => {
  const h = createActionHistory({ size: 3 });
  h.observe({ screenHash: 'x' });
  for (let i = 0; i < 5; i++) { h.record([i % 2 ? 'A' : 'B']); h.observe({ screenHash: 'x' }); }
  const l = h.list();
  assert.equal(l.length, 3);
  assert.deepEqual(l.map((i) => i.buttons[0]), ['B', 'A', 'B']);
  assert.ok(l.every((i) => i.effect === 'no-change'));
});

test('formatHistory: 行形式', () => {
  const s = formatHistory([{ buttons: ['A'], effect: 'changed', reason: 'ok' }, { buttons: [], effect: null }]);
  assert.equal(s, '1. [A] -> screen/state changed (ok)\n2. [(none)] -> pending');
});

test('buildDecisionPrompt: 行動候補・状態要約・先読み plan 指示を含む', () => {
  const p = buildDecisionPrompt({ frame: 10, title: 'GAME', state: { hp: 3 } }, { vision: true });
  for (const [b] of ACTION_HINTS) assert.ok(p.includes(`- ${b}:`));
  assert.match(p, /game state \(from RAM\): hp=3/);
  assert.match(p, /attached image/);
  assert.match(p, /"plan"/);
  assert.match(p, /next 3 button presses/);
});

test('buildDecisionPrompt: lookahead=0 は plan なしの従来 JSON 形式', () => {
  const p = buildDecisionPrompt({ frame: 1 }, { lookahead: 0 });
  assert.ok(!p.includes('"plan"'));
  assert.match(p, /\{"buttons":\["A"\],"reason":"short"\}/);
  assert.match(p, /No screen image/);
});

test('buildDecisionPrompt: 直近が空振り続きなら警告を出す', () => {
  const hist = [{ buttons: ['A'], effect: 'no-change' }, { buttons: ['A'], effect: 'no-change' }];
  assert.match(buildDecisionPrompt({}, { history: hist }), /Do NOT repeat/);
  const ok = [{ buttons: ['A'], effect: 'changed' }, { buttons: ['A'], effect: 'no-change' }];
  assert.ok(!buildDecisionPrompt({}, { history: ok }).includes('Do NOT repeat'));
});

test('buildDecisionPrompt: title の " をエスケープ・goal を反映', () => {
  const p = buildDecisionPrompt({ title: 'A"B' }, { goal: 'reach the field' });
  assert.match(p, /title="A\\"B"/);
  assert.match(p, /Goal: reach the field/);
});
