/**
 * Fleet v15 — health scoring, capacity planning (dự báo hết tài
 * nguyên), safe drain, rebalancing bot giữa các node (v1.18, Đội T6).
 *
 * Tầng trên của fleet v14 (`fleetV14/fleetV14.ts` — đăng ký node,
 * health check 4 mức từ sample, phân bổ task theo tải, drain +
 * migration plan, capacity report). V14 trả lời "node này khỏe
 * không, task mới nên chạy ở đâu, rút node ra sao"; v15 trả lời
 * 4 câu vận hành tiếp theo:
 *
 * - HEALTH SCORING: từ sample + lịch sử health của node → điểm
 *   0..100 (trọng số: heartbeat 20, CPU 20, RAM 20, disk 15, VRAM
 *   10, lỗi task 15) + hạng `excellent/good/fair/poor/critical`
 *   + điểm từng yếu tố (để UI vẽ rõ "điểm thấp vì disk") + xu
 *   hướng (improving/stable/declining từ 5 điểm gần nhất).
 * - CAPACITY PLANNING: từ capacity report v14 + tốc độ tăng
 *   trưởng mỗi ngày (do caller đo thật, vd tăng RAM 200 MB/ngày)
 *   → dự báo số ngày tới khi từng tài nguyên (CPU/RAM/VRAM/disk/
 *   task slot) đầy, ngày đầy dự kiến, mức `ok/watch/urgent`
 *   (urgent < 14 ngày, watch < 45 ngày). Tăng trưởng <= 0 → không
 *   bao giờ đầy (Infinity). Disk ước tính từ sample disk-free gần
 *   nhất; không có sample → disk là `unknown`.
 * - SAFE DRAIN: drain v14 chỉ lập kế hoạch di chuyển; v15 kiểm
 *   tra thêm "di chuyển xong node đích có còn đủ headroom không"
 *   (mặc định giữ ít nhất 15% tài nguyên trống sau khi nhận task)
 *   — không đủ headroom thì drain bị chặn kèm lý do từng task,
 *   snapshot KHÔNG đổi (an toàn: không rút node khi chưa chắc
 *   task có chỗ đi).
 * - REBALANCING: gợi ý di chuyển bot từ node quá tải (load >
 *   maxLoad, mặc định 0.7) sang node ít tải nhất mà vẫn đủ tài
 *   nguyên + khớp label + sau khi nhận load vẫn <= maxLoad; mô
 *   phỏng tải trong bộ nhớ nên nhiều task cùng chuyển không làm
 *   node đích quá tải. `applyFleetV15Rebalance` áp dụng từng bước
 *   bằng migrate v14 (bước nào lỗi thì dừng và báo rõ bước đó).
 *
 * Module này KHÔNG spawn process, KHÔNG chạm mạng, KHÔNG chạy hay
 * chuyển task thật: nó quyết định "node này mấy điểm, bao lâu thì
 * hết chỗ, có rút được không, bot nào nên chuyển đi đâu" — việc
 * chạy/chuyển thật do caller làm.
 */

import type {
  FleetV14HealthSample,
  FleetV14Node,
  FleetV14Snapshot,
  FleetV14Task,
} from '../fleetV14/fleetV14';
import {
  buildFleetV14CapacityReport,
  drainFleetV14Node,
  fleetV14NodeFreeResources,
  fleetV14NodeLoad,
  migrateFleetV14Task,
  planFleetV14Drain,
  scoreFleetV14NodeForTask,
} from '../fleetV14/fleetV14';

/** Headroom tối thiểu mặc định sau khi nhận task di chuyển (15% trống). */
export const FLEET_V15_DEFAULT_HEADROOM_FRACTION = 0.15;
/** Load tối đa mặc định để coi node là "cân bằng" khi rebalance. */
export const FLEET_V15_DEFAULT_MAX_LOAD = 0.7;
/** Cải thiện load tối thiểu để một bước rebalance được chấp nhận (5%). */
export const FLEET_V15_DEFAULT_MIN_IMPROVEMENT = 0.05;
/** Số điểm health gần nhất dùng tính xu hướng. */
export const FLEET_V15_TREND_WINDOW = 5;
/** Ngưỡng ngày cho mức urgent / watch trong dự báo capacity. */
export const FLEET_V15_FORECAST_URGENT_DAYS = 14;
export const FLEET_V15_FORECAST_WATCH_DAYS = 45;

