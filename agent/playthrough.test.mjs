// =============================================================
//  playthrough.test.mjs ― プレイスルーハーネス純粋ヘルパーのユニットテスト (#14)
//  外部依存なし（mGBA/ollama 不要）。CI で自動実行。
//  実行: node --test agent/playthrough.test.mjs
// =============================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldStop, isSnapshotStep, buildSummary } from './playthrough.mjs';

const base = {
  step: 0, maxSteps: 100, elapsedMs: 0, maxMs: 600000,
  stopping: false, consecutiveFailures: 0, maxFailures: 5,
};

test('shouldStop: 継続条件では stop=false', () => {
  assert.deepEqual(shouldStop(base), { stop: false, reason: null });
});

test('shouldStop: 中断シグナルが最優先', () => {
  const r = shouldStop({ ...base, stopping: true, step: 999, consecutiveFailures: 999 });
  assert.deepEqual(r, { stop: true, reason: 'interrupted' });
});

test('shouldStop: ステップ上限', () => {
  assert.equal(shouldStop({ ...base, step: 100 }).reason, 'max-steps');
  assert.equal(shouldStop({ ...base, step: 101 }).reason, 'max-steps');
});

test('shouldStop: 時間上限', () => {
  assert.equal(shouldStop({ ...base, elapsedMs: 600000 }).reason, 'time-budget');
});

test('shouldStop: 連続失敗上限', () => {
  assert.equal(shouldStop({ ...base, consecutiveFailures: 5 }).reason, 'too-many-failures');
});

test('shouldStop: 優先順（ステップ上限 > 時間 > 失敗）', () => {
  // ステップ上限と失敗上限が同時 → ステップ上限が先
  assert.equal(shouldStop({ ...base, step: 100, consecutiveFailures: 5 }).reason, 'max-steps');
});

test('shouldStop: maxSteps/maxMs が null なら該当条件は無視', () => {
  const r = shouldStop({ ...base, maxSteps: null, maxMs: null, step: 1e9, elapsedMs: 1e9 });
  assert.equal(r.stop, false);
});

test('isSnapshotStep: every の倍数（step>0）で true', () => {
  assert.equal(isSnapshotStep(0, 25), false); // step 0 は除外
  assert.equal(isSnapshotStep(25, 25), true);
  assert.equal(isSnapshotStep(50, 25), true);
  assert.equal(isSnapshotStep(26, 25), false);
});

test('isSnapshotStep: every=0 なら常に false（スナップショット無効）', () => {
  assert.equal(isSnapshotStep(25, 0), false);
  assert.equal(isSnapshotStep(100, 0), false);
});

test('buildSummary: frameProgress を算出しキーが揃う', () => {
  const s = buildSummary({
    runId: 'r1', policyLabel: 'demo', steps: 40, framesStart: 1000, framesEnd: 4000,
    snapshots: 1, errors: 0, consecutiveFailures: 0, stopReason: 'max-steps',
    elapsedMs: 5000, lastCheckpointSlot: 1, startedAt: 'a', endedAt: 'b',
  });
  assert.equal(s.frameProgress, 3000);
  assert.equal(s.steps, 40);
  assert.equal(s.stopReason, 'max-steps');
  for (const k of ['runId', 'policy', 'framesStart', 'framesEnd', 'snapshots', 'errors', 'startedAt', 'endedAt']) {
    assert.ok(k in s, `key ${k} が存在する`);
  }
});

test('buildSummary: frame 未取得(null)でも frameProgress=0', () => {
  const s = buildSummary({ framesStart: null, framesEnd: null });
  assert.equal(s.frameProgress, 0);
});
