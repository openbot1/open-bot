/**
 * Fleet v30 profile quotas (v1.44, Team T6).
 *
 * The v28 runtime store caps how many runtimes run at once
 * fleet-wide; v30 adds the per-profile side: how much of the
 * fleet one profile (one bot owner) may consume. A profile that
 * would starve the others is refused at bind time — the host
 * calls `checkAdmission` before `isolation.bind` and refuses the
 * bind when it returns reasons.
 *
 * A quota has four caps (each null = uncapped):
 * - `maxBindings`: live isolation bindings for the profile.
 * - `maxCpuCores` / `maxRamMB` / `maxDiskMB`: summed live usage
 *   across the profile's active bindings (from the v28 runtimes
 *   underneath them).
 *
 * Admission checks, in order (first failure still reports the
 * rest so the operator sees the full picture):
 *   1. A binding cap would be exceeded by one more binding.
 *   2. The new runtime's limits would push the profile past a
 *      resource cap (checked against the limits the bind asks
 *      for, not against live usage — a bind that cannot fit even
 *      at its declared limits is refused up front).
 *   3. The profile already exceeds a resource cap in live usage
 *      (usage grew past the cap after the quota was set) — new
 *      binds are refused until usage drops back under.
 *
 * Quotas never stop a running binding — they only gate new ones.
 * Nothing here touches the network, runs a model, or spawns a
 * process. All time flows through the isolation manager's clocks.
 */

import type { FleetV28RuntimeLimits } from '../fleetV28/runtime';
import type { FleetV30IsolationManager } from './isolation';

/** One profile's fleet quota (null cap = uncapped). */
export interface FleetV30ProfileQuota {
  /** Profile the quota applies to. */
  profileId: string;
  /** Max live isolation bindings (null = uncapped). */
  maxBindings: number | null;
  /** Max summed CPU cores across the profile's bindings (null = uncapped). */
  maxCpuCores: number | null;
  /** Max summed RAM, MiB (null = uncapped). */
  maxRamMB: number | null;
  /** Max summed disk, MiB (null = uncapped). */
  maxDiskMB: number | null;
  /** Who set the quota. */
  setBy: string;
  /** When the quota was set (ISO). */
  setAt: string;
}

/** Live usage summed across one profile's active bindings. */
export interface FleetV30ProfileUsage {
  /** Profile measured. */
  profileId: string;
  /** Live bindings (active only). */
  bindings: number;
  /** Summed CPU cores of the profile's live runtimes. */
  cpuCores: number;
  /** Summed RAM, MiB. */
  ramMB: number;
  /** Summed disk, MiB. */
  diskMB: number;
  /** The quota in force (null = no quota set). */
  quota: FleetV30ProfileQuota | null;
  /** Caps currently exceeded (empty = within quota). */
  overQuota: Array<'bindings' | 'cpu' | 'ram' | 'disk'>;
}

/** Default quota: uncapped everywhere (quotas are opt-in). */
export function defaultFleetV30ProfileQuota(profileId: string, setBy: string, setAt: string): FleetV30ProfileQuota {
  return { profileId, maxBindings: null, maxCpuCores: null, maxRamMB: null, maxDiskMB: null, setBy, setAt };
}

/** Validate a quota (empty = valid). */
export function validateFleetV30ProfileQuota(quota: FleetV30ProfileQuota): string[] {
  const reasons: string[] = [];
  if (!quota.profileId.trim()) reasons.push('profileId is required.');
  if (quota.maxBindings !== null && (!Number.isInteger(quota.maxBindings) || quota.maxBindings < 1)) {
    reasons.push('maxBindings must be an integer >= 1 or null.');
  }
  for (const key of ['maxCpuCores', 'maxRamMB', 'maxDiskMB'] as const) {
    const v = quota[key];
    if (v !== null && (typeof v !== 'number' || !Number.isFinite(v) || v <= 0)) {
      reasons.push(`${key} must be a number > 0 or null.`);
    }
  }
  return reasons;
}

export interface FleetV30ProfileQuotasDeps {
  /** The v30 isolation manager (owns the bindings). */
  isolation: FleetV30IsolationManager;
  /** Clock (tests inject a fixed one). */
  nowIso?: () => string;
}

export class FleetV30ProfileQuotas {
  private readonly isolation: FleetV30IsolationManager;
  private readonly nowIso: () => string;
  private readonly quotas = new Map<string, FleetV30ProfileQuota>();

  constructor(deps: FleetV30ProfileQuotasDeps) {
    this.isolation = deps.isolation;
    this.nowIso = deps.nowIso ?? (() => new Date().toISOString());
  }

  /** Set (or replace) a profile's quota. */
  setQuota(
    profileId: string,
    setBy: string,
    caps: {
      maxBindings?: number | null;
      maxCpuCores?: number | null;
      maxRamMB?: number | null;
      maxDiskMB?: number | null;
    },
  ): { ok: true; quota: FleetV30ProfileQuota } | { ok: false; reasons: string[] } {
    const quota: FleetV30ProfileQuota = {
      profileId,
      maxBindings: caps.maxBindings ?? null,
      maxCpuCores: caps.maxCpuCores ?? null,
      maxRamMB: caps.maxRamMB ?? null,
      maxDiskMB: caps.maxDiskMB ?? null,
      setBy,
      setAt: this.nowIso(),
    };
    const reasons = validateFleetV30ProfileQuota(quota);
    if (reasons.length > 0) return { ok: false, reasons };
    this.quotas.set(profileId, quota);
    return { ok: true, quota: { ...quota } };
  }