// ---------------------------------------------------------------------------
// Health scoring
// ---------------------------------------------------------------------------

/** Hạng sức khỏe từ điểm 0..100. */
export type FleetV15HealthGrade = 'excellent' | 'good' | 'fair' | 'poor' | 'critical';

export function fleetV15HealthGrade(score: number): FleetV15HealthGrade {
  if (score >= 90) return 'excellent';
  if (score >= 75) return 'good';
  if (score >= 55) return 'fair';
  if (score >= 35) return 'poor';
  return 'critical';
}

/** Xu hướng sức khỏe từ chuỗi điểm gần nhất. */
export type FleetV15HealthTrend = 'improving' | 'stable' | 'declining';

/** Điểm từng yếu tố sức khỏe (0..100 mỗi yếu tố). */
export interface FleetV15HealthFactors {
  heartbeat: number;
  cpu: number;
  ram: number;
  vram: number;
  disk: number;
  errors: number;
}

/** Kết quả health scoring của một node. */
export interface FleetV15HealthScore {
  nodeId: string;
  /** Điểm tổng 0..100 (làm tròn 1 chữ số thập phân). */
  score: number;
  grade: FleetV15HealthGrade;
  factors: FleetV15HealthFactors;
  trend: FleetV15HealthTrend;
  /** Điểm 5 lần gần nhất (mới nhất ở cuối) — để UI vẽ sparkline. */
  recentScores: number[];
  reasons: string[];
  at: number;
}

function fractionToScore(fraction: number): number {
  // Dùng <= 25% → 100 điểm (gần như rỗi là hoàn toàn khỏe); 25%→75%
  // giảm tuyến tính 100→50; 75%→100% giảm 50→0.
  if (fraction <= 0.25) return 100;
  if (fraction <= 0.75) return Math.max(0, 100 - ((fraction - 0.25) / 0.5) * 50);
  return Math.max(0, 50 - ((fraction - 0.75) / 0.25) * 50);
}

function heartbeatScore(sample: FleetV14HealthSample, now: number): number {
  const age = sample.heartbeatAt > 0 ? sample.at - sample.heartbeatAt : Number.MAX_SAFE_INTEGER;
  if (age === Number.MAX_SAFE_INTEGER) return 0;
  if (age <= 60 * 1000) return 100;
  if (age <= 5 * 60 * 1000) return 70;
  return 0;
}

function trendOf(scores: readonly number[]): FleetV15HealthTrend {
  if (scores.length < 2) return 'stable';
  const first = scores[0];
  const last = scores[scores.length - 1];
  if (last - first >= 5) return 'improving';
  if (first - last >= 5) return 'declining';
  return 'stable';
}

/**
 * Chấm điểm sức khỏe node từ một sample. Trọng số: heartbeat 20,
 * CPU 20, RAM 20, disk 15, VRAM 10, lỗi task 15. Node không có GPU
 * thì trọng số VRAM dồn sang RAM.
 */
