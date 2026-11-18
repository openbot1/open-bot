/**
 * Sandbox v2 — tier selector (v1.34, Đội T2).
 *
 * Chooses the isolation tier from (trust level, policy minimum,
 * requested tier, host capabilities). Rules, in order:
 *
 *  1. The tier is never below the policy minimum tier.
 *  2. The tier is never below the floor for the trust level
 *     (trusted → 1, standard/untrusted → 2, hostile → 3).
 *  3. A requested tier below the floor is upgraded, with the reason
 *     recorded; a requested tier above the floor is honoured when
 *     the host can do it.
 *  4. When the host cannot run the chosen tier, downgrade to the
 *     strongest tier the host CAN run — and say so loudly
 *     (`downgraded: true` + reason). Downgrade never happens silently.
 *  5. Hostile code with no tier-3 host is REFUSED, not downgraded:
 *     there is no safe tier-1/2 home for known-malicious code.
 *
 * Host probing is dependency-injected (`probeHostCapabilities` takes
 * injectable check functions) so tests can fake any host without
 * touching /dev/kvm or PATH.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { minTierForTrust } from './policy';
import type { SandboxV2Policy } from './policy';
import type {
  SandboxV2HostCapabilities,
  SandboxV2Tier,
  SandboxV2TierDecision,
  SandboxV2TierLevel,
  SandboxV2TrustLevel,
} from './types';
import { SANDBOX_V2_TIER_LEVELS } from './policy';

/** Default host capabilities when nothing is known (fail-closed: no bwrap, no KVM). */
export const SANDBOX_V2_UNKNOWN_HOST: SandboxV2HostCapabilities = {
  platform: 'linux',
  bwrapAvailable: false,
  unshareAvailable: false,
  kvmAvailable: false,
  cpuCount: 1,
  totalMemoryBytes: 0,
  firecrackerAvailable: false,
};

/** Functions the prober uses — injectable so tests can fake a host. */
export interface SandboxV2HostProbeFns {
  platform?: () => NodeJS.Platform;
  commandAvailable?: (command: string) => boolean;
  kvmReadable?: () => boolean;
  cpuCount?: () => number;
  totalMemoryBytes?: () => number;
}

function defaultCommandAvailable(command: string): boolean {
  try {
    execFileSync('command', ['-v', command], { stdio: 'ignore', shell: '/bin/sh' });
    return true;
  } catch {
    return false;
  }
}

