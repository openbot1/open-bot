/**
 * Router v3 orchestrator tests (v1.18, Doi T3 — node:test, no
 * network, no GPU, no real model).
 *
 * Covers UnifiedRouterV3 (routerV3.ts) with an injected mock
 * executor (never a real API call):
 * - Candidate building: catalog defaults + local override +
 *   custom candidates + local registration.
 * - Ranking: cheapest / fastest / balanced policies, capability
 *   exclusion, disabled providers, preferred provider/model,
 *   configured fallback order.
 * - Chat: success on first candidate, cost accounting, latency
 *   recording, fallback after retryable errors, no retry after
 *   auth errors, capability skips, local-model serving.
 * - Circuit breaker per provider: opens after N failures,
 *   half-open probe after the reset timeout, manual reset.
 * - Failure guidance when every provider fails.
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/router-v3-router.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  UnifiedRouterV3,
  capabilitiesForModel,
  explainRouterV3Candidate,
  listV3Providers,
  normalizeHigherBetterV3,
  normalizeLowerBetterV3,
} from '../packages/core/dist/index.js';

function okResponse(text = 'hello', usage = { inputTokens: 1000, outputTokens: 500 }) {
  return { text, toolCalls: [], usage };
}

/** Router with a mock executor; `now` is fixed, `sleep` records delays. */
function makeRouter(opts = {}) {
  let nowValue = 1_000_000;
  const delays = [];
  const calls = [];
  const executor = opts.executor ?? (async (providerId, baseUrl, req) => {
    calls.push({ providerId, baseUrl, model: req.model });
    return okResponse(`from ${providerId}`);
  });
  const router = new UnifiedRouterV3({
    config: opts.config,
    executor,
    now: () => nowValue,
    sleep: async (ms) => {
      delays.push(ms);
    },
  });
  return {
    router,
    calls,
    delays,
    setNow: (v) => {
      nowValue = v;
    },
    advanceNow: (ms) => {
      nowValue += ms;
    },
  };
}

/** Provider ids of every catalog entry except the given keep-list. */
function allBut(...keep) {
  return listV3Providers()
    .map((p) => p.id)
    .filter((id) => !keep.includes(id));
}

const BASE_URL = 'http://localhost:11434';

// ---------------------------------------------------------------------------
// Candidate building
// ---------------------------------------------------------------------------

test('router: buildCandidates covers the catalog; local models register + upsert', () => {
  const { router } = makeRouter();
  const candidates = router.buildCandidates();
  assert.ok(candidates.length >= 90, `candidates ${candidates.length}`);
  assert.ok(candidates.every((c) => c.modelId && c.providerId));
  assert.ok(candidates.every((c) => c.capability.contextWindow > 0));
  assert.ok(candidates.every((c) => c.costPer1kTokensUsd >= 0));
  assert.ok(candidates.every((c) => c.estLatencyMs > 0));

  // Local model registers with cost 0 and appears in candidates.
  router.registerLocalModels([
    {
      modelId: 'qwen3:8b',
      serverKind: 'ollama',
      baseUrl: BASE_URL,
      providerId: 'local:ollama',
      capability: capabilitiesForModel('qwen3:8b'),
      running: true,
      discoveredAt: 1,
    },
  ]);
  assert.equal(router.listLocalModels().length, 1);
  const local = router.buildCandidates().find((c) => c.providerId === 'local:ollama');
  assert.ok(local);
  assert.equal(local.modelId, 'qwen3:8b');
  assert.equal(local.costPer1kTokensUsd, 0);
  assert.equal(local.local, true);
  assert.equal(local.baseUrl, `${BASE_URL}/v1`);

  // Re-registering the same provider+model upserts instead of duplicating.
  router.registerLocalModels([
    {
      modelId: 'qwen3:8b',
      serverKind: 'ollama',
      baseUrl: BASE_URL,
      providerId: 'local:ollama',
      capability: capabilitiesForModel('qwen3:8b'),
      running: false,
      discoveredAt: 2,
    },
  ]);
  assert.equal(router.listLocalModels().length, 1);
  assert.equal(router.listLocalModels()[0].running, false);

  // Custom candidate (user's own provider) joins the pool.
  router.addCandidate({
    providerId: 'my-gateway',
    baseUrl: 'https://gw.example/v1',
    modelId: 'my-model',
    capability: capabilitiesForModel('gpt-4o'),
    costPer1kTokensUsd: 0.001,
    estLatencyMs: 100,
    local: false,
  });
  assert.ok(router.buildCandidates().some((c) => c.providerId === 'my-gateway'));
});

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

