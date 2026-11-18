/**
 * Rollout theo nhóm v2 tests (v1.16, Đội T6 — node:test, no network).
 *
 * Covers:
 * - Cohort deterministic: cùng rollout + user list thì cohort không
 *   đổi; stage sau bao trọn stage trước (mở rộng đơn điệu); canary
 *   ~1%, all = 100%.
 * - State machine: draft→canary→pilot→early→general→all→complete;
 *   chuyển đổi không hợp lệ bị từ chối; pause lưu stage trước,
 *   resume quay lại đúng stage; rollback một nút trả restoreVersion.
 * - Health gate: đủ mẫu + lỗi thấp + không alert → pass; thiếu mẫu /
 *   lỗi cao / nhiều user báo lỗi / alert critical → fail từng điều
 *   kiện riêng; stage cuối không có gate.
 * - Auto action: lỗi >= 20% → rollback; >= 10% → pause; alert
 *   critical + lỗi cao → rollback; khỏe → none.
 * - Validation: version == previousVersion lỗi; id sai ký tự lỗi;
 *   trùng id lỗi.
 * - Persistence: save/load round-trip, file hỏng → null.
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/fleet-v116-rollout.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  TEAM_V13_DEPLOY_STAGES,
  TEAM_V13_ROLLOUT_TRANSITIONS,
  applyTeamV13RolloutAction,
  checkTeamV13RolloutGate,
  createTeamV13Rollout,
  createTeamV13RolloutStore,
  decideTeamV13AutoAction,
  findTeamV13Rollout,
  loadTeamV13RolloutStore,
  rollbackTeamV13Rollout,
  saveTeamV13RolloutStore,
  summarizeTeamV13Rollout,
  teamV13NextStage,
  teamV13StageCohort,
  teamV13StageLabel,
  teamV13UserInRollout,
  teamV13UserRolloutHash,
  validateTeamV13RolloutInput,
} from '../packages/core/dist/fleetV13/index.js';

const T0 = Date.UTC(2026, 10, 16, 0, 0, 0);

function tmpRoot() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-rollout-v13-')), 'team');
}

function users(n) {
  return Array.from({ length: n }, (_, i) => `u_${String(i).padStart(3, '0')}`);
}

function makeRollout(store, id = 'rollout-voice-v15') {
  const res = createTeamV13Rollout(
    store,
    { id, feature: 'voice-v15', version: 'v15', previousVersion: 'v14', createdBy: 'u_owner' },
    T0,
  );
  assert.equal(res.ok, true, res.error ?? '');
  return res;
}

test('cohort deterministic and monotone: same inputs same cohort; later stage contains earlier', () => {
  const list = users(1000);
  const canary1 = teamV13StageCohort('rollout-voice-v15', 'canary', list);
  const canary2 = teamV13StageCohort('rollout-voice-v15', 'canary', list);
  assert.deepEqual(canary1, canary2);
  // Canary ~1% (cho phép dao động hash: 2..25 trên 1000 user).
  assert.ok(canary1.length >= 2 && canary1.length <= 25, `canary size ${canary1.length}`);
  const pilot = teamV13StageCohort('rollout-voice-v15', 'pilot', list);
  const early = teamV13StageCohort('rollout-voice-v15', 'early', list);
  const general = teamV13StageCohort('rollout-voice-v15', 'general', list);
  const all = teamV13StageCohort('rollout-voice-v15', 'all', list);
  assert.equal(all.length, 1000);
  for (const u of canary1) assert.ok(pilot.includes(u), `${u} in canary but not pilot`);
  for (const u of pilot) assert.ok(early.includes(u), `${u} in pilot but not early`);
  for (const u of early) assert.ok(general.includes(u), `${u} in early but not general`);
  // Rollout khác → cohort khác (hash gồm rolloutId).
  const other = teamV13StageCohort('rollout-other', 'canary', list);
  assert.notDeepEqual(other, canary1);
  // Hash nằm trong [0, 1).
  for (const u of list.slice(0, 20)) {
    const h = teamV13UserRolloutHash('rollout-voice-v15', u);
    assert.ok(h >= 0 && h < 1);
  }
  // Stage không có % → cohort rỗng.
  assert.deepEqual(teamV13StageCohort('r', 'draft', list), []);
  assert.deepEqual(teamV13StageCohort('r', 'paused', list), []);
  assert.equal(teamV13NextStage('all'), null);
  assert.equal(teamV13NextStage('canary'), 'pilot');
  assert.equal(teamV13NextStage('draft'), null);
  assert.deepEqual(TEAM_V13_DEPLOY_STAGES, ['canary', 'pilot', 'early', 'general', 'all']);
  assert.equal(teamV13StageLabel('canary'), 'canary (1% user)');
  assert.equal(teamV13StageLabel('rolled-back'), 'đã rollback');
});

test('state machine: full walk draft→all→complete; invalid transitions rejected; pause/resume round-trip', () => {
  let store = createTeamV13RolloutStore(T0);
  const created = makeRollout(store);
  store = created.store;
  const rollout = created.rollout;
  assert.equal(rollout.stage, 'draft');
  assert.equal(rollout.history.length, 1);
  assert.equal(rollout.history[0].action, 'created');

  // Advance từ draft → lỗi (phải start trước).
  assert.equal(applyTeamV13RolloutAction(store, rollout.id, 'advance', 'u_owner', '', T0 + 1).ok, false);
  // Complete từ draft → lỗi.
  assert.equal(applyTeamV13RolloutAction(store, rollout.id, 'complete', 'u_owner', '', T0 + 1).ok, false);

  const started = applyTeamV13RolloutAction(store, rollout.id, 'start', 'u_owner', 'bắt đầu canary', T0 + 2);
  assert.equal(started.ok, true);
  assert.equal(started.rollout.stage, 'canary');
  store = started.store;

  // Pause từ canary → resume quay lại canary.
  const paused = applyTeamV13RolloutAction(store, rollout.id, 'pause', 'u_owner', 'lỗi tăng nhẹ', T0 + 3);
  assert.equal(paused.ok, true);
  assert.equal(paused.rollout.stage, 'paused');
  assert.equal(paused.rollout.stageBeforePause, 'canary');
  store = paused.store;
  const resumed = applyTeamV13RolloutAction(store, rollout.id, 'resume', 'u_owner', 'đã kiểm tra xong', T0 + 4);
  assert.equal(resumed.ok, true);
  assert.equal(resumed.rollout.stage, 'canary');
  assert.equal(resumed.rollout.stageBeforePause, null);
  store = resumed.store;

  // Đi hết các stage tới all rồi complete.
  for (const expected of ['pilot', 'early', 'general', 'all']) {
    const adv = applyTeamV13RolloutAction(store, rollout.id, 'advance', 'u_owner', '', T0 + 5);
    assert.equal(adv.ok, true, adv.error ?? '');
    assert.equal(adv.rollout.stage, expected);
    store = adv.store;
  }
  // Advance từ all → lỗi (không còn stage kế).
  assert.equal(applyTeamV13RolloutAction(store, rollout.id, 'advance', 'u_owner', '', T0 + 6).ok, false);
  const done = applyTeamV13RolloutAction(store, rollout.id, 'complete', 'u_owner', 'rollout xong', T0 + 7);
  assert.equal(done.ok, true);
  assert.equal(done.rollout.stage, 'complete');
  store = done.store;
  // Complete rồi thì không làm gì được nữa.
  assert.equal(applyTeamV13RolloutAction(store, rollout.id, 'rollback', 'u_owner', '', T0 + 8).ok, false);
  assert.equal(applyTeamV13RolloutAction(store, rollout.id, 'pause', 'u_owner', '', T0 + 8).ok, false);
  // History ghi đủ mọi chuyển đổi.
  assert.ok(findTeamV13Rollout(store, rollout.id).history.length >= 8);
  assert.deepEqual(TEAM_V13_ROLLOUT_TRANSITIONS.complete, []);
  assert.deepEqual(TEAM_V13_ROLLOUT_TRANSITIONS['rolled-back'], []);
});

test('rollback one-click: returns restoreVersion, stage rolled-back, note records version', () => {
  let store = createTeamV13RolloutStore(T0);
  const created = makeRollout(store);
  store = created.store;
  const started = applyTeamV13RolloutAction(store, created.rollout.id, 'start', 'u_owner', '', T0 + 1);
  store = started.store;
  const adv = applyTeamV13RolloutAction(store, created.rollout.id, 'advance', 'u_owner', '', T0 + 2);
  store = adv.store;
  assert.equal(findTeamV13Rollout(store, created.rollout.id).stage, 'pilot');

  const rolled = rollbackTeamV13Rollout(store, created.rollout.id, 'u_owner', 'lỗi nghiêm trọng', T0 + 3);
  assert.equal(rolled.ok, true);
  assert.equal(rolled.rollout.stage, 'rolled-back');
  assert.equal(rolled.restoreVersion, 'v14');
  assert.match(rolled.rollout.history.at(-1).action, /rollback/);
  store = rolled.store;
  // Rollback lần nữa → lỗi.
  assert.equal(rollbackTeamV13Rollout(store, created.rollout.id, 'u_owner', '', T0 + 4).ok, false);
  // Rollback rollout không tồn tại → lỗi.
  assert.equal(rollbackTeamV13Rollout(store, 'nope', 'u_owner', '', T0 + 4).ok, false);
  // Rollback từ draft cũng được (chưa start đã hủy).
  const draft = makeRollout(store, 'rollout-draft-only');
  const rbDraft = rollbackTeamV13Rollout(draft.store, 'rollout-draft-only', 'u_owner', 'hủy trước khi start', T0 + 5);
  assert.equal(rbDraft.ok, true);
  assert.equal(rbDraft.rollout.stage, 'rolled-back');
});

test('health gate: passes when healthy; each failing condition reported separately', () => {
  let store = createTeamV13RolloutStore(T0);
  const created = makeRollout(store);
  store = created.store;
  const started = applyTeamV13RolloutAction(store, created.rollout.id, 'start', 'u_owner', '', T0 + 1);
  store = started.store;
  const rollout = findTeamV13Rollout(store, created.rollout.id);
  const healthy = { sampleUsers: 50, errorRate: 0.01, reportingUsers: 1, openCriticalAlerts: 0 };
  const gateOk = checkTeamV13RolloutGate(rollout, healthy);
  assert.equal(gateOk.passed, true);
  assert.equal(gateOk.fromStage, 'canary');
  assert.equal(gateOk.toStage, 'pilot');
  assert.equal(gateOk.checks.length, 4);
  assert.ok(gateOk.checks.every((c) => c.passed));

  const smallSample = checkTeamV13RolloutGate(rollout, { ...healthy, sampleUsers: 3 });
  assert.equal(smallSample.passed, false);
  assert.equal(smallSample.checks.find((c) => c.name === 'sample').passed, false);
  assert.equal(smallSample.checks.find((c) => c.name === 'error-rate').passed, true);

  const highError = checkTeamV13RolloutGate(rollout, { ...healthy, errorRate: 0.2 });
  assert.equal(highError.passed, false);
  assert.equal(highError.checks.find((c) => c.name === 'error-rate').passed, false);

  const manyReports = checkTeamV13RolloutGate(rollout, { ...healthy, reportingUsers: 99 });
  assert.equal(manyReports.passed, false);
  assert.equal(manyReports.checks.find((c) => c.name === 'reporting-users').passed, false);

  const critical = checkTeamV13RolloutGate(rollout, { ...healthy, openCriticalAlerts: 2 });
  assert.equal(critical.passed, false);
  assert.equal(critical.checks.find((c) => c.name === 'critical-alerts').passed, false);

  // Gate ở stage cuối (all) → không có stage kế.
  const allRollout = { ...rollout, stage: 'all' };
  const noNext = checkTeamV13RolloutGate(allRollout, healthy);
  assert.equal(noNext.passed, false);
  assert.equal(noNext.toStage, null);
});

test('auto action: rollback on severe errors, pause on moderate, none when healthy', () => {
  assert.equal(decideTeamV13AutoAction({ sampleUsers: 100, errorRate: 0.25, reportingUsers: 1, openCriticalAlerts: 0 }).action, 'rollback');
  assert.equal(decideTeamV13AutoAction({ sampleUsers: 100, errorRate: 0.05, reportingUsers: 25, openCriticalAlerts: 0 }).action, 'rollback');
  assert.equal(decideTeamV13AutoAction({ sampleUsers: 100, errorRate: 0.15, reportingUsers: 1, openCriticalAlerts: 1 }).action, 'rollback');
  assert.equal(decideTeamV13AutoAction({ sampleUsers: 100, errorRate: 0.12, reportingUsers: 1, openCriticalAlerts: 0 }).action, 'pause');
  assert.equal(decideTeamV13AutoAction({ sampleUsers: 100, errorRate: 0.01, reportingUsers: 0, openCriticalAlerts: 0 }).action, 'none');
  // Alert critical nhưng lỗi thấp → không rollback (chỉ pause khi lỗi cũng cao).
  assert.equal(decideTeamV13AutoAction({ sampleUsers: 100, errorRate: 0.01, reportingUsers: 0, openCriticalAlerts: 2 }).action, 'none');
});

test('user in rollout + summary + validation + persistence', () => {
  const list = users(1000);
  let store = createTeamV13RolloutStore(T0);
  const created = makeRollout(store);
  store = created.store;
  const started = applyTeamV13RolloutAction(store, created.rollout.id, 'start', 'u_owner', '', T0 + 1);
  store = started.store;
  const rollout = findTeamV13Rollout(store, created.rollout.id);
  const inCohort = list.filter((u) => teamV13UserInRollout(rollout, u));
  assert.ok(inCohort.length >= 2 && inCohort.length <= 25);
  assert.equal(teamV13UserInRollout({ ...rollout, stage: 'draft' }, list[0]), false);
  assert.equal(teamV13UserInRollout(rollout, ''), false);

  const summary = summarizeTeamV13Rollout(rollout, list);
  assert.equal(summary.stage, 'canary');
  assert.equal(summary.percent, 1);
  assert.equal(summary.cohortSize, inCohort.length);
  assert.equal(summary.totalUsers, 1000);
  assert.match(summary.summary, /canary/);

  // Validation.
  assert.ok(validateTeamV13RolloutInput({ id: '', feature: 'f', version: 'v2', previousVersion: 'v1', createdBy: 'u' }).length > 0);
  assert.ok(validateTeamV13RolloutInput({ id: 'bad id!', feature: 'f', version: 'v2', previousVersion: 'v1', createdBy: 'u' }).length > 0);
  assert.ok(validateTeamV13RolloutInput({ id: 'r1', feature: 'f', version: 'v1', previousVersion: 'v1', createdBy: 'u' }).length > 0);
  assert.deepEqual(validateTeamV13RolloutInput({ id: 'r1', feature: 'f', version: 'v2', previousVersion: 'v1', createdBy: 'u' }), []);
  // Trùng id → lỗi.
  assert.equal(createTeamV13Rollout(store, { id: created.rollout.id, feature: 'f', version: 'v9', previousVersion: 'v8', createdBy: 'u_owner' }, T0).ok, false);
  assert.equal(findTeamV13Rollout(store, 'nope'), null);

  // Persistence.
  const root = tmpRoot();
  saveTeamV13RolloutStore(root, store);
  const loaded = loadTeamV13RolloutStore(root);
  assert.ok(loaded);
  assert.equal(loaded.rollouts.length, 1);
  assert.equal(loaded.rollouts[0].stage, 'canary');
  assert.equal(loaded.rollouts[0].history.length, 2);
  fs.writeFileSync(path.join(root, 'rollouts-v116.json'), '{bad');
  assert.equal(loadTeamV13RolloutStore(root), null);
  assert.equal(loadTeamV13RolloutStore(path.join(root, 'missing')), null);
});
