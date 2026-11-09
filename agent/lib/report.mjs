// =============================================================
//  report.mjs ― E2E 完走シナリオ + 合否レポート（純粋ロジック, Epic #13 / #17）
//
//  playthrough.mjs（#14 ハーネス + #15 進捗/完走判定 + #16 self-healing）の
//  実行記録 runs/<id>/（meta.json・steps.jsonl・screenshots/）と
//  完走シナリオ定義（agent/scenarios/*.json）から **合否レポート** を組み立てる。
//
//    - parseScenario      : シナリオ JSON を正規化（対象ゲーム・想定フロー・マイルストーン・完結条件・実行設定）
//    - scenarioEnv        : シナリオ → playthrough.mjs 用 env（明示 env が優先）
//    - hasCompletionCondition : 完結条件が 1 つ以上あるか（無ければ PASS 不可能 → 前提不足）
//    - evaluateMilestones : steps.jsonl を走査し「どこまで到達したか」を判定
//    - buildReport        : 合否（PASS=完結到達のみ）・停止理由・到達点・リカバリ回数・所要・スクショ/ログ
//    - renderReportMarkdown : 人間向け report.md
//
//  副作用なし（ファイル I/O は呼び出し側 scripts/verify-playthrough.mjs）。CI で unit 実行。
// =============================================================
import { titleContains, stateEquals, screenHashIn } from './progress.mjs';

/** 停止理由 → 人間向け説明（FAIL 時にレポートへ残す）。 */
export const STOP_REASON_TEXT = {
  completed: '完結条件に到達（クリア / エンディング）',
  'max-steps': 'ステップ上限に到達（完結前に打ち切り）',
  'time-budget': '時間上限に到達（完結前に打ち切り）',
  interrupted: '中断シグナル（Ctrl+C 等）で停止',
  'too-many-failures': 'bridge 切断・RPC 失敗が連続し上限超過（自己修復で復帰できず）',
  stuck: '無進捗が STUCK_ABORT_STEPS 継続（自己修復でも解消せず）',
  'no-summary': 'ハーネスが finalize 前に異常終了（meta.json の summary 無し）',
};

/**
 * 完走シナリオ JSON を正規化する。
 *   { game, flow[], milestones[{name, titleContains|state{field,equals}|screenHashes[]}],
 *     completion{titleContains, state:"k=v", screenHashes[]}, stateMap, run{...} }
 */
export function parseScenario(src) {
  const s = typeof src === 'string' ? JSON.parse(src) : (src ?? {});
  const c = s.completion ?? {};
  const r = s.run ?? {};
  const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  return {
    game: s.game ?? null,
    flow: Array.isArray(s.flow) ? s.flow.map(String) : [],
    milestones: (Array.isArray(s.milestones) ? s.milestones : [])
      .filter((m) => m && (m.titleContains || m.state || m.screenHashes))
      .map((m, i) => ({ ...m, name: m.name ?? `milestone${i + 1}` })),
    completion: {
      titleContains: c.titleContains ?? null,
      state: c.state ?? null,
      screenHashes: Array.isArray(c.screenHashes) ? c.screenHashes.filter(Boolean) : [],
    },
    stateMap: s.stateMap ?? null,
    run: {
      maxSteps: num(r.maxSteps),
      maxSeconds: num(r.maxSeconds),
      policy: r.policy ?? null,
      env: r.env && typeof r.env === 'object' ? r.env : {},
    },
  };
}

/**
 * シナリオから playthrough.mjs 用 env を作る。baseEnv（= process.env）に既に
 * 値がある項目は上書きしない（コマンドラインでの一時上書きを優先）。
 */
export function scenarioEnv(scenario, baseEnv = {}) {
  const out = {};
  const set = (k, v) => {
    if (v == null || v === '') return;
    if (baseEnv[k] != null && baseEnv[k] !== '') return;
    out[k] = String(v);
  };
  for (const [k, v] of Object.entries(scenario.run.env)) set(k, v);
  set('COMPLETE_TITLE_CONTAINS', scenario.completion.titleContains);
  set('COMPLETE_STATE', scenario.completion.state);
  if (scenario.completion.screenHashes.length) set('COMPLETE_SCREEN_HASHES', scenario.completion.screenHashes.join(','));
  set('STATE_MAP', scenario.stateMap);
  set('POLICY', scenario.run.policy);
  set('MAX_SECONDS', scenario.run.maxSeconds);
  set('STEPS', scenario.run.maxSteps);
  return out;
}