export function scoreFleetV15NodeHealth(
  node: FleetV14Node,
  sample: FleetV14HealthSample,
  recentScores: readonly number[] = [],
  now = sample.at,
): FleetV15HealthScore {
  const factors: FleetV15HealthFactors = {
    heartbeat: heartbeatScore(sample, now),
    cpu: fractionToScore(sample.cpuFraction),
    ram: fractionToScore(sample.ramFraction),
    vram: node.capacity.vramTotalMb > 0 ? fractionToScore(sample.vramFraction) : 100,
    disk: sample.diskFreeMb >= 10 * 1024
      ? 100
      : sample.diskFreeMb >= 5 * 1024
        ? 50
        : 0,
    errors: sample.recentTaskErrors <= 0 ? 100 : sample.recentTaskErrors >= 5 ? 0 : 100 - sample.recentTaskErrors * 20,
  };
  const hasGpu = node.capacity.vramTotalMb > 0;
  const vramWeight = hasGpu ? 0.1 : 0;
  const ramWeight = hasGpu ? 0.2 : 0.3;
  const raw =
    factors.heartbeat * 0.2 +
    factors.cpu * 0.2 +
    factors.ram * ramWeight +
    factors.vram * vramWeight +
    factors.disk * 0.15 +
    factors.errors * 0.15;
  const score = Math.round(Math.max(0, Math.min(100, raw)) * 10) / 10;
  const reasons: string[] = [];
  if (factors.heartbeat < 100) reasons.push(`heartbeat score ${factors.heartbeat} (stale heartbeat)`);
  if (sample.cpuFraction >= 0.75) reasons.push(`CPU ${(sample.cpuFraction * 100).toFixed(0)}% used`);
  if (sample.ramFraction >= 0.75) reasons.push(`RAM ${(sample.ramFraction * 100).toFixed(0)}% used`);
  if (hasGpu && sample.vramFraction >= 0.75) reasons.push(`VRAM ${(sample.vramFraction * 100).toFixed(0)}% used`);
  if (sample.diskFreeMb < 10 * 1024) reasons.push(`disk free only ${sample.diskFreeMb} MB`);
  if (sample.recentTaskErrors > 0) reasons.push(`${sample.recentTaskErrors} task errors in last 5 minutes`);
  if (reasons.length === 0) reasons.push('all signals healthy');
  const windowed = [...recentScores.slice(-(FLEET_V15_TREND_WINDOW - 1)), score];
  return {
    nodeId: node.nodeId,
    score,
    grade: fleetV15HealthGrade(score),
    factors,
    trend: trendOf(windowed),
    recentScores: windowed,
    reasons,
    at: sample.at,
  };
}

/** Chấm điểm toàn bộ node trong snapshot từ sample mới nhất mỗi node. */
export function scoreFleetV15FleetHealth(
  snapshot: FleetV14Snapshot,
  samples: Record<string, FleetV14HealthSample>,
  previousScores: Record<string, number[]> = {},
): FleetV15HealthScore[] {
  const out: FleetV15HealthScore[] = [];
  for (const node of snapshot.nodes) {
    if (node.status === 'removed') continue;
    const sample = samples[node.nodeId];
    if (!sample) continue;
    out.push(scoreFleetV15NodeHealth(node, sample, previousScores[node.nodeId] ?? []));
  }
  out.sort((a, b) => a.score - b.score);
  return out;
}

// ---------------------------------------------------------------------------
// Capacity planning (dự báo hết tài nguyên)
// ---------------------------------------------------------------------------

/** Tốc độ tăng trưởng tài nguyên mỗi ngày (do caller đo thật). */
export interface FleetV15DailyGrowth {
  cpuCoresPerDay: number;
  ramMbPerDay: number;
  vramMbPerDay: number;
  diskMbPerDay: number;
  tasksPerDay: number;
}

/** Mức cảnh báo của một tài nguyên trong dự báo. */
export type FleetV15ForecastStatus = 'ok' | 'watch' | 'urgent' | 'unknown';

/** Dự báo cho một tài nguyên. */
export interface FleetV15ResourceForecast {
  resource: 'cpu' | 'ram' | 'vram' | 'disk' | 'tasks';
  used: number;
  total: number;
  usedFraction: number;
  dailyGrowth: number;
  /** Số ngày tới khi đầy (Infinity = không bao giờ đầy; null = không đo được). */
  daysUntilFull: number | null;
  /** Epoch ms ngày đầy dự kiến (0 = không đầy / không đo được). */
  projectedFullAt: number;
  status: FleetV15ForecastStatus;
}

/** Toàn bộ dự báo capacity của fleet. */
export interface FleetV15CapacityForecast {
  at: number;
  resources: FleetV15ResourceForecast[];
  /** Tài nguyên hết sớm nhất (null = không tài nguyên nào đo được). */
  tightestResource: string;
  /** Số ngày tới khi tài nguyên đầu tiên đầy (Infinity = không đầy). */
  daysUntilFirstFull: number | null;
  summary: string;
}

