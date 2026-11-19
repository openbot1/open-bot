/**
 * Sandbox v6 — per-bot runtime: shared types (v1.38, Team T3).
 *
 * One layer above sandbox v4: v4 gives a per-conversation runtime
 * (its own v3 session, workspace, budget meter, secret requests);
 * v5 ties that isolation to a *bot* and enforces it with the
 * operating system, not just with bookkeeping:
 *
 *  - per-bot runtime (`runtime.ts`) — every bot gets its own
 *    runtime: its own BotBox workspace, its own cgroup v2
 *    enforcement, its own exec audit log, its own secret scope.
 *    Nothing leaks across bots: not CPU, not RAM, not disk,
 *    not secrets, not audit entries.
 *  - cgroup v2 enforcement (`cgroupEnforcer.ts`) — real kernel
 *    limits per bot: `cpu.max` (CPU quota), `memory.max` (physical
 *    RAM, via the existing `CgroupMemoryLimiter`), `pids.max`
 *    (fork-bomb guard), `io.max` (best-effort disk I/O throttle).
 *    Disk *capacity* has no cgroup controller, so it is enforced
 *    by measurement (`diskQuota.ts`): the workspace is scanned
 *    and new execs are refused once the quota is crossed.
 *  - exec audit (`execAudit.ts`) — every exec is recorded:
 *    which command, which bot, when, how long, exit code, signal,
 *    enforcement mode. Entries are append-only JSONL, chained
 *    with a sha256 hash so a later edit is detectable. Secret
 *    values are never written: they are scrubbed before logging.
 *  - secret scoping (`secretScope.ts`) — a secret belongs to
 *    exactly one bot (plus an optional purpose list and expiry).
 *    Reading it requires the caller's bot id to match the owner;
 *    any other bot gets a denial, and the denial itself is
 *    audited. List/describe paths carry metadata only.
 *
 * Ideas only from the repo survey v138 (cgroup v2 per-bot
 * quotas, exec audit, secret scoping) and from the existing
 * open-bot code (compute/cgroup.ts, sandbox/box.ts,
 * sandboxV4) — no code, text or asset copied from any repo,
 * xAI or Cursor.
 *
 * Fail-closed everywhere: an unknown bot, a quota already
 * blown, a secret owned by another bot, a cgroup that could
 * not be created, or an audit log that fails to append all
 * stop the operation, never let it through silently. When
 * the kernel cannot enforce (no cgroup v2 delegation on this
 * machine) the runtime says so in `enforcement.mode` and
 * falls back to prlimit + measurement — it never claims a
 * limit it does not hold.
 */

/** A bot id is a safe path segment: letters, digits, `_`, `-`, `.`. */
export const SANDBOX_V6_BOT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** A secret name is a safe slug: lowercase letters, digits, `_`, `-`. */
export const SANDBOX_V6_SECRET_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** A secret purpose is a safe slug: lowercase letters, digits, `_`, `-`, `/`. */
export const SANDBOX_V6_SECRET_PURPOSE_PATTERN = /^[a-z0-9][a-z0-9_/-]{0,63}$/;

/** How strongly the kernel is enforcing this bot's quotas. */
export type SandboxV6EnforcementMode =
  | 'cgroup' // cgroup v2 limits are live for this bot.
  | 'prlimit' // no cgroup delegation: prlimit + measurement only.
  | 'none'; // no enforcement at all (non-Linux or probe failed hard).

/** Per-bot resource quota. `0` (or absent) means "no limit" for that axis. */
export interface SandboxV6Quota {
  /** CPU share in percent of one core (100 = one full core, 50 = half a core). 0 = unlimited. */
  cpuPercent?: number;
  /** Physical RAM cap in bytes. 0 = unlimited. */
  memoryBytes?: number;
  /** Workspace disk cap in bytes. 0 = unlimited. */
  diskBytes?: number;
  /** Max processes in the bot's cgroup (fork-bomb guard). 0 = unlimited. */
  maxProcesses?: number;
  /** Max wall-clock ms for a single exec. 0 = use the box default. */
  maxExecMs?: number;
  /** Max bytes a single exec may write to the workspace. 0 = use the box default. */
  maxWriteBytes?: number;
}

