/**
 * Roles + permissions v25 — multi-user roles for the fleet (v1.38, Đội T6).
 *
 * Fleet v25 adds the multi-user layer on top of the fleet v24 dashboard:
 * three roles — `admin`, `operator`, `viewer` — with a fixed permission
 * matrix, a role hierarchy, and resource scoping. This module is the pure
 * core: no I/O, no store, no rendering — the user store lives in
 * `users.ts`, the permission check that tools call lives here so every
 * sensitive action goes through one gate.
 *
 * Concepts:
 * - `FleetV25Role` — one of three roles. `admin` can do everything
 *   (including user/role management and audit export); `operator` runs
 *   the fleet day to day (run bots, manage schedules and automations,
 *   acknowledge stop-hook feedback) but cannot touch users, roles or
 *   the audit log's retention; `viewer` reads everything but writes
 *   nothing.
 * - `FleetV25Action` — a named capability (aligned with the
 *   `requiresAction` strings the v22–v24 tool defs already use, so
 *   existing tools keep working: `view-fleet`, `run-bot`,
 *   `manage-fleet`).
 * - `FleetV25Scope` — an optional resource scope on a user: when set,
 *   the user may only act on resources matching the scope (tags,
 *   owners, automation ids). Admins are never scoped down by accident:
 *   a scope on an admin still applies — scope is a restriction, not a
 *   grant — but `manage-users` / `manage-roles` ignore scope because
 *   they are fleet-wide by nature.
 * - `checkFleetV25Permission` — the single gate. It returns a decision
 *   object (`allowed` + `reason`) instead of throwing, so the caller
 *   (tool, UI, engine) can record the denial in the audit log
 *   (`auditLog.ts`) instead of losing it in an exception.
 *
 * Nothing here re-pins global counters and nothing here touches the
 * network: it is a data structure with rules.
 */

/** The three fleet roles, lowest privilege first. */
export type FleetV25Role = 'admin' | 'operator' | 'viewer';

/** All roles, lowest privilege first (display + rank order). */
export const FLEET_V25_ROLES: readonly FleetV25Role[] = ['viewer', 'operator', 'admin'];

/** Rank of a role: higher number = more privilege. */
export const FLEET_V25_ROLE_RANK: Readonly<Record<FleetV25Role, number>> = {
  viewer: 1,
  operator: 2,
  admin: 3,
};

/** A named capability that a role may or may not hold. */
export type FleetV25Action =
  | 'view-fleet'
  | 'view-audit'
  | 'run-bot'
  | 'run-schedule'
  | 'acknowledge-stop'
  | 'manage-fleet'
  | 'manage-automations'
  | 'manage-schedules'
  | 'manage-cidr'
  | 'manage-users'
  | 'manage-roles'
  | 'manage-audit'
  | 'export-audit';

/** All actions, grouped: reads first, then writes, then admin-only. */
export const FLEET_V25_ACTIONS: readonly FleetV25Action[] = [
  'view-fleet',
  'view-audit',
  'run-bot',
  'run-schedule',
  'acknowledge-stop',
  'manage-fleet',
  'manage-automations',
  'manage-schedules',
  'manage-cidr',
  'manage-users',
  'manage-roles',
  'manage-audit',
  'export-audit',
];

/** Actions that only ever make sense fleet-wide (scope never applies). */
export const FLEET_V25_FLEET_WIDE_ACTIONS: readonly FleetV25Action[] = [
  'manage-users',
  'manage-roles',
  'manage-audit',
  'export-audit',
];

/** Actions that write state (need approval in tools, need an audit entry). */
export const FLEET_V25_WRITE_ACTIONS: readonly FleetV25Action[] = [
  'run-bot',
  'run-schedule',
  'acknowledge-stop',
  'manage-fleet',
  'manage-automations',
  'manage-schedules',
  'manage-cidr',
  'manage-users',
  'manage-roles',
  'manage-audit',
  'export-audit',
];

/** Actions that only read state. */
export const FLEET_V25_READ_ACTIONS: readonly FleetV25Action[] = [
  'view-fleet',
  'view-audit',
];

/**
 * Permission matrix: which actions each role holds. The matrix is the
 * source of truth — `roleCan` and `FLEET_V25_ACTION_MIN_ROLE` are
 * derived from it, so the matrix and the helpers can never drift apart.
 */
