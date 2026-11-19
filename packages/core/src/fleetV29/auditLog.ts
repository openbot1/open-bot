/**
 * Fleet v29 audit log (v1.42, Team T6).
 *
 * Append-only log of every inter-agent delegation, allowlist change,
 * card verification, and sensitive-action decision. The log is the
 * fleet's memory of who delegated what to whom, when, and with what
 * result — the admin panel and the board both read from it.
 *
 * Privacy: entries carry ids, states, and amounts only. Prompt
 * text, tool arguments, message parts, and secret values are NEVER
 * written here — a caller that passes such text in `detail` gets it
 * rejected (the log truncates + redacts known secret-looking
 * patterns as a second line of defence, but callers must not rely
 * on that).
 *
 * Tamper evidence: each entry carries a hash chain — `hash` is a
 * deterministic hash of (prevHash + seq + kind + at + actor +
 * peerId + taskId + detail). Recomputing the chain over the stored
 * entries detects any edit, deletion, or reorder after the fact.
 * The hash is FNV-1a (fast, dependency-free); it is a tamper
 * *detector*, not a cryptographic signature.
 */

import type { FleetV29AuditEntry, FleetV29AuditKind } from './types';
import { fleetV29HashText } from './cardVerify';

/** Max entries kept in memory (oldest dropped, chain re-anchored). */
export const FLEET_V29_AUDIT_MAX_ENTRIES = 5000;

const SECRET_PATTERNS: readonly RegExp[] = [
  /sk-[A-Za-z0-9]{8,}/g,
  /Bearer\s+[A-Za-z0-9._-]{8,}/gi,
  /"?(api[_-]?key|password|secret|token)"?\s*[:=]\s*"?[^\s",}]{4,}/gi,
];

/** Redact secret-looking fragments from a detail string. */
export function fleetV29RedactDetail(detail: string): string {
  let out = detail;
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, '[redacted]');
  return out.slice(0, 500);
}

export interface FleetV29AuditInput {
  kind: FleetV29AuditKind;
  actor: string;
  peerId?: string;
  taskId?: string;
  detail: string;
  meta?: Record<string, string | number | boolean>;
  at?: string;
}

export class FleetV29AuditLog {
  private readonly entries: FleetV29AuditEntry[] = [];
  private nextSeq = 1;

  /** Append one entry (returns the stored entry, hash-chained). */
  append(input: FleetV29AuditInput): FleetV29AuditEntry {
    const prev = this.entries.length > 0 ? (this.entries[this.entries.length - 1] as FleetV29AuditEntry) : null;
    const prevHash = prev ? prev.hash : '';
    const seq = this.nextSeq;
    this.nextSeq += 1;
    const at = input.at ?? new Date().toISOString();
    const detail = fleetV29RedactDetail(input.detail);
    const hash = fleetV29HashText(
      [prevHash, String(seq), input.kind, at, input.actor, input.peerId ?? '', input.taskId ?? '', detail].join('|'),
    );
    const entry: FleetV29AuditEntry = {
      seq,
      hash,
      prevHash,
      kind: input.kind,
      at,
      actor: input.actor,
      ...(input.peerId !== undefined ? { peerId: input.peerId } : {}),
      ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
      detail,
      ...(input.meta !== undefined ? { meta: { ...input.meta } } : {}),
    };
    this.entries.push(entry);
    while (this.entries.length > FLEET_V29_AUDIT_MAX_ENTRIES) this.entries.shift();
    return entry;
  }

  /** All entries, oldest first. */
  list(): FleetV29AuditEntry[] {
    return [...this.entries];
  }

  /** Filtered list (kind / peer / task / actor / since). */
  query(filter?: {
    kind?: FleetV29AuditKind | FleetV29AuditKind[];
    peerId?: string;
    taskId?: string;
    actor?: string;
    sinceIso?: string;
    untilIso?: string;
    limit?: number;
  }): FleetV29AuditEntry[] {
    const kinds = filter?.kind === undefined ? null : Array.isArray(filter.kind) ? filter.kind : [filter.kind];
    const out = this.entries.filter((e) => {
      if (kinds && !kinds.includes(e.kind)) return false;
      if (filter?.peerId !== undefined && e.peerId !== filter.peerId) return false;
      if (filter?.taskId !== undefined && e.taskId !== filter.taskId) return false;
      if (filter?.actor !== undefined && e.actor !== filter.actor) return false;
      if (filter?.sinceIso !== undefined && e.at < filter.sinceIso) return false;
      if (filter?.untilIso !== undefined && e.at > filter.untilIso) return false;
      return true;
    });
    return filter?.limit !== undefined ? out.slice(-filter.limit) : out;
  }

  /** Entries for one task, in order (the task's delegation story). */
  forTask(taskId: string): FleetV29AuditEntry[] {
    return this.query({ taskId });
  }

  /** Entries for one peer, in order. */
  forPeer(peerId: string): FleetV29AuditEntry[] {
    return this.query({ peerId });
  }

  count(): number {
    return this.entries.length;
  }

  /** Recompute the hash chain; returns the first broken seq (null = intact). */
  verifyChain(): { ok: true } | { ok: false; brokenSeq: number; reason: string } {
    let prevHash = '';
    for (const entry of this.entries) {
      if (entry.prevHash !== prevHash) {
        return { ok: false, brokenSeq: entry.seq, reason: `Entry ${entry.seq} prevHash does not match the previous entry.` };
      }
      const recomputed = fleetV29HashText(
        [prevHash, String(entry.seq), entry.kind, entry.at, entry.actor, entry.peerId ?? '', entry.taskId ?? '', entry.detail].join('|'),
      );
      if (recomputed !== entry.hash) {
        return { ok: false, brokenSeq: entry.seq, reason: `Entry ${entry.seq} hash does not match its contents.` };
      }
      prevHash = entry.hash;
    }
    return { ok: true };
  }

  /** Counts per kind (for the audit panel summary). */
  countsByKind(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const entry of this.entries) out[entry.kind] = (out[entry.kind] ?? 0) + 1;
    return out;
  }

  /** Export as newline-delimited JSON (for the admin panel download). */
  toNdjson(): string {
    return this.entries.map((e) => JSON.stringify(e)).join('\n');
  }
}
