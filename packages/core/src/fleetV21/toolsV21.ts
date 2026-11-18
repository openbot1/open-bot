/**
 * Tools v21 — định nghĩa tool riêng của platform/fleet v21
 * (v1.34, Đội T6).
 *
 * Theo pattern tools v20 (`fleetV20/toolsV20.ts`): registry riêng của
 * đội T6 (không sửa registry trung tâm của các đội khác): mỗi tool là
 * một định nghĩa thuần (tên, mô tả, params, cần quyền gì, có ghi hay
 * không) để agent loop / UI gọi qua các hàm core ở `fleetV21/` —
 * module này KHÔNG tự đăng ký vào registry trung tâm, KHÔNG chạy tool.
 * Tool chạy thật nằm ở `packages/tools/src/fleetV21Tools.ts`.
 *
 * Quy ước tên (snake_case, theo validateToolDefinition:
 * chi chu/digit/`-`/`_` — ten dotted `schedulerV21.schedule` cu bi
 * ToolRegistry tu choi khi build factory, xem v1.35):
 * `scheduler_v21_*` cho tier-aware scheduling, `placement_v21_*` cho
 * multi-node placement, `automation_v21_*` cho durable automation v2,
 * `fleet_v21_*` cho dashboard tổng hợp.
 * Tool ghi (write: true) luôn cần duyệt trước khi chạy thật.
 */

/** Định nghĩa một tool v21 (thuần, JSON-able). */
export interface FleetV21ToolDef {
  /** Tên tool, vd `scheduler_v21_schedule`. */
  name: string;
  description: string;
  /** true = hành động ghi (cần duyệt + ghi audit). */
  write: boolean;
  /** Quyền team cần có (xem `multiUserV13.ts` TEAM_V13_ACTIONS). */
  requiresAction: string;
  /** Tên param (để UI render form, không validate kiểu ở đây). */
  params: string[];
}