export const FLEET_V25_ROLE_PERMISSIONS: Readonly<Record<FleetV25Role, readonly FleetV25Action[]>> = {
  viewer: ['view-fleet', 'view-audit'],
  operator: [
    'view-fleet',
    'view-audit',
    'run-bot',
    'run-schedule',
    'acknowledge-stop',
    'manage-fleet',
    'manage-automations',
    'manage-schedules',
    'manage-cidr',
  ],
  admin: [
    'view-fleet',
    'view-audit',
    'run-bot',
    'run-schedule',
    'acknowledge-stop',
    'manage-fleet',
    'manage-automations',
    'manage-schedules',
    'manage-cidr',
    'manage-users',
    'manage-roles',
    'manage-audit',
    'export-audit',
  ],
};

/**
 * Minimum role that holds each action, derived from the matrix (lowest
 * rank first). Useful for UI badges ("needs operator") and for the
 * `requiresAction` strings in `toolsV25.ts`.
 */
export const FLEET_V25_ACTION_MIN_ROLE: Readonly<Record<FleetV25Action, FleetV25Role>> =
  buildActionMinRole();

function buildActionMinRole(): Readonly<Record<FleetV25Action, FleetV25Role>> {
  const out = {} as Record<FleetV25Action, FleetV25Role>;
  for (const action of FLEET_V25_ACTIONS) {
    for (const role of FLEET_V25_ROLES) {
      if (FLEET_V25_ROLE_PERMISSIONS[role].includes(action)) {
        out[action] = role;
        break;
      }
    }
  }
  return out;
}

/** Human-readable description of one role (English; UI uses i18n keys). */
export const FLEET_V25_ROLE_DESCRIPTIONS: Readonly<Record<FleetV25Role, string>> = {
  viewer: 'Read-only: can view the fleet dashboard, runs and audit log, but cannot change anything.',
  operator: 'Day-to-day fleet operator: can run bots and schedules, manage automations and CIDR rules, and acknowledge stop-hook feedback.',
  admin: 'Full control: everything an operator can do, plus user and role management, audit retention and audit export.',
};

/** true when `role` is a known fleet v25 role. */
export function isFleetV25Role(value: unknown): value is FleetV25Role {
  return value === 'viewer' || value === 'operator' || value === 'admin';
}

/** true when `value` names a known fleet v25 action. */
export function isFleetV25Action(value: unknown): value is FleetV25Action {
  return (
    typeof value === 'string' &&
    (FLEET_V25_ACTIONS as readonly string[]).includes(value)
  );
}

/** true when `role` holds `action` in the permission matrix. */
export function roleCan(role: FleetV25Role, action: FleetV25Action): boolean {
  return FLEET_V25_ROLE_PERMISSIONS[role].includes(action);
}

/** true when `role` holds every action in `actions`. */
export function roleCanAll(role: FleetV25Role, actions: readonly FleetV25Action[]): boolean {
  return actions.every((a) => roleCan(role, a));
}

/** true when `role` holds at least one action in `actions`. */
export function roleCanAny(role: FleetV25Role, actions: readonly FleetV25Action[]): boolean {
  return actions.some((a) => roleCan(role, a));
}

/** true when `role` is at least `minRole` in the hierarchy. */
export function roleAtLeast(role: FleetV25Role, minRole: FleetV25Role): boolean {
  return FLEET_V25_ROLE_RANK[role] >= FLEET_V25_ROLE_RANK[minRole];
}

/** All actions a role holds (copy — callers may not mutate the matrix). */
export function actionsForRole(role: FleetV25Role): FleetV25Action[] {
  return [...FLEET_V25_ROLE_PERMISSIONS[role]];
}

/** Roles that hold `action`, lowest privilege first. */
export function rolesForAction(action: FleetV25Action): FleetV25Role[] {
  return FLEET_V25_ROLES.filter((r) => roleCan(r, action));
}

/** true when `action` writes state. */
export function isFleetV25WriteAction(action: FleetV25Action): boolean {
  return (FLEET_V25_WRITE_ACTIONS as readonly FleetV25Action[]).includes(action);
}

