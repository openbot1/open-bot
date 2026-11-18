/**
 * Node model cho fleet v21 (v1.34, Đội T6).
 *
 * Một node là một máy (host vật lý / VM / máy của user) mà fleet đặt
 * bot run lên. Module này chỉ giữ DỮ LIỆU + tính toán thuần trên dữ
 * liệu đó: không đọc file, không chạm mạng, không spawn process.
 * Scheduler (`scheduler.ts`) và placement (`placement.ts`) đọc node
 * qua các hàm ở đây; dashboard (`panelsV21.ts`) render từ đây.
 *
 * Trạng thái node:
 * - `online`: nhận run mới bình thường.
 * - `draining`: còn chạy run cũ, KHÔNG nhận run mới (chuẩn bị rút).
 * - `offline`: mất heartbeat nhưng chưa kết luận chết (có thể quay lại).
 * - `dead`: đã chết (quá `NODE_DEAD_AFTER_MS` không heartbeat, hoặc
 *   admin đánh dấu) — run của nó phải được rebalance (xem placement).
 */

import type { SandboxTierV21 } from './tiers';
import { tierSatisfiesV21 } from './tiers';

/** Trạng thái vòng đời của node. */
export type FleetV21NodeStatus = 'online' | 'draining' | 'offline' | 'dead';

/** Mọi trạng thái — dùng để validate / lọc ở UI. */
export const FLEET_V21_NODE_STATUSES: readonly FleetV21NodeStatus[] = ['online', 'draining', 'offline', 'dead'];

/** Không heartbeat quá ngần này ms thì node `offline` được coi là `dead`. */
export const NODE_DEAD_AFTER_MS = 5 * 60 * 1000;

/** Node được coi là quá tải khi CPU hoặc RAM dùng trên ngần này. */
export const NODE_OVERLOAD_FRACTION = 0.9;

/** Node được coi là "nóng" (cảnh báo sớm) khi CPU hoặc RAM dùng trên ngần này. */
export const NODE_HOT_FRACTION = 0.75;

/** Một node trong fleet v21. */
export interface FleetV21Node {
  /** Id duy nhất (ổn định qua restart — không dùng hostname đổi được). */
  id: string;
  /** Tên hiển thị (vd `gpu-node-01`). */
  name: string;
  /** Tier cách ly mạnh nhất node hỗ trợ (kèm mọi tier thấp hơn). */
  maxTier: SandboxTierV21;
  /** Trạng thái vòng đời. */
  status: FleetV21NodeStatus;
  /** Tổng CPU (core, có thể lẻ: 1.5). */
  cpuCores: number;
  /** CPU đang dùng (core). */
  cpuUsed: number;
  /** Tổng RAM (byte). */
  ramBytes: number;
  /** RAM đang dùng (byte). */
  ramUsed: number;
  /** Tổng disk (byte). */
  diskBytes: number;
  /** Disk đang dùng (byte). */
  diskUsed: number;
  /** Độ trễ đo được tới node (ms) — null khi chưa đo. */
  latencyMs: number | null;
  /**
   * Độ tin cậy 0..1 (từ uptime + tỉ lệ run thành công — host cập nhật,
   * module này không tự bịa: mặc định 1 cho node mới, giảm khi lỗi).
   */
  reliability: number;
  /** Số run đang chạy trên node (đếm từ placement, để dashboard khỏi đếm lại). */
  runCount: number;
  /** Nhãn tự do (vd `gpu`, `eu-west`, `spot`) — dùng cho affinity. */
  labels: string[];
  /** Lần cuối nhận heartbeat (epoch ms). */
  lastSeenAt: number;
  /** Khi node được thêm vào fleet (epoch ms). */
  joinedAt: number;
  /** Lý do chết/rút (vd `heartbeat timeout`, `admin drain`) — nếu có. */
  statusReason?: string;
}

/** Tạo node mới với giá trị mặc định hợp lý (reliability 1, online). */
export function createFleetV21Node(input: {
  id: string;
  name?: string;
  maxTier: SandboxTierV21;
  cpuCores: number;
  ramBytes: number;
  diskBytes: number;
  latencyMs?: number | null;
  labels?: string[];
  now?: number;
  /** Trạng thái ban đầu (mặc định 0 — dùng cho fixture/test và khi host đã biết tải node). */
  cpuUsed?: number;
  ramUsed?: number;
  diskUsed?: number;
  /** Độ tin cậy ban đầu 0..1 (mặc định 1). */
  reliability?: number;
  /** Số run đang chạy ban đầu (mặc định 0). */
  runCount?: number;
}): FleetV21Node {
  const now = input.now ?? Date.now();
  return {
    id: input.id,
    name: input.name ?? input.id,
    maxTier: input.maxTier,
    status: 'online',
    cpuCores: input.cpuCores,
    cpuUsed: Math.max(0, input.cpuUsed ?? 0),
    ramBytes: input.ramBytes,
    ramUsed: Math.max(0, input.ramUsed ?? 0),
    diskBytes: input.diskBytes,
    diskUsed: Math.max(0, input.diskUsed ?? 0),
    latencyMs: input.latencyMs ?? null,
    reliability: Math.min(1, Math.max(0, input.reliability ?? 1)),
    runCount: Math.max(0, Math.floor(input.runCount ?? 0)),
    labels: [...(input.labels ?? [])],
    lastSeenAt: now,
    joinedAt: now,
  };
}

