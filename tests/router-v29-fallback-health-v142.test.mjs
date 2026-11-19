/**
 * Router v29 — fallback chain + provider health probe (v1.42, Doi T5, node:test).
 *
 * Covers (thuan, khong model that, khong network — executor/prober mock):
 * - Phan loai loi: 429 rate-limit, 401/403 auth, 5xx server, timeout,
 *   404 not-found, 400 invalid-request; retryable = rate-limit/server/
 *   timeout/unknown.
 * - Plan fallback: loi retryable -> buoc tiep theo; loi auth -> dung;
 *   het chain -> khong con buoc.
 * - Run chain (mock executor): loi model dau -> fallback model sau ok;
 *   tat ca loi -> gaveUp all-failed; loi auth -> dung ngay (fatal);
 *   config sai -> invalid-config.
 * - Default chain: cung loai truoc, text re nhat cuoi; registry
 *   register/list/remove/summary/lastRun.
 * - Health probe (mock): healthy/degraded/unhealthy theo loi lien tiep
 *   + nguong cham; uptime ratio; healthiest truoc; stale; default mock
 *   prober xac dinh theo ten provider.
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/router-v29-fallback-health-v142.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FallbackChainRegistryV29,
  buildDefaultFallbackChainV29,
  classifyProviderErrorV29,
  isRetryableProviderErrorV29,
  planFallbackChainV29,
  runFallbackChainV29,
  validateFallbackChainV29,
} from '../packages/core/dist/routerV29/fallbackChainV29.js';
import {
  HEALTH_SLOW_THRESHOLD_MS_V29,
  ProviderHealthTrackerV29,
  defaultMockProberV29,
  deriveProviderStatusV29,
  hashStringV29,
} from '../packages/core/dist/routerV29/healthProbeV29.js';
import { defaultModelCatalogV29 } from '../packages/core/dist/routerV29/modelCatalogV29.js';

const CHAIN = {
  chainId: 'voice-main',
  steps: [
    { modelId: 'gpt-realtime-2.1', provider: 'openai', reason: 'chinh' },
    { modelId: 'gemini-3.8-live', provider: 'gemini', reason: 'live re hon' },
    { modelId: 'gemini-2.5-flash', provider: 'gemini', reason: 'text re nhat' },
  ],
};

/** Executor mock: model trong failMap loi, con lai ok. */
function mockExecutor(failMap) {
  return async (modelId, _provider, _i) => {
    const fail = failMap[modelId];
    if (fail) return { ok: false, error: fail, latencyMs: 40 };
    return { ok: true, output: `ok:${modelId}`, latencyMs: 120 };
  };
}

test('fallback: phan loai loi + retryable', () => {
  assert.equal(classifyProviderErrorV29({ status: 429 }), 'rate-limit');
  assert.equal(classifyProviderErrorV29({ status: 401 }), 'auth');
  assert.equal(classifyProviderErrorV29({ status: 403 }), 'auth');
  assert.equal(classifyProviderErrorV29({ status: 500 }), 'server');
  assert.equal(classifyProviderErrorV29({ status: 503, message: 'overloaded' }), 'server');
  assert.equal(classifyProviderErrorV29({ status: 404 }), 'not-found');
  assert.equal(classifyProviderErrorV29({ status: 400 }), 'invalid-request');
  assert.equal(classifyProviderErrorV29({ code: 'ETIMEDOUT' }), 'timeout');
  assert.equal(classifyProviderErrorV29({ message: 'request timed out' }), 'timeout');
  assert.equal(classifyProviderErrorV29({ message: 'Rate limit exceeded' }), 'rate-limit');
  assert.equal(classifyProviderErrorV29({ message: 'invalid api key' }), 'auth');
  assert.equal(classifyProviderErrorV29({ message: 'weird thing' }), 'unknown');
  assert.equal(isRetryableProviderErrorV29('rate-limit'), true);
  assert.equal(isRetryableProviderErrorV29('server'), true);
  assert.equal(isRetryableProviderErrorV29('timeout'), true);
  assert.equal(isRetryableProviderErrorV29('unknown'), true);
  assert.equal(isRetryableProviderErrorV29('auth'), false);
  assert.equal(isRetryableProviderErrorV29('invalid-request'), false);
  assert.equal(isRetryableProviderErrorV29('not-found'), false);
});

test('fallback: validate chain', () => {
  assert.equal(validateFallbackChainV29(CHAIN).ok, true);
  assert.equal(validateFallbackChainV29({ chainId: '', steps: [] }).ok, false);
  assert.equal(validateFallbackChainV29({ chainId: 'x', steps: [] }).ok, false);
  assert.equal(
    validateFallbackChainV29({ chainId: 'x', steps: [{ modelId: 'a', provider: 'p' }, { modelId: 'a', provider: 'p' }] }).ok,
    false,
  );
  assert.equal(validateFallbackChainV29({ chainId: 'x', steps: [{ modelId: 'a', provider: 'p' }], maxAttempts: 0 }).ok, false);
  assert.equal(validateFallbackChainV29({ chainId: 'x', steps: [{ modelId: 'a', provider: 'p' }], maxAttempts: 5 }).ok, false);
});

