/**
 * Tests for fleet v22 multi-user + per-bot computers (v1.35, Đội T6).
 *
 * Covers:
 * - Roles: ordering, minimum role per action, locked users denied.
 * - Quotas: fits, shortfall, fractions, near-limit flag.
 * - User registry: duplicate id/email throws, last-admin protection,
 *   setRole/setActive, getByEmail.
 * - Computers: kinds, lifecycle transitions (legal/illegal), one active
 *   computer per bot, usage fractions, pressure flag, totals, remove
 *   guard while holding resources.
 * - computerFromGrantedShareV22: denied share throws.
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/fleet-v22-users-computers.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_FLEET_V22_QUOTA,
  FLEET_V22_USER_ROLES,
  FleetV22UserRegistry,
  canFleetV22,
  createFleetV22User,
  quotaFitsV22,
  quotaFractionsV22,
  quotaIsNearLimitV22,
  quotaMaxFractionV22,
  quotaShortfallV22,
  roleCanV22,
  userCanUseTierV22,
  validateFleetV22User,
} from '../packages/core/dist/fleetV22/users.js';
import {
  FLEET_V22_COMPUTER_TRANSITIONS,
  FleetV22ComputerRegistry,
  computerCpuFractionV22,
  computerFromGrantedShareV22,
  computerHoldsResourcesV22,
  computerIsPressuredV22,
  computerTransitionAllowedV22,
  createFleetV22BotComputer,
  transitionFleetV22Computer,
  validateFleetV22Computer,
} from '../packages/core/dist/fleetV22/computers.js';

const GB = 1024 ** 3;
const NOW = 1780000000000;

function makeUser(id, overrides = {}) {
  return createFleetV22User({ id, displayName: id, email: `${id}@example.com`, now: NOW, ...overrides });
}

function makeComputer(id, overrides = {}) {
  return createFleetV22BotComputer({
    id,
    botId: `bot-${id}`,
    ownerId: 'user-1',
    kind: 'local-vm',
    cpuCores: 2,
    ramBytes: 4 * GB,
    diskBytes: 20 * GB,
    now: NOW,
    ...overrides,
  });
}

test('roles: ordering and minimum role per action', () => {
  assert.deepEqual([...FLEET_V22_USER_ROLES], ['viewer', 'member', 'operator', 'admin']);
  assert.equal(roleCanV22('viewer', 'view-own'), true);
  assert.equal(roleCanV22('viewer', 'create-bot'), false);
  assert.equal(roleCanV22('member', 'create-bot'), true);
  assert.equal(roleCanV22('member', 'manage-users'), false);
  assert.equal(roleCanV22('operator', 'manage-own-computers'), true);
  assert.equal(roleCanV22('operator', 'manage-users'), false);
  assert.equal(roleCanV22('admin', 'manage-users'), true);
  assert.equal(roleCanV22('admin', 'impersonate'), true);
});

test('canFleetV22: locked user denied, other owner denied unless admin', () => {
  const member = makeUser('u1', { role: 'member' });
  const locked = { ...member, active: false };
  assert.equal(canFleetV22(locked, 'create-bot').allowed, false);
  assert.equal(canFleetV22(member, 'create-bot', 'someone-else').allowed, false);
  assert.equal(canFleetV22(member, 'create-bot', 'u1').allowed, true);
  assert.equal(canFleetV22(member, 'view-own', 'u1').allowed, true);
  const admin = makeUser('admin-1', { role: 'admin' });
  assert.equal(canFleetV22(admin, 'manage-users', 'u1').allowed, true);
  assert.match(canFleetV22(member, 'manage-users').reason ?? '', /không đủ quyền/);
});

test('userCanUseTierV22: maxTier caps the tier', () => {
  const user = makeUser('u1', { maxTier: 'syscall-policy' });
  assert.equal(userCanUseTierV22(user, 'bwrap'), true);
  assert.equal(userCanUseTierV22(user, 'syscall-policy'), true);
  assert.equal(userCanUseTierV22(user, 'microvm'), false);
});

test('createFleetV22User: defaults by role (admin unlimited)', () => {
  const member = makeUser('m1');
  assert.equal(member.role, 'member');
  assert.equal(member.active, true);
  assert.deepEqual(member.quota, DEFAULT_FLEET_V22_QUOTA);
  assert.equal(member.lastActiveAt, null);
  const admin = makeUser('a1', { role: 'admin' });
  assert.equal(admin.quota.maxCpuCores, Number.POSITIVE_INFINITY);
  assert.equal(admin.quota.maxBots, Number.POSITIVE_INFINITY);
});

test('quota: fits, shortfall, fractions, near-limit', () => {
  const quota = DEFAULT_FLEET_V22_QUOTA;
  const usage = { cpuCores: 7, ramBytes: 4 * GB, diskBytes: 10 * GB, bots: 2, concurrentRuns: 3, computers: 1 };
  assert.equal(quotaFitsV22(quota, usage, { cpuCores: 1 }), true);
  assert.equal(quotaFitsV22(quota, usage, { cpuCores: 2 }), false);
  const short = quotaShortfallV22(quota, usage, { cpuCores: 2, bots: 4 });
  assert.equal(short.cpuCores, 1);
  assert.equal(short.bots, 1);
  assert.equal(short.ramBytes, undefined);
  const fracs = quotaFractionsV22(quota, usage);
  assert.equal(fracs.cpuCores, 7 / 8);
  assert.equal(quotaMaxFractionV22(quota, usage), 7 / 8);
  assert.equal(quotaIsNearLimitV22(quota, usage), true); // 87.5% >= 80%
  const light = { cpuCores: 1, ramBytes: 1 * GB, diskBytes: 1 * GB, bots: 1, concurrentRuns: 1, computers: 0 };
  assert.equal(quotaIsNearLimitV22(quota, light), false);
  // Unlimited quota never counts as near-limit.
  const admin = makeUser('a1', { role: 'admin' });
  assert.equal(quotaMaxFractionV22(admin.quota, usage), 0);
});

test('user registry: duplicate id/email, last-admin protection, role/active', () => {
  const reg = new FleetV22UserRegistry();
  reg.add(makeUser('u1'));
  assert.throws(() => reg.add(makeUser('u1')), /đã tồn tại/);
  assert.throws(() => reg.add(makeUser('u2', { email: 'u1@example.com' })), /Email/);
  assert.equal(reg.getByEmail('U1@EXAMPLE.COM')?.id, 'u1');
  assert.equal(reg.size, 1);
  reg.add(makeUser('a1', { role: 'admin', email: 'a1@example.com' }));
  // Cannot remove or demote the last admin.
  assert.throws(() => reg.remove('a1'), /admin cuối cùng/);
  assert.throws(() => reg.setRole('a1', 'member'), /admin cuối cùng/);
  reg.add(makeUser('a2', { role: 'admin', email: 'a2@example.com' }));
  assert.equal(reg.setRole('a1', 'operator').role, 'operator');
  assert.equal(reg.remove('a1'), true);
  assert.equal(reg.setActive('u1', false).active, false);
  assert.equal(reg.active().length, 1);
  assert.throws(() => reg.update(makeUser('ghost')), /chưa có/);
  assert.equal(reg.remove('ghost'), false);
});

test('user registry: touch updates lastActiveAt, byTeam filters', () => {
  const reg = new FleetV22UserRegistry();
  reg.add(makeUser('u1', { team: 'alpha' }));
  reg.add(makeUser('u2', { team: 'beta' }));
  reg.touch('u1', NOW + 5000);
  assert.equal(reg.get('u1')?.lastActiveAt, NOW + 5000);
  assert.deepEqual(reg.byTeam('alpha').map((u) => u.id), ['u1']);
  reg.touch('ghost'); // no-op, no throw
});

test('validateFleetV22User: bad email, bad role, bad quota', () => {
  assert.deepEqual(validateFleetV22User(null), ['user phải là object.']);
  assert.ok(validateFleetV22User({ id: '', displayName: 'x', email: 'not-an-email', role: 'superuser' }).length >= 3);
  assert.deepEqual(validateFleetV22User(makeUser('u1')), []);
  assert.ok(validateFleetV22User({ ...makeUser('u1'), quota: { maxCpuCores: -1 } }).length >= 1);
});

test('computers: create defaults to provisioning, transitions enforced', () => {
  const c = makeComputer('c1');
  assert.equal(c.status, 'provisioning');
  assert.equal(c.cpuUsed, null);
  assert.equal(computerHoldsResourcesV22(c), true);
  assert.equal(computerTransitionAllowedV22('provisioning', 'ready'), true);
  assert.equal(computerTransitionAllowedV22('provisioning', 'running'), false);
  assert.equal(computerTransitionAllowedV22('running', 'provisioning'), false);
  const ready = transitionFleetV22Computer(c, 'ready', 'vm up', NOW + 1000);
  assert.equal(ready.status, 'ready');
  assert.equal(ready.statusReason, 'vm up');
  assert.equal(ready.updatedAt, NOW + 1000);
  assert.throws(() => transitionFleetV22Computer(ready, 'provisioning'), /không chuyển được/);
  const running = transitionFleetV22Computer(ready, 'running');
  const failed = transitionFleetV22Computer(running, 'failed', 'vm crashed');
  assert.equal(failed.consecutiveFailures, 1);
  const retry = transitionFleetV22Computer(failed, 'provisioning');
  assert.equal(retry.consecutiveFailures, 0);
  assert.deepEqual(FLEET_V22_COMPUTER_TRANSITIONS.stopped, ['provisioning']);
});

test('computers: usage fractions and pressure flag', () => {
  const c = makeComputer('c1');
  assert.equal(computerCpuFractionV22(c), null);
  const used = { ...c, cpuUsed: 1.9, ramUsed: 3.8 * GB, diskUsed: 2 * GB };
  assert.equal(computerCpuFractionV22(used), 0.95);
  assert.equal(computerIsPressuredV22(used), true);
  const light = { ...c, cpuUsed: 0.5, ramUsed: 1 * GB, diskUsed: 2 * GB };
  assert.equal(computerIsPressuredV22(light), false);
});

test('computer registry: one active computer per bot, remove guard, totals', () => {
  const reg = new FleetV22ComputerRegistry();
  reg.add(makeComputer('c1', { botId: 'bot-a' }));
  assert.throws(() => reg.add(makeComputer('c2', { botId: 'bot-a' })), /đã có computer/);
  assert.throws(() => reg.add(makeComputer('c1')), /đã tồn tại/);
  assert.equal(reg.getByBot('bot-a')?.id, 'c1');
  assert.equal(reg.byOwner('user-1').length, 1);
  assert.equal(reg.byKind('local-vm').length, 1);
  assert.equal(reg.byStatus('provisioning').length, 1);
  // Cannot remove while holding resources.
  assert.throws(() => reg.remove('c1'), /còn giữ tài nguyên/);
  const stopped = transitionFleetV22Computer(reg.get('c1'), 'stopped', 'done');
  reg.update(stopped);
  assert.equal(reg.remove('c1'), true);
  assert.equal(reg.getByBot('bot-a'), undefined);
  // Totals only count holding computers.
  reg.add(makeComputer('c3', { botId: 'bot-b' }));
  reg.add(makeComputer('c4', { botId: 'bot-c' }));
  const totals = reg.totalsHolding();
  assert.equal(totals.computers, 2);
  assert.equal(totals.cpuCores, 4);
  assert.equal(reg.byNode('node-x').length, 0);
  const onNode = { ...reg.get('c3'), nodeId: 'node-x' };
  reg.update(onNode);
  assert.equal(reg.byNode('node-x').length, 1);
});

test('computerFromGrantedShareV22: denied share throws, granted creates computer', () => {
  assert.throws(
    () => computerFromGrantedShareV22(
      { id: 'x', ownerId: 'u1', granted: false, grantedCpuCores: 0, grantedRamBytes: 0, grantedDiskBytes: 0, reason: 'no room' },
      { botId: 'b1', ownerId: 'u1', kind: 'local-vm' },
    ),
    /no room/,
  );
  const c = computerFromGrantedShareV22(
    { id: 'c9', ownerId: 'u1', granted: true, grantedCpuCores: 2, grantedRamBytes: 4 * GB, grantedDiskBytes: 10 * GB },
    { botId: 'b9', ownerId: 'u1', kind: 'cloud-linux-desktop', nodeId: 'node-1' },
  );
  assert.equal(c.id, 'c9');
  assert.equal(c.kind, 'cloud-linux-desktop');
  assert.equal(c.nodeId, 'node-1');
  assert.equal(c.cpuCores, 2);
});

test('validateFleetV22Computer: bad kind/status, non-positive resources', () => {
  assert.deepEqual(validateFleetV22Computer(null), ['computer phải là object.']);
  assert.ok(validateFleetV22Computer({ ...makeComputer('c1'), kind: 'mainframe' }).length >= 1);
  assert.ok(validateFleetV22Computer({ ...makeComputer('c1'), cpuCores: 0 }).length >= 1);
  assert.deepEqual(validateFleetV22Computer(makeComputer('c1')), []);
});
