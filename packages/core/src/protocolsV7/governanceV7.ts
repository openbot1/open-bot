/**
 * Protocols v7 — governance layer (v1.38, Team T2).
 *
 * Idea only, learned from the public protocol descriptions in
 * docs/repo-survey-v138.md: all five surveyed protocols lack a
 * governance layer — delegation, constraint and revocation
 * scored 2/12, and voting / dissent / human escalation are
 * absent everywhere. This module is open-bot's own layer on
 * top of them (versioned as `gov 1.0` in versions.ts):
 *
 *   - `GovV7PolicyEngine` — delegation grants: a delegator
 *     grants a delegate a scoped, expiring, optionally
 *     single-use permission; grants form a tree (a delegate
 *     may sub-delegate only within its own scope and depth).
 *   - Revocation: by grant id, by delegate, by scope, or
 *     cascading (revoking a grant revokes its whole subtree).
 *     Revocation is immediate and beats expiry.
 *   - Constraints: allow/deny scope lists, per-grant rate
 *     limits, time windows, and a spend cap that is ALWAYS
 *     zero (no money moves in open-bot — UCP is read-only).
 *   - `GovV7EscalationQueue` — human escalation: when a
 *     decision needs the user, the agent files a request; the
 *     user approves / denies; unanswered requests auto-deny
 *     at their deadline (never auto-approve).
 *   - `GovV7AuditLog` — append-only, hash-chained audit log:
 *     every grant / revoke / check / escalation is recorded,
 *     each entry chained to the previous hash, so tampering is
 *     detectable with `verifyChain()`.
 *
 * No code, text or asset from any other repo is copied here.
 * No network, no filesystem: the host mirrors the audit log.
 */

import { createHash, randomUUID } from 'node:crypto';

/** Error raised by the governance layer. */
export class GovV7Error extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'GovV7Error';
    this.code = code;
  }
}

/** A scope string: `family:operation` or `family:operation:target` (`*` = any). */
export type GovV7Scope = string;

/** Grant status. */
export type GovV7GrantStatus = 'active' | 'revoked' | 'expired' | 'exhausted';

/** Constraints attached to a grant. */
export interface GovV7GrantConstraints {
  /** Max uses per minute (undefined = unlimited). */
  maxUsesPerMinute?: number;
  /** Only these tenants (undefined = the grant's tenant only). */
  allowedTenants?: string[];
  /** Only during these UTC hour windows, e.g. [[9, 17]] (undefined = any time). */
  allowedHourWindowsUtc?: [number, number][];
  /** Spend cap in minor units — ALWAYS 0 in open-bot (no money moves). */
  spendCapMinor: 0;
}

/** A delegation grant. */
export interface GovV7Grant {
  id: string;
  /** Who granted (user id / agent id). */
  delegator: string;
  /** Who received the grant (agent id / tool id). */
  delegate: string;
  /** Scopes granted (e.g. `a2a:send`, `mcp:tools/call:*`). */
  scopes: GovV7Scope[];
  /** Tenant the grant applies to. */
  tenant: string;
  /** Parent grant id (sub-delegation) — null for root grants. */
  parentGrantId: string | null;
  /** Depth in the delegation tree (root = 0). */
  depth: number;
  /** Creation time (ms since epoch). */
  createdAtMs: number;
  /** Expiry (ms since epoch). */
  expiresAtMs: number;
  /** Max total uses (undefined = unlimited). */
  maxUses?: number;
  /** Uses consumed so far. */
  uses: number;
  /** Current status. */
  status: GovV7GrantStatus;
  /** Constraints on this grant. */
  constraints: GovV7GrantConstraints;
  /** Revocation reason (when revoked). */
  revokeReason?: string;
  /** Human-readable purpose (shown to the user). */
  purpose?: string;
}

