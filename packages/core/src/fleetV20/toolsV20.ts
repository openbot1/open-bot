/**
 * Tools v20 — định nghĩa tool riêng của platform/fleet v20
 * (v1.33, Đội T6).
 *
 * Theo pattern tools v19 (`fleetV19/toolsV19.ts`): registry riêng của
 * đội T6 (không sửa registry trung tâm của các đội khác): mỗi tool là
 * một định nghĩa thuần (tên, mô tả, params, cần quyền gì, có ghi hay
 * không) để agent loop / UI gọi qua các hàm core ở `fleetV20/` —
 * module này KHÔNG tự đăng ký vào registry trung tâm, KHÔNG chạy tool.
 * Coordinator gộp sẽ quyết định có merge các def này vào registry
 * trung tâm hay không; số đếm tool được pin trong test của đội
 * (`tests/fleet-v133-t6.test.mjs`).
 *
 * Quy ước tên: `subagentV20.*` cho subagent chuyên biệt + context cô
 * lập, `pluginV20.*` cho plugin manager, `hookV20.*` cho hook manager,
 * `evalV20.*` cho eval harness.
 * Tool ghi (write: true) luôn cần duyệt trước khi chạy thật.
 */

/** Định nghĩa một tool v20 (thuần, JSON-able). */
export interface FleetV20ToolDef {
  /** Tên tool, vd `pluginV20.enable`. */
  name: string;
  description: string;
  /** true = hành động ghi (cần duyệt + ghi audit). */
  write: boolean;
  /** Quyền team cần có (xem `multiUserV13.ts` TEAM_V13_ACTIONS). */
  requiresAction: string;
  /** Tên param (để UI render form, không validate kiểu ở đây). */
  params: string[];
}

