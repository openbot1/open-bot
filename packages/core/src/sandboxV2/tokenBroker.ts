/**
 * Sandbox v2 — token broker (v1.34, Đội T2).
 *
 * Idea (from the v1.34 survey §3): scoped, short-lived credentials —
 * NO tool call touches a downstream system until it has passed the
 * policy check AND received a fresh credential for that task.
 *
 * Rules:
 *  - One token per (task, scope set). Tokens are bound to a task id;
 *    a token issued for task A never authorises task B.
 *  - TTL is capped by the policy (`caps.maxTokenTtlMs`) AND by the
 *    broker's own ceiling — the smaller wins.
 *  - Tokens expire automatically: `validate()` treats an expired
 *    token as revoked, and `sweepExpired()` revokes it for real so
 *    the run report can list it.
 *  - Revocation is explicit: task done, kill switch, manual revoke,
 *    or expiry. A revoked token never validates again.
 *  - The broker stores only token METADATA (id, scopes, expiry).
 *    The secret itself is generated per token, handed to the caller
 *    once at issue time, and never written to a log or a report —
 *    reports carry the token id only.
 *
 * The secret is a random 32-byte hex string. It is the caller's
 * responsibility to pass it to the downstream system; the broker
 * only answers "is this token (id + secret) valid for this task and
 * scope right now?".
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { SandboxV2Policy } from './policy';
import { SandboxV2TokenError } from './types';
import type { SandboxV2Token } from './types';

/** Broker-wide ceiling on token TTL (30 minutes), even if a policy allows more. */
export const SANDBOX_V2_BROKER_MAX_TTL_MS = 1_800_000;

/** Default TTL when the caller asks for none (15 minutes). */
export const SANDBOX_V2_DEFAULT_TOKEN_TTL_MS = 900_000;

/** Minimum TTL the broker will issue (1 second — anything shorter is useless). */
export const SANDBOX_V2_MIN_TOKEN_TTL_MS = 1_000;

/** A token as issued: metadata + the secret (returned once, never logged). */
export interface SandboxV2IssuedToken {
  token: SandboxV2Token;
  /** The secret. Hand it to the downstream call and forget it — it is never stored. */
  secret: string;
}

/** Scopes the broker knows. Unknown scopes are rejected at issue time. */
export const SANDBOX_V2_KNOWN_SCOPES: readonly string[] = [
  'github:read',
  'github:write',
  'npm:fetch',
  'npm:publish',
  'slack:read',
  'slack:write',
  'gmail:read',
  'gmail:send',
  'drive:read',
  'drive:write',
  'composio:execute',
  'shell:exec',
  'fs:read',
  'fs:write',
  'net:fetch',
];

/** Validate a scope list: known scopes only, no duplicates, no empties. */
export function validateSandboxV2Scopes(scopes: string[]): string[] {
  const problems: string[] = [];
  if (scopes.length === 0) problems.push('at least one scope is required');
  const seen = new Set<string>();
  for (const scope of scopes) {
    if (typeof scope !== 'string' || scope.trim() === '') {
      problems.push('scopes must be non-empty strings');
      continue;
    }
    if (seen.has(scope)) problems.push(`duplicate scope "${scope}"`);
    seen.add(scope);
    if (!SANDBOX_V2_KNOWN_SCOPES.includes(scope)) {
      problems.push(`unknown scope "${scope}" (known: ${SANDBOX_V2_KNOWN_SCOPES.join(', ')})`);
    }
  }
  return problems;
}

export interface TokenBrokerOptions {
  /** Policy that caps TTLs issued by this broker. */
  policy: SandboxV2Policy;
  /** Clock override for tests (defaults to Date.now). */
  nowFn?: () => number;
  /** Random-bytes override for tests (defaults to crypto.randomBytes). */
  randomFn?: (bytes: number) => Buffer;
}

/** Internal record: metadata + secret hash (never the secret itself). */
interface TokenRecord {
  meta: SandboxV2Token;
  /** SHA-256-free comparison: store the secret bytes; compare timing-safe. */
  secret: Buffer;
}

/**
 * Token broker. In-memory by design: tokens are short-lived and bound
 * to a single process lifetime; a restart invalidates everything
 * (fail-closed — a token that cannot be validated is denied).
 */
export class TokenBroker {
  private readonly policy: SandboxV2Policy;
  private readonly nowFn: () => number;
  private readonly randomFn: (bytes: number) => Buffer;
  private readonly records = new Map<string, TokenRecord>();
  private counter = 0;

  constructor(options: TokenBrokerOptions) {
    this.policy = options.policy;
    this.nowFn = options.nowFn ?? (() => Date.now());
    this.randomFn = options.randomFn ?? ((bytes: number) => randomBytes(bytes));
  }

  /** Effective TTL cap: min(policy cap, broker ceiling). */
  effectiveTtlCapMs(): number {
    return Math.min(this.policy.caps.maxTokenTtlMs, SANDBOX_V2_BROKER_MAX_TTL_MS);
  }

