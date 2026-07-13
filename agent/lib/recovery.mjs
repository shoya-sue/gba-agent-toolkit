#!/usr/bin/env node
// =============================================================
//  lib/recovery.mjs ― スタック/クラッシュからの自己修復ロジック (Epic #13 / #16)
//
//  自律プレイ中に「詰まり(#15 の stuck 信号) / 切断・クラッシュ」が起きても、
//  自己修復して再トライし、完走まで自立稼働させるための**純粋な意思決定ロジック**。
//  実際の副作用（別入力送信・セーブステート復帰・reset・セッション再起動）は
//  playthrough.mjs 側の executor が担い、本モジュールは「次に何を試すか」だけを決める。
//
//  リカバリ戦略（エスカレーション順・#16 のタスク定義に対応）:
//    1. alt-input       … 別の入力を試す（探索・メニューループ脱出）
//    2. load-state      … 直近セーブステート(checkpoint)から復帰してやり直す
//    3. reset           … ソフトリセット
//    4. restart-session … stop-session.sh → start-session.sh（最重量・ROM必須で opt-in）
//  同一エピソードでは軽い戦略から順に試し、リトライ上限で give-up（無限ループ防止）。
//  すべて決定的・外部依存なしでユニットテスト可能。
// =============================================================

/** リカバリ戦略のエスカレーション順（軽い→重い）。 */
export const RECOVERY_LADDER = ['alt-input', 'load-state', 'reset', 'restart-session'];

/** 探索で試す入力セット（詰まり脱出の定番手）。すべて VALID_BUTTONS 内。 */
const EXPLORATION_SETS = [
  ['A'], ['B'], ['Start'], ['Down'], ['Right'], ['Up'], ['Left'], ['B', 'B'], ['A', 'A'],
];

/**
 * 探索用の入力セットを決定的に返す（seed で巡回）。immutable にコピーを返す。
 * @param {number} seed 試行回数など（負値も安全に正規化）
 * @returns {string[]}
 */
export function explorationButtons(seed) {
  const n = EXPLORATION_SETS.length;
  const i = ((Math.trunc(seed) % n) + n) % n;
  return EXPLORATION_SETS[i].slice();
}

/**
 * これまでのエピソード内試行回数から次の戦略を返す（エスカレーション）。
 * enabled 指定時はその戦略のみを対象にする（例: ROM 無しなら restart-session を除外）。
 * @returns {string|null} 使い切ったら null（give-up）
 */
export function nextRecoveryStrategy(attempt, { ladder = RECOVERY_LADDER, enabled } = {}) {
  const active = enabled ? ladder.filter((s) => enabled.includes(s)) : ladder;
  return attempt >= 0 && attempt < active.length ? active[attempt] : null;
}

/** 指数バックオフ（上限つき）。試行が進むほど待ち時間を伸ばす。 */
export function backoffMs(attempt, { base = 500, factor = 2, max = 8000 } = {}) {
  const a = Math.max(0, Math.trunc(attempt));
  return Math.min(base * Math.pow(factor, a), max);
}

/**
 * リカバリ制御。エピソード内試行数・総試行数を追跡し、
 * 「次にどの戦略を、どれだけ待って試すか」または「give-up」を決める。
 * @param {{maxPerEpisode?:number, maxTotal?:number, ladder?:string[]}} opts
 */
export function createRecoveryController({
  maxPerEpisode = RECOVERY_LADDER.length,
  maxTotal = 12,
  ladder = RECOVERY_LADDER,
} = {}) {
  let episode = 0; // 現在の詰まり/失敗エピソード内での試行回数
  let total = 0;   // ラン全体でのリカバリ試行回数
  return {
    /**
     * スタック/失敗を検出したときに呼ぶ。次の戦略プランを返し、カウンタを進める。
     * @param {{enabled?:string[]}} o enabled=有効な戦略（未指定なら全戦略）
     * @returns {{giveUp:boolean, reason?:string, strategy:string|null,
     *            backoffMs?:number, episodeAttempt?:number, totalAttempt?:number}}
     */
    onStuck({ enabled } = {}) {
      if (total >= maxTotal) return { giveUp: true, reason: 'max-total-recoveries', strategy: null };
      const active = enabled ? ladder.filter((s) => enabled.includes(s)) : ladder;
      const cap = Math.min(maxPerEpisode, active.length);
      if (episode >= cap) return { giveUp: true, reason: 'episode-exhausted', strategy: null };
      const strategy = active[episode];
      const plan = {
        giveUp: false,
        strategy,
        backoffMs: backoffMs(episode),
        episodeAttempt: episode + 1,
        totalAttempt: total + 1,
      };
      episode++;
      total++;
      return plan;
    },
    /** 進捗が再開したら呼ぶ。エピソード内カウンタをリセット（次の詰まりに備える）。 */
    onProgress() { episode = 0; },
    get episodeAttempts() { return episode; },
    get totalAttempts() { return total; },
  };
}
