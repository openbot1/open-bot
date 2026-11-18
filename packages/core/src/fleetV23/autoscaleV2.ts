/**
 * Autoscale v2 cho fleet v23 (v1.36, Đội T6) — đề xuất tăng/giảm node
 * theo capacity + hàng đợi.
 *
 * Capacity planning (`placementV2.ts`) chỉ DỰ BÁO ngày hết chỗ; nó
 * không nói host phải làm gì HÔM NAY. Rebalance v2 chỉ XẾP LẠI bot
 * trên node hiện có; nó không thêm node mới. Module này là bước tiếp
 * theo: từ dự báo + độ dài hàng đợi + SLA, đề xuất scale-out (thêm
 * node) hay scale-in (bớt node) — và NÓI RÕ vì sao, tốn thêm bao
 * nhiêu $/tháng, bao giờ được đề xuất lại (cooldown).
 *
 * Luật đề xuất (theo thứ tự, scale-out được xét trước vì thiếu chỗ
 * nguy hiểm hơn thừa chỗ):
 *
 * SCALE-OUT (thêm node) khi MỘT trong các điều kiện đúng:
 * 1. Có job breach SLA VÀ không còn node nào đặt được job đó (hàng
 *    đợi tắc vì hết chỗ, không phải vì job lỗi).
 * 2. Capacity forecast báo URGENT (một loại tài nguyên hết trong
 *    <= 3 tháng) VÀ hàng đợi đang dài (queued >= ngưỡng).
 * 3. Job chờ lâu nhất vượt ngưỡng chờ (vd > 10 phút) VÀ node trung
 *    bình đã dùng > 80% CPU (hết chỗ thật, không phải job kẹt vì
 *    topology).
 *
 * SCALE-IN (bớt node) khi TẤT CẢ đúng:
 * 1. Hàng đợi rỗng (không job queued/running nào chờ chỗ).
 * 2. Không job breach SLA.
 * 3. Node lạnh nhất dùng < ngưỡng idle (vd < 15% CPU) VÀ fleet còn
 *    trên minNodes (không scale về 0 node).
 * 4. Không có forecast urgent (đừng bớt node khi sắp hết chỗ).
 *
 * COOLDOWN: sau một lần scale (host báo `lastScaleAtMs`), trong
 * `cooldownMs` không đề xuất gì thêm — tránh scale-out rồi scale-in
 * liên tục khi số liệu chưa ổn định. Khi đang cooldown, hàm trả về
 * action `none` kèm `cooldownRemainingMs` để UI nói rõ "đợi X phút
 * nữa mới đề xuất lại".
 *
 * Module thuần: không mua/thuê node thật — host đọc đề xuất rồi thực
 * thi (mua node / tắt node / báo user).
 */

import type { FleetV23ExhaustionForecast } from './placementV2';
import type { FleetV23NodeSnapshot } from './placementV2';
import type { FleetV23Job } from './schedulerV2';
import { breachedSlaJobsV23, snapshotFleetV23Queue } from './schedulerV2';

/** Hành động autoscale. */
export type FleetV23AutoscaleAction = 'scale-out' | 'scale-in' | 'none';

/** Mọi hành động autoscale. */
export const FLEET_V23_AUTOSCALE_ACTIONS: readonly FleetV23AutoscaleAction[] = ['scale-out', 'scale-in', 'none'];

/** Chính sách autoscale (host cấu hình; mọi ngưỡng đều có mặc định). */
export interface FleetV23AutoscalePolicy {
  /** Số node tối thiểu (không scale-in dưới mức này). */
  minNodes: number;
  /** Số node tối đa (không scale-out trên mức này). */
  maxNodes: number;
  /** Hàng đợi dài bao nhiêu job thì tính là "dài" (cho điều kiện forecast-urgent). */
  queueLengthThreshold: number;
  /** Job chờ lâu nhất bao nhiêu ms thì tính là "chờ lâu" (mặc định 10 phút). */
  maxWaitMs: number;
  /** Node trung bình dùng trên bao nhiêu % CPU thì tính là "hết chỗ thật" (0..1). */
  highCpuFraction: number;
  /** Node lạnh nhất dùng dưới bao nhiêu % CPU thì tính là "idle" (0..1). */
  idleCpuFraction: number;
  /** Sau một lần scale, đợi bao nhiêu ms mới đề xuất lại. */
  cooldownMs: number;
  /** Chi phí $/giờ của MỘT node mới (host điền theo giá node rẻ nhất; 0 = chưa biết giá). */
  newNodeCostPerHour: number;
}

