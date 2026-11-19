/**
 * Runtime isolation drivers (v1.44, Team T6) — fleet v30.
 *
 * OpenHands Agent Server (survey `docs/repo-survey-v144.md` §1)
 * runs one dedicated runtime per conversation; open-bot stays
 * local-first, so the driver is chosen on this host:
 *
 * - `bwrap` (bubblewrap): the default. The command builder below
 *   produces an argv array (never a shell string) that binds the
 *   conversation workspace read-write, everything else read-only,
 *   drops the network unless the mode allows it, and runs the
 *   requested command unprivileged. The host execs the argv; this
 *   module only builds and validates it.
 * - `docker`: optional, only when the host reports Docker
 *   available (the availability probe is the host's job — this
 *   module builds the `docker run` argv and validates it the same
 *   way). Never required, never assumed present.
 * - `local`: the fallback when neither sandbox exists. It runs
 *   the command on the host with NO isolation — every binding that
 *   uses it is labelled `isolated: false` and the UI must say so.
 *   A `local` driver is never chosen silently: the caller must ask
 *   for it explicitly, or the selection policy must record that
 *   both sandboxes were unavailable.
 *
 * All builders return reasons (empty = valid) so the host can show
 * the operator exactly why a driver or command was refused.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { FleetV30NetworkMode, FleetV30RuntimeDriverKind } from './types';

/** Capability matrix for one driver kind. */
export interface FleetV30DriverCapabilities {
  /** Driver kind. */
  kind: FleetV30RuntimeDriverKind;
  /** True when the driver actually isolates the runtime. */
  isolates: boolean;
  /** True when the driver can enforce a network mode. */
  networkModes: FleetV30NetworkMode[];
  /** True when the driver can enforce a CPU/RAM/disk limit. */
  resourceLimits: boolean;
  /** True when the driver needs an external binary on the host. */
  needsBinary: boolean;
  /** Binary the driver needs (null = built in). */
  binary: string | null;
  /** Human-readable note for the UI. */
  note: string;
}

/** Capability matrix for every driver kind. */
export const FLEET_V30_DRIVER_CAPABILITIES: Record<FleetV30RuntimeDriverKind, FleetV30DriverCapabilities> = {
  bwrap: {
    kind: 'bwrap',
    isolates: true,
    networkModes: ['none', 'loopback'],
    resourceLimits: false,
    needsBinary: true,
    binary: 'bwrap',
    note: 'Bubblewrap sandbox (local-first default). Filesystem + network isolation; resource limits come from the v28 runtime limits.',
  },
  docker: {
    kind: 'docker',
    isolates: true,
    networkModes: ['none', 'loopback', 'host'],
    resourceLimits: true,
    needsBinary: true,
    binary: 'docker',
    note: 'Docker container (optional). Full isolation + resource limits when Docker is installed on the host.',
  },
  local: {
    kind: 'local',
    isolates: false,
    networkModes: ['host'],
    resourceLimits: false,
    needsBinary: false,
    binary: null,
    note: 'Local process — NO isolation. Used only when no sandbox is available; always labelled as unisolated.',
  },
};

/** Capabilities for one driver kind. */
export function fleetV30DriverCapabilities(kind: FleetV30RuntimeDriverKind): FleetV30DriverCapabilities {
  return FLEET_V30_DRIVER_CAPABILITIES[kind];
}

/** Result of probing driver availability on the host. */
export interface FleetV30DriverAvailability {
  /** Driver kind probed. */
  kind: FleetV30RuntimeDriverKind;
  /** True when the host reports the driver usable. */
  available: boolean;
  /** Binary path found (null = not found / not applicable). */
  binaryPath: string | null;
  /** Version string when known (null = unknown). */
  version: string | null;
  /** Why it is unavailable (null = available). */
  reason: string | null;
}

