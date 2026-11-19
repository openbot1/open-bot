/**
 * Sandbox policy for per-conversation runtimes (v1.41, Team T6) — fleet v28.
 *
 * The runtime store (`runtime.ts`) decides lifecycle; this module
 * decides what a runtime is ALLOWED to do while it runs. It never
 * spawns a process or touches cgroups — it translates the
 * conversation's limits into concrete enforcement values the host
 * applies, and validates every exec request before the host runs it:
 *
 * - Resource translation: CPU cores -> cgroup `cpu.max` quota/
 *   period + `cpu.shares`; RAM MiB -> `memory.max` bytes; disk MiB
 *   -> disk quota bytes. Pure arithmetic, host-independent.
 * - Workspace containment: every file path a runtime touches must
 *   stay under its conversation workspace root. Checked lexically
 *   first (fast reject), then with `realpath` when the path exists
 *   (a symlink inside the root that points outside is rejected —
 *   the same fail-closed rule as `fleet/isolation.ts`, applied per
 *   conversation instead of per fleet workspace).
 * - Command policy: an allowlist of safe commands + a denylist of
 *   dangerous patterns (shell metacharacters that chain commands,
 *   destructive commands, network exfiltration tools). A request
 *   that matches the denylist is refused even when the command is
 *   allowlisted; an empty allowlist means "no commands allowed".
 * - Environment: only allowlisted variable names may be passed
 *   into a runtime; secret values are NEVER passed as env vars —
 *   `validateEnv` refuses any value that equals a profile secret
 *   (the caller passes the profile's secret values in, so the
 *   check is exact, not heuristic).
 * - Watchdog: `watchdogDeadline` computes the hard kill time for
 *   one exec from the runtime's `timeoutMs` and the exec's own
 *   timeout; `watchdogStatus` reports remaining time for a running
 *   exec so the host can warn before killing it.
 *
 * All validation returns reasons (empty = allowed) so the host can
 * show the operator exactly why a request was refused.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { FleetV28RuntimeLimits } from './runtime';

/** cgroup v2 CPU period used for quota derivation (µs). */
export const FLEET_V28_CGROUP_CPU_PERIOD_US = 100000;

/** Bytes in one MiB. */
export const FLEET_V28_MIB_BYTES = 1024 * 1024;

/** cgroup enforcement values derived from runtime limits. */
export interface FleetV28CgroupLimits {
  /** `cpu.max` quota, µs per period (rounded up, min 1000). */
  cpuQuotaUs: number;
  /** `cpu.max` period, µs. */
  cpuPeriodUs: number;
  /** `cpu.shares` weight (1024 per core, min 2). */
  cpuShares: number;
  /** `memory.max`, bytes. */
  memoryMaxBytes: number;
  /** Disk quota, bytes. */
  diskQuotaBytes: number;
}

/** Derive cgroup enforcement values from runtime limits. */
export function deriveFleetV28CgroupLimits(limits: FleetV28RuntimeLimits): FleetV28CgroupLimits {
  const cpuQuotaUs = Math.max(1000, Math.ceil(limits.cpuCores * FLEET_V28_CGROUP_CPU_PERIOD_US));
  return {
    cpuQuotaUs,
    cpuPeriodUs: FLEET_V28_CGROUP_CPU_PERIOD_US,
    cpuShares: Math.max(2, Math.round(limits.cpuCores * 1024)),
    memoryMaxBytes: limits.ramMB * FLEET_V28_MIB_BYTES,
    diskQuotaBytes: limits.diskMB * FLEET_V28_MIB_BYTES,
  };
}

/** One exec request a runtime wants the host to run. */
export interface FleetV28ExecRequest {
  /** Command (binary name, no path separators preferred). */
  command: string;
  /** Arguments (no shell interpretation — the host execs directly). */
  args: string[];
  /** Working directory (must be inside the workspace root). */
  cwd: string;
  /** Timeout for this exec, ms (must fit inside the runtime timeout). */
  timeoutMs: number;
  /** Environment variables the exec wants (name -> value). */
  env: Record<string, string>;
}

/** Sandbox policy for one conversation runtime. */
export interface FleetV28SandboxPolicy {
  /** Conversation the policy guards. */
  conversationId: string;
  /** Workspace root: every file access must stay under it. */
  workspaceRoot: string;
  /** Commands the runtime may run (empty = none allowed). */
  allowedCommands: string[];
  /** Extra blocked substrings (in addition to the built-ins). */
  blockedPatterns: string[];
  /** Environment variable names the runtime may receive. */
  allowedEnvNames: string[];
  /** Max timeout for a single exec, ms. */
  maxExecTimeoutMs: number;
}