/** Input for creating a grant. */
export interface GovV7GrantInput {
  delegator: string;
  delegate: string;
  scopes: GovV7Scope[];
  tenant: string;
  /** Lifetime in ms (default 1h, max 24h). */
  ttlMs?: number;
  /** Max total uses (undefined = unlimited). */
  maxUses?: number;
  /** Parent grant (for sub-delegation). */
  parentGrantId?: string;
  /** Extra constraints (spend cap is forced to 0). */
  constraints?: Omit<GovV7GrantConstraints, 'spendCapMinor'>;
  /** Human-readable purpose. */
  purpose?: string;
}

/** Max delegation depth (root = 0; deeper chains are refused). */
export const GOV_V7_MAX_DELEGATION_DEPTH = 3;
/** Default grant lifetime: 1 hour. */
export const GOV_V7_DEFAULT_GRANT_TTL_MS = 60 * 60 * 1000;
/** Max grant lifetime: 24 hours (grants are short-lived by design). */
export const GOV_V7_MAX_GRANT_TTL_MS = 24 * 60 * 60 * 1000;
/** Spend cap is always zero — no money moves. */
export const GOV_V7_SPEND_CAP_MINOR = 0 as const;

/**
 * True when a scope pattern covers an operation. Patterns are
 * colon-separated segments; `*` matches one segment, and a
 * trailing `*` matches the rest (`mcp:tools/call:*` covers
 * `mcp:tools/call:fs:read`).
 */
export function govV7ScopeMatches(pattern: string, operation: string): boolean {
  const p = pattern.split(':');
  const o = operation.split(':');
  for (let i = 0; i < p.length; i += 1) {
    if (p[i] === '*') return true;
    if (i >= o.length || p[i] !== o[i]) return false;
  }
  return p.length === o.length;
}

/** True when every scope in `needed` is covered by some scope in `granted`. */
export function govV7ScopesCover(granted: readonly string[], needed: readonly string[]): boolean {
  return needed.every((n) => granted.some((g) => govV7ScopeMatches(g, n)));
}

/** One audit log entry (hash-chained). */
export interface GovV7AuditEntry {
  /** Sequence number (0-based, gapless). */
  seq: number;
  /** Entry time (ms since epoch). */
  atMs: number;
  /** What happened: grant / revoke / check / escalate / … */
  kind: string;
  /** Actor (user / agent / system). */
  actor: string;
  /** Grant / escalation id the entry is about (when any). */
  subjectId?: string;
  /** Tenant the entry is about. */
  tenant?: string;
  /** Outcome: allowed / denied / granted / revoked / … */
  outcome: string;
  /** Free-text detail (never credentials, never secrets). */
  detail?: string;
  /** SHA-256 hex of the previous entry ('' for seq 0). */
  prevHash: string;
  /** SHA-256 hex of this entry (canonical JSON + prevHash). */
  hash: string;
}

/** Canonical JSON for hashing (sorted keys, no whitespace). */
export function govV7CanonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((v) => govV7CanonicalJson(v)).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${govV7CanonicalJson(obj[k])}`).join(',')}}`;
}

/** Hash one audit entry (without its own `hash` field). */
export function govV7HashEntry(entry: Omit<GovV7AuditEntry, 'hash'>): string {
  const { hash: _ignored, ...rest } = entry as GovV7AuditEntry & { hash?: string };
  void _ignored;
  return createHash('sha256').update(govV7CanonicalJson(rest), 'utf-8').digest('hex');
}

/**
 * Append-only, hash-chained audit log. Entries are immutable
 * once appended; `verifyChain()` detects any tampering.
 */
export class GovV7AuditLog {
  private entries: GovV7AuditEntry[] = [];

  /** Number of entries. */
  size(): number {
    return this.entries.length;
  }

