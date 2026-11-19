/**
 * Fleet v29 health + cost rollup (v1.42, Team T6).
 *
 * Reads the peer registry (latency/cost samples), the task board
 * (active / terminal counts), the allowlist (live entries), and the
 * confirmation queue (pending sensitive requests) and turns them
 * into the numbers the board dashboard shows: per-peer health
 * (score, p50/p95, error rate, cost) and the fleet-wide summary.
 *
 * Thresholds are the board's own (documented here, tunable by the
 * host later): a peer is `healthy` at score >= 80, `degraded` at
 * >= 50, `down` below that; `unknown` when nothing has ever been
 * measured. Cost is a sum of recorded samples — never an estimate
 * the board invented; unpriced usage is reported as cost 0 with
 * the peer flagged by its sample count, not by a guessed price.
 */

import type { FleetV29Allowlist } from './allowlist';
import type { FleetV29PeerRegistry } from './peerRegistry';
import type { FleetV29TaskBoard } from './taskBoard';
import type { FleetV29HealthSummary, FleetV29PeerHealth } from './types';

export interface FleetV29HealthDeps {
  registry: FleetV29PeerRegistry;
  board: FleetV29TaskBoard;
  allowlist: FleetV29Allowlist;
  /** Pending sensitive confirmations (0 when the host has no queue). */
  pendingConfirmations?: number;
  /** Clock for allowlist expiry checks. */
  nowIso?: () => string;
}

/** Fleet-wide health summary for the dashboard. */
export function buildFleetV29HealthSummary(deps: FleetV29HealthDeps): FleetV29HealthSummary {
  const now = deps.nowIso?.() ?? new Date().toISOString();
  const peers = deps.registry.listPeers();
  const activeByPeer = deps.board.activeTasksByPeer();
  const health = deps.registry.allPeerHealth(activeByPeer);
  let healthy = 0;
  let degraded = 0;
  let down = 0;
  let unknown = 0;
  let totalCostUsd = 0;
  const medians: number[] = [];
  for (const h of health) {
    if (h.level === 'healthy') healthy += 1;
    else if (h.level === 'degraded') degraded += 1;
    else if (h.level === 'down') down += 1;
    else unknown += 1;
    totalCostUsd += h.totalCostUsd;
    if (h.p50Ms !== null) medians.push(h.p50Ms);
  }
  medians.sort((a, b) => a - b);
  const counts = deps.board.countsByState();
  const allowlistedUnverified = deps.allowlist
    .list()
    .filter((entry) => {
      if (!deps.allowlist.isAllowlisted(entry.peerId, now)) return false;
      const peer = deps.registry.getPeer(entry.peerId);
      return !peer || (peer.cardStatus !== 'verified' && peer.cardStatus !== 'unsigned');
    }).length;
  return {
    peersTotal: peers.length,
    peersHealthy: healthy,
    peersDegraded: degraded,
    peersDown: down,
    peersUnknown: unknown,
    tasksActive: [...activeByPeer.values()].reduce((a, b) => a + b, 0),
    tasksCompleted: counts['completed'] ?? 0,
    tasksFailed: counts['failed'] ?? 0,
    tasksCancelled: counts['cancelled'] ?? 0,
    tasksAwaitingInput: deps.board.listTasks({ state: 'input-required' }).total,
    totalCostUsd: Math.round(totalCostUsd * 10000) / 10000,
    medianLatencyMs: medians.length === 0 ? null : (medians[Math.floor(medians.length / 2)] as number),
    pendingConfirmations: deps.pendingConfirmations ?? 0,
    allowlistedUnverified,
  };
}

/** Per-peer health, sorted best-first (healthy, then lowest p50). */
export function listFleetV29PeerHealth(deps: {
  registry: FleetV29PeerRegistry;
  board: FleetV29TaskBoard;
}): FleetV29PeerHealth[] {
  const activeByPeer = deps.board.activeTasksByPeer();
  const health = deps.registry.allPeerHealth(activeByPeer);
  const rank = (level: FleetV29PeerHealth['level']): number =>
    level === 'healthy' ? 0 : level === 'degraded' ? 1 : level === 'unknown' ? 2 : 3;
  return health.sort((a, b) => {
    if (rank(a.level) !== rank(b.level)) return rank(a.level) - rank(b.level);
    const la = a.p50Ms ?? Number.POSITIVE_INFINITY;
    const lb = b.p50Ms ?? Number.POSITIVE_INFINITY;
    return la - lb;
  });
}

/** Alert strings for the dashboard (empty = nothing needs attention). */
export function fleetV29HealthAlerts(summary: FleetV29HealthSummary): string[] {
  const alerts: string[] = [];
  if (summary.peersDown > 0) alerts.push(`${summary.peersDown} peer(s) down.`);
  if (summary.allowlistedUnverified > 0) {
    alerts.push(`${summary.allowlistedUnverified} allowlisted peer(s) have an unverified card — delegation to them is blocked.`);
  }
  if (summary.pendingConfirmations > 0) {
    alerts.push(`${summary.pendingConfirmations} sensitive action(s) awaiting your confirmation.`);
  }
  if (summary.tasksAwaitingInput > 0) {
    alerts.push(`${summary.tasksAwaitingInput} task(s) waiting for your input.`);
  }
  if (summary.tasksFailed > 0 && summary.tasksFailed >= summary.tasksCompleted && summary.tasksCompleted > 0) {
    alerts.push('More tasks failed than completed — check peer health before delegating more work.');
  }
  return alerts;
}

/** Cost leaderboard: peers by total cost, highest first. */
export function fleetV29CostLeaderboard(health: FleetV29PeerHealth[]): FleetV29PeerHealth[] {
  return [...health].sort((a, b) => b.totalCostUsd - a.totalCostUsd);
}
