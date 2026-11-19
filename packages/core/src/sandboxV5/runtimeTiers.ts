/**
 * Sandbox v5 — runtime tiers (v1.37, Team T3).
 *
 * A tier is the isolation a bot runtime runs on. Weakest first:
 *
 *  - `local` — no isolation at all: the bot runs as a plain
 *    process in its own workspace directory, with the env
 *    allow-list and the write cap as its only guards. Fast,
 *    dev-only, only for bots the user fully trusts.
 *  - `bwrap` — bubblewrap mount + pid namespaces on Linux
 *    (the sandbox box backend). Real process isolation, cheap.
 *  - `syscall-policy` — bwrap PLUS a syscall allowlist on top
 *    (the sandbox v3 session): dangerous syscalls are denied
 *    before they can run. The tier for untrusted code.
 *  - `microvm` — a tiny virtual machine per bot (Firecracker /
 *    QEMU style, host-provided): the bot's kernel is its own.
 *    Strongest isolation that still starts in seconds.
 *  - `vm` — a full virtual machine per bot (the per-bot
 *    computer): its own OS, its own disk, loopback-only net
 *    unless the egress gate allows more. Slowest to start,
 *    strongest isolation.
 *
 * Tiers are DATA (a catalog), not code: the host decides which
 * tier a bot runs on, and the catalog answers "what does this
 * tier guarantee, what does it cost, and is it even available
 * on this machine". Availability is probed from the host
 * (bwrap binary present? VM backend present?) — a tier that is
 * not available is never offered as a choice, and never
 * silently downgraded to: an unavailable tier is a hard error
 * at choice time, not a quiet fallback at run time.
 *
 * Ideas only from docs/repo-survey-v137.md (per-bot computer
 * tiers, CIDR sandbox rules in recent CLI releases) — no code
 * or text copied from any repo.
 */

import { commandAvailable } from '../sandbox/env';

import type { SandboxV5Tier, SandboxV5TierInfo, SandboxV5TrustLevel } from './types';

/** Trust order, weakest trust first (hostile trusts nothing). */
const TRUST_ORDER: readonly SandboxV5TrustLevel[] = ['hostile', 'untrusted', 'standard', 'trusted'];

/** Numeric trust rank (higher = more trusted). */
export function sandboxV5TrustRank(trust: SandboxV5TrustLevel): number {
  return TRUST_ORDER.indexOf(trust);
}

/** The tier catalog: one record per tier, weakest first. */
export const SANDBOX_V5_TIER_CATALOG: Record<SandboxV5Tier, SandboxV5TierInfo> = {
  local: {
    tier: 'local',
    name: 'Local (no isolation)',
    description:
      'Plain process in its own workspace directory. Env allow-list + write cap only. ' +
      'Dev-only: no process, filesystem or network isolation.',
    isolatesProcess: false,
    confinesFilesystem: false,
    confinesNetwork: false,
    syscallPolicy: false,
    startupCost: 1,
    overhead: 1,
    platforms: ['linux', 'darwin', 'win32'],
    minTrust: 'trusted',
    requires: '',
  },
  bwrap: {
    tier: 'bwrap',
    name: 'bubblewrap',
    description:
      'Linux bubblewrap: mount + pid namespaces, workspace bind-mounted in, ' +
      'everything else read-only or hidden. Real process isolation, cheap.',
    isolatesProcess: true,
    confinesFilesystem: true,
    confinesNetwork: false,
    syscallPolicy: false,
    startupCost: 2,
    overhead: 1,
    platforms: ['linux'],
    minTrust: 'standard',
    requires: 'bwrap',
  },
  'syscall-policy': {
    tier: 'syscall-policy',
    name: 'Syscall policy (bwrap + allowlist)',
    description:
      'bwrap plus a syscall allowlist (sandbox v3 session): dangerous syscalls ' +
      'are denied before they run, egress goes through the gate. For untrusted code.',
    isolatesProcess: true,
    confinesFilesystem: true,
    confinesNetwork: true,
    syscallPolicy: true,
    startupCost: 3,
    overhead: 2,
    platforms: ['linux'],
    minTrust: 'untrusted',
    requires: 'bwrap',
  },
  microvm: {
    tier: 'microvm',
    name: 'MicroVM',
    description:
      'Tiny virtual machine per bot (Firecracker / QEMU style): the bot runs ' +
      'its own kernel, its own disk image, loopback-only network unless the ' +
      'egress gate allows more. Starts in seconds.',
    isolatesProcess: true,
    confinesFilesystem: true,
    confinesNetwork: true,
    syscallPolicy: true,
    startupCost: 4,
    overhead: 3,
    platforms: ['linux', 'darwin'],
    minTrust: 'hostile',
    requires: 'microvm-backend',
  },
  vm: {
    tier: 'vm',
    name: 'Full VM (per-bot computer)',
    description:
      'Full virtual machine per bot: its own OS, its own disk, its own ' +
      'network namespace. Slowest to start, strongest isolation — the ' +
      'per-bot computer. For hostile code and long-lived bots.',
    isolatesProcess: true,
    confinesFilesystem: true,
    confinesNetwork: true,
    syscallPolicy: true,
    startupCost: 5,
    overhead: 4,
    platforms: ['linux', 'darwin', 'win32'],
    minTrust: 'hostile',
    requires: 'vm-backend',
  },
};

