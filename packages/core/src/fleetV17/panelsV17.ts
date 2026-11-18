/**
 * Admin panels v3 — view-model cho admin panels: dashboard tổng
 * quan fleet + tenant, quản lý quota, quản lý rollout (v1.20, Đội T6).
 *
 * Tầng trên của panels v16 (`fleetV16/panelsV16.ts` — user panel,
 * quota panel tenant v16, system config, gateway panel, audit
 * panel, admin panel tổng hợp) và các module v17: fleet v17
 * (health/capacity/drain/auto-scale), tenant quotas v2 (soft/hard
 * + override audit), gateway rate limit v2 (token bucket + load
 * sim), audit log UI v3 (filter/timeline), rollout v6 (staged by
 * user group, auto-rollback, history), sub-agent visualizer.
 * V16 trả lời "xem từng mảng riêng"; v17 trả lời 3 câu quản trị
 * tổng hợp:
 *
 * - DASHBOARD TỔNG QUAN: một panel gom fleet (node/health/
 *   capacity/bottleneck/headroom, scale decision gần nhất),
 *   tenant (số tenant, alert quota theo mức), gateway (bucket,
 *   kết quả load sim gần nhất), audit (tổng entry + critical
 *   trong khoảng), rollout (đang chạy / tạm dừng) — admin mở một
 *   màn hình là thấy toàn bộ sức khỏe hệ thống.
 * - QUẢN LÝ QUOTA: hàng quota v17 theo tenant (4 loại, đã dùng/
 *   còn lại, mức cảnh báo, enforcement mềm/cứng, override hay
 *   không) + lịch sử override gần nhất + cảnh báo sắp xếp theo
 *   mức độ — để admin đổi quota có căn cứ và thấy ai đã đổi.
 * - QUẢN LÝ ROLLOUT: hàng rollout v6 (stage hiện tại, %, trạng
 *   thái, dwell đã đủ chưa, action cuối + thời gian) + tóm tắt
 *   theo trạng thái + rollout nào cần chú ý (paused, rolled-back,
 *   sắp chạm ngưỡng lỗi) — để admin theo dõi triển khai mà không
 *   mở từng rollout.
 *
 * Theo pattern panels v15/v16: module chỉ xây VIEW-MODEL thuần
 * từ dữ liệu thật của các tầng dưới; component React render từ
 * đó. Không đọc file, không chạm mạng, không chứa mock.
 */

import type { FleetV17CapacitySummary, FleetV17HealthCheck, FleetV17ScaleDecision } from './fleetV17';
import type { FleetV17SubAgentMap } from './fleetSubAgentVisualizerV17';
import type { GatewayV17LoadResult } from './gatewayRateLimitV17';
import type { AuditV17Timeline } from './auditLogV17';
import type { TeamV17Rollout, TeamV17RolloutStore } from './rolloutV17';
import { summarizeTeamV17Rollout, summarizeTeamV17RolloutStore } from './rolloutV17';
import type { TenantV17Alert, TenantV17QuotaRow, TenantV17QuotaState } from './tenantQuotasV17';
import { listTenantV17OverrideAudit, summarizeTenantV17Quota, tenantV17Alerts } from './tenantQuotasV17';
import type { TenantV17OverrideAudit } from './tenantQuotasV17';

// ---------------------------------------------------------------------------
// Dashboard tổng quan
// ---------------------------------------------------------------------------

/** Một mục cảnh báo trên dashboard (để UI xếp theo mức độ). */
export interface FleetV17DashboardAlert {
  level: 'critical' | 'warning' | 'info';
  area: 'fleet' | 'quota' | 'gateway' | 'audit' | 'rollout';
  message: string;
}

/** Dashboard tổng quan fleet + tenant. */
export interface FleetV17DashboardPanel {
  at: number;
  fleet: {
    nodeCount: number;
    activeNodeCount: number;
    healthyNodeCount: number;
    degradedNodeCount: number;
    unhealthyNodeCount: number;
    downNodeCount: number;
    bottleneck: FleetV17CapacitySummary['bottleneck'];
    bottleneckUsage: number;
    mediumTasksHeadroom: number;
    freeCpuCores: number;
    freeRamMb: number;
    freeTaskSlots: number;
    runningTasks: number;
  };
  tenants: {
    tenantCount: number;
    alertCount: number;
    exceededCount: number;
    softExceededCount: number;
    topAlerts: TenantV17Alert[];
  };
  gateway: {
    bucketCount: number;
    lastLoadSim: GatewayV17LoadResult | null;
  };
  audit: {
    total: number;
    critical: number;
    warning: number;
    topActions: { action: string; count: number }[];
  };
  rollouts: {
    total: number;
    running: number;
    paused: number;
    rolledBack: number;
  };
  subAgents: {
    totalAgents: number;
    overloadedNodeCount: number;
    atRiskNodeCount: number;
    orphanAgents: number;
  };
  /** Scale decision gần nhất (null = chưa có rule nào ra quyết định). */
  lastScaleDecision: FleetV17ScaleDecision | null;
  /** Cảnh báo gom từ mọi mảng, xếp critical trước. */
  alerts: FleetV17DashboardAlert[];
}

