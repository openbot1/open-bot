/**
 * Sandbox v6 — exec audit log (v1.38, Team T3).
 *
 * Every exec a bot runs is recorded, twice: an `exec-start`
 * entry when the command is accepted and an `exec-finish`
 * entry when it ends (plus `exec-refused` / `exec-timeout`
 * when it never runs or is killed by its timeout). Non-exec
 * events (quota changes, secret denials, lifecycle) are
 * recorded through the same log so one query answers "what
 * did this bot do, when, and what happened?".
 *
 * Integrity: the log is append-only JSONL, one entry per
 * line, and every entry carries a sha256 hash chained to the
 * previous entry's hash (`hash = sha256(prevHash + canonical
 * body)`). `verifyChain()` replays the chain; a missing,
 * edited or reordered line breaks the chain at that sequence
 * number. The log file is never rewritten in place — rotation
 * moves the old file aside and starts a fresh chain.
 *
 * Secrets: the logger holds a set of known secret values
 * (registered by the secret scope manager) and scrubs them
 * out of every command, argument, stdout/stderr excerpt and
 * detail string before anything is written. A secret value
 * must never appear in an audit entry, even if the bot
 * echoes it.
 *
 * One logger per bot (file `<baseDir>/<botId>/audit.jsonl`).
 * All writes are synchronous appends so a crash cannot lose
 * an entry that was reported as recorded.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  SandboxV6AuditEntry,
  SandboxV6AuditKind,
  SandboxV6AuditQuery,
  SandboxV6AuditSummary,
  SandboxV6EnforcementMode,
} from './types';

export const SANDBOX_V6_AUDIT_FILE = 'audit.jsonl';
/** Rotate when the log passes this size (10 MiB). */
export const SANDBOX_V6_AUDIT_MAX_BYTES = 10 * 1024 * 1024;
/** Rotate when the log passes this many entries. */
export const SANDBOX_V6_AUDIT_MAX_ENTRIES = 100_000;
/** Max chars kept of a command / excerpt in an entry. */
export const SANDBOX_V6_AUDIT_MAX_TEXT = 4000;

export interface SandboxV6AuditLoggerOptions {
  /** Directory holding this bot's audit.jsonl. */
  dir: string;
  /** Bot this log belongs to. */
  botId: string;
  /** Clock override (tests). Default `Date.now`. */
  nowMs?: () => number;
  /** Max bytes before rotation. */
  maxBytes?: number;
  /** Max entries before rotation. */
  maxEntries?: number;
}

/** Input for one audit entry (the logger fills id/seq/hash). */
export interface SandboxV6AuditRecordInput {
  runtimeId: string;
  kind: SandboxV6AuditKind;
  command?: string;
  args?: string[];
  startedAtMs?: number;
  durationMs?: number;
  exitCode?: number | null;
  signal?: string | null;
  timedOut?: boolean;
  enforcement?: SandboxV6EnforcementMode;
  isolation?: string;
  detail?: string;
}

function canonicalEntryBody(entry: Omit<SandboxV6AuditEntry, 'hash'>): string {
  return JSON.stringify([
    entry.seq,
    entry.botId,
    entry.runtimeId,
    entry.kind,
    entry.command,
    entry.args,
    entry.startedAtMs,
    entry.durationMs,
    entry.exitCode,
    entry.signal,
    entry.timedOut,
    entry.enforcement,
    entry.isolation,
    entry.detail,
    entry.prevHash,
  ]);
}

function chainHash(prevHash: string, body: Omit<SandboxV6AuditEntry, 'hash'>): string {
  return crypto.createHash('sha256').update(prevHash + canonicalEntryBody(body), 'utf8').digest('hex');
}

/** Scrub known secret values out of text (longest values first, so a short value cannot mask a long one). */
export function scrubSandboxV6Secrets(text: string, secrets: Iterable<string>): string {
  let out = text;
  const values = [...secrets].filter((v) => typeof v === 'string' && v.length >= 4);
  values.sort((a, b) => b.length - a.length);
  for (const value of values) {
    out = out.split(value).join('[REDACTED]');
  }
  return out;
}