  /** Append an entry (hash-chained to the previous one). */
  append(entry: {
    kind: string;
    actor: string;
    subjectId?: string;
    tenant?: string;
    outcome: string;
    detail?: string;
    atMs?: number;
  }): GovV7AuditEntry {
    const prevHash = this.entries.length === 0 ? '' : this.entries[this.entries.length - 1].hash;
    // Omit undefined fields so the entry is JSON-stable: the hash
    // must survive a snapshot round-trip (JSON drops undefined).
    const base: Omit<GovV7AuditEntry, 'hash'> = {
      seq: this.entries.length,
      atMs: entry.atMs ?? Date.now(),
      kind: entry.kind,
      actor: entry.actor,
      outcome: entry.outcome,
      prevHash,
      ...(entry.subjectId !== undefined ? { subjectId: entry.subjectId } : {}),
      ...(entry.tenant !== undefined ? { tenant: entry.tenant } : {}),
      ...(entry.detail !== undefined ? { detail: entry.detail } : {}),
    };
    const hash = govV7HashEntry(base);
    const full: GovV7AuditEntry = { ...base, hash };
    this.entries.push(full);
    return { ...full };
  }

  /** All entries (copies, oldest first). */
  list(): GovV7AuditEntry[] {
    return this.entries.map((e) => ({ ...e }));
  }

  /** Entries filtered by kind / actor / tenant / subject. */
  filter(filter: {
    kind?: string;
    actor?: string;
    tenant?: string;
    subjectId?: string;
    outcome?: string;
  }): GovV7AuditEntry[] {
    return this.entries
      .filter((e) =>
        (filter.kind === undefined || e.kind === filter.kind)
        && (filter.actor === undefined || e.actor === filter.actor)
        && (filter.tenant === undefined || e.tenant === filter.tenant)
        && (filter.subjectId === undefined || e.subjectId === filter.subjectId)
        && (filter.outcome === undefined || e.outcome === filter.outcome))
      .map((e) => ({ ...e }));
  }

  /** Verify the whole hash chain (returns the first bad seq, or -1 when clean). */
  verifyChain(): { ok: boolean; badSeq: number; reason: string } {
    for (let i = 0; i < this.entries.length; i += 1) {
      const entry = this.entries[i];
      if (entry.seq !== i) {
        return { ok: false, badSeq: i, reason: `Entry seq is ${entry.seq}, expected ${i}.` };
      }
      const expectedPrev = i === 0 ? '' : this.entries[i - 1].hash;
      if (entry.prevHash !== expectedPrev) {
        return { ok: false, badSeq: i, reason: `Entry ${i} prevHash does not match entry ${i - 1} hash.` };
      }
      const recomputed = govV7HashEntry(entry);
      if (recomputed !== entry.hash) {
        return { ok: false, badSeq: i, reason: `Entry ${i} hash does not match its contents (tampered).` };
      }
    }
    return { ok: true, badSeq: -1, reason: `Chain verified: ${this.entries.length} entries.` };
  }

  /** Serialise the log as JSON (host mirrors it to disk). */
  snapshot(): string {
    return JSON.stringify(this.entries, null, 2);
  }

  /** Restore from a snapshot (validates the chain; throws on tampering). */
  restore(snapshotJson: string): number {
    let parsed: unknown;
    try {
      parsed = JSON.parse(snapshotJson) as unknown;
    } catch {
      throw new GovV7Error('bad-snapshot', 'Audit snapshot is not valid JSON.');
    }
    if (!Array.isArray(parsed)) {
      throw new GovV7Error('bad-snapshot', 'Audit snapshot must be a JSON array of entries.');
    }
    const next = parsed as GovV7AuditEntry[];
    for (const entry of next) {
      if (typeof entry !== 'object' || entry === null || typeof entry.hash !== 'string') {
        throw new GovV7Error('bad-snapshot', 'Audit snapshot entries must be entry objects with a hash.');
      }
    }
    const old = this.entries;
    this.entries = next.map((e) => ({ ...e }));
    const check = this.verifyChain();
    if (!check.ok) {
      this.entries = old;
      throw new GovV7Error('tampered-snapshot', `Audit snapshot failed verification: ${check.reason}`);
    }
    return this.entries.length;
  }
}

/** Escalation request status. */
export type GovV7EscalationStatus = 'pending' | 'approved' | 'denied' | 'expired';

