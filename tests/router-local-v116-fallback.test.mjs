/**
 * Local model router v116 fallback tests (v1.39, Doi T3 — node:test,
 * no network, no real model).
 *
 * Covers (pure modules — fallbackV116):
 * - backoffDelayMs: exponential growth, capped at max, jitter in
 *   range (deterministic random injection).
 * - ModelCircuitBreaker: closed -> open after N failures -> half-open
 *   after reset timeout -> closed on success / open again on failure;
 *   canAttempt() false while open; nextRetryAt(); reset(); snapshot
 *   round-trip (fromSnapshot).
 * - LocalFallbackChain: tries candidates in order, stops at first
 *   success, records attempts; skips open breakers (skipped-open);
 *   executor errors are recorded, never thrown; maxChainLength caps
 *   the chain; serialize/deserialize restores breaker state.
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/router-local-v116-fallback.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_LOCAL_CIRCUIT_BREAKER_CONFIG,
  LocalFallbackChain,
  ModelCircuitBreaker,
  backoffDelayMs,
} from '../packages/core/dist/router/local/index.js';

function candidate(modelId, kind = 'local') {
  return { kind, modelId, costPer1kTokensUsd: 0, estLatencyMs: 100, quality: 0.9 };
}

/** Fake clock: now() tra ve gia tri co the tang tay. */
function fakeClock(start = 1_000_000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms) => { now += ms; },
  };
}

test('backoffDelayMs: exponential, capped, jitter bounded', () => {
  const config = { ...DEFAULT_LOCAL_CIRCUIT_BREAKER_CONFIG, backoffBaseMs: 1000, backoffMaxMs: 8000, backoffJitter: 0 };
  assert.equal(backoffDelayMs(0, config, () => 0.5), 1000);
  assert.equal(backoffDelayMs(1, config, () => 0.5), 2000);
  assert.equal(backoffDelayMs(2, config, () => 0.5), 4000);
  assert.equal(backoffDelayMs(3, config, () => 0.5), 8000);
  assert.equal(backoffDelayMs(10, config, () => 0.5), 8000, 'chan tran max');
  // Jitter +-20%: random=0 -> -20%, random=1 -> +20%.
  const jittered = { ...config, backoffJitter: 0.2 };
  assert.equal(backoffDelayMs(0, jittered, () => 0), 800);
  assert.equal(backoffDelayMs(0, jittered, () => 1), 1200);
  assert.equal(backoffDelayMs(0, jittered, () => 0.5), 1000);
});

test('ModelCircuitBreaker: opens after threshold, half-opens after timeout', () => {
  const clock = fakeClock();
  const breaker = new ModelCircuitBreaker('qwen3-4b', { failureThreshold: 2, resetTimeoutMs: 5000 }, clock.now);
  assert.equal(breaker.getState(), 'closed');
  assert.equal(breaker.canAttempt(), true);
  breaker.recordFailure('boom 1');
  assert.equal(breaker.getState(), 'closed', 'chua du nguong thi van closed');
  breaker.recordFailure('boom 2');
  assert.equal(breaker.getState(), 'open');
  assert.equal(breaker.canAttempt(), false);
  assert.equal(breaker.nextRetryAt(), 1_000_000 + 5000);
  // Chua het timeout: van open.
  clock.advance(4999);
  assert.equal(breaker.getState(), 'open');
  // Het timeout: half-open, cho thu lai.
  clock.advance(1);
  assert.equal(breaker.getState(), 'half-open');
  assert.equal(breaker.canAttempt(), true);
  // Thu lai that bai -> mo lai ngay.
  breaker.recordFailure('boom 3');
  assert.equal(breaker.getState(), 'open');
  // Het timeout lan nua, thu lai thanh cong -> dong.
  clock.advance(5000);
  assert.equal(breaker.getState(), 'half-open');
  breaker.recordSuccess();
  assert.equal(breaker.getState(), 'closed');
  assert.equal(breaker.canAttempt(), true);
});

test('ModelCircuitBreaker: success resets failure count; reset() clears', () => {
  const clock = fakeClock();
  const breaker = new ModelCircuitBreaker('m', { failureThreshold: 3 }, clock.now);
  breaker.recordFailure('e1');
  breaker.recordFailure('e2');
  breaker.recordSuccess();
  breaker.recordFailure('e3');
  breaker.recordFailure('e4');
  assert.equal(breaker.getState(), 'closed', 'success giua chung phai reset dem loi');
  breaker.recordFailure('e5');
  assert.equal(breaker.getState(), 'open');
  breaker.reset();
  assert.equal(breaker.getState(), 'closed');
  assert.equal(breaker.snapshot().consecutiveFailures, 0);
  assert.equal(breaker.snapshot().lastError, null);
});

test('ModelCircuitBreaker: snapshot round-trip preserves state', () => {
  const clock = fakeClock();
  const breaker = new ModelCircuitBreaker('m', { failureThreshold: 1 }, clock.now);
  breaker.recordFailure('kaboom');
  assert.equal(breaker.getState(), 'open');
  const snap = breaker.snapshot();
  assert.equal(snap.totalFailures, 1);
  assert.equal(snap.openedAt, 1_000_000);
  const restored = ModelCircuitBreaker.fromSnapshot(snap, { failureThreshold: 1 }, clock.now);
  assert.equal(restored.getState(), 'open');
  assert.equal(restored.canAttempt(), false);
  assert.equal(restored.snapshot().lastError, 'kaboom');
});

