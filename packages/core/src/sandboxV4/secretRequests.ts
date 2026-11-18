/**
 * Sandbox v4 — secret requests (v1.36, Team T4).
 *
 * An agent that needs a credential mid-conversation does not
 * ask for it in chat and never sees it in a log: it opens a
 * secret request. The user (or an approved vault flow) fulfils
 * the request out of band; the agent then *consumes* the value
 * exactly once, and the value is gone from memory afterwards.
 *
 * The iron rule, enforced by construction, not by convention:
 *
 *  - The value lives ONLY in one in-memory `Map` (never on
 *    disk, never in a request object, never in an audit entry).
 *  - `describe` / `list` / `auditLog` return metadata only.
 *  - `redactText` scrubs every live value out of text before
 *    that text is logged or stored in context/history. After a
 *    value is consumed it is gone from the manager entirely, so
 *    callers must redact before consuming, never after.
 *  - Consuming is single-use: the second `consume` throws.
 *  - Pending requests expire (default 15 minutes); the sweep
 *    marks them `expired` and drops any value that was somehow
 *    attached (there never is one — fulfil moves pending →
 *    fulfilled only, and consume is the only read path).
 *
 * The audit log is hash-chained (each entry hashes the previous
 * entry's hash + its own metadata) so a tampered log is
 * detectable with `verifyAuditChain`. Audit entries carry
 * request id, actor and event only — never a value, never even
 * a value length (lengths leak information about the secret).
 */

import { createHash, randomUUID } from 'node:crypto';
import type { SandboxV4SecretAuditEntry, SandboxV4SecretRequest, SandboxV4SecretRequestStatus } from './types';

/** Default time-to-live for a pending secret request: 15 minutes. */
export const SANDBOX_V4_SECRET_DEFAULT_TTL_MS = 15 * 60 * 1000;

/** Hard maximum TTL: 1 hour. */
export const SANDBOX_V4_SECRET_MAX_TTL_MS = 60 * 60 * 1000;

/** Maximum secret name length. */
export const SANDBOX_V4_SECRET_NAME_MAX = 128;

/** Maximum purpose length. */
export const SANDBOX_V4_SECRET_PURPOSE_MAX = 1000;

/** Maximum stored secret value length (chars). Longer values are refused. */
export const SANDBOX_V4_SECRET_VALUE_MAX = 16_384;

/** Placeholder written where a secret value was scrubbed. */
export const SANDBOX_V4_REDACTED = '[REDACTED SECRET]';

/** Request name pattern: letters, digits, `_`, `-`, `.` (no spaces, no slashes). */
export const SANDBOX_V4_SECRET_NAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

/** Validate a secret request's name + purpose. Returns problems. */
export function validateSandboxV4SecretRequest(input: { name?: unknown; purpose?: unknown }): string[] {
  const problems: string[] = [];
  if (typeof input.name !== 'string' || !SANDBOX_V4_SECRET_NAME_PATTERN.test(input.name)) {
    problems.push('Secret name must be a slug (letters, digits, "_", "-", ".", max 128 chars).');
  }
  if (typeof input.purpose !== 'string' || input.purpose.trim() === '') {
    problems.push('Secret purpose must be a non-empty string.');
  } else if (input.purpose.length > SANDBOX_V4_SECRET_PURPOSE_MAX) {
    problems.push(`Secret purpose must be at most ${SANDBOX_V4_SECRET_PURPOSE_MAX} characters.`);
  }
  return problems;
}

function hashEntry(prevHash: string, seq: number, atMs: number, requestId: string, event: string, actor: string, detail: string): string {
  return createHash('sha256')
    .update(`${prevHash}|${seq}|${atMs}|${requestId}|${event}|${actor}|${detail}`)
    .digest('hex');
}

export interface SandboxV4SecretRequestOptions {
  /** Time-to-live for pending requests in ms (default 15 min, clamped to 1h). */
  ttlMs?: number;
  /** Clock override (tests). Default `Date.now`. */
  nowMs?: () => number;
}

export interface SandboxV4SecretRequestInput {
  conversationId: string;
  name: string;
  purpose: string;
  requestedBy?: string;
}

/**
 * Secret request manager. One instance per host process (shared
 * by all conversations — requests are scoped by conversationId).
 * The value store is in-memory only and is never serialised.
 */
export class SandboxV4SecretRequestManager {
  private readonly requests = new Map<string, SandboxV4SecretRequest>();
  /** Live values, keyed by request id. NEVER serialised, NEVER logged. */
  private readonly values = new Map<string, string>();
  private readonly audit: SandboxV4SecretAuditEntry[] = [];
  private readonly ttlMs: number;
  private readonly nowMs: () => number;

