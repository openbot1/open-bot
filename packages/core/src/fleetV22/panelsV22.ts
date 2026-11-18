/**
 * Panels + fleet dashboard v22 (v1.35, Đội T6).
 *
 * Theo pattern panels v21: module chỉ xây VIEW-MODEL thuần từ dữ liệu
 * thật của các tầng dưới; component React render từ đó. Không đọc file,
 * không chạm mạng, không chứa mock.
 *
 * Dashboard v22 gộp 4 panel con (progressive disclosure — chi tiết nằm
 * sau từng panel):
 *
 * - USER: user nào, vai trò gì, quota dùng bao nhiêu, ai sắp hết quota,
 *   ai bị khoá.
 * - COMPUTER: per-bot computer nào, loại gì, trạng thái gì, cấp bao
 *   nhiêu / dùng bao nhiêu, computer nào đang chịu áp lực tài nguyên.
 * - ORCHESTRATION: delegation nào đang chạy/chờ xác minh, handoff nào
 *   chờ duyệt, escalation nào đã kích hoạt, audit mới nhất.
 * - CẢNH BÁO: user sắp hết quota, computer quá tải, delegation fail
 *   liên tiếp, handoff chờ duyệt quá lâu, computer failed.
 *
 * Chuỗi tóm tắt trong view-model viết tiếng Việt như panels v21 (chuỗi
 * hiển thị dài hơn dùng i18n `fleet.v22.*` ở desktop).
 */

import type { FleetV22BotComputer } from './computers';
import { computerCpuFractionV22, computerIsPressuredV22, computerRamFractionV22 } from './computers';
import type { FleetV22Delegation } from './delegation';
import type { FleetV22Handoff } from './handoff';
import type { FleetV22OrchestrationAuditEntry } from './orchestration';
import type { FleetV22HostProbe } from './probes';
import { allocatableFromProbeV22, probeAgeMsV22 } from './probes';
import type { FleetV22Usage, FleetV22User } from './users';
import { quotaFractionsV22, quotaIsNearLimitV22, quotaMaxFractionV22 } from './users';

// ---------------------------------------------------------------------------
// User panel
// ---------------------------------------------------------------------------

export interface FleetV22UserRow {
  id: string;
  displayName: string;
  email: string;
  role: string;
  active: boolean;
  team?: string;
  /** Tỉ lệ dùng quota nặng nhất 0..1. */
  maxQuotaFraction: number;
  /** Tỉ lệ dùng từng mục. */
  quotaFractions: Record<string, number>;
  nearLimit: boolean;
  /** User hoạt động lần cuối cách đây bao lâu (ms) — null khi chưa hoạt động. */
  idleMs: number | null;
}

export interface FleetV22UserPanelView {
  summary: string;
  total: number;
  active: number;
  locked: number;
  admins: number;
  operators: number;
  members: number;
  viewers: number;
  nearLimit: number;
  rows: FleetV22UserRow[];
  nearLimitUserIds: string[];
  lockedUserIds: string[];
}