/** A human-escalation request (agent asks the user to decide). */
export interface GovV7Escalation {
  id: string;
  /** Agent / delegate that filed the request. */
  requester: string;
  /** Operation that needs a human decision. */
  operation: string;
  /** Why the agent cannot decide alone (shown to the user). */
  reason: string;
  /** Tenant the operation belongs to. */
  tenant: string;
  /** Grant the request relates to (when any). */
  grantId?: string;
  /** Full context for the user (JSON-able, never credentials). */
  context?: Record<string, unknown>;
  /** Current status. */
  status: GovV7EscalationStatus;
  /** Creation time (ms since epoch). */
  createdAtMs: number;
  /** Deadline (ms since epoch) — unanswered requests auto-deny. */
  deadlineMs: number;
  /** Resolution time (ms since epoch). */
  resolvedAtMs?: number;
  /** Who resolved it (user id). */
  resolvedBy?: string;
  /** User's note on resolution. */
  resolutionNote?: string;
}

/** Default escalation deadline: 15 minutes (then auto-deny). */
export const GOV_V7_DEFAULT_ESCALATION_TTL_MS = 15 * 60 * 1000;

/**
 * Human-escalation queue: agents file requests, users resolve
 * them. Unanswered requests auto-deny at their deadline —
 * never auto-approve.
 */
export class GovV7EscalationQueue {
  private requests = new Map<string, GovV7Escalation>();

  /** File a request (returns the created request). */
  file(input: {
    requester: string;
    operation: string;
    reason: string;
    tenant: string;
    grantId?: string;
    context?: Record<string, unknown>;
    ttlMs?: number;
    createdAtMs?: number;
  }): GovV7Escalation {
    if (!input.requester || !input.operation || !input.reason) {
      throw new GovV7Error('invalid-escalation', 'Escalation needs a requester, an operation and a reason.');
    }
    const now = input.createdAtMs ?? Date.now();
    const ttl = input.ttlMs ?? GOV_V7_DEFAULT_ESCALATION_TTL_MS;
    if (!Number.isFinite(ttl) || ttl <= 0) {
      throw new GovV7Error('invalid-escalation', 'Escalation TTL must be positive.');
    }
    const request: GovV7Escalation = {
      id: `esc-${randomUUID()}`,
      requester: input.requester,
      operation: input.operation,
      reason: input.reason,
      tenant: input.tenant,
      grantId: input.grantId,
      context: input.context ? { ...input.context } : undefined,
      status: 'pending',
      createdAtMs: now,
      deadlineMs: now + ttl,
    };
    this.requests.set(request.id, request);
    return { ...request };
  }

  /** Get a request (null when missing). */
  get(id: string): GovV7Escalation | null {
    const req = this.requests.get(id);
    return req ? { ...req } : null;
  }

  /** Pending requests (oldest first), optionally for one tenant. */
  pending(tenant?: string): GovV7Escalation[] {
    return [...this.requests.values()]
      .filter((r) => r.status === 'pending' && (tenant === undefined || r.tenant === tenant))
      .sort((a, b) => a.createdAtMs - b.createdAtMs)
      .map((r) => ({ ...r }));
  }

  /** All requests (newest first). */
  list(tenant?: string): GovV7Escalation[] {
    return [...this.requests.values()]
      .filter((r) => tenant === undefined || r.tenant === tenant)
      .sort((a, b) => b.createdAtMs - a.createdAtMs)
      .map((r) => ({ ...r }));
  }

  /** Approve a pending request (only the user resolves requests). */
  approve(id: string, resolvedBy: string, note?: string): GovV7Escalation {
    return this.resolve(id, 'approved', resolvedBy, note);
  }

  /** Deny a pending request. */
  deny(id: string, resolvedBy: string, note?: string): GovV7Escalation {
    return this.resolve(id, 'denied', resolvedBy, note);
  }

