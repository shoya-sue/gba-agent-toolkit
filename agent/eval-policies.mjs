#!/usr/bin/env node
// =============================================================
//  eval-policies.mjs ― 判断ポリシーの同一シーン比較評価 (Issue #11)
//
//  同じセーブステート（同一シーン）から複数の判断ポリシーを N ステップずつ走らせ、
//  「どれだけゲームが進んだか」を同じ物差しで比較する。text ベースライン
//  (llm/qwen2.5 等) と vision モデル (moondream / llama3.2-vision / qwen2.5vl) /
//  Claude の判断品質比較に使う。
//
//  進行度の指標（#15 progress / #12 state を再利用）:
//    - uniqueScreens : 訪れた相異なる画面（PNG ハッシュ）数 … 主指標（探索・進行の幅）
//    - progressSteps : 画面/状態/title が変化したステップ数（操作が効いた回数）
//    - maxNoProgress : 最長の無進捗連続（空振り・詰まりの深さ。小さいほど良い）
//    - reward        : STATE_MAP の reward 合計（#12・指定時のみ）
//    - noop / errors : 何も押さなかった / 判断エラーのステップ数
//
//  前提: mGBA + bridge.lua 稼働（launcher/start-session.sh --rom <ROM>）。
//  使い方: node agent/eval-policies.mjs [steps]
//    EVAL_POLICIES="demo,llm@qwen2.5:7b,llm@moondream+vision,claude@claude-opus-5-5"
//       各要素 = kind[@model][+vision|+text]（kind: demo|llm|claude。claude は既定 vision）
//    EVAL_FROM_SLOT=<n>  既存セーブステート slot n を評価シーンにする（未指定なら現在の
//                        画面を EVAL_SLOT(既定 9) に保存してシーンとする）
//    EVAL_REPEATS(既定1) / STEP_DELAY_MS(既定250) / STATE_MAP / AGENT_GOAL / AGENT_LOOKAHEAD
//    出力: runs/eval-<ts>/report.json（＋各ステップ JSONL）。runs/ は .gitignore 済み。
// =============================================================
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MgbaMcpClient, sleep } from './lib/mcp-client.mjs';
import { VALID_BUTTONS } from './policies/demo-policy.mjs';
import { selectPolicy } from './policies/select.mjs';
import { createProgressTracker, hashBytes, observationSignature } from './lib/progress.mjs';
import { readState, parseStateMap, stateSignature, computeReward } from './lib/state.mjs';

// ─────────── 純粋ヘルパー（ユニットテスト対象） ───────────

/**
 * EVAL_POLICIES 文字列を仕様配列にする。
 * @param {string} src 例 "demo,llm@qwen2.5:7b,llm@moondream+vision,claude"
 * @returns {Array<{kind:string, model:string|null, vision:boolean|null, id:string}>}
 */
export function parsePolicySpecs(src = '') {
  return String(src).split(',').map((s) => s.trim()).filter(Boolean).map((raw) => {
    let rest = raw;
    let vision = null;
    const m = rest.match(/\+(vision|text)$/);
    if (m) { vision = m[1] === 'vision'; rest = rest.slice(0, -m[0].length); }
    const at = rest.indexOf('@');
    const kind = (at >= 0 ? rest.slice(0, at) : rest).trim();
    const model = at >= 0 ? rest.slice(at + 1).trim() || null : null;
    return { kind, model, vision, id: raw };
  });
}

/** 仕様を selectPolicy に渡す env 上書きへ変換する（ベース env は維持）。 */
export function specToEnv(spec, base = {}) {
  const env = { ...base, POLICY: spec.kind };
  if (spec.kind === 'llm') {
    if (spec.model) env.OLLAMA_MODEL = spec.model;
    if (spec.vision != null) env.OLLAMA_VISION = spec.vision ? '1' : '0';
  } else if (spec.kind === 'claude') {
    if (spec.model) env.CLAUDE_MODEL = spec.model;
    if (spec.vision != null) env.CLAUDE_VISION = spec.vision ? '1' : '0';
  }
  return env;
}

/**
 * 1 試行のステップ記録から指標を集計する。
 * @param {Array<{screenHash?:string|null, progressed?:boolean, noProgressStreak?:number,
 *   buttons?:string[], note?:string, reward?:number, decideMs?:number}>} steps
 */
