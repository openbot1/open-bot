/**
 * Placement scorer v2 cho fleet v23 (v1.36, Đội T6) — chấm điểm node
 * đa tiêu chí + capacity planning.
 *
 * Fleet v21 chấm node theo 6 tiêu chí (RAM/CPU/disk trống, độ tin
 * cậy, độ trễ, tier-fit) cho MỘT run, không biết chi phí, không biết
 * fleet còn đủ chỗ bao lâu. Module này đi xa hơn, trên cùng một quyết
 * định đặt bot:
 *
 * - 6 tiêu chí chấm điểm: CPU trống, RAM trống, disk trống, độ tin
 *   cậy, độ trễ, CHI PHÍ ($/giờ — node cloud đắt bị trừ điểm khi job
 *   không cần gấp). Trọng số cấu hình được (tổng phải = 100, host
 *   tự cân: vd fleet tiết kiệm thì tăng trọng số cost).
 * - Ràng buộc cứng (loại ngay, không chấm): node offline/draining,
 *   không đủ tài nguyên trống, thiếu label yêu cầu, vi phạm topology
 *   (zone cấm / anti-affinity với bot đang chạy trên node / spread
 *   group — kiểm qua `checkFleetV23GroupPlacement`).
 * - Pareto frontier: trong các node đủ điều kiện, node nào không bị
 *   node khác "vượt mặt toàn diện" (tốt hơn hoặc bằng ở mọi tiêu chí
 *   và tốt hơn hẳn ở ít nhất một) thì nằm trên frontier — UI cho user
 *   chọn trong frontier thay vì chỉ nhận node top-1.
 * - Capacity planning: với tốc độ tăng trưởng (bot mới / tháng, tài
 *   nguyên mỗi bot), dự báo ngày nào fleet hết CPU/RAM/disk (từng
 *   loại riêng — loại nào hết trước thì đó là nút thắt), để host mua
 *   thêm node TRƯỚC khi hết chỗ.
 * - Chi phí: ước tính $/giờ chạy bot trên node (costPerHour của node
 *   × tỉ lệ tài nguyên bot dùng) — để so sánh placement rẻ/đắt.
 *
 * Module thuần, làm việc trên snapshot node (`FleetV23NodeSnapshot`)
 * — host tự chuyển node v21/computer v22 thành snapshot, v23 không
 * phụ thuộc struct node của phiên bản cũ.
 */

import type { FleetV23Topology } from './topology';
import { checkFleetV23GroupPlacement, topologyGroupOfBot } from './topology';

/** Ảnh chụp một node để chấm điểm placement (host tự build từ node thật). */
export interface FleetV23NodeSnapshot {
  /** Id node. */
  id: string;
  /** Zone node thuộc (null khi chưa gắn zone). */
  zoneId: string | null;
  /** Node có nhận bot mới không (offline/draining → false). */
  online: boolean;
  /** Tổng CPU (core). */
  cpuCores: number;
  /** CPU trống (core). */
  cpuFree: number;
  /** Tổng RAM (byte). */
  ramBytes: number;
  /** RAM trống (byte). */
  ramFree: number;
  /** Tổng disk (byte). */
  diskBytes: number;
  /** Disk trống (byte). */
  diskFree: number;
  /** Độ tin cậy 0..100 (100 = chưa từng lỗi; host tính từ lịch sử). */
  reliability: number;
  /** Độ trễ tới node (ms) — null khi chưa đo (tính trung bình). */
  latencyMs: number | null;
  /** Chi phí $/giờ khi chạy hết node (0 = node local miễn phí). */
  costPerHour: number;
  /** Nhãn node (vd `gpu`, `ssd`, `eu`). */
  labels: string[];
  /** Bot đang chạy trên node. */
  runningBotIds: string[];
}

/** Tài nguyên một bot cần để chạy. */
export interface FleetV23Demand {
  cpuCores: number;
  ramBytes: number;
  diskBytes: number;
}

