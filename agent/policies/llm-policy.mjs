// =============================================================
//  llm-policy.mjs ― ローカル LLM を「判断」に接続する実ポリシー (Issue #8)
//
//  demo-policy の差し込み口を実装したもの。observation（画面 PNG ＋状態）を
//  ollama のローカル LLM に渡し、次に押すボタンを JSON で推論させる。
//  play-loop.mjs の policy をこれに差し替えると自律プレイになる。
//
//  - text モデル（qwen2.5 等）: 状態テキストのみで判断
//  - vision モデル（moondream/llama3.2-vision 等）: 画面 PNG を添付して判断
// =============================================================
import { readFileSync } from 'node:fs';
import { ollamaGenerate, imageToBase64 } from '../lib/ollama-client.mjs';
import { VALID_BUTTONS } from './demo-policy.mjs';
import { buildDecisionPrompt, createActionHistory } from '../lib/prompt.mjs';
import { hashBytes } from '../lib/progress.mjs';
import { stateSignature } from '../lib/state.mjs';

// LLM 出力（大文字小文字/別名）を正準ボタン名へ正規化するマップ。
// CANON は正準名の小文字→正準名（'l'→'L','r'→'R' 等）。ALIAS は CANON に
// 無い別名のみ（'l'/'r' は CANON の L/R に遮蔽されるため入れない）。
const CANON = new Map(VALID_BUTTONS.map((b) => [b.toLowerCase(), b]));
const ALIAS = { u: 'Up', d: 'Down' };

export function normalizeButtons(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const raw of arr) {
    if (typeof raw !== 'string') continue;
    const key = raw.trim().toLowerCase();
    const canon = CANON.get(key) || ALIAS[key];
    if (canon && !out.includes(canon)) out.push(canon);
  }
  return out.slice(0, 3); // 1 ステップ最大 3 ボタン
}

export function extractJson(text) {
  // format:json でも稀に前後にゴミが付くため、最初の完結した {...} を拾う。
  // greedy な /\{[\s\S]*\}/ は複数オブジェクト時に過剰マッチするため、
  // 波括弧の深さを数えて最初のバランスした塊を抽出する。
  if (typeof text !== 'string') return null;
  try { return JSON.parse(text); } catch {}
  let depth = 0, start = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '{') { if (depth === 0) start = i; depth++; }
    else if (c === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        try { return JSON.parse(text.slice(start, i + 1)); } catch {}
        start = -1;
      }
    }
  }
  return null;
}

/**
 * LLM の JSON 応答を判断に変換する（ollama / Claude 共通）。
 * @param {object|null} parsed extractJson の結果
 * @returns {{buttons:string[], reason:string, plan:string[], scene:string, noop:boolean, valid:boolean}}
 *   valid=false は「JSON 不正/buttons 不在」（リトライ対象）。noop=true は明示的な「何もしない」。
 */
export function parseDecision(parsed) {
  const buttons = normalizeButtons(parsed?.buttons);
  const reason = (parsed?.reason ?? '').toString().slice(0, 40);
  // plan は表示用（正規化のみ、ボタン数制限なし・最大 8）
  const plan = Array.isArray(parsed?.plan)
    ? parsed.plan.map((p) => normalizeButtons([p])[0]).filter(Boolean).slice(0, 8)
    : [];
  const scene = typeof parsed?.scene === 'string' ? parsed.scene.slice(0, 20) : '';
  const valid = buttons.length > 0 || Array.isArray(parsed?.buttons);
  return { buttons, reason, plan, scene, noop: valid && buttons.length === 0, valid };
}

/** 判断の note（ログ用 1 行）を組み立てる。 */
export function decisionNote(label, d) {
  const extra = [d.scene && `scene=${d.scene}`, d.plan.length > 1 && `plan=${d.plan.join('>')}`]
    .filter(Boolean).join(' ');
  const body = d.noop ? `no action (${d.reason})` : d.reason;
  return `${label}: ${body}${extra ? ` [${extra}]` : ''}`;
}

/**
 * 観測から履歴用の署名（画面ハッシュ/状態キー）を得る。playthrough は screenHash を
 * 付けて渡すが、play-loop は付けないため screenshotPath から計算する（読めなければ null）。
 * @returns {{screenHash:string|null, stateKey:string|null}}
 */
export function observationKey(obs = {}) {
  let screenHash = obs.screenHash ?? null;
  if (screenHash == null && obs.screenshotPath) {
    try { screenHash = hashBytes(readFileSync(obs.screenshotPath)); } catch { screenHash = null; }
  }
  let stateKey = null;
  try { stateKey = obs.state ? stateSignature(obs.state) : null; } catch { stateKey = null; }
  return { screenHash, stateKey };
}

/** 環境変数から判断プロンプトの共通オプション（先読み数・目標）を得る。 */
export function promptOptionsFromEnv(env = process.env) {
  const n = parseInt(env.AGENT_LOOKAHEAD ?? '', 10);
  return {
    lookahead: Number.isFinite(n) && n >= 0 ? Math.min(n, 8) : 3,
    goal: env.AGENT_GOAL || '',
  };
}

/**
 * LLM ポリシーを生成する。
 * @param {object} opts
 * @param {string} opts.model    ollama モデル名（既定: env OLLAMA_MODEL or "qwen2.5:7b"）
 * @param {boolean} opts.vision  true で screenshot を添付（vision モデル向け）
 * @param {number} opts.retries  リトライ回数（既定 2）
 * @param {number} opts.lookahead 先読み plan のステップ数（既定 env AGENT_LOOKAHEAD or 3、0 で無効）
 * @param {string} opts.goal     ゲーム固有の目標（既定 env AGENT_GOAL）
 * @returns {(obs:object)=>Promise<{buttons:string[],note:string}>}
 */
export function createLlmPolicy({ model, vision = false, retries = 2, lookahead, goal } = {}) {
  const mdl = model || process.env.OLLAMA_MODEL || 'qwen2.5:7b';
  const envOpts = promptOptionsFromEnv();
  const promptOpts = { lookahead: lookahead ?? envOpts.lookahead, goal: goal ?? envOpts.goal };
  // 直近の行動とその効果（画面/状態が変わったか）を保持し、空振りの繰り返しを抑止する (#11)
  const history = createActionHistory();
  const decide = async (obs) => {
    history.observe(observationKey(obs));
    const prompt = buildDecisionPrompt(obs, { vision, history: history.list(), ...promptOpts });

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        // 画像読取も try 内に置き、読取失敗でループ全体を落とさない
        const images =
          vision && obs.screenshotPath ? [imageToBase64(obs.screenshotPath)] : undefined;
        const resp = await ollamaGenerate({
          model: mdl,
          prompt,
          images,
          format: 'json',
          options: { temperature: 0.3, num_predict: promptOpts.lookahead > 0 ? 160 : 80 },
        });
        const d = parseDecision(extractJson(resp));
        // 有効ボタン、または有効 JSON かつ buttons 空配列（LLM の「何もしない」判断）→ 即返却
        if (d.valid) return { buttons: d.buttons, note: decisionNote(`LLM(${mdl})`, d), reason: d.reason };
        // それ以外（JSON 解析失敗・buttons 不在）はリトライ
      } catch (e) {
        if (attempt === retries) return { buttons: [], note: `LLM error: ${e.message}` };
      }
    }
    // 全リトライで有効ボタンが得られない場合は安全側（何も押さない）
    return { buttons: [], note: `LLM(${mdl}): no valid buttons` };
  };
  return async function llmPolicy(obs) {
    const { reason, ...dec } = await decide(obs);
    history.record(dec.buttons, reason ?? '');
    return dec;
  };
}