// ---------------------------------------------------------------------------
// Dung lượng trống / tỉ lệ dùng
// ---------------------------------------------------------------------------

/** CPU trống (core, không âm — node dùng quá công suất thì trống = 0). */
export function nodeFreeCpuV21(node: FleetV21Node): number {
  return Math.max(0, node.cpuCores - node.cpuUsed);
}

/** RAM trống (byte, không âm). */
export function nodeFreeRamV21(node: FleetV21Node): number {
  return Math.max(0, node.ramBytes - node.ramUsed);
}

/** Disk trống (byte, không âm). */
export function nodeFreeDiskV21(node: FleetV21Node): number {
  return Math.max(0, node.diskBytes - node.diskUsed);
}

/** Tỉ lệ CPU đang dùng 0..1 (trên 1 = dùng quá công suất). */
export function nodeCpuFractionV21(node: FleetV21Node): number {
  return node.cpuCores > 0 ? node.cpuUsed / node.cpuCores : 1;
}

/** Tỉ lệ RAM đang dùng 0..1. */
export function nodeRamFractionV21(node: FleetV21Node): number {
  return node.ramBytes > 0 ? node.ramUsed / node.ramBytes : 1;
}

/** Tỉ lệ disk đang dùng 0..1. */
export function nodeDiskFractionV21(node: FleetV21Node): number {
  return node.diskBytes > 0 ? node.diskUsed / node.diskBytes : 1;
}

/** Tải nặng nhất của node (max CPU/RAM/disk fraction) — 1 số để so sánh. */
export function nodeLoadV21(node: FleetV21Node): number {
  return Math.max(nodeCpuFractionV21(node), nodeRamFractionV21(node), nodeDiskFractionV21(node));
}

/** true khi node quá tải (CPU hoặc RAM >= 90% — disk đầy không tính là quá tải chạy). */
export function nodeIsOverloadedV21(node: FleetV21Node): boolean {
  return nodeCpuFractionV21(node) >= NODE_OVERLOAD_FRACTION || nodeRamFractionV21(node) >= NODE_OVERLOAD_FRACTION;
}

/** true khi node "nóng" (cảnh báo sớm, >= 75% CPU hoặc RAM). */
export function nodeIsHotV21(node: FleetV21Node): boolean {
  return nodeCpuFractionV21(node) >= NODE_HOT_FRACTION || nodeRamFractionV21(node) >= NODE_HOT_FRACTION;
}

// ---------------------------------------------------------------------------
// Đủ tài nguyên / đủ tier cho một run?
// ---------------------------------------------------------------------------

/** Tài nguyên một run cần (đơn vị như node: core / byte / byte). */
export interface FleetV21RunDemand {
  cpuCores: number;
  ramBytes: number;
  diskBytes: number;
}

/** true khi node còn đủ CPU/RAM/disk cho demand (không xét tier/status). */
export function nodeFitsDemandV21(node: FleetV21Node, demand: FleetV21RunDemand): boolean {
  return (
    nodeFreeCpuV21(node) >= demand.cpuCores &&
    nodeFreeRamV21(node) >= demand.ramBytes &&
    nodeFreeDiskV21(node) >= demand.diskBytes
  );
}

/** Tài nguyên còn thiếu (0 cho tài nguyên đã đủ) — để scheduler giải thích rõ. */
export function nodeDemandShortfallV21(
  node: FleetV21Node,
  demand: FleetV21RunDemand,
): { cpuCores: number; ramBytes: number; diskBytes: number } {
  return {
    cpuCores: Math.max(0, demand.cpuCores - nodeFreeCpuV21(node)),
    ramBytes: Math.max(0, demand.ramBytes - nodeFreeRamV21(node)),
    diskBytes: Math.max(0, demand.diskBytes - nodeFreeDiskV21(node)),
  };
}

/** true khi node hỗ trợ tier tối thiểu mà run yêu cầu. */
export function nodeSupportsTierV21(node: FleetV21Node, minTier: SandboxTierV21): boolean {
  return tierSatisfiesV21(node.maxTier, minTier);
}