export function buildFleetV22UserPanel(
  users: readonly FleetV22User[],
  usageByUserId: Readonly<Record<string, FleetV22Usage>>,
  now: number = Date.now(),
): FleetV22UserPanelView {
  const rows: FleetV22UserRow[] = [...users]
    .sort((a, b) => quotaMaxFractionV22(b.quota, usageByUserId[b.id] ?? emptyUsage()) - quotaMaxFractionV22(a.quota, usageByUserId[a.id] ?? emptyUsage()) || a.id.localeCompare(b.id))
    .map((u) => {
      const usage = usageByUserId[u.id] ?? emptyUsage();
      return {
        id: u.id,
        displayName: u.displayName,
        email: u.email,
        role: u.role,
        active: u.active,
        ...(u.team ? { team: u.team } : {}),
        maxQuotaFraction: Math.round(quotaMaxFractionV22(u.quota, usage) * 1000) / 1000,
        quotaFractions: quotaFractionsV22(u.quota, usage),
        nearLimit: quotaIsNearLimitV22(u.quota, usage),
        idleMs: u.lastActiveAt === null ? null : Math.max(0, now - u.lastActiveAt),
      };
    });
  const nearLimit = rows.filter((r) => r.nearLimit).length;
  const locked = rows.filter((r) => !r.active).length;
  return {
    summary:
      users.length === 0
        ? 'Fleet chưa có user nào — tạo user đầu tiên (admin) trước khi thêm người khác.'
        : `${users.length} user (${rows.filter((r) => r.role === 'admin').length} admin, ` +
          `${rows.filter((r) => r.role === 'operator').length} operator, ` +
          `${rows.filter((r) => r.role === 'member').length} member, ` +
          `${rows.filter((r) => r.role === 'viewer').length} viewer)` +
          (nearLimit > 0 ? `, ${nearLimit} user sắp hết quota` : '') +
          (locked > 0 ? `, ${locked} user đang bị khoá` : '') +
          '.',
    total: users.length,
    active: rows.filter((r) => r.active).length,
    locked,
    admins: rows.filter((r) => r.role === 'admin').length,
    operators: rows.filter((r) => r.role === 'operator').length,
    members: rows.filter((r) => r.role === 'member').length,
    viewers: rows.filter((r) => r.role === 'viewer').length,
    nearLimit,
    rows,
    nearLimitUserIds: rows.filter((r) => r.nearLimit).map((r) => r.id),
    lockedUserIds: rows.filter((r) => !r.active).map((r) => r.id),
  };
}

function emptyUsage(): FleetV22Usage {
  return { cpuCores: 0, ramBytes: 0, diskBytes: 0, bots: 0, concurrentRuns: 0, computers: 0 };
}

// ---------------------------------------------------------------------------
// Computer panel
// ---------------------------------------------------------------------------

export interface FleetV22ComputerRow {
  id: string;
  botId: string;
  ownerId: string;
  kind: string;
  status: string;
  statusReason?: string;
  name: string;
  nodeId: string | null;
  cpuCores: number;
  cpuUsed: number | null;
  cpuFraction: number | null;
  ramBytes: number;
  ramUsed: number | null;
  ramFraction: number | null;
  diskBytes: number;
  diskUsed: number | null;
  diskFraction: number | null;
  pressured: boolean;
  endpoint: string | null;
  consecutiveFailures: number;
  ageMs: number;
}

export interface FleetV22ComputerPanelView {
  summary: string;
  total: number;
  running: number;
  provisioning: number;
  paused: number;
  failed: number;
  stopped: number;
  pressured: number;
  totalCpuCores: number;
  totalRamBytes: number;
  totalDiskBytes: number;
  byKind: Record<string, number>;
  byStatus: Record<string, number>;
  rows: FleetV22ComputerRow[];
  pressuredComputerIds: string[];
  failedComputerIds: string[];
}

export function buildFleetV22ComputerPanel(
  computers: readonly FleetV22BotComputer[],
  now: number = Date.now(),
): FleetV22ComputerPanelView {
  const rows: FleetV22ComputerRow[] = [...computers]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((c) => ({
      id: c.id,
      botId: c.botId,
      ownerId: c.ownerId,
      kind: c.kind,
      status: c.status,
      ...(c.statusReason ? { statusReason: c.statusReason } : {}),
      name: c.name,
      nodeId: c.nodeId,
      cpuCores: c.cpuCores,
      cpuUsed: c.cpuUsed,
      cpuFraction: computerCpuFractionV22(c),
      ramBytes: c.ramBytes,
      ramUsed: c.ramUsed,
      ramFraction: computerRamFractionV22(c),
      diskBytes: c.diskBytes,
      diskUsed: c.diskUsed,
      diskFraction: c.diskUsed === null || c.diskBytes <= 0 ? null : Math.round((c.diskUsed / c.diskBytes) * 1000) / 1000,
      pressured: computerIsPressuredV22(c),
      endpoint: c.endpoint,
      consecutiveFailures: c.consecutiveFailures,
      ageMs: Math.max(0, now - c.createdAt),
    }));
  const byKind: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  for (const r of rows) {
    byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
    byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  }
  const failed = rows.filter((r) => r.status === 'failed').length;
  const pressured = rows.filter((r) => r.pressured).length;
  return {
    summary:
      computers.length === 0
        ? 'Chưa có per-bot computer nào — tạo computer cho bot để bot có máy riêng.'
        : `${computers.length} computer: ${byStatus.running ?? 0} đang chạy, ${byStatus.provisioning ?? 0} đang tạo, ` +
          `${byStatus.paused ?? 0} tạm dừng, ${byStatus.ready ?? 0} sẵn sàng` +
          (failed > 0 ? `, ${failed} lỗi` : '') +
          (pressured > 0 ? `, ${pressured} đang chịu áp lực tài nguyên` : '') +
          '.',
    total: computers.length,
    running: byStatus.running ?? 0,
    provisioning: byStatus.provisioning ?? 0,
    paused: byStatus.paused ?? 0,
    failed,
    stopped: byStatus.stopped ?? 0,
    pressured,
    totalCpuCores: rows.reduce((s, r) => s + r.cpuCores, 0),
    totalRamBytes: rows.reduce((s, r) => s + r.ramBytes, 0),
    totalDiskBytes: rows.reduce((s, r) => s + r.diskBytes, 0),
    byKind,
    byStatus,
    rows,
    pressuredComputerIds: rows.filter((r) => r.pressured).map((r) => r.id),
    failedComputerIds: rows.filter((r) => r.status === 'failed').map((r) => r.id),
  };
}

