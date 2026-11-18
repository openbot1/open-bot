/**
 * Fleet v14 — quản lý fleet node: đăng ký node, health check, phân bổ
 * task theo tải, drain node khi bảo trì (v1.17, Đội T6).
 *
 * Tầng trên của fleet v13 (`fleetV13/fleetV13.ts` — pin model theo
 * RAM/VRAM, health check từ sample, capacity report, rebalance gợi
 * ý, event log) và node maintenance v12 (`fleet/nodeMaintenance.ts`).
 * V13 trả lời "node này có chạy nổi model đó không, fleet còn chỗ
 * không"; v14 trả lời "node này LÀ AI trong fleet, nó còn sống
 * không, task mới nên chạy ở ĐÂU, và làm sao rút node ra bảo trì
 * mà không làm rơi task đang chạy":
 *
 * - Đăng ký node: mỗi node có id, hostname, labels (vd
 *   `gpu=true,region=home`), capacity (CPU cores, RAM, VRAM, disk,
 *   max task đồng thời), đăng ký lần đầu ở trạng thái `joining` rồi
 *   `active` khi heartbeat đầu tiên tới. Đăng ký trùng id với
 *   fingerprint khác → từ chối (tránh hai máy cùng id); cùng
 *   fingerprint → coi là re-register (node restart) và giữ lại task
 *   đang chạy của nó.
 * - Health check: từ sample (heartbeat age, CPU/RAM/VRAM %, disk
 *   free, số task lỗi gần đây) → trạng thái `healthy/degraded/
 *   unhealthy/down` + lý do từng điều kiện (như v13) + thêm
 *   `draining` (đang rút) và `maintenance` (đang bảo trì, không
 *   nhận task). Lịch sử health mỗi node giữ N sample gần nhất để
 *   vẽ trend; node `down` quá lâu → đề xuất remove.
 * - Phân bổ task theo tải: task khai CPU/RAM/VRAM cần + độ ưu tiên
 *   + có thể chạy trên node nào (label selector). `allocateTask`
 *   chấm điểm từng node đủ điều kiện: vừa tài nguyên, vừa số task
 *   tối đa, điểm = tải hiện tại (thấp thắng) + khớp label (khớp
 *   nhiều thắng) + node khỏe thắng; hòa thì node ít task hơn thắng,
 *   cuối cùng là nodeId nhỏ hơn (xác định, test được). Trả lý do
 *   khi không node nào nhận được (thiếu RAM bao nhiêu, label nào
 *   không khớp...).
 * - Drain node khi bảo trì: `drainNode` chuyển node sang `draining`,
 *   chặn task mới, và lập KẾ HOẠCH DI CHUYỂN cho từng task đang chạy
 *   (task nào chuyển được sang node nào — dùng cùng bộ chấm điểm;
 *   task nào không chuyển được thì ghi rõ lý do, caller quyết định
 *   giữ lại hay hủy). `completeDrain` chỉ cho phép khi không còn
 *   task nào (hoặc toàn bộ task đã có kế hoạch chuyển), rồi node
 *   sang `maintenance`. `undrainNode` đưa node về `active`.
 *
 * Module này KHÔNG spawn process, KHÔNG chạm mạng, KHÔNG chạy task
 * thật: nó quyết định "node nào, khỏe không, task đi đâu" — việc
 * chạy/chuyển task thật do FleetServiceManager / caller làm.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** File snapshot fleet v14 trong fleet root. */
export const FLEET_V14_SNAPSHOT_FILE = 'fleet-v117.json';
/** File event log fleet v14 trong fleet root. */
export const FLEET_V14_EVENTS_FILE = 'fleet-events-v117.jsonl';
/** Số node tối đa trong một fleet snapshot. */
export const FLEET_V14_MAX_NODES = 200;
/** Số task tối đa trong một fleet snapshot. */
export const FLEET_V14_MAX_TASKS = 5000;
/** Số event tối đa giữ trong bộ nhớ (file giữ toàn bộ). */
export const FLEET_V14_MAX_EVENTS = 5000;
/** Số health sample giữ mỗi node (để vẽ trend). */
export const FLEET_V14_MAX_HEALTH_SAMPLES = 100;
/** Heartbeat quá 5 phút → node down. */
export const FLEET_V14_HEARTBEAT_TIMEOUT_MS = 5 * 60 * 1000;
/** Node down quá 24 giờ → đề xuất remove. */
export const FLEET_V14_DOWN_REMOVE_AFTER_MS = 24 * 60 * 60 * 1000;
/** Ngưỡng degraded: CPU/RAM/VRAM >= 75%. */
export const FLEET_V14_DEGRADED_THRESHOLD = 0.75;
/** Ngưỡng unhealthy: CPU/RAM/VRAM >= 90%. */
export const FLEET_V14_UNHEALTHY_THRESHOLD = 0.9;
/** Disk free dưới 5 GB → unhealthy; dưới 10 GB → degraded. */
export const FLEET_V14_DISK_UNHEALTHY_MB = 5 * 1024;
export const FLEET_V14_DISK_DEGRADED_MB = 10 * 1024;

/** Trạng thái vòng đời của một fleet node. */
export type FleetV14NodeStatus =
  | 'joining'
  | 'active'
  | 'draining'
  | 'maintenance'
  | 'down'
  | 'removed';

export const FLEET_V14_NODE_STATUSES: readonly FleetV14NodeStatus[] = [
  'joining',
  'active',
  'draining',
  'maintenance',
  'down',
  'removed',
];

