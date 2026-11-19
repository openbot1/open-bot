/**
 * Tools v25 — pure definitions for fleet v25 (v1.38, Đội T6).
 *
 * Follows the `fleetV24/toolsV24.ts` pattern: a separate pure registry
 * (this file) that defines each tool (name, description, params, the
 * action it requires, whether it writes) — this module does NOT run
 * tools and does NOT register into the central registry. The runnable
 * tools live in `packages/tools/src/fleetV25Tools.ts`.
 *
 * Naming (snake_case, NO dots — v21/v22 broke `defaultToolFactory`
 * with dotted names, never again):
 * - `fleet_v25_roles` / `fleet_v25_check_permission` — roles +
 *   permission matrix + the single permission gate.
 * - `fleet_v25_user_*` — user directory: create/list/set-role/
 *   disable/enable/set-scope/remove.
 * - `fleet_v25_audit_*` — audit log: query/verify/summary/export.
 * - `fleet_v25_schedule_*` — schedules v2: create/list/enable/
 *   disable/pause/resume/remove/next-runs/validate-cron.
 * - `fleet_v25_runs_*` — scheduled-run history: query/stats/stuck.
 * - `fleet_v25_engine_tick_dry_run` / `fleet_v25_dashboard` —
 *   scheduler preview + combined dashboard.
 *
 * Every write tool needs approval (`write: true`) AND a permission
 * check: the runnable tool resolves the `actorId` to a user, checks
 * the role gate, and writes the denial to the audit log when the
 * check fails. The `requiresAction` here is the action string from
 * `roles.ts` (`FleetV25Action`).
 */

import type { FleetV25Action } from './roles';

/** Definition of one v25 tool (pure, JSON-able). */
export interface FleetV25ToolDef {
  /** Tool name, e.g. `fleet_v25_user_create`. */
  name: string;
  description: string;
  /** true = a write action (needs approval + an audit entry). */
  write: boolean;
  /** Action the caller's role must hold (see `roles.ts`). */
  requiresAction: FleetV25Action;
  /** Parameter names (for the UI form; no type validation here). */
  params: string[];
}

