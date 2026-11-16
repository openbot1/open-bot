/**
 * Fleet v13 — model pinning per node theo RAM/VRAM, health check +
 * capacity report, rebalance gợi ý, fleet event log
 * (v1.16, Đội T6).
 *
 * Tầng trên của pinning v12 (`fleet/fleetV12Pinning.ts` — pin model
 * GGUF + verify SHA-256, chặn model OS cung cấp) và health v12
 * (`fleet/fleetV12Health.ts` — sample theo node, alert rule,
 * trend). V12 trả lời "file model có đúng hash không" và "node có
 * khỏe không"; v13 trả lời "node này CÓ CHẠY NỔI model đó không
 * (RAM/VRAM), fleet còn chỗ không, và nên chuyển model nào đi đâu
 * khi node quá tải":
 *
 * - Pinning theo tài nguyên: mỗi node khai RAM/VRAM tổng + trống;
 *   mỗi model khai RAM/VRAM cần (model + KV cache theo context).
 *   `canFleetV13NodeRunModel` kiểm tra vừa RAM + vừa VRAM + vừa
 *   số model tối đa trên node; pin vượt tài nguyên bị từ chối kèm
 *   lý do rõ ràng (thiếu bao nhiêu MB). Pin v13 KHÔNG thay thế
 *   pin v12 — nó là lớp kiểm tra tài nguyên TRƯỚC khi gán pin v12;
 *   hash verify vẫn do v12 làm.
 * - Health check: từ một sample (heartbeat age, CPU/RAM/VRAM %,
 *   disk free) → trạng thái node `healthy/degraded/unhealthy/down`
 *   + lý do từng điều kiện (để UI vẽ rõ). Ngưỡng mặc định: CPU/RAM/
 *   VRAM > 90% → unhealthy, > 75% → degraded; heartbeat quá 5 phút
 *   → down.
 * - Capacity report: tổng RAM/VRAM đã pin vs trống theo node và
 *   toàn fleet, headroom còn lại, node quá tải (đã pin > 85% RAM
 *   hoặc VRAM), model nào chưa có node nào chạy được.
 * - Rebalance gợi ý: node quá tải → đề xuất chuyển model (model
 *   nhẹ nhất vừa node đích) sang node có headroom lớn nhất, kèm
 *   điểm số (giảm tải bao nhiêu %, đích còn trống bao nhiêu sau
 *   khi nhận). Module chỉ GỢI Ý — việc chuyển thật do caller làm.
 * - Fleet event log: append-only trong bộ nhớ + file
 *   `<fleetRoot>/fleet-events-v116.jsonl` (0600): pin/unpin,
 *   health-change, rebalance, node-join/leave, rollout. Event có
 *   seq + thời gian + actor + chi tiết; `verifyFleetV13EventLog`
 *   kiểm tra seq liên tục để phát hiện mất dòng.
 *
 * Module này KHÔNG tải model, KHÔNG chạy inference, KHÔNG spawn
 * process, KHÔNG chạm mạng: nó quyết định "pin được không, khỏe
 * không, chuyển đi đâu" — việc load/chuyển thật do router (T3) /
 * FleetServiceManager làm.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** File event log fleet v13 trong fleet root. */
export const FLEET_V13_EVENTS_FILE = 'fleet-events-v116.jsonl';
/** File snapshot pin v13 trong fleet root. */
export const FLEET_V13_PINS_FILE = 'fleet-pins-v116.json';
/** Số model tối đa pin trên một node. */
export const FLEET_V13_MAX_MODELS_PER_NODE = 4;
/** Số node tối đa trong một fleet snapshot. */
export const FLEET_V13_MAX_NODES = 200;
/** Số event tối đa giữ trong bộ nhớ (file giữ toàn bộ). */
export const FLEET_V13_MAX_EVENTS = 5000;
/** Ngưỡng quá tải: đã dùng >= 85% RAM hoặc VRAM. */
export const FLEET_V13_OVERLOAD_FRACTION = 0.85;
/** Ngưỡng degraded: CPU/RAM/VRAM >= 75%. */
export const FLEET_V13_DEGRADED_THRESHOLD = 0.75;
/** Ngưỡng unhealthy: CPU/RAM/VRAM >= 90%. */
export const FLEET_V13_UNHEALTHY_THRESHOLD = 0.9;
/** Heartbeat quá 5 phút → node down. */
export const FLEET_V13_HEARTBEAT_TIMEOUT_MS = 5 * 60 * 1000;
/** VRAM chừa lại cho hệ thống khi tính vừa model (MB). */
export const FLEET_V13_VRAM_RESERVE_MB = 512;
/** RAM chừa lại cho hệ thống khi tính vừa model (MB). */
export const FLEET_V13_RAM_RESERVE_MB = 1024;