function forecastOne(
  resource: FleetV15ResourceForecast['resource'],
  used: number,
  total: number,
  dailyGrowth: number,
  now: number,
): FleetV15ResourceForecast {
  const usedFraction = total > 0 ? used / total : 0;
  if (total <= 0) {
    return { resource, used, total, usedFraction, dailyGrowth, daysUntilFull: null, projectedFullAt: 0, status: 'unknown' };
  }
  const free = Math.max(0, total - used);
  if (dailyGrowth <= 0) {
    return { resource, used, total, usedFraction, dailyGrowth, daysUntilFull: Number.POSITIVE_INFINITY, projectedFullAt: 0, status: 'ok' };
  }
  const daysUntilFull = free / dailyGrowth;
  const status: FleetV15ForecastStatus =
    daysUntilFull < FLEET_V15_FORECAST_URGENT_DAYS
      ? 'urgent'
      : daysUntilFull < FLEET_V15_FORECAST_WATCH_DAYS
        ? 'watch'
        : 'ok';
  return {
    resource,
    used,
    total,
    usedFraction,
    dailyGrowth,
    daysUntilFull: Math.round(daysUntilFull * 10) / 10,
    projectedFullAt: now + Math.round(daysUntilFull * 24 * 60 * 60 * 1000),
    status,
  };
}

/**
 * Dự báo capacity: khi nào từng tài nguyên đầy nếu tăng trưởng giữ
 * nguyên tốc độ hiện tại. Disk dùng = capacity − disk-free gần nhất
 * (từ healthHistory); node không có sample thì bỏ khỏi ước tính disk.
 */
export function forecastFleetV15Capacity(
  snapshot: FleetV14Snapshot,
  growth: FleetV15DailyGrowth,
  now = Date.now(),
): FleetV15CapacityForecast {
  const report = buildFleetV14CapacityReport(snapshot);
  let diskUsed = 0;
  let diskTotal = 0;
  let diskKnown = false;
  for (const node of snapshot.nodes) {
    if (node.status === 'removed') continue;
    const history = snapshot.healthHistory[node.nodeId] ?? [];
    const latest = history[history.length - 1];
    if (!latest) continue;
    diskKnown = true;
    diskTotal += node.capacity.diskTotalMb;
    diskUsed += Math.max(0, node.capacity.diskTotalMb - latest.diskFreeMb);
  }
  const resources: FleetV15ResourceForecast[] = [
    forecastOne('cpu', report.usedCpuCores, report.totalCpuCores, growth.cpuCoresPerDay, now),
    forecastOne('ram', report.usedRamMb, report.totalRamMb, growth.ramMbPerDay, now),
    forecastOne('vram', report.usedVramMb, report.totalVramMb, growth.vramMbPerDay, now),
    diskKnown
      ? forecastOne('disk', diskUsed, diskTotal, growth.diskMbPerDay, now)
      : { resource: 'disk', used: 0, total: 0, usedFraction: 0, dailyGrowth: growth.diskMbPerDay, daysUntilFull: null, projectedFullAt: 0, status: 'unknown' as const },
    forecastOne('tasks', report.usedTaskSlots, report.totalTaskSlots, growth.tasksPerDay, now),
  ];
  const known = resources.filter((r) => r.daysUntilFull !== null && Number.isFinite(r.daysUntilFull));
  let tightestResource = '';
  let daysUntilFirstFull: number | null = null;
  if (known.length > 0) {
    const tightest = known.reduce((a, b) => (a.daysUntilFull as number) <= (b.daysUntilFull as number) ? a : b);
    tightestResource = tightest.resource;
    daysUntilFirstFull = tightest.daysUntilFull;
  } else if (resources.some((r) => r.daysUntilFull === Number.POSITIVE_INFINITY)) {
    daysUntilFirstFull = Number.POSITIVE_INFINITY;
  }
  const urgent = resources.filter((r) => r.status === 'urgent').map((r) => r.resource);
  const watch = resources.filter((r) => r.status === 'watch').map((r) => r.resource);
  const summary =
    daysUntilFirstFull === null
      ? 'Capacity forecast: not enough data (no measurable resource).'
      : daysUntilFirstFull === Number.POSITIVE_INFINITY
        ? 'Capacity forecast: no resource is growing — fleet will not fill at current growth.'
        : `Capacity forecast: ${tightestResource} fills first in ~${daysUntilFirstFull} day(s)` +
          (urgent.length > 0 ? `; urgent: ${urgent.join(', ')}` : '') +
          (watch.length > 0 ? `; watch: ${watch.join(', ')}` : '');
  return { at: now, resources, tightestResource, daysUntilFirstFull, summary };
}