/** Trạng thái sức khỏe node v14. */
export type FleetV14NodeHealth = 'healthy' | 'degraded' | 'unhealthy' | 'down';

export const FLEET_V14_NODE_HEALTHS: readonly FleetV14NodeHealth[] = [
  'healthy',
  'degraded',
  'unhealthy',
  'down',
];

/** Capacity khai báo của một node. */
export interface FleetV14NodeCapacity {
  cpuCores: number;
  ramTotalMb: number;
  vramTotalMb: number;
  diskTotalMb: number;
  /** Số task đồng thời tối đa. */
  maxTasks: number;
}

/** Một fleet node v14. */
export interface FleetV14Node {
  nodeId: string;
  hostname: string;
  /** Fingerprint ổn định của máy (vd hash MAC + hostname) — chống trùng id. */
  fingerprint: string;
  labels: Record<string, string>;
  capacity: FleetV14NodeCapacity;
  status: FleetV14NodeStatus;
  health: FleetV14NodeHealth;
  /** Epoch ms heartbeat gần nhất (null = chưa từng). */
  lastHeartbeatAt: number | null;
  /** Epoch ms đăng ký lần đầu. */
  registeredAt: number;
  /** Epoch ms bắt đầu drain (null = không drain). */
  drainStartedAt: number | null;
  /** Lý do drain / bảo trì. */
  maintenanceReason: string;
  /** Tài nguyên đang dùng (do task đang chạy chiếm, MB). */
  usedRamMb: number;
  usedVramMb: number;
  usedCpuCores: number;
  /** Id các task đang chạy trên node. */
  runningTaskIds: string[];
}

/** Một health sample (do caller đo thật, vd từ heartbeat). */
export interface FleetV14HealthSample {
  at: number;
  /** % CPU đang dùng (0..1). */
  cpuFraction: number;
  /** % RAM đang dùng (0..1). */
  ramFraction: number;
  /** % VRAM đang dùng (0..1, 0 = không có GPU). */
  vramFraction: number;
  /** Disk trống (MB). */
  diskFreeMb: number;
  /** Epoch ms heartbeat của sample này. */
  heartbeatAt: number;
  /** Số task lỗi trên node trong 5 phút gần nhất. */
  recentTaskErrors: number;
}

/** Kết quả health check: trạng thái + lý do từng điều kiện. */
export interface FleetV14HealthCheck {
  nodeId: string;
  health: FleetV14NodeHealth;
  /** Lý do từng điều kiện (để UI vẽ rõ). */
  reasons: string[];
  at: number;
}

/** Một task cần phân bổ (do caller định nghĩa, vd chạy bot / chạy model). */
export interface FleetV14Task {
  taskId: string;
  kind: string;
  /** CPU cần (cores, có thể lẻ — vd 0.5). */
  cpuCores: number;
  ramMb: number;
  vramMb: number;
  /** Độ ưu tiên (cao hơn = được xếp trước khi tranh node). */
  priority: number;
  /** Label selector: node phải khớp TẤT CẢ (vd {gpu: 'true'}). */
  requiredLabels: Record<string, string>;
  /** Node nào được phép chạy (rỗng = mọi node). */
  allowedNodeIds: string[];
  createdBy: string;
  createdAt: number;
}

/** Trạng thái của một task đã phân bổ. */
export type FleetV14TaskStatus = 'pending' | 'running' | 'migrating' | 'done' | 'failed' | 'cancelled';

export interface FleetV14AllocatedTask {
  task: FleetV14Task;
  nodeId: string;
  status: FleetV14TaskStatus;
  allocatedAt: number;
  /** Node cũ khi task đang migrate ('' = không migrate). */
  previousNodeId: string;
}

/** Toàn bộ snapshot fleet v14 (lưu file). */
export interface FleetV14Snapshot {
  version: 1;
  nodes: FleetV14Node[];
  tasks: FleetV14AllocatedTask[];
  /** Lịch sử health mỗi node (nodeId -> sample, mới nhất ở cuối). */
  healthHistory: Record<string, FleetV14HealthSample[]>;
  events: FleetV14Event[];
  updatedAt: number;
}

/** Một event fleet (append-only, seq liên tục). */
export interface FleetV14Event {
  seq: number;
  at: number;
  kind: string;
  nodeId: string;
  taskId: string;
  actorUserId: string;
  detail: string;
}

