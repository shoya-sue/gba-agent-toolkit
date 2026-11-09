// =============================================================
//  report.test.mjs ― E2E 完走シナリオ + 合否レポート 純粋ロジックのユニットテスト (#17)
//  外部依存なし（mGBA/ollama/ROM 不要）。CI で自動実行。
//  実行: node --test agent/lib/report.test.mjs
// =============================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseScenario, scenarioEnv, hasCompletionCondition, evaluateMilestones,
  buildReport, renderReportMarkdown, STOP_REASON_TEXT,
} from './report.mjs';

const scenario = parseScenario({
  game: 'TestGame',
  flow: ['title', 'town', 'ending'],
  milestones: [
    { name: 'title', titleContains: 'TEST' },
    { name: 'town', state: { field: 'map', equals: 3 } },
    { name: 'ending', screenHashes: ['endhash'] },
    { name: 'invalid-no-condition' },
  ],
  completion: { titleContains: 'THE END', state: 'cleared=1', screenHashes: ['endhash'] },
  stateMap: 'agent/state-maps/x.local.json',
  run: { maxSteps: 500, maxSeconds: 60, policy: 'llm', env: { STUCK_STEPS: 20 } },
});

const summary = (over = {}) => ({
  runId: 'r1', policy: 'demo', steps: 3, framesStart: 0, framesEnd: 300, errors: 0,
  stopReason: 'completed', completed: true, completionMatched: ['title~THE END'],
  elapsedMs: 65000, startedAt: 'a', endedAt: 'b',
  progressSteps: 2, stuckSignals: 1, maxNoProgressStreak: 4,
  recoveries: 2, recoveryByStrategy: { 'alt-input': 1, 'load-state': 1 }, recoveryGiveUp: false,
  stateEnabled: false, lastState: null,
  ...over,
});

const steps = [
  { step: 0, ok: true, frame: 100, title: 'TEST GAME', state: { map: 1 }, screenHash: 'h0', progressed: true },
  { step: 1, ok: false, error: 'timeout 10000ms' },
  { step: 2, ok: true, frame: 200, title: 'TEST GAME', state: { map: 3 }, screenHash: 'h1', progressed: true },
  { step: 3, ok: true, frame: 300, title: 'TEST GAME', state: { map: 3 }, screenHash: 'h1', progressed: false },
];

test('parseScenario: 正規化・条件の無いマイルストーンは除外・数値化', () => {
  assert.equal(scenario.game, 'TestGame');
  assert.deepEqual(scenario.flow, ['title', 'town', 'ending']);
  assert.deepEqual(scenario.milestones.map((m) => m.name), ['title', 'town', 'ending']);
  assert.equal(scenario.run.maxSteps, 500);
  assert.equal(scenario.run.policy, 'llm');
  const empty = parseScenario('{}');
  assert.deepEqual(empty.milestones, []);
  assert.deepEqual(empty.completion, { titleContains: null, state: null, screenHashes: [] });
  assert.equal(empty.run.maxSteps, null);
});

test('scenarioEnv: シナリオを playthrough 用 env へ変換', () => {
  const env = scenarioEnv(scenario, {});
  assert.equal(env.COMPLETE_TITLE_CONTAINS, 'THE END');
  assert.equal(env.COMPLETE_STATE, 'cleared=1');
  assert.equal(env.COMPLETE_SCREEN_HASHES, 'endhash');
  assert.equal(env.STATE_MAP, 'agent/state-maps/x.local.json');
  assert.equal(env.POLICY, 'llm');
  assert.equal(env.STEPS, '500');
  assert.equal(env.MAX_SECONDS, '60');
  assert.equal(env.STUCK_STEPS, '20');
});

test('scenarioEnv: 既存 env（コマンドライン指定）は上書きしない・空値は出さない', () => {
  const env = scenarioEnv(scenario, { POLICY: 'demo', STEPS: '10' });
  assert.equal('POLICY' in env, false);
  assert.equal('STEPS' in env, false);
  const env2 = scenarioEnv(parseScenario({}), {});
  assert.deepEqual(env2, {});
});

test('hasCompletionCondition: env か state-map completion のいずれかが必要', () => {
  assert.equal(hasCompletionCondition({}, 0), false);
  assert.equal(hasCompletionCondition({ COMPLETE_STATE: 'a=1' }, 0), true);
  assert.equal(hasCompletionCondition({ COMPLETE_SCREEN_HASHES: 'x' }), true);
  assert.equal(hasCompletionCondition({}, 1), true);
});

