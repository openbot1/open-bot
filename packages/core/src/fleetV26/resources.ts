/**
 * Resources v26 — host capacity + per-bot quotas (v1.39, Team T6).
 *
 * Fleet v26 manages MANY bots on the USER'S OWN machine, so the first
 * question is never "how much can a bot have" but "how much must the
 * host keep". This module answers it with a hard reserve:
 *
 * - CPU: at least 1 core (or 25% of cores, whichever is larger) stays
 *   with the host; bots share the rest.
 * - RAM: at least 25% of total RAM, and at least 512 MiB, stays with
 *   the host; bots share the rest.
 * - Disk: there is no portable synchronous disk probe in Node, so disk
 *   capacity comes from a host-supplied probe callback. When the host
 *   supplies no probe, disk is UNKNOWN and disk-heavy allocations are
 *   refused rather than guessed (a wrong guess is how a bot fills the
 *   user's disk).
 *
 * The allocator is pure in-memory state (no processes are spawned, no
 * cgroups are touched — enforcement is the host's job; this module
 * decides what is SAFE to promise). Every allocation is recorded in a
 * ledger so the fleet can always say who holds what, and every
 * admission decision carries its reasons.
 *
 * Follows the `fleetV25/roles.ts` + `fleetV23/placementV2.ts` style:
 * small validated value objects, a store class with JSON round-trip,
 * and a one-line summary for the UI.
 */

import * as os from 'node:os';

/** Host capacity as probed (RAM/CPU from `node:os`, disk from the host). */
export interface FleetV26HostCapacity {
  /** Logical CPU cores. */
  cpuCores: number;
  /** Total RAM, MiB. */
  totalRamMB: number;
  /** Free RAM right now, MiB. */
  freeRamMB: number;
  /** Total disk, MiB (null = the host gave no disk probe). */
  totalDiskMB: number | null;
  /** Free disk, MiB (null = the host gave no disk probe). */
  freeDiskMB: number | null;
  /** When the probe ran. */
  probedAtMs: number;
}

/** Disk probe the host may supply (null = no disk data available). */
export interface FleetV26DiskProbe {
  totalDiskMB: number;
  freeDiskMB: number;
}

/** What the host always keeps back for itself. */
export interface FleetV26HostReserve {
  /** CPU cores reserved for the host. */
  cpuCores: number;
  /** RAM, MiB, reserved for the host. */
  ramMB: number;
  /** Disk, MiB, reserved for the host (0 = unknown disk). */
  diskMB: number;
}

/** What may be promised to bots after the reserve. */
export interface FleetV26Allocatable {
  cpuCores: number;
  ramMB: number;
  /** null = disk unknown, nothing disk-heavy may be promised. */
  diskMB: number | null;
}

/** A per-bot quota request (all fields optional except the bot id). */
export interface FleetV26QuotaRequest {
  botId: string;
  /** CPU cores wanted (fractional allowed, e.g. 0.5). */
  cpuCores?: number;
  /** RAM, MiB, wanted. */
  ramMB?: number;
  /** Disk, MiB, wanted. */
  diskMB?: number;
}

/** A granted per-bot quota (what the ledger holds). */
export interface FleetV26BotQuota {
  botId: string;
  cpuCores: number;
  ramMB: number;
  diskMB: number;
  grantedAtMs: number;
}

/** Why an allocation was refused (or admitted with a warning). */
export type FleetV26AdmissionReason =
  | 'ok'
  | 'cpu-over-allocatable'
  | 'ram-over-allocatable'
  | 'disk-over-allocatable'
  | 'disk-unknown'
  | 'bot-already-allocated'
  | 'invalid-quota'
  | 'host-reserve-too-small';

/** Result of one admission decision. */
export interface FleetV26Admission {
  admitted: boolean;
  botId: string;
  /** The quota that would be granted (the request, clamped to >= 0). */
  requested: FleetV26QuotaRequest;
  reasons: FleetV26AdmissionReason[];
  /** Human-readable one-liners (English; UI uses i18n keys). */
  messages: string[];
  /** What is left for other bots after this grant (null when refused). */
  remainingAfter: FleetV26Allocatable | null;
}