/**
 * Xây dashboard tổng quan từ dữ liệu thật của các module v17.
 * `healthChecks` là kết quả `checkFleetV17Health`; `quotaState`
 * là state tenant quotas v2; `auditTimeline` là kết quả
 * `auditV17Timeline` của khoảng admin đang xem.
 */
export function buildFleetV17DashboardPanel(input: {
  capacity: FleetV17CapacitySummary;
  healthChecks: readonly FleetV17HealthCheck[];
  quotaState: TenantV17QuotaState;
  gatewayBucketCount: number;
  lastLoadSim?: GatewayV17LoadResult | null;
  auditTimeline: AuditV17Timeline;
  rolloutStore: TeamV17RolloutStore;
  subAgentMap: FleetV17SubAgentMap;
  lastScaleDecision?: FleetV17ScaleDecision | null;
  now?: number;
}): FleetV17DashboardPanel {
  const now = input.now ?? Date.now();
  const healthCounts = { healthy: 0, degraded: 0, unhealthy: 0, down: 0 };
  for (const h of input.healthChecks) healthCounts[h.health] += 1;
  const quotaAlerts = tenantV17Alerts(input.quotaState, now);
  const exceeded = quotaAlerts.filter((a) => a.level === 'exceeded');
  const softExceeded = quotaAlerts.filter((a) => a.level === 'soft-exceeded');
  const rolloutSummary = summarizeTeamV17RolloutStore(input.rolloutStore, now);
  const auditCritical = input.auditTimeline.buckets.reduce((s, b) => s + b.critical, 0);
  const auditWarning = input.auditTimeline.buckets.reduce((s, b) => s + b.warning, 0);
  const alerts: FleetV17DashboardAlert[] = [];
  if (healthCounts.down > 0) {
    alerts.push({ level: 'critical', area: 'fleet', message: `${healthCounts.down} node down` });
  }
  if (healthCounts.unhealthy > 0) {
    alerts.push({ level: 'warning', area: 'fleet', message: `${healthCounts.unhealthy} node unhealthy` });
  }
  if (input.capacity.bottleneck !== 'none' && input.capacity.bottleneckUsage >= 0.9) {
    alerts.push({
      level: 'warning', area: 'fleet',
      message: `nút thắt ${input.capacity.bottleneck} đã dùng ${(input.capacity.bottleneckUsage * 100).toFixed(0)}%`,
    });
  }
  for (const a of exceeded.slice(0, 3)) {
    alerts.push({ level: 'critical', area: 'quota', message: a.message });
  }
  for (const a of softExceeded.slice(0, 3)) {
    alerts.push({ level: 'warning', area: 'quota', message: a.message });
  }
  if (input.lastLoadSim && input.lastLoadSim.blockedRate >= 0.5) {
    alerts.push({
      level: 'warning', area: 'gateway',
      message: `load sim gần nhất chặn ${(input.lastLoadSim.blockedRate * 100).toFixed(0)}% lần gọi (${input.lastLoadSim.pattern})`,
    });
  }
  if (auditCritical > 0) {
    alerts.push({ level: 'critical', area: 'audit', message: `${auditCritical} audit entry critical trong khoảng đang xem` });
  }
  if (rolloutSummary.byStatus.paused > 0) {
    alerts.push({ level: 'warning', area: 'rollout', message: `${rolloutSummary.byStatus.paused} rollout đang tạm dừng` });
  }
  if (rolloutSummary.byStatus['rolled-back'] > 0) {
    alerts.push({ level: 'warning', area: 'rollout', message: `${rolloutSummary.byStatus['rolled-back']} rollout đã rollback` });
  }
  if (input.subAgentMap.summary.orphanAgents > 0) {
    alerts.push({ level: 'warning', area: 'fleet', message: `${input.subAgentMap.summary.orphanAgents} sub-agent mồ côi (cha đã mất)` });
  }
  const levelRank = { critical: 0, warning: 1, info: 2 };
  alerts.sort((a, b) => levelRank[a.level] - levelRank[b.level]);
  return {
    at: now,
    fleet: {
      nodeCount: input.capacity.nodeCount,
      activeNodeCount: input.capacity.activeNodeCount,
      healthyNodeCount: healthCounts.healthy,
      degradedNodeCount: healthCounts.degraded,
      unhealthyNodeCount: healthCounts.unhealthy,
      downNodeCount: healthCounts.down,
      bottleneck: input.capacity.bottleneck,
      bottleneckUsage: input.capacity.bottleneckUsage,
      mediumTasksHeadroom: input.capacity.mediumTasksHeadroom,
      freeCpuCores: input.capacity.freeCpuCores,
      freeRamMb: input.capacity.freeRamMb,
      freeTaskSlots: input.capacity.freeTaskSlots,
      runningTasks: input.capacity.runningTasks,
    },
    tenants: {
      tenantCount: input.quotaState.tenants.length,
      alertCount: quotaAlerts.length,
      exceededCount: exceeded.length,
      softExceededCount: softExceeded.length,
      topAlerts: quotaAlerts.slice(0, 5),
    },
    gateway: {
      bucketCount: input.gatewayBucketCount,
      lastLoadSim: input.lastLoadSim ?? null,
    },
    audit: {
      total: input.auditTimeline.total,
      critical: auditCritical,
      warning: auditWarning,
      topActions: input.auditTimeline.topActions,
    },
    rollouts: {
      total: rolloutSummary.total,
      running: rolloutSummary.byStatus.running,
      paused: rolloutSummary.byStatus.paused,
      rolledBack: rolloutSummary.byStatus['rolled-back'],
    },
    subAgents: {
      totalAgents: input.subAgentMap.summary.totalAgents,
      overloadedNodeCount: input.subAgentMap.summary.overloadedNodeCount,
      atRiskNodeCount: input.subAgentMap.summary.atRiskNodeCount,
      orphanAgents: input.subAgentMap.summary.orphanAgents,
    },
    lastScaleDecision: input.lastScaleDecision ?? null,
    alerts,
  };
}

