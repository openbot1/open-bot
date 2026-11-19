/**
 * Fleet v29 panels — view-models for the desktop A2A task board
 * (v1.42, Team T6).
 *
 * Pure functions: each builds the view a desktop panel renders from
 * the fleet v29 stores (peer registry, task board, allowlist, audit
 * log, confirmation queue, health rollup). Panels never see prompt
 * text, message parts, or secret values — board titles are short
 * human labels, audit details are ids + states, and peer cards
 * carry no credentials.
 *
 * The combined dashboard joins all five areas so the host can
 * render one screen: health summary + alerts, board summary +
 * awaiting-input tasks, peer health sorted best-first, allowlist
 * status (including allowlisted-but-unverified peers, whose
 * delegation is blocked), pending confirmations, and audit counts.
 */

import type { FleetV29Allowlist } from './allowlist';
import type { FleetV29AuditLog } from './auditLog';
import type { FleetV29PeerRegistry } from './peerRegistry';
import type { FleetV29ConfirmationQueue } from './sensitiveConfirm';
import type { FleetV29TaskBoard } from './taskBoard';
import { buildFleetV29HealthSummary, fleetV29HealthAlerts, listFleetV29PeerHealth } from './health';
import type {
  FleetV29AuditEntry,
  FleetV29BoardTask,
  FleetV29Confirmation,
  FleetV29HealthSummary,
  FleetV29Peer,
  FleetV29PeerHealth,
} from './types';

export interface FleetV29BoardPanelView {
  summary: string;
  transportWired: boolean;
  totalTasks: number;
  activeTasks: number;
  awaitingInput: number;
  countsByState: Record<string, number>;
  tasks: FleetV29BoardTask[];
  nextCursor: string | null;
}

export interface FleetV29PeerPanelView {
  summary: string;
  peers: FleetV29Peer[];
  health: FleetV29PeerHealth[];
  verifiedCount: number;
  unverifiedCount: number;
}

export interface FleetV29AllowlistPanelView {
  summary: string;
  entries: Array<{
    peerId: string;
    addedBy: string;
    addedAt: string;
    expiresAt: string | null;
    reason: string;
    suspended: boolean;
    expired: boolean;
    cardStatus: FleetV29Peer['cardStatus'];
    allowedSkills: string[];
    allowedOperations: string[];
    maxCostUsdPerTask: number | null;
    maxConcurrentTasks: number;
    sensitiveActionsAllowed: string[];
  }>;
  activeCount: number;
  suspendedCount: number;
  expiredCount: number;
}

export interface FleetV29AuditPanelView {
  summary: string;
  entries: FleetV29AuditEntry[];
  total: number;
  chainOk: boolean;
  brokenSeq: number | null;
  countsByKind: Record<string, number>;
}

export interface FleetV29ConfirmPanelView {
  summary: string;
  pending: FleetV29Confirmation[];
  decided: FleetV29Confirmation[];
}

export interface FleetV29DashboardView {
  summary: string;
  health: FleetV29HealthSummary;
  alerts: string[];
  board: FleetV29BoardPanelView;
  peers: FleetV29PeerPanelView;
  allowlist: FleetV29AllowlistPanelView;
  audit: FleetV29AuditPanelView;
  confirmations: FleetV29ConfirmPanelView;
}

export interface FleetV29PanelDeps {
  registry: FleetV29PeerRegistry;
  board: FleetV29TaskBoard;
  allowlist: FleetV29Allowlist;
  audit: FleetV29AuditLog;
  confirmations: FleetV29ConfirmationQueue;
  nowIso?: () => string;
}

/** Board panel: active tasks first, then the newest page. */
export function buildFleetV29BoardPanel(
  board: FleetV29TaskBoard,
  options?: { peerId?: string; state?: FleetV29BoardTask['task']['status']['state']; pageSize?: number; cursor?: string | null },
): FleetV29BoardPanelView {
  const page = board.listTasks(
    {
      ...(options?.peerId !== undefined ? { peerId: options.peerId } : {}),
      ...(options?.state !== undefined ? { state: options.state } : {}),
    },
    options?.cursor ?? null,
    options?.pageSize ?? 20,
  );
  const counts = board.countsByState();
  const active = Object.entries(counts)
    .filter(([state]) => !['completed', 'failed', 'cancelled', 'rejected'].includes(state))
    .reduce((sum, [, n]) => sum + n, 0);
  return {
    summary: board.transportWired
      ? 'Live A2A task board — tasks delegated to real peers over A2A v1.0.'
      : 'Local-simulation task board — no A2A transport wired yet; tasks are simulated and labelled as such.',
    transportWired: board.transportWired,
    totalTasks: board.taskCount(),
    activeTasks: active,
    awaitingInput: counts['input-required'] ?? 0,
    countsByState: counts,
    tasks: page.tasks,
    nextCursor: page.nextCursor,
  };
}