/** Fraction of RAM the host always keeps (25%). */
export const FLEET_V26_RAM_RESERVE_FRACTION = 0.25;
/** Minimum RAM reserve, MiB (512 MiB — the host must stay usable). */
export const FLEET_V26_RAM_RESERVE_MIN_MB = 512;
/** Fraction of CPU cores the host always keeps (25%, at least 1). */
export const FLEET_V26_CPU_RESERVE_FRACTION = 0.25;
/** Minimum disk reserve when disk is known, MiB (2 GiB). */
export const FLEET_V26_DISK_RESERVE_MB = 2048;
/** Smallest grantable quota (anything smaller rounds up to this). */
export const FLEET_V26_MIN_CPU_CORES = 0.1;
export const FLEET_V26_MIN_RAM_MB = 64;
export const FLEET_V26_MIN_DISK_MB = 64;

/** Probe the host capacity right now (CPU/RAM from `node:os`). */
export function probeFleetV26HostCapacity(
  diskProbe?: () => FleetV26DiskProbe | null,
  nowMs: number = Date.now(),
): FleetV26HostCapacity {
  const totalRamMB = Math.max(0, Math.floor(os.totalmem() / (1024 * 1024)));
  const freeRamMB = Math.max(0, Math.floor(os.freemem() / (1024 * 1024)));
  let disk: FleetV26DiskProbe | null = null;
  if (diskProbe) {
    try {
      disk = diskProbe();
    } catch {
      disk = null;
    }
  }
  return {
    cpuCores: Math.max(1, os.cpus().length),
    totalRamMB,
    freeRamMB,
    totalDiskMB: disk && disk.totalDiskMB > 0 ? Math.floor(disk.totalDiskMB) : null,
    freeDiskMB: disk && disk.freeDiskMB >= 0 ? Math.floor(disk.freeDiskMB) : null,
    probedAtMs: nowMs,
  };
}

/** Compute the host reserve from a capacity probe. */
export function computeFleetV26HostReserve(cap: FleetV26HostCapacity): FleetV26HostReserve {
  const cpuCores = Math.max(1, Math.ceil(cap.cpuCores * FLEET_V26_CPU_RESERVE_FRACTION));
  const ramMB = Math.max(
    FLEET_V26_RAM_RESERVE_MIN_MB,
    Math.ceil(cap.totalRamMB * FLEET_V26_RAM_RESERVE_FRACTION),
  );
  return {
    cpuCores: Math.min(cpuCores, Math.max(1, cap.cpuCores - 1)),
    ramMB: Math.min(ramMB, Math.max(FLEET_V26_RAM_RESERVE_MIN_MB, cap.totalRamMB - 64)),
    diskMB: cap.totalDiskMB === null ? 0 : FLEET_V26_DISK_RESERVE_MB,
  };
}

/** Compute what may be promised to bots after the reserve. */
export function computeFleetV26Allocatable(
  cap: FleetV26HostCapacity,
  reserve: FleetV26HostReserve,
): FleetV26Allocatable {
  return {
    cpuCores: Math.max(0, cap.cpuCores - reserve.cpuCores),
    ramMB: Math.max(0, cap.totalRamMB - reserve.ramMB),
    diskMB:
      cap.totalDiskMB === null
        ? null
        : Math.max(0, cap.totalDiskMB - reserve.diskMB),
  };
}

/** Normalise a quota request (missing fields become 0; negatives rejected). */
export function normalizeFleetV26Quota(
  req: FleetV26QuotaRequest,
): { ok: true; quota: Omit<FleetV26BotQuota, 'grantedAtMs'> } | { ok: false; reason: FleetV26AdmissionReason; message: string } {
  const botId = typeof req.botId === 'string' ? req.botId.trim() : '';
  if (!botId) return { ok: false, reason: 'invalid-quota', message: 'botId is required.' };
  const cpuCores = req.cpuCores ?? 0;
  const ramMB = req.ramMB ?? 0;
  const diskMB = req.diskMB ?? 0;
  if (
    !Number.isFinite(cpuCores) || !Number.isFinite(ramMB) || !Number.isFinite(diskMB) ||
    cpuCores < 0 || ramMB < 0 || diskMB < 0
  ) {
    return { ok: false, reason: 'invalid-quota', message: 'Quota values must be finite numbers >= 0.' };
  }
  return {
    ok: true,
    quota: {
      botId,
      cpuCores: Math.floor(cpuCores * 10) / 10,
      ramMB: Math.floor(ramMB),
      diskMB: Math.floor(diskMB),
    },
  };
}