// ---------------------------------------------------------------------------
// Quản lý quota
// ---------------------------------------------------------------------------

/** Một hàng tenant trong panel quản lý quota. */
export interface FleetV17QuotaPanelRow {
  tenantId: string;
  displayName: string;
  quotas: TenantV17QuotaRow[];
  /** Mức cảnh báo xấu nhất của tenant. */
  worstLevel: TenantV17QuotaRow['level'];
  overrideCount: number;
}

/** Panel quản lý quota v17. */
export interface FleetV17QuotaPanel {
  at: number;
  rows: FleetV17QuotaPanelRow[];
  alerts: TenantV17Alert[];
  /** Lịch sử override gần nhất (mới nhất trước). */
  recentOverrides: TenantV17OverrideAudit[];
}

/** Số override gần nhất hiển thị. */
export const FLEET_V17_QUOTA_PANEL_RECENT_OVERRIDES = 20;

/** Xây panel quản lý quota từ state tenant quotas v2. */
export function buildFleetV17QuotaPanel(
  quotaState: TenantV17QuotaState,
  now = Date.now(),
): FleetV17QuotaPanel {
  const levelRank: Record<TenantV17QuotaRow['level'], number> = {
    none: 0, watch: 1, warning: 2, critical: 3, exceeded: 4, 'soft-exceeded': 4,
  };
  const rows: FleetV17QuotaPanelRow[] = quotaState.tenants.map((tenant) => {
    const quotas = summarizeTenantV17Quota(tenant, now);
    const worst = quotas.reduce<TenantV17QuotaRow['level']>(
      (m, q) => (levelRank[q.level] > levelRank[m] ? q.level : m),
      'none',
    );
    return {
      tenantId: tenant.tenantId,
      displayName: tenant.displayName,
      quotas,
      worstLevel: worst,
      overrideCount: quotaState.overrideAudit.filter((a) => a.tenantId === tenant.tenantId).length,
    };
  });
  rows.sort((a, b) => levelRank[b.worstLevel] - levelRank[a.worstLevel] || a.tenantId.localeCompare(b.tenantId));
  const recentOverrides = [...quotaState.overrideAudit]
    .sort((a, b) => b.at - a.at || b.seq - a.seq)
    .slice(0, FLEET_V17_QUOTA_PANEL_RECENT_OVERRIDES);
  return { at: now, rows, alerts: tenantV17Alerts(quotaState, now), recentOverrides };
}

// ---------------------------------------------------------------------------
// Quản lý rollout
// ---------------------------------------------------------------------------

