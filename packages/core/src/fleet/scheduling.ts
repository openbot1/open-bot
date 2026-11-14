/**
 * Fleet scheduler v3 — where should the next bot live?
 *
 * The v1/v2 fleet layer allocates CPU/RAM/disk per workspace at
 * creation time and guards it at runtime with per-bot quotas. It never
 * answered the placement question: given N workspaces with different
 * headroom, load and state, which one should host a new bot?
 *
 * This module answers it with pure functions (easy to test, no disk):
 *
 * - `scoreWorkspaceForPlacement` scores one workspace for one
 *   placement request: hard fail when the request does not fit the
 *   workspace's allocation, then a 0..1 score from remaining headroom
 *   after placement (fragmentation penalty) and current load.
 * - `planPlacement` ranks every workspace for a request under a
 *   policy: 'spread' prefers the emptiest workspace (even load),
 *   'binpack' prefers the fullest workspace that still fits (pack bots
 *   tight, leave whole workspaces free to suspend).
 * - `FleetScheduleQueue` is the durable waiting list: requests that
 *   fit nowhere right now wait in `<fleetRoot>/fleet-schedule.json`
 *   (atomic write, mode 0600, same posture as the quota file) until
 *   capacity frees up or an admin claims/cancels them. The queue
 *   never moves a bot by itself — placement is always an explicit
 *   admin decision recorded in the fleet audit log by the caller.
 *
 * Honesty rules (same as quotas.ts): a workspace that is suspended,
 * errored, or unmeasured is scored honestly — suspended/errored are
 * never placement targets, and unknown load is reported as unknown,
 * never guessed as zero.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { FleetStatusView, FleetUsageSummary } from './types';

/** How the scheduler picks between workspaces that all fit. */
export type FleetSchedulingStrategy = 'spread' | 'binpack';

export const FLEET_SCHEDULING_STRATEGIES: readonly FleetSchedulingStrategy[] = [
  'spread',
  'binpack',
];

export interface FleetSchedulingPolicy {
  /** 'spread' = emptiest workspace wins; 'binpack' = fullest that fits wins. */
  strategy: FleetSchedulingStrategy;
  /** Never place more than this many bots on one workspace (0 = no limit). */
  maxBotsPerWorkspace: number;
  /** Workspaces below this free-RAM fraction after placement are deprioritised. */
  minFreeRamFraction: number;
}

export const DEFAULT_FLEET_SCHEDULING_POLICY: FleetSchedulingPolicy = {
  strategy: 'spread',
  maxBotsPerWorkspace: 0,
  minFreeRamFraction: 0.1,
};

/** What a new bot needs. */
export interface FleetPlacementRequest {
  /** Bot (workspace) id the placement is for — informational, not yet a workspace. */
  botId: string;
  cpuCores: number;
  ramBytes: number;
  diskBytes: number;
  /** When set, only this workspace is considered (pin). */
  preferredWorkspaceId?: string;
}

export type PlacementFit = 'fits' | 'no-fit' | 'not-eligible';

/** One workspace scored for one placement request. */
export interface PlacementCandidate {
  workspaceId: string;
  workspaceName: string;
  fit: PlacementFit;
  /** 0..1, higher = better placement (0 when not a fit). */
  score: number;
  /** Headroom left AFTER this placement (allocated minus used minus request). */
  headroomAfter: { cpuCores: number; ramBytes: number; diskBytes: number };
  /** Why this workspace is (not) a candidate, in plain words. */
  reason: string;
  /** Bots already placed on this workspace (from the usage summary count). */
  botsPlaced: number;
}

