/**
 * Multi-node placement cho fleet v21 (v1.34, Đội T6).
 *
 * Đặt NHIỀU run song song lên nhiều node trong một lần gọi, rồi giữ
 * lịch sử placement để audit. Khác với scheduler (đặt 1 run, chọn node
 * tốt nhất), placement lo chuyện PHÂN BỔ TẬP THỂ:
 *
 * - Run nặng đặt trước (demand lớn nhất trước) để bin-packing không bị
 *   kẹt: run nhẹ lấp đầy khoảng trống sau, run nặng không bị "hết chỗ
 *   vì toàn mảnh vụn".
 * - Anti-affinity: run cùng bot tránh chung node khi cấu hình yêu cầu
 *   (`antiAffinityBot: true`) — một node chết không giết cả chùm run
 *   của cùng bot. Khi không còn node nào khác thì run bị hoãn (không
 *   phá luật lén) và ghi rõ lý do.
 * - Affinity: run có cùng `affinityKey` ưu tiên chung node (vd các run
 *   chia sẻ cache/model) — ưu tiên mềm: chỉ cộng điểm, không ép buộc.
 * - Mỗi lần đặt xong, trừ tài nguyên node trong bản sao làm việc để run
 *   sau trong cùng đợt thấy đúng dung lượng còn lại (không đặt trùng).
 * - Rebalance: khi node mới vào (có chỗ trống tốt) hoặc node chết
 *   (run của nó phải dời đi), tính danh sách move tối thiểu: chỉ dời
 *   run khi (a) node chết/draining, hoặc (b) move giảm độ lệch tải
 *   rõ rệt (trên ngưỡng), không xáo trộn fleet vì lệch nhỏ.
 * - Lịch sử placement: append-only, mỗi bản ghi có run, node, lý do,
 *   điểm, thời gian — để audit "run này vì sao ở node này, ai dời nó".
 *
 * Module thuần (không I/O): host chịu trách nhiệm lưu history xuống
 * disk nếu cần bền vững; `FleetV21PlacementLog` giữ trong bộ nhớ.
 */

import type { SandboxTierV21 } from './tiers';
import type { FleetV21Node, FleetV21RunDemand } from './nodes';
import { nodeFreeCpuV21, nodeFreeDiskV21, nodeFreeRamV21 } from './nodes';
import type { FleetV21ScheduleRequest } from './scheduler';
import { evaluateFleetV21Schedule } from './scheduler';

/** Một run cần đặt trong đợt placement (mở rộng schedule request). */
export interface FleetV21PlacementRequest extends FleetV21ScheduleRequest {
  /**
   * true = các run cùng bot này không được chung node với nhau.
   * Mặc định false (bot nhỏ chạy chung node cho tiết kiệm).
   */
  antiAffinityBot?: boolean;
  /**
   * Khóa affinity mềm: run cùng khóa ưu tiên chung node (chia sẻ
   * cache/model). Không bắt buộc — chỉ cộng điểm khi chọn node.
   */
  affinityKey?: string;
  /** Mức ưu tiên đặt trước (số lớn đặt trước; mặc định 0). */
  priority?: number;
}

/** Kết quả đặt 1 run trong đợt. */
export interface FleetV21PlacementResult {
  runId: string;
  botId: string;
  /** Node được đặt (undefined khi không đặt được). */
  nodeId?: string;
  placed: boolean;
  /** Điểm scheduler của node được chọn (undefined khi không đặt được). */
  score?: number;
  /** Lý do không đặt được (khi placed = false). */
  reason?: string;
  /** Run cùng bot đã ở node nào rồi (để giải thích anti-affinity). */
  antiAffinityBlockedNodeIds: string[];
}

/** Kết quả cả đợt placement. */
export interface FleetV21PlacementPlan {
  /** Đặt được bao nhiêu / tổng bao nhiêu. */
  placedCount: number;
  totalCount: number;
  results: FleetV21PlacementResult[];
  /** Run không đặt được (để UI/host retry sau). */
  unplacedRunIds: string[];
  /** Tóm tắt 1 dòng. */
  summary: string;
}

