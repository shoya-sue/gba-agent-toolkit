// =============================================================
//  lib/recovery.test.mjs ― 自己修復ロジックの純粋関数ユニットテスト (#16)
//  外部依存なし（mGBA/ollama 不要）。CI で自動実行。
//  実行: node --test agent/lib/recovery.test.mjs
// =============================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RECOVERY_LADDER,
  explorationButtons,
  nextRecoveryStrategy,
  backoffMs,
  createRecoveryController,
} from './recovery.mjs';

// ─────────── explorationButtons ───────────

test('explorationButtons: 決定的で seed 巡回、copy を返す', () => {
  const a = explorationButtons(0);
  const b = explorationButtons(0);
  assert.deepEqual(a, b);
  a.push('X'); // 返り値を破壊しても内部定義に影響しない
  assert.deepEqual(explorationButtons(0), b);
});

test('explorationButtons: 負値・大きい値も安全に正規化', () => {
  assert.ok(Array.isArray(explorationButtons(-1)));
  assert.ok(explorationButtons(-1).length > 0);
  assert.deepEqual(explorationButtons(9), explorationButtons(0)); // 9 セットで一巡
});

test('explorationButtons: 返す入力はすべて有効ボタン', () => {
  const valid = new Set(['A', 'B', 'Up', 'Down', 'Left', 'Right', 'Start', 'Select', 'L', 'R']);
  for (let i = 0; i < 12; i++) {
    for (const btn of explorationButtons(i)) assert.ok(valid.has(btn), `${btn} は有効`);
  }
});

// ─────────── nextRecoveryStrategy ───────────

test('nextRecoveryStrategy: 試行順に梯子を上る', () => {
  assert.equal(nextRecoveryStrategy(0), 'alt-input');
  assert.equal(nextRecoveryStrategy(1), 'load-state');
  assert.equal(nextRecoveryStrategy(2), 'reset');
  assert.equal(nextRecoveryStrategy(3), 'restart-session');
  assert.equal(nextRecoveryStrategy(4), null); // 使い切り
  assert.equal(nextRecoveryStrategy(-1), null);
});

test('nextRecoveryStrategy: enabled で戦略を絞る（ROM 無し=restart 除外）', () => {
  const enabled = ['alt-input', 'load-state', 'reset'];
  assert.equal(nextRecoveryStrategy(0, { enabled }), 'alt-input');
  assert.equal(nextRecoveryStrategy(2, { enabled }), 'reset');
  assert.equal(nextRecoveryStrategy(3, { enabled }), null); // restart は除外され使い切り
});

// ─────────── backoffMs ───────────

test('backoffMs: 指数で伸び、上限で頭打ち', () => {
  assert.equal(backoffMs(0), 500);
  assert.equal(backoffMs(1), 1000);
  assert.equal(backoffMs(2), 2000);
  assert.equal(backoffMs(3), 4000);
  assert.equal(backoffMs(4), 8000);
  assert.equal(backoffMs(5), 8000); // max で頭打ち
  assert.equal(backoffMs(-3), 500); // 負値は 0 扱い
});

test('backoffMs: base/factor/max をカスタムできる', () => {
  assert.equal(backoffMs(2, { base: 100, factor: 3, max: 5000 }), 900);
  assert.equal(backoffMs(10, { base: 100, factor: 3, max: 5000 }), 5000);
});

// ─────────── createRecoveryController ───────────

test('createRecoveryController: 梯子を順に上り、使い切ると give-up', () => {
  const rc = createRecoveryController({ maxTotal: 100 });
  const p0 = rc.onStuck();
  assert.equal(p0.strategy, 'alt-input');
  assert.equal(p0.episodeAttempt, 1);
  assert.equal(p0.backoffMs, 500);
  assert.equal(rc.onStuck().strategy, 'load-state');
  assert.equal(rc.onStuck().strategy, 'reset');
  assert.equal(rc.onStuck().strategy, 'restart-session');
  const exhausted = rc.onStuck();
  assert.equal(exhausted.giveUp, true);
  assert.equal(exhausted.reason, 'episode-exhausted');
});

test('createRecoveryController: onProgress でエピソードがリセットされ再び軽い戦略から', () => {
  const rc = createRecoveryController({ maxTotal: 100 });
  rc.onStuck(); // alt-input
  rc.onStuck(); // load-state
  assert.equal(rc.episodeAttempts, 2);
  rc.onProgress(); // 進捗再開
  assert.equal(rc.episodeAttempts, 0);
  assert.equal(rc.onStuck().strategy, 'alt-input'); // また最初から
  assert.equal(rc.totalAttempts, 3); // 総試行は累積される
});

test('createRecoveryController: 総試行上限で give-up（無限ループ防止）', () => {
  const rc = createRecoveryController({ maxTotal: 2, maxPerEpisode: 10 });
  assert.equal(rc.onStuck().giveUp, false);
  assert.equal(rc.onStuck().giveUp, false);
  const third = rc.onStuck();
  assert.equal(third.giveUp, true);
  assert.equal(third.reason, 'max-total-recoveries');
});

test('createRecoveryController: enabled 縮小時は per-episode cap もそれに合わせる', () => {
  const rc = createRecoveryController({ maxTotal: 100 });
  const enabled = ['alt-input', 'load-state']; // 2 戦略のみ
  assert.equal(rc.onStuck({ enabled }).strategy, 'alt-input');
  assert.equal(rc.onStuck({ enabled }).strategy, 'load-state');
  const done = rc.onStuck({ enabled });
  assert.equal(done.giveUp, true);
  assert.equal(done.reason, 'episode-exhausted');
});

test('createRecoveryController: maxPerEpisode で1エピソードの試行を制限', () => {
  const rc = createRecoveryController({ maxPerEpisode: 2, maxTotal: 100 });
  assert.equal(rc.onStuck().strategy, 'alt-input');
  assert.equal(rc.onStuck().strategy, 'load-state');
  assert.equal(rc.onStuck().giveUp, true); // 3回目は per-episode 上限
});

test('RECOVERY_LADDER: 想定の順序で公開されている', () => {
  assert.deepEqual(RECOVERY_LADDER, ['alt-input', 'load-state', 'reset', 'restart-session']);
});
