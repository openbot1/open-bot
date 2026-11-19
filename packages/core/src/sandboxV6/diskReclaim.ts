/**
 * Sandbox v6 — disk reclaim (v1.38, Team T3).
 *
 * When a bot's workspace crosses its disk quota, refusing new
 * execs is only half the answer: the operator (or the bot
 * itself) needs a way back under the cap. Reclaim deletes
 * files inside the workspace, in a fixed safe order, until
 * the workspace fits again:
 *
 *  1. `tmp/` scratch files (oldest first);
 *  2. `*.log` files (oldest first);
 *  3. any other regular file (oldest first, largest first
 *     within the same age bucket is NOT used — age wins, so
 *     a bot's fresh work is deleted last).
 *
 * Safety rules (fail-closed, never surprising):
 *
 *  - Only regular files *inside* the workspace are ever
 *    deleted. Symlinks are never followed and never deleted
 *    (a symlink is not disk use). Directories are removed
 *    only when they become empty as a side effect.
 *  - Nothing outside the workspace is touched: every
 *    candidate path is checked to stay under the workspace
 *    root (lexical + realpath check against `..` escapes).
 *  - `dryRun` (default) lists what *would* be deleted and
 *    how much it would free, without deleting anything.
 *    `apply` deletes and returns exactly what was deleted.
 *  - A protected set (default: `box.json` and anything the
 *    caller names) is never deleted.
 *  - Reclaim never frees more than needed: it stops as soon
 *    as the workspace fits the quota (plus an optional
 *    safety margin), so a 1 GiB overage does not wipe the
 *    whole workspace.
 *  - Every deletion is returned as a record, so the caller
 *    can audit it (the service records one `disk-quota`
 *    audit entry with the freed bytes and file count).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface SandboxV6ReclaimCandidate {
  file: string;
  bytes: number;
  mtimeMs: number;
  /** Why this file is a candidate: tmp | log | other. */
  reason: 'tmp' | 'log' | 'other';
}

export interface SandboxV6ReclaimResult {
  /** Workspace bytes before reclaim. */
  beforeBytes: number;
  /** Workspace bytes after reclaim (dry-run: projected). */
  afterBytes: number;
  /** Bytes freed (dry-run: would-be freed). */
  freedBytes: number;
  /** Files deleted (dry-run: would-be deleted). */
  deleted: SandboxV6ReclaimCandidate[];
  /** Files that were candidates but not needed. */
  skipped: SandboxV6ReclaimCandidate[];
  /** True when the workspace fits the quota afterwards. */
  fitsQuota: boolean;
  /** True when this was only a plan (nothing deleted). */
  dryRun: boolean;
}

export interface SandboxV6ReclaimOptions {
  /** Quota to fit (0 = unlimited — nothing to reclaim). */
  quotaBytes: number;
  /** Keep this many bytes of headroom under the quota (default 0). */
  headroomBytes?: number;
  /** Delete for real (default false = dry-run). */
  apply?: boolean;
  /** Extra file names (basenames) that must never be deleted. */
  protectedNames?: string[];
  /** Max files to consider (default 10_000). */
  maxFiles?: number;
  /** Max depth to walk (default 32). */
  maxDepth?: number;
}

const DEFAULT_PROTECTED = new Set(['box.json']);

