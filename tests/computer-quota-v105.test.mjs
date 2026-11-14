/**
 * computer-quota-v105.test.mjs — per-bot computer v2: quota + usage + status (v1.05, Đội T3).
 * Không gọi probe thật của máy (profile giả), không chạm cgroup.
 * Run: build core rồi `node --test tests/computer-quota-v105.test.mjs`
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  buildBotComputerStatusView,
  checkLevelFeasible,
  emptyBotComputerUsage,
  evaluateQuota,
  loadBotComputerQuotas,
  measureDirSizeMb,
  saveBotComputerQuotas,
  upsertBotComputerQuota,
  validateBotComputerQuota,
} from '../packages/core/dist/compute/quota.js';
import { fakeMachineProfile } from '../packages/core/dist/compute/probe.js';

function usage(overrides = {}) {
  return { ...emptyBotComputerUsage('bot-1'), ...overrides };
}

test('computer quota: validate — ok và các lỗi rõ', () => {
  const q = validateBotComputerQuota({ botId: ' b1 ', level: 'box', cpuCores: 2, memoryMb: 1024 });
  assert.equal(q.botId, 'b1');
  assert.equal(q.level, 'box');
  assert.throws(() => validateBotComputerQuota({ botId: '' }), /botId/);
  assert.throws(() => validateBotComputerQuota({ botId: 'b', level: 'baremetal' }), /level/);
  assert.throws(() => validateBotComputerQuota({ botId: 'b', cpuCores: 0 }), /cpuCores/);
  assert.throws(() => validateBotComputerQuota({ botId: 'b', memoryMb: -1 }), /memoryMb/);
  assert.throws(() => validateBotComputerQuota('khong-phai-object'), /object/);
});

test('computer quota: evaluate — dưới 80% không cảnh báo, 80-99% warn, >=100% over', () => {
  const quota = { botId: 'b', memoryMb: 1000 };
  assert.deepEqual(evaluateQuota(quota, usage({ memoryMb: 100 })), []);
  const warn = evaluateQuota(quota, usage({ memoryMb: 850 }));
  assert.equal(warn.length, 1);
  assert.equal(warn[0].severity, 'warn');
  assert.equal(warn[0].field, 'memoryMb');
  assert.ok(warn[0].ratio >= 0.8 && warn[0].ratio < 1);
  const over = evaluateQuota(quota, usage({ memoryMb: 1200 }));
  assert.equal(over[0].severity, 'over');
  assert.equal(over[0].ratio, 1.2);
});

test('computer quota: evaluate — field thiếu một bên thì bỏ qua (không cảnh báo giả)', () => {
  const quota = { botId: 'b', memoryMb: 1000, diskMb: 500 };
  // usage.memoryMb null (không đo được) -> không cảnh báo RAM dù quota có.
  const warnings = evaluateQuota(quota, usage({ diskMb: 100 }));
  assert.deepEqual(warnings, []);
  // quota không có cpuCores -> usage cpu cao cũng không cảnh báo.
  const warnings2 = evaluateQuota(quota, usage({ cpuCores: 99, diskMb: 100 }));
  assert.deepEqual(warnings2, []);
});

test('computer quota: upsert thay thế cùng botId, giữ bot khác, sắp xếp theo botId', () => {
  const list = upsertBotComputerQuota(
    [{ botId: 'b2', memoryMb: 100 }, { botId: 'b1', memoryMb: 50 }],
    { botId: 'b2', memoryMb: 200 },
  );
  assert.equal(list.length, 2);
  assert.deepEqual(list.map((q) => q.botId), ['b1', 'b2']);
  assert.equal(list.find((q) => q.botId === 'b2').memoryMb, 200);
});

test('computer quota: save/load round-trip qua file JSON', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openbot-quota-v105-'));
  assert.deepEqual(loadBotComputerQuotas(dir), []);
  saveBotComputerQuotas(dir, [{ botId: 'b1', level: 'container', cpuCores: 2 }]);
  const loaded = loadBotComputerQuotas(dir);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].level, 'container');
  assert.equal(loaded[0].cpuCores, 2);
  // File hỏng -> throw rõ.
  fs.writeFileSync(path.join(dir, 'team-computers.json'), '{hong', 'utf8');
  assert.throws(() => loadBotComputerQuotas(dir), /team-computers\.json/);
});

test('computer quota: measureDirSizeMb đo thật thư mục', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openbot-measure-v105-'));
  fs.writeFileSync(path.join(dir, 'a.txt'), 'x'.repeat(1024), 'utf8');
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'sub', 'b.txt'), 'y'.repeat(2048), 'utf8');
  const mb = measureDirSizeMb(dir);
  assert.ok(mb !== null && mb >= 0 && mb < 1, `đo được ~0.0 MB, thực tế ${mb}`);
  assert.equal(measureDirSizeMb(path.join(dir, 'khong-co')), null);
});

test('computer quota: checkLevelFeasible — box luôn được, vm cần ảo hoá', () => {
  const profile = fakeMachineProfile();
  assert.equal(checkLevelFeasible('box', profile).feasible, true);
  const noVirt = { ...profile, virtualization: { ...profile.virtualization, supported: false } };
  const vm = checkLevelFeasible('vm', noVirt);
  assert.equal(vm.feasible, false);
  assert.ok(vm.note);
  const withVirt = { ...profile, virtualization: { ...profile.virtualization, supported: true, detail: 'KVM' } };
  assert.equal(checkLevelFeasible('vm', withVirt).feasible, true);
  const container = checkLevelFeasible('container', { ...profile, os: 'darwin' });
  assert.equal(container.feasible, false);
  assert.match(container.note, /Linux/);
});

test('computer quota: buildBotComputerStatusView — status theo warning nặng nhất', () => {
  const quota = { botId: 'b1', level: 'box', diskMb: 100 };
  const ok = buildBotComputerStatusView('b1', quota, usage({ diskMb: 10 }), null);
  assert.equal(ok.status, 'ok');
  assert.equal(ok.warnings.length, 0);
  assert.equal(ok.levelFeasible, null); // không có profile -> không kết luận
  const warn = buildBotComputerStatusView('b1', quota, usage({ diskMb: 85 }), null);
  assert.equal(warn.status, 'warn');
  const over = buildBotComputerStatusView('b1', quota, usage({ diskMb: 150 }), null);
  assert.equal(over.status, 'over');
  assert.equal(over.warnings[0].severity, 'over');
  // Không quota -> ok, warnings rỗng.
  const noQuota = buildBotComputerStatusView('b1', null, usage({ diskMb: 150 }), null);
  assert.equal(noQuota.status, 'ok');
  assert.deepEqual(noQuota.warnings, []);
});