/** All tier infos, weakest first. */
export function listSandboxV5Tiers(): SandboxV5TierInfo[] {
  return (Object.keys(SANDBOX_V5_TIER_CATALOG) as SandboxV5Tier[]).map(
    (tier) => SANDBOX_V5_TIER_CATALOG[tier],
  );
}

/** Look up one tier's info (undefined when unknown). */
export function getSandboxV5TierInfo(tier: string): SandboxV5TierInfo | undefined {
  if (tier !== 'local' && tier !== 'bwrap' && tier !== 'syscall-policy' && tier !== 'microvm' && tier !== 'vm') {
    return undefined;
  }
  return SANDBOX_V5_TIER_CATALOG[tier];
}

/** Is `tier` a known tier id? */
export function isSandboxV5Tier(tier: string): tier is SandboxV5Tier {
  return getSandboxV5TierInfo(tier) !== undefined;
}

/** Strength rank of a tier (higher = stronger isolation). */
export function sandboxV5TierRank(tier: SandboxV5Tier): number {
  return (['local', 'bwrap', 'syscall-policy', 'microvm', 'vm'] as const).indexOf(tier);
}

/** True when `tier` is at least as strong as `minimum`. */
export function sandboxV5TierAtLeast(tier: SandboxV5Tier, minimum: SandboxV5Tier): boolean {
  return sandboxV5TierRank(tier) >= sandboxV5TierRank(minimum);
}

/**
 * Minimum tier for a trust level: the weakest tier that is still
 * safe for code at this trust. `trusted` may run local; `standard`
 * needs bwrap; `untrusted` needs the syscall policy; `hostile`
 * needs a microVM.
 */
export function minSandboxV5TierForTrust(trust: SandboxV5TrustLevel): SandboxV5Tier {
  switch (trust) {
    case 'trusted':
      return 'local';
    case 'standard':
      return 'bwrap';
    case 'untrusted':
      return 'syscall-policy';
    case 'hostile':
      return 'microvm';
  }
}

/**
 * Validate a tier choice for a trust level. Returns problems
 * (empty = the tier is safe for that trust). A tier weaker than
 * the minimum for the trust is a hard problem, not a warning.
 */
export function validateSandboxV5TierForTrust(tier: SandboxV5Tier, trust: SandboxV5TrustLevel): string[] {
  const problems: string[] = [];
  const info = getSandboxV5TierInfo(tier);
  if (!info) {
    problems.push(`Unknown tier "${tier}".`);
    return problems;
  }
  const minimum = minSandboxV5TierForTrust(trust);
  if (!sandboxV5TierAtLeast(tier, minimum)) {
    problems.push(
      `Tier "${tier}" is too weak for trust "${trust}": minimum is "${minimum}". ` +
        `Run untrusted code on "${minimum}" or stronger.`,
    );
  }
  return problems;
}

