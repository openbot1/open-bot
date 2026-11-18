/**
 * Fleet v16 — quản lý fleet node: đăng ký node có token + nhãn
 * kiểm định, health check theo heartbeat trễ + lỗi liên tiếp, phân
 * phối tải theo 3 chiến lược, vòng đời node (v1.19, Đội T6).
 *
 * Tầng trên của fleet v15 (`fleetV15/fleetV15.ts` — health scoring
 * 0..100, capacity forecast, safe drain, rebalance) và fleet v14
 * (`fleetV14/fleetV14.ts` — đăng ký node, health check 4 mức,
 * phân bổ task theo tải, drain + migration). V15 trả lời "node này
 * mấy điểm, bao lâu thì hết chỗ, có rút được không"; v16 trả lời
 * 4 câu vận hành tiếp theo:
 *
 * - ĐĂNG KÝ NODE: node đăng ký bằng token (mã dùng một lần do
 *   fleet cấp, chống node lạ tự xưng tên), nhãn key/value kiểm
 *   định chặt (slug), capacity kiểm định (core/RAM/disk/task
 *   slot > 0), trùng fingerprint/hostname → từ chối. Node mới ở
 *   trạng thái `joining` tới khi heartbeat đầu tiên xác nhận.
 * - HEALTH CHECK: ngoài sample như v14, v16 theo dõi heartbeat
 *   trễ (stale) theo 3 mức (warn 60s, unhealthy 5 phút, down
 *   15 phút) + số heartbeat trượt liên tiếp; node `down` quá
 *   24h → đề xuất gỡ khỏi fleet.
 * - PHÂN PHỐI TẢI: 3 chiến lược chọn node cho task mới —
 *   `least-loaded` (tải thấp nhất, dùng `fleetV14NodeLoad`),
 *   `least-connections` (ít task đang chạy nhất), và
 *   `weighted-round-robin` mượt (smooth WRR theo trọng số cấu
 *   hình của node, state giữ trong snapshot để lần lượt đều).
 *   Chỉ node `active` + khỏe (không `down`/`unhealthy`) + đủ tài
 *   nguyên + khớp label mới được chọn.
 * - VÒNG ĐỜI: chuyển trạng thái node theo bảng chuyển đổi cho
 *   phép (vd `active → draining → removed`, không nhảy cóc
 *   `joining → removed` khi còn task); decommission chỉ khi node
 *   không còn task đang chạy (hoặc force kèm danh sách task phải
 *   di chuyển trước).
 *
 * Module này KHÔNG spawn process, KHÔNG chạm mạng, KHÔNG chạy
 * task thật: nó quyết định "node này có được vào fleet không,
 * khỏe không, task mới chạy ở đâu, node này được chuyển trạng
 * thái nào" — việc chạy/chuyển task thật do caller làm.
 */

import * as crypto from 'node:crypto';
import type {
  FleetV14HealthSample,
  FleetV14Node,
  FleetV14NodeCapacity,
  FleetV14Snapshot,
  FleetV14Task,
} from '../fleetV14/fleetV14';
import {
  fleetV14NodeEligibleForTask,
  fleetV14NodeFreeResources,
  fleetV14NodeLoad,
  registerFleetV14Node,
} from '../fleetV14/fleetV14';

/** Heartbeat trễ quá mức này → cảnh báo (node có thể chậm). */
export const FLEET_V16_HEARTBEAT_WARN_MS = 60 * 1000;
/** Heartbeat trễ quá mức này → unhealthy. */
export const FLEET_V16_HEARTBEAT_UNHEALTHY_MS = 5 * 60 * 1000;
/** Heartbeat trễ quá mức này → down. */
export const FLEET_V16_HEARTBEAT_DOWN_MS = 15 * 60 * 1000;
/** Node down quá mức này → đề xuất gỡ khỏi fleet. */
export const FLEET_V16_DOWN_REMOVE_AFTER_MS = 24 * 60 * 60 * 1000;
/** Số heartbeat trượt liên tiếp tối đa trước khi đánh unhealthy. */
export const FLEET_V16_MAX_MISSED_HEARTBEATS = 3;
/** Độ dài token đăng ký node (ký tự hex). */
export const FLEET_V16_REGISTRATION_TOKEN_LENGTH = 32;

// ---------------------------------------------------------------------------
// Đăng ký node v2
// ---------------------------------------------------------------------------

