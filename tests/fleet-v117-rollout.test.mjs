/**
 * Rollout v3 tests (v1.17, Đội T6 — node:test, no network).
 *
 * Covers:
 * - Stage plan validation (percents must strictly increase).
 * - Cohort: deterministic hash, monotonic expansion, group filter
 *   before percent (role / explicit / hash-bucket groups).
 * - Advance: dwell-time block, health-gate block, valid advance.
 * - Pause/resume round-trip (resume returns to pre-pause stage).
 * - Manual rollback (records previous version, terminal state).
 * - Auto decision: error rate / reporting users / crashes thresholds;
 *   applyAutoRollback actually pauses or rolls back when enabled,
 *   does nothing when disabled.
 * - Persistence: save/load store, upsert.
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/fleet-v117-rollout.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  advanceTeamV14Rollout,
  applyTeamV14AutoRollback,
  createTeamV14Rollout,
  createTeamV14RolloutStore,
  decideTeamV14AutoAction,
  defaultTeamV14StagePlan,
  evaluateTeamV14HealthGate,
  loadTeamV14Rollouts,
  pauseTeamV14Rollout,
  resumeTeamV14Rollout,
  rollbackTeamV14Rollout,
  saveTeamV14Rollouts,
  setTeamV14RolloutGroups,
  summarizeTeamV14Rollout,
  teamV14CohortUsers,
  teamV14NextStage,
  teamV14StageLabel,
  teamV14StagePercent,
  teamV14UserBucket,
  teamV14UserInGroup,
  teamV14UserReceivesFeature,
  updateTeamV14RolloutMetrics,
  upsertTeamV14Rollout,
  validateTeamV14Group,
  validateTeamV14StagePlan,
} from '../packages/core/dist/fleetV14/index.js';

const T0 = Date.UTC(2026, 10, 16, 0, 0, 0);
const HOUR = 60 * 60 * 1000;

function makeRollout(now = T0) {
  return createTeamV14Rollout(
    { id: 'roll-voice-v16', feature: 'voice-v16', version: 'v16', previousVersion: 'v15' },
    'u_owner',
    now,
  );
}

function healthyMetrics() {
  return { sampleUsers: 50, errorRate: 0.01, errorCount: 2, reportingUsers: 1, criticalAlerts: 0, crashes: 0 };
}

function tmpRoot() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-rollout-v14-')), 'team');
}

test('stage plan: default plan percents increase, validation catches bad plans', () => {
  const plan = defaultTeamV14StagePlan();
  assert.deepEqual(plan.map((p) => p.stage), ['canary', 'pilot', 'early', 'general', 'all']);
  assert.deepEqual(plan.map((p) => p.percent), [1, 5, 25, 50, 100]);
  assert.equal(validateTeamV14StagePlan(plan), '');
  assert.ok(validateTeamV14StagePlan([
    { stage: 'canary', percent: 5, minDwellMs: 0 },
    { stage: 'pilot', percent: 5, minDwellMs: 0 },
  ]).length > 0, 'equal percents rejected');
  assert.ok(validateTeamV14StagePlan([{ stage: 'canary', percent: 0, minDwellMs: 0 }]).length > 0);
  assert.ok(validateTeamV14StagePlan([]).length > 0);
  assert.equal(teamV14StagePercent(plan, 'canary'), 1);
  assert.equal(teamV14StagePercent(plan, 'all'), 100);
  assert.equal(teamV14NextStage(plan, 'canary'), 'pilot');
  assert.equal(teamV14NextStage(plan, 'all'), '');
  assert.equal(teamV14StageLabel('canary'), 'canary (1% users)');
  assert.equal(teamV14StageLabel('rolled-back'), 'rolled back');
});

test('cohort: deterministic bucket, monotonic expansion across stages', () => {
  const users = Array.from({ length: 2000 }, (_, i) => ({ id: `u${i}`, role: 'member' }));
  const rollout = { ...makeRollout(), stage: 'canary' };
  const canary = teamV14CohortUsers(rollout, users);
  assert.ok(canary.length >= 5 && canary.length <= 60, `canary ~1% of 2000, got ${canary.length}`);
  // Deterministic: same input, same cohort.
  assert.deepEqual(teamV14CohortUsers(rollout, users), canary);
  const pilot = teamV14CohortUsers({ ...rollout, stage: 'pilot' }, users);
  const early = teamV14CohortUsers({ ...rollout, stage: 'early' }, users);
  assert.ok(pilot.length > canary.length);
  assert.ok(early.length > pilot.length);
  for (const u of canary) assert.ok(pilot.includes(u), 'stage expansion is monotonic');
  for (const u of pilot) assert.ok(early.includes(u));
  // Bucket range sanity.
  const b = teamV14UserBucket('roll-voice-v16', 'u0');
  assert.ok(b >= 0 && b < 10000);
  // Draft/paused/rolled-back receive nothing; complete receives everything.
  assert.equal(teamV14UserReceivesFeature({ ...rollout, stage: 'draft' }, 'u0', 'member'), false);
  assert.equal(teamV14UserReceivesFeature({ ...rollout, stage: 'complete' }, 'u0', 'member'), true);
});

test('groups: role / explicit / hash-bucket filter before percent', () => {
  const roleGroup = { id: 'g-admin', name: 'Admins', kind: 'role', role: 'admin', userIds: [], bucketMin: 0, bucketMax: 10000 };
  const explicitGroup = { id: 'g-beta', name: 'Beta', kind: 'explicit', role: '', userIds: ['u1', 'u2'], bucketMin: 0, bucketMax: 10000 };
  const bucketGroup = { id: 'g-first', name: 'First bucket', kind: 'hash-bucket', role: '', userIds: [], bucketMin: 0, bucketMax: 5000 };
  assert.equal(validateTeamV14Group(roleGroup), '');
  assert.equal(validateTeamV14Group({ ...roleGroup, role: '' }).length > 0, true);
  assert.equal(validateTeamV14Group({ ...bucketGroup, bucketMin: 6000, bucketMax: 5000 }).length > 0, true);
  assert.equal(teamV14UserInGroup(roleGroup, 'u1', 'admin', 'r1'), true);
  assert.equal(teamV14UserInGroup(roleGroup, 'u1', 'member', 'r1'), false);
  assert.equal(teamV14UserInGroup(explicitGroup, 'u2', 'member', 'r1'), true);
  assert.equal(teamV14UserInGroup(explicitGroup, 'u9', 'member', 'r1'), false);
  const bucketUsers = Array.from({ length: 500 }, (_, i) => `u${i}`).filter((id) =>
    teamV14UserInGroup(bucketGroup, id, 'member', 'r1'));
  assert.ok(bucketUsers.length > 150 && bucketUsers.length < 350, `~50% in bucket, got ${bucketUsers.length}`);
  // Rollout with groups: user outside groups gets nothing even at 100%.
  const rollout = {
    ...makeRollout(),
    stage: 'all',
    groups: [explicitGroup],
    enabledGroupIds: ['g-beta'],
  };
  assert.equal(teamV14UserReceivesFeature(rollout, 'u1', 'member'), true);
  assert.equal(teamV14UserReceivesFeature(rollout, 'u9', 'member'), false);
  // setTeamV14RolloutGroups rejects unknown group ids.
  const bad = setTeamV14RolloutGroups(rollout, ['g-nope'], T0);
  assert.equal(bad.ok, false);
  const okSet = setTeamV14RolloutGroups(rollout, [], T0);
  assert.equal(okSet.ok, true, 'empty enabled list = all groups');
});

test('advance: dwell blocks, health gate blocks, valid advance moves stage', () => {
  let rollout = makeRollout(T0);
  rollout = { ...rollout, stage: 'canary', stageEnteredAt: T0, metrics: healthyMetrics() };
  const tooSoon = advanceTeamV14Rollout(rollout, 'u_owner', T0 + 10 * 60 * 1000);
  assert.equal(tooSoon.ok, false);
  assert.match(tooSoon.reason, /dwell/);
  // After dwell, healthy gate passes.
  const ok = advanceTeamV14Rollout(rollout, 'u_owner', T0 + 2 * HOUR);
  assert.equal(ok.ok, true);
  assert.equal(ok.rollout.stage, 'pilot');
  assert.equal(ok.rollout.history.length, 2);
  // Unhealthy metrics block advance.
  const sick = updateTeamV14RolloutMetrics(ok.rollout, { errorRate: 0.3, sampleUsers: 100 }, T0 + 2 * HOUR);
  const blocked = advanceTeamV14Rollout(sick, 'u_owner', T0 + 4 * HOUR);
  assert.equal(blocked.ok, false);
  assert.match(blocked.reason, /health gate failed/);
  // Advancing from 'all' completes.
  const all = { ...ok.rollout, stage: 'all', stageEnteredAt: T0, metrics: healthyMetrics() };
  const done = advanceTeamV14Rollout(all, 'u_owner', T0 + 2 * HOUR);
  assert.equal(done.ok, true);
  assert.equal(done.rollout.stage, 'complete');
});

test('health gate: each condition reported separately', () => {
  const rollout = makeRollout();
  const gateOk = evaluateTeamV14HealthGate(rollout, healthyMetrics());
  assert.equal(gateOk.pass, true);
  assert.equal(gateOk.checks.length, 5);
  const smallSample = evaluateTeamV14HealthGate(rollout, { ...healthyMetrics(), sampleUsers: 2 });
  assert.equal(smallSample.pass, false);
  assert.equal(smallSample.checks.find((c) => c.name === 'sample-size').pass, false);
  const alerts = evaluateTeamV14HealthGate(rollout, { ...healthyMetrics(), criticalAlerts: 2 });
  assert.equal(alerts.checks.find((c) => c.name === 'critical-alerts').pass, false);
});

test('pause/resume round-trip, manual rollback records previous version', () => {
  let rollout = { ...makeRollout(), stage: 'pilot', stageEnteredAt: T0, metrics: healthyMetrics() };
  const paused = pauseTeamV14Rollout(rollout, 'u_owner', 'incident', T0 + 1);
  assert.equal(paused.ok, true);
  assert.equal(paused.rollout.stage, 'paused');
  assert.equal(paused.rollout.stageBeforePause, 'pilot');
  rollout = paused.rollout;
  const resumed = resumeTeamV14Rollout(rollout, 'u_owner', T0 + 2);
  assert.equal(resumed.ok, true);
  assert.equal(resumed.rollout.stage, 'pilot');
  assert.equal(resumed.rollout.stageBeforePause, '');
  const rolled = rollbackTeamV14Rollout(resumed.rollout, 'u_owner', 'bad release', T0 + 3);
  assert.equal(rolled.ok, true);
  assert.equal(rolled.rollout.stage, 'rolled-back');
  assert.match(rolled.rollout.history.at(-1).reason, /v15/);
  // Terminal: cannot pause or roll back again.
  assert.equal(pauseTeamV14Rollout(rolled.rollout, 'u_owner', 'x', T0 + 4).ok, false);
  assert.equal(rollbackTeamV14Rollout(rolled.rollout, 'u_owner', 'x', T0 + 4).ok, false);
  // Draft cannot roll back.
  assert.equal(rollbackTeamV14Rollout(makeRollout(), 'u_owner', 'x', T0).ok, false);
});

test('auto decision + apply: rollback on high errors, pause on medium, disabled does nothing', () => {
  const rollout = { ...makeRollout(), stage: 'pilot', metrics: healthyMetrics() };
  const dNone = decideTeamV14AutoAction(rollout, healthyMetrics());
  assert.equal(dNone.action, 'none');
  const dPause = decideTeamV14AutoAction(rollout, { ...healthyMetrics(), errorRate: 0.15 });
  assert.equal(dPause.action, 'pause');
  const dRollback = decideTeamV14AutoAction(rollout, { ...healthyMetrics(), errorRate: 0.25 });
  assert.equal(dRollback.action, 'rollback');
  const dCrash = decideTeamV14AutoAction(rollout, { ...healthyMetrics(), crashes: 9 });
  assert.equal(dCrash.action, 'rollback');
  const dUsers = decideTeamV14AutoAction(rollout, { ...healthyMetrics(), reportingUsers: 25 });
  assert.equal(dUsers.action, 'rollback');
  // Apply rollback for real.
  const applied = applyTeamV14AutoRollback(rollout, { ...healthyMetrics(), errorRate: 0.25 }, 'system:auto-rollback', T0);
  assert.equal(applied.appliedAction, 'rollback');
  assert.equal(applied.rollout.stage, 'rolled-back');
  // Apply pause for real.
  const appliedPause = applyTeamV14AutoRollback(rollout, { ...healthyMetrics(), errorRate: 0.15 }, 'system:auto-rollback', T0);
  assert.equal(appliedPause.appliedAction, 'pause');
  assert.equal(appliedPause.rollout.stage, 'paused');
  // Disabled auto-rollback: decision still computed, nothing applied.
  const disabled = { ...rollout, autoRollbackEnabled: false };
  const notApplied = applyTeamV14AutoRollback(disabled, { ...healthyMetrics(), errorRate: 0.25 }, 'system:auto-rollback', T0);
  assert.equal(notApplied.appliedAction, 'none');
  assert.equal(notApplied.decision.action, 'rollback');
  assert.equal(notApplied.rollout.stage, 'pilot');
});

test('summary + persistence round-trip', () => {
  const root = tmpRoot();
  const rollout = { ...makeRollout(), stage: 'canary', metrics: healthyMetrics() };
  const summary = summarizeTeamV14Rollout(rollout);
  assert.equal(summary.stage, 'canary');
  assert.equal(summary.percent, 1);
  assert.equal(summary.gate.pass, true);
  assert.equal(summary.autoDecision.action, 'none');
  let store = createTeamV14RolloutStore(T0);
  store = upsertTeamV14Rollout(store, rollout, T0);
  saveTeamV14Rollouts(root, store);
  const loaded = loadTeamV14Rollouts(root);
  assert.ok(loaded);
  assert.equal(loaded.rollouts.length, 1);
  assert.equal(loaded.rollouts[0].feature, 'voice-v16');
  fs.writeFileSync(path.join(root, 'rollouts-v117.json'), 'bad json');
  assert.equal(loadTeamV14Rollouts(root), null);
});
