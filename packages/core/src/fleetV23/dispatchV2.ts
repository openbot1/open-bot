/**
 * Dispatch v2 cho fleet v23 (v1.36, Đội T6) — nối hàng đợi scheduler
 * với placement scorer: gán job đang chờ lên node.
 *
 * Scheduler v2 (`schedulerV2.ts`) chỉ XẾP job theo ưu tiên — nó không
 * biết job chạy ở ĐÂU. Placement v2 (`placementV2.ts`) chỉ chấm ĐIỂM
 * cho MỘT bot — nó không biết job nào đang chờ. Module này là mắt
 * xích còn thiếu: một vòng dispatch lấy job queued theo thứ tự ưu
 * tiên, chấm từng job lên node còn trống, và trả về kế hoạch gán
 * (job → node) + job hoãn lại (hết chỗ) kèm lý do.
 *
 * Luật dispatch (một vòng, host chạy lại mỗi khi có chỗ trống / job mới):
 * 1. Job xét theo thứ tự hàng đợi (ưu tiên hiệu dụng → deadline SLA →
 *    FIFO) — job breach SLA tự động lên trước nhờ deadline sớm.
 * 2. Mỗi job được chấm bằng placement scorer v2 (ràng buộc cứng +
 *    topology + trọng số của host). Node tốt nhất thắng; demand của
 *    job được TRỪ khỏi snapshot node ngay trong vòng dispatch (mô
 *    phỏng) để job sau không gán trùng chỗ đã hứa.
 * 3. Job không đặt được (hết chỗ / vi phạm topology / không node nào
 *    đủ điều kiện) → hoãn lại, giữ nguyên trong hàng đợi, kèm lý do
 *    tóm tắt (để host biết là thiếu tài nguyên hay kẹt topology).
 * 4. Dry-run: tính kế hoạch mà không đổi gì (không start job, không
 *    đổi placement) — host/UI xem trước rồi mới duyệt.
 * 5. Áp dụng kế hoạch: job được gán → `running` (qua queue) +
 *    placement[botId] = nodeId. Job hoãn lại không đụng tới.
 *
 * Module thuần (trừ `applyFleetV23DispatchPlan` đổi trạng thái queue
 * + placement mà host truyền vào — host giữ state).
 */

import type { FleetV23NodeSnapshot, FleetV23ScoreWeights } from './placementV2';
import {
  evaluateFleetV23Placement,
  summarizePlacementRejectionV23,
} from './placementV2';
import type { FleetV23Job } from './schedulerV2';
import { FleetV23SchedulerQueue, sortFleetV23Queue } from './schedulerV2';
import type { FleetV23Topology } from './topology';

/** Một lần gán job → node trong kế hoạch dispatch. */
export interface FleetV23DispatchAssignment {
  /** Id job được gán. */
  jobId: string;
  /** Bot chạy job. */
  botId: string;
  /** Node job sẽ chạy lên. */
  nodeId: string;
  /** Điểm placement của node này cho job (0..100). */
  score: number;
  /** Chi phí ước tính $/giờ chạy job trên node. */
  estimatedCostPerHour: number;
  /** Node có nằm trên Pareto frontier cho job này không. */
  onParetoFrontier: boolean;
}

/** Một job bị hoãn lại trong vòng dispatch. */
export interface FleetV23DispatchDeferral {
  /** Id job bị hoãn. */
  jobId: string;
  /** Bot của job. */
  botId: string;
  /** Lý do hoãn (tóm tắt 1 dòng). */
  reason: string;
}