/** Một bản ghi lịch sử placement (append-only, để audit). */
export interface FleetV21PlacementRecord {
  id: string;
  runId: string;
  botId: string;
  nodeId: string;
  /** 'place' | 'move' (rebalance) | 'evacuate' (node chết) | 'remove'. */
  kind: 'place' | 'move' | 'evacuate' | 'remove';
  /** Vì sao đặt/dời run này lên node này. */
  reason: string;
  /** Điểm scheduler lúc đặt (nếu có). */
  score?: number;
  /** Tier yêu cầu của run lúc đặt. */
  minTier: SandboxTierV21;
  /** Thời gian (epoch ms). */
  at: number;
}

/** Lịch sử placement trong bộ nhớ (append-only, có giới hạn để không phình). */
export class FleetV21PlacementLog {
  private readonly records: FleetV21PlacementRecord[] = [];
  private counter = 0;

  constructor(private readonly maxRecords: number = 1000) {}

  /** Ghi một bản ghi (tự sinh id, tự cắt cũ khi quá giới hạn). */
  record(entry: Omit<FleetV21PlacementRecord, 'id' | 'at'> & { at?: number }): FleetV21PlacementRecord {
    this.counter += 1;
    const rec: FleetV21PlacementRecord = {
      ...entry,
      id: `plc-${this.counter}`,
      at: entry.at ?? Date.now(),
    };
    this.records.push(rec);
    while (this.records.length > this.maxRecords) this.records.shift();
    return rec;
  }

  /** Mọi bản ghi (cũ → mới). */
  list(): FleetV21PlacementRecord[] {
    return [...this.records];
  }

  /** Bản ghi của 1 run (cũ → mới). */
  forRun(runId: string): FleetV21PlacementRecord[] {
    return this.records.filter((r) => r.runId === runId);
  }

  /** Bản ghi của 1 node (cũ → mới). */
  forNode(nodeId: string): FleetV21PlacementRecord[] {
    return this.records.filter((r) => r.nodeId === nodeId);
  }

  /** Bản ghi mới nhất trước (tối đa `limit`). */
  recent(limit = 50): FleetV21PlacementRecord[] {
    return this.records.slice(-limit).reverse();
  }

  get size(): number {
    return this.records.length;
  }
}

// ---------------------------------------------------------------------------
// Đặt nhiều run (bin-packing có xét tier + affinity/anti-affinity)
// ---------------------------------------------------------------------------

/** Độ "nặng" của run để sắp thứ tự đặt: RAM nặng nhất, rồi CPU, rồi disk. */
export function placementWeightV21(demand: FleetV21RunDemand): number {
  // Chuẩn hoá về "đơn vị tài nguyên": 1 core ~ 4GB RAM ~ 50GB disk.
  return demand.cpuCores * 4 + demand.ramBytes / (4 * 1024 ** 3) + demand.diskBytes / (50 * 1024 ** 3);
}

/**
 * Đặt nhiều run lên nhiều node.
 *
 * Thuật toán: sắp run nặng + ưu tiên cao trước; với mỗi run, chấm điểm
 * node trên ẢNH CHỤP tài nguyên còn lại (đã trừ các run đặt trước trong
 * đợt); áp anti-affinity (loại node đã có run cùng bot) và affinity
 * (cộng điểm node đã có run cùng affinityKey); chọn node điểm cao nhất.
 * Run không đặt được thì ghi lý do, không chặn các run sau.
 *
 * `nodes` không bị mutate: hàm làm việc trên bản sao (cpuUsed/ramUsed/
 * diskUsed/runCount tăng dần theo từng placement trong đợt).
 */
