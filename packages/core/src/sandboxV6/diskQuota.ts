/**
 * Sandbox v6 — disk quota by measurement (v1.38, Team T3).
 *
 * cgroup v2 has no disk *capacity* controller (only I/O rate
 * via `io.max`, handled in cgroupEnforcer.ts), so the disk
 * quota is enforced by measuring the bot's workspace:
 *
 *  - `measureWorkspace()` walks the workspace tree and sums
 *    real file sizes. Symlinks are never followed (a symlink
 *    pointing outside the workspace must not let a bot hide
 *    usage — or count the host's files against its quota), and
 *    the walk is capped (max files / max depth) so a bot that
 *    creates a million tiny files cannot DoS the measurer.
 *  - `checkDiskQuota()` compares the measurement against the
 *    quota: over quota (refuse new execs), near quota (>= 90%,
 *    warn), or fine.
 *  - `enforceDiskQuotaBeforeExec()` is the gate the runtime
 *    calls before every exec: it returns `allowed: false` with
 *    a reason when the workspace is already over quota, so the
 *    exec is refused and audited instead of running.
 *
 * The scan is synchronous and cheap for normal workspaces
 * (tens of thousands of files); the caps keep the worst case
 * bounded. Sizes are exact file sizes (not disk blocks) —
 * documented as an approximation of disk use, not a billing
 * figure.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SandboxV6DiskCheck } from './types';

/** Default walk caps. */
export const SANDBOX_V6_DISK_SCAN_MAX_FILES = 100_000;
export const SANDBOX_V6_DISK_SCAN_MAX_DEPTH = 32;
/** Warn when usage reaches this fraction of the quota. */
export const SANDBOX_V6_DISK_WARN_RATIO = 0.9;

export interface SandboxV6WorkspaceMeasure {
  /** Total bytes of regular files inside the workspace. */
  bytes: number;
  /** Regular files counted. */
  files: number;
  /** Directories visited. */
  dirs: number;
  /** Symlinks seen (counted, never followed). */
  symlinks: number;
  /** True when a cap stopped the walk early (measurement is a lower bound). */
  truncated: boolean;
}

/**
 * Measure a workspace tree. Never follows symlinks, never
 * leaves the tree, never throws for unreadable entries (they
 * are skipped and counted in `unreadable`). A missing root
 * measures as zero, not as an error.
 */
export function measureWorkspace(
  root: string,
  opts: { maxFiles?: number; maxDepth?: number } = {},
): SandboxV6WorkspaceMeasure {
  const maxFiles = opts.maxFiles ?? SANDBOX_V6_DISK_SCAN_MAX_FILES;
  const maxDepth = opts.maxDepth ?? SANDBOX_V6_DISK_SCAN_MAX_DEPTH;
  const out: SandboxV6WorkspaceMeasure = { bytes: 0, files: 0, dirs: 0, symlinks: 0, truncated: false };
  let unreadable = 0;

  const walk = (dir: string, depth: number): void => {
    if (out.truncated || depth > maxDepth) {
      if (depth > maxDepth) out.truncated = true;
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      unreadable += 1;
      return;
    }
    for (const entry of entries) {
      if (out.files >= maxFiles) {
        out.truncated = true;
        return;
      }
      const full = path.join(dir, entry.name);
      // lstat, never stat: a symlink is reported as a symlink
      // and never followed, wherever it points.
      let st: fs.Stats;
      try {
        st = fs.lstatSync(full);
      } catch {
        unreadable += 1;
        continue;
      }
      if (st.isSymbolicLink()) {
        out.symlinks += 1;
        continue;
      }
      if (st.isDirectory()) {
        out.dirs += 1;
        walk(full, depth + 1);
        continue;
      }
      if (st.isFile()) {
        out.files += 1;
        out.bytes += st.size;
        continue;
      }
      // Sockets, fifos, devices: not counted as disk use.
    }
  };

  try {
    const rootStat = fs.lstatSync(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return out;
  } catch {
    return out; // Missing root = empty workspace.
  }
  out.dirs = 1;
  walk(root, 0);
  void unreadable; // Unreadable entries are skipped by design; see docs above.
  return out;
}

/** Compare a measurement against a quota. */
export function checkDiskQuota(
  measured: SandboxV6WorkspaceMeasure,
  quotaBytes: number,
): SandboxV6DiskCheck {
  const quota = quotaBytes > 0 ? quotaBytes : 0;
  const ratio = quota > 0 ? measured.bytes / quota : 0;
  return {
    usedBytes: measured.bytes,
    quotaBytes: quota,
    files: measured.files,
    overQuota: quota > 0 && measured.bytes >= quota,
    nearQuota: quota > 0 && ratio >= SANDBOX_V6_DISK_WARN_RATIO && measured.bytes < quota,
    ratio,
  };
}

/** Measure a workspace and check it against a quota in one call. */
export function measureAndCheckDiskQuota(
  root: string,
  quotaBytes: number,
  opts: { maxFiles?: number; maxDepth?: number } = {},
): SandboxV6DiskCheck & { truncated: boolean; symlinks: number } {
  const measured = measureWorkspace(root, opts);
  const check = checkDiskQuota(measured, quotaBytes);
  return { ...check, truncated: measured.truncated, symlinks: measured.symlinks };
}

/** Gate result for "may this bot run a new exec right now?" */
export interface SandboxV6DiskGate {
  allowed: boolean;
  /** Reason when refused (undefined when allowed). */
  reason?: string;
  check: SandboxV6DiskCheck;
}

/**
 * The pre-exec disk gate: measure the workspace, refuse when
 * over quota. The check result is returned so the caller can
 * audit it (including the refused case).
 */
export function enforceDiskQuotaBeforeExec(
  workdir: string,
  quotaBytes: number,
  opts: { maxFiles?: number; maxDepth?: number } = {},
): SandboxV6DiskGate {
  const measured = measureWorkspace(workdir, opts);
  const check = checkDiskQuota(measured, quotaBytes);
  if (check.overQuota) {
    return {
      allowed: false,
      reason:
        `Disk quota exceeded: workspace uses ${check.usedBytes} bytes ` +
        `(quota ${check.quotaBytes} bytes, ${check.files} files). Free space or raise the quota before running more commands.`,
      check,
    };
  }
  return { allowed: true, check };
}

/**
 * Find the largest files in a workspace (for the "what is
 * eating my quota" report). Returns at most `limit` entries,
 * largest first. Symlinks are skipped, never followed.
 */
export function largestWorkspaceFiles(
  root: string,
  limit = 10,
  opts: { maxFiles?: number; maxDepth?: number } = {},
): { file: string; bytes: number }[] {
  const maxFiles = opts.maxFiles ?? SANDBOX_V6_DISK_SCAN_MAX_FILES;
  const maxDepth = opts.maxDepth ?? SANDBOX_V6_DISK_SCAN_MAX_DEPTH;
  const found: { file: string; bytes: number }[] = [];
  let seen = 0;
  let truncated = false;

  const walk = (dir: string, depth: number): void => {
    if (truncated || depth > maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (seen >= maxFiles) {
        truncated = true;
        return;
      }
      const full = path.join(dir, entry.name);
      let st: fs.Stats;
      try {
        st = fs.lstatSync(full);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      if (st.isFile()) {
        seen += 1;
        found.push({ file: full, bytes: st.size });
      }
    }
  };

  try {
    if (!fs.lstatSync(root).isDirectory()) return [];
  } catch {
    return [];
  }
  walk(root, 0);
  void truncated;
  found.sort((a, b) => b.bytes - a.bytes);
  return found.slice(0, Math.max(0, limit));
}
