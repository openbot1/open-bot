/**
 * Router v3 core tests (v1.18, Doi T3 — node:test, no network,
 * no GPU, no real model).
 *
 * Covers the pure modules of packages/core/src/routerV3:
 * - Capability matrix (capabilities.ts): known models, inference
 *   from name, user override, requirement check + alternative.
 * - Cost table (costTable.ts): known prices, local = 0, provider
 *   defaults, unknown-model estimate, overrides, serialize.
 * - Normalised errors (errors.ts): HTTP status classification,
 *   fetch errors, Retry-After parsing, backoff, failure guidance.
 * - Latency tracker (latency.ts): percentiles, rolling window,
 *   estimated latency, error rate.
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/router-v3-core.test.mjs
 *
 * NOTE: routerV3 modules are imported from their dist subpaths,
 * not from the `@open-bot/core` barrel — the barrel explicitly
 * re-exports same-named helpers from older modules
 * (`normalizeModelId` from router/contextWindow,
 * `retryDelayMs` from mcp/tasksRunner), so the barrel versions
 * of those two names are NOT the routerV3 ones.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_MODEL_CAPABILITY,
  EMBEDDING_MODEL_CAPABILITY,
  KNOWN_MODEL_CAPABILITIES,
  capabilitiesForModel,
  checkRequirements,
  checkRequirementsWithAlternative,
  inferCapabilityFromName,
  normalizeModelId,
  registerModelCapability,
  suggestAlternative,
  unregisterModelCapability,
} from '../packages/core/dist/routerV3/capabilities.js';
import {
  CostTable,
  DEFAULT_MODEL_COSTS,
  DEFAULT_PROVIDER_COSTS,
  UNKNOWN_MODEL_INPUT_PER_1M_USD,
  UNKNOWN_MODEL_OUTPUT_PER_1M_USD,
} from '../packages/core/dist/routerV3/costTable.js';
import {
  buildRouterV3FailureGuidance,
  classifyFetchError,
  classifyProviderError,
  parseRetryAfterSeconds,
  retryDelayMs,
  shouldRetry,
  truncateRouterErrorText,
} from '../packages/core/dist/routerV3/errors.js';
import {
  LATENCY_MIN_SAMPLES,
  LATENCY_WINDOW_SIZE,
  LatencyTracker,
  latencyKey,
  percentile,
  statsFromSamples,
} from '../packages/core/dist/routerV3/latency.js';

// ---------------------------------------------------------------------------
// Capability matrix
// ---------------------------------------------------------------------------

test('capabilities: known flagship models carry published context + vision', () => {
  const gpt4o = capabilitiesForModel('gpt-4o');
  assert.equal(gpt4o.contextWindow, 128_000);
  assert.equal(gpt4o.vision, true);
  assert.equal(gpt4o.toolCalling, true);
  assert.equal(gpt4o.source, 'known');

  const gemini = capabilitiesForModel('gemini-2.5-flash');
  assert.equal(gemini.contextWindow, 1_048_576);
  assert.equal(gemini.reasoning, true);

  const scout = capabilitiesForModel('llama-4-scout');
  assert.equal(scout.contextWindow, 10_485_760);
  assert.equal(scout.vision, true);
});

test('capabilities: longest-prefix match wins (gpt-4o-mini vs gpt-4o)', () => {
  assert.equal(capabilitiesForModel('gpt-4o-mini').maxOutputTokens, 16_384);
  assert.equal(capabilitiesForModel('gpt-5-mini').reasoning, true);
  // Vendor prefix + tag are stripped before lookup.
  assert.equal(capabilitiesForModel('openai/gpt-4o-mini:free').contextWindow, 128_000);
  assert.equal(capabilitiesForModel('GPT-4O').vision, true);
});

test('capabilities: deepseek-r1 has reasoning but no tool-calling', () => {
  const r1 = capabilitiesForModel('deepseek-r1');
  assert.equal(r1.reasoning, true);
  assert.equal(r1.toolCalling, false);
  const check = checkRequirements('deepseek-r1', { needsToolCalling: true });
  assert.equal(check.ok, false);
  assert.deepEqual(check.missing, ['toolCalling']);
  assert.match(check.reason ?? '', /tool-calling/);
});

test('capabilities: unknown model falls back to safe default via name inference', () => {
  const unknown = capabilitiesForModel('some-brand-new-model-9b');
  assert.equal(unknown.source, 'inferred');
  assert.equal(unknown.vision, false);
  assert.equal(unknown.toolCalling, true);
  assert.equal(unknown.contextWindow, 32_768);

  const vl = capabilitiesForModel('my-custom-vl-7b');
  assert.equal(vl.vision, true);

  const embed = capabilitiesForModel('text-embedding-3-small');
  assert.equal(embed.toolCalling, false);
  assert.equal(embed.streaming, false);
  assert.deepEqual(embed, { ...EMBEDDING_MODEL_CAPABILITY, source: 'inferred' });

  // A model with no signal at all still gets the safe default shape.
  assert.deepEqual(
    { ...DEFAULT_MODEL_CAPABILITY, source: 'inferred' },
    capabilitiesForModel('totally-unknown-xyz'),
  );
});

test('capabilities: user override wins over the known table, unregister restores it', () => {
  registerModelCapability('gpt-4o', {
    toolCalling: false,
    vision: false,
    streaming: false,
    jsonMode: false,
    contextWindow: 8000,
    maxOutputTokens: 1000,
    reasoning: false,
    source: 'known',
  });
  try {
    const overridden = capabilitiesForModel('gpt-4o');
    assert.equal(overridden.contextWindow, 8000);
    assert.equal(overridden.vision, false);
    const check = checkRequirements('gpt-4o', { needsVision: true });
    assert.equal(check.ok, false);
  } finally {
    assert.equal(unregisterModelCapability('gpt-4o'), true);
  }
  assert.equal(capabilitiesForModel('gpt-4o').contextWindow, 128_000);
  assert.equal(unregisterModelCapability('gpt-4o'), false);
});

test('capabilities: normalizeModelId strips vendor, tag, case', () => {
  assert.equal(normalizeModelId('meta-llama/Llama-3.1-8B-Instruct:free'), 'llama-3.1-8b-instruct');
  assert.equal(normalizeModelId('  Qwen3:8b  '), 'qwen3');
  assert.equal(normalizeModelId('gpt-4o-mini'), 'gpt-4o-mini');
});

test('capabilities: checkRequirements reports every missing capability', () => {
  const ok = checkRequirements('gpt-4o', {
    needsToolCalling: true,
    needsVision: true,
    needsStreaming: true,
    needsJsonMode: true,
    minContextWindow: 100_000,
    minOutputTokens: 8000,
  });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.missing, []);

  const fail = checkRequirements('llava:13b', {
    needsToolCalling: true,
    needsVision: true,
    minContextWindow: 100_000,
  });
  assert.equal(fail.ok, false);
  assert.deepEqual(fail.missing, ['toolCalling', 'contextWindow']);
  // llava HAS vision, so vision must not be listed.
  assert.ok(!fail.missing.includes('vision'));

  // Empty requirements always pass.
  assert.equal(checkRequirements('deepseek-r1', {}).ok, true);
  // minOutputTokens above the model's max is reported.
  const out = checkRequirements('gpt-4o-mini', { minOutputTokens: 100_000 });
  assert.deepEqual(out.missing, ['maxOutputTokens']);
});

test('capabilities: suggestAlternative picks the first candidate that satisfies', () => {
  const candidates = [
    { modelId: 'deepseek-r1', providerId: 'deepseek' },
    { modelId: 'llava:13b', providerId: 'local:ollama' },
    { modelId: 'gpt-4o', providerId: 'openai' },
  ];
  assert.equal(suggestAlternative({ needsToolCalling: true }, candidates), 'gpt-4o');
  assert.equal(suggestAlternative({ needsVision: true }, candidates), 'llava:13b');
  assert.equal(
    suggestAlternative({ needsVision: true, needsReasoning: true, minContextWindow: 5_000_000 }, candidates),
    undefined,
  );
  assert.equal(suggestAlternative({ needsToolCalling: true }, []), undefined);
});

test('capabilities: checkRequirementsWithAlternative attaches a suggestion', () => {
  const result = checkRequirementsWithAlternative(
    'deepseek-r1',
    { needsToolCalling: true },
    'deepseek',
    [
      { modelId: 'gpt-4o', providerId: 'openai' },
      { modelId: 'claude-sonnet-4-5', providerId: 'anthropic' },
    ],
  );
  assert.equal(result.ok, false);
  assert.equal(result.suggestedAlternative, 'gpt-4o');
  const okResult = checkRequirementsWithAlternative('gpt-4o', { needsVision: true }, 'openai', []);
  assert.equal(okResult.ok, true);
  assert.equal(okResult.suggestedAlternative, undefined);
});

test('capabilities: known tables are non-empty and consistent', () => {
  assert.ok(Object.keys(KNOWN_MODEL_CAPABILITIES).length >= 60);
  assert.ok(Object.keys(DEFAULT_MODEL_COSTS).length >= 60);
  for (const [id, cap] of Object.entries(KNOWN_MODEL_CAPABILITIES)) {
    assert.ok(cap.contextWindow > 0, `${id} contextWindow`);
    assert.ok(cap.maxOutputTokens >= 0, `${id} maxOutputTokens`);
    assert.equal(cap.source, 'known');
  }
  assert.ok(Object.keys(DEFAULT_PROVIDER_COSTS).length >= 10);
});

// ---------------------------------------------------------------------------
// Cost table
// ---------------------------------------------------------------------------

test('costTable: known model prices match the public table', () => {
  const table = new CostTable();
  assert.deepEqual(table.costFor('gpt-4o-mini'), { inputPer1mUsd: 0.15, outputPer1mUsd: 0.6, estimated: false });
  assert.deepEqual(table.costFor('claude-opus-4-5'), { inputPer1mUsd: 5, outputPer1mUsd: 25, estimated: false });
  assert.deepEqual(table.costFor('deepseek-chat'), { inputPer1mUsd: 0.28, outputPer1mUsd: 0.42, estimated: false });
  // Longest-prefix match: gpt-4o-mini-2024-07-18 still resolves to gpt-4o-mini.
  assert.equal(table.costFor('gpt-4o-mini-2024-07-18').inputPer1mUsd, 0.15);
});

test('costTable: local providers are always free', () => {
  const table = new CostTable();
  for (const pid of ['ollama', 'ollama-local', 'lm-studio', 'vllm', 'llama-cpp', 'text-generation-webui', 'localai']) {
    assert.deepEqual(table.costFor('any-model', pid), { inputPer1mUsd: 0, outputPer1mUsd: 0, estimated: false });
  }
  assert.equal(table.costPer1kTokensUsd('qwen3:8b', 'local:ollama'), 0);
  assert.equal(table.estimateCostUsd('qwen3:8b', 'local:ollama', 1_000_000, 500_000), 0);
});

test('costTable: unknown model falls back to provider default, then global estimate', () => {
  const table = new CostTable();
  const deepseek = table.costFor('some-future-deepseek-model', 'deepseek');
  assert.equal(deepseek.inputPer1mUsd, 0.28);
  assert.equal(deepseek.estimated, true); // provider default, not a listed price
  const unknown = table.costFor('some-future-model', 'some-future-provider');
  assert.deepEqual(unknown, {
    inputPer1mUsd: UNKNOWN_MODEL_INPUT_PER_1M_USD,
    outputPer1mUsd: UNKNOWN_MODEL_OUTPUT_PER_1M_USD,
    estimated: true,
  });
  const noProvider = table.costFor('some-future-model');
  assert.equal(noProvider.estimated, true);
});

test('costTable: estimateCostUsd math + costPer1kTokensUsd (3:1 input:output mix)', () => {
  const table = new CostTable();
  // gpt-4o-mini: 0.15 in / 0.6 out per 1M -> 1M in + 1M out = 0.75 USD.
  assert.equal(table.estimateCostUsd('gpt-4o-mini', 'openai', 1_000_000, 1_000_000), 0.75);
  assert.equal(table.estimateCostUsd('gpt-4o-mini', 'openai', 0, 0), 0);
  // Negative token counts are clamped to 0.
  assert.equal(table.estimateCostUsd('gpt-4o-mini', 'openai', -5, -10), 0);
  // costPer1k = ((0.15*3 + 0.6)/4)/1000 = 0.0002625
  assert.ok(Math.abs(table.costPer1kTokensUsd('gpt-4o-mini', 'openai') - 0.0002625) < 1e-12);
});

test('costTable: user overrides win, clear restores, serialize round-trips', () => {
  const table = new CostTable();
  table.setModelCost('my-model', { inputPer1mUsd: 9, outputPer1mUsd: 18, estimated: false });
  assert.equal(table.costFor('my-model').inputPer1mUsd, 9);
  assert.equal(table.modelOverrideCount(), 1);
  table.setProviderDefault('my-provider', { inputPer1mUsd: 2, outputPer1mUsd: 4 });
  assert.equal(table.costFor('other-model', 'my-provider').inputPer1mUsd, 2);
  assert.equal(table.clearModelCost('my-model'), true);
  assert.equal(table.clearModelCost('my-model'), false);
  assert.equal(table.costFor('my-model').estimated, true);

  const restored = CostTable.deserialize(table.serialize());
  assert.equal(restored.costFor('other-model', 'my-provider').inputPer1mUsd, 2);
  // Invalid saved data is ignored, never throws.
  const broken = CostTable.deserialize({ modelOverrides: { x: 'nope', y: { inputPer1mUsd: 'a' } } });
  assert.equal(broken.costFor('x').estimated, true);
  assert.equal(CostTable.deserialize(null).costFor('gpt-4o-mini').inputPer1mUsd, 0.15);
  assert.equal(CostTable.deserialize('garbage').costFor('gpt-4o-mini').inputPer1mUsd, 0.15);
  // Constructor overrides are honoured.
  const seeded = new CostTable({
    modelOverrides: { 'seed-model': { inputPer1mUsd: 1, outputPer1mUsd: 2, estimated: false } },
  });
  assert.equal(seeded.costFor('seed-model').inputPer1mUsd, 1);
});

// ---------------------------------------------------------------------------
// Normalised errors
// ---------------------------------------------------------------------------

test('errors: HTTP status classification covers the whole matrix', () => {
  const cases = [
    [401, '', 'auth', false],
    [403, '', 'auth', false],
    [429, '', 'rate-limit', true],
    [429, 'insufficient_quota: out of credits', 'quota', false],
    [402, '', 'quota', false],
    [403, 'exceeded your current quota', 'quota', false],
    [404, '', 'not-found', false],
    [404, 'model_not_found', 'not-found', false],
    [400, 'context_length_exceeded', 'context-overflow', false],
    [400, 'maximum context length is 128000', 'context-overflow', false],
    [400, 'content_filter triggered', 'content-filter', false],
    [400, 'bad request', 'invalid-request', false],
    [422, 'safety blocked', 'content-filter', false],
    [422, 'weird', 'invalid-request', false],
    [408, '', 'timeout', true],
    [504, '', 'timeout', true],
    [500, '', 'server', true],
    [502, '', 'server', true],
    [418, '', 'unknown', false],
  ];
  for (const [status, body, kind, retryable] of cases) {
    const err = classifyProviderError('prov', status, body);
    assert.equal(err.kind, kind, `status ${status} body ${JSON.stringify(body)}`);
    assert.equal(err.retryable, retryable, `status ${status} retryable`);
    assert.equal(err.status, status);
    assert.equal(err.providerId, 'prov');
  }
  // No status at all = network failure, retryable.
  const noStatus = classifyProviderError('prov', undefined, '');
  assert.equal(noStatus.kind, 'network');
  assert.equal(noStatus.retryable, true);
  // Long bodies are truncated so logs never carry secrets (message
  // ends with the truncated body + a trailing period).
  const long = classifyProviderError('prov', 400, `x-secret-${'a'.repeat(1000)}`);
  assert.ok(long.message.length <= 300 + 'prov: request khong hop le (HTTP 400) — '.length + 2);
  assert.ok(!long.message.includes('a'.repeat(1000))); // truncated, full secret never lands in logs
});

test('errors: parseRetryAfterSeconds accepts seconds and HTTP dates only', () => {
  assert.equal(parseRetryAfterSeconds('30'), 30);
  assert.equal(parseRetryAfterSeconds('0'), 0);
  assert.equal(parseRetryAfterSeconds('  7  '), 7);
  assert.equal(parseRetryAfterSeconds('1.5'), 2); // ceil
  assert.equal(parseRetryAfterSeconds('99999'), undefined); // capped at 1h
  assert.equal(parseRetryAfterSeconds('-5'), undefined);
  assert.equal(parseRetryAfterSeconds('garbage'), undefined);
  assert.equal(parseRetryAfterSeconds(null), undefined);
  assert.equal(parseRetryAfterSeconds(undefined), undefined);
  const future = new Date(Date.now() + 45_000).toUTCString();
  const parsed = parseRetryAfterSeconds(future);
  assert.ok(parsed !== undefined && parsed >= 40 && parsed <= 46, `HTTP-date ${future} -> ${parsed}`);
});

test('errors: classifyFetchError distinguishes abort/timeout/network', () => {
  const abort = new Error('aborted');
  abort.name = 'AbortError';
  assert.equal(classifyFetchError('p', abort).kind, 'aborted');
  assert.equal(classifyFetchError('p', abort).retryable, false);

  const timeout = new Error('timed out');
  timeout.name = 'TimeoutError';
  assert.equal(classifyFetchError('p', timeout).kind, 'timeout');
  assert.equal(classifyFetchError('p', timeout).retryable, true);

  assert.equal(classifyFetchError('p', new Error('ECONNREFUSED')).kind, 'network');
  assert.equal(classifyFetchError('p', 'string thrown').kind, 'network');
  assert.equal(classifyFetchError('p', null).kind, 'network');
});

test('errors: retryDelayMs is exponential with a cap; shouldRetry honours kind + budget', () => {
  assert.equal(retryDelayMs(0, 500, 8000), 500);
  assert.equal(retryDelayMs(1, 500, 8000), 1000);
  assert.equal(retryDelayMs(2, 500, 8000), 2000);
  assert.equal(retryDelayMs(10, 500, 8000), 8000);
  assert.equal(retryDelayMs(-1, 500, 8000), 500);

  const retryable = classifyProviderError('p', 500, '');
  const fatal = classifyProviderError('p', 401, '');
  assert.equal(shouldRetry(retryable, 0, 2), true);
  assert.equal(shouldRetry(retryable, 2, 2), false);
  assert.equal(shouldRetry(fatal, 0, 2), false);
  assert.equal(truncateRouterErrorText('abc', 300), 'abc');
  assert.equal(truncateRouterErrorText('a'.repeat(500), 10), `${'a'.repeat(10)}…`);
});

test('errors: buildRouterV3FailureGuidance names the real cause', () => {
  assert.match(buildRouterV3FailureGuidance([]), /Chua co provider/);
  const auth = buildRouterV3FailureGuidance([
    { providerId: 'openai', modelId: 'gpt-4o', attemptIndex: 0, outcome: 'failed', errorKind: 'auth', error: 'bad key', latencyMs: 10, attemptedAt: 0 },
  ]);
  assert.match(auth, /sai key/);
  const quota = buildRouterV3FailureGuidance([
    { providerId: 'x', modelId: 'm', attemptIndex: 0, outcome: 'failed', errorKind: 'quota', error: 'quota', latencyMs: 1, attemptedAt: 0 },
  ]);
  assert.match(quota, /het quota/);
  const mixed = buildRouterV3FailureGuidance([
    { providerId: 'a', modelId: 'm', attemptIndex: 0, outcome: 'skipped-circuit-open', latencyMs: 0, attemptedAt: 0 },
    { providerId: 'b', modelId: 'm', attemptIndex: 0, outcome: 'skipped-capability', latencyMs: 0, attemptedAt: 0 },
    { providerId: 'c', modelId: 'm', attemptIndex: 0, outcome: 'skipped-disabled', latencyMs: 0, attemptedAt: 0 },
  ]);
  assert.match(mixed, /circuit breaker/);
  assert.match(mixed, /capability/);
  const allDisabled = buildRouterV3FailureGuidance([
    { providerId: 'a', modelId: 'm', attemptIndex: 0, outcome: 'skipped-disabled', latencyMs: 0, attemptedAt: 0 },
  ]);
  assert.match(allDisabled, /bi tat/);
  assert.match(mixed, /model local/);
});

// ---------------------------------------------------------------------------
// Latency tracker
// ---------------------------------------------------------------------------

test('latency: percentile + statsFromSamples math', () => {
  assert.equal(percentile([], 50), 0);
  assert.equal(percentile([100], 50), 100);
  assert.equal(percentile([10, 20, 30, 40], 50), 20);
  assert.equal(percentile([10, 20, 30, 40], 90), 40);
  assert.equal(percentile([10, 20, 30, 40], 0), 10);
  assert.equal(percentile([10, 20, 30, 40], 150), 40); // clamped

  const stats = statsFromSamples(
    [
      { latencyMs: 100, ok: true, at: 1 },
      { latencyMs: 200, ok: true, at: 2 },
      { latencyMs: 300, ok: true, at: 3 },
      { latencyMs: 9999, ok: false, at: 4 },
    ],
    1000,
  );
  assert.equal(stats.count, 3);
  assert.equal(stats.meanMs, 200);
  assert.equal(stats.p50Ms, 200);
  assert.equal(stats.p90Ms, 300);
  assert.equal(stats.minMs, 100);
  assert.equal(stats.maxMs, 300);
  assert.equal(stats.errorRate, 0.25);
  assert.equal(stats.updatedAt, 1000);

  const allFailed = statsFromSamples([{ latencyMs: 50, ok: false, at: 1 }], 5);
  assert.equal(allFailed.count, 0);
  assert.equal(allFailed.errorRate, 1);
  assert.equal(statsFromSamples([], 5).errorRate, 0);
});

test('latency: LatencyTracker rolling window, estimates, clear', () => {
  const tracker = new LatencyTracker({ windowSize: 5 });
  assert.equal(tracker.estimatedLatencyMs('p', 'm', 1200), 1200);
  assert.equal(tracker.stats('p', 'm'), undefined);
  assert.equal(tracker.sampleCount('p', 'm'), 0);

  tracker.record('p', 'm', 100);
  tracker.record('p', 'm', 200);
  // Fewer than LATENCY_MIN_SAMPLES -> mean.
  assert.equal(tracker.estimatedLatencyMs('p', 'm', 1200), 150);
  tracker.record('p', 'm', 300);
  assert.equal(tracker.estimatedLatencyMs('p', 'm', 1200), 200); // p50 at >= 3 samples
  assert.equal(LATENCY_MIN_SAMPLES, 3);

  // Window caps at 5: push 5 more, oldest drop out.
  for (const v of [400, 500, 600, 700, 800]) tracker.record('p', 'm', v);
  assert.equal(tracker.sampleCount('p', 'm'), 5);
  const stats = tracker.stats('p', 'm');
  assert.equal(stats.minMs, 400);
  assert.equal(stats.maxMs, 800);

  // Failures count toward errorRate but not p50. The window holds
  // 5 samples, so adding the failure evicts the oldest (100/200/300
  // are already gone): window is [500,600,700,800,fail].
  tracker.record('p', 'm', 50, false);
  assert.equal(tracker.sampleCount('p', 'm'), 5);
  assert.equal(tracker.stats('p', 'm').errorRate, 1 / 5);

  // Negative / NaN samples are ignored.
  tracker.record('p', 'm', -1);
  tracker.record('p', 'm', Number.NaN);
  assert.equal(tracker.sampleCount('p', 'm'), 5);

  assert.deepEqual(tracker.trackedKeys(), [{ providerId: 'p', modelId: 'm' }]);
  assert.equal(Object.keys(tracker.snapshot()).length, 1);
  assert.equal(tracker.clear('p', 'm'), true);
  assert.equal(tracker.clear('p', 'm'), false);
  assert.equal(tracker.sampleCount('p', 'm'), 0);

  // Default window size is the exported constant.
  const big = new LatencyTracker();
  for (let i = 0; i < LATENCY_WINDOW_SIZE + 10; i += 1) big.record('p', 'm', i);
  assert.equal(big.sampleCount('p', 'm'), LATENCY_WINDOW_SIZE);
  big.clearAll();
  assert.equal(big.sampleCount('p', 'm'), 0);
});

test('latency: latencyKey is provider::model', () => {
  assert.equal(latencyKey('groq', 'llama-3.1-8b'), 'groq::llama-3.1-8b');
});
