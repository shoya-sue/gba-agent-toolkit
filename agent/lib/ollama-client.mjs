// =============================================================
//  ollama-client.mjs ― ローカル LLM(ollama) の最小 HTTP クライアント
//
//  ollama の /api/generate を叩き、テキスト（＋ vision モデル向けに画像）
//  を渡して推論結果を得る。LLM ポリシー（判断）の実接続に使う。
//  ollama 既定エンドポイント: http://127.0.0.1:11434
// =============================================================
import { readFileSync } from 'node:fs';

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';

/**
 * ollama /api/generate を呼ぶ。
 * @param {object} o
 * @param {string} o.model    モデル名（例 "qwen2.5:7b" / "moondream"）
 * @param {string} o.prompt   プロンプト
 * @param {string[]} [o.images] 画像(base64・data URI 不可の生 base64)の配列（vision モデル用）
 * @param {"json"|undefined} [o.format] "json" で JSON 出力を強制
 * @param {object} [o.options] ollama options（temperature/num_predict 等）
 * @param {number} [o.timeoutMs]
 * @returns {Promise<string>} モデルの応答テキスト
 */
export async function ollamaGenerate({ model, prompt, images, format, options, timeoutMs = 60000 }) {
  const body = { model, prompt, stream: false };
  if (images && images.length) body.images = images;
  if (format) body.format = format;
  if (options) body.options = options;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${OLLAMA_HOST}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`ollama HTTP ${res.status}: ${await res.text()}`);
    const json = await res.json();
    return json.response || '';
  } finally {
    clearTimeout(t);
  }
}

/** 画像ファイルを ollama 用の生 base64 に変換する。 */
export function imageToBase64(path) {
  if (!path) throw new Error('imageToBase64: path が空です');
  return readFileSync(path).toString('base64');
}

/** ollama が起動しており、指定モデルが存在するか確認する。 */
export async function ollamaHasModel(model) {
  try {
    const res = await fetch(`${OLLAMA_HOST}/api/tags`);
    if (!res.ok) return false;
    const { models = [] } = await res.json();
    return models.some((m) => m.name === model || m.name.startsWith(model + ':') || m.model === model);
  } catch {
    return false;
  }
}
