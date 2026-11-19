/**
 * Tests for fleet v30 snapshot + per-profile quotas (v1.44, Team T6).
 *
 * Covers:
 * - Snapshot: build from populated stores (groups, views, custom
 *   kanban, rules, admins, pending + approved approvals, binding
 *   descriptors); JSON round-trip; fromJson refuses invalid JSON,
 *   wrong version, and missing arrays; restore into fresh stores
 *   (admins/rules/groups/views/kanban/approvals restored, unregistered
 *   group members skipped + reported, approved approvals re-approved,
 *   binding descriptors counted but NOT applied as live bindings).
 * - Quotas: set/get/list/remove, validation (bad caps refused),
 *   admission with no quota (admitted), binding cap (second bind
 *   refused), resource caps (limits that would exceed refused),
 *   live usage sums (recordUsage feeds usageFor), over-quota
 *   detection when usage grows past the cap, profilesOverQuota.
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/fleet-v30-snapshot-quotas-v144.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { FleetV28RuntimeStore } from '../packages/core/dist/fleetV28/runtime.js';
import { FleetV29Allowlist } from '../packages/core/dist/fleetV29/allowlist.js';
import { FleetV29PeerRegistry } from '../packages/core/dist/fleetV29/peerRegistry.js';
import { FleetV29TaskBoard } from '../packages/core/dist/fleetV29/taskBoard.js';
import { buildAgentCard } from '../packages/core/dist/a2a/card.js';
import { FleetV30AdminPolicy } from '../packages/core/dist/fleetV30/adminPolicy.js';
import { FleetV30BoardV2 } from '../packages/core/dist/fleetV30/boardV2.js';
import { FleetV30IsolationManager } from '../packages/core/dist/fleetV30/isolation.js';
import { FleetV30PeerGroups } from '../packages/core/dist/fleetV30/peerGroups.js';
import { FleetV30ProfileQuotas } from '../packages/core/dist/fleetV30/quotas.js';
import {
  FLEET_V30_SNAPSHOT_VERSION,
  buildFleetV30Snapshot,
  fleetV30SnapshotFromJson,
  fleetV30SnapshotToJson,
  restoreFleetV30Snapshot,
  validateFleetV30Snapshot,
} from '../packages/core/dist/fleetV30/snapshot.js';
import { fleetV30DriverAvailability } from '../packages/core/dist/fleetV30/drivers.js';

const NOW = '2026-11-19T05:00:00.000Z';
const AVAIL = [
  fleetV30DriverAvailability('bwrap', { available: true }),
  fleetV30DriverAvailability('docker', { available: false, reason: 'no docker' }),
  fleetV30DriverAvailability('local', { available: true }),
];

function makeState() {
  const runtimeStore = new FleetV28RuntimeStore({ maxConcurrentRuntimes: 8 });
  const isolation = new FleetV30IsolationManager({
    runtimeStore,
    workspaceBaseDir: '/tmp/open-bot-v144-t6-test',
    driverAvailability: AVAIL,
    nowIso: () => NOW,
  });
  const registry = new FleetV29PeerRegistry();
  const allowlist = new FleetV29Allowlist();
  const board = new FleetV29TaskBoard({ registry, allowlist, nowIso: () => NOW });
  const boardV2 = new FleetV30BoardV2({ board, registry, allowlist, nowIso: () => NOW });
  const groups = new FleetV30PeerGroups({ registry, board });
  const admin = new FleetV30AdminPolicy({
    allowlist, registry, isolation,
    availableDrivers: ['bwrap', 'local'],
    nowIso: () => NOW,
  });
  const quotas = new FleetV30ProfileQuotas({ isolation, nowIso: () => NOW });
  return { runtimeStore, isolation, registry, allowlist, board, boardV2, groups, admin, quotas };
}

function registerPeer(state, peerId) {
  const card = buildAgentCard({
    name: `Agent ${peerId}`,
    description: 'Test peer.',
    url: 'http://127.0.0.1:4199/',
    version: '1.0.0',
    protocolVersion: '1.0.1',
    streaming: true,
  });
  state.registry.registerPeer({ peerId, card });
  state.registry.recordVerification(peerId, 'verified', 'signature', [], NOW);
  state.allowlist.add(peerId, 'admin');
}

/* ---------------- quotas ---------------- */

test('quotas: set/get/list/remove + validation', () => {
  const s = makeState();
  assert.equal(s.quotas.setQuota('', 'root', {}).ok, false);
  assert.equal(s.quotas.setQuota('profile-a', 'root', { maxBindings: 0 }).ok, false);
  assert.equal(s.quotas.setQuota('profile-a', 'root', { maxCpuCores: -1 }).ok, false);
  assert.equal(s.quotas.setQuota('profile-a', 'root', { maxRamMB: 0 }).ok, false);
  const set = s.quotas.setQuota('profile-a', 'root', { maxBindings: 2, maxCpuCores: 2, maxRamMB: 2048 });
  assert.equal(set.ok, true);
  if (set.ok) {
    assert.equal(set.quota.profileId, 'profile-a');
    assert.equal(set.quota.maxBindings, 2);
    assert.equal(set.quota.maxDiskMB, null);
  }
  assert.equal(s.quotas.getQuota('profile-a')?.maxCpuCores, 2);
  assert.equal(s.quotas.getQuota('profile-missing'), null);
  assert.equal(s.quotas.listQuotas().length, 1);
  assert.equal(s.quotas.removeQuota('profile-a'), true);
  assert.equal(s.quotas.removeQuota('profile-a'), false);
  assert.equal(s.quotas.listQuotas().length, 0);
});

