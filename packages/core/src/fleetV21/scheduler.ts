/**
 * Scheduler tier-aware cho fleet v21 (v1.34, Đội T6).
 *
 * Đặt MỘT bot run lên node tốt nhất, có xét tier cách ly yêu cầu.
 * Module thuần: nhận danh sách node + yêu cầu run, trả về quyết định
 * (node được chọn + điểm từng node, hoặc từ chối kèm lý do từng node).
 *
 * Luật cứng (node nào vi phạm là loại ngay, không chấm điểm):
 * 1. Node phải `online` (draining/offline/dead không nhận run mới).
 * 2. Node phải hỗ trợ tier tối thiểu của run (không hạ tier lén).
 * 3. Node phải đủ CPU/RAM/disk trống cho run.
 *
 * Chấm điểm 0..100 (node đủ điều kiện mới được chấm):
 * - RAM trống 25 + CPU trống 20 + disk trống 10: node càng trống càng
 *   tốt, nhưng điểm dùng tỉ lệ trống (không phải số tuyệt đối) để node
 *   nhỏ không bao giờ thắng node lớn chỉ vì "trống nhiều GB hơn".
 * - Độ tin cậy 25: node hay lỗi bị trừ nặng — run quan trọng không nên
 *   lên node chập chờn.
 * - Độ trễ 10: latency thấp tốt hơn; chưa đo được tính trung bình (5).
 * - Tier-fit 10: node có maxTier vừa đủ (bằng minTier) được trọn 10;
 *   node mạnh hơn bị trừ dần — giữ node microVM cho run thật sự cần.
 * - Chạy ít run hơn được cộng nhẹ qua tie-break: điểm bằng nhau thì
 *   node ít run hơn thắng, rồi node id nhỏ hơn (quyết định ổn định).
 *
 * Từ chối: khi không node nào qua luật cứng, trả về `rejected` + lý do
 * từng node + tóm tắt nguyên nhân chung lớn nhất (vd "không node nào
 * đạt tier microvm" vs "đủ tier nhưng thiếu RAM") để UI nói rõ cho user
 * thay vì "không đặt được".
 */

import type { SandboxTierV21 } from './tiers';
import { SANDBOX_TIER_RANK_V21 } from './tiers';
import type { FleetV21Node, FleetV21RunDemand } from './nodes';
import { nodeFreeCpuV21, nodeFreeDiskV21, nodeFreeRamV21, nodeRejectReasonsV21 } from './nodes';

/** Yêu cầu đặt một bot run. */
export interface FleetV21ScheduleRequest {
  /** Id run (để trace/audit). */
  runId: string;
  /** Id bot chạy run này (dùng cho affinity/anti-affinity ở placement). */
  botId: string;
  /** Tier cách ly tối thiểu run yêu cầu — bắt buộc, không có mặc định lén. */
  minTier: SandboxTierV21;
  /** Tier muốn dùng nếu có (phải >= minTier; chỉ ảnh hưởng tier-fit). */
  preferredTier?: SandboxTierV21;
  /** Tài nguyên run cần. */
  demand: FleetV21RunDemand;
  /** Nhãn node yêu cầu (node phải có đủ nhãn này) — vd `['gpu']`. */
  requiredLabels?: string[];
  /** Id node muốn ưu tiên (nếu node đó đủ điều kiện thì được cộng điểm). */
  preferredNodeId?: string;
  /** Thời gian sống tối đa của run (ms) — dashboard cảnh báo khi vượt. */
  maxLifetimeMs?: number;
}

/** Điểm của một node cho một yêu cầu (chỉ node đủ điều kiện mới có). */
export interface FleetV21NodeScore {
  nodeId: string;
  /** Tổng điểm 0..100. */
  score: number;
  /** Điểm thành phần (để UI giải thích "vì sao node này thắng"). */
  breakdown: {
    freeRam: number;
    freeCpu: number;
    freeDisk: number;
    reliability: number;
    latency: number;
    tierFit: number;
    preferredNodeBonus: number;
  };
  /** Node còn trống bao nhiêu sau khi trừ demand của run (để kiểm tra lại). */
  freeAfter: { cpuCores: number; ramBytes: number; diskBytes: number };
}

/** Kết quả chấm: node đủ điều kiện (đã sắp theo điểm giảm dần) + node bị loại + lý do. */
export interface FleetV21ScheduleEvaluation {
  request: FleetV21ScheduleRequest;
  /** Node đủ điều kiện, sắp theo điểm giảm dần (điểm bằng → ít run hơn → id nhỏ hơn). */
  ranked: FleetV21NodeScore[];
  /** Node bị loại + lý do từng node (để giải thích khi từ chối). */
  rejected: { nodeId: string; reasons: string[] }[];
  /** Node nào bị loại vì tier (để tóm tắt "thiếu tier" riêng). */
  tierRejectedNodeIds: string[];
  /** Node nào bị loại vì thiếu tài nguyên. */
  capacityRejectedNodeIds: string[];
  /** Node nào bị loại vì không online. */
  statusRejectedNodeIds: string[];
}