/** Trạng thái sức khỏe node v13. */
export type FleetV13NodeHealth = 'healthy' | 'degraded' | 'unhealthy' | 'down';

export const FLEET_V13_NODE_HEALTHS: readonly FleetV13NodeHealth[] = [
  'healthy',
  'degraded',
  'unhealthy',
  'down',
];

/** Tài nguyên của một fleet node (MB, đo thật do caller cung cấp). */
export interface FleetV13NodeResources {
  nodeId: string;
  /** Tổng RAM (MB). */
  ramTotalMb: number;
  /** RAM trống hiện tại (MB). */
  ramFreeMb: number;
  /** Tổng VRAM (MB, 0 = node không có GPU). */
  vramTotalMb: number;
  /** VRAM trống hiện tại (MB). */
  vramFreeMb: number;
  /** Số core CPU. */
  cpuCores: number;
  /** Epoch ms heartbeat gần nhất (null = chưa từng). */
  lastHeartbeatAt: number | null;
}

/** Yêu cầu tài nguyên của một model (đã gồm KV cache theo context). */
export interface FleetV13ModelRequirement {
  modelId: string;
  displayName: string;
  /** RAM cần (MB) — model + KV cache + overhead router. */
  ramMb: number;
  /** VRAM cần (MB, 0 = chạy CPU-only). */
  vramMb: number;
  /** Context window (token) mà mức RAM/VRAM trên tính cho. */
  contextTokens: number;
  quant: string;
}

/** Một pin model trên node (lớp tài nguyên, trên pin v12). */
export interface FleetV13NodePin {
  nodeId: string;
  modelId: string;
  /** RAM/VRAM model này chiếm trên node (MB, lúc pin). */
  ramMb: number;
  vramMb: number;
  pinnedBy: string;
  pinnedAt: number;
}

/** Toàn bộ snapshot pin v13 (lưu file). */
export interface FleetV13PinSnapshot {
  version: 1;
  nodes: FleetV13NodeResources[];
  pins: FleetV13NodePin[];
  updatedAt: number;
  updatedBy: string;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(0, v));
}

export function createFleetV13PinSnapshot(updatedBy: string, now = Date.now()): FleetV13PinSnapshot {
  return { version: 1, nodes: [], pins: [], updatedAt: now, updatedBy: updatedBy.trim() };
}

/** Đăng ký/cập nhật tài nguyên một node (hàm thuần). */
export type FleetV13RegisterNodeResult =
  | { ok: true; snapshot: FleetV13PinSnapshot; node: FleetV13NodeResources }
  | { ok: false; snapshot: FleetV13PinSnapshot; error: string };

export function registerFleetV13Node(
  snapshot: FleetV13PinSnapshot,
  node: FleetV13NodeResources,
  updatedBy: string,
  now = Date.now(),
): FleetV13RegisterNodeResult {
  const errors: string[] = [];
  if (!isNonEmptyString(node?.nodeId)) errors.push('nodeId không được trống');
  if (!Number.isFinite(node?.ramTotalMb) || node.ramTotalMb <= 0) errors.push('ramTotalMb phải > 0');
  if (!Number.isFinite(node?.ramFreeMb) || node.ramFreeMb < 0 || node.ramFreeMb > node.ramTotalMb) {
    errors.push('ramFreeMb phải trong [0, ramTotalMb]');
  }
  if (!Number.isFinite(node?.vramTotalMb) || node.vramTotalMb < 0) errors.push('vramTotalMb phải >= 0');
  if (!Number.isFinite(node?.vramFreeMb) || node.vramFreeMb < 0 || node.vramFreeMb > node.vramTotalMb) {
    errors.push('vramFreeMb phải trong [0, vramTotalMb]');
  }
  if (!Number.isFinite(node?.cpuCores) || node.cpuCores <= 0) errors.push('cpuCores phải > 0');
  if (errors.length > 0) {
    return { ok: false, snapshot, error: `node không hợp lệ: ${errors.join('; ')}` };
  }
  if (snapshot.nodes.length >= FLEET_V13_MAX_NODES && !snapshot.nodes.some((n) => n.nodeId === node.nodeId.trim())) {
    return { ok: false, snapshot, error: `đã đủ ${FLEET_V13_MAX_NODES} node tối đa` };
  }
  const clean: FleetV13NodeResources = {
    nodeId: node.nodeId.trim(),
    ramTotalMb: Math.floor(node.ramTotalMb),
    ramFreeMb: Math.floor(node.ramFreeMb),
    vramTotalMb: Math.floor(node.vramTotalMb),
    vramFreeMb: Math.floor(node.vramFreeMb),
    cpuCores: Math.floor(node.cpuCores),
    lastHeartbeatAt: node.lastHeartbeatAt,
  };
  const nodes = snapshot.nodes.filter((n) => n.nodeId !== clean.nodeId);
  nodes.push(clean);
  return {
    ok: true,
    snapshot: { ...snapshot, nodes, updatedAt: now, updatedBy: updatedBy.trim() },
    node: clean,
  };
}

