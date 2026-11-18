/**
 * Multi-user v4 tests (v1.18, Đội T6 — node:test, no network).
 *
 * Covers:
 * - Custom roles: validate (bad id, unknown base/action, extra∩denied,
 *   owner-only leak), effective actions (base + extra − denied),
 *   canTeamV15 for built-in + custom refs, fail-closed unknown ref,
 *   add/remove in state.
 * - Quota v4: 9 kinds; resource defaults per role; override; consume
 *   cpu/ram/disk (level) + tokens-per-day (delegated to v3); exceed
 *   rejected with remaining; release never negative; summary rows = 9.
 * - Sessions: create (unknown role rejected, isolated dir sanitized),
 *   touch, revoke, revoke-all, expiry, prune.
 * - User switch: audit event appended to the v3 hash chain (verify OK),
 *   same-user rejected, switch list.
 * - Persistence: save/load round-trip, corrupt file → null.
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/fleet-v118-multiuser.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  addTeamV15CustomRole,
  canTeamV15,
  consumeTeamV15Quota,
  createTeamV15CustomRole,
  createTeamV15Session,
  createTeamV15State,
  effectiveTeamV15CustomRoleActions,
  isTeamV15SessionActive,
  listTeamV15ActiveSessions,
  listTeamV15Switches,
  loadTeamV15State,
  pruneTeamV15Sessions,
  releaseTeamV15Quota,
  removeTeamV15CustomRole,
  revokeAllTeamV15UserSessions,
  revokeTeamV15Session,
  saveTeamV15State,
  sanitizeTeamV15UserDir,
  setTeamV15ResourceQuotaOverride,
  summarizeTeamV15Quota,
  summarizeTeamV15User,
  switchTeamV15User,
  teamV15QuotaLimitFor,
  teamV15QuotaRemaining,
  teamV15RoleRef,
  teamV15SessionDir,
  TEAM_V15_QUOTA_KINDS,
  touchTeamV15Session,
  validateTeamV15CustomRole,
} from '../packages/core/dist/fleetV15/index.js';
import { verifyTeamV14UserAuditLog } from '../packages/core/dist/fleetV14/index.js';

const T0 = Date.UTC(2026, 10, 16, 0, 0, 0);
const HOUR = 60 * 60 * 1000;

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-team-v15-'));
}

test('multi-user v4: custom role validation + effective actions', () => {
  const base = createTeamV15CustomRole(
    { id: 'support-lead', name: 'Support lead', baseRole: 'member', extraActions: ['manage-fleet'], deniedActions: ['run-bots'] },
    'u_owner',
    T0,
  );
  assert.equal(validateTeamV15CustomRole(base), '');
  const eff = effectiveTeamV15CustomRoleActions(base);
  assert.ok(eff.includes('manage-fleet'), 'extra action granted');
  assert.ok(!eff.includes('run-bots'), 'denied action wins over base default');
  assert.ok(eff.includes('view-members'), 'base member action kept');

  // Owner-only leak: member-based role may not gain change-role.
  const leak = createTeamV15CustomRole(
    { id: 'sneaky', name: 'Sneaky', baseRole: 'member', extraActions: ['change-role'] },
    'u_owner',
    T0,
  );
  assert.match(validateTeamV15CustomRole(leak), /owner-only/);
  // Owner-based role MAY gain owner-only actions (it already has them).
  const ownerBased = createTeamV15CustomRole(
    { id: 'deputy', name: 'Deputy', baseRole: 'owner', extraActions: [] },
    'u_owner',
    T0,
  );
  assert.equal(validateTeamV15CustomRole(ownerBased), '');

  // Bad id / overlap / unknown action.
  assert.match(validateTeamV15CustomRole({ ...base, id: 'Bad_ID' }), /lowercase/);
  assert.match(
    validateTeamV15CustomRole({ ...base, extraActions: ['run-bots'], deniedActions: ['run-bots'] }),
    /both extra and denied/,
  );
  assert.match(
    validateTeamV15CustomRole({ ...base, extraActions: ['fly-to-moon'] }),
    /unknown action/,
  );
  assert.match(validateTeamV15CustomRole({ ...base, baseRole: 'superuser' }), /unknown base role/);
});

test('multi-user v4: canTeamV15 (built-in + custom + fail-closed)', () => {
  let state = createTeamV15State('team-a', T0);
  assert.equal(canTeamV15(state.customRoles, 'viewer', 'run-bots'), true);
  assert.equal(canTeamV15(state.customRoles, 'viewer', 'manage-fleet'), false);
  assert.equal(canTeamV15(state.customRoles, 'admin', 'manage-fleet'), true);
  assert.equal(canTeamV15(state.customRoles, 'nobody', 'run-bots'), false, 'unknown ref fails closed');

  const role = createTeamV15CustomRole(
    { id: 'auditor', name: 'Auditor', baseRole: 'viewer', extraActions: ['view-audit'] },
    'u_owner',
    T0,
  );
  const added = addTeamV15CustomRole(state, role, T0);
  assert.equal(added.ok, true, added.reason);
  state = added.state;
  assert.equal(teamV15RoleRef(role), 'custom:auditor');
  assert.equal(canTeamV15(state.customRoles, 'custom:auditor', 'view-audit'), true);
  assert.equal(canTeamV15(state.customRoles, 'custom:auditor', 'run-bots'), true, 'viewer base keeps run-bots');
  assert.equal(canTeamV15(state.customRoles, 'custom:auditor', 'manage-fleet'), false);
  assert.equal(canTeamV15(state.customRoles, 'custom:missing', 'view-audit'), false);

  // Duplicate id rejected; remove works.
  assert.equal(addTeamV15CustomRole(state, role, T0).ok, false);
  const removed = removeTeamV15CustomRole(state, 'auditor', T0);
  assert.equal(removed.ok, true);
  assert.equal(removeTeamV15CustomRole(removed.state, 'auditor', T0).ok, false);
});

test('multi-user v4: resource quota defaults + consume/release', () => {
  const state = createTeamV15State('team-a', T0);
  assert.deepEqual([...TEAM_V15_QUOTA_KINDS].sort(), [
    'bots', 'concurrent-runs', 'cpu-cores', 'disk-mb', 'ram-mb', 'storage-mb',
    'tokens-per-day', 'tool-calls-per-day', 'voice-minutes-per-day',
  ]);
  assert.equal(teamV15QuotaLimitFor(state, 'u1', 'owner', 'cpu-cores'), -1);
  assert.equal(teamV15QuotaLimitFor(state, 'u1', 'member', 'cpu-cores'), 8);
  assert.equal(teamV15QuotaLimitFor(state, 'u1', 'member', 'ram-mb'), 32_768);
  assert.equal(teamV15QuotaLimitFor(state, 'u1', 'viewer', 'disk-mb'), 20_480);
  assert.equal(teamV15QuotaLimitFor(state, 'u1', 'ghost-role', 'ram-mb'), 0, 'unknown role fails closed');
  // Custom role inherits base role defaults.
  let withRole = state;
  const role = createTeamV15CustomRole({ id: 'lead', name: 'Lead', baseRole: 'admin' }, 'u_owner', T0);
  withRole = addTeamV15CustomRole(withRole, role, T0).state;
  assert.equal(teamV15QuotaLimitFor(withRole, 'u1', 'custom:lead', 'cpu-cores'), 32);

  // Consume RAM as member: 8 cores / 32768 MB.
  let s = state;
  let res = consumeTeamV15Quota(s, 'u_member', 'member', 'ram-mb', 10_000, T0);
  assert.equal(res.ok, true, res.reason);
  assert.equal(res.remaining, 22_768);
  s = res.state;
  res = consumeTeamV15Quota(s, 'u_member', 'member', 'ram-mb', 30_000, T0);
  assert.equal(res.ok, false);
  assert.match(res.reason, /quota exceeded/);
  assert.equal(res.remaining, 22_768);
  // CPU cores: 8 max, 9 rejected.
  res = consumeTeamV15Quota(s, 'u_member', 'member', 'cpu-cores', 9, T0);
  assert.equal(res.ok, false);
  res = consumeTeamV15Quota(s, 'u_member', 'member', 'cpu-cores', 8, T0);
  assert.equal(res.ok, true);
  s = res.state;
  // Release clamps at 0, never negative.
  s = releaseTeamV15Quota(s, 'u_member', 'ram-mb', 99_999, T0);
  assert.equal(teamV15QuotaRemaining(s, 'u_member', 'member', 'ram-mb', T0), 32_768);
  // Daily kind delegates to v3 (tokens).
  res = consumeTeamV15Quota(s, 'u_member', 'member', 'tokens-per-day', 100, T0);
  assert.equal(res.ok, true);
  assert.equal(res.resetAt, Date.UTC(2026, 10, 17, 0, 0, 0));
  // Invalid inputs rejected.
  assert.equal(consumeTeamV15Quota(s, '', 'member', 'ram-mb', 1, T0).ok, false);
  assert.equal(consumeTeamV15Quota(s, 'u_member', 'member', 'ram-mb', -1, T0).ok, false);
  assert.equal(consumeTeamV15Quota(s, 'u_member', 'member', 'nope', 1, T0).ok, false);

  const rows = summarizeTeamV15Quota(s, 'u_member', 'member', T0);
  assert.equal(rows.length, 9);
  const ram = rows.find((r) => r.kind === 'ram-mb');
  assert.equal(ram.limit, 32_768);
  assert.equal(ram.used, 0, 'released back to 0');
  assert.equal(ram.daily, false);
});

test('multi-user v4: resource quota override', () => {
  let state = createTeamV15State('team-a', T0);
  let res = setTeamV15ResourceQuotaOverride(state, 'u1', 'ram-mb', 1000, T0);
  assert.equal(res.ok, true, res.reason);
  state = res.state;
  assert.equal(teamV15QuotaLimitFor(state, 'u1', 'member', 'ram-mb'), 1000);
  res = setTeamV15ResourceQuotaOverride(state, 'u1', 'ram-mb', null, T0);
  assert.equal(res.ok, true);
  assert.equal(teamV15QuotaLimitFor(res.state, 'u1', 'member', 'ram-mb'), 32_768);
  assert.equal(setTeamV15ResourceQuotaOverride(state, 'u1', 'ram-mb', -2, T0).ok, false);
  assert.equal(setTeamV15ResourceQuotaOverride(state, 'u1', 'tokens-per-day', 5, T0).ok, false, 'v3 kinds go through the v3 setter');
});

test('multi-user v4: sessions (isolated dirs, revoke, expiry, prune)', () => {
  let state = createTeamV15State('team-a', T0);
  assert.equal(sanitizeTeamV15UserDir('alice/bob..x'), 'alice_bob..x');
  assert.equal(teamV15SessionDir('alice', 's-1'), 'users/alice/session-s-1');
  // No path traversal: no '..' or '.' path component, even for hostile ids.
  const parts = teamV15SessionDir('../evil', 's-1').split('/');
  assert.ok(parts.every((p) => p !== '..' && p !== '.'), 'no path traversal');

  const bad = createTeamV15Session(state, 'u1', 'ghost', 'laptop', HOUR, T0);
  assert.equal(bad.ok, false, 'unknown role ref rejected');
  const made = createTeamV15Session(state, 'u1', 'member', 'laptop', HOUR, T0);
  assert.equal(made.ok, true, made.reason);
  assert.ok(made.session);
  assert.equal(made.session.isolatedDir, teamV15SessionDir('u1', made.session.sessionId));
  assert.equal(made.session.expiresAt, T0 + HOUR);
  state = made.state;
  assert.equal(isTeamV15SessionActive(made.session, T0 + 1000), true);
  assert.equal(isTeamV15SessionActive(made.session, T0 + HOUR + 1), false, 'expired');
  assert.equal(listTeamV15ActiveSessions(state, 'u1', T0 + 1000).length, 1);
  assert.equal(listTeamV15ActiveSessions(state, 'u1', T0 + HOUR + 1).length, 0);

  // Touch updates lastActiveAt; revoke blocks further activity.
  const touched = touchTeamV15Session(state, made.session.sessionId, T0 + 5000);
  assert.equal(touched.sessions[0].lastActiveAt, T0 + 5000);
  const revoked = revokeTeamV15Session(touched, made.session.sessionId, 'device lost', T0 + 6000);
  assert.equal(revoked.ok, true);
  assert.equal(isTeamV15SessionActive(revoked.session, T0 + 7000), false);
  assert.equal(revokeTeamV15Session(revoked.state, made.session.sessionId, 'again', T0).ok, false);
  assert.equal(revokeTeamV15Session(state, 'nope', 'x', T0).ok, false);

  // Revoke-all for a user.
  const s1 = createTeamV15Session(state, 'u2', 'viewer', 'a', HOUR, T0).state;
  const s2 = createTeamV15Session(s1, 'u2', 'viewer', 'b', HOUR, T0).state;
  const all = revokeAllTeamV15UserSessions(s2, 'u2', 'role changed', T0);
  assert.equal(all.revokedCount, 2);
  assert.equal(listTeamV15ActiveSessions(all.state, 'u2', T0).length, 0);

  // Prune drops sessions ended long ago, keeps active ones.
  const old = createTeamV15Session(state, 'u3', 'viewer', 'old', 1000, T0).state;
  const pruned = pruneTeamV15Sessions(old, T0 + 31 * 24 * HOUR);
  assert.equal(pruned.sessions.length, 0);
});

test('multi-user v4: user switch writes hash-chained audit', () => {
  let state = createTeamV15State('team-a', T0);
  const same = switchTeamV15User(state, { fromUserId: 'u1', toUserId: 'u1', actorUserId: 'u_admin', actorRole: 'admin' }, T0);
  assert.equal(same.ok, false);
  const res = switchTeamV15User(
    state,
    { fromUserId: 'u1', toUserId: 'u2', actorUserId: 'u_admin', actorRole: 'admin', reason: 'shift handover' },
    T0,
  );
  assert.equal(res.ok, true, res.reason);
  assert.ok(res.switchRecord);
  assert.equal(res.switchRecord.fromUserId, 'u1');
  assert.equal(res.switchRecord.toUserId, 'u2');
  assert.equal(res.switchRecord.auditSeq, 1);
  state = res.state;
  // Audit chain verifies (nothing tampered).
  assert.deepEqual(verifyTeamV14UserAuditLog(state.v14.auditEvents), { ok: true, badSeq: -1, reason: '' });
  assert.equal(state.v14.auditEvents[0].action, 'user.switch');
  assert.equal(listTeamV15Switches(state).length, 1);
  const summary = summarizeTeamV15User(state, 'u2', 'member', T0);
  assert.equal(summary.switchCount, 1);
  assert.equal(summary.lastSwitchAt, T0);
  assert.equal(summary.quotaRows.length, 9);
});

test('multi-user v4: persistence round-trip + corrupt file', () => {
  const root = tmpRoot();
  let state = createTeamV15State('team-a', T0);
  const role = createTeamV15CustomRole({ id: 'lead', name: 'Lead', baseRole: 'admin' }, 'u_owner', T0);
  state = addTeamV15CustomRole(state, role, T0).state;
  state = createTeamV15Session(state, 'u1', 'custom:lead', 'laptop', HOUR, T0).state;
  saveTeamV15State(root, state);
  const loaded = loadTeamV15State(root);
  assert.ok(loaded);
  assert.equal(loaded.teamName, 'team-a');
  assert.equal(loaded.customRoles.length, 1);
  assert.equal(loaded.sessions.length, 1);
  fs.writeFileSync(path.join(root, 'team-v118.json'), '{broken');
  assert.equal(loadTeamV15State(root), null);
  assert.equal(loadTeamV15State(path.join(root, 'missing-dir')), null);
});
