/**
 * Panels v19 — view-model cho desktop panels fleet health, job queue,
 * node status, plugin store (v1.29, Đội T6).
 *
 * Tầng trên của panels v17 (`fleetV17/panelsV17.ts` — dashboard tổng
 * quan + quản lý quota/rollout) và các module v19: fleet health v19
 * (lịch sử/trend/alert), job queue v19 (hàng đợi/retry/dead-letter),
 * node status v19 (vòng đời/pressure/ranking), plugin SDK v4
 * (manifest/lifecycle/sandbox). V17 trả lời "toàn hệ thống khỏe không";
 * v19 trả lời 4 câu của từng panel riêng:
 *
 * - FLEET HEALTH PANEL: điểm fleet + phân bố health + trend từng node
 *   (improving/degrading/volatile) + alert đang mở (nghiêm trọng
 *   trước) + node flapping — một màn hình để trực ca nhìn là biết
 *   fleet có ổn không.
 * - JOB QUEUE PANEL: thống kê hàng đợi (độ sâu theo trạng thái,
 *   chờ lâu nhất/trung bình, ước tính chờ) + job tiếp theo sẽ chạy
 *   (kèm node đích đã chọn) + dead-letter mới nhất + job đang retry
 *   (còn bao lâu mới chạy lại).
 * - NODE STATUS PANEL: bảng node (status/health/pressure/staleness/
 *   rank) + tóm tắt theo nhóm + node cần chú ý + nút chuyển trạng
 *   thái hợp lệ cho từng node (chỉ hiện nút được phép bấm).
 * - PLUGIN STORE PANEL: danh sách plugin đã cài (lifecycle, version,
 *   capability, quyền đã duyệt/chưa duyệt) + thứ tự load + plugin
 *   lỗi dependency (không enable được, kèm lý do) + tóm tắt store.
 *
 * Theo pattern panels v15/v16/v17: module chỉ xây VIEW-MODEL thuần
 * từ dữ liệu thật của các tầng dưới; component React render từ đó.
 * Không đọc file, không chạm mạng, không chứa mock.
 */

import type { FleetV14Node } from '../fleetV14/fleetV14';
import type { FleetV17Taint } from '../fleetV17/fleetV17';
import type {
  FleetV19Alert,
  FleetV19FleetScore,
  FleetV19NodeStats,
} from './fleetHealthV19';
import type { FleetV19Job, FleetV19JobQueue, FleetV19QueueStats } from './jobQueueV19';
import {
  listFleetV19DeadJobs,
  peekFleetV19NextJob,
  pickFleetV19NodeForJob,
  summarizeFleetV19Queue,
} from './jobQueueV19';
import type {
  FleetV19NodePressure,
  FleetV19NodeRank,
  FleetV19StatusSnapshot,
} from './nodeStatusV19';
import {
  fleetV19AllowedTransitions,
  fleetV19HeartbeatStaleness,
  summarizeFleetV19Status,
} from './nodeStatusV19';
import type {
  PluginV19Installed,
  PluginV19Store,
} from './pluginSdkV19';
import {
  checkPluginV19Dependencies,
  resolvePluginV19LoadOrder,
  summarizePluginV19Store,
} from './pluginSdkV19';

// ---------------------------------------------------------------------------
// Fleet health panel
// ---------------------------------------------------------------------------

/** Một hàng node trong fleet health panel. */
export interface FleetV19HealthPanelNodeRow {
  nodeId: string;
  latestScore: number | null;
  latestHealth: string;
  avgScore: number | null;
  uptimePct: number | null;
  trend: string;
  levelChanges: number;
  flapping: boolean;
}

/** View-model panel fleet health. */
export interface FleetV19HealthPanel {
  at: number;
  fleetScore: FleetV19FleetScore;
  nodes: FleetV19HealthPanelNodeRow[];
  /** Node đang degrading (điểm giảm liên tục). */
  degradingNodeIds: string[];
  /** Node đang flapping. */
  flappingNodeIds: string[];
  openAlerts: FleetV19Alert[];
  openAlertCount: number;
  criticalAlertCount: number;
  summary: string;
}