export function findFleetV13Node(
  snapshot: FleetV13PinSnapshot,
  nodeId: string,
): FleetV13NodeResources | null {
  if (!isNonEmptyString(nodeId)) return null;
  return snapshot.nodes.find((n) => n.nodeId === nodeId.trim()) ?? null;
}

/** Pin của một node (đã sắp xếp theo modelId). */
export function fleetV13PinsOfNode(
  snapshot: FleetV13PinSnapshot,
  nodeId: string,
): FleetV13NodePin[] {
  if (!isNonEmptyString(nodeId)) return [];
  return snapshot.pins
    .filter((p) => p.nodeId === nodeId.trim())
    .sort((a, b) => a.modelId.localeCompare(b.modelId));
}

/** Tổng RAM/VRAM đã pin trên một node. */
export function fleetV13PinnedUsage(
  snapshot: FleetV13PinSnapshot,
  nodeId: string,
): { ramMb: number; vramMb: number; modelCount: number } {
  const pins = fleetV13PinsOfNode(snapshot, nodeId);
  return {
    ramMb: pins.reduce((n, p) => n + p.ramMb, 0),
    vramMb: pins.reduce((n, p) => n + p.vramMb, 0),
    modelCount: pins.length,
  };
}

/** Kết quả kiểm tra node có chạy nổi model không. */
export interface FleetV13FitCheck {
  fits: boolean;
  reasons: string[];
  /** RAM còn trống sau khi trừ reserve + model (âm = thiếu). */
  ramHeadroomMb: number;
  /** VRAM còn trống sau khi trừ reserve + model (âm = thiếu). */
  vramHeadroomMb: number;
}

/**
 * Kiểm tra node có chạy nổi model không: RAM trống (trừ reserve hệ
 * thống) >= RAM model, VRAM trống (trừ reserve, khi model cần VRAM)
 * >= VRAM model, và node chưa đủ số model tối đa. Trả từng lý do
 * riêng để UI vẽ rõ thiếu bao nhiêu.
 */
export function canFleetV13NodeRunModel(
  node: FleetV13NodeResources,
  model: FleetV13ModelRequirement,
  currentPins: readonly FleetV13NodePin[],
): FleetV13FitCheck {
  const reasons: string[] = [];
  const pinned = currentPins.filter((p) => p.nodeId === node.nodeId);
  const pinnedRam = pinned.reduce((n, p) => n + p.ramMb, 0);
  const pinnedVram = pinned.reduce((n, p) => n + p.vramMb, 0);
  const ramFreeAfterPins = node.ramFreeMb - pinnedRam;
  const vramFreeAfterPins = node.vramFreeMb - pinnedVram;
  const ramHeadroomMb = ramFreeAfterPins - FLEET_V13_RAM_RESERVE_MB - model.ramMb;
  const vramHeadroomMb =
    model.vramMb > 0
      ? vramFreeAfterPins - FLEET_V13_VRAM_RESERVE_MB - model.vramMb
      : Number.POSITIVE_INFINITY;
  if (model.ramMb <= 0) reasons.push(`model "${model.modelId}" có ramMb không hợp lệ (${model.ramMb})`);
  else if (ramHeadroomMb < 0) {
    reasons.push(
      `thiếu RAM: node "${node.nodeId}" còn trống ${ramFreeAfterPins} MB (trừ ${FLEET_V13_RAM_RESERVE_MB} MB reserve), ` +
        `model cần ${model.ramMb} MB — thiếu ${-ramHeadroomMb} MB`,
    );
  }
  if (model.vramMb > 0) {
    if (node.vramTotalMb <= 0) {
      reasons.push(`model "${model.modelId}" cần ${model.vramMb} MB VRAM nhưng node "${node.nodeId}" không có GPU`);
    } else if (vramHeadroomMb < 0) {
      reasons.push(
        `thiếu VRAM: node "${node.nodeId}" còn trống ${vramFreeAfterPins} MB (trừ ${FLEET_V13_VRAM_RESERVE_MB} MB reserve), ` +
          `model cần ${model.vramMb} MB — thiếu ${-vramHeadroomMb} MB`,
      );
    }
  }
  if (pinned.length >= FLEET_V13_MAX_MODELS_PER_NODE) {
    reasons.push(
      `node "${node.nodeId}" đã pin đủ ${FLEET_V13_MAX_MODELS_PER_NODE} model tối đa`,
    );
  }
  if (pinned.some((p) => p.modelId === model.modelId)) {
    reasons.push(`model "${model.modelId}" đã pin trên node "${node.nodeId}" rồi`);
  }
  return { fits: reasons.length === 0, reasons, ramHeadroomMb, vramHeadroomMb };
}

