/**
 * Fleet v25 tools (v1.38, Team T6) — registered in ALL_TOOLS (see tools.ts).
 *
 * Runnable tools for fleet v25 (pure definitions live in
 * `packages/core/src/fleetV25/toolsV25.ts` — 28 tools, 6 groups; this
 * file is the runnable version, wired to core via `@open-bot/core`):
 *
 * - `fleet_v25_roles` / `fleet_v25_check_permission` — roles +
 *   permission matrix + the single permission gate.
 * - `fleet_v25_user_*` — user directory: create/list/activate/
 *   set-role/disable/enable/set-scope/remove.
 * - `fleet_v25_audit_*` — audit log: query/verify/summary/export.
 * - `fleet_v25_schedule_*` — schedules v2: create/list/enable/
 *   disable/pause/resume/remove/next-runs/validate-cron.
 * - `fleet_v25_runs_*` — scheduled-run history: query/stats/stuck.
 * - `fleet_v25_engine_tick_dry_run` / `fleet_v25_dashboard` —
 *   scheduler preview + combined dashboard.
 *
 * Like fleet v24, this is a placeholder in ALL_TOOLS until the host
 * binds: `createFleetV25Tools(getState)` with the host's state
 * (user store + audit log + schedule registry + run ledger +
 * engine). Unbound, tools return a clear "not configured" message
 * instead of guessing state. Write tools need approval
 * (`needsApproval: true`) AND a permission check: every write tool
 * takes `actorId`, resolves the user, checks the role gate, and on
 * denial writes the denial to the audit log and returns an error.
 * Successful writes also append an audit entry. Tools never run a
 * model and never spawn a VM; the engine only dispatches through the
 * host's callback, and the dry-run tool dispatches nothing.
 */

import type { Tool } from '@open-bot/core';
import {
  FleetV25AuditLog,
  FleetV25AutomationEngine,
  FleetV25ScheduleRegistry,
  FleetV25ScheduledRunLedger,
  FleetV25UserStore,
  bootstrapFleetV25Admin,
  buildFleetV25Dashboard,
  buildFleetV25RolesPanel,
  buildFleetV25SchedulesPanel,
  canFleetV25UserAct,
  checkFleetV25Permission,
  createFleetV25AuditLog,
  createFleetV25ScheduleRegistry,
  createFleetV25ScheduledRunLedger,
  createFleetV25UserStore,
  describeFleetV25Cron,
  validateFleetV25Condition,
  validateFleetV25Cron,
} from '@open-bot/core';
import type {
  FleetV25Action,
  FleetV25AuditResourceType,
  FleetV25AuditResult,
  FleetV25Role,
  FleetV25RunCondition,
  FleetV25RunTrigger,
  FleetV25ScheduleKind,
  FleetV25ScheduledOutcome,
  FleetV25TickReport,
  FleetV25User,
} from '@open-bot/core';

/** State fleet v25 host provides for the tools (resolved lazily per call). */
export interface FleetV25ToolState {
  /** User directory (host holds 1 instance). */
  users: FleetV25UserStore;
  /** Audit log (host holds 1 instance). */
  audit: FleetV25AuditLog;
  /** Schedule registry (host holds 1 instance). */
  schedules: FleetV25ScheduleRegistry;
  /** Scheduled-run ledger (host holds 1 instance). */
  ledger: FleetV25ScheduledRunLedger;
  /** Scheduler engine (host holds 1 instance). */
  engine: FleetV25AutomationEngine;
  /** Last tick report (null = no tick has run yet). */
  lastTick: FleetV25TickReport | null;
}