/** Result of planning one placement. */
export interface PlacementPlan {
  request: FleetPlacementRequest;
  policy: FleetSchedulingPolicy;
  candidates: PlacementCandidate[];
  /** Best candidate, or null when nothing fits. */
  best: PlacementCandidate | null;
  plannedAt: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/** Validate a placement request (throws on any bad field). */
export function validatePlacementRequest(raw: unknown): FleetPlacementRequest {
  if (!isRecord(raw)) throw new Error('placement request must be an object.');
  const { botId, cpuCores, ramBytes, diskBytes, preferredWorkspaceId } = raw;
  if (typeof botId !== 'string' || botId.trim().length === 0) {
    throw new Error('placement request needs a non-empty botId.');
  }
  if (!isPositiveFinite(cpuCores)) throw new Error('placement request cpuCores must be a number > 0.');
  if (!isPositiveFinite(ramBytes)) throw new Error('placement request ramBytes must be a number > 0.');
  if (!isPositiveFinite(diskBytes)) throw new Error('placement request diskBytes must be a number > 0.');
  if (
    preferredWorkspaceId !== undefined &&
    (typeof preferredWorkspaceId !== 'string' || preferredWorkspaceId.trim().length === 0)
  ) {
    throw new Error('placement request preferredWorkspaceId must be a non-empty string when given.');
  }
  return {
    botId: botId.trim(),
    cpuCores: cpuCores as number,
    ramBytes: ramBytes as number,
    diskBytes: diskBytes as number,
    ...(preferredWorkspaceId !== undefined
      ? { preferredWorkspaceId: (preferredWorkspaceId as string).trim() }
      : {}),
  };
}

/** Validate a scheduling policy (throws on any bad field). */
export function validateSchedulingPolicy(raw: unknown): FleetSchedulingPolicy {
  if (!isRecord(raw)) throw new Error('scheduling policy must be an object.');
  const { strategy, maxBotsPerWorkspace, minFreeRamFraction } = raw;
  if (strategy !== 'spread' && strategy !== 'binpack') {
    throw new Error("scheduling policy strategy must be 'spread' or 'binpack'.");
  }
  if (
    typeof maxBotsPerWorkspace !== 'number' ||
    !Number.isInteger(maxBotsPerWorkspace) ||
    maxBotsPerWorkspace < 0
  ) {
    throw new Error('scheduling policy maxBotsPerWorkspace must be an integer >= 0.');
  }
  if (
    typeof minFreeRamFraction !== 'number' ||
    !Number.isFinite(minFreeRamFraction) ||
    minFreeRamFraction < 0 ||
    minFreeRamFraction >= 1
  ) {
    throw new Error('scheduling policy minFreeRamFraction must be a number in [0, 1).');
  }
  return { strategy, maxBotsPerWorkspace, minFreeRamFraction };
}

function usedFromSummary(usage: FleetUsageSummary | null): {
  ramBytes: number | null;
  diskBytes: number | null;
} {
  if (!usage) return { ramBytes: null, diskBytes: null };
  return { ramBytes: usage.rssBytesLatest, diskBytes: usage.diskBytesLatest };
}

/**
 * Score one workspace for one placement request.
 *
 * - suspended workspaces and errored services are never targets
 *   ('not-eligible'); a stopped service is fine (the scheduler places
 *   the bot, the service starts later).
 * - 'no-fit' when the request exceeds the workspace's allocation
 *   minus what is already used (used = latest measured sample; when
 *   unmeasured, used is treated as 0 but flagged in the reason —
 *   allocation alone still bounds the placement).
 * - score: under 'spread', the emptier the workspace after placement
 *   the higher the score; under 'binpack', the fuller the better.
 *   A workspace that would drop below minFreeRamFraction after
 *   placement loses half its score (deprioritised, not rejected).
 */
export function scoreWorkspaceForPlacement(
  status: FleetStatusView,
  request: FleetPlacementRequest,
  policy: FleetSchedulingPolicy,
  botsPlaced = 0,
): PlacementCandidate {
  const ws = status.workspace;
  const used = usedFromSummary(status.usage);
  const unmeasured = used.ramBytes === null && used.diskBytes === null;
  const ramUsed = used.ramBytes ?? 0;
  const diskUsed = used.diskBytes ?? 0;
  const headroomAfter = {
    cpuCores: ws.cpuCores - request.cpuCores,
    ramBytes: ws.ramBytes - ramUsed - request.ramBytes,
    diskBytes: ws.diskBytes - diskUsed - request.diskBytes,
  };
  const base: Omit<PlacementCandidate, 'fit' | 'score' | 'reason'> = {
    workspaceId: ws.id,
    workspaceName: ws.name,
    headroomAfter,
    botsPlaced,
  };
  if (ws.status !== 'active') {
    return { ...base, fit: 'not-eligible', score: 0, reason: `workspace "${ws.name}" is ${ws.status}.` };
  }
  if (status.service.state === 'error') {
    return { ...base, fit: 'not-eligible', score: 0, reason: `service of "${ws.name}" is in error state.` };
  }
  if (policy.maxBotsPerWorkspace > 0 && botsPlaced >= policy.maxBotsPerWorkspace) {
    return {
      ...base,
      fit: 'not-eligible',
      score: 0,
      reason: `"${ws.name}" already hosts ${botsPlaced} bots (limit ${policy.maxBotsPerWorkspace}).`,
    };
  }
  if (headroomAfter.cpuCores < 0 || headroomAfter.ramBytes < 0 || headroomAfter.diskBytes < 0) {
    const lacking: string[] = [];
    if (headroomAfter.cpuCores < 0) lacking.push('cpu');
    if (headroomAfter.ramBytes < 0) lacking.push('ram');
    if (headroomAfter.diskBytes < 0) lacking.push('disk');
    return {
      ...base,
      fit: 'no-fit',
      score: 0,
      reason: `"${ws.name}" cannot fit the request (not enough ${lacking.join(' + ')}).`,
    };
  }
  // Fraction of the workspace still free after placement, per resource.
  const freeCpu = ws.cpuCores > 0 ? headroomAfter.cpuCores / ws.cpuCores : 0;
  const freeRam = ws.ramBytes > 0 ? headroomAfter.ramBytes / ws.ramBytes : 0;
  const freeDisk = ws.diskBytes > 0 ? headroomAfter.diskBytes / ws.diskBytes : 0;
  const freeMean = (freeCpu + freeRam + freeDisk) / 3;
  let score = policy.strategy === 'spread' ? freeMean : 1 - freeMean;
  // Deprioritise (not reject) workspaces that would run low on RAM.
  if (freeRam < policy.minFreeRamFraction) score *= 0.5;
  const reason = unmeasured
    ? `"${ws.name}" fits (usage unmeasured — allocation only).`
    : `"${ws.name}" fits; ${Math.round(freeMean * 100)}% free after placement.`;
  return { ...base, fit: 'fits', score, reason };
}

/**
 * Plan one placement across the whole fleet. Candidates are ranked
 * best-first; ties break by workspace name so the order is stable.
 * A preferredWorkspaceId restricts the plan to that workspace.
 */
export function planPlacement(
  statuses: FleetStatusView[],
  request: FleetPlacementRequest,
  policy: FleetSchedulingPolicy = DEFAULT_FLEET_SCHEDULING_POLICY,
  botsPlacedByWorkspace: Record<string, number> = {},
  at: number = Date.now(),
): PlacementPlan {
  const req = validatePlacementRequest(request);
  const pol = validateSchedulingPolicy(policy);
  const pool = req.preferredWorkspaceId
    ? statuses.filter((s) => s.workspace.id === req.preferredWorkspaceId)
    : statuses;
  const candidates = pool
    .map((status) =>
      scoreWorkspaceForPlacement(status, req, pol, botsPlacedByWorkspace[status.workspace.id] ?? 0),
    )
    .sort(
      (a, b) =>
        b.score - a.score ||
        (b.fit === 'fits' ? 1 : 0) - (a.fit === 'fits' ? 1 : 0) ||
        a.workspaceName.localeCompare(b.workspaceName),
    );
  const best = candidates.find((c) => c.fit === 'fits') ?? null;
  return { request: req, policy: pol, candidates, best, plannedAt: at };
}

// ---------------------------------------------------------------------------
// Durable placement queue (`fleet-schedule.json`)
// ---------------------------------------------------------------------------

export const FLEET_SCHEDULE_FILE = 'fleet-schedule.json';

/** One waiting placement request. */
export interface QueuedPlacement {
  /** Queue id: `pq-<uuid-ish>`. */
  id: string;
  request: FleetPlacementRequest;
  policy: FleetSchedulingPolicy;
  /** 'waiting' | 'claimed' (an admin picked it up) | 'cancelled'. */
  status: 'waiting' | 'claimed' | 'cancelled';
  requestedBy: string;
  requestedAt: string;
  /** Admin who claimed it (only when status = 'claimed'). */
  claimedBy?: string;
  claimedAt?: string;
  /** Why it was cancelled (only when status = 'cancelled'). */
  cancelReason?: string;
}

export function getFleetSchedulePath(rootDir: string): string {
  if (typeof rootDir !== 'string' || rootDir.trim().length === 0) {
    throw new Error('fleet schedule needs a non-empty rootDir.');
  }
  return path.join(rootDir, FLEET_SCHEDULE_FILE);
}

/** Validate one queued placement (throws on any bad field). */
export function validateQueuedPlacement(raw: unknown): QueuedPlacement {
  if (!isRecord(raw)) throw new Error('queued placement must be an object.');
  const { id, request, policy, status, requestedBy, requestedAt, claimedBy, claimedAt, cancelReason } = raw;
  if (typeof id !== 'string' || id.trim().length === 0) {
    throw new Error('queued placement needs a non-empty id.');
  }
  const validRequest = validatePlacementRequest(request);
  const validPolicy = validateSchedulingPolicy(policy);
  if (status !== 'waiting' && status !== 'claimed' && status !== 'cancelled') {
    throw new Error("queued placement status must be 'waiting', 'claimed' or 'cancelled'.");
  }
  if (typeof requestedBy !== 'string' || requestedBy.trim().length === 0) {
    throw new Error('queued placement needs a non-empty requestedBy.');
  }
  if (typeof requestedAt !== 'string' || requestedAt.trim().length === 0) {
    throw new Error('queued placement needs a non-empty requestedAt.');
  }
  if (claimedBy !== undefined && typeof claimedBy !== 'string') {
    throw new Error('queued placement claimedBy must be a string when given.');
  }
  if (claimedAt !== undefined && typeof claimedAt !== 'string') {
    throw new Error('queued placement claimedAt must be a string when given.');
  }
  if (cancelReason !== undefined && typeof cancelReason !== 'string') {
    throw new Error('queued placement cancelReason must be a string when given.');
  }
  return {
    id: id.trim(),
    request: validRequest,
    policy: validPolicy,
    status,
    requestedBy: requestedBy.trim(),
    requestedAt,
    ...(claimedBy !== undefined ? { claimedBy } : {}),
    ...(claimedAt !== undefined ? { claimedAt } : {}),
    ...(cancelReason !== undefined ? { cancelReason } : {}),
  };
}

/** Load the queue (missing file = empty queue). */
export function loadScheduleQueue(rootDir: string): QueuedPlacement[] {
  const filePath = getFleetSchedulePath(rootDir);
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${FLEET_SCHEDULE_FILE} is corrupt: not valid JSON.`);
  }
  if (!Array.isArray(parsed)) throw new Error(`${FLEET_SCHEDULE_FILE} is corrupt: expected an array.`);
  return parsed.map((entry, i) => {
    try {
      return validateQueuedPlacement(entry);
    } catch (err) {
      throw new Error(`${FLEET_SCHEDULE_FILE} is corrupt at index ${i}: ${(err as Error).message}`);
    }
  });
}

/** Save the queue (atomic tmp + rename, mode 0600). */
export function saveScheduleQueue(rootDir: string, queue: QueuedPlacement[]): void {
  const valid = queue.map((q) => validateQueuedPlacement(q));
  const filePath = getFleetSchedulePath(rootDir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(valid, null, 2)}\n`, 'utf8');
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    // chmod is best-effort on platforms without POSIX modes.
  }
  fs.renameSync(tmp, filePath);
}

