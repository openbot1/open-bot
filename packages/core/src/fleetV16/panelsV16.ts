/**
 * Panels v16 — view-model cho admin panels v2: quản lý user, quota
 * tenant, cấu hình hệ thống, trạng thái gateway (v1.19, Đội T6).
 *
 * Theo pattern panels v15 (`fleetV15/panelsV15.ts`): module chỉ
 * xây VIEW-MODEL thuần (dữ liệu đã lọc/sắp xếp + tóm tắt) từ dữ
 * liệu thật của các tầng dưới; component React ở
 * `apps/desktop/src/renderer/components/AdminPanelsV16.tsx` /
 * `AuditLogV16Panel.tsx` / `FleetV16Panel.tsx` render từ đó.
 * Không import code của các đội khác (T1–T5 sóng v1.19) — chỉ
 * định nghĩa input interface tối thiểu cho dữ liệu họ cung cấp
 * qua IPC.
 *
 * - USER PANEL: hàng user (role, status, feature hiệu lực, session
 *   tối đa, last active) + đếm theo status/role + nhật ký quản
 *   trị gần nhất — xây trên `multiUserV16.ts`.
 * - QUOTA PANEL: hàng quota tenant (5 loại, đã dùng/còn lại, mức
 *   cảnh báo, giờ reset) + danh sách cảnh báo sắp xếp theo mức
 *   độ — xây trên `tenantQuotasV16.ts`.
 * - SYSTEM CONFIG PANEL: schema cài đặt hệ thống v2 theo nhóm
 *   (gateway, quota, fleet, rollout) — mỗi setting có kiểu, giá
 *   trị mặc định, min/max/options, cần restart không; validate +
 *   apply có ép kiểu an toàn (số ngoài khoảng → lỗi, không âm
 *   thầm clamp).
 * - GATEWAY PANEL: trạng thái rate limit (giới hạn theo scope/
 *   route, số bucket đang giữ) + rollout/flag tóm tắt — xây trên
 *   `gatewayRateLimitV16.ts` + `rolloutV16.ts`.
 *
 * Tất cả hàm đều thuần, không đọc file, không chạm mạng. Dữ liệu
 * mock chỉ xuất hiện ở component demo — module này không chứa mock.
 */

import type { AuditV16Row, AuditV16Summary } from './auditLogV16';
import { summarizeAuditV16Rows } from './auditLogV16';
import type { FleetV14Snapshot } from '../fleetV14/fleetV14';
import { fleetV16NodeWeight, summarizeFleetV16 } from './fleetV16';
import type { FleetV16Summary } from './fleetV16';
import type { GatewayV16Config } from './gatewayRateLimitV16';
import type {
  TeamV16AdminLogEntry,
  TeamV16State,
  TeamV16User,
  TeamV16UserStatus,
} from './multiUserV16';
import { summarizeTeamV16, summarizeTeamV16User } from './multiUserV16';
import type { TeamV16Rollout } from './rolloutV16';
import { summarizeTeamV16Rollout } from './rolloutV16';
import type { TenantV16QuotaRow, TenantV16QuotaState } from './tenantQuotasV16';
import { summarizeTenantV16Quota, tenantV16Alerts } from './tenantQuotasV16';

// ---------------------------------------------------------------------------
// User management panel
// ---------------------------------------------------------------------------

/** Một hàng user trong panel quản lý user. */
export interface FleetV16UserPanelRow {
  userId: string;
  displayName: string;
  roleRef: string;
  status: TeamV16UserStatus;
  features: string[];
  maxSessions: number;
  lastActiveAt: number | null;
}

/** View-model panel quản lý user. */
export interface FleetV16UserPanel {
  rows: FleetV16UserPanelRow[];
  totalUsers: number;
  byStatus: Record<TeamV16UserStatus, number>;
  byRole: Record<string, number>;
  customRoles: number;
  recentAdminActions: TeamV16AdminLogEntry[];
}