export function createFleetV14Snapshot(now = Date.now()): FleetV14Snapshot {
  return { version: 1, nodes: [], tasks: [], healthHistory: {}, events: [], updatedAt: now };
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

/** True khi node khớp label selector của task. */
export function fleetV14NodeMatchesLabels(
  node: FleetV14Node,
  requiredLabels: Record<string, string>,
): boolean {
  for (const [key, value] of Object.entries(requiredLabels)) {
    if (node.labels[key] !== value) return false;
  }
  return true;
}

/** True khi node được phép nhận task (trạng thái + allowed list + label). */
export function fleetV14NodeEligibleForTask(node: FleetV14Node, task: FleetV14Task): boolean {
  if (node.status !== 'active') return false;
  if (task.allowedNodeIds.length > 0 && !task.allowedNodeIds.includes(node.nodeId)) return false;
  return fleetV14NodeMatchesLabels(node, task.requiredLabels);
}

/** Tài nguyên trống của node (MB / cores). */
export function fleetV14NodeFreeResources(node: FleetV14Node): { cpuCores: number; ramMb: number; vramMb: number; taskSlots: number } {
  return {
    cpuCores: Math.max(0, node.capacity.cpuCores - node.usedCpuCores),
    ramMb: Math.max(0, node.capacity.ramTotalMb - node.usedRamMb),
    vramMb: Math.max(0, node.capacity.vramTotalMb - node.usedVramMb),
    taskSlots: Math.max(0, node.capacity.maxTasks - node.runningTaskIds.length),
  };
}

/** Tải hiện tại của node 0..1 (max của CPU/RAM/VRAM/task-slot đã dùng). */
export function fleetV14NodeLoad(node: FleetV14Node): number {
  const cpu = node.capacity.cpuCores > 0 ? node.usedCpuCores / node.capacity.cpuCores : 0;
  const ram = node.capacity.ramTotalMb > 0 ? node.usedRamMb / node.capacity.ramTotalMb : 0;
  const vram = node.capacity.vramTotalMb > 0 ? node.usedVramMb / node.capacity.vramTotalMb : 0;
  const slots = node.capacity.maxTasks > 0 ? node.runningTaskIds.length / node.capacity.maxTasks : 0;
  return Math.min(1, Math.max(cpu, ram, vram, slots));
}

// ---------------------------------------------------------------------------
// Đăng ký node + heartbeat + health check
// ---------------------------------------------------------------------------

function appendEvent(
  snapshot: FleetV14Snapshot,
  kind: string,
  nodeId: string,
  taskId: string,
  actorUserId: string,
  detail: string,
  now: number,
): FleetV14Event[] {
  const prev = snapshot.events[snapshot.events.length - 1];
  const event: FleetV14Event = {
    seq: prev ? prev.seq + 1 : 1,
    at: now,
    kind,
    nodeId,
    taskId,
    actorUserId,
    detail,
  };
  const events = [...snapshot.events, event];
  return events.length > FLEET_V14_MAX_EVENTS ? events.slice(events.length - FLEET_V14_MAX_EVENTS) : events;
}

export interface FleetV14RegisterResult {
  ok: boolean;
  snapshot: FleetV14Snapshot;
  /** 'registered' | 're-registered' (cùng fingerprint, node restart). */
  outcome: string;
  reason: string;
}

/**
 * Đăng ký node mới. Trùng id + fingerprint khác → từ chối (hai máy
 * cùng id). Cùng fingerprint → re-register: giữ task đang chạy, cập
 * nhật capacity/labels, trạng thái về `joining` chờ heartbeat.
 */
export function registerFleetV14Node(
  snapshot: FleetV14Snapshot,
  input: {
    nodeId: string;
    hostname: string;
    fingerprint: string;
    labels?: Record<string, string>;
    capacity: FleetV14NodeCapacity;
  },
  actorUserId: string,
  now = Date.now(),
): FleetV14RegisterResult {
  if (!isNonEmptyString(input.nodeId) || !isNonEmptyString(input.fingerprint)) {
    return { ok: false, snapshot, outcome: '', reason: 'nodeId and fingerprint are required' };
  }
  if (input.capacity.cpuCores <= 0 || input.capacity.ramTotalMb <= 0 || input.capacity.maxTasks <= 0) {
    return { ok: false, snapshot, outcome: '', reason: 'capacity must have cpuCores > 0, ramTotalMb > 0, maxTasks > 0' };
  }
  if (snapshot.nodes.filter((n) => n.status !== 'removed').length >= FLEET_V14_MAX_NODES) {
    return { ok: false, snapshot, outcome: '', reason: 'too many nodes in fleet' };
  }
  const existing = snapshot.nodes.find((n) => n.nodeId === input.nodeId && n.status !== 'removed');
  if (existing && existing.fingerprint !== input.fingerprint) {
    return { ok: false, snapshot, outcome: '', reason: `node id ${input.nodeId} already registered with a different fingerprint` };
  }
  if (existing) {
    const node: FleetV14Node = { ...existing, hostname: input.hostname.trim(), labels: input.labels ?? existing.labels, capacity: input.capacity, status: 'joining' };
    const nodes = snapshot.nodes.map((n) => (n.nodeId === input.nodeId ? node : n));
    const next: FleetV14Snapshot = {
      ...snapshot,
      nodes,
      events: appendEvent(snapshot, 'node-re-register', input.nodeId, '', actorUserId, `node ${input.nodeId} re-registered (restart)`, now),
      updatedAt: now,
    };
    return { ok: true, snapshot: next, outcome: 're-registered', reason: '' };
  }
  const node: FleetV14Node = {
    nodeId: input.nodeId.trim(),
    hostname: input.hostname.trim(),
    fingerprint: input.fingerprint.trim(),
    labels: input.labels ?? {},
    capacity: input.capacity,
    status: 'joining',
    health: 'healthy',
    lastHeartbeatAt: null,
    registeredAt: now,
    drainStartedAt: null,
    maintenanceReason: '',
    usedRamMb: 0,
    usedVramMb: 0,
    usedCpuCores: 0,
    runningTaskIds: [],
  };
  const next: FleetV14Snapshot = {
    ...snapshot,
    nodes: [...snapshot.nodes, node],
    events: appendEvent(snapshot, 'node-join', node.nodeId, '', actorUserId, `node ${node.nodeId} joined fleet`, now),
    updatedAt: now,
  };
  return { ok: true, snapshot: next, outcome: 'registered', reason: '' };
}

/** Ghi heartbeat: cập nhật lastHeartbeatAt, joining → active. */
export function heartbeatFleetV14Node(
  snapshot: FleetV14Snapshot,
  nodeId: string,
  now = Date.now(),
): FleetV14Snapshot {
  const nodes = snapshot.nodes.map((n) => {
    if (n.nodeId !== nodeId || n.status === 'removed') return n;
    return { ...n, lastHeartbeatAt: now, status: n.status === 'joining' ? 'active' : n.status };
  });
  return { ...snapshot, nodes, updatedAt: now };
}

/**
 * Health check từ một sample: heartbeat quá hạn → down; CPU/RAM/VRAM
 * >= 90% → unhealthy; >= 75% → degraded; disk free thấp → degraded/
 * unhealthy; task lỗi nhiều (>= 5 trong 5 phút) → degraded. Draining /
 * maintenance giữ nguyên health cũ (không đánh giá lại khi đang rút).
 */
export function checkFleetV14NodeHealth(
  node: FleetV14Node,
  sample: FleetV14HealthSample,
): FleetV14HealthCheck {
  const reasons: string[] = [];
  let health: FleetV14NodeHealth = 'healthy';
  const heartbeatAge = sample.heartbeatAt > 0 ? sample.at - sample.heartbeatAt : Number.MAX_SAFE_INTEGER;
  if (node.lastHeartbeatAt === null && sample.heartbeatAt <= 0) {
    health = 'down';
    reasons.push('no heartbeat ever received');
  } else if (heartbeatAge > FLEET_V14_HEARTBEAT_TIMEOUT_MS) {
    health = 'down';
    reasons.push(`heartbeat stale for ${Math.round(heartbeatAge / 1000)}s (> ${FLEET_V14_HEARTBEAT_TIMEOUT_MS / 1000}s)`);
  }
  const checkFraction = (label: string, value: number): void => {
    if (value >= FLEET_V14_UNHEALTHY_THRESHOLD) {
      if (health !== 'down') health = 'unhealthy';
      reasons.push(`${label} ${(value * 100).toFixed(0)}% >= 90%`);
    } else if (value >= FLEET_V14_DEGRADED_THRESHOLD) {
      if (health === 'healthy') health = 'degraded';
      reasons.push(`${label} ${(value * 100).toFixed(0)}% >= 75%`);
    }
  };
  if (health !== 'down') {
    checkFraction('CPU', sample.cpuFraction);
    checkFraction('RAM', sample.ramFraction);
    if (node.capacity.vramTotalMb > 0) checkFraction('VRAM', sample.vramFraction);
    if (sample.diskFreeMb < FLEET_V14_DISK_UNHEALTHY_MB) {
      health = 'unhealthy';
      reasons.push(`disk free ${sample.diskFreeMb} MB < ${FLEET_V14_DISK_UNHEALTHY_MB} MB`);
    } else if (sample.diskFreeMb < FLEET_V14_DISK_DEGRADED_MB) {
      if (health === 'healthy') health = 'degraded';
      reasons.push(`disk free ${sample.diskFreeMb} MB < ${FLEET_V14_DISK_DEGRADED_MB} MB`);
    }
    if (sample.recentTaskErrors >= 5) {
      if (health === 'healthy') health = 'degraded';
      reasons.push(`${sample.recentTaskErrors} task errors in last 5 minutes`);
    }
  }
  if (reasons.length === 0) reasons.push('all signals normal');
  return { nodeId: node.nodeId, health, reasons, at: sample.at };
}

/** Áp dụng health check vào snapshot (cập nhật health + lịch sử sample). */
export function applyFleetV14HealthCheck(
  snapshot: FleetV14Snapshot,
  nodeId: string,
  sample: FleetV14HealthSample,
): { snapshot: FleetV14Snapshot; check: FleetV14HealthCheck | null } {
  const node = snapshot.nodes.find((n) => n.nodeId === nodeId);
  if (!node || node.status === 'removed') return { snapshot, check: null };
  const check = checkFleetV14NodeHealth(node, sample);
  const healthChanged = check.health !== node.health;
  const nodes = snapshot.nodes.map((n) => {
    if (n.nodeId !== nodeId) return n;
    // Node down (mất heartbeat) thì status cũng chuyển sang down.
    const status: FleetV14NodeStatus = check.health === 'down' && n.status === 'active' ? 'down' : n.status;
    return { ...n, health: check.health, status, lastHeartbeatAt: sample.heartbeatAt || n.lastHeartbeatAt };
  });
  const history = [...(snapshot.healthHistory[nodeId] ?? []), sample];
  const trimmed = history.length > FLEET_V14_MAX_HEALTH_SAMPLES ? history.slice(history.length - FLEET_V14_MAX_HEALTH_SAMPLES) : history;
  let next: FleetV14Snapshot = {
    ...snapshot,
    nodes,
    healthHistory: { ...snapshot.healthHistory, [nodeId]: trimmed },
    updatedAt: sample.at,
  };
  if (healthChanged) {
    next = {
      ...next,
      events: appendEvent(next, 'health-change', nodeId, '', 'system', `node ${nodeId} health ${node.health} -> ${check.health}: ${check.reasons.join('; ')}`, sample.at),
    };
  }
  return { snapshot: next, check };
}

/** Node down quá lâu thì đề xuất remove (trả danh sách nodeId). */
export function fleetV14NodesToRemove(snapshot: FleetV14Snapshot, now = Date.now()): string[] {
  return snapshot.nodes
    .filter((n) => n.status === 'down' && n.lastHeartbeatAt !== null && now - n.lastHeartbeatAt > FLEET_V14_DOWN_REMOVE_AFTER_MS)
    .map((n) => n.nodeId);
}

// ---------------------------------------------------------------------------
// Phân bổ task theo tải
// ---------------------------------------------------------------------------

/** Điểm của một node cho một task (thấp = tốt): tải + khớp label + sức khỏe. */
export interface FleetV14NodeScore {
  nodeId: string;
  score: number;
  load: number;
  labelMatches: number;
  /** Lý do loại ('' = đủ điều kiện). */
  ineligibleReason: string;
}

export function scoreFleetV14NodeForTask(node: FleetV14Node, task: FleetV14Task): FleetV14NodeScore {
  const base = { nodeId: node.nodeId, score: Number.POSITIVE_INFINITY, load: fleetV14NodeLoad(node), labelMatches: 0, ineligibleReason: '' };
  if (!fleetV14NodeEligibleForTask(node, task)) {
    if (node.status !== 'active') return { ...base, ineligibleReason: `node status is ${node.status}` };
    if (task.allowedNodeIds.length > 0 && !task.allowedNodeIds.includes(node.nodeId)) {
      return { ...base, ineligibleReason: 'node not in allowedNodeIds' };
    }
    return { ...base, ineligibleReason: 'node labels do not match requiredLabels' };
  }
  const free = fleetV14NodeFreeResources(node);
  if (free.taskSlots <= 0) return { ...base, ineligibleReason: 'no free task slot' };
  if (free.cpuCores < task.cpuCores) {
    return { ...base, ineligibleReason: `not enough CPU: free ${free.cpuCores} cores, need ${task.cpuCores}` };
  }
  if (free.ramMb < task.ramMb) {
    return { ...base, ineligibleReason: `not enough RAM: free ${free.ramMb} MB, need ${task.ramMb} MB` };
  }
  if (free.vramMb < task.vramMb) {
    return { ...base, ineligibleReason: `not enough VRAM: free ${free.vramMb} MB, need ${task.vramMb} MB` };
  }
  const labelMatches = Object.keys(task.requiredLabels).length;
  // Điểm: tải hiện tại (0..1) trừ 0.05 mỗi label khớp (khớp nhiều thắng),
  // cộng phạt sức khỏe (degraded +0.2, unhealthy +0.5, down loại từ trước).
  let score = fleetV14NodeLoad(node) - labelMatches * 0.05;
  if (node.health === 'degraded') score += 0.2;
  if (node.health === 'unhealthy') score += 0.5;
  return { nodeId: node.nodeId, score, load: fleetV14NodeLoad(node), labelMatches, ineligibleReason: '' };
}

/** Chấm điểm toàn bộ node cho một task, sắp xếp tốt nhất trước. */
export function rankFleetV14NodesForTask(
  snapshot: FleetV14Snapshot,
  task: FleetV14Task,
): FleetV14NodeScore[] {
  const scored = snapshot.nodes
    .filter((n) => n.status !== 'removed')
    .map((n) => scoreFleetV14NodeForTask(n, task));
  scored.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score;
    if (a.load !== b.load) return a.load - b.load;
    return a.nodeId.localeCompare(b.nodeId);
  });
  return scored;
}

