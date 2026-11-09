// eval-policies（判断ポリシー同一シーン比較, #11）純粋ヘルパーのユニットテスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePolicySpecs, specToEnv, summarizeTrial, averageTrials, rankResults, formatTable,
} from './eval-policies.mjs';
import { selectPolicy } from './policies/select.mjs';

test('parsePolicySpecs: kind@model+vision（model 内の : を保持）', () => {
  assert.deepEqual(parsePolicySpecs('demo, llm@qwen2.5:7b ,llm@llama3.2-vision+vision,claude+text'), [
    { kind: 'demo', model: null, vision: null, id: 'demo' },
    { kind: 'llm', model: 'qwen2.5:7b', vision: null, id: 'llm@qwen2.5:7b' },
    { kind: 'llm', model: 'llama3.2-vision', vision: true, id: 'llm@llama3.2-vision+vision' },
    { kind: 'claude', model: null, vision: false, id: 'claude+text' },
  ]);
  assert.deepEqual(parsePolicySpecs(''), []);
});

test('specToEnv: llm / claude の env 上書き（ベース env を維持）', () => {
  const [l, c] = parsePolicySpecs('llm@moondream+vision,claude@claude-sonnet-5-5+text');
  assert.deepEqual(specToEnv(l, { X: '1' }), { X: '1', POLICY: 'llm', OLLAMA_MODEL: 'moondream', OLLAMA_VISION: '1' });
  assert.deepEqual(specToEnv(c), { POLICY: 'claude', CLAUDE_MODEL: 'claude-sonnet-5-5', CLAUDE_VISION: '0' });
});

test('specToEnv → selectPolicy: ラベルに反映（ポリシー切替がハーネス無改造で効く）', () => {
  const [l, c, d] = parsePolicySpecs('llm@moondream+vision,claude@claude-sonnet-5-5,demo');
  assert.equal(selectPolicy(specToEnv(l)).label, 'LLM(ollama moondream, vision)');
  assert.equal(selectPolicy(specToEnv(c)).label, 'Claude(claude-sonnet-5-5, vision, effort=medium)');
  assert.equal(selectPolicy(specToEnv(d)).label, 'demo');
});

test('summarizeTrial: 画面数・進捗・最長無進捗・無操作・エラー・reward', () => {
  const m = summarizeTrial([
    { screenHash: 'a', progressed: true, noProgressStreak: 0, buttons: ['A'], reward: 1, decideMs: 100 },
    { screenHash: 'a', progressed: false, noProgressStreak: 1, buttons: [], note: 'LLM error: x', decideMs: 300 },
    { screenHash: 'b', progressed: true, noProgressStreak: 0, buttons: ['A', 'Down'], reward: 0.5 },
  ]);
  assert.deepEqual(m, {
    steps: 3, uniqueScreens: 2, progressSteps: 2, maxNoProgress: 1, reward: 1.5,
    noop: 1, errors: 1, avgDecideMs: 133, buttonCounts: { A: 2, Down: 1 },
  });
});

test('averageTrials: 平均と buttonCounts 合算・空入力', () => {
  const a = averageTrials([summarizeTrial([{ screenHash: 'a', buttons: ['A'] }]), summarizeTrial([{ screenHash: 'a', buttons: ['A'] }, { screenHash: 'b', buttons: ['B'] }])]);
  assert.equal(a.trials, 2);
  assert.equal(a.uniqueScreens, 1.5);
  assert.deepEqual(a.buttonCounts, { A: 2, B: 1 });
  assert.equal(averageTrials([]).steps, 0);
});

test('rankResults / formatTable: reward → 画面数 → 進捗 → 無進捗の昇順', () => {
  const mk = (label, o) => ({ label, metrics: { steps: 10, uniqueScreens: 0, progressSteps: 0, maxNoProgress: 0, reward: 0, noop: 0, errors: 0, avgDecideMs: 0, ...o } });
  const rs = [mk('text', { uniqueScreens: 2, progressSteps: 3 }), mk('vision', { uniqueScreens: 5 }), mk('claude', { uniqueScreens: 5, progressSteps: 7 })];
  assert.deepEqual(rankResults(rs).map((r) => r.label), ['claude', 'vision', 'text']);
  const t = formatTable(rs).split('\n');
  assert.equal(t.length, 5);
  assert.match(t[2], /^\| 1 \| claude \| 5 \| 7\/10 \|/);
});
