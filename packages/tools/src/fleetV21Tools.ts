/**
 * Fleet v21 tools (v1.34, Đội T6) — registered in ALL_TOOLS (see tools.ts).
 *
 * Tool chạy thật cho platform/fleet v21 (định nghĩa thuần nằm ở
 * `packages/core/src/fleetV21/toolsV21.ts` — 18 tool, 4 nhóm; file này
 * là bản chạy được, nối vào core qua `@open-bot/core`):
 *
 * - `scheduler_v21_schedule` / `scheduler_v21_evaluate` /
 *   `scheduler_v21_node_scores` — đặt 1 run
 *   lên node tốt nhất theo tier cách ly tối thiểu + tài nguyên + độ
 *   tin cậy + độ trễ; từ chối kèm lý do từng node.
 * - `placement_v21_place_runs` / `placement_v21_rebalance` /
 *   `placement_v21_history` / `placement_v21_node_capacity` — đặt
 *   nhiều run song song, kế hoạch rebalance, lịch sử placement,
 *   dung lượng node.
 * - `automation_v21_create` / `automation_v21_list` /
 *   `automation_v21_pause` / `automation_v21_resume` /
 *   `automation_v21_remove` / `automation_v21_traces` /
 *   `automation_v21_run_due` — durable automation v2.
 * - `fleet_v21_dashboard` / `fleet_v21_nodes` / `fleet_v21_runs` /
 *   `fleet_v21_alerts` — dashboard tổng hợp toàn fleet.
 *
 * Như internet-data và fleet v3, đây là placeholder trong ALL_TOOLS
 * cho tới khi host bind: `createFleetV21Tools(getState)` với state của
 * host (nodes + runs + automation store + placement log). Unbound, tool
 * trả về thông báo "not configured" rõ ràng thay vì đoán state. Tool
 * ghi (placeRuns, automation create/pause/resume/remove/runDue) cần
 * duyệt (`needsApproval: true`); placement chỉ TRẢ VỀ kế hoạch, host
 * mới áp dụng đặt/dời thật (tool không tự dời run).
 */

import type { Tool } from '@open-bot/core';
import {
  buildFleetV21AutomationPanel,
  buildFleetV21Dashboard,
  buildFleetV21NodePanel,
  buildFleetV21RunPanel,
  evaluateFleetV21Schedule,
  placeFleetV21Runs,
  planFleetV21Rebalance,
  scheduleFleetV21Run,
  scoreFleetV21Node,
  validateDurableAutomationV2,
  validateScheduleRequestV21,
} from '@open-bot/core';
import type {
  AutomationV2Executor,
  AutomationV2Store,
  FleetV21Node,
  FleetV21PlacementLog,
  FleetV21PlacementRequest,
  FleetV21RunningRun,
  FleetV21RunningRunView,
} from '@open-bot/core';

/** State fleet v21 host cung cấp cho tools (đọc lười mỗi lần tool chạy). */
export interface FleetV21ToolState {
  /** Node trong fleet (ảnh chụp hiện tại). */
  nodes: FleetV21Node[];
  /** Run đang chạy (ảnh chụp hiện tại). */
  runs: FleetV21RunningRunView[];
  /** Store durable automation v2 (null = chưa cấu hình automation). */
  automationStore: AutomationV2Store | null;
  /** Lịch sử placement (null = không có lịch sử). */
  placementLog: FleetV21PlacementLog | null;
  /** Run đang chạy KÈM demand (host cung cấp khi muốn rebalance thật — dashboard view không có demand). */
  runningRuns?: FleetV21RunningRun[];
  /** Executor chạy action automation (null = runDue/fireEvent không chạy được). */
  executor?: AutomationV2Executor | null;
}

export const FLEET_V21_TOOL_NAMES = [
  'scheduler_v21_schedule',
  'scheduler_v21_evaluate',
  'scheduler_v21_node_scores',
  'placement_v21_place_runs',
  'placement_v21_rebalance',
  'placement_v21_history',
  'placement_v21_node_capacity',
  'automation_v21_create',
  'automation_v21_list',
  'automation_v21_pause',
  'automation_v21_resume',
  'automation_v21_remove',
  'automation_v21_traces',
  'automation_v21_run_due',
  'fleet_v21_dashboard',
  'fleet_v21_nodes',
  'fleet_v21_runs',
  'fleet_v21_alerts',
] as const;

const NOT_WIRED =
  'Fleet v21 is not configured: the host has not wired fleet state (nodes/runs/automation store) into the v21 tools.';

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

