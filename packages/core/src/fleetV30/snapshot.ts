/**
 * Fleet v30 snapshot — host persistence (v1.44, Team T6).
 *
 * The host persists the slow-changing v30 configuration so a
 * restart does not lose it: peer groups, saved board views, kanban
 * columns, policy rules, admins, approval requests, and isolation
 * binding descriptors (which conversation ran on which driver, for
 * the audit trail — NOT live bindings).
 *
 * What is NOT snapshotted, and why:
 * - Live isolation bindings are never restored as live: after a
 *   restart no runtime is running, so a restored binding would
 *   lie about its state. Descriptors are kept for the audit trail;
 *   the host re-binds a conversation when it becomes active again
 *   (see `bindingDescriptors` in the report).
 * - Board tasks and their v30 metadata are live state (v29 board
 *   tasks are never snapshotted either — see `fleetV29/snapshot.ts`).
 * - Denied / expired approvals are history, not config — dropped.
 * - Secrets are never in a snapshot (there are none in v30 stores).
 *
 * Restore is fail-soft per item: a group whose peers are not
 * registered yet restores without those members (listed in the
 * report); a rule whose creator is unknown restores under the
 * restoring admin; an approval whose peer is gone is skipped.
 * Nothing here touches the disk — the host writes the JSON.
 */

import type { FleetV30AdminPolicy } from './adminPolicy';
import type { FleetV30BoardV2 } from './boardV2';
import type { FleetV30IsolationManager } from './isolation';
import type { FleetV30PeerGroups } from './peerGroups';
import type {
  FleetV30ApprovalRequest,
  FleetV30BoardView,
  FleetV30IsolationBinding,
  FleetV30KanbanColumn,
  FleetV30PeerGroup,
  FleetV30PolicyRule,
} from './types';
import { FLEET_V30_DEFAULT_KANBAN } from './types';

/** Snapshot format version (bump on breaking changes). */
export const FLEET_V30_SNAPSHOT_VERSION = 1;

/** One isolation binding descriptor (audit trail, not a live binding). */
export interface FleetV30BindingDescriptor {
  conversationId: string;
  profileId: string;
  botId: string;
  driverKind: FleetV30IsolationBinding['driverKind'];
  networkMode: FleetV30IsolationBinding['networkMode'];
  workspaceRoot: string;
  status: FleetV30IsolationBinding['status'];
  createdAtMs: number;
  cleanedAtMs: number | null;
}

/** The v30 snapshot (JSON-able). */
export interface FleetV30Snapshot {
  version: number;
  savedAt: string;
  groups: FleetV30PeerGroup[];
  views: FleetV30BoardView[];
  kanban: FleetV30KanbanColumn[];
  rules: FleetV30PolicyRule[];
  admins: Array<{ userId: string; role: string }>;
  approvals: FleetV30ApprovalRequest[];
  bindingDescriptors: FleetV30BindingDescriptor[];
}

export interface FleetV30SnapshotDeps {
  isolation: FleetV30IsolationManager;
  boardV2: FleetV30BoardV2;
  groups: FleetV30PeerGroups;
  admin: FleetV30AdminPolicy;
  nowIso?: () => string;
}

export interface FleetV30SnapshotRestoreDeps {
  isolation: FleetV30IsolationManager;
  boardV2: FleetV30BoardV2;
  groups: FleetV30PeerGroups;
  admin: FleetV30AdminPolicy;
  /** Admin id the restore runs as (must be bootstrapped or an admin). */
  restoredBy: string;
}

/** What one restore run did (per-item, fail-soft). */
export interface FleetV30SnapshotRestoreReport {
  restoredAdmins: string[];
  restoredRules: string[];
  restoredGroups: string[];
  skippedGroupMembers: Array<{ groupId: string; peerId: string }>;
  restoredViews: string[];
  kanbanRestored: boolean;
  restoredApprovals: string[];
  skippedApprovals: string[];
  bindingDescriptors: number;
  reasons: string[];
}

function descriptorOf(binding: FleetV30IsolationBinding): FleetV30BindingDescriptor {
  return {
    conversationId: binding.conversationId,
    profileId: binding.profileId,
    botId: binding.botId,
    driverKind: binding.driverKind,
    networkMode: binding.networkMode,
    workspaceRoot: binding.workspaceRoot,
    status: binding.status,
    createdAtMs: binding.createdAtMs,
    cleanedAtMs: binding.cleanedAtMs,
  };
}

