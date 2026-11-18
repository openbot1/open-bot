/**
 * Tools v23 — định nghĩa tool riêng của fleet v23 (v1.36, Đội T6).
 *
 * Theo pattern tools v22 (`fleetV22/toolsV22.ts`): registry riêng của
 * đội T6 (không sửa registry trung tâm của các đội khác): mỗi tool là
 * một định nghĩa thuần (tên, mô tả, params, cần quyền gì, có ghi hay
 * không) để agent loop / UI gọi qua các hàm core ở `fleetV23/` —
 * module này KHÔNG tự đăng ký vào registry trung tâm, KHÔNG chạy tool.
 * Tool chạy thật nằm ở `packages/tools/src/fleetV23Tools.ts`.
 *
 * Quy ước tên (snake_case, KHÔNG dấu chấm — v21/v22 đã nổ
 * `defaultToolFactory` vì tên dotted, không lặp lại):
 * - `fleet_v23_*` — topology (zone/group) + dashboard tổng hợp.
 * - `schedule_v23_*` — hàng đợi ưu tiên + cron + SLA + preemption + dispatch.
 * - `place_v23_*` — placement scorer v2 + Pareto + capacity forecast + autoscale.
 * - `rebalance_v23_*` — phát hiện lệch tải + kế hoạch + thực thi.
 * Tool ghi (write: true) luôn cần duyệt trước khi chạy thật.
 */

/** Định nghĩa một tool v23 (thuần, JSON-able). */
export interface FleetV23ToolDef {
  /** Tên tool, vd `schedule_v23_enqueue`. */
  name: string;
  description: string;
  /** true = hành động ghi (cần duyệt + ghi audit). */
  write: boolean;
  /** Quyền team cần có (xem `users.ts` v22 FLEET_V22_ACTION_MIN_ROLE). */
  requiresAction: string;
  /** Tên param (để UI render form, không validate kiểu ở đây). */
  params: string[];
}

