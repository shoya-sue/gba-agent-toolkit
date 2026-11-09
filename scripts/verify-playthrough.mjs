#!/usr/bin/env node
// =============================================================
//  verify-playthrough.mjs ― E2E 完走テスト本体 + 合否レポート (Epic #13 / #17)
//
//  完走シナリオ（agent/scenarios/*.json）を読み、playthrough.mjs
//  （#14 ハーネス + #15 進捗/完走判定 + #16 self-healing）を統合実行して、
//  runs/<id>/report.json・report.md に **合否レポート** を出力する。
//
//  ※ mGBA + bridge.lua が稼働している前提（通常は scripts/verify-playthrough.sh 経由で起動）。
//
//  使い方:
//    node scripts/verify-playthrough.mjs <scenario.json> [--rom <ROM>]
//        → playthrough を実行し、終了後にレポート生成
//    node scripts/verify-playthrough.mjs --report-only <runDir> [scenario.json]
//        → 既存の実行記録からレポートだけ再生成（中断ラン・ハーネス異常終了の事後確認用）
//  終了コード: 0=PASS（完結到達） / 1=FAIL（未完結。理由・到達点はレポートに記録） / 2=前提不足
// =============================================================
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseScenario, scenarioEnv, hasCompletionCondition, buildReport, renderReportMarkdown,
} from '../agent/lib/report.mjs';
import { parseStateMap } from '../agent/lib/state.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function die(msg, code = 2) { console.error(`✗ ${msg}`); process.exit(code); }

function loadScenario(path) {
  if (!path) return null;
  if (!existsSync(path)) die(`シナリオが見つかりません: ${path}`);
  try { return parseScenario(readFileSync(path, 'utf8')); } catch (e) { die(`シナリオ JSON 不正（${path}）: ${e.message}`); }
}

function readJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

/** runDir の記録からレポートを組み立てて書き出し、PASS/FAIL を返す。 */
function writeReport(runDir, scenario, harnessExitCode = null) {
  let meta = null;
  try { meta = JSON.parse(readFileSync(join(runDir, 'meta.json'), 'utf8')); } catch { meta = null; }
  const steps = readJsonl(join(runDir, 'steps.jsonl'));
  const shotDir = join(runDir, 'screenshots');
  const screenshots = existsSync(shotDir)
    ? readdirSync(shotDir).filter((f) => f.endsWith('.png')).sort().map((f) => join(shotDir, f))
    : [];
  const report = buildReport({ meta, steps, scenario, runDir, screenshots, harnessExitCode });
  const md = renderReportMarkdown(report);
  writeFileSync(join(runDir, 'report.json'), JSON.stringify(report, null, 2));
  writeFileSync(join(runDir, 'report.md'), md);
  console.log('\n' + md);
  console.log(`RESULT: ${report.result} (stop=${report.stopReason})  → ${join(runDir, 'report.md')}`);
  return report.result;
}

function main() {
  const args = process.argv.slice(2);

  if (args[0] === '--report-only') {
    const runDir = args[1];
    if (!runDir || !existsSync(runDir)) die(`usage: --report-only <runDir> [scenario.json]（runDir 不在: ${runDir ?? '-'}）`);
    const result = writeReport(resolve(runDir), loadScenario(args[2]));
    process.exit(result === 'PASS' ? 0 : 1);
  }

  const scenarioPath = args[0];
  if (!scenarioPath || scenarioPath.startsWith('--')) die('usage: verify-playthrough.mjs <scenario.json> [--rom <ROM>]');
  const scenario = loadScenario(scenarioPath);
  const romIdx = args.indexOf('--rom');
  const rom = romIdx >= 0 ? args[romIdx + 1] : null;

  const extra = scenarioEnv(scenario, process.env);
  const env = { ...process.env, ...extra };

  // 完結条件が無ければ PASS 判定が不可能 → 前提不足として実行しない
  let smCompletion = 0;
  if (env.STATE_MAP) {
    if (!existsSync(env.STATE_MAP)) die(`STATE_MAP が見つかりません: ${env.STATE_MAP}`);
    try { smCompletion = parseStateMap(readFileSync(env.STATE_MAP, 'utf8')).completion.length; } catch (e) { die(`STATE_MAP 不正: ${e.message}`); }
  }
  if (!hasCompletionCondition(env, smCompletion)) {
    die('完結条件が未定義です（シナリオ completion / COMPLETE_* / state-map completion のいずれかが必要）');
  }

  const runId = `e2e-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const runDir = resolve(env.RUN_DIR || join(ROOT, 'runs', runId));
  mkdirSync(runDir, { recursive: true });
  env.RUN_DIR = runDir;
  // self-healing の最終手段（restart-session）は ROM 指定時のみ有効化
  if (rom && !env.RESTART_ROM) env.RESTART_ROM = resolve(rom);

  console.log(`▶ E2E 完走テスト: ${scenario.game ?? scenarioPath}`);
  if (scenario.flow.length) console.log(`  想定フロー: ${scenario.flow.join(' → ')}`);
  console.log(`  シナリオ由来 env: ${Object.keys(extra).join(' ') || '(なし)'}`);
  console.log(`  記録先: ${runDir}`);

  const r = spawnSync(process.execPath, [join(ROOT, 'agent', 'playthrough.mjs')], {
    cwd: ROOT, env, stdio: 'inherit',
  });
  const code = r.status ?? (r.signal ? 130 : null);
  const result = writeReport(runDir, scenario, code);
  process.exit(result === 'PASS' ? 0 : 1);
}

main();