// ---------------------------------------------------------------------------
// Orchestration panel
// ---------------------------------------------------------------------------

export interface FleetV22OrchestrationPanelView {
  summary: string;
  delegationsTotal: number;
  delegationsRunning: number;
  delegationsAwaitingVerification: number;
  delegationsCompleted: number;
  delegationsFailed: number;
  delegationsTimedOut: number;
  handoffsTotal: number;
  handoffsPendingApproval: number;
  handoffsTransferred: number;
  handoffsRejected: number;
  handoffsFailed: number;
  auditEntries: number;
  /** Delegation chờ xác minh lâu nhất (ms) — null khi không có. */
  oldestAwaitingVerificationMs: number | null;
  awaitingVerificationIds: string[];
  pendingApprovalHandoffIds: string[];
  recentAudit: FleetV22OrchestrationAuditEntry[];
}

export function buildFleetV22OrchestrationPanel(
  delegations: readonly FleetV22Delegation[],
  handoffs: readonly FleetV22Handoff[],
  audit: readonly FleetV22OrchestrationAuditEntry[],
  now: number = Date.now(),
): FleetV22OrchestrationPanelView {
  const awaiting = delegations.filter((d) => d.status === 'awaiting-verification');
  const oldest = awaiting.length === 0 ? null : Math.max(...awaiting.map((d) => now - d.createdAt));
  const pendingHandoffs = handoffs.filter((h) => h.status === 'pending-approval');
  return {
    summary:
      `Delegation: ${delegations.length} tổng, ` +
      `${delegations.filter((d) => d.status === 'running').length} đang chạy, ` +
      `${awaiting.length} chờ xác minh, ${delegations.filter((d) => d.status === 'completed').length} xong` +
      (delegations.filter((d) => d.status === 'failed' || d.status === 'timed-out').length > 0
        ? `, ${delegations.filter((d) => d.status === 'failed' || d.status === 'timed-out').length} lỗi/hết giờ`
        : '') +
      `. Handoff: ${handoffs.length} tổng, ${handoffCount(handoffs, 'transferred')} đã chuyển` +
      (pendingHandoffs.length > 0 ? `, ${pendingHandoffs.length} chờ duyệt` : '') +
      `. Audit: ${audit.length} mục.`,
    delegationsTotal: delegations.length,
    delegationsRunning: delegations.filter((d) => d.status === 'running').length,
    delegationsAwaitingVerification: awaiting.length,
    delegationsCompleted: delegations.filter((d) => d.status === 'completed').length,
    delegationsFailed: delegations.filter((d) => d.status === 'failed').length,
    delegationsTimedOut: delegations.filter((d) => d.status === 'timed-out').length,
    handoffsTotal: handoffs.length,
    handoffsPendingApproval: pendingHandoffs.length,
    handoffsTransferred: handoffCount(handoffs, 'transferred'),
    handoffsRejected: handoffCount(handoffs, 'rejected'),
    handoffsFailed: handoffCount(handoffs, 'failed'),
    auditEntries: audit.length,
    oldestAwaitingVerificationMs: oldest,
    awaitingVerificationIds: awaiting.map((d) => d.id),
    pendingApprovalHandoffIds: pendingHandoffs.map((h) => h.id),
    recentAudit: [...audit].slice(-10).reverse(),
  };
}