  private resolve(id: string, status: 'approved' | 'denied', resolvedBy: string, note?: string): GovV7Escalation {
    const req = this.requests.get(id);
    if (!req) throw new GovV7Error('escalation-not-found', `Escalation ${id} does not exist.`);
    if (req.status !== 'pending') {
      throw new GovV7Error('escalation-resolved', `Escalation ${id} is already ${req.status}.`);
    }
    if (!resolvedBy) throw new GovV7Error('invalid-resolver', 'Escalation needs a resolver (user id).');
    req.status = status;
    req.resolvedAtMs = Date.now();
    req.resolvedBy = resolvedBy;
    req.resolutionNote = note;
    return { ...req };
  }

  /** Auto-deny pending requests past their deadline (returns how many). */
  sweepExpired(nowMs: number = Date.now()): number {
    let n = 0;
    for (const req of this.requests.values()) {
      if (req.status === 'pending' && nowMs > req.deadlineMs) {
        req.status = 'expired';
        req.resolvedAtMs = nowMs;
        req.resolutionNote = 'Auto-denied: no human decision before the deadline.';
        n += 1;
      }
    }
    return n;
  }

  /** Number of pending requests. */
  pendingCount(tenant?: string): number {
    return this.pending(tenant).length;
  }
}

/** Result of a policy check. */
export interface GovV7CheckResult {
  allowed: boolean;
  /** Grant that allowed it (when allowed). */
  grantId?: string;
  /** Why (one line, for the UI / audit). */
  reason: string;
  /** True when the caller should escalate to the user instead. */
  needsEscalation: boolean;
}

/**
 * Policy engine: grants + constraints + revocation + audit.
 * One entry point — `authorize()` — answers "may this delegate
 * do this operation now?" and records the answer.
 */
export class GovV7PolicyEngine {
  private grants = new Map<string, GovV7Grant>();
  private audit: GovV7AuditLog;
  private useWindows = new Map<string, number[]>();

  constructor(audit: GovV7AuditLog = new GovV7AuditLog()) {
    this.audit = audit;
  }

  /** The audit log this engine writes to. */
  getAuditLog(): GovV7AuditLog {
    return this.audit;
  }

