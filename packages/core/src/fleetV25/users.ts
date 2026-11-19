/**
 * Fleet users v25 — multi-user store (v1.38, Đội T6).
 *
 * The user directory for the fleet v25 multi-user layer: who the users
 * are, which role each one holds, whether they are active, and what
 * resource scope restricts them. This module is the pure core: no I/O,
 * no passwords, no tokens — identity (how a caller proves they are a
 * user id) belongs to the host's auth layer; this store only records
 * the authorisation facts (role + scope + status) and enforces the
 * invariants that keep the fleet administrable.
 *
 * Invariants (enforced on every mutation, never silently bypassed):
 * - There is always at least one active admin. Demoting, disabling or
 *   removing the last active admin throws — the fleet must never be
 *   left with nobody able to manage users.
 * - User ids are unique, non-empty, trimmed, and at most 128 chars.
 * - A user is created `invited` (no access yet) and becomes `active`
 *   on `activate`; `disabled` users keep their record but hold no
 *   permissions (the permission gate in `roles.ts` still checks the
 *   role, so callers must also check `isActive` — see
 *   `canFleetV25UserAct`).
 * - Email, when given, must look like an email (one `@`, non-empty
 *   local + domain parts); it is stored lower-cased.
 * - Scopes are normalised through `normalizeFleetV25Scope` (tags
 *   lower-cased) so scope checks never split on case/whitespace.
 *
 * The store serialises to plain JSON (`toJSON` / `fromJSON`) so the
 * host can persist it in the vault or a file; `fromJSON` re-validates
 * and re-enforces the last-admin invariant.
 */

import {
  checkFleetV25Permission,
  normalizeFleetV25Scope,
  type FleetV25Role,
  type FleetV25Scope,
} from './roles';

/** Lifecycle status of a fleet user. */
export type FleetV25UserStatus = 'invited' | 'active' | 'disabled';

/** All user statuses, in directory display order. */
export const FLEET_V25_USER_STATUSES: readonly FleetV25UserStatus[] = [
  'active',
  'invited',
  'disabled',
];

/** One fleet user. */
export interface FleetV25User {
  /** Stable id, unique in the store (e.g. `u-huy`, `team-data`). */
  id: string;
  /** Human display name. */
  name: string;
  /** Contact email (lower-cased) or null. */
  email: string | null;
  /** Role: admin / operator / viewer. */
  role: FleetV25Role;
  /** Lifecycle status. */
  status: FleetV25UserStatus;
  /** Resource scope (empty = unrestricted). */
  scope: FleetV25Scope;
  /** When the user was created (epoch ms). */
  createdAtMs: number;
  /** When any field last changed (epoch ms). */
  updatedAtMs: number;
  /** When the user last acted (epoch ms, null = never). */
  lastActiveAtMs: number | null;
  /** Who created/invited this user (user id or `system`). */
  createdBy: string;
  /** Free-form note (e.g. why the user was disabled). */
  note: string | null;
}

/** Input for creating / inviting a user. */
export interface FleetV25CreateUserInput {
  id: string;
  name: string;
  email?: string | null;
  role: FleetV25Role;
  scope?: FleetV25Scope | null;
  createdBy?: string;
  note?: string | null;
}

/** Per-role user counts. */
export interface FleetV25UserCounts {
  total: number;
  active: number;
  invited: number;
  disabled: number;
  admin: number;
  operator: number;
  viewer: number;
  activeAdmin: number;
}

function cleanId(id: unknown): string {
  if (typeof id !== 'string') throw new Error('User id must be a string.');
  const v = id.trim();
  if (!v) throw new Error('User id must not be empty.');
  if (v.length > 128) throw new Error('User id must be at most 128 characters.');
  return v;
}

function cleanName(name: unknown): string {
  if (typeof name !== 'string') throw new Error('User name must be a string.');
  const v = name.trim();
  if (!v) throw new Error('User name must not be empty.');
  if (v.length > 256) throw new Error('User name must be at most 256 characters.');
  return v;
}