export interface FleetV14AllocateResult {
  ok: boolean;
  snapshot: FleetV14Snapshot;
  allocated: FleetV14AllocatedTask | null;
  reason: string;
}

/**
 * Phân bổ task cho node tốt nhất (điểm thấp nhất). Cập nhật tài nguyên
 * đã dùng + runningTaskIds của node. Không node nào nhận được → trả
 * lý do của từng node để caller/UI hiển thị.
 */
export function allocateFleetV14Task(
  snapshot: FleetV14Snapshot,
  task: FleetV14Task,
  now = Date.now(),
): FleetV14AllocateResult {
  if (snapshot.tasks.some((t) => t.task.taskId === task.taskId && t.status !== 'done' && t.status !== 'failed' && t.status !== 'cancelled')) {
    return { ok: false, snapshot, allocated: null, reason: `task ${task.taskId} already allocated` };
  }
  const ranked = rankFleetV14NodesForTask(snapshot, task);
  const best = ranked.find((r) => r.ineligibleReason === '');
  if (!best) {
    const reasons = ranked.map((r) => `${r.nodeId}: ${r.ineligibleReason}`).join('; ');
    return { ok: false, snapshot, allocated: null, reason: ranked.length === 0 ? 'no nodes in fleet' : `no node can run task: ${reasons}` };
  }
  const node = snapshot.nodes.find((n) => n.nodeId === best.nodeId);
  if (!node) return { ok: false, snapshot, allocated: null, reason: `node ${best.nodeId} disappeared` };
  const allocated: FleetV14AllocatedTask = {
    task,
    nodeId: node.nodeId,
    status: 'running',
    allocatedAt: now,
    previousNodeId: '',
  };
  const nodes = snapshot.nodes.map((n) => {
    if (n.nodeId !== node.nodeId) return n;
    return {
      ...n,
      usedRamMb: n.usedRamMb + task.ramMb,
      usedVramMb: n.usedVramMb + task.vramMb,
      usedCpuCores: n.usedCpuCores + task.cpuCores,
      runningTaskIds: [...n.runningTaskIds, task.taskId],
    };
  });
  const next: FleetV14Snapshot = {
    ...snapshot,
    nodes,
    tasks: [...snapshot.tasks, allocated],
    events: appendEvent(snapshot, 'task-allocate', node.nodeId, task.taskId, task.createdBy, `task ${task.taskId} allocated to ${node.nodeId} (score ${best.score.toFixed(2)})`, now),
    updatedAt: now,
  };
  return { ok: true, snapshot: next, allocated, reason: '' };
}