/** Quyết định đặt run: chọn node tốt nhất, hoặc từ chối có giải thích. */
export type FleetV21ScheduleDecision =
  | { placed: true; runId: string; nodeId: string; score: FleetV21NodeScore; evaluation: FleetV21ScheduleEvaluation }
  | {
      placed: false;
      runId: string;
      reason: string;
      evaluation: FleetV21ScheduleEvaluation;
    };

/** Trọng số chấm điểm (tổng 100 + bonus node ưu tiên tối đa 5). */
export const FLEET_V21_SCORE_WEIGHTS = {
  freeRam: 25,
  freeCpu: 20,
  freeDisk: 10,
  reliability: 25,
  latency: 10,
  tierFit: 10,
  preferredNodeBonus: 5,
} as const;

/** Chấm điểm một node đã qua luật cứng (không gọi trực tiếp khi node chưa đủ điều kiện). */
export function scoreFleetV21Node(
  node: FleetV21Node,
  request: FleetV21ScheduleRequest,
): FleetV21NodeScore {
  const w = FLEET_V21_SCORE_WEIGHTS;
  const freeRamFrac = node.ramBytes > 0 ? nodeFreeRamV21(node) / node.ramBytes : 0;
  const freeCpuFrac = node.cpuCores > 0 ? nodeFreeCpuV21(node) / node.cpuCores : 0;
  const freeDiskFrac = node.diskBytes > 0 ? nodeFreeDiskV21(node) / node.diskBytes : 0;

  const freeRam = w.freeRam * freeRamFrac;
  const freeCpu = w.freeCpu * freeCpuFrac;
  const freeDisk = w.freeDisk * freeDiskFrac;
  const reliability = w.reliability * Math.min(1, Math.max(0, node.reliability));

  // Latency: 0ms → trọn điểm, >= 500ms → 0; chưa đo → một nửa.
  const latency =
    node.latencyMs === null
      ? w.latency * 0.5
      : w.latency * Math.max(0, 1 - node.latencyMs / 500);

  // Tier-fit: vừa đủ tier → trọn điểm; mạnh hơn 1 bậc → mất nửa;
  // mạnh hơn 2 bậc (bwrap run lên microVM) → gần như mất hết.
  const targetTier = request.preferredTier ?? request.minTier;
  const tierGap = SANDBOX_TIER_RANK_V21[node.maxTier] - SANDBOX_TIER_RANK_V21[targetTier];
  const tierFit = tierGap <= 0 ? w.tierFit : w.tierFit * Math.max(0, 1 - tierGap * 0.5);

  const preferredNodeBonus = request.preferredNodeId === node.id ? w.preferredNodeBonus : 0;

  const score = freeRam + freeCpu + freeDisk + reliability + latency + tierFit + preferredNodeBonus;
  return {
    nodeId: node.id,
    score: Math.round(score * 100) / 100,
    breakdown: {
      freeRam: Math.round(freeRam * 100) / 100,
      freeCpu: Math.round(freeCpu * 100) / 100,
      freeDisk: Math.round(freeDisk * 100) / 100,
      reliability: Math.round(reliability * 100) / 100,
      latency: Math.round(latency * 100) / 100,
      tierFit: Math.round(tierFit * 100) / 100,
      preferredNodeBonus,
    },
    freeAfter: {
      cpuCores: nodeFreeCpuV21(node) - request.demand.cpuCores,
      ramBytes: nodeFreeRamV21(node) - request.demand.ramBytes,
      diskBytes: nodeFreeDiskV21(node) - request.demand.diskBytes,
    },
  };
}

/** Đánh giá mọi node cho một yêu cầu (luật cứng + chấm điểm + phân loại lý do loại). */
export function evaluateFleetV21Schedule(
  nodes: readonly FleetV21Node[],
  request: FleetV21ScheduleRequest,
): FleetV21ScheduleEvaluation {
  const ranked: FleetV21NodeScore[] = [];
  const rejected: { nodeId: string; reasons: string[] }[] = [];
  const tierRejectedNodeIds: string[] = [];
  const capacityRejectedNodeIds: string[] = [];
  const statusRejectedNodeIds: string[] = [];

  for (const node of nodes) {
    const reasons = nodeRejectReasonsV21(node, request.demand, request.minTier);
    // Nhãn yêu cầu: node thiếu nhãn thì cũng bị loại (lý do riêng).
    const missingLabels = (request.requiredLabels ?? []).filter((l) => !node.labels.includes(l));
    if (missingLabels.length > 0) {
      reasons.push(`node thiếu nhãn yêu cầu: ${missingLabels.join(', ')}`);
    }
    if (reasons.length > 0) {
      rejected.push({ nodeId: node.id, reasons });
      if (node.status !== 'online') statusRejectedNodeIds.push(node.id);
      if (node.maxTier !== undefined && SANDBOX_TIER_RANK_V21[node.maxTier] < SANDBOX_TIER_RANK_V21[request.minTier]) {
        tierRejectedNodeIds.push(node.id);
      }
      if (
        nodeFreeCpuV21(node) < request.demand.cpuCores ||
        nodeFreeRamV21(node) < request.demand.ramBytes ||
        nodeFreeDiskV21(node) < request.demand.diskBytes
      ) {
        capacityRejectedNodeIds.push(node.id);
      }
      continue;
    }
    ranked.push(scoreFleetV21Node(node, request));
  }

  // Sắp điểm giảm dần; bằng điểm → node ít run hơn thắng → id nhỏ hơn (ổn định).
  const runCountById = new Map(nodes.map((n) => [n.id, n.runCount]));
  ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const ra = runCountById.get(a.nodeId) ?? 0;
    const rb = runCountById.get(b.nodeId) ?? 0;
    if (ra !== rb) return ra - rb;
    return a.nodeId.localeCompare(b.nodeId);
  });

  return { request, ranked, rejected, tierRejectedNodeIds, capacityRejectedNodeIds, statusRejectedNodeIds };
}