export const FLEET_V25_TOOL_NAMES = [
  'fleet_v25_roles',
  'fleet_v25_check_permission',
  'fleet_v25_user_create',
  'fleet_v25_user_list',
  'fleet_v25_user_activate',
  'fleet_v25_user_set_role',
  'fleet_v25_user_disable',
  'fleet_v25_user_enable',
  'fleet_v25_user_set_scope',
  'fleet_v25_user_remove',
  'fleet_v25_audit_query',
  'fleet_v25_audit_verify',
  'fleet_v25_audit_summary',
  'fleet_v25_audit_export',
  'fleet_v25_schedule_create',
  'fleet_v25_schedule_list',
  'fleet_v25_schedule_enable',
  'fleet_v25_schedule_disable',
  'fleet_v25_schedule_pause',
  'fleet_v25_schedule_resume',
  'fleet_v25_schedule_remove',
  'fleet_v25_schedule_next_runs',
  'fleet_v25_schedule_validate_cron',
  'fleet_v25_runs_query',
  'fleet_v25_run_stats',
  'fleet_v25_runs_stuck',
  'fleet_v25_engine_tick_dry_run',
  'fleet_v25_dashboard',
] as const;

const NOT_WIRED =
  'Fleet v25 is not configured: the host has not wired fleet state (user store, audit log, schedule registry, run ledger, scheduler engine) into the v25 tools.';

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

function getOptionalStringArg(args: Record<string, unknown>, name: string): string | null {
  const value = args[name];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new Error(`Argument "${name}" must be a string, got ${typeof value}`);
  }
  return value.trim() ? value : null;
}

function getNumberArg(args: Record<string, unknown>, name: string, fallback: number): number {
  const value = args[name];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`Argument "${name}" must be a number >= 0.`);
  }
  return value;
}

function getBooleanArg(args: Record<string, unknown>, name: string, fallback = false): boolean {
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

/** Parse run conditions: an array of condition objects, or a JSON string of one. */
function getConditionsArg(args: Record<string, unknown>, name: string): FleetV25RunCondition[] {
  const value = args[name];
  if (value === undefined || value === null) return [];
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error(`Argument "${name}" must be an array of conditions or a JSON string of one.`);
    }
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`Argument "${name}" must be an array of run conditions.`);
  }
  const conditions = parsed as FleetV25RunCondition[];
  conditions.forEach((c, i) => {
    if (!c || typeof c !== 'object' || typeof (c as { type?: unknown }).type !== 'string') {
      throw new Error(`Condition[${i}] must be an object with a "type".`);
    }
    const problems = validateFleetV25Condition(c);
    if (problems.length > 0) {
      throw new Error(`Condition[${i}] invalid: ${problems.join(' ')}`);
    }
  });
  return conditions;
}

/** Build an empty state for hosts without their own state (tests + demo). */
export function createEmptyFleetV25ToolState(): FleetV25ToolState {
  const users = createFleetV25UserStore();
  const audit = createFleetV25AuditLog();
  const schedules = createFleetV25ScheduleRegistry();
  const ledger = createFleetV25ScheduledRunLedger();
  const engine = new FleetV25AutomationEngine(schedules, ledger, { auditLog: audit });
  // Bootstrap one active admin so the demo/test state is usable:
  // without any user, every write tool would (correctly) refuse.
  bootstrapFleetV25Admin(users, { id: 'admin', name: 'Fleet Admin', role: 'admin' }, Date.now());
  return { users, audit, schedules, ledger, engine, lastTick: null };
}

/** true when every runnable v25 tool name is unique. */
export function fleetV25ToolNamesUnique(): boolean {
  return new Set(FLEET_V25_TOOL_NAMES).size === FLEET_V25_TOOL_NAMES.length;
}

