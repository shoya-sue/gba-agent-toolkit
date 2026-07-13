// =============================================================
//  demo-policy.mjs ― 決定的な「判断（policy）」デモ実装
//
//  知覚→判断→行動ループの「判断」部分の最小例。observation を受け取り、
//  次に押すボタン列を返す純粋関数。実ゲームの意味判断はしない。
//
//  ローカル LLM による実「判断」は policies/llm-policy.mjs を参照
//  （play-loop.mjs を POLICY=llm で起動すると自律プレイになる）。
//  VALID_BUTTONS は llm-policy / play-loop の入力検証でも共有される。
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

/** 有効な GBA ボタン名（policy の返り値検証用） */
export const VALID_BUTTONS = ['A', 'B', 'Up', 'Down', 'Left', 'Right', 'Start', 'Select', 'L', 'R'];