export function placeFleetV21Runs(
  nodes: readonly FleetV21Node[],
  requests: readonly FleetV21PlacementRequest[],
  log?: FleetV21PlacementLog,
  now: number = Date.now(),
): FleetV21PlacementPlan {
  // Bản sao làm việc: trừ tài nguyên dần khi đặt.
  const working = new Map<string, FleetV21Node>(
    nodes.map((n) => [n.id, { ...n, labels: [...n.labels] }]),
  );
  // Bot nào đã ở node nào (trong đợt này + node đã có run từ trước — host
  // truyền runCount, nhưng anti-affinity trong đợt chỉ xét run trong đợt).
  const botNodesInBatch = new Map<string, Set<string>>();
  // Affinity key nào đã ở node nào (trong đợt).
  const affinityNodes = new Map<string, Set<string>>();

  // Nặng + ưu tiên cao đặt trước.
  const ordered = [...requests].sort((a, b) => {
    const pa = a.priority ?? 0;
    const pb = b.priority ?? 0;
    if (pb !== pa) return pb - pa;
    return placementWeightV21(b.demand) - placementWeightV21(a.demand);
  });

  const results: FleetV21PlacementResult[] = [];

  for (const req of ordered) {
    const antiNodes = req.antiAffinityBot ? botNodesInBatch.get(req.botId) ?? new Set<string>() : new Set<string>();
    const affinityBonusNodes = req.affinityKey ? affinityNodes.get(req.affinityKey) ?? new Set<string>() : new Set<string>();

    const candidates = [...working.values()];
    const evaluation = evaluateFleetV21Schedule(candidates, req);
    // Loại node vi phạm anti-affinity; cộng điểm affinity cho node đã có run cùng khóa.
    const eligible = evaluation.ranked
      .filter((s) => !antiNodes.has(s.nodeId))
      .map((s) => ({
        ...s,
        score: s.score + (affinityBonusNodes.has(s.nodeId) ? 10 : 0),
      }))
      .sort((a, b) => b.score - a.score);

    const best = eligible[0];
    if (!best) {
      const reason =
        antiNodes.size > 0 && evaluation.ranked.length > 0 && evaluation.ranked.every((s) => antiNodes.has(s.nodeId))
          ? `Anti-affinity: mọi node đủ điều kiện (${[...antiNodes].join(', ')}) đã có run của bot "${req.botId}" — run này chờ node khác.`
          : evaluation.ranked.length === 0
            ? 'Không node nào đủ điều kiện (xem lý do từng node trong evaluation).'
            : 'Mọi node đủ điều kiện đều vi phạm anti-affinity của bot.';
      results.push({
        runId: req.runId,
        botId: req.botId,
        placed: false,
        reason,
        antiAffinityBlockedNodeIds: [...antiNodes],
      });
      continue;
    }

    // Trừ tài nguyên node trong bản sao làm việc.
    const node = working.get(best.nodeId);
    if (node) {
      node.cpuUsed += req.demand.cpuCores;
      node.ramUsed += req.demand.ramBytes;
      node.diskUsed += req.demand.diskBytes;
      node.runCount += 1;
      working.set(node.id, node);
    }
    if (req.antiAffinityBot) {
      const set = botNodesInBatch.get(req.botId) ?? new Set<string>();
      set.add(best.nodeId);
      botNodesInBatch.set(req.botId, set);
    }
    if (req.affinityKey) {
      const set = affinityNodes.get(req.affinityKey) ?? new Set<string>();
      set.add(best.nodeId);
      affinityNodes.set(req.affinityKey, set);
    }
    log?.record({
      runId: req.runId,
      botId: req.botId,
      nodeId: best.nodeId,
      kind: 'place',
      reason: `Scheduler chọn node ${best.nodeId} (điểm ${best.score}) cho tier tối thiểu ${req.minTier}.`,
      score: best.score,
      minTier: req.minTier,
      at: now,
    });
    results.push({
      runId: req.runId,
      botId: req.botId,
      nodeId: best.nodeId,
      placed: true,
      score: best.score,
      antiAffinityBlockedNodeIds: [...antiNodes],
    });
  }

  // Trả kết quả theo thứ tự request gốc (dễ đối chiếu), không theo thứ tự đặt.
  const byRunId = new Map(results.map((r) => [r.runId, r]));
  const orderedResults = requests.map((r) => byRunId.get(r.runId) as FleetV21PlacementResult);
  const placedCount = orderedResults.filter((r) => r.placed).length;
  return {
    placedCount,
    totalCount: requests.length,
    results: orderedResults,
    unplacedRunIds: orderedResults.filter((r) => !r.placed).map((r) => r.runId),
    summary:
      requests.length === 0
        ? 'Không có run nào cần đặt.'
        : `Đã đặt ${placedCount}/${requests.length} run lên fleet.` +
          (placedCount < requests.length ? ` ${requests.length - placedCount} run chưa đặt được.` : ''),
  };
}

// ---------------------------------------------------------------------------
// Rebalance: node mới vào / node chết
// ---------------------------------------------------------------------------

/** Một run đang chạy (đầu vào cho rebalance — host lấy từ placement hiện tại). */
export interface FleetV21RunningRun {
  runId: string;
  botId: string;
  nodeId: string;
  minTier: SandboxTierV21;
  demand: FleetV21RunDemand;
  startedAt: number;
  /** true = run này được phép dời (một số run sticky, không dời). */
  movable: boolean;
}

