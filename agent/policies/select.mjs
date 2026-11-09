// =============================================================
//  select.mjs ― 環境変数 POLICY から判断関数を選ぶ（play-loop / playthrough 共通）
//
//   POLICY=demo（既定）… 決定的デモ
//   POLICY=llm         … ローカル LLM(ollama)。OLLAMA_MODEL / OLLAMA_VISION=1
//   POLICY=claude      … Claude API（vision 既定 ON）。CLAUDE_MODEL / CLAUDE_VISION / CLAUDE_EFFORT (#11)
//  preflight() は起動前の疎通確認（毎ステップ失敗の空振り回避）。
// =============================================================
import { demoPolicy } from './demo-policy.mjs';
import { createLlmPolicy, promptOptionsFromEnv } from './llm-policy.mjs';
import { createClaudePolicy, claudeOptionsFromEnv, claudeCheck } from './claude-policy.mjs';
import { ollamaHasModel } from '../lib/ollama-client.mjs';

export const POLICY_KINDS = ['demo', 'llm', 'claude'];

/**
 * @returns {{kind:string, policy:Function, label:string, preflight:()=>Promise<{ok:boolean,error?:string}>}}
 */
export function selectPolicy(env = process.env) {
  const kind = env.POLICY || 'demo';
  if (kind === 'llm') {
    const mdl = env.OLLAMA_MODEL || 'qwen2.5:7b';
    const vision = env.OLLAMA_VISION === '1';
    const host = env.OLLAMA_HOST || 'http://127.0.0.1:11434';
    return {
      kind,
      policy: createLlmPolicy({ model: mdl, vision, ...promptOptionsFromEnv(env) }),
      label: `LLM(ollama ${mdl}${vision ? ', vision' : ''})`,
      preflight: async () => (await ollamaHasModel(mdl))
        ? { ok: true }
        : { ok: false, error: `ollama にモデル "${mdl}" が見つかりません（${host}）。ollama 起動と \`ollama pull ${mdl}\` を確認してください。` },
    };
  }
  if (kind === 'claude') {
    const o = claudeOptionsFromEnv(env);
    return {
      kind,
      policy: createClaudePolicy({ ...o, ...promptOptionsFromEnv(env) }),
      label: `Claude(${o.model}${o.vision ? ', vision' : ''}, effort=${o.effort})`,
      preflight: async () => {
        const r = await claudeCheck(o.model);
        return r.ok ? r : { ok: false, error: `Claude API に接続できません（model=${o.model}）: ${r.error}` };
      },
    };
  }
  if (kind !== 'demo') console.warn(`⚠ 未知の POLICY="${kind}"。demo を使います（${POLICY_KINDS.join('/')}）`);
  return { kind: 'demo', policy: demoPolicy, label: 'demo', preflight: async () => ({ ok: true }) };
}
