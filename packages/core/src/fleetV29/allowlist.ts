/**
 * Fleet v29 allowlist (v1.42, Team T6).
 *
 * The allowlist is the fleet's explicit consent list: a peer may be
 * delegated to only when it has an entry here AND its card verifies
 * (see `cardVerify.ts`). Either check failing blocks delegation —
 * there is no "allowlisted but unverified" fast path and no
 * "verified but not allowlisted" fast path.
 *
 * Entries carry a scope (least privilege by default): which skills
 * and operations the peer may be asked for, a per-task cost cap, a
 * concurrency cap, and which sensitive actions it may even request
 * (each still needs a user confirmation). Entries can expire and can
 * be suspended without deleting the record, so an admin can pause a
 * peer instantly and resume it later with the same scope.
 *
 * Every change is reported back to the caller as an audit event
 * (the store itself does not own the audit log — the coordinator
 * writes the returned events into `FleetV29AuditLog` so one log
 * covers delegation + allowlist + confirmations in order).
 */

import type {
  FleetV29AllowlistEntry,
  FleetV29AuditKind,
  FleetV29PeerScope,
  FleetV29SensitiveAction,
} from './types';
import { FLEET_V29_DEFAULT_SCOPE, FLEET_V29_OPERATIONS } from './types';

export interface FleetV29AllowlistChange {
  kind: FleetV29AuditKind;
  peerId: string;
  detail: string;
}

/** Scope overrides when adding a peer (everything else = default). */
export interface FleetV29AllowlistScopeInput {
  allowedSkills?: string[];
  allowedOperations?: FleetV29AllowlistEntry['scope']['allowedOperations'];
  maxCostUsdPerTask?: number | null;
  maxConcurrentTasks?: number;
  sensitiveActionsAllowed?: FleetV29SensitiveAction[];
}

function cloneScope(scope: FleetV29PeerScope): FleetV29PeerScope {
  return {
    allowedSkills: [...scope.allowedSkills],
    allowedOperations: [...scope.allowedOperations],
    maxCostUsdPerTask: scope.maxCostUsdPerTask,
    maxConcurrentTasks: scope.maxConcurrentTasks,
    sensitiveActionsAllowed: [...scope.sensitiveActionsAllowed],
  };
}

export function fleetV29DefaultScopeWith(input?: FleetV29AllowlistScopeInput): FleetV29PeerScope {
  const scope = cloneScope(FLEET_V29_DEFAULT_SCOPE);
  if (!input) return scope;
  if (input.allowedSkills !== undefined) scope.allowedSkills = [...input.allowedSkills];
  if (input.allowedOperations !== undefined) {
    scope.allowedOperations = [...input.allowedOperations];
  }
  if (input.maxCostUsdPerTask !== undefined) scope.maxCostUsdPerTask = input.maxCostUsdPerTask;
  if (input.maxConcurrentTasks !== undefined) scope.maxConcurrentTasks = input.maxConcurrentTasks;
  if (input.sensitiveActionsAllowed !== undefined) scope.sensitiveActionsAllowed = [...input.sensitiveActionsAllowed];
  return scope;
}

/** Problems with a scope (empty = valid). */
export function fleetV29ValidateScope(scope: FleetV29PeerScope): string[] {
  const problems: string[] = [];
  for (const op of scope.allowedOperations) {
    if (!(FLEET_V29_OPERATIONS as readonly string[]).includes(op)) problems.push(`Unknown A2A operation "${op}".`);
  }
  if (new Set(scope.allowedOperations).size !== scope.allowedOperations.length) {
    problems.push('allowedOperations has duplicates.');
  }
  if (scope.maxCostUsdPerTask !== null && (!Number.isFinite(scope.maxCostUsdPerTask) || scope.maxCostUsdPerTask < 0)) {
    problems.push('maxCostUsdPerTask must be >= 0 or null.');
  }
  if (!Number.isInteger(scope.maxConcurrentTasks) || scope.maxConcurrentTasks < 1) {
    problems.push('maxConcurrentTasks must be an integer >= 1.');
  }
  if (new Set(scope.allowedSkills).size !== scope.allowedSkills.length) {
    problems.push('allowedSkills has duplicates.');
  }
  return problems;
}

export class FleetV29Allowlist {
  private readonly entries = new Map<string, FleetV29AllowlistEntry>();

  /** Add a peer (fails when already present — use updateScope / resume instead). */
  add(
    peerId: string,
    addedBy: string,
    scopeInput?: FleetV29AllowlistScopeInput,
    options?: { reason?: string; expiresAt?: string | null },
    nowIso?: string,
  ): { ok: true; entry: FleetV29AllowlistEntry; change: FleetV29AllowlistChange } | { ok: false; reasons: string[] } {
    if (!peerId.trim()) return { ok: false, reasons: ['peerId is required.'] };
    if (this.entries.has(peerId)) return { ok: false, reasons: [`Peer "${peerId}" is already on the allowlist.`] };
    const scope = fleetV29DefaultScopeWith(scopeInput);
    const problems = fleetV29ValidateScope(scope);
    if (problems.length > 0) return { ok: false, reasons: problems };
    const now = nowIso ?? new Date().toISOString();
    const entry: FleetV29AllowlistEntry = {
      peerId,
      scope,
      addedBy,
      addedAt: now,
      expiresAt: options?.expiresAt ?? null,
      reason: options?.reason ?? '',
      suspended: false,
    };
    this.entries.set(peerId, entry);
    return {
      ok: true,
      entry,
      change: { kind: 'allowlist-added', peerId, detail: `Peer ${peerId} added to the allowlist by ${addedBy}.` },
    };
  }

