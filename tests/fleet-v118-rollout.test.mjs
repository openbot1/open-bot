/**
 * Rollout v4 tests (v1.18, Đội T6 — node:test, no network).
 *
 * Covers:
 * - Node targeting: all-nodes / label-selector / node-ids, validation,
 *   removed nodes excluded, targeted node list.
 * - Node + user cohort: node must match target AND user must be in the
 *   v3 cohort (both filters apply).
 * - Approve step: distinct approvers, duplicate rejected, approvals
 *   counted per next stage only, early vs late approval counts,
 *   advance blocked until approvals met, approvals reset after advance,
 *   rollback needs no approval, rejected approvals recorded in events.
 * - Node status: apply per-node stage/version, version counts.
 * - History: merged timeline (stage + approval + node), newest first.
 * - Auto-rollback: error metric rolls back and resets node versions.
 * - Persistence: save/load round-trip, corrupt file → null.
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/fleet-v118-rollout.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  applyTeamV15AutoRollback,
  applyTeamV15NodeStage,
  approveTeamV15Rollout,
  createTeamV15Rollout,
  createTeamV15RolloutStore,
  defaultTeamV15NodeTarget,
  loadTeamV15Rollouts,
  rollbackTeamV15Rollout,
  saveTeamV15Rollouts,
  setTeamV15NodeTarget,
  advanceTeamV15Rollout,
  summarizeTeamV15Rollout,
  teamV15ApprovalCount,
  teamV15ApprovalsMet,
  teamV15NodeMatchesTarget,
  teamV15NodeReceivesFeature,
  teamV15NodeVersionCounts,
  teamV15RequiredApprovals,
  teamV15RolloutHistory,
  teamV15TargetedNodes,
  upsertTeamV15Rollout,
  validateTeamV15NodeTarget,
} from '../packages/core/dist/fleetV15/index.js';
import {
  createFleetV14Snapshot,
  registerFleetV14Node,
  updateTeamV14RolloutMetrics,
} from '../packages/core/dist/fleetV14/index.js';

const T0 = Date.UTC(2026, 10, 16, 0, 0, 0);
const HOUR = 60 * 60 * 1000;

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-rollout-v15-'));
}

function cap() {
  return { cpuCores: 8, ramTotalMb: 32768, vramTotalMb: 0, diskTotalMb: 500_000, maxTasks: 4 };
}

function twoNodes() {
  let snap = createFleetV14Snapshot(T0);
  snap = registerFleetV14Node(snap, { nodeId: 'node-a', hostname: 'a.local', fingerprint: 'fp-a', labels: { region: 'home', gpu: 'true' }, capacity: cap() }, 'admin', T0).snapshot;
  snap = registerFleetV14Node(snap, { nodeId: 'node-b', hostname: 'b.local', fingerprint: 'fp-b', labels: { region: 'office' }, capacity: cap() }, 'admin', T0).snapshot;
  return snap;
}

function makeRollout(now = T0) {
  return createTeamV15Rollout(
    {
      id: 'roll-1',
      feature: 'voice-v17',
      version: 'v17',
      previousVersion: 'v16',
      plan: [
        { stage: 'canary', percent: 1, minDwellMs: 0 },
        { stage: 'pilot', percent: 5, minDwellMs: 0 },
        { stage: 'early', percent: 25, minDwellMs: 0 },
        { stage: 'general', percent: 50, minDwellMs: 0 },
        { stage: 'all', percent: 100, minDwellMs: 0 },
      ],
    },
    'u_admin',
    now,
  );
}

test('rollout v4: node target validation + matching', () => {
  assert.equal(validateTeamV15NodeTarget(defaultTeamV15NodeTarget()), '');
  assert.match(validateTeamV15NodeTarget({ kind: 'label-selector', labels: {}, nodeIds: [] }), /at least one label/);
  assert.match(validateTeamV15NodeTarget({ kind: 'node-ids', labels: {}, nodeIds: [] }), /at least one node id/);
  assert.match(validateTeamV15NodeTarget({ kind: 'node-ids', labels: {}, nodeIds: ['a', 'a'] }), /duplicates/);
  assert.match(validateTeamV15NodeTarget({ kind: 'everywhere', labels: {}, nodeIds: [] }), /unknown node target/);

  const snap = twoNodes();
  const [a, b] = snap.nodes;
  assert.equal(teamV15NodeMatchesTarget(defaultTeamV15NodeTarget(), a), true);
  const byLabel = { kind: 'label-selector', labels: { region: 'home' }, nodeIds: [] };
  assert.equal(teamV15NodeMatchesTarget(byLabel, a), true);
  assert.equal(teamV15NodeMatchesTarget(byLabel, b), false);
  const byIds = { kind: 'node-ids', labels: {}, nodeIds: ['node-b'] };
  assert.equal(teamV15NodeMatchesTarget(byIds, a), false);
  assert.equal(teamV15NodeMatchesTarget(byIds, b), true);
  assert.equal(teamV15TargetedNodes({ nodeTarget: byLabel, v14: { stage: 'canary' } }, snap.nodes).length, 1);
  // Removed nodes never match.
  assert.equal(teamV15NodeMatchesTarget(defaultTeamV15NodeTarget(), { ...a, status: 'removed' }), false);
});

test('rollout v4: node + user cohort both filter', () => {
  // Draft rollout: nobody receives anything.
  const rollout = makeRollout();
  const snap = twoNodes();
  const [a] = snap.nodes;
  assert.equal(teamV15NodeReceivesFeature(rollout, a, 'u1', 'member'), false);
  // Move to canary (bypass v3 advance: create then approve+advance with dwell 0).
  let r = rollout;
  // Draft -> canary needs approve (earlyApprovals=1) + advance.
  r = approveTeamV15Rollout(r, 'admin1', 'admin', '', T0).rollout;
  const adv = advanceTeamV15Rollout(r, 'admin1', T0);
  assert.equal(adv.ok, true, adv.reason);
  r = adv.rollout;
  assert.equal(r.v14.stage, 'canary');
  // Node outside target receives nothing even if user is in cohort.
  const byLabel = setTeamV15NodeTarget(makeRollout(), { kind: 'label-selector', labels: { region: 'home' }, nodeIds: [] }, T0);
  assert.equal(byLabel.ok, true);
  // Target change only allowed in draft — the advanced rollout rejects it.
  assert.equal(setTeamV15NodeTarget(r, { kind: 'label-selector', labels: { region: 'home' }, nodeIds: [] }, T0).ok, false);
  // With label target on a fresh draft that then advances: node-b excluded.
  let r2 = byLabel.rollout;
  r2 = approveTeamV15Rollout(r2, 'admin1', 'admin', '', T0).rollout;
  r2 = advanceTeamV15Rollout(r2, 'admin1', T0).rollout;
  const [, nodeB] = twoNodes().nodes;
  assert.equal(teamV15NodeReceivesFeature(r2, nodeB, 'u1', 'member'), false);
});

test('rollout v4: approve step (distinct approvers, per-stage, reset on advance)', () => {
  let r = makeRollout();
  // Draft chưa có approve nào nên advance bị chặn; approve được cấp ngay ở draft.
  assert.equal(teamV15ApprovalsMet(r), false);
  assert.match(advanceTeamV15Rollout(r, 'admin1', T0).reason, /waiting for approvals/);
  // Draft -> canary: needs 1 approval (early).
  assert.equal(teamV15RequiredApprovals(r), 1);
  r = approveTeamV15Rollout(r, 'admin1', 'admin', 'looks good', T0).rollout;
  assert.equal(teamV15ApprovalCount(r), 1);
  assert.equal(teamV15ApprovalsMet(r), true);
  // Duplicate approver rejected (same person twice counts once).
  const dup = approveTeamV15Rollout(r, 'admin1', 'admin', '', T0);
  assert.equal(dup.ok, false);
  assert.match(dup.reason, /already approved/);
  assert.equal(teamV15ApprovalCount(dup.rollout), 1);
  // Advance: approvals reset; next stage (pilot) needs 1 approval again.
  const adv = advanceTeamV15Rollout(r, 'admin1', T0);
  assert.equal(adv.ok, true, adv.reason);
  r = adv.rollout;
  assert.equal(r.v14.stage, 'canary');
  assert.equal(r.approvals.length, 0, 'approvals reset after advance');
  assert.equal(teamV15RequiredApprovals(r), 1, 'pilot still early');
  // V3 health gate needs real metrics before further advances: healthy cohort.
  r = { ...r, v14: updateTeamV14RolloutMetrics(r.v14, { sampleUsers: 50, errorRate: 0.01, errorCount: 1, reportingUsers: 0, criticalAlerts: 0, crashes: 0 }, T0) };
  // Pilot -> early needs 2 approvals (late).
  r = approveTeamV15Rollout(r, 'admin1', 'admin', '', T0).rollout;
  r = advanceTeamV15Rollout(r, 'admin1', T0).rollout;
  assert.equal(r.v14.stage, 'pilot');
  assert.equal(teamV15RequiredApprovals(r), 2, 'early stage needs late approvals');
  r = approveTeamV15Rollout(r, 'admin1', 'admin', '', T0).rollout;
  assert.equal(teamV15ApprovalsMet(r), false, '1/2 approvals not enough');
  assert.match(advanceTeamV15Rollout(r, 'admin1', T0).reason, /waiting for approvals: 1\/2/);
  r = approveTeamV15Rollout(r, 'admin2', 'admin', '', T0).rollout;
  assert.equal(teamV15ApprovalsMet(r), true);
  const adv2 = advanceTeamV15Rollout(r, 'admin1', T0);
  assert.equal(adv2.ok, true, adv2.reason);
  assert.equal(adv2.rollout.v14.stage, 'early');
});

test('rollout v4: rollback needs no approval + resets node versions', () => {
  let r = makeRollout();
  r = approveTeamV15Rollout(r, 'admin1', 'admin', '', T0).rollout;
  r = advanceTeamV15Rollout(r, 'admin1', T0).rollout;
  r = applyTeamV15NodeStage(r, 'node-a', 'v17', 'canary', 'admin1', T0);
  r = applyTeamV15NodeStage(r, 'node-b', 'v17', 'canary', 'admin1', T0);
  assert.deepEqual(teamV15NodeVersionCounts(r), { v17: 2 });
  const rb = rollbackTeamV15Rollout(r, 'admin1', 'bad release', T0);
  assert.equal(rb.ok, true, rb.reason);
  assert.equal(rb.rollout.v14.stage, 'rolled-back');
  assert.deepEqual(teamV15NodeVersionCounts(rb.rollout), { v16: 2 });
  assert.equal(rollbackTeamV15Rollout(rb.rollout, 'admin1', 'again', T0).ok, false);
});

test('rollout v4: merged history timeline', () => {
  let r = makeRollout();
  r = approveTeamV15Rollout(r, 'admin1', 'admin', 'ok', T0).rollout;
  r = approveTeamV15Rollout(r, 'admin1', 'admin', 'dup', T0).rollout; // rejected, still recorded
  r = advanceTeamV15Rollout(r, 'admin1', T0).rollout;
  r = applyTeamV15NodeStage(r, 'node-a', 'v17', 'canary', 'admin1', T0 + 1000);
  const history = teamV15RolloutHistory(r);
  const kinds = history.map((h) => h.kind);
  assert.ok(kinds.includes('stage'));
  assert.ok(kinds.includes('approval'));
  assert.ok(kinds.includes('node'));
  assert.ok(history.some((h) => h.summary.includes('approval rejected')), 'rejected approval is in the timeline');
  assert.ok(history[0].at >= history[history.length - 1].at, 'newest first');
  assert.equal(teamV15RolloutHistory(r, 1).length, 1, 'limit respected');
});

test('rollout v4: auto-rollback from error metrics', () => {
  let r = makeRollout();
  r = approveTeamV15Rollout(r, 'admin1', 'admin', '', T0).rollout;
  r = advanceTeamV15Rollout(r, 'admin1', T0).rollout;
  r = applyTeamV15NodeStage(r, 'node-a', 'v17', 'canary', 'admin1', T0);
  const bad = { sampleUsers: 50, errorRate: 0.5, errorCount: 25, reportingUsers: 30, criticalAlerts: 0, crashes: 0 };
  const res = applyTeamV15AutoRollback(r, bad, 'system:auto-rollback', T0);
  assert.equal(res.appliedAction, 'rollback');
  assert.equal(res.rollout.v14.stage, 'rolled-back');
  assert.deepEqual(teamV15NodeVersionCounts(res.rollout), { v16: 1 });
  // Healthy metrics: no action.
  let r2 = makeRollout();
  r2 = approveTeamV15Rollout(r2, 'admin1', 'admin', '', T0).rollout;
  r2 = advanceTeamV15Rollout(r2, 'admin1', T0).rollout;
  const good = { sampleUsers: 50, errorRate: 0.01, errorCount: 1, reportingUsers: 0, criticalAlerts: 0, crashes: 0 };
  assert.equal(applyTeamV15AutoRollback(r2, good, 'system:auto-rollback', T0).appliedAction, 'none');
});

test('rollout v4: summary + persistence', () => {
  let r = makeRollout();
  const s0 = summarizeTeamV15Rollout(r, twoNodes().nodes);
  assert.equal(s0.stage, 'draft');
  assert.equal(s0.targetedNodeCount, 2);
  assert.equal(s0.approvalsNeed, 1);
  assert.equal(s0.nodesOnNewVersion, 0);
  r = approveTeamV15Rollout(r, 'admin1', 'admin', '', T0).rollout;
  r = advanceTeamV15Rollout(r, 'admin1', T0).rollout;
  r = applyTeamV15NodeStage(r, 'node-a', 'v17', 'canary', 'admin1', T0);
  const s1 = summarizeTeamV15Rollout(r, twoNodes().nodes);
  assert.equal(s1.nodesOnNewVersion, 1);
  assert.equal(s1.historyCount, r.v14.history.length + r.approvalEvents.length + r.nodeEvents.length);

  const root = tmpRoot();
  const store = upsertTeamV15Rollout(createTeamV15RolloutStore(T0), r, T0);
  saveTeamV15Rollouts(root, store);
  const loaded = loadTeamV15Rollouts(root);
  assert.ok(loaded);
  assert.equal(loaded.rollouts.length, 1);
  assert.equal(loaded.rollouts[0].v14.id, 'roll-1');
  fs.writeFileSync(path.join(root, 'rollouts-v118.json'), 'nope{');
  assert.equal(loadTeamV15Rollouts(root), null);
});
