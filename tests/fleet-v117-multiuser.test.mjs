/**
 * Multi-user v3 tests (v1.17, Đội T6 — node:test, no network).
 *
 * Covers:
 * - Role default quotas: owner unlimited, viewer lowest, unknown role → 0.
 * - consumeQuota: within quota ok, over quota rejected with remaining,
 *   daily window resets next day, level quotas (bots/storage) persist.
 * - Overrides: set/clear per-user override, invalid limit rejected.
 * - Grants: deny beats role default and explicit allow; allow grants
 *   viewer tool use; expired grant ignored; revoke = deny.
 * - Per-user audit: hash chain, verify detects tamper/sequence gap,
 *   filter by user/action/time.
 * - Persistence: save/load round-trip, corrupt file → null.
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/fleet-v117-multiuser.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  appendTeamV14UserAuditEvent,
  appendTeamV14UserAuditToFile,
  canUserAccessTeamV14Bot,
  canUserUseTeamV14Tool,
  consumeTeamV14Quota,
  createTeamV14QuotaState,
  filterTeamV14UserAudit,
  findTeamV14Grant,
  grantTeamV14Access,
  listAccessibleTeamV14Targets,
  listTeamV14UserGrants,
  loadTeamV14QuotaState,
  pruneTeamV14Usage,
  readTeamV14UserAuditFromFile,
  releaseTeamV14Quota,
  revokeTeamV14Access,
  saveTeamV14QuotaState,
  setTeamV14QuotaOverride,
  summarizeTeamV14Quota,
  summarizeTeamV14User,
  teamV14DayKey,
  teamV14HasQuota,
  teamV14QuotaLimitFor,
  teamV14QuotaRemaining,
  teamV14UsedAmount,
  verifyTeamV14UserAuditLog,
} from '../packages/core/dist/fleetV14/index.js';

const T0 = Date.UTC(2026, 10, 16, 0, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

function tmpRoot() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-team-v14-')), 'team');
}

test('role default quotas: owner unlimited, viewer lowest, unknown role fail-closed', () => {
  assert.equal(teamV14QuotaLimitFor('owner', 'tokens-per-day'), -1);
  assert.equal(teamV14QuotaLimitFor('admin', 'tokens-per-day'), 10_000_000);
  assert.equal(teamV14QuotaLimitFor('member', 'tokens-per-day'), 1_000_000);
  assert.equal(teamV14QuotaLimitFor('viewer', 'tokens-per-day'), 100_000);
  assert.equal(teamV14QuotaLimitFor('viewer', 'concurrent-runs'), 1);
  assert.equal(teamV14QuotaLimitFor('member', 'bots'), 50);
  assert.equal(teamV14QuotaLimitFor('superuser', 'tokens-per-day'), 0);
  assert.equal(teamV14QuotaLimitFor(null, 'tokens-per-day'), 0);
  assert.equal(teamV14DayKey(T0), '2026-11-16');
});

test('consumeQuota: within quota ok, over quota rejected, daily reset next day', () => {
  let state = createTeamV14QuotaState('Team', T0);
  const r1 = consumeTeamV14Quota(state, 'u_member', 'member', 'tokens-per-day', 400_000, T0);
  assert.equal(r1.ok, true);
  assert.equal(r1.remaining, 600_000);
  state = r1.state;
  assert.equal(teamV14UsedAmount(state, 'u_member', 'tokens-per-day', T0), 400_000);
  assert.equal(teamV14HasQuota(state, 'u_member', 'member', 'tokens-per-day', 600_000, T0), true);
  assert.equal(teamV14HasQuota(state, 'u_member', 'member', 'tokens-per-day', 600_001, T0), false);
  const over = consumeTeamV14Quota(state, 'u_member', 'member', 'tokens-per-day', 600_001, T0);
  assert.equal(over.ok, false);
  assert.equal(over.remaining, 600_000);
  assert.match(over.reason, /quota exceeded/);
  assert.equal(over.state, state, 'rejected consume must not change state');
  // Next day: daily window resets.
  const nextDay = consumeTeamV14Quota(state, 'u_member', 'member', 'tokens-per-day', 1_000_000, T0 + DAY);
  assert.equal(nextDay.ok, true);
  assert.equal(nextDay.remaining, 0);
  // Owner unlimited: consume does not track.
  const owner = consumeTeamV14Quota(state, 'u_owner', 'owner', 'tokens-per-day', 999_999_999, T0);
  assert.equal(owner.ok, true);
  assert.equal(owner.remaining, -1);
});

test('level quotas (bots/storage) persist across days, release returns quota', () => {
  let state = createTeamV14QuotaState('Team', T0);
  const r1 = consumeTeamV14Quota(state, 'u_member', 'member', 'bots', 3, T0);
  assert.equal(r1.ok, true);
  state = r1.state;
  assert.equal(teamV14UsedAmount(state, 'u_member', 'bots', T0 + DAY), 3, 'level quota survives day change');
  const over = consumeTeamV14Quota(state, 'u_member', 'member', 'bots', 48, T0 + DAY);
  assert.equal(over.ok, false);
  state = releaseTeamV14Quota(state, 'u_member', 'bots', 2, T0 + DAY);
  assert.equal(teamV14UsedAmount(state, 'u_member', 'bots', T0 + DAY), 1);
  // Release more than used clamps at 0; daily quota is never released.
  state = releaseTeamV14Quota(state, 'u_member', 'bots', 99, T0 + DAY);
  assert.equal(teamV14UsedAmount(state, 'u_member', 'bots', T0 + DAY), 0);
  const r2 = consumeTeamV14Quota(state, 'u_member', 'member', 'tokens-per-day', 100, T0);
  const released = releaseTeamV14Quota(r2.state, 'u_member', 'tokens-per-day', 100, T0);
  assert.equal(teamV14UsedAmount(released, 'u_member', 'tokens-per-day', T0), 100);
});

test('quota override: set/clear per user, invalid values rejected', () => {
  let state = createTeamV14QuotaState('Team', T0);
  const bad = setTeamV14QuotaOverride(state, 'u_member', 'tokens-per-day', 100.5, T0);
  assert.equal(bad.ok, false);
  const bad2 = setTeamV14QuotaOverride(state, 'u_member', 'tokens-per-day', -2, T0);
  assert.equal(bad2.ok, false);
  const set = setTeamV14QuotaOverride(state, 'u_member', 'tokens-per-day', 5_000_000, T0);
  assert.equal(set.ok, true);
  state = set.state;
  assert.equal(teamV14QuotaLimitFor('member', 'tokens-per-day', state.overrides.u_member), 5_000_000);
  assert.equal(teamV14QuotaRemaining(state, 'u_member', 'member', 'tokens-per-day', T0), 5_000_000);
  const clear = setTeamV14QuotaOverride(state, 'u_member', 'tokens-per-day', null, T0);
  assert.equal(clear.ok, true);
  assert.equal(teamV14QuotaLimitFor('member', 'tokens-per-day', clear.state.overrides.u_member ?? {}), 1_000_000);
  // Unlimited override.
  const unlim = setTeamV14QuotaOverride(state, 'u_viewer', 'bots', -1, T0);
  assert.equal(unlim.ok, true);
  assert.equal(teamV14QuotaLimitFor('viewer', 'bots', unlim.state.overrides.u_viewer), -1);
});

test('grants: deny beats everything, allow grants viewer tool use, expired ignored', () => {
  let state = createTeamV14QuotaState('Team', T0);
  // Role defaults: viewer can run bots but not use tools.
  assert.equal(canUserAccessTeamV14Bot(state, 'u_viewer', 'viewer', 'bot-a', T0), true);
  assert.equal(canUserUseTeamV14Tool(state, 'u_viewer', 'viewer', 'fleetV13.pinModel', T0), false);
  assert.equal(canUserUseTeamV14Tool(state, 'u_member', 'member', 'fleetV13.pinModel', T0), true);
  assert.equal(canUserAccessTeamV14Bot(state, 'u_x', null, 'bot-a', T0), false, 'unknown role fail-closed');
  // Explicit allow grants viewer tool use.
  const g1 = grantTeamV14Access(state, 'u_viewer', 'tool', 'fleetV13.pinModel', 'allow', 'u_owner', 'need pin', 0, T0);
  assert.equal(g1.ok, true);
  state = g1.state;
  assert.equal(canUserUseTeamV14Tool(state, 'u_viewer', 'viewer', 'fleetV13.pinModel', T0), true);
  // Deny beats allow (newer grant wins) and beats owner role default.
  const g2 = grantTeamV14Access(state, 'u_owner', 'bot', 'bot-secret', 'deny', 'u_owner', 'locked bot', 0, T0 + 1);
  state = g2.state;
  assert.equal(canUserAccessTeamV14Bot(state, 'u_owner', 'owner', 'bot-secret', T0 + 1), false);
  // Expired grant is ignored.
  const g3 = grantTeamV14Access(state, 'u_viewer', 'tool', 'tool-old', 'allow', 'u_owner', '', 1000, T0);
  state = g3.state;
  assert.equal(canUserUseTeamV14Tool(state, 'u_viewer', 'viewer', 'tool-old', T0 + 2000), false);
  assert.equal(findTeamV14Grant(state, 'u_viewer', 'tool', 'tool-old', T0 + 2000), null);
  // Revoke = deny grant.
  const r = revokeTeamV14Access(state, 'u_viewer', 'tool', 'fleetV13.pinModel', 'u_owner', 'abuse', T0 + 2);
  state = r.state;
  assert.equal(canUserUseTeamV14Tool(state, 'u_viewer', 'viewer', 'fleetV13.pinModel', T0 + 2), false);
  // List accessible targets.
  const bots = listAccessibleTeamV14Targets(state, 'u_owner', 'owner', 'bot', ['bot-a', 'bot-secret'], T0);
  assert.deepEqual(bots, ['bot-a']);
  assert.equal(listTeamV14UserGrants(state, 'u_viewer', T0 + 2).length, 3);
});

test('summarize quota + user summary: tightest quota, grants, audit count', () => {
  let state = createTeamV14QuotaState('Team', T0);
  const r1 = consumeTeamV14Quota(state, 'u_member', 'member', 'tokens-per-day', 900_000, T0);
  state = r1.state;
  const rows = summarizeTeamV14Quota(state, 'u_member', 'member', T0);
  assert.equal(rows.length, 6);
  const tokens = rows.find((r) => r.kind === 'tokens-per-day');
  assert.equal(tokens.used, 900_000);
  assert.equal(tokens.remaining, 100_000);
  assert.equal(tokens.usedFraction, 0.9);
  assert.equal(tokens.daily, true);
  assert.ok(tokens.resetAt > T0);
  const summary = summarizeTeamV14User(state, 'u_member', 'member', T0);
  assert.equal(summary.tightestQuota, 'tokens-per-day');
  assert.equal(summary.tightestFraction, 0.9);
  assert.equal(summary.auditEventCount, 0);
});

test('per-user audit: hash chain, filter, tamper detection', () => {
  let state = createTeamV14QuotaState('Team', T0);
  state = appendTeamV14UserAuditEvent(state, { userId: 'u_member', actorUserId: 'u_owner', actorRole: 'owner', action: 'set-quota', target: 'tokens-per-day', detail: 'override 5M' }, T0);
  state = appendTeamV14UserAuditEvent(state, { userId: 'u_member', actorUserId: 'u_owner', actorRole: 'owner', action: 'grant-access', target: 'bot-a', detail: 'allow' }, T0 + 1);
  state = appendTeamV14UserAuditEvent(state, { userId: 'u_viewer', actorUserId: 'u_admin', actorRole: 'admin', action: 'grant-access', target: 'bot-a', detail: 'allow' }, T0 + 2);
  assert.equal(state.auditEvents.length, 3);
  assert.deepEqual(state.auditEvents.map((e) => e.seq), [1, 2, 3]);
  assert.equal(verifyTeamV14UserAuditLog(state.auditEvents).ok, true);
  const mine = filterTeamV14UserAudit(state, { userId: 'u_member' });
  assert.equal(mine.length, 2);
  assert.equal(mine[0].seq, 2, 'newest first');
  assert.equal(filterTeamV14UserAudit(state, { action: 'set-quota' }).length, 1);
  assert.equal(filterTeamV14UserAudit(state, { fromMs: T0 + 2 }).length, 1);
  // Tamper with content → verify fails at that seq.
  const tampered = state.auditEvents.map((e) => (e.seq === 2 ? { ...e, detail: 'CHANGED' } : e));
  const bad = verifyTeamV14UserAuditLog(tampered);
  assert.equal(bad.ok, false);
  assert.equal(bad.badSeq, 2);
  // Delete a line → sequence gap.
  const deleted = state.auditEvents.filter((e) => e.seq !== 2);
  assert.equal(verifyTeamV14UserAuditLog(deleted).ok, false);
  assert.equal(verifyTeamV14UserAuditLog(deleted).badSeq, 3);
});

test('persistence: save/load round-trip, corrupt file returns null, audit file', () => {
  const root = tmpRoot();
  let state = createTeamV14QuotaState('Team', T0);
  state = appendTeamV14UserAuditEvent(state, { userId: 'u_member', actorUserId: 'u_owner', actorRole: 'owner', action: 'set-quota', target: 'bots', detail: 'override 100' }, T0);
  saveTeamV14QuotaState(root, state);
  const loaded = loadTeamV14QuotaState(root);
  assert.ok(loaded);
  assert.equal(loaded.teamName, 'Team');
  assert.equal(loaded.auditEvents.length, 1);
  assert.equal(verifyTeamV14UserAuditLog(loaded.auditEvents).ok, true);
  appendTeamV14UserAuditToFile(root, state.auditEvents[0]);
  const fromFile = readTeamV14UserAuditFromFile(root);
  assert.equal(fromFile.length, 1);
  assert.equal(fromFile[0].hash, state.auditEvents[0].hash);
  fs.writeFileSync(path.join(root, 'team-quotas-v117.json'), '{not json');
  assert.equal(loadTeamV14QuotaState(root), null);
  assert.equal(loadTeamV14QuotaState(path.join(root, 'missing')), null);
});

test('prune usage: old days dropped, current level kept', () => {
  let state = createTeamV14QuotaState('Team', T0);
  const r1 = consumeTeamV14Quota(state, 'u_member', 'member', 'tokens-per-day', 100, T0);
  state = r1.state;
  const r2 = consumeTeamV14Quota(state, 'u_member', 'member', 'bots', 2, T0);
  state = r2.state;
  const pruned = pruneTeamV14Usage(state, 90, T0 + 100 * DAY);
  assert.equal(teamV14UsedAmount(pruned, 'u_member', 'tokens-per-day', T0 + 100 * DAY), 0);
  assert.equal(teamV14UsedAmount(pruned, 'u_member', 'bots', T0 + 100 * DAY), 2);
});