/** Yêu cầu đặt một bot. */
export interface FleetV23PlaceRequest {
  /** Id bot cần đặt. */
  botId: string;
  demand: FleetV23Demand;
  /** Nhãn node bắt buộc (node phải có đủ). */
  requiredLabels?: string[];
  /** Zone cấm (bot không được đặt vào các zone này, vd zone đang bảo trì). */
  forbiddenZones?: string[];
  /** Zone bắt buộc (bot chỉ được đặt trong các zone này; rỗng = không giới hạn). */
  allowedZones?: string[];
}

/** Trọng số chấm điểm — tổng phải = 100 (validate ở hàm chấm). */
export interface FleetV23ScoreWeights {
  freeCpu: number;
  freeRam: number;
  freeDisk: number;
  reliability: number;
  latency: number;
  cost: number;
}

/** Trọng số mặc định: tài nguyên 55, tin cậy 20, trễ 10, chi phí 15. */
export const DEFAULT_FLEET_V23_SCORE_WEIGHTS: FleetV23ScoreWeights = {
  freeCpu: 20,
  freeRam: 20,
  freeDisk: 15,
  reliability: 20,
  latency: 10,
  cost: 15,
};

/** Validate trọng số: mọi số 0..100, tổng = 100. */
export function validateFleetV23ScoreWeights(weights: FleetV23ScoreWeights): string[] {
  const errors: string[] = [];
  for (const [key, value] of Object.entries(weights)) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
      errors.push(`trọng số ${key} phải là số 0..100.`);
    }
  }
  const total = Object.values(weights).reduce((s, v) => s + v, 0);
  if (Math.abs(total - 100) > 0.001) errors.push(`tổng trọng số phải = 100, hiện tại ${total}.`);
  return errors;
}

/** Validate node snapshot từ dữ liệu ngoài (lỗi → danh sách). */
export function validateFleetV23NodeSnapshot(input: unknown): string[] {
  const errors: string[] = [];
  if (typeof input !== 'object' || input === null) return ['node snapshot phải là object.'];
  const n = input as Record<string, unknown>;
  if (typeof n.id !== 'string' || n.id.trim().length === 0) errors.push('node.id phải là chuỗi không rỗng.');
  for (const field of ['cpuCores', 'cpuFree', 'ramBytes', 'ramFree', 'diskBytes', 'diskFree'] as const) {
    if (typeof n[field] !== 'number' || !Number.isFinite(n[field]) || (n[field] as number) < 0) {
      errors.push(`node.${field} phải là số >= 0.`);
    }
  }
  if (typeof n.cpuFree === 'number' && typeof n.cpuCores === 'number' && (n.cpuFree as number) > (n.cpuCores as number)) {
    errors.push('node.cpuFree không được lớn hơn cpuCores.');
  }
  if (typeof n.ramFree === 'number' && typeof n.ramBytes === 'number' && (n.ramFree as number) > (n.ramBytes as number)) {
    errors.push('node.ramFree không được lớn hơn ramBytes.');
  }
  if (typeof n.diskFree === 'number' && typeof n.diskBytes === 'number' && (n.diskFree as number) > (n.diskBytes as number)) {
    errors.push('node.diskFree không được lớn hơn diskBytes.');
  }
  if (typeof n.reliability !== 'number' || (n.reliability as number) < 0 || (n.reliability as number) > 100) {
    errors.push('node.reliability phải là số 0..100.');
  }
  if (typeof n.costPerHour !== 'number' || (n.costPerHour as number) < 0) {
    errors.push('node.costPerHour phải là số >= 0.');
  }
  if (!Array.isArray(n.labels)) errors.push('node.labels phải là mảng.');
  if (!Array.isArray(n.runningBotIds)) errors.push('node.runningBotIds phải là mảng.');
  return errors;
}

