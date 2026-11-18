/**
 * Fleet v17 — quản lý fleet node: health check theo probe, capacity
 * tổng hợp, drain có kế hoạch di chuyển task, auto-scale rule,
 * node labels/taints (v1.20, Đội T6).
 *
 * Tầng trên của fleet v16 (`fleetV16/fleetV16.ts` — đăng ký node
 * bằng token, heartbeat stale 3 mức, phân phối tải 3 chiến lược,
 * vòng đời node) và fleet v15 (`fleetV15/fleetV15.ts` — health
 * scoring 0..100, capacity forecast, safe drain, rebalance).
 * V16 trả lời "node này có được vào fleet không, khỏe không, task
 * mới chạy ở đâu"; v17 trả lời 5 câu vận hành tiếp theo:
 *
 * - HEALTH CHECK THEO PROBE: ngoài heartbeat, v17 nhận kết quả
 *   probe chủ động (liveness/readiness do caller đo thật — ping
 *   agent, kiểm tra disk, kiểm tra model server) và tính điểm
 *   health 0..100 + mức `healthy/degraded/unhealthy/down` + lý do
 *   từng probe; probe fail liên tiếp → hạ mức ngay (không chờ
 *   heartbeat timeout).
 * - CAPACITY TỔNG HỢP: cộng dồn capacity + usage toàn fleet, tính
 *   headroom theo từng tài nguyên (CPU/RAM/disk/task slot), báo
 *   node nào là nút thắt; dự báo "còn nhận được bao nhiêu task
 *   cỡ trung bình nữa" trước khi hết chỗ.
 * - DRAIN CÓ KẾ HOẠCH: drain không chỉ đổi trạng thái — v17 lập
 *   kế hoạch di chuyển từng task đang chạy sang node đích đủ tài
 *   nguyên + khớp label/taint, task nào không có đích thì liệt kê
 *   riêng (caller quyết định chờ hay hủy); cancel drain trả node
 *   về active khi chưa di chuyển task nào.
 * - AUTO-SCALE RULE: rule đánh giá trên metric tổng hợp (vd CPU
 *   trung bình > 80% trong 5 phút → scale-up +1 node; < 20% trong
 *   15 phút → scale-down) kèm cooldown (không scale liên tiếp),
 *   giới hạn min/max node; rule chỉ RA QUYẾT ĐỊNH — việc tạo/xóa
 *   node thật do caller làm.
 * - LABELS/TAINTS: label kiểm định chặt (slug key/value, tối đa
 *   32 label/node); taint (`key=value:effect`, effect
 *   NoSchedule/NoExecute/PreferNoSchedule) — task có toleration
 *   khớp taint mới được xếp lên node; node có taint NoExecute thì
 *   task đang chạy không toleration phải di chuyển đi.
 *
 * Module này KHÔNG spawn process, KHÔNG chạm mạng, KHÔNG chạy
 * task thật: nó quyết định "node này khỏe mấy điểm, còn bao nhiêu
 * chỗ, task này di chuyển đi đâu, có nên scale không" — việc chạy/
 * chuyển task thật do caller làm.
 */

import type {
  FleetV14Node,
  FleetV14NodeCapacity,
  FleetV14Snapshot,
  FleetV14Task,
} from '../fleetV14/fleetV14';
import { FLEET_V14_NODE_HEALTHS } from '../fleetV14/fleetV14';
import type { FleetV14NodeHealth } from '../fleetV14/fleetV14';
import { checkFleetV16NodeHealth } from '../fleetV16/fleetV16';
import type { FleetV16HealthCheck } from '../fleetV16/fleetV16';