/** Built-in blocked patterns (shell chaining, destruction, exfiltration). */
export const FLEET_V28_BLOCKED_COMMAND_PATTERNS: readonly string[] = [
  '&&',
  '||',
  ';',
  '|',
  '`',
  '$(',
  '>',
  '<',
  'rm -rf',
  'mkfs',
  'dd ',
  'curl',
  'wget',
  'nc ',
  'netcat',
  'ssh ',
  'scp ',
  'chmod +x',
  '/dev/',
  '..',
];

/** Default safe commands for a conversation runtime. */
export const FLEET_V28_DEFAULT_ALLOWED_COMMANDS: readonly string[] = [
  'node',
  'python3',
  'git',
  'ls',
  'cat',
  'grep',
  'head',
  'tail',
  'wc',
  'sort',
  'jq',
  'npm',
  'tsc',
];

/** Default allowlisted environment variable names. */
export const FLEET_V28_DEFAULT_ALLOWED_ENV: readonly string[] = [
  'PATH',
  'HOME',
  'NODE_ENV',
  'LANG',
  'LC_ALL',
  'TZ',
  'NO_COLOR',
  'CI',
];

/** Default sandbox policy for a conversation (restrictive, host widens). */
export function defaultFleetV28SandboxPolicy(
  conversationId: string,
  workspaceRoot: string,
): FleetV28SandboxPolicy {
  return {
    conversationId,
    workspaceRoot,
    allowedCommands: [...FLEET_V28_DEFAULT_ALLOWED_COMMANDS],
    blockedPatterns: [...FLEET_V28_BLOCKED_COMMAND_PATTERNS],
    allowedEnvNames: [...FLEET_V28_DEFAULT_ALLOWED_ENV],
    maxExecTimeoutMs: 5 * 60 * 1000,
  };
}

/** Result of validating one path against the workspace root. */
export interface FleetV28PathCheck {
  /** Whether the path is inside the root. */
  allowed: boolean;
  /** Resolved absolute path (or the input when it cannot resolve). */
  resolved: string;
  /** Reasons when refused. */
  reasons: string[];
}

/**
 * Check a path against the workspace root.
 *
 * Lexical check first (the resolved path must start with the root
 * + separator, or equal the root). When the path (or its parent)
 * exists on disk, `realpath` resolves symlinks and the check runs
 * again on the real path — a symlink inside the root that points
 * outside is refused. A path that does not exist yet is checked
 * lexically against its nearest existing ancestor's real path.
 */
