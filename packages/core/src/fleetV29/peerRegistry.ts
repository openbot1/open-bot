/**
 * Fleet v29 peer registry (v1.42, Team T6).
 *
 * Owns the fleet's view of A2A peers: register from an Agent Card,
 * track verification status, latency/cost samples, reachability, and
 * health. The registry never decides trust on its own — trust is
 * `allowlist AND card verified` (see `allowlist.ts` +
 * `cardVerify.ts`); this store only holds the facts both of them
 * read.
 *
 * A peer's card fingerprint changes when the card changes (new URL,
 * new key, new skills): the registry marks the peer `stale` so the
 * fleet re-verifies before delegating again — a card swapped
 * mid-session must not silently keep its old trust.
 */

import type { A2aAgentCard } from '../a2a/types';
import type {
  FleetV29LatencySample,
  FleetV29Peer,
  FleetV29PeerHealth,
} from './types';
import { fleetV29FingerprintCard } from './cardVerify';

/** Max latency samples kept per peer (ring buffer, oldest dropped). */
export const FLEET_V29_MAX_SAMPLES_PER_PEER = 200;
/** Samples used for p50/p95 + error rate (most recent N). */
export const FLEET_V29_HEALTH_WINDOW = 50;

export interface FleetV29PeerInput {
  peerId: string;
  card: A2aAgentCard;
  tenantId?: string;
  tags?: string[];
}

export interface FleetV29PeerUpdate {
  card?: A2aAgentCard;
  tags?: string[];
  reachable?: boolean;
  tenantId?: string;
}

function cloneCard(card: A2aAgentCard): A2aAgentCard {
  return JSON.parse(JSON.stringify(card)) as A2aAgentCard;
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)));
  return sorted[idx] as number;
}

export class FleetV29PeerRegistry {
  private readonly peers = new Map<string, FleetV29Peer>();
  private readonly samples = new Map<string, FleetV29LatencySample[]>();
  private readonly taskCounts = new Map<string, { completed: number; failed: number }>();

  /** Register a peer from its Agent Card (or refresh an existing one). */
  registerPeer(input: FleetV29PeerInput, nowIso?: string): FleetV29Peer {
    const now = nowIso ?? new Date().toISOString();
    const fingerprint = fleetV29FingerprintCard(input.card);
    const existing = this.peers.get(input.peerId);
    if (existing) {
      const changed = existing.cardFingerprint !== fingerprint;
      existing.card = cloneCard(input.card);
      existing.cardFingerprint = fingerprint;
      if (changed) {
        // Card changed under the same peer id: trust must be re-earned.
        existing.cardStatus = 'stale';
        existing.verifyMethod = 'none';
        existing.verifyProblems = ['Agent Card changed since last verification; re-verify before delegating.'];
        existing.verifiedAt = null;
      }
      if (input.tags !== undefined) existing.tags = [...input.tags];
      if (input.tenantId !== undefined) existing.tenantId = input.tenantId;
      return existing;
    }
    const peer: FleetV29Peer = {
      peerId: input.peerId,
      card: cloneCard(input.card),
      cardFingerprint: fingerprint,
      cardStatus: 'unverified',
      verifyMethod: 'none',
      verifyProblems: [],
      verifiedAt: null,
      registeredAt: now,
      lastSeenAt: null,
      tenantId: input.tenantId,
      tags: [...(input.tags ?? [])],
      reachable: false,
      consecutiveFailures: 0,
    };
    this.peers.set(input.peerId, peer);
    this.samples.set(input.peerId, []);
    this.taskCounts.set(input.peerId, { completed: 0, failed: 0 });
    return peer;
  }

  getPeer(peerId: string): FleetV29Peer | null {
    return this.peers.get(peerId) ?? null;
  }

  /** All peers, optionally filtered by tenant / tag / verification status. */
  listPeers(filter?: {
    tenantId?: string;
    tag?: string;
    cardStatus?: FleetV29Peer['cardStatus'];
    reachableOnly?: boolean;
  }): FleetV29Peer[] {
    const out: FleetV29Peer[] = [];
    for (const peer of this.peers.values()) {
      if (filter?.tenantId !== undefined && peer.tenantId !== filter.tenantId) continue;
      if (filter?.tag !== undefined && !peer.tags.includes(filter.tag)) continue;
      if (filter?.cardStatus !== undefined && peer.cardStatus !== filter.cardStatus) continue;
      if (filter?.reachableOnly && !peer.reachable) continue;
      out.push(peer);
    }
    out.sort((a, b) => a.peerId.localeCompare(b.peerId));
    return out;
  }

  removePeer(peerId: string): boolean {
    const had = this.peers.delete(peerId);
    this.samples.delete(peerId);
    this.taskCounts.delete(peerId);
    return had;
  }

  /** Record the outcome of a card verification check. */
  recordVerification(
    peerId: string,
    status: FleetV29Peer['cardStatus'],
    method: FleetV29Peer['verifyMethod'],
    problems: string[],
    nowIso?: string,
  ): FleetV29Peer | null {
    const peer = this.peers.get(peerId);
    if (!peer) return null;
    peer.cardStatus = status;
    peer.verifyMethod = method;
    peer.verifyProblems = [...problems];
    peer.verifiedAt = status === 'verified' || status === 'unsigned' ? nowIso ?? new Date().toISOString() : peer.verifiedAt;
    if (status === 'verified' || status === 'unsigned') peer.reachable = true;
    return peer;
  }