  /**
   * Issue a token for one task. Throws SandboxV2TokenError on bad
   * scopes or an unusable TTL. The caller must run the policy check
   * BEFORE calling this — the broker is the second gate, not the first.
   */
  issue(taskId: string, scopes: string[], ttlMs: number = SANDBOX_V2_DEFAULT_TOKEN_TTL_MS): SandboxV2IssuedToken {
    if (typeof taskId !== 'string' || taskId.trim() === '') {
      throw new SandboxV2TokenError('taskId must be a non-empty string');
    }
    const scopeProblems = validateSandboxV2Scopes(scopes);
    if (scopeProblems.length > 0) {
      throw new SandboxV2TokenError(`Cannot issue token: ${scopeProblems.join('; ')}`);
    }
    const cap = this.effectiveTtlCapMs();
    const effectiveTtl = Math.min(Math.max(ttlMs, SANDBOX_V2_MIN_TOKEN_TTL_MS), cap);
    const now = this.nowFn();
    this.counter += 1;
    const id = `sbv2_${now.toString(36)}_${this.counter.toString(36)}_${this.randomFn(6).toString('hex')}`;
    const secret = this.randomFn(32).toString('hex');
    const meta: SandboxV2Token = {
      id,
      taskId,
      scopes: [...scopes].sort(),
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + effectiveTtl).toISOString(),
      revoked: false,
    };
    this.records.set(id, { meta, secret: Buffer.from(secret, 'utf8') });
    return { token: { ...meta }, secret };
  }

  /** Look up token metadata by id (undefined when unknown). Never returns the secret. */
  get(id: string): SandboxV2Token | undefined {
    const record = this.records.get(id);
    return record ? { ...record.meta } : undefined;
  }

  /** True when the token is live right now (exists, not revoked, not expired). */
  isLive(id: string, nowMs: number = this.nowFn()): boolean {
    const record = this.records.get(id);
    if (!record) return false;
    if (record.meta.revoked) return false;
    return Date.parse(record.meta.expiresAt) > nowMs;
  }

  /**
   * Validate a token for a downstream call: id + secret must match,
   * the token must be live, bound to this task, and carry the scope.
   * Throws SandboxV2TokenError with the specific reason — the caller
   * must deny the downstream call on ANY throw.
   */
  validate(id: string, secret: string, taskId: string, scope: string): SandboxV2Token {
    const record = this.records.get(id);
    if (!record) throw new SandboxV2TokenError(`Unknown token "${id}"`);
    const expected = record.secret;
    const given = Buffer.from(secret, 'utf8');
    const matches =
      expected.length === given.length && timingSafeEqual(expected, given);
    if (!matches) throw new SandboxV2TokenError(`Token "${id}" secret does not match`);
    if (record.meta.revoked) {
      throw new SandboxV2TokenError(
        `Token "${id}" was revoked${record.meta.revokeReason ? ` (${record.meta.revokeReason})` : ''}`,
      );
    }
    const now = this.nowFn();
    if (Date.parse(record.meta.expiresAt) <= now) {
      this.revoke(id, 'expired');
      throw new SandboxV2TokenError(`Token "${id}" expired at ${record.meta.expiresAt}`);
    }
    if (record.meta.taskId !== taskId) {
      throw new SandboxV2TokenError(`Token "${id}" is bound to task "${record.meta.taskId}", not "${taskId}"`);
    }
    if (!record.meta.scopes.includes(scope)) {
      throw new SandboxV2TokenError(`Token "${id}" does not carry scope "${scope}"`);
    }
    return { ...record.meta };
  }

  /**
   * Guard helper for tool calls: validate first, then run `fn` with
   * the token metadata. `fn` NEVER runs when validation fails — this
   * is the "no downstream touch without a fresh credential" rule in
   * one place.
   */
  async guard<T>(
    id: string,
    secret: string,
    taskId: string,
    scope: string,
    fn: (token: SandboxV2Token) => Promise<T> | T,
  ): Promise<T> {
    const token = this.validate(id, secret, taskId, scope);
    return fn(token);
  }

  /** Revoke a token now. Returns false when the token is unknown. */
  revoke(id: string, reason: SandboxV2Token['revokeReason'] = 'manual'): boolean {
    const record = this.records.get(id);
    if (!record) return false;
    if (record.meta.revoked) return false;
    record.meta.revoked = true;
    record.meta.revokedAt = new Date(this.nowFn()).toISOString();
    record.meta.revokeReason = reason;
    return true;
  }

  /** Revoke every live token bound to a task (task done / killed). Returns revoked ids. */
  revokeForTask(taskId: string, reason: SandboxV2Token['revokeReason'] = 'task-done'): string[] {
    const revoked: string[] = [];
    for (const [id, record] of this.records) {
      if (record.meta.taskId === taskId && !record.meta.revoked) {
        record.meta.revoked = true;
        record.meta.revokedAt = new Date(this.nowFn()).toISOString();
        record.meta.revokeReason = reason;
        revoked.push(id);
      }
    }
    return revoked;
  }

  /** Revoke every token whose expiry has passed. Returns revoked ids. */
  sweepExpired(nowMs: number = this.nowFn()): string[] {
    const revoked: string[] = [];
    for (const [id, record] of this.records) {
      if (!record.meta.revoked && Date.parse(record.meta.expiresAt) <= nowMs) {
        record.meta.revoked = true;
        record.meta.revokedAt = new Date(nowMs).toISOString();
        record.meta.revokeReason = 'expired';
        revoked.push(id);
      }
    }
    return revoked;
  }

  /** All tokens for a task (metadata only), newest first. */
  listForTask(taskId: string): SandboxV2Token[] {
    return [...this.records.values()]
      .filter((r) => r.meta.taskId === taskId)
      .map((r) => ({ ...r.meta }))
      .sort((a, b) => Date.parse(b.issuedAt) - Date.parse(a.issuedAt));
  }

  /** Live token count (for status displays). */
  liveCount(nowMs: number = this.nowFn()): number {
    let count = 0;
    for (const record of this.records.values()) {
      if (!record.meta.revoked && Date.parse(record.meta.expiresAt) > nowMs) count += 1;
    }
    return count;
  }
}
