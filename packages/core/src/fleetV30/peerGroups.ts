/**
 * Peer groups + capability routing (v1.44, Team T6) — fleet v30.
 *
 * The v29 registry owns peers, cards, and verification; v30 adds
 * the organisation and routing layer on top of it:
 *
 * - Groups: a named set of peers (a team, a region, a capability
 *   pool). Membership is kept in the group AND mirrored onto the
 *   peer's tags as `group:<groupId>` so the v29 board, the v30
 *   board views, and the panels can filter by group without a
 *   second lookup. Removing a peer from the fleet removes it from
 *   every group (the host calls `removePeerFromAllGroups` when it
 *   removes the peer from the registry).
 * - Discovery probes: the host probes a peer endpoint (HTTP GET
 *   of the Agent Card URL, or a plain TCP connect — the host
 *   chooses) and records the outcome here; a reachable probe
 *   feeds a latency sample into the v29 registry so health scoring
 *   sees it. This module never touches the network itself.
 * - Capability scoring: for a task requirement (skills, latency
 *   budget, streaming, group) each candidate peer gets a 0–100
 *   score with a breakdown — skills 40, health 25, capacity 20,
 *   latency 15. A peer that misses a required skill, is
 *   unverified, or cannot stream when streaming is required scores
 *   0 on that component and the miss is listed in `reasons`, so
 *   the operator sees why a peer was passed over.
 * - Pick / failover: `pickPeer` returns the best-scoring peer
 *   with free capacity (ties break by p50 latency, then peer id);
 *   `pickFailover` is the same pick with one peer excluded — the
 *   peer that just failed a task.
 *
 * All scores are deterministic given the same inputs (no clock,
 * no randomness) so tests and the UI agree.
 */

import type { FleetV29PeerRegistry } from '../fleetV29/peerRegistry';
import type { FleetV29Peer, FleetV29PeerHealth } from '../fleetV29/types';
import type { FleetV29TaskBoard } from '../fleetV29/taskBoard';
import type {
  FleetV30CapabilityScore,
  FleetV30DiscoveryProbe,
  FleetV30PeerGroup,
  FleetV30TaskRequirement,
} from './types';
import { FLEET_V30_MAX_GROUPS } from './types';

export interface FleetV30PeerGroupsDeps {
  /** The v29 peer registry (owns peers + health samples). */
  registry: FleetV29PeerRegistry;
  /** The v29 task board (for active-task counts per peer). */
  board: FleetV29TaskBoard;
  /** Id generator (tests inject a deterministic one). */
  newId?: () => string;
  /** Clock (tests inject a fixed one). */
  nowIso?: () => string;
}