export type FleetV13PinResult =
  | { ok: true; snapshot: FleetV13PinSnapshot; pin: FleetV13NodePin }
  | { ok: false; snapshot: FleetV13PinSnapshot; error: string };

/**
 * Pin model lên node sau khi kiểm tra vừa RAM/VRAM (hàm thuần).
 * Node chưa đăng ký → lỗi; model không vừa → lỗi kèm lý do thiếu
 * bao nhiêu. Pin thành công ghi rõ RAM/VRAM chiếm lúc pin.
 */
export function pinFleetV13ModelToNode(
  snapshot: FleetV13PinSnapshot,
  nodeId: string,
  model: FleetV13ModelRequirement,
  pinnedBy: string,
  now = Date.now(),
): FleetV13PinResult {
  const node = findFleetV13Node(snapshot, nodeId);
  if (!node) return { ok: false, snapshot, error: `node "${nodeId}" chưa đăng ký vào fleet` };
  if (!isNonEmptyString(pinnedBy)) return { ok: false, snapshot, error: 'pinnedBy không được trống' };
  if (!isNonEmptyString(model?.modelId)) return { ok: false, snapshot, error: 'modelId không được trống' };
  const fit = canFleetV13NodeRunModel(node, model, snapshot.pins);
  if (!fit.fits) {
    return { ok: false, snapshot, error: `không pin được model "${model.modelId}" lên node "${nodeId}": ${fit.reasons.join('; ')}` };
  }
  const pin: FleetV13NodePin = {
    nodeId: node.nodeId,
    modelId: model.modelId.trim(),
    ramMb: Math.floor(model.ramMb),
    vramMb: Math.floor(model.vramMb),
    pinnedBy: pinnedBy.trim(),
    pinnedAt: now,
  };
  return {
    ok: true,
    snapshot: { ...snapshot, pins: [...snapshot.pins, pin], updatedAt: now, updatedBy: pinnedBy.trim() },
    pin,
  };
}

/** Gỡ pin model khỏi node (hàm thuần, node/model không có thì trả snapshot cũ). */
export function unpinFleetV13ModelFromNode(
  snapshot: FleetV13PinSnapshot,
  nodeId: string,
  modelId: string,
  updatedBy: string,
  now = Date.now(),
): FleetV13PinSnapshot {
  if (!isNonEmptyString(nodeId) || !isNonEmptyString(modelId)) return snapshot;
  const pins = snapshot.pins.filter(
    (p) => !(p.nodeId === nodeId.trim() && p.modelId === modelId.trim()),
  );
  if (pins.length === snapshot.pins.length) return snapshot;
  return { ...snapshot, pins, updatedAt: now, updatedBy: updatedBy.trim() };
}

// ---------------------------------------------------------------------------
// Health check + capacity report
// ---------------------------------------------------------------------------

/** Một sample sức khỏe node (do caller đo thật). */
export interface FleetV13NodeSample {
  nodeId: string;
  at: number;
  /** CPU đang dùng (0..1). */
  cpuFraction: number;
  /** RAM đang dùng (0..1). */
  ramFraction: number;
  /** VRAM đang dùng (0..1, 0 khi node không có GPU). */
  vramFraction: number;
  /** Đĩa trống (MB). */
  diskFreeMb: number;
  /** Epoch ms heartbeat gần nhất. */
  lastHeartbeatAt: number | null;
}

/** Kết quả health check một node. */
export interface FleetV13HealthResult {
  nodeId: string;
  status: FleetV13NodeHealth;
  checks: { name: string; passed: boolean; detail: string }[];
  summary: string;
}

/**
 * Health check một node từ sample: heartbeat quá hạn → down; bất kỳ
 * CPU/RAM/VRAM >= 90% → unhealthy; >= 75% → degraded; còn lại →
 * healthy. Trả từng điều kiện riêng để UI vẽ rõ lý do.
 */