/** Một lần dời run trong kế hoạch rebalance. */
export interface FleetV21RebalanceMove {
  runId: string;
  botId: string;
  fromNodeId: string;
  toNodeId: string;
  /** 'evacuate' (node chết/draining) | 'balance' (giảm lệch tải). */
  reason: 'evacuate' | 'balance';
  detail: string;
}

/** Kết quả rebalance: move cần làm + run không dời được + lý do. */
export interface FleetV21RebalancePlan {
  moves: FleetV21RebalanceMove[];
  /** Run ở node chết/draining nhưng không dời được (kèm lý do). */
  stranded: { runId: string; reason: string }[];
  summary: string;
}

/** Ngưỡng lệch tải: chỉ rebalance vì cân bằng khi (max-min load) vượt ngần này. */
export const REBALANCE_IMBALANCE_THRESHOLD = 0.35;

/**
 * Tính kế hoạch rebalance.
 *
 * 1. Evacuate trước: mọi run movable trên node dead/draining phải dời
 *    sang node online đủ tier + đủ tài nguyên (dùng scheduler, run nặng
 *    trước). Run không movable hoặc không có node đích → stranded.
 * 2. Balance sau: nếu sau evacuate mà lệch tải (max-min node load) vẫn
 *    trên ngưỡng, dời run movable từ node tải cao nhất sang node tải
 *    thấp nhất khi move đó giảm lệch ít nhất 0.1 — tối đa 5 move/đợt
 *    để không xáo trộn fleet.
 * Không mutate node/run đầu vào.
 */