  /** Mark a peer seen (successful probe / task round-trip). */
  markSeen(peerId: string, nowIso?: string): void {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    peer.lastSeenAt = nowIso ?? new Date().toISOString();
    peer.reachable = true;
    peer.consecutiveFailures = 0;
  }

  /** Mark a probe/task failure (reachability + health input). */
  markFailed(peerId: string): void {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    peer.consecutiveFailures += 1;
    if (peer.consecutiveFailures >= 3) peer.reachable = false;
  }

  /** Record one latency/cost sample (ring buffer per peer). */
  recordSample(sample: FleetV29LatencySample): void {
    if (!this.peers.has(sample.peerId)) return;
    const list = this.samples.get(sample.peerId) ?? [];
    list.push({ ...sample });
    while (list.length > FLEET_V29_MAX_SAMPLES_PER_PEER) list.shift();
    this.samples.set(sample.peerId, list);
    if (sample.failed) this.markFailed(sample.peerId);
    else this.markSeen(sample.peerId, sample.at);
  }

  listSamples(peerId: string, limit = FLEET_V29_HEALTH_WINDOW): FleetV29LatencySample[] {
    const list = this.samples.get(peerId) ?? [];
    return list.slice(-Math.max(1, limit));
  }

  /** Record a terminal task outcome for health accounting. */
  recordTaskOutcome(peerId: string, outcome: 'completed' | 'failed'): void {
    const counts = this.taskCounts.get(peerId) ?? { completed: 0, failed: 0 };
    if (outcome === 'completed') counts.completed += 1;
    else counts.failed += 1;
    this.taskCounts.set(peerId, counts);
  }

  /** Per-peer health rollup from recent samples + task counts. */
  peerHealth(peerId: string, activeTasks: number): FleetV29PeerHealth | null {
    const peer = this.peers.get(peerId);
    if (!peer) return null;
    const window = this.listSamples(peerId, FLEET_V29_HEALTH_WINDOW);
    const latencies = window.filter((s) => !s.failed).map((s) => s.latencyMs).sort((a, b) => a - b);
    const failures = window.filter((s) => s.failed).length;
    const totalCostUsd = window.reduce((sum, s) => sum + s.costUsd, 0);
    const counts = this.taskCounts.get(peerId) ?? { completed: 0, failed: 0 };
    const errorRate = window.length === 0 ? 0 : failures / window.length;
    let score = 100;
    score -= Math.min(60, errorRate * 120);
    const p95 = percentile(latencies, 95);
    if (p95 !== null && p95 > 5000) score -= 20;
    else if (p95 !== null && p95 > 2000) score -= 10;
    if (peer.consecutiveFailures >= 3) score -= 20;
    if (peer.cardStatus === 'invalid') score = Math.min(score, 20);
    if (peer.cardStatus === 'stale' || peer.cardStatus === 'unverified') score = Math.min(score, 70);
    score = Math.max(0, Math.min(100, Math.round(score)));
    const level: FleetV29PeerHealth['level'] =
      window.length === 0 && peer.lastSeenAt === null
        ? 'unknown'
        : score >= 80
          ? 'healthy'
          : score >= 50
            ? 'degraded'
            : 'down';
    return {
      peerId,
      score,
      level,
      p50Ms: percentile(latencies, 50),
      p95Ms: p95,
      errorRate: Math.round(errorRate * 1000) / 1000,
      totalCostUsd: Math.round(totalCostUsd * 10000) / 10000,
      activeTasks,
      completedTasks: counts.completed,
      failedTasks: counts.failed,
      lastSampleAt: window.length > 0 ? (window[window.length - 1]?.at ?? null) : null,
    };
  }

  /** Health for every registered peer. */
  allPeerHealth(activeByPeer: ReadonlyMap<string, number>): FleetV29PeerHealth[] {
    return this.listPeers().map(
      (p) => this.peerHealth(p.peerId, activeByPeer.get(p.peerId) ?? 0) as FleetV29PeerHealth,
    );
  }

  peerCount(): number {
    return this.peers.size;
  }

  /** Peers whose card is verified (usable once allowlisted). */
  verifiedPeers(): FleetV29Peer[] {
    return this.listPeers().filter((p) => p.cardStatus === 'verified');
  }

  /** Serialize for the host snapshot (cards + samples, no secrets). */
  toJSON(): { peers: FleetV29Peer[]; samples: Record<string, FleetV29LatencySample[]> } {
    const samples: Record<string, FleetV29LatencySample[]> = {};
    for (const [peerId, list] of this.samples) samples[peerId] = [...list];
    return { peers: this.listPeers(), samples };
  }
}

/** Sort peers for the board: healthy first, then by p50 latency. */
export function sortPeersForBoard(
  peers: FleetV29Peer[],
  healthByPeer: ReadonlyMap<string, FleetV29PeerHealth>,
): FleetV29Peer[] {
  const levelRank = (level: FleetV29PeerHealth['level']): number =>
    level === 'healthy' ? 0 : level === 'degraded' ? 1 : level === 'unknown' ? 2 : 3;
  return [...peers].sort((a, b) => {
    const ha = healthByPeer.get(a.peerId);
    const hb = healthByPeer.get(b.peerId);
    const ra = ha ? levelRank(ha.level) : 2;
    const rb = hb ? levelRank(hb.level) : 2;
    if (ra !== rb) return ra - rb;
    const la = ha?.p50Ms ?? Number.POSITIVE_INFINITY;
    const lb = hb?.p50Ms ?? Number.POSITIVE_INFINITY;
    if (la !== lb) return la - lb;
    return a.peerId.localeCompare(b.peerId);
  });
}