export function checkFleetV28WorkspacePath(workspaceRoot: string, targetPath: string): FleetV28PathCheck {
  const reasons: string[] = [];
  if (typeof workspaceRoot !== 'string' || workspaceRoot.trim() === '') {
    return { allowed: false, resolved: targetPath, reasons: ['workspaceRoot must be a non-empty path.'] };
  }
  if (typeof targetPath !== 'string' || targetPath.trim() === '') {
    return { allowed: false, resolved: targetPath, reasons: ['targetPath must be a non-empty path.'] };
  }
  const root = path.resolve(workspaceRoot);
  const resolved = path.resolve(root, targetPath);
  if (!isUnderRoot(root, resolved)) {
    return { allowed: false, resolved, reasons: [`Path "${targetPath}" escapes the workspace root.`] };
  }
  // Resolve symlinks: the target itself, else its nearest existing ancestor.
  let probe = resolved;
  for (let depth = 0; depth < 64; depth += 1) {
    try {
      const real = fs.realpathSync(probe);
      const suffix = path.relative(probe, resolved);
      const realTarget = suffix ? path.join(real, suffix) : real;
      if (!isUnderRoot(root, realTarget)) {
        return {
          allowed: false,
          resolved: realTarget,
          reasons: [`Path "${targetPath}" resolves outside the workspace root (symlink).`],
        };
      }
      return { allowed: true, resolved: realTarget, reasons: [] };
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
  }
  return { allowed: true, resolved, reasons };
}

function isUnderRoot(root: string, target: string): boolean {
  return target === root || target.startsWith(root + path.sep);
}

/** Validate one exec request against the policy + runtime limits. */
export function validateFleetV28ExecRequest(
  policy: FleetV28SandboxPolicy,
  limits: FleetV28RuntimeLimits,
  request: FleetV28ExecRequest,
  secretValues: string[] = [],
): string[] {
  const reasons: string[] = [];
  if (!request || typeof request !== 'object') return ['Exec request must be an object.'];
  if (typeof request.command !== 'string' || request.command.trim() === '') {
    reasons.push('command must be a non-empty string.');
  } else {
    const base = request.command.split(path.sep).pop() ?? request.command;
    if (!policy.allowedCommands.includes(base) && !policy.allowedCommands.includes(request.command)) {
      reasons.push(`Command "${request.command}" is not allowlisted for this runtime.`);
    }
    for (const pattern of policy.blockedPatterns) {
      if (request.command.includes(pattern)) {
        reasons.push(`Command contains blocked pattern "${pattern}".`);
        break;
      }
    }
  }
  if (!Array.isArray(request.args) || request.args.some((a) => typeof a !== 'string')) {
    reasons.push('args must be an array of strings.');
  } else {
    const joined = request.args.join(' ');
    for (const pattern of policy.blockedPatterns) {
      if (joined.includes(pattern)) {
        reasons.push(`Arguments contain blocked pattern "${pattern}".`);
        break;
      }
    }
  }
  if (typeof request.cwd !== 'string' || request.cwd.trim() === '') {
    reasons.push('cwd must be a non-empty path.');
  } else {
    const checked = checkFleetV28WorkspacePath(policy.workspaceRoot, request.cwd);
    if (!checked.allowed) reasons.push(...checked.reasons);
  }
  if (typeof request.timeoutMs !== 'number' || !Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0) {
    reasons.push('timeoutMs must be a number > 0.');
  } else {
    if (request.timeoutMs > policy.maxExecTimeoutMs) {
      reasons.push(`timeoutMs exceeds the sandbox maxExecTimeoutMs (${policy.maxExecTimeoutMs}ms).`);
    }
    if (request.timeoutMs > limits.timeoutMs) {
      reasons.push(`timeoutMs exceeds the runtime timeoutMs (${limits.timeoutMs}ms).`);
    }
  }
  reasons.push(...validateFleetV28ExecEnv(policy, request.env ?? {}, secretValues));
  return reasons;
}

/** Validate an env map: names allowlisted, values never a secret. */
export function validateFleetV28ExecEnv(
  policy: FleetV28SandboxPolicy,
  env: Record<string, string>,
  secretValues: string[] = [],
): string[] {
  const reasons: string[] = [];
  if (!env || typeof env !== 'object' || Array.isArray(env)) return ['env must be an object.'];
  for (const [name, value] of Object.entries(env)) {
    if (!policy.allowedEnvNames.includes(name)) {
      reasons.push(`Environment variable "${name}" is not allowlisted for this runtime.`);
      continue;
    }
    if (typeof value !== 'string') {
      reasons.push(`Environment variable "${name}" must be a string.`);
      continue;
    }
    for (const secret of secretValues) {
      if (typeof secret === 'string' && secret.length >= 4 && value.includes(secret)) {
        reasons.push(`Environment variable "${name}" carries a secret value (refused).`);
        break;
      }
    }
  }
  return reasons;
}

/** Watchdog deadline for one exec (ms epoch). */
export function watchdogDeadline(startedAtMs: number, timeoutMs: number): number {
  return startedAtMs + timeoutMs;
}

/** Watchdog status for a running exec. */
export interface FleetV28WatchdogStatus {
  /** Hard kill time, ms epoch. */
  deadlineMs: number;
  /** ms left before the kill (<= 0 = overdue, kill now). */
  remainingMs: number;
  /** True when the exec is overdue and must be killed. */
  overdue: boolean;
  /** True when under 10% of the timeout remains (warn the operator). */
  nearlyOverdue: boolean;
}

/** Watchdog status for an exec started at `startedAtMs`. */
export function watchdogStatus(startedAtMs: number, timeoutMs: number, nowMs: number = Date.now()): FleetV28WatchdogStatus {
  const deadlineMs = watchdogDeadline(startedAtMs, timeoutMs);
  const remainingMs = deadlineMs - nowMs;
  return {
    deadlineMs,
    remainingMs,
    overdue: remainingMs <= 0,
    nearlyOverdue: remainingMs > 0 && remainingMs <= timeoutMs * 0.1,
  };
}
