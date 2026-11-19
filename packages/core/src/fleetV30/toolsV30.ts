/**
 * Tools v30 — pure definitions for fleet v30 (v1.44, Team T6).
 *
 * Follows the `fleetV29/toolsV29.ts` pattern: a separate pure
 * registry (this file) that defines each tool (name, description,
 * params, whether it writes) — this module does NOT run tools and
 * does NOT register into the central registry. The runnable tools
 * live in `packages/tools/src/fleetV30Tools.ts`.
 *
 * Naming (snake_case, NO dots — v21/v22 broke `defaultToolFactory`
 * with dotted names, never again). Groups (36 tools):
 * - `fleet_v30_iso_*` — per-conversation isolation (bind/list/get/
 *   suspend/resume/end/orphans/usage/events).
 * - `fleet_v30_driver_*` — drivers (capabilities/select/command).
 * - `fleet_v30_board_*` — board v2 (view/reassign/priority/due/
 *   dependency/ready/overdue/retry/kanban/bulk).
 * - `fleet_v30_view_*` — saved board views (create/list/apply/delete).
 * - `fleet_v30_group_*` — peer groups (create/list/get/rename/
 *   delete/add-peer/remove-peer/score/pick/probe).
 * - `fleet_v30_admin_*` — admin policy (bootstrap/grant/revoke/
 *   rule-create/list/update/delete/preflight/approval-requests/events).
 * - `fleet_v30_quota_*` — per-profile quotas (set/get/list/check).
 * - `fleet_v30_snapshot_*` — host persistence (save/load).
 * - `fleet_v30_dashboard` — combined rollup.
 *
 * (60 tools, 9 groups.)
 * Write tools need approval (`write: true`). They never run a
 * model, never spawn a process, and never touch the network. A
 * `local`-driver binding is always labelled unisolated.
 */

/** Definition of one v30 tool (pure, JSON-able). */
export interface FleetV30ToolDef {
  /** Tool name, e.g. `fleet_v30_iso_bind`. */
  name: string;
  description: string;
  /** true = a write action (needs approval). */
  write: boolean;
  /** Parameter names (for the UI form; no type validation here). */
  params: string[];
}

