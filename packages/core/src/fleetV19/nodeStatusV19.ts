/**
 * Node status v19 — trạng thái vòng đời + tải của fleet node
 * (v1.29, Đội T6).
 *
 * Tầng trên của vòng đời node v14/v16 (`fleetV14` — đăng ký node,
 * heartbeat, status joining/active/draining/maintenance/down/removed;
 * `fleetV16` — heartbeat stale 3 mức) và health v17 (probe scoring).
 * V14/v16 trả lời "node đang ở trạng thái nào"; v19 trả lời 5 câu vận
 * hành tiếp theo:
 *
 * - CHUYỂN TRẠNG THÁI HỢP LỆ: bảng chuyển đổi cho phép (vd active →
 *   draining được, removed → active không được, down → active chỉ qua
 *   rejoin có kiểm tra); chuyển sai → lỗi rõ ràng kèm trạng thái đích
 *   hợp lệ — chống UI bấm nhầm làm node "sống lại" từ removed.
 * - HEARTBEAT STALE 4 MỨC: fresh / stale / very-stale / lost (ngưỡng
 *   30s / 5 phút / 30 phút) — v16 chỉ có 3 mức; mức lost là tín hiệu
 *   để auto-drain task khỏi node.
 * - ÁP LỰC TÀI NGUYÊN: từ used/total từng loại (cpu/ram/disk/task)
 *   tính utilization + mức pressure (ok/warm/hot/critical) theo ngưỡng
 *   70/85/95% — node hot + health degrading = ứng viên drain đầu tiên.
 * - XẾP HẠNG NODE (RANKING): điểm placement 0..100 cho mỗi node
 *   (health tốt + tải thấp + heartbeat fresh = cao); UI và job queue
 *   dùng chung để chọn node đích, thay vì mỗi nơi một công thức.
 * - SNAPSHOT TRẠNG THÁI: tóm tắt toàn fleet theo status/health/
 *   pressure (số node mỗi nhóm, node cần chú ý), để panel node status
 *   render một bảng duy nhất.
 *
 * Module này KHÔNG nhận heartbeat thật, KHÔNG chạm mạng: nó nhận
 * snapshot node + thời điểm hiện tại và quyết định trạng thái/tải/
 * thứ hạng — việc đo heartbeat và cập nhật snapshot do caller làm.
 */

import type {
  FleetV14Node,
  FleetV14NodeHealth,
  FleetV14NodeStatus,
} from '../fleetV14/fleetV14';
import { FLEET_V14_NODE_STATUSES } from '../fleetV14/fleetV14';

/** Heartbeat < 30s → fresh. */
export const FLEET_V19_HEARTBEAT_FRESH_MS = 30 * 1000;
/** Heartbeat < 5 phút → stale. */
export const FLEET_V19_HEARTBEAT_STALE_MS = 5 * 60 * 1000;
/** Heartbeat < 30 phút → very-stale; quá nữa → lost. */
export const FLEET_V19_HEARTBEAT_VERY_STALE_MS = 30 * 60 * 1000;
/** Ngưỡng pressure: >= 70% warm, >= 85% hot, >= 95% critical. */
export const FLEET_V19_PRESSURE_WARM = 0.7;
export const FLEET_V19_PRESSURE_HOT = 0.85;
export const FLEET_V19_PRESSURE_CRITICAL = 0.95;

// ---------------------------------------------------------------------------
// Chuyển trạng thái vòng đời
// ---------------------------------------------------------------------------

/** Bảng chuyển trạng thái cho phép (trạng thái nguồn -> các đích hợp lệ). */
export const FLEET_V19_STATUS_TRANSITIONS: Record<FleetV14NodeStatus, readonly FleetV14NodeStatus[]> = {
  joining: ['active', 'down', 'removed'],
  active: ['draining', 'maintenance', 'down', 'removed'],
  draining: ['active', 'maintenance', 'down', 'removed'],
  maintenance: ['active', 'draining', 'down', 'removed'],
  down: ['joining', 'removed'],
  removed: [],
};

/** true = được phép chuyển từ `from` sang `to`. */
export function canFleetV19Transition(
  from: FleetV14NodeStatus,
  to: FleetV14NodeStatus,
): boolean {
  return (FLEET_V19_STATUS_TRANSITIONS[from] ?? []).includes(to);
}

/** Các trạng thái đích hợp lệ từ `from` (để UI chỉ hiện nút hợp lệ). */
export function fleetV19AllowedTransitions(from: FleetV14NodeStatus): FleetV14NodeStatus[] {
  return [...(FLEET_V19_STATUS_TRANSITIONS[from] ?? [])];
}

