/**
 * Sandbox v6 — cgroup v2 enforcer (v1.38, Team T3).
 *
 * Real kernel enforcement of a bot's quota, one cgroup per bot:
 *
 *  - `cpu.max` — CPU quota: `<quota_usec> <period_usec>`, quota
 *    derived from `cpuPercent` (100% = one full core at the
 *    100ms period). `cpu.weight` is NOT used: weight only orders
 *    contended CPU, it never caps it.
 *  - `memory.max` — physical RAM, delegated to the existing
 *    `CgroupMemoryLimiter` (compute/cgroup.ts) so the two paths
 *    never disagree about file layout or cleanup.
 *  - `pids.max` — fork-bomb guard.
 *  - `io.max` — best-effort disk I/O throttle (`rbps`/`wbps`
 *    on the root device when it can be found; skipped silently
 *    when the device cannot be resolved — a throttle that
 *    cannot be written is not a quota that can be claimed).
 *
 * Every file operation goes through an injectable `cgroupRoot`
 * so tests run against a fake cgroup tree (plain directory
 * with regular files) and never touch `/sys/fs/cgroup`.
 * `probeSandboxV6Cgroup()` (no args) is the only function
 * that touches the real tree, and it only reads + creates and
 * removes its own probe cgroup.
 *
 * Failure policy: `create()` throws when a *requested* limit
 * cannot be written (fail-closed — a bot must not run thinking
 * it is capped when it is not). Best-effort files (`io.max`,
 * `memory.swap.max`) warn and continue. `destroy()` never
 * throws: a leftover empty cgroup is harmless.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { CGROUP_NAME_PREFIX, CGROUP_ROOT_DEFAULT, CgroupMemoryLimiter } from '../compute/cgroup';
import {
  SANDBOX_V6_CPU_PERIOD_USEC,
  SANDBOX_V6_MIN_CPU_QUOTA_USEC,
  formatSandboxV6Bytes,
  type SandboxV6CgroupProbe,
  type SandboxV6Quota,
  type SandboxV6ResolvedQuota,
} from './types';

const CGROUP_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** cgroup name for a bot runtime. */
export function sandboxV6CgroupName(botId: string, runtimeId: string): string {
  return `${CGROUP_NAME_PREFIX}v6-${botId}-${runtimeId.slice(0, 8)}`;
}

/**
 * Probe the real cgroup tree for the controllers v5 needs.
 * Never throws: every failure becomes `available: false` + reason.
 */
export function probeSandboxV6Cgroup(opts: { cgroupRoot?: string } = {}): SandboxV6CgroupProbe {
  const root = opts.cgroupRoot ?? CGROUP_ROOT_DEFAULT;
  const empty: SandboxV6CgroupProbe = {
    available: false,
    cpu: false,
    memory: false,
    pids: false,
    io: false,
  };
  try {
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
      return { ...empty, reason: `No cgroup directory: ${root}` };
    }
    let controllers = '';
    try {
      controllers = fs.readFileSync(path.join(root, 'cgroup.controllers'), 'utf8');
    } catch {
      return { ...empty, reason: `Cannot read ${path.join(root, 'cgroup.controllers')}` };
    }
    const set = new Set(controllers.split(/\s+/).filter(Boolean));
    const probe: SandboxV6CgroupProbe = {
      available: false,
      cpu: set.has('cpu'),
      memory: set.has('memory'),
      pids: set.has('pids'),
      io: set.has('io'),
    };
    if (!probe.cpu && !probe.memory && !probe.pids) {
      return {
        ...probe,
        reason:
          'No usable controller delegated to this process (cgroup.controllers has none of cpu/memory/pids) — this machine cannot enforce per-bot quotas with cgroup v2.',
      };
    }
    // Prove write access: create a probe cgroup, write cpu.max + memory.max, remove it.
    const probeName = `${CGROUP_NAME_PREFIX}v6-probe-${process.pid}`;
    const probeDir = path.join(root, probeName);
    try {
      fs.mkdirSync(probeDir);
    } catch (err) {
      return { ...probe, reason: `Cannot create a cgroup in ${root}: ${(err as Error).message}` };
    }
    try {
      if (probe.cpu) fs.writeFileSync(path.join(probeDir, 'cpu.max'), 'max 100000', 'utf8');
      if (probe.memory) fs.writeFileSync(path.join(probeDir, 'memory.max'), 'max', 'utf8');
    } catch (err) {
      removeCgroupDirBestEffort(probeDir);
      return { ...probe, reason: `Cannot write limits in a cgroup: ${(err as Error).message}` };
    }
    removeCgroupDirBestEffort(probeDir);
    return { ...probe, available: true };
  } catch (err) {
    return { ...empty, reason: `cgroup probe failed: ${(err as Error).message}` };
  }
}