/** Ledger of granted per-bot quotas + the admission gate. */
export class FleetV26ResourceAllocator {
  private capacity: FleetV26HostCapacity;
  private reserve: FleetV26HostReserve;
  private quotas = new Map<string, FleetV26BotQuota>();

  constructor(capacity: FleetV26HostCapacity) {
    this.capacity = capacity;
    this.reserve = computeFleetV26HostReserve(capacity);
  }

  /** Current host capacity (re-probe to refresh). */
  getCapacity(): FleetV26HostCapacity {
    return { ...this.capacity };
  }

  /** Current host reserve. */
  getReserve(): FleetV26HostReserve {
    return { ...this.reserve };
  }

  /** Re-probe the host (CPU/RAM fresh; disk via the same probe shape). */
  reprobe(diskProbe?: () => FleetV26DiskProbe | null, nowMs: number = Date.now()): FleetV26HostCapacity {
    this.capacity = probeFleetV26HostCapacity(diskProbe, nowMs);
    this.reserve = computeFleetV26HostReserve(this.capacity);
    return this.getCapacity();
  }

  /** What may still be promised (allocatable minus granted). */
  remaining(): FleetV26Allocatable {
    const allocatable = computeFleetV26Allocatable(this.capacity, this.reserve);
    let cpu = allocatable.cpuCores;
    let ram = allocatable.ramMB;
    let disk = allocatable.diskMB;
    for (const q of this.quotas.values()) {
      cpu -= q.cpuCores;
      ram -= q.ramMB;
      if (disk !== null) disk -= q.diskMB;
    }
    return {
      cpuCores: Math.max(0, Math.floor(cpu * 10) / 10),
      ramMB: Math.max(0, ram),
      diskMB: disk === null ? null : Math.max(0, disk),
    };
  }

  /** Granted quota for one bot (undefined = none). */
  get(botId: string): FleetV26BotQuota | undefined {
    const q = this.quotas.get(botId);
    return q ? { ...q } : undefined;
  }

  /** All granted quotas, sorted by bot id. */
  list(): FleetV26BotQuota[] {
    return [...this.quotas.values()]
      .map((q) => ({ ...q }))
      .sort((a, b) => a.botId.localeCompare(b.botId));
  }

  /** Totals currently granted. */
  grantedTotals(): { cpuCores: number; ramMB: number; diskMB: number; bots: number } {
    let cpuCores = 0;
    let ramMB = 0;
    let diskMB = 0;
    for (const q of this.quotas.values()) {
      cpuCores += q.cpuCores;
      ramMB += q.ramMB;
      diskMB += q.diskMB;
    }
    return {
      cpuCores: Math.floor(cpuCores * 10) / 10,
      ramMB,
      diskMB,
      bots: this.quotas.size,
    };
  }

  /** Decide whether a quota request may be granted (no state change). */
  check(req: FleetV26QuotaRequest): FleetV26Admission {
    const normalized = normalizeFleetV26Quota(req);
    if (!normalized.ok) {
      return {
        admitted: false,
        botId: req.botId ?? '',
        requested: req,
        reasons: [normalized.reason],
        messages: [normalized.message],
        remainingAfter: null,
      };
    }
    const quota = normalized.quota;
    const reasons: FleetV26AdmissionReason[] = [];
    const messages: string[] = [];
    if (this.quotas.has(quota.botId)) {
      reasons.push('bot-already-allocated');
      messages.push(`Bot "${quota.botId}" already holds a quota — release it first.`);
    }
    const remaining = this.remaining();
    if (quota.cpuCores > remaining.cpuCores) {
      reasons.push('cpu-over-allocatable');
      messages.push(
        `CPU ${quota.cpuCores} cores exceeds the ${remaining.cpuCores} cores left for bots ` +
          `(host keeps ${this.reserve.cpuCores}).`,
      );
    }
    if (quota.ramMB > remaining.ramMB) {
      reasons.push('ram-over-allocatable');
      messages.push(
        `RAM ${quota.ramMB} MiB exceeds the ${remaining.ramMB} MiB left for bots ` +
          `(host keeps ${this.reserve.ramMB} MiB).`,
      );
    }
    if (quota.diskMB > 0) {
      if (remaining.diskMB === null) {
        reasons.push('disk-unknown');
        messages.push('Disk capacity is unknown (no host disk probe) — disk allocations are refused.');
      } else if (quota.diskMB > remaining.diskMB) {
        reasons.push('disk-over-allocatable');
        messages.push(`Disk ${quota.diskMB} MiB exceeds the ${remaining.diskMB} MiB left for bots.`);
      }
    }
    if (reasons.length > 0) {
      return { admitted: false, botId: quota.botId, requested: req, reasons, messages, remainingAfter: null };
    }
    const after: FleetV26Allocatable = {
      cpuCores: Math.max(0, Math.floor((remaining.cpuCores - quota.cpuCores) * 10) / 10),
      ramMB: Math.max(0, remaining.ramMB - quota.ramMB),
      diskMB: remaining.diskMB === null ? null : Math.max(0, remaining.diskMB - quota.diskMB),
    };
    return {
      admitted: true,
      botId: quota.botId,
      requested: req,
      reasons: ['ok'],
      messages: ['Quota fits inside what the host can spare.'],
      remainingAfter: after,
    };
  }