/** Build an availability record for one driver (host fills the facts). */
export function fleetV30DriverAvailability(
  kind: FleetV30RuntimeDriverKind,
  opts: { available: boolean; binaryPath?: string | null; version?: string | null; reason?: string | null },
): FleetV30DriverAvailability {
  return {
    kind,
    available: opts.available,
    binaryPath: opts.binaryPath ?? null,
    version: opts.version ?? null,
    reason: opts.available ? null : (opts.reason ?? `${kind} is not available on this host.`),
  };
}

/** True when the driver kind can run the requested network mode. */
export function fleetV30DriverSupportsNetwork(
  kind: FleetV30RuntimeDriverKind,
  mode: FleetV30NetworkMode,
): boolean {
  return FLEET_V30_DRIVER_CAPABILITIES[kind].networkModes.includes(mode);
}

/**
 * Select a driver: the preferred kind when it is available and
 * supports the network mode, otherwise the first available kind
 * in preference order that supports the mode. The `local` fallback
 * is returned only when no sandbox driver is available, and the
 * caller must label that binding `isolated: false`.
 * Returns null when nothing is available (not even `local` — the
 * host disabled the fallback).
 */
export function selectFleetV30Driver(
  preferred: FleetV30RuntimeDriverKind | null,
  availability: readonly FleetV30DriverAvailability[],
  networkMode: FleetV30NetworkMode,
  allowLocalFallback = true,
): { kind: FleetV30RuntimeDriverKind; viaFallback: boolean; reasons: string[] } | null {
  const byKind = new Map(availability.map((a) => [a.kind, a]));
  const usable = (kind: FleetV30RuntimeDriverKind): boolean => {
    const a = byKind.get(kind);
    if (!a || !a.available) return false;
    if (!fleetV30DriverSupportsNetwork(kind, networkMode)) return false;
    if (kind === 'local' && !allowLocalFallback) return false;
    return true;
  };
  const reasons: string[] = [];
  if (preferred !== null) {
    if (usable(preferred)) return { kind: preferred, viaFallback: false, reasons: [] };
    const a = byKind.get(preferred);
    reasons.push(
      a && !a.available
        ? `Preferred driver "${preferred}" is unavailable: ${a.reason ?? 'unknown reason'}.`
        : `Preferred driver "${preferred}" does not support network mode "${networkMode}".`,
    );
  }
  const order: FleetV30RuntimeDriverKind[] = ['bwrap', 'docker', 'local'];
  for (const kind of order) {
    if (kind === preferred) continue;
    if (usable(kind)) {
      return { kind, viaFallback: kind === 'local', reasons };
    }
  }
  reasons.push('No isolation driver is available on this host.');
  return null;
}

/** One command a runtime wants to run inside its isolation. */
export interface FleetV30DriverCommand {
  /** Command (binary name, no path separators preferred). */
  command: string;
  /** Arguments (no shell interpretation). */
  args: string[];
  /** Working directory inside the workspace. */
  cwd: string;
  /** Workspace root on the host. */
  workspaceRoot: string;
  /** Network mode for this run. */
  networkMode: FleetV30NetworkMode;
  /** CPU cores limit (null = no limit passed to the driver). */
  cpuCores: number | null;
  /** RAM limit, MiB (null = no limit passed to the driver). */
  ramMB: number | null;
}