export function createFleetV21Tools(
  getState?: () => FleetV21ToolState | null | undefined,
): Tool[] {
  const resolveState = (): FleetV21ToolState | null => {
    try {
      return getState?.() ?? null;
    } catch {
      return null;
    }
  };

  const demandProps = {
    cpuCores: { type: 'number', description: 'CPU cores the run needs.' },
    ramBytes: { type: 'number', description: 'RAM in bytes the run needs.' },
    diskBytes: { type: 'number', description: 'Disk in bytes the run needs.' },
  };
  const tierProp = {
    type: 'string',
    enum: ['bwrap', 'syscall-policy', 'microvm'],
    description: 'Minimum sandbox isolation tier the run requires.',
  };

  const scheduleTool: Tool = {
    definition: toolDef(
      'scheduler_v21_schedule',
      'Schedule one bot run onto the best node for its minimum sandbox tier (bwrap/syscall-policy/microvm), CPU/RAM/disk, reliability and latency; refuses with per-node reasons when no node qualifies.',
      {
        runId: { type: 'string', description: 'Id of the run to place.' },
        botId: { type: 'string', description: 'Id of the bot running this run.' },
        minTier: tierProp,
        ...demandProps,
      },
      ['runId', 'botId', 'minTier', 'cpuCores', 'ramBytes', 'diskBytes'],
    ),
    needsApproval: false,
    execute: async (args) => {
      const state = resolveState();
      if (!state) return errorResult(NOT_WIRED);
      try {
        const request = {
          runId: getStringArg(args, 'runId'),
          botId: getStringArg(args, 'botId'),
          minTier: getStringArg(args, 'minTier') as 'bwrap' | 'syscall-policy' | 'microvm',
          demand: {
            cpuCores: getNumberArg(args, 'cpuCores', 0),
            ramBytes: getNumberArg(args, 'ramBytes', 0),
            diskBytes: getNumberArg(args, 'diskBytes', 0),
          },
        };
        const errors = validateScheduleRequestV21(request);
        if (errors.length > 0) return errorResult(errors.join(' '));
        return jsonResult(scheduleFleetV21Run(state.nodes, request));
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const evaluateTool: Tool = {
    definition: toolDef(
      'scheduler_v21_evaluate',
      'Evaluate every node for a run request (ranked scores + per-node rejection reasons) without placing the run.',
      {
        runId: { type: 'string', description: 'Id of the run to evaluate.' },
        botId: { type: 'string', description: 'Id of the bot running this run.' },
        minTier: tierProp,
        ...demandProps,
      },
      ['runId', 'botId', 'minTier', 'cpuCores', 'ramBytes', 'diskBytes'],
    ),
    needsApproval: false,
    execute: async (args) => {
      const state = resolveState();
      if (!state) return errorResult(NOT_WIRED);
      try {
        return jsonResult(
          evaluateFleetV21Schedule(state.nodes, {
            runId: getStringArg(args, 'runId'),
            botId: getStringArg(args, 'botId'),
            minTier: getStringArg(args, 'minTier') as 'bwrap' | 'syscall-policy' | 'microvm',
            demand: {
              cpuCores: getNumberArg(args, 'cpuCores', 0),
              ramBytes: getNumberArg(args, 'ramBytes', 0),
              diskBytes: getNumberArg(args, 'diskBytes', 0),
            },
          }),
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const nodeScoresTool: Tool = {
    definition: toolDef(
      'scheduler_v21_node_scores',
      'Score one node for a run request (0-100 with free CPU/RAM/disk, reliability, latency and tier-fit breakdown).',
      {
        nodeId: { type: 'string', description: 'Id of the node to score.' },
        runId: { type: 'string', description: 'Id of the run.' },
        botId: { type: 'string', description: 'Id of the bot.' },
        minTier: tierProp,
      },
      ['nodeId', 'runId', 'botId', 'minTier'],
    ),
    needsApproval: false,
    execute: async (args) => {
      const state = resolveState();
      if (!state) return errorResult(NOT_WIRED);
      try {
        const node = state.nodes.find((n) => n.id === getStringArg(args, 'nodeId'));
        if (!node) return errorResult(`Node "${getStringArg(args, 'nodeId')}" không có trong fleet v21.`);
        return jsonResult(
          scoreFleetV21Node(node, {
            runId: getStringArg(args, 'runId'),
            botId: getStringArg(args, 'botId'),
            minTier: getStringArg(args, 'minTier') as 'bwrap' | 'syscall-policy' | 'microvm',
            demand: {
              cpuCores: getNumberArg(args, 'cpuCores', 0),
              ramBytes: getNumberArg(args, 'ramBytes', 0),
              diskBytes: getNumberArg(args, 'diskBytes', 0),
            },
          }),
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const placeRunsTool: Tool = {
    definition: toolDef(
      'placement_v21_place_runs',
      'Place many runs across many nodes at once (heaviest first, tier-aware bin-packing, affinity/anti-affinity). Returns the plan only — the host applies placements.',
      {
        requests: {
          type: 'array',
          description: 'Run placement requests: [{runId, botId, minTier, demand:{cpuCores, ramBytes, diskBytes}, antiAffinityBot?, affinityKey?, priority?}].',
          items: { type: 'object' },
        },
      },
      ['requests'],
    ),
    needsApproval: true,
    execute: async (args) => {
      const state = resolveState();
      if (!state) return errorResult(NOT_WIRED);
      try {
        if (!Array.isArray(args.requests)) return errorResult('requests must be an array of placement requests.');
        const requests: FleetV21PlacementRequest[] = [];
        for (const raw of args.requests as unknown[]) {
          if (typeof raw !== 'object' || raw === null) return errorResult('Each placement request must be an object.');
          const r = raw as Record<string, unknown>;
          const demand = r.demand as Record<string, unknown> | undefined;
          const request: FleetV21PlacementRequest = {
            runId: String(r.runId ?? ''),
            botId: String(r.botId ?? ''),
            minTier: (r.minTier as 'bwrap' | 'syscall-policy' | 'microvm' | undefined) ?? 'bwrap',
            demand: {
              cpuCores: typeof demand?.cpuCores === 'number' ? demand.cpuCores : 0,
              ramBytes: typeof demand?.ramBytes === 'number' ? demand.ramBytes : 0,
              diskBytes: typeof demand?.diskBytes === 'number' ? demand.diskBytes : 0,
            },
            ...(typeof r.antiAffinityBot === 'boolean' ? { antiAffinityBot: r.antiAffinityBot } : {}),
            ...(typeof r.affinityKey === 'string' ? { affinityKey: r.affinityKey } : {}),
            ...(typeof r.priority === 'number' ? { priority: r.priority } : {}),
          };
          const errors = validateScheduleRequestV21(request);
          if (errors.length > 0) return errorResult(`Request "${request.runId}": ${errors.join(' ')}`);
          requests.push(request);
        }
        return jsonResult(placeFleetV21Runs(state.nodes, requests, state.placementLog ?? undefined));
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const rebalanceTool: Tool = {
    definition: toolDef(
      'placement_v21_rebalance',
      'Plan a rebalance: evacuate runs off dead/draining nodes and balance load (at most 5 balance moves per plan). Returns the plan only — the host applies moves.',
      {},
      [],
    ),
    needsApproval: false,
    execute: async () => {
      const state = resolveState();
      if (!state) return errorResult(NOT_WIRED);
      try {
        // Rebalance cần demand thật của run đang chạy (để trừ/cộng tài
        // nguyên khi dời). Dashboard view không có demand nên host phải
        // cung cấp `runningRuns` đầy đủ; thiếu thì báo rõ thay vì đoán.
        if (!state.runningRuns) {
          return errorResult(
            'placement_v21_rebalance needs full running runs with demands (cpuCores/ramBytes/diskBytes per run) — bind FleetV21ToolState.runningRuns, or use planFleetV21Rebalance from @open-bot/core directly.',
          );
        }
        return jsonResult(planFleetV21Rebalance(state.nodes, state.runningRuns, state.placementLog ?? undefined));
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const historyTool: Tool = {
    definition: toolDef(
      'placement_v21_history',
      'Show recent placement history (run, node, reason, score) for audit — newest first.',
      {
        runId: { type: 'string', description: 'Filter by run id (optional).' },
        nodeId: { type: 'string', description: 'Filter by node id (optional).' },
        limit: { type: 'number', description: 'Max records (default 20).' },
      },
      [],
    ),
    needsApproval: false,
    execute: async (args) => {
      const state = resolveState();
      if (!state) return errorResult(NOT_WIRED);
      try {
        if (!state.placementLog) return jsonResult([]);
        const limit = getNumberArg(args, 'limit', 20);
        const runId = getStringArg(args, 'runId', false);
        const nodeId = getStringArg(args, 'nodeId', false);
        let records = state.placementLog.recent(1000);
        if (runId) records = records.filter((r) => r.runId === runId);
        if (nodeId) records = records.filter((r) => r.nodeId === nodeId);
        return jsonResult(records.slice(0, limit));
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const nodeCapacityTool: Tool = {
    definition: toolDef(
      'placement_v21_node_capacity',
      'Show free/used CPU/RAM/disk per node and fleet totals (overloaded and dead nodes flagged).',
      {},
      [],
    ),
    needsApproval: false,
    execute: async () => {
      const state = resolveState();
      if (!state) return errorResult(NOT_WIRED);
      try {
        return jsonResult(buildFleetV21NodePanel(state.nodes));
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const automationCreateTool: Tool = {
    definition: toolDef(
      'automation_v21_create',
      'Create a durable automation (schedule trigger every N ms, or event trigger by pattern) that survives restarts; retries with backoff and dead-letters after max attempts.',
      {
        automation: {
          type: 'object',
          description: 'Automation: {id, name, description?, trigger:{kind:"schedule",intervalMs}|{kind:"event",eventPattern}, action:{kind:"run-bot",botId,task?}, maxAttempts?, baseBackoffMs?, maxBackoffMs?}.',
        },
      },
      ['automation'],
    ),
    needsApproval: true,
    execute: async (args) => {
      const state = resolveState();
      if (!state) return errorResult(NOT_WIRED);
      try {
        if (!state.automationStore) return errorResult('Automation store chưa được cấu hình trong fleet v21 state.');
        const raw = args.automation as Record<string, unknown> | undefined;
        if (typeof raw !== 'object' || raw === null) return errorResult('automation must be an object.');
        const errors = validateDurableAutomationV2(raw);
        if (errors.length > 0) return errorResult(errors.join(' '));
        const created = state.automationStore.add(
          raw as unknown as Parameters<AutomationV2Store['add']>[0],
        );
        return jsonResult(created);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const automationListTool: Tool = {
    definition: toolDef(
      'automation_v21_list',
      'List durable automations with status, next run, consecutive failures and last error.',
      {},
      [],
    ),
    needsApproval: false,
    execute: async () => {
      const state = resolveState();
      if (!state) return errorResult(NOT_WIRED);
      try {
        if (!state.automationStore) return errorResult('Automation store chưa được cấu hình trong fleet v21 state.');
        return jsonResult(buildFleetV21AutomationPanel(state.automationStore.list()));
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const automationPauseTool: Tool = {
    definition: toolDef(
      'automation_v21_pause',
      'Pause a durable automation (scheduled runs stop until resumed).',
      { automationId: { type: 'string', description: 'Id of the automation.' } },
      ['automationId'],
    ),
    needsApproval: true,
    execute: async (args) => {
      const state = resolveState();
      if (!state) return errorResult(NOT_WIRED);
      try {
        if (!state.automationStore) return errorResult('Automation store chưa được cấu hình trong fleet v21 state.');
        return jsonResult(state.automationStore.pause(getStringArg(args, 'automationId')));
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const automationResumeTool: Tool = {
    definition: toolDef(
      'automation_v21_resume',
      'Resume a paused or dead-lettered automation (dead-letter resumes reset attempts and failures).',
      { automationId: { type: 'string', description: 'Id of the automation.' } },
      ['automationId'],
    ),
    needsApproval: true,
    execute: async (args) => {
      const state = resolveState();
      if (!state) return errorResult(NOT_WIRED);
      try {
        if (!state.automationStore) return errorResult('Automation store chưa được cấu hình trong fleet v21 state.');
        return jsonResult(state.automationStore.resumeManual(getStringArg(args, 'automationId')));
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const automationRemoveTool: Tool = {
    definition: toolDef(
      'automation_v21_remove',
      'Remove a durable automation (its trace history is deleted with it).',
      { automationId: { type: 'string', description: 'Id of the automation.' } },
      ['automationId'],
    ),
    needsApproval: true,
    execute: async (args) => {
      const state = resolveState();
      if (!state) return errorResult(NOT_WIRED);
      try {
        if (!state.automationStore) return errorResult('Automation store chưa được cấu hình trong fleet v21 state.');
        const removed = state.automationStore.remove(getStringArg(args, 'automationId'));
        return jsonResult({ removed });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const automationTracesTool: Tool = {
    definition: toolDef(
      'automation_v21_traces',
      'Show the run trace of a durable automation (started/succeeded/failed/retry/dead-letter/resumed), newest last.',
      {
        automationId: { type: 'string', description: 'Id of the automation.' },
        limit: { type: 'number', description: 'Max trace entries (default 20).' },
      },
      ['automationId'],
    ),
    needsApproval: false,
    execute: async (args) => {
      const state = resolveState();
      if (!state) return errorResult(NOT_WIRED);
      try {
        if (!state.automationStore) return errorResult('Automation store chưa được cấu hình trong fleet v21 state.');
        const a = state.automationStore.get(getStringArg(args, 'automationId'));
        if (!a) return errorResult(`Automation "${getStringArg(args, 'automationId')}" không tồn tại.`);
        const limit = getNumberArg(args, 'limit', 20);
        return jsonResult(a.traces.slice(-limit));
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const automationRunDueTool: Tool = {
    definition: toolDef(
      'automation_v21_run_due',
      'Run all due scheduled automations now (one failure does not block the others).',
      {},
      [],
    ),
    needsApproval: true,
    execute: async () => {
      const state = resolveState();
      if (!state) return errorResult(NOT_WIRED);
      try {
        if (!state.automationStore) return errorResult('Automation store chưa được cấu hình trong fleet v21 state.');
        if (!state.executor) return errorResult('Không có automation executor — host chưa bind executor chạy action automation.');
        return jsonResult(await state.automationStore.runDue(state.executor));
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const dashboardTool: Tool = {
    definition: toolDef(
      'fleet_v21_dashboard',
      'Show the aggregated fleet dashboard: nodes (tier/load/status), running runs (tier/node/age), automations (schedule/last run/errors) and alerts (overload, lifetime-cap, consecutive failures).',
      {},
      [],
    ),
    needsApproval: false,
    execute: async () => {
      const state = resolveState();
      if (!state) return errorResult(NOT_WIRED);
      try {
        return jsonResult(
          buildFleetV21Dashboard({
            nodes: state.nodes,
            runs: state.runs,
            automations: state.automationStore ? state.automationStore.list() : [],
            placementHistory: state.placementLog ? state.placementLog.list() : [],
          }),
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const nodesTool: Tool = {
    definition: toolDef(
      'fleet_v21_nodes',
      'List fleet nodes with tier, load, reliability, latency and run count, sorted by load.',
      {},
      [],
    ),
    needsApproval: false,
    execute: async () => {
      const state = resolveState();
      if (!state) return errorResult(NOT_WIRED);
      try {
        return jsonResult(buildFleetV21NodePanel(state.nodes));
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const runsTool: Tool = {
    definition: toolDef(
      'fleet_v21_runs',
      'List running runs with node, tier, age and lifetime-cap status (orphaned runs flagged).',
      {},
      [],
    ),
    needsApproval: false,
    execute: async () => {
      const state = resolveState();
      if (!state) return errorResult(NOT_WIRED);
      try {
        return jsonResult(buildFleetV21RunPanel(state.runs, state.nodes));
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const alertsTool: Tool = {
    definition: toolDef(
      'fleet_v21_alerts',
      'List fleet alerts only (overloaded nodes, runs over lifetime cap, failing/dead-letter automations, dead nodes with stranded runs), errors first.',
      {},
      [],
    ),
    needsApproval: false,
    execute: async () => {
      const state = resolveState();
      if (!state) return errorResult(NOT_WIRED);
      try {
        const dashboard = buildFleetV21Dashboard({
          nodes: state.nodes,
          runs: state.runs,
          automations: state.automationStore ? state.automationStore.list() : [],
          placementHistory: state.placementLog ? state.placementLog.list() : [],
        });
        return jsonResult({ attentionCount: dashboard.attentionCount, attention: dashboard.attention });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [
    scheduleTool,
    evaluateTool,
    nodeScoresTool,
    placeRunsTool,
    rebalanceTool,
    historyTool,
    nodeCapacityTool,
    automationCreateTool,
    automationListTool,
    automationPauseTool,
    automationResumeTool,
    automationRemoveTool,
    automationTracesTool,
    automationRunDueTool,
    dashboardTool,
    nodesTool,
    runsTool,
    alertsTool,
  ];
}

/** Toàn bộ tool v21 (unbound placeholders — host bind qua `createFleetV21Tools`). */
export const FLEET_V21_TOOLS: Tool[] = createFleetV21Tools();

/** true khi mọi tên tool v21 là duy nhất. */
export function fleetV21ToolNamesUnique(): boolean {
  return new Set(FLEET_V21_TOOLS.map((t) => t.definition.name)).size === FLEET_V21_TOOLS.length;
}