  /** Create a grant (root, or a sub-grant within a parent's scope). */
  grant(input: GovV7GrantInput, nowMs: number = Date.now()): GovV7Grant {
    if (!input.delegator || !input.delegate) {
      throw new GovV7Error('invalid-grant', 'A grant needs a delegator and a delegate.');
    }
    if (input.delegator === input.delegate) {
      throw new GovV7Error('invalid-grant', 'A grant cannot delegate to itself.');
    }
    if (!Array.isArray(input.scopes) || input.scopes.length === 0
      || input.scopes.some((s) => typeof s !== 'string' || s.length === 0)) {
      throw new GovV7Error('invalid-grant', 'A grant needs at least one non-empty scope.');
    }
    const ttl = input.ttlMs ?? GOV_V7_DEFAULT_GRANT_TTL_MS;
    if (!Number.isFinite(ttl) || ttl <= 0 || ttl > GOV_V7_MAX_GRANT_TTL_MS) {
      throw new GovV7Error('invalid-grant', `Grant TTL must be 1–${GOV_V7_MAX_GRANT_TTL_MS} ms (max 24h).`);
    }
    let depth = 0;
    let parent: GovV7Grant | undefined;
    if (input.parentGrantId) {
      parent = this.grants.get(input.parentGrantId);
      if (!parent) throw new GovV7Error('parent-not-found', `Parent grant ${input.parentGrantId} does not exist.`);
      if (parent.status !== 'active') {
        throw new GovV7Error('parent-inactive', `Parent grant ${input.parentGrantId} is ${parent.status}.`);
      }
      if (parent.delegate !== input.delegator) {
        throw new GovV7Error('parent-mismatch', 'Only the parent grant\'s delegate may sub-delegate from it.');
      }
      if (!govV7ScopesCover(parent.scopes, input.scopes)) {
        throw new GovV7Error('scope-exceeds-parent', 'A sub-grant cannot exceed its parent grant\'s scopes.');
      }
      if (parent.tenant !== input.tenant) {
        throw new GovV7Error('tenant-mismatch', 'A sub-grant must stay in its parent grant\'s tenant.');
      }
      depth = parent.depth + 1;
      if (depth > GOV_V7_MAX_DELEGATION_DEPTH) {
        throw new GovV7Error('depth-exceeded', `Delegation depth ${depth} exceeds the max of ${GOV_V7_MAX_DELEGATION_DEPTH}.`);
      }
    }
    const grant: GovV7Grant = {
      id: `grant-${randomUUID()}`,
      delegator: input.delegator,
      delegate: input.delegate,
      scopes: [...input.scopes],
      tenant: input.tenant,
      parentGrantId: input.parentGrantId ?? null,
      depth,
      createdAtMs: nowMs,
      expiresAtMs: nowMs + ttl,
      maxUses: input.maxUses,
      uses: 0,
      status: 'active',
      constraints: {
        maxUsesPerMinute: input.constraints?.maxUsesPerMinute,
        allowedTenants: input.constraints?.allowedTenants ? [...input.constraints.allowedTenants] : undefined,
        allowedHourWindowsUtc: input.constraints?.allowedHourWindowsUtc
          ? input.constraints.allowedHourWindowsUtc.map(([a, b]) => [a, b] as [number, number])
          : undefined,
        spendCapMinor: GOV_V7_SPEND_CAP_MINOR,
      },
      purpose: input.purpose,
    };
    this.grants.set(grant.id, grant);
    this.audit.append({
      kind: 'grant',
      actor: input.delegator,
      subjectId: grant.id,
      tenant: grant.tenant,
      outcome: 'granted',
      detail: `${input.delegator} -> ${input.delegate}: ${grant.scopes.join(', ')} (depth ${depth}, ttl ${ttl}ms)`,
      atMs: nowMs,
    });
    return { ...grant, scopes: [...grant.scopes] };
  }

  /** Get a grant (null when missing). */
  getGrant(id: string): GovV7Grant | null {
    const grant = this.grants.get(id);
    return grant ? { ...grant, scopes: [...grant.scopes] } : null;
  }

  /** Grants for one delegate (optionally filtered by status). */
  grantsFor(delegate: string, status?: GovV7GrantStatus): GovV7Grant[] {
    return [...this.grants.values()]
      .filter((g) => g.delegate === delegate && (status === undefined || g.status === status))
      .map((g) => ({ ...g, scopes: [...g.scopes] }));
  }

  /** Grants in one tenant. */
  grantsInTenant(tenant: string): GovV7Grant[] {
    return [...this.grants.values()]
      .filter((g) => g.tenant === tenant)
      .map((g) => ({ ...g, scopes: [...g.scopes] }));
  }

  /** Children of a grant (direct sub-delegations). */
  childrenOf(grantId: string): GovV7Grant[] {
    return [...this.grants.values()]
      .filter((g) => g.parentGrantId === grantId)
      .map((g) => ({ ...g, scopes: [...g.scopes] }));
  }

  /** Revoke one grant (no cascade). */
  revoke(grantId: string, actor: string, reason?: string): boolean {
    const grant = this.grants.get(grantId);
    if (!grant || grant.status === 'revoked') return false;
    grant.status = 'revoked';
    grant.revokeReason = reason;
    this.audit.append({
      kind: 'revoke',
      actor,
      subjectId: grantId,
      tenant: grant.tenant,
      outcome: 'revoked',
      detail: reason ?? 'Revoked.',
    });
    return true;
  }