/** Một token đăng ký node đang chờ (dùng một lần). */
export interface FleetV16RegistrationToken {
  token: string;
  /** Hostname dự kiến của node sẽ đăng ký ('' = bất kỳ). */
  expectedHostname: string;
  createdAt: number;
  /** Epoch ms hết hạn. */
  expiresAt: number;
  /** true = đã dùng (không dùng lại được). */
  used: boolean;
}

export function createFleetV16RegistrationToken(
  expectedHostname: string,
  ttlMs = 60 * 60 * 1000,
  now = Date.now(),
): FleetV16RegistrationToken {
  // Dùng crypto.randomBytes: LCG tự viết trước đây tràn float64
  // (xem randomTeamV16Token) làm token sụp về toàn '0' ~37% số
  // lần sinh — token đăng ký node là credential chống node lạ nên
  // phải ngẫu nhiên thật.
  const token = crypto
    .randomBytes(Math.ceil(FLEET_V16_REGISTRATION_TOKEN_LENGTH / 2))
    .toString('hex')
    .slice(0, FLEET_V16_REGISTRATION_TOKEN_LENGTH);
  return { token, expectedHostname, createdAt: now, expiresAt: now + ttlMs, used: false };
}

/** Token còn dùng được không (chưa dùng + chưa hết hạn + đúng hostname). */
export function isFleetV16RegistrationTokenValid(
  token: FleetV16RegistrationToken,
  hostname: string,
  now = Date.now(),
): boolean {
  if (token.used) return false;
  if (now > token.expiresAt) return false;
  if (token.expectedHostname !== '' && token.expectedHostname !== hostname) return false;
  return true;
}

/** Lỗi validate nhãn node, '' = hợp lệ. Nhãn: key/value dạng slug. */
export function validateFleetV16NodeLabels(labels: Record<string, string>): string {
  const keys = Object.keys(labels);
  if (keys.length > 32) return 'node tối đa 32 nhãn';
  for (const key of keys) {
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(key)) return `nhãn key không hợp lệ: ${key}`;
    const value = labels[key];
    if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
      return `nhãn value không hợp lệ cho key ${key}`;
    }
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value)) {
      return `nhãn value không hợp lệ cho key ${key}: ${value}`;
    }
  }
  return '';
}

/** Lỗi validate capacity khai báo, '' = hợp lệ. */
export function validateFleetV16NodeCapacity(capacity: FleetV14NodeCapacity): string {
  if (!Number.isFinite(capacity.cpuCores) || capacity.cpuCores <= 0 || capacity.cpuCores > 1024) {
    return 'cpuCores phải trong (0, 1024]';
  }
  if (!Number.isInteger(capacity.ramTotalMb) || capacity.ramTotalMb <= 0) {
    return 'ramTotalMb phải là số nguyên > 0';
  }
  if (!Number.isInteger(capacity.vramTotalMb) || capacity.vramTotalMb < 0) {
    return 'vramTotalMb phải là số nguyên >= 0';
  }
  if (!Number.isInteger(capacity.diskTotalMb) || capacity.diskTotalMb <= 0) {
    return 'diskTotalMb phải là số nguyên > 0';
  }
  if (!Number.isInteger(capacity.maxTasks) || capacity.maxTasks <= 0 || capacity.maxTasks > 10000) {
    return 'maxTasks phải là số nguyên trong (0, 10000]';
  }
  return '';
}

/** Input đăng ký node v16. */
export interface FleetV16RegisterInput {
  nodeId: string;
  hostname: string;
  fingerprint: string;
  labels: Record<string, string>;
  capacity: FleetV14NodeCapacity;
  /** Token đăng ký (bắt buộc — chống node lạ tự xưng tên). */
  registrationToken: string;
  /** Trọng số phân phối tải (1..100, mặc định 100). */
  weight?: number;
}

export interface FleetV16RegisterResult {
  ok: boolean;
  snapshot: FleetV14Snapshot;
  /** Token đã dùng (đánh dấu used) — caller lưu lại. */
  token: FleetV16RegistrationToken | null;
  error: string;
}

/**
 * Đăng ký node v16: kiểm định token + nhãn + capacity rồi ủy thác
 * việc ghi node cho `registerFleetV14Node` (node mới ở `joining`).
 * Token sai/hết hạn/dùng rồi → từ chối, snapshot không đổi.
 */