export function createFleetV25Tools(
  getState?: () => FleetV25ToolState | null | undefined,
): Tool[] {
  const resolveState = (): FleetV25ToolState | null => {
    try {
      return getState?.() ?? null;
    } catch {
      return null;
    }
  };

  const requireState = (): FleetV25ToolState => {
    const state = resolveState();
    if (!state) throw new Error(NOT_WIRED);
    return state;
  };

  const nowMs = (): number => Date.now();

  /** Resolve the acting user for a write tool (throws when unknown). */
  const requireActor = (state: FleetV25ToolState, args: Record<string, unknown>): FleetV25User => {
    const actorId = getStringArg(args, 'actorId');
    const user = state.users.get(actorId);
    if (!user) throw new Error(`Unknown actor "${actorId}": no such fleet user.`);
    return user;
  };

  /**
   * The permission gate for write tools: the actor must be active and
   * their role must hold `action` (and their scope must cover the
   * resource when given). On denial, the denial is written to the
   * audit log and an error is thrown — denials are evidence.
   */
  const requirePermission = (
    state: FleetV25ToolState,
    actor: FleetV25User,
    action: FleetV25Action,
    resource?: { tags?: string[]; owner?: string; automationId?: string },
    auditAction?: string,
    auditResourceType?: FleetV25AuditResourceType,
    auditResourceId?: string,
  ): void => {
    const decision = checkFleetV25Permission({
      role: actor.role,
      action,
      scope: actor.scope,
      resource,
    });
    const active = actor.status === 'active';
    if (!decision.allowed || !active) {
      const detail = !active
        ? `User "${actor.id}" is ${actor.status} and cannot act.`
        : decision.detail;
      try {
        state.audit.append(
          {
            actorId: actor.id,
            actorRole: actor.role,
            action: auditAction ?? `permission.denied:${action}`,
            resourceType: auditResourceType ?? 'fleet',
            resourceId: auditResourceId ?? actor.id,
            result: 'denied',
            detail,
          },
          nowMs(),
        );
      } catch {
        // Audit must never mask the denial itself.
      }
      throw new Error(`Permission denied: ${detail}`);
    }
  };

  /** Append a success audit entry for a write tool (best-effort). */
  const auditSuccess = (
    state: FleetV25ToolState,
    actor: FleetV25User,
    action: string,
    resourceType: FleetV25AuditResourceType,
    resourceId: string,
    detail: string,
  ): void => {
    try {
      state.audit.append(
        { actorId: actor.id, actorRole: actor.role, action, resourceType, resourceId, result: 'success', detail },
        nowMs(),
      );
    } catch {
      // Audit must never break the tool call.
    }
  };

  /** True when `actor` may perform `action` (read tools use this, no audit on denial). */
  const actorMay = (actor: FleetV25User, action: FleetV25Action): boolean =>
    canFleetV25UserAct(actor, action);

  const tools: Tool[] = [
    // -- roles + permission gate --------------------------------------------
    {
      definition: toolDef(
        'fleet_v25_roles',
        'Show the fleet v25 roles with the permission matrix and per-role action counts.',
        {},
        [],
      ),
      needsApproval: false,
      execute: async () => {
        try {
          requireState();
          return jsonResult(buildFleetV25RolesPanel());
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v25_check_permission',
        'Check whether a role may perform an action on a resource.',
        {
          role: { type: 'string' },
          action: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          owner: { type: 'string' },
          automationId: { type: 'string' },
        },
        ['role', 'action'],
      ),
      needsApproval: false,
      execute: async (args) => {
        try {
          requireState();
          const role = getStringArg(args, 'role') as FleetV25Role;
          const action = getStringArg(args, 'action') as FleetV25Action;
          return jsonResult(
            checkFleetV25Permission({
              role,
              action,
              resource: {
                tags: getStringArrayArg(args, 'tags'),
                owner: getOptionalStringArg(args, 'owner') ?? undefined,
                automationId: getOptionalStringArg(args, 'automationId') ?? undefined,
              },
            }),
          );
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    // -- users ----------------------------------------------------------------
    {
      definition: toolDef(
        'fleet_v25_user_create',
        'Invite a user to the fleet with a role and an optional resource scope.',
        {
          id: { type: 'string' },
          name: { type: 'string' },
          email: { type: 'string' },
          role: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          owners: { type: 'array', items: { type: 'string' } },
          automationIds: { type: 'array', items: { type: 'string' } },
          actorId: { type: 'string' },
        },
        ['id', 'name', 'role', 'actorId'],
      ),
      needsApproval: true,
      execute: async (args) => {
        try {
          const state = requireState();
          const actor = requireActor(state, args);
          requirePermission(state, actor, 'manage-users', undefined, 'user.create', 'user', getStringArg(args, 'id'));
          const user = state.users.create(
            {
              id: getStringArg(args, 'id'),
              name: getStringArg(args, 'name'),
              email: getOptionalStringArg(args, 'email'),
              role: getStringArg(args, 'role') as FleetV25Role,
              scope: {
                tags: getStringArrayArg(args, 'tags'),
                owners: getStringArrayArg(args, 'owners'),
                automationIds: getStringArrayArg(args, 'automationIds'),
              },
              createdBy: actor.id,
            },
            nowMs(),
          );
          auditSuccess(state, actor, 'user.create', 'user', user.id, `Invited user "${user.id}" as ${user.role}.`);
          return jsonResult(user);
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v25_user_list',
        'List fleet users, optionally filtered by role or status.',
        {
          role: { type: 'string' },
          status: { type: 'string' },
        },
        [],
      ),
      needsApproval: false,
      execute: async (args) => {
        try {
          const state = requireState();
          const role = getOptionalStringArg(args, 'role') as FleetV25Role | null;
          const status = getOptionalStringArg(args, 'status');
          let list = state.users.list();
          if (role) list = list.filter((u) => u.role === role);
          if (status) list = list.filter((u) => u.status === status);
          return jsonResult({ total: list.length, users: list, counts: state.users.counts() });
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v25_user_activate',
        'Activate an invited user so they can act with their role.',
        {
          id: { type: 'string' },
          actorId: { type: 'string' },
        },
        ['id', 'actorId'],
      ),
      needsApproval: true,
      execute: async (args) => {
        try {
          const state = requireState();
          const actor = requireActor(state, args);
          const id = getStringArg(args, 'id');
          requirePermission(state, actor, 'manage-users', undefined, 'user.activate', 'user', id);
          const user = state.users.activate(id, nowMs());
          auditSuccess(state, actor, 'user.activate', 'user', id, `Activated user "${id}".`);
          return jsonResult(user);
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v25_user_set_role',
        'Change a user role; demoting the last active admin is refused.',
        {
          id: { type: 'string' },
          role: { type: 'string' },
          actorId: { type: 'string' },
        },
        ['id', 'role', 'actorId'],
      ),
      needsApproval: true,
      execute: async (args) => {
        try {
          const state = requireState();
          const actor = requireActor(state, args);
          const id = getStringArg(args, 'id');
          requirePermission(state, actor, 'manage-roles', undefined, 'user.set-role', 'role', id);
          const user = state.users.setRole(id, getStringArg(args, 'role') as FleetV25Role, nowMs());
          auditSuccess(state, actor, 'user.set-role', 'role', id, `Set role of "${id}" to ${user.role}.`);
          return jsonResult(user);
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v25_user_disable',
        'Disable a user (keeps the record); disabling the last active admin is refused.',
        {
          id: { type: 'string' },
          note: { type: 'string' },
          actorId: { type: 'string' },
        },
        ['id', 'actorId'],
      ),
      needsApproval: true,
      execute: async (args) => {
        try {
          const state = requireState();
          const actor = requireActor(state, args);
          const id = getStringArg(args, 'id');
          requirePermission(state, actor, 'manage-users', undefined, 'user.disable', 'user', id);
          const user = state.users.disable(id, nowMs(), getOptionalStringArg(args, 'note'));
          auditSuccess(state, actor, 'user.disable', 'user', id, `Disabled user "${id}".`);
          return jsonResult(user);
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v25_user_enable',
        'Re-enable a disabled user.',
        {
          id: { type: 'string' },
          actorId: { type: 'string' },
        },
        ['id', 'actorId'],
      ),
      needsApproval: true,
      execute: async (args) => {
        try {
          const state = requireState();
          const actor = requireActor(state, args);
          const id = getStringArg(args, 'id');
          requirePermission(state, actor, 'manage-users', undefined, 'user.enable', 'user', id);
          const user = state.users.enable(id, nowMs());
          auditSuccess(state, actor, 'user.enable', 'user', id, `Enabled user "${id}".`);
          return jsonResult(user);
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v25_user_set_scope',
        'Replace a user resource scope (tags/owners/automation ids).',
        {
          id: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          owners: { type: 'array', items: { type: 'string' } },
          automationIds: { type: 'array', items: { type: 'string' } },
          actorId: { type: 'string' },
        },
        ['id', 'actorId'],
      ),
      needsApproval: true,
      execute: async (args) => {
        try {
          const state = requireState();
          const actor = requireActor(state, args);
          const id = getStringArg(args, 'id');
          requirePermission(state, actor, 'manage-users', undefined, 'user.set-scope', 'user', id);
          const user = state.users.setScope(
            id,
            {
              tags: getStringArrayArg(args, 'tags'),
              owners: getStringArrayArg(args, 'owners'),
              automationIds: getStringArrayArg(args, 'automationIds'),
            },
            nowMs(),
          );
          auditSuccess(state, actor, 'user.set-scope', 'user', id, `Set scope of "${id}".`);
          return jsonResult(user);
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v25_user_remove',
        'Remove a user permanently; removing the last active admin is refused.',
        {
          id: { type: 'string' },
          actorId: { type: 'string' },
        },
        ['id', 'actorId'],
      ),
      needsApproval: true,
      execute: async (args) => {
        try {
          const state = requireState();
          const actor = requireActor(state, args);
          const id = getStringArg(args, 'id');
          requirePermission(state, actor, 'manage-users', undefined, 'user.remove', 'user', id);
          const removed = state.users.remove(id);
          if (!removed) return errorResult(`User "${id}" does not exist.`);
          auditSuccess(state, actor, 'user.remove', 'user', id, `Removed user "${id}".`);
          return jsonResult({ removed: true, id });
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    // -- audit log -------------------------------------------------------------
    {
      definition: toolDef(
        'fleet_v25_audit_query',
        'Query the audit log by actor, action, resource, result or time window.',
        {
          actorId: { type: 'string' },
          action: { type: 'string' },
          actionPrefix: { type: 'string' },
          resourceType: { type: 'string' },
          resourceId: { type: 'string' },
          result: { type: 'string' },
          fromMs: { type: 'number' },
          toMs: { type: 'number' },
          limit: { type: 'number' },
          newestFirst: { type: 'boolean' },
        },
        [],
      ),
      needsApproval: false,
      execute: async (args) => {
        try {
          const state = requireState();
          const entries = state.audit.query({
            actorId: getOptionalStringArg(args, 'actorId') ?? undefined,
            action: getOptionalStringArg(args, 'action') ?? undefined,
            actionPrefix: getOptionalStringArg(args, 'actionPrefix') ?? undefined,
            resourceType: (getOptionalStringArg(args, 'resourceType') as FleetV25AuditResourceType | null) ?? undefined,
            resourceId: getOptionalStringArg(args, 'resourceId') ?? undefined,
            result: (getOptionalStringArg(args, 'result') as FleetV25AuditResult | null) ?? undefined,
            fromMs: args.fromMs === undefined ? undefined : getNumberArg(args, 'fromMs', 0),
            toMs: args.toMs === undefined ? undefined : getNumberArg(args, 'toMs', 0),
            limit: args.limit === undefined ? undefined : getNumberArg(args, 'limit', 100),
            newestFirst: getBooleanArg(args, 'newestFirst', false),
          });
          return jsonResult({ total: entries.length, entries });
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v25_audit_verify',
        'Verify the audit log hash chain.',
        {},
        [],
      ),
      needsApproval: false,
      execute: async () => {
        try {
          const state = requireState();
          return jsonResult(state.audit.verify());
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v25_audit_summary',
        'Summarise the audit log: totals by result, top actions and actors.',
        {},
        [],
      ),
      needsApproval: false,
      execute: async () => {
        try {
          const state = requireState();
          return jsonResult({ ...state.audit.summary(), chain: state.audit.verify() });
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v25_audit_export',
        'Export the audit log as JSONL (one entry per line); admin-only.',
        {
          limit: { type: 'number' },
          actorId: { type: 'string' },
        },
        ['actorId'],
      ),
      needsApproval: false,
      execute: async (args) => {
        try {
          const state = requireState();
          const actor = requireActor(state, args);
          if (!actorMay(actor, 'export-audit')) {
            return errorResult(`Permission denied: role "${actor.role}" cannot export the audit log (needs admin).`);
          }
          const limit = args.limit === undefined ? undefined : getNumberArg(args, 'limit', 1000);
          const entries = state.audit.query({ newestFirst: false, limit });
          return entries.map((e) => JSON.stringify(e)).join('\n');
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    // -- schedules v2 ----------------------------------------------------------
    {
      definition: toolDef(
        'fleet_v25_schedule_create',
        'Create a scheduled automation (cron, fixed interval, or one-shot) with run conditions and a retry policy.',
        {
          id: { type: 'string' },
          automationId: { type: 'string' },
          owner: { type: 'string' },
          name: { type: 'string' },
          kind: { type: 'string' },
          cron: { type: 'string' },
          intervalMs: { type: 'number' },
          runAtMs: { type: 'number' },
          timezone: { type: 'string' },
          conditions: { type: 'array', items: { type: 'object' } },
          maxRetries: { type: 'number' },
          backoffMs: { type: 'number' },
          actorId: { type: 'string' },
        },
        ['id', 'automationId', 'owner', 'name', 'kind', 'actorId'],
      ),
      needsApproval: true,
      execute: async (args) => {
        try {
          const state = requireState();
          const actor = requireActor(state, args);
          const id = getStringArg(args, 'id');
          const automationId = getStringArg(args, 'automationId');
          requirePermission(state, actor, 'manage-schedules', { automationId }, 'schedule.create', 'schedule', id);
          const schedule = state.schedules.create(
            {
              id,
              automationId,
              owner: getStringArg(args, 'owner'),
              name: getStringArg(args, 'name'),
              kind: getStringArg(args, 'kind') as FleetV25ScheduleKind,
              cron: getOptionalStringArg(args, 'cron'),
              intervalMs: args.intervalMs === undefined ? null : getNumberArg(args, 'intervalMs', 0),
              runAtMs: args.runAtMs === undefined ? null : getNumberArg(args, 'runAtMs', 0),
              timezone: getOptionalStringArg(args, 'timezone') ?? undefined,
              conditions: getConditionsArg(args, 'conditions'),
              retry: {
                ...(args.maxRetries === undefined ? {} : { maxRetries: getNumberArg(args, 'maxRetries', 0) }),
                ...(args.backoffMs === undefined ? {} : { backoffMs: getNumberArg(args, 'backoffMs', 60000) }),
              },
            },
            nowMs(),
          );
          auditSuccess(state, actor, 'schedule.create', 'schedule', id, `Created ${schedule.kind} schedule "${id}" for automation "${automationId}".`);
          return jsonResult(schedule);
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v25_schedule_list',
        'List schedules, optionally filtered by automation, owner or kind.',
        {
          automationId: { type: 'string' },
          owner: { type: 'string' },
          kind: { type: 'string' },
        },
        [],
      ),
      needsApproval: false,
      execute: async (args) => {
        try {
          const state = requireState();
          const automationId = getOptionalStringArg(args, 'automationId');
          const owner = getOptionalStringArg(args, 'owner');
          const kind = getOptionalStringArg(args, 'kind') as FleetV25ScheduleKind | null;
          let list = state.schedules.list();
          if (automationId) list = list.filter((s) => s.automationId === automationId);
          if (owner) list = list.filter((s) => s.owner === owner);
          if (kind) list = list.filter((s) => s.kind === kind);
          return jsonResult({ total: list.length, schedules: list, stats: state.schedules.stats() });
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v25_schedule_enable',
        'Enable a schedule (recomputes its next run).',
        {
          id: { type: 'string' },
          actorId: { type: 'string' },
        },
        ['id', 'actorId'],
      ),
      needsApproval: true,
      execute: async (args) => {
        try {
          const state = requireState();
          const actor = requireActor(state, args);
          const id = getStringArg(args, 'id');
          requirePermission(state, actor, 'manage-schedules', undefined, 'schedule.enable', 'schedule', id);
          const schedule = state.schedules.enable(id, nowMs());
          auditSuccess(state, actor, 'schedule.enable', 'schedule', id, `Enabled schedule "${id}".`);
          return jsonResult(schedule);
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v25_schedule_disable',
        'Disable a schedule (it never fires; clears any pending retry).',
        {
          id: { type: 'string' },
          actorId: { type: 'string' },
        },
        ['id', 'actorId'],
      ),
      needsApproval: true,
      execute: async (args) => {
        try {
          const state = requireState();
          const actor = requireActor(state, args);
          const id = getStringArg(args, 'id');
          requirePermission(state, actor, 'manage-schedules', undefined, 'schedule.disable', 'schedule', id);
          const schedule = state.schedules.disable(id, nowMs());
          auditSuccess(state, actor, 'schedule.disable', 'schedule', id, `Disabled schedule "${id}".`);
          return jsonResult(schedule);
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v25_schedule_pause',
        'Pause a schedule (it never fires while paused).',
        {
          id: { type: 'string' },
          actorId: { type: 'string' },
        },
        ['id', 'actorId'],
      ),
      needsApproval: true,
      execute: async (args) => {
        try {
          const state = requireState();
          const actor = requireActor(state, args);
          const id = getStringArg(args, 'id');
          requirePermission(state, actor, 'manage-schedules', undefined, 'schedule.pause', 'schedule', id);
          const schedule = state.schedules.pause(id, nowMs());
          auditSuccess(state, actor, 'schedule.pause', 'schedule', id, `Paused schedule "${id}".`);
          return jsonResult(schedule);
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v25_schedule_resume',
        'Resume a paused schedule (recomputes its next run from now).',
        {
          id: { type: 'string' },
          actorId: { type: 'string' },
        },
        ['id', 'actorId'],
      ),
      needsApproval: true,
      execute: async (args) => {
        try {
          const state = requireState();
          const actor = requireActor(state, args);
          const id = getStringArg(args, 'id');
          requirePermission(state, actor, 'manage-schedules', undefined, 'schedule.resume', 'schedule', id);
          const schedule = state.schedules.resume(id, nowMs());
          auditSuccess(state, actor, 'schedule.resume', 'schedule', id, `Resumed schedule "${id}".`);
          return jsonResult(schedule);
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v25_schedule_remove',
        'Remove a schedule permanently.',
        {
          id: { type: 'string' },
          actorId: { type: 'string' },
        },
        ['id', 'actorId'],
      ),
      needsApproval: true,
      execute: async (args) => {
        try {
          const state = requireState();
          const actor = requireActor(state, args);
          const id = getStringArg(args, 'id');
          requirePermission(state, actor, 'manage-schedules', undefined, 'schedule.remove', 'schedule', id);
          const removed = state.schedules.remove(id);
          if (!removed) return errorResult(`Schedule "${id}" does not exist.`);
          auditSuccess(state, actor, 'schedule.remove', 'schedule', id, `Removed schedule "${id}".`);
          return jsonResult({ removed: true, id });
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v25_schedule_next_runs',
        'Show the schedules due to fire next, with pending retries and failing schedules.',
        {
          limit: { type: 'number' },
        },
        [],
      ),
      needsApproval: false,
      execute: async (args) => {
        try {
          const state = requireState();
          const limit = getNumberArg(args, 'limit', 10);
          const panel = buildFleetV25SchedulesPanel(state.schedules, nowMs());
          return jsonResult({
            ...panel,
            schedules: panel.schedules.slice(0, limit),
            dueSoon: panel.dueSoon.slice(0, limit),
          });
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v25_schedule_validate_cron',
        'Validate a 5-field cron expression and show its normalised form and description.',
        {
          cron: { type: 'string' },
        },
        ['cron'],
      ),
      needsApproval: false,
      execute: async (args) => {
        try {
          requireState();
          const cron = getStringArg(args, 'cron');
          const validation = validateFleetV25Cron(cron);
          return jsonResult({
            cron,
            valid: validation.valid,
            problems: validation.problems,
            normalised: validation.expression?.text ?? null,
            description: validation.expression ? describeFleetV25Cron(validation.expression) : null,
          });
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    // -- scheduled runs ---------------------------------------------------------
    {
      definition: toolDef(
        'fleet_v25_runs_query',
        'Query scheduled runs by schedule, automation, owner, trigger, outcome or time window.',
        {
          scheduleId: { type: 'string' },
          automationId: { type: 'string' },
          owner: { type: 'string' },
          trigger: { type: 'string' },
          outcome: { type: 'string' },
          fromMs: { type: 'number' },
          toMs: { type: 'number' },
          limit: { type: 'number' },
          newestFirst: { type: 'boolean' },
        },
        [],
      ),
      needsApproval: false,
      execute: async (args) => {
        try {
          const state = requireState();
          const runs = state.ledger.query({
            scheduleId: getOptionalStringArg(args, 'scheduleId') ?? undefined,
            automationId: getOptionalStringArg(args, 'automationId') ?? undefined,
            owner: getOptionalStringArg(args, 'owner') ?? undefined,
            trigger: (getOptionalStringArg(args, 'trigger') as FleetV25RunTrigger | null) ?? undefined,
            outcome: (getOptionalStringArg(args, 'outcome') as FleetV25ScheduledOutcome | null) ?? undefined,
            fromMs: args.fromMs === undefined ? undefined : getNumberArg(args, 'fromMs', 0),
            toMs: args.toMs === undefined ? undefined : getNumberArg(args, 'toMs', 0),
            limit: args.limit === undefined ? undefined : getNumberArg(args, 'limit', 100),
            newestFirst: getBooleanArg(args, 'newestFirst', false),
          });
          return jsonResult({
            total: runs.length,
            runs,
            groups: state.ledger.groupSummaries().slice(0, 10),
          });
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v25_run_stats',
        'Per-schedule run stats or fleet-wide run stats.',
        {
          scheduleId: { type: 'string' },
        },
        [],
      ),
      needsApproval: false,
      execute: async (args) => {
        try {
          const state = requireState();
          const scheduleId = getOptionalStringArg(args, 'scheduleId');
          if (scheduleId) {
            return jsonResult(state.ledger.statsBySchedule(scheduleId));
          }
          return jsonResult({
            scope: 'fleet',
            total: state.ledger.size,
            countsByOutcome: state.ledger.countsByOutcome(),
            failureRate: state.ledger.failureRate(),
            timing: state.ledger.timing(),
            groups: state.ledger.groupSummaries().slice(0, 10),
          });
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v25_runs_stuck',
        'List scheduled runs stuck in flight past a max age.',
        {
          stuckAfterMs: { type: 'number' },
        },
        [],
      ),
      needsApproval: false,
      execute: async (args) => {
        try {
          const state = requireState();
          const stuckAfterMs = getNumberArg(args, 'stuckAfterMs', 30 * 60 * 1000);
          return jsonResult({
            stuckAfterMs,
            stuck: state.ledger.stuckRuns(nowMs(), stuckAfterMs),
          });
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    // -- engine preview + combined dashboard -------------------------------------
    {
      definition: toolDef(
        'fleet_v25_engine_tick_dry_run',
        'Preview what the scheduler engine would do now, without dispatching anything.',
        {},
        [],
      ),
      needsApproval: false,
      execute: async () => {
        try {
          const state = requireState();
          return jsonResult(state.engine.tickDryRun(nowMs()));
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      definition: toolDef(
        'fleet_v25_dashboard',
        'Build the combined fleet v25 dashboard (roles, users, audit, schedules, runs, last tick).',
        {},
        [],
      ),
      needsApproval: false,
      execute: async () => {
        try {
          const state = requireState();
          return jsonResult(
            buildFleetV25Dashboard(state.users, state.audit, state.schedules, state.ledger, nowMs(), state.lastTick),
          );
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
  ];

  return tools;
}

/** The runnable v25 tools, for ALL_TOOLS (unbound until the host wires state). */
export const FLEET_V25_TOOLS: Tool[] = createFleetV25Tools();
