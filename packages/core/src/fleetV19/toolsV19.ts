/**
 * Tools v19 — định nghĩa tool riêng của platform/fleet v19
 * (v1.29, Đội T6).
 *
 * Theo pattern tools v17 (`fleetV17/toolsV17.ts`): registry riêng
 * của đội T6 (không sửa registry trung tâm của các đội khác): mỗi
 * tool là một định nghĩa thuần (tên, mô tả, params, cần quyền gì,
 * có ghi hay không) để agent loop / UI gọi qua các hàm core ở
 * `fleetV19/` — module này KHÔNG tự đăng ký vào registry trung tâm,
 * KHÔNG chạy tool. Coordinator gộp sẽ quyết định có merge các def
 * này vào registry trung tâm hay không; số đếm tool được pin trong
 * test của đội (`tests/fleet-v129-panels-tools-i18n.test.mjs`).
 *
 * Quy ước tên: `fleetV19.*` cho health/queue/node-status, `pluginV19.*`
 * cho plugin SDK v4, `pluginStoreV19.*` cho plugin store panel.
 * Tool ghi (write: true) luôn cần duyệt trước khi chạy thật.
 */

/** Định nghĩa một tool v19 (thuần, JSON-able). */
export interface FleetV19ToolDef {
  /** Tên tool, vd `fleetV19.healthSummary`. */
  name: string;
  description: string;
  /** true = hành động ghi (cần duyệt + ghi audit). */
  write: boolean;
  /** Quyền team cần có (xem `multiUserV13.ts` TEAM_V13_ACTIONS). */
  requiresAction: string;
  /** Tên param (để UI render form, không validate kiểu ở đây). */
  params: string[];
}