test('fallback: plan — retryable di tiep, auth dung, het chain', () => {
  const plan = planFallbackChainV29(CHAIN, 'gpt-realtime-2.1', { status: 429, message: 'rate limit' });
  assert.equal(plan.errorKind, 'rate-limit');
  assert.equal(plan.retryable, true);
  assert.deepEqual(plan.nextSteps.map((s) => s.modelId), ['gemini-3.8-live', 'gemini-2.5-flash']);
  assert.ok(plan.reason.includes('gemini-3.8-live'));
  const authPlan = planFallbackChainV29(CHAIN, 'gpt-realtime-2.1', { status: 401, message: 'invalid api key' });
  assert.equal(authPlan.errorKind, 'auth');
  assert.equal(authPlan.retryable, false);
  assert.deepEqual(authPlan.nextSteps, []);
  const last = planFallbackChainV29(CHAIN, 'gemini-2.5-flash', { status: 500 });
  assert.equal(last.retryable, true);
  assert.deepEqual(last.nextSteps, []);
  assert.ok(last.reason.includes('khong con model'));
});

test('fallback: run — loi dau fallback sau ok, ghi attempt + ly do', async () => {
  const result = await runFallbackChainV29(
    CHAIN,
    mockExecutor({ 'gpt-realtime-2.1': { status: 429, message: 'rate limit' } }),
  );
  assert.equal(result.ok, true);
  assert.equal(result.modelId, 'gemini-3.8-live');
  assert.equal(result.attempts.length, 2);
  assert.equal(result.fallbackCount, 1);
  assert.equal(result.attempts[0].errorKind, 'rate-limit');
  assert.equal(result.attempts[0].ok, false);
  assert.equal(result.attempts[1].ok, true);
  assert.deepEqual(result.triedModelIds, ['gpt-realtime-2.1', 'gemini-3.8-live']);
  assert.equal(result.gaveUpReason, null);
  assert.equal(result.totalLatencyMs, 160);
});

test('fallback: run — tat ca loi -> all-failed; loi auth dung ngay', async () => {
  const allFail = await runFallbackChainV29(
    CHAIN,
    mockExecutor({
      'gpt-realtime-2.1': { status: 500, message: 'boom' },
      'gemini-3.8-live': { status: 503, message: 'overloaded' },
      'gemini-2.5-flash': { status: 500, message: 'boom' },
    }),
  );
  assert.equal(allFail.ok, false);
  assert.equal(allFail.attempts.length, 3);
  assert.equal(allFail.fallbackCount, 3);
  assert.ok(allFail.gaveUpReason.startsWith('all-failed'));
  const authFail = await runFallbackChainV29(
    CHAIN,
    mockExecutor({ 'gpt-realtime-2.1': { status: 401, message: 'invalid api key' } }),
  );
  assert.equal(authFail.ok, false);
  assert.equal(authFail.attempts.length, 1);
  assert.equal(authFail.attempts[0].fatal, true);
  assert.ok(authFail.gaveUpReason.includes('fatal-error (auth)'));
  // maxAttempts gioi han so buoc thu.
  const limited = await runFallbackChainV29(
    { ...CHAIN, maxAttempts: 1 },
    mockExecutor({ 'gpt-realtime-2.1': { status: 500, message: 'boom' } }),
  );
  assert.equal(limited.attempts.length, 1);
  // Config sai -> invalid-config, khong chay executor.
  let called = 0;
  const bad = await runFallbackChainV29({ chainId: 'bad', steps: [] }, async () => {
    called += 1;
    return { ok: true };
  });
  assert.equal(bad.ok, false);
  assert.equal(called, 0);
  assert.ok(bad.gaveUpReason.startsWith('invalid-config'));
  // Executor throw -> tinh la loi unknown, retry duoc.
  const threw = await runFallbackChainV29(
    { chainId: 't', steps: [{ modelId: 'a', provider: 'p' }, { modelId: 'b', provider: 'p' }] },
    async (modelId) => {
      if (modelId === 'a') throw new Error('socket hang up');
      return { ok: true, output: 'b-ok', latencyMs: 5 };
    },
  );
  assert.equal(threw.ok, true);
  assert.equal(threw.modelId, 'b');
});

test('fallback: default chain + registry', () => {
  const catalog = defaultModelCatalogV29();
  const chain = buildDefaultFallbackChainV29(catalog, 'gpt-realtime-2.1', 'auto-voice');
  assert.equal(chain.steps[0].modelId, 'gpt-realtime-2.1');
  assert.ok(chain.steps.length >= 3);
  assert.equal(chain.steps[chain.steps.length - 1].modelId, 'qwen3-4b');
  assert.ok(chain.steps.slice(1, -1).every((s) => {
    const m = catalog.find((x) => x.modelId === s.modelId);
    return m.kind === 'realtime' || m.kind === 'live';
  }));
  const registry = new FallbackChainRegistryV29();
  assert.equal(registry.register(CHAIN).ok, true);
  assert.equal(registry.register({ chainId: 'bad', steps: [] }).ok, false);
  assert.equal(registry.list().length, 1);
  assert.equal(registry.get('voice-main').chainId, 'voice-main');
  registry.recordRun({ chainId: 'voice-main', ok: true, modelId: 'gemini-3.8-live', provider: 'gemini', attempts: [], triedModelIds: [], gaveUpReason: null, totalLatencyMs: 1, fallbackCount: 1 });
  const summary = registry.summary();
  assert.equal(summary[0].lastRunOk, true);
  assert.equal(summary[0].lastRunModelId, 'gemini-3.8-live');
  assert.equal(summary[0].lastRunFallbacks, 1);
  assert.equal(registry.remove('voice-main'), true);
  assert.equal(registry.list().length, 0);
  assert.equal(registry.lastRun('voice-main'), undefined);
});