/** Số probe fail liên tiếp → hạ một mức health. */
export const FLEET_V17_PROBE_FAIL_STREAK_TO_DEGRADE = 2;
/** Số probe fail liên tiếp → unhealthy. */
export const FLEET_V17_PROBE_FAIL_STREAK_TO_UNHEALTHY = 5;
/** Số label tối đa mỗi node. */
export const FLEET_V17_MAX_LABELS_PER_NODE = 32;
/** Số taint tối đa mỗi node. */
export const FLEET_V17_MAX_TAINTS_PER_NODE = 16;
/** Cooldown mặc định giữa hai lần scale: 10 phút. */
export const FLEET_V17_DEFAULT_SCALE_COOLDOWN_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// Health check theo probe
// ---------------------------------------------------------------------------

/** Loại probe sức khỏe. */
export type FleetV17ProbeKind = 'liveness' | 'readiness' | 'disk' | 'model-server' | 'network';

export const FLEET_V17_PROBE_KINDS: readonly FleetV17ProbeKind[] = [
  'liveness',
  'readiness',
  'disk',
  'model-server',
  'network',
];

/** Kết quả một lần probe (do caller đo thật). */
export interface FleetV17ProbeResult {
  nodeId: string;
  kind: FleetV17ProbeKind;
  /** true = probe pass. */
  ok: boolean;
  /** Thời gian probe chạy (ms). */
  latencyMs: number;
  /** Chi tiết (vd `disk free 3.2GB`, `model server 200 OK`). */
  detail: string;
  at: number;
}

/** Lỗi validate probe, '' = hợp lệ. */
export function validateFleetV17ProbeResult(probe: FleetV17ProbeResult): string {
  if (typeof probe.nodeId !== 'string' || probe.nodeId.length === 0) return 'nodeId không được rỗng';
  if (!FLEET_V17_PROBE_KINDS.includes(probe.kind)) return `probe kind không hợp lệ: ${probe.kind}`;
  if (!Number.isFinite(probe.latencyMs) || probe.latencyMs < 0) return 'latencyMs phải >= 0';
  if (!Number.isFinite(probe.at) || probe.at <= 0) return 'at phải là epoch ms > 0';
  return '';
}

/** Kết quả health check v17 của một node. */
export interface FleetV17HealthCheck {
  nodeId: string;
  health: FleetV14NodeHealth;
  /** Điểm 0..100 (100 = hoàn toàn khỏe). */
  score: number;
  /** Số probe fail liên tiếp gần nhất. */
  consecutiveFailures: number;
  /** Probe fail gần nhất (null = chưa từng fail). */
  lastFailedProbe: FleetV17ProbeResult | null;
  reasons: string[];
  at: number;
}

/**
 * Tính điểm health từ các probe gần nhất của node: mỗi kind lấy
 * probe mới nhất; pass = đủ điểm, fail = 0 điểm cho kind đó;
 * trọng số: liveness 30, readiness 25, disk 20, model-server 15,
 * network 10. Probe fail liên tiếp hạ thêm: >= 2 lần → tối đa
 * `degraded`, >= 5 lần → `unhealthy` (dù điểm còn cao).
 */
