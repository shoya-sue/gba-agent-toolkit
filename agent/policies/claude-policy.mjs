// =============================================================
//  claude-policy.mjs ― Claude API（vision）を「判断」に接続するポリシー (Issue #11)
//
//  llm-policy（ollama）と同じ (observation)=>{buttons,note} インターフェース。
//  画面 PNG（＋#12 の状態要約・直近履歴・先読み plan 指示）を Claude に渡し、
//  次に押すボタンを JSON で返させる。play-loop / playthrough の POLICY=claude で使う。
//
//  - SDK: @anthropic-ai/sdk（agent/ で `npm install`）。他ポリシー・ユニットテストを
//    SDK 非導入でも動かすため、SDK は初回呼び出し時に動的 import する。
//  - 認証: SDK 既定の解決順（ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / `ant auth login`）。
//    キーはコード・ログに一切出さない。
//  - 送信されるのは画面 PNG と状態テキストのみ（ROM 本体は送らない）。
// =============================================================
import { imageToBase64 } from '../lib/ollama-client.mjs';
import { buildDecisionPrompt, createActionHistory } from '../lib/prompt.mjs';
import {
  extractJson, parseDecision, decisionNote, observationKey, promptOptionsFromEnv,
} from './llm-policy.mjs';

export const DEFAULT_CLAUDE_MODEL = 'claude-opus-5-5';
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

let sdkPromise = null;
/** @anthropic-ai/sdk を遅延ロードする（未導入なら分かりやすいエラーにする）。 */
async function loadSdk() {
  sdkPromise ??= import('@anthropic-ai/sdk').then((m) => m.default ?? m).catch((e) => {
    sdkPromise = null;
    throw new Error(`@anthropic-ai/sdk が見つかりません（agent/ で \`npm install\` してください）: ${e.message}`);
  });
  return sdkPromise;
}

/** 環境変数から Claude ポリシー設定を得る（不正値は既定に丸める）。 */
export function claudeOptionsFromEnv(env = process.env) {
  const effort = EFFORTS.includes(env.CLAUDE_EFFORT) ? env.CLAUDE_EFFORT : 'medium';
  return {
    model: env.CLAUDE_MODEL || DEFAULT_CLAUDE_MODEL,
    vision: env.CLAUDE_VISION !== '0', // 既定 ON（画面ベース判断が本ポリシーの主目的）
    effort,
    fallbacks: env.CLAUDE_FALLBACKS !== '0',
  };
}

/**
 * Messages API のリクエスト本体を組み立てる（純粋・テスト用に export）。
 * @param {{model:string, effort:string, fallbacks:boolean, prompt:string, imageB64?:string}} o
 */
export function buildClaudeRequest({ model, effort, fallbacks, prompt, imageB64 }) {
  const content = [];
  if (imageB64) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: imageB64 } });
  content.push({ type: 'text', text: prompt });
  const req = {
    model,
    // 適応的 thinking のトークンも含むため余裕を持たせる（出力 JSON 自体は短い）
    max_tokens: 8000,
    output_config: { effort },
    messages: [{ role: 'user', content }],
  };
  // 安全分類器による refusal 時はサーバ側で別モデルへフォールバック（CLAUDE_FALLBACKS=0 で無効）
  if (fallbacks) Object.assign(req, { betas: [FALLBACK_BETA], fallbacks: 'default' });
  return req;
}

/** レスポンスの text ブロックを連結する。 */
export function responseText(resp) {
  return (resp?.content ?? []).filter((b) => b?.type === 'text').map((b) => b.text).join('\n');
}

/**
 * 接続確認（モデル取得）。play-loop/playthrough の起動前チェック用。
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
export async function claudeCheck(model = DEFAULT_CLAUDE_MODEL, { client } = {}) {
  try {
    const c = client ?? new (await loadSdk())();
    await c.models.retrieve(model);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

/**
 * Claude ポリシーを生成する。
 * @param {object} [opts]  未指定項目は env（CLAUDE_MODEL/CLAUDE_VISION/CLAUDE_EFFORT/CLAUDE_FALLBACKS,
 *                         AGENT_LOOKAHEAD/AGENT_GOAL）→ 既定の順で決まる
 * @param {object} [opts.client] Anthropic クライアント（テスト用に差し替え可。既定は SDK を遅延生成）
 * @returns {(obs:object)=>Promise<{buttons:string[],note:string}>}
 */
export function createClaudePolicy(opts = {}) {
  const env = claudeOptionsFromEnv();
  const penv = promptOptionsFromEnv();
  const model = opts.model ?? env.model;
  const vision = opts.vision ?? env.vision;
  const effort = opts.effort ?? env.effort;
  const fallbacks = opts.fallbacks ?? env.fallbacks;
  const retries = opts.retries ?? 2;
  const promptOpts = { lookahead: opts.lookahead ?? penv.lookahead, goal: opts.goal ?? penv.goal };
  const label = `Claude(${model})`;
  const history = createActionHistory();
  let client = opts.client ?? null;
  let Sdk = null;

  const decide = async (obs) => {
    history.observe(observationKey(obs));
    const prompt = buildDecisionPrompt(obs, { vision, history: history.list(), ...promptOpts });
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        if (!client) { Sdk = await loadSdk(); client = new Sdk(); }
        const imageB64 = vision && obs.screenshotPath ? imageToBase64(obs.screenshotPath) : undefined;
        const resp = await client.beta.messages.create(
          buildClaudeRequest({ model, effort, fallbacks, prompt, imageB64 }));
        if (resp?.stop_reason === 'refusal') {
          return { buttons: [], note: `${label}: refused (${resp.stop_details?.category ?? 'unknown'})`, reason: 'refused' };
        }
        const d = parseDecision(extractJson(responseText(resp)));
        if (d.valid) return { buttons: d.buttons, note: decisionNote(label, d), reason: d.reason };
        // JSON 不正・buttons 不在はリトライ
      } catch (e) {
        // 認証/権限/リクエスト不正はリトライしても直らない（SDK 自体が 429/5xx を内部リトライ済み）
        const fatal = Sdk && (e instanceof Sdk.AuthenticationError || e instanceof Sdk.PermissionDeniedError ||
          e instanceof Sdk.BadRequestError || e instanceof Sdk.NotFoundError);
        if (fatal || attempt === retries) return { buttons: [], note: `${label} error: ${e.message}`, reason: 'error' };
      }
    }
    return { buttons: [], note: `${label}: no valid buttons`, reason: 'invalid' };
  };

  return async function claudePolicy(obs) {
    const { reason, ...dec } = await decide(obs);
    history.record(dec.buttons, reason ?? '');
    return dec;
  };
}
