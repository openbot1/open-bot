/**
 * Tests for fleet v25 roles + users (v1.38, Team T6).
 *
 * Covers:
 * - Role matrix: 3 roles, 13 actions, viewer 2 / operator 9 /
 *   admin 13, min-role per action, write/read split.
 * - Permission gate: allowed/denied, unknown role/action, scope
 *   allow/deny (tags/owners/automation ids), fleet-wide actions
 *   ignore scope.
 * - User store: bootstrap admin, invite/activate/disable/enable,
 *   set role/scope, last-active-admin invariant (demote/disable/
 *   remove all refuse), counts, JSON round-trip.
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/fleet-v25-roles-users.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FLEET_V25_ACTION_MIN_ROLE,
  FLEET_V25_ACTIONS,
  FLEET_V25_ROLE_PERMISSIONS,
  FLEET_V25_ROLES,
  FLEET_V25_VERSION,
  FleetV25UserStore,
  actionsForRole,
  bootstrapFleetV25Admin,
  buildFleetV25PermissionMatrix,
  canFleetV25UserAct,
  checkFleetV25Permission,
  createFleetV25UserStore,
  isFleetV25Action,
  isFleetV25Role,
  normalizeFleetV25Scope,
  roleAtLeast,
  roleCan,
  roleCanAll,
  roleCanAny,
  rolesForAction,
  scopeAllows,
  summarizeFleetV25Roles,
  summarizeFleetV25Users,
} from '../packages/core/dist/fleetV25/index.js';

const NOW = Date.UTC(2026, 10, 18, 10, 0, 0);

test('roles v25: version + matrix counts', () => {
  assert.equal(FLEET_V25_VERSION, 'v25');
  assert.deepEqual([...FLEET_V25_ROLES], ['viewer', 'operator', 'admin']);
  assert.equal(FLEET_V25_ACTIONS.length, 13);
  assert.equal(FLEET_V25_ROLE_PERMISSIONS.viewer.length, 2);
  assert.equal(FLEET_V25_ROLE_PERMISSIONS.operator.length, 9);
  assert.equal(FLEET_V25_ROLE_PERMISSIONS.admin.length, 13);
  assert.equal(actionsForRole('viewer').length, 2);
  assert.equal(actionsForRole('admin').length, 13);
  assert.equal(FLEET_V25_ACTION_MIN_ROLE['view-fleet'], 'viewer');
  assert.equal(FLEET_V25_ACTION_MIN_ROLE['run-bot'], 'operator');
  assert.equal(FLEET_V25_ACTION_MIN_ROLE['manage-users'], 'admin');
  assert.equal(FLEET_V25_ACTION_MIN_ROLE['export-audit'], 'admin');
  assert.equal(FLEET_V25_ACTION_MIN_ROLE['manage-schedules'], 'operator');
  assert.deepEqual(rolesForAction('manage-users'), ['admin']);
  assert.deepEqual(rolesForAction('view-fleet'), ['viewer', 'operator', 'admin']);
  const summary = summarizeFleetV25Roles();
  assert.equal(summary.roles, 3);
  assert.equal(summary.actions, 13);
  assert.equal(summary.readActions, 2);
  assert.equal(summary.writeActions, 11);
  assert.equal(summary.adminOnlyActions, 4);
  assert.equal(buildFleetV25PermissionMatrix().length, 13);
  assert.equal(buildFleetV25PermissionMatrix().find((r) => r.action === 'manage-users')?.admin, true);
  assert.equal(buildFleetV25PermissionMatrix().find((r) => r.action === 'manage-users')?.viewer, false);
});

test('roles v25: gate — allowed, denied, unknown', () => {
  assert.equal(roleCan('viewer', 'view-fleet'), true);
  assert.equal(roleCan('viewer', 'run-bot'), false);
  assert.equal(roleCan('operator', 'manage-users'), false);
  assert.equal(roleCan('admin', 'export-audit'), true);
  assert.equal(roleCanAll('operator', ['run-bot', 'manage-schedules']), true);
  assert.equal(roleCanAll('operator', ['run-bot', 'manage-users']), false);
  assert.equal(roleCanAny('viewer', ['run-bot', 'view-audit']), true);
  assert.equal(roleCanAny('viewer', ['run-bot', 'manage-users']), false);
  assert.equal(roleAtLeast('operator', 'viewer'), true);
  assert.equal(roleAtLeast('viewer', 'operator'), false);
  assert.equal(isFleetV25Role('admin'), true);
  assert.equal(isFleetV25Role('superuser'), false);
  assert.equal(isFleetV25Action('run-bot'), true);
  assert.equal(isFleetV25Action('fly'), false);

  const ok = checkFleetV25Permission({ role: 'operator', action: 'run-bot' });
  assert.equal(ok.allowed, true);
  assert.equal(ok.reason, 'allowed');
  assert.equal(ok.minRole, 'operator');

  const denied = checkFleetV25Permission({ role: 'viewer', action: 'manage-fleet' });
  assert.equal(denied.allowed, false);
  assert.equal(denied.reason, 'role-lacks-action');
  assert.equal(denied.minRole, 'operator');
  assert.match(denied.detail, /needs operator/);

  const unknownRole = checkFleetV25Permission({ role: 'root', action: 'view-fleet' });
  assert.equal(unknownRole.allowed, false);
  assert.equal(unknownRole.reason, 'unknown-role');
  const unknownAction = checkFleetV25Permission({ role: 'admin', action: 'teleport' });
  assert.equal(unknownAction.allowed, false);
  assert.equal(unknownAction.reason, 'unknown-action');
});

test('roles v25: scope — normalise, allow, deny', () => {
  assert.deepEqual(normalizeFleetV25Scope({ tags: [' Nightly ', 'nightly', 'BACKUP'] }), { tags: ['backup', 'nightly'] });
  assert.deepEqual(normalizeFleetV25Scope({ tags: [], owners: [] }), {});
  assert.equal(scopeAllows(null, { tags: ['x'] }), true);
  assert.equal(scopeAllows({}, { tags: ['x'] }), true);
  // No concrete resource → scope does not restrict (general capability check).
  assert.equal(scopeAllows({ tags: ['nightly'] }, null), true);
  assert.equal(scopeAllows({ tags: ['nightly'] }, undefined), true);
  assert.equal(scopeAllows({ tags: ['nightly'] }, { tags: ['Nightly', 'other'] }), true);
  assert.equal(scopeAllows({ tags: ['nightly'] }, { tags: ['daily'] }), false);
  assert.equal(scopeAllows({ tags: ['nightly'] }, {}), false);
  assert.equal(scopeAllows({ owners: ['team-data'] }, { owner: 'team-data' }), true);
  assert.equal(scopeAllows({ owners: ['team-data'] }, { owner: 'team-ops' }), false);
  assert.equal(
    scopeAllows({ tags: ['nightly'], owners: ['team-data'] }, { tags: ['nightly'], owner: 'team-data' }),
    true,
  );
  assert.equal(
    scopeAllows({ tags: ['nightly'], owners: ['team-data'] }, { tags: ['nightly'], owner: 'team-ops' }),
    false,
  );
  assert.equal(scopeAllows({ automationIds: ['auto-a'] }, { automationId: 'auto-a' }), true);
  assert.equal(scopeAllows({ automationIds: ['auto-a'] }, { automationId: 'auto-b' }), false);

  // Scoped operator may run a matching automation, not another one.
  const allowed = checkFleetV25Permission({
    role: 'operator',
    action: 'run-bot',
    scope: { tags: ['nightly'] },
    resource: { tags: ['nightly'] },
  });
  assert.equal(allowed.allowed, true);
  const scopedDenied = checkFleetV25Permission({
    role: 'operator',
    action: 'run-bot',
    scope: { tags: ['nightly'] },
    resource: { tags: ['daily'] },
  });
  assert.equal(scopedDenied.allowed, false);
  assert.equal(scopedDenied.reason, 'scope-denied');
  // Fleet-wide actions ignore scope.
  const fleetWide = checkFleetV25Permission({
    role: 'admin',
    action: 'manage-users',
    scope: { tags: ['nightly'] },
    resource: { tags: ['daily'] },
  });
  assert.equal(fleetWide.allowed, true);
});

test('users v25: bootstrap + invite/activate lifecycle', () => {
  const store = createFleetV25UserStore();
  assert.throws(() => bootstrapFleetV25Admin(store, { id: 'op', name: 'Op', role: 'operator' }, NOW), /must be an admin/);
  const admin = bootstrapFleetV25Admin(store, { id: 'u-admin', name: 'Admin', email: 'Admin@Example.com', role: 'admin' }, NOW);
  assert.equal(admin.status, 'active');
  assert.equal(admin.email, 'admin@example.com');
  assert.equal(admin.createdBy, 'system');
  assert.throws(() => bootstrapFleetV25Admin(store, { id: 'u2', name: 'Two', role: 'admin' }, NOW), /empty user directory/);

  const op = store.create({ id: 'u-op', name: 'Op', role: 'operator', scope: { tags: ['Nightly'] }, createdBy: 'u-admin' }, NOW);
  assert.equal(op.status, 'invited');
  assert.deepEqual(op.scope, { tags: ['nightly'] });
  assert.equal(canFleetV25UserAct(op, 'run-bot'), false); // invited: cannot act yet
  assert.throws(() => store.create({ id: 'u-op', name: 'Dup', role: 'viewer' }, NOW), /already exists/);
  assert.throws(() => store.create({ id: 'u-bad', name: 'Bad', email: 'not-an-email', role: 'viewer' }, NOW), /Invalid email/);
  assert.throws(() => store.create({ id: '  ', name: 'Blank', role: 'viewer' }, NOW), /must not be empty/);

  const activated = store.activate('u-op', NOW + 1000);
  assert.equal(activated.status, 'active');
  assert.equal(canFleetV25UserAct(activated, 'run-bot'), true);
  assert.equal(canFleetV25UserAct(activated, 'manage-users'), false);
  assert.throws(() => store.activate('u-op', NOW), /already active/);

  const viewer = store.createActive({ id: 'u-view', name: 'View', role: 'viewer' }, NOW);
  assert.equal(viewer.status, 'active');
  assert.equal(canFleetV25UserAct(viewer, 'view-fleet'), true);
  assert.equal(canFleetV25UserAct(viewer, 'run-bot'), false);

  assert.equal(store.size, 3);
  assert.deepEqual(store.counts(), {
    total: 3, active: 3, invited: 0, disabled: 0,
    admin: 1, operator: 1, viewer: 1, activeAdmin: 1,
  });
  assert.equal(store.byRole('admin').length, 1);
  assert.equal(store.byStatus('active').length, 3);
  assert.equal(store.activeAdmins().length, 1);
  assert.match(summarizeFleetV25Users(store), /3 users/);
});

test('users v25: last active admin invariant', () => {
  const store = createFleetV25UserStore();
  bootstrapFleetV25Admin(store, { id: 'a1', name: 'A1', role: 'admin' }, NOW);
  assert.throws(() => store.setRole('a1', 'viewer', NOW), /last active admin/);
  assert.throws(() => store.disable('a1', NOW), /last active admin/);
  assert.throws(() => store.remove('a1'), /last active admin/);

  // A second admin makes the first one demotable/disablable.
  store.createActive({ id: 'a2', name: 'A2', role: 'admin' }, NOW);
  assert.equal(store.setRole('a1', 'operator', NOW).role, 'operator');
  assert.equal(store.disable('a1', NOW, 'stepping down').status, 'disabled');
  assert.equal(store.enable('a1', NOW).status, 'active');
  assert.equal(store.activeAdmins().length, 1); // only a2 is admin now
  assert.throws(() => store.disable('a2', NOW), /last active admin/);
  assert.equal(store.remove('a1'), true);
  assert.equal(store.has('a1'), false);
  assert.throws(() => store.remove('a1'), /does not exist/);
});

test('users v25: set scope / profile / JSON round-trip', () => {
  const store = createFleetV25UserStore();
  bootstrapFleetV25Admin(store, { id: 'a1', name: 'A1', role: 'admin' }, NOW);
  const u = store.createActive({ id: 'u1', name: 'One', role: 'operator', scope: { tags: ['a'] } }, NOW);
  assert.deepEqual(store.setScope('u1', { owners: ['team-x'], automationIds: ['auto-1'] }, NOW + 1).scope,
    { owners: ['team-x'], automationIds: ['auto-1'] });
  assert.deepEqual(store.setScope('u1', null, NOW + 2).scope, {});
  assert.equal(store.updateProfile('u1', { name: 'Uno', note: 'renamed' }, NOW + 3).name, 'Uno');
  assert.equal(store.get('u1')?.note, 'renamed');
  assert.equal(store.get('missing'), undefined);
  store.touch('u1', NOW + 5000);
  assert.equal(store.get('u1')?.lastActiveAtMs, NOW + 5000);

  const json = store.toJSON();
  assert.equal(json.version, 1);
  assert.equal(json.users.length, 2);
  const restored = FleetV25UserStore.fromJSON(JSON.parse(JSON.stringify(json)));
  assert.equal(restored.size, 2);
  assert.equal(restored.get('u1')?.name, 'Uno');
  assert.equal(restored.counts().activeAdmin, 1);

  // No active admin in the dump → refuse to load.
  const bad = JSON.parse(JSON.stringify(json));
  bad.users.find((x) => x.id === 'a1').role = 'viewer';
  assert.throws(() => FleetV25UserStore.fromJSON(bad), /no active admin/);
  assert.throws(() => FleetV25UserStore.fromJSON({ users: 'nope' }), /must be an array/);
  assert.throws(() => FleetV25UserStore.fromJSON(null), /Invalid user directory/);
});