function handoffCount(handoffs: readonly FleetV22Handoff[], status: FleetV22Handoff['status']): number {
  return handoffs.filter((h) => h.status === status).length;
}

// ---------------------------------------------------------------------------
// Probe panel (tài nguyên host)
// ---------------------------------------------------------------------------

export interface FleetV22ProbePanelView {
  summary: string;
  probeAgeMs: number;
  fresh: boolean;
  source: string;
  cpuCores: number;
  cpuUsed: number;
  ramBytes: number;
  ramUsed: number;
  diskBytes: number;
  diskUsed: number;
  diskPath: string;
  allocatableCpuCores: number;
  allocatableRamBytes: number;
  allocatableDiskBytes: number;
  reservedCpuCores: number;
  reservedRamBytes: number;
  reservedDiskBytes: number;
}

export function buildFleetV22ProbePanel(probe: FleetV22HostProbe, now: number = Date.now()): FleetV22ProbePanelView {
  const allocatable = allocatableFromProbeV22(probe);
  return {
    summary:
      `Host ${probe.cpuCores} CPU core, ${Math.round((probe.ramBytes / 1024 ** 3) * 10) / 10} GB RAM, ` +
      `${Math.round((probe.diskBytes / 1024 ** 3) * 10) / 10} GB disk — chia được ` +
      `${allocatable.cpuCores} CPU core, ${Math.round((allocatable.ramBytes / 1024 ** 3) * 10) / 10} GB RAM, ` +
      `${Math.round((allocatable.diskBytes / 1024 ** 3) * 10) / 10} GB disk sau khi giữ headroom cho host. ` +
      `Số đo cách đây ${Math.round(probeAgeMsV22(probe, now) / 1000)}s (${probe.source}).`,
    probeAgeMs: probeAgeMsV22(probe, now),
    fresh: probeAgeMsV22(probe, now) <= 60_000,
    source: probe.source,
    cpuCores: probe.cpuCores,
    cpuUsed: probe.cpuUsed,
    ramBytes: probe.ramBytes,
    ramUsed: probe.ramUsed,
    diskBytes: probe.diskBytes,
    diskUsed: probe.diskUsed,
    diskPath: probe.diskPath,
    allocatableCpuCores: Math.round(allocatable.cpuCores * 100) / 100,
    allocatableRamBytes: allocatable.ramBytes,
    allocatableDiskBytes: allocatable.diskBytes,
    reservedCpuCores: allocatable.reserved.cpuCores,
    reservedRamBytes: allocatable.reserved.ramBytes,
    reservedDiskBytes: allocatable.reserved.diskBytes,
  };
}

// ---------------------------------------------------------------------------
// Dashboard tổng hợp
// ---------------------------------------------------------------------------

/** Một mục cần chú ý trên dashboard v22. */
export interface FleetV22DashboardAttention {
  panel: 'user' | 'computer' | 'orchestration' | 'probe';
  level: 'error' | 'warning' | 'info';
  message: string;
}

export interface FleetV22DashboardView {
  summary: string;
  userSummary: string;
  computerSummary: string;
  orchestrationSummary: string;
  probeSummary: string | null;
  attentionCount: number;
  attention: FleetV22DashboardAttention[];
  counts: {
    usersTotal: number;
    usersNearLimit: number;
    usersLocked: number;
    computersTotal: number;
    computersRunning: number;
    computersFailed: number;
    computersPressured: number;
    delegationsRunning: number;
    delegationsAwaitingVerification: number;
    handoffsPendingApproval: number;
  };
}