/**
 * 実効 env（+ state-map の completion 件数）に完結条件が 1 つ以上あるか。
 * 無い場合は「完結到達」を判定できず PASS になり得ないので、ランナーは前提不足で止める。
 */
export function hasCompletionCondition(env = {}, stateMapCompletionCount = 0) {
  return !!(env.COMPLETE_TITLE_CONTAINS || env.COMPLETE_STATE || env.COMPLETE_SCREEN_HASHES
    || stateMapCompletionCount > 0);
}

function milestoneCondition(m) {
  if (m.titleContains) return titleContains(m.titleContains, m.name);
  if (m.state) return stateEquals(m.state.field, m.state.equals, m.name);
  return screenHashIn(m.screenHashes, m.name);
}

/**
 * steps.jsonl のエントリ列からマイルストーン到達を判定する。
 * 各マイルストーンの初回到達ステップを記録し、定義順で最も先まで到達したものを「到達点」とする。
 * @returns {{reached:Array<{name,step}>, missed:string[], furthest:{name,step,index}|null, total:number}}
 */
export function evaluateMilestones(steps = [], milestones = []) {
  const conds = milestones.map(milestoneCondition);
  const firstStep = new Array(milestones.length).fill(null);
  for (const e of steps) {
    if (!e || !e.ok) continue;
    const obs = { title: e.title, state: e.state, screenHash: e.screenHash };
    conds.forEach((c, i) => {
      if (firstStep[i] != null) return;
      let ok = false;
      try { ok = !!c.test(obs); } catch { ok = false; }
      if (ok) firstStep[i] = e.step;
    });
  }
  const reached = [];
  const missed = [];
  let furthest = null;
  milestones.forEach((m, i) => {
    if (firstStep[i] != null) {
      reached.push({ name: m.name, step: firstStep[i] });
      furthest = { name: m.name, step: firstStep[i], index: i };
    } else {
      missed.push(m.name);
    }
  });
  return { reached, missed, furthest, total: milestones.length };
}

/**
 * 合否レポートを組み立てる。PASS は「summary.completed かつ stopReason=completed」のみ。
 * それ以外（上限打ち切り・切断・stuck・異常終了）は FAIL とし、理由と到達点を残す。
 * @param {{meta:{config?,summary?}|null, steps:object[], scenario?:object, runDir?:string,
 *          screenshots?:string[], harnessExitCode?:number|null}} p
 */
export function buildReport({ meta, steps = [], scenario = null, runDir = null, screenshots = [], harnessExitCode = null }) {
  const summary = meta?.summary ?? null;
  const stopReason = summary?.stopReason ?? 'no-summary';
  const pass = !!(summary && summary.completed && stopReason === 'completed');
  const okSteps = steps.filter((e) => e && e.ok);
  const last = okSteps[okSteps.length - 1] ?? null;
  let lastProgressStep = null;
  for (const e of okSteps) if (e.progressed) lastProgressStep = e.step;
  const milestones = evaluateMilestones(steps, scenario?.milestones ?? []);
  const errors = steps.filter((e) => e && !e.ok);
  const lastError = errors.length ? errors[errors.length - 1].error ?? null : null;
  const finalShot = screenshots.find((p) => /(^|\/)final\.png$/.test(p)) ?? null;

  return {
    result: pass ? 'PASS' : 'FAIL',
    game: scenario?.game ?? null,
    runId: summary?.runId ?? null,
    policy: summary?.policy ?? meta?.config?.policy ?? null,
    stopReason,
    stopReasonText: STOP_REASON_TEXT[stopReason] ?? stopReason,
    completionMatched: summary?.completionMatched ?? [],
    harnessExitCode,
    reached: {
      steps: summary?.steps ?? okSteps.length,
      lastStep: last?.step ?? null,
      lastFrame: last?.frame ?? summary?.framesEnd ?? null,
      lastTitle: last?.title ?? null,
      lastState: summary?.lastState ?? last?.state ?? null,
      lastProgressStep,
      milestone: milestones.furthest,
    },
    milestones,
    progress: {
      progressSteps: summary?.progressSteps ?? 0,
      stuckSignals: summary?.stuckSignals ?? 0,
      maxNoProgressStreak: summary?.maxNoProgressStreak ?? 0,
    },
    recovery: {
      total: summary?.recoveries ?? 0,
      byStrategy: summary?.recoveryByStrategy ?? {},
      giveUp: summary?.recoveryGiveUp ?? false,
    },
    errors: { total: summary?.errors ?? errors.length, last: lastError },
    reward: summary?.stateEnabled ? { total: summary.totalReward ?? 0, steps: summary.rewardSteps ?? 0 } : null,
    timing: {
      startedAt: summary?.startedAt ?? null,
      endedAt: summary?.endedAt ?? null,
      elapsedMs: summary?.elapsedMs ?? null,
    },
    artifacts: {
      runDir,
      meta: runDir ? `${runDir}/meta.json` : null,
      stepsLog: runDir ? `${runDir}/steps.jsonl` : null,
      finalScreenshot: finalShot,
      screenshots: screenshots.length,
    },
  };
}

