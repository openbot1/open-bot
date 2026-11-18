/**
 * Rollout v5 tests (v1.19, Đội T6 — node:test, no network).
 *
 * Covers:
 * - Canary plan validation (monotonic, last step 100%, dwell >= 0,
 *   max 20 steps) + percent-at-time ramp + stable user bucketing.
 * - Feature flags: create/validate, eval order (killed → disabled →
 *   targeting → percent bucket), kill/revive.
 * - Error budget validation + auto-rollback decisions (too few
 *   samples → none; consecutive failures → rollback; error rate
 *   over max → rollback; over pause level → pause).
 * - Rollout lifecycle: draft → canary → pause → resume → complete,
 *   illegal transitions rejected, auto decision applies rollback /
 *   pause, history capped, store upsert + save/load.
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/fleet-v119-rollout.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  applyTeamV16AutoDecision,
  completeTeamV16Rollout,
  createTeamV16FeatureFlag,
  createTeamV16Rollout,
  createTeamV16RolloutStore,
  defaultTeamV16CanaryPlan,
  defaultTeamV16ErrorBudget,
  evaluateTeamV16AutoRollback,
  isTeamV16FlagEnabledFor,
  killTeamV16FeatureFlag,
  loadTeamV16Rollouts,
  pauseTeamV16Rollout,
  resumeTeamV16Rollout,
  reviveTeamV16FeatureFlag,
  saveTeamV16Rollouts,
  startTeamV16Canary,
  teamV16CanaryPercentAt,
  teamV16RolloutPercent,
  teamV16UserInCanary,
  upsertTeamV16FeatureFlag,
  upsertTeamV16Rollout,
  validateTeamV16CanaryPlan,
  validateTeamV16ErrorBudget,
  validateTeamV16FeatureFlag,
  validateTeamV16Rollout,
} from '../packages/core/dist/fleetV16/index.js';

const T0 = Date.UTC(2026, 10, 16, 0, 0, 0);
const HOUR = 60 * 60 * 1000;

function flag(over = {}) {
  return {
    id: 'new-chat',
    name: 'New Chat',
    description: 'd',
    enabled: true,
    killed: false,
    rolloutPercent: 100,
    targeting: { userIds: [], roles: [], tenantIds: [] },
    ...over,
  };
}

function metrics(over = {}) {
  return { samples: 100, errors: 5, consecutiveFailures: 0, ...over };
}

test('rollout v16: canary plan validation', () => {
  assert.equal(validateTeamV16CanaryPlan(defaultTeamV16CanaryPlan()), '');
  assert.match(validateTeamV16CanaryPlan([]), /không được rỗng/);
  assert.match(validateTeamV16CanaryPlan([{ percent: 50, dwellMs: 0 }]), /100%/);
  assert.match(
    validateTeamV16CanaryPlan([{ percent: 50, dwellMs: 0 }, { percent: 25, dwellMs: 0 }, { percent: 100, dwellMs: 0 }]),
    /tăng đơn điệu/,
  );
  assert.match(
    validateTeamV16CanaryPlan([{ percent: 100, dwellMs: -1 }]),
    /không được âm/,
  );
  assert.match(
    validateTeamV16CanaryPlan(Array.from({ length: 21 }, (_, i) => ({ percent: (i + 1) * 4, dwellMs: 0 })).concat([{ percent: 100, dwellMs: 0 }])),
    /tối đa 20/,
  );
});

test('rollout v16: canary percent at time + user bucketing', () => {
  const plan = defaultTeamV16CanaryPlan(); // 1% → 5% → 25% → 50% → 100%, 1h each
  const at0 = teamV16CanaryPercentAt(plan, T0, T0);
  assert.equal(at0.percent, 1);
  assert.equal(at0.stepIndex, 0);
  assert.equal(at0.nextStepAt, T0 + HOUR);
  const at2h = teamV16CanaryPercentAt(plan, T0, T0 + 2 * HOUR + 1);
  assert.equal(at2h.percent, 25);
  assert.equal(at2h.stepIndex, 2);
  const atEnd = teamV16CanaryPercentAt(plan, T0, T0 + 100 * HOUR);
  assert.equal(atEnd.percent, 100);
  assert.equal(atEnd.stepIndex, 4);
  assert.equal(atEnd.nextStepAt, null);
  assert.equal(teamV16CanaryPercentAt([], T0, T0).percent, 0);
  // Bucketing is stable + deterministic.
  assert.equal(teamV16UserInCanary('r1', 'u1', 0), false);
  assert.equal(teamV16UserInCanary('r1', 'u1', 100), true);
  const a = teamV16UserInCanary('r1', 'u1', 50);
  assert.equal(teamV16UserInCanary('r1', 'u1', 50), a);
  // At 50%, roughly half of a sample of users is in canary.
  let inside = 0;
  for (let i = 0; i < 200; i++) if (teamV16UserInCanary('r1', `user-${i}`, 50)) inside++;
  assert.ok(inside > 60 && inside < 140, `expected ~100 in canary, got ${inside}`);
});

test('rollout v16: feature flags (eval order, kill switch, targeting)', () => {
  assert.equal(validateTeamV16FeatureFlag(flag()), '');
  assert.match(validateTeamV16FeatureFlag(flag({ rolloutPercent: 101 })), /0\.\.100/);
  assert.match(validateTeamV16FeatureFlag(flag({ id: 'Bad Id' })), /slug/);
  const bad = createTeamV16FeatureFlag(flag({ rolloutPercent: -1 }));
  assert.equal(bad.ok, false);
  assert.equal(bad.flag, null);
  const made = createTeamV16FeatureFlag(flag(), T0);
  assert.equal(made.ok, true, made.error);
  assert.equal(made.flag.createdAt, T0);
  const ctx = { userId: 'u1', roleRef: 'member', tenantId: 't1' };
  assert.equal(isTeamV16FlagEnabledFor(made.flag, ctx), true);
  assert.equal(isTeamV16FlagEnabledFor(flag({ ...flag(), enabled: false }), ctx), false);
  // Kill switch beats everything, even 100% + matching targeting.
  const killed = killTeamV16FeatureFlag(made.flag, T0);
  assert.equal(killed.killed, true);
  assert.equal(isTeamV16FlagEnabledFor(killed, ctx), false);
  assert.equal(isTeamV16FlagEnabledFor(reviveTeamV16FeatureFlag(killed, T0), ctx), true);
  // Targeting: wrong user / role / tenant → false.
  const targeted = createTeamV16FeatureFlag(flag({
    targeting: { userIds: ['u2'], roles: ['admin'], tenantIds: ['t1'] },
  })).flag;
  assert.equal(isTeamV16FlagEnabledFor(targeted, ctx), false);
  assert.equal(isTeamV16FlagEnabledFor(targeted, { userId: 'u2', roleRef: 'admin', tenantId: 't1' }), true);
  // 0% → nobody, even with no targeting.
  assert.equal(isTeamV16FlagEnabledFor(flag({ ...flag(), rolloutPercent: 0 }), ctx), false);
  // Invalid flag fails closed.
  assert.equal(isTeamV16FlagEnabledFor(flag({ ...flag(), rolloutPercent: 101 }), ctx), false);
});

test('rollout v16: error budget + auto-rollback decisions', () => {
  assert.equal(validateTeamV16ErrorBudget(defaultTeamV16ErrorBudget()), '');
  assert.match(validateTeamV16ErrorBudget({ ...defaultTeamV16ErrorBudget(), pauseErrorRate: 0.5, maxErrorRate: 0.2 }), /pauseErrorRate phải <= maxErrorRate/);
  assert.match(validateTeamV16ErrorBudget({ ...defaultTeamV16ErrorBudget(), minSamples: 0 }), /minSamples/);
  const budget = defaultTeamV16ErrorBudget(); // max 0.2, pause 0.1, min 10, maxConsec 5
  assert.equal(evaluateTeamV16AutoRollback(metrics({ samples: 5, errors: 5 }), budget).action, 'none', 'too few samples');
  assert.equal(evaluateTeamV16AutoRollback(metrics({ errors: 5 }), budget).action, 'none');
  assert.equal(evaluateTeamV16AutoRollback(metrics({ errors: 15 }), budget).action, 'pause', '15% > pause 10%');
  assert.equal(evaluateTeamV16AutoRollback(metrics({ errors: 25 }), budget).action, 'rollback', '25% > max 20%');
  assert.equal(evaluateTeamV16AutoRollback(metrics({ errors: 1, consecutiveFailures: 5 }), budget).action, 'rollback', 'consecutive failures');
  assert.equal(evaluateTeamV16AutoRollback(metrics({ errors: 0 }), budget).action, 'none');
});

test('rollout v16: lifecycle draft → canary → pause → resume → complete', () => {
  const made = createTeamV16Rollout({ id: 'r1', feature: 'chat-v2', version: '1.2.0' }, T0);
  assert.equal(made.ok, true, made.error);
  assert.equal(made.rollout.status, 'draft');
  assert.equal(validateTeamV16Rollout(made.rollout), '');
  assert.equal(createTeamV16Rollout({ id: 'Bad Id', feature: 'f', version: '1' }, T0).ok, false);
  // Cannot pause/complete from draft.
  assert.equal(pauseTeamV16Rollout(made.rollout, 'x', T0).ok, false);
  assert.equal(completeTeamV16Rollout(made.rollout, T0).ok, false);
  const started = startTeamV16Canary(made.rollout, T0);
  assert.equal(started.ok, true, started.error);
  assert.equal(started.rollout.status, 'canary');
  assert.equal(started.rollout.canaryStartedAt, T0);
  assert.equal(teamV16RolloutPercent(started.rollout, T0).percent, 1);
  assert.equal(teamV16RolloutPercent(made.rollout, T0).percent, 0, 'not started → 0%');
  assert.equal(startTeamV16Canary(started.rollout, T0).ok, false, 'cannot start twice');
  const paused = pauseTeamV16Rollout(started.rollout, 'ops hold', T0);
  assert.equal(paused.ok, true, paused.error);
  assert.equal(paused.rollout.status, 'paused');
  const resumed = resumeTeamV16Rollout(paused.rollout, T0);
  assert.equal(resumed.ok, true, resumed.error);
  assert.equal(resumed.rollout.status, 'canary');
  assert.equal(resumed.rollout.canaryStartedAt, T0, 'resume keeps start time');
  const done = completeTeamV16Rollout(resumed.rollout, T0);
  assert.equal(done.ok, true, done.error);
  assert.equal(done.rollout.status, 'complete');
  assert.ok(done.rollout.history.length >= 5, 'history records each step');
});

test('rollout v16: auto decision applies rollback / pause to rollout', () => {
  const made = createTeamV16Rollout({ id: 'r2', feature: 'f', version: '2' }, T0);
  const started = startTeamV16Canary(made.rollout, T0).rollout;
  const bad = applyTeamV16AutoDecision(started, metrics({ errors: 30 }), T0);
  assert.equal(bad.decision.action, 'rollback');
  assert.equal(bad.rollout.status, 'rolled-back');
  assert.equal(bad.rollout.lastAutoAction, 'rollback');
  assert.equal(bad.rollout.latestMetrics.errors, 30);
  const started2 = startTeamV16Canary(createTeamV16Rollout({ id: 'r3', feature: 'f', version: '2' }, T0).rollout, T0).rollout;
  const paused = applyTeamV16AutoDecision(started2, metrics({ errors: 12 }), T0);
  assert.equal(paused.decision.action, 'pause');
  assert.equal(paused.rollout.status, 'paused');
  const started3 = startTeamV16Canary(createTeamV16Rollout({ id: 'r4', feature: 'f', version: '2' }, T0).rollout, T0).rollout;
  const calm = applyTeamV16AutoDecision(started3, metrics({ errors: 2 }), T0);
  assert.equal(calm.decision.action, 'none');
  assert.equal(calm.rollout.status, 'canary');
});

test('rollout v16: store upsert + save/load', () => {
  let store = createTeamV16RolloutStore(T0);
  const r = createTeamV16Rollout({ id: 'r1', feature: 'f', version: '1' }, T0).rollout;
  const up = upsertTeamV16Rollout(store, r, T0);
  assert.equal(up.ok, true, up.error);
  store = up.store;
  assert.equal(upsertTeamV16Rollout(store, r, T0).ok, false, 'duplicate rollout id');
  const f = createTeamV16FeatureFlag(flag()).flag;
  const uf = upsertTeamV16FeatureFlag(store, f, T0);
  assert.equal(uf.ok, true, uf.error);
  store = uf.store;
  const f2 = { ...f, rolloutPercent: 50 };
  const uf2 = upsertTeamV16FeatureFlag(store, f2, T0);
  assert.equal(uf2.ok, true, uf2.error);
  assert.equal(uf2.store.flags.find((x) => x.id === 'new-chat').rolloutPercent, 50, 'upsert updates flag');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rollout-v16-'));
  try {
    saveTeamV16Rollouts(dir, uf2.store);
    const loaded = loadTeamV16Rollouts(dir);
    assert.ok(loaded);
    assert.equal(loaded.rollouts.length, 1);
    assert.equal(loaded.flags.length, 1);
    assert.equal(loadTeamV16Rollouts(path.join(dir, 'missing')), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