test('LocalFallbackChain: stops at first success, records attempts', async () => {
  const clock = fakeClock();
  const chain = new LocalFallbackChain({}, clock.now);
  const calls = [];
  const result = await chain.attempt(
    [candidate('a'), candidate('b'), candidate('c')],
    async (c) => {
      calls.push(c.modelId);
      if (c.modelId === 'a') throw new Error('a chet');
      return `ok-${c.modelId}`;
    },
  );
  assert.equal(result.succeeded, true);
  assert.equal(result.modelId, 'b');
  assert.equal(result.value, 'ok-b');
  assert.deepEqual(calls, ['a', 'b'], 'dung o model dau tien thanh cong');
  assert.equal(result.attempts.length, 2);
  assert.equal(result.attempts[0].outcome, 'failed');
  assert.equal(result.attempts[0].error, 'a chet');
  assert.equal(result.attempts[1].outcome, 'success');
  assert.equal(chain.breakerFor('a').snapshot().consecutiveFailures, 1);
  assert.equal(chain.breakerFor('b').snapshot().totalAttempts, 1);
});

test('LocalFallbackChain: all fail -> succeeded=false, breaker opens', async () => {
  const clock = fakeClock();
  const chain = new LocalFallbackChain({ breaker: { failureThreshold: 2 } }, clock.now);
  const fail = async () => { throw new Error('nope'); };
  const r1 = await chain.attempt([candidate('x'), candidate('y')], fail);
  assert.equal(r1.succeeded, false);
  assert.equal(r1.modelId, null);
  assert.equal(r1.attempts.length, 2);
  // Lan 2: ca 2 deu that bai lan 2 -> breaker mo.
  await chain.attempt([candidate('x'), candidate('y')], fail);
  assert.equal(chain.breakerFor('x').getState(), 'open');
  assert.equal(chain.breakerFor('y').getState(), 'open');
  // Lan 3: ca 2 bi bo qua (skipped-open), executor khong duoc goi.
  let calls = 0;
  const r3 = await chain.attempt([candidate('x'), candidate('y')], async () => { calls += 1; return 'ok'; });
  assert.equal(calls, 0);
  assert.equal(r3.succeeded, false);
  assert.ok(r3.attempts.every((a) => a.outcome === 'skipped-open'));
});

test('LocalFallbackChain: maxChainLength caps the chain', async () => {
  const clock = fakeClock();
  const chain = new LocalFallbackChain({ maxChainLength: 2 }, clock.now);
  const calls = [];
  const result = await chain.attempt(
    [candidate('a'), candidate('b'), candidate('c'), candidate('d')],
    async (c) => { calls.push(c.modelId); throw new Error('fail'); },
  );
  assert.deepEqual(calls, ['a', 'b']);
  assert.equal(result.attempts.length, 2);
  assert.equal(chain.getConfig().maxChainLength, 2);
});

test('LocalFallbackChain: half-open model is retried after timeout', async () => {
  const clock = fakeClock();
  const chain = new LocalFallbackChain({ breaker: { failureThreshold: 1, resetTimeoutMs: 1000 } }, clock.now);
  const fail = async () => { throw new Error('down'); };
  await chain.attempt([candidate('m')], fail);
  assert.equal(chain.breakerFor('m').getState(), 'open');
  clock.advance(1000);
  let called = false;
  const result = await chain.attempt([candidate('m')], async () => { called = true; return 'back'; });
  assert.equal(called, true, 'het timeout phai duoc thu lai');
  assert.equal(result.succeeded, true);
  assert.equal(chain.breakerFor('m').getState(), 'closed');
});

test('LocalFallbackChain: serialize/deserialize restores open breakers', async () => {
  const clock = fakeClock();
  const chain = new LocalFallbackChain({ breaker: { failureThreshold: 1 } }, clock.now);
  await chain.attempt([candidate('m')], async () => { throw new Error('down'); });
  const snapshots = chain.serialize();
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].state, 'open');
  const restored = LocalFallbackChain.deserialize(snapshots, { breaker: { failureThreshold: 1 } }, clock.now);
  assert.equal(restored.breakerFor('m').getState(), 'open');
  assert.equal(restored.breakerFor('m').canAttempt(), false);
  restored.resetAll();
  assert.equal(restored.breakerSnapshots().length, 0);
});

test('LocalFallbackChain: backoffFor grows with consecutive failures', () => {
  const clock = fakeClock();
  const chain = new LocalFallbackChain({ breaker: { backoffBaseMs: 1000, backoffMaxMs: 30000, backoffJitter: 0 } }, clock.now);
  const breaker = chain.breakerFor('m');
  breaker.recordFailure('e1');
  assert.equal(chain.backoffFor('m', () => 0.5), 1000);
  breaker.recordFailure('e2');
  assert.equal(chain.backoffFor('m', () => 0.5), 2000);
  breaker.recordFailure('e3');
  assert.equal(chain.backoffFor('m', () => 0.5), 4000);
});