/** Điểm một node cho một yêu cầu (chỉ node đủ điều kiện mới có). */
export interface FleetV23NodeScore {
  nodeId: string;
  /** Tổng điểm 0..100. */
  score: number;
  /** Điểm thành phần (mỗi mục đã nhân trọng số; tổng = score). */
  breakdown: {
    freeCpu: number;
    freeRam: number;
    freeDisk: number;
    reliability: number;
    latency: number;
    cost: number;
  };
  /** Tài nguyên trống còn lại sau khi trừ demand (để kiểm tra lại). */
  freeAfter: FleetV23Demand;
  /** Chi phí ước tính $/giờ chạy bot này trên node. */
  estimatedCostPerHour: number;
  /** Node có nằm trên Pareto frontier không. */
  onParetoFrontier: boolean;
}

/** Kết quả chấm: node đủ điều kiện (điểm giảm dần) + node bị loại + lý do. */
export interface FleetV23PlacementEvaluation {
  request: FleetV23PlaceRequest;
  /** Node đủ điều kiện, sắp theo điểm giảm dần (hoà → id nhỏ hơn). */
  ranked: FleetV23NodeScore[];
  /** Node bị loại + lý do từng node. */
  rejected: { nodeId: string; reasons: string[] }[];
  /** Node nào bị loại vì offline. */
  statusRejectedNodeIds: string[];
  /** Node nào bị loại vì thiếu tài nguyên. */
  capacityRejectedNodeIds: string[];
  /** Node nào bị loại vì topology (zone/label/affinity). */
  topologyRejectedNodeIds: string[];
}

/** Quyết định đặt bot: chọn node tốt nhất, hoặc từ chối có giải thích. */
export type FleetV23PlacementDecision =
  | { placed: true; botId: string; nodeId: string; score: FleetV23NodeScore; evaluation: FleetV23PlacementEvaluation }
  | { placed: false; botId: string; reason: string; evaluation: FleetV23PlacementEvaluation };

/**
 * Lý do loại node: kiểm tra ràng buộc cứng (trả về [] = qua được).
 * Thứ tự kiểm tra: trạng thái → tài nguyên → label → zone → topology
 * (affinity/anti-affinity với bot đang chạy trên node).
 */
export function placementRejectReasonsV23(
  node: FleetV23NodeSnapshot,
  request: FleetV23PlaceRequest,
  topology?: FleetV23Topology,
  placement?: ReadonlyMap<string, string> | Record<string, string>,
): string[] {
  const reasons: string[] = [];
  if (!node.online) {
    reasons.push(`node "${node.id}" không online (không nhận bot mới).`);
    return reasons; // node chết thì không cần kiểm tiếp
  }
  if (node.cpuFree < request.demand.cpuCores) {
    reasons.push(`node "${node.id}" chỉ còn ${node.cpuFree} CPU, cần ${request.demand.cpuCores}.`);
  }
  if (node.ramFree < request.demand.ramBytes) {
    reasons.push(`node "${node.id}" chỉ còn ${node.ramFree} byte RAM, cần ${request.demand.ramBytes}.`);
  }
  if (node.diskFree < request.demand.diskBytes) {
    reasons.push(`node "${node.id}" chỉ còn ${node.diskFree} byte disk, cần ${request.demand.diskBytes}.`);
  }
  for (const label of request.requiredLabels ?? []) {
    if (!node.labels.includes(label)) reasons.push(`node "${node.id}" thiếu nhãn "${label}".`);
  }
  if (node.zoneId !== null) {
    if ((request.forbiddenZones ?? []).includes(node.zoneId)) {
      reasons.push(`node "${node.id}" thuộc zone cấm "${node.zoneId}".`);
    }
    if ((request.allowedZones ?? []).length > 0 && !(request.allowedZones as string[]).includes(node.zoneId)) {
      reasons.push(`node "${node.id}" thuộc zone "${node.zoneId}", ngoài danh sách zone cho phép.`);
    }
  }
  if (topology && placement !== undefined) {
    const group = topologyGroupOfBot(topology, request.botId);
    if (group) {
      // Giả sử bot đặt lên node này, kiểm tra group còn vi phạm không.
      const trial: Record<string, string> = placement instanceof Map ? Object.fromEntries(placement) : { ...placement };
      trial[request.botId] = node.id;
      const violations = checkFleetV23GroupPlacement(topology, group, trial);
      // Spread chỉ ép khi cả group đã đặt: placement từng phần (đặt bot
      // đầu tiên) không thể đủ spread — ép lúc này thì node nào cũng
      // bị loại. Tương tự, vi phạm unplaced-bot của bot KHÁC không phải
      // lỗi của node này (bot đó chưa đặt ở đâu cả).
      const allPlaced = group.botIds.every((b) => trial[b] !== undefined);
      for (const v of violations) {
        if (v.kind === 'unplaced-bot' && !v.botIds.includes(request.botId)) continue;
        if (v.kind === 'spread-short' && !allPlaced) continue;
        reasons.push(`topology: ${v.reason}`);
      }
    }
  }
  return reasons;
}

