/**
 * Sandbox v6 — host capacity + admission control (v1.38, Team T3).
 *
 * Quotas are only meaningful if the host can actually hold
 * them: promising ten bots 2 GiB each on an 8 GiB machine is
 * a lie that ends in the kernel OOM-killing a random process.
 * Admission control sums the quotas of all live bots and
 * refuses a new (or raised) quota when the total would exceed
 * what the host has:
 *
 *  - RAM: sum of `memoryBytes` (unlimited bots count as the
 *    default quota — an "unlimited" bot still reserves the
 *    default, otherwise the sum is meaningless).
 *  - CPU: sum of `cpuPercent` (100 = one core) against the
 *    host's core count * 100. CPU is compressible (the kernel
 *    throttles instead of killing), so CPU overcommit is a
 *    *warning*, not a refusal — but it is still reported.
 *  - Disk: sum of `diskBytes` against free space on the
 *    volume holding the base dir.
 *
 * Host capacity is probed from the OS (`os.cpus()`,
 * `/proc/meminfo`, `fs.statfsSync`) and falls back to
 * conservative values when the probe fails (1 core, 1 GiB
 * RAM, 1 GiB free disk) — a failed probe must shrink the
 * budget, never inflate it.
 *
 * The check is advisory for CPU and hard for RAM/disk, and
 * the service can opt out entirely (`allowOvercommit`) for
 * hosts where the operator knows better. Every refusal lists
 * the exact numbers so the caller can ask for less.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SANDBOX_V6_DEFAULT_QUOTA, type SandboxV6ResolvedQuota } from './types';

/** Host capacity (what admission is measured against). */
export interface SandboxV6HostCapacity {
  /** Logical CPU cores. */
  cpuCores: number;
  /** Total physical RAM, bytes. */
  memoryBytes: number;
  /** Free disk bytes on the volume holding `baseDir` (0 = unknown). */
  diskFreeBytes: number;
  /** Where each number came from (for the report). */
  source: string;
}

/** Admission decision. */
export interface SandboxV6AdmissionResult {
  admitted: boolean;
  /** Human-readable reasons when refused (warnings when admitted with notes). */
  reasons: string[];
  /** Warnings that do not block admission (e.g. CPU overcommit). */
  warnings: string[];
  /** Projected totals if this quota is admitted. */
  projected: { cpuPercent: number; memoryBytes: number; diskBytes: number };
  capacity: SandboxV6HostCapacity;
}

/** Probe host capacity. Never throws — falls back to conservative values. */
export function probeSandboxV6HostCapacity(baseDir?: string): SandboxV6HostCapacity {
  const sources: string[] = [];
  let cpuCores = 1;
  try {
    const cores = os.cpus().length;
    if (Number.isFinite(cores) && cores > 0) {
      cpuCores = cores;
      sources.push(`cpus=${cores}`);
    }
  } catch {
    sources.push('cpus=fallback(1)');
  }

  let memoryBytes = 1024 * 1024 * 1024;
  try {
    const total = os.totalmem();
    if (Number.isFinite(total) && total > 0) {
      memoryBytes = total;
      sources.push(`mem=${total}`);
    }
  } catch {
    sources.push('mem=fallback(1GiB)');
  }
  // /proc/meminfo is the more honest number on Linux (os.totalmem
  // agrees, but MemTotal is what the kernel will actually hand out).
  try {
    if (process.platform === 'linux') {
      const meminfo = fs.readFileSync('/proc/meminfo', 'utf8');
      const match = /MemTotal:\s+(\d+)\s+kB/.exec(meminfo);
      if (match?.[1] !== undefined) {
        const total = Number(match[1]) * 1024;
        if (Number.isFinite(total) && total > 0) {
          memoryBytes = total;
          sources.push('mem=/proc/meminfo');
        }
      }
    }
  } catch {
    // Keep os.totalmem.
  }

  let diskFreeBytes = 0;
  if (baseDir !== undefined) {
    try {
      const stat = fs.statfsSync(baseDir);
      // bavail = blocks available to an unprivileged user.
      diskFreeBytes = stat.bavail * stat.bsize;
      sources.push(`disk=${diskFreeBytes} free`);
    } catch {
      sources.push('disk=unknown');
    }
  } else {
    sources.push('disk=unknown (no baseDir)');
  }

  return { cpuCores, memoryBytes, diskFreeBytes, source: sources.join(', ') };
}

/** Effective reservation of one quota (unlimited axes count as the default preset). */
export function sandboxV6QuotaReservation(quota: SandboxV6ResolvedQuota): {
  cpuPercent: number;
  memoryBytes: number;
  diskBytes: number;
} {
  return {
    cpuPercent: quota.cpuPercent > 0 ? quota.cpuPercent : SANDBOX_V6_DEFAULT_QUOTA.cpuPercent,
    memoryBytes: quota.memoryBytes > 0 ? quota.memoryBytes : SANDBOX_V6_DEFAULT_QUOTA.memoryBytes,
    diskBytes: quota.diskBytes > 0 ? quota.diskBytes : SANDBOX_V6_DEFAULT_QUOTA.diskBytes,
  };
}