  getQuota(profileId: string): FleetV30ProfileQuota | null {
    const q = this.quotas.get(profileId);
    return q ? { ...q } : null;
  }

  listQuotas(): FleetV30ProfileQuota[] {
    return [...this.quotas.values()]
      .map((q) => ({ ...q }))
      .sort((a, b) => a.profileId.localeCompare(b.profileId));
  }

  removeQuota(profileId: string): boolean {
    return this.quotas.delete(profileId);
  }

  /** Live usage summed across one profile's active bindings. */
  usageFor(profileId: string): FleetV30ProfileUsage {
    const quota = this.getQuota(profileId);
    const totals = this.isolationUsageByProfile(profileId);
    const overQuota: FleetV30ProfileUsage['overQuota'] = [];
    if (quota?.maxBindings !== null && quota?.maxBindings !== undefined && totals.bindings > quota.maxBindings) {
      overQuota.push('bindings');
    }
    if (quota?.maxCpuCores !== null && quota?.maxCpuCores !== undefined && totals.cpuCores > quota.maxCpuCores) {
      overQuota.push('cpu');
    }
    if (quota?.maxRamMB !== null && quota?.maxRamMB !== undefined && totals.ramMB > quota.maxRamMB) {
      overQuota.push('ram');
    }
    if (quota?.maxDiskMB !== null && quota?.maxDiskMB !== undefined && totals.diskMB > quota.maxDiskMB) {
      overQuota.push('disk');
    }
    return {
      profileId,
      bindings: totals.bindings,
      cpuCores: totals.cpuCores,
      ramMB: totals.ramMB,
      diskMB: totals.diskMB,
      quota,
      overQuota,
    };
  }

  /** Summed live usage for one profile (bindings + resources). */
  private isolationUsageByProfile(profileId: string): { bindings: number; cpuCores: number; ramMB: number; diskMB: number } {
    // The isolation manager's aggregate is fleet-wide; per-profile
    // usage is derived from the profile's active bindings' runtimes
    // via the manager's public list (usage lives on the runtime).
    // This class only reads public state — it never reaches into
    // the manager's internals.
    const bindings = this.isolation.listBindingsByProfile(profileId).filter((b) => b.status === 'active');
    let cpuCores = 0;
    let ramMB = 0;
    let diskMB = 0;
    for (const binding of bindings) {
      const usage = this.isolation.runtimeUsageFor(binding.conversationId);
      cpuCores += usage.cpuCores;
      ramMB += usage.ramMB;
      diskMB += usage.diskMB;
    }
    return { bindings: bindings.length, cpuCores, ramMB, diskMB };
  }

  /**
   * Admission check for a new bind: would one more binding with
   * these limits fit the profile's quota? Returns reasons (empty
   * = admitted). The caller still runs the isolation bind itself.
   */
  checkAdmission(
    profileId: string,
    limits: FleetV28RuntimeLimits,
  ): { admitted: boolean; reasons: string[] } {
    const reasons: string[] = [];
    const quota = this.quotas.get(profileId);
    if (!quota) return { admitted: true, reasons: [] };
    const usage = this.usageFor(profileId);
    if (quota.maxBindings !== null && usage.bindings + 1 > quota.maxBindings) {
      reasons.push(
        `Profile "${profileId}" is at its binding quota (${usage.bindings}/${quota.maxBindings} bindings).`,
      );
    }
    if (quota.maxCpuCores !== null && usage.cpuCores + limits.cpuCores > quota.maxCpuCores) {
      reasons.push(
        `Profile "${profileId}" would exceed its CPU quota (${usage.cpuCores + limits.cpuCores}/${quota.maxCpuCores} cores).`,
      );
    }
    if (quota.maxRamMB !== null && usage.ramMB + limits.ramMB > quota.maxRamMB) {
      reasons.push(
        `Profile "${profileId}" would exceed its RAM quota (${usage.ramMB + limits.ramMB}/${quota.maxRamMB} MiB).`,
      );
    }
    if (quota.maxDiskMB !== null && usage.diskMB + limits.diskMB > quota.maxDiskMB) {
      reasons.push(
        `Profile "${profileId}" would exceed its disk quota (${usage.diskMB + limits.diskMB}/${quota.maxDiskMB} MiB).`,
      );
    }
    // Already over quota in live usage: no new binds until it drops.
    if (usage.overQuota.length > 0) {
      reasons.push(
        `Profile "${profileId}" is already over quota (${usage.overQuota.join(', ')}) — new binds are refused until usage drops.`,
      );
    }
    return { admitted: reasons.length === 0, reasons };
  }

  /** Profiles currently over quota (for the dashboard). */
  profilesOverQuota(): FleetV30ProfileUsage[] {
    const out: FleetV30ProfileUsage[] = [];
    for (const quota of this.quotas.values()) {
      const usage = this.usageFor(quota.profileId);
      if (usage.overQuota.length > 0) out.push(usage);
    }
    return out.sort((a, b) => a.profileId.localeCompare(b.profileId));
  }
}