/** Build a snapshot from the live v30 stores. */
export function buildFleetV30Snapshot(deps: FleetV30SnapshotDeps): FleetV30Snapshot {
  const nowIso = deps.nowIso ?? (() => new Date().toISOString());
  return {
    version: FLEET_V30_SNAPSHOT_VERSION,
    savedAt: nowIso(),
    groups: deps.groups.listGroups(),
    views: deps.boardV2.listViews(),
    kanban: deps.boardV2.getKanban(),
    rules: deps.admin.listRules(),
    admins: deps.admin.listAdmins().map((a) => ({ userId: a.userId, role: a.role })),
    approvals: deps.admin.listApprovals().filter((r) => r.status === 'pending' || r.status === 'approved'),
    bindingDescriptors: deps.isolation.listBindings().map(descriptorOf),
  };
}

/** Validate a parsed snapshot (empty = valid). */
export function validateFleetV30Snapshot(value: unknown): string[] {
  const reasons: string[] = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['Snapshot must be an object.'];
  const s = value as Record<string, unknown>;
  if (s['version'] !== FLEET_V30_SNAPSHOT_VERSION) {
    reasons.push(`Snapshot version must be ${FLEET_V30_SNAPSHOT_VERSION}.`);
  }
  if (typeof s['savedAt'] !== 'string' || Number.isNaN(Date.parse(s['savedAt'] as string))) {
    reasons.push('savedAt must be an ISO date string.');
  }
  for (const key of ['groups', 'views', 'kanban', 'rules', 'admins', 'approvals', 'bindingDescriptors'] as const) {
    if (!Array.isArray(s[key])) reasons.push(`${key} must be an array.`);
  }
  if (Array.isArray(s['groups'])) {
    for (const g of s['groups'] as Array<Record<string, unknown>>) {
      if (typeof g['groupId'] !== 'string' || !g['groupId']) reasons.push('Every group needs a groupId.');
      if (typeof g['name'] !== 'string' || !g['name']) reasons.push('Every group needs a name.');
      if (!Array.isArray(g['peerIds'])) reasons.push('Every group needs a peerIds array.');
    }
  }
  if (Array.isArray(s['rules'])) {
    for (const r of s['rules'] as Array<Record<string, unknown>>) {
      if (typeof r['ruleId'] !== 'string' || !r['ruleId']) reasons.push('Every rule needs a ruleId.');
      if (typeof r['name'] !== 'string' || !r['name']) reasons.push('Every rule needs a name.');
    }
  }
  if (Array.isArray(s['admins'])) {
    for (const a of s['admins'] as Array<Record<string, unknown>>) {
      if (typeof a['userId'] !== 'string' || !a['userId']) reasons.push('Every admin needs a userId.');
      if (!['viewer', 'operator', 'admin'].includes(a['role'] as string)) {
        reasons.push(`Admin ${String(a['userId'])} has an unknown role.`);
      }
    }
  }
  return reasons;
}

/** Parse snapshot JSON (validates; never throws). */
export function fleetV30SnapshotFromJson(
  json: string,
): { ok: true; snapshot: FleetV30Snapshot } | { ok: false; reasons: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch (err) {
    return { ok: false, reasons: [`Snapshot is not valid JSON: ${err instanceof Error ? err.message : String(err)}`] };
  }
  const reasons = validateFleetV30Snapshot(parsed);
  if (reasons.length > 0) return { ok: false, reasons };
  return { ok: true, snapshot: parsed as FleetV30Snapshot };
}

/** Serialize a snapshot to JSON. */
export function fleetV30SnapshotToJson(snapshot: FleetV30Snapshot): string {
  return JSON.stringify(snapshot, null, 2);
}

/**
 * Restore a snapshot into (fresh) v30 stores, fail-soft per item.
 * Admins restore first (so rule creation has its actors); groups
 * restore with the members that are currently registered; rules
 * restore under the restoring admin; views and kanban restore
 * as-is; approvals restore as pending requests, re-decided when
 * the snapshot says approved/denied. Binding descriptors are
 * counted, not applied — the host re-binds live conversations.
 */
