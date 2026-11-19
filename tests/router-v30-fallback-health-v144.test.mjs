/**
 * Router v30 — fallback chain + health probe (v1.44, Doi T5, node:test).
 *
 * Covers (thuan, khong model that, khong network — executor/prober mock):
 * - Phan loai loi: 429/timeout/5xx/network -> retryable; 401/403/404/
 *   invalid-request -> fatal (khong fallback).
 * - Validate chain: rong / trung buoc / maxAttempts ngoai 1..5 /
 *   maxTotalAttempts ngoai 1..20.
 * - Default chain: chinh -> ollama re -> local-echo.
 * - Plan: tong so lan thu, bo buoc dang cooldown.
 * - Run: 429 o buoc 1 -> sang buoc 2 thanh cong; 401 dung ngay;
 *   that het -> ok:false + lastError; maxTotalAttempts gioi han;
 *   moi buoc maxAttempts=2 thu lai buoc do truoc khi sang buoc sau;
 *   decision log ghi du, cap 200, mostFailedModel.
 * - Health: probe ok nhanh -> healthy; cham >= 5s -> degraded;
 *   that 1 lan -> degraded (chua down); that 3 lan lien tiep -> down;
 *   cache TTL (needsProbe), probeStale chi probe cai stale;
 *   summary + downProviders + snapshot/restore.
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/router-v30-fallback-health-v144.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FallbackDecisionLogV30,
  ProviderHealthTrackerV30,
  buildDefaultFallbackChainV30,
  classifyProviderErrorV30,
  planFallbackV30,
  runFallbackChainV30,
  validateFallbackChainV30,
} from '../packages/core/dist/routerV30/index.js';

test('phan loai loi: retryable vs fatal', () => {
  assert.deepEqual(
    classifyProviderErrorV30({ status: 429, message: 'rate limited' }),
    { kind: 'rate-limited', retryable: true, code: 429, message: 'rate limited' },
  );
  assert.equal(classifyProviderErrorV30({ status: 500, message: 'boom' }).kind, 'server-error');
  assert.equal(classifyProviderErrorV30({ status: 500, message: 'boom' }).retryable, true);
  assert.equal(classifyProviderErrorV30({ status: 503, message: 'unavailable' }).retryable, true);
  assert.equal(classifyProviderErrorV30({ status: 408, message: 'timeout' }).kind, 'timeout');
  assert.equal(classifyProviderErrorV30({ message: 'request timed out' }).retryable, true);
  assert.equal(classifyProviderErrorV30({ message: 'fetch failed' }).kind, 'network');
  assert.equal(classifyProviderErrorV30({ status: 401, message: 'bad key' }).kind, 'auth');
  assert.equal(classifyProviderErrorV30({ status: 401, message: 'bad key' }).retryable, false);
  assert.equal(classifyProviderErrorV30({ status: 403, message: 'forbidden' }).retryable, false);
  assert.equal(classifyProviderErrorV30({ status: 404, message: 'model not found' }).kind, 'not-found');
  assert.equal(classifyProviderErrorV30({ status: 404, message: 'model not found' }).retryable, false);
  assert.equal(classifyProviderErrorV30({ status: 400, message: 'invalid request' }).retryable, false);
  assert.equal(classifyProviderErrorV30('weird').kind, 'unknown');
  assert.equal(classifyProviderErrorV30('weird').retryable, false);
});

test('validate chain + default chain', () => {
  const def = buildDefaultFallbackChainV30('openai', 'gpt-5.2-mini');
  assert.equal(def.steps.length, 3);
  assert.equal(def.steps[0].provider, 'openai');
  assert.equal(def.steps[1].provider, 'ollama');
  assert.equal(def.steps[2].modelId, 'local-echo');
  assert.deepEqual(validateFallbackChainV30(def), []);
  // Chinh da la local thi chain van co ollama lam buoc 2, khong trung buoc.
  const localDef = buildDefaultFallbackChainV30('local', 'local-echo');
  assert.equal(localDef.steps.length, 2);
  assert.equal(localDef.steps[0].modelId, 'local-echo');
  assert.equal(localDef.steps[1].provider, 'ollama');
  assert.deepEqual(validateFallbackChainV30(localDef), []);
  assert.deepEqual(validateFallbackChainV30(null), ['chain must be an object']);
  assert.ok(validateFallbackChainV30({ name: 'x', steps: [] }).length > 0);
  assert.ok(
    validateFallbackChainV30({
      name: 'x',
      steps: [
        { provider: 'a', modelId: 'm' },
        { provider: 'a', modelId: 'm' },
      ],
    }).some((e) => e.includes('duplicates')),
  );
  assert.ok(
    validateFallbackChainV30({
      name: 'x',
      steps: [{ provider: 'a', modelId: 'm', maxAttempts: 9 }],
    }).length > 0,
  );
  assert.ok(
    validateFallbackChainV30({
      name: 'x',
      steps: [{ provider: 'a', modelId: 'm' }],
      maxTotalAttempts: 99,
    }).length > 0,
  );
});

test('plan: tong lan thu + bo buoc cooldown', () => {
  const chain = {
    name: 'p',
    steps: [
      { provider: 'openai', modelId: 'gpt-5.2-mini', maxAttempts: 2 },
      { provider: 'ollama', modelId: 'llama-4-scout', maxAttempts: 1 },
    ],
  };
  const plan = planFallbackV30(chain);
  assert.equal(plan.totalAttempts, 3);
  assert.equal(plan.stepCount, 2);
  assert.deepEqual(plan.skippedCoolingDown, []);
  const cooling = new Map([['openai::gpt-5.2-mini', Date.now() + 60_000]]);
  const plan2 = planFallbackV30(chain, cooling);
  assert.equal(plan2.stepCount, 1);
  assert.deepEqual(plan2.skippedCoolingDown, ['openai::gpt-5.2-mini']);
  assert.equal(plan2.totalAttempts, 1);
  const capped = planFallbackV30({ ...chain, maxTotalAttempts: 2 });
  assert.equal(capped.totalAttempts, 2);
});

test('run: 429 -> fallback sang buoc 2 thanh cong, log ghi du', async () => {
  const chain = buildDefaultFallbackChainV30('openai', 'gpt-5.2-mini');
  const log = new FallbackDecisionLogV30();
  const result = await runFallbackChainV30(
    chain,
    async (step) => {
      if (step.provider === 'openai') {
        return { ok: false, error: { status: 429, message: 'rate limited' } };
      }
      return { ok: true, value: `ok:${step.provider}` };
    },
    { log },
  );
  assert.equal(result.ok, true);
  assert.equal(result.value, 'ok:ollama');
  assert.equal(result.succeededStep.provider, 'ollama');
  assert.equal(result.attemptsMade, 2);
  assert.deepEqual(result.triedSteps, ['openai::gpt-5.2-mini', 'ollama::llama-4-scout']);
  assert.equal(log.length, 2);
  assert.equal(log.entries[0].outcome, 'failed-retryable');
  assert.equal(log.entries[0].errorKind, 'rate-limited');
  assert.equal(log.entries[0].movedToNext, true);
  assert.equal(log.entries[1].outcome, 'success');
  assert.equal(log.fallbackCount(), 1);
});

test('run: 401 dung ngay, khong thu buoc sau', async () => {
  const chain = buildDefaultFallbackChainV30('openai', 'gpt-5.2-mini');
  let calls = 0;
  const result = await runFallbackChainV30(chain, async () => {
    calls += 1;
    return { ok: false, error: { status: 401, message: 'invalid api key' } };
  });
  assert.equal(result.ok, false);
  assert.equal(calls, 1);
  assert.equal(result.attemptsMade, 1);
  assert.equal(result.lastError.kind, 'auth');
  assert.equal(result.lastError.retryable, false);
});

test('run: that het + maxAttempts moi buoc + maxTotalAttempts', async () => {
  const chain = {
    name: 'all-fail',
    steps: [
      { provider: 'a', modelId: 'm1', maxAttempts: 2 },
      { provider: 'b', modelId: 'm2', maxAttempts: 2 },
    ],
  };
  const log = new FallbackDecisionLogV30();
  const result = await runFallbackChainV30(
    chain,
    async () => ({ ok: false, error: { status: 503, message: 'down' } }),
    { log },
  );
  assert.equal(result.ok, false);
  assert.equal(result.attemptsMade, 4);
  assert.equal(result.lastError.kind, 'server-error');
  assert.equal(log.length, 4);
  assert.deepEqual(log.mostFailedModel(), { stepKey: 'a::m1', failures: 2 });

  const capped = await runFallbackChainV30(
    chain,
    async () => ({ ok: false, error: { status: 503, message: 'down' } }),
    { maxTotalAttempts: 3 },
  );
  assert.equal(capped.attemptsMade, 3);
  assert.equal(capped.ok, false);

  // Chain sai thi throw.
  await assert.rejects(
    runFallbackChainV30({ name: 'x', steps: [] }, async () => ({ ok: true })),
    /invalid fallback chain/,
  );
});

test('decision log: cap 200 muc', () => {
  const log = new FallbackDecisionLogV30();
  for (let i = 0; i < 250; i += 1) {
    log.record({
      at: i,
      chainName: 'c',
      stepKey: 'a::m',
      attempt: 1,
      outcome: 'failed-retryable',
      movedToNext: true,
    });
  }
  assert.equal(log.length, 200);
  assert.equal(log.entries[0].at, 50);
  assert.equal(log.fallbackCount(), 200);
});

test('health: probe ok nhanh -> healthy; cham -> degraded', async () => {
  const tracker = new ProviderHealthTrackerV30();
  assert.equal(tracker.getStatus('openai'), null);
  assert.equal(tracker.needsProbe('openai'), true);
  const fast = await tracker.probe('openai', async () => ({ ok: true, latencyMs: 120, detail: 'ok' }), undefined, 1000);
  assert.equal(fast.status, 'healthy');
  assert.equal(fast.latencyMs, 120);
  assert.equal(fast.totalProbes, 1);
  assert.equal(tracker.needsProbe('openai', undefined, 1000 + 1000), false);
  assert.equal(tracker.needsProbe('openai', undefined, 1000 + 5 * 60 * 1000 + 1), true);
  const slow = await tracker.probe('gemini', async () => ({ ok: true, latencyMs: 8000, detail: 'slow' }), undefined, 2000);
  assert.equal(slow.status, 'degraded');
  assert.equal(slow.consecutiveFailures, 0);
});

test('health: that 1 lan -> degraded, 3 lan lien tiep -> down, ok lai -> healthy', async () => {
  const tracker = new ProviderHealthTrackerV30();
  const fail = async () => ({ ok: false, latencyMs: 0, detail: 'boom' });
  const r1 = await tracker.probe('xai', fail, undefined, 1000);
  assert.equal(r1.status, 'degraded');
  assert.equal(r1.consecutiveFailures, 1);
  const r2 = await tracker.probe('xai', fail, undefined, 2000);
  assert.equal(r2.status, 'degraded');
  assert.equal(r2.consecutiveFailures, 2);
  const r3 = await tracker.probe('xai', fail, undefined, 3000);
  assert.equal(r3.status, 'down');
  assert.equal(r3.consecutiveFailures, 3);
  assert.deepEqual(tracker.downProviders(), ['xai']);
  const ok = await tracker.probe('xai', async () => ({ ok: true, latencyMs: 100 }), undefined, 4000);
  assert.equal(ok.status, 'healthy');
  assert.equal(ok.consecutiveFailures, 0);
  assert.equal(ok.totalFailures, 3);
  assert.deepEqual(tracker.downProviders(), []);
  // Prober throw cung tinh la that.
  const threw = await tracker.probe('xai', async () => { throw new Error('conn refused'); }, undefined, 5000);
  assert.equal(threw.status, 'degraded');
  assert.match(threw.detail, /conn refused/);
});

test('health: probeStale chi probe cai stale + summary + snapshot', async () => {
  const tracker = new ProviderHealthTrackerV30(60_000);
  await tracker.probe('openai', async () => ({ ok: true, latencyMs: 100 }), undefined, 1000);
  await tracker.probe('gemini', async () => ({ ok: true, latencyMs: 100 }), undefined, 1000);
  // 30s sau: ca 2 con fresh -> khong probe lai.
  const none = await tracker.probeStale(
    [{ provider: 'openai' }, { provider: 'gemini' }],
    async () => ({ ok: true, latencyMs: 999 }),
    31_000,
  );
  assert.equal(none.length, 0);
  // 61s sau: ca 2 stale -> probe lai.
  const both = await tracker.probeStale(
    [{ provider: 'openai' }, { provider: 'gemini' }],
    async () => ({ ok: true, latencyMs: 200 }),
    62_000,
  );
  assert.equal(both.length, 2);
  const summary = tracker.summary();
  assert.equal(summary.total, 2);
  assert.equal(summary.healthy, 2);
  assert.equal(summary.healthyRatio, 1);
  assert.ok(summary.worst);
  const snap = tracker.snapshotV30();
  const tracker2 = new ProviderHealthTrackerV30();
  assert.equal(tracker2.restoreV30(snap), 2);
  assert.equal(tracker2.getStatus('openai').status, 'healthy');
  assert.equal(tracker2.restoreV30([{ provider: '', status: 'healthy' }]), 0);
  assert.equal(tracker2.restoreV30([{ provider: 'x', status: 'weird' }]), 0);
});