export function summarizeTrial(steps = []) {
  const screens = new Set();
  const buttonCounts = {};
  let progressSteps = 0, maxNoProgress = 0, noop = 0, errors = 0, reward = 0, decideMs = 0;
  for (const s of steps) {
    if (s.screenHash) screens.add(s.screenHash);
    if (s.progressed) progressSteps++;
    if ((s.noProgressStreak ?? 0) > maxNoProgress) maxNoProgress = s.noProgressStreak;
    const b = Array.isArray(s.buttons) ? s.buttons : [];
    if (!b.length) noop++;
    for (const x of b) buttonCounts[x] = (buttonCounts[x] ?? 0) + 1;
    if (/error/i.test(s.note ?? '')) errors++;
    reward += Number.isFinite(s.reward) ? s.reward : 0;
    decideMs += Number.isFinite(s.decideMs) ? s.decideMs : 0;
  }
  return {
    steps: steps.length,
    uniqueScreens: screens.size,
    progressSteps,
    maxNoProgress,
    reward: Math.round(reward * 100) / 100,
    noop,
    errors,
    avgDecideMs: steps.length ? Math.round(decideMs / steps.length) : 0,
    buttonCounts,
  };
}

/** 複数試行の指標を平均する（buttonCounts は合算）。 */
export function averageTrials(trials = []) {
  if (!trials.length) return summarizeTrial([]);
  const keys = ['steps', 'uniqueScreens', 'progressSteps', 'maxNoProgress', 'reward', 'noop', 'errors', 'avgDecideMs'];
  const out = { trials: trials.length, buttonCounts: {} };
  for (const k of keys) out[k] = Math.round((trials.reduce((a, t) => a + (t[k] ?? 0), 0) / trials.length) * 100) / 100;
  for (const t of trials) for (const [b, n] of Object.entries(t.buttonCounts ?? {})) out.buttonCounts[b] = (out.buttonCounts[b] ?? 0) + n;
  return out;
}

/** 進行度で順位付けする: reward → uniqueScreens → progressSteps の降順、maxNoProgress の昇順。 */
export function rankResults(results = []) {
  return [...results].sort((a, b) =>
    (b.metrics.reward - a.metrics.reward) ||
    (b.metrics.uniqueScreens - a.metrics.uniqueScreens) ||
    (b.metrics.progressSteps - a.metrics.progressSteps) ||
    (a.metrics.maxNoProgress - b.metrics.maxNoProgress));
}

/** 結果を Markdown 表にする（docs/ への転記用）。 */
export function formatTable(results = []) {
  const head = '| # | policy | 画面数 | 進捗step | 最長無進捗 | reward | 無操作 | エラー | 判断ms |\n|---|---|---|---|---|---|---|---|---|';
  const rows = rankResults(results).map((r, i) => {
    const m = r.metrics;
    return `| ${i + 1} | ${r.label} | ${m.uniqueScreens} | ${m.progressSteps}/${m.steps} | ${m.maxNoProgress} | ${m.reward} | ${m.noop} | ${m.errors} | ${m.avgDecideMs} |`;
  });
  return [head, ...rows].join('\n');
}

// ─────────── ランナー本体（副作用あり・CLI から実行） ───────────