/** Toàn bộ tool v21 (định nghĩa thuần). */
export const FLEET_V21_TOOLS: readonly FleetV21ToolDef[] = [
  // Tier-aware scheduling: chấm điểm node theo tier + tài nguyên.
  {
    name: 'scheduler_v21_schedule',
    description: 'Schedule one bot run onto the best node for its minimum sandbox tier (bwrap/syscall-policy/microvm), CPU/RAM/disk, reliability and latency; refuses with per-node reasons when no node qualifies.',
    write: false,
    requiresAction: 'view-fleet',
    params: ['runId', 'botId', 'minTier', 'cpuCores', 'ramBytes', 'diskBytes'],
  },
  {
    name: 'scheduler_v21_evaluate',
    description: 'Evaluate every node for a run request (ranked scores + per-node rejection reasons) without placing the run.',
    write: false,
    requiresAction: 'view-fleet',
    params: ['runId', 'botId', 'minTier', 'cpuCores', 'ramBytes', 'diskBytes'],
  },
  {
    name: 'scheduler_v21_node_scores',
    description: 'Score one node for a run request (0-100 with free CPU/RAM/disk, reliability, latency and tier-fit breakdown).',
    write: false,
    requiresAction: 'view-fleet',
    params: ['nodeId', 'runId', 'botId', 'minTier'],
  },
  // Multi-node placement: đặt nhiều run, rebalance, lịch sử.
  {
    name: 'placement_v21_place_runs',
    description: 'Place many runs across many nodes at once (heaviest first, tier-aware bin-packing, affinity/anti-affinity); returns placed/unplaced runs with reasons.',
    write: true,
    requiresAction: 'manage-fleet',
    params: ['requests'],
  },
  {
    name: 'placement_v21_rebalance',
    description: 'Plan a rebalance: evacuate runs off dead/draining nodes and balance load (at most 5 balance moves per plan); returns moves plus stranded runs.',
    write: false,
    requiresAction: 'view-fleet',
    params: [],
  },
  {
    name: 'placement_v21_history',
    description: 'Show recent placement history (run, node, reason, score) for audit — newest first.',
    write: false,
    requiresAction: 'view-fleet',
    params: ['runId', 'nodeId', 'limit'],
  },
  {
    name: 'placement_v21_node_capacity',
    description: 'Show free/used CPU/RAM/disk per node and fleet totals (overloaded and dead nodes flagged).',
    write: false,
    requiresAction: 'view-fleet',
    params: [],
  },
  // Durable automation v2: tạo/tạm dừng/bật lại + xem trạng thái/trace.
  {
    name: 'automation_v21_create',
    description: 'Create a durable automation (schedule trigger every N ms, or event trigger by pattern) that survives restarts; retries with backoff and dead-letters after max attempts.',
    write: true,
    requiresAction: 'manage-automations',
    params: ['automation'],
  },
  {
    name: 'automation_v21_list',
    description: 'List durable automations with status, next run, consecutive failures and last error.',
    write: false,
    requiresAction: 'view-automations',
    params: [],
  },
  {
    name: 'automation_v21_pause',
    description: 'Pause a durable automation (scheduled runs stop until resumed).',
    write: true,
    requiresAction: 'manage-automations',
    params: ['automationId'],
  },
  {
    name: 'automation_v21_resume',
    description: 'Resume a paused or dead-lettered automation (dead-letter resumes reset attempts and failures).',
    write: true,
    requiresAction: 'manage-automations',
    params: ['automationId'],
  },
  {
    name: 'automation_v21_remove',
    description: 'Remove a durable automation (its trace history is deleted with it).',
    write: true,
    requiresAction: 'manage-automations',
    params: ['automationId'],
  },
  {
    name: 'automation_v21_traces',
    description: 'Show the run trace of a durable automation (started/succeeded/failed/retry/dead-letter/resumed), newest last.',
    write: false,
    requiresAction: 'view-automations',
    params: ['automationId', 'limit'],
  },
  {
    name: 'automation_v21_run_due',
    description: 'Run all due scheduled automations now (one failure does not block the others).',
    write: true,
    requiresAction: 'run-automations',
    params: [],
  },
  // Fleet dashboard tổng hợp.
  {
    name: 'fleet_v21_dashboard',
    description: 'Show the aggregated fleet dashboard: nodes (tier/load/status), running runs (tier/node/age), automations (schedule/last run/errors) and alerts (overload, lifetime-cap, consecutive failures).',
    write: false,
    requiresAction: 'view-fleet',
    params: [],
  },
  {
    name: 'fleet_v21_nodes',
    description: 'List fleet nodes with tier, load, reliability, latency and run count, sorted by load.',
    write: false,
    requiresAction: 'view-fleet',
    params: [],
  },
  {
    name: 'fleet_v21_runs',
    description: 'List running runs with node, tier, age and lifetime-cap status (orphaned runs flagged).',
    write: false,
    requiresAction: 'view-fleet',
    params: [],
  },
  {
    name: 'fleet_v21_alerts',
    description: 'List fleet alerts only (overloaded nodes, runs over lifetime cap, failing/dead-letter automations, dead nodes with stranded runs), errors first.',
    write: false,
    requiresAction: 'view-fleet',
    params: [],
  },
];

/** Tìm tool v21 theo tên; không có → undefined (không throw). */
export function findFleetV21Tool(name: string): FleetV21ToolDef | undefined {
  return FLEET_V21_TOOLS.find((t) => t.name === name);
}

/** true khi mọi tên tool v21 là duy nhất. */
export function fleetV21ToolNamesUnique(): boolean {
  return new Set(FLEET_V21_TOOLS.map((t) => t.name)).size === FLEET_V21_TOOLS.length;
}

/** Tool ghi của v21 (cần duyệt + audit khi chạy thật). */
export function fleetV21WriteTools(): FleetV21ToolDef[] {
  return FLEET_V21_TOOLS.filter((t) => t.write);
}

/** Tool v21 theo tiền tố nhóm (`scheduler_v21` / `placement_v21` / `automation_v21` / `fleet_v21`). */
export function fleetV21ToolsByGroup(
  group: 'scheduler_v21' | 'placement_v21' | 'automation_v21' | 'fleet_v21',
): FleetV21ToolDef[] {
  return FLEET_V21_TOOLS.filter((t) => t.name.startsWith(`${group}_`));
}
