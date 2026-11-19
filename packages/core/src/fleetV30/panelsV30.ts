/**
 * Fleet v30 panels — view-models for the desktop fleet v30 screens
 * (v1.44, Team T6).
 *
 * Pure functions: each builds the view a desktop panel renders from
 * the fleet v30 stores (isolation manager, board v2, peer groups,
 * admin policy) joined with the v29 stores they sit on. Panels
 * never see prompt text, message parts, or secret values — board
 * titles are short human labels, audit details are ids + states,
 * and peer cards carry no credentials.
 *
 * The combined dashboard joins all four areas so the host can
 * render one screen: isolation bindings + resource usage, board v2
 * (kanban + overdue + escalated), peer groups + capability picks,
 * and admin policy (rules, pending approvals, recent pre-flight
 * denials).
 */

import type { FleetV29Allowlist } from '../fleetV29/allowlist';
import type { FleetV29PeerRegistry } from '../fleetV29/peerRegistry';
import type { FleetV29TaskBoard } from '../fleetV29/taskBoard';
import type { FleetV30AdminPolicy } from './adminPolicy';
import type { FleetV30BoardV2 } from './boardV2';
import type { FleetV30IsolationManager } from './isolation';
import type { FleetV30PeerGroups } from './peerGroups';
import type { FleetV30ProfileQuotas } from './quotas';
import type {
  FleetV30AdminEvent,
  FleetV30ApprovalRequest,
  FleetV30BoardTaskView,
  FleetV30BoardView,
  FleetV30CapabilityScore,
  FleetV30IsolationBinding,
  FleetV30KanbanColumn,
  FleetV30PeerGroup,
  FleetV30PolicyRule,
} from './types';

export interface FleetV30IsolationPanelView {
  summary: string;
  bindings: FleetV30IsolationBinding[];
  active: number;
  suspended: number;
  cleaned: number;
  unisolated: number;
  usage: { cpuCores: number; ramMB: number; diskMB: number };
  drivers: string[];
}

export interface FleetV30BoardV2PanelView {
  summary: string;
  kanban: Array<{ column: FleetV30KanbanColumn; tasks: FleetV30BoardTaskView[] }>;
  overdue: FleetV30BoardTaskView[];
  escalated: FleetV30BoardTaskView[];
  ready: FleetV30BoardTaskView[];
  blocked: FleetV30BoardTaskView[];
  countsByPriority: Record<string, number>;
  countsByState: Record<string, number>;
  views: FleetV30BoardView[];
}

export interface FleetV30PeerGroupsPanelView {
  summary: string;
  groups: Array<{
    group: FleetV30PeerGroup;
    peers: Array<{ peerId: string; cardStatus: string; reachable: boolean; healthScore: number | null }>;
  }>;
  ungrouped: string[];
  lastProbes: Array<{ peerId: string; reachable: boolean; latencyMs: number | null; at: string }>;
}

export interface FleetV30AdminPanelView {
  summary: string;
  admins: Array<{ userId: string; role: string }>;
  rules: FleetV30PolicyRule[];
  pendingApprovals: FleetV30ApprovalRequest[];
  recentDenials: FleetV30AdminEvent[];
  countsByKind: Record<string, number>;
}

export interface FleetV30QuotasPanelView {
  summary: string;
  quotas: Array<{
    profileId: string;
    maxBindings: number | null;
    maxCpuCores: number | null;
    maxRamMB: number | null;
    maxDiskMB: number | null;
    bindings: number;
    cpuCores: number;
    ramMB: number;
    diskMB: number;
    overQuota: string[];
  }>;
  overQuotaProfiles: string[];
}

export interface FleetV30DashboardView {
  summary: string;
  isolation: FleetV30IsolationPanelView;
  board: FleetV30BoardV2PanelView;
  groups: FleetV30PeerGroupsPanelView;
  admin: FleetV30AdminPanelView;
  quotas: FleetV30QuotasPanelView;
}

export interface FleetV30PanelDeps {
  isolation: FleetV30IsolationManager;
  boardV2: FleetV30BoardV2;
  board: FleetV29TaskBoard;
  groups: FleetV30PeerGroups;
  admin: FleetV30AdminPolicy;
  registry: FleetV29PeerRegistry;
  allowlist: FleetV29Allowlist;
  /** Optional quotas store (dashboard shows quotas only when wired). */
  quotas?: FleetV30ProfileQuotas;
}

/** Isolation panel: bindings + usage + unisolated warnings. */
export function buildFleetV30IsolationPanel(
  isolation: FleetV30IsolationManager,
): FleetV30IsolationPanelView {
  const bindings = isolation.listBindings();
  const usage = isolation.aggregateUsage();
  const unisolated = bindings.filter((b) => b.status === 'active' && !b.isolated).length;
  const drivers = [...new Set(bindings.filter((b) => b.status === 'active').map((b) => b.driverKind))];
  return {
    summary:
      `${usage.active} active isolation binding(s), ${usage.suspended} suspended, ${usage.cleaned} cleaned.` +
      (unisolated > 0 ? ` ${unisolated} active binding(s) run WITHOUT isolation (local driver).` : ''),
    bindings,
    active: usage.active,
    suspended: usage.suspended,
    cleaned: usage.cleaned,
    unisolated,
    usage: { cpuCores: usage.cpuCores, ramMB: usage.ramMB, diskMB: usage.diskMB },
    drivers,
  };
}