  /** Grant a quota (admission-checked; refused requests change nothing). */
  allocate(req: FleetV26QuotaRequest, nowMs: number = Date.now()): FleetV26Admission {
    const decision = this.check(req);
    if (!decision.admitted) return decision;
    const normalized = normalizeFleetV26Quota(req);
    if (!normalized.ok) return decision; // unreachable: check() already validated
    this.quotas.set(normalized.quota.botId, { ...normalized.quota, grantedAtMs: nowMs });
    return decision;
  }

  /** Release a bot's quota (true = something was released). */
  release(botId: string): boolean {
    return this.quotas.delete(botId);
  }

  /** Utilisation of the allocatable pool, 0..1 per resource (null disk = unknown). */
  utilization(): { cpu: number; ram: number; disk: number | null } {
    const allocatable = computeFleetV26Allocatable(this.capacity, this.reserve);
    const granted = this.grantedTotals();
    const ratio = (used: number, total: number): number =>
      total <= 0 ? 0 : Math.min(1, Math.max(0, used / total));
    return {
      cpu: ratio(granted.cpuCores, allocatable.cpuCores),
      ram: ratio(granted.ramMB, allocatable.ramMB),
      disk: allocatable.diskMB === null ? null : ratio(granted.diskMB, allocatable.diskMB),
    };
  }

  /** JSON round-trip (quotas + capacity snapshot). */
  toJSON(): { capacity: FleetV26HostCapacity; reserve: FleetV26HostReserve; quotas: FleetV26BotQuota[] } {
    return { capacity: this.getCapacity(), reserve: this.getReserve(), quotas: this.list() };
  }

  static fromJSON(data: {
    capacity: FleetV26HostCapacity;
    quotas?: FleetV26BotQuota[];
  }): FleetV26ResourceAllocator {
    const alloc = new FleetV26ResourceAllocator(data.capacity);
    for (const q of data.quotas ?? []) {
      if (q && typeof q.botId === 'string' && q.botId) alloc.quotas.set(q.botId, { ...q });
    }
    return alloc;
  }
}

/** One-line summary for the resources panel. */
export function summarizeFleetV26Resources(alloc: FleetV26ResourceAllocator): string {
  const cap = alloc.getCapacity();
  const reserve = alloc.getReserve();
  const granted = alloc.grantedTotals();
  const remaining = alloc.remaining();
  const disk =
    remaining.diskMB === null ? 'disk unknown' : `${remaining.diskMB} MiB disk left`;
  return (
    `${cap.cpuCores} cores / ${cap.totalRamMB} MiB RAM host; ` +
    `reserve ${reserve.cpuCores} cores + ${reserve.ramMB} MiB; ` +
    `${granted.bots} bot(s) hold ${granted.cpuCores} cores + ${granted.ramMB} MiB; ` +
    `${remaining.cpuCores} cores + ${remaining.ramMB} MiB + ${disk} left`
  );
}

/** true when a quota request asks for nothing at all. */
export function isFleetV26EmptyQuota(req: FleetV26QuotaRequest): boolean {
  return (req.cpuCores ?? 0) <= 0 && (req.ramMB ?? 0) <= 0 && (req.diskMB ?? 0) <= 0;
}