test('quotas: admission — no quota admits, binding + resource caps refuse', () => {
  const s = makeState();
  const limits = { cpuCores: 1, ramMB: 2048, diskMB: 5120, timeoutMs: 1800000, idleTimeoutMs: 900000, maxRestarts: 3 };
  assert.deepEqual(s.quotas.checkAdmission('profile-a', limits), { admitted: true, reasons: [] });
  assert.equal(s.quotas.setQuota('profile-a', 'root', { maxBindings: 1 }).ok, true);
  assert.equal(s.isolation.bind('conv-1', 'profile-a').ok, true);
  const second = s.quotas.checkAdmission('profile-a', limits);
  assert.equal(second.admitted, false);
  assert.ok(second.reasons.some((r) => r.includes('binding quota')));
  // Resource caps: a bind whose limits alone exceed the cap is refused.
  assert.equal(s.quotas.setQuota('profile-b', 'root', { maxRamMB: 1024 }).ok, true);
  const over = s.quotas.checkAdmission('profile-b', limits);
  assert.equal(over.admitted, false);
  assert.ok(over.reasons.some((r) => r.includes('RAM quota')));
  const fits = s.quotas.checkAdmission('profile-b', { ...limits, ramMB: 512 });
  assert.equal(fits.admitted, true);
});

test('quotas: live usage sums + over-quota detection', () => {
  const s = makeState();
  assert.equal(s.isolation.bind('conv-1', 'profile-a').ok, true);
  assert.equal(s.isolation.bind('conv-2', 'profile-a').ok, true);
  s.runtimeStore.recordUsage('conv-1', { cpuCores: 0.5, ramMB: 512, diskMB: 100 });
  s.runtimeStore.recordUsage('conv-2', { cpuCores: 1.5, ramMB: 1024, diskMB: 200 });
  const usage = s.quotas.usageFor('profile-a');
  assert.equal(usage.bindings, 2);
  assert.equal(usage.cpuCores, 2);
  assert.equal(usage.ramMB, 1536);
  assert.equal(usage.diskMB, 300);
  assert.deepEqual(usage.overQuota, []);
  assert.equal(usage.quota, null);
  // Tighten the quota below live usage: over-quota flags appear and
  // new binds are refused until usage drops.
  assert.equal(s.quotas.setQuota('profile-a', 'root', { maxRamMB: 1024 }).ok, true);
  const over = s.quotas.usageFor('profile-a');
  assert.deepEqual(over.overQuota, ['ram']);
  assert.equal(s.quotas.profilesOverQuota().length, 1);
  const limits = { cpuCores: 1, ramMB: 100, diskMB: 100, timeoutMs: 1800000, idleTimeoutMs: 900000, maxRestarts: 3 };
  assert.equal(s.quotas.checkAdmission('profile-a', limits).admitted, false);
  // Usage drops (runtime stopped): the profile is back under quota.
  s.isolation.endConversation('conv-2');
  assert.deepEqual(s.quotas.usageFor('profile-a').overQuota, []);
  assert.equal(s.quotas.checkAdmission('profile-a', limits).admitted, true);
});

/* ---------------- snapshot ---------------- */

test('snapshot: build, JSON round-trip, validation refusals', () => {
  const s = makeState();
  registerPeer(s, 'peer-1');
  s.admin.bootstrapAdmin('root');
  s.admin.grantRole('root', 'op1', 'operator');
  s.admin.createRule('root', { name: 'Cheap', maxCostUsdPerTask: 1 });
  const group = s.groups.createGroup('Coding', 'root');
  assert.equal(group.ok, true);
  if (group.ok) s.groups.addPeer(group.group.groupId, 'peer-1');
  s.boardV2.createView({ name: 'Urgent', createdBy: 'root', priority: 'urgent' });
  assert.equal(s.isolation.bind('conv-1', 'profile-a').ok, true);
  const snapshot = buildFleetV30Snapshot({ isolation: s.isolation, boardV2: s.boardV2, groups: s.groups, admin: s.admin, nowIso: () => NOW });
  assert.equal(snapshot.version, FLEET_V30_SNAPSHOT_VERSION);
  assert.equal(snapshot.savedAt, NOW);
  assert.equal(snapshot.groups.length, 1);
  assert.equal(snapshot.groups[0].peerIds.length, 1);
  assert.equal(snapshot.views.length, 1);
  assert.equal(snapshot.rules.length, 1);
  assert.equal(snapshot.admins.length, 2);
  assert.equal(snapshot.bindingDescriptors.length, 1);
  assert.equal(snapshot.bindingDescriptors[0].conversationId, 'conv-1');
  assert.equal(snapshot.kanban.length, 3);

  const json = fleetV30SnapshotToJson(snapshot);
  const parsed = fleetV30SnapshotFromJson(json);
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.equal(parsed.snapshot.groups[0].name, 'Coding');
  assert.deepEqual(validateFleetV30Snapshot(snapshot), []);
  assert.equal(fleetV30SnapshotFromJson('not json').ok, false);
  assert.equal(fleetV30SnapshotFromJson(JSON.stringify({ ...snapshot, version: 99 })).ok, false);
  assert.equal(fleetV30SnapshotFromJson(JSON.stringify({ ...snapshot, groups: 'nope' })).ok, false);
  assert.equal(fleetV30SnapshotFromJson(JSON.stringify({ ...snapshot, admins: [{ userId: 'x', role: 'bogus' }] })).ok, false);
});