async function runTrial(client, { policy, steps, slot, delayMs, stateMap, logFile }) {
  await client.loadState(slot);
  await sleep(300);
  const tracker = createProgressTracker({ stuckAfter: Number.MAX_SAFE_INTEGER });
  const records = [];
  let prevState = null;
  for (let step = 0; step < steps; step++) {
    const info = await client.getInfo();
    const shot = await client.screenshot();
    const screenHash = shot && existsSync(shot) ? hashBytes(readFileSync(shot)) : null;
    let gameState = null, reward = 0;
    if (stateMap?.descriptors.length) {
      try {
        gameState = await readState(client, stateMap.descriptors);
        if (prevState) reward = computeReward(prevState, gameState, stateMap.rewardSpec).total;
        prevState = gameState;
      } catch { gameState = null; }
    }
    const prog = tracker.update(observationSignature({
      frame: info.frame, title: info.title, screenHash,
      stateKey: stateSignature(gameState, stateMap?.signatureKeys),
    }));
    const observation = { step, frame: info.frame, title: info.title, screenshotPath: shot, screenHash, state: gameState };
    const t0 = Date.now();
    let dec;
    try { dec = await policy(observation); } catch (e) { dec = { buttons: [], note: `policy error: ${e.message}` }; }
    const decideMs = Date.now() - t0;
    const buttons = Array.isArray(dec?.buttons) ? dec.buttons.filter((b) => VALID_BUTTONS.includes(b)) : [];
    if (buttons.length) await client.pressButtons(buttons);
    await sleep(delayMs);
    const rec = {
      step, frame: info.frame, screenHash, progressed: prog.progressed, reasons: prog.reasons,
      noProgressStreak: prog.noProgressStreak, buttons, note: dec?.note ?? '', reward, decideMs,
      ...(gameState ? { state: gameState } : {}),
    };
    records.push(rec);
    appendFileSync(logFile, JSON.stringify(rec) + '\n');
    console.log(`  step ${step}: ${prog.progressed ? '▲' : '・'} [${buttons.join('+') || '-'}] ${rec.note}`);
  }
  return summarizeTrial(records);
}

async function main() {
  const steps = parseInt(process.argv[2] || '20', 10);
  const specs = parsePolicySpecs(process.env.EVAL_POLICIES || 'demo,llm');
  const repeats = Math.max(1, parseInt(process.env.EVAL_REPEATS || '1', 10));
  const delayMs = parseInt(process.env.STEP_DELAY_MS || '250', 10);
  const fromSlot = process.env.EVAL_FROM_SLOT;
  const slot = parseInt(fromSlot ?? process.env.EVAL_SLOT ?? '9', 10);
  let stateMap = null;
  if (process.env.STATE_MAP) {
    try { stateMap = parseStateMap(readFileSync(process.env.STATE_MAP, 'utf8')); }
    catch (e) { console.warn(`⚠ state-map 読込失敗: ${e.message}`); }
  }

  const client = new MgbaMcpClient();
  await client.connect();
  if (!/pong/i.test(await client.ping())) {
    console.error('✗ bridge に接続できません。launcher/start-session.sh で起動してください。');
    client.close();
    process.exit(2);
  }
  if (fromSlot == null) {
    await client.saveState(slot);
    console.log(`📌 現在のシーンを slot ${slot} に保存（全ポリシー共通の開始点）`);
  }

  const outDir = join(process.cwd(), 'runs', `eval-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  mkdirSync(outDir, { recursive: true });
  const results = [];
  for (const spec of specs) {
    const env = specToEnv(spec, process.env);
    const { label, preflight } = selectPolicy(env);
    const pre = await preflight();
    if (!pre.ok) {
      console.warn(`⚠ ${spec.id}: スキップ（${pre.error}）`);
      results.push({ id: spec.id, label, skipped: pre.error, metrics: averageTrials([]) });
      continue;
    }
    const trials = [];
    for (let r = 0; r < repeats; r++) {
      console.log(`▶ ${label}  試行 ${r + 1}/${repeats}（${steps} ステップ, slot ${slot} から）`);
      // 試行毎に新しいポリシー（履歴をリセット）
      const { policy } = selectPolicy(env);
      const logFile = join(outDir, `${spec.id.replace(/[^\w.@+-]/g, '_')}.t${r}.jsonl`);
      trials.push(await runTrial(client, { policy, steps, slot, delayMs, stateMap, logFile }));
    }
    results.push({ id: spec.id, label, trials, metrics: averageTrials(trials) });
  }
  // 評価後はシーンを開始点に戻しておく
  try { await client.loadState(slot); } catch { /* noop */ }

  const scored = results.filter((r) => !r.skipped);
  const report = { createdAt: new Date().toISOString(), steps, repeats, slot, policies: specs.map((s) => s.id), results };
  writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`\n${formatTable(scored)}`);
  console.log(`\n✓ 比較評価完了 → ${join(outDir, 'report.json')}`);
  client.close();
  await sleep(100);
  process.exit(0);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((e) => { console.error('FATAL', e); process.exit(2); });
}
