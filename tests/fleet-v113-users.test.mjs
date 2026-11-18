/**
 * Fleet v10 users tests (v1.13, Doi T6 — node:test, no network).
 *
 * Covers:
 * - Create/validate: id pattern (lowercase, no spaces), duplicate id,
 *   role/status validation, max users
 * - Permissions: matrix admin/member/chat-only, unknown role/action
 *   fail-closed, suspended user unusable, audit read rules
 *   (admin any, member only own), owned-resource access
 * - Quota: check each field, disabled quota allows, after-add check
 *   refuses before creation, runsToday limit (0 = unlimited)
 * - Isolation: user dir resolution rejects absolute paths and `..`
 *   escapes, vault namespace per user
 * - Audit: hash chain append + verify, tamper detected (hash and
 *   prevHash), per-user file
 * - Persistence round-trip + corrupt file loads as empty
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/fleet-v113-users.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  FLEET_V10_MAX_USERS,
  appendFleetV10UserAudit,
  canFleetV10User,
  canFleetV10UserAccessOwned,
  canFleetV10UserReadAudit,
  checkFleetV10UserQuota,
  checkFleetV10UserQuotaAfterAdd,
  createFleetV10User,
  defaultFleetV10UserQuota,
  findFleetV10User,
  fleetV10VaultNamespace,
  getFleetV10UserDir,
  isFleetV10UserUsable,
  isPathInsideFleetV10UserDir,
  loadFleetV10UserQuotas,
  loadFleetV10Users,
  readFleetV10UserAudit,
  removeFleetV10User,
  resolveFleetV10UserPath,
  saveFleetV10UserQuotas,
  saveFleetV10Users,
  setFleetV10UserQuota,
  setFleetV10UserRole,
  setFleetV10UserStatus,
  validateFleetV10UserQuota,
  verifyFleetV10UserAudit,
} from '../packages/core/dist/fleet/fleetV10Users.js';

const T0 = Date.UTC(2026, 10, 15, 0, 0, 0);
const GB = 1024 ** 3;

function makeUsers() {
  let users = [];
  users = [...users, createFleetV10User(users, { id: 'admin1', displayName: 'Admin', role: 'admin', createdBy: 'system' }, T0)];
  users = [...users, createFleetV10User(users, { id: 'alice', displayName: 'Alice', role: 'member', createdBy: 'admin1' }, T0)];
  users = [...users, createFleetV10User(users, { id: 'bob', displayName: 'Bob', role: 'chat-only', createdBy: 'admin1' }, T0)];
  return users;
}

function baseUsage(overrides = {}) {
  return {
    userId: 'alice',
    agents: 1,
    concurrentRuns: 1,
    triggers: 2,
    schedules: 1,
    cpuCores: 0.5,
    ramBytes: 512 * 1024 * 1024,
    diskBytes: 100 * 1024 * 1024,
    runsToday: 10,
    ...overrides,
  };
}

test('create: id pattern, trung id, vai tro sai, gioi han so user', () => {
  const users = makeUsers();
  assert.equal(users.length, 3);
  assert.equal(users[0].status, 'active');
  assert.throws(() => createFleetV10User(users, { id: 'Alice', displayName: 'A', role: 'member' }, T0), /already exists/);
  assert.throws(() => createFleetV10User(users, { id: 'Bad Name', displayName: 'A', role: 'member' }, T0), /must match/);
  assert.throws(() => createFleetV10User(users, { id: 'carol', displayName: '', role: 'member' }, T0), /non-empty displayName/);
  assert.throws(() => createFleetV10User(users, { id: 'carol', displayName: 'C', role: 'superuser' }, T0), /role must be one of/);
  assert.equal(findFleetV10User(users, 'alice').displayName, 'Alice');
  assert.equal(findFleetV10User(users, 'nobody'), undefined);
  // Role/status setters + remove.
  const promoted = setFleetV10UserRole(users, 'alice', 'admin', T0 + 1000);
  assert.equal(promoted.find((u) => u.id === 'alice').role, 'admin');
  assert.throws(() => setFleetV10UserRole(users, 'alice', 'superuser'), /role must be one of/);
  const suspended = setFleetV10UserStatus(users, 'alice', 'suspended', T0 + 1000);
  assert.equal(suspended.find((u) => u.id === 'alice').status, 'suspended');
  assert.throws(() => setFleetV10UserStatus(users, 'alice', 'banned'), /status must be one of/);
  assert.equal(removeFleetV10User(users, 'bob').length, 2);
  assert.throws(() => removeFleetV10User(users, 'nobody'), /not found/);
  // Gioi han so user.
  const many = Array.from({ length: FLEET_V10_MAX_USERS }, (_, i) => ({
    id: `u${i}`, displayName: `U${i}`, role: 'member', status: 'active', createdBy: 'system', createdAt: T0, updatedAt: T0, lastActiveAt: null,
  }));
  assert.throws(() => createFleetV10User(many, { id: 'extra', displayName: 'E', role: 'member' }, T0), /too many users/);
});

test('permissions: ma tran theo vai tro, fail-closed, suspended khong dung duoc', () => {
  assert.equal(canFleetV10User('admin', 'user.manage'), true);
  assert.equal(canFleetV10User('admin', 'quota.manage'), true);
  assert.equal(canFleetV10User('member', 'agent.start'), true);
  assert.equal(canFleetV10User('member', 'trigger.create'), true);
  assert.equal(canFleetV10User('member', 'user.manage'), false);
  assert.equal(canFleetV10User('member', 'quota.manage'), false);
  assert.equal(canFleetV10User('chat-only', 'dashboard.read'), true);
  assert.equal(canFleetV10User('chat-only', 'agent.start'), false);
  assert.equal(canFleetV10User('chat-only', 'trigger.create'), false);
  // Fail-closed: vai tro / hanh dong khong biet.
  assert.equal(canFleetV10User('superuser', 'agent.start'), false);
  assert.equal(canFleetV10User('admin', 'nuke.everything'), false);
  const users = makeUsers();
  assert.deepEqual(isFleetV10UserUsable(users, 'alice'), { usable: true, reason: 'ok' });
  assert.equal(isFleetV10UserUsable(users, 'nobody').usable, false);
  const suspended = setFleetV10UserStatus(users, 'alice', 'suspended', T0);
  assert.match(isFleetV10UserUsable(suspended, 'alice').reason, /suspended/);
  // Audit read: admin doc moi user, member chi doc cua minh.
  assert.equal(canFleetV10UserReadAudit(users, 'admin1', 'alice'), true);
  assert.equal(canFleetV10UserReadAudit(users, 'alice', 'alice'), true);
  assert.equal(canFleetV10UserReadAudit(users, 'alice', 'bob'), false);
  assert.equal(canFleetV10UserReadAudit(users, 'nobody', 'alice'), false);
  // Owned resource: admin moi thu, member chi cua minh.
  assert.equal(canFleetV10UserAccessOwned(users, 'admin1', 'alice'), true);
  assert.equal(canFleetV10UserAccessOwned(users, 'alice', 'alice'), true);
  assert.equal(canFleetV10UserAccessOwned(users, 'alice', 'bob'), false);
  assert.equal(canFleetV10UserAccessOwned(users, 'bob', 'bob'), true);
});

test('quota: tung truong vuot, quota tat thi cho, after-add tu choi som', () => {
  const quota = defaultFleetV10UserQuota('alice', 'admin1', T0);
  assert.equal(quota.maxAgents, 5);
  assert.equal(quota.cpuCoresMax, 2);
  assert.equal(quota.ramBytesMax, 4 * GB);
  assert.deepEqual(checkFleetV10UserQuota(quota, baseUsage()), { allowed: true, violations: [] });
  // Tung truong vuot rieng le.
  for (const [field, used] of [
    ['agents', 6],
    ['concurrentRuns', 3],
    ['triggers', 21],
    ['schedules', 21],
    ['cpuCores', 3],
    ['ramBytes', 5 * GB],
    ['diskBytes', 11 * GB],
    ['runsToday', 201],
  ]) {
    const check = checkFleetV10UserQuota(quota, baseUsage({ [field]: used }));
    assert.equal(check.allowed, false, field);
    assert.equal(check.violations.length, 1, field);
    assert.equal(check.violations[0].field, field);
  }
  // Quota tat thi cho phep moi thu.
  assert.equal(checkFleetV10UserQuota({ ...quota, enabled: false }, baseUsage({ agents: 99 })).allowed, true);
  // maxRunsPerDay = 0 la khong gioi han.
  assert.equal(checkFleetV10UserQuota({ ...quota, maxRunsPerDay: 0 }, baseUsage({ runsToday: 99999 })).allowed, true);
  // After-add: them 1 agent khi da 5 -> tu choi; them 1 trigger khi da 2 -> cho.
  assert.equal(checkFleetV10UserQuotaAfterAdd(quota, baseUsage({ agents: 5 }), { agents: 1 }).allowed, false);
  assert.equal(checkFleetV10UserQuotaAfterAdd(quota, baseUsage(), { triggers: 1 }).allowed, true);
  // Set quota: validate + thay the theo userId.
  const custom = { ...quota, maxAgents: 2, updatedBy: 'admin1', updatedAt: T0 + 1000 };
  const quotas = setFleetV10UserQuota([quota], custom);
  assert.equal(quotas.length, 1);
  assert.equal(quotas[0].maxAgents, 2);
  assert.throws(() => validateFleetV10UserQuota({ ...quota, maxAgents: -1 }), /maxAgents must be a non-negative integer/);
});

test('isolation: duong dan user tu choi tuyet doi + thoat .., vault namespace rieng', () => {
  const root = '/tmp/fleet-root';
  assert.equal(getFleetV10UserDir(root, 'alice'), path.join(root, 'users', 'alice'));
  assert.equal(fleetV10VaultNamespace('alice'), 'fleet-user/alice');
  assert.equal(
    resolveFleetV10UserPath(root, 'alice', 'notes/todo.md'),
    path.join(root, 'users', 'alice', 'notes', 'todo.md'),
  );
  assert.throws(() => resolveFleetV10UserPath(root, 'alice', '../bob/secret.txt'), /escapes user directory/);
  assert.throws(() => resolveFleetV10UserPath(root, 'alice', '/etc/passwd'), /absolute paths are not allowed/);
  assert.throws(() => resolveFleetV10UserPath(root, 'Alice', 'x.md'), /invalid user id/);
  assert.equal(isPathInsideFleetV10UserDir(root, 'alice', path.join(root, 'users', 'alice', 'a.txt')), true);
  assert.equal(isPathInsideFleetV10UserDir(root, 'alice', path.join(root, 'users', 'bob', 'a.txt')), false);
  assert.equal(isPathInsideFleetV10UserDir(root, 'alice', '/etc/passwd'), false);
});

test('audit theo user: chuoi hash noi, sua len bi phat hien, file rieng tung user', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-v10-users-'));
  try {
    const e1 = appendFleetV10UserAudit(root, 'alice', { actorUserId: 'admin1', action: 'user.create', target: 'alice', detail: 'created by admin' }, T0);
    assert.equal(e1.seq, 1);
    assert.equal(e1.prevHash, 'GENESIS');
    assert.equal(e1.hash.length, 64);
    const e2 = appendFleetV10UserAudit(root, 'alice', { actorUserId: 'alice', action: 'agent.start', target: 'bot-1' }, T0 + 1000);
    assert.equal(e2.seq, 2);
    assert.equal(e2.prevHash, e1.hash);
    assert.deepEqual(verifyFleetV10UserAudit(root, 'alice'), { ok: true, count: 2 });
    // Audit cua bob rieng biet, chua co su kien.
    assert.deepEqual(readFleetV10UserAudit(root, 'bob'), []);
    assert.deepEqual(verifyFleetV10UserAudit(root, 'bob'), { ok: true, count: 0 });
    // Sua len dong 1 (doi detail) -> hash sai.
    const auditPath = path.join(root, 'users', 'alice', 'audit.jsonl');
    const lines = fs.readFileSync(auditPath, 'utf8').split('\n');
    const tampered = JSON.parse(lines[0]);
    tampered.detail = 'forged';
    lines[0] = JSON.stringify(tampered);
    fs.writeFileSync(auditPath, lines.join('\n'));
    const bad = verifyFleetV10UserAudit(root, 'alice');
    assert.equal(bad.ok, false);
    assert.match(bad.error, /hash mismatch at line 1/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('persistence: users + quotas round-trip, file hong = rong', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-v10-users-persist-'));
  try {
    const users = makeUsers();
    saveFleetV10Users(root, users);
    assert.equal(fs.statSync(path.join(root, 'fleet-users-v113.json')).mode & 0o777, 0o600);
    assert.equal(loadFleetV10Users(root).length, 3);
    const quotas = [defaultFleetV10UserQuota('alice', 'admin1', T0)];
    saveFleetV10UserQuotas(root, quotas);
    assert.equal(loadFleetV10UserQuotas(root).length, 1);
    assert.equal(loadFleetV10UserQuotas(root)[0].maxAgents, 5);
    fs.writeFileSync(path.join(root, 'fleet-users-v113.json'), '[{bad}]');
    assert.deepEqual(loadFleetV10Users(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