/** true when `action` is fleet-wide (scope never restricts it). */
export function isFleetV25FleetWideAction(action: FleetV25Action): boolean {
  return (FLEET_V25_FLEET_WIDE_ACTIONS as readonly FleetV25Action[]).includes(action);
}

/**
 * Resource scope: a restriction on which resources a user may touch.
 * Every list is a whitelist — an empty/missing list means "no
 * restriction on that axis". A scope with all lists missing/empty is
 * unrestricted. Matching is case-insensitive for tags (v24 normalises
 * tags to lower-case) and exact for owners and automation ids.
 */
export interface FleetV25Scope {
  /** Automation tags the user may touch (lower-cased on normalise). */
  tags?: string[];
  /** Owners (user/team ids) the user may touch. */
  owners?: string[];
  /** Automation ids the user may touch. */
  automationIds?: string[];
}

/** The resource a permission check is about (any axis may be absent). */
export interface FleetV25ResourceRef {
  /** Tags carried by the resource. */
  tags?: string[];
  /** Owner of the resource. */
  owner?: string;
  /** Automation id of the resource. */
  automationId?: string;
}

/** Normalise a scope: trim, lower-case tags, de-duplicate, sort. */
export function normalizeFleetV25Scope(scope: FleetV25Scope | null | undefined): FleetV25Scope {
  if (!scope) return {};
  const clean = (values: string[] | undefined, lower: boolean): string[] | undefined => {
    if (!values) return undefined;
    const seen = new Set<string>();
    for (const raw of values) {
      const v = lower ? raw.trim().toLowerCase() : raw.trim();
      if (v) seen.add(v);
    }
    const out = [...seen].sort();
    return out.length > 0 ? out : undefined;
  };
  const out: FleetV25Scope = {};
  const tags = clean(scope.tags, true);
  if (tags) out.tags = tags;
  const owners = clean(scope.owners, false);
  if (owners) out.owners = owners;
  const automationIds = clean(scope.automationIds, false);
  if (automationIds) out.automationIds = automationIds;
  return out;
}

/** true when the scope restricts nothing (all axes empty). */
export function isFleetV25ScopeUnrestricted(scope: FleetV25Scope | null | undefined): boolean {
  const n = normalizeFleetV25Scope(scope);
  return !n.tags && !n.owners && !n.automationIds;
}

/**
 * true when `scope` allows touching `resource`. An unrestricted scope
 * allows everything, and when NO resource is given (null) the scope
 * does not restrict — scope only applies to a concrete resource, so
 * a general "may this user do X?" check without a target is not
 * denied by scope. When a scope axis is set and a resource IS given,
 * the resource must match at least one entry on that axis; axes that
 * are unset do not restrict. A resource with no tags/owner/
 * automationId fails a set axis (there is nothing to match against)
 * — a scoped user cannot touch unlabelled resources, by design.
 */
export function scopeAllows(
  scope: FleetV25Scope | null | undefined,
  resource: FleetV25ResourceRef | null | undefined,
): boolean {
  const n = normalizeFleetV25Scope(scope);
  if (!n.tags && !n.owners && !n.automationIds) return true;
  if (resource === null || resource === undefined) return true;
  const r = resource;
  if (n.tags) {
    const tags = (r.tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean);
    if (!tags.some((t) => n.tags!.includes(t))) return false;
  }
  if (n.owners) {
    if (!r.owner || !n.owners.includes(r.owner.trim())) return false;
  }
  if (n.automationIds) {
    if (!r.automationId || !n.automationIds.includes(r.automationId.trim())) return false;
  }
  return true;
}

/** Why a permission check allowed or denied — for audit entries. */
export type FleetV25PermissionReason =
  | 'allowed'
  | 'unknown-role'
  | 'unknown-action'
  | 'role-lacks-action'
  | 'scope-denied';

/** The result of one permission check (never throws). */
export interface FleetV25PermissionDecision {
  /** true when the action may proceed. */
  allowed: boolean;
  /** Machine-readable reason (see `FleetV25PermissionReason`). */
  reason: FleetV25PermissionReason;
  /** Human-readable explanation (English; UI uses i18n keys). */
  detail: string;
  /** The role that was checked. */
  role: FleetV25Role | null;
  /** The action that was checked. */
  action: FleetV25Action | null;
  /** Minimum role that holds the action (null when the action is unknown). */
  minRole: FleetV25Role | null;
}