/** Kế hoạch dispatch của một vòng. */
export interface FleetV23DispatchPlan {
  /** Id kế hoạch (ổn định để audit trích dẫn). */
  id: string;
  /** Lúc lập kế hoạch (epoch ms). */
  createdAt: number;
  /** Job được gán (theo thứ tự ưu tiên). */
  assignments: FleetV23DispatchAssignment[];
  /** Job bị hoãn lại (vẫn queued). */
  deferred: FleetV23DispatchDeferral[];
  /** Tài nguyên trống còn lại mỗi node SAU khi trừ demand các job được gán. */
  nodeFreeAfter: { nodeId: string; cpuFree: number; ramFree: number; diskFree: number }[];
  /** true = dry-run (chỉ tính, chưa đổi gì). */
  dryRun: boolean;
  /** Số job queued đã xét trong vòng này. */
  jobsConsidered: number;
}

/** Validate kế hoạch dispatch từ dữ liệu ngoài (lỗi → danh sách). */
export function validateFleetV23DispatchPlan(input: unknown): string[] {
  const errors: string[] = [];
  if (typeof input !== 'object' || input === null) return ['dispatch plan phải là object.'];
  const p = input as Record<string, unknown>;
  if (typeof p.id !== 'string' || p.id.trim().length === 0) errors.push('plan.id phải là chuỗi không rỗng.');
  if (!Array.isArray(p.assignments)) errors.push('plan.assignments phải là mảng.');
  if (!Array.isArray(p.deferred)) errors.push('plan.deferred phải là mảng.');
  if (Array.isArray(p.assignments)) {
    for (const a of p.assignments as unknown[]) {
      if (typeof a !== 'object' || a === null) {
        errors.push('plan.assignments chứa phần tử không phải object.');
        continue;
      }
      const item = a as Record<string, unknown>;
      if (typeof item.jobId !== 'string' || item.jobId.trim().length === 0) errors.push('assignment.jobId phải là chuỗi không rỗng.');
      if (typeof item.nodeId !== 'string' || item.nodeId.trim().length === 0) errors.push('assignment.nodeId phải là chuỗi không rỗng.');
    }
  }
  return errors;
}

/**
 * Lập kế hoạch dispatch cho một vòng:
 * - Xét job queued theo thứ tự ưu tiên (tối đa `maxJobs` job — mặc
 *   định xét hết, host giới hạn khi hàng đợi dài).
 * - Mỗi job: chấm placement trên snapshot node ĐÃ TRỪ demand các job
 *   gán trước đó trong cùng vòng (không hứa trùng chỗ).
 * - Job gán được → assignment; job không gán được → deferral kèm lý
 *   do tóm tắt.
 */
export function planFleetV23Dispatch(input: {
  id: string;
  jobs: readonly FleetV23Job[];
  nodes: readonly FleetV23NodeSnapshot[];
  placement?: ReadonlyMap<string, string> | Record<string, string>;
  topology?: FleetV23Topology;
  weights?: FleetV23ScoreWeights;
  maxJobs?: number;
  dryRun?: boolean;
  now?: number;
}): FleetV23DispatchPlan {
  const now = input.now ?? Date.now();
  const ordered = sortFleetV23Queue(input.jobs, now);
  const considered = input.maxJobs === undefined ? ordered : ordered.slice(0, input.maxJobs);
  // Snapshot node mô phỏng (trừ dần demand khi gán job).
  const simNodes = input.nodes.map((n) => ({ ...n, labels: [...n.labels], runningBotIds: [...n.runningBotIds] }));
  const placementAfter: Record<string, string> =
    input.placement instanceof Map ? Object.fromEntries(input.placement) : { ...(input.placement ?? {}) };
  const assignments: FleetV23DispatchAssignment[] = [];
  const deferred: FleetV23DispatchDeferral[] = [];

  for (const job of considered) {
    const evaluation = evaluateFleetV23Placement(
      simNodes,
      { botId: job.botId, demand: job.demand },
      { weights: input.weights, topology: input.topology, placement: placementAfter },
    );
    const best = evaluation.ranked[0];
    if (!best) {
      deferred.push({
        jobId: job.id,
        botId: job.botId,
        reason: summarizePlacementRejectionV23(evaluation),
      });
      continue;
    }
    assignments.push({
      jobId: job.id,
      botId: job.botId,
      nodeId: best.nodeId,
      score: best.score,
      estimatedCostPerHour: best.estimatedCostPerHour,
      onParetoFrontier: best.onParetoFrontier,
    });
    // Trừ demand khỏi snapshot node thắng + ghi placement giả định.
    const node = simNodes.find((n) => n.id === best.nodeId);
    if (node) {
      node.cpuFree = Math.max(0, node.cpuFree - job.demand.cpuCores);
      node.ramFree = Math.max(0, node.ramFree - job.demand.ramBytes);
      node.diskFree = Math.max(0, node.diskFree - job.demand.diskBytes);
      node.runningBotIds = [...node.runningBotIds, job.botId];
    }
    placementAfter[job.botId] = best.nodeId;
  }

  return {
    id: input.id,
    createdAt: now,
    assignments,
    deferred,
    nodeFreeAfter: simNodes.map((n) => ({ nodeId: n.id, cpuFree: n.cpuFree, ramFree: n.ramFree, diskFree: n.diskFree })),
    dryRun: input.dryRun ?? true,
    jobsConsidered: considered.length,
  };
}