export function checkFleetV17NodeHealth(
  node: FleetV14Node,
  probes: readonly FleetV17ProbeResult[],
  now = Date.now(),
): FleetV17HealthCheck {
  const nodeProbes = probes.filter((p) => p.nodeId === node.nodeId);
  const reasons: string[] = [];
  const weights: Record<FleetV17ProbeKind, number> = {
    liveness: 30,
    readiness: 25,
    disk: 20,
    'model-server': 15,
    network: 10,
  };
  let score = 0;
  let totalWeight = 0;
  for (const kind of FLEET_V17_PROBE_KINDS) {
    const latest = [...nodeProbes].filter((p) => p.kind === kind).sort((a, b) => b.at - a.at)[0];
    if (!latest) continue;
    totalWeight += weights[kind];
    if (latest.ok) {
      score += weights[kind];
    } else {
      reasons.push(`probe ${kind} fail: ${latest.detail}`);
    }
  }
  const normalized = totalWeight === 0 ? 100 : Math.round((score / totalWeight) * 100);
  // Số probe fail liên tiếp (theo thời gian, mọi kind gộp).
  const sorted = [...nodeProbes].sort((a, b) => b.at - a.at);
  let consecutiveFailures = 0;
  for (const p of sorted) {
    if (!p.ok) consecutiveFailures += 1;
    else break;
  }
  const lastFailedProbe = sorted.find((p) => !p.ok) ?? null;
  // Kết hợp với health theo heartbeat của v16 (lấy mức xấu hơn).
  const v16: FleetV16HealthCheck = checkFleetV16NodeHealth(node, null, 30 * 1000, now);
  let health: FleetV14NodeHealth =
    normalized >= 90 ? 'healthy' : normalized >= 60 ? 'degraded' : normalized >= 30 ? 'unhealthy' : 'down';
  if (consecutiveFailures >= FLEET_V17_PROBE_FAIL_STREAK_TO_UNHEALTHY) health = 'unhealthy';
  else if (consecutiveFailures >= FLEET_V17_PROBE_FAIL_STREAK_TO_DEGRADE && health === 'healthy') health = 'degraded';
  const order: FleetV14NodeHealth[] = ['healthy', 'degraded', 'unhealthy', 'down'];
  if (order.indexOf(v16.health) > order.indexOf(health)) {
    health = v16.health;
    reasons.push(`heartbeat: ${v16.reasons.join('; ')}`);
  }
  if (nodeProbes.length === 0) reasons.push('chưa có probe nào — health theo heartbeat');
  return { nodeId: node.nodeId, health, score: normalized, consecutiveFailures, lastFailedProbe, reasons, at: now };
}

/** Health check cho toàn fleet (chỉ node chưa removed). */
export function checkFleetV17Health(
  snapshot: FleetV14Snapshot,
  probes: readonly FleetV17ProbeResult[],
  now = Date.now(),
): FleetV17HealthCheck[] {
  return snapshot.nodes
    .filter((n) => n.status !== 'removed')
    .map((n) => checkFleetV17NodeHealth(n, probes, now));
}

// ---------------------------------------------------------------------------
// Capacity tổng hợp
// ---------------------------------------------------------------------------

/** Tài nguyên trống của một node (dựa trên capacity − usage). */
export function fleetV17NodeFree(node: FleetV14Node): FleetV14NodeCapacity {
  return {
    cpuCores: Math.max(0, node.capacity.cpuCores - node.usedCpuCores),
    ramTotalMb: Math.max(0, node.capacity.ramTotalMb - node.usedRamMb),
    vramTotalMb: Math.max(0, node.capacity.vramTotalMb - node.usedVramMb),
    diskTotalMb: node.capacity.diskTotalMb,
    maxTasks: Math.max(0, node.capacity.maxTasks - node.runningTaskIds.length),
  };
}

/** Capacity tổng hợp toàn fleet. */
export interface FleetV17CapacitySummary {
  nodeCount: number;
  activeNodeCount: number;
  totalCpuCores: number;
  freeCpuCores: number;
  totalRamMb: number;
  freeRamMb: number;
  totalDiskMb: number;
  freeTaskSlots: number;
  totalTaskSlots: number;
  runningTasks: number;
  /** Tài nguyên đang căng nhất (`cpu`/`ram`/`tasks`). */
  bottleneck: 'cpu' | 'ram' | 'tasks' | 'none';
  /** % tài nguyên đã dùng của bottleneck (0..1). */
  bottleneckUsage: number;
  /** Số task cỡ trung bình (2 core / 4GB RAM) còn nhận được. */
  mediumTasksHeadroom: number;
}

