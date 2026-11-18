/**
 * Fleet rollout v12 tests (v1.15, Đội T6 — node:test, no network).
 *
 * Covers:
 * - Cohort deterministic: cùng rollout + cùng node -> cùng cohort;
 *   cohort mức cao bao hàm mức thấp; canary đúng 1 node; 100% = all.
 * - Validation: tên/feature/version trống, node rỗng/trùng.
 * - State machine: draft -> start -> canary -> advance -> expanding
 *   -> complete; pause/resume; rollback từ mọi giai đoạn đang chạy;
 *   chuyển đổi sai bị từ chối, không mutate.
 * - Gate: chặn khi cohort chưa xong, error rate vượt ngưỡng, node
 *   down quá nhiều, alert critical ở cohort tiếp theo, cohort tiếp
 *   theo thiếu healthy; hết mức thì advance sẽ complete.
 * - Auto action: rollback khi lỗi nặng / nhiều node down / alert
 *   critical trên cohort đang chạy; pause khi lỗi vừa; none khi khỏe
 *   hoặc rollout không chạy.
 * - Persistence: save/load round-trip, add/update/find, id trùng
 *   không thêm trùng, file hỏng -> [].
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/fleet-v115-rollout.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  FLEET_V12_ROLLOUT_PERCENTAGES,
  addFleetV12Rollout,
  applyFleetV12RolloutAction,
  checkFleetV12RolloutGate,
  computeFleetV12Cohort,
  createFleetV12Rollout,
  decideFleetV12AutoAction,
  findFleetV12Rollout,
  fleetV12CohortErrorRate,
  fleetV12NodeHash,
  fleetV12PercentageLabel,
  getFleetV12RolloutsPath,
  loadFleetV12Rollouts,
  markFleetV12CohortDone,
  recordFleetV12CohortProgress,
  saveFleetV12Rollouts,
  summarizeFleetV12Rollout,
  updateFleetV12Rollout,
  validateFleetV12RolloutInput,
} from '../packages/core/dist/index.js';

const T0 = Date.UTC(2026, 10, 16, 0, 0, 0);
const NODES = ['node-1', 'node-2', 'node-3', 'node-4', 'node-5', 'node-6', 'node-7', 'node-8'];

function tmpFleetRoot() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-fleet-v12-rollout-')), 'fleet');
}

function makeInput(overrides = {}) {
  return {
    name: 'Model qwen3-4b',
    description: 'Rollout model qwen3-4b cho fleet.',
    feature: 'local-model-qwen3-4b',
    version: '2.4.0',
    previousVersion: '2.3.1',
    allNodeIds: [...NODES],
    createdBy: 'admin',
    ...overrides,
  };
}

function makeRollout(overrides = {}) {
  return createFleetV12Rollout(makeInput(overrides), T0);
}

function startRollout(r = makeRollout()) {
  const res = applyFleetV12RolloutAction(r, 'start', 'admin', 'bắt đầu canary', T0);
  assert.equal(res.ok, true, res.ok ? '' : res.error);
  return res.rollout;
}

function doneCohort(r, pct) {
  return markFleetV12CohortDone(recordFleetV12CohortProgress(r, pct, 1, 0, T0), pct, T0);
}

test('cohort deterministic + bao ham + canary 1 node + 100% = all', () => {
  const r = makeRollout();
  assert.deepEqual(FLEET_V12_ROLLOUT_PERCENTAGES, [1, 25, 50, 100]);
  assert.equal(fleetV12PercentageLabel(1), 'canary (1 node)');
  assert.equal(fleetV12PercentageLabel(25), '25%');
  const [c1, c25, c50, c100] = r.cohorts.map((c) => c.nodeIds);
  assert.equal(c1.length, 1);
  assert.equal(c25.length, 2);
  assert.equal(c50.length, 4);
  assert.equal(c100.length, 8);
  // Cohort mức cao bao hàm mức thấp (mở rộng, không đổi nhóm).
  assert.ok(c25.includes(c1[0]));
  assert.ok(c25.every((n) => c50.includes(n)), 'cohort 50% phai bao ham cohort 25%');
  assert.deepEqual([...c100].sort(), [...NODES].sort());
  // Deterministic: tính lại cùng rollout id -> cùng cohort.
  assert.deepEqual(computeFleetV12Cohort(r.id, NODES, 25), c25);
  assert.deepEqual(computeFleetV12Cohort(r.id, NODES, 25), computeFleetV12Cohort(r.id, NODES, 25));
  // Rollout khác -> hash khác (cohort có thể khác); node hash ổn định.
  const r2 = createFleetV12Rollout(makeInput({ name: 'Khac' }), T0 + 1);
  assert.notEqual(r2.id, r.id);
  assert.equal(fleetV12NodeHash(r.id, 'node-1'), fleetV12NodeHash(r.id, 'node-1'));
  // 1 node duy nhất: mọi mức đều chỉ có node đó.
  const solo = createFleetV12Rollout(makeInput({ allNodeIds: ['node-1'] }), T0);
  assert.ok(solo.cohorts.every((c) => c.nodeIds.length === 1 && c.nodeIds[0] === 'node-1'));
  // Node rỗng bị loại khỏi cohort.
  assert.deepEqual(computeFleetV12Cohort(r.id, [], 50), []);
});

test('validation: truong trong, node rong/trung', () => {
  assert.ok(validateFleetV12RolloutInput(makeInput({ name: '  ' })).length > 0);
  assert.ok(validateFleetV12RolloutInput(makeInput({ feature: '' })).length > 0);
  assert.ok(validateFleetV12RolloutInput(makeInput({ version: '' })).length > 0);
  assert.ok(validateFleetV12RolloutInput(makeInput({ previousVersion: '' })).length > 0);
  assert.ok(validateFleetV12RolloutInput(makeInput({ createdBy: '' })).length > 0);
  assert.ok(validateFleetV12RolloutInput(makeInput({ allNodeIds: [] })).length > 0);
  assert.ok(validateFleetV12RolloutInput(makeInput({ allNodeIds: ['node-1', 'node-1'] })).length > 0);
  assert.ok(validateFleetV12RolloutInput(makeInput({ allNodeIds: ['node-1', ''] })).length > 0);
  assert.deepEqual(validateFleetV12RolloutInput(makeInput()), []);
  assert.throws(() => createFleetV12Rollout(makeInput({ name: '' }), T0), /không hợp lệ/);
  const r = makeRollout();
  assert.equal(r.stage, 'draft');
  assert.equal(r.cohorts.length, 4);
  assert.equal(r.history.length, 1);
  assert.equal(r.history[0].action, 'create');
});

test('state machine: start -> advance -> complete; pause/resume; rollback; chuyen sai bi tu choi', () => {
  const r0 = makeRollout();
  // advance/pause từ draft đều sai.
  assert.equal(applyFleetV12RolloutAction(r0, 'advance', 'admin', 'x', T0).ok, false);
  assert.equal(applyFleetV12RolloutAction(r0, 'pause', 'admin', 'x', T0).ok, false);
  assert.equal(applyFleetV12RolloutAction(r0, 'start', '', 'x', T0).ok, false);
  assert.equal(applyFleetV12RolloutAction(r0, 'start', 'admin', '', T0).ok, false);
  const r1 = startRollout(r0);
  assert.equal(r1.stage, 'canary');
  assert.equal(r1.activeCohortIndex, 0);
  assert.equal(r1.cohorts[0].status, 'active');
  assert.ok(r1.cohorts[0].startedAt !== null);
  // advance khi cohort chưa done -> lỗi, không đổi stage.
  const blocked = applyFleetV12RolloutAction(r1, 'advance', 'admin', 'mở rộng', T0);
  assert.equal(blocked.ok, false);
  assert.ok(blocked.error.includes('chưa xong'));
  assert.equal(blocked.rollout.stage, 'canary');
  // pause/resume từ canary.
  const paused = applyFleetV12RolloutAction(r1, 'pause', 'admin', 'tạm dừng', T0);
  assert.equal(paused.ok, true);
  assert.equal(paused.rollout.stage, 'paused');
  const resumed = applyFleetV12RolloutAction(paused.rollout, 'resume', 'admin', 'tiếp tục', T0);
  assert.equal(resumed.ok, true);
  assert.equal(resumed.rollout.stage, 'canary');
  // Đi hết 4 mức -> complete.
  let r = resumed.rollout;
  for (const pct of [1, 25, 50, 100]) {
    r = doneCohort(r, pct);
    const adv = applyFleetV12RolloutAction(r, 'advance', 'admin', `mở rộng ${pct}%`, T0);
    assert.equal(adv.ok, true, adv.ok ? '' : adv.error);
    r = adv.rollout;
  }
  assert.equal(r.stage, 'complete');
  assert.equal(r.activeCohortIndex, null);
  assert.ok(r.cohorts.every((c) => c.status === 'done'));
  // complete thì không còn action nào hợp lệ.
  assert.equal(applyFleetV12RolloutAction(r, 'rollback', 'admin', 'x', T0).ok, false);
  // rollback từ expanding: cohort active/done -> rolled-back, pending giữ nguyên.
  let rb = startRollout();
  rb = doneCohort(rb, 1);
  rb = applyFleetV12RolloutAction(rb, 'advance', 'admin', 'mở rộng', T0).rollout;
  assert.equal(rb.stage, 'expanding');
  const rolled = applyFleetV12RolloutAction(rb, 'rollback', 'admin', 'lỗi nặng', T0);
  assert.equal(rolled.ok, true);
  assert.equal(rolled.rollout.stage, 'rolled-back');
  assert.equal(rolled.rollout.cohorts[0].status, 'rolled-back');
  assert.equal(rolled.rollout.cohorts[1].status, 'rolled-back');
  assert.equal(rolled.rollout.cohorts[2].status, 'pending');
  assert.ok(rolled.rollout.history.some((h) => h.action === 'rollback'));
  // complete sớm từ canary.
  const early = applyFleetV12RolloutAction(startRollout(), 'complete', 'admin', 'đủ rồi', T0);
  assert.equal(early.ok, true);
  assert.equal(early.rollout.stage, 'complete');
  assert.equal(early.rollout.cohorts[0].status, 'done');
});

test('group progress: kep so, error rate tinh dung, mark done chi tac dong cohort active', () => {
  let r = startRollout();
  r = recordFleetV12CohortProgress(r, 1, 99, 99, T0);
  assert.equal(r.cohorts[0].appliedCount, 1);
  assert.equal(r.cohorts[0].errorCount, 1);
  assert.equal(fleetV12CohortErrorRate(r.cohorts[0]), 0.5);
  r = recordFleetV12CohortProgress(r, 1, -5, -2, T0);
  assert.equal(r.cohorts[0].appliedCount, 0);
  assert.equal(r.cohorts[0].errorCount, 0);
  assert.equal(fleetV12CohortErrorRate(r.cohorts[0]), 0);
  // mark done cohort chưa active (25%) thì không đổi.
  const before = r;
  const after = markFleetV12CohortDone(r, 25, T0);
  assert.equal(after.cohorts[1].status, 'pending');
  assert.equal(after.cohorts[0].status, before.cohorts[0].status);
});

test('gate: chan khi cohort chua xong / loi cao / down nhieu / critical o cohort sau / thieu healthy', () => {
  const healthyAll = [...NODES];
  const gateInput = (overrides = {}) => ({
    criticalAlertNodeIds: [],
    downNodeIds: [],
    healthyNodeIds: healthyAll,
    ...overrides,
  });
  // Rollout chưa chạy -> gate chặn (stage).
  let r = makeRollout();
  assert.equal(checkFleetV12RolloutGate(r, gateInput()).allowed, false);
  // Cohort active chưa done -> chặn.
  r = startRollout();
  assert.equal(checkFleetV12RolloutGate(r, gateInput()).allowed, false);
  // Cohort done, mọi thứ khỏe -> cho phép, next = 25%.
  r = doneCohort(r, 1);
  let gate = checkFleetV12RolloutGate(r, gateInput());
  assert.equal(gate.allowed, true);
  assert.equal(gate.nextPercentage, 25);
  assert.ok(gate.checks.every((c) => c.passed));
  // Error rate vượt ngưỡng (1 lỗi / 1 áp dụng = 100%).
  r = recordFleetV12CohortProgress(doneCohort(startRollout(), 1), 1, 0, 1, T0);
  gate = checkFleetV12RolloutGate(r, gateInput());
  assert.equal(gate.allowed, false);
  assert.equal(gate.checks.find((c) => c.name === 'error-rate')?.passed, false);
  // Node down trong cohort active vượt ngưỡng: sang cohort 25% (2 node),
  // down cả 2 node -> 2 > ngưỡng 1 -> chặn.
  r = doneCohort(startRollout(), 1);
  r = applyFleetV12RolloutAction(r, 'advance', 'admin', 'mở rộng 25%', T0).rollout;
  r = doneCohort(r, 25);
  gate = checkFleetV12RolloutGate(r, gateInput({ downNodeIds: [...r.cohorts[1].nodeIds] }));
  assert.equal(gate.checks.find((c) => c.name === 'down-nodes')?.passed, false);
  assert.equal(gate.allowed, false);
  // Chỉ down 1/2 node -> vẫn qua check down-nodes.
  gate = checkFleetV12RolloutGate(r, gateInput({ downNodeIds: [r.cohorts[1].nodeIds[0]] }));
  assert.equal(gate.checks.find((c) => c.name === 'down-nodes')?.passed, true);
  // Alert critical trên cohort 25% -> chặn.
  const next25 = r.cohorts[1].nodeIds;
  gate = checkFleetV12RolloutGate(r, gateInput({ criticalAlertNodeIds: [next25[0]] }));
  assert.equal(gate.allowed, false);
  assert.equal(gate.checks.find((c) => c.name === 'no-critical-alert')?.passed, false);
  // Cohort tiếp theo thiếu healthy (0 healthy) -> chặn.
  gate = checkFleetV12RolloutGate(r, gateInput({ healthyNodeIds: [] }));
  assert.equal(gate.allowed, false);
  assert.equal(gate.checks.find((c) => c.name === 'next-cohort-healthy')?.passed, false);
  // Hết mức: cohort 100% done -> gate cho phép, next = null.
  let full = startRollout();
  for (const pct of [1, 25, 50, 100]) {
    full = doneCohort(full, pct);
    if (pct !== 100) full = applyFleetV12RolloutAction(full, 'advance', 'admin', 'mở rộng', T0).rollout;
  }
  gate = checkFleetV12RolloutGate(full, gateInput());
  assert.equal(gate.allowed, true);
  assert.equal(gate.nextPercentage, null);
});

test('auto action: rollback khi loi nang / down nhieu / critical; pause khi loi vua; none khi khoe', () => {
  const health = (down = [], critical = []) => ({ downNodeIds: down, criticalAlertNodeIds: critical });
  // Rollout không chạy -> none.
  let d = decideFleetV12AutoAction(makeRollout(), health(['node-1']));
  assert.equal(d.action, 'none');
  // Khỏe -> none.
  let r = startRollout();
  d = decideFleetV12AutoAction(r, health());
  assert.equal(d.action, 'none');
  assert.equal(d.errorRate, 0);
  // Lỗi vừa (1 lỗi / 9 áp dụng không thể với canary 1 node — dùng cohort 25%: 2 node, 1 lỗi/1 áp dụng = 50% > pause 10%, < rollback 20%? 50% > 20% nên rollback. Dùng ngưỡng tùy chỉnh để test pause.
  r = doneCohort(startRollout(), 1);
  r = applyFleetV12RolloutAction(r, 'advance', 'admin', 'mở rộng', T0).rollout;
  r = recordFleetV12CohortProgress(r, 25, 1, 1, T0);
  d = decideFleetV12AutoAction(r, health(), { pauseErrorRate: 0.1, rollbackErrorRate: 0.9 });
  assert.equal(d.action, 'pause');
  assert.ok(d.reasons.some((x) => x.includes('pause')));
  // Lỗi nặng mặc định (50% > 20%) -> rollback.
  d = decideFleetV12AutoAction(r, health());
  assert.equal(d.action, 'rollback');
  assert.ok(d.reasons.some((x) => x.includes('rollback')));
  // Nhiều node down -> rollback (dùng ngưỡng tùy chỉnh 1 để cohort 2 node đủ vượt).
  r = doneCohort(startRollout(), 1);
  r = applyFleetV12RolloutAction(r, 'advance', 'admin', 'mở rộng', T0).rollout;
  const cohort25 = r.cohorts[1].nodeIds;
  d = decideFleetV12AutoAction(r, health([...cohort25, 'node-x', 'node-y']), { rollbackDownNodes: 1 });
  assert.equal(d.action, 'rollback');
  assert.ok(d.reasons.some((x) => x.includes('down')));
  // Alert critical trên cohort đang chạy -> rollback.
  d = decideFleetV12AutoAction(r, health([], [cohort25[0]]));
  assert.equal(d.action, 'rollback');
  assert.ok(d.reasons.some((x) => x.includes('nghiêm trọng')));
  // 1 node down (ngưỡng pause = 1, không vượt) -> none.
  d = decideFleetV12AutoAction(r, health([cohort25[0]]));
  assert.equal(d.action, 'none');
});

test('summary + persistence: tien do, file v115, id trung khong them', () => {
  const r = startRollout();
  const p = summarizeFleetV12Rollout(r);
  assert.equal(p.total, 8);
  assert.equal(p.totalCohorts, 4);
  assert.equal(p.activePercentage, 1);
  assert.ok(p.summary.includes('canary'));
  const done = summarizeFleetV12Rollout(applyFleetV12RolloutAction(doneCohort(r, 1), 'complete', 'admin', 'x', T0).rollout);
  assert.ok(done.summary.includes('hoàn tất'));
  const root = tmpFleetRoot();
  assert.deepEqual(loadFleetV12Rollouts(root), []);
  assert.ok(getFleetV12RolloutsPath(root).endsWith('fleet-rollouts-v115.json'));
  const r1 = makeRollout();
  saveFleetV12Rollouts(root, addFleetV12Rollout([], r1));
  assert.equal(loadFleetV12Rollouts(root).length, 1);
  assert.equal(findFleetV12Rollout(loadFleetV12Rollouts(root), r1.id)?.name, 'Model qwen3-4b');
  assert.equal(findFleetV12Rollout(loadFleetV12Rollouts(root), 'khong-co'), null);
  // Id trùng không thêm trùng.
  assert.equal(addFleetV12Rollout(loadFleetV12Rollouts(root), r1).length, 1);
  // Update + update id không tồn tại giữ nguyên.
  const r2 = { ...r1, name: 'Doi ten' };
  assert.equal(updateFleetV12Rollout(loadFleetV12Rollouts(root), r2)[0].name, 'Doi ten');
  assert.equal(updateFleetV12Rollout(loadFleetV12Rollouts(root), { ...r1, id: 'khong-co' }).length, 1);
  fs.writeFileSync(getFleetV12RolloutsPath(root), 'khong-phai-json');
  assert.deepEqual(loadFleetV12Rollouts(root), []);
});