function truncateText(text: string, max = SANDBOX_V6_AUDIT_MAX_TEXT): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…[truncated ${text.length - max} chars]`;
}

/**
 * Append-only audit logger for one bot. Keeps the last hash +
 * sequence in memory so appends stay O(1); `reload()` re-reads
 * the file (used after rotation by another process, or in tests).
 */
export class SandboxV6AuditLogger {
  readonly dir: string;
  readonly botId: string;
  private readonly nowMs: () => number;
  private readonly maxBytes: number;
  private readonly maxEntries: number;
  private lastHash = '';
  private lastSeq = 0;
  private entryCount = 0;
  private readonly secrets = new Set<string>();

  constructor(options: SandboxV6AuditLoggerOptions) {
    this.dir = options.dir;
    this.botId = options.botId;
    this.nowMs = options.nowMs ?? Date.now;
    this.maxBytes = options.maxBytes ?? SANDBOX_V6_AUDIT_MAX_BYTES;
    this.maxEntries = options.maxEntries ?? SANDBOX_V6_AUDIT_MAX_ENTRIES;
    fs.mkdirSync(this.dir, { recursive: true });
    this.reload();
  }

  /** Path of the live log file. */
  get filePath(): string {
    return path.join(this.dir, SANDBOX_V6_AUDIT_FILE);
  }

  /** Entries written to the live log so far. */
  get count(): number {
    return this.entryCount;
  }

  /** Register a secret value to scrub from everything logged from now on. */
  registerSecret(value: string): void {
    if (typeof value === 'string' && value.length >= 4) this.secrets.add(value);
  }

  /** Forget a secret value (after revocation — old entries stay scrubbed, new text is not). */
  unregisterSecret(value: string): void {
    this.secrets.delete(value);
  }

  /** Scrub registered secrets out of a string. */
  scrub(text: string): string {
    return scrubSandboxV6Secrets(text, this.secrets);
  }

  /**
   * Append one entry. Returns the stored entry. Throws when
   * the append fails — the caller must treat a failed audit
   * write as a failed operation (fail-closed).
   */
  record(input: SandboxV6AuditRecordInput): SandboxV6AuditEntry {
    this.maybeRotate();
    const startedAtMs = input.startedAtMs ?? this.nowMs();
    const seq = this.lastSeq + 1;
    const body: Omit<SandboxV6AuditEntry, 'hash'> = {
      id: crypto.randomUUID(),
      seq,
      botId: this.botId,
      runtimeId: input.runtimeId,
      kind: input.kind,
      command: truncateText(this.scrub(input.command ?? '')),
      args: (input.args ?? []).map((a) => truncateText(this.scrub(a))),
      startedAtMs,
      durationMs: input.durationMs ?? 0,
      exitCode: input.exitCode ?? null,
      signal: input.signal ?? null,
      timedOut: input.timedOut ?? false,
      enforcement: input.enforcement ?? 'none',
      isolation: input.isolation ?? '',
      detail: truncateText(this.scrub(input.detail ?? '')),
      prevHash: this.lastHash,
    };
    const entry: SandboxV6AuditEntry = { ...body, hash: chainHash(this.lastHash, body) };
    fs.appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`, 'utf8');
    this.lastHash = entry.hash;
    this.lastSeq = seq;
    this.entryCount += 1;
    return entry;
  }

  /** Read all entries from the live log (oldest first). Corrupt lines are skipped, never thrown. */
  readAll(): SandboxV6AuditEntry[] {
    return readSandboxV6AuditFile(this.filePath);
  }

  /** Query the live log (newest first, limited). */
  query(query: SandboxV6AuditQuery = {}): SandboxV6AuditEntry[] {
    const entries = this.readAll();
    return filterSandboxV6AuditEntries(entries, query);
  }

  /** Summary counts over the live log, including chain verification. */
  summarize(): SandboxV6AuditSummary {
    const entries = this.readAll();
    return summarizeSandboxV6AuditEntries(this.botId, entries);
  }

  /** Verify the hash chain of the live log. Returns broken sequence numbers (empty = clean). */
  verifyChain(): { ok: boolean; brokenAt: number[] } {
    const entries = this.readAll();
    const brokenAt = verifySandboxV6AuditChain(entries);
    return { ok: brokenAt.length === 0, brokenAt };
  }

  /** Re-read the live log to rebuild last-hash / sequence (after external rotation). */
  reload(): void {
    const entries = this.readAll();
    if (entries.length === 0) {
      this.lastHash = '';
      this.lastSeq = 0;
      this.entryCount = 0;
      return;
    }
    this.lastHash = entries[entries.length - 1]?.hash ?? '';
    this.lastSeq = entries[entries.length - 1]?.seq ?? 0;
    this.entryCount = entries.length;
  }

  /** Rotate the live log aside (fresh chain) when it is too big or too long. */
  rotate(): string | null {
    if (!fs.existsSync(this.filePath)) return null;
    const stamp = new Date(this.nowMs()).toISOString().replace(/[:.]/g, '-');
    const rotated = path.join(this.dir, `audit-${stamp}-${this.lastSeq}.jsonl`);
    fs.renameSync(this.filePath, rotated);
    this.lastHash = '';
    this.lastSeq = 0;
    this.entryCount = 0;
    return rotated;
  }

  /** List rotated log files (oldest first). */
  rotatedFiles(): string[] {
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return [];
    }
    return names
      .filter((n) => n.startsWith('audit-') && n.endsWith('.jsonl'))
      .sort()
      .map((n) => path.join(this.dir, n));
  }

  private maybeRotate(): void {
    if (this.entryCount >= this.maxEntries) {
      this.rotate();
      return;
    }
    try {
      if (fs.existsSync(this.filePath) && fs.statSync(this.filePath).size >= this.maxBytes) {
        this.rotate();
      }
    } catch {
      // Stat failure: keep appending; the append itself will surface errors.
    }
  }
}