function removeCgroupDirBestEffort(dir: string): void {
  try {
    fs.rmdirSync(dir);
    return;
  } catch {
    // Real cgroup with processes left, or fake tree with control files.
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup.
  }
}

/** Parse a cpu.stat file (`usage_usec 1234` lines) into a map. */
export function parseSandboxV6CpuStat(text: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const line of text.split('\n')) {
    const [key, value] = line.trim().split(/\s+/);
    if (!key || value === undefined) continue;
    const n = Number(value);
    if (Number.isFinite(n)) out.set(key, n);
  }
  return out;
}

/** Parse an io.stat file (`8:0 rbytes=... wbytes=...` lines). */
export function parseSandboxV6IoStat(text: string): { readBytes: number; writeBytes: number } {
  let readBytes = 0;
  let writeBytes = 0;
  for (const line of text.split('\n')) {
    for (const part of line.trim().split(/\s+/)) {
      const [key, value] = part.split('=');
      if (key === 'rbytes') readBytes += Number(value) || 0;
      if (key === 'wbytes') writeBytes += Number(value) || 0;
    }
  }
  return { readBytes, writeBytes };
}

/** Convert a CPU percent into a `cpu.max` quota (microseconds per period). */
export function sandboxV6CpuQuotaUsec(cpuPercent: number): number {
  if (cpuPercent <= 0) return 0; // 0 = unlimited ("max").
  return Math.max(
    SANDBOX_V6_MIN_CPU_QUOTA_USEC,
    Math.round((cpuPercent / 100) * SANDBOX_V6_CPU_PERIOD_USEC),
  );
}

export interface SandboxV6CgroupEnforcerOptions {
  /** cgroup root (default /sys/fs/cgroup; tests pass a temp dir). */
  cgroupRoot?: string;
  /** cgroup name (e.g. `open-bot-v6-<bot>-<id8>`). */
  name: string;
  logger?: { warn(message: string): void };
}

/**
 * One cgroup v2 for one bot runtime. Wraps the existing memory
 * limiter for RAM and adds CPU / pids / I/O on the same directory,
 * so `memory.max` and `cpu.max` always describe the same group
 * of processes. Children inherit the cgroup on fork, so attaching
 * the box process covers its whole process tree.
 */
export class SandboxV6CgroupEnforcer {
  readonly cgroupRoot: string;
  readonly name: string;
  private readonly warn: (message: string) => void;
  private readonly memory: CgroupMemoryLimiter;
  private createdFlag = false;
  private quota: SandboxV6ResolvedQuota | null = null;

  constructor(options: SandboxV6CgroupEnforcerOptions) {
    if (!CGROUP_NAME_RE.test(options.name) || options.name.includes('..')) {
      throw new Error(`Invalid cgroup name "${options.name}": use letters, digits, ".", "-" and "_" only.`);
    }
    this.cgroupRoot = options.cgroupRoot ?? CGROUP_ROOT_DEFAULT;
    this.name = options.name;
    this.warn = options.logger ? (m) => options.logger?.warn(m) : () => undefined;
    this.memory = new CgroupMemoryLimiter({
      ...(options.cgroupRoot !== undefined ? { cgroupRoot: options.cgroupRoot } : {}),
      name: options.name,
      logger: options.logger,
    });
  }

  /** Directory of this cgroup. */
  get dir(): string {
    return path.join(this.cgroupRoot, this.name);
  }

  /** True when this enforcer created the cgroup. */
  get created(): boolean {
    return this.createdFlag;
  }

  /** Quota currently in force (null before create). */
  get currentQuota(): SandboxV6ResolvedQuota | null {
    return this.quota;
  }

