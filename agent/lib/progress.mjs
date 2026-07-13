#!/usr/bin/env node
// =============================================================
//  lib/progress.mjs ― 進捗・完走判定 (Epic #13 / #15)
//
//  「ゲームが進んでいるか（進捗）」「完結したか（完走）」を判定する
//  純粋ロジック。playthrough.mjs（#14 ハーネス）へ組み込み、
//  スタック検出（#16 リカバリの入力）と E2E 合否（#17）の根拠にする。
//
//  設計の要点:
//    - 実 mGBA はリアルタイム進行するため frame は常に増える。静止メニューでも
//      frame は進むので、**frame の増加"だけ"では進捗と見なさない**。
//      進捗の主信号は「画面内容(PNGハッシュ) / ゲーム状態(#12) / title の変化」。
//      frame の"停止"は逆にエミュ凍結の兆候 → frameFrozen で別途通知する。
//    - 状態(#12: HP/座標/フラグ)や完結条件はゲーム依存 → プラガブルにして
//      観測(observation)へ後付けできる形にする。本モジュールは純粋・同期で、
//      副作用（メモリ読取・ファイル I/O）は呼び出し側（ハーネス）が担う。
//  すべて外部依存なし・決定的でユニットテスト可能。
// =============================================================

/** a と b が両方非 null かつ異なるとき true（片方 null は「不明」で変化扱いしない）。 */
function changed(a, b) {
  return a != null && b != null && a !== b;
}

/**
 * バイト列の FNV-1a 32bit ハッシュ（8桁hex）。画面 PNG の変化検出に使う。
 * 決定的・依存なし。「画面が変わったか」を安価に判定するための署名。
 * @param {Uint8Array|Buffer|number[]} bytes
 * @returns {string} 8桁の16進文字列
 */
export function hashBytes(bytes) {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i] & 0xff;
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * 観測から進捗比較用の署名を作る（null 正規化）。
 * @param {{frame?:number, title?:string, screenHash?:string, stateKey?:string}} o
 * @returns {{frame:number|null, title:string|null, screenHash:string|null, stateKey:string|null}}
 */
export function observationSignature(o = {}) {
  return {
    frame: o.frame ?? null,
    title: o.title ?? null,
    screenHash: o.screenHash ?? null,
    stateKey: o.stateKey ?? null,
  };
}

/**
 * 直前署名 prev と現署名 curr を比較して進捗を判定する。
 * 進捗 = 画面 / 状態 / title のいずれかが変化。frame 停止は frameFrozen で別途通知。
 * @returns {{progressed:boolean, reasons:string[], frameFrozen:boolean}}
 */
export function detectProgress(prev, curr) {
  if (!prev) return { progressed: true, reasons: ['first'], frameFrozen: false };
  const reasons = [];
  if (changed(prev.screenHash, curr.screenHash)) reasons.push('screen');
  if (changed(prev.stateKey, curr.stateKey)) reasons.push('state');
  if (changed(prev.title, curr.title)) reasons.push('title');
  const frameFrozen = prev.frame != null && curr.frame != null && curr.frame === prev.frame;
  return { progressed: reasons.length > 0, reasons, frameFrozen };
}

/**
 * 進捗トラッカー。ステップ毎に署名を update し、無進捗の連続数と
 * スタック判定（stuckAfter 連続で無進捗）を返す。
 * @param {{stuckAfter?:number}} opts stuckAfter=スタックと見なす連続無進捗数
 */
export function createProgressTracker({ stuckAfter = 12 } = {}) {
  let prev = null;
  let noProgress = 0;
  let frozen = 0;
  return {
    /**
     * @returns {{progressed:boolean, reasons:string[], frameFrozen:boolean,
     *            noProgressStreak:number, frozenStreak:number, stuck:boolean}}
     */
    update(sig) {
      const res = detectProgress(prev, sig);
      noProgress = res.progressed ? 0 : noProgress + 1;
      frozen = res.frameFrozen ? frozen + 1 : 0;
      prev = sig;
      return {
        ...res,
        noProgressStreak: noProgress,
        frozenStreak: frozen,
        stuck: noProgress >= stuckAfter,
      };
    },
    get noProgressStreak() { return noProgress; },
    get frozenStreak() { return frozen; },
  };
}

/**
 * 完結条件を評価する。conditions は {name, test:(observation)=>boolean} の配列。
 * test が例外を投げても検出全体は落とさない（1条件の不備で完走判定を壊さない）。
 * @returns {{completed:boolean, matched:string[]}}
 */
export function evaluateCompletion(observation, conditions = []) {
  const matched = [];
  for (const c of conditions) {
    if (!c || typeof c.test !== 'function') continue;
    let ok = false;
    try { ok = !!c.test(observation); } catch { ok = false; }
    if (ok) matched.push(c.name ?? 'unnamed');
  }
  return { completed: matched.length > 0, matched };
}

// ─────────── 完結条件ビルダー（ゲーム依存の完走定義） ───────────

/** title に substr を含んだら完結（例: エンディングで title が変わるゲーム）。 */
export function titleContains(substr, name) {
  return {
    name: name ?? `title~${substr}`,
    test: (o) => typeof o?.title === 'string' && o.title.includes(substr),
  };
}

/**
 * observation.state[key] が value と一致（文字列比較）で完結。
 * #12（状態アドレス読取）でクリアフラグ等を observation.state に載せて使う。
 * 値は env 由来が文字列、状態読取が数値になり得るため String 化して比較する。
 */
export function stateEquals(key, value, name) {
  return {
    name: name ?? `state.${key}==${value}`,
    test: (o) => o?.state != null && key in o.state && String(o.state[key]) === String(value),
  };
}

/** 画面ハッシュが既知のエンディング画面ハッシュ集合に入ったら完結。 */
export function screenHashIn(hashes, name = 'screen∈ending') {
  const set = new Set(hashes);
  return { name, test: (o) => o?.screenHash != null && set.has(o.screenHash) };
}

/**
 * env ライクなオブジェクトから完結条件を組み立てる（プラガブル設定の入口）。
 *   COMPLETE_TITLE_CONTAINS="THE END"            → titleContains
 *   COMPLETE_STATE="cleared=1"                   → stateEquals('cleared','1')（#12連携）
 *   COMPLETE_SCREEN_HASHES="ab12cd34,ff001122"   → screenHashIn
 * @param {Record<string,string>} env
 * @returns {Array<{name:string, test:Function}>}
 */
export function parseCompletionConditions(env = {}) {
  const conds = [];
  if (env.COMPLETE_TITLE_CONTAINS) conds.push(titleContains(env.COMPLETE_TITLE_CONTAINS));
  if (env.COMPLETE_STATE) {
    const [k, v] = String(env.COMPLETE_STATE).split('=');
    if (k && k.trim()) conds.push(stateEquals(k.trim(), (v ?? '').trim()));
  }
  if (env.COMPLETE_SCREEN_HASHES) {
    const hs = String(env.COMPLETE_SCREEN_HASHES).split(',').map((s) => s.trim()).filter(Boolean);
    if (hs.length) conds.push(screenHashIn(hs));
  }
  return conds;
}
