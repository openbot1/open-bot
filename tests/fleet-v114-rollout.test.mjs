/**
 * Fleet rollout v11 tests (v1.14, Đội T6 — node:test, no network).
 *
 * Covers:
 * - Validation: tên/feature/version trống, targetKind sai, nhóm rỗng,
 *   target trùng giữa các nhóm, nhóm "all" không ở cuối.
 * - State machine: draft -> start -> canary -> advance (khi nhóm done)
 *   -> expanding -> complete; pause/resume; rollback từ mọi giai đoạn
 *   đang chạy; chuyển đổi sai bị từ chối kèm lý do, không mutate.
 * - Group progress: applied/error được kẹp về khoảng hợp lệ, error rate
 *   tính đúng, mark done chỉ tác động nhóm active.
 * - Gate: chặn khi nhóm chưa xong, khi error rate vượt ngưỡng, khi có
 *   alert critical ở nhóm tiếp theo, khi nhóm tiếp theo thiếu healthy;
 *   hết nhóm thì advance sẽ complete.
 * - Auto-rollback: đề xuất khi error rate vượt ngưỡng hoặc quá nhiều
 *   target down; không đề xuất khi rollout không đang chạy.
 * - Persistence: save/load round-trip, add/update/find, id trùng không
 *   thêm trùng, file hỏng -> [].
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/fleet-v114-rollout.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  addFleetV11Rollout,
  applyFleetV11RolloutAction,
  checkFleetV11RolloutGate,
  createFleetV11Rollout,
  decideFleetV11AutoRollback,
  findFleetV11Rollout,
  fleetV11GroupErrorRate,
  loadFleetV11Rollouts,
  markFleetV11GroupDone,
  recordFleetV11GroupProgress,
  saveFleetV11Rollouts,
  summarizeFleetV11Rollout,
  updateFleetV11Rollout,
  validateFleetV11RolloutInput,
} from '../packages/core/dist/index.js';

const T0 = Date.UTC(2026, 10, 16, 0, 0, 0);

function tmpFleetRoot() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-fleet-v11-rollout-')), 'fleet');
}

function makeInput(overrides = {}) {
  return {
    name: 'Voice v12',
    description: 'Triển khai voice v12 realtime.',
    targetKind: 'node',
    feature: 'voice-v12-realtime',
    version: '2.4.0',
    previousVersion: '2.3.1',
    groups: [
      { name: 'canary', targets: ['node-1'] },
      { name: 'pilot', targets: ['node-2', 'node-3'] },
      { name: 'all', targets: ['node-4', 'node-5'] },
    ],
    createdBy: 'admin',
    ...overrides,
  };
}

function makeRollout(overrides = {}) {
  return createFleetV11Rollout(makeInput(overrides), T0);
}

function startRollout(r = makeRollout()) {
  const res = applyFleetV11RolloutAction(r, 'start', 'admin', 'bắt đầu canary', T0);
  assert.equal(res.ok, true);
  return res.rollout;
}

test('validate: bắt lỗi input xấu, nhóm all phải ở cuối, target không trùng', () => {
  assert.deepEqual(validateFleetV11RolloutInput(makeInput()), []);
  assert.ok(validateFleetV11RolloutInput(makeInput({ name: '  ' })).length > 0);
  assert.ok(validateFleetV11RolloutInput(makeInput({ feature: '' })).length > 0);
  assert.ok(validateFleetV11RolloutInput(makeInput({ targetKind: 'server' })).length > 0);
  assert.ok(validateFleetV11RolloutInput(makeInput({ groups: [] })).length > 0);
  assert.ok(
    validateFleetV11RolloutInput(
      makeInput({ groups: [{ name: 'all', targets: ['n1'] }, { name: 'x', targets: ['n2'] }] }),
    ).some((e) => e.includes('"all"')),
    'nhóm all không ở cuối phải lỗi',
  );
  assert.ok(
    validateFleetV11RolloutInput(
      makeInput({ groups: [{ name: 'a', targets: ['n1'] }, { name: 'b', targets: ['n1'] }] }),
    ).some((e) => e.includes('n1')),
    'target trùng giữa các nhóm phải lỗi',
  );
  assert.ok(
    validateFleetV11RolloutInput(
      makeInput({ groups: [{ name: 'a', targets: ['n1'] }, { name: 'a', targets: ['n2'] }] }),
    ).length > 0,
    'tên nhóm trùng phải lỗi',
  );
  assert.throws(() => createFleetV11Rollout(makeInput({ name: '' }), T0), /không hợp lệ/);
});

test('create: draft, nhóm pending, history có entry create', () => {
  const r = makeRollout();
  assert.equal(r.stage, 'draft');
  assert.equal(r.activeGroupIndex, null);
  assert.equal(r.groups.length, 3);
  assert.ok(r.groups.every((g) => g.status === 'pending' && g.startedAt === null));
  assert.equal(r.history.length, 1);
  assert.equal(r.history[0].action, 'create');
  assert.match(r.id, /^ro-voice-v12-/);
});

test('state machine: start -> canary, advance cần nhóm done, hết nhóm -> complete', () => {
  let r = makeRollout();
  const bad = applyFleetV11RolloutAction(r, 'advance', 'admin', 'x', T0);
  assert.equal(bad.ok, false, 'draft không advance được');
  assert.equal(bad.rollout.stage, 'draft', 'từ chối không đổi trạng thái');
  assert.match(bad.error, /không thể advance/);

  r = startRollout(r);
  assert.equal(r.stage, 'canary');
  assert.equal(r.activeGroupIndex, 0);
  assert.equal(r.groups[0].status, 'active');
  assert.equal(r.groups[0].startedAt, T0);

  const early = applyFleetV11RolloutAction(r, 'advance', 'admin', 'x', T0);
  assert.equal(early.ok, false, 'nhóm canary chưa done thì không advance');

  r = markFleetV11GroupDone(r, 'canary', T0 + 1000);
  assert.equal(r.groups[0].status, 'done');
  const adv = applyFleetV11RolloutAction(r, 'advance', 'admin', 'mở pilot', T0 + 2000);
  assert.equal(adv.ok, true);
  r = adv.rollout;
  assert.equal(r.stage, 'expanding');
  assert.equal(r.activeGroupIndex, 1);
  assert.equal(r.groups[1].status, 'active');

  r = markFleetV11GroupDone(r, 'pilot', T0 + 3000);
  r = applyFleetV11RolloutAction(r, 'advance', 'admin', 'mở all', T0 + 4000).rollout;
  assert.equal(r.stage, 'expanding');
  assert.equal(r.activeGroupIndex, 2);
  r = markFleetV11GroupDone(r, 'all', T0 + 5000);
  r = applyFleetV11RolloutAction(r, 'advance', 'admin', 'xong', T0 + 6000).rollout;
  assert.equal(r.stage, 'complete');
  assert.equal(r.activeGroupIndex, null);
  const after = applyFleetV11RolloutAction(r, 'rollback', 'admin', 'x', T0 + 7000);
  assert.equal(after.ok, false, 'complete rồi không rollback được nữa');
});

test('state machine: pause/resume giữ nhóm active, rollback đánh dấu nhóm, complete sớm', () => {
  let r = startRollout();
  r = applyFleetV11RolloutAction(r, 'pause', 'admin', 'tạm dừng', T0 + 1000).rollout;
  assert.equal(r.stage, 'paused');
  const resume = applyFleetV11RolloutAction(r, 'resume', 'admin', 'tiếp tục', T0 + 2000);
  assert.equal(resume.ok, true);
  assert.equal(resume.rollout.stage, 'canary', 'đang ở nhóm đầu thì resume về canary');
  r = resume.rollout;

  const rb = applyFleetV11RolloutAction(r, 'rollback', 'admin', 'lỗi canary', T0 + 3000);
  assert.equal(rb.ok, true);
  assert.equal(rb.rollout.stage, 'rolled-back');
  assert.equal(rb.rollout.groups[0].status, 'rolled-back');
  assert.equal(rb.rollout.groups[1].status, 'pending', 'nhóm chưa chạy giữ nguyên pending');
  assert.equal(rb.rollout.history.length, 5, 'create + start + pause + resume + rollback');

  let r2 = startRollout(makeRollout({ name: 'Khác' }));
  r2 = applyFleetV11RolloutAction(r2, 'complete', 'admin', 'xong sớm', T0 + 1000).rollout;
  assert.equal(r2.stage, 'complete');
  assert.equal(r2.groups[0].status, 'done', 'complete sớm đánh done nhóm active');

  const noActor = applyFleetV11RolloutAction(makeRollout(), 'start', '', 'x', T0);
  assert.equal(noActor.ok, false, 'actor trống bị từ chối');
  const noReason = applyFleetV11RolloutAction(makeRollout(), 'start', 'admin', '', T0);
  assert.equal(noReason.ok, false, 'reason trống bị từ chối');
});

test('progress: kẹp số liệu, error rate, summarize', () => {
  let r = startRollout();
  r = recordFleetV11GroupProgress(r, 'canary', 99, 99, T0 + 1000);
  assert.equal(r.groups[0].appliedCount, 1, 'applied kẹp về tổng target');
  assert.equal(r.groups[0].errorCount, 1, 'error kẹp về tổng target');
  r = recordFleetV11GroupProgress(r, 'canary', -5, -2, T0 + 2000);
  assert.equal(r.groups[0].appliedCount, 0);
  assert.equal(r.groups[0].errorCount, 0);
  assert.equal(fleetV11GroupErrorRate(r.groups[0]), 0);
  r = recordFleetV11GroupProgress(r, 'canary', 8, 2, T0 + 3000);
  // applied kẹp về 1 target -> error rate = 1/(1+1) = 0.5 (vì error cũng kẹp 1)
  assert.equal(fleetV11GroupErrorRate(r.groups[0]), 0.5);
  const p = summarizeFleetV11Rollout(r);
  assert.equal(p.total, 5);
  assert.equal(p.totalGroups, 3);
  assert.equal(p.doneGroups, 0);
  assert.equal(p.activeGroupName, 'canary');
  assert.match(p.summary, /nhóm "canary"/);
});

test('gate: chặn khi nhóm chưa xong / lỗi cao / alert critical / thiếu healthy', () => {
  let r = startRollout();
  let gate = checkFleetV11RolloutGate(r, { criticalAlertTargetIds: [], healthyTargetIds: ['node-2', 'node-3'] });
  assert.equal(gate.allowed, false, 'nhóm canary chưa done');
  assert.ok(gate.checks.some((c) => c.name === 'group-done' && !c.passed));

  r = markFleetV11GroupDone(r, 'canary', T0 + 1000);
  gate = checkFleetV11RolloutGate(r, { criticalAlertTargetIds: [], healthyTargetIds: ['node-2', 'node-3'] });
  assert.equal(gate.allowed, true);
  assert.equal(gate.nextGroupName, 'pilot');

  // Error rate cao (nhóm canary 1 target: applied 1 + error 1 -> 50%).
  r = recordFleetV11GroupProgress(r, 'canary', 1, 1, T0 + 2000);
  gate = checkFleetV11RolloutGate(r, { criticalAlertTargetIds: [], healthyTargetIds: ['node-2', 'node-3'] });
  assert.equal(gate.allowed, false, 'error rate 50% > 5%');
  assert.ok(gate.checks.some((c) => c.name === 'error-rate' && !c.passed));

  r = recordFleetV11GroupProgress(r, 'canary', 1, 0, T0 + 3000);
  gate = checkFleetV11RolloutGate(r, { criticalAlertTargetIds: ['node-2'], healthyTargetIds: ['node-2', 'node-3'] });
  assert.equal(gate.allowed, false, 'node-2 có alert critical');
  assert.ok(gate.checks.some((c) => c.name === 'no-critical-alert' && !c.passed));

  gate = checkFleetV11RolloutGate(r, { criticalAlertTargetIds: [], healthyTargetIds: [] });
  assert.equal(gate.allowed, false, 'nhóm pilot 0/2 healthy (cần ít nhất 1)');
  assert.ok(gate.checks.some((c) => c.name === 'next-group-healthy' && !c.passed));

  // Draft thì gate chặn ngay.
  const draftGate = checkFleetV11RolloutGate(makeRollout(), { criticalAlertTargetIds: [], healthyTargetIds: [] });
  assert.equal(draftGate.allowed, false);
  assert.equal(draftGate.nextGroupName, null);

  // Hết nhóm: gate allowed với nextGroupName null.
  let done = startRollout();
  done = markFleetV11GroupDone(done, 'canary', T0);
  done = applyFleetV11RolloutAction(done, 'advance', 'admin', 'x', T0).rollout;
  done = markFleetV11GroupDone(done, 'pilot', T0);
  done = applyFleetV11RolloutAction(done, 'advance', 'admin', 'x', T0).rollout;
  done = markFleetV11GroupDone(done, 'all', T0);
  const lastGate = checkFleetV11RolloutGate(done, { criticalAlertTargetIds: [], healthyTargetIds: [] });
  assert.equal(lastGate.allowed, true);
  assert.equal(lastGate.nextGroupName, null);
});

test('auto-rollback: đề xuất khi lỗi cao hoặc nhiều target down, không khi đang nháp', () => {
  let r = startRollout();
  let d = decideFleetV11AutoRollback(r, []);
  assert.equal(d.shouldRollback, false);
  assert.equal(d.errorRate, 0);

  r = recordFleetV11GroupProgress(r, 'canary', 1, 1, T0);
  d = decideFleetV11AutoRollback(r, []);
  assert.equal(d.shouldRollback, true, 'error rate 50% > 20%');
  assert.match(d.reasons.join(' '), /tỉ lệ lỗi/);

  const r2 = startRollout(makeRollout({ name: 'Down test' }));
  // canary chỉ có 1 target: 1 down <= ngưỡng 2 -> không đề xuất.
  d = decideFleetV11AutoRollback(r2, ['node-1']);
  assert.equal(d.shouldRollback, false);
  d = decideFleetV11AutoRollback(r2, ['node-1'], { maxDownTargets: 0 });
  assert.equal(d.shouldRollback, true, '1 down > ngưỡng 0');
  assert.equal(d.downTargets, 1);

  const draft = decideFleetV11AutoRollback(makeRollout(), ['node-1']);
  assert.equal(draft.shouldRollback, false, 'rollout nháp không đề xuất rollback');
});

test('summarize: draft / complete / rolled-back có summary riêng', () => {
  assert.match(summarizeFleetV11Rollout(makeRollout()).summary, /nháp/);
  let r = startRollout();
  r = applyFleetV11RolloutAction(r, 'rollback', 'admin', 'x', T0).rollout;
  assert.match(summarizeFleetV11Rollout(r).summary, /rollback/);
});

test('persistence: save/load round-trip, add không trùng, update, file hỏng -> []', () => {
  const root = tmpFleetRoot();
  assert.deepEqual(loadFleetV11Rollouts(root), []);
  const r = makeRollout();
  saveFleetV11Rollouts(root, addFleetV11Rollout([], r));
  let loaded = loadFleetV11Rollouts(root);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].id, r.id);
  assert.equal(findFleetV11Rollout(loaded, r.id)?.name, 'Voice v12');
  assert.equal(findFleetV11Rollout(loaded, 'nope'), null);

  assert.equal(addFleetV11Rollout(loaded, r).length, 1, 'thêm trùng id không tăng');
  const updated = { ...r, name: 'Đổi tên' };
  assert.equal(updateFleetV11Rollout(loaded, updated)[0].name, 'Đổi tên');
  assert.equal(updateFleetV11Rollout(loaded, { ...r, id: 'nope' }), loaded, 'update id lạ trả về cũ');

  fs.writeFileSync(path.join(root, 'fleet-rollouts-v114.json'), '[{bad]');
  assert.deepEqual(loadFleetV11Rollouts(root), []);
});