/** All v25 tools (pure definitions). */
export const FLEET_V25_TOOLS: readonly FleetV25ToolDef[] = [
  // Roles + permission gate.
  {
    name: 'fleet_v25_roles',
    description: 'Show the fleet v25 roles (admin/operator/viewer) with the permission matrix and per-role action counts.',
    write: false,
    requiresAction: 'view-fleet',
    params: [],
  },
  {
    name: 'fleet_v25_check_permission',
    description: 'Check whether a role may perform an action on a resource (optionally scope-restricted); returns the allow/deny decision with its reason.',
    write: false,
    requiresAction: 'view-fleet',
    params: ['role', 'action', 'tags', 'owner', 'automationId'],
  },
  // Users: create/list/set-role/disable/enable/set-scope/remove.
  {
    name: 'fleet_v25_user_create',
    description: 'Invite a user to the fleet with a role and an optional resource scope; invited users cannot act until activated.',
    write: true,
    requiresAction: 'manage-users',
    params: ['id', 'name', 'email', 'role', 'tags', 'owners', 'automationIds', 'actorId'],
  },
  {
    name: 'fleet_v25_user_list',
    description: 'List fleet users, optionally filtered by role or status.',
    write: false,
    requiresAction: 'view-fleet',
    params: ['role', 'status'],
  },
  {
    name: 'fleet_v25_user_activate',
    description: 'Activate an invited user so they can act with their role.',
    write: true,
    requiresAction: 'manage-users',
    params: ['id', 'actorId'],
  },
  {
    name: 'fleet_v25_user_set_role',
    description: 'Change a user role; demoting the last active admin is refused.',
    write: true,
    requiresAction: 'manage-roles',
    params: ['id', 'role', 'actorId'],
  },
  {
    name: 'fleet_v25_user_disable',
    description: 'Disable a user (keeps the record); disabling the last active admin is refused.',
    write: true,
    requiresAction: 'manage-users',
    params: ['id', 'note', 'actorId'],
  },
  {
    name: 'fleet_v25_user_enable',
    description: 'Re-enable a disabled user.',
    write: true,
    requiresAction: 'manage-users',
    params: ['id', 'actorId'],
  },
  {
    name: 'fleet_v25_user_set_scope',
    description: 'Replace a user resource scope (tags/owners/automation ids); an empty scope is unrestricted.',
    write: true,
    requiresAction: 'manage-users',
    params: ['id', 'tags', 'owners', 'automationIds', 'actorId'],
  },
  {
    name: 'fleet_v25_user_remove',
    description: 'Remove a user permanently; removing the last active admin is refused.',
    write: true,
    requiresAction: 'manage-users',
    params: ['id', 'actorId'],
  },
  // Audit log: query/verify/summary/export.
  {
    name: 'fleet_v25_audit_query',
    description: 'Query the audit log by actor, action (or action prefix), resource, result or time window, newest or oldest first.',
    write: false,
    requiresAction: 'view-audit',
    params: ['actorId', 'action', 'actionPrefix', 'resourceType', 'resourceId', 'result', 'fromMs', 'toMs', 'limit', 'newestFirst'],
  },
  {
    name: 'fleet_v25_audit_verify',
    description: 'Verify the audit log hash chain and report whether it is valid (and where it breaks when it is not).',
    write: false,
    requiresAction: 'view-audit',
    params: [],
  },
  {
    name: 'fleet_v25_audit_summary',
    description: 'Summarise the audit log: totals by result, top actions and actors, denied and failed counts.',
    write: false,
    requiresAction: 'view-audit',
    params: [],
  },
  {
    name: 'fleet_v25_audit_export',
    description: 'Export the audit log as JSONL (one entry per line) for external archiving; admin-only.',
    write: false,
    requiresAction: 'export-audit',
    params: ['limit'],
  },
  // Schedules v2: create/list/lifecycle/next-runs/validate-cron.
  {
    name: 'fleet_v25_schedule_create',
    description: 'Create a scheduled automation (cron, fixed interval, or one-shot) with run conditions and a retry policy.',
    write: true,
    requiresAction: 'manage-schedules',
    params: ['id', 'automationId', 'owner', 'name', 'kind', 'cron', 'intervalMs', 'runAtMs', 'timezone', 'conditions', 'maxRetries', 'backoffMs', 'actorId'],
  },
  {
    name: 'fleet_v25_schedule_list',
    description: 'List schedules, optionally filtered by automation, owner or kind.',
    write: false,
    requiresAction: 'view-fleet',
    params: ['automationId', 'owner', 'kind'],
  },
  {
    name: 'fleet_v25_schedule_enable',
    description: 'Enable a schedule (recomputes its next run).',
    write: true,
    requiresAction: 'manage-schedules',
    params: ['id', 'actorId'],
  },
  {
    name: 'fleet_v25_schedule_disable',
    description: 'Disable a schedule (it never fires; clears any pending retry).',
    write: true,
    requiresAction: 'manage-schedules',
    params: ['id', 'actorId'],
  },
  {
    name: 'fleet_v25_schedule_pause',
    description: 'Pause a schedule (it never fires while paused).',
    write: true,
    requiresAction: 'manage-schedules',
    params: ['id', 'actorId'],
  },
  {
    name: 'fleet_v25_schedule_resume',
    description: 'Resume a paused schedule (recomputes its next run from now).',
    write: true,
    requiresAction: 'manage-schedules',
    params: ['id', 'actorId'],
  },
  {
    name: 'fleet_v25_schedule_remove',
    description: 'Remove a schedule permanently.',
    write: true,
    requiresAction: 'manage-schedules',
    params: ['id', 'actorId'],
  },
  {
    name: 'fleet_v25_schedule_next_runs',
    description: 'Show the schedules due to fire next (live schedules ordered by next run time), with pending retries and failing schedules.',
    write: false,
    requiresAction: 'view-fleet',
    params: ['limit'],
  },
  {
    name: 'fleet_v25_schedule_validate_cron',
    description: 'Validate a 5-field cron expression and show its normalised form and description.',
    write: false,
    requiresAction: 'view-fleet',
    params: ['cron'],
  },
  // Scheduled runs: query/stats/stuck.
  {
    name: 'fleet_v25_runs_query',
    description: 'Query scheduled runs by schedule, automation, owner, trigger, outcome or time window; also lists retry groups.',
    write: false,
    requiresAction: 'view-fleet',
    params: ['scheduleId', 'automationId', 'owner', 'trigger', 'outcome', 'fromMs', 'toMs', 'limit', 'newestFirst'],
  },
  {
    name: 'fleet_v25_run_stats',
    description: 'Per-schedule run stats (totals, outcomes, failure rate, timing) or fleet-wide run stats.',
    write: false,
    requiresAction: 'view-fleet',
    params: ['scheduleId'],
  },
  {
    name: 'fleet_v25_runs_stuck',
    description: 'List scheduled runs stuck in flight past a max age.',
    write: false,
    requiresAction: 'view-fleet',
    params: ['stuckAfterMs'],
  },
  // Engine preview + combined dashboard.
  {
    name: 'fleet_v25_engine_tick_dry_run',
    description: 'Preview what the scheduler engine would do now (which schedules would fire, skip on conditions, or defer) without dispatching anything.',
    write: false,
    requiresAction: 'view-fleet',
    params: [],
  },
  {
    name: 'fleet_v25_dashboard',
    description: 'Build the combined fleet v25 dashboard: roles, users, audit log, schedules, scheduled runs and the last tick.',
    write: false,
    requiresAction: 'view-fleet',
    params: [],
  },
];

/** Find a v25 tool by name (undefined when absent). */
export function findFleetV25Tool(name: string): FleetV25ToolDef | undefined {
  return FLEET_V25_TOOLS.find((t) => t.name === name);
}

/** true when every v25 tool name is valid: unique, snake_case, no dots. */
export function fleetV25ToolNamesValid(): boolean {
  const seen = new Set<string>();
  for (const t of FLEET_V25_TOOLS) {
    if (t.name.includes('.')) return false;
    if (!/^[a-z][a-z0-9_]*$/.test(t.name)) return false;
    if (seen.has(t.name)) return false;
    seen.add(t.name);
  }
  return true;
}

/** v25 tools by name prefix (`fleet_v25`). */
export function fleetV25ToolsByGroup(prefix: string): FleetV25ToolDef[] {
  return FLEET_V25_TOOLS.filter((t) => t.name.startsWith(`${prefix}_`));
}

/** v25 tools that write (need approval + an audit entry). */
export function fleetV25WriteTools(): FleetV25ToolDef[] {
  return FLEET_V25_TOOLS.filter((t) => t.write);
}

/** v25 tools that only read. */
export function fleetV25ReadTools(): FleetV25ToolDef[] {
  return FLEET_V25_TOOLS.filter((t) => !t.write);
}

/** v25 tools requiring a given action. */
export function fleetV25ToolsRequiring(action: FleetV25Action): FleetV25ToolDef[] {
  return FLEET_V25_TOOLS.filter((t) => t.requiresAction === action);
}
