/**
 * Provider health monitor tests (v1.08, Đội T4 — node:test, mock probe
 * only, NO live calls, NO real keys).
 *
 * Covers:
 *  - unknown → up on first success; latency + uptime recorded
 *  - 1 failure = degraded, 2nd consecutive failure = down (alert once)
 *  - recovery on success (alert once, not per probe)
 *  - probe that throws is recorded as a failure, never crashes check()
 *  - quota parsing: x-ratelimit-* headers (remaining/limit/reset in
 *    seconds, epoch seconds and epoch ms) + quota-low alert on crossing
 *  - history (newest first, capped) + alerts (newest first, capped)
 *  - summary counts + worst latency + quota-low provider list
 *  - reset() per provider + reset() all; subscribe/unsubscribe
 *  - start()/stop() timer state (no real waiting — short interval + stop)
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/provider-health-v108.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ProviderHealthMonitor,
  parseQuotaHeaders,
} from '../packages/core/dist/providers/health.js';

function makeProbe(results) {
  // results: array of probe results (or Errors to throw); cycles the last one.
  let calls = 0;
  const probe = async (providerId) => {
    const item = results[Math.min(calls, results.length - 1)];
    calls += 1;
    if (item instanceof Error) throw item;
    return { ...item, providerId };
  };
  probe.calls = () => calls;
  return probe;
}

test('health v108: unknown provider, then up on first success with latency + uptime', async () => {
  let now = 1_000_000;
  const probe = makeProbe([{ ok: true, latencyMs: 120 }]);
  const monitor = new ProviderHealthMonitor({ probe, now: () => now });
  const before = monitor.getSnapshot('openrouter');
  assert.equal(before.status, 'unknown');
  assert.equal(before.uptimePct, null);
  assert.equal(before.checksTotal, 0);
  now += 120;
  const snap = await monitor.check('openrouter');
  assert.equal(snap.status, 'up');
  assert.equal(snap.lastLatencyMs, 120);
  assert.equal(snap.checksTotal, 1);
  assert.equal(snap.failuresTotal, 0);
  assert.equal(snap.uptimePct, 100);
  assert.equal(snap.consecutiveSuccesses, 1);
  assert.equal(snap.consecutiveFailures, 0);
  assert.deepEqual(monitor.getAlerts(), []);
});

test('health v108: 1 failure = degraded, 2nd consecutive = down, alerts fire once per transition', async () => {
  const probe = makeProbe([
    { ok: true, latencyMs: 50 },
    { ok: false, latencyMs: 30, error: 'HTTP 500' },
    { ok: false, latencyMs: 31, error: 'HTTP 500' },
    { ok: false, latencyMs: 32, error: 'HTTP 500' },
    { ok: true, latencyMs: 60 },
  ]);
  const seen = [];
  const monitor = new ProviderHealthMonitor({ probe, onAlert: (a) => seen.push(a) });
  await monitor.check('fireworks');
  let snap = await monitor.check('fireworks');
  assert.equal(snap.status, 'degraded');
  assert.equal(snap.lastError, 'HTTP 500');
  assert.equal(snap.uptimePct, 50);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].kind, 'degraded');
  snap = await monitor.check('fireworks');
  assert.equal(snap.status, 'down');
  assert.equal(snap.consecutiveFailures, 2);
  assert.equal(seen.length, 2);
  assert.equal(seen[1].kind, 'down');
  assert.match(seen[1].message, /Fireworks|fireworks/);
  // 3rd failure while already down: NO new alert (transition-only).
  await monitor.check('fireworks');
  assert.equal(seen.length, 2);
  // Recovery: one success → up + one 'recovered' alert.
  snap = await monitor.check('fireworks');
  assert.equal(snap.status, 'up');
  assert.equal(snap.consecutiveFailures, 0);
  assert.equal(seen.length, 3);
  assert.equal(seen[2].kind, 'recovered');
  assert.equal(monitor.getAlerts().length, 3);
  assert.equal(monitor.getAlerts()[0].kind, 'recovered', 'alerts are newest first');
});

test('health v108: probe that throws is recorded as failure, check() never throws', async () => {
  const probe = makeProbe([new Error('ECONNREFUSED'), { ok: true, latencyMs: 10 }]);
  const monitor = new ProviderHealthMonitor({ probe });
  const snap = await monitor.check('groq');
  assert.equal(snap.status, 'degraded');
  assert.match(snap.lastError, /ECONNREFUSED/);
  assert.equal(snap.failuresTotal, 1);
  const recovered = await monitor.check('groq');
  assert.equal(recovered.status, 'up');
});

test('health v108: probe returning an invalid result is a failure', async () => {
  const probe = async () => 'not-an-object';
  const monitor = new ProviderHealthMonitor({ probe });
  const snap = await monitor.check('deepseek');
  assert.equal(snap.status, 'degraded');
  assert.match(snap.lastError, /invalid result/);
});

test('health v108: downAfterFailures option changes the down threshold', async () => {
  const probe = makeProbe([{ ok: false, error: 'x' }]);
  const monitor = new ProviderHealthMonitor({ probe, downAfterFailures: 3 });
  assert.equal((await monitor.check('a')).status, 'degraded');
  assert.equal((await monitor.check('a')).status, 'degraded');
  assert.equal((await monitor.check('a')).status, 'down');
});

test('health v108: parseQuotaHeaders reads remaining/limit/reset (seconds, epoch s, epoch ms)', () => {
  const now = 1_700_000_000_000;
  assert.deepEqual(
    parseQuotaHeaders({ 'x-ratelimit-remaining': '42', 'x-ratelimit-limit': '1000' }, now),
    { remaining: 42, limit: 1000 },
  );
  // Reset in seconds-from-now.
  assert.deepEqual(
    parseQuotaHeaders({ 'X-RateLimit-Remaining': '5', 'x-ratelimit-reset': '60' }, now),
    { remaining: 5, resetAtMs: now + 60_000 },
  );
  // Reset as epoch seconds.
  assert.deepEqual(
    parseQuotaHeaders({ 'x-ratelimit-remaining': '5', 'x-ratelimit-reset': '1700000060' }, now),
    { remaining: 5, resetAtMs: 1_700_000_060_000 },
  );
  // Reset as epoch ms.
  assert.deepEqual(
    parseQuotaHeaders({ 'x-ratelimit-remaining': '5', 'x-ratelimit-reset': '1700000060000' }, now),
    { remaining: 5, resetAtMs: 1_700_000_060_000 },
  );
  // retry-after only counts as a reset when quota headers exist too.
  assert.deepEqual(
    parseQuotaHeaders({ 'x-ratelimit-remaining': '3', 'retry-after': '30' }, now),
    { remaining: 3, resetAtMs: now + 30_000 },
  );
  assert.equal(parseQuotaHeaders({ 'retry-after': '30' }, now), undefined);
  assert.equal(parseQuotaHeaders({}, now), undefined);
  assert.equal(parseQuotaHeaders({ 'x-ratelimit-remaining': 'abc' }, now), undefined);
});

test('health v108: quota-low alert fires once when crossing the threshold', async () => {
  const probe = makeProbe([
    { ok: true, latencyMs: 10, quota: { remaining: 500, limit: 1000 } },
    { ok: true, latencyMs: 11, quota: { remaining: 9, limit: 1000 } },
    { ok: true, latencyMs: 12, quota: { remaining: 8, limit: 1000 } },
    { ok: true, latencyMs: 13, quota: { remaining: 100, limit: 1000 } },
  ]);
  const seen = [];
  const monitor = new ProviderHealthMonitor({ probe, onAlert: (a) => seen.push(a) });
  let snap = await monitor.check('openrouter');
  assert.equal(snap.quotaLow, false);
  snap = await monitor.check('openrouter');
  assert.equal(snap.quotaLow, true);
  assert.equal(snap.quota.remaining, 9);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].kind, 'quota-low');
  // Still low on the next probe: no repeat alert.
  await monitor.check('openrouter');
  assert.equal(seen.length, 1);
  // Quota recovers: no alert for the recovery itself, flag clears.
  snap = await monitor.check('openrouter');
  assert.equal(snap.quotaLow, false);
});

test('health v108: history is newest-first and capped; alerts capped too', async () => {
  const probe = makeProbe([{ ok: true, latencyMs: 5 }]);
  const monitor = new ProviderHealthMonitor({ probe, maxSamplesPerProvider: 3, maxAlerts: 2 });
  await monitor.check('x');
  await monitor.check('x');
  await monitor.check('x');
  await monitor.check('x');
  const history = monitor.getHistory('x');
  assert.equal(history.length, 3, 'only the last 3 samples are kept');
  assert.equal(monitor.getSnapshot('x').samplesKept, 3);
  assert.equal(monitor.getHistory('unknown-provider').length, 0);
  assert.equal(monitor.getHistory('x', 1).length, 1);
});

test('health v108: summary counts statuses + worst latency + quota-low list', async () => {
  const probe = async (id) => {
    if (id === 'up-one') return { ok: true, latencyMs: 100 };
    if (id === 'slow-one') return { ok: true, latencyMs: 900, quota: { remaining: 2, limit: 100 } };
    return { ok: false, error: 'boom' };
  };
  const monitor = new ProviderHealthMonitor({ probe });
  await monitor.checkAll(['up-one', 'slow-one', 'down-one', 'down-one']);
  const summary = monitor.summary(['up-one', 'slow-one', 'down-one', 'never-checked']);
  assert.equal(summary.total, 4);
  assert.equal(summary.up, 2);
  assert.equal(summary.down, 1);
  assert.equal(summary.unknown, 1);
  assert.equal(summary.degraded, 0);
  assert.equal(summary.worstLatencyMs, 900);
  assert.equal(summary.worstProviderId, 'slow-one');
  assert.deepEqual(summary.quotaLowProviders, ['slow-one']);
});

test('health v108: reset() per provider and reset() all', async () => {
  const probe = makeProbe([{ ok: true, latencyMs: 10 }]);
  const monitor = new ProviderHealthMonitor({ probe });
  await monitor.check('a');
  await monitor.check('b');
  monitor.reset('a');
  assert.equal(monitor.getSnapshot('a').status, 'unknown');
  assert.equal(monitor.getSnapshot('a').checksTotal, 0);
  assert.equal(monitor.getSnapshot('b').status, 'up');
  monitor.reset();
  assert.equal(monitor.getSnapshot('b').status, 'unknown');
  assert.equal(monitor.getAlerts().length, 0);
});

test('health v108: subscribe/unsubscribe + checkAll returns snapshots in order', async () => {
  const probe = makeProbe([{ ok: true, latencyMs: 7 }]);
  const monitor = new ProviderHealthMonitor({ probe });
  const seen = [];
  const off = monitor.subscribe((a) => seen.push(a));
  const snaps = await monitor.checkAll(['p1', 'p2']);
  assert.deepEqual(snaps.map((s) => s.providerId), ['p1', 'p2']);
  assert.ok(snaps.every((s) => s.status === 'up'));
  off();
  // Unsubscribed listener gets nothing even when an alert fires.
  const failing = new ProviderHealthMonitor({
    probe: makeProbe([{ ok: false, error: 'x' }, { ok: false, error: 'x' }]),
  });
  const seen2 = [];
  const off2 = failing.subscribe((a) => seen2.push(a));
  off2();
  await failing.check('z');
  await failing.check('z');
  assert.equal(seen2.length, 0);
});

test('health v108: start()/stop() arms and disarms the timer; invalid ids throw', async () => {
  const probe = makeProbe([{ ok: true, latencyMs: 1 }]);
  const monitor = new ProviderHealthMonitor({ probe });
  assert.equal(monitor.isRunning(), false);
  monitor.start(['openrouter'], 30_000);
  assert.equal(monitor.isRunning(), true);
  monitor.start(['openrouter'], 30_000);
  assert.equal(monitor.isRunning(), true, 'second start() restarts, does not double-arm');
  monitor.stop();
  assert.equal(monitor.isRunning(), false);
  monitor.stop();
  assert.equal(monitor.isRunning(), false);
  await assert.rejects(() => monitor.check(''), /non-empty provider id/);
  assert.throws(() => monitor.getSnapshot(''), /non-empty provider id/);
  assert.throws(() => new ProviderHealthMonitor({}), /needs a probe function/);
});