export function summarizeFleetV17Capacity(snapshot: FleetV14Snapshot): FleetV17CapacitySummary {
  const nodes = snapshot.nodes.filter((n) => n.status === 'active');
  let totalCpu = 0;
  let freeCpu = 0;
  let totalRam = 0;
  let freeRam = 0;
  let totalDisk = 0;
  let totalSlots = 0;
  let freeSlots = 0;
  let running = 0;
  for (const n of nodes) {
    totalCpu += n.capacity.cpuCores;
    freeCpu += Math.max(0, n.capacity.cpuCores - n.usedCpuCores);
    totalRam += n.capacity.ramTotalMb;
    freeRam += Math.max(0, n.capacity.ramTotalMb - n.usedRamMb);
    totalDisk += n.capacity.diskTotalMb;
    totalSlots += n.capacity.maxTasks;
    freeSlots += Math.max(0, n.capacity.maxTasks - n.runningTaskIds.length);
    running += n.runningTaskIds.length;
  }
  const cpuUsage = totalCpu === 0 ? 0 : 1 - freeCpu / totalCpu;
  const ramUsage = totalRam === 0 ? 0 : 1 - freeRam / totalRam;
  const taskUsage = totalSlots === 0 ? 0 : 1 - freeSlots / totalSlots;
  let bottleneck: FleetV17CapacitySummary['bottleneck'] = 'none';
  let bottleneckUsage = 0;
  if (cpuUsage >= ramUsage && cpuUsage >= taskUsage && cpuUsage > 0) {
    bottleneck = 'cpu';
    bottleneckUsage = cpuUsage;
  } else if (ramUsage >= taskUsage && ramUsage > 0) {
    bottleneck = 'ram';
    bottleneckUsage = ramUsage;
  } else if (taskUsage > 0) {
    bottleneck = 'tasks';
    bottleneckUsage = taskUsage;
  }
  const byCpu = Math.floor(freeCpu / 2);
  const byRam = Math.floor(freeRam / 4096);
  const mediumTasksHeadroom = Math.max(0, Math.min(byCpu, byRam, freeSlots));
  return {
    nodeCount: snapshot.nodes.filter((n) => n.status !== 'removed').length,
    activeNodeCount: nodes.length,
    totalCpuCores: totalCpu,
    freeCpuCores: Math.round(freeCpu * 100) / 100,
    totalRamMb: totalRam,
    freeRamMb: freeRam,
    totalDiskMb: totalDisk,
    freeTaskSlots: freeSlots,
    totalTaskSlots: totalSlots,
    runningTasks: running,
    bottleneck,
    bottleneckUsage: Math.round(bottleneckUsage * 1000) / 1000,
    mediumTasksHeadroom,
  };
}

// ---------------------------------------------------------------------------
// Labels / taints
// ---------------------------------------------------------------------------

/** Lỗi validate label map, '' = hợp lệ. */
export function validateFleetV17Labels(labels: Record<string, string>): string {
  const keys = Object.keys(labels);
  if (keys.length > FLEET_V17_MAX_LABELS_PER_NODE) {
    return `tối đa ${FLEET_V17_MAX_LABELS_PER_NODE} label mỗi node`;
  }
  for (const k of keys) {
    if (!/^[a-z0-9][a-z0-9._/-]{0,62}$/.test(k)) return `label key không hợp lệ: ${k}`;
    const v = labels[k];
    if (typeof v !== 'string' || v.length > 63 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(v)) {
      return `label value không hợp lệ cho ${k}: ${v}`;
    }
  }
  return '';
}

/** Hiệu ứng của taint. */
export type FleetV17TaintEffect = 'NoSchedule' | 'PreferNoSchedule' | 'NoExecute';

export const FLEET_V17_TAINT_EFFECTS: readonly FleetV17TaintEffect[] = [
  'NoSchedule',
  'PreferNoSchedule',
  'NoExecute',
];

/** Một taint trên node. */
export interface FleetV17Taint {
  key: string;
  value: string;
  effect: FleetV17TaintEffect;
}