/** Toàn bộ tool v19 (định nghĩa thuần). */
export const FLEET_V19_TOOLS: readonly FleetV19ToolDef[] = [
  // Fleet health v19: lịch sử, trend, điểm fleet, alert lifecycle.
  {
    name: 'fleetV19.healthSummary',
    description: 'Summarize one node health history (avg/min/max, uptime, trend, flapping).',
    write: false,
    requiresAction: 'view-fleet',
    params: ['nodeId', 'points'],
  },
  {
    name: 'fleetV19.fleetScore',
    description: 'Fleet-wide health score (task-weighted) with health distribution and worst/best node.',
    write: false,
    requiresAction: 'view-fleet',
    params: ['statsByNode', 'runningTasksByNode'],
  },
  {
    name: 'fleetV19.evaluateAlertRules',
    description: 'Evaluate fleet alert rules on current stats and return new triggers.',
    write: false,
    requiresAction: 'view-fleet',
    params: ['rules', 'statsByNode', 'fleetScore'],
  },
  {
    name: 'fleetV19.raiseAlerts',
    description: 'Raise new alerts from triggers (dedupe per rule+node inside cooldown).',
    write: true,
    requiresAction: 'manage-fleet',
    params: ['triggers'],
  },
  {
    name: 'fleetV19.ackAlert',
    description: 'Acknowledge an open fleet alert.',
    write: true,
    requiresAction: 'manage-fleet',
    params: ['alertId', 'userId'],
  },
  {
    name: 'fleetV19.resolveAlert',
    description: 'Resolve an open or acked fleet alert.',
    write: true,
    requiresAction: 'manage-fleet',
    params: ['alertId'],
  },
  {
    name: 'fleetV19.autoResolveAlerts',
    description: 'Auto-resolve alerts whose trigger condition no longer holds.',
    write: true,
    requiresAction: 'manage-fleet',
    params: ['activeTriggers'],
  },
  {
    name: 'fleetV19.listOpenAlerts',
    description: 'List open fleet alerts, most severe first.',
    write: false,
    requiresAction: 'view-fleet',
    params: [],
  },
  {
    name: 'fleetV19.healthPanel',
    description: 'Build the fleet health panel view-model (fleet score, node trends, open alerts).',
    write: false,
    requiresAction: 'view-fleet',
    params: ['fleetScore', 'statsByNode', 'openAlerts'],
  },
  // Job queue v19: enqueue, lifecycle, retry, dead-letter, placement.
  {
    name: 'fleetV19.enqueueJob',
    description: 'Enqueue a job (idempotent by idempotencyKey, duplicate returns the existing job).',
    write: true,
    requiresAction: 'manage-fleet',
    params: ['job', 'idempotencyKey'],
  },
  {
    name: 'fleetV19.nextJob',
    description: 'Peek the next job to run (effective priority with aging, FIFO within priority).',
    write: false,
    requiresAction: 'view-fleet',
    params: [],
  },
  {
    name: 'fleetV19.startJob',
    description: 'Mark a queued job as running on a node.',
    write: true,
    requiresAction: 'manage-fleet',
    params: ['jobId', 'nodeId'],
  },
  {
    name: 'fleetV19.completeJob',
    description: 'Mark a running job as done.',
    write: true,
    requiresAction: 'manage-fleet',
    params: ['jobId'],
  },
  {
    name: 'fleetV19.failJob',
    description: 'Mark a running job as failed (retry with backoff, or dead-letter when out of attempts).',
    write: true,
    requiresAction: 'manage-fleet',
    params: ['jobId', 'error'],
  },
  {
    name: 'fleetV19.promoteRetries',
    description: 'Move retrying jobs whose backoff expired back to queued.',
    write: true,
    requiresAction: 'manage-fleet',
    params: [],
  },
  {
    name: 'fleetV19.cancelJob',
    description: 'Cancel a queued or retrying job.',
    write: true,
    requiresAction: 'manage-fleet',
    params: ['jobId', 'reason'],
  },
  {
    name: 'fleetV19.killJob',
    description: 'Kill a running job (goes to dead-letter, no retry).',
    write: true,
    requiresAction: 'manage-fleet',
    params: ['jobId', 'reason'],
  },
  {
    name: 'fleetV19.requeueDeadJob',
    description: 'Requeue a dead-letter job (reset attempts).',
    write: true,
    requiresAction: 'manage-fleet',
    params: ['jobId'],
  },
  {
    name: 'fleetV19.pickNodeForJob',
    description: 'Pick the least-loaded eligible node for a job (labels, taints, resources).',
    write: false,
    requiresAction: 'view-fleet',
    params: ['job', 'nodes'],
  },
  {
    name: 'fleetV19.queueStats',
    description: 'Job queue statistics (depth by status/priority, waits, throughput, ETA).',
    write: false,
    requiresAction: 'view-fleet',
    params: [],
  },
  {
    name: 'fleetV19.jobQueuePanel',
    description: 'Build the job queue panel view-model (stats, next job + target node, retries, dead-letter).',
    write: false,
    requiresAction: 'view-fleet',
    params: ['queue', 'nodes'],
  },
  // Node status v19: transitions, staleness, pressure, ranking.
  {
    name: 'fleetV19.transitionNode',
    description: 'Transition a node lifecycle status (validated against the allowed-transition table).',
    write: true,
    requiresAction: 'manage-fleet',
    params: ['nodeId', 'to', 'reason'],
  },
  {
    name: 'fleetV19.nodePressure',
    description: 'Compute a node resource pressure (cpu/ram/disk/tasks utilization + level).',
    write: false,
    requiresAction: 'view-fleet',
    params: ['node', 'diskFreeMb'],
  },
  {
    name: 'fleetV19.rankNodes',
    description: 'Rank fleet nodes for placement (health + load + heartbeat freshness).',
    write: false,
    requiresAction: 'view-fleet',
    params: ['nodes', 'healthByNode'],
  },
  {
    name: 'fleetV19.statusSnapshot',
    description: 'Fleet status snapshot (counts by status/health/pressure/staleness, attention nodes).',
    write: false,
    requiresAction: 'view-fleet',
    params: ['nodes'],
  },
  {
    name: 'fleetV19.nodeStatusPanel',
    description: 'Build the node status panel view-model (node table, allowed transitions, attention).',
    write: false,
    requiresAction: 'view-fleet',
    params: ['nodes', 'pressureByNode', 'ranks'],
  },
  // Plugin SDK v4: manifest, lifecycle, dependencies, sandbox.
  {
    name: 'pluginV19.validateManifest',
    description: 'Validate a plugin SDK v4 manifest (id, semver, sdkVersion, capabilities, main path).',
    write: false,
    requiresAction: 'view-plugins',
    params: ['manifest'],
  },
  {
    name: 'pluginV19.checkManifestRegistry',
    description: 'Check a v4 manifest against the host capability registry (versions + permission coverage).',
    write: false,
    requiresAction: 'view-plugins',
    params: ['manifest', 'registry'],
  },
  {
    name: 'pluginV19.install',
    description: 'Install a plugin (validate manifest + registry, record installed state).',
    write: true,
    requiresAction: 'manage-plugins',
    params: ['manifest'],
  },
  {
    name: 'pluginV19.enable',
    description: 'Enable a plugin (dependencies must be present, version-matched and enabled).',
    write: true,
    requiresAction: 'manage-plugins',
    params: ['pluginId'],
  },
  {
    name: 'pluginV19.disable',
    description: 'Disable an enabled plugin (blocked when another enabled plugin depends on it).',
    write: true,
    requiresAction: 'manage-plugins',
    params: ['pluginId', 'reason'],
  },
  {
    name: 'pluginV19.uninstall',
    description: 'Uninstall a plugin (blocked when enabled or still depended on).',
    write: true,
    requiresAction: 'manage-plugins',
    params: ['pluginId', 'reason'],
  },
  {
    name: 'pluginV19.checkDependencies',
    description: 'Check a plugin dependencies (missing, version mismatch, cycle).',
    write: false,
    requiresAction: 'view-plugins',
    params: ['pluginId'],
  },
  {
    name: 'pluginV19.loadOrder',
    description: 'Resolve the load order of enabled plugins (dependencies first).',
    write: false,
    requiresAction: 'view-plugins',
    params: [],
  },
  {
    name: 'pluginV19.approvePermission',
    description: 'Approve a high-risk permission for a plugin (explicit user approval).',
    write: true,
    requiresAction: 'manage-plugins',
    params: ['pluginId', 'permission'],
  },
  {
    name: 'pluginV19.evaluatePermission',
    description: 'Evaluate a runtime permission request against manifest, registry and sandbox limits.',
    write: false,
    requiresAction: 'view-plugins',
    params: ['request'],
  },
  // Plugin store panel.
  {
    name: 'pluginStoreV19.panel',
    description: 'Build the plugin store panel view-model (lifecycle, capabilities, approvals, load order).',
    write: false,
    requiresAction: 'view-plugins',
    params: ['store'],
  },
  {
    name: 'pluginStoreV19.setSandboxLimits',
    description: 'Set sandbox limits for a plugin (allowed dirs, hosts, shell prefixes).',
    write: true,
    requiresAction: 'manage-plugins',
    params: ['pluginId', 'limits'],
  },
];

/** Tìm tool def theo tên (undefined = không có). */
export function findFleetV19Tool(name: string): FleetV19ToolDef | undefined {
  return FLEET_V19_TOOLS.find((t) => t.name === name);
}

/** true = mọi tool name là duy nhất. */
export function fleetV19ToolNamesUnique(): boolean {
  return new Set(FLEET_V19_TOOLS.map((t) => t.name)).size === FLEET_V19_TOOLS.length;
}
