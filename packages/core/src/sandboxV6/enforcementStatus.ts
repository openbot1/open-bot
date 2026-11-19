/**
 * Sandbox v6 — enforcement verification (v1.38, Team T3).
 *
 * Writing a limit into a cgroup file is not the same as the
 * limit staying there: another process, a host admin, or a
 * kernel quirk can change it afterwards. Verification re-reads
 * the live cgroup files and compares them against the quota
 * the runtime believes is in force:
 *
 *  - `cpu.max` must equal the quota derived from `cpuPercent`
 *    (`"max 100000"` when unlimited);
 *  - `memory.max` must equal the quota's `memoryBytes`
 *    (`"max"` when unlimited);
 *  - `pids.max` must equal `maxProcesses` (`"max"` when
 *    unlimited, i.e. when the preset kept the guard);
 *  - the cgroup directory must exist and `cgroup.procs` must
 *    be readable.
 *
 * Any mismatch is *drift*: the report lists exactly which
 * file disagrees and what it holds, so the operator can
 * re-apply the quota (`setQuota` rewrites every limit) or
 * investigate. Drift never silently re-applies: re-writing
 * limits behind the operator's back would hide the fact
 * that something else is touching the cgroups.
 *
 * On a fake cgroup tree (tests) the same code runs against
 * plain files, so drift detection is fully testable without
 * root or a real cgroup delegation.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { sandboxV6CpuQuotaUsec } from './cgroupEnforcer';
import { SANDBOX_V6_CPU_PERIOD_USEC } from './types';
import type { SandboxV6EnforcementMode, SandboxV6ResolvedQuota } from './types';

/** One drift finding: a cgroup file that disagrees with the quota. */
export interface SandboxV6EnforcementDrift {
  /** Control file (e.g. `cpu.max`). */
  file: string;
  /** What the quota says it should hold. */
  expected: string;
  /** What the file actually holds ('' when unreadable). */
  actual: string;
  /** Human-readable explanation. */
  reason: string;
}

/** Verification verdict for one bot's enforcement. */
export interface SandboxV6EnforcementStatus {
  botId: string;
  runtimeId: string;
  /** Enforcement mode the runtime claims. */
  mode: SandboxV6EnforcementMode;
  /** cgroup name ('' when none). */
  cgroupName: string;
  /** True when the cgroup directory exists. */
  cgroupExists: boolean;
  /** True when every readable control file matches the quota. */
  verified: boolean;
  /** Drift findings (empty when verified). */
  drift: SandboxV6EnforcementDrift[];
  /** Control files that could not be read at all. */
  unreadable: string[];
  /** When the check ran (ms since epoch). */
  checkedAtMs: number;
}

/** Read a cgroup control file, trimmed. Null when unreadable. */
export function readSandboxV6CgroupFile(cgroupDir: string, file: string): string | null {
  try {
    return fs.readFileSync(path.join(cgroupDir, file), 'utf8').trim();
  } catch {
    return null;
  }
}

/** Expected `cpu.max` content for a quota. */
export function expectedSandboxV6CpuMax(cpuPercent: number): string {
  const quota = sandboxV6CpuQuotaUsec(cpuPercent);
  return quota > 0 ? `${quota} ${SANDBOX_V6_CPU_PERIOD_USEC}` : `max ${SANDBOX_V6_CPU_PERIOD_USEC}`;
}

/** Expected `memory.max` content for a quota. */
export function expectedSandboxV6MemoryMax(memoryBytes: number): string {
  return memoryBytes > 0 ? String(memoryBytes) : 'max';
}

/** Expected `pids.max` content for a quota. */
export function expectedSandboxV6PidsMax(maxProcesses: number): string {
  return maxProcesses > 0 ? String(maxProcesses) : 'max';
}

/**
 * Verify one bot's cgroup against its quota. Never throws:
 * an unreadable tree becomes `verified: false` with the
 * files listed under `unreadable`.
 */