function defaultKvmReadable(): boolean {
  try {
    fs.accessSync('/dev/kvm', fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/** Probe the real host. Never throws — any probe failure means "not available". */
export function probeHostCapabilities(fns: SandboxV2HostProbeFns = {}): SandboxV2HostCapabilities {
  const platform = fns.platform?.() ?? os.platform();
  const commandAvailable = fns.commandAvailable ?? defaultCommandAvailable;
  const kvmReadable = fns.kvmReadable ?? defaultKvmReadable;
  const cpuCount = fns.cpuCount ?? (() => os.cpus().length);
  const totalMemoryBytes = fns.totalMemoryBytes ?? (() => os.totalmem());
  let bwrap = false;
  let unshare = false;
  let kvm = false;
  let cpus = 1;
  let mem = 0;
  try {
    bwrap = commandAvailable('bwrap');
  } catch {
    bwrap = false;
  }
  try {
    unshare = commandAvailable('unshare');
  } catch {
    unshare = false;
  }
  try {
    kvm = platform === 'linux' && kvmReadable();
  } catch {
    kvm = false;
  }
  try {
    cpus = Math.max(1, cpuCount());
  } catch {
    cpus = 1;
  }
  try {
    mem = Math.max(0, totalMemoryBytes());
  } catch {
    mem = 0;
  }
  let firecracker = false;
  try {
    firecracker = commandAvailable('firecracker');
  } catch {
    firecracker = false;
  }
  return {
    platform,
    bwrapAvailable: bwrap,
    unshareAvailable: unshare,
    kvmAvailable: kvm,
    cpuCount: cpus,
    totalMemoryBytes: mem,
    firecrackerAvailable: firecracker,
  };
}

/** Can this host run the tier at all (ignoring policy/trust)? */
export function tierSupportedOnHost(tier: SandboxV2Tier, host: SandboxV2HostCapabilities): boolean {
  switch (tier) {
    case 'bwrap':
      // Tier 1 needs bwrap (or unshare as a weak fallback). Without
      // either, the run is un-isolated — the runner reports that
      // honestly instead of pretending tier 1 ran.
      return host.platform === 'linux' && (host.bwrapAvailable || host.unshareAvailable);
    case 'syscall-policy':
      // The policy engine is in-process, so it runs anywhere — but
      // it only MEANS something when a real boundary (tier 1) sits
      // underneath it. On a host with no bwrap the engine still
      // runs, and the report marks isolation honestly.
      return true;
    case 'microvm':
      return host.platform === 'linux' && host.kvmAvailable;
  }
}

/** Strongest tier this host can run (3 → 1, or null when nothing is isolated). */
export function strongestSupportedTier(host: SandboxV2HostCapabilities): SandboxV2Tier | null {
  if (tierSupportedOnHost('microvm', host)) return 'microvm';
  if (tierSupportedOnHost('syscall-policy', host)) return 'syscall-policy';
  if (tierSupportedOnHost('bwrap', host)) return 'bwrap';
  return null;
}

/** Human-readable one-liner describing a host's isolation posture. */
export function describeHostCapabilities(host: SandboxV2HostCapabilities): string {
  const parts: string[] = [`platform=${host.platform}`, `cpus=${host.cpuCount}`];
  parts.push(host.bwrapAvailable ? 'bwrap=yes' : 'bwrap=no');
  parts.push(host.unshareAvailable ? 'unshare=yes' : 'unshare=no');
  parts.push(host.kvmAvailable ? 'kvm=yes' : 'kvm=no');
  parts.push(host.firecrackerAvailable ? 'firecracker=yes' : 'firecracker=no');
  return parts.join(', ');
}

export interface SandboxV2TierSelectOptions {
  trust: SandboxV2TrustLevel;
  policy: SandboxV2Policy;
  requestedTier?: SandboxV2Tier;
  host: SandboxV2HostCapabilities;
}

/**
 * Select the tier. Returns the decision with the full reason chain.
 * Throws (never silently downgrades) when hostile code has no tier-3
 * host — the caller must refuse the run.
 */
export function selectSandboxV2Tier(options: SandboxV2TierSelectOptions): SandboxV2TierDecision {
  const { trust, policy, requestedTier, host } = options;
  const policyFloor = SANDBOX_V2_TIER_LEVELS[policy.minTier];
  const trustFloor = SANDBOX_V2_TIER_LEVELS[minTierForTrust(trust)];
  const floor = Math.max(policyFloor, trustFloor) as SandboxV2TierLevel;
  const floorTier: SandboxV2Tier =
    floor === 3 ? 'microvm' : floor === 2 ? 'syscall-policy' : 'bwrap';

  let desired: SandboxV2Tier = floorTier;
  let desiredLevel = floor;
  let reason = `floor is tier ${floor} (${floorTier}) for trust "${trust}" + policy ${policy.id} v${policy.version}`;
  if (requestedTier !== undefined) {
    const requestedLevel = SANDBOX_V2_TIER_LEVELS[requestedTier];
    if (requestedLevel >= floor) {
      desired = requestedTier;
      desiredLevel = requestedLevel;
      reason = `requested tier ${requestedTier} honoured (at/above floor ${floorTier})`;
    } else {
      reason =
        `requested tier ${requestedTier} is below the floor ${floorTier} ` +
        `for trust "${trust}" + policy ${policy.id} — upgraded to ${floorTier}`;
    }
  }

  const hostFacts: SandboxV2TierDecision['host'] = {
    platform: host.platform,
    bwrapAvailable: host.bwrapAvailable,
    kvmAvailable: host.kvmAvailable,
  };

  if (tierSupportedOnHost(desired, host)) {
    return {
      tier: desired,
      level: desiredLevel,
      reason,
      downgraded: false,
      ...(requestedTier !== undefined ? { requestedTier } : {}),
      trust,
      host: hostFacts,
    };
  }

  // Host cannot run the desired tier. Hostile code is refused outright.
  if (trust === 'hostile') {
    throw new Error(
      `Refusing hostile code: tier ${desired} (${desiredLevel}) is required but this host cannot run it ` +
        `(${describeHostCapabilities(host)}). No safe downgrade exists.`,
    );
  }

  // Downgrade to the strongest tier the host can run.
  const fallback = strongestSupportedTier(host);
  if (fallback === null) {
    throw new Error(
      `No isolation tier available on this host (${describeHostCapabilities(host)}). ` +
        `Refusing to run untrusted code without isolation.`,
    );
  }
  const fallbackLevel = SANDBOX_V2_TIER_LEVELS[fallback];
  return {
    tier: fallback,
    level: fallbackLevel,
    reason:
      `${reason}. Host cannot run tier ${desired} ` +
      `(${describeHostCapabilities(host)}) — DOWNGRADED to tier ${fallback} (${fallbackLevel}). ` +
      `Isolation is weaker than requested; see the run report.`,
    downgraded: true,
    requestedTier: desired,
    trust,
    host: hostFacts,
  };
}
