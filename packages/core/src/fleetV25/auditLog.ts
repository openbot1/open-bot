/**
 * Audit log v25 — hash-chained record of important fleet actions
 * (v1.38, Đội T6).
 *
 * Every important action in fleet v25 is written here: who did it,
 * what they did, when, on which resource, and whether it was allowed
 * (including *denied* attempts — a denied write is itself evidence).
 * This module is the pure core: no I/O, no timers — the host owns
 * persistence (the log serialises to JSONL, one entry per line).
 *
 * Tamper evidence: entries form a hash chain. Each entry stores the
 * SHA-256 of the previous entry's hash plus its own content, so
 * editing, deleting or reordering any entry breaks `verify()` at
 * exactly that sequence number. The first entry's `prevHash` is the
 * all-zero hash (`FLEET_V25_AUDIT_GENESIS_HASH`).
 *
 * Retention: `pruneBeforeSeq` drops old entries for bounded storage,
 * but it records a checkpoint (the hash + seq of the last pruned
 * entry) so `verify()` still proves the remaining chain starts from
 * a known-good checkpoint instead of silently restarting. A pruned
 * log verifies with `pruned: true` and reports the checkpoint.
 *
 * Entries are append-only: there is no update or delete API for
 * single entries. Corrections are new entries (e.g. an admin noting
 * a mistaken action), never edits.
 */

import { createHash } from 'node:crypto';

/** Hash of "nothing before" — the prevHash of the first entry. */
export const FLEET_V25_AUDIT_GENESIS_HASH = '0'.repeat(64);

/** Result of an audited action. */
export type FleetV25AuditResult = 'allowed' | 'denied' | 'success' | 'failure';

/** All audit results, in summary display order. */
export const FLEET_V25_AUDIT_RESULTS: readonly FleetV25AuditResult[] = [
  'success',
  'allowed',
  'denied',
  'failure',
];

/** Resource kinds the audit log knows about. */
export type FleetV25AuditResourceType =
  | 'user'
  | 'role'
  | 'automation'
  | 'schedule'
  | 'run'
  | 'audit'
  | 'cidr-rule'
  | 'fleet'
  | 'tool';

/** One audit entry (append-only, hash-chained). */
export interface FleetV25AuditEntry {
  /** Monotonic sequence inside this log (starts at 1). */
  seq: number;
  /** Stable id: `audit-<seq>` (unique inside the log). */
  id: string;
  /** When the action happened (epoch ms). */
  atMs: number;
  /** Who acted (user id, `system`, `tool`, `engine`, ...). */
  actorId: string;
  /** Role of the actor at action time (null when unknown/system). */
  actorRole: string | null;
  /** What happened (e.g. `user.disable`, `schedule.create`). */
  action: string;
  /** Kind of resource acted on. */
  resourceType: FleetV25AuditResourceType;
  /** Id of the resource acted on. */
  resourceId: string;
  /** Outcome of the action. */
  result: FleetV25AuditResult;
  /** Human-readable detail (free text, no secrets — never log keys). */
  detail: string;
  /** Hash of the previous entry (`GENESIS` for seq 1 / after prune). */
  prevHash: string;
  /** SHA-256 hash of this entry's content (see `hashFleetV25AuditEntry`). */
  hash: string;
}

/** Input for appending an entry (hash + seq are computed). */
export interface FleetV25AuditAppendInput {
  actorId: string;
  actorRole?: string | null;
  action: string;
  resourceType: FleetV25AuditResourceType;
  resourceId: string;
  result: FleetV25AuditResult;
  detail?: string;
}

/** Filters for querying the log (all optional; combined with AND). */
export interface FleetV25AuditQuery {
  actorId?: string;
  action?: string;
  /** Prefix match on action (e.g. `schedule.` matches all schedule actions). */
  actionPrefix?: string;
  resourceType?: FleetV25AuditResourceType;
  resourceId?: string;
  result?: FleetV25AuditResult;
  fromMs?: number;
  toMs?: number;
  /** Max entries returned (newest-first when set with `newestFirst`). */
  limit?: number;
  /** When true, results come newest first (default: oldest first). */
  newestFirst?: boolean;
}