export function registerFleetV16Node(
  snapshot: FleetV14Snapshot,
  tokens: readonly FleetV16RegistrationToken[],
  input: FleetV16RegisterInput,
  now = Date.now(),
): FleetV16RegisterResult {
  const token = tokens.find((t) => t.token === input.registrationToken) ?? null;
  if (!token) {
    return { ok: false, snapshot, token: null, error: 'registration token không tồn tại' };
  }
  if (!isFleetV16RegistrationTokenValid(token, input.hostname, now)) {
    return { ok: false, snapshot, token: null, error: 'registration token đã dùng, hết hạn hoặc sai hostname' };
  }
  const labelError = validateFleetV16NodeLabels(input.labels);
  if (labelError) return { ok: false, snapshot, token: null, error: labelError };
  const capacityError = validateFleetV16NodeCapacity(input.capacity);
  if (capacityError) return { ok: false, snapshot, token: null, error: capacityError };
  const weight = input.weight ?? 100;
  if (!Number.isInteger(weight) || weight < 1 || weight > 100) {
    return { ok: false, snapshot, token: null, error: 'weight phải là số nguyên 1..100' };
  }
  const v14 = registerFleetV14Node(
    snapshot,
    {
      nodeId: input.nodeId,
      hostname: input.hostname,
      fingerprint: input.fingerprint,
      labels: input.labels,
      capacity: input.capacity,
    },
    'fleet-v16',
    now,
  );
  if (!v14.ok) return { ok: false, snapshot, token: null, error: v14.reason };
  // Lưu trọng số vào snapshot v16 (gắn theo nodeId, tách khỏi v14).
  const weights = { ...(v14.snapshot as FleetV14Snapshot & { v16Weights?: Record<string, number> }).v16Weights, [input.nodeId]: weight };
  const out = { ...v14.snapshot, v16Weights: weights } as FleetV14Snapshot;
  return { ok: true, snapshot: out, token: { ...token, used: true }, error: '' };
}

/** Trọng số phân phối tải của node (mặc định 100 khi chưa đặt). */
export function fleetV16NodeWeight(snapshot: FleetV14Snapshot, nodeId: string): number {
  const weights = (snapshot as FleetV14Snapshot & { v16Weights?: Record<string, number> }).v16Weights;
  return weights?.[nodeId] ?? 100;
}

// ---------------------------------------------------------------------------
// Health check v2: heartbeat trễ + lỗi liên tiếp
// ---------------------------------------------------------------------------

/** Kết quả health check v16 cho một node. */
export interface FleetV16HealthCheck {
  nodeId: string;
  health: FleetV14Node['health'];
  /** Heartbeat trễ bao lâu (ms, null = chưa từng heartbeat). */
  heartbeatAgeMs: number | null;
  missedHeartbeats: number;
  reasons: string[];
  at: number;
}

/** Số heartbeat trượt liên tiếp (ước lượng từ độ trễ / chu kỳ heartbeat). */
export function fleetV16MissedHeartbeats(
  node: FleetV14Node,
  heartbeatIntervalMs: number,
  now = Date.now(),
): number {
  if (node.lastHeartbeatAt === null) return 0;
  const age = now - node.lastHeartbeatAt;
  if (age <= heartbeatIntervalMs) return 0;
  return Math.floor(age / heartbeatIntervalMs);
}

/**
 * Health check v16: kết hợp sample v14 (CPU/RAM/disk/lỗi task)
 * với độ trễ heartbeat. Heartbeat stale thắng sample tốt — node
 * không liên lạc được thì không thể tin sample cũ.
 */
