// =============================================================
//  lib/progress.test.mjs ― 進捗・完走判定の純粋ロジックのユニットテスト (#15)
//  外部依存なし（mGBA/ollama 不要）。CI で自動実行。
//  実行: node --test agent/lib/progress.test.mjs
// =============================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hashBytes,
  observationSignature,
  detectProgress,
  createProgressTracker,
  evaluateCompletion,
  titleContains,
  stateEquals,
  screenHashIn,
  parseCompletionConditions,
} from './progress.mjs';

// ─────────── hashBytes ───────────

test('hashBytes: 決定的で同一入力は同一ハッシュ', () => {
  const a = hashBytes(Uint8Array.from([1, 2, 3, 4]));
  const b = hashBytes(Uint8Array.from([1, 2, 3, 4]));
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{8}$/); // 8桁hex
});

test('hashBytes: 1バイト違えばハッシュが変わる', () => {
  const a = hashBytes(Uint8Array.from([1, 2, 3, 4]));
  const b = hashBytes(Uint8Array.from([1, 2, 3, 5]));
  assert.notEqual(a, b);
});

test('hashBytes: 空入力でも FNV offset basis を返す', () => {
  assert.equal(hashBytes(new Uint8Array(0)), '811c9dc5');
});

// ─────────── observationSignature ───────────

test('observationSignature: 欠損フィールドは null 正規化', () => {
  assert.deepEqual(observationSignature({ frame: 10 }), {
    frame: 10, title: null, screenHash: null, stateKey: null,
  });
  assert.deepEqual(observationSignature(), {
    frame: null, title: null, screenHash: null, stateKey: null,
  });
});

// ─────────── detectProgress ───────────

test('detectProgress: prev なし（初回）は progressed=true reason=first', () => {
  const r = detectProgress(null, observationSignature({ frame: 1, screenHash: 'aa' }));
  assert.equal(r.progressed, true);
  assert.deepEqual(r.reasons, ['first']);
  assert.equal(r.frameFrozen, false);
});

test('detectProgress: 画面ハッシュ変化で progressed', () => {
  const prev = observationSignature({ frame: 1, screenHash: 'aa', title: 'T' });
  const curr = observationSignature({ frame: 2, screenHash: 'bb', title: 'T' });
  const r = detectProgress(prev, curr);
  assert.equal(r.progressed, true);
  assert.deepEqual(r.reasons, ['screen']);
});

test('detectProgress: 画面/状態/title すべて不変なら無進捗（frame は増えても）', () => {
  const prev = observationSignature({ frame: 100, screenHash: 'aa', title: 'T', stateKey: 's' });
  const curr = observationSignature({ frame: 200, screenHash: 'aa', title: 'T', stateKey: 's' });
  const r = detectProgress(prev, curr);
  assert.equal(r.progressed, false); // frame が進んでも進捗と見なさない
  assert.deepEqual(r.reasons, []);
  assert.equal(r.frameFrozen, false); // frame は変化しているので凍結ではない
});

test('detectProgress: frame 停止は frameFrozen=true', () => {
  const prev = observationSignature({ frame: 100, screenHash: 'aa' });
  const curr = observationSignature({ frame: 100, screenHash: 'aa' });
  const r = detectProgress(prev, curr);
  assert.equal(r.frameFrozen, true);
});

test('detectProgress: 状態・title の変化も進捗理由に含む', () => {
  const prev = observationSignature({ frame: 1, screenHash: 'aa', title: 'A', stateKey: '1' });
  const curr = observationSignature({ frame: 2, screenHash: 'aa', title: 'B', stateKey: '2' });
  const r = detectProgress(prev, curr);
  assert.equal(r.progressed, true);
  assert.deepEqual(r.reasons.sort(), ['state', 'title']);
});

test('detectProgress: 片方 null（不明）は変化扱いしない', () => {
  const prev = observationSignature({ frame: 1, screenHash: null, title: 'A' });
  const curr = observationSignature({ frame: 2, screenHash: 'bb', title: 'A' });
  const r = detectProgress(prev, curr);
  assert.equal(r.progressed, false); // screenHash が prev で不明なので変化と見なさない
});

// ─────────── createProgressTracker ───────────

test('createProgressTracker: 無進捗が続くと noProgressStreak が増え stuck になる', () => {
  const tr = createProgressTracker({ stuckAfter: 3 });
  const same = () => observationSignature({ frame: 1, screenHash: 'aa', title: 'T' });
  assert.equal(tr.update(same()).progressed, true);  // 初回
  assert.equal(tr.update(same()).noProgressStreak, 1);
  assert.equal(tr.update(same()).noProgressStreak, 2);
  const r = tr.update(same());
  assert.equal(r.noProgressStreak, 3);
  assert.equal(r.stuck, true); // 3 連続で stuck
});