/** Lỗi validate taint, '' = hợp lệ. */
export function validateFleetV17Taint(taint: FleetV17Taint): string {
  if (!/^[a-z0-9][a-z0-9._/-]{0,62}$/.test(taint.key)) return `taint key không hợp lệ: ${taint.key}`;
  if (typeof taint.value !== 'string' || taint.value.length > 63 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(taint.value)) {
    return `taint value không hợp lệ: ${taint.value}`;
  }
  if (!FLEET_V17_TAINT_EFFECTS.includes(taint.effect)) return `taint effect không hợp lệ: ${taint.effect}`;
  return '';
}

/** Hai taint trùng key+value+effect không. */
export function fleetV17TaintsEqual(a: FleetV17Taint, b: FleetV17Taint): boolean {
  return a.key === b.key && a.value === b.value && a.effect === b.effect;
}

/** Một toleration của task. */
export interface FleetV17Toleration {
  key: string;
  /** value rỗng = khớp mọi value của key đó. */
  value: string;
  effect: FleetV17TaintEffect | '';
}

/** Task có tolerate taint này không. */
export function fleetV17Tolerates(taint: FleetV17Taint, tolerations: readonly FleetV17Toleration[]): boolean {
  return tolerations.some(
    (t) =>
      t.key === taint.key &&
      (t.value === '' || t.value === taint.value) &&
      (t.effect === '' || t.effect === taint.effect),
  );
}

/**
 * Node có nhận task mới không theo taint: taint NoSchedule/NoExecute
 * mà task không tolerate → từ chối; PreferNoSchedule → vẫn nhận
 * nhưng bị trừ điểm khi chọn node (caller dùng `fleetV17TaintPenalty`).
 */
export function fleetV17NodeToleratesTask(
  taints: readonly FleetV17Taint[],
  tolerations: readonly FleetV17Toleration[],
): { allowed: boolean; blockingTaints: FleetV17Taint[] } {
  const blocking = taints.filter(
    (t) => (t.effect === 'NoSchedule' || t.effect === 'NoExecute') && !fleetV17Tolerates(t, tolerations),
  );
  return { allowed: blocking.length === 0, blockingTaints: blocking };
}

/** Điểm phạt khi node có taint PreferNoSchedule mà task không tolerate (0..1). */
export function fleetV17TaintPenalty(
  taints: readonly FleetV17Taint[],
  tolerations: readonly FleetV17Toleration[],
): number {
  const untolerated = taints.filter((t) => t.effect === 'PreferNoSchedule' && !fleetV17Tolerates(t, tolerations));
  return Math.min(1, untolerated.length * 0.25);
}

/** Node có khớp label selector của task không (phải khớp TẤT CẢ). */
export function fleetV17NodeMatchesLabels(
  nodeLabels: Record<string, string>,
  requiredLabels: Record<string, string>,
): boolean {
  return Object.entries(requiredLabels).every(([k, v]) => nodeLabels[k] === v);
}

// ---------------------------------------------------------------------------
// Drain có kế hoạch di chuyển task
// ---------------------------------------------------------------------------

/** Taints theo node (nodeId → taints) — v14 node không mang taint, caller giữ map riêng. */
export type FleetV17NodeTaints = Record<string, readonly FleetV17Taint[]>;

/** Toleration theo task (taskId → tolerations). */
export type FleetV17TaskTolerations = Record<string, readonly FleetV17Toleration[]>;

/** Một lần di chuyển task trong kế hoạch drain. */
export interface FleetV17DrainMove {
  taskId: string;
  fromNodeId: string;
  toNodeId: string;
  /** Lý do chọn node đích (vd `least-loaded, còn 6 core / 20GB`). */
  reason: string;
}

/** Task không di chuyển được + lý do. */
export interface FleetV17DrainBlocked {
  taskId: string;
  reason: string;
}

/** Kế hoạch drain một node. */
export interface FleetV17DrainPlan {
  nodeId: string;
  /** Di chuyển theo thứ tự ưu tiên giảm dần (task ưu tiên cao đi trước). */
  moves: FleetV17DrainMove[];
  /** Task không có node đích (caller quyết định chờ hay hủy). */
  unmovable: FleetV17DrainBlocked[];
  /** true = mọi task đều có đích (drain xong là node trống). */
  readyToComplete: boolean;
  at: number;
}