/** Input for `checkFleetV25Permission`. */
export interface FleetV25PermissionCheckInput {
  /** Role of the actor (unknown values deny, they never throw). */
  role: unknown;
  /** Action the actor wants to perform. */
  action: unknown;
  /** Optional resource scope of the actor. */
  scope?: FleetV25Scope | null;
  /** Optional resource the action targets. */
  resource?: FleetV25ResourceRef | null;
}

/**
 * The single permission gate for fleet v25. Checks, in order: the role
 * is known, the action is known, the role holds the action, and (for
 * resource-scoped actions) the actor's scope covers the resource.
 * Fleet-wide actions (`manage-users`, `manage-roles`, `manage-audit`,
 * `export-audit`) skip the scope check — they are fleet-wide by nature.
 */
export function checkFleetV25Permission(input: FleetV25PermissionCheckInput): FleetV25PermissionDecision {
  const { role, action } = input;
  if (!isFleetV25Role(role)) {
    return {
      allowed: false,
      reason: 'unknown-role',
      detail: `Unknown role: ${String(role)}.`,
      role: null,
      action: isFleetV25Action(action) ? action : null,
      minRole: isFleetV25Action(action) ? FLEET_V25_ACTION_MIN_ROLE[action] : null,
    };
  }
  if (!isFleetV25Action(action)) {
    return {
      allowed: false,
      reason: 'unknown-action',
      detail: `Unknown action: ${String(action)}.`,
      role,
      action: null,
      minRole: null,
    };
  }
  if (!roleCan(role, action)) {
    return {
      allowed: false,
      reason: 'role-lacks-action',
      detail: `Role "${role}" cannot perform "${action}" (needs ${FLEET_V25_ACTION_MIN_ROLE[action]} or above).`,
      role,
      action,
      minRole: FLEET_V25_ACTION_MIN_ROLE[action],
    };
  }
  if (!isFleetV25FleetWideAction(action) && !scopeAllows(input.scope ?? null, input.resource ?? null)) {
    return {
      allowed: false,
      reason: 'scope-denied',
      detail: `Role "${role}" holds "${action}" but the actor's scope does not cover this resource.`,
      role,
      action,
      minRole: FLEET_V25_ACTION_MIN_ROLE[action],
    };
  }
  return {
    allowed: true,
    reason: 'allowed',
    detail: `Role "${role}" may perform "${action}".`,
    role,
    action,
    minRole: FLEET_V25_ACTION_MIN_ROLE[action],
  };
}

/** One row of the role × action matrix (for the UI panel). */
export interface FleetV25PermissionMatrixRow {
  action: FleetV25Action;
  minRole: FleetV25Role;
  viewer: boolean;
  operator: boolean;
  admin: boolean;
  write: boolean;
}

/** The full permission matrix as rows (for the roles panel). */
export function buildFleetV25PermissionMatrix(): FleetV25PermissionMatrixRow[] {
  return FLEET_V25_ACTIONS.map((action) => ({
    action,
    minRole: FLEET_V25_ACTION_MIN_ROLE[action],
    viewer: roleCan('viewer', action),
    operator: roleCan('operator', action),
    admin: roleCan('admin', action),
    write: isFleetV25WriteAction(action),
  }));
}

/** Summary of the role system (counts, for the dashboard). */
export function summarizeFleetV25Roles(): {
  roles: number;
  actions: number;
  readActions: number;
  writeActions: number;
  adminOnlyActions: number;
  operatorActions: number;
  viewerActions: number;
} {
  return {
    roles: FLEET_V25_ROLES.length,
    actions: FLEET_V25_ACTIONS.length,
    readActions: FLEET_V25_READ_ACTIONS.length,
    writeActions: FLEET_V25_WRITE_ACTIONS.length,
    adminOnlyActions: FLEET_V25_ACTIONS.filter((a) => FLEET_V25_ACTION_MIN_ROLE[a] === 'admin').length,
    operatorActions: FLEET_V25_ROLE_PERMISSIONS.operator.length,
    viewerActions: FLEET_V25_ROLE_PERMISSIONS.viewer.length,
  };
}