test('createProgressTracker: 進捗が入ると streak がリセットされる', () => {
  const tr = createProgressTracker({ stuckAfter: 3 });
  tr.update(observationSignature({ screenHash: 'aa' }));
  tr.update(observationSignature({ screenHash: 'aa' })); // streak 1
  tr.update(observationSignature({ screenHash: 'aa' })); // streak 2
  const moved = tr.update(observationSignature({ screenHash: 'bb' })); // 進捗
  assert.equal(moved.progressed, true);
  assert.equal(moved.noProgressStreak, 0);
  assert.equal(moved.stuck, false);
});

test('createProgressTracker: frozenStreak は frame 停止の連続数', () => {
  const tr = createProgressTracker({ stuckAfter: 10 });
  tr.update(observationSignature({ frame: 5, screenHash: 'aa' }));
  assert.equal(tr.update(observationSignature({ frame: 5, screenHash: 'bb' })).frozenStreak, 1);
  assert.equal(tr.update(observationSignature({ frame: 5, screenHash: 'cc' })).frozenStreak, 2);
  assert.equal(tr.update(observationSignature({ frame: 6, screenHash: 'dd' })).frozenStreak, 0); // frame 進行で解除
});

// ─────────── evaluateCompletion + 条件ビルダー ───────────

test('evaluateCompletion: 条件なしは未完結', () => {
  assert.deepEqual(evaluateCompletion({ title: 'X' }, []), { completed: false, matched: [] });
});

test('titleContains: title に部分一致で完結', () => {
  const cond = titleContains('THE END');
  assert.equal(evaluateCompletion({ title: 'THE END - Congratulations' }, [cond]).completed, true);
  assert.equal(evaluateCompletion({ title: 'PLAYING' }, [cond]).completed, false);
});

test('stateEquals: observation.state のフラグ一致で完結（数値↔文字列も一致）', () => {
  const cond = stateEquals('cleared', '1');
  assert.equal(evaluateCompletion({ state: { cleared: 1 } }, [cond]).completed, true);   // 数値 1
  assert.equal(evaluateCompletion({ state: { cleared: '1' } }, [cond]).completed, true); // 文字列 '1'
  assert.equal(evaluateCompletion({ state: { cleared: 0 } }, [cond]).completed, false);
  assert.equal(evaluateCompletion({ state: {} }, [cond]).completed, false);
  assert.equal(evaluateCompletion({}, [cond]).completed, false); // state なし
});

test('screenHashIn: 既知エンディング画面ハッシュで完結', () => {
  const cond = screenHashIn(['abcd1234', 'ffff0000']);
  assert.equal(evaluateCompletion({ screenHash: 'abcd1234' }, [cond]).completed, true);
  assert.equal(evaluateCompletion({ screenHash: 'deadbeef' }, [cond]).completed, false);
});

test('evaluateCompletion: matched に一致した条件名が入る', () => {
  const r = evaluateCompletion({ title: 'THE END', state: { cleared: 1 } }, [
    titleContains('THE END'),
    stateEquals('cleared', 1),
  ]);
  assert.equal(r.completed, true);
  assert.equal(r.matched.length, 2);
});

test('evaluateCompletion: 例外を投げる条件があっても落とさない', () => {
  const bad = { name: 'bad', test: () => { throw new Error('boom'); } };
  const good = titleContains('OK');
  const r = evaluateCompletion({ title: 'OK' }, [bad, good]);
  assert.deepEqual(r, { completed: true, matched: ['title~OK'] });
});

// ─────────── parseCompletionConditions ───────────

test('parseCompletionConditions: env から title/state/screen 条件を組み立てる', () => {
  const conds = parseCompletionConditions({
    COMPLETE_TITLE_CONTAINS: 'END',
    COMPLETE_STATE: 'cleared=1',
    COMPLETE_SCREEN_HASHES: 'aa11, bb22 ,cc33',
  });
  assert.equal(conds.length, 3);
  // 実際に評価して疎通確認
  assert.equal(evaluateCompletion({ title: 'THE END' }, conds).completed, true);
  assert.equal(evaluateCompletion({ state: { cleared: 1 } }, conds).completed, true);
  assert.equal(evaluateCompletion({ screenHash: 'bb22' }, conds).completed, true);
});

test('parseCompletionConditions: env 空なら条件ゼロ', () => {
  assert.deepEqual(parseCompletionConditions({}), []);
  assert.deepEqual(parseCompletionConditions(), []);
});