  /**
   * Create the cgroup and write every requested limit.
   * Idempotent: calling again only rewrites the limits.
   * Throws when a requested limit cannot be written — the
   * caller must then refuse to run the bot under a false cap.
   * Controllers that are absent from the (fake or real) tree
   * are skipped with a warning, and the skip is recorded in
   * the returned `applied` list so the runtime can report the
   * real enforcement mode honestly.
   */
  create(quota: SandboxV6ResolvedQuota): { applied: string[]; skipped: string[] } {
    const applied: string[] = [];
    const skipped: string[] = [];
    if (!fs.existsSync(this.dir)) {
      fs.mkdirSync(this.dir, { recursive: false });
    }
    this.createdFlag = true;
    this.quota = { ...quota };

    // CPU: cpu.max "<quota> <period>", or "max 100000" for unlimited.
    const cpuQuota = sandboxV6CpuQuotaUsec(quota.cpuPercent);
    const cpuValue = cpuQuota > 0 ? `${cpuQuota} ${SANDBOX_V6_CPU_PERIOD_USEC}` : `max ${SANDBOX_V6_CPU_PERIOD_USEC}`;
    if (this.writeFile('cpu.max', cpuValue, quota.cpuPercent > 0)) {
      applied.push(`cpu.max=${cpuValue}`);
    } else {
      skipped.push('cpu');
    }

    // RAM: delegate to the existing limiter (also sets memory.swap.max=0).
    if (quota.memoryBytes > 0) {
      try {
        if (!this.memory.created) this.memory.create(quota.memoryBytes);
        else this.memory.setLimit(quota.memoryBytes);
        applied.push(`memory.max=${quota.memoryBytes}`);
      } catch (err) {
        throw new Error(`Cannot write memory.max for cgroup ${this.name}: ${(err as Error).message}`);
      }
    } else {
      // Unlimited RAM: still create the group, but leave memory.max at "max".
      if (this.tryWriteFile('memory.max', 'max')) applied.push('memory.max=max');
      else skipped.push('memory');
    }

    // Fork-bomb guard.
    if (quota.maxProcesses > 0) {
      if (this.writeFile('pids.max', String(quota.maxProcesses), true)) {
        applied.push(`pids.max=${quota.maxProcesses}`);
      } else {
        skipped.push('pids');
      }
    } else if (this.tryWriteFile('pids.max', 'max')) {
      applied.push('pids.max=max');
    } else {
      skipped.push('pids');
    }

    // I/O throttle: best-effort only (device resolution may fail).
    const io = this.tryWriteIoMax(quota);
    if (io !== null) applied.push(io);
    else skipped.push('io');

    return { applied, skipped };
  }

  /** Change the quota of a live cgroup (same rules as create). */
  setQuota(quota: SandboxV6ResolvedQuota): { applied: string[]; skipped: string[] } {
    if (!this.createdFlag && !fs.existsSync(this.dir)) {
      throw new Error(`Cgroup not created: ${this.dir} — call create() first.`);
    }
    this.createdFlag = true;
    return this.create(quota);
  }

  /** Move a process (and, by inheritance, its whole tree) into this cgroup. */
  addPid(pid: number): void {
    if (!Number.isInteger(pid) || pid <= 0) {
      throw new Error(`Invalid pid ${pid}: must be a positive integer.`);
    }
    if (!this.createdFlag && !fs.existsSync(this.dir)) {
      throw new Error(`Cgroup not created: ${this.dir} — call create() before addPid().`);
    }
    try {
      fs.writeFileSync(path.join(this.dir, 'cgroup.procs'), String(pid), 'utf8');
    } catch (err) {
      throw new Error(`Cannot move pid ${pid} into cgroup ${this.name}: ${(err as Error).message}`);
    }
  }

  /** Read live usage from the cgroup files. Nulls when unreadable — never throws. */
  readUsage(): {
    cpuTimeUsec: number | null;
    memoryCurrentBytes: number | null;
    memoryPeakBytes: number | null;
    processCount: number | null;
    ioReadBytes: number | null;
    ioWriteBytes: number | null;
  } {
    const out = {
      cpuTimeUsec: null as number | null,
      memoryCurrentBytes: null as number | null,
      memoryPeakBytes: null as number | null,
      processCount: null as number | null,
      ioReadBytes: null as number | null,
      ioWriteBytes: null as number | null,
    };
    try {
      const stat = parseSandboxV6CpuStat(fs.readFileSync(path.join(this.dir, 'cpu.stat'), 'utf8'));
      const usage = stat.get('usage_usec');
      if (usage !== undefined) out.cpuTimeUsec = usage;
    } catch {
      // No cpu.stat — leave null.
    }
    const mem = this.memory.readUsage();
    if (mem !== null) {
      out.memoryCurrentBytes = mem.currentBytes;
      out.memoryPeakBytes = mem.peakBytes;
    }
    try {
      const procs = fs.readFileSync(path.join(this.dir, 'cgroup.procs'), 'utf8').trim();
      out.processCount = procs === '' ? 0 : procs.split('\n').filter(Boolean).length;
    } catch {
      // No cgroup.procs — leave null.
    }
    try {
      const io = parseSandboxV6IoStat(fs.readFileSync(path.join(this.dir, 'io.stat'), 'utf8'));
      out.ioReadBytes = io.readBytes;
      out.ioWriteBytes = io.writeBytes;
    } catch {
      // No io.stat — leave null.
    }
    return out;
  }