/** Một hàng rollout trong panel quản lý rollout. */
export interface FleetV17RolloutPanelRow {
  id: string;
  name: string;
  targetVersion: string;
  status: TeamV17Rollout['status'];
  currentStage: string | null;
  currentPercent: number;
  stageIndex: number;
  stageCount: number;
  dwellSatisfied: boolean;
  lastAction: string | null;
  lastActionAt: number | null;
  /** true = rollout cần chú ý (paused / rolled-back / chưa start lâu). */
  needsAttention: boolean;
}

/** Panel quản lý rollout v17. */
export interface FleetV17RolloutPanel {
  at: number;
  total: number;
  byStatus: Record<TeamV17Rollout['status'], number>;
  rows: FleetV17RolloutPanelRow[];
  running: FleetV17RolloutPanelRow[];
}

/** Xây panel quản lý rollout từ store rollout v6. */
export function buildFleetV17RolloutPanel(
  store: TeamV17RolloutStore,
  now = Date.now(),
): FleetV17RolloutPanel {
  const summary = summarizeTeamV17RolloutStore(store, now);
  const rows: FleetV17RolloutPanelRow[] = store.rollouts.map((rollout) => {
    const s = summarizeTeamV17Rollout(rollout, now);
    const needsAttention =
      rollout.status === 'paused' ||
      rollout.status === 'rolled-back' ||
      (rollout.status === 'draft' && now - rollout.createdAt > 24 * 60 * 60 * 1000);
    return {
      id: s.id,
      name: s.name,
      targetVersion: s.targetVersion,
      status: s.status,
      currentStage: s.currentStage,
      currentPercent: s.currentPercent,
      stageIndex: s.stageIndex,
      stageCount: s.stageCount,
      dwellSatisfied: s.dwellSatisfied,
      lastAction: s.lastAction,
      lastActionAt: s.lastActionAt,
      needsAttention,
    };
  });
  rows.sort((a, b) => {
    if (a.needsAttention !== b.needsAttention) return a.needsAttention ? -1 : 1;
    return (b.lastActionAt ?? 0) - (a.lastActionAt ?? 0);
  });
  return {
    at: now,
    total: summary.total,
    byStatus: summary.byStatus,
    rows,
    running: rows.filter((r) => r.status === 'running'),
  };
}

// ---------------------------------------------------------------------------
// Validate
// ---------------------------------------------------------------------------

/** Lỗi validate dashboard panel, '' = hợp lệ. */
export function validateFleetV17DashboardPanel(panel: FleetV17DashboardPanel): string {
  if (panel.fleet.nodeCount < panel.fleet.activeNodeCount) return 'nodeCount không được < activeNodeCount';
  if (panel.fleet.activeNodeCount < 0 || panel.fleet.nodeCount < 0) return 'số node phải >= 0';
  if (panel.tenants.tenantCount < 0) return 'tenantCount phải >= 0';
  if (panel.gateway.bucketCount < 0) return 'bucketCount phải >= 0';
  const healthSum =
    panel.fleet.healthyNodeCount +
    panel.fleet.degradedNodeCount +
    panel.fleet.unhealthyNodeCount +
    panel.fleet.downNodeCount;
  // Tổng health = số node đã check (node removed không được check)
  // nên không vượt nodeCount.
  if (healthSum > panel.fleet.nodeCount) return 'tổng node theo health vượt nodeCount';
  return '';
}

/** Lỗi validate quota panel, '' = hợp lệ. */
export function validateFleetV17QuotaPanel(panel: FleetV17QuotaPanel): string {
  for (const row of panel.rows) {
    if (row.quotas.length === 0) return `tenant ${row.tenantId} không có dòng quota nào`;
    for (const q of row.quotas) {
      if (q.limit < 0) return `tenant ${row.tenantId} quota ${q.kind} có giới hạn âm`;
      if (q.used < 0) return `tenant ${row.tenantId} quota ${q.kind} có lượng dùng âm`;
    }
  }
  return '';
}

/** Lỗi validate rollout panel, '' = hợp lệ. */
export function validateFleetV17RolloutPanel(panel: FleetV17RolloutPanel): string {
  const byStatusTotal = Object.values(panel.byStatus).reduce((a, b) => a + b, 0);
  if (byStatusTotal !== panel.total) return 'tổng byStatus không khớp total';
  if (panel.rows.length !== panel.total) return 'số hàng không khớp total';
  for (const row of panel.rows) {
    if (row.currentPercent < 0 || row.currentPercent > 100) {
      return `rollout ${row.id} có currentPercent ngoài 0..100`;
    }
    if (row.stageIndex < -1 || row.stageIndex >= row.stageCount) {
      return `rollout ${row.id} có stageIndex ngoài khoảng`;
    }
  }
  return '';
}