/** Tóm tắt nguyên nhân từ chối chung nhất (để UI hiện 1 dòng thay vì liệt kê mọi node). */
export function summarizeScheduleRejectionV21(evaluation: FleetV21ScheduleEvaluation): string {
  const total = evaluation.ranked.length + evaluation.rejected.length;
  if (total === 0) return 'Fleet không có node nào — thêm node trước khi đặt run.';
  if (evaluation.statusRejectedNodeIds.length === total) {
    return 'Không node nào đang online — mọi node đều draining, offline hoặc dead.';
  }
  const onlineCount = total - evaluation.statusRejectedNodeIds.length;
  if (evaluation.tierRejectedNodeIds.length >= onlineCount && onlineCount > 0) {
    return (
      `Không node online nào đạt tier tối thiểu ${evaluation.request.minTier} — ` +
      `tier cao nhất của fleet là ${evaluation.request.minTier === 'microvm' ? 'thấp hơn microvm' : 'chưa đủ'}. Thêm node hỗ trợ tier ${evaluation.request.minTier} hoặc hạ tier yêu cầu của run.`
    );
  }
  if (evaluation.capacityRejectedNodeIds.length > 0 && evaluation.tierRejectedNodeIds.length === 0) {
    return 'Node đủ tier nhưng không node nào còn đủ CPU/RAM/disk trống cho run này — chờ run khác xong hoặc thêm node.';
  }
  if (evaluation.rejected.length > 0 && evaluation.rejected.every((r) => r.reasons.some((x) => x.includes('nhãn')))) {
    return `Không node nào có đủ nhãn yêu cầu (${(evaluation.request.requiredLabels ?? []).join(', ')}) — kiểm tra nhãn node hoặc bỏ yêu cầu nhãn.`;
  }
  return 'Không node nào đủ điều kiện đặt run này — xem lý do từng node để biết cần thêm node, tăng tài nguyên hay hạ tier.';
}

/** Đặt một run: trả về node tốt nhất, hoặc từ chối kèm lý do đầy đủ. */
export function scheduleFleetV21Run(
  nodes: readonly FleetV21Node[],
  request: FleetV21ScheduleRequest,
): FleetV21ScheduleDecision {
  const evaluation = evaluateFleetV21Schedule(nodes, request);
  const best = evaluation.ranked[0];
  if (!best) {
    return { placed: false, runId: request.runId, reason: summarizeScheduleRejectionV21(evaluation), evaluation };
  }
  return { placed: true, runId: request.runId, nodeId: best.nodeId, score: best, evaluation };
}

/** Validate yêu cầu đặt run: lỗi → danh sách (rỗng = hợp lệ). */
export function validateScheduleRequestV21(input: unknown): string[] {
  const errors: string[] = [];
  if (typeof input !== 'object' || input === null) return ['yêu cầu đặt run phải là object.'];
  const r = input as Record<string, unknown>;
  if (typeof r.runId !== 'string' || r.runId.trim().length === 0) errors.push('runId phải là chuỗi không rỗng.');
  if (typeof r.botId !== 'string' || r.botId.trim().length === 0) errors.push('botId phải là chuỗi không rỗng.');
  if (!['bwrap', 'syscall-policy', 'microvm'].includes(r.minTier as string)) {
    errors.push('minTier phải là bwrap, syscall-policy hoặc microvm.');
  }
  const demand = r.demand as Record<string, unknown> | undefined;
  if (typeof demand !== 'object' || demand === null) {
    errors.push('demand phải là object {cpuCores, ramBytes, diskBytes}.');
  } else {
    for (const field of ['cpuCores', 'ramBytes', 'diskBytes'] as const) {
      if (typeof demand[field] !== 'number' || !Number.isFinite(demand[field]) || (demand[field] as number) < 0) {
        errors.push(`demand.${field} phải là số >= 0.`);
      }
    }
  }
  if (r.maxLifetimeMs !== undefined && (typeof r.maxLifetimeMs !== 'number' || r.maxLifetimeMs <= 0)) {
    errors.push('maxLifetimeMs (nếu có) phải là số > 0.');
  }
  return errors;
}
