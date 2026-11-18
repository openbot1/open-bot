/**
 * Fleet v23 tools (v1.36, Đội T6) — registered in ALL_TOOLS (see tools.ts).
 *
 * Tool chạy thật cho fleet v23 (định nghĩa thuần nằm ở
 * `packages/core/src/fleetV23/toolsV23.ts` — 23 tool, 4 nhóm; file này
 * là bản chạy được, nối vào core qua `@open-bot/core`):
 *
 * - `fleet_v23_create_zone` / `fleet_v23_assign_node_zone` /
 *   `fleet_v23_create_group` / `fleet_v23_check_topology` /
 *   `fleet_v23_zone_failure` — topology (zone/group/spread/quorum).
 * - `schedule_v23_enqueue` / `schedule_v23_next` / `schedule_v23_start` /
 *   `schedule_v23_finish` / `schedule_v23_cron_next` / `schedule_v23_sla` /
 *   `schedule_v23_preempt` / `schedule_v23_queue` / `schedule_v23_dispatch` —
 *   scheduler v2 + dispatch.
 * - `place_v23_evaluate` / `place_v23_place` / `place_v23_capacity` /
 *   `place_v23_autoscale` — placement scorer v2 + Pareto + capacity
 *   forecast + autoscale.
 * - `rebalance_v23_measure` / `rebalance_v23_plan` /
 *   `rebalance_v23_execute` / `rebalance_v23_history` — rebalance v2.
 * - `fleet_v23_dashboard` — dashboard tổng hợp.
 *
 * Như fleet v22, đây là placeholder trong ALL_TOOLS cho tới khi host
 * bind: `createFleetV23Tools(getState)` với state của host (topology +
 * queue + node snapshots + placement + growth + plans + history +
 * dispatch plans + autoscale state).
 * Unbound, tool trả về thông báo "not configured" rõ ràng thay vì đoán
 * state. Tool ghi cần duyệt (`needsApproval: true`); tool KHÔNG tự
 * chạy model hay spawn VM — rebalance execute mặc định di chuyển bằng
 * cách cập nhật placement trong state (mô phỏng), host thay bằng mover
 * thật qua `state.mover` khi có provisioner.
 */

import type { Tool } from '@open-bot/core';
import {
  DEFAULT_FLEET_V23_AUTOSCALE_POLICY,
  DEFAULT_FLEET_V23_REBALANCE_THRESHOLDS,
  DEFAULT_FLEET_V23_SCORE_WEIGHTS,
  FleetV23HealthHistory,
  FleetV23RebalanceHistory,
  FleetV23SchedulerQueue,
  applyFleetV23DispatchPlan,
  applyFleetV23Preemption,
  breachedSlaJobsV23,
  buildFleetV23AutoscalePanel,
  buildFleetV23Dashboard,
  buildFleetV23DispatchPanel,
  buildFleetV23HealthPanel,
  buildFleetV23PlacementPanel,
  buildFleetV23RebalancePanel,
  buildFleetV23SchedulerPanel,
  buildFleetV23TopologyPanel,
  checkFleetV23Sla,
  checkFleetV23TopologyPlacement,
  createFleetV23BotGroup,
  createFleetV23Job,
  createFleetV23Topology,
  createFleetV23Zone,
  cronMatchesAtV23,
  decideFleetV23Preemption,
  evaluateFleetV23Placement,
  executeFleetV23RebalancePlan,
  fleetV23HealthAlerts,
  forecastFleetV23Capacity,
  measureFleetV23Imbalance,
  nextFleetV23CronRun,
  placeFleetV23Bot,
  planFleetV23Dispatch,
  planFleetV23Rebalance,
  recommendFleetV23Autoscale,
  rollupFleetV23Health,
  scoreFleetV23NodeHealth,
  snapshotFleetV23Queue,
  topologyAddGroup,
  topologyAddZone,
  topologyAssignNode,
  topologyNodesInZone,
  validateFleetV23Cron,
  validateFleetV23Job,
  worstZoneFailureV23,
  zoneFailureImpactV23,
} from '@open-bot/core';
import type {
  FleetV23DispatchPlan,
  FleetV23GrowthRate,
  FleetV23HealthPanel,
  FleetV23NodeHealthInput,
  FleetV23NodeLoad,
  FleetV23NodeSnapshot,
  FleetV23PlacementEvaluation,
  FleetV23Priority,
  FleetV23RebalanceMove,
  FleetV23RebalancePlan,
  FleetV23ScaleRecommendation,
  FleetV23ScoreWeights,
  FleetV23Topology,
} from '@open-bot/core';

/** Mover thật (host cung cấp khi có provisioner): di chuyển + xác minh bot. */
export interface FleetV23Mover {
  moveBot: (move: FleetV23RebalanceMove) => Promise<void>;
  verifyBot: (move: FleetV23RebalanceMove) => Promise<boolean>;
}