export interface FleetV22DashboardInput {
  users: readonly FleetV22User[];
  usageByUserId: Readonly<Record<string, FleetV22Usage>>;
  computers: readonly FleetV22BotComputer[];
  delegations: readonly FleetV22Delegation[];
  handoffs: readonly FleetV22Handoff[];
  audit: readonly FleetV22OrchestrationAuditEntry[];
  probe?: FleetV22HostProbe | null;
  now?: number;
}

export function buildFleetV22Dashboard(input: FleetV22DashboardInput): FleetV22DashboardView {
  const now = input.now ?? Date.now();
  const userPanel = buildFleetV22UserPanel(input.users, input.usageByUserId, now);
  const computerPanel = buildFleetV22ComputerPanel(input.computers, now);
  const orchPanel = buildFleetV22OrchestrationPanel(input.delegations, input.handoffs, input.audit, now);
  const probePanel = input.probe ? buildFleetV22ProbePanel(input.probe, now) : null;

  const attention: FleetV22DashboardAttention[] = [];
  for (const row of userPanel.rows) {
    if (!row.active) {
      attention.push({ panel: 'user', level: 'warning', message: `User "${row.displayName}" (${row.email}) đang bị khoá.` });
    } else if (row.nearLimit) {
      attention.push({
        panel: 'user',
        level: 'warning',
        message: `User "${row.displayName}" sắp hết quota (mức dùng cao nhất ${Math.round(row.maxQuotaFraction * 100)}%).`,
      });
    }
  }
  for (const row of computerPanel.rows) {
    if (row.status === 'failed') {
      attention.push({
        panel: 'computer',
        level: 'error',
        message: `Computer "${row.id}" (bot ${row.botId}) lỗi${row.statusReason ? `: ${row.statusReason}` : ''} — cần xem rồi tạo lại.`,
      });
    } else if (row.pressured) {
      attention.push({
        panel: 'computer',
        level: 'warning',
        message: `Computer "${row.id}" (bot ${row.botId}) dùng trên 90% CPU hoặc RAM đã cấp — cân nhắc tăng cấp.`,
      });
    }
  }
  for (const id of orchPanel.awaitingVerificationIds) {
    attention.push({
      panel: 'orchestration',
      level: 'warning',
      message: `Delegation "${id}" đã xong việc và đang chờ parent xác minh kết quả.`,
    });
  }
  for (const id of orchPanel.pendingApprovalHandoffIds) {
    attention.push({
      panel: 'orchestration',
      level: 'warning',
      message: `Handoff "${id}" đang chờ duyệt — hội thoại chưa chuyển sang agent chuyên môn.`,
    });
  }
  if (probePanel && !probePanel.fresh) {
    attention.push({
      panel: 'probe',
      level: 'info',
      message: `Số đo tài nguyên host đã cũ (${Math.round(probePanel.probeAgeMs / 1000)}s) — chạy probe lại trước khi chia tài nguyên.`,
    });
  }
  const levelRank: Record<string, number> = { error: 0, warning: 1, info: 2 };
  attention.sort((a, b) => levelRank[a.level] - levelRank[b.level]);

  return {
    summary:
      `${userPanel.summary} ${computerPanel.summary} ${orchPanel.summary}` +
      (probePanel ? ` ${probePanel.summary}` : '') +
      (attention.length > 0 ? ` Có ${attention.length} mục cần chú ý.` : ' Không có mục nào cần chú ý.'),
    userSummary: userPanel.summary,
    computerSummary: computerPanel.summary,
    orchestrationSummary: orchPanel.summary,
    probeSummary: probePanel?.summary ?? null,
    attentionCount: attention.filter((a) => a.level !== 'info').length,
    attention,
    counts: {
      usersTotal: userPanel.total,
      usersNearLimit: userPanel.nearLimit,
      usersLocked: userPanel.locked,
      computersTotal: computerPanel.total,
      computersRunning: computerPanel.running,
      computersFailed: computerPanel.failed,
      computersPressured: computerPanel.pressured,
      delegationsRunning: orchPanel.delegationsRunning,
      delegationsAwaitingVerification: orchPanel.delegationsAwaitingVerification,
      handoffsPendingApproval: orchPanel.handoffsPendingApproval,
    },
  };
}