test('health: mock prober xac dinh + derive status', () => {
  assert.equal(hashStringV29('openai'), hashStringV29('openai'));
  assert.notEqual(hashStringV29('openai'), hashStringV29('gemini'));
  const prober = defaultMockProberV29();
  const ok = prober('openai');
  assert.equal(ok.ok, true);
  assert.ok(ok.latencyMs >= 120 && ok.latencyMs < 800);
  assert.equal(prober('openai').latencyMs, ok.latencyMs);
  assert.equal(defaultMockProberV29(['xai'])('xai').ok, false);
  assert.equal(deriveProviderStatusV29({ ok: true, latencyMs: 200 }, 0), 'healthy');
  assert.equal(deriveProviderStatusV29({ ok: true, latencyMs: HEALTH_SLOW_THRESHOLD_MS_V29 + 1 }, 0), 'degraded');
  assert.equal(deriveProviderStatusV29({ ok: false, latencyMs: 0 }, 0), 'degraded');
  assert.equal(deriveProviderStatusV29({ ok: false, latencyMs: 0 }, 2), 'unhealthy');
});

test('health: tracker — healthy, loi lien tiep -> unhealthy, uptime, stale', async () => {
  let now = 1000;
  const tracker = new ProviderHealthTrackerV29(() => now);
  const r1 = await tracker.probeProvider('openai');
  assert.equal(r1.status, 'healthy');
  assert.equal(r1.reachable, true);
  assert.equal(tracker.isProviderHealthy('openai'), true);
  assert.equal(tracker.recordFor('openai').uptimeRatio, 1);
  // 3 loi lien tiep -> unhealthy.
  const failProber = () => ({ ok: false, latencyMs: 0, error: 'mock down' });
  await tracker.probeProvider('xai', failProber);
  await tracker.probeProvider('xai', failProber);
  const third = await tracker.probeProvider('xai', failProber);
  assert.equal(third.status, 'unhealthy');
  const rec = tracker.recordFor('xai');
  assert.equal(rec.consecutiveFailures, 3);
  assert.equal(rec.totalFailures, 3);
  assert.equal(rec.uptimeRatio, 0);
  assert.equal(rec.lastError, 'mock down');
  assert.equal(tracker.isProviderHealthy('xai'), false);
  // Probe lai thanh cong -> healthy, consecutive reset, uptime 1/4.
  const okAgain = await tracker.probeProvider('xai');
  assert.equal(okAgain.status, 'healthy');
  assert.equal(tracker.recordFor('xai').consecutiveFailures, 0);
  assert.equal(tracker.recordFor('xai').uptimeRatio, 0.25);
  // Provider cham (>1500ms) -> degraded.
  const slow = await tracker.probeProvider('slow-p', () => ({ ok: true, latencyMs: 2000 }));
  assert.equal(slow.status, 'degraded');
  // Summary + healthiest + stale.
  const summary = tracker.summary();
  assert.equal(summary.totalProviders, 3);
  assert.equal(summary.healthy, 2);
  assert.equal(summary.degraded, 1);
  assert.equal(summary.unhealthy, 0);
  assert.equal(summary.worstStatus, 'degraded');
  const healthiest = tracker.healthiestProviders();
  assert.equal(healthiest[0].status, 'healthy');
  assert.equal(healthiest[healthiest.length - 1].provider, 'slow-p');
  // Trong nhom healthy, do tre thap dung truoc (sap xep on dinh).
  const healthyOnes = healthiest.filter((h) => h.status === 'healthy');
  assert.ok(healthyOnes[0].lastLatencyMs <= healthyOnes[1].lastLatencyMs);
  now = 1000 + 61000;
  assert.deepEqual(tracker.staleProviders(60000).sort(), ['openai', 'slow-p', 'xai']);
  assert.equal(tracker.recordFor('chua-co').status, 'unknown');
  assert.equal(tracker.recordFor('chua-co').uptimeRatio, null);
  // probeAll + clear.
  const all = await tracker.probeAll(['openai', 'gemini']);
  assert.equal(all.length, 2);
  assert.ok(all.every((r) => r.status === 'healthy'));
  tracker.clearProvider('gemini');
  assert.equal(tracker.recordFor('gemini').status, 'unknown');
  tracker.clearAll();
  assert.equal(tracker.providers().length, 0);
  await assert.rejects(tracker.probeProvider(''));
});