  /** Revoke a grant and its whole subtree (cascade). Returns how many were revoked. */
  revokeCascade(grantId: string, actor: string, reason?: string): number {
    const grant = this.grants.get(grantId);
    if (!grant) return 0;
    let n = 0;
    const queue: GovV7Grant[] = [grant];
    while (queue.length > 0) {
      const current = queue.shift() as GovV7Grant;
      if (current.status !== 'revoked') {
        current.status = 'revoked';
        current.revokeReason = reason ?? 'Revoked (cascade).';
        n += 1;
      }
      for (const child of this.childrenOf(current.id)) queue.push(this.grants.get(child.id) as GovV7Grant);
    }
    this.audit.append({
      kind: 'revoke',
      actor,
      subjectId: grantId,
      tenant: grant.tenant,
      outcome: 'revoked-cascade',
      detail: `${reason ?? 'Revoked (cascade).'} ${n} grant(s) revoked.`,
    });
    return n;
  }

  /** Revoke every grant of one delegate (returns how many). */
  revokeByDelegate(delegate: string, actor: string, reason?: string): number {
    let n = 0;
    for (const grant of this.grants.values()) {
      if (grant.delegate === delegate && grant.status !== 'revoked') {
        grant.status = 'revoked';
        grant.revokeReason = reason ?? `Delegate ${delegate} revoked.`;
        n += 1;
      }
    }
    if (n > 0) {
      this.audit.append({
        kind: 'revoke',
        actor,
        subjectId: delegate,
        outcome: 'revoked-by-delegate',
        detail: `${reason ?? `Delegate ${delegate} revoked.`} ${n} grant(s) revoked.`,
      });
    }
    return n;
  }

  /** Revoke every grant covering a scope (returns how many). */
  revokeByScope(scope: string, actor: string, reason?: string): number {
    let n = 0;
    for (const grant of this.grants.values()) {
      if (grant.status !== 'revoked' && grant.scopes.some((s) => govV7ScopeMatches(s, scope) || govV7ScopeMatches(scope, s))) {
        grant.status = 'revoked';
        grant.revokeReason = reason ?? `Scope ${scope} revoked.`;
        n += 1;
      }
    }
    if (n > 0) {
      this.audit.append({
        kind: 'revoke',
        actor,
        subjectId: scope,
        outcome: 'revoked-by-scope',
        detail: `${reason ?? `Scope ${scope} revoked.`} ${n} grant(s) revoked.`,
      });
    }
    return n;
  }

  /** Mark expired / exhausted grants (sweep; returns how many changed status). */
  sweep(nowMs: number = Date.now()): number {
    let n = 0;
    for (const grant of this.grants.values()) {
      if (grant.status !== 'active') continue;
      if (nowMs > grant.expiresAtMs) {
        grant.status = 'expired';
        n += 1;
      } else if (grant.maxUses !== undefined && grant.uses >= grant.maxUses) {
        grant.status = 'exhausted';
        n += 1;
      }
    }
    return n;
  }