/** Validate a driver command (shared by bwrap + docker + local). */
export function validateFleetV30DriverCommand(
  kind: FleetV30RuntimeDriverKind,
  cmd: FleetV30DriverCommand,
): string[] {
  const reasons: string[] = [];
  if (!cmd || typeof cmd !== 'object') return ['Driver command must be an object.'];
  if (typeof cmd.command !== 'string' || cmd.command.trim() === '') {
    reasons.push('command must be a non-empty string.');
  } else if (/[\s;&|<>`$]/.test(cmd.command)) {
    reasons.push('command must not contain whitespace or shell metacharacters.');
  }
  if (!Array.isArray(cmd.args) || cmd.args.some((a) => typeof a !== 'string')) {
    reasons.push('args must be an array of strings.');
  } else {
    for (const arg of cmd.args) {
      if (/[;&|<>`$]/.test(arg)) {
        reasons.push(`Argument "${arg}" contains a shell metacharacter.`);
        break;
      }
    }
  }
  if (typeof cmd.cwd !== 'string' || cmd.cwd.trim() === '') reasons.push('cwd must be a non-empty path.');
  if (typeof cmd.workspaceRoot !== 'string' || cmd.workspaceRoot.trim() === '') {
    reasons.push('workspaceRoot must be a non-empty path.');
  }
  if (!fleetV30DriverSupportsNetwork(kind, cmd.networkMode)) {
    reasons.push(`Driver "${kind}" does not support network mode "${cmd.networkMode}".`);
  }
  if (cmd.cpuCores !== null && (typeof cmd.cpuCores !== 'number' || !Number.isFinite(cmd.cpuCores) || cmd.cpuCores <= 0)) {
    reasons.push('cpuCores must be a number > 0 or null.');
  }
  if (cmd.ramMB !== null && (typeof cmd.ramMB !== 'number' || !Number.isFinite(cmd.ramMB) || cmd.ramMB <= 0)) {
    reasons.push('ramMB must be a number > 0 or null.');
  }
  return reasons;
}

/**
 * Build a `bwrap` argv for one command.
 *
 * Layout: `bwrap --unshare-all --die-with-parent --ro-bind /usr /usr
 * --ro-bind /lib /lib --ro-bind /lib64 /lib64 --bind <workspace> <workspace>
 * --tmpfs /tmp --chdir <cwd> [--unshare-net] <command> <args...>`.
 * `--unshare-net` is added for `none`; `loopback` keeps the loopback
 * interface only (no external network is routed — the host enforces
 * that; bwrap alone cannot). `host` is refused for bwrap: a caller
 * that needs host networking must pick docker or local instead.
 */
export function buildFleetV30BwrapCommand(cmd: FleetV30DriverCommand): { ok: true; argv: string[] } | { ok: false; reasons: string[] } {
  const reasons = validateFleetV30DriverCommand('bwrap', cmd);
  if (cmd.networkMode === 'host') {
    reasons.push('bwrap does not support network mode "host" — pick docker or local.');
  }
  if (reasons.length > 0) return { ok: false, reasons };
  const argv: string[] = [
    'bwrap',
    '--unshare-all',
    '--die-with-parent',
    '--ro-bind', '/usr', '/usr',
    '--ro-bind', '/lib', '/lib',
    '--ro-bind', '/lib64', '/lib64',
    '--bind', cmd.workspaceRoot, cmd.workspaceRoot,
    '--tmpfs', '/tmp',
    '--chdir', cmd.cwd,
  ];
  if (cmd.networkMode === 'none') argv.push('--unshare-net');
  argv.push(cmd.command, ...cmd.args);
  return { ok: true, argv };
}

/**
 * Build a `docker run` argv for one command.
 *
 * Layout: `docker run --rm --read-only --network <net>
 * [--cpus <cores>] [--memory <ram>m] -v <workspace>:<workspace> -w <cwd>
 * <image> <command> <args...>`. The image is the host's configured
 * runtime image (default `open-bot-runtime:latest`); the host may
 * override it. `--network none` for `none`, `host` for `host`,
 * and the default bridge with no published ports for `loopback`
 * (loopback-only: the container can reach the host loopback, not
 * the LAN — the host firewall enforces the rest).
 */
