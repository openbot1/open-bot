/**
 * Tests cho Sandbox v4 — budget meter + secret requests (v1.36, Đội T4).
 *
 * Run sau khi build core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/sandbox-v4-budget-secrets.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SANDBOX_V4_REDACTED,
  SandboxV4BudgetMeter,
  SandboxV4SecretRequestManager,
  defaultSandboxV4BudgetLimits,
  estimateSandboxV4StepCost,
  isSandboxV4LocalModel,
  priceForSandboxV4Model,
  validateSandboxV4BudgetLimits,
  validateSandboxV4SecretRequest,
} from '../packages/core/dist/sandboxV4/index.js';

test('budget: price table + local models cost 0 + fallback for unknown models', () => {
  assert.deepEqual(priceForSandboxV4Model('gpt-4o'), { inputPerM: 2.5, outputPerM: 10.0 });
  assert.deepEqual(priceForSandboxV4Model('GPT-4O'), { inputPerM: 2.5, outputPerM: 10.0 });
  assert.deepEqual(priceForSandboxV4Model('ollama/llama3'), { inputPerM: 0, outputPerM: 0 });
  assert.deepEqual(priceForSandboxV4Model('local/mistral'), { inputPerM: 0, outputPerM: 0 });
  assert.equal(isSandboxV4LocalModel('ollama/llama3'), true);
  assert.equal(isSandboxV4LocalModel('gpt-4o'), false);
  assert.deepEqual(priceForSandboxV4Model('some-future-model-9'), { inputPerM: 3.0, outputPerM: 15.0 });
  // (1000 * 2.5 + 500 * 10) / 1e6 = 0.0075
  assert.equal(estimateSandboxV4StepCost('gpt-4o', 1000, 500), 0.0075);
  assert.equal(estimateSandboxV4StepCost('ollama/llama3', 100000, 100000), 0);
  assert.equal(estimateSandboxV4StepCost('', 100, 100), 0);
});

test('budget: limits validation', () => {
  assert.deepEqual(validateSandboxV4BudgetLimits(defaultSandboxV4BudgetLimits()), []);
  assert.ok(validateSandboxV4BudgetLimits({ ...defaultSandboxV4BudgetLimits(), maxInputTokens: -1 }).length > 0);
  assert.ok(validateSandboxV4BudgetLimits({ ...defaultSandboxV4BudgetLimits(), maxCostUsd: -0.5 }).length > 0);
  assert.ok(validateSandboxV4BudgetLimits({ ...defaultSandboxV4BudgetLimits(), warnAtRatio: 0 }).length > 0);
  assert.ok(validateSandboxV4BudgetLimits({ ...defaultSandboxV4BudgetLimits(), warnAtRatio: 1.5 }).length > 0);
  assert.ok(validateSandboxV4BudgetLimits({ ...defaultSandboxV4BudgetLimits(), maxWallMs: 1.5 }).length > 0);
  assert.ok(validateSandboxV4BudgetLimits(null).length > 0);
  assert.ok(validateSandboxV4BudgetLimits('x').length > 0);
});

test('budget: ok -> warning at 80% -> soft-blocked at the limit, then raise/reset', () => {
  const now = 1700000000000;
  const meter = new SandboxV4BudgetMeter({
    conversationId: 'conv-b',
    limits: { maxInputTokens: 1000, maxOutputTokens: 500, maxCostUsd: 1, maxWallMs: 60000, warnAtRatio: 0.8 },
    nowMs: () => now,
  });
  assert.equal(meter.status(), 'ok');
  assert.equal(meter.mayStartStep(), true);
  assert.deepEqual(meter.remaining(), {
    inputTokens: 1000,
    outputTokens: 500,
    costUsd: 1,
    wallMs: 60000,
  });

  const first = meter.recordUsage({ model: 'gpt-4o', inputTokens: 700, outputTokens: 100, wallMs: 1000 });
  assert.equal(first.status, 'ok');
  assert.equal(first.newlyBlocked, false);
  assert.equal(first.stepCostUsd, 0.00275); // (700*2.5 + 100*10) / 1e6
  assert.deepEqual(meter.warningDimensions(), []);
  assert.equal(meter.status(), 'ok');

  const second = meter.recordUsage({ model: 'gpt-4o', inputTokens: 100, outputTokens: 0, wallMs: 1000 });
  assert.equal(second.status, 'warning', '800/1000 input tokens = 80%');
  assert.deepEqual(meter.warningDimensions(), ['inputTokens']);
  assert.equal(meter.mayStartStep(), true);

  const third = meter.recordUsage({ model: 'gpt-4o', inputTokens: 250, outputTokens: 0, wallMs: 0 });
  assert.equal(third.status, 'soft-blocked');
  assert.equal(third.newlyBlocked, true);
  assert.deepEqual(third.blockedDimensions, ['inputTokens']);
  assert.equal(meter.mayStartStep(), false);
  // Recording while blocked still records (the overrun stays visible).
  const fourth = meter.recordUsage({ model: 'gpt-4o', inputTokens: 10, outputTokens: 0 });
  assert.equal(fourth.status, 'soft-blocked');
  assert.equal(fourth.newlyBlocked, false);
  assert.equal(meter.getUsage().inputTokens, 1060);
  assert.equal(meter.getUsage().steps, 4);

  // Raising the limit unblocks; a wrong limit is refused.
  assert.deepEqual(meter.raiseLimit('inputTokens', 2000), []);
  assert.equal(meter.status(), 'ok');
  assert.deepEqual(meter.setLimits({ ...defaultSandboxV4BudgetLimits(), warnAtRatio: 0 }), [
    'warnAtRatio must be a number in (0, 1].',
  ]);
  assert.equal(meter.getLimits().maxInputTokens, 2000, 'failed setLimits keeps old limits');

  // Forecast: cost so far / steps, against the $1 limit.
  const forecast = meter.forecastStepsLeft();
  assert.ok(typeof forecast === 'number' && forecast >= 0);

  meter.reset();
  assert.equal(meter.status(), 'ok');
  assert.deepEqual(meter.getUsage(), { inputTokens: 0, outputTokens: 0, costUsd: 0, wallMs: 0, steps: 0 });
  assert.equal(meter.describe().lastResetAtMs, now);
  assert.match(meter.statusLine(), /budget conv-b: ok/);
});

test('budget: unlimited dimensions (0) never warn or block; explicit cost wins', () => {
  const meter = new SandboxV4BudgetMeter({
    conversationId: 'conv-free',
    limits: { maxInputTokens: 0, maxOutputTokens: 0, maxCostUsd: 0, maxWallMs: 0, warnAtRatio: 0.8 },
  });
  const result = meter.recordUsage({ model: 'gpt-4o', inputTokens: 10_000_000, outputTokens: 5_000_000 });
  assert.equal(result.status, 'ok');
  assert.deepEqual(meter.remaining(), { inputTokens: null, outputTokens: null, costUsd: null, wallMs: null });
  assert.equal(meter.forecastStepsLeft(), null);

  const priced = new SandboxV4BudgetMeter({ conversationId: 'conv-priced' });
  const withCost = priced.recordUsage({ model: 'gpt-4o', inputTokens: 10, outputTokens: 10, costUsd: 0.5 });
  assert.equal(withCost.stepCostUsd, 0.5, 'provider-reported cost overrides the estimate');
  assert.throws(
    () => new SandboxV4BudgetMeter({ conversationId: '', limits: defaultSandboxV4BudgetLimits() }),
    /non-empty conversationId/,
  );
  assert.throws(
    () => new SandboxV4BudgetMeter({ conversationId: 'x', limits: { ...defaultSandboxV4BudgetLimits(), maxCostUsd: -1 } }),
    /Invalid budget limits/,
  );
});

test('budget: step history is a ring buffer', () => {
  const meter = new SandboxV4BudgetMeter({ conversationId: 'conv-ring', historySize: 3 });
  for (let i = 0; i < 5; i++) {
    meter.recordUsage({ model: 'gpt-4o', inputTokens: 10, outputTokens: 5 });
  }
  const state = meter.describe();
  assert.equal(state.steps.length, 3);
  assert.deepEqual(state.steps.map((s) => s.seq), [3, 4, 5]);
  assert.equal(state.usage.steps, 5, 'totals stay exact while history is capped');
});

test('secrets: request validation', () => {
  assert.deepEqual(validateSandboxV4SecretRequest({ name: 'GITHUB_TOKEN', purpose: 'Push a branch.' }), []);
  assert.ok(validateSandboxV4SecretRequest({ name: 'bad name!', purpose: 'x' }).length > 0);
  assert.ok(validateSandboxV4SecretRequest({ name: 'K', purpose: '' }).length > 0);
  assert.ok(validateSandboxV4SecretRequest({ name: 'K', purpose: '   ' }).length > 0);
});

test('secrets: request -> fulfil -> consume once; value never leaks into metadata', () => {
  const now = 1700000000000;
  const manager = new SandboxV4SecretRequestManager({ nowMs: () => now });
  const request = manager.request({
    conversationId: 'conv-s',
    name: 'GITHUB_TOKEN',
    purpose: 'Push the feature branch.',
    requestedBy: 'coder-agent',
  });
  assert.equal(request.status, 'pending');
  assert.equal(request.conversationId, 'conv-s');
  assert.equal(manager.size(), 1);
  assert.equal(manager.liveValueCount(), 0);
  // Metadata-only: no key of the request object ever holds the value.
  assert.equal(JSON.stringify(request).includes('ghp_SECRET_VALUE_123'), false);

  const fulfilled = manager.fulfill(request.id, 'ghp_SECRET_VALUE_123');
  assert.equal(fulfilled.status, 'fulfilled');
  assert.equal(manager.liveValueCount(), 1);
  assert.equal(JSON.stringify(fulfilled).includes('ghp_SECRET_VALUE_123'), false);
  assert.equal(JSON.stringify(manager.listForConversation('conv-s')).includes('ghp_SECRET_VALUE_123'), false);
  assert.equal(JSON.stringify(manager.auditLog()).includes('ghp_SECRET_VALUE_123'), false);

  // Redaction works while the value is live.
  assert.equal(
    manager.redactText('calling api with ghp_SECRET_VALUE_123 in the header'),
    `calling api with ${SANDBOX_V4_REDACTED} in the header`,
  );
  assert.deepEqual(
    manager.redactValue({ nested: ['token ghp_SECRET_VALUE_123', 42] }),
    { nested: [`token ${SANDBOX_V4_REDACTED}`, 42] },
  );

  const value = manager.consume(request.id);
  assert.equal(value, 'ghp_SECRET_VALUE_123');
  assert.equal(manager.liveValueCount(), 0, 'consumed value is gone from memory');
  assert.throws(() => manager.consume(request.id), /not fulfilled|already consumed|gone/);
  assert.throws(() => manager.fulfill(request.id, 'x'), /not pending/);
  assert.throws(() => manager.deny(request.id), /not pending/);
  assert.throws(() => manager.fulfill('nope', 'x'), /Unknown secret request/);
  assert.throws(() => manager.consume('nope'), /Unknown secret request/);
});

test('secrets: deny, expiry sweep, audit hash chain', () => {
  let now = 1700000000000;
  const manager = new SandboxV4SecretRequestManager({ ttlMs: 1000, nowMs: () => now });
  const denied = manager.request({ conversationId: 'conv-d', name: 'K1', purpose: 'p' });
  const done = manager.deny(denied.id, 'Not needed anymore.');
  assert.equal(done.status, 'denied');
  assert.equal(done.note, 'Not needed anymore.');
  assert.equal(done.resolvedBy, 'user');

  const expiring = manager.request({ conversationId: 'conv-d', name: 'K2', purpose: 'p' });
  const staying = manager.request({ conversationId: 'conv-d', name: 'K3', purpose: 'p' });
  assert.equal(manager.listPending('conv-d').length, 2);
  now += 1500;
  const expired = manager.sweepExpired();
  assert.deepEqual(expired, [expiring.id, staying.id]);
  assert.equal(manager.describe(expiring.id)?.status, 'expired');
  // A fulfilled request is never swept.
  const kept = manager.request({ conversationId: 'conv-d', name: 'K4', purpose: 'p' });
  manager.fulfill(kept.id, 'value-9');
  now += 5000;
  assert.deepEqual(manager.sweepExpired(), []);
  assert.equal(manager.describe(kept.id)?.status, 'fulfilled');

  // Audit chain is intact: requested/denied/expired/fulfilled events, metadata only.
  assert.equal(manager.verifyAuditChain(), 0);
  const log = manager.auditLog();
  assert.ok(log.length >= 6);
  assert.ok(log.every((e) => e.prevHash !== undefined && e.hash.length === 64));
  assert.equal(log[0].seq, 1);
  assert.equal(log[0].prevHash, '');
  assert.ok(log.every((e) => !JSON.stringify(e).includes('value-9')));
  // Fulfil with an empty value is refused.
  const bad = manager.request({ conversationId: 'conv-d', name: 'K5', purpose: 'p' });
  assert.throws(() => manager.fulfill(bad.id, ''), /non-empty string/);
  // Short values are still stored (they are the user's choice) but
  // are not scrubbed by redactText (too collision-prone).
  manager.fulfill(bad.id, 'ab');
  assert.equal(manager.redactText('xxabxx'), 'xxabxx');
  assert.throws(() => manager.request({ conversationId: '', name: 'K', purpose: 'p' }), /non-empty conversationId/);
  assert.throws(() => manager.request({ conversationId: 'c', name: 'bad name', purpose: 'p' }), /Invalid secret request/);
});

test('secrets: removeForConversation drops requests and live values', () => {
  const manager = new SandboxV4SecretRequestManager();
  const a = manager.request({ conversationId: 'conv-a', name: 'K', purpose: 'p' });
  manager.fulfill(a.id, 'live-value-1');
  manager.request({ conversationId: 'conv-b', name: 'K', purpose: 'p' });
  assert.equal(manager.removeForConversation('conv-a'), 1);
  assert.equal(manager.liveValueCount(), 0);
  assert.equal(manager.describe(a.id), undefined);
  assert.equal(manager.size(), 1);
});