// ---------------------------------------------------------------------------
// Safe drain (drain v14 + kiểm tra headroom node đích)
// ---------------------------------------------------------------------------

/** Kết quả kiểm tra an toàn của một bước di chuyển khi drain. */
export interface FleetV15SafeDrainCheck {
  taskId: string;
  toNodeId: string;
  /** True khi node đích còn đủ headroom sau khi nhận task. */
  safe: boolean;
  /** Load node đích sau khi nhận task (0..1). */
  destLoadAfter: number;
  reason: string;
}

export interface FleetV15SafeDrainResult {
  ok: boolean;
  snapshot: FleetV14Snapshot;
  /** Kế hoạch di chuyển v14 (task → node đích). */
  plan: ReturnType<typeof planFleetV14Drain> | null;
  checks: FleetV15SafeDrainCheck[];
  /** Lý do chặn ('' khi ok). */
  reason: string;
}

/**
 * Drain an toàn: lập kế hoạch v14 rồi kiểm tra từng node đích còn
 * đủ headroom (load sau khi nhận <= 1 - headroom) không. Không đủ
 * → chặn drain, snapshot KHÔNG đổi, trả lý do từng task để operator
 * thêm node / giảm tải trước rồi drain lại.
 */
export function safeDrainFleetV15Node(
  snapshot: FleetV14Snapshot,
  nodeId: string,
  reason: string,
  actorUserId: string,
  headroomFraction: number = FLEET_V15_DEFAULT_HEADROOM_FRACTION,
  now = Date.now(),
): FleetV15SafeDrainResult {
  const node = snapshot.nodes.find((n) => n.nodeId === nodeId);
  if (!node || node.status === 'removed') {
    return { ok: false, snapshot, plan: null, checks: [], reason: `node not found: ${nodeId}` };
  }
  const plan = planFleetV14Drain(snapshot, nodeId);
  if (plan.blocked.length > 0) {
    const reasons = plan.blocked.map((b) => `${b.taskId}: ${b.blockedReason}`).join('; ');
    return { ok: false, snapshot, plan, checks: [], reason: `cannot drain: ${plan.blocked.length} task(s) have nowhere to go: ${reasons}` };
  }
  // Mô phỏng tải node đích sau khi nhận task (cộng dồn nhiều task cùng đích).
  const simulatedLoad = new Map<string, { load: number; node: FleetV14Node }>();
  const checks: FleetV15SafeDrainCheck[] = [];
  for (const step of plan.migrations) {
    const dest = snapshot.nodes.find((n) => n.nodeId === step.toNodeId);
    const allocated = snapshot.tasks.find((t) => t.task.taskId === step.taskId);
    if (!dest || !allocated) {
      checks.push({ taskId: step.taskId, toNodeId: step.toNodeId, safe: false, destLoadAfter: 1, reason: 'destination or task disappeared' });
      continue;
    }
    const sim = simulatedLoad.get(dest.nodeId) ?? { load: fleetV14NodeLoad(dest), node: dest };
    const task = allocated.task;
    const extraCpu = dest.capacity.cpuCores > 0 ? task.cpuCores / dest.capacity.cpuCores : 0;
    const extraRam = dest.capacity.ramTotalMb > 0 ? task.ramMb / dest.capacity.ramTotalMb : 0;
    const extraVram = dest.capacity.vramTotalMb > 0 ? task.vramMb / dest.capacity.vramTotalMb : 0;
    const extraSlots = dest.capacity.maxTasks > 0 ? 1 / dest.capacity.maxTasks : 0;
    const loadAfter = Math.min(1, Math.max(sim.load, sim.load + Math.max(extraCpu, extraRam, extraVram, extraSlots)));
    simulatedLoad.set(dest.nodeId, { load: loadAfter, node: dest });
    const safe = loadAfter <= 1 - headroomFraction;
    checks.push({
      taskId: step.taskId,
      toNodeId: step.toNodeId,
      safe,
      destLoadAfter: Math.round(loadAfter * 1000) / 1000,
      reason: safe ? '' : `destination ${dest.nodeId} would reach ${Math.round(loadAfter * 100)}% load (headroom needs <= ${Math.round((1 - headroomFraction) * 100)}%)`,
    });
  }
  const unsafe = checks.filter((c) => !c.safe);
  if (unsafe.length > 0) {
    const reasons = unsafe.map((c) => `${c.taskId} -> ${c.toNodeId}: ${c.reason}`).join('; ');
    return { ok: false, snapshot, plan, checks, reason: `drain unsafe: ${reasons}` };
  }
  const drained = drainFleetV14Node(snapshot, nodeId, reason, actorUserId, now);
  if (!drained.ok) {
    return { ok: false, snapshot, plan, checks, reason: drained.reason };
  }
  return { ok: true, snapshot: drained.snapshot, plan: drained.plan, checks, reason: '' };
}

