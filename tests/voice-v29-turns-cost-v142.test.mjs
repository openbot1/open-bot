/**
 * Tests for voice v29 units: turn detector, cost math, cascaded
 * pipeline budgets and the append-only context (v1.42, Team T4).
 *
 * Covers: speech/silence/backchannel/noise classification, the
 * 800ms cascaded budget and degraded mode, per-minute cost math
 * (gpt-live $0.05/min, split input/output rates, caps), add-only
 * extraction semantics (compaction supersedes, never deletes)
 * and time-travel queries.
 *
 * All offline, deterministic, no key / network / audio.
 * Only the v29 namespace is asserted — no global totals.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AppendOnlyContextV29,
  AudioTurnDetectorV29,
  CascadedPipelineV29,
  CostLedgerV29,
  DelegatedToolRunnerV29,
  ProactiveAudioV29,
  VOICE_V29_CASCADED_BUDGET_TOTAL_MS,
  VOICE_V29_MODEL_CATALOG,
  VOICE_V29_S2S_BUDGET_TOTAL_MS,
  costForMinutesV29,
  costForSliceV29,
  createAppendOnlyContextV29,
  createAudioTurnDetectorV29,
  createCascadedPipelineV29,
  createCostLedgerV29,
  createDelegatedToolRunnerV29,
  createProactiveAudioV29,
  isKnownModelV29,
  modelInfoV29,
  rateForModelV29,
} from '../packages/core/dist/voiceV29/index.js';

function feed(detector, fromMs, count, energy, text) {
  const results = [];
  for (let i = 0; i < count; i += 1) {
    results.push(detector.feed({ atMs: fromMs + i * 50, energy, text: text ?? null }));
  }
  return results;
}

test('v29 turn detector: silence only never starts a turn', () => {
  const detector = createAudioTurnDetectorV29();
  const results = feed(detector, 0, 20, 0.02);
  assert.ok(results.every((r) => r.kind === 'silence'));
  assert.ok(results.every((r) => !r.turnStarted && !r.turnEnded));
  assert.equal(detector.stats().turns, 0);
});

test('v29 turn detector: speech then silence ends one turn', () => {
  const detector = createAudioTurnDetectorV29();
  const speech = feed(detector, 0, 10, 0.8, 'hello');
  assert.equal(speech[0].turnStarted, true);
  assert.equal(speech[0].kind, 'speech');
  const silence = feed(detector, 500, 18, 0.02);
  const ended = silence.find((r) => r.turnEnded);
  assert.notEqual(ended, undefined);
  assert.equal(ended?.endReason, 'silence');
  assert.equal(detector.stats().turns, 1);
  const turn = detector.lastTurn();
  assert.notEqual(turn, null);
  assert.ok((turn?.durationMs ?? 0) >= 400);
  // One text fragment per speech frame: the turn text accumulates.
  assert.equal(turn?.text, 'hello '.repeat(10).trim());
  assert.equal(turn?.frames, 10);
});

test('v29 turn detector: a burst too short to be speech is noise, not a turn', () => {
  // Note: duration is measured to the turn end, so a short burst
  // only counts as noise when the turn is ended promptly (here
  // with an explicit end); waiting out the silence timeout would
  // stretch the measured duration past the minimum.
  const detector = createAudioTurnDetectorV29();
  feed(detector, 0, 2, 0.8);
  const ended = detector.endNow(100, 'explicit');
  assert.equal(ended, null);
  assert.equal(detector.stats().turns, 0);
  assert.equal(detector.stats().noiseRejected, 1);
  assert.equal(detector.lastTurn(), null);
});

test('v29 turn detector: a short quiet burst is a backchannel, not a turn', () => {
  // Same timing note as the noise test: end the burst promptly,
  // otherwise the silence-timeout wait stretches the measured
  // duration past the backchannel limit.
  const detector = createAudioTurnDetectorV29();
  feed(detector, 0, 6, 0.3);
  const ended = detector.endNow(300, 'explicit');
  assert.notEqual(ended, null);
  assert.equal(ended?.backchannel, true);
  assert.equal(detector.stats().turns, 0);
  assert.equal(detector.stats().backchannels, 1);
});

test('v29 turn detector: keyword ends the turn immediately', () => {
  const detector = createAudioTurnDetectorV29({ config: { endKeyword: 'stop' } });
  feed(detector, 0, 5, 0.8, 'please');
  const hit = detector.feed({ atMs: 250, energy: 0.8, text: 'stop now' });
  assert.equal(hit.turnEnded, true);
  assert.equal(hit.endReason, 'keyword');
});

test('v29 turn detector: presets exist and apply', () => {
  const detector = createAudioTurnDetectorV29();
  const config = detector.applyPreset('sensitive');
  assert.equal(typeof config.threshold, 'number');
  assert.ok(config.threshold < 0.18);
  assert.equal(detector.getConfig().threshold, config.threshold);
});

test('v29 cost math: flat and split rates', () => {
  assert.equal(costForMinutesV29(2, 0.05), 0.1);
  assert.equal(costForMinutesV29(0, 0.05), 0);
  assert.equal(costForMinutesV29(10, 0), 0);
  const live = rateForModelV29(
    [{ modelId: 'gpt-live', usdPerMinute: 0.05, usdPerMinuteInput: null, usdPerMinuteOutput: null, source: 't', overridden: false }],
    'gpt-live',
  );
  assert.notEqual(live, null);
  assert.equal(costForSliceV29(1, 1, live), 0.1);
  const realtime = rateForModelV29(
    [{ modelId: 'gpt-realtime-2.1', usdPerMinute: 0.08, usdPerMinuteInput: 0.04, usdPerMinuteOutput: 0.12, source: 't', overridden: false }],
    'gpt-realtime-2.1',
  );
  assert.equal(costForSliceV29(1, 1, realtime), 0.16);
  assert.equal(costForSliceV29(0, 0, realtime), 0);
});

test('v29 model catalog: realtime models from the 2026 survey', () => {
  assert.equal(isKnownModelV29('gpt-realtime-2.1'), true);
  assert.equal(isKnownModelV29('gpt-live'), true);
  assert.equal(isKnownModelV29('gemini-3.8-live'), true);
  assert.equal(isKnownModelV29('gpt-99'), false);
  const live = modelInfoV29('gpt-live');
  assert.equal(live?.architecture, 'full-duplex');
  assert.equal(live?.serverDrivenBargeIn, true);
  assert.equal(live?.delegatesToolCalls, true);
  const realtime = modelInfoV29('gpt-realtime-2.1');
  assert.equal(realtime?.contextTokens, 128000);
  assert.equal(realtime?.maxOutputTokens, 32000);
  const gemini = modelInfoV29('gemini-3.8-live');
  assert.equal(gemini?.contextTokens, 131000);
  assert.equal(gemini?.asyncFunctionCallingDefault, true);
  assert.equal(gemini?.proactiveAudio, true);
  assert.equal(VOICE_V29_MODEL_CATALOG.length, 6);
});

test('v29 cost ledger: meter, tick, report and session cap', () => {
  const ledger = createCostLedgerV29({ sessionCapUsd: 0.1 });
  const meter = ledger.startSession('s1', 'gpt-live', 0);
  assert.equal(meter.modelId, 'gpt-live');
  const entry = ledger.tick('s1', 60_000, 60_000, 60_000);
  assert.notEqual(entry, null);
  assert.equal(entry?.usd, 0.1);
  assert.equal(entry?.inputMinutes, 1);
  assert.equal(entry?.outputMinutes, 1);
  // Past the cap, further ticks bill $0.
  const capped = ledger.tick('s1', 60_000, 60_000, 120_000);
  assert.equal(capped?.usd, 0);
  assert.equal(ledger.getMeter('s1')?.capped, true);
  const report = ledger.report();
  assert.equal(report.sessions, 1);
  assert.equal(report.totalUsd, 0.1);
  assert.equal(ledger.tick('no-such-session', 1000, 1000, 0), null);
});

test('v29 cost ledger: estimate and host rate override', () => {
  const ledger = createCostLedgerV29();
  const estimate = ledger.estimate('gpt-live', 10, 0);
  assert.equal(estimate.modelId, 'gpt-live');
  assert.equal(estimate.estimatedUsd, 0.5);
  const overridden = ledger.overrideRate('gpt-live', 0.1);
  assert.equal(overridden.usdPerMinute, 0.1);
  assert.equal(overridden.overridden, true);
  assert.equal(ledger.estimate('gpt-live', 10, 0).estimatedUsd, 1);
  // Markdown only lists models with billed entries, so bill one
  // minute first; the report then names the model.
  ledger.startSession('est1', 'gpt-live', 0);
  ledger.tick('est1', 60_000, 0, 60_000);
  assert.match(ledger.toMarkdown(), /gpt-live/);
});

test('v29 pipeline: budgets, within-budget and over-budget turns', async () => {
  assert.equal(VOICE_V29_CASCADED_BUDGET_TOTAL_MS, 800);
  assert.equal(VOICE_V29_S2S_BUDGET_TOTAL_MS, 300);
  const pipeline = createCascadedPipelineV29();
  const ok = await pipeline.runCascaded('hello', 0, { stt: 120, llm: 280, tts: 140 });
  assert.equal(ok.totalMs, 540);
  assert.equal(ok.withinBudget, true);
  assert.deepEqual(ok.overBudgetStages, []);
  const over = await pipeline.runCascaded('hello', 1000, { stt: 300, llm: 500, tts: 300 });
  assert.equal(over.totalMs, 1100);
  assert.equal(over.withinBudget, false);
  assert.ok(over.overBudgetStages.includes('llm'));
  const s2s = await pipeline.runSpeechToSpeech('hi', 3000, 180);
  assert.equal(s2s.totalMs, 180);
  assert.equal(s2s.withinBudget, true);
  const stats = pipeline.stats();
  assert.equal(stats.turns, 3);
  assert.ok(stats.withinBudgetPct > 0 && stats.withinBudgetPct < 100);
  assert.ok(stats.p95Ms >= 540);
  assert.match(pipeline.report().toString(), /./);
});

test('v29 pipeline: repeated over-budget turns switch on degraded mode', async () => {
  const pipeline = createCascadedPipelineV29({ degradedAfter: 2, recoverAfter: 2 });
  assert.equal(pipeline.isDegraded(), false);
  await pipeline.runCascaded('a', 0, { stt: 400, llm: 600, tts: 400 });
  assert.equal(pipeline.isDegraded(), false);
  await pipeline.runCascaded('b', 2000, { stt: 400, llm: 600, tts: 400 });
  assert.equal(pipeline.isDegraded(), true);
  await pipeline.runCascaded('c', 4000, { stt: 120, llm: 280, tts: 140 });
  await pipeline.runCascaded('d', 5000, { stt: 120, llm: 280, tts: 140 });
  assert.equal(pipeline.isDegraded(), false);
});

test('v29 context: add-only — compaction supersedes, never deletes', () => {
  const context = createAppendOnlyContextV29({ sessionId: 'c1' });
  context.appendUserTurn('first thing', 100);
  context.appendAgentTurn('first reply', 200);
  context.appendUserTurn('second thing', 300);
  assert.equal(context.all().length, 3);
  assert.equal(context.live().length, 3);
  const result = context.compact(400);
  assert.notEqual(result, null);
  assert.equal(result?.supersededCount, 3);
  // Nothing was deleted: history still holds every item.
  assert.equal(context.all().length, 4);
  assert.equal(context.live().length, 1);
  assert.equal(context.live()[0].kind, 'summary');
  const old = context.get(1);
  assert.equal(old?.superseded, true);
  assert.equal(old?.supersededBySeq, 4);
  assert.equal(context.needsCompaction(), false);
  // Search still finds superseded history when asked; the live
  // summary itself quotes the compacted items, so it matches too.
  assert.equal(context.search('first', false).length, 3);
  assert.equal(context.search('first').length, 1);
  assert.equal(context.search('first')[0].kind, 'summary');
});

test('v29 context: time-travel query returns what was true at time X', () => {
  const context = new AppendOnlyContextV29({ sessionId: 'c2' });
  context.appendUserTurn('at one hundred', 100);
  context.appendAgentTurn('at two hundred', 200);
  assert.equal(context.asOf(150).length, 1);
  assert.equal(context.asOf(150)[0].text, 'at one hundred');
  assert.equal(context.asOf(250).length, 2);
  assert.equal(context.asOf(50).length, 0);
  assert.equal(context.byKind('agent-turn').length, 1);
  // The agent reply shares the user turn's index (turn 0 = both items).
  assert.equal(context.byTurn(0).length, 2);
});

test('v29 delegate runner: async call, approval gate, retry on failure', async () => {
  const runner = createDelegatedToolRunnerV29();
  runner.registerTool({
    name: 'echo',
    description: 'Echo.',
    sensitive: false,
    execute: (args) => JSON.stringify({ echoed: args }),
  });
  runner.registerTool({
    name: 'secret-read',
    description: 'Needs approval.',
    sensitive: true,
    execute: () => 'top-secret',
  });
  const call = runner.delegate('s1', 'echo', { ping: 1 }, 0, { mode: 'async' });
  assert.equal(call.state, 'queued');
  const finished = await runner.pump(100);
  assert.equal(finished.length, 1);
  assert.equal(finished[0].state, 'done');
  assert.match(finished[0].result ?? '', /ping/);
  // Sensitive tools wait for approval instead of running.
  const gated = runner.delegate('s1', 'secret-read', {}, 200, { mode: 'async' });
  const pumped = await runner.pump(300);
  assert.equal(pumped.length, 0);
  assert.equal(runner.list('s1').find((c) => c.id === gated.id)?.state, 'awaiting-approval');
  assert.equal(runner.stats().awaitingApproval, 1);
  assert.equal(runner.stats().done, 1);
  assert.throws(() => runner.delegate('s1', 'ghost', {}, 400), /Unknown delegated tool/);
  assert.throws(
    () => runner.registerTool({ name: 'Bad Name!', description: 'x', sensitive: false, execute: () => '' }),
    /Invalid delegated tool name/,
  );
});

test('v29 proactive: schedule, tick, quiet hours and cooldown', () => {
  const proactive = createProactiveAudioV29({ enabled: true });
  const trigger = proactive.schedule('reminder', 'Drink some water.', 5000, { createdAtMs: 0 });
  assert.equal(typeof trigger.id, 'string');
  assert.deepEqual(proactive.tick(4000), { fired: null, suppressed: [] });
  const { fired } = proactive.tick(5000, {});
  assert.notEqual(fired, null);
  assert.equal(fired?.kind, 'reminder');
  assert.equal(proactive.stats().fired, 1);
  // Disabled proactive suppresses instead of firing.
  const off = createProactiveAudioV29({ enabled: false });
  off.schedule('greeting', 'Hi!', 1000, { createdAtMs: 0 });
  const result = off.tick(1000, {});
  assert.equal(result.fired, null);
  assert.equal(result.suppressed.length, 1);
  assert.equal(result.suppressed[0].kind, 'suppressed-consent');
});