/**
 * Lập kế hoạch drain: task đang chạy trên node nguồn được xếp sang
 * node đích active (khác nguồn, không draining), khớp label,
 * tolerate taint của đích, đủ CPU/RAM/slot (tính cả các move đã
 * xếp trước trong cùng kế hoạch — tránh xếp chồng quá tải).
 * Task ưu tiên cao được xếp trước; task không có đích → `unmovable`.
 */
export function planFleetV17Drain(
  snapshot: FleetV14Snapshot,
  nodeId: string,
  nodeTaints: FleetV17NodeTaints = {},
  taskTolerations: FleetV17TaskTolerations = {},
  now = Date.now(),
): FleetV17DrainPlan {
  const source = snapshot.nodes.find((n) => n.nodeId === nodeId);
  if (!source) {
    return { nodeId, moves: [], unmovable: [], readyToComplete: false, at: now };
  }
  const running = snapshot.tasks
    .filter((t) => t.nodeId === nodeId && t.status === 'running')
    .map((t) => t.task)
    .sort((a, b) => b.priority - a.priority);
  // Tài nguyên còn trống theo node đích (trừ dần khi xếp move).
  const freeByNode = new Map<string, { cpu: number; ram: number; slots: number }>();
  const candidates = snapshot.nodes.filter(
    (n) => n.nodeId !== nodeId && n.status === 'active' && n.drainStartedAt === null,
  );
  for (const n of candidates) {
    const free = fleetV17NodeFree(n);
    freeByNode.set(n.nodeId, { cpu: free.cpuCores, ram: free.ramTotalMb, slots: free.maxTasks });
  }
  const moves: FleetV17DrainMove[] = [];
  const unmovable: FleetV17DrainBlocked[] = [];
  for (const task of running) {
    const tolerations = taskTolerations[task.taskId] ?? [];
    let best: FleetV14Node | null = null;
    let bestLoad = Number.POSITIVE_INFINITY;
    let bestReason = '';
    for (const n of candidates) {
      if (task.allowedNodeIds.length > 0 && !task.allowedNodeIds.includes(n.nodeId)) continue;
      if (!fleetV17NodeMatchesLabels(n.labels, task.requiredLabels)) continue;
      const taintCheck = fleetV17NodeToleratesTask(nodeTaints[n.nodeId] ?? [], tolerations);
      if (!taintCheck.allowed) continue;
      const free = freeByNode.get(n.nodeId);
      if (!free || free.cpu < task.cpuCores || free.ram < task.ramMb || free.slots < 1) continue;
      const load = n.capacity.cpuCores === 0 ? 1 : n.usedCpuCores / n.capacity.cpuCores;
      const penalty = fleetV17TaintPenalty(nodeTaints[n.nodeId] ?? [], tolerations);
      const score = load + penalty;
      if (score < bestLoad) {
        bestLoad = score;
        best = n;
        bestReason = `least-loaded (cpu ${(load * 100).toFixed(0)}%), còn ${free.cpu.toFixed(1)} core / ${Math.round(free.ram)}MB`;
      }
    }
    if (!best) {
      unmovable.push({ taskId: task.taskId, reason: 'không có node đích đủ tài nguyên + khớp label/taint' });
      continue;
    }
    const free = freeByNode.get(best.nodeId);
    if (free) {
      free.cpu -= task.cpuCores;
      free.ram -= task.ramMb;
      free.slots -= 1;
    }
    moves.push({ taskId: task.taskId, fromNodeId: nodeId, toNodeId: best.nodeId, reason: bestReason });
  }
  return { nodeId, moves, unmovable, readyToComplete: unmovable.length === 0, at: now };
}