/** Read one audit file. Corrupt lines are skipped (counted nowhere, never thrown). */
export function readSandboxV6AuditFile(filePath: string): SandboxV6AuditEntry[] {
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }
  const out: SandboxV6AuditEntry[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      const parsed = JSON.parse(trimmed) as SandboxV6AuditEntry;
      if (typeof parsed.seq === 'number' && typeof parsed.hash === 'string') out.push(parsed);
    } catch {
      // Corrupt line: skip, the chain check will flag the gap.
    }
  }
  return out;
}

/** Apply a query filter to entries (newest first, limited). */
export function filterSandboxV6AuditEntries(
  entries: SandboxV6AuditEntry[],
  query: SandboxV6AuditQuery,
): SandboxV6AuditEntry[] {
  const limit = query.limit !== undefined ? Math.max(0, Math.floor(query.limit)) : 100;
  const needle = query.text !== undefined ? query.text.toLowerCase() : null;
  const out: SandboxV6AuditEntry[] = [];
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const e = entries[i];
    if (!e) continue;
    if (query.botId !== undefined && e.botId !== query.botId) continue;
    if (query.runtimeId !== undefined && e.runtimeId !== query.runtimeId) continue;
    if (query.kind !== undefined && e.kind !== query.kind) continue;
    if (query.sinceMs !== undefined && e.startedAtMs < query.sinceMs) continue;
    if (query.untilMs !== undefined && e.startedAtMs > query.untilMs) continue;
    if (query.exitCode !== undefined && e.exitCode !== query.exitCode) continue;
    if (needle !== null) {
      const hay = `${e.command} ${e.args.join(' ')} ${e.detail}`.toLowerCase();
      if (!hay.includes(needle)) continue;
    }
    out.push(e);
    if (out.length >= limit) break;
  }
  return out;
}

/** Verify a hash chain. Returns sequence numbers that fail (empty = clean). */
export function verifySandboxV6AuditChain(entries: SandboxV6AuditEntry[]): number[] {
  const broken: number[] = [];
  let prevHash = '';
  let prevSeq = 0;
  for (const entry of entries) {
    if (entry.seq !== prevSeq + 1 || entry.prevHash !== prevHash) {
      broken.push(entry.seq);
    }
    const { hash, ...body } = entry;
    const expected = chainHash(entry.prevHash, body as Omit<SandboxV6AuditEntry, 'hash'>);
    if (expected !== hash) {
      if (!broken.includes(entry.seq)) broken.push(entry.seq);
    }
    prevHash = entry.hash;
    prevSeq = entry.seq;
  }
  return broken;
}

/** Summarise entries (counts + chain verification). */
export function summarizeSandboxV6AuditEntries(
  botId: string,
  entries: SandboxV6AuditEntry[],
): SandboxV6AuditSummary {
  const summary: SandboxV6AuditSummary = {
    botId,
    totalEntries: entries.length,
    execStarts: 0,
    execFinishes: 0,
    execRefused: 0,
    execTimeouts: 0,
    quotaExceeded: 0,
    secretDenied: 0,
    exitCodes: {},
    firstMs: 0,
    lastMs: 0,
    chainOk: true,
    chainBrokenAt: [],
  };
  if (entries.length === 0) return summary;
  summary.firstMs = entries[0]?.startedAtMs ?? 0;
  summary.lastMs = entries[entries.length - 1]?.startedAtMs ?? 0;
  for (const e of entries) {
    if (e.kind === 'exec-start') summary.execStarts += 1;
    if (e.kind === 'exec-finish') summary.execFinishes += 1;
    if (e.kind === 'exec-refused') summary.execRefused += 1;
    if (e.kind === 'exec-timeout') summary.execTimeouts += 1;
    if (e.kind === 'quota-exceeded' || e.kind === 'disk-quota-exceeded') summary.quotaExceeded += 1;
    if (e.kind === 'secret-access-denied') summary.secretDenied += 1;
    if (e.exitCode !== null && e.exitCode !== undefined) {
      const key = String(e.exitCode);
      summary.exitCodes[key] = (summary.exitCodes[key] ?? 0) + 1;
    }
  }
  summary.chainBrokenAt = verifySandboxV6AuditChain(entries);
  summary.chainOk = summary.chainBrokenAt.length === 0;
  return summary;
}
