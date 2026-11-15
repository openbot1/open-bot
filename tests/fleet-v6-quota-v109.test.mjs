/**
 * Tests for fleet quota groups v6 (packages/core/src/fleet/fleetV6Quotas.ts).
 *
 * Covers: group validation (+ errors), group evaluation from measured
 * usage (sum across bots, warn at warnPercent, breach -> pause, warning
 * -> throttle), disabled groups never evaluate, mixed bot + group
 * evaluation ordering, paused/throttled derivations, resume rules
 * (only when no breach remains), and the durable groups file.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/fleet-v6-quota-v109.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  evaluateFleetV6QuotaGroup,
  evaluateFleetV6Quotas,
  fleetV6QuotaAlerts,
  getFleetV6QuotaGroup,
  groupsForFleetV6Bot,
  loadFleetV6QuotaGroups,
  pausedBotsFromFleetV6Evaluations,
  removeFleetV6QuotaGroup,
  resolveFleetV6PausedBots,
  setFleetV6QuotaGroup,
  sumFleetV6BotUsage,
  throttledConcurrencyFromFleetV6Evaluations,
  validateFleetV6QuotaGroup,
} from '../packages/core/dist/fleet/fleetV6Quotas.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-fleet-v6-quota-'));
}

const GB = 1024 ** 3;
const T0 = 1792000000000;

function usage(cpu, ram, disk) {
  return { cpuCoresUsed: cpu, ramBytesUsed: ram, diskBytesUsed: disk };
}

function group(overrides = {}) {
  return validateFleetV6QuotaGroup({
    id: 'qg6-1',
    name: 'team-a',
    botIds: ['bot-1', 'bot-2'],
    cpuCoresMax: 2,
    ramBytesMax: 4 * GB,
    diskBytesMax: 20 * GB,
    warnPercent: 0.8,
    enabled: true,
    throttleMaxConcurrent: 1,
    updatedAt: new Date(T0).toISOString(),
    updatedBy: 'admin',
    ...overrides,
  });
}

test('validation: bad groups throw', () => {
  assert.throws(() => group({ botIds: [] }), /botIds/);
  assert.throws(() => group({ botIds: ['bot-1', 'bot-1'] }), /unique/);
  assert.throws(() => group({ warnPercent: 1 }), /warnPercent/);
  assert.throws(() => group({ warnPercent: 0 }), /warnPercent/);
  assert.throws(() => group({ cpuCoresMax: 0 }), /cpuCoresMax/);
  assert.throws(() => group({ throttleMaxConcurrent: 0 }), /throttleMaxConcurrent/);
});

test('sum usage: adds measured bots, unknown stays unknown when nothing measured', () => {
  const summed = sumFleetV6BotUsage([usage(1, 1 * GB, 5 * GB), usage(0.5, 2 * GB, 5 * GB)]);
  assert.equal(summed.cpuCoresUsed, 1.5);
  assert.equal(summed.ramBytesUsed, 3 * GB);
  assert.equal(summed.diskBytesUsed, 10 * GB);
  const empty = sumFleetV6BotUsage([{ cpuCoresUsed: null, ramBytesUsed: null, diskBytesUsed: null }]);
  assert.equal(empty.cpuCoresUsed, null);
  assert.equal(empty.ramBytesUsed, null);
  // Một bot đo được + một bot chưa đo: phần đo được vẫn cộng, phần kia unknown.
  const partial = sumFleetV6BotUsage([usage(1, null, 5 * GB), { cpuCoresUsed: null, ramBytesUsed: 2 * GB, diskBytesUsed: null }]);
  assert.equal(partial.cpuCoresUsed, 1);
  assert.equal(partial.ramBytesUsed, 2 * GB);
  assert.equal(partial.diskBytesUsed, 5 * GB);
});

test('evaluate group: under limit is ok, at 80% warns with throttle, over limit breaches with pause', () => {
  const g = group();
  const ok = evaluateFleetV6QuotaGroup(g, { 'bot-1': usage(0.5, 1 * GB, 5 * GB), 'bot-2': usage(0.5, 1 * GB, 5 * GB) }, T0);
  assert.equal(ok.overall, 'ok');
  assert.equal(ok.action, 'none');
  assert.deepEqual(ok.pausedBotIds, []);

  // Tổng CPU 1.7/2 = 85% -> warning -> throttle 1 concurrent.
  const warn = evaluateFleetV6QuotaGroup(g, { 'bot-1': usage(1, 1 * GB, 5 * GB), 'bot-2': usage(0.7, 1 * GB, 5 * GB) }, T0);
  assert.equal(warn.overall, 'warning');
  assert.equal(warn.action, 'throttle');
  assert.equal(warn.throttleMaxConcurrent, 1);
  assert.deepEqual(warn.pausedBotIds, []);

  // Tổng RAM 5GB/4GB -> breach -> pause cả nhóm.
  const breach = evaluateFleetV6QuotaGroup(g, { 'bot-1': usage(0.5, 3 * GB, 5 * GB), 'bot-2': usage(0.5, 2 * GB, 5 * GB) }, T0);
  assert.equal(breach.overall, 'breach');
  assert.equal(breach.action, 'pause');
  assert.deepEqual(breach.pausedBotIds, ['bot-1', 'bot-2']);
});

test('evaluate group: disabled group never evaluates (unknown/none)', () => {
  const g = group({ enabled: false });
  const result = evaluateFleetV6QuotaGroup(g, { 'bot-1': usage(99, 99 * GB, 99 * GB) }, T0);
  assert.equal(result.overall, 'unknown');
  assert.equal(result.action, 'none');
  assert.deepEqual(result.pausedBotIds, []);
});

test('evaluate group: unmeasured usage is unknown, not zero', () => {
  const g = group();
  const result = evaluateFleetV6QuotaGroup(g, {}, T0);
  assert.equal(result.overall, 'unknown');
  assert.equal(result.action, 'none');
  assert.equal(result.resources[0].used, null);
});

test('evaluate all: breach sorts before warning; bot quota v2 mixes in', () => {
  const g = group({ id: 'qg6-warn', name: 'warn-group' });
  const botQuota = {
    botId: 'solo',
    cpuCoresMax: 1,
    ramBytesMax: 1 * GB,
    diskBytesMax: 10 * GB,
    warnPercent: 0.8,
    enabled: true,
    updatedAt: new Date(T0).toISOString(),
    updatedBy: 'admin',
  };
  const evaluations = evaluateFleetV6Quotas(
    [g],
    {
      'bot-1': usage(1, 1 * GB, 5 * GB),
      'bot-2': usage(0.7, 1 * GB, 5 * GB), // nhóm warn
      solo: usage(2, 2 * GB, 5 * GB), // bot breach
    },
    [botQuota],
    T0,
  );
  assert.equal(evaluations[0].scope, 'bot');
  assert.equal(evaluations[0].overall, 'breach');
  assert.equal(evaluations[1].scope, 'group');
  assert.equal(evaluations[1].overall, 'warning');
});

test('derived sets: paused bots, throttle caps (min wins), resume only when breach clears', () => {
  const breachEval = evaluateFleetV6QuotaGroup(group(), { 'bot-1': usage(0.5, 3 * GB, 5 * GB), 'bot-2': usage(0.5, 2 * GB, 5 * GB) }, T0);
  assert.deepEqual([...pausedBotsFromFleetV6Evaluations([breachEval])].sort(), ['bot-1', 'bot-2']);
  // Đã tụt xuống dưới trần -> được resume.
  const okEval = evaluateFleetV6QuotaGroup(group(), { 'bot-1': usage(0.5, 1 * GB, 5 * GB), 'bot-2': usage(0.5, 1 * GB, 5 * GB) }, T0);
  assert.deepEqual(resolveFleetV6PausedBots([okEval], ['bot-1', 'bot-2']), ['bot-1', 'bot-2']);
  // Vẫn breach -> không resume.
  assert.deepEqual(resolveFleetV6PausedBots([breachEval], ['bot-1', 'bot-2']), []);

  const warnEval = evaluateFleetV6QuotaGroup(group({ throttleMaxConcurrent: 2 }), { 'bot-1': usage(1, 1 * GB, 5 * GB), 'bot-2': usage(0.7, 1 * GB, 5 * GB) }, T0);
  const caps = throttledConcurrencyFromFleetV6Evaluations([warnEval], 4);
  assert.equal(caps['bot-1'], 2);
  assert.equal(caps['bot-2'], 2);
  // Bot không bị throttle giữ default.
  const okCaps = throttledConcurrencyFromFleetV6Evaluations([okEval], 4);
  assert.equal(okCaps['bot-1'], 4);
});

test('alerts: only warning/breach resources produce alerts', () => {
  const warn = evaluateFleetV6QuotaGroup(group(), { 'bot-1': usage(1, 1 * GB, 5 * GB), 'bot-2': usage(0.7, 1 * GB, 5 * GB) }, T0);
  const alerts = fleetV6QuotaAlerts([warn]);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].resource, 'cpu');
  assert.equal(alerts[0].level, 'warning');
  assert.match(alerts[0].message, /team-a/);
  const ok = evaluateFleetV6QuotaGroup(group(), { 'bot-1': usage(0.5, 1 * GB, 5 * GB), 'bot-2': usage(0.5, 1 * GB, 5 * GB) }, T0);
  assert.deepEqual(fleetV6QuotaAlerts([ok]), []);
});

test('files: set/get/remove groups round-trip, duplicate name rejected', () => {
  const dir = tmpDir();
  assert.deepEqual(loadFleetV6QuotaGroups(dir), []);
  const created = setFleetV6QuotaGroup(dir, {
    name: 'team-a',
    botIds: ['bot-1', 'bot-2'],
    cpuCoresMax: 2,
    ramBytesMax: 4 * GB,
    diskBytesMax: 20 * GB,
  }, 'admin');
  assert.equal(created.name, 'team-a');
  assert.equal(created.warnPercent, 0.8);
  assert.equal(getFleetV6QuotaGroup(dir, created.id).name, 'team-a');
  assert.deepEqual(groupsForFleetV6Bot(dir, 'bot-1').map((g) => g.id), [created.id]);
  assert.deepEqual(groupsForFleetV6Bot(dir, 'bot-9'), []);
  // Cập nhật cùng id: đổi trần, giữ id.
  const updated = setFleetV6QuotaGroup(dir, {
    id: created.id,
    name: 'team-a',
    botIds: ['bot-1'],
    cpuCoresMax: 3,
    ramBytesMax: 4 * GB,
    diskBytesMax: 20 * GB,
  }, 'admin');
  assert.equal(updated.id, created.id);
  assert.equal(updated.cpuCoresMax, 3);
  assert.equal(loadFleetV6QuotaGroups(dir).length, 1);
  // Tên trùng với nhóm khác thì lỗi.
  const other = setFleetV6QuotaGroup(dir, {
    name: 'team-b',
    botIds: ['bot-3'],
    cpuCoresMax: 1,
    ramBytesMax: 1 * GB,
    diskBytesMax: 10 * GB,
  }, 'admin');
  assert.throws(() => setFleetV6QuotaGroup(dir, {
    id: other.id,
    name: 'team-a',
    botIds: ['bot-3'],
    cpuCoresMax: 1,
    ramBytesMax: 1 * GB,
    diskBytesMax: 10 * GB,
  }, 'admin'), /already used/);
  assert.equal(removeFleetV6QuotaGroup(dir, created.id), true);
  assert.equal(removeFleetV6QuotaGroup(dir, created.id), false);
  assert.equal(loadFleetV6QuotaGroups(dir).length, 1);
});
