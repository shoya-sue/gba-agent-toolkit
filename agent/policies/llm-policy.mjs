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
import { ollamaGenerate, imageToBase64 } from '../lib/ollama-client.mjs';
import { VALID_BUTTONS } from './demo-policy.mjs';

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

const PROMPT_BASE =
  'You are an AI agent playing a Game Boy Advance game. Make progress in the game.\n' +
  'Valid buttons: A, B, Up, Down, Left, Right, Start, Select, L, R.\n' +
  'Decide which button(s) to press next (usually exactly one).\n' +
  'Respond ONLY with compact JSON: {"buttons":["A"],"reason":"short"}';

/**
 * LLM ポリシーを生成する。
 * @param {object} opts
 * @param {string} opts.model    ollama モデル名（既定: env OLLAMA_MODEL or "qwen2.5:7b"）
 * @param {boolean} opts.vision  true で screenshot を添付（vision モデル向け）
 * @param {number} opts.retries  リトライ回数（既定 2）
 * @returns {(obs:object)=>Promise<{buttons:string[],note:string}>}
 */
export function createLlmPolicy({ model, vision = false, retries = 2 } = {}) {
  const mdl = model || process.env.OLLAMA_MODEL || 'qwen2.5:7b';
  return async function llmPolicy(obs) {
    // title は ROM ヘッダ由来だが、念のため " をエスケープしてプロンプト境界を守る
    const title = String(obs.title || '').replace(/"/g, '\\"');
    const state =
      `Current state: frame=${obs.frame}, title="${title}".` +
      (vision ? '\nThe attached image is the current game screen (240x160).' : '');
    const prompt = `${PROMPT_BASE}\n${state}`;

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
          options: { temperature: 0.3, num_predict: 80 },
        });
        const parsed = extractJson(resp);
        const buttons = normalizeButtons(parsed?.buttons);
        if (buttons.length) {
          const reason = (parsed?.reason ?? '').toString().slice(0, 40);
          return { buttons, note: `LLM(${mdl}): ${reason}` };
        }
        // 有効 JSON かつ buttons が空配列 = LLM の「何もしない」判断 → 即返却（無駄リトライ回避）
        if (Array.isArray(parsed?.buttons)) {
          const reason = (parsed?.reason ?? '').toString().slice(0, 40);
          return { buttons: [], note: `LLM(${mdl}): no action (${reason})` };
        }
        // それ以外（JSON 解析失敗・buttons 不在）はリトライ
      } catch (e) {
        if (attempt === retries) return { buttons: [], note: `LLM error: ${e.message}` };
      }
    }
    // 全リトライで有効ボタンが得られない場合は安全側（何も押さない）
    return { buttons: [], note: `LLM(${mdl}): no valid buttons` };
  };
}