/** Kết quả áp dụng kế hoạch dispatch. */
export interface FleetV23DispatchApplication {
  planId: string;
  /** Job đã start (id). */
  startedJobIds: string[];
  /** Job trong plan nhưng start lỗi (id + lý do — vd job đã bị huỷ giữa chừng). */
  failedStarts: { jobId: string; reason: string }[];
  /** Placement sau khi áp dụng (botId → nodeId). */
  placementAfter: Record<string, string>;
  /** true = mọi assignment đều start được. */
  success: boolean;
}

/**
 * Áp dụng kế hoạch dispatch: job được gán → `running` (qua queue) +
 * placement[botId] = nodeId. Job start lỗi (vd đã finish/huỷ sau khi
 * lập plan) thì BỎ QUA job đó và tiếp tục job khác — không rollback
 * các job đã start (chúng đã chạy thật rồi, rollback sẽ giết job
 * đang chạy; host xử lý job lỗi riêng).
 */
export function applyFleetV23DispatchPlan(
  plan: FleetV23DispatchPlan,
  queue: FleetV23SchedulerQueue,
  placement: Record<string, string>,
  now: number = Date.now(),
): FleetV23DispatchApplication {
  const startedJobIds: string[] = [];
  const failedStarts: { jobId: string; reason: string }[] = [];
  const placementAfter: Record<string, string> = { ...placement };
  for (const assignment of plan.assignments) {
    try {
      queue.start(assignment.jobId, now);
      placementAfter[assignment.botId] = assignment.nodeId;
      startedJobIds.push(assignment.jobId);
    } catch (err) {
      failedStarts.push({ jobId: assignment.jobId, reason: (err as Error).message });
    }
  }
  return {
    planId: plan.id,
    startedJobIds,
    failedStarts,
    placementAfter,
    success: failedStarts.length === 0,
  };
}

/**
 * Tóm tắt kế hoạch dispatch: bao nhiêu job gán được / hoãn, tổng chi
 * phí $/giờ, job hoãn vì lý do gì nhiều nhất.
 */
export function summarizeFleetV23DispatchPlan(plan: FleetV23DispatchPlan): {
  assigned: number;
  deferred: number;
  totalCostPerHour: number;
  topDeferralReason: string | null;
} {
  const totalCostPerHour =
    Math.round(plan.assignments.reduce((s, a) => s + a.estimatedCostPerHour, 0) * 10000) / 10000;
  const reasonCounts = new Map<string, number>();
  for (const d of plan.deferred) reasonCounts.set(d.reason, (reasonCounts.get(d.reason) ?? 0) + 1);
  const top = [...reasonCounts.entries()].sort((a, b) => b[1] - a[1])[0];
  return {
    assigned: plan.assignments.length,
    deferred: plan.deferred.length,
    totalCostPerHour,
    topDeferralReason: top ? `${top[0]} (${top[1]} job)` : null,
  };
}