/** Toàn bộ tool v20 (định nghĩa thuần). */
export const FLEET_V20_TOOLS: readonly FleetV20ToolDef[] = [
  // Subagent chuyên biệt v20: spawn explore/plan/verify + context cô lập.
  {
    name: 'subagentV20.spawnExplore',
    description: 'Spawn an explore specialized subagent (read-only, cheap model) to research code/docs/web and return sourced findings.',
    write: false,
    requiresAction: 'run-subagent',
    params: ['task', 'sharedFacts', 'modelTier'],
  },
  {
    name: 'subagentV20.spawnPlan',
    description: 'Spawn a plan specialized subagent (read-only) to research the codebase and return a validated step-by-step plan.',
    write: false,
    requiresAction: 'run-subagent',
    params: ['task', 'sharedFacts', 'modelTier'],
  },
  {
    name: 'subagentV20.spawnVerify',
    description: 'Spawn a verify specialized subagent (read + run tests, never edits files) to check a diff and return an evidenced pass/fail verdict.',
    write: false,
    requiresAction: 'run-subagent',
    params: ['task', 'diff', 'modelTier'],
  },
  {
    name: 'subagentV20.planSpawns',
    description: 'Plan parallel specialized-subagent spawns into waves (topological levels, capped by maxParallel).',
    write: false,
    requiresAction: 'run-subagent',
    params: ['requests', 'maxParallel'],
  },
  {
    name: 'subagentV20.validateOutput',
    description: 'Validate a specialized subagent structured output (explore findings / plan / verify verdict) against its schema.',
    write: false,
    requiresAction: 'run-subagent',
    params: ['kind', 'output'],
  },
  {
    name: 'subagentV20.poolStatus',
    description: 'Show the specialized-subagent context pool status (running count, per-kind counts, rejected-full count).',
    write: false,
    requiresAction: 'view-fleet',
    params: [],
  },
  // Plugin manager v20: lifecycle + quyền + dependency.
  {
    name: 'pluginV20.list',
    description: 'List plugins with search/filter (status, capability, unapproved dangerous permissions, dependency problems).',
    write: false,
    requiresAction: 'view-plugins',
    params: ['query', 'status', 'capability'],
  },
  {
    name: 'pluginV20.install',
    description: 'Install a plugin (checks host version compat and dependencies; installed but not yet enabled).',
    write: true,
    requiresAction: 'manage-plugins',
    params: ['pluginId'],
  },
  {
    name: 'pluginV20.enable',
    description: 'Enable an installed plugin (blocked until all dangerous permissions are approved and dependencies are satisfied).',
    write: true,
    requiresAction: 'manage-plugins',
    params: ['pluginId'],
  },
  {
    name: 'pluginV20.disable',
    description: 'Disable an enabled plugin (blocked when another enabled plugin depends on it).',
    write: true,
    requiresAction: 'manage-plugins',
    params: ['pluginId'],
  },
  {
    name: 'pluginV20.uninstall',
    description: 'Uninstall a plugin (must be disabled first; blocked when another enabled plugin depends on it).',
    write: true,
    requiresAction: 'manage-plugins',
    params: ['pluginId'],
  },
  {
    name: 'pluginV20.approvePermission',
    description: 'Approve one dangerous permission of a plugin (user action in the Plugin panel).',
    write: true,
    requiresAction: 'manage-plugins',
    params: ['pluginId', 'permissionName'],
  },
  {
    name: 'pluginV20.summary',
    description: 'Summarize the plugin store (enabled/total, errors, unapproved dangerous permissions, dependency problems).',
    write: false,
    requiresAction: 'view-plugins',
    params: [],
  },
  // Hook manager v20: đăng ký/bật/tắt + log chặn.
  {
    name: 'hookV20.register',
    description: 'Register a hook for an event pattern (exact, prefix.* or *), with blocking flag, priority and timeout.',
    write: true,
    requiresAction: 'manage-hooks',
    params: ['hook'],
  },
  {
    name: 'hookV20.unregister',
    description: 'Unregister a hook by id (its run/block logs are kept).',
    write: true,
    requiresAction: 'manage-hooks',
    params: ['hookId'],
  },
  {
    name: 'hookV20.enable',
    description: 'Enable a hook (blocked while the hook is in error state; reset the error first).',
    write: true,
    requiresAction: 'manage-hooks',
    params: ['hookId'],
  },
  {
    name: 'hookV20.disable',
    description: 'Disable a hook (matched hooks skip disabled ones; logs are kept).',
    write: true,
    requiresAction: 'manage-hooks',
    params: ['hookId'],
  },
  {
    name: 'hookV20.resetError',
    description: 'Reset a hook error state after fixing the cause (clears consecutive errors and re-enables).',
    write: true,
    requiresAction: 'manage-hooks',
    params: ['hookId'],
  },
  {
    name: 'hookV20.match',
    description: 'List hooks that run for an event, in execution order (priority, then id).',
    write: false,
    requiresAction: 'view-hooks',
    params: ['event'],
  },
  {
    name: 'hookV20.blockLog',
    description: 'Query the hook run log (newest first), optionally blocked-only or per hook/event.',
    write: false,
    requiresAction: 'view-hooks',
    params: ['hookId', 'event', 'blockedOnly', 'limit'],
  },
  {
    name: 'hookV20.summary',
    description: 'Summarize the hook store (enabled/total, blocking hooks, errored hooks, total runs/blocks).',
    write: false,
    requiresAction: 'view-hooks',
    params: [],
  },
  // Eval harness v20: chạy eval + báo cáo + hồi quy.
  {
    name: 'evalV20.report',
    description: 'Build an eval report (% resolved over completed tasks, cost/task, per-category breakdown, pending/retryable tasks).',
    write: false,
    requiresAction: 'view-eval',
    params: ['runId'],
  },
  {
    name: 'evalV20.recordResult',
    description: 'Record one task result into an eval run (verdict must match its evidence: resolved requires all tests passed).',
    write: true,
    requiresAction: 'run-eval',
    params: ['runId', 'result'],
  },
  {
    name: 'evalV20.compareBaseline',
    description: 'Compare an eval run with a baseline run (resolved delta, cost delta, newly failed/resolved tasks, regression verdict).',
    write: false,
    requiresAction: 'view-eval',
    params: ['runId', 'baselineRunId'],
  },
  {
    name: 'evalV20.retryableTasks',
    description: 'List eval tasks worth re-running (failed/timeout/error; resolved tasks are not re-run blindly).',
    write: false,
    requiresAction: 'view-eval',
    params: ['runId'],
  },
];

/** Tìm tool v20 theo tên; không có → undefined (không throw). */
export function findFleetV20Tool(name: string): FleetV20ToolDef | undefined {
  return FLEET_V20_TOOLS.find((t) => t.name === name);
}

/** true khi mọi tên tool v20 là duy nhất. */
export function fleetV20ToolNamesUnique(): boolean {
  return new Set(FLEET_V20_TOOLS.map((t) => t.name)).size === FLEET_V20_TOOLS.length;
}

/** Tool ghi của v20 (cần duyệt + audit khi chạy thật). */
export function fleetV20WriteTools(): FleetV20ToolDef[] {
  return FLEET_V20_TOOLS.filter((t) => t.write);
}

/** Tool v20 theo tiền tố nhóm (`subagentV20` / `pluginV20` / `hookV20` / `evalV20`). */
export function fleetV20ToolsByGroup(group: 'subagentV20' | 'pluginV20' | 'hookV20' | 'evalV20'): FleetV20ToolDef[] {
  return FLEET_V20_TOOLS.filter((t) => t.name.startsWith(`${group}.`));
}