export function buildFleetV30DockerCommand(
  cmd: FleetV30DriverCommand,
  image = 'open-bot-runtime:latest',
): { ok: true; argv: string[] } | { ok: false; reasons: string[] } {
  const reasons = validateFleetV30DriverCommand('docker', cmd);
  if (typeof image !== 'string' || image.trim() === '') reasons.push('image must be a non-empty string.');
  if (reasons.length > 0) return { ok: false, reasons };
  const network = cmd.networkMode === 'none' ? 'none' : cmd.networkMode === 'host' ? 'host' : 'bridge';
  const argv: string[] = [
    'docker', 'run', '--rm', '--read-only',
    '--network', network,
    '-v', `${cmd.workspaceRoot}:${cmd.workspaceRoot}`,
    '-w', cmd.cwd,
  ];
  if (cmd.cpuCores !== null) argv.push('--cpus', String(cmd.cpuCores));
  if (cmd.ramMB !== null) argv.push('--memory', `${Math.floor(cmd.ramMB)}m`);
  argv.push(image, cmd.command, ...cmd.args);
  return { ok: true, argv };
}

/**
 * Build the argv for the `local` fallback: the command itself, run
 * on the host with no isolation. The caller MUST label the binding
 * `isolated: false` and show that in the UI — this function does not
 * hide it.
 */
export function buildFleetV30LocalCommand(cmd: FleetV30DriverCommand): { ok: true; argv: string[] } | { ok: false; reasons: string[] } {
  const reasons = validateFleetV30DriverCommand('local', cmd);
  if (reasons.length > 0) return { ok: false, reasons };
  return { ok: true, argv: [cmd.command, ...cmd.args] };
}

/** Build the argv for any driver kind (dispatches to the builders above). */
export function buildFleetV30DriverCommand(
  kind: FleetV30RuntimeDriverKind,
  cmd: FleetV30DriverCommand,
  dockerImage?: string,
): { ok: true; argv: string[] } | { ok: false; reasons: string[] } {
  if (kind === 'bwrap') return buildFleetV30BwrapCommand(cmd);
  if (kind === 'docker') return buildFleetV30DockerCommand(cmd, dockerImage);
  return buildFleetV30LocalCommand(cmd);
}

/** True when the argv was built for a driver that actually isolates. */
export function fleetV30DriverIsolates(kind: FleetV30RuntimeDriverKind): boolean {
  return FLEET_V30_DRIVER_CAPABILITIES[kind].isolates;
}

/** Well-known install paths the host probe checks for each binary. */
export const FLEET_V30_DRIVER_BINARY_PATHS: Record<string, readonly string[]> = {
  bwrap: ['/usr/bin/bwrap', '/bin/bwrap', '/usr/local/bin/bwrap'],
  docker: ['/usr/bin/docker', '/usr/local/bin/docker', '/opt/homebrew/bin/docker'],
};

/**
 * Probe driver availability on this host (filesystem check only —
 * no process is spawned, no network is touched). bwrap/docker are
 * available when their binary exists at a well-known path (the host
 * may override with its own probe and pass the result in instead);
 * `local` is always available. The host calls this at startup and
 * passes the result into the isolation manager.
 */
export function probeFleetV30DriverAvailability(): FleetV30DriverAvailability[] {
  const findBinary = (kind: 'bwrap' | 'docker'): string | null => {
    for (const candidate of FLEET_V30_DRIVER_BINARY_PATHS[kind] ?? []) {
      try {
        if (fs.existsSync(candidate)) return candidate;
      } catch {
        // A filesystem error means "not found here" — keep looking.
      }
    }
    return null;
  };
  const bwrapPath = findBinary('bwrap');
  const dockerPath = findBinary('docker');
  return [
    fleetV30DriverAvailability('bwrap', {
      available: bwrapPath !== null,
      binaryPath: bwrapPath,
      reason: bwrapPath === null ? 'bwrap binary not found on this host.' : undefined,
    }),
    fleetV30DriverAvailability('docker', {
      available: dockerPath !== null,
      binaryPath: dockerPath,
      reason: dockerPath === null ? 'Docker binary not found on this host.' : undefined,
    }),
    fleetV30DriverAvailability('local', { available: true }),
  ];
}
