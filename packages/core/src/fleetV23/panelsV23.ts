/**
 * Panels v23 — view-model cho UI fleet v23 (v1.36, Đội T6).
 *
 * Theo pattern `fleetV22/panelsV22.ts`: module thuần, chỉ biến state
 * core thành dữ liệu hiển thị (JSON-able, đã làm tròn, có chuỗi tóm
 * tắt) — không tự render, không đọc i18n trực tiếp (UI dùng key
 * `fleet.v23.*`). Dashboard tổng hợp gộp 4 mảng: topology, scheduler,
 * placement, rebalance.
 */

import type { FleetV23Imbalance } from './rebalanceV2';
import type { FleetV23PlacementEvaluation } from './placementV2';
import type { FleetV23Job } from './schedulerV2';
import { checkFleetV23Sla, snapshotFleetV23Queue } from './schedulerV2';
import type { FleetV23Topology } from './topology';
import { summarizeFleetV23Topology } from './topology';

/** View-model topology: zone/group + cảnh báo spread. */
export interface FleetV23TopologyPanel {
  zones: { id: string; region: string; name: string; nodes: number }[];
  groups: {
    id: string;
    name: string;
    bots: number;
    spreadMinZones: number;
    quorum: number;
    affinityPairs: number;
    antiAffinityPairs: number;
  }[];
  summary: ReturnType<typeof summarizeFleetV23Topology>;
}

/** Build panel topology từ topology + số node mỗi zone. */
export function buildFleetV23TopologyPanel(
  topology: FleetV23Topology,
  nodeCountByZone: ReadonlyMap<string, number> | Record<string, number>,
): FleetV23TopologyPanel {
  const countFor = (zoneId: string): number =>
    nodeCountByZone instanceof Map ? (nodeCountByZone.get(zoneId) ?? 0) : ((nodeCountByZone as Record<string, number>)[zoneId] ?? 0);
  return {
    zones: topology.zones.map((z) => ({ id: z.id, region: z.region, name: z.name, nodes: countFor(z.id) })),
    groups: topology.groups.map((g) => ({
      id: g.id,
      name: g.name,
      bots: g.botIds.length,
      spreadMinZones: g.spreadMinZones,
      quorum: g.quorum,
      affinityPairs: g.affinityPairs.length,
      antiAffinityPairs: g.antiAffinityPairs.length,
    })),
    summary: summarizeFleetV23Topology(topology),
  };
}

/** View-model hàng đợi scheduler: job chờ/chạy + SLA. */
export interface FleetV23SchedulerPanel {
  total: number;
  queued: number;
  running: number;
  preempted: number;
  completed: number;
  failed: number;
  cancelled: number;
  byPriorityQueued: Record<string, number>;
  breachedSlaIds: string[];
  longestWaitingJobId: string | null;
  longestWaitMs: number;
  /** Job queued tiếp theo (để UI hiện "sắp chạy"). */
  nextJob: { id: string; botId: string; title: string; priority: string; waitedMs: number } | null;
  /** Job đang chạy (tối đa 10, sắp theo thời gian bắt đầu). */
  runningJobs: { id: string; botId: string; title: string; priority: string; runningMs: number }[];
}

/** Build panel scheduler từ danh sách job. */
export function buildFleetV23SchedulerPanel(jobs: readonly FleetV23Job[], now: number = Date.now()): FleetV23SchedulerPanel {
  const snapshot = snapshotFleetV23Queue(jobs, now);
  const queued = jobs
    .filter((j) => j.status === 'queued')
    .sort((a, b) => a.submittedAt - b.submittedAt);
  const next = queued.length > 0 ? queued[0] : undefined;
  const runningJobs = jobs
    .filter((j) => j.status === 'running')
    .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))
    .slice(0, 10)
    .map((j) => ({
      id: j.id,
      botId: j.botId,
      title: j.title,
      priority: j.priority,
      runningMs: Math.max(0, now - (j.startedAt ?? now)),
    }));
  return {
    ...snapshot,
    nextJob: next
      ? {
          id: next.id,
          botId: next.botId,
          title: next.title,
          priority: next.priority,
          waitedMs: Math.max(0, now - next.submittedAt),
        }
      : null,
    runningJobs,
  };
}

/** View-model placement: node tốt nhất + frontier + từ chối. */
export interface FleetV23PlacementPanel {
  botId: string;
  placed: boolean;
  nodeId: string | null;
  score: number | null;
  ranked: { nodeId: string; score: number; costPerHour: number; onParetoFrontier: boolean }[];
  paretoFrontier: string[];
  rejectedCount: number;
  rejectedReasons: { nodeId: string; reasons: string[] }[];
  summary: string;
}

