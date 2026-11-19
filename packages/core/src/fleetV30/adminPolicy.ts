/**
 * Allowlist admin v2 (v1.44, Team T6) — fleet v30.
 *
 * The v29 allowlist owns per-peer scopes (skills, operations, caps,
 * suspend/expire). v30 adds the administration layer around it:
 *
 * - Admin roles: `viewer` (read-only), `operator` (run pre-flight
 *   checks, request approvals, manage rules they did not create is
 *   NOT allowed — operators may create rules but only admins may
 *   delete them or change roles), `admin` (everything). The first
 *   admin is bootstrapped by the host (`bootstrapAdmin` — the host
 *   calls it once with the local user's id; after that, only an
 *   admin can grant or revoke roles). Role checks are fail-closed:
 *   an unknown user is a viewer.
 * - Policy rules: fleet-wide rules that constrain what may run —
 *   task types, runtime driver kinds, peer ids, a time window
 *   (local hours + days of week), a per-task cost cap, a
 *   concurrency cap, and task types that need an approval first.
 *   A rule with an empty task-type / peer / runtime list applies
 *   to everything. Disabled rules are ignored.
 * - Approval workflow: an operator requests approval for
 *   out-of-scope work (a peer, a task type, a summary). An admin
 *   approves or denies with a reason; requests expire (the host
 *   sweeps them). An approval unblocks exactly one pre-flight
 *   check: the same peer + task type, while it is still `approved`
 *   and unexpired.
 * - Pre-flight check (`preflightCheck`): the single gate that runs
 *   before ANY execution — a task is never started, a runtime is
 *   never bound, a peer is never delegated to without it. Checks
 *   in order, first failure still records every later check so the
 *   operator sees the full picture (the decision is `allowed`
 *   only when every check passed):
 *     1. actor — the actor is a known admin/operator (viewers may
 *        not execute anything).
 *     2. allowlist — the peer has a live v29 entry.
 *     3. card — the peer's card is usable (verified, or unsigned
 *        when the policy allows it).
 *     4. runtime — the requested driver kind is available AND the
 *        conversation's isolation binding (when one exists) uses a
 *        driver the rules allow.
 *     5. policy — every enabled rule that applies to this
 *        peer/task-type/runtime: time window, cost cap, concurrency
 *        cap, and the approval requirement (satisfied by an
 *        approved, unexpired approval request for this peer + type).
 *     6. cost — the estimated cost is under the tightest
 *        applicable cap.
 *   A denied pre-flight is written to the admin audit log.
 *
 * Nothing here calls the network, runs a model, or spawns a
 * process. All time flows through injected clocks so tests are
 * deterministic.
 */

import { fleetV29CardStatusUsable } from '../fleetV29/cardVerify';
import type { FleetV29Allowlist } from '../fleetV29/allowlist';
import type { FleetV29PeerRegistry } from '../fleetV29/peerRegistry';
import type { FleetV30IsolationManager } from './isolation';
import type {
  FleetV30Admin,
  FleetV30AdminEvent,
  FleetV30AdminRole,
  FleetV30ApprovalRequest,
  FleetV30ApprovalStatus,
  FleetV30PolicyRule,
  FleetV30PreflightCheck,
  FleetV30PreflightDecision,
  FleetV30RuntimeDriverKind,
  FleetV30TaskType,
  FleetV30TimeWindow,
} from './types';
import { FLEET_V30_MAX_APPROVALS, FLEET_V30_MAX_RULES, FLEET_V30_TASK_TYPES } from './types';

export interface FleetV30AdminPolicyDeps {
  /** The v29 allowlist (owns per-peer scopes). */
  allowlist: FleetV29Allowlist;
  /** The v29 peer registry (owns cards + verification). */
  registry: FleetV29PeerRegistry;
  /** The v30 isolation manager (for the runtime check). */
  isolation?: FleetV30IsolationManager;
  /** Driver kinds the host reports available. */
  availableDrivers?: FleetV30RuntimeDriverKind[];
  /** Id generator (tests inject a deterministic one). */
  newId?: () => string;
  /** Clock (tests inject a fixed one). */
  nowIso?: () => string;
  /** Local-time clock for time-window checks (tests inject one). */
  nowLocal?: () => Date;
}