  /**
   * Authorize: may `delegate` do `operation` in `tenant` now?
   * Checks grants (scope + tenant + expiry + uses + rate limit
   * + time window), records the check in the audit log, and
   * consumes one use on success. A denied check reports
   * whether the caller should escalate to the user instead.
   */
  authorize(input: {
    delegate: string;
    operation: string;
    tenant: string;
    grantId?: string;
    nowMs?: number;
  }): GovV7CheckResult {
    const nowMs = input.nowMs ?? Date.now();
    // Live grants (not copies): authorize consumes a use and may
    // flip the status to exhausted — that must persist.
    const candidates = input.grantId
      ? [this.grants.get(input.grantId)].filter((g): g is GovV7Grant => g !== undefined)
      : [...this.grants.values()].filter((g) => g.delegate === input.delegate && g.status === 'active');
    const denied = (reason: string, needsEscalation: boolean, grantId?: string): GovV7CheckResult => {
      this.audit.append({
        kind: 'check',
        actor: input.delegate,
        subjectId: grantId,
        tenant: input.tenant,
        outcome: 'denied',
        detail: `${input.operation}: ${reason}`,
        atMs: nowMs,
      });
      return { allowed: false, reason, needsEscalation, grantId };
    };
    if (candidates.length === 0) {
      return denied(`No active grant for delegate "${input.delegate}".`, true);
    }
    for (const grant of candidates) {
      if (grant.tenant !== input.tenant) continue;
      if (grant.status !== 'active') continue;
      if (nowMs > grant.expiresAtMs) {
        grant.status = 'expired';
        continue;
      }
      if (grant.maxUses !== undefined && grant.uses >= grant.maxUses) {
        grant.status = 'exhausted';
        continue;
      }
      if (!govV7ScopesCover(grant.scopes, [input.operation])) continue;
      const constraint = this.checkConstraints(grant, input.tenant, nowMs);
      if (!constraint.ok) {
        return denied(constraint.reason, constraint.needsEscalation, grant.id);
      }
      grant.uses += 1;
      this.recordUse(grant.id, nowMs);
      if (grant.maxUses !== undefined && grant.uses >= grant.maxUses) grant.status = 'exhausted';
      this.audit.append({
        kind: 'check',
        actor: input.delegate,
        subjectId: grant.id,
        tenant: input.tenant,
        outcome: 'allowed',
        detail: `${input.operation} allowed by grant ${grant.id} (use ${grant.uses}${grant.maxUses !== undefined ? `/${grant.maxUses}` : ''}).`,
        atMs: nowMs,
      });
      return { allowed: true, grantId: grant.id, reason: `Allowed by grant ${grant.id}.`, needsEscalation: false };
    }
    return denied(`No active grant of "${input.delegate}" covers "${input.operation}" in tenant "${input.tenant}".`, true);
  }

  private checkConstraints(
    grant: GovV7Grant,
    tenant: string,
    nowMs: number,
  ): { ok: boolean; reason: string; needsEscalation: boolean } {
    const c = grant.constraints;
    if (c.allowedTenants !== undefined && !c.allowedTenants.includes(tenant)) {
      return { ok: false, reason: `Grant ${grant.id} does not allow tenant "${tenant}".`, needsEscalation: false };
    }
    if (c.allowedHourWindowsUtc !== undefined && c.allowedHourWindowsUtc.length > 0) {
      const hour = new Date(nowMs).getUTCHours();
      const inside = c.allowedHourWindowsUtc.some(([from, to]) => hour >= from && hour < to);
      if (!inside) {
        return { ok: false, reason: `Grant ${grant.id} is outside its allowed hours (UTC ${hour}).`, needsEscalation: true };
      }
    }
    if (c.maxUsesPerMinute !== undefined) {
      const windowStart = nowMs - 60_000;
      const uses = (this.useWindows.get(grant.id) ?? []).filter((t) => t > windowStart);
      if (uses.length >= c.maxUsesPerMinute) {
        return { ok: false, reason: `Grant ${grant.id} hit its rate limit (${c.maxUsesPerMinute}/minute).`, needsEscalation: false };
      }
    }
    return { ok: true, reason: '', needsEscalation: false };
  }

  private recordUse(grantId: string, nowMs: number): void {
    const uses = this.useWindows.get(grantId) ?? [];
    uses.push(nowMs);
    this.useWindows.set(grantId, uses.filter((t) => t > nowMs - 60_000));
  }

  /** Counts by status (for the UI). */
  countsByStatus(): Record<GovV7GrantStatus, number> {
    const counts: Record<GovV7GrantStatus, number> = { active: 0, revoked: 0, expired: 0, exhausted: 0 };
    for (const grant of this.grants.values()) counts[grant.status] += 1;
    return counts;
  }
}

/**
 * One-line summary of a grant, for logs and the UI.
 * (Spend is never shown — it is always zero.)
 */
export function summarizeGovV7Grant(grant: GovV7Grant): string {
  return `${grant.id} ${grant.delegator} -> ${grant.delegate} [${grant.tenant}] ${grant.status} — ${grant.scopes.join(', ')} — ${grant.uses}${grant.maxUses !== undefined ? `/${grant.maxUses}` : ''} uses`;
}
