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
//         [進捗・完走判定 #15]
//         STUCK_STEPS(既定12, N ステップ無進捗でスタック信号) /
//         STUCK_ABORT_STEPS(既定0=無効, >0 で無進捗 N ステップ継続時に stuck 中断) /
//         COMPLETE_TITLE_CONTAINS / COMPLETE_STATE="flag=val" / COMPLETE_SCREEN_HASHES="h1,h2"
//         （いずれか一致で「完走(completed)」として正常終了。ゲーム毎の完結定義）
//         [自己修復・再トライ #16]
//         RECOVER(既定1=ON, 0で無効) スタック/切断時に自動リカバリ /
//         RECOVER_MAX_TOTAL(既定12, ラン全体のリカバリ試行上限=無限ループ防止) /
//         FAIL_RECOVER_AFTER(既定2, 連続失敗が N でブリッジ再接続を試行) /
//         RESTART_ROM(指定時のみ最終手段 restart-session を梯子に追加。ROM 絶対パス)
//         リカバリ梯子: alt-input(別入力探索)→load-state(直近checkpoint復帰)→reset→restart-session
//         [実ゲーム状態読取・報酬 #12]
//         STATE_MAP=<path>  ゲーム固有の JSON(state-map: 記述子/報酬仕様/署名キー/完結)。
//           指定時のみ HP/座標/フラグ を毎ステップ読み、observation.state / 進捗署名 /
//           報酬シグナル / 完結条件に反映する。未指定なら状態読取は無効（後方互換）。
//
//  ※ 実 mGBA はリアルタイム動作でフレームは自然進行するため、既定では
//    mgba_advance_frames を呼ばない（未応答ビルドで毎ステップ RPC タイムアウトし
//    10 秒/step 停滞するのを回避）。ステップ間隔は STEP_DELAY_MS で制御する。
//  終了コード: 0=正常終了(上限到達/中断) / 1=連続失敗で中断 / 2=起動不能
// =============================================================
import { existsSync, copyFileSync, mkdirSync, appendFileSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MgbaMcpClient, sleep } from './lib/mcp-client.mjs';
import { demoPolicy, VALID_BUTTONS } from './policies/demo-policy.mjs';
import { createLlmPolicy } from './policies/llm-policy.mjs';
import { ollamaHasModel } from './lib/ollama-client.mjs';
import {
  createProgressTracker, evaluateCompletion, hashBytes,
  observationSignature, parseCompletionConditions, stateEquals,
} from './lib/progress.mjs';
import { createRecoveryController, explorationButtons } from './lib/recovery.mjs';
import { readState, parseStateMap, stateSignature, computeReward } from './lib/state.mjs';
import { spawnSync } from 'node:child_process';

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
    // 進捗・完走判定 (#15)
    progressSteps: s.progressSteps ?? 0,
    stuckSignals: s.stuckSignals ?? 0,
    maxNoProgressStreak: s.maxNoProgressStreak ?? 0,
    completed: s.completed ?? false,
    completionMatched: s.completionMatched ?? [],
    // 自己修復・再トライ (#16)
    recoveries: s.recoveries ?? 0,
    recoveryByStrategy: s.recoveryByStrategy ?? {},
    recoveryGiveUp: s.recoveryGiveUp ?? false,
    // 実ゲーム状態・報酬 (#12)
    stateEnabled: s.stateEnabled ?? false,
    stateFields: s.stateFields ?? [],
    totalReward: s.totalReward ?? 0,
    rewardSteps: s.rewardSteps ?? 0,
    lastState: s.lastState ?? null,
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
  console.log(`進捗=${state.progressSteps}/${state.steps} スタック信号=${state.stuckSignals} ` +
    `最大無進捗=${state.maxNoProgressStreak} ` +
    `完走=${state.completed ? `YES [${state.completionMatched.join(', ')}]` : 'no'}`);
  const recBy = Object.entries(state.recoveryByStrategy || {}).map(([k, v]) => `${k}:${v}`).join(' ');
  console.log(`リカバリ=${state.recoveries}${recBy ? ` (${recBy})` : ''}` +
    `${state.recoveryGiveUp ? ' ⛔give-up' : ''}`);
  if (state.stateEnabled) {
    console.log(`状態=[${(state.stateFields || []).join(', ')}] 報酬合計=${Math.round((state.totalReward || 0) * 100) / 100} ` +
      `報酬発生=${state.rewardSteps}/${state.steps}` +
      `${state.lastState ? ` 最終=${JSON.stringify(state.lastState)}` : ''}`);
  }
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
  // 進捗・完走判定 (#15)
  const stuckAfter = Math.max(1, parseInt(process.env.STUCK_STEPS || '12', 10));
  const stuckAbort = Math.max(0, parseInt(process.env.STUCK_ABORT_STEPS || '0', 10));
  // 実ゲーム状態読取 (#12): STATE_MAP=<path> の JSON(state-map) から
  // 記述子(HP/座標/フラグ)と報酬仕様を読む。未指定なら状態読取は無効（後方互換）。
  let stateMap = null;
  const stateMapPath = process.env.STATE_MAP || '';
  if (stateMapPath) {
    try {
      stateMap = parseStateMap(readFileSync(stateMapPath, 'utf8'));
      console.log(`🗺 state-map: ${stateMapPath}（${stateMap.descriptors.length} フィールド, game=${stateMap.game ?? '?'}）`);
    } catch (e) {
      console.warn(`⚠ state-map 読込失敗（${stateMapPath}）: ${e.message} → 状態読取なしで継続`);
    }
  }
  const stateEnabled = !!(stateMap && stateMap.descriptors.length);
  // 完結条件 (#15) に state-map の completion（{field, equals}）を stateEquals として合流。
  const completionConditions = parseCompletionConditions(process.env).concat(
    (stateMap?.completion ?? []).map((c) => stateEquals(c.field, c.equals)),
  );
  const tracker = createProgressTracker({ stuckAfter });
  // 自己修復・再トライ (#16)
  const recoverOn = process.env.RECOVER !== '0'; // 既定 ON。RECOVER=0 で無効化
  const restartRom = process.env.RESTART_ROM || ''; // 指定時のみ restart-session を梯子に含める
  const recoverEnabled = ['alt-input', 'load-state', 'reset', ...(restartRom ? ['restart-session'] : [])];
  const recoverMaxTotal = Math.max(1, parseInt(process.env.RECOVER_MAX_TOTAL || '12', 10));
  const failRecoverAfter = Math.max(1, parseInt(process.env.FAIL_RECOVER_AFTER || '2', 10));
  const recovery = createRecoveryController({ maxTotal: recoverMaxTotal });

  let client = new MgbaMcpClient();
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
    stuckAfter, stuckAbort, completionConditions: completionConditions.map((c) => c.name),
    recover: recoverOn, recoverEnabled, recoverMaxTotal, failRecoverAfter,
    restartSession: restartRom ? true : false,
    stateMap: stateMapPath || null,
    stateFields: stateEnabled ? stateMap.descriptors.map((d) => d.name) : [],
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
    // 進捗・完走判定 (#15)
    progressSteps: 0, stuckSignals: 0, maxNoProgressStreak: 0,
    completed: false, completionMatched: [],
    // 自己修復・再トライ (#16)
    recoveries: 0, recoveryByStrategy: {}, recoveryGiveUp: false,
    // 実ゲーム状態・報酬 (#12)
    stateEnabled, stateFields: stateEnabled ? stateMap.descriptors.map((d) => d.name) : [],
    prevState: null, lastState: null, totalReward: 0, rewardSteps: 0,
  };

  // ── 自己修復 executor (#16): 純粋ロジック(recovery.mjs)が選んだ戦略を実際に適用する ──
  //    client を張り直す可能性があるためクロージャで外側の let client を更新する。
  async function bridgeAlive() {
    try { return /pong/i.test(await withTimeout(client.ping(), 3000)); }
    catch { return false; }
  }
  async function reconnectClient() {
    // mcp-mgba 子プロセスが死んだ場合の張り直し（mGBA/bridge が生存していれば復帰）。
    // close() は child.kill() のみで通常失敗しないが、失敗時は診断のため可視化する
    // （旧子プロセス/接続のリーク兆候。次段の connect/bridgeAlive で実影響を確認）。
    try { client.close(); } catch (e) { console.warn(`⚠ 旧 client close 失敗: ${e?.message || e}`); }
    client = new MgbaMcpClient();
    await client.connect();
    return bridgeAlive();
  }
  async function restartSession() {
    // 最重量: mGBA セッションごと再起動（ROM 必須）。stop-session → start-session。
    if (!restartRom) return { ok: false, detail: 'RESTART_ROM 未指定' };
    const dir = join(process.cwd(), 'launcher');
    try { spawnSync('bash', [join(dir, 'stop-session.sh')], { timeout: 30000 }); } catch { /* noop */ }
    const r = spawnSync('bash', [join(dir, 'start-session.sh'), '--rom', restartRom],
      { timeout: 120000, encoding: 'utf8' });
    // timeout/signal kill 時は r.error/r.signal に出る（r.stdout は null になり得る）。
    // これを見ないと「起動失敗」と「タイムアウトで殺した」が区別できず原因が曖昧になる。
    if (r.error || r.signal) return { ok: false, detail: `start-session 異常終了: ${r.signal || r.error?.message}` };
    const started = /RESULT:\s*OK/.test((r.stdout || '') + (r.stderr || ''));
    if (started) { try { await reconnectClient(); } catch { /* 次段の bridgeAlive で検出 */ } }
    return { ok: started && (await bridgeAlive()), detail: started ? 'session restarted' : 'start-session 失敗' };
  }
  async function applyRecovery(strategy, seed) {
    switch (strategy) {
      case 'alt-input': {
        const btns = explorationButtons(seed);
        await client.pressButtons(btns);
        return { ok: true, detail: `alt-input ${btns.join('+')}` };
      }
      case 'load-state':
        if (state.lastCheckpointSlot == null) return { ok: false, detail: 'checkpoint 未保存' };
        await client.loadState(checkpointSlot);
        return { ok: true, detail: `load slot ${checkpointSlot}` };
      case 'reset':
        await client.reset();
        await sleep(1500); // ROM 再初期化待ち
        return { ok: true, detail: 'soft reset' };
      case 'restart-session':
        return await restartSession();
      default:
        return { ok: false, detail: `unknown strategy ${strategy}` };
    }
  }

  let stopping = false;
  const onSignal = () => { if (!stopping) { stopping = true; console.log('\n⏸ 中断シグナル受信 → finalize します'); } };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  const startMs = Date.now();
  console.log(`▶ プレイスルー開始（最大 ${maxSteps} ステップ / ${maxMs / 1000}s, policy=${label}）`);
  console.log(`  記録先: ${runDir}`);
  console.log(`  進捗判定: ${stuckAfter} ステップ無進捗でスタック信号` +
    `${stuckAbort > 0 ? ` / ${stuckAbort} 継続で中断` : ''}` +
    ` / 完結条件: ${completionConditions.length ? completionConditions.map((c) => c.name).join(', ') : '(なし)'}`);
  console.log(`  自己修復: ${recoverOn ? `ON 梯子=[${recoverEnabled.join(' → ')}] 総上限=${recoverMaxTotal}` : 'OFF'}` +
    `${restartRom ? ` / restart ROM=${restartRom}` : ''}\n`);

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
      let prog = null;         // 進捗判定結果（catch 後の中断判断でも参照）
      let completion = null;   // 完結判定結果（同上）
      let recoveryResult = null; // リカバリ発動結果（#16・entry に記録）
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

        // 1.5 進捗判定 (#15): 画面 PNG ハッシュ・title・(状態#12) の変化で「進んだか」を見る。
        //     実 mGBA は frame が常に進むので frame "だけ" では進捗と見なさない。
        let screenHash = null;
        if (shot && existsSync(shot)) {
          try { screenHash = hashBytes(readFileSync(shot)); } catch { /* 読めなければ null */ }
        }
        // 実ゲーム状態読取 (#12): state-map 指定時のみメモリを読む（未指定は null＝後方互換）。
        let gameState = null;
        let reward = null;
        if (stateEnabled) {
          try {
            gameState = await withTimeout(readState(client, stateMap.descriptors), 3000);
            reward = computeReward(state.prevState, gameState, stateMap.rewardSpec);
            state.prevState = gameState;
            state.lastState = gameState;
            state.totalReward += reward.total;
            if (reward.total !== 0) state.rewardSteps++;
          } catch (e) {
            gameState = null; // 状態読取の失敗は補助情報のため観測を壊さず継続
            console.warn(`⚠ step ${step} 状態読取失敗: ${e?.message || e}`);
          }
        }
        prog = tracker.update(observationSignature({
          frame: info.frame, title: info.title, screenHash,
          stateKey: stateSignature(gameState, stateMap?.signatureKeys),
        }));
        if (prog.progressed) { state.progressSteps++; recovery.onProgress(); } // 進捗再開で梯子リセット
        if (prog.noProgressStreak > state.maxNoProgressStreak) state.maxNoProgressStreak = prog.noProgressStreak;
        // スタック信号はしきい値をまたいだ瞬間に 1 度だけ発火（stall エピソード毎）。
        if (prog.stuck && prog.noProgressStreak === stuckAfter) {
          state.stuckSignals++;
          console.warn(`⚠ スタック検出: ${prog.noProgressStreak} ステップ無進捗（画面/状態/title 不変）` +
            `${prog.frozenStreak ? ` / frame 凍結 ${prog.frozenStreak}` : ''}`);
        }
        // 自己修復トリガ (#16): スタック中は stuckAfter ステップ毎に梯子を 1 段ずつ上って介入。
        // （STUCK_STEPS=1 だと詰まり中は毎ステップ発動しうるが、総試行 RECOVER_MAX_TOTAL で頭打ち）
        const shouldRecover = recoverOn && prog.stuck && (prog.noProgressStreak - stuckAfter) % stuckAfter === 0;

        // 2. 判断
        const observation = { step, frame: info.frame, title: info.title, screenshotPath: shot, screenHash, state: gameState };
        const dec = await policy(observation);
        const buttons = Array.isArray(dec?.buttons)
          ? dec.buttons.filter((b) => VALID_BUTTONS.includes(b))
          : [];
        const note = dec?.note ?? '';

        // 完結判定 (#15): ゲーム毎の完結条件（title/状態/画面ハッシュ）に一致したら完走。
        completion = evaluateCompletion(observation, completionConditions);
        if (completion.completed && !state.completed) {
          state.completed = true;
          state.completionMatched = completion.matched;
          console.log(`🏁 完結検出: [${completion.matched.join(', ')}] → 完走とみなす`);
        }

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

        // 自己修復の実行 (#16): 詰まりから抜けるため梯子の次の戦略を適用する。
        if (shouldRecover) {
          const plan = recovery.onStuck({ enabled: recoverEnabled });
          if (plan.giveUp) {
            state.recoveryGiveUp = true;
            recoveryResult = { trigger: 'stuck', giveUp: true, reason: plan.reason };
            console.warn(`⛔ 自己修復を諦め（${plan.reason}）`);
          } else {
            if (plan.backoffMs) await sleep(plan.backoffMs);
            let res;
            try { res = await applyRecovery(plan.strategy, plan.totalAttempt); }
            catch (e) { res = { ok: false, detail: String(e?.message || e) }; }
            state.recoveries++;
            state.recoveryByStrategy[plan.strategy] = (state.recoveryByStrategy[plan.strategy] || 0) + 1;
            recoveryResult = { trigger: 'stuck', strategy: plan.strategy, attempt: plan.totalAttempt, ok: res.ok, detail: res.detail };
            console.warn(`🔧 リカバリ#${plan.totalAttempt} [${plan.strategy}] → ${res.ok ? 'OK' : 'NG'}（${res.detail}）`);
          }
        }

        state.steps++;
        state.consecutiveFailures = 0;
        Object.assign(entry, {
          ok: true, frame: info.frame, title: info.title,
          buttons, note, snapshot: snap, savedShot: savedShot ? true : false,
          screenHash,
          state: gameState, reward: reward ? reward.total : null,
          progressed: prog.progressed, progressReasons: prog.reasons,
          noProgressStreak: prog.noProgressStreak, stuck: prog.stuck, frameFrozen: prog.frameFrozen,
          completed: completion.completed, completionMatched: completion.matched,
          recovery: recoveryResult,
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
        // 切断/クラッシュからの自己修復 (#16): 詰まり梯子(recovery コントローラ)とは**別系統**。
        //   観測不変(詰まり)と RPC 失敗(切断)は別現象なので梯子を共有しない（意図的な分離）。
        //   応答が無ければ mcp-mgba 再接続、ダメなら（ROM 指定時のみ）セッション再起動。
        //   maxFailures 到達前に復帰を狙い、復帰できたら consecutiveFailures をリセットする。
        if (recoverOn && state.consecutiveFailures >= failRecoverAfter && state.consecutiveFailures < maxFailures) {
          const alive = await bridgeAlive();
          if (!alive) {
            console.warn('🔧 bridge 応答なし → mcp-mgba 再接続を試行');
            let recovered = false;
            try { recovered = await reconnectClient(); } catch { recovered = false; }
            let strategy = 'reconnect';
            if (!recovered && restartRom) {
              console.warn('🔧 再接続失敗 → セッション再起動を試行');
              const rr = await restartSession();
              recovered = rr.ok; strategy = 'restart-session';
            }
            state.recoveries++;
            state.recoveryByStrategy[strategy] = (state.recoveryByStrategy[strategy] || 0) + 1;
            entry.recovery = { trigger: 'failure', strategy, ok: recovered };
            if (recovered) { state.consecutiveFailures = 0; console.warn('🔧 復帰成功'); }
            else console.warn('🔧 復帰できず（連続失敗が上限に達したら中断）');
          }
        }
        await sleep(500); // バックオフ
      }
      appendFileSync(stepsLog, JSON.stringify(entry) + '\n');

      // 完走したら成功終了。無進捗が STUCK_ABORT_STEPS 継続したら stuck 中断（opt-in）。
      // ※ 詰まり自体の自己修復は上のループ内で実施済み。ここは最終的な停止判定のみ。
      if (completion?.completed) { state.stopReason = 'completed'; break; }
      if (stuckAbort > 0 && (prog?.noProgressStreak ?? 0) >= stuckAbort) {
        state.stopReason = 'stuck';
        console.warn(`⛔ 無進捗が ${stuckAbort} ステップ継続 → 中断（stuck / リカバリは #16）`);
        break;
      }
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