/** Result of verifying the chain. */
export interface FleetV25AuditVerifyResult {
  /** true when every checked entry's hash + link is correct. */
  ok: boolean;
  /** Number of entries checked. */
  checked: number;
  /** Sequence of the first bad entry (null when ok). */
  badSeq: number | null;
  /** Why verification failed (null when ok). */
  reason: string | null;
  /** true when the log was pruned (chain starts at a checkpoint). */
  pruned: boolean;
  /** Seq of the last pruned entry (0 when never pruned). */
  prunedBeforeSeq: number;
}

/** Per-action / per-actor summary counts. */
export interface FleetV25AuditSummary {
  total: number;
  byResult: Record<FleetV25AuditResult, number>;
  byAction: { action: string; count: number }[];
  byActor: { actorId: string; count: number }[];
  denied: number;
  failures: number;
  firstAtMs: number | null;
  lastAtMs: number | null;
}

/** Canonical JSON for one entry's hashable content (stable key order). */
export function fleetV25AuditEntryPayload(entry: Omit<FleetV25AuditEntry, 'hash'>): string {
  return JSON.stringify({
    seq: entry.seq,
    id: entry.id,
    atMs: entry.atMs,
    actorId: entry.actorId,
    actorRole: entry.actorRole,
    action: entry.action,
    resourceType: entry.resourceType,
    resourceId: entry.resourceId,
    result: entry.result,
    detail: entry.detail,
    prevHash: entry.prevHash,
  });
}

/** SHA-256 hex of an entry's content + its prevHash link. */
export function hashFleetV25AuditEntry(entry: Omit<FleetV25AuditEntry, 'hash'>): string {
  return createHash('sha256').update(fleetV25AuditEntryPayload(entry), 'utf8').digest('hex');
}

function cleanActor(actorId: unknown): string {
  if (typeof actorId !== 'string' || !actorId.trim()) {
    throw new Error('Audit actorId must be a non-empty string.');
  }
  return actorId.trim();
}

function cleanAction(action: unknown): string {
  if (typeof action !== 'string' || !action.trim()) {
    throw new Error('Audit action must be a non-empty string.');
  }
  const v = action.trim();
  if (v.length > 128) throw new Error('Audit action must be at most 128 characters.');
  return v;
}

function cleanResourceId(resourceId: unknown): string {
  if (typeof resourceId !== 'string' || !resourceId.trim()) {
    throw new Error('Audit resourceId must be a non-empty string.');
  }
  return resourceId.trim();
}

const RESOURCE_TYPES: readonly FleetV25AuditResourceType[] = [
  'user',
  'role',
  'automation',
  'schedule',
  'run',
  'audit',
  'cidr-rule',
  'fleet',
  'tool',
];

/** The append-only, hash-chained audit log. */
export class FleetV25AuditLog {
  private entries: FleetV25AuditEntry[] = [];
  private nextSeq = 1;
  /** Hash of the last pruned entry (genesis when never pruned). */
  private checkpointHash: string = FLEET_V25_AUDIT_GENESIS_HASH;
  /** Seq of the last pruned entry (0 when never pruned). */
  private prunedBeforeSeq = 0;

  /** Number of entries currently held. */
  get size(): number {
    return this.entries.length;
  }

  /** true when at least one entry was pruned (chain starts at checkpoint). */
  get pruned(): boolean {
    return this.prunedBeforeSeq > 0;
  }

  /** Append one entry. Returns the stored entry (with seq + hash). */
  append(input: FleetV25AuditAppendInput, nowMs: number): FleetV25AuditEntry {
    const prevHash = this.entries.length > 0
      ? this.entries[this.entries.length - 1].hash
      : this.checkpointHash;
    const base: Omit<FleetV25AuditEntry, 'hash'> = {
      seq: this.nextSeq,
      id: `audit-${this.nextSeq}`,
      atMs: nowMs,
      actorId: cleanActor(input.actorId),
      actorRole: input.actorRole?.trim() ? input.actorRole.trim() : null,
      action: cleanAction(input.action),
      resourceType: RESOURCE_TYPES.includes(input.resourceType)
        ? input.resourceType
        : (() => { throw new Error(`Unknown audit resource type: ${String(input.resourceType)}.`); })(),
      resourceId: cleanResourceId(input.resourceId),
      result: FLEET_V25_AUDIT_RESULTS.includes(input.result)
        ? input.result
        : (() => { throw new Error(`Unknown audit result: ${String(input.result)}.`); })(),
      detail: input.detail?.trim() ? input.detail.trim().slice(0, 2000) : '',
      prevHash,
    };
    const entry: FleetV25AuditEntry = { ...base, hash: hashFleetV25AuditEntry(base) };
    this.entries.push(entry);
    this.nextSeq += 1;
    return { ...entry };
  }

