/**
 * Multi-user v5 tests (v1.19, Đội T6 — node:test, no network).
 *
 * Covers:
 * - Feature matrix: 9 features, role defaults (owner all, viewer
 *   chat+memory only), unknown role ref → no features (fail-closed).
 * - Custom feature-roles: base + extra − denied, admin extra only
 *   on owner base, extra/deny clash rejected, remove blocked while
 *   in use.
 * - User lifecycle: create (slug validation, duplicate id, unknown
 *   role), invite (32-char token, 7-day TTL) → accept (wrong token,
 *   expired token rejected), suspend/deactivate/reactivate, last
 *   owner cannot be suspended, deactivated, or demoted.
 * - Per-user feature grants/denies (deny wins, admin grant blocked
 *   for non-owner base), session limits per role + override.
 * - Admin log + summary counts, save/load round-trip.
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/fleet-v119-multiuser.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  TEAM_V16_FEATURES,
  TEAM_V16_ROLE_FEATURES,
  TEAM_V16_ROLE_MAX_SESSIONS,
  acceptTeamV16Invite,
  addTeamV16CustomFeatureRole,
  canTeamV16UseFeature,
  canTeamV16UserLogin,
  changeTeamV16UserRole,
  checkTeamV16SessionLimit,
  countTeamV16ActiveOwners,
  createTeamV16State,
  createTeamV16User,
  deactivateTeamV16User,
  effectiveTeamV16CustomRoleFeatures,
  effectiveTeamV16UserFeatures,
  findTeamV16User,
  inviteTeamV16User,
  loadTeamV16State,
  reactivateTeamV16User,
  removeTeamV16CustomFeatureRole,
  saveTeamV16State,
  setTeamV16UserFeatureAccess,
  setTeamV16UserMaxSessions,
  summarizeTeamV16,
  summarizeTeamV16User,
  suspendTeamV16User,
  teamV16FeaturesForRoleRef,
  teamV16MaxSessionsForRoleRef,
  validateTeamV16CustomFeatureRole,
  validateTeamV16UserInput,
} from '../packages/core/dist/fleetV16/index.js';

const T0 = Date.UTC(2026, 10, 16, 0, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

function stateWithOwner() {
  let state = createTeamV16State(T0);
  const res = createTeamV16User(state, { userId: 'owner1', displayName: 'Owner', roleRef: 'owner', actorUserId: 'owner1' }, T0);
  assert.equal(res.ok, true, res.error);
  return res.state;
}

test('multi-user v16: feature matrix + role defaults', () => {
  assert.equal(TEAM_V16_FEATURES.length, 9);
  assert.deepEqual([...TEAM_V16_ROLE_FEATURES.owner], [...TEAM_V16_FEATURES]);
  assert.deepEqual([...TEAM_V16_ROLE_FEATURES.viewer], ['chat', 'memory']);
  assert.deepEqual([...TEAM_V16_ROLE_FEATURES.member], ['chat', 'bots', 'tools', 'memory', 'voice', 'media']);
  assert.deepEqual([...TEAM_V16_ROLE_FEATURES.admin], ['chat', 'bots', 'tools', 'memory', 'voice', 'composio', 'fleet', 'media']);
  assert.equal(TEAM_V16_ROLE_MAX_SESSIONS.owner, 10);
  assert.equal(TEAM_V16_ROLE_MAX_SESSIONS.viewer, 2);
  assert.deepEqual(teamV16FeaturesForRoleRef('nope', []), []);
  assert.equal(teamV16MaxSessionsForRoleRef('nope', []), 0);
  assert.equal(teamV16MaxSessionsForRoleRef('custom:missing', []), 0);
});

test('multi-user v16: validate user input', () => {
  assert.match(validateTeamV16UserInput({ userId: 'Bad Id', displayName: 'A', roleRef: 'member' }), /slug/);
  assert.match(validateTeamV16UserInput({ userId: 'ok1', displayName: '', roleRef: 'member' }), /displayName/);
  assert.match(validateTeamV16UserInput({ userId: 'ok1', displayName: 'A', roleRef: '' }), /roleRef/);
  assert.equal(validateTeamV16UserInput({ userId: 'ok-1', displayName: 'A', roleRef: 'member' }), '');
});

test('multi-user v16: create user (duplicate, unknown role, admin log)', () => {
  let state = stateWithOwner();
  const dup = createTeamV16User(state, { userId: 'owner1', displayName: 'Dup', roleRef: 'member', actorUserId: 'owner1' }, T0);
  assert.equal(dup.ok, false);
  assert.match(dup.error, /đã tồn tại/);
  const badRole = createTeamV16User(state, { userId: 'u2', displayName: 'U2', roleRef: 'nope', actorUserId: 'owner1' }, T0);
  assert.equal(badRole.ok, false);
  assert.match(badRole.error, /không tồn tại/);
  const ok = createTeamV16User(state, { userId: 'mem1', displayName: ' Mem One ', roleRef: 'member', actorUserId: 'owner1' }, T0);
  assert.equal(ok.ok, true, ok.error);
  assert.equal(findTeamV16User(ok.state, 'mem1').displayName, 'Mem One');
  assert.equal(findTeamV16User(ok.state, 'mem1').status, 'active');
  assert.equal(ok.state.adminLog.length, 2);
  assert.equal(ok.state.adminLog[1].action, 'user.create');
  assert.equal(countTeamV16ActiveOwners(ok.state), 1);
  state = ok.state;
  assert.equal(summarizeTeamV16(state).totalUsers, 2);
  assert.equal(summarizeTeamV16(state).byStatus.active, 2);
  assert.equal(summarizeTeamV16(state).byRole.owner, 1);
});

test('multi-user v16: invite → accept (wrong/expired token rejected)', () => {
  let state = stateWithOwner();
  const inv = inviteTeamV16User(state, { userId: 'new1', displayName: 'New', roleRef: 'viewer', actorUserId: 'owner1' }, T0);
  assert.equal(inv.ok, true, inv.error);
  assert.equal(inv.inviteToken.length, 32);
  const invited = findTeamV16User(inv.state, 'new1');
  assert.equal(invited.status, 'invited');
  assert.equal(invited.inviteExpiresAt, T0 + 7 * DAY);
  assert.equal(canTeamV16UserLogin(inv.state, 'new1'), false);

  const wrong = acceptTeamV16Invite(inv.state, { userId: 'new1', token: '0'.repeat(32) }, T0 + 1000);
  assert.equal(wrong.ok, false);
  assert.match(wrong.error, /không đúng/);
  const expired = acceptTeamV16Invite(inv.state, { userId: 'new1', token: inv.inviteToken }, T0 + 7 * DAY + 1);
  assert.equal(expired.ok, false);
  assert.match(expired.error, /hết hạn/);
  const ok = acceptTeamV16Invite(inv.state, { userId: 'new1', token: inv.inviteToken }, T0 + DAY);
  assert.equal(ok.ok, true, ok.error);
  assert.equal(findTeamV16User(ok.state, 'new1').status, 'active');
  assert.equal(findTeamV16User(ok.state, 'new1').inviteToken, null);
  assert.equal(canTeamV16UserLogin(ok.state, 'new1'), true);
  // Accept twice → not invited anymore.
  assert.equal(acceptTeamV16Invite(ok.state, { userId: 'new1', token: inv.inviteToken }, T0 + DAY).ok, false);
});

test('multi-user v16: invite tokens are unpredictable (entropy regression)', () => {
  // Hồi quy: LCG cũ tràn float64 sinh ~37% token toàn '0' — test
  // "wrong token" từng fail ngẫu nhiên vì token thật trùng '0'*32.
  let state = stateWithOwner();
  const tokens = new Set();
  for (let i = 0; i < 100; i++) {
    const inv = inviteTeamV16User(state, { userId: `u${i}`, displayName: `U${i}`, roleRef: 'viewer', actorUserId: 'owner1' }, T0);
    assert.equal(inv.ok, true, inv.error);
    assert.match(inv.inviteToken, /^[0-9a-f]{32}$/);
    assert.notEqual(inv.inviteToken, '0'.repeat(32), 'token must not be all zeros');
    assert.ok(!/^(.)\1+$/.test(inv.inviteToken), 'token must not be a single repeated char');
    tokens.add(inv.inviteToken);
    state = inv.state;
  }
  assert.ok(tokens.size >= 95, `expected ~100 unique tokens, got ${tokens.size}`);
});

test('multi-user v16: suspend/deactivate/reactivate + last-owner guard', () => {
  let state = stateWithOwner();
  const mem = createTeamV16User(state, { userId: 'mem1', displayName: 'M', roleRef: 'member', actorUserId: 'owner1' }, T0);
  state = mem.state;
  // Last owner cannot be suspended / deactivated / demoted.
  assert.equal(suspendTeamV16User(state, { userId: 'owner1', actorUserId: 'owner1' }, T0).ok, false);
  assert.equal(deactivateTeamV16User(state, { userId: 'owner1', actorUserId: 'owner1' }, T0).ok, false);
  assert.equal(changeTeamV16UserRole(state, { userId: 'owner1', roleRef: 'admin', actorUserId: 'owner1' }, T0).ok, false);
  // Member lifecycle works.
  const susp = suspendTeamV16User(state, { userId: 'mem1', actorUserId: 'owner1' }, T0);
  assert.equal(susp.ok, true, susp.error);
  assert.equal(findTeamV16User(susp.state, 'mem1').status, 'suspended');
  assert.equal(canTeamV16UseFeature(susp.state, 'mem1', 'chat'), false);
  assert.equal(canTeamV16UserLogin(susp.state, 'mem1'), false);
  assert.equal(suspendTeamV16User(susp.state, { userId: 'mem1', actorUserId: 'owner1' }, T0).ok, false, 'already suspended');
  const reac = reactivateTeamV16User(susp.state, { userId: 'mem1', actorUserId: 'owner1' }, T0);
  assert.equal(reac.ok, true, reac.error);
  assert.equal(findTeamV16User(reac.state, 'mem1').status, 'active');
  const deac = deactivateTeamV16User(reac.state, { userId: 'mem1', actorUserId: 'owner1' }, T0);
  assert.equal(deac.ok, true, deac.error);
  assert.equal(findTeamV16User(deac.state, 'mem1').status, 'deactivated');
  assert.equal(reactivateTeamV16User(deac.state, { userId: 'mem1', actorUserId: 'owner1' }, T0).ok, true);
  // Second owner lifts the guard.
  const o2 = createTeamV16User(deac.state, { userId: 'owner2', displayName: 'O2', roleRef: 'owner', actorUserId: 'owner1' }, T0);
  assert.equal(o2.ok, true, o2.error);
  assert.equal(suspendTeamV16User(o2.state, { userId: 'owner1', actorUserId: 'owner2' }, T0).ok, true);
  assert.equal(countTeamV16ActiveOwners(suspendTeamV16User(o2.state, { userId: 'owner1', actorUserId: 'owner2' }, T0).state), 1);
});

test('multi-user v16: custom feature-roles', () => {
  let state = stateWithOwner();
  assert.match(
    validateTeamV16CustomFeatureRole({ id: 'x', name: 'X', baseRole: 'member', extraFeatures: ['admin'], deniedFeatures: [] }),
    /chỉ custom role có base owner/,
  );
  assert.match(
    validateTeamV16CustomFeatureRole({ id: 'x', name: 'X', baseRole: 'member', extraFeatures: ['fleet'], deniedFeatures: ['fleet'] }),
    /vừa cộng vừa trừ/,
  );
  assert.equal(validateTeamV16CustomFeatureRole({ id: 'ops', name: 'Ops', baseRole: 'member', extraFeatures: ['fleet'], deniedFeatures: ['voice'] }), '');
  const added = addTeamV16CustomFeatureRole(state, { id: 'ops', name: 'Ops', baseRole: 'member', extraFeatures: ['fleet'], deniedFeatures: ['voice'] }, 'owner1', T0);
  assert.equal(added.ok, true, added.error);
  state = added.state;
  assert.deepEqual(
    effectiveTeamV16CustomRoleFeatures(state.customFeatureRoles[0]),
    ['chat', 'bots', 'tools', 'memory', 'fleet', 'media'],
  );
  // Duplicate id rejected.
  assert.equal(addTeamV16CustomFeatureRole(state, { id: 'ops', name: 'Ops2', baseRole: 'member', extraFeatures: [], deniedFeatures: [] }, 'owner1', T0).ok, false);
  const u = createTeamV16User(state, { userId: 'ops1', displayName: 'Ops1', roleRef: 'custom:ops', actorUserId: 'owner1' }, T0);
  assert.equal(u.ok, true, u.error);
  state = u.state;
  assert.equal(canTeamV16UseFeature(state, 'ops1', 'fleet'), true);
  assert.equal(canTeamV16UseFeature(state, 'ops1', 'voice'), false);
  // Remove blocked while in use.
  assert.equal(removeTeamV16CustomFeatureRole(state, 'ops', 'owner1', T0).ok, false);
  const moved = changeTeamV16UserRole(state, { userId: 'ops1', roleRef: 'member', actorUserId: 'owner1' }, T0);
  assert.equal(moved.ok, true, moved.error);
  const removed = removeTeamV16CustomFeatureRole(moved.state, 'ops', 'owner1', T0);
  assert.equal(removed.ok, true, removed.error);
  assert.equal(removeTeamV16CustomFeatureRole(removed.state, 'ops', 'owner1', T0).ok, false, 'already removed');
});

test('multi-user v16: per-user grants/denies + session limits', () => {
  let state = stateWithOwner();
  const mem = createTeamV16User(state, { userId: 'mem1', displayName: 'M', roleRef: 'member', actorUserId: 'owner1' }, T0);
  state = mem.state;
  // Member cannot be granted admin (privilege escalation guard).
  assert.equal(
    setTeamV16UserFeatureAccess(state, { userId: 'mem1', actorUserId: 'owner1', grants: ['admin'] }, T0).ok,
    false,
  );
  // Grant fleet, deny voice → deny wins over role default.
  const g = setTeamV16UserFeatureAccess(state, { userId: 'mem1', actorUserId: 'owner1', grants: ['fleet'], denies: ['voice'] }, T0);
  assert.equal(g.ok, true, g.error);
  state = g.state;
  const feats = effectiveTeamV16UserFeatures(state, findTeamV16User(state, 'mem1'));
  assert.ok(feats.includes('fleet'));
  assert.ok(!feats.includes('voice'));
  assert.ok(!feats.includes('admin'));
  assert.equal(canTeamV16UseFeature(state, 'mem1', 'fleet'), true);
  assert.equal(canTeamV16UseFeature(state, 'mem1', 'nope'), false);
  assert.equal(canTeamV16UseFeature(state, 'ghost', 'chat'), false);
  // Grant+deny clash rejected.
  assert.equal(
    setTeamV16UserFeatureAccess(state, { userId: 'mem1', actorUserId: 'owner1', grants: ['fleet'], denies: ['fleet'] }, T0).ok,
    false,
  );
  // Session limits: member default 3.
  assert.deepEqual(checkTeamV16SessionLimit(state, 'mem1', 2), { allowed: true, maxSessions: 3, reason: '' });
  assert.equal(checkTeamV16SessionLimit(state, 'mem1', 3).allowed, false);
  assert.equal(checkTeamV16SessionLimit(state, 'ghost', 0).allowed, false);
  // Override to 1.
  const o = setTeamV16UserMaxSessions(state, { userId: 'mem1', actorUserId: 'owner1', maxSessions: 1 }, T0);
  assert.equal(o.ok, true, o.error);
  state = o.state;
  assert.equal(checkTeamV16SessionLimit(state, 'mem1', 1).allowed, false);
  assert.equal(checkTeamV16SessionLimit(state, 'mem1', 0).maxSessions, 1);
  assert.equal(setTeamV16UserMaxSessions(state, { userId: 'mem1', actorUserId: 'owner1', maxSessions: 101 }, T0).ok, false);
  const back = setTeamV16UserMaxSessions(state, { userId: 'mem1', actorUserId: 'owner1', maxSessions: null }, T0);
  assert.equal(back.ok, true, back.error);
  assert.equal(summarizeTeamV16User(back.state, findTeamV16User(back.state, 'mem1')).maxSessions, 3);
});

test('multi-user v16: save/load round-trip + corrupt file → null', () => {
  let state = stateWithOwner();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-v16-'));
  try {
    saveTeamV16State(dir, state);
    const loaded = loadTeamV16State(dir);
    assert.ok(loaded);
    assert.equal(loaded.users.length, 1);
    assert.equal(loaded.users[0].userId, 'owner1');
    assert.equal(loadTeamV16State(path.join(dir, 'missing')), null);
    fs.writeFileSync(path.join(dir, 'team-v119.json'), 'not json', 'utf8');
    assert.equal(loadTeamV16State(dir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