export function checkFleetV13NodeHealth(
  sample: FleetV13NodeSample,
  now = Date.now(),
): FleetV13HealthResult {
  const checks: FleetV13HealthResult['checks'] = [];
  const heartbeatAge =
    sample.lastHeartbeatAt === null ? Number.POSITIVE_INFINITY : now - sample.lastHeartbeatAt;
  checks.push({
    name: 'heartbeat',
    passed: heartbeatAge <= FLEET_V13_HEARTBEAT_TIMEOUT_MS,
    detail:
      sample.lastHeartbeatAt === null
        ? 'node chưa từng gửi heartbeat'
        : heartbeatAge <= FLEET_V13_HEARTBEAT_TIMEOUT_MS
          ? `heartbeat cách đây ${Math.round(heartbeatAge / 1000)}s`
          : `heartbeat đã mất ${Math.round(heartbeatAge / 60000)} phút (ngưỡng ${FLEET_V13_HEARTBEAT_TIMEOUT_MS / 60000} phút)`,
  });
  for (const [name, value] of [
    ['cpu', clamp01(sample.cpuFraction)],
    ['ram', clamp01(sample.ramFraction)],
    ['vram', clamp01(sample.vramFraction)],
  ] as const) {
    checks.push({
      name,
      passed: value < FLEET_V13_UNHEALTHY_THRESHOLD,
      detail: `${name.toUpperCase()} đang dùng ${(value * 100).toFixed(0)}%` +
        (value >= FLEET_V13_UNHEALTHY_THRESHOLD
          ? ` (vượt ngưỡng unhealthy ${(FLEET_V13_UNHEALTHY_THRESHOLD * 100).toFixed(0)}%)`
          : value >= FLEET_V13_DEGRADED_THRESHOLD
            ? ` (vượt ngưỡng degraded ${(FLEET_V13_DEGRADED_THRESHOLD * 100).toFixed(0)}%)`
            : ''),
    });
  }
  checks.push({
    name: 'disk',
    passed: sample.diskFreeMb >= 1024,
    detail:
      sample.diskFreeMb >= 1024
        ? `đĩa còn trống ${sample.diskFreeMb} MB`
        : `đĩa chỉ còn ${sample.diskFreeMb} MB trống (dưới 1 GB)`,
  });
  let status: FleetV13NodeHealth = 'healthy';
  if (!checks[0].passed) status = 'down';
  else if (checks.some((c) => c.name !== 'heartbeat' && !c.passed)) status = 'unhealthy';
  else if (
    clamp01(sample.cpuFraction) >= FLEET_V13_DEGRADED_THRESHOLD ||
    clamp01(sample.ramFraction) >= FLEET_V13_DEGRADED_THRESHOLD ||
    clamp01(sample.vramFraction) >= FLEET_V13_DEGRADED_THRESHOLD
  ) {
    status = 'degraded';
  }
  const worst = checks.filter((c) => !c.passed).map((c) => c.name).join(', ');
  return {
    nodeId: sample.nodeId,
    status,
    checks,
    summary:
      status === 'healthy'
        ? `Node "${sample.nodeId}" khỏe.`
        : `Node "${sample.nodeId}" ${status} (${worst || 'tải cao'}).`,
  };
}

/** Capacity của một node trong report. */
export interface FleetV13NodeCapacity {
  nodeId: string;
  ramTotalMb: number;
  ramPinnedMb: number;
  ramUsedFraction: number;
  vramTotalMb: number;
  vramPinnedMb: number;
  vramUsedFraction: number;
  modelCount: number;
  overloaded: boolean;
  headroomRamMb: number;
  headroomVramMb: number;
}

/** Capacity report toàn fleet. */
export interface FleetV13CapacityReport {
  nodeCount: number;
  totalRamMb: number;
  totalPinnedRamMb: number;
  totalVramMb: number;
  totalPinnedVramMb: number;
  overloadedNodes: string[];
  underloadedNodes: string[];
  nodes: FleetV13NodeCapacity[];
  summary: string;
}

/**
 * Capacity report: RAM/VRAM đã pin vs tổng theo node + toàn fleet,
 * node quá tải (>= 85% RAM hoặc VRAM đã pin), node còn trống nhiều
 * (< 25% đã pin). Dùng để UI vẽ bảng capacity và làm đầu vào cho
 * rebalance.
 */