  /** All entries, oldest first (copies). */
  list(): FleetV25AuditEntry[] {
    return this.entries.map((e) => ({ ...e }));
  }

  /** Query entries with AND filters (see `FleetV25AuditQuery`). */
  query(q: FleetV25AuditQuery = {}): FleetV25AuditEntry[] {
    let out = this.entries.filter((e) => {
      if (q.actorId !== undefined && e.actorId !== q.actorId) return false;
      if (q.action !== undefined && e.action !== q.action) return false;
      if (q.actionPrefix !== undefined && !e.action.startsWith(q.actionPrefix)) return false;
      if (q.resourceType !== undefined && e.resourceType !== q.resourceType) return false;
      if (q.resourceId !== undefined && e.resourceId !== q.resourceId) return false;
      if (q.result !== undefined && e.result !== q.result) return false;
      if (q.fromMs !== undefined && e.atMs < q.fromMs) return false;
      if (q.toMs !== undefined && e.atMs > q.toMs) return false;
      return true;
    });
    out = out.map((e) => ({ ...e }));
    if (q.newestFirst) out.reverse();
    if (q.limit !== undefined) {
      if (q.limit < 0) throw new Error('Audit query limit must be >= 0.');
      out = out.slice(0, q.limit);
    }
    return out;
  }

  /** Entries for one resource (any action on it), oldest first. */
  forResource(resourceType: FleetV25AuditResourceType, resourceId: string): FleetV25AuditEntry[] {
    return this.query({ resourceType, resourceId });
  }

  /** Entries by one actor, newest first. */
  forActor(actorId: string, limit?: number): FleetV25AuditEntry[] {
    return this.query({ actorId, newestFirst: true, limit });
  }

  /** Denied attempts (permission denials), newest first. */
  denied(limit?: number): FleetV25AuditEntry[] {
    return this.query({ result: 'denied', newestFirst: true, limit });
  }

  /** Failed actions, newest first. */
  failures(limit?: number): FleetV25AuditEntry[] {
    return this.query({ result: 'failure', newestFirst: true, limit });
  }

  /**
   * Verify the hash chain: every entry's hash must match its content
   * and its prevHash must equal the previous entry's hash (or the
   * checkpoint hash for the first retained entry after a prune).
   */
  verify(): FleetV25AuditVerifyResult {
    let prev = this.checkpointHash;
    for (const entry of this.entries) {
      if (entry.prevHash !== prev) {
        return {
          ok: false,
          checked: this.entries.length,
          badSeq: entry.seq,
          reason: `Entry ${entry.seq} prevHash does not match the previous entry's hash (chain broken — entry deleted or reordered).`,
          pruned: this.pruned,
          prunedBeforeSeq: this.prunedBeforeSeq,
        };
      }
      const { hash, ...rest } = entry;
      if (hashFleetV25AuditEntry(rest) !== hash) {
        return {
          ok: false,
          checked: this.entries.length,
          badSeq: entry.seq,
          reason: `Entry ${entry.seq} hash does not match its content (entry was edited).`,
          pruned: this.pruned,
          prunedBeforeSeq: this.prunedBeforeSeq,
        };
      }
      prev = entry.hash;
    }
    return {
      ok: true,
      checked: this.entries.length,
      badSeq: null,
      reason: null,
      pruned: this.pruned,
      prunedBeforeSeq: this.prunedBeforeSeq,
    };
  }

  /**
   * Drop every entry with seq < `beforeSeq` (retention). Records a
   * checkpoint so `verify()` still proves the remaining chain. The
   * checkpoint entry itself is NOT added to the log — the checkpoint
   * hash + seq travel with the serialised form instead. Returns the
   * number of entries pruned.
   */
  pruneBeforeSeq(beforeSeq: number): number {
    if (beforeSeq <= 1) return 0;
    const kept = this.entries.filter((e) => e.seq >= beforeSeq);
    const pruned = this.entries.filter((e) => e.seq < beforeSeq);
    if (pruned.length === 0) return 0;
    this.checkpointHash = pruned[pruned.length - 1].hash;
    this.prunedBeforeSeq = pruned[pruned.length - 1].seq;
    this.entries = kept;
    return pruned.length;
  }

