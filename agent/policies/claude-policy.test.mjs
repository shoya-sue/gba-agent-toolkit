// claude-policy（Claude API vision 判断, #11）のユニットテスト。
// 偽クライアントを注入するため SDK/ネットワーク/API キー不要。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createClaudePolicy, buildClaudeRequest, responseText, claudeOptionsFromEnv, claudeCheck, DEFAULT_CLAUDE_MODEL,
} from './claude-policy.mjs';

/** 呼び出しを記録し、順に応答（or 例外）を返す偽 Anthropic クライアント。 */
function fakeClient(responses) {
  const calls = [];
  return {
    calls,
    beta: { messages: { create: async (req) => {
      calls.push(req);
      const r = responses.shift();
      if (r instanceof Error) throw r;
      return r;
    } } },
    models: { retrieve: async (m) => { if (m === 'missing') throw new Error('not found'); return { id: m }; } },
  };
}
const text = (t) => ({ stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: t }] });

test('claudeOptionsFromEnv: 既定（opus-5-5 / vision ON / effort medium / fallbacks ON）と不正値の丸め', () => {
  assert.deepEqual(claudeOptionsFromEnv({}), { model: DEFAULT_CLAUDE_MODEL, vision: true, effort: 'medium', fallbacks: true });
  const o = claudeOptionsFromEnv({ CLAUDE_MODEL: 'claude-sonnet-5-5', CLAUDE_VISION: '0', CLAUDE_EFFORT: 'bogus', CLAUDE_FALLBACKS: '0' });
  assert.deepEqual(o, { model: 'claude-sonnet-5-5', vision: false, effort: 'medium', fallbacks: false });
  assert.equal(claudeOptionsFromEnv({ CLAUDE_EFFORT: 'high' }).effort, 'high');
});

test('buildClaudeRequest: 画像→テキストの順・effort・フォールバック', () => {
  const r = buildClaudeRequest({ model: 'm', effort: 'low', fallbacks: true, prompt: 'P', imageB64: 'QUJD' });
  assert.equal(r.model, 'm');
  assert.deepEqual(r.output_config, { effort: 'low' });
  assert.deepEqual(r.messages[0].content[0], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } });
  assert.deepEqual(r.messages[0].content[1], { type: 'text', text: 'P' });
  assert.equal(r.fallbacks, 'default');
  assert.deepEqual(r.betas, ['server-side-fallback-2026-07-01']);
  const r2 = buildClaudeRequest({ model: 'm', effort: 'low', fallbacks: false, prompt: 'P' });
  assert.equal(r2.messages[0].content.length, 1);
  assert.equal(r2.fallbacks, undefined);
  assert.equal(r2.betas, undefined);
});

test('responseText: text ブロックのみ連結', () => {
  assert.equal(responseText(text('{"a":1}')), '{"a":1}');
  assert.equal(responseText(null), '');
});

test('policy: 画面 PNG を添付し、JSON 応答をボタンに変換', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'claude-policy-test-'));
  const png = join(dir, 's.png');
  writeFileSync(png, Buffer.from('fakepng'));
  const client = fakeClient([text('{"scene":"menu","plan":["Down","A"],"buttons":["down"],"reason":"select new game"}')]);
  const policy = createClaudePolicy({ client, model: 'claude-x', vision: true, effort: 'low', fallbacks: false, lookahead: 2, goal: '' });
  const d = await policy({ frame: 1, title: 'T', screenshotPath: png });
  assert.deepEqual(d.buttons, ['Down']);
  assert.match(d.note, /^Claude\(claude-x\): select new game \[scene=menu plan=Down>A\]$/);
  const req = client.calls[0];
  assert.equal(req.messages[0].content[0].source.data, Buffer.from('fakepng').toString('base64'));
  assert.match(req.messages[0].content[1].text, /next 2 button presses/);
});

test('policy: 2 回目は直前行動と効果（画面不変）をプロンプトに含める', async () => {
  const client = fakeClient([text('{"buttons":["A"]}'), text('{"buttons":["B"]}')]);
  const policy = createClaudePolicy({ client, vision: false, fallbacks: false, lookahead: 0, goal: '' });
  await policy({ frame: 1, screenHash: 'h1' });
  await policy({ frame: 2, screenHash: 'h1' });
  assert.match(client.calls[1].messages[0].content[0].text, /1\. \[A\] -> NO visible change/);
});

test('policy: 不正 JSON はリトライ、空配列は no action で即返却', async () => {
  const client = fakeClient([text('nonsense'), text('{"buttons":[],"reason":"wait"}')]);
  const policy = createClaudePolicy({ client, vision: false, fallbacks: false, goal: '' });
  const d = await policy({ frame: 1 });
  assert.deepEqual(d.buttons, []);
  assert.match(d.note, /no action \(wait\)/);
  assert.equal(client.calls.length, 2);
});

test('policy: refusal は何も押さない', async () => {
  const client = fakeClient([{ stop_reason: 'refusal', stop_details: { category: 'cyber' }, content: [] }]);
  const d = await createClaudePolicy({ client, vision: false, fallbacks: false, goal: '' })({ frame: 1 });
  assert.deepEqual(d.buttons, []);
  assert.match(d.note, /refused \(cyber\)/);
});

test('policy: 例外は retries 回まで再試行し、最後は安全側で error note', async () => {
  const client = fakeClient([new Error('boom'), new Error('boom'), new Error('boom')]);
  const d = await createClaudePolicy({ client, vision: false, fallbacks: false, retries: 2, goal: '' })({ frame: 1 });
  assert.deepEqual(d.buttons, []);
  assert.match(d.note, /error: boom/);
  assert.equal(client.calls.length, 3);
});

test('policy: 画像読取失敗でも落ちずに再試行→error note', async () => {
  const client = fakeClient([]);
  const d = await createClaudePolicy({ client, vision: true, fallbacks: false, retries: 0, goal: '' })({ screenshotPath: '/nonexistent.png' });
  assert.deepEqual(d.buttons, []);
  assert.match(d.note, /error/);
  assert.equal(client.calls.length, 0);
});

test('claudeCheck: models.retrieve の成否を返す', async () => {
  const client = fakeClient([]);
  assert.deepEqual(await claudeCheck('m', { client }), { ok: true });
  const r = await claudeCheck('missing', { client });
  assert.equal(r.ok, false);
  assert.match(r.error, /not found/);
});