/** true khi node nhận được run mới: online + đủ tier + đủ tài nguyên. */
export function nodeCanAcceptV21(
  node: FleetV21Node,
  demand: FleetV21RunDemand,
  minTier: SandboxTierV21,
): boolean {
  return node.status === 'online' && nodeSupportsTierV21(node, minTier) && nodeFitsDemandV21(node, demand);
}

/** Lý do node KHÔNG nhận được run (rỗng = nhận được) — scheduler dùng để giải thích. */
export function nodeRejectReasonsV21(
  node: FleetV21Node,
  demand: FleetV21RunDemand,
  minTier: SandboxTierV21,
): string[] {
  const reasons: string[] = [];
  if (node.status !== 'online') {
    reasons.push(`node đang ${node.status}${node.statusReason ? ` (${node.statusReason})` : ''}, không nhận run mới`);
  }
  if (!nodeSupportsTierV21(node, minTier)) {
    reasons.push(`node chỉ hỗ trợ tới tier ${node.maxTier}, run cần tối thiểu ${minTier}`);
  }
  const short = nodeDemandShortfallV21(node, demand);
  if (short.cpuCores > 0) reasons.push(`thiếu ${short.cpuCores} CPU core`);
  if (short.ramBytes > 0) reasons.push(`thiếu ${Math.round(short.ramBytes / 1024 / 1024)} MB RAM`);
  if (short.diskBytes > 0) reasons.push(`thiếu ${Math.round(short.diskBytes / 1024 / 1024)} MB disk`);
  return reasons;
}

// ---------------------------------------------------------------------------
// Heartbeat / vòng đời
// ---------------------------------------------------------------------------

/** Cập nhật heartbeat: node offline → online trở lại (giữ nguyên draining/dead). */
export function nodeHeartbeatV21(node: FleetV21Node, now: number = Date.now()): FleetV21Node {
  return {
    ...node,
    lastSeenAt: now,
    status: node.status === 'offline' ? 'online' : node.status,
    ...(node.status === 'offline' ? { statusReason: undefined } : {}),
  };
}

/**
 * Suy ra trạng thái từ heartbeat: node `online` quá lâu không heartbeat
 * → `offline`; node `offline` quá `NODE_DEAD_AFTER_MS` → `dead`.
 * Trả về node mới (không mutate) + có đổi trạng thái không.
 */
export function nodeAgeStatusV21(
  node: FleetV21Node,
  now: number = Date.now(),
): { node: FleetV21Node; changed: boolean } {
  if (node.status === 'dead' || node.status === 'draining') return { node, changed: false };
  const silentMs = Math.max(0, now - node.lastSeenAt);
  if (node.status === 'offline' && silentMs >= NODE_DEAD_AFTER_MS) {
    return {
      node: { ...node, status: 'dead', statusReason: `mất heartbeat ${Math.round(silentMs / 1000)}s` },
      changed: true,
    };
  }
  if (node.status === 'online' && silentMs >= NODE_DEAD_AFTER_MS) {
    return {
      node: { ...node, status: 'offline', statusReason: `mất heartbeat ${Math.round(silentMs / 1000)}s` },
      changed: true,
    };
  }
  return { node, changed: false };
}

/** Đánh dấu node bắt đầu rút (draining) — run cũ vẫn chạy, không nhận run mới. */
export function nodeStartDrainV21(node: FleetV21Node, reason = 'admin drain'): FleetV21Node {
  if (node.status === 'dead') return node;
  return { ...node, status: 'draining', statusReason: reason };
}

/** Đánh dấu node chết (admin, hoặc heartbeat đã kết luận) — run của nó cần rebalance. */
export function nodeMarkDeadV21(node: FleetV21Node, reason = 'node chết'): FleetV21Node {
  return { ...node, status: 'dead', statusReason: reason };
}

/** Cập nhật độ tin cậy sau một run (thành công tăng nhẹ, thất bại giảm mạnh, kẹp 0..1). */
export function nodeRecordRunOutcomeV21(node: FleetV21Node, succeeded: boolean): FleetV21Node {
  const delta = succeeded ? 0.01 : -0.1;
  return { ...node, reliability: Math.min(1, Math.max(0, node.reliability + delta)) };
}

// ---------------------------------------------------------------------------
// Registry trong bộ nhớ (fleet v21 giữ state ở host; module này thuần)
// ---------------------------------------------------------------------------

/** Registry node trong bộ nhớ — host giữ 1 instance, truyền vào scheduler/placement. */
export class FleetV21NodeRegistry {
  private readonly nodes = new Map<string, FleetV21Node>();