test('snapshot: restore into fresh stores is fail-soft per item', () => {
  const s = makeState();
  registerPeer(s, 'peer-1');
  s.admin.bootstrapAdmin('root');
  s.admin.grantRole('root', 'op1', 'operator');
  s.admin.createRule('root', { name: 'Cheap', maxCostUsdPerTask: 1 });
  const group = s.groups.createGroup('Coding', 'root');
  assert.equal(group.ok, true);
  if (group.ok) {
    s.groups.addPeer(group.group.groupId, 'peer-1');
    // A member that will NOT exist in the restore state.
    s.registry.registerPeer({
      peerId: 'peer-ghost',
      card: buildAgentCard({ name: 'Ghost', description: 'Gone.', url: 'http://127.0.0.1:4198/', version: '1.0.0', protocolVersion: '1.0.1' }),
    });
    s.groups.addPeer(group.group.groupId, 'peer-ghost');
  }
  s.boardV2.createView({ name: 'Urgent', createdBy: 'root', priority: 'urgent' });
  s.boardV2.setKanban([
    { columnId: 'todo', title: 'To do', states: ['submitted', 'rejected'] },
    { columnId: 'doing', title: 'Doing', states: ['working', 'input-required', 'auth-required'] },
    { columnId: 'over', title: 'Over', states: ['completed', 'failed', 'cancelled'] },
  ]);
  const pending = s.admin.requestApproval('op1', 'peer-1', 'sensitive', 'Pending work.');
  assert.equal(pending.ok, true);
  const approved = s.admin.requestApproval('op1', 'peer-1', 'code', 'Approved work.');
  assert.equal(approved.ok, true);
  if (approved.ok) s.admin.decideApproval('root', approved.request.requestId, true, 'Yes.');
  assert.equal(s.isolation.bind('conv-1', 'profile-a').ok, true);
  const snapshot = buildFleetV30Snapshot({ isolation: s.isolation, boardV2: s.boardV2, groups: s.groups, admin: s.admin, nowIso: () => NOW });
  assert.equal(snapshot.approvals.length, 2); // pending + approved (denied/expired dropped)

  // Fresh stores: only peer-1 is registered (peer-ghost is gone).
  const fresh = makeState();
  registerPeer(fresh, 'peer-1');
  const report = restoreFleetV30Snapshot(snapshot, {
    isolation: fresh.isolation,
    boardV2: fresh.boardV2,
    groups: fresh.groups,
    admin: fresh.admin,
    restoredBy: 'root',
  });
  assert.deepEqual(report.restoredAdmins.sort(), ['op1', 'root']);
  assert.equal(fresh.admin.roleOf('op1'), 'operator');
  assert.equal(report.restoredRules.length, 1);
  assert.equal(fresh.admin.listRules().length, 1);
  assert.equal(report.restoredGroups.length, 1);
  assert.deepEqual(report.skippedGroupMembers, [{ groupId: report.restoredGroups[0], peerId: 'peer-ghost' }]);
  assert.deepEqual(fresh.groups.peersInGroup(report.restoredGroups[0]).map((p) => p.peerId), ['peer-1']);
  assert.equal(report.restoredViews.length, 1);
  assert.equal(fresh.boardV2.listViews().length, 1);
  assert.equal(report.kanbanRestored, true);
  assert.deepEqual(fresh.boardV2.getKanban().map((c) => c.columnId), ['todo', 'doing', 'over']);
  assert.equal(report.restoredApprovals.length, 2);
  assert.equal(fresh.admin.listApprovals('approved').length, 1);
  assert.equal(fresh.admin.listApprovals('pending').length, 1);
  // Binding descriptors are counted, never applied as live bindings.
  assert.equal(report.bindingDescriptors, 1);
  assert.equal(fresh.isolation.bindingCount(), 0);
  assert.equal(report.reasons.length, 0);
});