/** Peer registry panel: peers + health, verified counts. */
export function buildFleetV29PeerPanel(
  registry: FleetV29PeerRegistry,
  board: FleetV29TaskBoard,
): FleetV29PeerPanelView {
  const peers = registry.listPeers();
  const health = listFleetV29PeerHealth({ registry, board });
  return {
    summary: `${peers.length} registered peer(s).`,
    peers,
    health,
    verifiedCount: peers.filter((p) => p.cardStatus === 'verified').length,
    unverifiedCount: peers.filter((p) => p.cardStatus !== 'verified').length,
  };
}

/** Allowlist admin panel: entries joined with peer card status. */
export function buildFleetV29AllowlistPanel(
  allowlist: FleetV29Allowlist,
  registry: FleetV29PeerRegistry,
  nowIso?: string,
): FleetV29AllowlistPanelView {
  const now = nowIso ?? new Date().toISOString();
  const entries = allowlist.list().map((entry) => {
    const peer = registry.getPeer(entry.peerId);
    return {
      peerId: entry.peerId,
      addedBy: entry.addedBy,
      addedAt: entry.addedAt,
      expiresAt: entry.expiresAt,
      reason: entry.reason,
      suspended: entry.suspended,
      expired: entry.expiresAt !== null && now >= entry.expiresAt,
      cardStatus: peer?.cardStatus ?? 'unverified',
      allowedSkills: entry.scope.allowedSkills,
      allowedOperations: entry.scope.allowedOperations,
      maxCostUsdPerTask: entry.scope.maxCostUsdPerTask,
      maxConcurrentTasks: entry.scope.maxConcurrentTasks,
      sensitiveActionsAllowed: entry.scope.sensitiveActionsAllowed,
    };
  });
  return {
    summary: `${allowlist.activeCount(now)} active allowlist entr(ies) of ${allowlist.count()} total.`,
    entries,
    activeCount: allowlist.activeCount(now),
    suspendedCount: entries.filter((e) => e.suspended).length,
    expiredCount: entries.filter((e) => e.expired).length,
  };
}

/** Audit panel: latest entries + hash-chain verification. */
export function buildFleetV29AuditPanel(audit: FleetV29AuditLog, limit = 100): FleetV29AuditPanelView {
  const chain = audit.verifyChain();
  return {
    summary: `${audit.count()} audit entr(ies); hash chain ${chain.ok ? 'intact' : `broken at seq ${'brokenSeq' in chain ? chain.brokenSeq : '?'}`}.`,
    entries: audit.query({ limit }),
    total: audit.count(),
    chainOk: chain.ok,
    brokenSeq: chain.ok ? null : chain.brokenSeq,
    countsByKind: audit.countsByKind(),
  };
}

/** Confirmation panel: pending first, then recently decided. */
export function buildFleetV29ConfirmPanel(queue: FleetV29ConfirmationQueue): FleetV29ConfirmPanelView {
  const pending = queue.pending();
  const decided = queue.list().filter((r) => r.status !== 'pending').slice(0, 20);
  return {
    summary: `${pending.length} sensitive action(s) awaiting your confirmation.`,
    pending,
    decided,
  };
}

/** Combined dashboard joining all five areas. */
export function buildFleetV29Dashboard(deps: FleetV29PanelDeps): FleetV29DashboardView {
  const now = deps.nowIso?.() ?? new Date().toISOString();
  const health = buildFleetV29HealthSummary({
    registry: deps.registry,
    board: deps.board,
    allowlist: deps.allowlist,
    pendingConfirmations: deps.confirmations.pendingCount(),
    nowIso: () => now,
  });
  return {
    summary: `Fleet v29 — ${health.peersTotal} peer(s), ${health.tasksActive} active task(s), $${health.totalCostUsd.toFixed(4)} total cost.`,
    health,
    alerts: fleetV29HealthAlerts(health),
    board: buildFleetV29BoardPanel(deps.board),
    peers: buildFleetV29PeerPanel(deps.registry, deps.board),
    allowlist: buildFleetV29AllowlistPanel(deps.allowlist, deps.registry, now),
    audit: buildFleetV29AuditPanel(deps.audit),
    confirmations: buildFleetV29ConfirmPanel(deps.confirmations),
  };
}