  constructor(options: SandboxV4SecretRequestOptions = {}) {
    const requested = options.ttlMs ?? SANDBOX_V4_SECRET_DEFAULT_TTL_MS;
    this.ttlMs = Math.min(Math.max(Math.floor(requested), 1000), SANDBOX_V4_SECRET_MAX_TTL_MS);
    this.nowMs = options.nowMs ?? Date.now;
  }

  /** TTL for pending requests in ms. */
  getTtlMs(): number {
    return this.ttlMs;
  }

  /** Number of requests tracked (all statuses). */
  size(): number {
    return this.requests.size;
  }

  /** Number of live (unconsumed) secret values currently in memory. */
  liveValueCount(): number {
    return this.values.size;
  }

  /** Open a new secret request. Returns the request (metadata only). */
  request(input: SandboxV4SecretRequestInput): SandboxV4SecretRequest {
    const problems = validateSandboxV4SecretRequest(input);
    if (problems.length > 0) {
      throw new Error(`Invalid secret request: ${problems.join(' ')}`);
    }
    if (typeof input.conversationId !== 'string' || input.conversationId === '') {
      throw new Error('Secret request needs a non-empty conversationId.');
    }
    const now = this.nowMs();
    const request: SandboxV4SecretRequest = {
      id: randomUUID(),
      conversationId: input.conversationId,
      name: input.name,
      purpose: input.purpose.trim(),
      requestedBy: input.requestedBy ?? '',
      status: 'pending',
      createdAtMs: now,
      expiresAtMs: now + this.ttlMs,
      resolvedAtMs: 0,
      resolvedBy: '',
      note: '',
    };
    this.requests.set(request.id, request);
    this.appendAudit(request.id, 'requested', input.requestedBy ?? 'agent', `Secret "${request.name}" requested for ${request.conversationId}.`);
    return this.describe(request.id) as SandboxV4SecretRequest;
  }

  /** Resolve one request (metadata only — never the value). */
  describe(requestId: string): SandboxV4SecretRequest | undefined {
    const found = this.requests.get(requestId);
    if (!found) return undefined;
    return { ...found };
  }

  /** All requests for a conversation, oldest first (metadata only). */
  listForConversation(conversationId: string): SandboxV4SecretRequest[] {
    return [...this.requests.values()]
      .filter((r) => r.conversationId === conversationId)
      .sort((a, b) => a.createdAtMs - b.createdAtMs)
      .map((r) => ({ ...r }));
  }

  /** Pending requests for a conversation (metadata only). */
  listPending(conversationId?: string): SandboxV4SecretRequest[] {
    return [...this.requests.values()]
      .filter((r) => r.status === 'pending' && (conversationId === undefined || r.conversationId === conversationId))
      .sort((a, b) => a.createdAtMs - b.createdAtMs)
      .map((r) => ({ ...r }));
  }

  /**
   * Fulfil a pending request with a secret value. The value is
   * stored in memory only; the returned request carries no value.
   * Throws when the request is unknown, not pending, or expired.
   * Empty values and over-long values are refused.
   */
  fulfill(requestId: string, value: string, resolvedBy = 'user'): SandboxV4SecretRequest {
    const request = this.requireRequest(requestId);
    this.sweepOne(request);
    if (request.status !== 'pending') {
      throw new Error(`Secret request "${requestId}" is ${request.status}, not pending.`);
    }
    if (typeof value !== 'string' || value === '') {
      throw new Error('Secret value must be a non-empty string.');
    }
    if (value.length > SANDBOX_V4_SECRET_VALUE_MAX) {
      throw new Error(`Secret value must be at most ${SANDBOX_V4_SECRET_VALUE_MAX} characters.`);
    }
    const now = this.nowMs();
    request.status = 'fulfilled';
    request.resolvedAtMs = now;
    request.resolvedBy = resolvedBy;
    this.values.set(requestId, value);
    this.appendAudit(requestId, 'fulfilled', resolvedBy, `Secret "${request.name}" fulfilled.`);
    return { ...request };
  }

  /**
   * Consume a fulfilled secret value — single-use. Returns the
   * value and deletes it from memory. The second consume throws.
   * Callers must use the value immediately and never log it.
   */
  consume(requestId: string, actor = 'agent'): string {
    const request = this.requireRequest(requestId);
    if (request.status !== 'fulfilled') {
      throw new Error(`Secret request "${requestId}" is ${request.status}; only a fulfilled request can be consumed.`);
    }
    const value = this.values.get(requestId);
    if (value === undefined) {
      throw new Error(`Secret value for request "${requestId}" is gone (already consumed).`);
    }
    // Single-use: the live value is gone from this point on.
    // Nothing of the plaintext remains in the manager afterwards:
    // `values` is the only place it ever lived.
    this.values.delete(requestId);
    this.appendAudit(requestId, 'consumed', actor, `Secret "${request.name}" consumed once.`);
    return value;
  }

  /** True when a fulfilled value is waiting to be consumed. */
  hasLiveValue(requestId: string): boolean {
    return this.values.has(requestId);
  }

