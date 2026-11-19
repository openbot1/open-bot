/**
 * Tests for voice v24 dynamic provider catalogue, provider
 * health and mid-session model switching (v1.37, Team T5).
 *
 * Covers DynamicProviderCatalogV24 (starts empty, register /
 * probe / status derivation / usable / models / stale),
 * ProviderHealthTrackerV24 (score formula, grades, degraded,
 * flaps, uptime, prune) and VoiceModelSwitcherV24 (switch
 * validation, transcript preservation, history, rollback).
 *
 * All offline, deterministic, no key / network / audio.
 * Probes are caller-supplied measurements.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DynamicProviderCatalogV24,
  createDynamicProviderCatalogV24,
  providerDescriptorV24,
  validateProviderDescriptorV24,
  defaultDynamicProviderCatalogV24Options,
  validateDynamicProviderCatalogV24Options,
} from '../packages/core/dist/voiceV24/providerCatalogV24.js';
import {
  ProviderHealthTrackerV24,
  createProviderHealthTrackerV24,
  healthGradeV24,
  defaultProviderHealthV24Options,
  validateProviderHealthV24Options,
} from '../packages/core/dist/voiceV24/providerHealthV24.js';
import {
  VoiceModelSwitcherV24,
  createModelSwitcherV24,
  defaultModelSwitchV24Options,
  validateModelSwitchV24Options,
} from '../packages/core/dist/voiceV24/modelSwitchV24.js';
import {
  deriveProviderStatusV24,
} from '../packages/core/dist/voiceV24/types.js';

const TRANSCRIPT = [
  { role: 'user', text: 'xin chào', atMs: 0 },
  { role: 'assistant', text: 'chào bạn, tôi có thể giúp gì?', atMs: 100 },
];

function catalogWith(codexLatency = 120, ollamaOk = true) {
  const catalog = createDynamicProviderCatalogV24();
  catalog.register(providerDescriptorV24({
    id: 'codex', label: 'Codex', kind: 'subscription',
    models: [
      { id: 'gpt-5.2', label: 'GPT-5.2', supportsVoice: true },
      { id: 'gpt-5.2-mini', label: 'GPT-5.2 mini', supportsVoice: true },
      { id: 'gpt-4-old', label: 'GPT-4 old', deprecated: true },
    ],
    configured: true, accountLabel: 'demo@example.com', source: 'cli',
  }), 0);
  catalog.register(providerDescriptorV24({
    id: 'ollama', label: 'Ollama', kind: 'local',
    models: [{ id: 'qwen3:8b', label: 'Qwen3 8B' }],
    configured: true, source: 'local',
  }), 0);
  catalog.register(providerDescriptorV24({
    id: 'openai', label: 'OpenAI', kind: 'api',
    models: [{ id: 'gpt-5.2', label: 'GPT-5.2' }],
    configured: false, source: 'api-key',
  }), 0);
  catalog.recordProbe({ providerId: 'codex', atMs: 100, ok: true, latencyMs: codexLatency });
  catalog.recordProbe({ providerId: 'ollama', atMs: 100, ok: ollamaOk, latencyMs: 300 });
  return catalog;
}

// ---------------------------------------------------------------- status derivation
test('voice v137-t5: status derivation — unconfigured/unknown/offline/degraded/online', () => {
  const base = {
    configured: true, everProbed: true, lastProbeOk: true,
    lastProbeAtMs: 100, lastProbeLatencyMs: 100, nowMs: 200,
    staleAfterMs: 60000, degradedLatencyMs: 2000,
  };
  assert.equal(deriveProviderStatusV24(base), 'online');
  assert.equal(deriveProviderStatusV24({ ...base, configured: false }), 'unconfigured');
  assert.equal(deriveProviderStatusV24({ ...base, everProbed: false, lastProbeAtMs: null }), 'unknown');
  assert.equal(deriveProviderStatusV24({ ...base, nowMs: 100000 }), 'unknown');
  assert.equal(deriveProviderStatusV24({ ...base, lastProbeOk: false }), 'offline');
  assert.equal(deriveProviderStatusV24({ ...base, lastProbeLatencyMs: 5000 }), 'degraded');
  assert.equal(deriveProviderStatusV24({ ...base, lastProbeLatencyMs: 2000 }), 'online');
});

// ---------------------------------------------------------------- catalogue
test('voice v137-t5: catalogue — starts empty, no hard-coded providers', () => {
  const catalog = createDynamicProviderCatalogV24();
  assert.equal(catalog.count(), 0);
  assert.deepEqual(catalog.list(), []);
  assert.deepEqual(catalog.usable(), []);
  assert.equal(catalog.summary(), '0 providers (0 online, 0 degraded, 0 offline, 0 unconfigured, 0 unknown), 0 usable, mean probe latency 0ms.');
  assert.throws(() => catalog.snapshot('codex'), /Unknown provider/);
  assert.throws(() => catalog.recordProbe({ providerId: 'codex', atMs: 0, ok: true, latencyMs: 1 }), /register it first/);
  assert.deepEqual(defaultDynamicProviderCatalogV24Options(), { staleAfterMs: 60000, degradedLatencyMs: 2000 });
  assert.deepEqual(validateDynamicProviderCatalogV24Options({}), []);
  assert.ok(validateDynamicProviderCatalogV24Options({ staleAfterMs: 0 }).length > 0);
});

test('voice v137-t5: catalogue — register/probe/list ordering, usable, models, stale', () => {
  const catalog = catalogWith();
  assert.equal(catalog.count(), 3);
  const list = catalog.list(200);
  assert.deepEqual(list.map((p) => p.id), ['codex', 'ollama', 'openai']);
  assert.deepEqual(list.map((p) => p.status), ['online', 'online', 'unconfigured']);
  assert.equal(catalog.statusOf('openai', 200), 'unconfigured');
  assert.equal(catalog.usable(200).length, 2);
  const counts = catalog.counts(200);
  assert.equal(counts.online, 2);
  assert.equal(counts.unconfigured, 1);
  assert.equal(counts.total, 3);
  // Deprecated models sort last.
  assert.deepEqual(catalog.modelsFor('codex').map((m) => m.id), ['gpt-5.2', 'gpt-5.2-mini', 'gpt-4-old']);
  assert.equal(catalog.findModel({ providerId: 'codex', model: 'gpt-5.2' }).label, 'GPT-5.2');
  assert.equal(catalog.findModel({ providerId: 'codex', model: 'nope' }), null);
  assert.equal(catalog.findModel({ providerId: 'nope', model: 'gpt-5.2' }), null);
  assert.equal(catalog.hasModel({ providerId: 'codex', model: 'gpt-4-old' }), false);
  assert.equal(catalog.hasModel({ providerId: 'codex', model: 'gpt-5.2' }), true);
  assert.equal(catalog.meanProbeLatencyMs(), 210);
  // Stale probe: at 200000ms both probed providers need a re-probe.
  assert.deepEqual(catalog.needsProbe(200000), ['codex', 'ollama', 'openai']);
  assert.deepEqual(catalog.needsProbe(200), ['openai']);
  assert.match(catalog.markdown(200), /# Voice v24 dynamic providers/);
  assert.match(catalog.markdown(200), /\| Codex \(codex\) \| subscription \| online \| 3 \|/);
  assert.equal(catalog.remove('openai'), true);
  assert.equal(catalog.remove('openai'), false);
  assert.equal(catalog.count(), 2);
});

test('voice v137-t5: catalogue — degraded latency + failed probe + descriptor validation', () => {
  const catalog = catalogWith(5000, false);
  assert.equal(catalog.statusOf('codex', 200), 'degraded');
  assert.equal(catalog.statusOf('ollama', 200), 'offline');
  assert.equal(catalog.usable(200).length, 1);
  assert.equal(catalog.usable(200)[0].id, 'codex');
  assert.deepEqual(validateProviderDescriptorV24({
    id: 'x', label: 'X', kind: 'api', models: [], configured: true, source: 'api-key',
  }), []);
  assert.ok(validateProviderDescriptorV24({
    id: 'bad id', label: '', kind: 'nope', models: [{ id: '' }], configured: 'yes', source: 'nope',
  }).length >= 4);
  assert.ok(validateProviderDescriptorV24({
    id: 'x', label: 'X', kind: 'api',
    models: [{ id: 'm' }, { id: 'm' }], configured: true, source: 'api-key',
  }).some((e) => e.includes('duplicate')));
  assert.throws(() => providerDescriptorV24({ id: '', label: 'X', kind: 'api' }), /Invalid provider descriptor/);
  assert.throws(() => catalog.register({
    id: 'bad id', label: 'X', kind: 'api', models: [], configured: true, source: 'api-key',
  }), /Invalid provider descriptor/);
});

// ---------------------------------------------------------------- health
test('voice v137-t5: health — grades, score formula, no-data state', () => {
  assert.equal(healthGradeV24(95), 'A');
  assert.equal(healthGradeV24(80), 'B');
  assert.equal(healthGradeV24(60), 'C');
  assert.equal(healthGradeV24(40), 'D');
  assert.equal(healthGradeV24(10), 'F');
  assert.deepEqual(defaultProviderHealthV24Options(), {
    windowMs: 3600000, goodLatencyMs: 500, badLatencyMs: 3000,
    degradedBelow: 60, degradedFailures: 3, maxProbesPerProvider: 200,
  });
  assert.deepEqual(validateProviderHealthV24Options({}), []);
  assert.ok(validateProviderHealthV24Options({ goodLatencyMs: 5000, badLatencyMs: 1000 }).length > 0);
  const health = createProviderHealthTrackerV24();
  const empty = health.score('codex', 1000);
  assert.equal(empty.hasData, false);
  assert.equal(empty.score, 0);
  assert.equal(empty.grade, 'F');
  assert.equal(health.meanScore(1000), null);
  assert.equal(health.summary(1000), 'No provider probe history yet.');
});

test('voice v137-t5: health — perfect provider scores 100, flapping provider loses stability', () => {
  const health = createProviderHealthTrackerV24();
  for (let i = 0; i < 10; i += 1) {
    health.record({ providerId: 'codex', atMs: i * 1000, ok: true, latencyMs: 100 });
  }
  const good = health.score('codex', 10000);
  assert.equal(good.probes, 10);
  assert.equal(good.successRate, 1);
  assert.equal(good.meanLatencyMs, 100);
  assert.equal(good.flapRate, 0);
  assert.equal(good.score, 100);
  assert.equal(good.grade, 'A');
  assert.equal(good.degraded, false);
  assert.equal(health.uptime('codex', 10000), 1);
  // Flapping: alternating ok/fail, same success rate 0.5 but stability 0.
  const flappy = createProviderHealthTrackerV24();
  for (let i = 0; i < 10; i += 1) {
    flappy.record({ providerId: 'flap', atMs: i * 1000, ok: i % 2 === 0, latencyMs: 100 });
  }
  const flapScore = flappy.score('flap', 10000);
  assert.equal(flapScore.successRate, 0.5);
  assert.equal(flapScore.flapRate, 1);
  assert.equal(flapScore.score, 55);
  assert.equal(flapScore.degraded, true);
  assert.equal(flapScore.grade, 'D');
});

test('voice v137-t5: health — consecutive failures degrade, prune drops old probes', () => {
  const health = createProviderHealthTrackerV24();
  for (let i = 0; i < 5; i += 1) {
    health.record({ providerId: 'bad', atMs: i * 1000, ok: true, latencyMs: 100 });
  }
  for (let i = 5; i < 8; i += 1) {
    health.record({ providerId: 'bad', atMs: i * 1000, ok: false, latencyMs: 0, error: 'timeout' });
  }
  assert.equal(health.consecutiveFailures('bad'), 3);
  const score = health.score('bad', 8000);
  assert.equal(score.degraded, true);
  assert.equal(health.degradedProviders(8000).length, 1);
  assert.equal(health.degradedProviders(8000)[0].providerId, 'bad');
  assert.match(health.markdown(8000), /# Voice v24 provider health/);
  assert.match(health.markdown(8000), /\| bad \| 8 \|/);
  // Window is 1h: nothing pruned at 8000ms; at 4h all probes are stale.
  assert.equal(health.prune(8000), 0);
  assert.equal(health.prune(4 * 3600000), 8);
  assert.equal(health.probeCount('bad'), 0);
  assert.throws(() => health.record({ providerId: 'x', atMs: -1, ok: true, latencyMs: 1 }), /atMs/);
});

// ---------------------------------------------------------------- switcher
test('voice v137-t5: switcher — happy path preserves transcript, history + models used', () => {
  const catalog = catalogWith();
  const switcher = createModelSwitcherV24('s1', { providerId: 'codex', model: 'gpt-5.2' });
  assert.deepEqual(switcher.currentModel(), { providerId: 'codex', model: 'gpt-5.2' });
  assert.equal(switcher.canRollback(), false);
  const result = switcher.switchTo(catalog, { providerId: 'ollama', model: 'qwen3:8b' }, TRANSCRIPT, 1000);
  assert.equal(result.ok, true);
  assert.equal(result.transcriptPreserved, true);
  assert.equal(result.transcriptTurns, 2);
  assert.deepEqual(switcher.currentModel(), { providerId: 'ollama', model: 'qwen3:8b' });
  assert.equal(switcher.switchCount(), 1);
  assert.equal(switcher.historyList().length, 1);
  assert.equal(switcher.historyList()[0].from.model, 'gpt-5.2');
  assert.deepEqual(switcher.modelsUsed(), [
    { providerId: 'codex', model: 'gpt-5.2' },
    { providerId: 'ollama', model: 'qwen3:8b' },
  ]);
  assert.match(switcher.summary(), /1 switches/);
  assert.deepEqual(defaultModelSwitchV24Options(), { allowUnusableSwitch: false, maxHistory: 100 });
  assert.deepEqual(validateModelSwitchV24Options({}), []);
});

test('voice v137-t5: switcher — refusals: unknown provider/model, deprecated, same model, unconfigured, offline', () => {
  const catalog = catalogWith();
  const switcher = new VoiceModelSwitcherV24('s1', { providerId: 'codex', model: 'gpt-5.2' });
  const same = switcher.switchTo(catalog, { providerId: 'codex', model: 'gpt-5.2' }, TRANSCRIPT, 100);
  assert.equal(same.ok, false);
  assert.match(same.reason, /Already on that model/);
  const unknownProvider = switcher.switchTo(catalog, { providerId: 'nope', model: 'x' }, TRANSCRIPT, 100);
  assert.equal(unknownProvider.ok, false);
  assert.match(unknownProvider.reason, /not in the dynamic catalogue/);
  const unknownModel = switcher.switchTo(catalog, { providerId: 'codex', model: 'nope' }, TRANSCRIPT, 100);
  assert.equal(unknownModel.ok, false);
  assert.match(unknownModel.reason, /not offered/);
  const deprecated = switcher.switchTo(catalog, { providerId: 'codex', model: 'gpt-4-old' }, TRANSCRIPT, 100);
  assert.equal(deprecated.ok, false);
  assert.match(deprecated.reason, /deprecated/);
  const unconfigured = switcher.switchTo(catalog, { providerId: 'openai', model: 'gpt-5.2' }, TRANSCRIPT, 100);
  assert.equal(unconfigured.ok, false);
  assert.match(unconfigured.reason, /unconfigured/);
  const offlineCatalog = catalogWith(120, false);
  const offline = switcher.switchTo(offlineCatalog, { providerId: 'ollama', model: 'qwen3:8b' }, TRANSCRIPT, 100);
  assert.equal(offline.ok, false);
  assert.match(offline.reason, /offline/);
  // A failed switch leaves the current model untouched.
  assert.deepEqual(switcher.currentModel(), { providerId: 'codex', model: 'gpt-5.2' });
  assert.equal(switcher.switchCount(), 0);
});

// ---------------------------------------------------------------- budgets / fallback / refresh
test('voice v137-t5: budgets — per-call/session/turn breach + burn-down + per-tool table', async () => {
  const { ToolBudgetRegistryV24, createToolBudgetRegistryV24 } = await import(
    '../packages/core/dist/voiceV24/toolBudgetsV24.js'
  );
  const budgets = createToolBudgetRegistryV24();
  budgets.setBudget({ toolName: 'web_search', perCallMs: 500, perSessionMs: 1000, perTurnMs: 800 });
  assert.equal(budgets.perCallBudgetMs('web_search'), 500);
  assert.equal(budgets.perCallBudgetMs('unknown_tool'), 10000);
  budgets.setSessionBudget('s1', 2000);
  assert.equal(budgets.sessionBudgetMs('s1'), 2000);
  const call = {
    id: 'tc-1', sessionId: 's1', toolName: 'web_search', turnIndex: 0,
    startedAtMs: 0, endedAtMs: 700, durationMs: 700, status: 'completed',
  };
  const raised = budgets.recordFinished(call, 700, 700);
  assert.equal(raised.length, 1);
  assert.equal(raised[0].kind, 'per-call');
  assert.equal(raised[0].overByMs, 200);
  // Same call re-checked does not duplicate the breach.
  assert.equal(budgets.recordFinished(call, 700, 700).length, 0);
  // A second call pushes the session total (2100ms) over the
  // session budget (2000ms) and the turn total over 800ms.
  const call2 = { ...call, id: 'tc-2', startedAtMs: 800, endedAtMs: 2200, durationMs: 1400 };
  const raised2 = budgets.recordFinished(call2, 2100, 2100);
  assert.ok(raised2.some((b) => b.kind === 'per-call'));
  assert.ok(raised2.some((b) => b.kind === 'per-session'));
  assert.ok(raised2.some((b) => b.kind === 'per-turn'));
  assert.equal(budgets.breachCount('s1'), 4);
  const burn = budgets.sessionBurnDown('s1', [call, call2], 3000);
  assert.equal(burn.spentMs, 2100);
  assert.equal(burn.budgetMs, 2000);
  assert.equal(burn.spentRatio, 1.05);
  assert.equal(burn.breached, true);
  assert.match(budgets.summary('s1', [call, call2], 3000), /105%/);
  const perTool = budgets.perToolBurnDown('s1', [call, call2]);
  assert.equal(perTool.length, 1);
  assert.equal(perTool[0].burn.spentMs, 2100);
  assert.equal(perTool[0].burn.breached, true);
  assert.throws(() => budgets.setBudget({ toolName: '', perCallMs: 1 }), /toolName/);
  assert.throws(() => budgets.recordFinished({ ...call, durationMs: null }, 0, 0), /no duration/);
  assert.equal(new ToolBudgetRegistryV24().breachCount(), 0);
});

test('voice v137-t5: fallback chain — pick, wrap-around, exhausted, session auto-fallback', async () => {
  const { ModelFallbackChainV24, createModelFallbackChainV24 } = await import(
    '../packages/core/dist/voiceV24/modelFallbackV24.js'
  );
  const { VoiceSessionV24 } = await import('../packages/core/dist/voiceV24/voiceSessionV24.js');
  const catalog = catalogWith();
  const chain = createModelFallbackChainV24([
    { providerId: 'codex', model: 'gpt-5.2' },
    { providerId: 'ollama', model: 'qwen3:8b' },
    { providerId: 'openai', model: 'gpt-5.2' },
  ]);
  assert.equal(chain.length(), 3);
  assert.equal(chain.indexOf({ providerId: 'ollama', model: 'qwen3:8b' }), 1);
  // Current is the last usable link in chain order after codex: ollama.
  const picked = chain.pickFallback(catalog, { providerId: 'codex', model: 'gpt-5.2' }, 200);
  assert.deepEqual(picked.to, { providerId: 'ollama', model: 'qwen3:8b' });
  assert.equal(picked.skipped.length, 0);
  // Wrap-around: from ollama, the next usable is codex (openai is unconfigured, skipped).
  const wrapped = chain.pickFallback(catalog, { providerId: 'ollama', model: 'qwen3:8b' }, 200);
  assert.deepEqual(wrapped.to, { providerId: 'codex', model: 'gpt-5.2' });
  assert.equal(wrapped.skipped.length, 1);
  assert.match(wrapped.skipped[0].reason, /unconfigured/);
  const links = chain.linksWithUsability(catalog, 200);
  assert.deepEqual(links.map((l) => l.usable), [true, true, false]);
  assert.equal(chain.whyNot(catalog, { providerId: 'openai', model: 'gpt-5.2' }, 200), 'Provider "openai" is unconfigured (no login / key)');
  // Exhausted chain: every link unusable.
  const dead = new ModelFallbackChainV24([{ providerId: 'openai', model: 'gpt-5.2' }]);
  assert.deepEqual(dead.pickFallback(catalog, { providerId: 'codex', model: 'gpt-5.2' }, 200).to, null);
  assert.throws(() => new ModelFallbackChainV24([]), /at least one model/);
  assert.throws(() => new ModelFallbackChainV24([
    { providerId: 'a', model: 'm' }, { providerId: 'a', model: 'm' },
  ]), /Duplicate chain link/);
  // Session auto-fallback: codex goes offline, session moves to ollama, transcript kept.
  const session = VoiceSessionV24.open('s1', { providerId: 'codex', model: 'gpt-5.2' }, catalog, 0);
  session.addTurn('user', 'hello', 10);
  const checksumBefore = session.transcriptChecksum();
  catalog.recordProbe({ providerId: 'codex', atMs: 500, ok: false, latencyMs: 0, error: 'down' });
  const result = session.autoFallback(chain, 'codex went offline', 600);
  assert.equal(result.switched, true);
  assert.deepEqual(result.to, { providerId: 'ollama', model: 'qwen3:8b' });
  assert.equal(session.transcriptChecksum(), checksumBefore);
  assert.equal(chain.historyList('s1').length, 1);
  assert.equal(chain.exhaustedDecisions('s1').length, 0);
  assert.match(chain.summary(catalog, 600), /3 links, 1 usable now/);
});

test('voice v137-t5: refresh scheduler — due list, backoff, round, freshness', async () => {
  const { ProviderRefreshSchedulerV24, createProviderRefreshSchedulerV24 } = await import(
    '../packages/core/dist/voiceV24/providerRefreshV24.js'
  );
  const scheduler = createProviderRefreshSchedulerV24();
  scheduler.track('codex');
  scheduler.track('ollama');
  scheduler.track('openai');
  // Never probed: all due, openai (unconfigured) excluded by the caller's filter.
  const configured = (id) => id !== 'openai';
  assert.deepEqual(scheduler.dueList(0, configured).map((d) => d.providerId), ['codex', 'ollama']);
  assert.equal(scheduler.freshness(['codex', 'ollama', 'openai'], 0, configured), 0);
  scheduler.recordProbe('codex', 1000, true);
  scheduler.recordProbe('ollama', 1000, true);
  assert.deepEqual(scheduler.dueList(2000, configured), []);
  assert.equal(scheduler.freshness(['codex', 'ollama'], 2000, configured), 1);
  // Fail ollama 3 times: backoff grows (60s + 3*30s = 150s TTL).
  scheduler.recordProbe('ollama', 2000, false);
  scheduler.recordProbe('ollama', 3000, false);
  const state = scheduler.recordProbe('ollama', 4000, false);
  assert.equal(state.consecutiveFailures, 3);
  assert.equal(state.effectiveTtlMs, 150000);
  assert.equal(state.nextDueAtMs, 154000);
  // At 70000ms codex is due (TTL 60s from 1000), ollama is not (backoff).
  assert.deepEqual(scheduler.dueList(70000, configured).map((d) => d.providerId), ['codex']);
  const round = scheduler.recordRound([{ providerId: 'codex', ok: true }], 70000, configured);
  assert.deepEqual(round.refreshed, ['codex']);
  assert.deepEqual(round.stillDue, []);
  assert.equal(scheduler.roundsCompleted(), 1);
  assert.match(scheduler.summary(70000), /3 providers tracked, 1 due/);
  assert.equal(scheduler.untrack('openai'), true);
  assert.equal(scheduler.trackedIds().length, 2);
  assert.throws(() => scheduler.effectiveTtlMs('nope'), /not tracked/);
});

test('voice v137-t5: switcher — allowUnusableSwitch opts in, rollback restores previous model', () => {
  const catalog = catalogWith();
  const permissive = new VoiceModelSwitcherV24(
    's1',
    { providerId: 'codex', model: 'gpt-5.2' },
    { allowUnusableSwitch: true },
  );
  const result = permissive.switchTo(catalog, { providerId: 'openai', model: 'gpt-5.2' }, TRANSCRIPT, 100);
  assert.equal(result.ok, true);
  const rolled = permissive.rollback(TRANSCRIPT, 200);
  assert.equal(rolled.ok, true);
  assert.deepEqual(rolled.to, { providerId: 'codex', model: 'gpt-5.2' });
  assert.deepEqual(permissive.currentModel(), { providerId: 'codex', model: 'gpt-5.2' });
  assert.equal(permissive.canRollback(), false);
  assert.equal(permissive.rolledBackSwitches().length, 1);
  assert.equal(permissive.switchCount(), 2);
  // Second rollback has nothing to roll back to.
  const again = permissive.rollback(TRANSCRIPT, 300);
  assert.equal(again.ok, false);
  assert.match(again.reason, /No previous model/);
  assert.ok(validateModelSwitchV24Options({ maxHistory: 0 }).length > 0);
  assert.throws(() => new VoiceModelSwitcherV24('', { providerId: 'a', model: 'b' }), /sessionId/);
});