// ---------------------------------------------------------------------------
// Rebalancing bot giữa các node
// ---------------------------------------------------------------------------

/** Một bước di chuyển trong kế hoạch rebalance. */
export interface FleetV15RebalanceMove {
  taskId: string;
  kind: string;
  fromNodeId: string;
  toNodeId: string;
  fromLoadBefore: number;
  fromLoadAfter: number;
  toLoadBefore: number;
  toLoadAfter: number;
  reason: string;
}

/** Kế hoạch rebalance: các bước di chuyển + tải dự kiến sau rebalance. */
export interface FleetV15RebalancePlan {
  moves: FleetV15RebalanceMove[];
  /** Load dự kiến mỗi node sau khi áp dụng toàn bộ bước. */
  expectedLoads: Record<string, number>;
  /** Node vẫn quá tải sau rebalance (cần thêm node / giảm tải). */
  stillOverloaded: string[];
  summary: string;
}

/**
 * Lập kế hoạch rebalance: với mỗi node quá tải (load > maxLoad),
 * thử chuyển từng task (lớn trước) sang node ít tải nhất mà đủ tài
 * nguyên + khớp label + sau khi nhận load vẫn <= maxLoad và cải
 * thiện chênh lệch tải ít nhất minImprovement. Tải được mô phỏng
 * trong bộ nhớ nên nhiều task không dồn hết vào một node đích.
 */