/** State fleet v23 host cung cấp cho tools (đọc lười mỗi lần tool chạy). */
export interface FleetV23ToolState {
  /** Topology hiện tại (tool gán lại khi thêm zone/group — host giữ object state). */
  topology: FleetV23Topology;
  /** Hàng đợi scheduler v2 (host giữ 1 instance). */
  queue: FleetV23SchedulerQueue;
  /** Snapshot node để chấm placement/rebalance (host cập nhật định kỳ). */
  nodes: FleetV23NodeSnapshot[];
  /** Placement hiện tại: botId → nodeId. */
  placement: Record<string, string>;
  /** Tốc độ tăng trưởng để dự báo capacity. */
  growth: FleetV23GrowthRate;
  /** Trọng số chấm placement. */
  weights: FleetV23ScoreWeights;
  /** Kế hoạch rebalance đã lập (theo id — để execute sau khi duyệt). */
  plans: Map<string, FleetV23RebalancePlan>;
  /** Lịch sử thực thi rebalance. */
  history: FleetV23RebalanceHistory;
  /** Kết quả chấm placement gần nhất (để dashboard đọc). */
  lastPlacementEvaluation: FleetV23PlacementEvaluation | null;
  /** Kế hoạch dispatch đã lập (theo id — để apply sau khi duyệt). */
  dispatchPlans: Map<string, FleetV23DispatchPlan>;
  /** Kế hoạch dispatch gần nhất (để dashboard đọc). */
  lastDispatchPlan: FleetV23DispatchPlan | null;
  /** Đề xuất autoscale gần nhất (để dashboard đọc). */
  lastAutoscale: FleetV23ScaleRecommendation | null;
  /** Lúc scale gần nhất (để tính cooldown autoscale; null = chưa scale). */
  lastScaleAtMs: number | null;
  /** Input sức khoẻ node (host đo thật, cập nhật định kỳ). */
  healthInputs: FleetV23NodeHealthInput[];
  /** Lịch sử sức khoẻ fleet. */
  healthHistory: FleetV23HealthHistory;
  /** Panel sức khoẻ gần nhất (để dashboard đọc). */
  lastHealthPanel: FleetV23HealthPanel | null;
  /** Mover thật (undefined = mô phỏng: cập nhật placement trong state). */
  mover?: FleetV23Mover;
}

export const FLEET_V23_TOOL_NAMES = [
  'fleet_v23_create_zone',
  'fleet_v23_assign_node_zone',
  'fleet_v23_create_group',
  'fleet_v23_check_topology',
  'fleet_v23_zone_failure',
  'fleet_v23_health',
  'schedule_v23_enqueue',
  'schedule_v23_next',
  'schedule_v23_start',
  'schedule_v23_finish',
  'schedule_v23_cron_next',
  'schedule_v23_sla',
  'schedule_v23_preempt',
  'schedule_v23_queue',
  'schedule_v23_dispatch',
  'place_v23_evaluate',
  'place_v23_place',
  'place_v23_capacity',
  'place_v23_autoscale',
  'rebalance_v23_measure',
  'rebalance_v23_plan',
  'rebalance_v23_execute',
  'rebalance_v23_history',
  'fleet_v23_dashboard',
] as const;

const NOT_WIRED =
  'Fleet v23 is not configured: the host has not wired fleet state (topology, scheduler queue, node snapshots, placement, growth, plans, history, dispatch plans, autoscale state, health inputs) into the v23 tools.';

function toolDef(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
): Tool['definition'] {
  return {
    name,
    description,
    parameters: { type: 'object', properties, required, additionalProperties: false },
  };
}

function errorResult(message: string): string {
  return `Error: ${message}`;
}

function jsonResult(value: unknown): string {
  return JSON.stringify(value, null, 2).slice(0, 20000);
}

function getStringArg(args: Record<string, unknown>, name: string, required = true): string {
  const value = args[name];
  if (value === undefined || value === null) {
    if (required) throw new Error(`Missing required argument: "${name}"`);
    return '';
  }
  if (typeof value !== 'string') {
    throw new Error(`Argument "${name}" must be a string, got ${typeof value}`);
  }
  return value;
}

function getNumberArg(args: Record<string, unknown>, name: string, fallback: number): number {
  const value = args[name];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`Argument "${name}" must be a number >= 0.`);
  }
  return value;
}

function getBoolArg(args: Record<string, unknown>, name: string, fallback: boolean): boolean {
  const value = args[name];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') {
    throw new Error(`Argument "${name}" must be a boolean.`);
  }
  return value;
}

function getStringArrayArg(args: Record<string, unknown>, name: string): string[] {
  const value = args[name];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new Error(`Argument "${name}" must be an array of strings.`);
  }
  return value as string[];
}