test('evaluateMilestones: 初回到達ステップと最遠到達・失敗ステップは無視', () => {
  const m = evaluateMilestones(steps, scenario.milestones);
  assert.deepEqual(m.reached, [{ name: 'title', step: 0 }, { name: 'town', step: 2 }]);
  assert.deepEqual(m.missed, ['ending']);
  assert.deepEqual(m.furthest, { name: 'town', step: 2, index: 1 });
  assert.equal(m.total, 3);
  assert.deepEqual(evaluateMilestones([], []), { reached: [], missed: [], furthest: null, total: 0 });
});

test('buildReport: 完結到達のみ PASS・リカバリ回数/所要/到達点/スクショ', () => {
  const r = buildReport({
    meta: { config: {}, summary: summary() }, steps, scenario, runDir: '/runs/r1',
    screenshots: ['/runs/r1/screenshots/step00025.png', '/runs/r1/screenshots/final.png'], harnessExitCode: 0,
  });
  assert.equal(r.result, 'PASS');
  assert.equal(r.stopReason, 'completed');
  assert.equal(r.recovery.total, 2);
  assert.deepEqual(r.recovery.byStrategy, { 'alt-input': 1, 'load-state': 1 });
  assert.equal(r.timing.elapsedMs, 65000);
  assert.equal(r.reached.lastStep, 3);
  assert.equal(r.reached.lastFrame, 300);
  assert.equal(r.reached.lastProgressStep, 2);
  assert.equal(r.reached.milestone.name, 'town');
  assert.equal(r.errors.last, 'timeout 10000ms');
  assert.equal(r.artifacts.finalScreenshot, '/runs/r1/screenshots/final.png');
  assert.equal(r.artifacts.screenshots, 2);
  assert.equal(r.artifacts.stepsLog, '/runs/r1/steps.jsonl');
});

test('buildReport: 上限打ち切り・stuck・切断は FAIL で理由を残す', () => {
  for (const reason of ['max-steps', 'time-budget', 'stuck', 'too-many-failures', 'interrupted']) {
    const r = buildReport({ meta: { summary: summary({ stopReason: reason, completed: false, completionMatched: [] }) }, steps, scenario });
    assert.equal(r.result, 'FAIL', reason);
    assert.equal(r.stopReason, reason);
    assert.equal(r.stopReasonText, STOP_REASON_TEXT[reason]);
    assert.equal(r.reached.milestone.name, 'town'); // 停止しても到達点は残る
  }
});

test('buildReport: completed フラグが立っていても stopReason が completed でなければ FAIL', () => {
  const r = buildReport({ meta: { summary: summary({ stopReason: 'interrupted', completed: true }) }, steps });
  assert.equal(r.result, 'FAIL');
});

test('buildReport: meta.summary 無し（異常終了）でも steps から到達点を出して FAIL', () => {
  const r = buildReport({ meta: { config: {}, summary: null }, steps, scenario, harnessExitCode: 2 });
  assert.equal(r.result, 'FAIL');
  assert.equal(r.stopReason, 'no-summary');
  assert.equal(r.reached.steps, 3);
  assert.equal(r.reached.lastStep, 3);
  assert.equal(r.errors.total, 1);
  assert.equal(r.harnessExitCode, 2);
  const r2 = buildReport({ meta: null, steps: [] });
  assert.equal(r2.result, 'FAIL');
  assert.equal(r2.reached.lastStep, null);
});

test('renderReportMarkdown: 合否・停止理由・リカバリ・到達点・記録を含む', () => {
  const pass = renderReportMarkdown(buildReport({ meta: { summary: summary() }, steps, scenario, runDir: '/runs/r1', screenshots: ['/runs/r1/screenshots/final.png'] }));
  assert.match(pass, /✅ PASS/);
  assert.match(pass, /リカバリ回数 \| 2（alt-input:1 load-state:1）/);
  assert.match(pass, /所要 \| 1m5s/);
  assert.match(pass, /マイルストーン: 2\/3 到達（最遠: \*\*town\*\* @step 2）/);
  assert.match(pass, /⬜ ending/);
  assert.match(pass, /final\.png/);
  const fail = renderReportMarkdown(buildReport({ meta: { summary: summary({ stopReason: 'stuck', completed: false, recoveryGiveUp: true }) }, steps }));
  assert.match(fail, /❌ FAIL/);
  assert.match(fail, /`stuck`/);
  assert.match(fail, /give-up/);
});

test('example シナリオ（テンプレート）が parse でき完結条件を持つ', () => {
  const s = parseScenario(readFileSync(new URL('../scenarios/example.json', import.meta.url), 'utf8'));
  const env = scenarioEnv(s, {});
  assert.equal(hasCompletionCondition(env, 0), true);
  assert.ok(s.milestones.length >= 1);
  assert.ok(s.flow.length >= 1);
});