  /** Deny a pending request (operator note, never a value). */
  deny(requestId: string, note = '', resolvedBy = 'user'): SandboxV4SecretRequest {
    const request = this.requireRequest(requestId);
    this.sweepOne(request);
    if (request.status !== 'pending') {
      throw new Error(`Secret request "${requestId}" is ${request.status}, not pending.`);
    }
    const now = this.nowMs();
    request.status = 'denied';
    request.resolvedAtMs = now;
    request.resolvedBy = resolvedBy;
    request.note = note.slice(0, 500);
    this.appendAudit(requestId, 'denied', resolvedBy, `Secret "${request.name}" denied.`);
    return { ...request };
  }

  /**
   * Scrub text of every live secret value (fulfilled, not yet
   * consumed). Use on ANY text before it goes into a log,
   * context or history — while the value is live. After a value
   * is consumed it is gone from the manager entirely, so there
   * is nothing left to scrub: callers must redact before
   * consuming, never after. Returns the scrubbed text; the
   * original is never mutated. Values shorter than 4 chars are
   * not scrubbed by value (too collision-prone) — such values
   * should never be accepted as secrets in the first place.
   */
  redactText(text: string): string {
    if (typeof text !== 'string' || text === '') return text;
    let out = text;
    for (const value of this.values.values()) {
      if (value.length < 4) continue;
      if (out.includes(value)) out = out.split(value).join(SANDBOX_V4_REDACTED);
    }
    return out;
  }

  /**
   * Deep-scrub a JSON-able value (strings inside objects/arrays)
   * of every known secret value. Returns a scrubbed copy.
   */
  redactValue(value: unknown): unknown {
    if (typeof value === 'string') return this.redactText(value);
    if (Array.isArray(value)) return value.map((item) => this.redactValue(item));
    if (typeof value === 'object' && value !== null) {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        out[key] = this.redactValue(item);
      }
      return out;
    }
    return value;
  }

  /** Audit log (metadata only, oldest first). Never contains values. */
  auditLog(): SandboxV4SecretAuditEntry[] {
    return this.audit.map((entry) => ({ ...entry }));
  }

  /**
   * Verify the audit hash chain. Returns the first broken
   * sequence number, or 0 when the chain is intact.
   */
  verifyAuditChain(): number {
    let prev = '';
    for (const entry of this.audit) {
      if (entry.prevHash !== prev) return entry.seq;
      const recomputed = hashEntry(prev, entry.seq, entry.atMs, entry.requestId, entry.event, entry.actor, entry.detail);
      if (recomputed !== entry.hash) return entry.seq;
      prev = entry.hash;
    }
    return 0;
  }

  /**
   * Expire every pending request past its deadline. Returns the
   * ids that expired. Any live value attached to an expired
   * request is dropped (defensive — fulfil never attaches a
   * value to a pending request).
   */
  sweepExpired(now?: number): string[] {
    const at = now ?? this.nowMs();
    const expired: string[] = [];
    for (const request of this.requests.values()) {
      if (request.status === 'pending' && request.expiresAtMs <= at) {
        this.expireRequest(request, at);
        expired.push(request.id);
      }
    }
    return expired;
  }

  /** Remove all records for a conversation (runtime cleanup). */
  removeForConversation(conversationId: string): number {
    let removed = 0;
    for (const [id, request] of [...this.requests.entries()]) {
      if (request.conversationId !== conversationId) continue;
      this.requests.delete(id);
      this.values.delete(id);
      removed += 1;
    }
    return removed;
  }

  private requireRequest(requestId: string): SandboxV4SecretRequest {
    const request = this.requests.get(requestId);
    if (!request) throw new Error(`Unknown secret request "${requestId}".`);
    return request;
  }

  private sweepOne(request: SandboxV4SecretRequest): void {
    if (request.status === 'pending' && request.expiresAtMs <= this.nowMs()) {
      this.expireRequest(request, this.nowMs());
    }
  }

  private expireRequest(request: SandboxV4SecretRequest, at: number): void {
    request.status = 'expired';
    request.resolvedAtMs = at;
    request.resolvedBy = 'system';
    this.values.delete(request.id);
    this.appendAudit(request.id, 'expired', 'system', `Secret "${request.name}" request expired.`);
  }

  private appendAudit(
    requestId: string,
    event: SandboxV4SecretAuditEntry['event'],
    actor: string,
    detail: string,
  ): void {
    const prevHash = this.audit.length > 0 ? this.audit[this.audit.length - 1].hash : '';
    const seq = this.audit.length + 1;
    const atMs = this.nowMs();
    const hash = hashEntry(prevHash, seq, atMs, requestId, event, actor, detail);
    this.audit.push({ seq, atMs, requestId, event, actor, detail, hash, prevHash });
  }
}