export function buildFleetV16UserPanel(
  state: TeamV16State,
  users: readonly TeamV16User[],
  recentLimit = 10,
): FleetV16UserPanel {
  const summary = summarizeTeamV16(state, recentLimit);
  const rows = [...users]
    .sort((a, b) => a.userId.localeCompare(b.userId))
    .map((u) => {
      const s = summarizeTeamV16User(state, u);
      return {
        userId: s.userId,
        displayName: s.displayName,
        roleRef: s.roleRef,
        status: s.status,
        features: [...s.features],
        maxSessions: s.maxSessions,
        lastActiveAt: s.lastActiveAt,
      };
    });
  return {
    rows,
    totalUsers: summary.totalUsers,
    byStatus: summary.byStatus,
    byRole: summary.byRole,
    customRoles: summary.customRoles,
    recentAdminActions: summary.recentAdminActions,
  };
}

// ---------------------------------------------------------------------------
// Tenant quota panel
// ---------------------------------------------------------------------------

/** Một hàng tenant trong panel quota. */
export interface FleetV16TenantQuotaPanelRow {
  tenantId: string;
  displayName: string;
  quotas: TenantV16QuotaRow[];
  /** Mức cảnh báo cao nhất của tenant (để tô màu hàng). */
  worstWarning: string;
}

/** View-model panel quota tenant. */
export interface FleetV16TenantQuotaPanel {
  rows: FleetV16TenantQuotaPanelRow[];
  alertCount: number;
  criticalCount: number;
  alerts: { tenantId: string; kind: string; warning: string; used: number; limit: number }[];
}

const TENANT_V16_WARNING_ORDER: Record<string, number> = {
  none: 0,
  watch: 1,
  warning: 2,
  critical: 3,
  exceeded: 4,
};

export function buildFleetV16TenantQuotaPanel(
  state: TenantV16QuotaState,
  now = Date.now(),
): FleetV16TenantQuotaPanel {
  const rows = [...state.tenants]
    .sort((a, b) => a.tenantId.localeCompare(b.tenantId))
    .map((t) => {
      const quotas = summarizeTenantV16Quota(t, now);
      let worstWarning = 'none';
      for (const q of quotas) {
        if ((TENANT_V16_WARNING_ORDER[q.warning] ?? 0) > (TENANT_V16_WARNING_ORDER[worstWarning] ?? 0)) {
          worstWarning = q.warning;
        }
      }
      return { tenantId: t.tenantId, displayName: t.displayName, quotas, worstWarning };
    });
  const alerts = tenantV16Alerts(state, 'watch', now);
  return {
    rows,
    alertCount: alerts.length,
    criticalCount: alerts.filter((a) => a.warning === 'critical' || a.warning === 'exceeded').length,
    alerts: alerts.map((a) => ({
      tenantId: a.tenantId,
      kind: a.kind,
      warning: a.warning,
      used: a.used,
      limit: a.limit,
    })),
  };
}

// ---------------------------------------------------------------------------
// System config panel (schema + validate + apply)
// ---------------------------------------------------------------------------

/** Nhóm cài đặt hệ thống. */
export type FleetV16ConfigGroup = 'gateway' | 'quotas' | 'fleet' | 'rollout';

export const FLEET_V16_CONFIG_GROUPS: readonly FleetV16ConfigGroup[] = [
  'gateway',
  'quotas',
  'fleet',
  'rollout',
];

/** Kiểu giá trị của một setting. */
export type FleetV16ConfigKind = 'number' | 'string' | 'boolean' | 'enum';

/** Một dòng cài đặt hệ thống. */
export interface FleetV16ConfigRow {
  key: string;
  group: FleetV16ConfigGroup;
  kind: FleetV16ConfigKind;
  /** Giá trị hiện tại (kiểu theo kind). */
  value: string | number | boolean;
  defaultValue: string | number | boolean;
  /** Giới hạn số (chỉ kind number). */
  min?: number;
  max?: number;
  /** Lựa chọn (chỉ kind enum). */
  options?: string[];
  /** Đổi setting này có cần restart gateway không. */
  requiresRestart: boolean;
}