export function verifySandboxV6Enforcement(
  botId: string,
  runtimeId: string,
  mode: SandboxV6EnforcementMode,
  cgroupDir: string | null,
  quota: SandboxV6ResolvedQuota,
  nowMs: () => number = Date.now,
): SandboxV6EnforcementStatus {
  const status: SandboxV6EnforcementStatus = {
    botId,
    runtimeId,
    mode,
    cgroupName: cgroupDir !== null ? path.basename(cgroupDir) : '',
    cgroupExists: false,
    verified: false,
    drift: [],
    unreadable: [],
    checkedAtMs: nowMs(),
  };
  if (mode !== 'cgroup' || cgroupDir === null) {
    // Nothing to verify: prlimit/none modes have no cgroup
    // files. The status says so instead of faking a pass.
    status.unreadable.push('(no cgroup — enforcement mode is ' + mode + ')');
    return status;
  }
  let exists = false;
  try {
    exists = fs.existsSync(cgroupDir) && fs.statSync(cgroupDir).isDirectory();
  } catch {
    exists = false;
  }
  status.cgroupExists = exists;
  if (!exists) {
    status.drift.push({
      file: '(cgroup dir)',
      expected: `directory ${cgroupDir}`,
      actual: '(missing)',
      reason: 'The cgroup directory does not exist — the bot is running without kernel limits.',
    });
    return status;
  }

  const checks: { file: string; expected: string }[] = [
    { file: 'cpu.max', expected: expectedSandboxV6CpuMax(quota.cpuPercent) },
    { file: 'memory.max', expected: expectedSandboxV6MemoryMax(quota.memoryBytes) },
    { file: 'pids.max', expected: expectedSandboxV6PidsMax(quota.maxProcesses) },
  ];
  for (const check of checks) {
    const actual = readSandboxV6CgroupFile(cgroupDir, check.file);
    if (actual === null) {
      status.unreadable.push(check.file);
      continue;
    }
    if (actual !== check.expected) {
      status.drift.push({
        file: check.file,
        expected: check.expected,
        actual,
        reason: `${check.file} holds "${actual}" but the quota requires "${check.expected}" — the limit was changed outside sandbox v6.`,
      });
    }
  }
  // cgroup.procs must at least be readable (it lists the
  // processes currently limited). Its content changes as
  // processes spawn/exit, so only readability is checked.
  if (readSandboxV6CgroupFile(cgroupDir, 'cgroup.procs') === null) {
    status.unreadable.push('cgroup.procs');
  }
  status.verified = status.drift.length === 0 && status.unreadable.length === 0;
  return status;
}

/** One-line verdict for a status (for logs / tool output). */
export function renderSandboxV6EnforcementStatus(status: SandboxV6EnforcementStatus): string {
  if (status.mode !== 'cgroup') {
    return `Bot "${status.botId}": enforcement ${status.mode} — nothing to verify (no cgroup).`;
  }
  if (!status.cgroupExists) {
    return `Bot "${status.botId}": cgroup ${status.cgroupName} MISSING — running without kernel limits.`;
  }
  if (status.verified) {
    return `Bot "${status.botId}": cgroup ${status.cgroupName} verified — cpu.max, memory.max, pids.max all match the quota.`;
  }
  const parts: string[] = [`Bot "${status.botId}": cgroup ${status.cgroupName} DRIFT:`];
  for (const d of status.drift) parts.push(`- ${d.file}: expected "${d.expected}", actual "${d.actual}"`);
  for (const f of status.unreadable) parts.push(`- ${f}: unreadable`);
  return parts.join('\n');
}

/** Summarise verification across many bots (for the fleet report). */
export function summarizeSandboxV6Enforcement(
  statuses: SandboxV6EnforcementStatus[],
): { total: number; verified: number; drifted: number; unverifiable: number; driftedBots: string[] } {
  let verified = 0;
  let drifted = 0;
  let unverifiable = 0;
  const driftedBots: string[] = [];
  for (const s of statuses) {
    if (s.mode !== 'cgroup') {
      unverifiable += 1;
      continue;
    }
    if (s.verified) verified += 1;
    else {
      drifted += 1;
      driftedBots.push(s.botId);
    }
  }
  return { total: statuses.length, verified, drifted, unverifiable, driftedBots };
}