export function buildFleetV13CapacityReport(snapshot: FleetV13PinSnapshot): FleetV13CapacityReport {
  const nodes: FleetV13NodeCapacity[] = snapshot.nodes.map((node) => {
    const usage = fleetV13PinnedUsage(snapshot, node.nodeId);
    const ramUsedFraction = node.ramTotalMb > 0 ? usage.ramMb / node.ramTotalMb : 0;
    const vramUsedFraction = node.vramTotalMb > 0 ? usage.vramMb / node.vramTotalMb : 0;
    const overloaded =
      ramUsedFraction >= FLEET_V13_OVERLOAD_FRACTION || vramUsedFraction >= FLEET_V13_OVERLOAD_FRACTION;
    return {
      nodeId: node.nodeId,
      ramTotalMb: node.ramTotalMb,
      ramPinnedMb: usage.ramMb,
      ramUsedFraction,
      vramTotalMb: node.vramTotalMb,
      vramPinnedMb: usage.vramMb,
      vramUsedFraction,
      modelCount: usage.modelCount,
      overloaded,
      headroomRamMb: Math.max(0, node.ramFreeMb - usage.ramMb - FLEET_V13_RAM_RESERVE_MB),
      headroomVramMb: Math.max(0, node.vramFreeMb - usage.vramMb - FLEET_V13_VRAM_RESERVE_MB),
    };
  });
  const totalRamMb = nodes.reduce((n, x) => n + x.ramTotalMb, 0);
  const totalPinnedRamMb = nodes.reduce((n, x) => n + x.ramPinnedMb, 0);
  const totalVramMb = nodes.reduce((n, x) => n + x.vramTotalMb, 0);
  const totalPinnedVramMb = nodes.reduce((n, x) => n + x.vramPinnedMb, 0);
  const overloadedNodes = nodes.filter((n) => n.overloaded).map((n) => n.nodeId);
  const underloadedNodes = nodes
    .filter((n) => n.ramUsedFraction < 0.25 && n.vramUsedFraction < 0.25 && n.modelCount > 0)
    .map((n) => n.nodeId);
  return {
    nodeCount: nodes.length,
    totalRamMb,
    totalPinnedRamMb,
    totalVramMb,
    totalPinnedVramMb,
    overloadedNodes,
    underloadedNodes,
    nodes,
    summary:
      nodes.length === 0
        ? 'Fleet chưa có node nào.'
        : `Fleet ${nodes.length} node: đã pin ${totalPinnedRamMb}/${totalRamMb} MB RAM, ` +
          `${totalPinnedVramMb}/${totalVramMb} MB VRAM; ${overloadedNodes.length} node quá tải.`,
  };
}

/** Một gợi ý rebalance (chuyển model từ node quá tải sang node trống). */
export interface FleetV13RebalanceSuggestion {
  fromNodeId: string;
  toNodeId: string;
  modelId: string;
  ramMb: number;
  vramMb: number;
  /** % RAM node nguồn giảm sau khi chuyển. */
  sourceReliefPct: number;
  /** % RAM node đích dùng sau khi nhận (0..1). */
  destUsedAfter: number;
  reason: string;
}

/**
 * Gợi ý rebalance: với mỗi node quá tải, thử chuyển model nhẹ nhất
 * (RAM nhỏ nhất, ưu tiên model CPU-only khi đích không có GPU) sang
 * node có headroom lớn nhất mà vừa model đó. Mỗi model chỉ gợi ý
 * một lần. Module chỉ gợi ý — không tự chuyển.
 */
export function suggestFleetV13Rebalance(
  snapshot: FleetV13PinSnapshot,
  report: FleetV13CapacityReport = buildFleetV13CapacityReport(snapshot),
): FleetV13RebalanceSuggestion[] {
  const suggestions: FleetV13RebalanceSuggestion[] = [];
  const moved = new Set<string>();
  const overloaded = report.nodes.filter((n) => n.overloaded);
  const candidates = report.nodes
    .filter((n) => !n.overloaded)
    .sort((a, b) => b.headroomRamMb - a.headroomRamMb);
  for (const source of overloaded) {
    const pins = fleetV13PinsOfNode(snapshot, source.nodeId)
      .filter((p) => !moved.has(`${p.nodeId}:${p.modelId}`))
      .sort((a, b) => a.ramMb + a.vramMb - (b.ramMb + b.vramMb));
    for (const pin of pins) {
      const dest = candidates.find((c) => {
        if (c.nodeId === source.nodeId) return false;
        const destNode = findFleetV13Node(snapshot, c.nodeId);
        if (!destNode) return false;
        const fit = canFleetV13NodeRunModel(
          destNode,
          {
            modelId: pin.modelId,
            displayName: pin.modelId,
            ramMb: pin.ramMb,
            vramMb: pin.vramMb,
            contextTokens: 0,
            quant: '',
          },
          snapshot.pins.filter((p) => p.nodeId === c.nodeId),
        );
        return fit.fits;
      });
      if (!dest) continue;
      const sourceReliefPct =
        source.ramTotalMb > 0 ? pin.ramMb / source.ramTotalMb : 0;
      const destUsedAfter =
        dest.ramTotalMb > 0 ? (dest.ramPinnedMb + pin.ramMb) / dest.ramTotalMb : 0;
      suggestions.push({
        fromNodeId: source.nodeId,
        toNodeId: dest.nodeId,
        modelId: pin.modelId,
        ramMb: pin.ramMb,
        vramMb: pin.vramMb,
        sourceReliefPct,
        destUsedAfter,
        reason:
          `node "${source.nodeId}" quá tải (${(source.ramUsedFraction * 100).toFixed(0)}% RAM đã pin) — ` +
          `chuyển model "${pin.modelId}" (${pin.ramMb} MB RAM) sang node "${dest.nodeId}" ` +
          `(còn trống ${dest.headroomRamMb} MB, sau khi nhận dùng ${(destUsedAfter * 100).toFixed(0)}% RAM)`,
      });
      moved.add(`${pin.nodeId}:${pin.modelId}`);
      break; // mỗi node nguồn chỉ gợi ý 1 lần chuyển trong một lượt
    }
  }
  return suggestions;
}