/** Chính sách mặc định. */
export const DEFAULT_FLEET_V23_AUTOSCALE_POLICY: FleetV23AutoscalePolicy = {
  minNodes: 1,
  maxNodes: 20,
  queueLengthThreshold: 5,
  maxWaitMs: 10 * 60_000,
  highCpuFraction: 0.8,
  idleCpuFraction: 0.15,
  cooldownMs: 30 * 60_000,
  newNodeCostPerHour: 0,
};

/** Validate chính sách autoscale (lỗi → danh sách). */
export function validateFleetV23AutoscalePolicy(input: unknown): string[] {
  const errors: string[] = [];
  if (typeof input !== 'object' || input === null) return ['autoscale policy phải là object.'];
  const p = input as Record<string, unknown>;
  for (const field of ['minNodes', 'maxNodes', 'queueLengthThreshold'] as const) {
    if (typeof p[field] !== 'number' || !Number.isInteger(p[field]) || (p[field] as number) < 0) {
      errors.push(`policy.${field} phải là số nguyên >= 0.`);
    }
  }
  if (typeof p.minNodes === 'number' && typeof p.maxNodes === 'number' && (p.minNodes as number) > (p.maxNodes as number)) {
    errors.push(`policy.minNodes (${p.minNodes as number}) lớn hơn policy.maxNodes (${p.maxNodes as number}).`);
  }
  for (const field of ['highCpuFraction', 'idleCpuFraction'] as const) {
    if (typeof p[field] !== 'number' || (p[field] as number) < 0 || (p[field] as number) > 1) {
      errors.push(`policy.${field} phải là số 0..1.`);
    }
  }
  if (
    typeof p.highCpuFraction === 'number' &&
    typeof p.idleCpuFraction === 'number' &&
    (p.idleCpuFraction as number) >= (p.highCpuFraction as number)
  ) {
    errors.push('policy.idleCpuFraction phải nhỏ hơn policy.highCpuFraction (ngưỡng idle phải dưới ngưỡng "hết chỗ").');
  }
  for (const field of ['maxWaitMs', 'cooldownMs', 'newNodeCostPerHour'] as const) {
    if (typeof p[field] !== 'number' || (p[field] as number) < 0) {
      errors.push(`policy.${field} phải là số >= 0.`);
    }
  }
  return errors;
}

/** Đề xuất autoscale. */
export interface FleetV23ScaleRecommendation {
  /** Hành động đề xuất. */
  action: FleetV23AutoscaleAction;
  /** Thêm/bớt bao nhiêu node (0 khi action = none). */
  nodesDelta: number;
  /** Lý do 1-2 dòng (để UI + audit). */
  reason: string;
  /** Điều kiện nào đã kích hoạt đề xuất (để debug chính sách). */
  triggeredBy: string[];
  /** Chi phí thay đổi $/tháng (+ = tốn thêm, − = tiết kiệm; 0 khi chưa biết giá). */
  monthlyCostDelta: number;
  /** Còn bao nhiêu ms cooldown (0 = không trong cooldown). */
  cooldownRemainingMs: number;
  /** Lúc đề xuất (epoch ms). */
  at: number;
}

/** Tín hiệu đầu vào để đề xuất autoscale. */
export interface FleetV23AutoscaleSignals {
  /** Node hiện tại. */
  nodes: readonly FleetV23NodeSnapshot[];
  /** Job trong scheduler (để tính hàng đợi + breach SLA + chờ lâu nhất). */
  jobs: readonly FleetV23Job[];
  /** Dự báo capacity (từ `forecastFleetV23Capacity`). */
  forecasts: readonly FleetV23ExhaustionForecast[];
  /** Tài nguyên nút thắt (từ forecast) — null khi không hết. */
  bottleneck: 'cpu' | 'ram' | 'disk' | null;
  /** Số node tối đa có thể đặt thêm theo quota/vật lý (host giới hạn). */
  placeableNodes?: number;
}