/** Giải phóng task khỏi node (done/failed/cancelled): trừ tài nguyên đã dùng. */
export function releaseFleetV14Task(
  snapshot: FleetV14Snapshot,
  taskId: string,
  status: 'done' | 'failed' | 'cancelled',
  now = Date.now(),
): FleetV14Snapshot {
  const allocated = snapshot.tasks.find((t) => t.task.taskId === taskId);
  if (!allocated || allocated.status === 'done' || allocated.status === 'failed' || allocated.status === 'cancelled') {
    return snapshot;
  }
  const nodes = snapshot.nodes.map((n) => {
    if (n.nodeId !== allocated.nodeId) return n;
    return {
      ...n,
      usedRamMb: Math.max(0, n.usedRamMb - allocated.task.ramMb),
      usedVramMb: Math.max(0, n.usedVramMb - allocated.task.vramMb),
      usedCpuCores: Math.max(0, n.usedCpuCores - allocated.task.cpuCores),
      runningTaskIds: n.runningTaskIds.filter((id) => id !== taskId),
    };
  });
  const tasks = snapshot.tasks.map((t) => (t.task.taskId === taskId ? { ...t, status } : t));
  return {
    ...snapshot,
    nodes,
    tasks,
    events: appendEvent(snapshot, `task-${status}`, allocated.nodeId, taskId, '', `task ${taskId} ${status}`, now),
    updatedAt: now,
  };
}