  /** Remove the cgroup. Never throws; warns when processes are still inside. */
  destroy(): void {
    this.createdFlag = false;
    this.quota = null;
    this.memory.destroy();
    if (fs.existsSync(this.dir)) {
      removeCgroupDirBestEffort(this.dir);
      if (fs.existsSync(this.dir)) {
        this.warn(`Cannot remove cgroup ${this.name} (processes may still be inside).`);
      }
    }
  }

  /** Human-readable one-line summary of the quota in force. */
  describeQuota(quota: SandboxV6ResolvedQuota): string {
    const parts: string[] = [];
    parts.push(quota.cpuPercent > 0 ? `CPU ${quota.cpuPercent}%` : 'CPU unlimited');
    parts.push(quota.memoryBytes > 0 ? `RAM ${formatSandboxV6Bytes(quota.memoryBytes)}` : 'RAM unlimited');
    parts.push(quota.diskBytes > 0 ? `disk ${formatSandboxV6Bytes(quota.diskBytes)}` : 'disk unlimited');
    parts.push(quota.maxProcesses > 0 ? `${quota.maxProcesses} procs` : 'procs unlimited');
    return parts.join(', ');
  }

  /** Write a control file; returns false (with a warning) when the file is absent. */
  private tryWriteFile(file: string, value: string): boolean {
    try {
      fs.writeFileSync(path.join(this.dir, file), value, 'utf8');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Write a control file. When `required` is true the file must
   * exist and the write must succeed (throws otherwise); when
   * false a missing file is a skip with a warning.
   */
  private writeFile(file: string, value: string, required: boolean): boolean {
    try {
      fs.writeFileSync(path.join(this.dir, file), value, 'utf8');
      return true;
    } catch (err) {
      if (required) {
        throw new Error(`Cannot write ${file} for cgroup ${this.name}: ${(err as Error).message}`);
      }
      this.warn(`cgroup ${this.name}: no ${file} file — ${file.split('.')[0]} limit not applied.`);
      return false;
    }
  }

  /**
   * Best-effort `io.max` throttle. The disk cap itself is
   * enforced by measurement (diskQuota.ts) because cgroup v2
   * has no capacity controller; this only throttles I/O rate
   * so one bot cannot starve the disk. Returns the applied
   * value, or null when it could not be written.
   */
  private tryWriteIoMax(quota: SandboxV6Quota): string | null {
    if ((quota.diskBytes ?? 0) <= 0 && (quota.cpuPercent ?? 0) <= 0) return null;
    // A conservative throttle: 32 MiB/s read + write per bot.
    // Device resolution (major:minor) needs /proc/diskstats and
    // the workspace device; on a fake tree or an unresolvable
    // device this is skipped silently — never faked as applied.
    try {
      const ioMaxPath = path.join(this.dir, 'io.max');
      if (!fs.existsSync(ioMaxPath)) return null;
      const device = this.resolveWorkspaceDevice();
      if (device === null) return null;
      fs.writeFileSync(ioMaxPath, `${device} rbps=33554432 wbps=33554432`, 'utf8');
      return `io.max=${device} rbps=32MiB/s wbps=32MiB/s`;
    } catch {
      return null;
    }
  }

  /** Resolve the workspace block device as `major:minor` (null when unknown). */
  private resolveWorkspaceDevice(): string | null {
    try {
      // Best-effort: /proc/self/mountinfo maps the cgroup root's
      // device; on non-Linux or in tests this file is absent.
      const mounts = fs.readFileSync('/proc/self/mountinfo', 'utf8');
      for (const line of mounts.split('\n')) {
        const fields = line.split(' ');
        if (fields.length < 3) continue;
        const majorMinor = fields[2];
        if (/^\d+:\d+$/.test(majorMinor ?? '')) return majorMinor ?? null;
      }
      return null;
    } catch {
      return null;
    }
  }
}