  /** Summary counts (actions/actors sorted by count desc, then name). */
  summary(): FleetV25AuditSummary {
    const byResult: Record<FleetV25AuditResult, number> = {
      success: 0,
      allowed: 0,
      denied: 0,
      failure: 0,
    };
    const byAction = new Map<string, number>();
    const byActor = new Map<string, number>();
    for (const e of this.entries) {
      byResult[e.result] += 1;
      byAction.set(e.action, (byAction.get(e.action) ?? 0) + 1);
      byActor.set(e.actorId, (byActor.get(e.actorId) ?? 0) + 1);
    }
    const sorted = (m: Map<string, number>): { action: string; count: number }[] =>
      [...m.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([action, count]) => ({ action, count }));
    const actors = [...byActor.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([actorId, count]) => ({ actorId, count }));
    return {
      total: this.entries.length,
      byResult,
      byAction: sorted(byAction),
      byActor: actors,
      denied: byResult.denied,
      failures: byResult.failure,
      firstAtMs: this.entries.length > 0 ? this.entries[0].atMs : null,
      lastAtMs: this.entries.length > 0 ? this.entries[this.entries.length - 1].atMs : null,
    };
  }

  /** Serialise the log (entries + checkpoint) as plain JSON. */
  toJSON(): {
    version: 1;
    entries: FleetV25AuditEntry[];
    checkpointHash: string;
    prunedBeforeSeq: number;
    nextSeq: number;
  } {
    return {
      version: 1,
      entries: this.list(),
      checkpointHash: this.checkpointHash,
      prunedBeforeSeq: this.prunedBeforeSeq,
      nextSeq: this.nextSeq,
    };
  }

  /** Serialise as JSONL (one entry per line) for file storage. */
  toJSONL(): string {
    return this.entries.map((e) => JSON.stringify(e)).join('\n') +
      (this.entries.length > 0 ? '\n' : '');
  }

  /** Load a serialised log. Re-validates the chain; throws when broken. */
  static fromJSON(data: unknown): FleetV25AuditLog {
    const log = new FleetV25AuditLog();
    if (!data || typeof data !== 'object') throw new Error('Invalid audit log JSON.');
    const d = data as {
      entries?: unknown;
      checkpointHash?: unknown;
      prunedBeforeSeq?: unknown;
      nextSeq?: unknown;
    };
    if (!Array.isArray(d.entries)) throw new Error('Invalid audit log JSON: entries must be an array.');
    if (typeof d.checkpointHash === 'string' && /^[0-9a-f]{64}$/.test(d.checkpointHash)) {
      log.checkpointHash = d.checkpointHash;
    }
    if (typeof d.prunedBeforeSeq === 'number') log.prunedBeforeSeq = d.prunedBeforeSeq;
    for (const raw of d.entries) {
      if (!raw || typeof raw !== 'object') throw new Error('Invalid audit entry in log JSON.');
      const e = raw as FleetV25AuditEntry;
      if (typeof e.seq !== 'number' || typeof e.hash !== 'string') {
        throw new Error('Invalid audit entry in log JSON: missing seq/hash.');
      }
      log.entries.push({ ...e });
    }
    log.entries.sort((a, b) => a.seq - b.seq);
    log.nextSeq = typeof d.nextSeq === 'number'
      ? d.nextSeq
      : (log.entries.length > 0 ? log.entries[log.entries.length - 1].seq + 1 : 1);
    const v = log.verify();
    if (!v.ok) throw new Error(`Invalid audit log JSON: chain broken at seq ${v.badSeq} (${v.reason}).`);
    return log;
  }
}

/** Create an empty audit log. */
export function createFleetV25AuditLog(): FleetV25AuditLog {
  return new FleetV25AuditLog();
}

/** One-line summary of the log (for the dashboard header). */
export function summarizeFleetV25Audit(log: FleetV25AuditLog): string {
  const s = log.summary();
  const verify = log.verify();
  return (
    `${s.total} audit ${s.total === 1 ? 'entry' : 'entries'} ` +
    `(${s.byResult.success} success, ${s.denied} denied, ${s.failures} failed; ` +
    `chain ${verify.ok ? 'valid' : `BROKEN at seq ${verify.badSeq}`}` +
    `${verify.pruned ? `, pruned before seq ${verify.prunedBeforeSeq}` : ''})`
  );
}