// ---------------------------------------------------------------------------
// Drain node khi bảo trì
// ---------------------------------------------------------------------------

/** Một bước trong kế hoạch di chuyển khi drain: task → node đích. */
export interface FleetV14MigrationStep {
  taskId: string;
  fromNodeId: string;
  toNodeId: string;
  /** '' = chuyển được; có nội dung = không chuyển được, lý do. */
  blockedReason: string;
}

/** Kế hoạch drain: các task chuyển được + các task bị kẹt. */
export interface FleetV14DrainPlan {
  nodeId: string;
  migrations: FleetV14MigrationStep[];
  /** Task không chuyển được sang node nào (caller quyết định giữ/hủy). */
  blocked: FleetV14MigrationStep[];
  /** True khi mọi task đều chuyển được (an toàn để complete drain). */
  allMovable: boolean;
}

/**
 * Lập kế hoạch di chuyển cho node đang drain: với từng task đang
 * chạy, chấm điểm lại các node KHÁC (không tính node đang drain)
 * bằng cùng bộ chấm điểm phân bổ; task nào không node nào nhận
 * được thì vào `blocked` kèm lý do.
 */
export function planFleetV14Drain(snapshot: FleetV14Snapshot, nodeId: string): FleetV14DrainPlan {
  const node = snapshot.nodes.find((n) => n.nodeId === nodeId);
  const plan: FleetV14DrainPlan = { nodeId, migrations: [], blocked: [], allMovable: true };
  if (!node) return plan;
  const withoutNode: FleetV14Snapshot = {
    ...snapshot,
    nodes: snapshot.nodes.filter((n) => n.nodeId !== nodeId),
  };
  for (const taskId of node.runningTaskIds) {
    const allocated = snapshot.tasks.find((t) => t.task.taskId === taskId);
    if (!allocated) continue;
    const ranked = rankFleetV14NodesForTask(withoutNode, allocated.task);
    const best = ranked.find((r) => r.ineligibleReason === '');
    if (best) {
      plan.migrations.push({ taskId, fromNodeId: nodeId, toNodeId: best.nodeId, blockedReason: '' });
    } else {
      const reasons = ranked.map((r) => `${r.nodeId}: ${r.ineligibleReason}`).join('; ');
      plan.blocked.push({
        taskId,
        fromNodeId: nodeId,
        toNodeId: '',
        blockedReason: ranked.length === 0 ? 'no other node in fleet' : `no node can take task: ${reasons}`,
      });
    }
  }
  plan.allMovable = plan.blocked.length === 0;
  return plan;
}

export interface FleetV14DrainResult {
  ok: boolean;
  snapshot: FleetV14Snapshot;
  plan: FleetV14DrainPlan | null;
  reason: string;
}

