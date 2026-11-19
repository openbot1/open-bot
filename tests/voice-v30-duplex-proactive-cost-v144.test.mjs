/**
 * Tests for voice v30 units: full-duplex v2, proactive audio v2,
 * cost ledger v2 (v1.44, Team T4).
 *
 * Covers: two lanes running at once (inbound + outbound queues
 * stay independent), the jitter buffer (a late frame lands in
 * order), backpressure (a full queue drops the oldest frame),
 * degraded mode (latency SLO breaches degrade, recovery is
 * explicit), crosstalk counting, proactive priority order
 * (critical before normal), token-bucket rate limiting, dedupe
 * by key, TTL expiry, quiet-hours suppression with text
 * fallback, DND / not-present suppression, cost math (minutes
 * + tokens, per-kind breakdown), budget envelopes (session
 * cap stops billing), day/week/month rollups, forecasts, and
 * itemised statements (Markdown / CSV).
 *
 * All offline, deterministic, no key / network / audio.
 * Only the v30 namespace is asserted — no global totals.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CostLedgerV30,
  FullDuplexEngineV30,
  ProactiveAudioV30,
  costForMinutesV30,
  costForTokensV30,
  createCostLedgerV30,
  createFullDuplexEngineV30,
  createProactiveAudioV30,
  dayKeyV30,
  monthKeyV30,
} from '../packages/core/dist/voiceV30/index.js';

test('v30 duplex: inbound and outbound lanes run independently', () => {
  const engine = createFullDuplexEngineV30();
  engine.pushInbound(0, 0.8, 'hello');
  engine.pushInbound(50, 0.7, 'world');
  engine.pushOutbound(0, 0.6, 'hi there');
  assert.equal(engine.inboundDepth(), 2);
  assert.equal(engine.outboundDepth(), 1);
  assert.equal(engine.laneState('inbound'), 'active');
  assert.equal(engine.laneState('outbound'), 'active');
  const inbound = engine.drainInbound(10);
  assert.deepEqual(inbound.map((f) => f.text), ['hello', 'world']);
  assert.equal(engine.inboundDepth(), 0);
  // Draining one lane leaves the other untouched.
  assert.equal(engine.outboundDepth(), 1);
  const outbound = engine.drainOutbound(10);
  assert.deepEqual(outbound.map((f) => f.text), ['hi there']);
});

test('v30 duplex: the jitter buffer reorders a late frame', () => {
  const engine = createFullDuplexEngineV30();
  engine.pushInbound(100, 0.8, 'second');
  engine.pushInbound(0, 0.8, 'first');
  engine.pushInbound(50, 0.8, 'middle');
  const drained = engine.drainInbound(10);
  assert.deepEqual(drained.map((f) => f.text), ['first', 'middle', 'second']);
  assert.ok(engine.stats().jitterReordered >= 1);
});

test('v30 duplex: a full inbound queue drops the oldest frame (backpressure)', () => {
  const engine = createFullDuplexEngineV30({ inboundQueueMax: 3 });
  engine.pushInbound(0, 0.8, 'a');
  engine.pushInbound(50, 0.8, 'b');
  engine.pushInbound(100, 0.8, 'c');
  engine.pushInbound(150, 0.8, 'd');
  assert.equal(engine.inboundDepth(), 3);
  assert.equal(engine.stats().inboundDropped, 1);
  assert.equal(engine.laneState('inbound'), 'backpressured');
  const drained = engine.drainInbound(10);
  assert.deepEqual(drained.map((f) => f.text), ['b', 'c', 'd']);
});

test('v30 duplex: turn latency is measured against the SLOs', () => {
  const engine = createFullDuplexEngineV30();
  const id = engine.startTurn('speech-to-speech', 0);
  assert.ok(id.startsWith('duplex-turn-'));
  engine.markFirstByte(200);
  const turn = engine.endTurn(600);
  assert.notEqual(turn, null);
  assert.equal(turn?.firstByteLatencyMs, 200);
  assert.equal(turn?.totalLatencyMs, 600);
  assert.equal(turn?.withinFirstByteSlo, true);
  assert.equal(turn?.withinTotalSlo, true);
  assert.equal(engine.stats().sloBreaches, 0);
});

test('v30 duplex: two total-SLO breaches degrade; recovery is explicit', () => {
  const engine = createFullDuplexEngineV30({ sloBreachToDegrade: 2 });
  engine.startTurn('speech-to-speech', 0);
  engine.endTurn(2000); // over the 900ms total SLO
  assert.equal(engine.isDegraded(), false);
  engine.startTurn('speech-to-speech', 3000);
  engine.endTurn(5000); // second breach
  assert.equal(engine.isDegraded(), true);
  assert.equal(engine.getDegradationReason(), 'latency-slo-breach');
  assert.equal(engine.stats().sloBreaches, 2);
  // Degraded: the outbound lane refuses new chunks.
  assert.equal(engine.pushOutbound(5100, 0.6, 'held'), null);
  // Inbound still works in degraded mode.
  assert.notEqual(engine.pushInbound(5100, 0.8, 'user speaks'), null);
  assert.equal(engine.recover(6000), true);
  assert.equal(engine.isDegraded(), false);
  assert.equal(engine.recover(6100), false);
  assert.notEqual(engine.pushOutbound(6100, 0.6, 'speaking again'), null);
});

test('v30 duplex: simultaneous lanes count as crosstalk', () => {
  const engine = createFullDuplexEngineV30({ crosstalkToDegrade: 100 });
  engine.pushInbound(0, 0.8);
  engine.pushOutbound(100, 0.6);
  engine.pushInbound(200, 0.8);
  engine.pushOutbound(250, 0.6);
  assert.ok(engine.stats().crosstalkWindows >= 2);
  assert.equal(engine.isDegraded(), false);
});

test('v30 proactive: critical triggers fire before normal ones', () => {
  const queue = createProactiveAudioV30();
  queue.schedule('idle-nudge', 'Still there?', 0);
  queue.schedule('alert', 'Your build finished with errors!', 0);
  const fired = queue.tick(0, false);
  assert.notEqual(fired, null);
  assert.equal(fired?.kind, 'alert');
  assert.equal(fired?.priority, 'critical');
  // The idle nudge is still scheduled; the cooldown holds it this tick.
  const stats = queue.stats();
  assert.equal(stats.fired, 1);
});

test('v30 proactive: token bucket rate-limits a chatty kind', () => {
  const queue = createProactiveAudioV30({
    bucketCapacity: 1,
    bucketRefillPerMin: 1,
    cooldownMs: 0,
  });
  queue.schedule('task-complete', 'Task A done', 0);
  queue.schedule('task-complete', 'Task B done', 0);
  const first = queue.tick(0, false);
  assert.notEqual(first, null);
  assert.equal(first?.text, 'Task A done');
  // The kind bucket is empty now: Task B is suppressed + text fallback.
  const second = queue.tick(1, false);
  assert.equal(second, null);
  const stats = queue.stats();
  assert.equal(stats.suppressed, 1);
  assert.equal(stats.textFallbacks, 1);
  assert.equal(queue.textFallbacksSoFar().length, 1);
  assert.equal(queue.textFallbacksSoFar()[0].text, 'Task B done');
});

test('v30 proactive: a duplicate dedupe key is dropped', () => {
  const queue = createProactiveAudioV30();
  const first = queue.schedule('task-complete', 'Build done', 0, { dedupeKey: 'build-42' });
  assert.equal(first?.state, 'scheduled');
  const dup = queue.schedule('task-complete', 'Build done again', 1000, { dedupeKey: 'build-42' });
  assert.equal(dup?.state, 'deduplicated');
  assert.equal(dup?.outcome, 'deduplicated');
  assert.equal(queue.stats().deduplicated, 1);
  // After the dedupe window, the same key is accepted again.
  const later = queue.schedule('task-complete', 'Build done later', 61000, { dedupeKey: 'build-42' });
  assert.equal(later?.state, 'scheduled');
});

test('v30 proactive: a trigger past its TTL expires instead of firing', () => {
  const queue = createProactiveAudioV30();
  queue.schedule('scheduled-reminder', 'Meeting in 5 minutes', 0, { ttlMs: 1000 });
  const fired = queue.tick(5000, false);
  assert.equal(fired, null);
  assert.equal(queue.stats().expired, 1);
});

test('v30 proactive: quiet hours suppress audio and escalate to text', () => {
  const queue = createProactiveAudioV30({ cooldownMs: 0 });
  queue.setQuietHours(22, 6);
  // 23:00 UTC is inside quiet hours (22-06). ttlMs 0 = never expires.
  const atMs = Date.UTC(2026, 10, 19, 23, 0, 0);
  queue.schedule('scheduled-reminder', 'Drink water', atMs, { ttlMs: 0 });
  const fired = queue.tick(atMs, false);
  assert.equal(fired, null);
  assert.equal(queue.stats().suppressed, 1);
  assert.equal(queue.stats().textFallbacks, 1);
  const events = queue.eventsSoFar();
  assert.ok(events.some((e) => e.outcome === 'suppressed-quiet-hours'));
  assert.ok(events.some((e) => e.outcome === 'text-fallback'));
});

test('v30 proactive: never speaks over the user, and DND suppresses', () => {
  const queue = createProactiveAudioV30({ cooldownMs: 0 });
  queue.schedule('greeting', 'Hello!', 0);
  assert.equal(queue.tick(0, true), null);
  assert.equal(queue.stats().suppressed, 1);
  queue.setDoNotDisturb(true);
  queue.schedule('greeting', 'Hello again!', 1000);
  const second = queue.tick(1000, false);
  assert.equal(second, null);
  assert.equal(queue.stats().suppressed, 2);
});

test('v30 proactive: a critical alert with forceAudio still speaks in quiet hours', () => {
  const queue = createProactiveAudioV30({ cooldownMs: 0 });
  queue.setQuietHours(22, 6);
  const atMs = Date.UTC(2026, 10, 19, 23, 0, 0);
  queue.schedule('alert', 'Server is down!', atMs, { ttlMs: 0, payload: { forceAudio: 'true' } });
  const fired = queue.tick(atMs, false);
  assert.notEqual(fired, null);
  assert.equal(fired?.kind, 'alert');
});

test('v30 cost: minute + token hybrid math', () => {
  assert.equal(costForMinutesV30(1.5, 0.05), 0.075);
  assert.equal(costForTokensV30(1000, 0.01), 0.01);
  assert.equal(costForTokensV30(500, 0.01), 0.005);
  assert.equal(costForTokensV30(1000, null), 0);
  const ledger = createCostLedgerV30({
    sessionBudget: { warnAtUsd: 100, capUsd: 0 },
    dailyBudget: { warnAtUsd: 100, capUsd: 0 },
    monthlyBudget: { warnAtUsd: 100, capUsd: 0 },
  });
  ledger.startSession('s1', 'gpt-live', 0);
  const entries = ledger.tick('s1', { inputMs: 60_000, outputMs: 60_000, tokens: 1000 }, 60_000);
  // gpt-live: $0.05/min audio + $0.01/1k tokens.
  assert.equal(entries.length, 3);
  const meter = ledger.getMeter('s1');
  assert.notEqual(meter, null);
  assert.equal(meter?.usd, 0.11);
  assert.equal(meter?.usdByKind['input-audio'], 0.05);
  assert.equal(meter?.usdByKind['output-audio'], 0.05);
  assert.equal(meter?.usdByKind['text-tokens'], 0.01);
  assert.equal(meter?.tokens, 1000);
});

test('v30 cost: the session cap stops billing but keeps recording minutes', () => {
  const ledger = createCostLedgerV30({
    sessionBudget: { warnAtUsd: 0.04, capUsd: 0.05 },
    dailyBudget: { warnAtUsd: 0, capUsd: 0 },
    monthlyBudget: { warnAtUsd: 0, capUsd: 0 },
  });
  ledger.startSession('s1', 'gpt-live', 0);
  ledger.tick('s1', { inputMs: 60_000 }, 60_000); // $0.05 — exactly at the cap
  const meter = ledger.getMeter('s1');
  assert.equal(meter?.usd, 0.05);
  assert.equal(meter?.capped, false); // at the cap, not over it
  ledger.tick('s1', { inputMs: 60_000 }, 120_000); // would be another $0.05
  const capped = ledger.getMeter('s1');
  assert.equal(capped?.usd, 0.05);
  assert.equal(capped?.capped, true);
  assert.equal(capped?.inputMs, 120_000); // minutes stay honest
  assert.ok(ledger.alertsSoFar().some((a) => a.level === 'cap-reached'));
  assert.ok(ledger.alertsSoFar().some((a) => a.level === 'warning'));
});

test('v30 cost: report rolls up per day, week and month', () => {
  const ledger = createCostLedgerV30({
    sessionBudget: { warnAtUsd: 0, capUsd: 0 },
    dailyBudget: { warnAtUsd: 0, capUsd: 0 },
    monthlyBudget: { warnAtUsd: 0, capUsd: 0 },
  });
  const t0 = Date.UTC(2026, 10, 19, 10, 0, 0);
  ledger.startSession('s1', 'gpt-live', t0);
  ledger.tick('s1', { inputMs: 60_000 }, t0 + 60_000);
  ledger.startSession('s2', 'gpt-live', t0 + 3_600_000);
  ledger.tick('s2', { outputMs: 60_000 }, t0 + 3_660_000);
  const report = ledger.report();
  assert.equal(report.sessions, 2);
  assert.equal(report.totalUsd, 0.1);
  assert.equal(report.totalMinutes, 2);
  assert.equal(report.byDay[dayKeyV30(t0)]?.usd, 0.1);
  assert.equal(report.byMonth[monthKeyV30(t0)]?.usd, 0.1);
  assert.equal(Object.keys(report.byWeek).length, 1);
  assert.equal(report.byModel['gpt-live']?.sessions, 2);
  assert.equal(report.bySession.s1?.usd, 0.05);
  assert.equal(report.usdByKind['input-audio'], 0.05);
  assert.equal(report.usdByKind['output-audio'], 0.05);
});

test('v30 cost: forecast projects the run-rate for the day and month', () => {
  const ledger = createCostLedgerV30({
    sessionBudget: { warnAtUsd: 0, capUsd: 0 },
    dailyBudget: { warnAtUsd: 0, capUsd: 10 },
    monthlyBudget: { warnAtUsd: 0, capUsd: 100 },
  });
  // Noon UTC: half the day gone, $1 spent -> $2 projected for the day.
  const noon = Date.UTC(2026, 10, 19, 12, 0, 0);
  ledger.startSession('s1', 'gpt-live', noon - 3_600_000);
  // 20 minutes of gpt-live audio = $1.00.
  ledger.tick('s1', { inputMs: 1_200_000 }, noon);
  const forecast = ledger.forecast(noon);
  assert.equal(forecast.spentTodayUsd, 1);
  assert.equal(forecast.projectedDayUsd, 2);
  assert.equal(forecast.wouldBreachDailyCap, false);
  assert.equal(forecast.wouldBreachMonthlyCap, false);
});

test('v30 cost: itemised statements list every slice', () => {
  const ledger = createCostLedgerV30({
    sessionBudget: { warnAtUsd: 0, capUsd: 0 },
    dailyBudget: { warnAtUsd: 0, capUsd: 0 },
    monthlyBudget: { warnAtUsd: 0, capUsd: 0 },
  });
  ledger.startSession('s1', 'gpt-live', 0);
  ledger.tick('s1', { inputMs: 60_000, tokens: 2000 }, 60_000);
  const md = ledger.statementMarkdown('s1');
  assert.ok(md.includes('# Voice cost statement (v30) — s1'));
  assert.ok(md.includes('input-audio'));
  assert.ok(md.includes('text-tokens'));
  const csv = ledger.statementCsv('s1');
  assert.ok(csv.startsWith('sessionId,modelId,kind,startedAtMs,endedAtMs,minutes,tokens,usd'));
  assert.equal(csv.trim().split('\n').length, 3); // header + 2 slices
  const json = ledger.toJson();
  assert.equal(JSON.parse(json).totalUsd, 0.07);
  assert.equal(ledger.statementMarkdown('nope').includes('No such session'), true);
});

test('v30 cost: estimate checks all three budget envelopes', () => {
  const ledger = createCostLedgerV30({
    sessionBudget: { warnAtUsd: 0, capUsd: 1 },
    dailyBudget: { warnAtUsd: 0, capUsd: 1 },
    monthlyBudget: { warnAtUsd: 0, capUsd: 1 },
  });
  const est = ledger.estimate('gpt-live', 30, 0, 0);
  assert.equal(est.estimatedUsd, 1.5);
  assert.equal(est.withinSessionCap, false);
  assert.equal(est.withinDailyCap, false);
  assert.equal(est.withinMonthlyCap, false);
  const small = ledger.estimate('gpt-live', 1, 0, 0);
  assert.equal(small.withinSessionCap, true);
  const unknown = new CostLedgerV30().estimate('mock-cascaded', 10, 0, 0);
  assert.equal(unknown.estimatedUsd, 0);
});