/** Host capability probe (injectable for tests). */
export interface SandboxV5HostCapabilities {
  /** Platform the host runs on. */
  platform: NodeJS.Platform;
  /** True when `bwrap` is installed and runnable. */
  hasBwrap: boolean;
  /** True when a microVM backend is present (Firecracker / QEMU). */
  hasMicrovmBackend: boolean;
  /** True when a full VM backend is present (per-bot computer). */
  hasVmBackend: boolean;
}

/** Probe host capabilities from the real machine (best-effort, never throws). */
export function probeSandboxV5HostCapabilities(): SandboxV5HostCapabilities {
  // Dùng commandAvailable (có retry khi spawn lỗi nhất thời) thay vì
  // execFileSync một lần — nếu không, một lần fork lỗi thoáng qua dưới
  // tải sẽ làm cả tier bwrap/syscall-policy bị báo "không khả dụng"
  // và choice_set từ chối bwrap (lỗi r3: "Error: Tier ...").
  const hasBwrap = commandAvailable('bwrap');
  return {
    platform: process.platform,
    hasBwrap,
    // MicroVM / full-VM backends are host-provided (opt-in): the
    // v5 service records them when the host registers a backend,
    // they are never auto-detected from a binary name here.
    hasMicrovmBackend: false,
    hasVmBackend: false,
  };
}

/**
 * Which tiers are available on this host. A tier is available
 * when the platform supports it AND its required capability is
 * present. `local` is always available (it is just a process).
 */
export function availableSandboxV5Tiers(caps: SandboxV5HostCapabilities): SandboxV5Tier[] {
  const out: SandboxV5Tier[] = [];
  for (const info of listSandboxV5Tiers()) {
    if (!info.platforms.includes(caps.platform as 'linux' | 'darwin' | 'win32')) continue;
    if (info.tier === 'bwrap' || info.tier === 'syscall-policy') {
      if (!caps.hasBwrap) continue;
    }
    if (info.tier === 'microvm' && !caps.hasMicrovmBackend) continue;
    if (info.tier === 'vm' && !caps.hasVmBackend) continue;
    out.push(info.tier);
  }
  return out;
}

/**
 * Recommend a tier for a bot: the cheapest available tier that
 * is at least the minimum for its trust. Returns undefined when
 * no available tier is strong enough (the host cannot run this
 * trust level safely — the caller must refuse, not downgrade).
 */
export function recommendSandboxV5Tier(
  trust: SandboxV5TrustLevel,
  caps: SandboxV5HostCapabilities,
): SandboxV5Tier | undefined {
  const minimum = minSandboxV5TierForTrust(trust);
  const available = availableSandboxV5Tiers(caps);
  for (const tier of available) {
    if (sandboxV5TierAtLeast(tier, minimum)) return tier;
  }
  return undefined;
}

/**
 * Compare two tiers for a switch: is it an upgrade, a downgrade,
 * or a lateral move? Downgrades are allowed only with an explicit
 * reason — the switch planner turns them into warnings.
 */
export function describeSandboxV5TierChange(
  fromTier: SandboxV5Tier,
  toTier: SandboxV5Tier,
): { direction: 'upgrade' | 'downgrade' | 'same'; warnings: string[] } {
  const fromRank = sandboxV5TierRank(fromTier);
  const toRank = sandboxV5TierRank(toTier);
  if (fromRank === toRank) return { direction: 'same', warnings: [] };
  if (toRank > fromRank) return { direction: 'upgrade', warnings: [] };
  const warnings: string[] = [
    `Downgrading isolation from "${fromTier}" to "${toTier}": the bot loses isolation it had before.`,
  ];
  const fromInfo = getSandboxV5TierInfo(fromTier);
  const toInfo = getSandboxV5TierInfo(toTier);
  if (fromInfo?.syscallPolicy && !toInfo?.syscallPolicy) {
    warnings.push('The syscall allowlist is lost in the downgrade: dangerous syscalls are no longer denied.');
  }
  if (fromInfo?.confinesNetwork && !toInfo?.confinesNetwork) {
    warnings.push('Network confinement is lost in the downgrade: egress is no longer gated by the tier.');
  }
  if (fromInfo?.isolatesProcess && !toInfo?.isolatesProcess) {
    warnings.push('Process isolation is lost in the downgrade: the bot runs as a plain host process.');
  }
  return { direction: 'downgrade', warnings };
}