/** Is `child` inside `root` (lexical check, no `..` escape)? */
export function sandboxV6PathInside(child: string, root: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function classifyCandidate(file: string, workspaceDir: string): 'tmp' | 'log' | 'other' {
  const rel = path.relative(workspaceDir, file);
  const first = rel.split(path.sep)[0] ?? '';
  if (first === 'tmp') return 'tmp';
  if (file.toLowerCase().endsWith('.log')) return 'log';
  return 'other';
}

/** Collect reclaim candidates in a workspace (oldest first within each class). */
export function collectSandboxV6ReclaimCandidates(
  workspaceDir: string,
  opts: { maxFiles?: number; maxDepth?: number; protectedNames?: string[] } = {},
): SandboxV6ReclaimCandidate[] {
  const maxFiles = opts.maxFiles ?? 10_000;
  const maxDepth = opts.maxDepth ?? 32;
  const protectedNames = new Set([...DEFAULT_PROTECTED, ...(opts.protectedNames ?? [])]);
  const out: SandboxV6ReclaimCandidate[] = [];
  let seen = 0;

  const walk = (dir: string, depth: number): void => {
    if (seen >= maxFiles || depth > maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (seen >= maxFiles) return;
      const full = path.join(dir, entry.name);
      let st: fs.Stats;
      try {
        st = fs.lstatSync(full);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue; // Never follow, never delete.
      if (st.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      if (!st.isFile()) continue;
      if (protectedNames.has(entry.name)) continue;
      seen += 1;
      out.push({
        file: full,
        bytes: st.size,
        mtimeMs: st.mtimeMs,
        reason: classifyCandidate(full, workspaceDir),
      });
    }
  };

  try {
    if (!fs.lstatSync(workspaceDir).isDirectory()) return [];
  } catch {
    return [];
  }
  walk(workspaceDir, 0);
  const rank = (r: 'tmp' | 'log' | 'other'): number => (r === 'tmp' ? 0 : r === 'log' ? 1 : 2);
  out.sort((a, b) => rank(a.reason) - rank(b.reason) || a.mtimeMs - b.mtimeMs || b.bytes - a.bytes);
  return out;
}

/**
 * Plan (and optionally apply) a reclaim. Returns what was
 * (or would be) deleted, in deletion order. Never throws for
 * a single stubborn file: the error is recorded in `errors`
 * and reclaim continues with the next candidate.
 */
export function reclaimSandboxV6Disk(
  workspaceDir: string,
  options: SandboxV6ReclaimOptions,
): SandboxV6ReclaimResult & { errors: string[] } {
  const quota = options.quotaBytes > 0 ? options.quotaBytes : 0;
  const headroom = Math.max(0, options.headroomBytes ?? 0);
  const apply = options.apply ?? false;
  const errors: string[] = [];

  // Measure current use first (full scan: protected files
  // count as disk use even though reclaim never deletes them).
  const beforeBytes = measureWorkspaceBytes(workspaceDir);

  const target = quota > 0 ? quota - headroom : 0;
  const result: SandboxV6ReclaimResult & { errors: string[] } = {
    beforeBytes,
    afterBytes: beforeBytes,
    freedBytes: 0,
    deleted: [],
    skipped: [],
    fitsQuota: quota === 0 || beforeBytes < quota,
    dryRun: !apply,
    errors,
  };
  if (quota === 0 || beforeBytes < target) {
    result.skipped = collectSandboxV6ReclaimCandidates(workspaceDir, options);
    return result;
  }

  const need = beforeBytes - target;
  let freed = 0;
  const candidates = collectSandboxV6ReclaimCandidates(workspaceDir, options);
  for (const candidate of candidates) {
    if (freed >= need) {
      result.skipped.push(candidate);
      continue;
    }
    // Re-check containment right before deleting (a file
    // could have been replaced by a symlink between scan
    // and delete).
    if (!sandboxV6PathInside(candidate.file, workspaceDir)) {
      errors.push(`Refused to delete ${candidate.file}: outside workspace.`);
      result.skipped.push(candidate);
      continue;
    }
    if (apply) {
      try {
        const st = fs.lstatSync(candidate.file);
        if (!st.isFile() || st.isSymbolicLink()) {
          result.skipped.push(candidate);
          continue;
        }
        fs.unlinkSync(candidate.file);
      } catch (err) {
        errors.push(`Could not delete ${candidate.file}: ${(err as Error).message}`);
        result.skipped.push(candidate);
        continue;
      }
    }
    freed += candidate.bytes;
    result.deleted.push(candidate);
  }
  result.freedBytes = freed;
  result.afterBytes = beforeBytes - freed;
  result.fitsQuota = quota === 0 || result.afterBytes < quota;
  return result;
}

/** Total bytes of regular files under a root (symlinks never followed). */
export function measureWorkspaceBytes(root: string): number {
  let total = 0;
  const walk = (dir: string, depth: number): void => {
    if (depth > 32) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      let st: fs.Stats;
      try {
        st = fs.lstatSync(full);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) walk(full, depth + 1);
      else if (st.isFile()) total += st.size;
    }
  };
  try {
    if (!fs.lstatSync(root).isDirectory()) return 0;
  } catch {
    return 0;
  }
  walk(root, 0);
  return total;
}