const HOURS_PER_MONTH = 730;

/**
 * Đề xuất autoscale từ tín hiệu fleet. Thứ tự: cooldown → scale-out
 * (3 điều kiện) → scale-in (4 điều kiện) → none. `lastScaleAtMs` =
 * lúc scale gần nhất (null = chưa scale lần nào).
 */
export function recommendFleetV23Autoscale(
  signals: FleetV23AutoscaleSignals,
  policy: FleetV23AutoscalePolicy = DEFAULT_FLEET_V23_AUTOSCALE_POLICY,
  lastScaleAtMs: number | null = null,
  now: number = Date.now(),
): FleetV23ScaleRecommendation {
  const policyErrors = validateFleetV23AutoscalePolicy(policy);
  if (policyErrors.length > 0) throw new Error(`Autoscale policy không hợp lệ: ${policyErrors.join(' ')}`);
  const base = (action: FleetV23AutoscaleAction, nodesDelta: number, reason: string, triggeredBy: string[], cooldownRemainingMs = 0): FleetV23ScaleRecommendation => ({
    action,
    nodesDelta,
    reason,
    triggeredBy,
    monthlyCostDelta:
      action === 'none'
        ? 0
        : Math.round(policy.newNodeCostPerHour * nodesDelta * HOURS_PER_MONTH * 100) / 100,
    cooldownRemainingMs,
    at: now,
  });

  // Cooldown: chưa đủ thời gian từ lần scale trước → không đề xuất gì.
  if (lastScaleAtMs !== null && now - lastScaleAtMs < policy.cooldownMs) {
    const remaining = policy.cooldownMs - (now - lastScaleAtMs);
    return base(
      'none',
      0,
      `Đang cooldown sau lần scale trước (còn ${Math.ceil(remaining / 1000)}s) — chưa đề xuất lại để số liệu ổn định.`,
      ['cooldown'],
      remaining,
    );
  }

  const queue = snapshotFleetV23Queue(signals.jobs, now);
  const breached = breachedSlaJobsV23(signals.jobs, now);
  const urgentForecast = signals.forecasts.find((f) => f.urgent);
  const nodeCount = signals.nodes.length;
  const meanCpuUsed =
    nodeCount === 0
      ? 0
      : signals.nodes.reduce((s, n) => s + (n.cpuCores > 0 ? 1 - n.cpuFree / n.cpuCores : 0), 0) / nodeCount;
  const coldestCpuUsed =
    nodeCount === 0
      ? 0
      : Math.min(...signals.nodes.map((n) => (n.cpuCores > 0 ? 1 - n.cpuFree / n.cpuCores : 0)));

  // --- Scale-out -------------------------------------------------------
  const scaleOutReasons: string[] = [];
  if (breached.length > 0) {
    scaleOutReasons.push(`SLA breach: ${breached.length} job quá deadline (${breached.slice(0, 3).join(', ')}${breached.length > 3 ? ', …' : ''})`);
  }
  if (urgentForecast && queue.queued >= policy.queueLengthThreshold) {
    scaleOutReasons.push(
      `Capacity urgent: ${urgentForecast.resource.toUpperCase()} hết trong ${urgentForecast.monthsUntilExhaustion} tháng, hàng đợi ${queue.queued} job (>= ${policy.queueLengthThreshold})`,
    );
  }
  if (queue.longestWaitMs > policy.maxWaitMs && meanCpuUsed > policy.highCpuFraction) {
    scaleOutReasons.push(
      `Job chờ lâu nhất ${Math.round(queue.longestWaitMs / 1000)}s (ngưỡng ${Math.round(policy.maxWaitMs / 1000)}s), node trung bình dùng ${Math.round(meanCpuUsed * 100)}% CPU (ngưỡng ${Math.round(policy.highCpuFraction * 100)}%)`,
    );
  }
  if (scaleOutReasons.length > 0) {
    if (nodeCount >= policy.maxNodes) {
      return base(
        'none',
        0,
        `Cần scale-out (${scaleOutReasons.join('; ')}) nhưng fleet đã đủ ${policy.maxNodes} node tối đa — tăng maxNodes hoặc giảm tải.`,
        [...scaleOutReasons, 'max-nodes-reached'],
      );
    }
    // Thêm 1 node mỗi lần đề xuất (an toàn: host duyệt từng node, không
    // mua ồ ạt theo một lần đo).
    const delta = 1;
    return base(
      'scale-out',
      delta,
      `Đề xuất thêm ${delta} node: ${scaleOutReasons.join('; ')}.`,
      scaleOutReasons,
    );
  }

  // --- Scale-in --------------------------------------------------------
  const scaleInBlockers: string[] = [];
  if (queue.queued > 0 || queue.running > 0) scaleInBlockers.push(`hàng đợi còn ${queue.queued} job chờ + ${queue.running} job đang chạy`);
  if (breached.length > 0) scaleInBlockers.push(`${breached.length} job breach SLA`);
  if (urgentForecast) scaleInBlockers.push(`capacity urgent: ${urgentForecast.resource.toUpperCase()} hết trong ${urgentForecast.monthsUntilExhaustion} tháng`);
  if (nodeCount <= policy.minNodes) scaleInBlockers.push(`fleet chỉ còn ${nodeCount} node (tối thiểu ${policy.minNodes})`);
  if (coldestCpuUsed >= policy.idleCpuFraction) {
    scaleInBlockers.push(`node lạnh nhất vẫn dùng ${Math.round(coldestCpuUsed * 100)}% CPU (ngưỡng idle ${Math.round(policy.idleCpuFraction * 100)}%)`);
  }
  if (scaleInBlockers.length === 0) {
    return base(
      'scale-in',
      -1,
      `Đề xuất bớt 1 node: hàng đợi rỗng, không breach SLA, node lạnh nhất chỉ dùng ${Math.round(coldestCpuUsed * 100)}% CPU, không có forecast urgent.`,
      ['queue-empty', 'no-sla-breach', 'idle-node', 'no-urgent-forecast'],
    );
  }

  return base(
    'none',
    0,
    `Không cần scale: không đủ điều kiện scale-out, và scale-in bị chặn (${scaleInBlockers.join('; ')}).`,
    ['no-scale-out-trigger', ...scaleInBlockers.map((b) => `scale-in-blocked: ${b}`)],
  );
}