/**
 * Chuyển trạng thái một node trong snapshot (trả node mới, không mutate):
 * chuyển không hợp lệ → throw kèm danh sách đích hợp lệ. Chuyển sang
 * draining ghi drainStartedAt + maintenanceReason; chuyển về active
 * từ draining/maintenance xóa drainStartedAt; chuyển sang removed giữ
 * nguyên các field khác (lịch sử còn đó, chỉ không tính vào fleet nữa).
 */
export function transitionFleetV19NodeStatus(
  node: FleetV14Node,
  to: FleetV14NodeStatus,
  at: number,
  reason = '',
): FleetV14Node {
  if (!canFleetV19Transition(node.status, to)) {
    const allowed = fleetV19AllowedTransitions(node.status);
    throw new Error(
      `không chuyển được node ${node.nodeId} từ ${node.status} sang ${to}` +
        (allowed.length > 0 ? ` (chỉ được: ${allowed.join(', ')})` : ' (node đã removed, không chuyển được nữa)'),
    );
  }
  const next: FleetV14Node = { ...node, status: to };
  if (to === 'draining') {
    next.drainStartedAt = at;
    next.maintenanceReason = reason;
  } else if (to === 'active') {
    next.drainStartedAt = null;
    next.maintenanceReason = '';
  } else if (to === 'maintenance') {
    next.maintenanceReason = reason;
  }
  return next;
}

// ---------------------------------------------------------------------------
// Heartbeat staleness
// ---------------------------------------------------------------------------

/** Mức độ cũ của heartbeat. */
export type FleetV19HeartbeatStaleness = 'fresh' | 'stale' | 'very-stale' | 'lost' | 'never';

/** Tính mức stale của heartbeat tại `at` (null = chưa từng heartbeat). */
export function fleetV19HeartbeatStaleness(
  lastHeartbeatAt: number | null,
  at: number,
): FleetV19HeartbeatStaleness {
  if (lastHeartbeatAt === null) return 'never';
  const age = at - lastHeartbeatAt;
  if (age < 0) return 'fresh';
  if (age < FLEET_V19_HEARTBEAT_FRESH_MS) return 'fresh';
  if (age < FLEET_V19_HEARTBEAT_STALE_MS) return 'stale';
  if (age < FLEET_V19_HEARTBEAT_VERY_STALE_MS) return 'very-stale';
  return 'lost';
}

/** true = heartbeat đã mất (lost/never) — node coi như không liên lạc được. */
export function fleetV19HeartbeatLost(
  lastHeartbeatAt: number | null,
  at: number,
): boolean {
  const level = fleetV19HeartbeatStaleness(lastHeartbeatAt, at);
  return level === 'lost' || level === 'never';
}

// ---------------------------------------------------------------------------
// Áp lực tài nguyên (pressure)
// ---------------------------------------------------------------------------

/** Mức áp lực của một tài nguyên. */
export type FleetV19Pressure = 'ok' | 'warm' | 'hot' | 'critical';

/** Mức pressure từ utilization 0..1. */
export function fleetV19PressureOf(utilization: number): FleetV19Pressure {
  if (utilization >= FLEET_V19_PRESSURE_CRITICAL) return 'critical';
  if (utilization >= FLEET_V19_PRESSURE_HOT) return 'hot';
  if (utilization >= FLEET_V19_PRESSURE_WARM) return 'warm';
  return 'ok';
}

/** Utilization + pressure từng tài nguyên của một node. */
export interface FleetV19NodePressure {
  nodeId: string;
  cpu: number;
  ram: number;
  diskUsed: number;
  tasks: number;
  /** Tài nguyên căng nhất (cpu/ram/disk/tasks). */
  tightest: 'cpu' | 'ram' | 'disk' | 'tasks';
  tightestUtilization: number;
  /** Mức pressure chung = mức của tài nguyên căng nhất. */
  pressure: FleetV19Pressure;
}

/**
 * Tính pressure của node. diskUsed = 1 - diskFree/total (caller truyền
 * diskFreeMb thực đo; total 0 → coi như 0 để không báo sai khi node
 * không khai disk). Task fraction = running/maxTasks.
 */