/** Validated + defaulted quota (every field present). */
export interface SandboxV6ResolvedQuota {
  cpuPercent: number;
  memoryBytes: number;
  diskBytes: number;
  maxProcesses: number;
  maxExecMs: number;
  maxWriteBytes: number;
}

/** Smallest sane limits the enforcer accepts (below these the kernel refuses). */
export const SANDBOX_V6_MIN_MEMORY_BYTES = 1024 * 1024;
export const SANDBOX_V6_MIN_CPU_PERCENT = 1;
export const SANDBOX_V6_MIN_DISK_BYTES = 1024 * 1024;
export const SANDBOX_V6_MIN_PROCESSES = 4;
/** cgroup v2 cpu period: 100ms, the kernel default. */
export const SANDBOX_V6_CPU_PERIOD_USEC = 100_000;
/** Smallest cpu.max quota the kernel accepts for the 100ms period. */
export const SANDBOX_V6_MIN_CPU_QUOTA_USEC = 1000;

/** Default quota for a bot that asks for none (generous, but bounded). */
export const SANDBOX_V6_DEFAULT_QUOTA: SandboxV6ResolvedQuota = {
  cpuPercent: 50,
  memoryBytes: 512 * 1024 * 1024,
  diskBytes: 1024 * 1024 * 1024,
  maxProcesses: 64,
  maxExecMs: 120_000,
  maxWriteBytes: 256 * 1024 * 1024,
};

/** Named quota presets (UI + tools). */
export type SandboxV6QuotaPresetName = 'tiny' | 'small' | 'default' | 'large' | 'unlimited';

/** Preset quotas. `unlimited` still keeps a fork-bomb guard + exec timeout. */
export const SANDBOX_V6_QUOTA_PRESETS: Record<SandboxV6QuotaPresetName, SandboxV6ResolvedQuota> = {
  tiny: {
    cpuPercent: 10,
    memoryBytes: 64 * 1024 * 1024,
    diskBytes: 64 * 1024 * 1024,
    maxProcesses: 16,
    maxExecMs: 30_000,
    maxWriteBytes: 16 * 1024 * 1024,
  },
  small: {
    cpuPercent: 25,
    memoryBytes: 256 * 1024 * 1024,
    diskBytes: 256 * 1024 * 1024,
    maxProcesses: 32,
    maxExecMs: 60_000,
    maxWriteBytes: 64 * 1024 * 1024,
  },
  default: { ...SANDBOX_V6_DEFAULT_QUOTA },
  large: {
    cpuPercent: 100,
    memoryBytes: 2 * 1024 * 1024 * 1024,
    diskBytes: 5 * 1024 * 1024 * 1024,
    maxProcesses: 128,
    maxExecMs: 300_000,
    maxWriteBytes: 1024 * 1024 * 1024,
  },
  unlimited: {
    cpuPercent: 0,
    memoryBytes: 0,
    diskBytes: 0,
    maxProcesses: 256,
    maxExecMs: 600_000,
    maxWriteBytes: 0,
  },
};

/** Runtime lifecycle states. `destroyed` is terminal: box + cgroup + secrets are gone. */
export type SandboxV6RuntimeState = 'created' | 'running' | 'paused' | 'stopped' | 'destroyed';

/** Why a runtime stopped. */
export type SandboxV6RuntimeStopReason =
  | 'completed'
  | 'stopped-by-user'
  | 'quota-exceeded'
  | 'disk-quota-exceeded'
  | 'idle-timeout'
  | 'lifetime-cap'
  | 'error'
  | 'killed';

/** Live resource usage of one bot runtime (best-effort: nulls when unreadable). */
export interface SandboxV6Usage {
  /** CPU time consumed by the cgroup, in microseconds (from cpu.stat usage_usec). */
  cpuTimeUsec: number | null;
  /** Current physical RAM in the cgroup, bytes. */
  memoryCurrentBytes: number | null;
  /** Peak physical RAM in the cgroup, bytes. */
  memoryPeakBytes: number | null;
  /** Processes currently in the cgroup. */
  processCount: number | null;
  /** Workspace size on disk, bytes (measured by scan). */
  diskBytes: number;
  /** Files in the workspace. */
  diskFiles: number;
  /** When the usage was read (ms since epoch). */
  readAtMs: number;
}