/** All v30 tools (pure definitions). */
export const FLEET_V30_TOOLS: readonly FleetV30ToolDef[] = [
  // Per-conversation isolation.
  { name: 'fleet_v30_iso_bind', description: 'Bind a conversation to an isolated runtime (bwrap default, Docker when available, local fallback labelled unisolated).', write: true, params: ['conversationId', 'profileId', 'botId', 'driverKind', 'networkMode', 'workspaceRoot', 'allowLocalFallback'] },
  { name: 'fleet_v30_iso_list', description: 'List isolation bindings, optionally filtered by status or profile.', write: false, params: ['status', 'profileId'] },
  { name: 'fleet_v30_iso_get', description: 'Show one isolation binding (driver, workspace, network mode, status).', write: false, params: ['conversationId'] },
  { name: 'fleet_v30_iso_suspend', description: 'Suspend an isolation binding (runtime stopped, workspace kept).', write: true, params: ['conversationId', 'reason'] },
  { name: 'fleet_v30_iso_resume', description: 'Resume a suspended isolation binding (runtime restarted).', write: true, params: ['conversationId'] },
  { name: 'fleet_v30_iso_end', description: 'End a conversation: stop its runtime and list scratch paths for wiping.', write: true, params: ['conversationId', 'reason'] },
  { name: 'fleet_v30_iso_orphans', description: 'Clean up orphaned bindings whose v28 runtime vanished without cleanup.', write: true, params: [] },
  { name: 'fleet_v30_iso_sweep_evicted', description: 'Suspend active bindings whose v28 runtime was evicted (idle) or failed (workspace kept, resumable).', write: true, params: [] },
  { name: 'fleet_v30_iso_usage', description: 'Aggregate resource usage across active isolation bindings.', write: false, params: [] },
  { name: 'fleet_v30_iso_events', description: 'List isolation audit events, optionally for one conversation.', write: false, params: ['conversationId', 'limit'] },
  // Drivers.
  { name: 'fleet_v30_driver_capabilities', description: 'Show the capability matrix for every isolation driver (bwrap, docker, local).', write: false, params: [] },
  { name: 'fleet_v30_driver_select', description: 'Select the best available isolation driver for a network mode (preferred kind first, local only as fallback).', write: false, params: ['preferred', 'networkMode', 'allowLocalFallback'] },
  { name: 'fleet_v30_driver_command', description: 'Build the driver argv for one command (bwrap/docker/local) without running it.', write: false, params: ['driverKind', 'command', 'args', 'cwd', 'workspaceRoot', 'networkMode', 'cpuCores', 'ramMB'] },
  // Board v2.
  { name: 'fleet_v30_board_view', description: 'Show one board v2 task (v29 task + priority, deadline, SLA, dependencies, timeline).', write: false, params: ['taskId'] },
  { name: 'fleet_v30_board_reassign', description: 'Reassign a submitted task to another peer (v29 delegation gate re-runs for the new peer).', write: true, params: ['taskId', 'newPeerId', 'actor'] },
  { name: 'fleet_v30_board_priority', description: 'Set a board v2 task priority (low/normal/high/urgent).', write: true, params: ['taskId', 'priority', 'actor'] },
  { name: 'fleet_v30_board_due', description: 'Set or clear a board v2 task deadline and SLA budget.', write: true, params: ['taskId', 'dueAt', 'slaMinutes', 'actor'] },
  { name: 'fleet_v30_board_depend', description: 'Add a dependency: one task waits for another (cycles refused).', write: true, params: ['taskId', 'blockerId', 'actor'] },
  { name: 'fleet_v30_board_undepend', description: 'Remove a dependency between two tasks.', write: true, params: ['taskId', 'blockerId', 'actor'] },
  { name: 'fleet_v30_board_ready', description: 'List submitted tasks that are unblocked and ready to start.', write: false, params: [] },
  { name: 'fleet_v30_board_overdue', description: 'Sweep overdue tasks (flag missed deadlines, escalate SLA breaches).', write: true, params: ['actor'] },
  { name: 'fleet_v30_board_retry', description: 'Retry a failed task within its retry budget (re-runs the delegation gate).', write: true, params: ['taskId', 'actor'] },
  { name: 'fleet_v30_board_kanban', description: 'Show the board v2 kanban (tasks grouped by configurable columns).', write: false, params: [] },
  { name: 'fleet_v30_board_export', description: 'Export the board v2 as newline-delimited JSON (task + priority, deadline, SLA, dependencies; no prompt text).', write: false, params: ['state'] },
  { name: 'fleet_v30_board_bulk_cancel', description: 'Cancel many board tasks at once (per-task reasons for refusals).', write: true, params: ['taskIds', 'byUser', 'reason'] },
  { name: 'fleet_v30_board_bulk_reassign', description: 'Reassign many submitted tasks to one peer (per-task gate).', write: true, params: ['taskIds', 'newPeerId', 'actor'] },
  // Saved views.
  { name: 'fleet_v30_view_create', description: 'Create a saved board view (named filter preset).', write: true, params: ['name', 'createdBy', 'peerId', 'state', 'priority', 'query', 'activeOnly', 'overdueOnly', 'groupId'] },
  { name: 'fleet_v30_view_list', description: 'List saved board views.', write: false, params: [] },
  { name: 'fleet_v30_view_apply', description: 'Apply a saved board view and list the matching tasks.', write: false, params: ['viewId'] },
  { name: 'fleet_v30_view_delete', description: 'Delete a saved board view.', write: true, params: ['viewId'] },
  // Peer groups.
  { name: 'fleet_v30_group_create', description: 'Create a peer group (named set of peers).', write: true, params: ['name', 'createdBy', 'description', 'defaultMaxConcurrent'] },
  { name: 'fleet_v30_group_list', description: 'List peer groups with their members.', write: false, params: [] },
  { name: 'fleet_v30_group_get', description: 'Show one peer group with member health.', write: false, params: ['groupId'] },
  { name: 'fleet_v30_group_rename', description: 'Rename a peer group.', write: true, params: ['groupId', 'name'] },
  { name: 'fleet_v30_group_delete', description: 'Delete a peer group (members keep their peers, group tags removed).', write: true, params: ['groupId'] },
  { name: 'fleet_v30_group_add_peer', description: 'Add a registered peer to a group.', write: true, params: ['groupId', 'peerId'] },
  { name: 'fleet_v30_group_remove_peer', description: 'Remove a peer from a group.', write: true, params: ['groupId', 'peerId'] },
  { name: 'fleet_v30_group_score', description: 'Score candidate peers for a task requirement (skills, health, capacity, latency).', write: false, params: ['requiredSkills', 'latencyBudgetMs', 'streamingRequired', 'groupId', 'excludePeerIds'] },
  { name: 'fleet_v30_group_pick', description: 'Pick the best peer for a task requirement (load-balanced, failover-aware).', write: false, params: ['requiredSkills', 'latencyBudgetMs', 'streamingRequired', 'groupId', 'excludePeerIds'] },
  { name: 'fleet_v30_group_probe', description: 'Record a discovery probe for a peer endpoint (feeds health scoring).', write: true, params: ['peerId', 'endpoint', 'reachable', 'latencyMs', 'error'] },
  // Admin policy.
  { name: 'fleet_v30_admin_bootstrap', description: 'Bootstrap the first admin (host calls once with the local user id).', write: true, params: ['userId'] },
  { name: 'fleet_v30_admin_list', description: 'List admins and their roles.', write: false, params: [] },
  { name: 'fleet_v30_admin_grant', description: 'Grant a role to a user (admin only).', write: true, params: ['granterId', 'userId', 'role'] },
  { name: 'fleet_v30_admin_revoke', description: 'Revoke a user role (admin only; cannot revoke the last admin).', write: true, params: ['revokerId', 'userId'] },
  { name: 'fleet_v30_admin_rule_create', description: 'Create a policy rule (time window, runtime kinds, task types, caps, approval requirement).', write: true, params: ['actor', 'name', 'taskTypes', 'runtimeKinds', 'peerIds', 'startHour', 'endHour', 'days', 'maxCostUsdPerTask', 'maxConcurrentTasks', 'requiresApprovalFor', 'enabled'] },
  { name: 'fleet_v30_admin_rule_list', description: 'List policy rules.', write: false, params: [] },
  { name: 'fleet_v30_admin_rule_update', description: 'Update a policy rule (creator or admin).', write: true, params: ['actor', 'ruleId', 'name', 'enabled', 'maxCostUsdPerTask', 'maxConcurrentTasks'] },
  { name: 'fleet_v30_admin_rule_delete', description: 'Delete a policy rule (admin only).', write: true, params: ['actor', 'ruleId'] },
  { name: 'fleet_v30_admin_preflight', description: 'Run the pre-flight permission check before executing work (allowlist + card + runtime + policy + cost).', write: false, params: ['actor', 'peerId', 'taskType', 'runtimeKind', 'estimatedCostUsd', 'conversationId', 'activeTasksForPeer'] },
  { name: 'fleet_v30_admin_approval_request', description: 'Request approval for out-of-scope work (operator+).', write: true, params: ['requestedBy', 'peerId', 'taskType', 'summary', 'expiresAt'] },
  { name: 'fleet_v30_admin_approval_decide', description: 'Approve or deny an approval request (admin only).', write: true, params: ['decidedBy', 'requestId', 'approve', 'reason'] },
  { name: 'fleet_v30_admin_approval_list', description: 'List approval requests, optionally filtered by status.', write: false, params: ['status'] },
  { name: 'fleet_v30_admin_events', description: 'List admin audit events.', write: false, params: ['limit'] },
  // Per-profile quotas.
  { name: 'fleet_v30_quota_set', description: 'Set (or replace) a profile fleet quota (max bindings, CPU, RAM, disk caps).', write: true, params: ['profileId', 'setBy', 'maxBindings', 'maxCpuCores', 'maxRamMB', 'maxDiskMB'] },
  { name: 'fleet_v30_quota_get', description: 'Show one profile quota with its live usage and over-quota flags.', write: false, params: ['profileId'] },
  { name: 'fleet_v30_quota_list', description: 'List all profile quotas.', write: false, params: [] },
  { name: 'fleet_v30_quota_check', description: 'Check whether one more bind with given limits fits a profile quota (admission check).', write: false, params: ['profileId', 'cpuCores', 'ramMB', 'diskMB'] },
  // Snapshot (host persistence).
  { name: 'fleet_v30_snapshot_save', description: 'Save the fleet v30 snapshot (groups, views, kanban, rules, admins, approvals, binding descriptors) as JSON.', write: false, params: [] },
  { name: 'fleet_v30_snapshot_load', description: 'Load a fleet v30 snapshot JSON into fresh stores (live bindings are not restored — the host re-binds).', write: true, params: ['snapshotJson', 'restoredBy'] },
  // Rollup.
  { name: 'fleet_v30_dashboard', description: 'Combined fleet v30 dashboard (isolation + board v2 + peer groups + admin).', write: false, params: [] },
];