/** Cài đặt mặc định của hệ thống (v2). */
export function defaultFleetV16ConfigRows(): FleetV16ConfigRow[] {
  return [
    {
      key: 'gateway.userMaxPerMinute', group: 'gateway', kind: 'number',
      value: 60, defaultValue: 60, min: 1, max: 10000, requiresRestart: false,
    },
    {
      key: 'gateway.tenantMaxPerMinute', group: 'gateway', kind: 'number',
      value: 600, defaultValue: 600, min: 1, max: 100000, requiresRestart: false,
    },
    {
      key: 'gateway.chatCompletionsMaxPerMinute', group: 'gateway', kind: 'number',
      value: 20, defaultValue: 20, min: 1, max: 1000, requiresRestart: false,
    },
    {
      key: 'gateway.mediaGenerateMaxPerMinute', group: 'gateway', kind: 'number',
      value: 5, defaultValue: 5, min: 1, max: 100, requiresRestart: false,
    },
    {
      key: 'quotas.defaultModelCallsPerDay', group: 'quotas', kind: 'number',
      value: 10000, defaultValue: 10000, min: 0, max: 1000000, requiresRestart: false,
    },
    {
      key: 'quotas.defaultBots', group: 'quotas', kind: 'number',
      value: 50, defaultValue: 50, min: 0, max: 1000, requiresRestart: false,
    },
    {
      key: 'quotas.warningWatchPercent', group: 'quotas', kind: 'number',
      value: 80, defaultValue: 80, min: 1, max: 99, requiresRestart: false,
    },
    {
      key: 'fleet.heartbeatIntervalMs', group: 'fleet', kind: 'number',
      value: 30000, defaultValue: 30000, min: 5000, max: 600000, requiresRestart: true,
    },
    {
      key: 'fleet.defaultDistributeStrategy', group: 'fleet', kind: 'enum',
      value: 'least-loaded', defaultValue: 'least-loaded',
      options: ['least-loaded', 'least-connections', 'weighted-round-robin'],
      requiresRestart: false,
    },
    {
      key: 'fleet.maxNodes', group: 'fleet', kind: 'number',
      value: 200, defaultValue: 200, min: 1, max: 1000, requiresRestart: false,
    },
    {
      key: 'rollout.defaultCanaryDwellMs', group: 'rollout', kind: 'number',
      value: 3600000, defaultValue: 3600000, min: 0, max: 86400000, requiresRestart: false,
    },
    {
      key: 'rollout.autoRollbackEnabled', group: 'rollout', kind: 'boolean',
      value: true, defaultValue: true, requiresRestart: false,
    },
  ];
}

/**
 * Validate một giá trị cho setting (ép kiểu an toàn): số phải là
 * số nguyên trong min..max; enum phải thuộc options; boolean phải
 * là true/false (hoặc chuỗi 'true'/'false'); string không rỗng
 * quá 256 ký tự. Trả về {ok, value} — value đã ép kiểu đúng.
 */
export function validateFleetV16ConfigValue(
  row: FleetV16ConfigRow,
  raw: unknown,
): { ok: boolean; value: string | number | boolean | null; error: string } {
  switch (row.kind) {
    case 'number': {
      const n = typeof raw === 'string' ? Number(raw.trim()) : raw;
      if (typeof n !== 'number' || !Number.isFinite(n) || !Number.isInteger(n)) {
        return { ok: false, value: null, error: `${row.key} phải là số nguyên` };
      }
      if (row.min !== undefined && n < row.min) {
        return { ok: false, value: null, error: `${row.key} phải >= ${row.min}` };
      }
      if (row.max !== undefined && n > row.max) {
        return { ok: false, value: null, error: `${row.key} phải <= ${row.max}` };
      }
      return { ok: true, value: n, error: '' };
    }
    case 'boolean': {
      if (typeof raw === 'boolean') return { ok: true, value: raw, error: '' };
      if (raw === 'true') return { ok: true, value: true, error: '' };
      if (raw === 'false') return { ok: true, value: false, error: '' };
      return { ok: false, value: null, error: `${row.key} phải là true/false` };
    }
    case 'enum': {
      if (typeof raw !== 'string' || !(row.options ?? []).includes(raw)) {
        return { ok: false, value: null, error: `${row.key} phải là một trong: ${(row.options ?? []).join(', ')}` };
      }
      return { ok: true, value: raw, error: '' };
    }
    case 'string': {
      if (typeof raw !== 'string' || raw.length === 0 || raw.length > 256) {
        return { ok: false, value: null, error: `${row.key} phải là chuỗi 1..256 ký tự` };
      }
      return { ok: true, value: raw, error: '' };
    }
  }
}

