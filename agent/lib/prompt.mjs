// =============================================================
//  lib/prompt.mjs ― 判断プロンプトと観測整形 (Issue #11)
//
//  LLM ポリシー（ollama / Claude）共通の「判断」用プロンプトを組み立てる
//  純粋ロジック。#8 の素朴なプロンプト（ボタン一覧＋frame/title のみ）を
//  以下で強化する:
//    - 状態要約   : observation.state（#12 の HP/座標/フラグ）を 1 行に整形
//    - 行動候補   : 各ボタンの一般的な意味（決定/キャンセル/移動/メニュー）を提示
//    - 直近履歴   : 直前 N ステップの行動と「その後に画面/状態が変わったか」
//                   → 効かない操作の繰り返し（素朴判断の典型的な失敗）を抑止
//    - 先読み     : 数ステップ先までの plan を出させ、その先頭を実行させる
//  すべて外部依存なし・決定的でユニットテスト可能。I/O（画像読取・ハッシュ計算）は
//  呼び出し側（ポリシー）が担う。
// =============================================================

/** 行動候補（ボタンと一般的な意味）。プロンプトに列挙して選択を促す。 */
export const ACTION_HINTS = [
  ['A', 'confirm / talk / advance text'],
  ['B', 'cancel / back / close menu'],
  ['Up', 'move up / previous menu item'],
  ['Down', 'move down / next menu item'],
  ['Left', 'move left'],
  ['Right', 'move right'],
  ['Start', 'open main menu / skip title screen'],
  ['Select', 'secondary menu (rarely needed)'],
  ['L', 'shoulder L (page switch etc.)'],
  ['R', 'shoulder R (page switch etc.)'],
];

/** 状態 1 値をプロンプト用の短い文字列にする（配列/オブジェクトは JSON、長すぎるものは切り詰め）。 */
function fmtValue(v) {
  const s = typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v ?? null);
  return s.length > 60 ? `${s.slice(0, 57)}...` : s;
}

/**
 * observation.state（#12）を 1 行の要約にする。null/空なら空文字。
 * キー順は安定化（ソート）し、最大 maxKeys 件まで。
 * @param {object|null} state
 * @param {{maxKeys?:number}} [opts]
 * @returns {string} 例: "hp=12, map=3, x=5"
 */
export function summarizeState(state, { maxKeys = 16 } = {}) {
  if (!state || typeof state !== 'object') return '';
  const keys = Object.keys(state).sort();
  const parts = keys.slice(0, maxKeys).map((k) => `${k}=${fmtValue(state[k])}`);
  if (keys.length > maxKeys) parts.push(`...(+${keys.length - maxKeys})`);
  return parts.join(', ');
}

/**
 * 直近の行動履歴。push で 1 ステップ分を記録し、次の観測で「その行動の後に
 * 画面/状態が変わったか」を確定させる（行動の効果は次の観測でしか分からないため）。
 * @param {{size?:number}} [opts] 保持する件数（既定 6）
 */
export function createActionHistory({ size = 6 } = {}) {
  const items = [];
  let lastSig = null;
  return {
    /**
     * 新しい観測を取り込み、直前の行動に effect を付ける。
     * @param {{screenHash?:string|null, stateKey?:string|null}} sig
     */
    observe(sig = {}) {
      const cur = { screenHash: sig.screenHash ?? null, stateKey: sig.stateKey ?? null };
      const last = items[items.length - 1];
      if (last && last.effect == null && lastSig) {
        const screen = lastSig.screenHash != null && cur.screenHash != null && lastSig.screenHash !== cur.screenHash;
        const state = lastSig.stateKey != null && cur.stateKey != null && lastSig.stateKey !== cur.stateKey;
        const known = (lastSig.screenHash != null && cur.screenHash != null) ||
          (lastSig.stateKey != null && cur.stateKey != null);
        last.effect = !known ? 'unknown' : (screen || state ? 'changed' : 'no-change');
      }
      lastSig = cur;
    },
    /** 今回の判断（押したボタン）を記録する。 */
    record(buttons = [], reason = '') {
      items.push({ buttons: [...buttons], reason: String(reason || '').slice(0, 60), effect: null });
      if (items.length > size) items.shift();
    },
    /** 直近履歴（古い順）。effect=null は「まだ結果未観測」。 */
    list() { return items.map((i) => ({ ...i })); },
  };
}

/** 履歴を「1. [A] -> screen changed」形式の行に整形する。 */
export function formatHistory(items = []) {
  return items.map((it, i) => {
    const b = it.buttons?.length ? it.buttons.join('+') : '(none)';
    const eff = it.effect === 'changed' ? 'screen/state changed'
      : it.effect === 'no-change' ? 'NO visible change'
        : it.effect === 'unknown' ? 'effect unknown' : 'pending';
    return `${i + 1}. [${b}] -> ${eff}${it.reason ? ` (${it.reason})` : ''}`;
  }).join('\n');
}

/**
 * 判断用プロンプトを組み立てる。
 * @param {object} obs  observation（frame/title/state 等）
 * @param {object} [o]
 * @param {boolean} [o.vision]   画面画像を添付するか
 * @param {Array}   [o.history]  createActionHistory().list() の結果
 * @param {number}  [o.lookahead] plan に出させるステップ数（既定 3, 0 で無効）
 * @param {string}  [o.goal]     ゲーム固有の目標（任意。例: "start a new game and reach the field"）
 * @returns {string}
 */
export function buildDecisionPrompt(obs = {}, { vision = false, history = [], lookahead = 3, goal = '' } = {}) {
  // title は ROM ヘッダ由来だが、念のため " をエスケープしてプロンプト境界を守る
  const title = String(obs.title || '').replace(/"/g, '\\"');
  const lines = [
    'You are an AI agent playing a Game Boy Advance game. Your job is to make real progress in the game',
    '(get past title screens and menus, advance dialogue, explore, complete objectives).',
    goal ? `Goal: ${String(goal).slice(0, 200)}` : null,
    '',
    'Available actions (button: typical meaning):',
    ...ACTION_HINTS.map(([b, m]) => `- ${b}: ${m}`),
    '',
    '## Current observation',
    `frame=${obs.frame ?? '?'}, title="${title}"`,
  ];
  const st = summarizeState(obs.state);
  if (st) lines.push(`game state (from RAM): ${st}`);
  if (vision) {
    lines.push('The attached image is the current game screen (240x160). First identify what kind of scene it is ' +
      '(title / menu / dialogue / field / battle / other) and where the cursor is.');
  } else {
    lines.push('No screen image is available; infer the scene from the state and the recent history.');
  }
  if (history.length) {
    lines.push('', '## Recent actions (oldest first) and their effect', formatHistory(history));
    const tail = history.slice(-3);
    if (tail.length >= 2 && tail.every((h) => h.effect === 'no-change')) {
      lines.push('WARNING: the last actions had NO visible effect. Do NOT repeat them; try a different button.');
    }
  }
  lines.push(
    '',
    '## Decide',
    'Usually press exactly one button per step (max 3 pressed together).',
  );
  if (lookahead > 0) {
    lines.push(`Think a few steps ahead: write a short plan of the next ${lookahead} button presses, ` +
      'then output the FIRST one as "buttons".');
    lines.push('Respond ONLY with compact JSON: ' +
      '{"scene":"menu","plan":["Down","A","A"],"buttons":["Down"],"reason":"short"}');
  } else {
    lines.push('Respond ONLY with compact JSON: {"buttons":["A"],"reason":"short"}');
  }
  return lines.filter((l) => l != null).join('\n');
}