/** Build load snapshot các node từ node snapshot + placement (để đo lệch tải). */
export function buildFleetV23NodeLoads(
  nodes: readonly FleetV23NodeSnapshot[],
  placement: Record<string, string>,
  botDemand: (botId: string) => { cpuCores: number; ramBytes: number; diskBytes: number } | null,
): FleetV23NodeLoad[] {
  return nodes.map((n) => {
    const botsOnNode = Object.entries(placement)
      .filter(([, nodeId]) => nodeId === n.id)
      .map(([botId]) => {
        const d = botDemand(botId) ?? { cpuCores: 1, ramBytes: 512 * 1024 ** 2, diskBytes: 1024 ** 3 };
        return { botId, ...d, pinned: false };
      });
    return {
      nodeId: n.id,
      cpuUsedFraction: n.cpuCores > 0 ? Math.min(1, Math.max(0, 1 - n.cpuFree / n.cpuCores)) : 0,
      ramUsedFraction: n.ramBytes > 0 ? Math.min(1, Math.max(0, 1 - n.ramFree / n.ramBytes)) : 0,
      bots: botsOnNode,
    };
  });
}

export function createFleetV23Tools(
  getState?: () => FleetV23ToolState | null | undefined,
): Tool[] {
  const resolveState = (): FleetV23ToolState | null => {
    try {
      return getState?.() ?? null;
    } catch {
      return null;
    }
  };

  // --- Topology -----------------------------------------------------------
  const createZoneTool: Tool = {
    definition: toolDef(
      'fleet_v23_create_zone',
      'Create a fleet zone (failure domain) inside a region; nodes are assigned to exactly one zone so a zone failure can be modelled.',
      {
        id: { type: 'string', description: 'Unique id for the new zone.' },
        region: { type: 'string', description: 'Region containing the zone.' },
        name: { type: 'string', description: 'Display name (defaults to id).' },
      },
      ['id', 'region'],
    ),
    needsApproval: true,
    execute: async (args) => {
      const state = resolveState();
      if (!state) return errorResult(NOT_WIRED);
      try {
        const zone = createFleetV23Zone({
          id: getStringArg(args, 'id'),
          region: getStringArg(args, 'region'),
          name: getStringArg(args, 'name', false) || undefined,
        });
        state.topology = topologyAddZone(state.topology, zone);
        return jsonResult({ created: zone.id, region: zone.region, zones: state.topology.zones.length });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const assignNodeZoneTool: Tool = {
    definition: toolDef(
      'fleet_v23_assign_node_zone',
      'Assign a node to a zone (the zone must exist first); a node belongs to exactly one zone.',
      {
        nodeId: { type: 'string', description: 'Id of the node.' },
        zoneId: { type: 'string', description: 'Id of the zone.' },
      },
      ['nodeId', 'zoneId'],
    ),
    needsApproval: true,
    execute: async (args) => {
      const state = resolveState();
      if (!state) return errorResult(NOT_WIRED);
      try {
        state.topology = topologyAssignNode(state.topology, getStringArg(args, 'nodeId'), getStringArg(args, 'zoneId'));
        return jsonResult({ nodeId: getStringArg(args, 'nodeId'), zoneId: getStringArg(args, 'zoneId') });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const createGroupTool: Tool = {
    definition: toolDef(
      'fleet_v23_create_group',
      'Create a bot group with spread across zones, affinity pairs (must share a node) and anti-affinity pairs (must not share a node), plus a quorum for survival.',
      {
        id: { type: 'string', description: 'Unique id for the group.' },
        botIds: { type: 'array', items: { type: 'string' }, description: 'Bots in the group.' },
        spreadMinZones: { type: 'number', description: 'Minimum zones the group must spread across.' },
        quorum: { type: 'number', description: 'Minimum surviving bots for the group to stay alive.' },
      },
      ['id', 'botIds'],
    ),
    needsApproval: true,
    execute: async (args) => {
      const state = resolveState();
      if (!state) return errorResult(NOT_WIRED);
      try {
        const group = createFleetV23BotGroup({
          id: getStringArg(args, 'id'),
          botIds: getStringArrayArg(args, 'botIds'),
          spreadMinZones: args.spreadMinZones === undefined ? undefined : getNumberArg(args, 'spreadMinZones', 1),
          quorum: args.quorum === undefined ? undefined : getNumberArg(args, 'quorum', 1),
        });
        state.topology = topologyAddGroup(state.topology, group);
        return jsonResult({ created: group.id, bots: group.botIds.length, spreadMinZones: group.spreadMinZones, quorum: group.quorum });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const checkTopologyTool: Tool = {
    definition: toolDef(
      'fleet_v23_check_topology',
      'Check a bot placement against the fleet topology (unplaced bots, broken affinity/anti-affinity, spread shortfall, unzoned nodes) and list every violation.',
      {},
      [],
    ),
    needsApproval: false,
    execute: async () => {
      const state = resolveState();
      if (!state) return errorResult(NOT_WIRED);
      try {
        const violations = checkFleetV23TopologyPlacement(state.topology, state.placement);
        return jsonResult({ violations, ok: violations.length === 0 });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const zoneFailureTool: Tool = {
    definition: toolDef(
      'fleet_v23_zone_failure',
      'Model what happens if a zone dies: which bots and nodes are lost, which groups keep quorum, and which zone failure hurts the most.',
      {
        zoneId: { type: 'string', description: 'Zone to model (empty = worst zone failure).' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args) => {
      const state = resolveState();
      if (!state) return errorResult(NOT_WIRED);
      try {
        const zoneId = getStringArg(args, 'zoneId', false);
        if (zoneId) {
          return jsonResult({
            impact: zoneFailureImpactV23(state.topology, state.placement, zoneId),
            worst: worstZoneFailureV23(state.topology, state.placement),
          });
        }
        return jsonResult({ worst: worstZoneFailureV23(state.topology, state.placement) });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const healthTool: Tool = {
    definition: toolDef(
      'fleet_v23_health',
      'Score fleet health: every node 0-100 (availability, reliability, load, heartbeat freshness), fleet rollup (degraded zones, groups at risk of losing quorum) and health alerts.',
      {},
      [],
    ),
    needsApproval: false,
    execute: async () => {
      const state = resolveState();
      if (!state) return errorResult(NOT_WIRED);
      try {
        const nodeHealth = state.healthInputs.map((input) => scoreFleetV23NodeHealth(input));
        const fleetHealth = rollupFleetV23Health({ nodeHealth, topology: state.topology, placement: state.placement });
        const alerts = fleetV23HealthAlerts({ nodeHealth, fleetHealth });
        const trend = state.healthHistory.trend();
        state.healthHistory.record(fleetHealth);
        const panel = buildFleetV23HealthPanel({ nodeHealth, fleetHealth, alerts, trend });
        state.lastHealthPanel = panel;
        return jsonResult(panel);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  // --- Scheduler v2 -------------------------------------------------------
  const enqueueTool: Tool = {
    definition: toolDef(
      'schedule_v23_enqueue',
      'Enqueue a job with a priority class (critical/high/normal/low), an optional SLA deadline, estimated runtime and resource demand; aging boosts long-waiting jobs.',
      {
        id: { type: 'string', description: 'Unique id for the job.' },
        botId: { type: 'string', description: 'Bot that runs the job.' },
        title: { type: 'string', description: 'Short title.' },
        priority: { type: 'string', enum: ['critical', 'high', 'normal', 'low'], description: 'Priority class.' },
        slaDeadlineMs: { type: 'number', description: 'SLA deadline (epoch ms).' },
        estimatedMs: { type: 'number', description: 'Estimated runtime (ms).' },
        cpuCores: { type: 'number', description: 'CPU cores the job needs.' },
        ramBytes: { type: 'number', description: 'RAM bytes the job needs.' },
        diskBytes: { type: 'number', description: 'Disk bytes the job needs.' },
        cron: { type: 'string', description: 'Optional 5-field cron for a recurring job.' },
      },
      ['id', 'botId', 'title'],
    ),
    needsApproval: true,
    execute: async (args) => {
      const state = resolveState();
      if (!state) return errorResult(NOT_WIRED);
      try {
        const job = createFleetV23Job({
          id: getStringArg(args, 'id'),
          botId: getStringArg(args, 'botId'),
          title: getStringArg(args, 'title'),
          priority: (args.priority as FleetV23Priority | undefined) ?? 'normal',
          slaDeadlineMs: args.slaDeadlineMs === undefined ? undefined : getNumberArg(args, 'slaDeadlineMs', 0),
          estimatedMs: getNumberArg(args, 'estimatedMs', 60_000),
          demand: {
            cpuCores: getNumberArg(args, 'cpuCores', 1),
            ramBytes: getNumberArg(args, 'ramBytes', 512 * 1024 ** 2),
            diskBytes: getNumberArg(args, 'diskBytes', 1024 ** 3),
          },
          cron: args.cron === undefined ? undefined : getStringArg(args, 'cron'),
        });
        const errors = validateFleetV23Job(job);
        if (errors.length > 0) return errorResult(errors.join(' '));
        state.queue.enqueue(job);
        return jsonResult({ enqueued: job.id, priority: job.priority, queued: state.queue.queuedCount });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const nextTool: Tool = {
    definition: toolDef(
      'schedule_v23_next',
      'Show the next job the scheduler would run (highest effective priority, earliest SLA deadline, then FIFO) without starting it.',
      {},
      [],
    ),
    needsApproval: false,
    execute: async () => {
      const state = resolveState();
      if (!state) return errorResult(NOT_WIRED);
      try {
        const next = state.queue.peekNext();
        return jsonResult(next ? { next: next.id, botId: next.botId, title: next.title, priority: next.priority } : { next: null });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const startTool: Tool = {
    definition: toolDef(
      'schedule_v23_start',
      'Start a queued (or preempted) job; only queued/preempted jobs can start.',
      { jobId: { type: 'string', description: 'Id of the job to start.' } },
      ['jobId'],
    ),
    needsApproval: true,
    execute: async (args) => {
      const state = resolveState();
      if (!state) return errorResult(NOT_WIRED);
      try {
        const job = state.queue.start(getStringArg(args, 'jobId'));
        return jsonResult({ started: job.id, status: job.status, startedAt: job.startedAt });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const finishTool: Tool = {
    definition: toolDef(
      'schedule_v23_finish',
      'Finish a job as completed, failed or cancelled.',
      {
        jobId: { type: 'string', description: 'Id of the job.' },
        status: { type: 'string', enum: ['completed', 'failed', 'cancelled'], description: 'Final status.' },
      },
      ['jobId', 'status'],
    ),
    needsApproval: true,
    execute: async (args) => {
      const state = resolveState();
      if (!state) return errorResult(NOT_WIRED);
      try {
        const job = state.queue.finish(
          getStringArg(args, 'jobId'),
          getStringArg(args, 'status') as 'completed' | 'failed' | 'cancelled',
        );
        return jsonResult({ finished: job.id, status: job.status });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const cronNextTool: Tool = {
    definition: toolDef(
      'schedule_v23_cron_next',
      'Compute the next run time of a 5-field cron expression after a given moment (UTC, minute precision).',
      {
        cron: { type: 'string', description: '5-field cron expression.' },
        fromMs: { type: 'number', description: 'Epoch ms to compute from (default: now).' },
      },
      ['cron'],
    ),
    needsApproval: false,
    execute: async (args) => {
      const state = resolveState();
      if (!state) return errorResult(NOT_WIRED);
      try {
        const cron = getStringArg(args, 'cron');
        const errors = validateFleetV23Cron(cron);
        if (errors.length > 0) return errorResult(errors.join(' '));
        const fromMs = args.fromMs === undefined ? Date.now() : getNumberArg(args, 'fromMs', Date.now());
        const nextMs = nextFleetV23CronRun(cron, fromMs);
        return jsonResult({ cron, fromMs, nextRunMs: nextMs, nextRunIso: new Date(nextMs).toISOString(), matchesNow: cronMatchesAtV23(cron, fromMs) });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const slaTool: Tool = {
    definition: toolDef(
      'schedule_v23_sla',
      'Check SLA breaches: which queued jobs are past their deadline, how long each has waited, and how much time is left for the rest.',
      {},
      [],
    ),
    needsApproval: false,
    execute: async () => {
      const state = resolveState();
      if (!state) return errorResult(NOT_WIRED);
      try {
        const now = Date.now();
        const jobs = state.queue.list();
        const checks = jobs.map((j) => checkFleetV23Sla(j, now));
        return jsonResult({
          breached: breachedSlaJobsV23(jobs, now).map((j) => j.id),
          checks: checks.filter((c) => c.hasSla),
        });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const preemptTool: Tool = {
    definition: toolDef(
      'schedule_v23_preempt',
      'Decide whether a critical job may preempt a running lower-priority job (never preempts critical jobs or jobs that just started) and apply the preemption.',
      { incomingJobId: { type: 'string', description: 'Id of the incoming critical job (must be queued).' } },
      ['incomingJobId'],
    ),
    needsApproval: true,
    execute: async (args) => {
      const state = resolveState();
      if (!state) return errorResult(NOT_WIRED);
      try {
        const incoming = state.queue.get(getStringArg(args, 'incomingJobId'));
        if (!incoming) return errorResult(`Job "${getStringArg(args, 'incomingJobId')}" không có trong hàng đợi.`);
        const decision = decideFleetV23Preemption(incoming, state.queue.byStatus('running'));
        if (!decision.preempt) return jsonResult(decision);
        const result = applyFleetV23Preemption(state.queue, decision);
        return jsonResult({ ...decision, victimPreemptCount: result.victim.preemptCount });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const queueTool: Tool = {
    definition: toolDef(
      'schedule_v23_queue',
      'Show the scheduler queue snapshot: jobs per status and priority, SLA breaches, and the longest-waiting job.',
      {},
      [],
    ),
    needsApproval: false,
    execute: async () => {
      const state = resolveState();
      if (!state) return errorResult(NOT_WIRED);
      try {
        return jsonResult(snapshotFleetV23Queue(state.queue.list()));
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const dispatchTool: Tool = {
    definition: toolDef(
      'schedule_v23_dispatch',
      'Run one dispatch round: assign queued jobs (priority order) to nodes with the placement scorer, defer jobs that do not fit with reasons; dry-run by default, apply starts the assigned jobs.',
      {
        planId: { type: 'string', description: 'Id for the dispatch plan.' },
        dryRun: { type: 'boolean', description: 'Dry-run (default true): compute only, change nothing.' },
        maxJobs: { type: 'number', description: 'Maximum jobs to consider in this round.' },
        apply: { type: 'boolean', description: 'Apply the plan right away (start assigned jobs).' },
      },
      ['planId'],
    ),
    needsApproval: true,
    execute: async (args) => {
      const state = resolveState();
      if (!state) return errorResult(NOT_WIRED);
      try {
        const plan = planFleetV23Dispatch({
          id: getStringArg(args, 'planId'),
          jobs: state.queue.list(),
          nodes: state.nodes,
          placement: state.placement,
          topology: state.topology,
          weights: state.weights,
          maxJobs: args.maxJobs === undefined ? undefined : getNumberArg(args, 'maxJobs', 0),
          dryRun: getBoolArg(args, 'dryRun', true),
        });
        state.dispatchPlans.set(plan.id, plan);
        state.lastDispatchPlan = plan;
        if (!getBoolArg(args, 'apply', false)) return jsonResult(buildFleetV23DispatchPanel(plan));
        const application = applyFleetV23DispatchPlan(plan, state.queue, state.placement);
        state.placement = { ...application.placementAfter };
        return jsonResult({ plan: buildFleetV23DispatchPanel(plan), application });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  // --- Placement v2 -------------------------------------------------------
  const evaluateTool: Tool = {
    definition: toolDef(
      'place_v23_evaluate',
      'Score every node for a bot with multi-criteria weights (CPU/RAM/disk free, reliability, latency, cost), list ranked nodes with a per-criterion breakdown and the Pareto frontier.',
      {
        botId: { type: 'string', description: 'Bot to place.' },
        cpuCores: { type: 'number', description: 'CPU cores needed.' },
        ramBytes: { type: 'number', description: 'RAM bytes needed.' },
        diskBytes: { type: 'number', description: 'Disk bytes needed.' },
      },
      ['botId'],
    ),
    needsApproval: false,
    execute: async (args) => {
      const state = resolveState();
      if (!state) return errorResult(NOT_WIRED);
      try {
        const evaluation = evaluateFleetV23Placement(
          state.nodes,
          {
            botId: getStringArg(args, 'botId'),
            demand: {
              cpuCores: getNumberArg(args, 'cpuCores', 1),
              ramBytes: getNumberArg(args, 'ramBytes', 512 * 1024 ** 2),
              diskBytes: getNumberArg(args, 'diskBytes', 1024 ** 3),
            },
          },
          { weights: state.weights, topology: state.topology, placement: state.placement },
        );
        state.lastPlacementEvaluation = evaluation;
        return jsonResult(buildFleetV23PlacementPanel(evaluation));
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const placeTool: Tool = {
    definition: toolDef(
      'place_v23_place',
      'Place a bot on the best-scoring node (hard filters first: offline, capacity, labels, zones, topology) or reject with the reason for every node.',
      {
        botId: { type: 'string', description: 'Bot to place.' },
        cpuCores: { type: 'number', description: 'CPU cores needed.' },
        ramBytes: { type: 'number', description: 'RAM bytes needed.' },
        diskBytes: { type: 'number', description: 'Disk bytes needed.' },
      },
      ['botId'],
    ),
    needsApproval: true,
    execute: async (args) => {
      const state = resolveState();
      if (!state) return errorResult(NOT_WIRED);
      try {
        const decision = placeFleetV23Bot(
          state.nodes,
          {
            botId: getStringArg(args, 'botId'),
            demand: {
              cpuCores: getNumberArg(args, 'cpuCores', 1),
              ramBytes: getNumberArg(args, 'ramBytes', 512 * 1024 ** 2),
              diskBytes: getNumberArg(args, 'diskBytes', 1024 ** 3),
            },
          },
          { weights: state.weights, topology: state.topology, placement: state.placement },
        );
        state.lastPlacementEvaluation = decision.evaluation;
        if (!decision.placed) return errorResult(decision.reason);
        state.placement[decision.botId] = decision.nodeId;
        return jsonResult({ placed: decision.botId, nodeId: decision.nodeId, score: decision.score.score });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const capacityTool: Tool = {
    definition: toolDef(
      'place_v23_capacity',
      'Forecast fleet capacity: with a growth rate (new bots per month), when does CPU/RAM/disk run out, and which resource is the bottleneck.',
      {
        botsPerMonth: { type: 'number', description: 'New bots per month (default: state growth rate).' },
        cpuCores: { type: 'number', description: 'CPU cores per new bot.' },
        ramBytes: { type: 'number', description: 'RAM bytes per new bot.' },
        diskBytes: { type: 'number', description: 'Disk bytes per new bot.' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args) => {
      const state = resolveState();
      if (!state) return errorResult(NOT_WIRED);
      try {
        const growth: FleetV23GrowthRate = {
          botsPerMonth: args.botsPerMonth === undefined ? state.growth.botsPerMonth : getNumberArg(args, 'botsPerMonth', state.growth.botsPerMonth),
          perBot: {
            cpuCores: args.cpuCores === undefined ? state.growth.perBot.cpuCores : getNumberArg(args, 'cpuCores', state.growth.perBot.cpuCores),
            ramBytes: args.ramBytes === undefined ? state.growth.perBot.ramBytes : getNumberArg(args, 'ramBytes', state.growth.perBot.ramBytes),
            diskBytes: args.diskBytes === undefined ? state.growth.perBot.diskBytes : getNumberArg(args, 'diskBytes', state.growth.perBot.diskBytes),
          },
        };
        return jsonResult(forecastFleetV23Capacity(state.nodes, growth));
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const autoscaleTool: Tool = {
    definition: toolDef(
      'place_v23_autoscale',
      'Recommend scaling the fleet out (add a node) or in (remove a node) from the capacity forecast, queue length and SLA breaches, with a cooldown after the last scale and a monthly cost delta.',
      {},
      [],
    ),
    needsApproval: false,
    execute: async () => {
      const state = resolveState();
      if (!state) return errorResult(NOT_WIRED);
      try {
        const { forecasts, bottleneck } = forecastFleetV23Capacity(state.nodes, state.growth);
        const recommendation = recommendFleetV23Autoscale(
          { nodes: state.nodes, jobs: state.queue.list(), forecasts, bottleneck },
          DEFAULT_FLEET_V23_AUTOSCALE_POLICY,
          state.lastScaleAtMs,
        );
        state.lastAutoscale = recommendation;
        return jsonResult(buildFleetV23AutoscalePanel(recommendation));
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  // --- Rebalance v2 -------------------------------------------------------
  const measureTool: Tool = {
    definition: toolDef(
      'rebalance_v23_measure',
      'Measure fleet load imbalance (coefficient of variation + max-min spread for CPU/RAM) and say whether a rebalance is needed.',
      {},
      [],
    ),
    needsApproval: false,
    execute: async () => {
      const state = resolveState();
      if (!state) return errorResult(NOT_WIRED);
      try {
        const loads = buildFleetV23NodeLoads(state.nodes, state.placement, () => null);
        return jsonResult(measureFleetV23Imbalance(loads, DEFAULT_FLEET_V23_REBALANCE_THRESHOLDS));
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const planTool: Tool = {
    definition: toolDef(
      'rebalance_v23_plan',
      'Plan a rebalance (dry-run by default): greedy moves from the hottest node to the coldest, respecting capacity, pinned bots and topology; reports imbalance before/after and warnings.',
      {
        planId: { type: 'string', description: 'Id for the plan (to execute later).' },
        dryRun: { type: 'boolean', description: 'Dry-run (default true): compute only, change nothing.' },
        maxMoves: { type: 'number', description: 'Maximum moves in the plan (default 5).' },
      },
      ['planId'],
    ),
    needsApproval: false,
    execute: async (args) => {
      const state = resolveState();
      if (!state) return errorResult(NOT_WIRED);
      try {
        const loads = buildFleetV23NodeLoads(state.nodes, state.placement, () => null);
        const plan = planFleetV23Rebalance({
          id: getStringArg(args, 'planId'),
          loads,
          nodes: state.nodes,
          placement: state.placement,
          topology: state.topology,
          thresholds: {
            ...DEFAULT_FLEET_V23_REBALANCE_THRESHOLDS,
            maxMoves: getNumberArg(args, 'maxMoves', DEFAULT_FLEET_V23_REBALANCE_THRESHOLDS.maxMoves),
          },
          dryRun: getBoolArg(args, 'dryRun', true),
        });
        state.plans.set(plan.id, plan);
        return jsonResult(plan);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const executeTool: Tool = {
    definition: toolDef(
      'rebalance_v23_execute',
      'Execute a rebalance plan step by step with verification after every move; on a failed move it stops and rolls back the moves already applied.',
      { planId: { type: 'string', description: 'Id of the plan to execute.' } },
      ['planId'],
    ),
    needsApproval: true,
    execute: async (args) => {
      const state = resolveState();
      if (!state) return errorResult(NOT_WIRED);
      try {
        const plan = state.plans.get(getStringArg(args, 'planId'));
        if (!plan) return errorResult(`Kế hoạch rebalance "${getStringArg(args, 'planId')}" chưa được lập — chạy rebalance_v23_plan trước.`);
        // Mover mặc định (mô phỏng): cập nhật placement trong state, verify
        // bằng cách kiểm tra node đích còn đủ chỗ trong snapshot.
        const mover: FleetV23Mover = state.mover ?? {
          moveBot: async (move) => {
            state.placement[move.botId] = move.toNodeId;
          },
          verifyBot: async (move) => {
            const node = state.nodes.find((n) => n.id === move.toNodeId);
            return node !== undefined && node.online;
          },
        };
        const execution = await executeFleetV23RebalancePlan(plan, state.placement, mover);
        state.placement = { ...execution.placementAfter };
        state.history.record(execution);
        return jsonResult(execution);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const historyTool: Tool = {
    definition: toolDef(
      'rebalance_v23_history',
      'Show rebalance execution history (which plans ran, which moves applied, which failed and rolled back).',
      {},
      [],
    ),
    needsApproval: false,
    execute: async () => {
      const state = resolveState();
      if (!state) return errorResult(NOT_WIRED);
      try {
        return jsonResult({ executions: state.history.list(), failures: state.history.failureCount });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  // --- Dashboard ----------------------------------------------------------
  const dashboardTool: Tool = {
    definition: toolDef(
      'fleet_v23_dashboard',
      'Show the aggregated fleet v23 dashboard: topology (zones/groups/spread), scheduler queue (priorities, SLA breaches), placement (best nodes, capacity forecast) and rebalance (imbalance, last execution).',
      {},
      [],
    ),
    needsApproval: false,
    execute: async () => {
      const state = resolveState();
      if (!state) return errorResult(NOT_WIRED);
      try {
        const loads = buildFleetV23NodeLoads(state.nodes, state.placement, () => null);
        const imbalance = measureFleetV23Imbalance(loads, DEFAULT_FLEET_V23_REBALANCE_THRESHOLDS);
        const lastExecution = state.history.list().at(-1) ?? null;
        return jsonResult(
          buildFleetV23Dashboard({
            topology: buildFleetV23TopologyPanel(
              state.topology,
              new Map(state.topology.zones.map((z) => [z.id, topologyNodesInZone(state.topology, z.id).length])),
            ),
            scheduler: buildFleetV23SchedulerPanel(state.queue.list()),
            placement: state.lastPlacementEvaluation ? buildFleetV23PlacementPanel(state.lastPlacementEvaluation) : null,
            rebalance: buildFleetV23RebalancePanel({
              imbalance,
              plannedMoves: [...state.plans.values()].reduce((s, p) => s + p.moves.length, 0),
              lastExecution: lastExecution
                ? {
                    planId: lastExecution.planId,
                    success: lastExecution.success,
                    appliedMoves: lastExecution.appliedMoves,
                    rolledBackMoves: lastExecution.rolledBackMoves,
                    failedMove: lastExecution.failedMove,
                  }
                : null,
            }),
            dispatch: state.lastDispatchPlan ? buildFleetV23DispatchPanel(state.lastDispatchPlan) : null,
            autoscale: state.lastAutoscale ? buildFleetV23AutoscalePanel(state.lastAutoscale) : null,
            health: state.lastHealthPanel,
          }),
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [
    createZoneTool,
    assignNodeZoneTool,
    createGroupTool,
    checkTopologyTool,
    zoneFailureTool,
    healthTool,
    enqueueTool,
    nextTool,
    startTool,
    finishTool,
    cronNextTool,
    slaTool,
    preemptTool,
    queueTool,
    dispatchTool,
    evaluateTool,
    placeTool,
    capacityTool,
    autoscaleTool,
    measureTool,
    planTool,
    executeTool,
    historyTool,
    dashboardTool,
  ];
}

/** Toàn bộ tool v23 (unbound placeholders — host bind qua `createFleetV23Tools`). */
export const FLEET_V23_TOOLS: Tool[] = createFleetV23Tools();

/** true khi mọi tên tool v23 là duy nhất và không chứa dấu chấm. */
export function fleetV23ToolNamesUnique(): boolean {
  const names = FLEET_V23_TOOLS.map((t) => t.definition.name);
  return new Set(names).size === names.length && names.every((n) => /^[A-Za-z0-9_-]+$/.test(n));
}

/**
 * Tạo state v23 trống cho host (topology rỗng, queue rỗng, growth mặc
 * định 1 bot/tháng, plans/history rỗng) — host chỉ cần giữ 1 instance
 * này rồi truyền vào `createFleetV23Tools`.
 */
export function createEmptyFleetV23ToolState(): FleetV23ToolState {
  return {
    topology: createFleetV23Topology(),
    queue: new FleetV23SchedulerQueue(),
    nodes: [],
    placement: {},
    growth: {
      botsPerMonth: 1,
      perBot: { cpuCores: 1, ramBytes: 512 * 1024 ** 2, diskBytes: 1024 ** 3 },
    },
    weights: { ...DEFAULT_FLEET_V23_SCORE_WEIGHTS },
    plans: new Map<string, FleetV23RebalancePlan>(),
    history: new FleetV23RebalanceHistory(),
    lastPlacementEvaluation: null,
    dispatchPlans: new Map<string, FleetV23DispatchPlan>(),
    lastDispatchPlan: null,
    lastAutoscale: null,
    lastScaleAtMs: null,
    healthInputs: [],
    healthHistory: new FleetV23HealthHistory(),
    lastHealthPanel: null,
  };
}