/** One per-bot runtime. */
export interface SandboxV6BotRuntime {
  /** Runtime id (uuid). */
  id: string;
  /** Bot this runtime belongs to. */
  botId: string;
  /** cgroup name for this bot ('' when no cgroup). */
  cgroupName: string;
  /** Current lifecycle state. */
  state: SandboxV6RuntimeState;
  /** Resolved quota in force. */
  quota: SandboxV6ResolvedQuota;
  /** How strongly the kernel enforces the quota. */
  enforcement: SandboxV6EnforcementMode;
  /** Why cgroup enforcement is unavailable, when it is (human-readable). */
  enforcementReason?: string;
  /** BotBox workspace directory. */
  workdir: string;
  /** When the runtime was created (ms since epoch). */
  createdAtMs: number;
  /** Last activity (exec / quota change / heartbeat), ms since epoch. */
  lastActivityMs: number;
  /** Hard deadline (0 = none), ms since epoch. */
  deadlineMs: number;
  /** When the runtime stopped (0 while live). */
  endedAtMs: number;
  /** Why it stopped (undefined while live). */
  stopReason?: SandboxV6RuntimeStopReason;
  /** Execs run in this runtime so far. */
  execCount: number;
  /** Execs refused by quota/audit so far. */
  refusedCount: number;
}

/** Public summary of a runtime (what list/report tools return). */
export interface SandboxV6RuntimeSummary {
  id: string;
  botId: string;
  state: SandboxV6RuntimeState;
  quota: SandboxV6ResolvedQuota;
  enforcement: SandboxV6EnforcementMode;
  enforcementReason?: string;
  workdir: string;
  /** cgroup name for this bot ('' when no cgroup). */
  cgroupName: string;
  createdAtMs: number;
  lastActivityMs: number;
  deadlineMs: number;
  endedAtMs: number;
  stopReason?: SandboxV6RuntimeStopReason;
  execCount: number;
  refusedCount: number;
  /** Live usage, when the caller asked for it (null = not read). */
  usage: SandboxV6Usage | null;
}

/** Result of one audited exec inside a bot runtime. */
export interface SandboxV6ExecResult {
  /** Audit entry id (uuid, same as the audit log entry). */
  auditId: string;
  botId: string;
  runtimeId: string;
  command: string;
  args: string[];
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  writeCapExceeded: boolean;
  /** stdout excerpt (capped; secret values scrubbed). */
  stdout: string;
  /** stderr excerpt (capped; secret values scrubbed). */
  stderr: string;
  /** Wall-clock duration, ms. */
  durationMs: number;
  /** Workspace size after the exec, bytes. */
  workspaceBytes: number;
  /** Enforcement mode that was live for this exec. */
  enforcement: SandboxV6EnforcementMode;
  /** Isolation backend used (bwrap / unshare / plain / ...). */
  isolation: string;
  /** When the exec started (ms since epoch). */
  startedAtMs: number;
}

/** One exec audit entry (append-only log). */
export interface SandboxV6AuditEntry {
  /** Entry id (uuid). */
  id: string;
  /** Monotonic sequence number inside this bot's log (starts at 1). */
  seq: number;
  /** Bot that ran the exec. */
  botId: string;
  /** Runtime the exec ran in. */
  runtimeId: string;
  /** Kind of event. */
  kind: SandboxV6AuditKind;
  /** Program that was run ('' for non-exec events). */
  command: string;
  /** Arguments (secret values scrubbed before storage). */
  args: string[];
  /** When the event started (ms since epoch). */
  startedAtMs: number;
  /** Wall-clock duration, ms (0 for instant events). */
  durationMs: number;
  /** Exit code (null when not applicable / still unknown). */
  exitCode: number | null;
  /** Signal that ended the process (null when none). */
  signal: string | null;
  /** True when the exec hit its timeout. */
  timedOut: boolean;
  /** Enforcement mode live at the time. */
  enforcement: SandboxV6EnforcementMode;
  /** Isolation backend used. */
  isolation: string;
  /** Human-readable detail (metadata only — never a secret value). */
  detail: string;
  /** sha256 chain hash: hash(prevHash + canonical entry body). */
  hash: string;
  /** Previous entry's hash ('' for the first entry). */
  prevHash: string;
}