export function checkFleetV16NodeHealth(
  node: FleetV14Node,
  sample: FleetV14HealthSample | null,
  heartbeatIntervalMs = 30 * 1000,
  now = Date.now(),
): FleetV16HealthCheck {
  const reasons: string[] = [];
  let health: FleetV14Node['health'] = 'healthy';
  const heartbeatAgeMs = node.lastHeartbeatAt === null ? null : Math.max(0, now - node.lastHeartbeatAt);
  const missed = fleetV16MissedHeartbeats(node, heartbeatIntervalMs, now);
  if (heartbeatAgeMs === null) {
    health = 'down';
    reasons.push('chưa từng nhận heartbeat');
  } else if (heartbeatAgeMs >= FLEET_V16_HEARTBEAT_DOWN_MS || missed >= FLEET_V16_MAX_MISSED_HEARTBEATS * 5) {
    health = 'down';
    reasons.push(`heartbeat trễ ${Math.round(heartbeatAgeMs / 1000)}s`);
  } else if (heartbeatAgeMs >= FLEET_V16_HEARTBEAT_UNHEALTHY_MS) {
    health = 'unhealthy';
    reasons.push(`heartbeat trễ ${Math.round(heartbeatAgeMs / 1000)}s`);
  } else if (heartbeatAgeMs >= FLEET_V16_HEARTBEAT_WARN_MS) {
    health = 'degraded';
    reasons.push(`heartbeat trễ ${Math.round(heartbeatAgeMs / 1000)}s`);
  }
  if (missed >= FLEET_V16_MAX_MISSED_HEARTBEATS && health === 'healthy') {
    health = 'degraded';
    reasons.push(`trượt ${missed} heartbeat liên tiếp`);
  }
  if (sample) {
    if (sample.cpuFraction > 0.95 || sample.ramFraction > 0.95) {
      if (health === 'healthy') health = 'degraded';
      reasons.push('CPU/RAM trên 95%');
    }
    if (sample.diskFreeMb < 1024) {
      health = 'unhealthy';
      reasons.push(`disk trống chỉ còn ${sample.diskFreeMb} MB`);
    }
    if (sample.recentTaskErrors >= 10) {
      if (health === 'healthy') health = 'degraded';
      reasons.push(`${sample.recentTaskErrors} task lỗi gần đây`);
    }
  }
  return { nodeId: node.nodeId, health, heartbeatAgeMs, missedHeartbeats: missed, reasons, at: now };
}