export interface FleetV30PreflightRequest {
  /** Actor asking to execute (local user id). */
  actor: string;
  /** Peer the work would run on. */
  peerId: string;
  /** Task type of the work. */
  taskType: FleetV30TaskType;
  /** Runtime driver kind the work would run under. */
  runtimeKind: FleetV30RuntimeDriverKind;
  /** Estimated cost USD (null = unknown, treated as 0 for caps). */
  estimatedCostUsd: number | null;
  /** Conversation the work belongs to (null = no conversation). */
  conversationId: string | null;
  /** Active task count for the peer (for the concurrency check). */
  activeTasksForPeer: number;
}

function defaultId(): string {
  return `adm-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/** Role rank (higher = more power). */
function roleRank(role: FleetV30AdminRole): number {
  return role === 'admin' ? 2 : role === 'operator' ? 1 : 0;
}

export class FleetV30AdminPolicy {
  private readonly allowlist: FleetV29Allowlist;
  private readonly registry: FleetV29PeerRegistry;
  private readonly isolation: FleetV30IsolationManager | undefined;
  private readonly availableDrivers: FleetV30RuntimeDriverKind[];
  private readonly newId: () => string;
  private readonly nowIso: () => string;
  private readonly nowLocal: () => Date;
  private readonly admins = new Map<string, FleetV30Admin>();
  private readonly rules = new Map<string, FleetV30PolicyRule>();
  private readonly approvals = new Map<string, FleetV30ApprovalRequest>();
  private readonly events: FleetV30AdminEvent[] = [];
  private seq = 0;
  private bootstrapped = false;

  constructor(deps: FleetV30AdminPolicyDeps) {
    this.allowlist = deps.allowlist;
    this.registry = deps.registry;
    this.isolation = deps.isolation;
    this.availableDrivers = [...(deps.availableDrivers ?? ['bwrap', 'docker', 'local'])];
    this.newId = deps.newId ?? defaultId;
    this.nowIso = deps.nowIso ?? (() => new Date().toISOString());
    this.nowLocal = deps.nowLocal ?? (() => new Date());
  }

  private recordEvent(
    kind: FleetV30AdminEvent['kind'],
    actor: string,
    peerId: string | null,
    detail: string,
  ): void {
    this.seq += 1;
    this.events.push({ seq: this.seq, at: this.nowIso(), kind, actor, peerId, detail });
  }

  /* ---------------- admins ---------------- */

  /**
   * Bootstrap the first admin. The host calls this once with the
   * local user's id; a second call is refused (after bootstrap,
   * only an admin can grant roles).
   */
  bootstrapAdmin(userId: string): { ok: true; admin: FleetV30Admin } | { ok: false; reasons: string[] } {
    if (this.bootstrapped) return { ok: false, reasons: ['Admin bootstrap already ran — only an admin can grant roles now.'] };
    if (!userId.trim()) return { ok: false, reasons: ['userId is required.'] };
    this.bootstrapped = true;
    const admin: FleetV30Admin = { userId, role: 'admin', grantedBy: 'bootstrap', grantedAt: this.nowIso() };
    this.admins.set(userId, admin);
    this.recordEvent('admin-granted', 'bootstrap', null, `First admin bootstrapped: ${userId}.`);
    return { ok: true, admin: { ...admin } };
  }

  /** Role of a user (unknown users are viewers — fail-closed). */
  roleOf(userId: string): FleetV30AdminRole {
    return this.admins.get(userId)?.role ?? 'viewer';
  }

  getAdmin(userId: string): FleetV30Admin | null {
    const a = this.admins.get(userId);
    return a ? { ...a } : null;
  }

  listAdmins(): FleetV30Admin[] {
    return [...this.admins.values()].map((a) => ({ ...a })).sort((a, b) => a.userId.localeCompare(b.userId));
  }

  /** Grant a role (admin only; cannot grant above the granter's own role). */
  grantRole(
    granterId: string,
    userId: string,
    role: FleetV30AdminRole,
  ): { ok: true; admin: FleetV30Admin } | { ok: false; reasons: string[] } {
    if (this.roleOf(granterId) !== 'admin') {
      return { ok: false, reasons: [`${granterId} is not an admin and cannot grant roles.`] };
    }
    if (!userId.trim()) return { ok: false, reasons: ['userId is required.'] };
    const admin: FleetV30Admin = { userId, role, grantedBy: granterId, grantedAt: this.nowIso() };
    this.admins.set(userId, admin);
    this.recordEvent('admin-granted', granterId, null, `Role ${role} granted to ${userId}.`);
    return { ok: true, admin: { ...admin } };
  }

  /** Revoke a role (admin only; cannot revoke the last admin). */
  revokeRole(
    revokerId: string,
    userId: string,
  ): { ok: true } | { ok: false; reasons: string[] } {
    if (this.roleOf(revokerId) !== 'admin') {
      return { ok: false, reasons: [`${revokerId} is not an admin and cannot revoke roles.`] };
    }
    const target = this.admins.get(userId);
    if (!target) return { ok: false, reasons: [`${userId} has no role to revoke.`] };
    const adminsLeft = [...this.admins.values()].filter((a) => a.role === 'admin' && a.userId !== userId).length;
    if (target.role === 'admin' && adminsLeft === 0) {
      return { ok: false, reasons: [`Cannot revoke the last admin (${userId}).`] };
    }
    this.admins.delete(userId);
    this.recordEvent('admin-revoked', revokerId, null, `Role ${target.role} revoked from ${userId}.`);
    return { ok: true };
  }

  /* ---------------- policy rules ---------------- */

  /** Validate a time window (empty = valid). */
  static validateTimeWindow(window: FleetV30TimeWindow | null): string[] {
    if (window === null) return [];
    const problems: string[] = [];
    if (!Number.isInteger(window.startHour) || window.startHour < 0 || window.startHour > 23) {
      problems.push('timeWindow.startHour must be an integer 0–23.');
    }
    if (!Number.isInteger(window.endHour) || window.endHour < 0 || window.endHour > 23) {
      problems.push('timeWindow.endHour must be an integer 0–23.');
    }
    if (
      Number.isInteger(window.startHour) &&
      Number.isInteger(window.endHour) &&
      window.endHour <= window.startHour
    ) {
      problems.push('timeWindow.endHour must be after startHour (no overnight windows).');
    }
    if (!Array.isArray(window.days) || window.days.length === 0) {
      problems.push('timeWindow.days must list at least one day of week.');
    } else if (window.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
      problems.push('timeWindow.days must be integers 0–6 (0 = Sunday).');
    } else if (new Set(window.days).size !== window.days.length) {
      problems.push('timeWindow.days has duplicates.');
    }
    return problems;
  }

  /** Create a policy rule (operator+; validated, bounded). */
  createRule(
    actor: string,
    input: {
      name: string;
      taskTypes?: FleetV30TaskType[];
      runtimeKinds?: FleetV30RuntimeDriverKind[];
      peerIds?: string[];
      timeWindow?: FleetV30TimeWindow | null;
      maxCostUsdPerTask?: number | null;
      maxConcurrentTasks?: number | null;
      requiresApprovalFor?: FleetV30TaskType[];
      enabled?: boolean;
    },
  ): { ok: true; rule: FleetV30PolicyRule } | { ok: false; reasons: string[] } {
    const reasons: string[] = [];
    if (roleRank(this.roleOf(actor)) < 1) reasons.push(`${actor} is a viewer and cannot create policy rules.`);
    if (!input.name.trim()) reasons.push('A rule name is required.');
    const taskTypes = input.taskTypes ?? [];
    for (const t of taskTypes) {
      if (!(FLEET_V30_TASK_TYPES as readonly string[]).includes(t)) reasons.push(`Unknown task type "${t}".`);
    }
    if (new Set(taskTypes).size !== taskTypes.length) reasons.push('taskTypes has duplicates.');
    const runtimeKinds = input.runtimeKinds ?? [];
    for (const k of runtimeKinds) {
      if (!['bwrap', 'docker', 'local'].includes(k)) reasons.push(`Unknown runtime kind "${k}".`);
    }
    for (const t of input.requiresApprovalFor ?? []) {
      if (!(FLEET_V30_TASK_TYPES as readonly string[]).includes(t)) reasons.push(`Unknown task type "${t}" in requiresApprovalFor.`);
    }
    reasons.push(...FleetV30AdminPolicy.validateTimeWindow(input.timeWindow ?? null));
    if (input.maxCostUsdPerTask !== undefined && input.maxCostUsdPerTask !== null) {
      if (!Number.isFinite(input.maxCostUsdPerTask) || input.maxCostUsdPerTask < 0) {
        reasons.push('maxCostUsdPerTask must be >= 0 or null.');
      }
    }
    if (input.maxConcurrentTasks !== undefined && input.maxConcurrentTasks !== null) {
      if (!Number.isInteger(input.maxConcurrentTasks) || input.maxConcurrentTasks < 1) {
        reasons.push('maxConcurrentTasks must be an integer >= 1 or null.');
      }
    }
    if (this.rules.size >= FLEET_V30_MAX_RULES) reasons.push(`Too many policy rules (max ${FLEET_V30_MAX_RULES}).`);
    if (reasons.length > 0) return { ok: false, reasons };
    const ruleId = `rule-${this.newId()}`;
    const rule: FleetV30PolicyRule = {
      ruleId,
      name: input.name.trim(),
      taskTypes: [...taskTypes],
      runtimeKinds: [...runtimeKinds],
      peerIds: [...(input.peerIds ?? [])],
      timeWindow: input.timeWindow ?? null,
      maxCostUsdPerTask: input.maxCostUsdPerTask ?? null,
      maxConcurrentTasks: input.maxConcurrentTasks ?? null,
      requiresApprovalFor: [...(input.requiresApprovalFor ?? [])],
      enabled: input.enabled ?? true,
      createdBy: actor,
      createdAt: this.nowIso(),
    };
    this.rules.set(ruleId, rule);
    this.recordEvent('rule-created', actor, null, `Policy rule "${rule.name}" (${ruleId}) created.`);
    return { ok: true, rule: { ...rule, taskTypes: [...rule.taskTypes], runtimeKinds: [...rule.runtimeKinds], peerIds: [...rule.peerIds], requiresApprovalFor: [...rule.requiresApprovalFor] } };
  }

  getRule(ruleId: string): FleetV30PolicyRule | null {
    const r = this.rules.get(ruleId);
    if (!r) return null;
    return { ...r, taskTypes: [...r.taskTypes], runtimeKinds: [...r.runtimeKinds], peerIds: [...r.peerIds], requiresApprovalFor: [...r.requiresApprovalFor] };
  }

  listRules(): FleetV30PolicyRule[] {
    return [...this.rules.values()]
      .map((r) => ({ ...r, taskTypes: [...r.taskTypes], runtimeKinds: [...r.runtimeKinds], peerIds: [...r.peerIds], requiresApprovalFor: [...r.requiresApprovalFor] }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Update a rule's mutable fields (operator+; only the creator or an admin). */
  updateRule(
    actor: string,
    ruleId: string,
    patch: {
      name?: string;
      taskTypes?: FleetV30TaskType[];
      runtimeKinds?: FleetV30RuntimeDriverKind[];
      peerIds?: string[];
      timeWindow?: FleetV30TimeWindow | null;
      maxCostUsdPerTask?: number | null;
      maxConcurrentTasks?: number | null;
      requiresApprovalFor?: FleetV30TaskType[];
      enabled?: boolean;
    },
  ): { ok: true; rule: FleetV30PolicyRule } | { ok: false; reasons: string[] } {
    const rule = this.rules.get(ruleId);
    if (!rule) return { ok: false, reasons: [`No policy rule "${ruleId}".`] };
    if (this.roleOf(actor) !== 'admin' && rule.createdBy !== actor) {
      return { ok: false, reasons: [`${actor} did not create rule "${ruleId}" and is not an admin.`] };
    }
    if (roleRank(this.roleOf(actor)) < 1) return { ok: false, reasons: [`${actor} is a viewer and cannot update policy rules.`] };
    const reasons: string[] = [];
    if (patch.name !== undefined && !patch.name.trim()) reasons.push('A rule name is required.');
    if (patch.taskTypes !== undefined) {
      for (const t of patch.taskTypes) {
        if (!(FLEET_V30_TASK_TYPES as readonly string[]).includes(t)) reasons.push(`Unknown task type "${t}".`);
      }
    }
    reasons.push(...FleetV30AdminPolicy.validateTimeWindow(patch.timeWindow ?? rule.timeWindow));
    if (patch.maxCostUsdPerTask !== undefined && patch.maxCostUsdPerTask !== null) {
      if (!Number.isFinite(patch.maxCostUsdPerTask) || patch.maxCostUsdPerTask < 0) {
        reasons.push('maxCostUsdPerTask must be >= 0 or null.');
      }
    }
    if (patch.maxConcurrentTasks !== undefined && patch.maxConcurrentTasks !== null) {
      if (!Number.isInteger(patch.maxConcurrentTasks) || patch.maxConcurrentTasks < 1) {
        reasons.push('maxConcurrentTasks must be an integer >= 1 or null.');
      }
    }
    if (reasons.length > 0) return { ok: false, reasons };
    if (patch.name !== undefined) rule.name = patch.name.trim();
    if (patch.taskTypes !== undefined) rule.taskTypes = [...patch.taskTypes];
    if (patch.runtimeKinds !== undefined) rule.runtimeKinds = [...patch.runtimeKinds];
    if (patch.peerIds !== undefined) rule.peerIds = [...patch.peerIds];
    if (patch.timeWindow !== undefined) rule.timeWindow = patch.timeWindow;
    if (patch.maxCostUsdPerTask !== undefined) rule.maxCostUsdPerTask = patch.maxCostUsdPerTask;
    if (patch.maxConcurrentTasks !== undefined) rule.maxConcurrentTasks = patch.maxConcurrentTasks;
    if (patch.requiresApprovalFor !== undefined) rule.requiresApprovalFor = [...patch.requiresApprovalFor];
    if (patch.enabled !== undefined) rule.enabled = patch.enabled;
    this.recordEvent('rule-updated', actor, null, `Policy rule "${rule.name}" (${ruleId}) updated.`);
    return { ok: true, rule: this.getRule(ruleId) as FleetV30PolicyRule };
  }

  /** Delete a rule (admin only). */
  deleteRule(actor: string, ruleId: string): { ok: true } | { ok: false; reasons: string[] } {
    if (this.roleOf(actor) !== 'admin') return { ok: false, reasons: [`${actor} is not an admin and cannot delete policy rules.`] };
    const rule = this.rules.get(ruleId);
    if (!rule) return { ok: false, reasons: [`No policy rule "${ruleId}".`] };
    this.rules.delete(ruleId);
    this.recordEvent('rule-deleted', actor, null, `Policy rule "${rule.name}" (${ruleId}) deleted.`);
    return { ok: true };
  }

  /** Rules that apply to one peer + task type + runtime (enabled only). */
  applicableRules(peerId: string, taskType: FleetV30TaskType, runtimeKind: FleetV30RuntimeDriverKind): FleetV30PolicyRule[] {
    return this.listRules().filter((r) => {
      if (!r.enabled) return false;
      if (r.peerIds.length > 0 && !r.peerIds.includes(peerId)) return false;
      if (r.taskTypes.length > 0 && !r.taskTypes.includes(taskType)) return false;
      if (r.runtimeKinds.length > 0 && !r.runtimeKinds.includes(runtimeKind)) return false;
      return true;
    });
  }

  /** True when the local time falls inside the window. */
  static insideTimeWindow(window: FleetV30TimeWindow, nowLocal: Date): boolean {
    const day = nowLocal.getDay();
    if (!window.days.includes(day)) return false;
    const hour = nowLocal.getHours() + nowLocal.getMinutes() / 60;
    return hour >= window.startHour && hour < window.endHour;
  }

  /* ---------------- approvals ---------------- */

  /** Request approval for out-of-scope work (operator+). */
  requestApproval(
    requestedBy: string,
    peerId: string,
    taskType: FleetV30TaskType,
    summary: string,
    expiresAt: string | null = null,
  ): { ok: true; request: FleetV30ApprovalRequest } | { ok: false; reasons: string[] } {
    const reasons: string[] = [];
    if (roleRank(this.roleOf(requestedBy)) < 1) reasons.push(`${requestedBy} is a viewer and cannot request approvals.`);
    if (!this.registry.getPeer(peerId)) reasons.push(`Peer "${peerId}" is not registered.`);
    if (!(FLEET_V30_TASK_TYPES as readonly string[]).includes(taskType)) reasons.push(`Unknown task type "${taskType}".`);
    if (!summary.trim()) reasons.push('An approval summary is required.');
    if (expiresAt !== null && Number.isNaN(Date.parse(expiresAt))) reasons.push(`expiresAt "${expiresAt}" is not a valid ISO date.`);
    if (this.approvals.size >= FLEET_V30_MAX_APPROVALS) reasons.push(`Too many approval requests (max ${FLEET_V30_MAX_APPROVALS}).`);
    if (reasons.length > 0) return { ok: false, reasons };
    const request: FleetV30ApprovalRequest = {
      requestId: `appr-${this.newId()}`,
      peerId,
      taskType,
      summary: summary.trim(),
      requestedBy,
      requestedAt: this.nowIso(),
      expiresAt,
      status: 'pending',
      decidedBy: null,
      decidedAt: null,
      decisionReason: null,
    };
    this.approvals.set(request.requestId, request);
    this.recordEvent('approval-requested', requestedBy, peerId, `Approval requested for ${taskType} work on ${peerId} (${request.requestId}).`);
    return { ok: true, request: { ...request } };
  }

  /** Decide an approval request (admin only). */
  decideApproval(
    decidedBy: string,
    requestId: string,
    approve: boolean,
    reason?: string,
  ): { ok: true; request: FleetV30ApprovalRequest } | { ok: false; reasons: string[] } {
    if (this.roleOf(decidedBy) !== 'admin') {
      return { ok: false, reasons: [`${decidedBy} is not an admin and cannot decide approvals.`] };
    }
    const request = this.approvals.get(requestId);
    if (!request) return { ok: false, reasons: [`No approval request "${requestId}".`] };
    if (request.status !== 'pending') return { ok: false, reasons: [`Approval request "${requestId}" is already ${request.status}.`] };
    request.status = approve ? 'approved' : 'denied';
    request.decidedBy = decidedBy;
    request.decidedAt = this.nowIso();
    request.decisionReason = reason ?? null;
    this.recordEvent(
      approve ? 'approval-approved' : 'approval-denied',
      decidedBy,
      request.peerId,
      `Approval ${request.requestId} ${approve ? 'approved' : 'denied'}${reason ? `: ${reason}` : ''}.`,
    );
    return { ok: true, request: { ...request } };
  }

  /** Expire pending requests past their expiry (returns expired ids). */
  sweepExpiredApprovals(nowIso?: string): string[] {
    const now = nowIso ?? this.nowIso();
    const expired: string[] = [];
    for (const request of this.approvals.values()) {
      if (request.status !== 'pending') continue;
      if (request.expiresAt !== null && now >= request.expiresAt) {
        request.status = 'expired';
        expired.push(request.requestId);
        this.recordEvent('approval-expired', 'system', request.peerId, `Approval ${request.requestId} expired.`);
      }
    }
    return expired;
  }

  listApprovals(status?: FleetV30ApprovalStatus): FleetV30ApprovalRequest[] {
    return [...this.approvals.values()]
      .filter((r) => (status === undefined ? true : r.status === status))
      .map((r) => ({ ...r }))
      .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
  }

  /** Approved, unexpired approval for one peer + task type (null = none). */
  approvedFor(peerId: string, taskType: FleetV30TaskType, nowIso?: string): FleetV30ApprovalRequest | null {
    const now = nowIso ?? this.nowIso();
    for (const request of this.approvals.values()) {
      if (request.peerId !== peerId || request.taskType !== taskType) continue;
      if (request.status !== 'approved') continue;
      if (request.expiresAt !== null && now >= request.expiresAt) continue;
      return { ...request };
    }
    return null;
  }

  /* ---------------- pre-flight ---------------- */

  /**
   * The pre-flight permission check — runs before any execution.
   * Every check runs (failures do not short-circuit) so the caller
   * sees the full picture; `allowed` is true only when all pass.
   */
  preflightCheck(request: FleetV30PreflightRequest): FleetV30PreflightDecision {
    const checks: FleetV30PreflightCheck[] = [];
    const reasons: string[] = [];
    const push = (name: string, passed: boolean, detail: string): void => {
      checks.push({ name, passed, detail });
      if (!passed) reasons.push(detail);
    };

    // 1. Actor.
    const role = this.roleOf(request.actor);
    push(
      'actor',
      roleRank(role) >= 1,
      roleRank(role) >= 1
        ? `Actor ${request.actor} is ${role}.`
        : `Actor ${request.actor} is a viewer and may not execute anything.`,
    );

    // 2. Allowlist (live v29 entry).
    const now = this.nowIso();
    const entry = this.allowlist.get(request.peerId);
    const allowlisted = this.allowlist.isAllowlisted(request.peerId, now);
    push(
      'allowlist',
      allowlisted,
      allowlisted
        ? `Peer ${request.peerId} is allowlisted.`
        : entry
          ? entry.suspended
            ? `Peer "${request.peerId}" is suspended on the allowlist.`
            : `Peer "${request.peerId}" allowlist entry has expired.`
          : `Peer "${request.peerId}" is not on the allowlist.`,
    );

    // 3. Card.
    const peer = this.registry.getPeer(request.peerId);
    const cardUsable = peer ? fleetV29CardStatusUsable(peer.cardStatus) : false;
    push(
      'card',
      cardUsable,
      peer
        ? cardUsable
          ? `Peer ${request.peerId} card is ${peer.cardStatus}.`
          : `Peer "${request.peerId}" card is ${peer.cardStatus} — re-verify the Agent Card before executing.`
        : `Peer "${request.peerId}" is not registered.`,
    );

    // 4. Runtime driver.
    const driverAvailable = this.availableDrivers.includes(request.runtimeKind);
    let runtimeDetail = driverAvailable
      ? `Runtime driver "${request.runtimeKind}" is available on this host.`
      : `Runtime driver "${request.runtimeKind}" is not available on this host.`;
    let runtimeOk = driverAvailable;
    if (request.conversationId !== null && this.isolation) {
      const binding = this.isolation.getBinding(request.conversationId);
      if (binding && binding.status !== 'active') {
        runtimeOk = false;
        runtimeDetail = `Conversation "${request.conversationId}" isolation binding is ${binding.status}, not active.`;
      } else if (binding && binding.driverKind !== request.runtimeKind) {
        runtimeOk = false;
        runtimeDetail = `Conversation "${request.conversationId}" is bound to driver "${binding.driverKind}", not "${request.runtimeKind}".`;
      }
    }
    push('runtime', runtimeOk, runtimeDetail);

    // 5. Policy rules.
    const rules = this.applicableRules(request.peerId, request.taskType, request.runtimeKind);
    const nowLocal = this.nowLocal();
    let policyOk = true;
    const policyDetails: string[] = [];
    let approvalRequired: string | null = null;
    for (const rule of rules) {
      if (rule.timeWindow !== null && !FleetV30AdminPolicy.insideTimeWindow(rule.timeWindow, nowLocal)) {
        policyOk = false;
        policyDetails.push(`Rule "${rule.name}" allows ${request.taskType} only ${rule.timeWindow.startHour}:00–${rule.timeWindow.endHour}:00 on days ${rule.timeWindow.days.join(',')}.`);
      }
      if (rule.requiresApprovalFor.includes(request.taskType)) {
        const approval = this.approvedFor(request.peerId, request.taskType, now);
        if (!approval) {
          policyOk = false;
          policyDetails.push(`Rule "${rule.name}" requires an approved approval for ${request.taskType} work on ${request.peerId}.`);
          approvalRequired = approvalRequired ?? `approval:${request.peerId}:${request.taskType}`;
        }
      }
      if (rule.maxConcurrentTasks !== null && request.activeTasksForPeer >= rule.maxConcurrentTasks) {
        policyOk = false;
        policyDetails.push(`Rule "${rule.name}" caps concurrent tasks at ${rule.maxConcurrentTasks} (${request.activeTasksForPeer} active).`);
      }
    }
    push(
      'policy',
      policyOk,
      policyDetails.length === 0
        ? `${rules.length} applicable policy rule(s); all pass.`
        : policyDetails.join(' '),
    );

    // 6. Cost cap (tightest applicable rule + v29 scope cap).
    const caps: number[] = [];
    for (const rule of rules) {
      if (rule.maxCostUsdPerTask !== null) caps.push(rule.maxCostUsdPerTask);
    }
    const scopeCap = entry?.scope.maxCostUsdPerTask ?? null;
    if (scopeCap !== null) caps.push(scopeCap);
    const estimated = request.estimatedCostUsd ?? 0;
    const tightest = caps.length > 0 ? Math.min(...caps) : null;
    const costOk = tightest === null || estimated <= tightest;
    push(
      'cost',
      costOk,
      tightest === null
        ? 'No cost cap applies.'
        : costOk
          ? `Estimated $${estimated.toFixed(4)} is within the $${tightest.toFixed(4)} cap.`
          : `Estimated $${estimated.toFixed(4)} exceeds the $${tightest.toFixed(4)} cost cap.`,
    );

    const allowed = checks.every((c) => c.passed);
    if (!allowed) {
      this.recordEvent(
        'preflight-denied',
        request.actor,
        request.peerId,
        `Pre-flight denied for ${request.taskType} on ${request.peerId}: ${reasons.join(' ')}`,
      );
    }
    return { allowed, checks, reasons, approvalRequired };
  }

  /* ---------------- audit ---------------- */

  listEvents(limit = 200): FleetV30AdminEvent[] {
    return this.events.slice(-Math.max(1, limit));
  }

  eventsForPeer(peerId: string, limit = 100): FleetV30AdminEvent[] {
    return this.events.filter((e) => e.peerId === peerId).slice(-Math.max(1, limit));
  }

  countsByKind(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const e of this.events) out[e.kind] = (out[e.kind] ?? 0) + 1;
    return out;
  }
}
