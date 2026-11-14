/**
 * Policy audit log (v1.04, T3b).
 *
 * Append-only JSONL: `<stateDir>/policy-audit.jsonl`, one line per
 * policy event (created / updated / rejected / loaded). Each entry
 * carries the sha256 of the policy after the event and, for updates,
 * the hash before it — so "who loosened the policy, and from what?"
 * is answerable from the log alone, without keeping old copies.
 *
 * Best-effort I/O, like the hook log: a failed append never throws
 * (the policy save already happened; a missing audit line is a gap
 * in the record, not a reason to fail the operation). Reading a
 * corrupt line skips it and counts it, so one bad line cannot hide
 * the rest of the history.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** Name of the audit file inside the state dir. */
export const POLICY_AUDIT_FILE = 'policy-audit.jsonl';

/** Max audit entries `readPolicyAudit` returns by default. */
export const DEFAULT_POLICY_AUDIT_LIMIT = 100;

/** What happened to a policy. */
export type PolicyAuditAction = 'created' | 'updated' | 'rejected' | 'loaded';

/** One audit entry. */
export interface PolicyAuditEntry {
  /** ISO timestamp of the event. */
  ts: string;
  action: PolicyAuditAction;
  /** Policy name. */
  name: string;
  /** Policy format version. */
  version: number;
  /** sha256 of the policy after the event (undefined for a rejected load). */
  sha256?: string;
  /** sha256 before the event (updates only). */
  prevSha256?: string;
  /** Who did it ('user', 'settings-ui', 'import', …). */
  actor?: string;
  /** Free-form note (e.g. the validation error for a rejection). */
  note?: string;
}

export interface PolicyAuditInput {
  action: PolicyAuditAction;
  name: string;
  version: number;
  sha256?: string;
  prevSha256?: string;
  actor?: string;
  note?: string;
  /** Timestamp override (tests). Defaults to now. */
  ts?: string;
}

/** Append one entry to the audit log. Never throws. */
export function appendPolicyAudit(stateDir: string, input: PolicyAuditInput): void {
  try {
    const dir = (stateDir ?? '').trim();
    if (!dir) return;
    fs.mkdirSync(dir, { recursive: true });
    const entry: PolicyAuditEntry = {
      ts: input.ts ?? new Date().toISOString(),
      action: input.action,
      name: input.name,
      version: input.version,
      ...(input.sha256 !== undefined ? { sha256: input.sha256 } : {}),
      ...(input.prevSha256 !== undefined ? { prevSha256: input.prevSha256 } : {}),
      ...(input.actor !== undefined ? { actor: input.actor } : {}),
      ...(input.note !== undefined ? { note: input.note } : {}),
    };
    fs.appendFileSync(path.join(dir, POLICY_AUDIT_FILE), `${JSON.stringify(entry)}\n`, 'utf-8');
  } catch {
    // Best-effort: the audit log must never break a policy operation.
  }
}

export interface ReadPolicyAuditResult {
  entries: PolicyAuditEntry[];
  /** Lines that were not valid audit JSON (skipped). */
  skippedLines: number;
}

/**
 * Read the audit log, newest first. Never throws; a missing file is
 * an empty log, a corrupt line is skipped and counted.
 */
export function readPolicyAudit(
  stateDir: string,
  opts: { limit?: number } = {},
): ReadPolicyAuditResult {
  const limit = opts.limit ?? DEFAULT_POLICY_AUDIT_LIMIT;
  try {
    const file = path.join(stateDir, POLICY_AUDIT_FILE);
    const text = fs.readFileSync(file, 'utf-8');
    const entries: PolicyAuditEntry[] = [];
    let skippedLines = 0;
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (
          parsed &&
          typeof parsed === 'object' &&
          typeof (parsed as { ts?: unknown }).ts === 'string' &&
          typeof (parsed as { action?: unknown }).action === 'string' &&
          typeof (parsed as { name?: unknown }).name === 'string' &&
          typeof (parsed as { version?: unknown }).version === 'number'
        ) {
          entries.push(parsed as PolicyAuditEntry);
        } else {
          skippedLines++;
        }
      } catch {
        skippedLines++;
      }
    }
    entries.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
    return { entries: entries.slice(0, limit), skippedLines };
  } catch {
    return { entries: [], skippedLines: 0 };
  }
}

/** Summarise a policy into comparable leaf paths (`rules.tools.deny[0]` → value). */
export function flattenPolicy(policy: unknown, base = ''): Map<string, unknown> {
  const out = new Map<string, unknown>();
  const walk = (value: unknown, prefix: string): void => {
    if (Array.isArray(value)) {
      value.forEach((item, i) => walk(item, `${prefix}[${i}]`));
      return;
    }
    if (value !== null && typeof value === 'object') {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        walk(v, prefix === '' ? k : `${prefix}.${k}`);
      }
      return;
    }
    out.set(prefix, value);
  };
  walk(policy, base);
  return out;
}

/** One changed leaf between two policies. */
export interface PolicyDiffLine {
  path: string;
  before: unknown;
  after: unknown;
  kind: 'added' | 'removed' | 'changed';
}

/**
 * Diff two policies as a list of changed leaves (added / removed /
 * changed), sorted by path. Used by the audit trail and by Settings
 * ("what did this edit actually change?").
 */
export function diffPolicies(before: unknown, after: unknown): PolicyDiffLine[] {
  const a = flattenPolicy(before);
  const b = flattenPolicy(after);
  const lines: PolicyDiffLine[] = [];
  const keys = new Set([...a.keys(), ...b.keys()]);
  for (const key of [...keys].sort()) {
    const hasA = a.has(key);
    const hasB = b.has(key);
    if (hasA && !hasB) lines.push({ path: key, before: a.get(key), after: undefined, kind: 'removed' });
    else if (!hasA && hasB) lines.push({ path: key, before: undefined, after: b.get(key), kind: 'added' });
    else if (JSON.stringify(a.get(key)) !== JSON.stringify(b.get(key))) {
      lines.push({ path: key, before: a.get(key), after: b.get(key), kind: 'changed' });
    }
  }
  return lines;
}