test('router: cheapest policy ranks a free local model first', () => {
  const { router } = makeRouter();
  router.registerLocalModels([
    {
      modelId: 'qwen3:8b',
      serverKind: 'ollama',
      baseUrl: BASE_URL,
      providerId: 'local:ollama',
      capability: capabilitiesForModel('qwen3:8b'),
      running: true,
      discoveredAt: 1,
    },
  ]);
  const ranked = router.rankCandidates({ policy: 'cheapest' });
  assert.equal(ranked.length, router.buildCandidates().length);
  assert.equal(ranked[0].local, true);
  assert.equal(ranked[0].providerId, 'local:ollama');
  assert.ok(ranked.every((c) => c.score >= 0 && c.score <= 1));
  assert.ok(ranked.every((c) => c.explanation.length > 0));
  assert.match(ranked[0].explanation, /Local/);
});

test('router: fastest policy follows measured latency, not the default', () => {
  const { router } = makeRouter();
  const groq = listV3Providers().find((p) => p.id === 'groq');
  assert.ok(groq);
  for (let i = 0; i < 5; i += 1) {
    router.latencyTracker.record('groq', groq.defaultModel, 40, true, 1_000_000 + i);
  }
  const ranked = router.rankCandidates({ policy: 'fastest' });
  assert.equal(ranked[0].providerId, 'groq');
  assert.equal(ranked[0].estLatencyMs, 40);
});

test('router: balanced policy still scores every candidate', () => {
  const { router } = makeRouter();
  const ranked = router.rankCandidates({ policy: 'balanced' });
  assert.equal(ranked.length, router.buildCandidates().length);
  assert.ok(ranked[0].score >= ranked[ranked.length - 1].score);
});

test('router: capability requirements exclude + explain; preferred wins', () => {
  const { router } = makeRouter();
  const ranked = router.rankCandidates({ requirements: { needsVision: true } });
  const visionless = ranked.filter((c) => !c.capability.vision);
  assert.ok(visionless.length > 0);
  assert.ok(visionless.every((c) => c.excludedReason?.startsWith('thieu-capability')));
  const withVision = ranked.filter((c) => c.capability.vision);
  assert.ok(withVision.every((c) => c.excludedReason === undefined));
  // Excluded candidates sort after usable ones.
  const firstExcluded = ranked.findIndex((c) => c.excludedReason !== undefined);
  const lastUsable = ranked.map((c) => c.excludedReason === undefined).lastIndexOf(true);
  assert.ok(firstExcluded > lastUsable);

  // Preferred provider jumps to the front.
  const preferred = router.rankCandidates({ preferredProviderId: 'groq' });
  assert.equal(preferred[0].providerId, 'groq');
  const preferredModel = router.rankCandidates({ preferredModelId: 'gpt-4o-mini' });
  assert.equal(preferredModel[0].modelId, 'gpt-4o-mini');
});

test('router: disable/enable provider excludes it from ranking', () => {
  const { router } = makeRouter();
  router.disableProvider('groq');
  router.disableProvider('groq'); // idempotent
  const ranked = router.rankCandidates();
  const groq = ranked.find((c) => c.providerId === 'groq');
  assert.equal(groq.excludedReason, 'provider-bi-tat');
  router.enableProvider('groq');
  assert.equal(router.rankCandidates().find((c) => c.providerId === 'groq').excludedReason, undefined);
});

test('router: configured fallbackOrder beats score order', () => {
  const { router } = makeRouter({
    config: {
      fallbackOrder: ['groq', 'openai'],
      disabledProviders: allBut('groq', 'openai', 'deepseek'),
    },
  });
  const ranked = router.rankCandidates();
  // The two ordered providers come first, in order; the remaining
  // (disabled) candidate sorts last with an exclusion reason —
  // rankCandidates always returns the full pool.
  assert.deepEqual(
    ranked.slice(0, 3).map((c) => c.providerId),
    ['groq', 'openai', 'deepseek'],
  );
  assert.equal(ranked.length, router.buildCandidates().length);
  assert.ok(ranked.slice(3).every((c) => c.excludedReason === 'provider-bi-tat'));
});