/** Audit event kinds. */
export type SandboxV6AuditKind =
  | 'exec-start'
  | 'exec-finish'
  | 'exec-refused'
  | 'exec-timeout'
  | 'quota-changed'
  | 'quota-exceeded'
  | 'disk-quota-exceeded'
  | 'secret-access-denied'
  | 'secret-granted'
  | 'secret-revoked'
  | 'runtime-created'
  | 'runtime-stopped'
  | 'runtime-destroyed'
  | 'cgroup-failed';

/** Filter for querying an audit log. */
export interface SandboxV6AuditQuery {
  botId?: string;
  runtimeId?: string;
  kind?: SandboxV6AuditKind;
  /** Only entries started at/after this ms. */
  sinceMs?: number;
  /** Only entries started at/before this ms. */
  untilMs?: number;
  /** Only entries whose command/detail contains this (case-insensitive, substring). */
  text?: string;
  /** Only exec entries with this exit code. */
  exitCode?: number;
  /** Max entries to return (newest first). Default 100. */
  limit?: number;
}

/** Summary counts over an audit log. */
export interface SandboxV6AuditSummary {
  botId: string;
  totalEntries: number;
  execStarts: number;
  execFinishes: number;
  execRefused: number;
  execTimeouts: number;
  quotaExceeded: number;
  secretDenied: number;
  exitCodes: Record<string, number>;
  firstMs: number;
  lastMs: number;
  /** True when the hash chain verified end to end. */
  chainOk: boolean;
  /** Sequence numbers that failed verification (empty when clean). */
  chainBrokenAt: number[];
}

/** A secret scoped to exactly one bot. */
export interface SandboxV6SecretMeta {
  /** Secret name (unique per bot). */
  name: string;
  /** Bot that owns this secret. */
  ownerBotId: string;
  /** Purposes this secret may be used for (empty = any purpose for the owner). */
  purposes: string[];
  /** When it was stored (ms since epoch). */
  createdAtMs: number;
  /** Expiry (0 = never). */
  expiresAtMs: number;
  /** Times it has been read by its owner. */
  readCount: number;
  /** Last read (0 = never read). */
  lastReadAtMs: number;
  /** Times another bot tried to read it (denied). */
  deniedCount: number;
}

/** Result of an access check. */
export interface SandboxV6SecretAccess {
  allowed: boolean;
  /** Why access was denied (undefined when allowed). */
  reason?: string;
}

/** Disk quota check result. */
export interface SandboxV6DiskCheck {
  /** Workspace bytes measured. */
  usedBytes: number;
  /** Quota in force (0 = unlimited). */
  quotaBytes: number;
  /** Files counted. */
  files: number;
  /** True when used >= quota (new execs must be refused). */
  overQuota: boolean;
  /** True when used >= 90% of quota (warning zone). */
  nearQuota: boolean;
  /** Usage ratio 0..1+ (0 when unlimited). */
  ratio: number;
}

/** cgroup probe result (cpu + memory + pids controllers). */
export interface SandboxV6CgroupProbe {
  available: boolean;
  cpu: boolean;
  memory: boolean;
  pids: boolean;
  io: boolean;
  reason?: string;
}

/** Full report for one bot runtime. */
export interface SandboxV6RuntimeReport {
  runtime: SandboxV6RuntimeSummary;
  usage: SandboxV6Usage;
  disk: SandboxV6DiskCheck;
  audit: SandboxV6AuditSummary;
  /** Secret names owned by this bot (metadata only). */
  secrets: SandboxV6SecretMeta[];
}

/** Validate a bot id. Returns an error message, or '' when valid. */
export function sandboxV6BotIdError(botId: string): string {
  if (typeof botId !== 'string' || botId.length === 0) return 'botId must be a non-empty string.';
  if (!SANDBOX_V6_BOT_ID_PATTERN.test(botId)) {
    return `Invalid botId "${botId}": use letters, digits, ".", "-" and "_" only (max 128 chars).`;
  }
  return '';
}

