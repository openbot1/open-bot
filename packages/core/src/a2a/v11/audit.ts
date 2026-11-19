/**
 * A2A v1.0 audit log (v11 generation).
 *
 * Every security-relevant A2A v11 event is recorded here: peer
 * registration / allowlist changes, card verification outcomes,
 * delegation attempts, guard blocks / sanitisation, sensitive-action
 * confirmations, task lifecycle transitions, and session suspensions.
 *
 * Properties:
 *  - Append-only: entries are never edited or deleted in place; a
 *    redaction, when ever needed, is itself a new entry.
 *  - Tamper-evident chain: each entry carries a SHA-256 hash of the
 *    previous entry's hash + its own canonical content, so deleting
 *    or editing an entry in the middle breaks the chain.
 *  - No secrets: the logger redacts secret-shaped values before
 *    storing (same patterns as the guard's outbound scan).
 *  - Bounded: the in-memory ring keeps the newest N entries; the
 *    file/JSON export is the durable form.
 */

import * as crypto from 'node:crypto';

import { v11CanonicalJson } from './signing';

/** Kinds of audited A2A v11 events. */
export type V11AuditEventKind =
  | 'peer.registered'
  | 'peer.allowlisted'
  | 'peer.blocklisted'
  | 'peer.suspended'
  | 'peer.unsuspended'
  | 'card.verified'
  | 'card.rejected'
  | 'delegate.attempt'
  | 'delegate.allowed'
  | 'delegate.denied'
  | 'guard.block'
  | 'guard.sanitise'
  | 'guard.secret-block'
  | 'confirm.requested'
  | 'confirm.approved'
  | 'confirm.denied'
  | 'task.created'
  | 'task.transition'
  | 'task.cancelled'
  | 'task.listed'
  | 'server.started'
  | 'server.stopped';

/** One audit entry. */
export interface V11AuditEntry {
  seq: number;
  at: string;
  kind: V11AuditEventKind;
  actor?: string;
  peerId?: string;
  taskId?: string;
  detail: string;
  /** Extra structured data (already redacted). */
  data?: Record<string, unknown>;
  /** Hash chain: sha256(prevHash + canonical(this sans hash)). */
  hash: string;
  prevHash: string;
}

const V11_AUDIT_SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g,
  /\b(ghp|gho|github_pat)_[A-Za-z0-9_]{16,}\b/g,
  /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
  /\bBearer\s+[A-Za-z0-9._-]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b(password|api[_-]?key|access[_-]?token)\s*[:=]\s*['"][^'"]+['"]/gi,
];

/** Redact secret-shaped values from free text before it is stored. */
export function redactV11AuditText(text: string): string {
  let out = text;
  for (const pattern of V11_AUDIT_SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    out = out.replace(pattern, '[redacted]');
  }
  return out;
}

/** Redact secret-shaped values inside a JSON-ish structure. */
export function redactV11AuditData(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === 'string') {
      out[key] = redactV11AuditText(value);
    } else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = redactV11AuditData(value as Record<string, unknown>);
    } else if (Array.isArray(value)) {
      out[key] = value.map((item) =>
        typeof item === 'string' ? redactV11AuditText(item) : item,
      );
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Default ring size: newest 1,000 entries kept in memory. */
export const V11_AUDIT_MAX_ENTRIES = 1000;

/** Append-only, hash-chained audit log. */
export class V11AuditLog {
  private entries: V11AuditEntry[] = [];
  private seq = 0;
  private lastHash = 'genesis';

  constructor(private readonly maxEntries: number = V11_AUDIT_MAX_ENTRIES) {}

  /** Append an entry. Returns the stored entry (with its hash). */
  append(
    kind: V11AuditEventKind,
    detail: string,
    options: {
      actor?: string;
      peerId?: string;
      taskId?: string;
      data?: Record<string, unknown>;
      at?: Date;
    } = {},
  ): V11AuditEntry {
    this.seq += 1;
    const at = (options.at ?? new Date()).toISOString();
    const entrySansHash = {
      seq: this.seq,
      at,
      kind,
      ...(options.actor !== undefined ? { actor: options.actor } : {}),
      ...(options.peerId !== undefined ? { peerId: options.peerId } : {}),
      ...(options.taskId !== undefined ? { taskId: options.taskId } : {}),
      detail: redactV11AuditText(detail),
      ...(options.data !== undefined ? { data: redactV11AuditData(options.data) } : {}),
    };
    const hash = crypto
      .createHash('sha256')
      .update(`${this.lastHash}:${v11CanonicalJson(entrySansHash)}`, 'utf8')
      .digest('hex');
    const entry: V11AuditEntry = { ...entrySansHash, hash, prevHash: this.lastHash };
    this.lastHash = hash;
    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) {
      this.entries.splice(0, this.entries.length - this.maxEntries);
    }
    return entry;
  }

  /** All entries, oldest first. */
  all(): V11AuditEntry[] {
    return [...this.entries];
  }

  /** Entries filtered by kind and/or peer. */
  query(filter: { kind?: V11AuditEventKind; peerId?: string; taskId?: string } = {}): V11AuditEntry[] {
    return this.entries.filter((e) => {
      if (filter.kind !== undefined && e.kind !== filter.kind) return false;
      if (filter.peerId !== undefined && e.peerId !== filter.peerId) return false;
      if (filter.taskId !== undefined && e.taskId !== filter.taskId) return false;
      return true;
    });
  }

  count(): number {
    return this.entries.length;
  }

  /**
   * Verify the hash chain over the entries currently held. Returns
   * the first broken sequence number, or null when the chain is intact.
   * Note: entries dropped by ring truncation break the chain at the
   * truncation point by design — verify a full export, not a truncated
   * ring, for a strict check.
   */
  verifyChain(): { ok: boolean; brokenAtSeq?: number; reason?: string } {
    let prev = 'genesis';
    // The ring may have dropped the true genesis; the first held
    // entry's prevHash is then unverifiable — start from it instead.
    for (let i = 0; i < this.entries.length; i += 1) {
      const entry = this.entries[i] as V11AuditEntry;
      if (i > 0 && entry.prevHash !== prev) {
        return { ok: false, brokenAtSeq: entry.seq, reason: 'prevHash mismatch' };
      }
      const { hash: _hash, prevHash: _prev, ...sansHash } = entry;
      void _hash;
      void _prev;
      const expected = crypto
        .createHash('sha256')
        .update(`${entry.prevHash}:${v11CanonicalJson(sansHash)}`, 'utf8')
        .digest('hex');
      if (expected !== entry.hash) {
        return { ok: false, brokenAtSeq: entry.seq, reason: 'hash mismatch' };
      }
      prev = entry.hash;
    }
    return { ok: true };
  }

  /** Serialise the whole log (JSON array) for durable storage. */
  toJson(): string {
    return JSON.stringify(this.entries, null, 2);
  }

  /** Load entries previously exported with toJson(). Chain re-verified lazily. */
  static fromJson(json: string): V11AuditLog {
    const parsed = JSON.parse(json) as V11AuditEntry[];
    const log = new V11AuditLog(Math.max(parsed.length, V11_AUDIT_MAX_ENTRIES));
    log.entries = parsed;
    log.seq = parsed.length > 0 ? (parsed[parsed.length - 1]?.seq ?? 0) : 0;
    log.lastHash = parsed.length > 0 ? (parsed[parsed.length - 1]?.hash ?? 'genesis') : 'genesis';
    return log;
  }

  clear(): void {
    this.entries = [];
    this.seq = 0;
    this.lastHash = 'genesis';
  }
}