test('router: normalize helpers handle degenerate ranges', () => {
  assert.equal(normalizeLowerBetterV3(5, 5, 5), 1);
  assert.equal(normalizeHigherBetterV3(5, 5, 5), 1);
  assert.equal(normalizeLowerBetterV3(0, 0, 10), 1);
  assert.equal(normalizeLowerBetterV3(10, 0, 10), 0);
  assert.equal(normalizeHigherBetterV3(10, 0, 10), 1);
  assert.equal(explainRouterV3Candidate(
    {
      providerId: 'local:ollama',
      baseUrl: `${BASE_URL}/v1`,
      modelId: 'qwen3:8b',
      capability: capabilitiesForModel('qwen3:8b'),
      costPer1kTokensUsd: 0,
      estLatencyMs: 100,
      local: true,
    },
    { costScore: 1, latencyScore: 1, capabilityScore: 0.1 },
    'cheapest',
  ).includes('Local'), true);
});

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

test('router: chat succeeds on the first candidate and accounts cost + latency', async () => {
  const { router, calls } = makeRouter();
  const result = await router.chat({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.equal(result.ok, true);
  assert.equal(result.response.text, `from ${result.servedByProviderId}`);
  assert.equal(result.attempts.length, 1);
  assert.equal(result.attempts[0].outcome, 'success');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, result.servedByModelId);
  // Usage 1000 in + 500 out priced from the cost table.
  const expected = router.costTable.estimateCostUsd(result.servedByModelId, result.servedByProviderId, 1000, 500);
  assert.equal(result.costUsd, expected);
  assert.ok(result.totalLatencyMs >= 0);
  assert.equal(router.latencyTracker.sampleCount(result.servedByProviderId, result.servedByModelId), 1);
});

test('router: chat falls back after retryable 429s with backoff', async () => {
  const { router, calls, delays } = makeRouter({
    config: { maxRetriesPerProvider: 1, disabledProviders: allBut('groq', 'openai') },
    executor: async (providerId) => {
      if (providerId === 'groq') throw new Error('groq: HTTP 429 — rate limit, slow down');
      return okResponse(`from ${providerId}`);
    },
  });
  const result = await router.chat({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: 'hi' }],
    preferredProviderId: 'groq',
  });
  assert.equal(result.ok, true);
  assert.equal(result.servedByProviderId, 'openai');
  const groqAttempts = result.attempts.filter((a) => a.providerId === 'groq');
  assert.equal(groqAttempts.length, 2); // initial + 1 retry
  assert.ok(groqAttempts.every((a) => a.outcome === 'failed' && a.errorKind === 'rate-limit'));
  assert.equal(result.attempts.filter((a) => a.outcome === 'success').length, 1);
  assert.deepEqual(delays, [500]); // retryDelayMs(0, 500, 8000)
  assert.ok(calls.every((c) => c.providerId === 'groq' || c.providerId === 'openai'));
});

test('router: auth errors are NOT retried on the same provider', async () => {
  const { router } = makeRouter({
    config: { maxRetriesPerProvider: 2, disabledProviders: allBut('groq', 'openai') },
    executor: async (providerId) => {
      if (providerId === 'groq') throw new Error('groq: HTTP 401 — invalid api key');
      return okResponse(`from ${providerId}`);
    },
  });
  const result = await router.chat({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: 'hi' }],
    preferredProviderId: 'groq',
  });
  assert.equal(result.ok, true);
  assert.equal(result.servedByProviderId, 'openai');
  const groqAttempts = result.attempts.filter((a) => a.providerId === 'groq');
  assert.equal(groqAttempts.length, 1); // no retry for auth
  assert.equal(groqAttempts[0].errorKind, 'auth');
});

test('router: chat skips models lacking a required capability', async () => {
  const { router } = makeRouter({
    config: { disabledProviders: allBut('deepseek', 'openai', 'groq') },
  });
  const result = await router.chat({
    model: 'deepseek-v4-flash',
    messages: [{ role: 'user', content: 'describe this image' }],
    requirements: { needsVision: true },
    preferredModelId: 'deepseek-v4-flash',
  });
  assert.equal(result.ok, true);
  assert.notEqual(result.servedByModelId, 'deepseek-v4-flash');
  const skipped = result.attempts.find((a) => a.modelId === 'deepseek-v4-flash');
  assert.ok(skipped);
  assert.equal(skipped.outcome, 'skipped-capability');
  assert.equal(result.attempts.filter((a) => a.outcome === 'success').length, 1);
});

test('router: chat serves a registered local model at zero cost', async () => {
  const { router } = makeRouter();
  router.registerLocalModels([
    {
      modelId: 'qwen3:8b',
      serverKind: 'ollama',
      baseUrl: BASE_URL,
      providerId: 'local:ollama',
      capability: capabilitiesForModel('qwen3:8b'),
      running: true,
      discoveredAt: 1,
    },
  ]);
  const result = await router.chat({
    model: 'qwen3:8b',
    messages: [{ role: 'user', content: 'hi' }],
    policy: 'cheapest',
    preferredProviderId: 'local:ollama',
  });
  assert.equal(result.ok, true);
  assert.equal(result.servedByProviderId, 'local:ollama');
  assert.equal(result.servedByModelId, 'qwen3:8b');
  assert.equal(result.costUsd, 0);
});