/** Build fleet health panel từ fleet score + stats từng node + alert store. */
export function buildFleetV19HealthPanel(
  fleetScore: FleetV19FleetScore,
  statsByNode: ReadonlyMap<string, FleetV19NodeStats> | Record<string, FleetV19NodeStats>,
  openAlerts: FleetV19Alert[],
  at: number,
): FleetV19HealthPanel {
  const entries =
    statsByNode instanceof Map ? [...statsByNode.entries()] : Object.entries(statsByNode);
  const nodes: FleetV19HealthPanelNodeRow[] = entries
    .map(([, stats]) => ({
      nodeId: stats.nodeId,
      latestScore: stats.latestScore,
      latestHealth: stats.latestHealth ?? 'unknown',
      avgScore: stats.avgScore,
      uptimePct: stats.uptimePct,
      trend: stats.trend,
      levelChanges: stats.levelChanges,
      flapping: stats.flapping,
    }))
    .sort((a, b) => (a.latestScore ?? 101) - (b.latestScore ?? 101));
  const degradingNodeIds = nodes.filter((n) => n.trend === 'degrading').map((n) => n.nodeId);
  const flappingNodeIds = nodes.filter((n) => n.flapping).map((n) => n.nodeId);
  const criticalAlertCount = openAlerts.filter((a) => a.level === 'critical').length;
  const parts: string[] = [];
  parts.push(`điểm fleet ${fleetScore.score} (${fleetScore.nodeCount} node, ${fleetScore.healthyPct}% healthy)`);
  if (degradingNodeIds.length > 0) parts.push(`${degradingNodeIds.length} node đang xấu dần`);
  if (flappingNodeIds.length > 0) parts.push(`${flappingNodeIds.length} node chập chờn`);
  if (openAlerts.length > 0) parts.push(`${openAlerts.length} cảnh báo đang mở (${criticalAlertCount} critical)`);
  if (parts.length === 1) parts.push('không có cảnh báo');
  return {
    at,
    fleetScore,
    nodes,
    degradingNodeIds,
    flappingNodeIds,
    openAlerts,
    openAlertCount: openAlerts.length,
    criticalAlertCount,
    summary: parts.join(' · '),
  };
}

// ---------------------------------------------------------------------------
// Job queue panel
// ---------------------------------------------------------------------------

/** Một job retrying trong panel (kèm thời gian còn chờ). */
export interface FleetV19JobQueuePanelRetryRow {
  jobId: string;
  attempts: number;
  maxAttempts: number;
  lastError: string;
  retryInMs: number;
}

/** View-model panel job queue. */
export interface FleetV19JobQueuePanel {
  at: number;
  stats: FleetV19QueueStats;
  /** Job sẽ chạy tiếp (null = hàng đợi trống). */
  nextJob: FleetV19Job | null;
  /** Node đích đã chọn cho job tiếp theo (null = chưa chọn được). */
  nextJobNodeId: string | null;
  /** Lý do chưa chọn được node (rỗng = chọn được hoặc không có job). */
  nextJobBlockedReasons: string[];
  retrying: FleetV19JobQueuePanelRetryRow[];
  dead: FleetV19Job[];
  deadCount: number;
  summary: string;
}

