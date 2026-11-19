/**
 * Tests for fleet v24 automation dashboard + run ledger (v1.37, Đội T6).
 *
 * Covers:
 * - Registry: register/validation, tag normalisation, group by tag,
 *   filter by owner, stats per tag/owner/fleet, bulk enable/disable/
 *   pause/resume per tag group, audit trail.
 * - Run ledger: start/finish, query by automation/tag/owner/outcome/
 *   window, failure rates, timing, stuck runs, longest runs.
 * - Panels: dashboard panel with tag/owner filters, runs panel.
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/fleet-v24-automation-dashboard.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FleetV24AutomationRegistry,
  FleetV24RunLedger,
  buildFleetV24AutomationDashboardPanel,
  buildFleetV24RunsPanel,
  createFleetV24Automation,
  createFleetV24Run,
  failureRateFleetV24Runs,
  normalizeFleetV24Tags,
  summarizeFleetV24Automations,
  summarizeFleetV24RunTiming,
  validateFleetV24RegisterInput,
} from '../packages/core/dist/fleetV24/index.js';
import { FLEET_V24_VERSION } from '../packages/core/dist/fleetV24/index.js';

const T0 = 1794393600000;

function seedRegistry() {
  const registry = new FleetV24AutomationRegistry();
  registry.register(
    { id: 'auto-nightly-backup', name: 'Nightly backup', owner: 'team-data', tags: ['Nightly', ' backup '], schedule: '0 2 * * *' },
    T0,
    'seed',
  );
  registry.register(
    { id: 'auto-weekly-report', name: 'Weekly report', owner: 'team-data', tags: ['nightly', 'report'] },
    T0,
    'seed',
  );
  registry.register(
    { id: 'auto-cleanup', name: 'Temp cleanup', owner: 'team-ops', tags: ['maintenance'] },
    T0,
    'seed',
  );
  registry.register(
    { id: 'auto-untagged', name: 'No tags at all', owner: 'team-ops', tags: [] },
    T0,
    'seed',
  );
  return registry;
}

test('fleet v24: version + tag normalisation', () => {
  assert.equal(FLEET_V24_VERSION, 'v24');
  assert.deepEqual(normalizeFleetV24Tags(['Nightly', ' backup ', '', 'NIGHTLY', 'report']), [
    'backup',
    'nightly',
    'report',
  ]);
  assert.deepEqual(normalizeFleetV24Tags([]), []);
});

test('fleet v24: register validation', () => {
  assert.equal(validateFleetV24RegisterInput({ id: '', name: 'x', owner: 'o' }), 'Automation id must not be empty.');
  assert.equal(
    validateFleetV24RegisterInput({ id: 'has space', name: 'x', owner: 'o' }),
    'Automation id must not contain whitespace.',
  );
  assert.equal(
    validateFleetV24RegisterInput({ id: 'ok', name: '', owner: 'o' }),
    'Automation name must not be empty.',
  );
  assert.equal(
    validateFleetV24RegisterInput({ id: 'ok', name: 'x', owner: '  ' }),
    'Automation owner must not be empty.',
  );
  assert.equal(validateFleetV24RegisterInput({ id: 'ok', name: 'x', owner: 'o' }), null);
  assert.throws(
    () => createFleetV24Automation({ id: 'bad id', name: 'x', owner: 'o' }, T0),
    /whitespace/,
  );
  const auto = createFleetV24Automation(
    { id: 'a1', name: ' A ', owner: ' team-x ', tags: ['B', 'a'] },
    T0,
  );
  assert.equal(auto.name, 'A');
  assert.equal(auto.owner, 'team-x');
  assert.deepEqual(auto.tags, ['a', 'b']);
  assert.equal(auto.status, 'idle');
  assert.equal(auto.runCount, 0);
});

test('fleet v24: registry — register, duplicate, remove', () => {
  const registry = seedRegistry();
  assert.equal(registry.size, 4);
  assert.throws(
    () => registry.register({ id: 'auto-cleanup', name: 'dup', owner: 'x' }, T0),
    /already registered/,
  );
  assert.equal(registry.remove('auto-untagged', T0 + 1, 'tester'), true);
  assert.equal(registry.remove('auto-untagged', T0 + 1), false);
  assert.equal(registry.size, 3);
  assert.equal(registry.get('auto-cleanup')?.owner, 'team-ops');
  assert.equal(registry.get('missing'), undefined);
});

test('fleet v24: registry — group by tag + filter by owner', () => {
  const registry = seedRegistry();
  assert.deepEqual(registry.tags(), ['backup', 'maintenance', 'nightly', 'report']);
  assert.deepEqual(registry.owners(), ['team-data', 'team-ops']);
  // Tags are normalised at registration: 'Nightly' + ' backup ' -> nightly/backup.
  assert.equal(registry.byTag('nightly').length, 2);
  assert.equal(registry.byTag('NIGHTLY').length, 2);
  assert.equal(registry.byTag('backup').length, 1);
  assert.equal(registry.byTag('nope').length, 0);
  assert.equal(registry.byOwner('team-data').length, 2);
  assert.equal(registry.byOwner('team-ops').length, 2);
  assert.equal(registry.byTagAndOwner('nightly', 'team-data').length, 2);
  assert.equal(registry.byTagAndOwner('nightly', 'team-ops').length, 0);

  const groups = registry.groupByTag();
  assert.deepEqual(groups.map((g) => g.tag), ['(untagged)', 'backup', 'maintenance', 'nightly', 'report']);
  const nightly = groups.find((g) => g.tag === 'nightly');
  assert.equal(nightly?.automations.length, 2);
  assert.deepEqual(nightly?.owners, ['team-data']);
  assert.equal(nightly?.stats.total, 2);
  const untagged = groups.find((g) => g.tag === '(untagged)');
  assert.equal(untagged?.automations.length, 1);

  const slices = registry.groupByOwner();
  assert.deepEqual(slices.map((s) => s.owner), ['team-data', 'team-ops']);
  assert.deepEqual(slices[0].tags, ['backup', 'nightly', 'report']);
});

test('fleet v24: registry — stats per tag/owner/fleet', () => {
  const registry = seedRegistry();
  registry.setStatus('auto-nightly-backup', 'running', T0 + 1000, 'seed');
  registry.setStatus('auto-cleanup', 'failed', T0 + 1000, 'seed');
  registry.recordRunOutcome('auto-cleanup', 'failed', T0 + 2000, 'seed');
  registry.recordRunOutcome('auto-nightly-backup', 'completed', T0 + 3000, 'seed');

  const fleet = registry.stats();
  assert.equal(fleet.total, 4);
  assert.equal(fleet.running, 0); // completed overwrote running
  assert.equal(fleet.failed, 1);
  assert.equal(fleet.completed, 1);
  assert.equal(fleet.runs, 1);
  assert.equal(fleet.successes, 1);
  assert.equal(fleet.failures, 1);
  assert.equal(fleet.successRate, 0.5);
  assert.equal(fleet.failureRate, 0.5);

  const nightly = registry.statsByTag('nightly');
  assert.equal(nightly.total, 2);
  assert.equal(nightly.runs, 1);
  const ops = registry.statsByOwner('team-ops');
  assert.equal(ops.total, 2);
  assert.equal(ops.failed, 1);
  assert.equal(registry.statsByTag('nope').total, 0);

  const empty = summarizeFleetV24Automations([]);
  assert.equal(empty.total, 0);
  assert.equal(empty.successRate, 0);
});

test('fleet v24: registry — bulk enable/disable/pause/resume per tag', () => {
  const registry = seedRegistry();
  registry.disable('auto-weekly-report', T0, 'seed');
  registry.setStatus('auto-nightly-backup', 'running', T0, 'seed');

  const paused = registry.pauseTag('nightly', T0 + 1000, 'ops');
  assert.equal(paused.action, 'pause');
  assert.equal(paused.applied, 1); // only the running one pauses
  assert.equal(paused.skipped, 1); // disabled one cannot pause
  assert.equal(paused.items.find((i) => i.automationId === 'auto-nightly-backup')?.applied, true);
  assert.equal(
    paused.items.find((i) => i.automationId === 'auto-weekly-report')?.skippedReason,
    'cannot-pause-from-disabled',
  );
  assert.equal(registry.get('auto-nightly-backup')?.status, 'paused');

  const resumed = registry.resumeTag('nightly', T0 + 2000, 'ops');
  assert.equal(resumed.applied, 1);
  assert.equal(registry.get('auto-nightly-backup')?.status, 'idle');

  const enabled = registry.enableTag('nightly', T0 + 3000, 'ops');
  assert.equal(enabled.applied, 1); // the disabled report
  assert.equal(enabled.skipped, 1);
  assert.equal(registry.get('auto-weekly-report')?.status, 'idle');

  const disabled = registry.disableTag('nightly', T0 + 4000, 'ops');
  assert.equal(disabled.applied, 2);
  assert.equal(registry.get('auto-nightly-backup')?.status, 'disabled');
  assert.equal(registry.get('auto-weekly-report')?.status, 'disabled');

  const empty = registry.pauseTag('no-such-tag', T0, 'ops');
  assert.equal(empty.applied, 0);
  assert.equal(empty.skipped, 0);
});

test('fleet v24: registry — status transitions + audit trail', () => {
  const registry = seedRegistry();
  assert.equal(registry.setStatus('missing', 'running', T0), false);
  assert.equal(registry.enable('missing', T0), false);
  assert.equal(registry.pause('missing', T0), false);
  registry.setStatus('auto-cleanup', 'running', T0 + 100, 'ops');
  assert.equal(registry.get('auto-cleanup')?.runCount, 1);
  assert.equal(registry.get('auto-cleanup')?.lastRunAtMs, T0 + 100);
  registry.pause('auto-cleanup', T0 + 200, 'ops');
  assert.equal(registry.get('auto-cleanup')?.status, 'paused');
  registry.resume('auto-cleanup', T0 + 300, 'ops');
  assert.equal(registry.get('auto-cleanup')?.status, 'idle');

  const trail = registry.auditTrail();
  assert.ok(trail.length >= 7);
  assert.equal(trail[0].action, 'resume');
  assert.ok(registry.auditFor('auto-cleanup').length >= 4);
  assert.ok(registry.auditTrail(2).length === 2);
  // Audit is capped: register 600 more and the oldest entries drop.
  for (let i = 0; i < 600; i += 1) {
    registry.register({ id: `auto-bulk-${i}`, name: `Bulk ${i}`, owner: 'team-ops' }, T0, 'seed');
  }
  assert.ok(registry.auditTrail(10000).length <= 500);
});

test('fleet v24: run ledger — start/finish/query', () => {
  const ledger = new FleetV24RunLedger();
  const run = ledger.start(
    { id: 'run-1', automationId: 'auto-nightly-backup', owner: 'team-data', tags: ['Nightly'], trigger: 'schedule' },
    T0,
  );
  assert.equal(run.outcome, 'running');
  assert.deepEqual(run.tags, ['nightly']);
  assert.equal(run.trigger, 'schedule');
  assert.throws(
    () => ledger.start({ id: 'run-1', automationId: 'a', owner: 'o' }, T0),
    /already exists/,
  );
  assert.throws(
    () => createFleetV24Run({ id: 'bad id', automationId: 'a', owner: 'o' }, T0),
    /whitespace/,
  );

  const finished = ledger.finish('run-1', 'completed', T0 + 5000);
  assert.equal(finished?.durationMs, 5000);
  assert.equal(finished?.outcome, 'completed');
  assert.equal(ledger.finish('run-1', 'failed', T0 + 6000), null); // already finished
  assert.equal(ledger.finish('missing', 'failed', T0), null);
  ledger.start({ id: 'run-early', automationId: 'auto-cleanup', owner: 'team-ops', tags: ['maintenance'] }, T0 + 9000);
  assert.throws(() => ledger.finish('run-early', 'failed', T0 + 8000), /before it started/);
  ledger.finish('run-early', 'cancelled', T0 + 9500);

  ledger.start({ id: 'run-2', automationId: 'auto-cleanup', owner: 'team-ops', tags: ['maintenance'] }, T0 + 1000);
  ledger.finish('run-2', 'failed', T0 + 2000, 'disk full');
  ledger.start({ id: 'run-3', automationId: 'auto-cleanup', owner: 'team-ops', tags: ['maintenance'] }, T0 + 3000);
  ledger.finish('run-3', 'stopped', T0 + 4000, null, 'sh-1');
  ledger.start({ id: 'run-4', automationId: 'auto-nightly-backup', owner: 'team-data', tags: ['nightly'] }, T0 + 5000);

  assert.equal(ledger.size, 5);
  assert.equal(ledger.running().length, 1);
  assert.deepEqual(ledger.countsByOutcome(), { running: 1, completed: 1, failed: 1, stopped: 1, cancelled: 1 });
  assert.equal(ledger.forAutomation('auto-cleanup').length, 3);
  assert.equal(ledger.forTag('maintenance').length, 3);
  assert.equal(ledger.failed().length, 1);
  assert.equal(ledger.failed()[0].error, 'disk full');
  assert.equal(ledger.stoppedByHook().length, 1);
  assert.equal(ledger.stoppedByHook()[0].stopHookFeedbackId, 'sh-1');
  assert.equal(ledger.query({ owner: 'team-data' }).length, 2);
  assert.equal(ledger.query({ outcome: 'completed' }).length, 1);
  assert.equal(ledger.query({ fromMs: T0 + 2500 }).length, 3);
  assert.equal(ledger.query({ toMs: T0 + 2500 }).length, 2);
  assert.equal(ledger.query({ errorContains: 'DISK' }).length, 1);
  assert.equal(ledger.query({ errorContains: 'nope' }).length, 0);
  assert.equal(ledger.recent(2).length, 2);
  assert.equal(ledger.recent(2)[0].id, 'run-early');
  assert.equal(ledger.longest(1)[0].id, 'run-1');
  assert.equal(ledger.stuckRuns(T0 + 5000 + 100, 500).length, 0);
  assert.equal(ledger.stuckRuns(T0 + 5000 + 1000, 500).length, 1);
  assert.equal(ledger.stuckRuns(T0 + 5000 + 60_000, 1000).length, 1);
});

test('fleet v24: run ledger — failure rates + timing', () => {
  const ledger = new FleetV24RunLedger();
  const runs = [
    { id: 'r1', outcome: 'completed', dur: 1000 },
    { id: 'r2', outcome: 'failed', dur: 2000 },
    { id: 'r3', outcome: 'failed', dur: 3000 },
    { id: 'r4', outcome: 'stopped', dur: 4000 },
  ];
  for (const r of runs) {
    ledger.start({ id: r.id, automationId: 'auto-cleanup', owner: 'team-ops', tags: ['maintenance'] }, T0);
    ledger.finish(r.id, r.outcome, T0 + r.dur);
  }
  ledger.start({ id: 'r5', automationId: 'auto-cleanup', owner: 'team-ops', tags: ['maintenance'] }, T0 + 5000);

  const rate = ledger.failureRateForAutomation('auto-cleanup');
  assert.equal(rate.finished, 4);
  assert.equal(rate.failed, 2);
  assert.equal(rate.stopped, 1);
  assert.equal(rate.failureRate, 0.5);
  assert.equal(rate.notCleanRate, 0.75);
  assert.equal(ledger.failureRateForTag('maintenance').failureRate, 0.5);
  assert.equal(ledger.failureRateForTag('nope').finished, 0);
  assert.equal(ledger.failureRatesByAutomation().length, 1);

  const timing = ledger.timingForAutomation('auto-cleanup');
  assert.equal(timing.count, 4);
  assert.equal(timing.meanMs, 2500);
  assert.equal(timing.medianMs, 2500);
  assert.equal(timing.minMs, 1000);
  assert.equal(timing.maxMs, 4000);
  assert.equal(timing.p95Ms, 4000);
  assert.equal(ledger.timingForTag('nope').count, 0);

  assert.equal(summarizeFleetV24RunTiming([]).count, 0);
  assert.deepEqual(failureRateFleetV24Runs('x', []).finished, 0);
});

test('fleet v24: panels — automation dashboard with filters', () => {
  const registry = seedRegistry();
  registry.setStatus('auto-nightly-backup', 'running', T0, 'seed');
  registry.setStatus('auto-cleanup', 'failed', T0, 'seed');

  const panel = buildFleetV24AutomationDashboardPanel(registry);
  assert.equal(panel.stats.total, 4);
  assert.equal(panel.running.length, 1);
  assert.equal(panel.failed.length, 1);
  assert.equal(panel.all.length, 4);
  assert.equal(panel.filtered, null);
  assert.equal(panel.activeTagFilter, null);
  assert.ok(panel.summary.includes('4 automations'));

  const filtered = buildFleetV24AutomationDashboardPanel(registry, 'nightly', 'team-data');
  assert.equal(filtered.filtered?.length, 2);
  assert.equal(filtered.filteredStats?.total, 2);
  assert.equal(filtered.activeTagFilter, 'nightly');
  assert.equal(filtered.activeOwnerFilter, 'team-data');

  const ownerOnly = buildFleetV24AutomationDashboardPanel(registry, null, 'team-ops');
  assert.equal(ownerOnly.filtered?.length, 2);
  assert.equal(ownerOnly.filteredStats?.total, 2);

  const empty = buildFleetV24AutomationDashboardPanel(registry, 'nope', null);
  assert.equal(empty.filtered?.length, 0);
  assert.equal(empty.filteredStats?.total, 0);
});

test('fleet v24: panels — runs panel', () => {
  const ledger = new FleetV24RunLedger();
  ledger.start({ id: 'run-1', automationId: 'a1', owner: 'o', tags: ['t'] }, T0);
  ledger.finish('run-1', 'completed', T0 + 1000);
  ledger.start({ id: 'run-2', automationId: 'a1', owner: 'o', tags: ['t'] }, T0 + 2000);
  const panel = buildFleetV24RunsPanel(ledger, T0 + 2000 + 1000, 500);
  assert.equal(panel.countsByOutcome.completed, 1);
  assert.equal(panel.countsByOutcome.running, 1);
  assert.equal(panel.stuck.length, 1);
  assert.equal(panel.timing.count, 1);
  assert.equal(panel.timing.meanMs, 1000);
  assert.ok(panel.summary.includes('2 runs'));
});