/** Build panel placement từ kết quả chấm. */
export function buildFleetV23PlacementPanel(evaluation: FleetV23PlacementEvaluation): FleetV23PlacementPanel {
  const best = evaluation.ranked[0];
  return {
    botId: evaluation.request.botId,
    placed: best !== undefined,
    nodeId: best?.nodeId ?? null,
    score: best?.score ?? null,
    ranked: evaluation.ranked.map((s) => ({
      nodeId: s.nodeId,
      score: s.score,
      costPerHour: s.estimatedCostPerHour,
      onParetoFrontier: s.onParetoFrontier,
    })),
    paretoFrontier: evaluation.ranked.filter((s) => s.onParetoFrontier).map((s) => s.nodeId),
    rejectedCount: evaluation.rejected.length,
    rejectedReasons: evaluation.rejected,
    summary:
      best !== undefined
        ? `Bot "${evaluation.request.botId}" → node "${best.nodeId}" (điểm ${best.score}/100, $${best.estimatedCostPerHour}/giờ).`
        : `Không đặt được bot "${evaluation.request.botId}" — ${evaluation.rejected.length} node đều bị loại.`,
  };
}

/** View-model rebalance: lệch tải + kế hoạch + lần chạy gần nhất. */
export interface FleetV23RebalancePanel {
  imbalance: FleetV23Imbalance;
  plannedMoves: number;
  lastExecution: {
    planId: string;
    success: boolean;
    appliedMoves: number;
    rolledBackMoves: number;
    failedNote: string | null;
  } | null;
  alerts: string[];
}

/** Build panel rebalance từ độ lệch + kế hoạch + lần thực thi gần nhất. */
export function buildFleetV23RebalancePanel(input: {
  imbalance: FleetV23Imbalance;
  plannedMoves: number;
  lastExecution?: {
    planId: string;
    success: boolean;
    appliedMoves: { botId: string }[];
    rolledBackMoves: { botId: string }[];
    failedMove: { note: string } | null;
  } | null;
}): FleetV23RebalancePanel {
  const alerts: string[] = [];
  if (input.imbalance.needsRebalance) alerts.push(input.imbalance.reason);
  const last = input.lastExecution;
  if (last && !last.success) {
    alerts.push(`Rebalance "${last.planId}" lỗi: ${last.failedMove?.note ?? 'không rõ lý do'} — đã rollback ${last.rolledBackMoves.length} move.`);
  }
  return {
    imbalance: input.imbalance,
    plannedMoves: input.plannedMoves,
    lastExecution: last
      ? {
          planId: last.planId,
          success: last.success,
          appliedMoves: last.appliedMoves.length,
          rolledBackMoves: last.rolledBackMoves.length,
          failedNote: last.failedMove?.note ?? null,
        }
      : null,
    alerts,
  };
}

/** View-model dispatch: job gán được / hoãn + chi phí. */
export interface FleetV23DispatchPanel {
  planId: string;
  assigned: number;
  deferred: number;
  totalCostPerHour: number;
  assignments: { jobId: string; botId: string; nodeId: string; score: number }[];
  deferredJobs: { jobId: string; botId: string; reason: string }[];
  topDeferralReason: string | null;
  dryRun: boolean;
  summary: string;
}

/** Build panel dispatch từ kế hoạch dispatch. */
export function buildFleetV23DispatchPanel(plan: {
  id: string;
  assignments: { jobId: string; botId: string; nodeId: string; score: number; estimatedCostPerHour: number }[];
  deferred: { jobId: string; botId: string; reason: string }[];
  dryRun: boolean;
}): FleetV23DispatchPanel {
  const totalCostPerHour =
    Math.round(plan.assignments.reduce((s, a) => s + a.estimatedCostPerHour, 0) * 10000) / 10000;
  const reasonCounts = new Map<string, number>();
  for (const d of plan.deferred) reasonCounts.set(d.reason, (reasonCounts.get(d.reason) ?? 0) + 1);
  const top = [...reasonCounts.entries()].sort((a, b) => b[1] - a[1])[0];
  return {
    planId: plan.id,
    assigned: plan.assignments.length,
    deferred: plan.deferred.length,
    totalCostPerHour,
    assignments: plan.assignments.map((a) => ({ jobId: a.jobId, botId: a.botId, nodeId: a.nodeId, score: a.score })),
    deferredJobs: plan.deferred,
    topDeferralReason: top ? `${top[0]} (${top[1]} job)` : null,
    dryRun: plan.dryRun,
    summary:
      plan.assignments.length === 0 && plan.deferred.length === 0
        ? 'Hàng đợi rỗng — không có job nào để dispatch.'
        : `Dispatch "${plan.id}": gán ${plan.assignments.length} job, hoãn ${plan.deferred.length} job ($${totalCostPerHour}/giờ)${plan.dryRun ? ' [dry-run]' : ''}.`,
  };
}

/** View-model autoscale: đề xuất + chi phí. */export interface FleetV23AutoscalePanel {
  action: string;
  nodesDelta: number;
  reason: string;
  triggeredBy: string[];
  monthlyCostDelta: number;
  cooldownRemainingMs: number;
  summary: string;
}

/** Build panel autoscale từ đề xuất. */
export function buildFleetV23AutoscalePanel(recommendation: {
  action: string;
  nodesDelta: number;
  reason: string;
  triggeredBy: string[];
  monthlyCostDelta: number;
  cooldownRemainingMs: number;
}): FleetV23AutoscalePanel {
  return {
    ...recommendation,
    summary:
      recommendation.action === 'none'
        ? `Không cần scale: ${recommendation.reason}`
        : `${recommendation.action === 'scale-out' ? 'Thêm' : 'Bớt'} ${Math.abs(recommendation.nodesDelta)} node (${recommendation.monthlyCostDelta >= 0 ? '+' : ''}$${recommendation.monthlyCostDelta}/tháng): ${recommendation.reason}`,
  };
}