/** Node down quá lâu → đề xuất gỡ khỏi fleet (id + lý do). */
export function fleetV16StaleNodesToRemove(
  snapshot: FleetV14Snapshot,
  now = Date.now(),
): { nodeId: string; downForMs: number }[] {
  const out: { nodeId: string; downForMs: number }[] = [];
  for (const node of snapshot.nodes) {
    if (node.health !== 'down') continue;
    if (node.lastHeartbeatAt === null) continue;
    const downForMs = now - node.lastHeartbeatAt;
    if (downForMs >= FLEET_V16_DOWN_REMOVE_AFTER_MS) {
      out.push({ nodeId: node.nodeId, downForMs });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Phân phối tải: 3 chiến lược
// ---------------------------------------------------------------------------

export type FleetV16DistributeStrategy = 'least-loaded' | 'least-connections' | 'weighted-round-robin';

export const FLEET_V16_DISTRIBUTE_STRATEGIES: readonly FleetV16DistributeStrategy[] = [
  'least-loaded',
  'least-connections',
  'weighted-round-robin',
];

/** State smooth weighted round-robin (giữ trong bộ nhớ caller). */
export interface FleetV16WrrState {
  /** currentWeight hiện tại của từng node (theo thuật toán SWRR). */
  currentWeights: Record<string, number>;
}

/** Node có đủ điều kiện nhận task không (active + khỏe + đủ tài nguyên + khớp label). */
export function fleetV16NodeEligible(
  node: FleetV14Node,
  task: FleetV14Task,
): { eligible: boolean; reason: string } {
  if (node.status !== 'active') return { eligible: false, reason: `status=${node.status}` };
  if (node.health === 'down' || node.health === 'unhealthy') {
    return { eligible: false, reason: `health=${node.health}` };
  }
  if (!fleetV14NodeEligibleForTask(node, task)) {
    return { eligible: false, reason: 'không đủ tài nguyên hoặc không khớp label' };
  }
  return { eligible: true, reason: '' };
}

export interface FleetV16PickResult {
  nodeId: string | null;
  strategy: FleetV16DistributeStrategy;
  /** Lý do khi không chọn được node nào. */
  reason: string;
  /** Trạng thái WRR mới (chỉ dùng cho weighted-round-robin). */
  wrrState: FleetV16WrrState | null;
}

/**
 * Chọn node cho một task theo chiến lược. Smooth WRR (nginx-style):
 * mỗi lần chọn cộng weight vào currentWeight của mọi node đủ điều
 * kiện, chọn node có currentWeight cao nhất rồi trừ tổng weight —
 * phân phối đúng tỉ lệ weight theo thời gian mà không dồn cục.
 */
export function pickFleetV16NodeForTask(
  snapshot: FleetV14Snapshot,
  task: FleetV14Task,
  strategy: FleetV16DistributeStrategy,
  wrrState: FleetV16WrrState | null = null,
): FleetV16PickResult {
  const eligible = snapshot.nodes.filter((n) => fleetV16NodeEligible(n, task).eligible);
  if (eligible.length === 0) {
    return { nodeId: null, strategy, reason: 'không có node active/khỏe/đủ tài nguyên cho task', wrrState: null };
  }
  if (strategy === 'least-loaded') {
    let best = eligible[0];
    for (const node of eligible.slice(1)) {
      if (fleetV14NodeLoad(node) < fleetV14NodeLoad(best)) best = node;
    }
    return { nodeId: best.nodeId, strategy, reason: '', wrrState: null };
  }
  if (strategy === 'least-connections') {
    let best = eligible[0];
    for (const node of eligible.slice(1)) {
      if (node.runningTaskIds.length < best.runningTaskIds.length) best = node;
    }
    return { nodeId: best.nodeId, strategy, reason: '', wrrState: null };
  }
  // weighted-round-robin mượt.
  const currentWeights: Record<string, number> = { ...(wrrState?.currentWeights ?? {}) };
  let totalWeight = 0;
  for (const node of eligible) {
    const w = fleetV16NodeWeight(snapshot, node.nodeId);
    totalWeight += w;
    currentWeights[node.nodeId] = (currentWeights[node.nodeId] ?? 0) + w;
  }
  let best = eligible[0];
  for (const node of eligible.slice(1)) {
    if ((currentWeights[node.nodeId] ?? 0) > (currentWeights[best.nodeId] ?? 0)) best = node;
  }
  currentWeights[best.nodeId] = (currentWeights[best.nodeId] ?? 0) - totalWeight;
  return { nodeId: best.nodeId, strategy, reason: '', wrrState: { currentWeights } };
}

/**
 * Phân phối một loạt task theo chiến lược: mô phỏng tải trong bộ
 * nhớ (task đã gán làm tăng load tạm của node đích) để không dồn
 * nhiều task vào cùng một node trong cùng một lượt.
 */
export function distributeFleetV16Tasks(
  snapshot: FleetV14Snapshot,
  tasks: readonly FleetV14Task[],
  strategy: FleetV16DistributeStrategy,
): { assignments: { taskId: string; nodeId: string | null }[]; unassigned: string[] } {
  // Snapshot mô phỏng: clone nông nodes + runningTaskIds để load tăng dần.
  let sim: FleetV14Snapshot = {
    ...snapshot,
    nodes: snapshot.nodes.map((n) => ({ ...n, runningTaskIds: [...n.runningTaskIds] })),
  };
  let wrr: FleetV16WrrState | null = null;
  const assignments: { taskId: string; nodeId: string | null }[] = [];
  const unassigned: string[] = [];
  for (const task of tasks) {
    const pick = pickFleetV16NodeForTask(sim, task, strategy, wrr);
    wrr = pick.wrrState ?? wrr;
    assignments.push({ taskId: task.taskId, nodeId: pick.nodeId });
    if (pick.nodeId === null) {
      unassigned.push(task.taskId);
      continue;
    }
    // Mô phỏng: task chiếm 1 slot + tài nguyên khai báo trên node đích.
    sim = {
      ...sim,
      nodes: sim.nodes.map((n) => {
        if (n.nodeId !== pick.nodeId) return n;
        const free = fleetV14NodeFreeResources(n);
        return {
          ...n,
          runningTaskIds: [...n.runningTaskIds, task.taskId],
          usedCpuCores: n.usedCpuCores + Math.min(task.cpuCores, free.cpuCores),
          usedRamMb: n.usedRamMb + Math.min(task.ramMb, free.ramMb),
          usedVramMb: n.usedVramMb + Math.min(task.vramMb, free.vramMb),
        };
      }),
    };
  }
  return { assignments, unassigned };
}

// ---------------------------------------------------------------------------
// Vòng đời node
// ---------------------------------------------------------------------------

/** Bảng chuyển đổi trạng thái cho phép (không cho nhảy cóc). */
export const FLEET_V16_ALLOWED_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  joining: ['active', 'down', 'removed'],
  active: ['draining', 'maintenance', 'down'],
  draining: ['active', 'removed'],
  maintenance: ['active', 'down', 'removed'],
  down: ['joining', 'active', 'removed'],
  removed: [],
};

export interface FleetV16TransitionResult {
  ok: boolean;
  snapshot: FleetV14Snapshot;
  error: string;
}

/** Chuyển trạng thái node theo bảng cho phép. */
export function transitionFleetV16NodeStatus(
  snapshot: FleetV14Snapshot,
  nodeId: string,
  toStatus: FleetV14Node['status'],
  reason = '',
  now = Date.now(),
): FleetV16TransitionResult {
  const node = snapshot.nodes.find((n) => n.nodeId === nodeId);
  if (!node) return { ok: false, snapshot, error: `không tìm thấy node: ${nodeId}` };
  const allowed = FLEET_V16_ALLOWED_TRANSITIONS[node.status] ?? [];
  if (!allowed.includes(toStatus)) {
    return { ok: false, snapshot, error: `không được chuyển node từ ${node.status} sang ${toStatus}` };
  }
  const nodes = snapshot.nodes.map((n) =>
    n.nodeId === nodeId
      ? {
          ...n,
          status: toStatus,
          drainStartedAt: toStatus === 'draining' ? now : n.drainStartedAt,
          maintenanceReason: toStatus === 'maintenance' ? reason : n.maintenanceReason,
        }
      : n,
  );
  return { ok: true, snapshot: { ...snapshot, nodes }, error: '' };
}

export interface FleetV16DecommissionResult {
  ok: boolean;
  snapshot: FleetV14Snapshot;
  /** Task đang chạy trên node (phải di chuyển trước khi decommission không force). */
  blockingTaskIds: string[];
  error: string;
}

/**
 * Decommission node: chỉ khi không còn task đang chạy — nếu còn
 * task mà không force thì chặn kèm danh sách task; force thì chuyển
 * thẳng sang `removed` (caller tự di chuyển task theo danh sách
 * trả về trước).
 */
export function decommissionFleetV16Node(
  snapshot: FleetV14Snapshot,
  nodeId: string,
  force = false,
): FleetV16DecommissionResult {
  const node = snapshot.nodes.find((n) => n.nodeId === nodeId);
  if (!node) return { ok: false, snapshot, blockingTaskIds: [], error: `không tìm thấy node: ${nodeId}` };
  if (node.status === 'removed') {
    return { ok: false, snapshot, blockingTaskIds: [], error: `node đã removed: ${nodeId}` };
  }
  if (node.runningTaskIds.length > 0 && !force) {
    return {
      ok: false,
      snapshot,
      blockingTaskIds: [...node.runningTaskIds],
      error: `node còn ${node.runningTaskIds.length} task đang chạy — di chuyển trước hoặc dùng force`,
    };
  }
  const nodes = snapshot.nodes.map((n) => (n.nodeId === nodeId ? { ...n, status: 'removed' as const } : n));
  return { ok: true, snapshot: { ...snapshot, nodes }, blockingTaskIds: [...node.runningTaskIds], error: '' };
}

/** Tóm tắt fleet v16 cho panel: đếm node theo status/health + tải chung. */
export interface FleetV16Summary {
  totalNodes: number;
  byStatus: Record<string, number>;
  byHealth: Record<string, number>;
  totalRunningTasks: number;
  averageLoad: number;
  staleNodes: string[];
}

export function summarizeFleetV16(snapshot: FleetV14Snapshot, now = Date.now()): FleetV16Summary {
  const byStatus: Record<string, number> = {};
  const byHealth: Record<string, number> = {};
  let totalRunningTasks = 0;
  let loadSum = 0;
  for (const node of snapshot.nodes) {
    byStatus[node.status] = (byStatus[node.status] ?? 0) + 1;
    byHealth[node.health] = (byHealth[node.health] ?? 0) + 1;
    totalRunningTasks += node.runningTaskIds.length;
    loadSum += fleetV14NodeLoad(node);
  }
  return {
    totalNodes: snapshot.nodes.length,
    byStatus,
    byHealth,
    totalRunningTasks,
    averageLoad: snapshot.nodes.length > 0 ? loadSum / snapshot.nodes.length : 0,
    staleNodes: fleetV16StaleNodesToRemove(snapshot, now).map((s) => s.nodeId),
  };
}