function fmtDuration(ms) {
  if (ms == null) return '-';
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h ? `${h}h` : ''}${h || m ? `${m}m` : ''}${s % 60}s`;
}

/** 合否レポートを Markdown へ整形する（runs/<id>/report.md）。 */
export function renderReportMarkdown(r) {
  const L = [];
  const icon = r.result === 'PASS' ? '✅' : '❌';
  L.push(`# 自律プレイスルー E2E 合否レポート — ${icon} ${r.result}`, '');
  L.push('| 項目 | 値 |', '|---|---|');
  L.push(`| 対象ゲーム | ${r.game ?? '-'} |`);
  L.push(`| runId | ${r.runId ?? '-'} |`);
  L.push(`| ポリシー | ${r.policy ?? '-'} |`);
  L.push(`| 判定 | **${r.result}** |`);
  L.push(`| 停止理由 | \`${r.stopReason}\` — ${r.stopReasonText} |`);
  if (r.completionMatched.length) L.push(`| 一致した完結条件 | ${r.completionMatched.join(', ')} |`);
  L.push(`| 所要 | ${fmtDuration(r.timing.elapsedMs)}（${r.timing.startedAt ?? '-'} → ${r.timing.endedAt ?? '-'}） |`);
  L.push(`| ステップ | ${r.reached.steps}（進捗 ${r.progress.progressSteps} / スタック信号 ${r.progress.stuckSignals} / 最大無進捗 ${r.progress.maxNoProgressStreak}） |`);
  const rb = Object.entries(r.recovery.byStrategy).map(([k, v]) => `${k}:${v}`).join(' ');
  L.push(`| リカバリ回数 | ${r.recovery.total}${rb ? `（${rb}）` : ''}${r.recovery.giveUp ? ' ⛔give-up' : ''} |`);
  L.push(`| エラー | ${r.errors.total}${r.errors.last ? `（最後: ${r.errors.last}）` : ''} |`);
  if (r.reward) L.push(`| 報酬合計 | ${Math.round(r.reward.total * 100) / 100}（発生 ${r.reward.steps} ステップ） |`);
  if (r.harnessExitCode != null) L.push(`| ハーネス終了コード | ${r.harnessExitCode} |`);
  L.push('');
  L.push('## 到達点', '');
  L.push(`- 最終ステップ: ${r.reached.lastStep ?? '-'}（frame ${r.reached.lastFrame ?? '-'}, title \`${r.reached.lastTitle ?? '-'}\`）`);
  L.push(`- 最後に進捗したステップ: ${r.reached.lastProgressStep ?? '-'}`);
  if (r.reached.lastState) L.push(`- 最終状態: \`${JSON.stringify(r.reached.lastState)}\``);
  if (r.milestones.total) {
    const f = r.milestones.furthest;
    L.push(`- マイルストーン: ${r.milestones.reached.length}/${r.milestones.total} 到達` +
      `${f ? `（最遠: **${f.name}** @step ${f.step}）` : '（未到達）'}`);
    for (const m of r.milestones.reached) L.push(`  - ✅ ${m.name} @step ${m.step}`);
    for (const n of r.milestones.missed) L.push(`  - ⬜ ${n}`);
  }
  L.push('');
  L.push('## 記録', '');
  L.push(`- 実行記録: \`${r.artifacts.runDir ?? '-'}\``);
  L.push(`- ログ: \`${r.artifacts.stepsLog ?? '-'}\` / サマリ: \`${r.artifacts.meta ?? '-'}\``);
  L.push(`- スクリーンショット: ${r.artifacts.screenshots} 枚${r.artifacts.finalScreenshot ? `（最終: \`${r.artifacts.finalScreenshot}\`）` : ''}`);
  L.push('');
  return L.join('\n');
}