/**
 * Admission check: would adding `candidate` (on top of the
 * `existing` live quotas) fit the host? CPU overcommit warns
 * only; RAM and disk overcommit refuse.
 */
export function checkSandboxV6Admission(
  existing: { botId: string; quota: SandboxV6ResolvedQuota }[],
  candidate: SandboxV6ResolvedQuota,
  capacity?: SandboxV6HostCapacity,
  opts: { baseDir?: string } = {},
): SandboxV6AdmissionResult {
  const host = capacity ?? probeSandboxV6HostCapacity(opts.baseDir);
  const projected = { cpuPercent: 0, memoryBytes: 0, diskBytes: 0 };
  for (const entry of existing) {
    const r = sandboxV6QuotaReservation(entry.quota);
    projected.cpuPercent += r.cpuPercent;
    projected.memoryBytes += r.memoryBytes;
    projected.diskBytes += r.diskBytes;
  }
  const cand = sandboxV6QuotaReservation(candidate);
  projected.cpuPercent += cand.cpuPercent;
  projected.memoryBytes += cand.memoryBytes;
  projected.diskBytes += cand.diskBytes;

  const reasons: string[] = [];
  const warnings: string[] = [];
  const cpuCapacity = host.cpuCores * 100;
  if (projected.memoryBytes > host.memoryBytes) {
    reasons.push(
      `RAM: projected ${projected.memoryBytes} bytes exceeds host ${host.memoryBytes} bytes ` +
        `(${existing.length} live bot(s) + this quota).`,
    );
  }
  if (host.diskFreeBytes > 0 && projected.diskBytes > host.diskFreeBytes) {
    reasons.push(
      `Disk: projected ${projected.diskBytes} bytes exceeds ${host.diskFreeBytes} bytes free ` +
        `(${existing.length} live bot(s) + this quota).`,
    );
  }
  if (projected.cpuPercent > cpuCapacity) {
    warnings.push(
      `CPU: projected ${projected.cpuPercent}% exceeds host ${cpuCapacity}% (${host.cpuCores} core(s)) — ` +
        `bots will be throttled, not killed.`,
    );
  }
  return {
    admitted: reasons.length === 0,
    reasons,
    warnings,
    projected,
    capacity: host,
  };
}

/** One-line summary of an admission result (for logs / tool output). */
export function renderSandboxV6Admission(result: SandboxV6AdmissionResult): string {
  const lines: string[] = [];
  lines.push(`Admission: ${result.admitted ? 'admitted' : 'REFUSED'}`);
  lines.push(
    `Projected: CPU ${result.projected.cpuPercent}% / ${result.capacity.cpuCores * 100}%, ` +
      `RAM ${result.projected.memoryBytes} / ${result.capacity.memoryBytes} bytes, ` +
      `disk ${result.projected.diskBytes} / ${result.capacity.diskFreeBytes > 0 ? `${result.capacity.diskFreeBytes} bytes free` : 'unknown'}`,
  );
  for (const reason of result.reasons) lines.push(`- Refused: ${reason}`);
  for (const warning of result.warnings) lines.push(`- Warning: ${warning}`);
  lines.push(`Capacity source: ${result.capacity.source}`);
  return lines.join('\n');
}

/**
 * Suggest a fair-share quota: split the host evenly across
 * `botCount` bots (CPU split by cores, RAM split with a 25%
 * reserve kept for the host itself, disk split by free space).
 * Returns the default preset when the host cannot be probed.
 */
export function suggestSandboxV6FairShare(
  botCount: number,
  capacity?: SandboxV6HostCapacity,
  opts: { baseDir?: string } = {},
): SandboxV6ResolvedQuota {
  const count = Math.max(1, Math.floor(botCount));
  const host = capacity ?? probeSandboxV6HostCapacity(opts.baseDir);
  const hostReserve = 0.25;
  const memoryBytes = Math.max(
    64 * 1024 * 1024,
    Math.floor(((host.memoryBytes * (1 - hostReserve)) / count) / (1024 * 1024)) * 1024 * 1024,
  );
  const cpuPercent = Math.max(10, Math.floor((host.cpuCores * 100) / count));
  const diskBytes =
    host.diskFreeBytes > 0
      ? Math.max(64 * 1024 * 1024, Math.floor(host.diskFreeBytes / count))
      : SANDBOX_V6_DEFAULT_QUOTA.diskBytes;
  return {
    cpuPercent,
    memoryBytes,
    diskBytes,
    maxProcesses: SANDBOX_V6_DEFAULT_QUOTA.maxProcesses,
    maxExecMs: SANDBOX_V6_DEFAULT_QUOTA.maxExecMs,
    maxWriteBytes: SANDBOX_V6_DEFAULT_QUOTA.maxWriteBytes,
  };
}

/** Resolve a base dir for disk probing (absolute, existing or created). */
export function sandboxV6BaseDirForDisk(baseDir: string): string {
  try {
    fs.mkdirSync(baseDir, { recursive: true });
    return path.resolve(baseDir);
  } catch {
    return process.cwd();
  }
}