/** Chi phí ước tính $/giờ: costPerHour của node × tỉ lệ tài nguyên bot dùng (lớn nhất trong 3 loại). */
export function estimateFleetV23CostPerHour(node: FleetV23NodeSnapshot, demand: FleetV23Demand): number {
  if (node.costPerHour <= 0) return 0;
  const cpuFrac = node.cpuCores > 0 ? demand.cpuCores / node.cpuCores : 0;
  const ramFrac = node.ramBytes > 0 ? demand.ramBytes / node.ramBytes : 0;
  const diskFrac = node.diskBytes > 0 ? demand.diskBytes / node.diskBytes : 0;
  const frac = Math.max(cpuFrac, ramFrac, diskFrac);
  return Math.round(node.costPerHour * frac * 10000) / 10000;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Chấm điểm một node đã qua ràng buộc cứng. Điểm thành phần (đã nhân
 * trọng số, tổng = score, 0..100):
 * - freeCpu/freeRam/freeDisk: tỉ lệ trống SAU KHI trừ demand (node
 *   còn trống nhiều sau khi nhận bot thì tốt — tránh dồn bot vào node
 *   sắp đầy).
 * - reliability: reliability/100 × trọng số.
 * - latency: chưa đo → 50% trọng số; đã đo → nội suy tuyến tính
 *   0ms = trọn điểm, >=500ms = 0 (ngưỡng host có thể đổi sau).
 * - cost: node miễn phí = trọn điểm; node đắt nhất trong các node
 *   ứng viên = 0 — cần `maxCost` (chi phí cao nhất trong đợt chấm)
 *   để chuẩn hoá tương đối, không dùng ngưỡng tuyệt đối.
 */
export function scoreFleetV23Node(
  node: FleetV23NodeSnapshot,
  request: FleetV23PlaceRequest,
  weights: FleetV23ScoreWeights = DEFAULT_FLEET_V23_SCORE_WEIGHTS,
  maxCostPerHour = 0,
): FleetV23NodeScore {
  const freeAfter: FleetV23Demand = {
    cpuCores: node.cpuFree - request.demand.cpuCores,
    ramBytes: node.ramFree - request.demand.ramBytes,
    diskBytes: node.diskFree - request.demand.diskBytes,
  };
  const freeCpuFrac = node.cpuCores > 0 ? Math.max(0, freeAfter.cpuCores / node.cpuCores) : 0;
  const freeRamFrac = node.ramBytes > 0 ? Math.max(0, freeAfter.ramBytes / node.ramBytes) : 0;
  const freeDiskFrac = node.diskBytes > 0 ? Math.max(0, freeAfter.diskBytes / node.diskBytes) : 0;
  const latencyScore =
    node.latencyMs === null ? 0.5 : Math.max(0, 1 - node.latencyMs / 500);
  const estimatedCostPerHour = estimateFleetV23CostPerHour(node, request.demand);
  const costScore = maxCostPerHour <= 0 ? 1 : Math.max(0, 1 - estimatedCostPerHour / maxCostPerHour);
  const breakdown = {
    freeCpu: round2(weights.freeCpu * freeCpuFrac),
    freeRam: round2(weights.freeRam * freeRamFrac),
    freeDisk: round2(weights.freeDisk * freeDiskFrac),
    reliability: round2((weights.reliability * node.reliability) / 100),
    latency: round2(weights.latency * latencyScore),
    cost: round2(weights.cost * costScore),
  };
  const score = round2(
    breakdown.freeCpu + breakdown.freeRam + breakdown.freeDisk + breakdown.reliability + breakdown.latency + breakdown.cost,
  );
  return { nodeId: node.id, score, breakdown, freeAfter, estimatedCostPerHour, onParetoFrontier: false };
}

/**
 * Pareto frontier: node A "vượt" node B khi A tốt hơn hoặc bằng B ở
 * mọi tiêu chí thô (freeCpu/ram/disk sau trừ, reliability, latency
 * thấp hơn, cost thấp hơn) và tốt hơn hẳn ở ít nhất một tiêu chí.
 * Node không bị node nào vượt thì nằm trên frontier.
 */
export function paretoFrontierV23(scores: readonly FleetV23NodeScore[], nodes: readonly FleetV23NodeSnapshot[]): string[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  // Tiêu chí thô để so Pareto: [freeCpu, freeRam, freeDisk, reliability, -latency, -cost]
  // (latency/cost càng thấp càng tốt nên lấy dấu âm).
  const raw = new Map<string, number[]>();
  for (const s of scores) {
    const n = byId.get(s.nodeId);
    if (!n) continue;
    raw.set(s.nodeId, [
      s.freeAfter.cpuCores,
      s.freeAfter.ramBytes,
      s.freeAfter.diskBytes,
      n.reliability,
      -(n.latencyMs ?? 250),
      -s.estimatedCostPerHour,
    ]);
  }
  const frontier: string[] = [];
  for (const s of scores) {
    const a = raw.get(s.nodeId);
    if (!a) continue;
    let dominated = false;
    for (const other of scores) {
      if (other.nodeId === s.nodeId) continue;
      const b = raw.get(other.nodeId);
      if (!b) continue;
      const atLeastAsGood = b.every((v, i) => v >= (a[i] as number));
      const strictlyBetter = b.some((v, i) => v > (a[i] as number));
      if (atLeastAsGood && strictlyBetter) {
        dominated = true;
        break;
      }
    }
    if (!dominated) frontier.push(s.nodeId);
  }
  return frontier.sort();
}

/** Chấm toàn bộ node cho một yêu cầu: loại cứng → chấm → xếp hạng → gắn Pareto. */
export function evaluateFleetV23Placement(
  nodes: readonly FleetV23NodeSnapshot[],
  request: FleetV23PlaceRequest,
  options: {
    weights?: FleetV23ScoreWeights;
    topology?: FleetV23Topology;
    placement?: ReadonlyMap<string, string> | Record<string, string>;
  } = {},
): FleetV23PlacementEvaluation {
  const weights = options.weights ?? DEFAULT_FLEET_V23_SCORE_WEIGHTS;
  const weightErrors = validateFleetV23ScoreWeights(weights);
  if (weightErrors.length > 0) throw new Error(`Trọng số chấm điểm không hợp lệ: ${weightErrors.join(' ')}`);
  const rejected: { nodeId: string; reasons: string[] }[] = [];
  const eligible: FleetV23NodeSnapshot[] = [];
  for (const node of nodes) {
    const reasons = placementRejectReasonsV23(node, request, options.topology, options.placement);
    if (reasons.length > 0) rejected.push({ nodeId: node.id, reasons });
    else eligible.push(node);
  }
  const maxCost = eligible.reduce(
    (m, n) => Math.max(m, estimateFleetV23CostPerHour(n, request.demand)),
    0,
  );
  const scored = eligible.map((n) => scoreFleetV23Node(n, request, weights, maxCost));
  const frontier = new Set(paretoFrontierV23(scored, eligible));
  for (const s of scored) s.onParetoFrontier = frontier.has(s.nodeId);
  scored.sort((a, b) => b.score - a.score || a.nodeId.localeCompare(b.nodeId));
  return {
    request,
    ranked: scored,
    rejected,
    statusRejectedNodeIds: rejected.filter((r) => r.reasons.some((x) => x.includes('không online'))).map((r) => r.nodeId),
    capacityRejectedNodeIds: rejected
      .filter((r) => r.reasons.some((x) => x.includes('chỉ còn')))
      .map((r) => r.nodeId),
    topologyRejectedNodeIds: rejected
      .filter((r) => r.reasons.some((x) => x.includes('topology') || x.includes('zone') || x.includes('nhãn')))
      .map((r) => r.nodeId),
  };
}

/** Đặt bot: chọn node điểm cao nhất, hoặc từ chối kèm lý do chung lớn nhất. */
export function placeFleetV23Bot(
  nodes: readonly FleetV23NodeSnapshot[],
  request: FleetV23PlaceRequest,
  options: {
    weights?: FleetV23ScoreWeights;
    topology?: FleetV23Topology;
    placement?: ReadonlyMap<string, string> | Record<string, string>;
  } = {},
): FleetV23PlacementDecision {
  const evaluation = evaluateFleetV23Placement(nodes, request, options);
  const best = evaluation.ranked[0];
  if (!best) {
    const reason =
      evaluation.rejected.length === 0
        ? `Không có node nào trong fleet để đặt bot "${request.botId}".`
        : `Không đặt được bot "${request.botId}": ${evaluation.rejected
            .map((r) => `${r.nodeId} (${r.reasons.join('; ')})`)
            .join(' | ')}.`;
    return { placed: false, botId: request.botId, reason, evaluation };
  }
  return { placed: true, botId: request.botId, nodeId: best.nodeId, score: best, evaluation };
}

/** Tóm tắt lý do từ chối chung lớn nhất (để UI nói 1 câu). */
export function summarizePlacementRejectionV23(evaluation: FleetV23PlacementEvaluation): string {
  if (evaluation.ranked.length > 0) return 'Có node đủ điều kiện.';
  if (evaluation.rejected.length === 0) return 'Fleet không có node nào.';
  const counts = new Map<string, number>();
  for (const r of evaluation.rejected) {
    const key = r.reasons.some((x) => x.includes('không online'))
      ? 'node offline'
      : r.reasons.some((x) => x.includes('chỉ còn'))
        ? 'thiếu tài nguyên'
        : r.reasons.some((x) => x.includes('topology') || x.includes('zone') || x.includes('nhãn'))
          ? 'topology/label/zone'
          : 'lý do khác';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] as [string, number];
  return `Không node nào đặt được — nguyên nhân lớn nhất: ${top[0]} (${top[1]}/${evaluation.rejected.length} node).`;
}

// ---------------------------------------------------------------------------
// Capacity planning: fleet còn đủ chỗ bao lâu?
// ---------------------------------------------------------------------------

/** Tốc độ tăng trưởng fleet (để dự báo). */
export interface FleetV23GrowthRate {
  /** Bot mới mỗi tháng (có thể lẻ — vd 2.5 bot/tháng). */
  botsPerMonth: number;
  /** Tài nguyên trung bình mỗi bot mới cần. */
  perBot: FleetV23Demand;
}

/** Dự báo hết chỗ cho một loại tài nguyên. */
export interface FleetV23ExhaustionForecast {
  resource: 'cpu' | 'ram' | 'disk';
  /** Tổng còn trống hiện tại. */
  freeNow: number;
  /** Tốc độ tiêu thụ mỗi tháng. */
  burnPerMonth: number;
  /** Số tháng nữa thì hết (null = không bao giờ hết với tốc độ này). */
  monthsUntilExhaustion: number | null;
  /** Ngày dự báo hết (epoch ms; null khi không hết). */
  exhaustsAtMs: number | null;
  /** true khi sẽ hết trong 3 tháng tới (cần mua node gấp). */
  urgent: boolean;
}

/**
 * Dự báo capacity planning: với tốc độ tăng trưởng cho trước, từng
 * loại tài nguyên (CPU/RAM/disk) còn đủ bao nhiêu tháng. Nút thắt là
 * loại hết sớm nhất. `now` để test xác định.
 */
export function forecastFleetV23Capacity(
  nodes: readonly FleetV23NodeSnapshot[],
  growth: FleetV23GrowthRate,
  now: number = Date.now(),
): { forecasts: FleetV23ExhaustionForecast[]; bottleneck: 'cpu' | 'ram' | 'disk' | null } {
  const free = {
    cpu: nodes.reduce((s, n) => s + Math.max(0, n.cpuFree), 0),
    ram: nodes.reduce((s, n) => s + Math.max(0, n.ramFree), 0),
    disk: nodes.reduce((s, n) => s + Math.max(0, n.diskFree), 0),
  };
  const burn = {
    cpu: growth.botsPerMonth * growth.perBot.cpuCores,
    ram: growth.botsPerMonth * growth.perBot.ramBytes,
    disk: growth.botsPerMonth * growth.perBot.diskBytes,
  };
  const build = (resource: 'cpu' | 'ram' | 'disk'): FleetV23ExhaustionForecast => {
    const burnPerMonth = burn[resource];
    const freeNow = free[resource];
    if (burnPerMonth <= 0) {
      return { resource, freeNow, burnPerMonth, monthsUntilExhaustion: null, exhaustsAtMs: null, urgent: false };
    }
    const months = freeNow / burnPerMonth;
    return {
      resource,
      freeNow,
      burnPerMonth,
      monthsUntilExhaustion: Math.round(months * 100) / 100,
      exhaustsAtMs: now + Math.floor(months * 30 * 24 * 60 * 60 * 1000),
      urgent: months <= 3,
    };
  };
  const forecasts = [build('cpu'), build('ram'), build('disk')];
  const finite = forecasts.filter((f) => f.monthsUntilExhaustion !== null);
  const bottleneck =
    finite.length === 0
      ? null
      : (finite.sort((a, b) => (a.monthsUntilExhaustion as number) - (b.monthsUntilExhaustion as number))[0] as FleetV23ExhaustionForecast).resource;
  return { forecasts, bottleneck };
}

/** Validate yêu cầu đặt bot từ dữ liệu ngoài (lỗi → danh sách). */
export function validateFleetV23PlaceRequest(input: unknown): string[] {
  const errors: string[] = [];
  if (typeof input !== 'object' || input === null) return ['place request phải là object.'];
  const r = input as Record<string, unknown>;
  if (typeof r.botId !== 'string' || r.botId.trim().length === 0) errors.push('request.botId phải là chuỗi không rỗng.');
  const demand = r.demand as Record<string, unknown> | undefined;
  if (typeof demand !== 'object' || demand === null) {
    errors.push('request.demand phải là object { cpuCores, ramBytes, diskBytes }.');
    return errors;
  }
  for (const field of ['cpuCores', 'ramBytes', 'diskBytes'] as const) {
    if (typeof demand[field] !== 'number' || (demand[field] as number) <= 0) {
      errors.push(`request.demand.${field} phải là số > 0.`);
    }
  }
  return errors;
}