/** Board v2 panel: kanban + overdue + escalated + ready + blocked. */
export function buildFleetV30BoardV2Panel(boardV2: FleetV30BoardV2): FleetV30BoardV2PanelView {
  const kanban = boardV2.kanbanBoard();
  const all = kanban.flatMap((c) => c.tasks);
  const overdue = all.filter((t) => t.slaState === 'overdue');
  const escalated = all.filter((t) => t.meta.escalated);
  const ready = boardV2.readyTasks();
  const blocked = all.filter((t) => t.blocked);
  const countsByState: Record<string, number> = {};
  for (const t of all) {
    const state = t.boardTask.task.status.state;
    countsByState[state] = (countsByState[state] ?? 0) + 1;
  }
  return {
    summary: `${all.length} task(s) on board v2 — ${overdue.length} overdue, ${escalated.length} escalated, ${ready.length} ready to start.`,
    kanban,
    overdue,
    escalated,
    ready,
    blocked,
    countsByPriority: boardV2.countsByPriority(),
    countsByState,
    views: boardV2.listViews(),
  };
}

/** Peer groups panel: groups with member health + ungrouped peers. */
export function buildFleetV30PeerGroupsPanel(
  groups: FleetV30PeerGroups,
  registry: FleetV29PeerRegistry,
  board: FleetV29TaskBoard,
): FleetV30PeerGroupsPanelView {
  const activeByPeer = board.activeTasksByPeer();
  const groupViews = groups.listGroups().map((group) => ({
    group,
    peers: groups.peersInGroup(group.groupId).map((peer) => {
      const health = registry.peerHealth(peer.peerId, activeByPeer.get(peer.peerId) ?? 0);
      return {
        peerId: peer.peerId,
        cardStatus: peer.cardStatus,
        reachable: peer.reachable,
        healthScore: health ? health.score : null,
      };
    }),
  }));
  const grouped = new Set(groupViews.flatMap((g) => g.group.peerIds));
  const ungrouped = registry.listPeers().filter((p) => !grouped.has(p.peerId)).map((p) => p.peerId);
  const lastProbes = [...groups.lastProbeByPeer().values()].map((p) => ({
    peerId: p.peerId,
    reachable: p.reachable,
    latencyMs: p.latencyMs,
    at: p.at,
  }));
  return {
    summary: `${groupViews.length} peer group(s), ${ungrouped.length} ungrouped peer(s).`,
    groups: groupViews,
    ungrouped,
    lastProbes,
  };
}

/** Admin panel: admins + rules + pending approvals + denials. */
export function buildFleetV30AdminPanel(admin: FleetV30AdminPolicy): FleetV30AdminPanelView {
  const pending = admin.listApprovals('pending');
  const denials = admin.listEvents(200).filter((e) => e.kind === 'preflight-denied').slice(-20);
  return {
    summary: `${admin.listAdmins().length} admin(s), ${admin.listRules().length} policy rule(s), ${pending.length} approval(s) pending.`,
    admins: admin.listAdmins().map((a) => ({ userId: a.userId, role: a.role })),
    rules: admin.listRules(),
    pendingApprovals: pending,
    recentDenials: denials,
    countsByKind: admin.countsByKind(),
  };
}

/** Best peer pick for a requirement (for the groups panel "suggest" button). */
export function buildFleetV30CapabilityPick(
  groups: FleetV30PeerGroups,
  requirement: Parameters<FleetV30PeerGroups['pickPeer']>[0],
): FleetV30CapabilityScore | null {
  return groups.pickPeer(requirement);
}

/** Quotas panel: per-profile quotas with live usage + over-quota flags. */
export function buildFleetV30QuotasPanel(
  quotas: FleetV30ProfileQuotas | undefined,
): FleetV30QuotasPanelView {
  if (!quotas) {
    return { summary: 'No per-profile quotas configured (uncapped).', quotas: [], overQuotaProfiles: [] };
  }
  const rows = quotas.listQuotas().map((quota) => {
    const usage = quotas.usageFor(quota.profileId);
    return {
      profileId: quota.profileId,
      maxBindings: quota.maxBindings,
      maxCpuCores: quota.maxCpuCores,
      maxRamMB: quota.maxRamMB,
      maxDiskMB: quota.maxDiskMB,
      bindings: usage.bindings,
      cpuCores: usage.cpuCores,
      ramMB: usage.ramMB,
      diskMB: usage.diskMB,
      overQuota: usage.overQuota,
    };
  });
  const over = rows.filter((r) => r.overQuota.length > 0).map((r) => r.profileId);
  return {
    summary:
      `${rows.length} profile quota(s)` +
      (over.length > 0 ? ` — ${over.length} profile(s) over quota: ${over.join(', ')}.` : ', all within quota.'),
    quotas: rows,
    overQuotaProfiles: over,
  };
}

/** Combined dashboard joining all four v30 areas. */
export function buildFleetV30Dashboard(deps: FleetV30PanelDeps): FleetV30DashboardView {
  const isolation = buildFleetV30IsolationPanel(deps.isolation);
  const board = buildFleetV30BoardV2Panel(deps.boardV2);
  const groups = buildFleetV30PeerGroupsPanel(deps.groups, deps.registry, deps.board);
  const admin = buildFleetV30AdminPanel(deps.admin);
  const quotas = buildFleetV30QuotasPanel(deps.quotas);
  return {
    summary:
      `Fleet v30 — ${isolation.active} isolated conversation(s)` +
      ` (${isolation.unisolated} unisolated), ${board.kanban.flatMap((c) => c.tasks).length} board task(s)` +
      ` (${board.overdue.length} overdue), ${groups.groups.length} peer group(s), ${admin.pendingApprovals.length} approval(s) pending` +
      (quotas.overQuotaProfiles.length > 0 ? `, ${quotas.overQuotaProfiles.length} profile(s) over quota.` : '.'),
    isolation,
    board,
    groups,
    admin,
    quotas,
  };
}
