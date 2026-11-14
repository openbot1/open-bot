/**
 * Tests for the fleet policy v4 (packages/core/src/fleet/policy.ts).
 *
 * Covers validation (defaults for missing fields, rejects bad
 * values), file persistence (missing file = defaults, corrupt =
 * throw, round-trip), enforcement (max bots, per-bot token quota
 * with 90% warn, restarts/hour, tasks/bot, capability match), and
 * the small check helpers (token quota, auto-restart, start bot).
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/fleet-policy-v105.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  DEFAULT_FLEET_POLICY_V4,
  canAutoRestartBot,
  canStartAnotherBot,
  checkBotTokenQuota,
  enforceFleetPolicy,
  loadFleetPolicyV4,
  saveFleetPolicyV4,
  validateFleetPolicyV4,
} from '../packages/core/dist/fleet/policy.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-fleet-policy-'));
}

function emptySnapshot() {
  return {
    runningBots: 0,
    runningTasksByBot: {},
    tokenUsageByBot: {},
    restartsLastHourByBot: {},
  };
}

test('validateFleetPolicyV4: defaults fill missing fields, bad values throw', () => {
  const filled = validateFleetPolicyV4({ maxConcurrentBots: 3 });
  assert.equal(filled.maxConcurrentBots, 3);
  assert.equal(filled.perBotTokenQuota, DEFAULT_FLEET_POLICY_V4.perBotTokenQuota);
  assert.equal(filled.defaultPriority, 3);
  assert.throws(() => validateFleetPolicyV4({ maxConcurrentBots: -1 }), /maxConcurrentBots/);
  assert.throws(() => validateFleetPolicyV4({ perBotTokenQuota: 1.5 }), /perBotTokenQuota/);
  assert.throws(() => validateFleetPolicyV4({ defaultPriority: 0 }), /defaultPriority/);
  assert.throws(() => validateFleetPolicyV4({ defaultPriority: 6 }), /defaultPriority/);
  assert.throws(() => validateFleetPolicyV4({ maxRestartsPerHour: -1 }), /maxRestartsPerHour/);
  assert.throws(() => validateFleetPolicyV4({ tokenQuotaPeriodMs: 0 }), /tokenQuotaPeriodMs/);
  assert.throws(() => validateFleetPolicyV4({ requireCapabilityMatch: 'yes' }), /requireCapabilityMatch/);
  assert.throws(() => validateFleetPolicyV4(null), /object/);
});

test('policy file: missing = defaults, round-trip keeps values, corrupt throws', () => {
  const dir = tmpDir();
  assert.deepEqual(loadFleetPolicyV4(dir), DEFAULT_FLEET_POLICY_V4);
  const saved = saveFleetPolicyV4(dir, { ...DEFAULT_FLEET_POLICY_V4, maxConcurrentBots: 2, perBotTokenQuota: 500 });
  assert.equal(saved.maxConcurrentBots, 2);
  assert.deepEqual(loadFleetPolicyV4(dir), saved);
  fs.writeFileSync(path.join(dir, 'fleet-policy-v4.json'), '{ not json');
  assert.throws(() => loadFleetPolicyV4(dir), /corrupt/);
  fs.writeFileSync(path.join(dir, 'fleet-policy-v4.json'), JSON.stringify({ maxConcurrentBots: -5 }));
  assert.throws(() => loadFleetPolicyV4(dir), /maxConcurrentBots/);
});

test('enforceFleetPolicy: clean snapshot has no violations', () => {
  assert.deepEqual(enforceFleetPolicy(DEFAULT_FLEET_POLICY_V4, {
    ...emptySnapshot(),
    runningBots: 2,
    runningTasksByBot: { 'bot-a': 2 },
    tokenUsageByBot: { 'bot-a': 100 },
  }), []);
});

test('enforceFleetPolicy: max concurrent bots blocks', () => {
  const violations = enforceFleetPolicy(
    { ...DEFAULT_FLEET_POLICY_V4, maxConcurrentBots: 2 },
    { ...emptySnapshot(), runningBots: 3 },
  );
  assert.equal(violations.length, 1);
  assert.equal(violations[0].rule, 'max-concurrent-bots');
  assert.equal(violations[0].severity, 'block');
});

test('enforceFleetPolicy: token quota warns at 90%, blocks over 100%', () => {
  const policy = { ...DEFAULT_FLEET_POLICY_V4, perBotTokenQuota: 1000 };
  const warn = enforceFleetPolicy(policy, { ...emptySnapshot(), tokenUsageByBot: { 'bot-a': 950 } });
  assert.equal(warn.length, 1);
  assert.equal(warn[0].rule, 'per-bot-token-quota');
  assert.equal(warn[0].severity, 'warn');
  const block = enforceFleetPolicy(policy, { ...emptySnapshot(), tokenUsageByBot: { 'bot-a': 1200 } });
  assert.equal(block.length, 1);
  assert.equal(block[0].severity, 'block');
  // 0 quota = unlimited: no violation even at huge usage.
  const unlimited = enforceFleetPolicy(
    { ...DEFAULT_FLEET_POLICY_V4, perBotTokenQuota: 0 },
    { ...emptySnapshot(), tokenUsageByBot: { 'bot-a': 99999999 } },
  );
  assert.deepEqual(unlimited, []);
});

test('enforceFleetPolicy: tasks per bot + restarts per hour', () => {
  const violations = enforceFleetPolicy(
    { ...DEFAULT_FLEET_POLICY_V4, maxTasksPerBot: 2, maxRestartsPerHour: 1 },
    {
      ...emptySnapshot(),
      runningTasksByBot: { 'bot-a': 3, 'bot-b': 1 },
      restartsLastHourByBot: { 'bot-a': 2 },
    },
  );
  assert.equal(violations.filter((v) => v.rule === 'max-tasks-per-bot').length, 1);
  assert.equal(violations.filter((v) => v.rule === 'max-restarts-per-hour').length, 1);
  assert.ok(violations.every((v) => v.severity === 'block'));
});

test('enforceFleetPolicy: capability match is block or warn by policy', () => {
  const snapshot = {
    ...emptySnapshot(),
    missingCapabilitiesByBot: { 'bot-a': ['voice', 'composio'] },
  };
  const blocked = enforceFleetPolicy(
    { ...DEFAULT_FLEET_POLICY_V4, requireCapabilityMatch: true },
    snapshot,
  );
  assert.equal(blocked[0].severity, 'block');
  assert.equal(blocked[0].rule, 'capability-match');
  const warned = enforceFleetPolicy(
    { ...DEFAULT_FLEET_POLICY_V4, requireCapabilityMatch: false },
    snapshot,
  );
  assert.equal(warned[0].severity, 'warn');
});

test('checkBotTokenQuota: allowed / remaining / over-quota', () => {
  const policy = { ...DEFAULT_FLEET_POLICY_V4, perBotTokenQuota: 1000 };
  const ok = checkBotTokenQuota(policy, 'bot-a', 400, 100);
  assert.equal(ok.allowed, true);
  assert.equal(ok.remaining, 600);
  const over = checkBotTokenQuota(policy, 'bot-a', 950, 100);
  assert.equal(over.allowed, false);
  assert.equal(over.remaining, 50);
  const unlimited = checkBotTokenQuota({ ...DEFAULT_FLEET_POLICY_V4, perBotTokenQuota: 0 }, 'bot-a', 99999);
  assert.equal(unlimited.allowed, true);
  assert.equal(unlimited.remaining, null);
  assert.throws(() => checkBotTokenQuota(policy, '', 0), /botId/);
  assert.throws(() => checkBotTokenQuota(policy, 'bot-a', -1), /non-negative/);
});

test('canAutoRestartBot / canStartAnotherBot helpers', () => {
  assert.equal(canAutoRestartBot({ ...DEFAULT_FLEET_POLICY_V4, maxRestartsPerHour: 3 }, 2), true);
  assert.equal(canAutoRestartBot({ ...DEFAULT_FLEET_POLICY_V4, maxRestartsPerHour: 3 }, 3), false);
  assert.equal(canAutoRestartBot({ ...DEFAULT_FLEET_POLICY_V4, maxRestartsPerHour: 0 }, 0), false);
  assert.equal(canStartAnotherBot({ ...DEFAULT_FLEET_POLICY_V4, maxConcurrentBots: 2 }, 1), true);
  assert.equal(canStartAnotherBot({ ...DEFAULT_FLEET_POLICY_V4, maxConcurrentBots: 2 }, 2), false);
  assert.equal(canStartAnotherBot({ ...DEFAULT_FLEET_POLICY_V4, maxConcurrentBots: 0 }, 999), true);
});