/** Validate a secret name. Returns an error message, or '' when valid. */
export function sandboxV6SecretNameError(name: string): string {
  if (typeof name !== 'string' || name.length === 0) return 'Secret name must be a non-empty string.';
  if (!SANDBOX_V6_SECRET_NAME_PATTERN.test(name)) {
    return `Invalid secret name "${name}": use lowercase letters, digits, "-" and "_" only (max 64 chars).`;
  }
  return '';
}

/** Resolve a partial quota into a full one, validating every field. Throws on invalid input. */
export function resolveSandboxV6Quota(input: SandboxV6Quota = {}): SandboxV6ResolvedQuota {
  const check = (label: string, value: number | undefined, min: number): number => {
    if (value === undefined || value === 0) return 0;
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`Invalid quota ${label}: ${value} — must be 0 (unlimited) or a positive number.`);
    }
    if (value < min) {
      throw new Error(`Invalid quota ${label}: ${value} is below the minimum ${min}.`);
    }
    return Math.floor(value);
  };
  const cpu = input.cpuPercent ?? SANDBOX_V6_DEFAULT_QUOTA.cpuPercent;
  if (cpu !== 0 && (!Number.isFinite(cpu) || cpu < SANDBOX_V6_MIN_CPU_PERCENT)) {
    throw new Error(
      `Invalid quota cpuPercent: ${cpu} — must be 0 (unlimited) or >= ${SANDBOX_V6_MIN_CPU_PERCENT}.`,
    );
  }
  const memory = check('memoryBytes', input.memoryBytes, SANDBOX_V6_MIN_MEMORY_BYTES);
  const disk = check('diskBytes', input.diskBytes, SANDBOX_V6_MIN_DISK_BYTES);
  const procs = check('maxProcesses', input.maxProcesses, SANDBOX_V6_MIN_PROCESSES);
  const execMs = input.maxExecMs ?? 0;
  if (execMs !== 0 && (!Number.isFinite(execMs) || execMs < 1000)) {
    throw new Error(`Invalid quota maxExecMs: ${execMs} — must be 0 or >= 1000.`);
  }
  const write = input.maxWriteBytes ?? 0;
  if (write !== 0 && (!Number.isFinite(write) || write < 1024)) {
    throw new Error(`Invalid quota maxWriteBytes: ${write} — must be 0 or >= 1024.`);
  }
  return {
    cpuPercent: cpu,
    memoryBytes: memory === 0 && input.memoryBytes === undefined ? SANDBOX_V6_DEFAULT_QUOTA.memoryBytes : memory,
    diskBytes: disk === 0 && input.diskBytes === undefined ? SANDBOX_V6_DEFAULT_QUOTA.diskBytes : disk,
    maxProcesses: procs === 0 && input.maxProcesses === undefined ? SANDBOX_V6_DEFAULT_QUOTA.maxProcesses : procs,
    maxExecMs: execMs === 0 && input.maxExecMs === undefined ? SANDBOX_V6_DEFAULT_QUOTA.maxExecMs : execMs,
    maxWriteBytes: write === 0 && input.maxWriteBytes === undefined ? SANDBOX_V6_DEFAULT_QUOTA.maxWriteBytes : write,
  };
}

/** Is this quota field meaningfully limited (non-zero)? */
export function sandboxV6QuotaLimited(quota: SandboxV6ResolvedQuota): boolean {
  return (
    quota.cpuPercent > 0 || quota.memoryBytes > 0 || quota.diskBytes > 0 || quota.maxProcesses > 0
  );
}

/** Human-readable bytes (e.g. `512 MiB`, `1.5 GiB`). */
export function formatSandboxV6Bytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let unit = 'B';
  for (const u of units) {
    unit = u;
    value /= 1024;
    if (value < 1024) break;
  }
  const rounded = value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${unit}`;
}

/** Human-readable duration (e.g. `1.2s`, `3m 4s`). */
export function formatSandboxV6Duration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${Math.round(seconds * 10) / 10}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  if (minutes < 60) return `${minutes}m ${rest}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