/** Bắt đầu drain: node sang `draining`, chặn task mới, trả kế hoạch di chuyển. */
export function drainFleetV14Node(
  snapshot: FleetV14Snapshot,
  nodeId: string,
  reason: string,
  actorUserId: string,
  now = Date.now(),
): FleetV14DrainResult {
  const node = snapshot.nodes.find((n) => n.nodeId === nodeId);
  if (!node || node.status === 'removed') {
    return { ok: false, snapshot, plan: null, reason: `node not found: ${nodeId}` };
  }
  if (node.status === 'draining' || node.status === 'maintenance') {
    return { ok: false, snapshot, plan: null, reason: `node ${nodeId} already ${node.status}` };
  }
  if (node.status !== 'active' && node.status !== 'down') {
    return { ok: false, snapshot, plan: null, reason: `cannot drain node in status ${node.status}` };
  }
  const nodes = snapshot.nodes.map((n) =>
    n.nodeId === nodeId ? { ...n, status: 'draining' as const, drainStartedAt: now, maintenanceReason: reason.trim() } : n,
  );
  const next: FleetV14Snapshot = {
    ...snapshot,
    nodes,
    events: appendEvent(snapshot, 'node-drain-start', nodeId, '', actorUserId, `node ${nodeId} draining: ${reason}`, now),
    updatedAt: now,
  };
  return { ok: true, snapshot: next, plan: planFleetV14Drain(next, nodeId), reason: '' };
}

/** Áp dụng một bước migrate: chuyển task sang node đích (trừ/cộng tài nguyên). */
export function migrateFleetV14Task(
  snapshot: FleetV14Snapshot,
  taskId: string,
  toNodeId: string,
  actorUserId: string,
  now = Date.now(),
): { ok: boolean; snapshot: FleetV14Snapshot; reason: string } {
  const allocated = snapshot.tasks.find((t) => t.task.taskId === taskId);
  if (!allocated) return { ok: false, snapshot, reason: `task not found: ${taskId}` };
  if (allocated.status !== 'running' && allocated.status !== 'migrating') {
    return { ok: false, snapshot, reason: `task ${taskId} is ${allocated.status}, cannot migrate` };
  }
  const fromNode = snapshot.nodes.find((n) => n.nodeId === allocated.nodeId);
  const toNode = snapshot.nodes.find((n) => n.nodeId === toNodeId);
  if (!fromNode || !toNode) return { ok: false, snapshot, reason: 'source or destination node not found' };
  if (toNode.status !== 'active') return { ok: false, snapshot, reason: `destination node ${toNodeId} is ${toNode.status}` };
  const score = scoreFleetV14NodeForTask(toNode, allocated.task);
  if (score.ineligibleReason !== '') {
    return { ok: false, snapshot, reason: `destination cannot run task: ${score.ineligibleReason}` };
  }
  const nodes = snapshot.nodes.map((n) => {
    if (n.nodeId === fromNode.nodeId) {
      return {
        ...n,
        usedRamMb: Math.max(0, n.usedRamMb - allocated.task.ramMb),
        usedVramMb: Math.max(0, n.usedVramMb - allocated.task.vramMb),
        usedCpuCores: Math.max(0, n.usedCpuCores - allocated.task.cpuCores),
        runningTaskIds: n.runningTaskIds.filter((id) => id !== taskId),
      };
    }
    if (n.nodeId === toNode.nodeId) {
      return {
        ...n,
        usedRamMb: n.usedRamMb + allocated.task.ramMb,
        usedVramMb: n.usedVramMb + allocated.task.vramMb,
        usedCpuCores: n.usedCpuCores + allocated.task.cpuCores,
        runningTaskIds: [...n.runningTaskIds, taskId],
      };
    }
    return n;
  });
  const tasks = snapshot.tasks.map((t) =>
    t.task.taskId === taskId ? { ...t, nodeId: toNodeId, status: 'running' as const, previousNodeId: fromNode.nodeId } : t,
  );
  const next: FleetV14Snapshot = {
    ...snapshot,
    nodes,
    tasks,
    events: appendEvent(snapshot, 'task-migrate', toNodeId, taskId, actorUserId, `task ${taskId} migrated ${fromNode.nodeId} -> ${toNodeId}`, now),
    updatedAt: now,
  };
  return { ok: true, snapshot: next, reason: '' };
}

/** Hoàn tất drain: chỉ cho phép khi node không còn task nào → `maintenance`. */
export function completeFleetV14Drain(
  snapshot: FleetV14Snapshot,
  nodeId: string,
  actorUserId: string,
  now = Date.now(),
): { ok: boolean; snapshot: FleetV14Snapshot; reason: string } {
  const node = snapshot.nodes.find((n) => n.nodeId === nodeId);
  if (!node) return { ok: false, snapshot, reason: `node not found: ${nodeId}` };
  if (node.status !== 'draining') {
    return { ok: false, snapshot, reason: `node ${nodeId} is ${node.status}, not draining` };
  }
  if (node.runningTaskIds.length > 0) {
    return {
      ok: false,
      snapshot,
      reason: `node ${nodeId} still has ${node.runningTaskIds.length} running task(s): ${node.runningTaskIds.join(', ')}`,
    };
  }
  const nodes = snapshot.nodes.map((n) => (n.nodeId === nodeId ? { ...n, status: 'maintenance' as const } : n));
  const next: FleetV14Snapshot = {
    ...snapshot,
    nodes,
    events: appendEvent(snapshot, 'node-maintenance', nodeId, '', actorUserId, `node ${nodeId} drained, now in maintenance`, now),
    updatedAt: now,
  };
  return { ok: true, snapshot: next, reason: '' };
}