/** Build job queue panel: thống kê + job tiếp theo + node đích + retrying + dead-letter. */
export function buildFleetV19JobQueuePanel(
  queue: FleetV19JobQueue,
  nodes: readonly FleetV14Node[],
  taintsByNode: ReadonlyMap<string, readonly FleetV17Taint[]> | Record<string, readonly FleetV17Taint[]>,
  at: number,
): FleetV19JobQueuePanel {
  const stats = summarizeFleetV19Queue(queue, at);
  const nextJob = peekFleetV19NextJob(queue, at);
  let nextJobNodeId: string | null = null;
  let nextJobBlockedReasons: string[] = [];
  if (nextJob !== null) {
    const picked = pickFleetV19NodeForJob(nextJob, nodes, taintsByNode, []);
    nextJobNodeId = picked.node === null ? null : picked.node.nodeId;
    nextJobBlockedReasons = picked.blockedReasons;
  }
  const retrying: FleetV19JobQueuePanelRetryRow[] = queue.jobs
    .filter((j) => j.status === 'retrying')
    .map((j) => ({
      jobId: j.jobId,
      attempts: j.attempts,
      maxAttempts: j.maxAttempts,
      lastError: j.lastError,
      retryInMs: Math.max(0, j.readyAt - at),
    }))
    .sort((a, b) => a.retryInMs - b.retryInMs);
  const dead = listFleetV19DeadJobs(queue);
  const summaryParts = [
    `${stats.byStatus.queued} queued, ${stats.byStatus.running} running, ${stats.byStatus.retrying} retrying, ${stats.byStatus.dead} dead`,
  ];
  if (stats.oldestWaitMs !== null) summaryParts.push(`chờ lâu nhất ${Math.round(stats.oldestWaitMs / 1000)}s`);
  if (stats.estimatedWaitMs !== null) summaryParts.push(`ước tính chờ ${Math.round(stats.estimatedWaitMs / 1000)}s`);
  return {
    at,
    stats,
    nextJob,
    nextJobNodeId,
    nextJobBlockedReasons,
    retrying,
    dead,
    deadCount: dead.length,
    summary: summaryParts.join(' · '),
  };
}

// ---------------------------------------------------------------------------
// Node status panel
// ---------------------------------------------------------------------------

/** Một hàng node trong node status panel. */
export interface FleetV19NodeStatusPanelRow {
  nodeId: string;
  hostname: string;
  status: string;
  health: string;
  pressure: string;
  tightest: string;
  tightestUtilization: number;
  staleness: string;
  runningTasks: number;
  maxTasks: number;
  rankScore: number | null;
  eligible: boolean;
  /** Các trạng thái đích mà UI được phép hiện nút chuyển. */
  allowedTransitions: string[];
}

/** View-model panel node status. */
export interface FleetV19NodeStatusPanel {
  at: number;
  snapshot: FleetV19StatusSnapshot;
  nodes: FleetV19NodeStatusPanelRow[];
  summary: string;
}

/** Build node status panel từ node + pressure + rank. */
export function buildFleetV19NodeStatusPanel(
  nodes: readonly FleetV14Node[],
  pressureByNode: ReadonlyMap<string, FleetV19NodePressure> | Record<string, FleetV19NodePressure>,
  ranks: readonly FleetV19NodeRank[],
  at: number,
): FleetV19NodeStatusPanel {
  const snapshot = summarizeFleetV19Status(nodes, pressureByNode, ranks, at);
  const pressureOf = (nodeId: string): FleetV19NodePressure | undefined => {
    if (pressureByNode instanceof Map) return pressureByNode.get(nodeId);
    return (pressureByNode as Record<string, FleetV19NodePressure>)[nodeId];
  };
  const rankOf = (nodeId: string): FleetV19NodeRank | undefined =>
    ranks.find((r) => r.nodeId === nodeId);
  const rows: FleetV19NodeStatusPanelRow[] = nodes.map((node) => {
    const pressure = pressureOf(node.nodeId);
    const rank = rankOf(node.nodeId);
    return {
      nodeId: node.nodeId,
      hostname: node.hostname,
      status: node.status,
      health: node.health,
      pressure: pressure === undefined ? 'unknown' : pressure.pressure,
      tightest: pressure === undefined ? '-' : pressure.tightest,
      tightestUtilization: pressure === undefined ? 0 : pressure.tightestUtilization,
      staleness: fleetV19HeartbeatStaleness(node.lastHeartbeatAt, at),
      runningTasks: node.runningTaskIds.length,
      maxTasks: node.capacity.maxTasks,
      rankScore: rank === undefined ? null : rank.score,
      eligible: rank !== undefined && rank.eligible,
      allowedTransitions: fleetV19AllowedTransitions(node.status),
    };
  });
  rows.sort((a, b) => (b.rankScore ?? -1) - (a.rankScore ?? -1) || (a.nodeId < b.nodeId ? -1 : 1));
  const summary = `${snapshot.total} node: ${snapshot.byStatus.active} active, ${snapshot.eligibleCount} đủ điều kiện nhận job, ${snapshot.attention.length} node cần chú ý`;
  return { at, snapshot, nodes: rows, summary };
}