export function planFleetV15Rebalance(
  snapshot: FleetV14Snapshot,
  maxLoad: number = FLEET_V15_DEFAULT_MAX_LOAD,
  minImprovement: number = FLEET_V15_DEFAULT_MIN_IMPROVEMENT,
): FleetV15RebalancePlan {
  // Mô phỏng tài nguyên đã dùng mỗi node (để tính load sau từng bước).
  const sim = new Map<string, FleetV14Node>();
  for (const n of snapshot.nodes) sim.set(n.nodeId, { ...n, runningTaskIds: [...n.runningTaskIds] });
  const moves: FleetV15RebalanceMove[] = [];
  const overloaded = snapshot.nodes
    .filter((n) => n.status === 'active' && fleetV14NodeLoad(n) > maxLoad)
    .sort((a, b) => fleetV14NodeLoad(b) - fleetV14NodeLoad(a));
  for (const source of overloaded) {
    const sourceTasks = snapshot.tasks
      .filter((t) => t.nodeId === source.nodeId && t.status === 'running')
      .sort((a, b) => (b.task.ramMb + b.task.cpuCores * 1024) - (a.task.ramMb + a.task.cpuCores * 1024));
    for (const allocated of sourceTasks) {
      const simSource = sim.get(source.nodeId);
      if (!simSource || fleetV14NodeLoad(simSource) <= maxLoad) break;
      const task: FleetV14Task = allocated.task;
      // Ứng viên đích: node active khác, đủ điều kiện, load sau khi nhận <= maxLoad.
      const candidates = [...sim.values()]
        .filter((n) => n.nodeId !== source.nodeId && n.status === 'active')
        .map((n) => ({ node: n, score: scoreFleetV14NodeForTask(n, task) }))
        .filter((c) => c.score.ineligibleReason === '')
        .map((c) => {
          const loadBefore = fleetV14NodeLoad(c.node);
          const extra = Math.max(
            c.node.capacity.cpuCores > 0 ? task.cpuCores / c.node.capacity.cpuCores : 0,
            c.node.capacity.ramTotalMb > 0 ? task.ramMb / c.node.capacity.ramTotalMb : 0,
            c.node.capacity.vramTotalMb > 0 ? task.vramMb / c.node.capacity.vramTotalMb : 0,
            c.node.capacity.maxTasks > 0 ? 1 / c.node.capacity.maxTasks : 0,
          );
          return { node: c.node, loadBefore, loadAfter: Math.min(1, loadBefore + extra) };
        })
        .filter((c) => c.loadAfter <= maxLoad)
        .sort((a, b) => a.loadAfter - b.loadAfter);
      const best = candidates[0];
      if (!best) continue;
      const fromLoadBefore = fleetV14NodeLoad(simSource);
      // Cải thiện = chênh lệch tải nguồn-đích giảm bao nhiêu sau bước này.
      const fromLoadAfter = Math.max(
        0,
        fromLoadBefore - Math.max(
          simSource.capacity.cpuCores > 0 ? task.cpuCores / simSource.capacity.cpuCores : 0,
          simSource.capacity.ramTotalMb > 0 ? task.ramMb / simSource.capacity.ramTotalMb : 0,
          simSource.capacity.vramTotalMb > 0 ? task.vramMb / simSource.capacity.vramTotalMb : 0,
          simSource.capacity.maxTasks > 0 ? 1 / simSource.capacity.maxTasks : 0,
        ),
      );
      if (fromLoadBefore - best.loadAfter < minImprovement && fromLoadBefore - fromLoadAfter < minImprovement) {
        continue;
      }
      moves.push({
        taskId: task.taskId,
        kind: task.kind,
        fromNodeId: source.nodeId,
        toNodeId: best.node.nodeId,
        fromLoadBefore: Math.round(fromLoadBefore * 1000) / 1000,
        fromLoadAfter: Math.round(fromLoadAfter * 1000) / 1000,
        toLoadBefore: Math.round(best.loadBefore * 1000) / 1000,
        toLoadAfter: Math.round(best.loadAfter * 1000) / 1000,
        reason: `move ${task.taskId} from overloaded ${source.nodeId} (${Math.round(fromLoadBefore * 100)}%) to ${best.node.nodeId} (${Math.round(best.loadAfter * 100)}% after)`,
      });
      // Cập nhật mô phỏng: trừ ở nguồn, cộng ở đích.
      const simDest = sim.get(best.node.nodeId);
      if (simDest) {
        sim.set(best.node.nodeId, {
          ...simDest,
          usedRamMb: simDest.usedRamMb + task.ramMb,
          usedVramMb: simDest.usedVramMb + task.vramMb,
          usedCpuCores: simDest.usedCpuCores + task.cpuCores,
          runningTaskIds: [...simDest.runningTaskIds, task.taskId],
        });
      }
      sim.set(source.nodeId, {
        ...simSource,
        usedRamMb: Math.max(0, simSource.usedRamMb - task.ramMb),
        usedVramMb: Math.max(0, simSource.usedVramMb - task.vramMb),
        usedCpuCores: Math.max(0, simSource.usedCpuCores - task.cpuCores),
        runningTaskIds: simSource.runningTaskIds.filter((id) => id !== task.taskId),
      });
    }
  }
  const expectedLoads: Record<string, number> = {};
  for (const [nodeId, n] of sim) expectedLoads[nodeId] = Math.round(fleetV14NodeLoad(n) * 1000) / 1000;
  const stillOverloaded = [...sim.values()]
    .filter((n) => n.status === 'active' && fleetV14NodeLoad(n) > maxLoad)
    .map((n) => n.nodeId);
  return {
    moves,
    expectedLoads,
    stillOverloaded,
    summary: `Rebalance: ${moves.length} move(s) planned, ${stillOverloaded.length} node(s) still overloaded after rebalance${stillOverloaded.length > 0 ? ` (${stillOverloaded.join(', ')})` : ''}.`,
  };
}

