#!/usr/bin/env node
// =============================================================
//  playthrough.mjs ― プレイスルー・テストハーネス基盤 (Epic #13 / #14)
//
//  play-loop.mjs（N ステップ PoC）を、**長時間の連続自律プレイ**を安定して
//  回せるハーネスへ拡張したもの。自律完走テスト（#17）の土台。
//
//  提供する基盤:
//    - 長時間ループ（総ステップ / 総時間の上限、中断シグナルで graceful 終了）
//    - 構造化ログ（JSONL: step/frame/観測/判断/行動/所要/ok/error）
//    - 定期スナップショット（スクショ + セーブステート checkpoint）
//    - 途中経過の外部固定（runs/<runId>/ に meta.json・steps.jsonl・screenshots）
//    - bridge 切断・タイムアウトを **例外で全体を落とさず** 記録して継続
//      （連続失敗が上限を超えたら安全に中断）
//    - 再開（RESUME=1 で直近 checkpoint セーブステートから再開）
//
//  前提: mGBA + bridge.lua(127.0.0.1:8765) 稼働（launcher/start-session.sh）。
//  使い方: node agent/playthrough.mjs [maxSteps]
//    env: POLICY=demo|llm / OLLAMA_MODEL / OLLAMA_VISION=1 / OLLAMA_HOST
//         MAX_SECONDS(既定600) / SNAPSHOT_EVERY(既定25) / CHECKPOINT_SLOT(既定1)
//         MAX_FAILURES(既定5) / RUN_DIR(出力先上書き) / RESUME=1
//         STEP_DELAY_MS(既定250, ステップ間の実時間ディレイ=リアルタイム進行量)
//         ADVANCE_FRAMES(既定0=呼ばない。>0 で headless/一時停止ビルド向けに frameAdvance)
//
//  ※ 実 mGBA はリアルタイム動作でフレームは自然進行するため、既定では
//    mgba_advance_frames を呼ばない（未応答ビルドで毎ステップ RPC タイムアウトし
//    10 秒/step 停滞するのを回避）。ステップ間隔は STEP_DELAY_MS で制御する。
//  終了コード: 0=正常終了(上限到達/中断) / 1=連続失敗で中断 / 2=起動不能
// =============================================================
import { existsSync, copyFileSync, mkdirSync, appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MgbaMcpClient, sleep } from './lib/mcp-client.mjs';
import { demoPolicy, VALID_BUTTONS } from './policies/demo-policy.mjs';
import { createLlmPolicy } from './policies/llm-policy.mjs';
import { ollamaHasModel } from './lib/ollama-client.mjs';

// ─────────── 純粋ヘルパー（外部依存なし・ユニットテスト対象） ───────────

/**
 * ループを止めるべきか判定する。優先順: 中断 > ステップ上限 > 時間上限 > 連続失敗上限。
 * @returns {{stop:boolean, reason:string|null}}
 */
export function shouldStop({ step, maxSteps, elapsedMs, maxMs, stopping, consecutiveFailures, maxFailures }) {
  if (stopping) return { stop: true, reason: 'interrupted' };
  if (maxSteps != null && step >= maxSteps) return { stop: true, reason: 'max-steps' };
  if (maxMs != null && elapsedMs >= maxMs) return { stop: true, reason: 'time-budget' };
  if (maxFailures != null && consecutiveFailures >= maxFailures) return { stop: true, reason: 'too-many-failures' };
  return { stop: false, reason: null };
}

/** step が定期スナップショットのタイミングか（step>0 かつ every の倍数）。 */
export function isSnapshotStep(step, every) {
  return every > 0 && step > 0 && step % every === 0;
}

/** 実行状態からサマリオブジェクトを組み立てる（meta.json 用）。 */
export function buildSummary(s) {
  return {
    runId: s.runId,
    policy: s.policyLabel,
    steps: s.steps,
    framesStart: s.framesStart,
    framesEnd: s.framesEnd,
    frameProgress: (s.framesEnd ?? 0) - (s.framesStart ?? 0),
    snapshots: s.snapshots,
    errors: s.errors,
    consecutiveFailures: s.consecutiveFailures,
    stopReason: s.stopReason,
    elapsedMs: s.elapsedMs,
    lastCheckpointSlot: s.lastCheckpointSlot,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
  };
}