// ---------------------------------------------------------------------------
// Fleet event log
// ---------------------------------------------------------------------------

/** Loại event trong fleet event log v13. */
export type FleetV13EventKind =
  | 'node-join'
  | 'node-leave'
  | 'pin'
  | 'unpin'
  | 'health-change'
  | 'rebalance-suggested'
  | 'rollout'
  | 'node-maintenance';

export const FLEET_V13_EVENT_KINDS: readonly FleetV13EventKind[] = [
  'node-join',
  'node-leave',
  'pin',
  'unpin',
  'health-change',
  'rebalance-suggested',
  'rollout',
  'node-maintenance',
];

/** Một event trong fleet event log. */
export interface FleetV13Event {
  seq: number;
  at: number;
  kind: FleetV13EventKind;
  nodeId: string;
  actorUserId: string;
  detail: string;
}

/** Tạo event mới (seq nối tiếp event cuối, hàm thuần). */
export function createFleetV13Event(
  events: readonly FleetV13Event[],
  input: {
    kind: FleetV13EventKind;
    nodeId?: string;
    actorUserId: string;
    detail: string;
  },
  now = Date.now(),
): FleetV13Event {
  const last = events[events.length - 1];
  return {
    seq: last ? last.seq + 1 : 1,
    at: now,
    kind: input.kind,
    nodeId: input.nodeId?.trim() ?? '',
    actorUserId: input.actorUserId.trim(),
    detail: input.detail.trim(),
  };
}

/** Append event (hàm thuần, cắt bộ nhớ ở FLEET_V13_MAX_EVENTS). */
export function appendFleetV13Event(
  events: readonly FleetV13Event[],
  input: {
    kind: FleetV13EventKind;
    nodeId?: string;
    actorUserId: string;
    detail: string;
  },
  now = Date.now(),
): FleetV13Event[] {
  if (!FLEET_V13_EVENT_KINDS.includes(input.kind)) return [...events];
  if (!isNonEmptyString(input.actorUserId) || !isNonEmptyString(input.detail)) return [...events];
  return [...events, createFleetV13Event(events, input, now)].slice(-FLEET_V13_MAX_EVENTS);
}

/** Lọc event log theo kind/node/khoảng thời gian (cho panel UI). */
export function filterFleetV13Events(
  events: readonly FleetV13Event[],
  filter: { kind?: FleetV13EventKind; nodeId?: string; fromAt?: number; toAt?: number },
): FleetV13Event[] {
  return events.filter((e) => {
    if (filter.kind && e.kind !== filter.kind) return false;
    if (filter.nodeId && e.nodeId !== filter.nodeId) return false;
    if (typeof filter.fromAt === 'number' && e.at < filter.fromAt) return false;
    if (typeof filter.toAt === 'number' && e.at > filter.toAt) return false;
    return true;
  });
}

/** Kết quả verify event log (seq liên tục, kind hợp lệ). */
export function verifyFleetV13EventLog(events: readonly FleetV13Event[]): {
  ok: boolean;
  checked: number;
  badSeq: number;
  reason: string;
} {
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (!FLEET_V13_EVENT_KINDS.includes(e.kind)) {
      return { ok: false, checked: i, badSeq: e.seq, reason: `event seq ${e.seq}: kind "${e.kind}" không hợp lệ` };
    }
    if (i === 0) {
      if (e.seq !== 1) {
        return { ok: false, checked: 0, badSeq: e.seq, reason: `event đầu tiên phải có seq 1, nhận được ${e.seq} (log có thể đã bị cắt đầu)` };
      }
    } else if (e.seq !== events[i - 1].seq + 1) {
      return {
        ok: false,
        checked: i,
        badSeq: e.seq,
        reason: `event seq ${e.seq}: seq không liên tục (thiếu event ${events[i - 1].seq + 1})`,
      };
    }
  }
  return { ok: true, checked: events.length, badSeq: -1, reason: `event log nguyên vẹn (${events.length} event)` };
}