/** Toàn bộ tool v23 (định nghĩa thuần). */
export const FLEET_V23_TOOLS: readonly FleetV23ToolDef[] = [
  // Topology: zone + bot group.
  {
    name: 'fleet_v23_create_zone',
    description: 'Create a fleet zone (failure domain) inside a region; nodes are assigned to exactly one zone so a zone failure can be modelled.',
    write: true,
    requiresAction: 'manage-fleet',
    params: ['id', 'region', 'name'],
  },
  {
    name: 'fleet_v23_assign_node_zone',
    description: 'Assign a node to a zone (the zone must exist first); a node belongs to exactly one zone.',
    write: true,
    requiresAction: 'manage-fleet',
    params: ['nodeId', 'zoneId'],
  },
  {
    name: 'fleet_v23_create_group',
    description: 'Create a bot group with spread across zones, affinity pairs (must share a node) and anti-affinity pairs (must not share a node), plus a quorum for survival.',
    write: true,
    requiresAction: 'manage-fleet',
    params: ['id', 'botIds', 'spreadMinZones', 'quorum'],
  },
  {
    name: 'fleet_v23_check_topology',
    description: 'Check a bot placement against the fleet topology (unplaced bots, broken affinity/anti-affinity, spread shortfall, unzoned nodes) and list every violation.',
    write: false,
    requiresAction: 'view-fleet',
    params: ['placement'],
  },
  {
    name: 'fleet_v23_zone_failure',
    description: 'Model what happens if a zone dies: which bots and nodes are lost, which groups keep quorum, and which zone failure hurts the most.',
    write: false,
    requiresAction: 'view-fleet',
    params: ['zoneId'],
  },
  {
    name: 'fleet_v23_health',
    description: 'Score fleet health: every node 0-100 (availability, reliability, load, heartbeat freshness), fleet rollup (degraded zones, groups at risk of losing quorum) and health alerts.',
    write: false,
    requiresAction: 'view-fleet',
    params: [],
  },
  // Scheduler v2: priority queue + cron + SLA + preemption.
  {
    name: 'schedule_v23_enqueue',
    description: 'Enqueue a job with a priority class (critical/high/normal/low), an optional SLA deadline, estimated runtime and resource demand; aging boosts long-waiting jobs.',
    write: true,
    requiresAction: 'run-bot',
    params: ['id', 'botId', 'title', 'priority', 'slaDeadlineMs', 'estimatedMs'],
  },
  {
    name: 'schedule_v23_next',
    description: 'Show the next job the scheduler would run (highest effective priority, earliest SLA deadline, then FIFO) without starting it.',
    write: false,
    requiresAction: 'view-own',
    params: [],
  },
  {
    name: 'schedule_v23_start',
    description: 'Start a queued (or preempted) job; only queued/preempted jobs can start.',
    write: true,
    requiresAction: 'run-bot',
    params: ['jobId'],
  },
  {
    name: 'schedule_v23_finish',
    description: 'Finish a job as completed, failed or cancelled.',
    write: true,
    requiresAction: 'run-bot',
    params: ['jobId', 'status'],
  },
  {
    name: 'schedule_v23_cron_next',
    description: 'Compute the next run time of a 5-field cron expression after a given moment (UTC, minute precision).',
    write: false,
    requiresAction: 'view-own',
    params: ['cron', 'fromMs'],
  },
  {
    name: 'schedule_v23_sla',
    description: 'Check SLA breaches: which queued jobs are past their deadline, how long each has waited, and how much time is left for the rest.',
    write: false,
    requiresAction: 'view-own',
    params: [],
  },
  {
    name: 'schedule_v23_preempt',
    description: 'Decide whether a critical job may preempt a running lower-priority job (never preempts critical jobs or jobs that just started) and apply the preemption.',
    write: true,
    requiresAction: 'run-bot',
    params: ['incomingJobId'],
  },
  {
    name: 'schedule_v23_queue',
    description: 'Show the scheduler queue snapshot: jobs per status and priority, SLA breaches, and the longest-waiting job.',
    write: false,
    requiresAction: 'view-own',
    params: [],
  },
  {
    name: 'schedule_v23_dispatch',
    description: 'Run one dispatch round: assign queued jobs (priority order) to nodes with the placement scorer, defer jobs that do not fit with reasons; dry-run by default, apply starts the assigned jobs.',
    write: true,
    requiresAction: 'run-bot',
    params: ['planId', 'dryRun', 'maxJobs'],
  },
  // Placement v2: multi-criteria scoring + Pareto + capacity forecast.
  {
    name: 'place_v23_evaluate',
    description: 'Score every node for a bot with multi-criteria weights (CPU/RAM/disk free, reliability, latency, cost), list ranked nodes with a per-criterion breakdown and the Pareto frontier.',
    write: false,
    requiresAction: 'view-fleet',
    params: ['botId', 'cpuCores', 'ramBytes', 'diskBytes'],
  },
  {
    name: 'place_v23_place',
    description: 'Place a bot on the best-scoring node (hard filters first: offline, capacity, labels, zones, topology) or reject with the reason for every node.',
    write: true,
    requiresAction: 'run-bot',
    params: ['botId', 'cpuCores', 'ramBytes', 'diskBytes'],
  },
  {
    name: 'place_v23_capacity',
    description: 'Forecast fleet capacity: with a growth rate (new bots per month), when does CPU/RAM/disk run out, and which resource is the bottleneck.',
    write: false,
    requiresAction: 'view-fleet',
    params: ['botsPerMonth'],
  },
  {
    name: 'place_v23_autoscale',
    description: 'Recommend scaling the fleet out (add a node) or in (remove a node) from the capacity forecast, queue length and SLA breaches, with a cooldown after the last scale and a monthly cost delta.',
    write: false,
    requiresAction: 'view-fleet',
    params: [],
  },
  // Rebalance v2: detect + plan + execute + rollback.
  {
    name: 'rebalance_v23_measure',
    description: 'Measure fleet load imbalance (coefficient of variation + max-min spread for CPU/RAM) and say whether a rebalance is needed.',
    write: false,
    requiresAction: 'view-fleet',
    params: [],
  },
  {
    name: 'rebalance_v23_plan',
    description: 'Plan a rebalance (dry-run by default): greedy moves from the hottest node to the coldest, respecting capacity, pinned bots and topology; reports imbalance before/after and warnings.',
    write: false,
    requiresAction: 'view-fleet',
    params: ['dryRun'],
  },
  {
    name: 'rebalance_v23_execute',
    description: 'Execute a rebalance plan step by step with verification after every move; on a failed move it stops and rolls back the moves already applied.',
    write: true,
    requiresAction: 'manage-fleet',
    params: ['planId'],
  },
  {
    name: 'rebalance_v23_history',
    description: 'Show rebalance execution history (which plans ran, which moves applied, which failed and rolled back).',
    write: false,
    requiresAction: 'view-fleet',
    params: [],
  },
  // Dashboard tổng hợp v23.
  {
    name: 'fleet_v23_dashboard',
    description: 'Show the aggregated fleet v23 dashboard: topology (zones/groups/spread), scheduler queue (priorities, SLA breaches), placement (best nodes, capacity forecast) and rebalance (imbalance, last execution).',
    write: false,
    requiresAction: 'view-fleet',
    params: [],
  },
];

/** Tìm tool v23 theo tên; không có → undefined (không throw). */
export function findFleetV23Tool(name: string): FleetV23ToolDef | undefined {
  return FLEET_V23_TOOLS.find((t) => t.name === name);
}

/** true khi mọi tên tool v23 là duy nhất và không chứa dấu chấm. */
export function fleetV23ToolNamesValid(): boolean {
  const names = FLEET_V23_TOOLS.map((t) => t.name);
  return (
    new Set(names).size === names.length &&
    names.every((n) => /^[A-Za-z0-9_-]+$/.test(n))
  );
}

/** Tool ghi của v23 (cần duyệt + audit khi chạy thật). */
export function fleetV23WriteTools(): FleetV23ToolDef[] {
  return FLEET_V23_TOOLS.filter((t) => t.write);
}

/** Tool v23 theo tiền tố nhóm (`fleet_v23` / `schedule_v23` / `place_v23` / `rebalance_v23`). */
export function fleetV23ToolsByGroup(
  group: 'fleet_v23' | 'schedule_v23' | 'place_v23' | 'rebalance_v23',
): FleetV23ToolDef[] {
  return FLEET_V23_TOOLS.filter((t) => t.name.startsWith(`${group}_`));
}