export function fleetV19NodePressure(
  node: FleetV14Node,
  diskFreeMb: number,
): FleetV19NodePressure {
  const cpu = node.capacity.cpuCores > 0 ? node.usedCpuCores / node.capacity.cpuCores : 0;
  const ram = node.capacity.ramTotalMb > 0 ? node.usedRamMb / node.capacity.ramTotalMb : 0;
  const diskUsed =
    node.capacity.diskTotalMb > 0
      ? Math.max(0, Math.min(1, 1 - diskFreeMb / node.capacity.diskTotalMb))
      : 0;
  const tasks =
    node.capacity.maxTasks > 0 ? node.runningTaskIds.length / node.capacity.maxTasks : 0;
  const entries: { key: FleetV19NodePressure['tightest']; value: number }[] = [
    { key: 'cpu', value: cpu },
    { key: 'ram', value: ram },
    { key: 'disk', value: diskUsed },
    { key: 'tasks', value: tasks },
  ];
  let tightest = entries[0];
  for (const e of entries) if (e.value > tightest.value) tightest = e;
  const round = (n: number): number => Math.round(n * 1000) / 1000;
  return {
    nodeId: node.nodeId,
    cpu: round(cpu),
    ram: round(ram),
    diskUsed: round(diskUsed),
    tasks: round(tasks),
    tightest: tightest.key,
    tightestUtilization: round(tightest.value),
    pressure: fleetV19PressureOf(tightest.value),
  };
}

// ---------------------------------------------------------------------------
// Xếp hạng node (placement ranking)
// ---------------------------------------------------------------------------

/** Điểm xếp hạng của một node để chọn nơi chạy job mới. */
export interface FleetV19NodeRank {
  nodeId: string;
  /** Điểm 0..100 (cao = nên chọn). */
  score: number;
  /** Node có được chọn không (false = loại vì status/health/heartbeat). */
  eligible: boolean;
  /** Lý do loại ('' = đủ điều kiện). */
  ineligibleReason: string;
  /** Thành phần điểm (để UI giải thích). */
  parts: { health: number; load: number; heartbeat: number };
}

/** Điểm health theo mức (điểm health 0..100 được quy về thang này). */
const HEALTH_POINTS: Record<FleetV14NodeHealth, number> = {
  healthy: 40,
  degraded: 22,
  unhealthy: 8,
  down: 0,
};

/**
 * Xếp hạng các node để chạy job mới:
 * - score = health (tối đa 40, theo mức + điểm health) + load (tối đa
 *   35, tải càng thấp càng cao) + heartbeat (tối đa 25, fresh cao nhất);
 * - node không active / health down / heartbeat lost → ineligible
 *   (score vẫn tính để UI thấy "gần được chọn" nhưng không chọn);
 * - trả về theo score giảm dần, hòa thì nodeId nhỏ trước.
 */
export function rankFleetV19Nodes(
  nodes: readonly FleetV14Node[],
  healthByNode: ReadonlyMap<string, number> | Record<string, number>,
  pressureByNode: ReadonlyMap<string, FleetV19NodePressure> | Record<string, FleetV19NodePressure>,
  at: number,
): FleetV19NodeRank[] {
  const scoreOf = (
    map: ReadonlyMap<string, number> | Record<string, number>,
    nodeId: string,
  ): number | undefined => {
    if (map instanceof Map) return map.get(nodeId);
    return (map as Record<string, number>)[nodeId];
  };
  const pressureOf = (
    map: ReadonlyMap<string, FleetV19NodePressure> | Record<string, FleetV19NodePressure>,
    nodeId: string,
  ): FleetV19NodePressure | undefined => {
    if (map instanceof Map) return map.get(nodeId);
    return (map as Record<string, FleetV19NodePressure>)[nodeId];
  };
  const ranks: FleetV19NodeRank[] = nodes.map((node) => {
    const healthScore = scoreOf(healthByNode, node.nodeId);
    const pressure = pressureOf(pressureByNode, node.nodeId);
    const staleness = fleetV19HeartbeatStaleness(node.lastHeartbeatAt, at);
    const healthPart =
      HEALTH_POINTS[node.health] * (healthScore === undefined ? 0.5 : healthScore / 100);
    const loadPart = pressure === undefined ? 17.5 : (1 - pressure.tightestUtilization) * 35;
    const heartbeatPart =
      staleness === 'fresh' ? 25 : staleness === 'stale' ? 15 : staleness === 'very-stale' ? 5 : 0;
    const score = Math.round((healthPart + loadPart + heartbeatPart) * 10) / 10;
    let ineligibleReason = '';
    if (node.status !== 'active') ineligibleReason = `node không active (đang ${node.status})`;
    else if (node.health === 'down') ineligibleReason = 'node đang down';
    else if (staleness === 'lost' || staleness === 'never') ineligibleReason = 'mất heartbeat';
    return {
      nodeId: node.nodeId,
      score,
      eligible: ineligibleReason === '',
      ineligibleReason,
      parts: {
        health: Math.round(healthPart * 10) / 10,
        load: Math.round(loadPart * 10) / 10,
        heartbeat: heartbeatPart,
      },
    };
  });
  return ranks.sort((a, b) => b.score - a.score || (a.nodeId < b.nodeId ? -1 : 1));
}

// ---------------------------------------------------------------------------
// Snapshot trạng thái toàn fleet
// ---------------------------------------------------------------------------

