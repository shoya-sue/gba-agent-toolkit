// =============================================================
//  demo-policy.mjs ― サンプル「判断（policy）」実装
//
//  知覚→判断→行動ループの「判断」部分。observation を受け取り、
//  次に押すボタン列を返す純粋関数として定義する。
//
//  ★ ここが将来ローカル LLM に差し替わる拡張ポイント ★
//  observation.screenshotPath の画像と observation.info を LLM に渡し、
//  「次に押すべきボタン」を推論させる llmPolicy に置き換えれば、
//  ハーネス本体（play-loop.mjs）は無改造で自律プレイに移行できる。
// =============================================================

/**
 * デモ用の決定的ポリシー。実ゲームの意味判断はせず、
 * ループ機構（知覚→判断→行動）が回ることを示すためのスクリプト。
 * @param {{step:number, frame:number, title:string, screenshotPath:string}} obs
 * @returns {{buttons:string[], note:string}}
 */
export function demoPolicy(obs) {
  // ステップに応じて代表的な入力を巡回させる（決定的＝再現可能）
  const sequence = [
    { buttons: ['Start'], note: 'メニュー/ポーズ想定' },
    { buttons: ['A'], note: '決定' },
    { buttons: ['Right'], note: '移動(右)' },
    { buttons: ['Right'], note: '移動(右)' },
    { buttons: ['B'], note: 'キャンセル/走る' },
    { buttons: ['Down'], note: '移動(下)' },
  ];
  return sequence[obs.step % sequence.length];
}

/**
 * ローカル LLM 差し替えの雛形（未接続）。
 * 実装時は screenshotPath を base64 で読み、Claude/ローカル LLM に
 * 「この画面で次に押すべき GBA ボタンを JSON で返せ」と問い合わせる。
 * @returns {Promise<{buttons:string[], note:string}>}
 */
export async function llmPolicyStub(/* obs, { callModel } */) {
  throw new Error(
    'llmPolicyStub は未接続です。observation.screenshotPath を LLM に渡し ' +
    '{buttons:[...]} を推論する実装に置き換えてください。'
  );
}

/** 有効な GBA ボタン名（policy の返り値検証用） */
export const VALID_BUTTONS = ['A', 'B', 'Up', 'Down', 'Left', 'Right', 'Start', 'Select', 'L', 'R'];