/** Task đang chạy trên node có taint NoExecute mà không tolerate → phải di chuyển đi. */
export function fleetV17NoExecuteEvictions(
  snapshot: FleetV14Snapshot,
  nodeTaints: FleetV17NodeTaints,
  taskTolerations: FleetV17TaskTolerations,
): { nodeId: string; taskId: string; taint: FleetV17Taint }[] {
  const out: { nodeId: string; taskId: string; taint: FleetV17Taint }[] = [];
  for (const allocated of snapshot.tasks) {
    if (allocated.status !== 'running') continue;
    const taints = nodeTaints[allocated.nodeId] ?? [];
    const tolerations = taskTolerations[allocated.task.taskId] ?? [];
    for (const taint of taints) {
      if (taint.effect === 'NoExecute' && !fleetV17Tolerates(taint, tolerations)) {
        out.push({ nodeId: allocated.nodeId, taskId: allocated.task.taskId, taint });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Auto-scale rule
// ---------------------------------------------------------------------------

/** Metric tổng hợp mà rule đánh giá. */
export type FleetV17ScaleMetric = 'cpu' | 'ram' | 'tasks';

/** Hướng scale. */
export type FleetV17ScaleDirection = 'up' | 'down' | 'none';

/** Một rule auto-scale. */
export interface FleetV17ScaleRule {
  ruleId: string;
  name: string;
  /** Metric đánh giá (tính trên capacity summary: % đã dùng). */
  metric: FleetV17ScaleMetric;
  /** Vượt ngưỡng này (0..1) trong `durationMs` → scale-up. */
  thresholdUp: number;
  /** Dưới ngưỡng này (0..1) trong `durationMs` → scale-down. */
  thresholdDown: number;
  /** Metric phải giữ vượt/dưới ngưỡng liên tục trong khoảng này. */
  durationMs: number;
  /** Số node thêm khi scale-up. */
  scaleUpBy: number;
  /** Số node bớt khi scale-down. */
  scaleDownBy: number;
  /** Số node tối thiểu / tối đa của fleet. */
  minNodes: number;
  maxNodes: number;
  /** Ms tối thiểu giữa hai lần scale (mặc định 10 phút). */
  cooldownMs: number;
  enabled: boolean;
}

/** Lỗi validate rule, '' = hợp lệ. */
export function validateFleetV17ScaleRule(rule: FleetV17ScaleRule): string {
  if (rule.ruleId.trim() === '') return 'ruleId không được rỗng';
  if (!['cpu', 'ram', 'tasks'].includes(rule.metric)) return `metric không hợp lệ: ${rule.metric}`;
  if (!(rule.thresholdUp > 0 && rule.thresholdUp <= 1)) return 'thresholdUp phải trong (0, 1]';
  if (!(rule.thresholdDown >= 0 && rule.thresholdDown < 1)) return 'thresholdDown phải trong [0, 1)';
  if (rule.thresholdDown >= rule.thresholdUp) return 'thresholdDown phải < thresholdUp';
  if (!Number.isFinite(rule.durationMs) || rule.durationMs <= 0) return 'durationMs phải > 0';
  if (!Number.isInteger(rule.scaleUpBy) || rule.scaleUpBy < 1) return 'scaleUpBy phải là số nguyên >= 1';
  if (!Number.isInteger(rule.scaleDownBy) || rule.scaleDownBy < 1) return 'scaleDownBy phải là số nguyên >= 1';
  if (!Number.isInteger(rule.minNodes) || rule.minNodes < 0) return 'minNodes phải là số nguyên >= 0';
  if (!Number.isInteger(rule.maxNodes) || rule.maxNodes < rule.minNodes) return 'maxNodes phải >= minNodes';
  if (!Number.isFinite(rule.cooldownMs) || rule.cooldownMs < 0) return 'cooldownMs phải >= 0';
  return '';
}

/** Một mẫu metric tổng hợp theo thời gian. */
export interface FleetV17MetricSample {
  at: number;
  /** % tài nguyên đã dùng (0..1). */
  value: number;
}

/** Quyết định scale của một rule. */
export interface FleetV17ScaleDecision {
  ruleId: string;
  direction: FleetV17ScaleDirection;
  /** Số node thêm/bớt (0 khi `none`). */
  by: number;
  /** Giá trị metric hiện tại (0..1). */
  metricValue: number;
  /** Số node hiện tại / giới hạn áp dụng. */
  currentNodes: number;
  reason: string;
  at: number;
}

/**
 * Đánh giá một rule trên các mẫu metric gần nhất: scale-up khi
 * MỌI mẫu trong `durationMs` đều >= thresholdUp (và chưa chạm
 * maxNodes); scale-down khi MỌI mẫu đều <= thresholdDown (và chưa
 * chạm minNodes). Trong cooldown sau lần scale trước → `none`.
 * Rule chỉ RA QUYẾT ĐỊNH — tạo/xóa node thật do caller làm.
 */
export function evaluateFleetV17ScaleRule(
  rule: FleetV17ScaleRule,
  summary: FleetV17CapacitySummary,
  samples: readonly FleetV17MetricSample[],
  lastScaleAt: number | null,
  now = Date.now(),
): FleetV17ScaleDecision {
  const metricValue =
    rule.metric === 'cpu'
      ? summary.totalCpuCores === 0
        ? 0
        : 1 - summary.freeCpuCores / summary.totalCpuCores
      : rule.metric === 'ram'
        ? summary.totalRamMb === 0
          ? 0
          : 1 - summary.freeRamMb / summary.totalRamMb
        : summary.totalTaskSlots === 0
          ? 0
          : 1 - summary.freeTaskSlots / summary.totalTaskSlots;
  const base: Omit<FleetV17ScaleDecision, 'direction' | 'by' | 'reason'> = {
    ruleId: rule.ruleId,
    metricValue: Math.round(metricValue * 1000) / 1000,
    currentNodes: summary.activeNodeCount,
    at: now,
  };
  if (!rule.enabled) return { ...base, direction: 'none', by: 0, reason: 'rule đã tắt' };
  if (lastScaleAt !== null && now - lastScaleAt < rule.cooldownMs) {
    return { ...base, direction: 'none', by: 0, reason: `đang cooldown (còn ${rule.cooldownMs - (now - lastScaleAt)}ms)` };
  }
  const windowStart = now - rule.durationMs;
  const recent = samples.filter((s) => s.at >= windowStart && s.at <= now);
  if (recent.length === 0) {
    return { ...base, direction: 'none', by: 0, reason: 'chưa có mẫu metric trong cửa sổ đánh giá' };
  }
  if (recent.every((s) => s.value >= rule.thresholdUp)) {
    if (summary.activeNodeCount >= rule.maxNodes) {
      return { ...base, direction: 'none', by: 0, reason: `đã chạm maxNodes (${rule.maxNodes})` };
    }
    return {
      ...base,
      direction: 'up',
      by: Math.min(rule.scaleUpBy, rule.maxNodes - summary.activeNodeCount),
      reason: `${rule.metric} >= ${rule.thresholdUp} liên tục ${rule.durationMs}ms`,
    };
  }
  if (recent.every((s) => s.value <= rule.thresholdDown)) {
    if (summary.activeNodeCount <= rule.minNodes) {
      return { ...base, direction: 'none', by: 0, reason: `đã chạm minNodes (${rule.minNodes})` };
    }
    return {
      ...base,
      direction: 'down',
      by: Math.min(rule.scaleDownBy, summary.activeNodeCount - rule.minNodes),
      reason: `${rule.metric} <= ${rule.thresholdDown} liên tục ${rule.durationMs}ms`,
    };
  }
  return { ...base, direction: 'none', by: 0, reason: 'metric chưa vượt ngưỡng liên tục đủ lâu' };
}