// ---------------------------------------------------------------------------
// Plugin store panel
// ---------------------------------------------------------------------------

/** Một hàng plugin trong plugin store panel. */
export interface FleetV19PluginStorePanelRow {
  pluginId: string;
  name: string;
  version: string;
  sdkVersion: number;
  lifecycle: string;
  capabilities: string[];
  permissions: string[];
  approvedPermissions: string[];
  /** Quyền đã khai nhưng chưa được user duyệt (để UI hiện nút Approve). */
  unapprovedPermissions: string[];
  tools: string[];
  dependsOn: string[];
  /** Lỗi dependency (rỗng = dependency ổn). */
  dependencyErrors: string[];
  lastReason: string;
}

/** View-model panel plugin store. */
export interface FleetV19PluginStorePanel {
  at: number;
  total: number;
  byLifecycle: Record<string, number>;
  enabledWithHighRiskApproved: number;
  loadOrder: string[];
  /** true = thứ tự load tính được; false = có lỗi dependency (xem rows). */
  loadOrderOk: boolean;
  loadOrderError: string;
  plugins: FleetV19PluginStorePanelRow[];
  summary: string;
}

/** Build plugin store panel từ store plugin. */
export function buildFleetV19PluginStorePanel(
  store: PluginV19Store,
  at: number,
): FleetV19PluginStorePanel {
  const summary0 = summarizePluginV19Store(store);
  let loadOrder: string[] = [];
  let loadOrderOk = true;
  let loadOrderError = '';
  try {
    loadOrder = resolvePluginV19LoadOrder(store);
  } catch (err) {
    loadOrderOk = false;
    loadOrderError = err instanceof Error ? err.message : String(err);
  }
  const plugins: FleetV19PluginStorePanelRow[] = [...store.values()]
    .map((plugin: PluginV19Installed) => {
      const depErrors =
        plugin.lifecycle === 'uninstalled' ? [] : checkPluginV19Dependencies(store, plugin.manifest.id);
      return {
        pluginId: plugin.manifest.id,
        name: plugin.manifest.name,
        version: plugin.manifest.version,
        sdkVersion: plugin.manifest.sdkVersion,
        lifecycle: plugin.lifecycle,
        capabilities: plugin.manifest.capabilities.map(
          (c) => `${c.name}@${c.major}.${c.minor}`,
        ),
        permissions: [...plugin.manifest.permissions],
        approvedPermissions: [...plugin.approvedPermissions],
        unapprovedPermissions: plugin.manifest.permissions.filter(
          (p) => !plugin.approvedPermissions.includes(p),
        ),
        tools: [...plugin.manifest.tools],
        dependsOn: plugin.manifest.dependsOn.map((d) => `${d.id} ${d.versionRange}`),
        dependencyErrors: depErrors,
        lastReason: plugin.lastReason,
      };
    })
    .sort((a, b) => (a.pluginId < b.pluginId ? -1 : 1));
  const summary = `${summary0.total} plugin: ${summary0.byLifecycle.enabled} enabled, ${summary0.byLifecycle.disabled} disabled, ${summary0.byLifecycle.installed} installed, ${summary0.byLifecycle.uninstalled} uninstalled` +
    (loadOrderOk ? `, thứ tự load ${loadOrder.length} plugin` : ', lỗi thứ tự load');
  return {
    at,
    total: summary0.total,
    byLifecycle: { ...summary0.byLifecycle },
    enabledWithHighRiskApproved: summary0.enabledWithHighRiskApproved,
    loadOrder,
    loadOrderOk,
    loadOrderError,
    plugins,
    summary,
  };
}