// ─────────── ランナー本体（副作用あり・CLI から実行） ───────────

/** promise を ms でタイムアウトさせる（ハングする RPC で全体を止めないため）。 */
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout ${ms}ms`)), ms)),
  ]);
}

function selectPolicy() {
  const kind = process.env.POLICY || 'demo';
  const policy = kind === 'llm'
    ? createLlmPolicy({ vision: process.env.OLLAMA_VISION === '1' })
    : demoPolicy;
  const label = kind === 'llm'
    ? `LLM(ollama ${process.env.OLLAMA_MODEL || 'qwen2.5:7b'}${process.env.OLLAMA_VISION === '1' ? ', vision' : ''})`
    : 'demo';
  return { kind, policy, label };
}

async function finalize(client, state, runDir) {
  // 最終スナップショット + checkpoint（bridge 死亡時は失敗するので握りつぶす）
  try {
    const shot = await client.screenshot();
    if (shot && existsSync(shot)) copyFileSync(shot, join(runDir, 'screenshots', 'final.png'));
  } catch { /* bridge 不通なら諦める */ }
  try {
    await client.saveState(state.checkpointSlot);
    state.lastCheckpointSlot = state.checkpointSlot;
  } catch { /* 同上 */ }
  state.endedAt = new Date().toISOString();
  const summary = buildSummary(state);
  writeFileSync(join(runDir, 'meta.json'), JSON.stringify({ config: state.config, summary }, null, 2));
  console.log('\n──────── プレイスルー サマリ ────────');
  console.log(`stop=${state.stopReason} steps=${state.steps} frame進行=${summary.frameProgress} ` +
    `snapshot=${state.snapshots} error=${state.errors} 所要=${Math.round(state.elapsedMs / 1000)}s`);
  console.log(`  記録: ${runDir}`);
  try { client.close(); } catch { /* noop */ }
}

async function main() {
  const maxSteps = parseInt(process.argv[2] || process.env.STEPS || '200', 10);
  const maxMs = Math.max(1, parseInt(process.env.MAX_SECONDS || '600', 10)) * 1000;
  const snapshotEvery = Math.max(0, parseInt(process.env.SNAPSHOT_EVERY || '25', 10));
  const checkpointSlot = Math.max(1, parseInt(process.env.CHECKPOINT_SLOT || '1', 10));
  const maxFailures = Math.max(1, parseInt(process.env.MAX_FAILURES || '5', 10));
  const stepDelayMs = Math.max(0, parseInt(process.env.STEP_DELAY_MS || '250', 10));
  const advanceFramesN = Math.max(0, parseInt(process.env.ADVANCE_FRAMES || '0', 10));

  const client = new MgbaMcpClient();
  await client.connect();
  const pong = await client.ping();
  if (!/pong/i.test(pong)) {
    console.error('✗ bridge に接続できません。launcher/start-session.sh で起動してください。');
    client.close();
    process.exit(2);
  }

  const { kind, policy, label } = selectPolicy();
  if (kind === 'llm') {
    const mdl = process.env.OLLAMA_MODEL || 'qwen2.5:7b';
    if (!(await ollamaHasModel(mdl))) {
      console.error(`✗ ollama にモデル "${mdl}" が見つかりません（${process.env.OLLAMA_HOST || 'http://127.0.0.1:11434'}）。`);
      client.close();
      process.exit(2);
    }
  }

  // 出力ディレクトリ（runs/<runId>/ 既定・.gitignore 済）
  const startedAt = new Date();
  const runId = startedAt.toISOString().replace(/[:.]/g, '-');
  const runDir = process.env.RUN_DIR || join(process.cwd(), 'runs', runId);
  mkdirSync(join(runDir, 'screenshots'), { recursive: true });
  const stepsLog = join(runDir, 'steps.jsonl');

  const config = {
    maxSteps, maxSeconds: maxMs / 1000, snapshotEvery, checkpointSlot, maxFailures,
    policy: label, resume: process.env.RESUME === '1',
  };
  writeFileSync(join(runDir, 'meta.json'), JSON.stringify({ config, summary: null }, null, 2));

  // 再開: 直近 checkpoint セーブステートからロード
  if (process.env.RESUME === '1') {
    try { await client.loadState(checkpointSlot); console.log(`↻ checkpoint slot ${checkpointSlot} から再開`); }
    catch (e) { console.warn(`⚠ 再開失敗（slot ${checkpointSlot}）: ${e.message}`); }
  }

  const state = {
    runId, policyLabel: label, config, checkpointSlot,
    steps: 0, framesStart: null, framesEnd: null,
    snapshots: 0, errors: 0, consecutiveFailures: 0,
    stopReason: null, startedAt: startedAt.toISOString(), endedAt: null, elapsedMs: 0,
    lastCheckpointSlot: null,
  };

  let stopping = false;
  const onSignal = () => { if (!stopping) { stopping = true; console.log('\n⏸ 中断シグナル受信 → finalize します'); } };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  const startMs = Date.now();
  console.log(`▶ プレイスルー開始（最大 ${maxSteps} ステップ / ${maxMs / 1000}s, policy=${label}）`);
  console.log(`  記録先: ${runDir}\n`);

  try {
    for (let step = 0; ; step++) {
      state.elapsedMs = Date.now() - startMs;
      const decision = shouldStop({
        step, maxSteps, elapsedMs: state.elapsedMs, maxMs,
        stopping, consecutiveFailures: state.consecutiveFailures, maxFailures,
      });
      if (decision.stop) { state.stopReason = decision.reason; break; }

      const t0 = Date.now();
      const entry = { t: new Date().toISOString(), step, ok: false };
      try {
        // 1. 知覚
        const info = await client.getInfo();
        const shot = await client.screenshot();
        if (state.framesStart == null) state.framesStart = info.frame;
        state.framesEnd = info.frame;

        const snap = isSnapshotStep(step, snapshotEvery);
        let savedShot = null;
        if (snap && shot && existsSync(shot)) {
          savedShot = join(runDir, 'screenshots', `step${String(step).padStart(5, '0')}.png`);
          copyFileSync(shot, savedShot);
        }

        // 2. 判断
        const observation = { step, frame: info.frame, title: info.title, screenshotPath: shot };
        const dec = await policy(observation);
        const buttons = Array.isArray(dec?.buttons)
          ? dec.buttons.filter((b) => VALID_BUTTONS.includes(b))
          : [];
        const note = dec?.note ?? '';

        // 3. 行動
        if (buttons.length) await client.pressButtons(buttons);
        // 実 mGBA はリアルタイム進行なので既定では frameAdvance を呼ばない。
        // ADVANCE_FRAMES>0 のときだけ短タイムアウト付きで実行（ハングで停滞しない）。
        if (advanceFramesN > 0) {
          try { await withTimeout(client.advanceFrames(advanceFramesN), 800); } catch { /* 非対応/遅延は無視 */ }
        }

        // 定期 checkpoint（再開用セーブステート）
        if (snap) {
          try { await client.saveState(checkpointSlot); state.lastCheckpointSlot = checkpointSlot; } catch { /* noop */ }
          state.snapshots++;
        }

        state.steps++;
        state.consecutiveFailures = 0;
        Object.assign(entry, {
          ok: true, frame: info.frame, title: info.title,
          buttons, note, snapshot: snap, savedShot: savedShot ? true : false,
          durMs: Date.now() - t0,
        });
        if (step % 10 === 0 || snap) {
          console.log(`step ${step}: frame=${info.frame} [${info.title}] → [${buttons.join('+') || '(なし)'}] ${snap ? '📷💾' : ''}`);
        }
      } catch (e) {
        // bridge 切断・タイムアウト等: 落とさず記録して継続（連続失敗が上限を超えたら止まる）
        state.errors++;
        state.consecutiveFailures++;
        Object.assign(entry, { ok: false, error: String(e?.message || e), durMs: Date.now() - t0 });
        console.warn(`⚠ step ${step} 失敗(${state.consecutiveFailures}/${maxFailures}): ${entry.error}`);
        await sleep(500); // バックオフ
      }
      appendFileSync(stepsLog, JSON.stringify(entry) + '\n');
      await sleep(80);
    }
  } finally {
    state.elapsedMs = Date.now() - startMs;
    await finalize(client, state, runDir);
  }

  await sleep(100);
  process.exit(state.stopReason === 'too-many-failures' ? 1 : 0);
}

// CLI 実行時のみ main を起動（import 時＝テスト時は起動しない）
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('FATAL', e); process.exit(2); });
}