  /** Thêm node mới (id trùng → throw, không ghi đè lén). */
  add(node: FleetV21Node): void {
    if (this.nodes.has(node.id)) throw new Error(`Node "${node.id}" đã tồn tại trong fleet v21.`);
    this.nodes.set(node.id, { ...node, labels: [...node.labels] });
  }

  /** Thay thế node đã có (id chưa có → throw). */
  update(node: FleetV21Node): void {
    if (!this.nodes.has(node.id)) throw new Error(`Node "${node.id}" chưa có trong fleet v21.`);
    this.nodes.set(node.id, { ...node, labels: [...node.labels] });
  }

  /** Upsert: có thì thay, chưa có thì thêm (dùng khi sync từ host). */
  upsert(node: FleetV21Node): void {
    this.nodes.set(node.id, { ...node, labels: [...node.labels] });
  }

  /** Xoá node (không có → false). */
  remove(nodeId: string): boolean {
    return this.nodes.delete(nodeId);
  }

  /** Lấy 1 node (không có → undefined). */
  get(nodeId: string): FleetV21Node | undefined {
    const node = this.nodes.get(nodeId);
    return node ? { ...node, labels: [...node.labels] } : undefined;
  }

  /** Mọi node (bản sao — sửa ngoài không ảnh hưởng registry). */
  list(): FleetV21Node[] {
    return [...this.nodes.values()].map((n) => ({ ...n, labels: [...n.labels] }));
  }

  /** Node đang online (nhận run mới được). */
  online(): FleetV21Node[] {
    return this.list().filter((n) => n.status === 'online');
  }

  /** Node hỗ trợ tier tối thiểu (bất kể status — để scheduler giải thích rõ). */
  supporting(minTier: SandboxTierV21): FleetV21Node[] {
    return this.list().filter((n) => nodeSupportsTierV21(n, minTier));
  }

  /** Tổng dung lượng + đang dùng của cả fleet (cho dashboard). */
  totals(): {
    nodes: number;
    online: number;
    cpuCores: number;
    cpuUsed: number;
    ramBytes: number;
    ramUsed: number;
    diskBytes: number;
    diskUsed: number;
    runs: number;
    overloaded: number;
    dead: number;
  } {
    const list = this.list();
    return {
      nodes: list.length,
      online: list.filter((n) => n.status === 'online').length,
      cpuCores: list.reduce((s, n) => s + n.cpuCores, 0),
      cpuUsed: list.reduce((s, n) => s + n.cpuUsed, 0),
      ramBytes: list.reduce((s, n) => s + n.ramBytes, 0),
      ramUsed: list.reduce((s, n) => s + n.ramUsed, 0),
      diskBytes: list.reduce((s, n) => s + n.diskBytes, 0),
      diskUsed: list.reduce((s, n) => s + n.diskUsed, 0),
      runs: list.reduce((s, n) => s + n.runCount, 0),
      overloaded: list.filter(nodeIsOverloadedV21).length,
      dead: list.filter((n) => n.status === 'dead').length,
    };
  }

  /** Áp dụng ageing heartbeat cho mọi node, trả về id các node đổi trạng thái. */
  ageAll(now: number = Date.now()): string[] {
    const changed: string[] = [];
    for (const node of this.nodes.values()) {
      const aged = nodeAgeStatusV21(node, now);
      if (aged.changed) {
        this.nodes.set(node.id, aged.node);
        changed.push(node.id);
      }
    }
    return changed;
  }

  get size(): number {
    return this.nodes.size;
  }
}

/** Validate node từ dữ liệu ngoài (file/UI): trả về lỗi, rỗng = hợp lệ. */
export function validateFleetV21Node(input: unknown): string[] {
  const errors: string[] = [];
  if (typeof input !== 'object' || input === null) return ['node phải là object.'];
  const n = input as Record<string, unknown>;
  if (typeof n.id !== 'string' || n.id.trim().length === 0) errors.push('node.id phải là chuỗi không rỗng.');
  if (typeof n.maxTier !== 'string' || !['bwrap', 'syscall-policy', 'microvm'].includes(n.maxTier)) {
    errors.push('node.maxTier phải là bwrap, syscall-policy hoặc microvm.');
  }
  for (const field of ['cpuCores', 'ramBytes', 'diskBytes'] as const) {
    if (typeof n[field] !== 'number' || !Number.isFinite(n[field]) || (n[field] as number) < 0) {
      errors.push(`node.${field} phải là số >= 0.`);
    }
  }
  if (typeof n.reliability === 'number' && (n.reliability < 0 || n.reliability > 1)) {
    errors.push('node.reliability phải trong 0..1.');
  }
  return errors;
}