/** Names of all v30 tools. */
export const FLEET_V30_TOOL_NAMES: readonly string[] = FLEET_V30_TOOLS.map((t) => t.name);

/** Find one v30 tool definition by name. */
export function findFleetV30Tool(name: string): FleetV30ToolDef | null {
  return FLEET_V30_TOOLS.find((t) => t.name === name) ?? null;
}

/** true when every v30 tool name is unique. */
export function fleetV30ToolNamesUnique(): boolean {
  return new Set(FLEET_V30_TOOL_NAMES).size === FLEET_V30_TOOL_NAMES.length;
}

/** true when every v30 tool name is snake_case with no dots. */
export function fleetV30ToolNamesValid(): boolean {
  return FLEET_V30_TOOLS.every((t) => /^[a-z][a-z0-9_]*$/.test(t.name) && !t.name.includes('.'));
}

/** Read-only (no approval) v30 tools. */
export function fleetV30ReadTools(): FleetV30ToolDef[] {
  return FLEET_V30_TOOLS.filter((t) => !t.write);
}

/** Write (approval-needed) v30 tools. */
export function fleetV30WriteTools(): FleetV30ToolDef[] {
  return FLEET_V30_TOOLS.filter((t) => t.write);
}

/** v30 tools grouped by area (iso / driver / board / view / group / admin / quota / snapshot / health). */
export function fleetV30ToolsByGroup(): Record<string, FleetV30ToolDef[]> {
  const groups: Record<string, FleetV30ToolDef[]> = {
    iso: [],
    driver: [],
    board: [],
    view: [],
    group: [],
    admin: [],
    quota: [],
    snapshot: [],
    health: [],
  };
  for (const tool of FLEET_V30_TOOLS) {
    if (tool.name.startsWith('fleet_v30_iso_')) groups['iso']?.push(tool);
    else if (tool.name.startsWith('fleet_v30_driver_')) groups['driver']?.push(tool);
    else if (tool.name.startsWith('fleet_v30_board_')) groups['board']?.push(tool);
    else if (tool.name.startsWith('fleet_v30_view_')) groups['view']?.push(tool);
    else if (tool.name.startsWith('fleet_v30_group_')) groups['group']?.push(tool);
    else if (tool.name.startsWith('fleet_v30_admin_')) groups['admin']?.push(tool);
    else if (tool.name.startsWith('fleet_v30_quota_')) groups['quota']?.push(tool);
    else if (tool.name.startsWith('fleet_v30_snapshot_')) groups['snapshot']?.push(tool);
    else groups['health']?.push(tool);
  }
  return groups;
}