export interface FleetV15ApplyRebalanceResult {
  ok: boolean;
  snapshot: FleetV14Snapshot;
  appliedMoves: FleetV15RebalanceMove[];
  failedMove: FleetV15RebalanceMove | null;
  reason: string;
}

/**
 * Áp dụng kế hoạch rebalance từng bước bằng migrate v14. Bước nào
 * lỗi thì dừng ngay (các bước trước đó đã áp dụng được giữ lại) và
 * báo rõ bước lỗi để operator xử lý.
 */
export function applyFleetV15Rebalance(
  snapshot: FleetV14Snapshot,
  plan: FleetV15RebalancePlan,
  actorUserId: string,
  now = Date.now(),
): FleetV15ApplyRebalanceResult {
  let current = snapshot;
  const appliedMoves: FleetV15RebalanceMove[] = [];
  for (const move of plan.moves) {
    const res = migrateFleetV14Task(current, move.taskId, move.toNodeId, actorUserId, now);
    if (!res.ok) {
      return { ok: false, snapshot: current, appliedMoves, failedMove: move, reason: res.reason };
    }
    current = res.snapshot;
    appliedMoves.push(move);
  }
  return { ok: true, snapshot: current, appliedMoves, failedMove: null, reason: '' };
}

/** Tóm tắt nhanh fleet v15 cho panel: node, health, forecast, rebalance. */
export interface FleetV15Overview {
  nodeCount: number;
  activeNodeCount: number;
  overloadedNodeIds: string[];
  avgHealthScore: number;
  worstNodeId: string;
  worstScore: number;
  forecastSummary: string;
  rebalanceSummary: string;
  summary: string;
}

export function buildFleetV15Overview(
  snapshot: FleetV14Snapshot,
  healthScores: readonly FleetV15HealthScore[],
  forecast: FleetV15CapacityForecast,
  rebalance: FleetV15RebalancePlan,
): FleetV15Overview {
  const report = buildFleetV14CapacityReport(snapshot);
  const avg = healthScores.length > 0
    ? Math.round((healthScores.reduce((s, h) => s + h.score, 0) / healthScores.length) * 10) / 10
    : 0;
  const worst = healthScores.length > 0 ? [...healthScores].sort((a, b) => a.score - b.score)[0] : null;
  return {
    nodeCount: report.nodeCount,
    activeNodeCount: report.activeNodeCount,
    overloadedNodeIds: report.overloadedNodeIds,
    avgHealthScore: avg,
    worstNodeId: worst ? worst.nodeId : '',
    worstScore: worst ? worst.score : 0,
    forecastSummary: forecast.summary,
    rebalanceSummary: rebalance.summary,
    summary: `Fleet v15: ${report.nodeCount} nodes (${report.activeNodeCount} active, ${report.overloadedNodeIds.length} overloaded), avg health ${avg}/100${worst ? `, worst ${worst.nodeId} ${worst.score}/100 (${worst.grade})` : ''}; ${forecast.summary} ${rebalance.summary}`,
  };
}

/** Re-export để caller v15 không phải import 2 module. */
export { buildFleetV14CapacityReport, fleetV14NodeFreeResources, fleetV14NodeLoad };
