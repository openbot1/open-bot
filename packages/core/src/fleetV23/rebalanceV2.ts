/**
 * Rebalance engine v2 cho fleet v23 (v1.36, Đội T6) — phát hiện lệch
 * tải → lập kế hoạch di chuyển bot → dry-run → thực thi từng bước có
 * xác minh → rollback khi lỗi.
 *
 * Fleet v21 đã có `planFleetV21Rebalance` (node mới vào / node chết →
 * gợi ý di chuyển). Module này khác ở 3 điểm:
 *
 * 1. PHÁT HIỆN lệch tải liên tục, không chỉ khi node vào/ra: đo độ
 *    lệch tải CPU/RAM theo hệ số biến thiên (CV = stddev/mean) + độ
 *    chênh max-min; chỉ rebalance khi vượt ngưỡng (tránh di chuyển
 *    bot vì lệch nhỏ — mỗi lần di chuyển đều có chi phí gián đoạn).
 * 2. DI CHUYỂN KHÔNG GIÁN ĐOẠN theo từng bước: mỗi move phải qua
 *    verify (bot chạy lại được trên node đích — host báo kết quả qua
 *    callback) mới làm move tiếp theo; move lỗi → DỪNG và ROLLBACK
 *    các move đã làm (đưa bot về node cũ), không để fleet ở trạng
 *    thái nửa vời.
 * 3. DRY-RUN: kế hoạch có thể chạy thử (tính placement sau rebalance
 *    + độ lệch mới + số move) mà không đổi gì — host/UI xem trước
 *    rồi mới duyệt thực thi.
 *
 * Ràng buộc khi chọn move: node đích phải đủ tài nguyên trống, không
 * vi phạm topology (anti-affinity với bot trên node đích, spread
 * group, zone cấm), không di chuyển bot `pinned` (host đánh dấu bot
 * không được di chuyển, vd bot đang chạy job critical). Module thuần:
 * host cung cấp load snapshot + callback verify/move thật.
 */

import type { FleetV23NodeSnapshot } from './placementV2';
import type { FleetV23Topology } from './topology';
import { checkFleetV23GroupPlacement, topologyGroupOfBot } from './topology';

/** Load của một node (tỉ lệ dùng 0..1 theo từng loại tài nguyên). */
export interface FleetV23NodeLoad {
  nodeId: string;
  /** Tỉ lệ CPU đang dùng (0..1). */
  cpuUsedFraction: number;
  /** Tỉ lệ RAM đang dùng (0..1). */
  ramUsedFraction: number;
  /** Bot đang chạy trên node + tài nguyên mỗi bot dùng (để tính move). */
  bots: { botId: string; cpuCores: number; ramBytes: number; diskBytes: number; pinned: boolean }[];
}

/** Độ lệch tải của fleet. */
export interface FleetV23Imbalance {
  /** Hệ số biến thiên CPU (stddev/mean); 0 = cân tuyệt đối. */
  cpuCv: number;
  /** Hệ số biến thiên RAM. */
  ramCv: number;
  /** Chênh lệch max-min tỉ lệ dùng CPU giữa các node. */
  cpuSpread: number;
  /** Chênh lệch max-min tỉ lệ dùng RAM. */
  ramSpread: number;
  /** Node tải cao nhất (CPU). */
  hottestNodeId: string | null;
  /** Node tải thấp nhất (CPU). */
  coldestNodeId: string | null;
  /** Tải trung bình CPU toàn fleet. */
  meanCpu: number;
  /** Có cần rebalance không (vượt ngưỡng). */
  needsRebalance: boolean;
  /** Giải thích 1 dòng. */
  reason: string;
}

/** Ngưỡng phát hiện lệch tải. */
export interface FleetV23RebalanceThresholds {
  /** CV vượt ngưỡng này → lệch (mặc định 0.35, khớp REBALANCE_IMBALANCE_THRESHOLD v21). */
  maxCv: number;
  /** Chênh max-min vượt ngưỡng này → lệch (mặc định 0.4). */
  maxSpread: number;
  /** Số move tối đa trong một kế hoạch (tránh đảo cả fleet một lần). */
  maxMoves: number;
}