export function planFleetV21Rebalance(
  nodes: readonly FleetV21Node[],
  runs: readonly FleetV21RunningRun[],
  log?: FleetV21PlacementLog,
  now: number = Date.now(),
): FleetV21RebalancePlan {
  const moves: FleetV21RebalanceMove[] = [];
  const stranded: { runId: string; reason: string }[] = [];
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const working = new Map<string, FleetV21Node>(
    nodes.map((n) => [n.id, { ...n, labels: [...n.labels] }]),
  );
  // Trừ tài nguyên các run đang chạy khỏi bản sao làm việc? Không — node
  // đã phản ánh run đang chạy qua cpuUsed/...; khi evacuate, trả lại tài
  // nguyên cho node nguồn và trừ ở node đích.

  const badNodeIds = new Set(
    nodes.filter((n) => n.status === 'dead' || n.status === 'draining').map((n) => n.id),
  );

  // 1. Evacuate: run trên node xấu, nặng trước.
  const toEvacuate = runs
    .filter((r) => badNodeIds.has(r.nodeId))
    .sort((a, b) => placementWeightV21(b.demand) - placementWeightV21(a.demand));
  for (const run of toEvacuate) {
    const sourceNode = nodeById.get(run.nodeId);
    if (!run.movable) {
      stranded.push({ runId: run.runId, reason: `Run không movable (sticky) — ở lại node ${run.nodeId} (${sourceNode?.status ?? '?'}) chờ can thiệp tay.` });
      continue;
    }
    const evaluation = evaluateFleetV21Schedule([...working.values()], {
      runId: run.runId,
      botId: run.botId,
      minTier: run.minTier,
      demand: run.demand,
    });
    const best = evaluation.ranked[0];
    if (!best) {
      stranded.push({
        runId: run.runId,
        reason: `Không node online nào đủ tier ${run.minTier} + tài nguyên để nhận run từ node ${run.nodeId} (${sourceNode?.status ?? '?'}).`,
      });
      continue;
    }
    const target = working.get(best.nodeId);
    const source = working.get(run.nodeId);
    if (target) {
      target.cpuUsed += run.demand.cpuCores;
      target.ramUsed += run.demand.ramBytes;
      target.diskUsed += run.demand.diskBytes;
      target.runCount += 1;
    }
    if (source) {
      source.cpuUsed = Math.max(0, source.cpuUsed - run.demand.cpuCores);
      source.ramUsed = Math.max(0, source.ramUsed - run.demand.ramBytes);
      source.diskUsed = Math.max(0, source.diskUsed - run.demand.diskBytes);
      source.runCount = Math.max(0, source.runCount - 1);
    }
    moves.push({
      runId: run.runId,
      botId: run.botId,
      fromNodeId: run.nodeId,
      toNodeId: best.nodeId,
      reason: 'evacuate',
      detail: `Node ${run.nodeId} ${sourceNode?.status ?? ''} — dời sang ${best.nodeId} (điểm ${best.score}).`,
    });
    log?.record({
      runId: run.runId,
      botId: run.botId,
      nodeId: best.nodeId,
      kind: 'evacuate',
      reason: `Node ${run.nodeId} ${sourceNode?.status ?? ''} — evacuate sang ${best.nodeId}.`,
      score: best.score,
      minTier: run.minTier,
      at: now,
    });
  }

  // 2. Balance: chỉ khi lệch tải lớn, tối đa 5 move.
  const loadOf = (n: FleetV21Node): number =>
    Math.max(
      n.cpuCores > 0 ? n.cpuUsed / n.cpuCores : 0,
      n.ramBytes > 0 ? n.ramUsed / n.ramBytes : 0,
    );
  let balanceMoves = 0;
  while (balanceMoves < 5) {
    const online = [...working.values()].filter((n) => n.status === 'online');
    if (online.length < 2) break;
    const sorted = [...online].sort((a, b) => loadOf(b) - loadOf(a));
    const hottest = sorted[0];
    const coldest = sorted[sorted.length - 1];
    const imbalance = loadOf(hottest) - loadOf(coldest);
    if (imbalance <= REBALANCE_IMBALANCE_THRESHOLD) break;
    // Run movable nặng nhất trên node nóng nhất mà node lạnh nhất chứa được.
    const candidates = runs
      .filter((r) => r.nodeId === hottest.id && r.movable && !moves.some((m) => m.runId === r.runId))
      .sort((a, b) => placementWeightV21(b.demand) - placementWeightV21(a.demand));
    const movableRun = candidates.find(
      (r) =>
        nodeFreeCpuV21(coldest) >= r.demand.cpuCores &&
        nodeFreeRamV21(coldest) >= r.demand.ramBytes &&
        nodeFreeDiskV21(coldest) >= r.demand.diskBytes &&
        // Tier: node đích phải hỗ trợ tier của run.
        (r.minTier === 'bwrap' ||
          (r.minTier === 'syscall-policy' && coldest.maxTier !== 'bwrap') ||
          (r.minTier === 'microvm' && coldest.maxTier === 'microvm')),
    );
    if (!movableRun) break;
    // Move phải giảm lệch ít nhất 0.1 (tính gần đúng: tải node nóng giảm theo demand).
    const loadDrop = movableRun.demand.cpuCores / Math.max(1, hottest.cpuCores);
    if (loadDrop < 0.05 && movableRun.demand.ramBytes / Math.max(1, hottest.ramBytes) < 0.05) break;
    hottest.cpuUsed = Math.max(0, hottest.cpuUsed - movableRun.demand.cpuCores);
    hottest.ramUsed = Math.max(0, hottest.ramUsed - movableRun.demand.ramBytes);
    hottest.diskUsed = Math.max(0, hottest.diskUsed - movableRun.demand.diskBytes);
    hottest.runCount = Math.max(0, hottest.runCount - 1);
    coldest.cpuUsed += movableRun.demand.cpuCores;
    coldest.ramUsed += movableRun.demand.ramBytes;
    coldest.diskUsed += movableRun.demand.diskBytes;
    coldest.runCount += 1;
    moves.push({
      runId: movableRun.runId,
      botId: movableRun.botId,
      fromNodeId: hottest.id,
      toNodeId: coldest.id,
      reason: 'balance',
      detail: `Cân bằng tải: node ${hottest.id} tải ${Math.round(loadOf(hottest) * 100)}% → node ${coldest.id} tải thấp hơn.`,
    });
    log?.record({
      runId: movableRun.runId,
      botId: movableRun.botId,
      nodeId: coldest.id,
      kind: 'move',
      reason: `Rebalance: dời từ ${hottest.id} sang ${coldest.id} để cân bằng tải.`,
      minTier: movableRun.minTier,
      at: now,
    });
    balanceMoves += 1;
  }

  const evacCount = moves.filter((m) => m.reason === 'evacuate').length;
  const balCount = moves.filter((m) => m.reason === 'balance').length;
  return {
    moves,
    stranded,
    summary:
      moves.length === 0 && stranded.length === 0
        ? 'Fleet đã cân bằng — không cần dời run nào.'
        : `Rebalance: ${evacCount} evacuate, ${balCount} cân bằng tải` +
          (stranded.length > 0 ? `, ${stranded.length} run kẹt lại (stranded).` : '.'),
  };
}