/** Một node cần chú ý trong snapshot (để panel tô đỏ). */
export interface FleetV19AttentionNode {
  nodeId: string;
  reasons: string[];
}

/** Tóm tắt trạng thái toàn fleet. */
export interface FleetV19StatusSnapshot {
  at: number;
  total: number;
  byStatus: Record<FleetV14NodeStatus, number>;
  byHealth: Record<FleetV14NodeHealth, number>;
  byPressure: Record<FleetV19Pressure, number>;
  byStaleness: Record<FleetV19HeartbeatStaleness, number>;
  /** Số node active và đủ điều kiện nhận job. */
  eligibleCount: number;
  /** Số node đang chạy task. */
  busyCount: number;
  attention: FleetV19AttentionNode[];
}

/** Tính snapshot trạng thái từ danh sách node + pressure + ranking. */
export function summarizeFleetV19Status(
  nodes: readonly FleetV14Node[],
  pressureByNode: ReadonlyMap<string, FleetV19NodePressure> | Record<string, FleetV19NodePressure>,
  ranks: readonly FleetV19NodeRank[],
  at: number,
): FleetV19StatusSnapshot {
  const byStatus: Record<FleetV14NodeStatus, number> = {
    joining: 0,
    active: 0,
    draining: 0,
    maintenance: 0,
    down: 0,
    removed: 0,
  };
  const byHealth: Record<FleetV14NodeHealth, number> = {
    healthy: 0,
    degraded: 0,
    unhealthy: 0,
    down: 0,
  };
  const byPressure: Record<FleetV19Pressure, number> = {
    ok: 0,
    warm: 0,
    hot: 0,
    critical: 0,
  };
  const byStaleness: Record<FleetV19HeartbeatStaleness, number> = {
    fresh: 0,
    stale: 0,
    'very-stale': 0,
    lost: 0,
    never: 0,
  };
  const pressureOf = (nodeId: string): FleetV19NodePressure | undefined => {
    if (pressureByNode instanceof Map) return pressureByNode.get(nodeId);
    return (pressureByNode as Record<string, FleetV19NodePressure>)[nodeId];
  };
  const eligible = new Set(ranks.filter((r) => r.eligible).map((r) => r.nodeId));
  const attention: FleetV19AttentionNode[] = [];
  let busyCount = 0;
  for (const node of nodes) {
    byStatus[node.status]++;
    byHealth[node.health]++;
    const pressure = pressureOf(node.nodeId);
    if (pressure) byPressure[pressure.pressure]++;
    const staleness = fleetV19HeartbeatStaleness(node.lastHeartbeatAt, at);
    byStaleness[staleness]++;
    if (node.runningTaskIds.length > 0) busyCount++;
    const reasons: string[] = [];
    if (node.health === 'unhealthy' || node.health === 'down') reasons.push(`health ${node.health}`);
    if (pressure && pressure.pressure === 'critical') reasons.push(`tài nguyên ${pressure.tightest} quá tải`);
    if (staleness === 'lost' || staleness === 'never') reasons.push('mất heartbeat');
    if (node.status === 'down') reasons.push('node down');
    if (node.status === 'draining' && node.runningTaskIds.length > 0) {
      reasons.push(`đang drain, còn ${node.runningTaskIds.length} task`);
    }
    if (reasons.length > 0) attention.push({ nodeId: node.nodeId, reasons });
  }
  attention.sort((a, b) => b.reasons.length - a.reasons.length || (a.nodeId < b.nodeId ? -1 : 1));
  return {
    at,
    total: nodes.length,
    byStatus,
    byHealth,
    byPressure,
    byStaleness,
    eligibleCount: eligible.size,
    busyCount,
    attention,
  };
}

/** Kiểm tra một node có nên auto-drain không: mất heartbeat + còn task chạy. */
export function fleetV19ShouldAutoDrain(node: FleetV14Node, at: number): boolean {
  return (
    node.status === 'active' &&
    fleetV19HeartbeatLost(node.lastHeartbeatAt, at) &&
    node.runningTaskIds.length > 0
  );
}

/** Liệt kê node đã down quá lâu (đề xuất remove): down + lastHeartbeat quá removeAfterMs. */
export function listFleetV19StaleDownNodes(
  nodes: readonly FleetV14Node[],
  at: number,
  removeAfterMs: number,
): FleetV14Node[] {
  return nodes.filter(
    (n) =>
      n.status === 'down' &&
      n.lastHeartbeatAt !== null &&
      at - n.lastHeartbeatAt >= removeAfterMs,
  );
}

// Re-export để các module khác dùng chung mà không import sâu vào fleetV14.
export { FLEET_V14_NODE_STATUSES };