/** Ngưỡng mặc định. */
export const DEFAULT_FLEET_V23_REBALANCE_THRESHOLDS: FleetV23RebalanceThresholds = {
  maxCv: 0.35,
  maxSpread: 0.4,
  maxMoves: 5,
};

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function stddev(values: number[], avg: number): number {
  if (values.length === 0) return 0;
  return Math.sqrt(values.reduce((s, v) => s + (v - avg) ** 2, 0) / values.length);
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * Đo độ lệch tải của fleet từ load snapshot các node. Dưới 2 node thì
 * không có gì để cân (needsRebalance = false).
 */
export function measureFleetV23Imbalance(
  loads: readonly FleetV23NodeLoad[],
  thresholds: FleetV23RebalanceThresholds = DEFAULT_FLEET_V23_REBALANCE_THRESHOLDS,
): FleetV23Imbalance {
  if (loads.length < 2) {
    return {
      cpuCv: 0,
      ramCv: 0,
      cpuSpread: 0,
      ramSpread: 0,
      hottestNodeId: loads[0]?.nodeId ?? null,
      coldestNodeId: loads[0]?.nodeId ?? null,
      meanCpu: loads[0]?.cpuUsedFraction ?? 0,
      needsRebalance: false,
      reason: loads.length === 0 ? 'Fleet không có node nào — không có gì để cân.' : 'Fleet chỉ có 1 node — không thể rebalance.',
    };
  }
  const cpuValues = loads.map((l) => l.cpuUsedFraction);
  const ramValues = loads.map((l) => l.ramUsedFraction);
  const meanCpu = mean(cpuValues);
  const meanRam = mean(ramValues);
  const cpuCv = meanCpu > 0 ? stddev(cpuValues, meanCpu) / meanCpu : 0;
  const ramCv = meanRam > 0 ? stddev(ramValues, meanRam) / meanRam : 0;
  const cpuSpread = Math.max(...cpuValues) - Math.min(...cpuValues);
  const ramSpread = Math.max(...ramValues) - Math.min(...ramValues);
  const hottest = loads.reduce((a, b) => (b.cpuUsedFraction > a.cpuUsedFraction ? b : a));
  const coldest = loads.reduce((a, b) => (b.cpuUsedFraction < a.cpuUsedFraction ? b : a));
  const needsRebalance =
    cpuCv > thresholds.maxCv || ramCv > thresholds.maxCv || cpuSpread > thresholds.maxSpread || ramSpread > thresholds.maxSpread;
  return {
    cpuCv: round3(cpuCv),
    ramCv: round3(ramCv),
    cpuSpread: round3(cpuSpread),
    ramSpread: round3(ramSpread),
    hottestNodeId: hottest.nodeId,
    coldestNodeId: coldest.nodeId,
    meanCpu: round3(meanCpu),
    needsRebalance,
    reason: needsRebalance
      ? `Lệch tải: CPU CV ${round3(cpuCv)} (ngưỡng ${thresholds.maxCv}), spread ${round3(cpuSpread)} (ngưỡng ${thresholds.maxSpread}); node nóng nhất "${hottest.nodeId}", lạnh nhất "${coldest.nodeId}".`
      : `Tải cân bằng: CPU CV ${round3(cpuCv)}, spread ${round3(cpuSpread)} — trong ngưỡng, không cần rebalance.`,
  };
}

// ---------------------------------------------------------------------------
// Kế hoạch rebalance
// ---------------------------------------------------------------------------

/** Một bước di chuyển bot trong kế hoạch rebalance. */
export interface FleetV23RebalanceMove {
  /** Bot di chuyển. */
  botId: string;
  /** Node nguồn. */
  fromNodeId: string;
  /** Node đích. */
  toNodeId: string;
  /** Tải CPU node nguồn giảm bao nhiêu (điểm tỉ lệ) sau move này. */
  cpuRelief: number;
  /** Lý do chọn move này. */
  reason: string;
}

/** Kế hoạch rebalance (dry-run hoặc sẽ thực thi). */
export interface FleetV23RebalancePlan {
  /** Id kế hoạch (ổn định để audit/rollback trích dẫn). */
  id: string;
  /** Lúc lập kế hoạch (epoch ms). */
  createdAt: number;
  /** Độ lệch trước rebalance. */
  imbalanceBefore: FleetV23Imbalance;
  /** Các bước di chuyển (theo thứ tự thực thi). */
  moves: FleetV23RebalanceMove[];
  /** Placement sau khi áp dụng toàn bộ move (botId → nodeId). */
  placementAfter: Record<string, string>;
  /** Độ lệch dự kiến sau rebalance (tính trên placement sau). */
  imbalanceAfter: FleetV23Imbalance;
  /** true = dry-run (chỉ tính, chưa đổi gì). */
  dryRun: boolean;
  /** Cảnh báo (vd hết move mà vẫn lệch — cần thêm node). */
  warnings: string[];
}

/** Một bot move được thì node đích phải đủ chỗ + không vi phạm topology. */
function moveAllowedV23(
  bot: { botId: string; cpuCores: number; ramBytes: number; diskBytes: number },
  fromNodeId: string,
  toNode: FleetV23NodeSnapshot,
  topology: FleetV23Topology | undefined,
  placement: ReadonlyMap<string, string> | Record<string, string>,
): string | null {
  if (toNode.id === fromNodeId) return 'node đích chính là node nguồn.';
  if (!toNode.online) return `node đích "${toNode.id}" không online.`;
  if (toNode.cpuFree < bot.cpuCores) return `node đích "${toNode.id}" chỉ còn ${toNode.cpuFree} CPU, bot cần ${bot.cpuCores}.`;
  if (toNode.ramFree < bot.ramBytes) return `node đích "${toNode.id}" chỉ còn ${toNode.ramFree} byte RAM, bot cần ${bot.ramBytes}.`;
  if (toNode.diskFree < bot.diskBytes) return `node đích "${toNode.id}" chỉ còn ${toNode.diskFree} byte disk, bot cần ${bot.diskBytes}.`;
  if (!topology) return null;
  const group = topologyGroupOfBot(topology, bot.botId);
  if (!group) return null;
  const trial: Record<string, string> = placement instanceof Map ? Object.fromEntries(placement) : { ...placement };
  trial[bot.botId] = toNode.id;
  const violations = checkFleetV23GroupPlacement(topology, group, trial);
  // Spread chỉ ép khi cả group đã đặt (xem placementV2 — placement từng
  // phần không thể đủ spread).
  const allPlaced = group.botIds.every((b) => trial[b] !== undefined);
  const relevant = violations.filter(
    (v) => v.botIds.includes(bot.botId) && v.kind !== 'unplaced-bot' && !(v.kind === 'spread-short' && !allPlaced),
  );
  if (relevant.length > 0) return `topology: ${relevant[0]?.reason ?? 'vi phạm'}`;
  return null;
}

/**
 * Lập kế hoạch rebalance (tham lam):
 * - Lặp: lấy node nóng nhất (CPU) và node lạnh nhất; chọn bot KHÔNG
 *   pinned trên node nóng mà node lạnh chứa được (bot lớn nhất trước
 *   — giảm tải nhanh nhất với ít move nhất), kiểm tra topology; move
 *   đó vào kế hoạch, cập nhật load giả định, lặp lại.
 * - Dừng khi: hết lệch (dưới ngưỡng), hết move cho phép, không còn
 *   move hợp lệ, hoặc đã đủ `maxMoves`.
 * - Không đổi gì thật — chỉ trả kế hoạch (dry-run mặc định true; host
 *   duyệt rồi gọi `executeFleetV23RebalancePlan`).
 */
export function planFleetV23Rebalance(input: {
  id: string;
  loads: readonly FleetV23NodeLoad[];
  nodes: readonly FleetV23NodeSnapshot[];
  placement: ReadonlyMap<string, string> | Record<string, string>;
  topology?: FleetV23Topology;
  thresholds?: FleetV23RebalanceThresholds;
  dryRun?: boolean;
  now?: number;
}): FleetV23RebalancePlan {
  const thresholds = input.thresholds ?? DEFAULT_FLEET_V23_REBALANCE_THRESHOLDS;
  const now = input.now ?? Date.now();
  const imbalanceBefore = measureFleetV23Imbalance(input.loads, thresholds);
  const warnings: string[] = [];
  const moves: FleetV23RebalanceMove[] = [];
  // Load giả định (thay đổi theo từng move thử) — key nodeId.
  const simLoad = new Map<string, { cpu: number; ram: number; bots: FleetV23NodeLoad['bots'] }>();
  for (const l of input.loads) {
    simLoad.set(l.nodeId, { cpu: l.cpuUsedFraction, ram: l.ramUsedFraction, bots: l.bots.map((b) => ({ ...b })) });
  }
  const nodeById = new Map(input.nodes.map((n) => [n.id, n]));
  // Tài nguyên gốc của từng bot (tra khi tính chỗ trống node đích —
  // bot đã move khỏi danh sách bots của node nguồn trong mô phỏng).
  const botResources = new Map<string, { cpuCores: number; ramBytes: number; diskBytes: number }>();
  for (const l of input.loads) {
    for (const b of l.bots) botResources.set(b.botId, { cpuCores: b.cpuCores, ramBytes: b.ramBytes, diskBytes: b.diskBytes });
  }
  const placementAfter: Record<string, string> =
    input.placement instanceof Map ? Object.fromEntries(input.placement) : { ...input.placement };

  const simLoads = (): FleetV23NodeLoad[] =>
    [...simLoad.entries()].map(([nodeId, v]) => ({
      nodeId,
      cpuUsedFraction: v.cpu,
      ramUsedFraction: v.ram,
      bots: v.bots,
    }));

  if (!imbalanceBefore.needsRebalance) {
    return {
      id: input.id,
      createdAt: now,
      imbalanceBefore,
      moves,
      placementAfter,
      imbalanceAfter: imbalanceBefore,
      dryRun: input.dryRun ?? true,
      warnings: ['Tải đã cân bằng — không cần move nào.'],
    };
  }

  while (moves.length < thresholds.maxMoves) {
    const current = measureFleetV23Imbalance(simLoads(), thresholds);
    if (!current.needsRebalance) break;
    const hottestId = current.hottestNodeId as string;
    const coldestId = current.coldestNodeId as string;
    if (hottestId === coldestId) break;
    const hot = simLoad.get(hottestId);
    const cold = simLoad.get(coldestId);
    const coldNode = nodeById.get(coldestId);
    if (!hot || !cold || !coldNode) break;
    // Bot di chuyển được trên node nóng: không pinned, sắp theo CPU giảm dần.
    const movable = hot.bots
      .filter((b) => !b.pinned)
      .sort((a, b) => b.cpuCores - a.cpuCores || a.botId.localeCompare(b.botId));
    let moved = false;
    for (const bot of movable) {
      // Node đích "trống" trong mô phỏng = snapshot trừ bot đã move tới
      // node này trong kế hoạch đang lập.
      const movedToCold = moves.filter((m) => m.toNodeId === coldestId);
      const movedResources = movedToCold.reduce(
        (s, m) => {
          const b = botResources.get(m.botId);
          return {
            cpu: s.cpu + (b?.cpuCores ?? 0),
            ram: s.ram + (b?.ramBytes ?? 0),
            disk: s.disk + (b?.diskBytes ?? 0),
          };
        },
        { cpu: 0, ram: 0, disk: 0 },
      );
      const effectiveCold: FleetV23NodeSnapshot = {
        ...coldNode,
        cpuFree: Math.max(0, coldNode.cpuFree - movedResources.cpu),
        ramFree: Math.max(0, coldNode.ramFree - movedResources.ram),
        diskFree: Math.max(0, coldNode.diskFree - movedResources.disk),
      };
      const blockReason = moveAllowedV23(bot, hottestId, effectiveCold, input.topology, placementAfter);
      if (blockReason !== null) continue;
      // Áp move vào mô phỏng: tải CPU node nóng giảm theo tỉ lệ bot
      // chiếm trên node (ước từ cpuCores / tổng CPU node).
      const hotNode = nodeById.get(hottestId);
      const cpuRelief = hotNode && hotNode.cpuCores > 0 ? bot.cpuCores / hotNode.cpuCores : 0;
      const coldNodeTotal = coldNode.cpuCores > 0 ? coldNode.cpuCores : 1;
      const cpuGain = bot.cpuCores / coldNodeTotal;
      hot.cpu = Math.max(0, hot.cpu - cpuRelief);
      cold.cpu = Math.min(1, cold.cpu + cpuGain);
      const hotRamTotal = hotNode && hotNode.ramBytes > 0 ? hotNode.ramBytes : 1;
      const coldRamTotal = coldNode.ramBytes > 0 ? coldNode.ramBytes : 1;
      hot.ram = Math.max(0, hot.ram - bot.ramBytes / hotRamTotal);
      cold.ram = Math.min(1, cold.ram + bot.ramBytes / coldRamTotal);
      hot.bots = hot.bots.filter((b) => b.botId !== bot.botId);
      cold.bots = [...cold.bots, bot];
      placementAfter[bot.botId] = coldestId;
      moves.push({
        botId: bot.botId,
        fromNodeId: hottestId,
        toNodeId: coldestId,
        cpuRelief: round3(cpuRelief),
        reason: `Di chuyển bot "${bot.botId}" từ node nóng "${hottestId}" sang node lạnh "${coldestId}" (giảm tải CPU node nguồn ~${round3(cpuRelief * 100)}%).`,
      });
      moved = true;
      break;
    }
    if (!moved) {
      warnings.push(
        `Không move được bot nào từ node nóng "${hottestId}" sang node lạnh "${coldestId}" (bot pinned / node đích thiếu chỗ / vi phạm topology) — cần thêm node hoặc nới ràng buộc.`,
      );
      break;
    }
  }

  const imbalanceAfter = measureFleetV23Imbalance(simLoads(), thresholds);
  if (moves.length >= thresholds.maxMoves && imbalanceAfter.needsRebalance) {
    warnings.push(`Đã đủ ${thresholds.maxMoves} move tối đa mà tải vẫn lệch — chạy thêm một kế hoạch nữa sau khi các move này xong.`);
  }
  return {
    id: input.id,
    createdAt: now,
    imbalanceBefore,
    moves,
    placementAfter,
    imbalanceAfter,
    dryRun: input.dryRun ?? true,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Thực thi + xác minh + rollback
// ---------------------------------------------------------------------------

/** Kết quả thực thi một move (host báo qua callback). */
export interface FleetV23MoveResult {
  move: FleetV23RebalanceMove;
  /** Bot chạy lại được trên node đích chưa. */
  verified: boolean;
  /** Ghi chú (vd lỗi khi di chuyển). */
  note?: string;
}

/** Kết quả thực thi toàn bộ kế hoạch. */
export interface FleetV23RebalanceExecution {
  planId: string;
  /** Mọi move đã áp dụng thành công (theo thứ tự). */
  appliedMoves: FleetV23RebalanceMove[];
  /** Move lỗi (nếu có) — thực thi dừng tại đây. */
  failedMove: { move: FleetV23RebalanceMove; note: string } | null;
  /** Move đã rollback về node cũ (khi có lỗi). */
  rolledBackMoves: FleetV23RebalanceMove[];
  /** true = toàn bộ kế hoạch xong, không lỗi. */
  success: boolean;
  /** Placement cuối cùng sau thực thi/rollback. */
  placementAfter: Record<string, string>;
}

/**
 * Thực thi kế hoạch rebalance từng bước:
 * - Mỗi move: gọi `moveBot` (host di chuyển thật) rồi `verifyBot`
 *   (host kiểm tra bot chạy lại được trên node đích). Cả hai đều phải
 *   ok mới tính move xong và làm move tiếp theo.
 * - Move lỗi (move hoặc verify fail) → DỪNG, rollback các move đã
 *   áp dụng theo thứ tự NGƯỢC (đưa bot về node cũ qua `moveBot`),
 *   trả placement cuối cùng. Rollback lỗi cũng được ghi lại trong
 *   `rolledBackMoves`? Không — move rollback thất bại được ghi vào
 *   `failedMove.note` kèm danh sách move chưa rollback được? Để đơn
 *   giản và trung thực: `rolledBackMoves` chỉ chứa move rollback
 *   thành công; move rollback thất bại được thêm vào cuối note của
 *   failedMove để host xử lý tay.
 */
export async function executeFleetV23RebalancePlan(
  plan: FleetV23RebalancePlan,
  placement: ReadonlyMap<string, string> | Record<string, string>,
  callbacks: {
    /** Di chuyển bot thật (host thực thi). */
    moveBot: (move: FleetV23RebalanceMove) => Promise<void>;
    /** Xác minh bot chạy lại được trên node đích. */
    verifyBot: (move: FleetV23RebalanceMove) => Promise<boolean>;
  },
): Promise<FleetV23RebalanceExecution> {
  const current: Record<string, string> =
    placement instanceof Map ? Object.fromEntries(placement) : { ...placement };
  const appliedMoves: FleetV23RebalanceMove[] = [];
  const rolledBackMoves: FleetV23RebalanceMove[] = [];
  let failedMove: FleetV23RebalanceExecution['failedMove'] = null;

  for (const move of plan.moves) {
    try {
      await callbacks.moveBot(move);
      const verified = await callbacks.verifyBot(move);
      if (!verified) throw new Error(`bot "${move.botId}" không chạy lại được trên node "${move.toNodeId}" (verify fail).`);
      current[move.botId] = move.toNodeId;
      appliedMoves.push(move);
    } catch (err) {
      failedMove = { move, note: (err as Error).message };
      break;
    }
  }

  if (failedMove !== null) {
    // Rollback ngược thứ tự: move áp dụng sau cùng về trước.
    const rollbackFailures: string[] = [];
    for (const move of [...appliedMoves].reverse()) {
      const back: FleetV23RebalanceMove = {
        botId: move.botId,
        fromNodeId: move.toNodeId,
        toNodeId: move.fromNodeId,
        cpuRelief: move.cpuRelief,
        reason: `Rollback: đưa bot "${move.botId}" về node "${move.fromNodeId}" sau khi move "${move.botId}" lỗi.`,
      };
      try {
        await callbacks.moveBot(back);
        const verified = await callbacks.verifyBot(back);
        if (!verified) throw new Error(`bot "${move.botId}" không chạy lại được trên node cũ "${move.fromNodeId}" sau rollback.`);
        current[move.botId] = move.fromNodeId;
        rolledBackMoves.push(move);
      } catch (err) {
        rollbackFailures.push(`bot "${move.botId}": ${(err as Error).message}`);
      }
    }
    if (rollbackFailures.length > 0) {
      failedMove = {
        ...failedMove,
        note: `${failedMove.note} ROLLBACK CHƯA XONG (${rollbackFailures.length} bot): ${rollbackFailures.join(' | ')} — cần xử lý tay.`,
      };
    }
  }

  return {
    planId: plan.id,
    appliedMoves,
    failedMove,
    rolledBackMoves,
    success: failedMove === null,
    placementAfter: current,
  };
}

/** Lịch sử rebalance (append-only, giới hạn để không phình). */
export class FleetV23RebalanceHistory {
  private readonly executions: (FleetV23RebalanceExecution & { seq: number })[] = [];
  private counter = 0;

  constructor(private readonly maxEntries: number = 200) {}

  /** Ghi một lần thực thi (tự sinh id theo thứ tự). */
  record(execution: FleetV23RebalanceExecution): FleetV23RebalanceExecution & { seq: number } {
    this.counter += 1;
    const rec = { ...execution, seq: this.counter };
    this.executions.push(rec);
    while (this.executions.length > this.maxEntries) this.executions.shift();
    return rec;
  }

  /** Mọi lần thực thi (cũ → mới). */
  list(): (FleetV23RebalanceExecution & { seq: number })[] {
    return [...this.executions];
  }

  /** Lần thực thi thành công gần nhất. */
  lastSuccess(): (FleetV23RebalanceExecution & { seq: number }) | undefined {
    return [...this.executions].reverse().find((e) => e.success);
  }

  /** Số lần thực thi lỗi. */
  get failureCount(): number {
    return this.executions.filter((e) => !e.success).length;
  }

  get size(): number {
    return this.executions.length;
  }
}

/** Validate node load từ dữ liệu ngoài (lỗi → danh sách). */
export function validateFleetV23NodeLoad(input: unknown): string[] {
  const errors: string[] = [];
  if (typeof input !== 'object' || input === null) return ['node load phải là object.'];
  const l = input as Record<string, unknown>;
  if (typeof l.nodeId !== 'string' || l.nodeId.trim().length === 0) errors.push('load.nodeId phải là chuỗi không rỗng.');
  for (const field of ['cpuUsedFraction', 'ramUsedFraction'] as const) {
    if (typeof l[field] !== 'number' || (l[field] as number) < 0 || (l[field] as number) > 1) {
      errors.push(`load.${field} phải là số 0..1.`);
    }
  }
  if (!Array.isArray(l.bots)) errors.push('load.bots phải là mảng.');
  return errors;
}