test('router: chat records disabled providers as skipped, not failed', async () => {
  const { router } = makeRouter({
    config: { maxRetriesPerProvider: 0, disabledProviders: allBut('openai') },
    executor: async (providerId) => {
      if (providerId === 'openai') throw new Error('openai: HTTP 500 — boom');
      return okResponse(`from ${providerId}`);
    },
  });
  const result = await router.chat({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.equal(result.ok, false);
  // openai is usable so it is tried first and fails; every other
  // candidate is recorded as skipped-disabled (never called).
  const total = router.buildCandidates().length;
  assert.equal(result.attempts.length, total);
  assert.equal(result.attempts.filter((a) => a.outcome === 'failed').length, 1);
  assert.equal(result.attempts.filter((a) => a.providerId === 'openai')[0].errorKind, 'server');
  assert.equal(result.attempts.filter((a) => a.outcome === 'skipped-disabled').length, total - 1);
});

// ---------------------------------------------------------------------------
// Circuit breaker
// ---------------------------------------------------------------------------

test('router: circuit opens after N consecutive failures and skips the provider', async () => {
  const { router, setNow } = makeRouter({
    config: {
      maxRetriesPerProvider: 1,
      circuitFailureThreshold: 2,
      circuitResetTimeoutMs: 60_000,
      disabledProviders: allBut('groq', 'openai'),
    },
    executor: async (providerId) => {
      throw new Error(`${providerId}: HTTP 500 — boom`);
    },
  });
  const first = await router.chat({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.equal(first.ok, false);
  assert.match(first.guidance ?? '', /model local/);
  assert.equal(first.attempts.filter((a) => a.outcome === 'failed').length, 4); // 2 providers x 2 tries

  const status = router.circuitStatus();
  // rankCandidates creates a breaker per provider it scores, so the
  // status list covers the whole catalog — check the two we drove.
  const byId = new Map(status.map((s) => [s.providerId, s]));
  assert.equal(byId.get('groq').state, 'open');
  assert.equal(byId.get('groq').consecutiveFailures, 2);
  assert.equal(byId.get('groq').failureThreshold, 2);
  assert.equal(byId.get('openai').state, 'open');
  assert.equal(byId.get('openai').consecutiveFailures, 2);

  // Second chat: groq/openai are skipped as circuit-open (disabled
  // providers are skipped-disabled instead), no new calls.
  const second = await router.chat({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.equal(second.ok, false);
  const driven = second.attempts.filter((a) => a.providerId === 'groq' || a.providerId === 'openai');
  assert.equal(driven.length, 2);
  assert.ok(driven.every((a) => a.outcome === 'skipped-circuit-open'));
  assert.ok(second.attempts.filter((a) => a.outcome === 'skipped-disabled').length > 0);
  assert.match(second.guidance ?? '', /circuit breaker/);

  // Half-open after the reset timeout: the breaker allows one trial.
  setNow(1_000_000 + 61_000);
  assert.equal(router.breakerFor('groq').state(1_000_000 + 61_000), 'half-open');
  assert.equal(router.breakerFor('groq').allowRequest(1_000_000 + 61_000), true);

  // Manual reset closes the circuit immediately.
  assert.equal(router.resetCircuit('groq'), true);
  assert.equal(router.breakerFor('groq').state(1_000_000 + 61_000), 'closed');
  assert.equal(router.resetCircuit('no-such-provider'), false);
});

test('router: chat failing everywhere returns guidance, never throws', async () => {
  const { router, delays } = makeRouter({
    config: { maxRetriesPerProvider: 1, disabledProviders: allBut('groq', 'openai') },
    executor: async () => {
      throw new Error('boom');
    },
  });
  const result = await router.chat({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.equal(result.ok, false);
  assert.equal(result.response, undefined);
  assert.equal(result.attempts.filter((a) => a.outcome === 'failed').length, 4);
  assert.ok(result.attempts.filter((a) => a.outcome === 'failed').every((a) => a.errorKind === 'network'));
  assert.deepEqual(delays, [500, 500]); // one backoff per provider
  assert.match(result.guidance ?? '', /Tat ca provider/);
  assert.match(result.guidance ?? '', /model local/);
});