function queueId(): string {
  return `pq-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export interface EnqueuePlacementInput {
  request: FleetPlacementRequest;
  policy?: FleetSchedulingPolicy;
  requestedBy: string;
}

/** Add a placement request to the waiting queue. Returns the queued entry. */
export function enqueuePlacement(rootDir: string, input: EnqueuePlacementInput): QueuedPlacement {
  const request = validatePlacementRequest(input.request);
  const policy = input.policy ? validateSchedulingPolicy(input.policy) : DEFAULT_FLEET_SCHEDULING_POLICY;
  if (typeof input.requestedBy !== 'string' || input.requestedBy.trim().length === 0) {
    throw new Error('enqueuePlacement needs a non-empty requestedBy.');
  }
  const entry: QueuedPlacement = {
    id: queueId(),
    request,
    policy,
    status: 'waiting',
    requestedBy: input.requestedBy.trim(),
    requestedAt: new Date().toISOString(),
  };
  const queue = loadScheduleQueue(rootDir);
  saveScheduleQueue(rootDir, [...queue, entry]);
  return entry;
}

/** Mark a waiting request as claimed by an admin. Returns the updated entry. */
export function claimPlacement(rootDir: string, id: string, claimedBy: string): QueuedPlacement {
  if (typeof claimedBy !== 'string' || claimedBy.trim().length === 0) {
    throw new Error('claimPlacement needs a non-empty claimedBy.');
  }
  const queue = loadScheduleQueue(rootDir);
  const found = queue.find((q) => q.id === id);
  if (!found) throw new Error(`no queued placement with id "${id}".`);
  if (found.status !== 'waiting') {
    throw new Error(`queued placement "${id}" is ${found.status}, not waiting.`);
  }
  const updated: QueuedPlacement = {
    ...found,
    status: 'claimed',
    claimedBy: claimedBy.trim(),
    claimedAt: new Date().toISOString(),
  };
  saveScheduleQueue(
    rootDir,
    queue.map((q) => (q.id === id ? updated : q)),
  );
  return updated;
}

/** Cancel a waiting (or claimed) request. Returns the updated entry. */
export function cancelPlacement(rootDir: string, id: string, reason?: string): QueuedPlacement {
  const queue = loadScheduleQueue(rootDir);
  const found = queue.find((q) => q.id === id);
  if (!found) throw new Error(`no queued placement with id "${id}".`);
  if (found.status === 'cancelled') return found;
  const updated: QueuedPlacement = {
    ...found,
    status: 'cancelled',
    ...(reason !== undefined && reason.trim().length > 0 ? { cancelReason: reason.trim() } : {}),
  };
  saveScheduleQueue(
    rootDir,
    queue.map((q) => (q.id === id ? updated : q)),
  );
  return updated;
}

/** Only the requests still waiting, oldest first. */
export function listWaitingPlacements(rootDir: string): QueuedPlacement[] {
  return loadScheduleQueue(rootDir)
    .filter((q) => q.status === 'waiting')
    .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
}