function cleanEmail(email: string | null | undefined): string | null {
  if (email === undefined || email === null) return null;
  const v = email.trim().toLowerCase();
  if (!v) return null;
  const at = v.indexOf('@');
  if (at <= 0 || at !== v.lastIndexOf('@') || at === v.length - 1) {
    throw new Error(`Invalid email: "${email}".`);
  }
  if (v.length > 256) throw new Error('Email must be at most 256 characters.');
  return v;
}

function isRole(value: unknown): value is FleetV25Role {
  return value === 'admin' || value === 'operator' || value === 'viewer';
}

/** true when the user can act right now (active status only). */
export function isFleetV25UserActive(user: FleetV25User): boolean {
  return user.status === 'active';
}

/**
 * true when the user may act at all: active status AND the role holds
 * the action AND the scope covers the resource. This is the check
 * tools call before a sensitive action — it combines the status check
 * (here) with the permission gate (`roles.ts`).
 */
export function canFleetV25UserAct(
  user: FleetV25User | null | undefined,
  action: Parameters<typeof import('./roles').checkFleetV25Permission>[0]['action'],
  resource?: Parameters<typeof import('./roles').checkFleetV25Permission>[0]['resource'],
): boolean {
  if (!user || user.status !== 'active') return false;
  return checkPermissionForUser(user, action, resource);
}

function checkPermissionForUser(
  user: FleetV25User,
  action: Parameters<typeof checkFleetV25Permission>[0]['action'],
  resource?: Parameters<typeof checkFleetV25Permission>[0]['resource'],
): boolean {
  return checkFleetV25Permission({ role: user.role, action, scope: user.scope, resource }).allowed;
}

/** The fleet user directory (in-memory store + invariants). */
export class FleetV25UserStore {
  private readonly users = new Map<string, FleetV25User>();

  /** Number of users in the store. */
  get size(): number {
    return this.users.size;
  }

  /** Create (invite) a user. Throws on duplicate id / bad input. */
  create(input: FleetV25CreateUserInput, nowMs: number): FleetV25User {
    const id = cleanId(input.id);
    if (this.users.has(id)) throw new Error(`User "${id}" already exists.`);
    if (!isRole(input.role)) throw new Error(`Unknown role: ${String(input.role)}.`);
    const user: FleetV25User = {
      id,
      name: cleanName(input.name),
      email: cleanEmail(input.email),
      role: input.role,
      status: 'invited',
      scope: normalizeFleetV25Scope(input.scope ?? null),
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
      lastActiveAtMs: null,
      createdBy: (input.createdBy ?? 'system').trim() || 'system',
      note: input.note?.trim() ? input.note.trim() : null,
    };
    this.users.set(id, user);
    return { ...user, scope: { ...user.scope } };
  }

  /** Create + immediately activate (used for the first/bootstrapped admin). */
  createActive(input: FleetV25CreateUserInput, nowMs: number): FleetV25User {
    const user = this.create(input, nowMs);
    const stored = this.users.get(user.id)!;
    stored.status = 'active';
    stored.updatedAtMs = nowMs;
    return { ...stored, scope: { ...stored.scope } };
  }

  /** Get a user by id (undefined when absent). Returns a copy. */
  get(id: string): FleetV25User | undefined {
    const u = this.users.get(id.trim());
    return u ? { ...u, scope: { ...u.scope } } : undefined;
  }

  /** true when a user with this id exists. */
  has(id: string): boolean {
    return this.users.has(id.trim());
  }