  get(peerId: string): FleetV29AllowlistEntry | null {
    return this.entries.get(peerId) ?? null;
  }

  list(): FleetV29AllowlistEntry[] {
    return [...this.entries.values()].sort((a, b) => a.peerId.localeCompare(b.peerId));
  }

  /** True when the peer has a live (non-suspended, non-expired) entry. */
  isAllowlisted(peerId: string, nowIso?: string): boolean {
    const entry = this.entries.get(peerId);
    if (!entry || entry.suspended) return false;
    if (entry.expiresAt !== null && (nowIso ?? new Date().toISOString()) >= entry.expiresAt) return false;
    return true;
  }

  /** Entries that have passed their expiry (for the admin panel + sweeper). */
  expiredEntries(nowIso?: string): FleetV29AllowlistEntry[] {
    const now = nowIso ?? new Date().toISOString();
    return this.list().filter((e) => e.expiresAt !== null && now >= (e.expiresAt as string));
  }

  /** Remove expired entries; returns the removed peer ids (audit each). */
  sweepExpired(nowIso?: string): string[] {
    const removed: string[] = [];
    for (const entry of this.expiredEntries(nowIso)) {
      this.entries.delete(entry.peerId);
      removed.push(entry.peerId);
    }
    return removed;
  }

  remove(
    peerId: string,
  ): { ok: true; change: FleetV29AllowlistChange } | { ok: false; reasons: string[] } {
    if (!this.entries.has(peerId)) return { ok: false, reasons: [`Peer "${peerId}" is not on the allowlist.`] };
    this.entries.delete(peerId);
    return { ok: true, change: { kind: 'allowlist-removed', peerId, detail: `Peer ${peerId} removed from the allowlist.` } };
  }

  suspend(peerId: string): { ok: true; change: FleetV29AllowlistChange } | { ok: false; reasons: string[] } {
    const entry = this.entries.get(peerId);
    if (!entry) return { ok: false, reasons: [`Peer "${peerId}" is not on the allowlist.`] };
    if (entry.suspended) return { ok: false, reasons: [`Peer "${peerId}" is already suspended.`] };
    entry.suspended = true;
    return { ok: true, change: { kind: 'allowlist-suspended', peerId, detail: `Peer ${peerId} suspended (kept on the allowlist, not usable).` } };
  }

  resume(peerId: string): { ok: true; change: FleetV29AllowlistChange } | { ok: false; reasons: string[] } {
    const entry = this.entries.get(peerId);
    if (!entry) return { ok: false, reasons: [`Peer "${peerId}" is not on the allowlist.`] };
    if (!entry.suspended) return { ok: false, reasons: [`Peer "${peerId}" is not suspended.`] };
    entry.suspended = false;
    return { ok: true, change: { kind: 'allowlist-resumed', peerId, detail: `Peer ${peerId} resumed on the allowlist.` } };
  }

  /** Replace a peer's scope (validated; suspended state + expiry untouched). */
  updateScope(
    peerId: string,
    scopeInput: FleetV29AllowlistScopeInput,
  ): { ok: true; entry: FleetV29AllowlistEntry } | { ok: false; reasons: string[] } {
    const entry = this.entries.get(peerId);
    if (!entry) return { ok: false, reasons: [`Peer "${peerId}" is not on the allowlist.`] };
    const merged: FleetV29PeerScope = {
      allowedSkills: scopeInput.allowedSkills ?? entry.scope.allowedSkills,
      allowedOperations: scopeInput.allowedOperations ?? entry.scope.allowedOperations,
      maxCostUsdPerTask: scopeInput.maxCostUsdPerTask !== undefined ? scopeInput.maxCostUsdPerTask : entry.scope.maxCostUsdPerTask,
      maxConcurrentTasks: scopeInput.maxConcurrentTasks ?? entry.scope.maxConcurrentTasks,
      sensitiveActionsAllowed: scopeInput.sensitiveActionsAllowed ?? entry.scope.sensitiveActionsAllowed,
    };
    const problems = fleetV29ValidateScope(merged);
    if (problems.length > 0) return { ok: false, reasons: problems };
    entry.scope = cloneScope(merged);
    return { ok: true, entry };
  }

  /** True when the requested skill is inside the peer's scope (empty = all skills). */
  skillAllowed(peerId: string, skillId: string | undefined): boolean {
    const entry = this.entries.get(peerId);
    if (!entry) return false;
    if (skillId === undefined) return true;
    if (entry.scope.allowedSkills.length === 0) return true;
    return entry.scope.allowedSkills.includes(skillId);
  }

  /** True when the requested operation is inside the peer's scope. */
  operationAllowed(peerId: string, operation: FleetV29AllowlistEntry['scope']['allowedOperations'][number]): boolean {
    const entry = this.entries.get(peerId);
    if (!entry) return false;
    return entry.scope.allowedOperations.includes(operation);
  }

  /** True when the peer may even request this sensitive action. */
  sensitiveAllowed(peerId: string, action: FleetV29SensitiveAction): boolean {
    const entry = this.entries.get(peerId);
    if (!entry) return false;
    return entry.scope.sensitiveActionsAllowed.includes(action);
  }

  count(): number {
    return this.entries.size;
  }

  activeCount(nowIso?: string): number {
    return this.list().filter((e) => this.isAllowlisted(e.peerId, nowIso)).length;
  }
}