/**
 * Ước tính số node cần thêm để "hạ nhiệt" hàng đợi: với mỗi job queued
 * chưa đặt được, tính tổng demand; chia cho tài nguyên trống trung
 * bình mỗi node hiện tại → số node cần (làm tròn lên, tối thiểu 1 khi
 * có job tắc). Chỉ là ước tính để UI hiển thị — quyết định scale vẫn
 * qua `recommendFleetV23Autoscale` (thêm 1 node mỗi lần).
 */
export function estimateFleetV23NodesNeeded(
  queuedDemand: { cpuCores: number; ramBytes: number; diskBytes: number },
  nodes: readonly FleetV23NodeSnapshot[],
): { cpu: number; ram: number; disk: number; nodesNeeded: number } {
  if (nodes.length === 0) return { cpu: 0, ram: 0, disk: 0, nodesNeeded: 0 };
  const avgFree = {
    cpu: nodes.reduce((s, n) => s + Math.max(0, n.cpuFree), 0) / nodes.length,
    ram: nodes.reduce((s, n) => s + Math.max(0, n.ramFree), 0) / nodes.length,
    disk: nodes.reduce((s, n) => s + Math.max(0, n.diskFree), 0) / nodes.length,
  };
  const need = {
    cpu: avgFree.cpu > 0 ? Math.ceil(queuedDemand.cpuCores / avgFree.cpu) : 0,
    ram: avgFree.ram > 0 ? Math.ceil(queuedDemand.ramBytes / avgFree.ram) : 0,
    disk: avgFree.disk > 0 ? Math.ceil(queuedDemand.diskBytes / avgFree.disk) : 0,
  };
  const totalDemand = queuedDemand.cpuCores + queuedDemand.ramBytes + queuedDemand.diskBytes;
  return {
    ...need,
    nodesNeeded: totalDemand <= 0 ? 0 : Math.max(1, need.cpu, need.ram, need.disk),
  };
}