/** Áp dụng một giá trị mới cho setting (validate trước; sai → rows không đổi). */
export function applyFleetV16Config(
  rows: readonly FleetV16ConfigRow[],
  key: string,
  raw: unknown,
): { ok: boolean; rows: FleetV16ConfigRow[]; error: string; requiresRestart: boolean } {
  const row = rows.find((r) => r.key === key);
  if (!row) return { ok: false, rows: [...rows], error: `không tìm thấy setting: ${key}`, requiresRestart: false };
  const checked = validateFleetV16ConfigValue(row, raw);
  if (!checked.ok || checked.value === null) {
    return { ok: false, rows: [...rows], error: checked.error, requiresRestart: false };
  }
  const next = rows.map((r) => (r.key === key ? { ...r, value: checked.value as string | number | boolean } : r));
  return { ok: true, rows: next, error: '', requiresRestart: row.requiresRestart };
}

/** Nhóm các setting theo group (để panel render theo section). */
export function fleetV16ConfigRowsByGroup(
  rows: readonly FleetV16ConfigRow[],
): Record<FleetV16ConfigGroup, FleetV16ConfigRow[]> {
  const out: Record<FleetV16ConfigGroup, FleetV16ConfigRow[]> = {
    gateway: [],
    quotas: [],
    fleet: [],
    rollout: [],
  };
  for (const row of rows) out[row.group].push(row);
  return out;
}

// ---------------------------------------------------------------------------
// Gateway + rollout panel + admin panel tổng hợp
// ---------------------------------------------------------------------------

/** View-model panel gateway (rate limit + rollout/flag). */
export interface FleetV16GatewayPanel {
  userMaxPerMinute: number;
  tenantMaxPerMinute: number;
  routeOverrides: { route: string; maxRequests: number; windowMs: number }[];
  bucketCount: number;
  rolloutCount: number;
  activeRolloutCount: number;
  flagCount: number;
  killedFlagCount: number;
}

export function buildFleetV16GatewayPanel(input: {
  config: GatewayV16Config;
  bucketCount: number;
  rollouts: readonly TeamV16Rollout[];
  flags: readonly { killed: boolean }[];
}): FleetV16GatewayPanel {
  const userLimit = input.config.defaults.user;
  const tenantLimit = input.config.defaults.tenant;
  return {
    userMaxPerMinute: userLimit ? userLimit.maxRequests : 0,
    tenantMaxPerMinute: tenantLimit ? tenantLimit.maxRequests : 0,
    routeOverrides: Object.entries(input.config.routeOverrides)
      .map(([route, limit]) => ({ route, maxRequests: limit.maxRequests, windowMs: limit.windowMs }))
      .sort((a, b) => a.route.localeCompare(b.route)),
    bucketCount: input.bucketCount,
    rolloutCount: input.rollouts.length,
    activeRolloutCount: input.rollouts.filter((r) => r.status === 'canary' || r.status === 'rolling-out').length,
    flagCount: input.flags.length,
    killedFlagCount: input.flags.filter((f) => f.killed).length,
  };
}

/** View-model panel audit v2 (filter + phân trang cursor đã lọc sẵn). */
export interface FleetV16AuditPanel {
  rows: AuditV16Row[];
  totalRows: number;
  nextCursor: string | null;
  summary: AuditV16Summary;
}

export function buildFleetV16AuditPanel(input: {
  rows: readonly AuditV16Row[];
  nextCursor: string | null;
}): FleetV16AuditPanel {
  return {
    rows: [...input.rows],
    totalRows: input.rows.length,
    nextCursor: input.nextCursor,
    summary: summarizeAuditV16Rows(input.rows),
  };
}

/** Admin panel v2 tổng hợp: user + quota tenant + fleet + gateway + audit. */
export interface FleetV16AdminPanel {
  userPanel: FleetV16UserPanel;
  quotaPanel: FleetV16TenantQuotaPanel;
  configRows: FleetV16ConfigRow[];
  gatewayPanel: FleetV16GatewayPanel;
  fleetSummary: FleetV16Summary;
  auditSummary: AuditV16Summary;
  summary: string;
}