  /** All users, sorted by id. */
  list(): FleetV25User[] {
    return [...this.users.values()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((u) => ({ ...u, scope: { ...u.scope } }));
  }

  /** Users filtered by role. */
  byRole(role: FleetV25Role): FleetV25User[] {
    return this.list().filter((u) => u.role === role);
  }

  /** Users filtered by status. */
  byStatus(status: FleetV25UserStatus): FleetV25User[] {
    return this.list().filter((u) => u.status === status);
  }

  /** Active admins (the users that keep the fleet administrable). */
  activeAdmins(): FleetV25User[] {
    return this.list().filter((u) => u.role === 'admin' && u.status === 'active');
  }

  /** Counts by role and status. */
  counts(): FleetV25UserCounts {
    const all = this.list();
    return {
      total: all.length,
      active: all.filter((u) => u.status === 'active').length,
      invited: all.filter((u) => u.status === 'invited').length,
      disabled: all.filter((u) => u.status === 'disabled').length,
      admin: all.filter((u) => u.role === 'admin').length,
      operator: all.filter((u) => u.role === 'operator').length,
      viewer: all.filter((u) => u.role === 'viewer').length,
      activeAdmin: all.filter((u) => u.role === 'admin' && u.status === 'active').length,
    };
  }

  /** Mark an invited user active. Throws when missing / already active. */
  activate(id: string, nowMs: number): FleetV25User {
    const u = this.require(id);
    if (u.status === 'active') throw new Error(`User "${u.id}" is already active.`);
    if (u.status === 'disabled') {
      throw new Error(`User "${u.id}" is disabled; enable it instead of activating.`);
    }
    u.status = 'active';
    u.updatedAtMs = nowMs;
    return { ...u, scope: { ...u.scope } };
  }

  /** Disable a user (keeps the record). Never the last active admin. */
  disable(id: string, nowMs: number, note?: string | null): FleetV25User {
    const u = this.require(id);
    if (u.status === 'disabled') throw new Error(`User "${u.id}" is already disabled.`);
    this.assertNotLastActiveAdmin(u, 'disable');
    u.status = 'disabled';
    u.updatedAtMs = nowMs;
    if (note?.trim()) u.note = note.trim();
    return { ...u, scope: { ...u.scope } };
  }

  /** Re-enable a disabled user (back to active). */
  enable(id: string, nowMs: number): FleetV25User {
    const u = this.require(id);
    if (u.status === 'active') throw new Error(`User "${u.id}" is already active.`);
    if (u.status === 'invited') {
      throw new Error(`User "${u.id}" is still invited; activate it instead of enabling.`);
    }
    u.status = 'active';
    u.updatedAtMs = nowMs;
    return { ...u, scope: { ...u.scope } };
  }

  /** Change a user's role. Never demote the last active admin. */
  setRole(id: string, role: FleetV25Role, nowMs: number): FleetV25User {
    const u = this.require(id);
    if (!isRole(role)) throw new Error(`Unknown role: ${String(role)}.`);
    if (u.role === 'admin' && role !== 'admin') this.assertNotLastActiveAdmin(u, 'demote');
    u.role = role;
    u.updatedAtMs = nowMs;
    return { ...u, scope: { ...u.scope } };
  }

  /** Replace a user's resource scope (normalised). */
  setScope(id: string, scope: FleetV25Scope | null, nowMs: number): FleetV25User {
    const u = this.require(id);
    u.scope = normalizeFleetV25Scope(scope);
    u.updatedAtMs = nowMs;
    return { ...u, scope: { ...u.scope } };
  }

  /** Rename a user / change email / note. */
  updateProfile(
    id: string,
    patch: { name?: string; email?: string | null; note?: string | null },
    nowMs: number,
  ): FleetV25User {
    const u = this.require(id);
    if (patch.name !== undefined) u.name = cleanName(patch.name);
    if (patch.email !== undefined) u.email = cleanEmail(patch.email);
    if (patch.note !== undefined) u.note = patch.note?.trim() ? patch.note.trim() : null;
    u.updatedAtMs = nowMs;
    return { ...u, scope: { ...u.scope } };
  }

  /** Remove a user permanently. Never the last active admin. */
  remove(id: string): boolean {
    const u = this.require(id);
    this.assertNotLastActiveAdmin(u, 'remove');
    return this.users.delete(u.id);
  }

  /** Record that a user just acted (for last-active reporting). */
  touch(id: string, nowMs: number): void {
    const u = this.users.get(id.trim());
    if (!u) return;
    u.lastActiveAtMs = nowMs;
    u.updatedAtMs = nowMs;
  }

  /** Serialise the whole directory (plain JSON). */
  toJSON(): { version: 1; users: FleetV25User[] } {
    return { version: 1, users: this.list() };
  }

  /** Load a serialised directory. Re-validates; throws on bad data. */
  static fromJSON(data: unknown): FleetV25UserStore {
    const store = new FleetV25UserStore();
    if (!data || typeof data !== 'object') throw new Error('Invalid user directory JSON.');
    const users = (data as { users?: unknown }).users;
    if (!Array.isArray(users)) throw new Error('Invalid user directory JSON: users must be an array.');
    for (const raw of users) {
      if (!raw || typeof raw !== 'object') throw new Error('Invalid user entry in directory JSON.');
      const r = raw as Partial<FleetV25User>;
      if (!isRole(r.role)) throw new Error(`Invalid role in directory JSON: ${String(r.role)}.`);
      if (r.status !== 'invited' && r.status !== 'active' && r.status !== 'disabled') {
        throw new Error(`Invalid status in directory JSON: ${String(r.status)}.`);
      }
      const user: FleetV25User = {
        id: cleanId(r.id),
        name: cleanName(r.name),
        email: cleanEmail(r.email ?? null),
        role: r.role,
        status: r.status,
        scope: normalizeFleetV25Scope(r.scope ?? null),
        createdAtMs: typeof r.createdAtMs === 'number' ? r.createdAtMs : 0,
        updatedAtMs: typeof r.updatedAtMs === 'number' ? r.updatedAtMs : 0,
        lastActiveAtMs: typeof r.lastActiveAtMs === 'number' ? r.lastActiveAtMs : null,
        createdBy: typeof r.createdBy === 'string' && r.createdBy.trim() ? r.createdBy.trim() : 'system',
        note: typeof r.note === 'string' && r.note.trim() ? r.note.trim() : null,
      };
      if (store.users.has(user.id)) throw new Error(`Duplicate user "${user.id}" in directory JSON.`);
      store.users.set(user.id, user);
    }
    if (store.users.size > 0 && store.activeAdmins().length === 0) {
      throw new Error('Invalid user directory JSON: no active admin.');
    }
    return store;
  }

  private require(id: string): FleetV25User {
    const u = this.users.get(cleanId(id));
    if (!u) throw new Error(`User "${id.trim()}" does not exist.`);
    return u;
  }

  private assertNotLastActiveAdmin(user: FleetV25User, verb: string): void {
    if (user.role !== 'admin' || user.status !== 'active') return;
    if (this.activeAdmins().length <= 1) {
      throw new Error(`Cannot ${verb} "${user.id}": it is the last active admin.`);
    }
  }
}

/** Create an empty user directory. */
export function createFleetV25UserStore(): FleetV25UserStore {
  return new FleetV25UserStore();
}

/**
 * Bootstrap a directory with a single active admin (first-run setup).
 * Throws when the store is not empty.
 */
export function bootstrapFleetV25Admin(
  store: FleetV25UserStore,
  input: FleetV25CreateUserInput,
  nowMs: number,
): FleetV25User {
  if (store.size > 0) throw new Error('Admin bootstrap requires an empty user directory.');
  if (input.role !== 'admin') throw new Error('Bootstrap user must be an admin.');
  return store.createActive(input, nowMs);
}

/** One-line summary of the directory (for the dashboard header). */
export function summarizeFleetV25Users(store: FleetV25UserStore): string {
  const c = store.counts();
  return (
    `${c.total} user${c.total === 1 ? '' : 's'} ` +
    `(${c.activeAdmin} active admin${c.activeAdmin === 1 ? '' : 's'}, ` +
    `${c.operator} operator${c.operator === 1 ? '' : 's'}, ` +
    `${c.viewer} viewer${c.viewer === 1 ? '' : 's'}, ` +
    `${c.invited} invited, ${c.disabled} disabled)`
  );
}