/** View-model health: điểm từng node + rollup fleet + alert. */
export interface FleetV23HealthPanel {
  meanScore: number | null;
  byStatus: Record<string, number>;
  worstNodeId: string | null;
  degradedZones: string[];
  groupsAtRisk: string[];
  hasIncident: boolean;
  nodes: { nodeId: string; zoneId: string | null; score: number; status: string; reason: string }[];
  alerts: { severity: string; kind: string; targetId: string; message: string }[];
  trend: string;
  summary: string;
}

/** Build panel health từ điểm node + rollup + alert + xu hướng. */
export function buildFleetV23HealthPanel(input: {
  nodeHealth: { nodeId: string; zoneId: string | null; score: number; status: string; reason: string }[];
  fleetHealth: {
    meanScore: number | null;
    byStatus: Record<string, number>;
    worstNodeId: string | null;
    degradedZones: string[];
    groupsAtRisk: string[];
    hasIncident: boolean;
    summary: string;
  };
  alerts: { severity: string; kind: string; targetId: string; message: string }[];
  trend: string;
}): FleetV23HealthPanel {
  return {
    meanScore: input.fleetHealth.meanScore,
    byStatus: input.fleetHealth.byStatus,
    worstNodeId: input.fleetHealth.worstNodeId,
    degradedZones: input.fleetHealth.degradedZones,
    groupsAtRisk: input.fleetHealth.groupsAtRisk,
    hasIncident: input.fleetHealth.hasIncident,
    nodes: input.nodeHealth,
    alerts: input.alerts,
    trend: input.trend,
    summary: `${input.fleetHealth.summary} Xu hướng: ${input.trend}.`,
  };
}

/** Dashboard tổng hợp fleet v23. */
export interface FleetV23Dashboard {
  topology: FleetV23TopologyPanel;
  scheduler: FleetV23SchedulerPanel;
  placement: FleetV23PlacementPanel | null;
  rebalance: FleetV23RebalancePanel;
  /** Dispatch gần nhất (null khi chưa dispatch lần nào). */
  dispatch?: FleetV23DispatchPanel | null;
  /** Đề xuất autoscale gần nhất (null khi chưa tính lần nào). */
  autoscale?: FleetV23AutoscalePanel | null;
  /** Sức khoẻ fleet gần nhất (null khi chưa chấm lần nào). */
  health?: FleetV23HealthPanel | null;
  /** Cảnh báo gộp (mới nhất / quan trọng nhất trước). */
  alerts: string[];
}

/** Build dashboard tổng hợp từ 4 panel (placement null khi chưa chấm lần nào). */
export function buildFleetV23Dashboard(input: {
  topology: FleetV23TopologyPanel;
  scheduler: FleetV23SchedulerPanel;
  placement?: FleetV23PlacementPanel | null;
  rebalance: FleetV23RebalancePanel;
  dispatch?: FleetV23DispatchPanel | null;
  autoscale?: FleetV23AutoscalePanel | null;
  health?: FleetV23HealthPanel | null;
}): FleetV23Dashboard {
  const alerts: string[] = [];
  if (input.scheduler.breachedSlaIds.length > 0) {
    alerts.push(`${input.scheduler.breachedSlaIds.length} job quá SLA: ${input.scheduler.breachedSlaIds.join(', ')}.`);
  }
  alerts.push(...input.rebalance.alerts);
  if (input.topology.summary.zones < 2) {
    alerts.push('Fleet chỉ có dưới 2 zone — một zone chết có thể mất cả fleet (thêm zone để có spread).');
  }
  if (input.dispatch && input.dispatch.deferred > 0) {
    alerts.push(`Dispatch hoãn ${input.dispatch.deferred} job${input.dispatch.topDeferralReason ? ` — lý do lớn nhất: ${input.dispatch.topDeferralReason}` : ''}.`);
  }
  if (input.autoscale && input.autoscale.action === 'scale-out') {
    alerts.push(`Autoscale đề xuất thêm node: ${input.autoscale.reason}`);
  }
  if (input.health && input.health.hasIncident) {
    alerts.push(`Fleet có incident sức khoẻ: ${input.health.summary}`);
  }
  return {
    topology: input.topology,
    scheduler: input.scheduler,
    placement: input.placement ?? null,
    rebalance: input.rebalance,
    dispatch: input.dispatch ?? null,
    autoscale: input.autoscale ?? null,
    health: input.health ?? null,
    alerts,
  };
}

/** Job nào trong panel scheduler đã breach SLA (tiện cho UI tô đỏ). */
export function schedulerPanelBreachedJobs(jobs: readonly FleetV23Job[], now: number = Date.now()): string[] {
  return jobs
    .filter((j) => j.status === 'queued' && checkFleetV23Sla(j, now).breached)
    .map((j) => j.id);
}