export function buildFleetV16AdminPanel(input: {
  teamState: TeamV16State;
  users: readonly TeamV16User[];
  quotaState: TenantV16QuotaState;
  configRows: readonly FleetV16ConfigRow[];
  gateway: { config: GatewayV16Config; bucketCount: number };
  rollouts: readonly TeamV16Rollout[];
  flags: readonly { killed: boolean }[];
  fleetSnapshot: FleetV14Snapshot;
  auditRows: readonly AuditV16Row[];
  now?: number;
}): FleetV16AdminPanel {
  const now = input.now ?? Date.now();
  const userPanel = buildFleetV16UserPanel(input.teamState, input.users);
  const quotaPanel = buildFleetV16TenantQuotaPanel(input.quotaState, now);
  const gatewayPanel = buildFleetV16GatewayPanel({
    config: input.gateway.config,
    bucketCount: input.gateway.bucketCount,
    rollouts: input.rollouts,
    flags: input.flags,
  });
  const fleetSummary = summarizeFleetV16(input.fleetSnapshot, now);
  const auditSummary = summarizeAuditV16Rows(input.auditRows);
  const summary =
    `${userPanel.totalUsers} user (${userPanel.byStatus.active} active), ` +
    `${quotaPanel.rows.length} tenant (${quotaPanel.alertCount} cảnh báo quota), ` +
    `${fleetSummary.totalNodes} node (${fleetSummary.totalRunningTasks} task đang chạy), ` +
    `${gatewayPanel.activeRolloutCount}/${gatewayPanel.rolloutCount} rollout đang chạy, ` +
    `${auditSummary.criticalRows} dòng audit critical`;
  return {
    userPanel,
    quotaPanel,
    configRows: [...input.configRows],
    gatewayPanel,
    fleetSummary,
    auditSummary,
    summary,
  };
}

// ---------------------------------------------------------------------------
// Fleet v16 panel tổng hợp (cho FleetV16Panel.tsx)
// ---------------------------------------------------------------------------

/** Một hàng node trong panel fleet v16. */
export interface FleetV16PanelNodeRow {
  nodeId: string;
  hostname: string;
  status: string;
  health: string;
  heartbeatAgeMs: number | null;
  missedHeartbeats: number;
  load: number;
  runningTasks: number;
  maxTasks: number;
  weight: number;
}

/** Một hàng rollout v5 trong panel fleet v16. */
export interface FleetV16PanelRolloutRow {
  id: string;
  feature: string;
  version: string;
  status: string;
  percent: number;
  lastAutoAction: string;
  errorRate: number | null;
}

/** View-model panel fleet v16. */
export interface FleetV16Panel {
  nodes: FleetV16PanelNodeRow[];
  summary: FleetV16Summary;
  rollouts: FleetV16PanelRolloutRow[];
  summaryText: string;
}

export function buildFleetV16Panel(input: {
  fleetSnapshot: FleetV14Snapshot;
  rollouts: readonly TeamV16Rollout[];
  heartbeatIntervalMs?: number;
  now?: number;
}): FleetV16Panel {
  const now = input.now ?? Date.now();
  const interval = input.heartbeatIntervalMs ?? 30 * 1000;
  const nodes = [...input.fleetSnapshot.nodes]
    .sort((a, b) => a.nodeId.localeCompare(b.nodeId))
    .map((n) => {
      const age = n.lastHeartbeatAt === null ? null : Math.max(0, now - n.lastHeartbeatAt);
      const missed = n.lastHeartbeatAt === null ? 0 : Math.floor(Math.max(0, now - n.lastHeartbeatAt) / interval);
      return {
        nodeId: n.nodeId,
        hostname: n.hostname,
        status: n.status,
        health: n.health,
        heartbeatAgeMs: age,
        missedHeartbeats: missed,
        load: n.capacity.maxTasks > 0 ? n.runningTaskIds.length / n.capacity.maxTasks : 0,
        runningTasks: n.runningTaskIds.length,
        maxTasks: n.capacity.maxTasks,
        weight: fleetV16NodeWeight(input.fleetSnapshot, n.nodeId),
      };
    });
  const summary = summarizeFleetV16(input.fleetSnapshot, now);
  const rollouts = input.rollouts.map((r) => {
    const s = summarizeTeamV16Rollout(r, now);
    return {
      id: s.id,
      feature: s.feature,
      version: s.version,
      status: s.status,
      percent: s.percent,
      lastAutoAction: s.lastAutoAction,
      errorRate: s.errorRate,
    };
  });
  return {
    nodes,
    summary,
    rollouts,
    summaryText:
      `${summary.totalNodes} node, ${summary.totalRunningTasks} task đang chạy, ` +
      `tải trung bình ${(summary.averageLoad * 100).toFixed(0)}%, ` +
      `${rollouts.length} rollout v5`,
  };
}