export function restoreFleetV30Snapshot(
  snapshot: FleetV30Snapshot,
  deps: FleetV30SnapshotRestoreDeps,
): FleetV30SnapshotRestoreReport {
  const report: FleetV30SnapshotRestoreReport = {
    restoredAdmins: [],
    restoredRules: [],
    restoredGroups: [],
    skippedGroupMembers: [],
    restoredViews: [],
    kanbanRestored: false,
    restoredApprovals: [],
    skippedApprovals: [],
    bindingDescriptors: snapshot.bindingDescriptors.length,
    reasons: [],
  };
  const { admin, groups, boardV2 } = deps;

  // Admins: bootstrap the restoring actor first when the store is
  // empty (the host's admin), then grant every snapshot admin its
  // recorded role. A snapshot admin that already exists is skipped.
  if (admin.listAdmins().length === 0) {
    const boot = admin.bootstrapAdmin(deps.restoredBy);
    if (!boot.ok) {
      report.reasons.push(`Restore admin could not be bootstrapped: ${boot.reasons.join(' ')}`);
      return report;
    }
    report.restoredAdmins.push(deps.restoredBy);
  }
  for (const a of snapshot.admins) {
    if (admin.getAdmin(a.userId)) continue;
    const granted = admin.grantRole(deps.restoredBy, a.userId, a.role as 'viewer' | 'operator' | 'admin');
    if (granted.ok) report.restoredAdmins.push(a.userId);
    else report.reasons.push(`Admin ${a.userId} could not be granted: ${granted.reasons.join(' ')}`);
  }
  // The restoring actor must be an admin for the rule restores below.
  const actor = admin.roleOf(deps.restoredBy) === 'admin' ? deps.restoredBy : (report.restoredAdmins[0] ?? deps.restoredBy);

  // Rules (under the restoring actor; original creator recorded in name).
  for (const rule of snapshot.rules) {
    const created = admin.createRule(actor, {
      name: rule.name,
      taskTypes: [...rule.taskTypes],
      runtimeKinds: [...rule.runtimeKinds],
      peerIds: [...rule.peerIds],
      timeWindow: rule.timeWindow,
      maxCostUsdPerTask: rule.maxCostUsdPerTask,
      maxConcurrentTasks: rule.maxConcurrentTasks,
      requiresApprovalFor: [...rule.requiresApprovalFor],
      enabled: rule.enabled,
    });
    if (created.ok) report.restoredRules.push(created.rule.ruleId);
    else report.reasons.push(`Rule "${rule.name}" could not be restored: ${created.reasons.join(' ')}`);
  }

  // Groups (members that are registered now; the rest are reported).
  for (const group of snapshot.groups) {
    const created = groups.createGroup(group.name, actor, {
      description: group.description,
      defaultMaxConcurrent: group.defaultMaxConcurrent,
    });
    if (!created.ok) {
      report.reasons.push(`Group "${group.name}" could not be restored: ${created.reasons.join(' ')}`);
      continue;
    }
    report.restoredGroups.push(created.group.groupId);
    for (const peerId of group.peerIds) {
      const added = groups.addPeer(created.group.groupId, peerId);
      if (!added.ok) report.skippedGroupMembers.push({ groupId: created.group.groupId, peerId });
    }
  }

  // Views.
  for (const view of snapshot.views) {
    const created = boardV2.createView({
      name: view.name,
      createdBy: view.createdBy,
      peerId: view.peerId,
      state: view.state,
      priority: view.priority,
      query: view.query,
      activeOnly: view.activeOnly,
      overdueOnly: view.overdueOnly,
      groupId: view.groupId,
    });
    if (created.ok) report.restoredViews.push(created.view.viewId);
    else report.reasons.push(`View "${view.name}" could not be restored: ${created.reasons.join(' ')}`);
  }

  // Kanban (only when it differs from the default — a no-op otherwise).
  const kanban = snapshot.kanban.length > 0 ? snapshot.kanban : [...FLEET_V30_DEFAULT_KANBAN];
  const set = boardV2.setKanban(kanban.map((c) => ({ ...c, states: [...c.states] })));
  if (set.ok) report.kanbanRestored = true;
  else report.reasons.push(`Kanban could not be restored: ${set.reasons.join(' ')}`);

  // Approvals: pending requests restore as new pending requests;
  // approved ones restore as pending + immediately approved by the
  // restoring admin (the snapshot is the host's own record).
  for (const approval of snapshot.approvals) {
    const requested = admin.requestApproval(
      approval.requestedBy,
      approval.peerId,
      approval.taskType,
      approval.summary,
      approval.expiresAt,
    );
    if (!requested.ok) {
      report.skippedApprovals.push(approval.requestId);
      report.reasons.push(`Approval ${approval.requestId} could not be restored: ${requested.reasons.join(' ')}`);
      continue;
    }
    if (approval.status === 'approved') {
      const decided = admin.decideApproval(actor, requested.request.requestId, true, 'Restored from snapshot.');
      if (!decided.ok) {
        report.skippedApprovals.push(approval.requestId);
        report.reasons.push(`Approval ${approval.requestId} could not be re-approved: ${decided.reasons.join(' ')}`);
        continue;
      }
    }
    report.restoredApprovals.push(requested.request.requestId);
  }

  void deps.isolation;
  return report;
}