/** Đưa node từ draining/maintenance về active (hết bảo trì). */
export function undrainFleetV14Node(
  snapshot: FleetV14Snapshot,
  nodeId: string,
  actorUserId: string,
  now = Date.now(),
): { ok: boolean; snapshot: FleetV14Snapshot; reason: string } {
  const node = snapshot.nodes.find((n) => n.nodeId === nodeId);
  if (!node) return { ok: false, snapshot, reason: `node not found: ${nodeId}` };
  if (node.status !== 'draining' && node.status !== 'maintenance' && node.status !== 'down') {
    return { ok: false, snapshot, reason: `node ${nodeId} is ${node.status}, nothing to undrain` };
  }
  const nodes = snapshot.nodes.map((n) =>
    n.nodeId === nodeId
      ? { ...n, status: 'active' as const, drainStartedAt: null, maintenanceReason: '' }
      : n,
  );
  const next: FleetV14Snapshot = {
    ...snapshot,
    nodes,
    events: appendEvent(snapshot, 'node-undrain', nodeId, '', actorUserId, `node ${nodeId} back to active`, now),
    updatedAt: now,
  };
  return { ok: true, snapshot: next, reason: '' };
}

/** Xóa node khỏi fleet (chỉ khi không còn task đang chạy). */
export function removeFleetV14Node(
  snapshot: FleetV14Snapshot,
  nodeId: string,
  actorUserId: string,
  now = Date.now(),
): { ok: boolean; snapshot: FleetV14Snapshot; reason: string } {
  const node = snapshot.nodes.find((n) => n.nodeId === nodeId);
  if (!node) return { ok: false, snapshot, reason: `node not found: ${nodeId}` };
  if (node.runningTaskIds.length > 0) {
    return { ok: false, snapshot, reason: `node ${nodeId} still has running tasks` };
  }
  const nodes = snapshot.nodes.map((n) => (n.nodeId === nodeId ? { ...n, status: 'removed' as const } : n));
  const next: FleetV14Snapshot = {
    ...snapshot,
    nodes,
    events: appendEvent(snapshot, 'node-leave', nodeId, '', actorUserId, `node ${nodeId} removed from fleet`, now),
    updatedAt: now,
  };
  return { ok: true, snapshot: next, reason: '' };
}

// ---------------------------------------------------------------------------
// Capacity report + persistence
// ---------------------------------------------------------------------------

/** Báo cáo capacity toàn fleet: tổng / đã dùng / trống, node quá tải. */
export interface FleetV14CapacityReport {
  nodeCount: number;
  activeNodeCount: number;
  totalCpuCores: number;
  usedCpuCores: number;
  totalRamMb: number;
  usedRamMb: number;
  totalVramMb: number;
  usedVramMb: number;
  totalTaskSlots: number;
  usedTaskSlots: number;
  /** Node có tải >= 85% (quá tải). */
  overloadedNodeIds: string[];
  runningTaskCount: number;
  pendingTaskCount: number;
}

export function buildFleetV14CapacityReport(snapshot: FleetV14Snapshot): FleetV14CapacityReport {
  const live = snapshot.nodes.filter((n) => n.status !== 'removed');
  const active = live.filter((n) => n.status === 'active');
  return {
    nodeCount: live.length,
    activeNodeCount: active.length,
    totalCpuCores: live.reduce((s, n) => s + n.capacity.cpuCores, 0),
    usedCpuCores: live.reduce((s, n) => s + n.usedCpuCores, 0),
    totalRamMb: live.reduce((s, n) => s + n.capacity.ramTotalMb, 0),
    usedRamMb: live.reduce((s, n) => s + n.usedRamMb, 0),
    totalVramMb: live.reduce((s, n) => s + n.capacity.vramTotalMb, 0),
    usedVramMb: live.reduce((s, n) => s + n.usedVramMb, 0),
    totalTaskSlots: live.reduce((s, n) => s + n.capacity.maxTasks, 0),
    usedTaskSlots: live.reduce((s, n) => s + n.runningTaskIds.length, 0),
    overloadedNodeIds: live.filter((n) => fleetV14NodeLoad(n) >= 0.85).map((n) => n.nodeId),
    runningTaskCount: snapshot.tasks.filter((t) => t.status === 'running').length,
    pendingTaskCount: snapshot.tasks.filter((t) => t.status === 'pending').length,
  };
}

/** Verify event log: seq liên tục từ 1 (phát hiện mất dòng). */
export function verifyFleetV14EventLog(events: readonly FleetV14Event[]): { ok: boolean; badSeq: number; reason: string } {
  let expected = 1;
  for (const e of events) {
    if (e.seq !== expected) {
      return { ok: false, badSeq: e.seq, reason: `sequence gap: expected ${expected}, got ${e.seq}` };
    }
    expected++;
  }
  return { ok: true, badSeq: -1, reason: '' };
}

function atomicWriteFile(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, filePath);
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Windows không có chmod unix — bỏ qua.
  }
}

export function saveFleetV14Snapshot(fleetRoot: string, snapshot: FleetV14Snapshot): void {
  atomicWriteFile(path.join(fleetRoot, FLEET_V14_SNAPSHOT_FILE), JSON.stringify(snapshot, null, 2));
}

export function loadFleetV14Snapshot(fleetRoot: string): FleetV14Snapshot | null {
  const file = path.join(fleetRoot, FLEET_V14_SNAPSHOT_FILE);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as FleetV14Snapshot;
    if (parsed.version !== 1 || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.tasks)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Ghi thêm event vào file JSONL (0600). */
export function appendFleetV14EventToFile(fleetRoot: string, event: FleetV14Event): void {
  const file = path.join(fleetRoot, FLEET_V14_EVENTS_FILE);
  fs.mkdirSync(fleetRoot, { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(event)}\n`, { mode: 0o600 });
}