/** Tóm tắt fleet v13 cho UI. */
export interface FleetV13Summary {
  nodeCount: number;
  pinCount: number;
  overloadedCount: number;
  eventCount: number;
  summary: string;
}

export function summarizeFleetV13(
  snapshot: FleetV13PinSnapshot,
  events: readonly FleetV13Event[],
): FleetV13Summary {
  const report = buildFleetV13CapacityReport(snapshot);
  return {
    nodeCount: snapshot.nodes.length,
    pinCount: snapshot.pins.length,
    overloadedCount: report.overloadedNodes.length,
    eventCount: events.length,
    summary:
      snapshot.nodes.length === 0
        ? 'Fleet v13 chưa có node nào.'
        : `Fleet v13: ${snapshot.nodes.length} node, ${snapshot.pins.length} pin model, ` +
          `${report.overloadedNodes.length} node quá tải, ${events.length} event.`,
  };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export function getFleetV13PinsPath(fleetRoot: string): string {
  return path.join(fleetRoot, FLEET_V13_PINS_FILE);
}

export function getFleetV13EventsPath(fleetRoot: string): string {
  return path.join(fleetRoot, FLEET_V13_EVENTS_FILE);
}

function atomicWriteFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, filePath);
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Nền tảng không hỗ trợ chmod (Windows) — file vẫn dùng được.
  }
}

function isValidNode(v: unknown): v is FleetV13NodeResources {
  if (!v || typeof v !== 'object') return false;
  const n = v as Partial<FleetV13NodeResources>;
  return (
    typeof n.nodeId === 'string' &&
    typeof n.ramTotalMb === 'number' &&
    typeof n.ramFreeMb === 'number' &&
    typeof n.vramTotalMb === 'number' &&
    typeof n.vramFreeMb === 'number'
  );
}

function isValidPin(v: unknown): v is FleetV13NodePin {
  if (!v || typeof v !== 'object') return false;
  const p = v as Partial<FleetV13NodePin>;
  return typeof p.nodeId === 'string' && typeof p.modelId === 'string' && typeof p.ramMb === 'number';
}

export function loadFleetV13PinSnapshot(fleetRoot: string): FleetV13PinSnapshot | null {
  try {
    const raw = fs.readFileSync(getFleetV13PinsPath(fleetRoot), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const p = parsed as Partial<FleetV13PinSnapshot>;
    if (p.version !== 1 || !Array.isArray(p.nodes) || !Array.isArray(p.pins)) return null;
    return {
      version: 1,
      nodes: p.nodes.filter(isValidNode).slice(0, FLEET_V13_MAX_NODES),
      pins: p.pins.filter(isValidPin),
      updatedAt: typeof p.updatedAt === 'number' ? p.updatedAt : 0,
      updatedBy: typeof p.updatedBy === 'string' ? p.updatedBy : '',
    };
  } catch {
    return null;
  }
}

export function saveFleetV13PinSnapshot(fleetRoot: string, snapshot: FleetV13PinSnapshot): void {
  atomicWriteFile(getFleetV13PinsPath(fleetRoot), `${JSON.stringify(snapshot, null, 2)}\n`);
}

/** Ghi thêm một event xuống file JSONL (append, 0600 khi tạo mới). */
export function appendFleetV13EventToFile(fleetRoot: string, event: FleetV13Event): void {
  const filePath = getFleetV13EventsPath(fleetRoot);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(event)}\n`, { mode: 0o600 });
}

/** Đọc toàn bộ event log từ file JSONL (dòng hỏng bị bỏ qua, có đếm). */
export function readFleetV13EventsFromFile(fleetRoot: string): {
  events: FleetV13Event[];
  skippedLines: number;
} {
  try {
    const raw = fs.readFileSync(getFleetV13EventsPath(fleetRoot), 'utf8');
    const events: FleetV13Event[] = [];
    let skippedLines = 0;
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as unknown;
        if (
          parsed &&
          typeof parsed === 'object' &&
          typeof (parsed as Partial<FleetV13Event>).seq === 'number' &&
          FLEET_V13_EVENT_KINDS.includes((parsed as Partial<FleetV13Event>).kind as FleetV13EventKind)
        ) {
          events.push(parsed as FleetV13Event);
        } else skippedLines++;
      } catch {
        skippedLines++;
      }
    }
    return { events, skippedLines };
  } catch {
    return { events: [], skippedLines: 0 };
  }
}