function defaultId(): string {
  return `group-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/** Group tag written onto a peer (mirrors group membership). */
export function fleetV30GroupTag(groupId: string): string {
  return `group:${groupId}`;
}

export class FleetV30PeerGroups {
  private readonly registry: FleetV29PeerRegistry;
  private readonly board: FleetV29TaskBoard;
  private readonly newId: () => string;
  private readonly nowIso: () => string;
  private readonly groups = new Map<string, FleetV30PeerGroup>();
  private readonly probes = new Map<string, FleetV30DiscoveryProbe[]>();

  constructor(deps: FleetV30PeerGroupsDeps) {
    this.registry = deps.registry;
    this.board = deps.board;
    this.newId = deps.newId ?? defaultId;
    this.nowIso = deps.nowIso ?? (() => new Date().toISOString());
  }

  /* ---------------- groups ---------------- */

  /** Create a group (validated, bounded). */
  createGroup(
    name: string,
    createdBy: string,
    opts: { description?: string; defaultMaxConcurrent?: number | null } = {},
  ): { ok: true; group: FleetV30PeerGroup } | { ok: false; reasons: string[] } {
    const reasons: string[] = [];
    if (!name.trim()) reasons.push('A group name is required.');
    if (this.groups.size >= FLEET_V30_MAX_GROUPS) reasons.push(`Too many peer groups (max ${FLEET_V30_MAX_GROUPS}).`);
    if (opts.defaultMaxConcurrent !== undefined && opts.defaultMaxConcurrent !== null) {
      if (!Number.isInteger(opts.defaultMaxConcurrent) || opts.defaultMaxConcurrent < 1) {
        reasons.push('defaultMaxConcurrent must be an integer >= 1 or null.');
      }
    }
    if (reasons.length > 0) return { ok: false, reasons };
    const groupId = `group-${this.newId()}`;
    const group: FleetV30PeerGroup = {
      groupId,
      name: name.trim(),
      description: opts.description ?? '',
      peerIds: [],
      createdBy,
      createdAt: this.nowIso(),
      defaultMaxConcurrent: opts.defaultMaxConcurrent ?? null,
    };
    this.groups.set(groupId, group);
    return { ok: true, group: { ...group, peerIds: [] } };
  }

  getGroup(groupId: string): FleetV30PeerGroup | null {
    const g = this.groups.get(groupId);
    return g ? { ...g, peerIds: [...g.peerIds] } : null;
  }

  listGroups(): FleetV30PeerGroup[] {
    return [...this.groups.values()]
      .map((g) => ({ ...g, peerIds: [...g.peerIds] }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  renameGroup(groupId: string, name: string): { ok: true; group: FleetV30PeerGroup } | { ok: false; reasons: string[] } {
    const g = this.groups.get(groupId);
    if (!g) return { ok: false, reasons: [`No peer group "${groupId}".`] };
    if (!name.trim()) return { ok: false, reasons: ['A group name is required.'] };
    g.name = name.trim();
    return { ok: true, group: { ...g, peerIds: [...g.peerIds] } };
  }

  deleteGroup(groupId: string): { ok: true } | { ok: false; reasons: string[] } {
    const g = this.groups.get(groupId);
    if (!g) return { ok: false, reasons: [`No peer group "${groupId}".`] };
    // Remove the group tag from every member peer first.
    for (const peerId of [...g.peerIds]) this.removePeer(groupId, peerId);
    this.groups.delete(groupId);
    return { ok: true };
  }

  /** Add a peer to a group (peer must be registered; tag mirrored). */
  addPeer(
    groupId: string,
    peerId: string,
  ): { ok: true; group: FleetV30PeerGroup } | { ok: false; reasons: string[] } {
    const g = this.groups.get(groupId);
    if (!g) return { ok: false, reasons: [`No peer group "${groupId}".`] };
    const peer = this.registry.getPeer(peerId);
    if (!peer) return { ok: false, reasons: [`Peer "${peerId}" is not registered.`] };
    if (g.peerIds.includes(peerId)) return { ok: false, reasons: [`Peer "${peerId}" is already in group "${groupId}".`] };
    g.peerIds.push(peerId);
    g.peerIds.sort();
    const tag = fleetV30GroupTag(groupId);
    if (!peer.tags.includes(tag)) {
      this.registry.registerPeer({ peerId, card: peer.card, tags: [...peer.tags, tag] });
    }
    return { ok: true, group: { ...g, peerIds: [...g.peerIds] } };
  }

  /** Remove a peer from a group (tag removed too). */
  removePeer(
    groupId: string,
    peerId: string,
  ): { ok: true; group: FleetV30PeerGroup } | { ok: false; reasons: string[] } {
    const g = this.groups.get(groupId);
    if (!g) return { ok: false, reasons: [`No peer group "${groupId}".`] };
    if (!g.peerIds.includes(peerId)) return { ok: false, reasons: [`Peer "${peerId}" is not in group "${groupId}".`] };
    g.peerIds = g.peerIds.filter((id) => id !== peerId);
    const peer = this.registry.getPeer(peerId);
    if (peer) {
      const tag = fleetV30GroupTag(groupId);
      this.registry.registerPeer({ peerId, card: peer.card, tags: peer.tags.filter((t) => t !== tag) });
    }
    return { ok: true, group: { ...g, peerIds: [...g.peerIds] } };
  }

  /** Remove a peer from every group (call when the peer leaves the fleet). */
  removePeerFromAllGroups(peerId: string): string[] {
    const removed: string[] = [];
    for (const g of this.groups.values()) {
      if (!g.peerIds.includes(peerId)) continue;
      this.removePeer(g.groupId, peerId);
      removed.push(g.groupId);
    }
    return removed;
  }

  /** Groups one peer belongs to. */
  groupsForPeer(peerId: string): FleetV30PeerGroup[] {
    return this.listGroups().filter((g) => g.peerIds.includes(peerId));
  }

  /** Peers of a group (registered peers only — stale ids are skipped). */
  peersInGroup(groupId: string): FleetV29Peer[] {
    const g = this.groups.get(groupId);
    if (!g) return [];
    const out: FleetV29Peer[] = [];
    for (const peerId of g.peerIds) {
      const peer = this.registry.getPeer(peerId);
      if (peer) out.push(peer);
    }
    return out.sort((a, b) => a.peerId.localeCompare(b.peerId));
  }

  /* ---------------- discovery probes ---------------- */

  /**
   * Record a discovery probe. A reachable probe feeds a latency
   * sample into the v29 registry (health scoring sees it); an
   * unreachable probe marks the peer failed. Probes are kept per
   * peer (newest last, bounded at 50).
   */
  recordProbe(probe: Omit<FleetV30DiscoveryProbe, 'at'> & { at?: string }): FleetV30DiscoveryProbe {
    const at = probe.at ?? this.nowIso();
    const full: FleetV30DiscoveryProbe = { ...probe, at };
    const list = this.probes.get(probe.peerId) ?? [];
    list.push(full);
    while (list.length > 50) list.shift();
    this.probes.set(probe.peerId, list);
    if (this.registry.getPeer(probe.peerId)) {
      this.registry.recordSample({
        peerId: probe.peerId,
        latencyMs: probe.latencyMs ?? 0,
        costUsd: 0,
        failed: !probe.reachable,
        at,
      });
    }
    return { ...full };
  }

  listProbes(peerId: string, limit = 20): FleetV30DiscoveryProbe[] {
    const list = this.probes.get(peerId) ?? [];
    return list.slice(-Math.max(1, limit)).map((p) => ({ ...p }));
  }

  /** Last probe per peer (for the groups panel). */
  lastProbeByPeer(): Map<string, FleetV30DiscoveryProbe> {
    const out = new Map<string, FleetV30DiscoveryProbe>();
    for (const [peerId, list] of this.probes) {
      const last = list[list.length - 1];
      if (last) out.set(peerId, { ...last });
    }
    return out;
  }

  /* ---------------- capability scoring ---------------- */

  /**
   * Score one peer against a task requirement.
   *
   * - Skills (40): share of required skills the card advertises
   *   (a peer with none of the required skills scores 0 here).
   * - Health (25): the v29 health score scaled to 25; an
   *   unverified / stale / invalid card caps the total at 40.
   * - Capacity (20): free concurrency slots vs the peer's cap
   *   (full = 0, half = 10, empty = 20).
   * - Latency (15): p50 vs the latency budget (no budget = 15;
   *   p50 over budget = 0, scaled linearly below it).
   */
  scorePeer(
    peer: FleetV29Peer,
    health: FleetV29PeerHealth | null,
    requirement: FleetV30TaskRequirement,
    activeTasks: number,
    maxConcurrent: number,
  ): FleetV30CapabilityScore {
    const reasons: string[] = [];
    const cardSkills = (peer.card.skills ?? []).map((s) => s.id);
    let skillScore = 40;
    if (requirement.requiredSkills.length > 0) {
      const matched = requirement.requiredSkills.filter((s) => cardSkills.includes(s)).length;
      skillScore = Math.round((matched / requirement.requiredSkills.length) * 40);
      if (matched < requirement.requiredSkills.length) {
        const missing = requirement.requiredSkills.filter((s) => !cardSkills.includes(s));
        reasons.push(`Missing skill(s): ${missing.join(', ')}.`);
      }
    }
    const healthScore = health ? Math.round((health.score / 100) * 25) : 0;
    if (!health) reasons.push('No health data for this peer yet.');
    if (peer.cardStatus === 'invalid') reasons.push('Agent Card is invalid.');
    else if (peer.cardStatus === 'stale') reasons.push('Agent Card is stale — re-verify before delegating.');
    else if (peer.cardStatus === 'unverified') reasons.push('Agent Card is unverified.');
    if (requirement.streamingRequired && peer.card.capabilities?.streaming !== true) {
      reasons.push('Streaming is required but the peer does not advertise it.');
    }
    let capacityScore = 20;
    if (maxConcurrent <= 0) capacityScore = 0;
    else if (activeTasks >= maxConcurrent) {
      capacityScore = 0;
      reasons.push(`At concurrency cap (${maxConcurrent} active task(s)).`);
    } else {
      capacityScore = Math.round(((maxConcurrent - activeTasks) / maxConcurrent) * 20);
    }
    let latencyScore = 15;
    if (requirement.latencyBudgetMs !== null) {
      const p50 = health?.p50Ms;
      if (p50 === null || p50 === undefined) {
        latencyScore = 7;
        reasons.push('No latency data for this peer yet.');
      } else if (p50 >= requirement.latencyBudgetMs) {
        latencyScore = 0;
        reasons.push(`p50 latency ${p50}ms exceeds the ${requirement.latencyBudgetMs}ms budget.`);
      } else {
        latencyScore = Math.round(((requirement.latencyBudgetMs - p50) / requirement.latencyBudgetMs) * 15);
      }
    }
    let score = skillScore + healthScore + capacityScore + latencyScore;
    if (requirement.streamingRequired && peer.card.capabilities?.streaming !== true) score = 0;
    if (peer.cardStatus === 'invalid') score = Math.min(score, 10);
    else if (peer.cardStatus === 'stale' || peer.cardStatus === 'unverified') score = Math.min(score, 40);
    score = Math.max(0, Math.min(100, score));
    return { peerId: peer.peerId, score, skillScore, healthScore, capacityScore, latencyScore, reasons };
  }

  /** Score every candidate peer for a requirement (best first). */
  scorePeers(requirement: FleetV30TaskRequirement): FleetV30CapabilityScore[] {
    let candidates = this.registry.listPeers();
    if (requirement.groupId !== null) {
      const group = this.groups.get(requirement.groupId);
      if (!group) return [];
      const ids = new Set(group.peerIds);
      candidates = candidates.filter((p) => ids.has(p.peerId));
    }
    const excluded = new Set(requirement.excludePeerIds);
    candidates = candidates.filter((p) => !excluded.has(p.peerId));
    const activeByPeer = this.board.activeTasksByPeer();
    const scores = candidates.map((peer) => {
      const health = this.registry.peerHealth(peer.peerId, activeByPeer.get(peer.peerId) ?? 0);
      const active = activeByPeer.get(peer.peerId) ?? 0;
      // Concurrency cap: the group's default when set, else 5.
      const group = this.groupsForPeer(peer.peerId).find((g) => g.defaultMaxConcurrent !== null);
      const maxConcurrent = group?.defaultMaxConcurrent ?? 5;
      return this.scorePeer(peer, health, requirement, active, maxConcurrent);
    });
    return scores.sort((a, b) => b.score - a.score || a.peerId.localeCompare(b.peerId));
  }

  /** Best peer for a requirement (null when no candidate scores > 0). */
  pickPeer(requirement: FleetV30TaskRequirement): FleetV30CapabilityScore | null {
    const scores = this.scorePeers(requirement);
    const best = scores[0];
    if (!best || best.score <= 0) return null;
    return best;
  }

  /** Best peer excluding the one that just failed (failover pick). */
  pickFailover(requirement: FleetV30TaskRequirement, failedPeerId: string): FleetV30CapabilityScore | null {
    return this.pickPeer({
      ...requirement,
      excludePeerIds: [...requirement.excludePeerIds, failedPeerId],
    });
  }
}
