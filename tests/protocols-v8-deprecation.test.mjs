/**
 * Tests for v1.39 (Team T2) — protocols v8 deprecation handling:
 * packages/core/src/protocolsV8/deprecationV8.ts
 *
 * Covers:
 *  - migration plans (one per deprecated feature, ordered steps,
 *    unknown feature = undefined, past-floor flag)
 *  - tracker: record returns a structured warning, non-deprecated
 *    uses are not recorded, counts per feature, warnings per
 *    feature, clear
 *  - removal status: floor 2027-07-28, 252 days from 2026-11-18,
 *    past-floor detection
 *  - transport policy: streamable-http preferred, http-sse warns
 *    with replacement, unknown transport refused
 *  - deprecation report rows (uses + migration steps)
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/protocols-v8-deprecation.test.mjs
 *
 * No network, no model.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  McpV8DeprecationTracker,
  buildMcpV8DeprecationReport,
  checkMcpV8Transport,
  defaultMcpV8TransportPolicy,
  mcpV8AllMigrationPlans,
  mcpV8MigrationPlan,
} from '../packages/core/dist/index.js';

test('migration plans: every deprecated feature has ordered steps + replacement', () => {
  const features = ['sampling', 'roots', 'logging', 'http-sse-transport', 'initialize-handshake', 'mcp-session-id-header'];
  for (const feature of features) {
    const plan = mcpV8MigrationPlan(feature, Date.parse('2026-11-18T00:00:00Z'));
    assert.notEqual(plan, undefined);
    assert.equal(plan.feature, feature);
    assert.equal(plan.deprecatedOn, '2026-07-28');
    assert.equal(plan.earliestRemoval, '2027-07-28');
    assert.ok(plan.replacement.length > 0);
    assert.ok(plan.steps.length >= 2);
    plan.steps.forEach((s, i) => {
      assert.equal(s.step, i + 1);
      assert.ok(s.action.length > 0);
      assert.ok(s.verify.length > 0);
    });
    assert.equal(plan.pastRemovalFloor, false);
  }
  assert.equal(mcpV8MigrationPlan('tools/call'), undefined);
  const past = mcpV8MigrationPlan('sampling', Date.parse('2027-08-01T00:00:00Z'));
  assert.equal(past?.pastRemovalFloor, true);
  const sampling = mcpV8MigrationPlan('sampling');
  assert.ok(sampling?.steps.some((s) => s.action.includes('Elicitation')));
  const sse = mcpV8MigrationPlan('http-sse-transport');
  assert.ok(sse?.steps.some((s) => s.action.includes('Streamable HTTP')));
  const init = mcpV8MigrationPlan('initialize-handshake');
  assert.ok(init?.steps.some((s) => s.action.includes('server/discover')));
  assert.equal(mcpV8AllMigrationPlans().length, 6);
});

test('tracker: records deprecated uses with structured warnings; ignores clean features', () => {
  let now = 1_800_000_000_000;
  const tracker = new McpV8DeprecationTracker({ nowMs: () => now });
  assert.equal(tracker.totalUses(), 0);
  assert.equal(tracker.anyUsed(), false);

  const w1 = tracker.record('sampling', 'old-client-a');
  assert.notEqual(w1, undefined);
  assert.equal(w1.feature, 'sampling');
  assert.equal(w1.caller, 'old-client-a');
  assert.equal(w1.atMs, now);
  assert.equal(w1.earliestRemoval, '2027-07-28');
  assert.match(w1.message, /Deprecated feature "sampling"/);
  assert.match(w1.message, /Elicitation/);

  now += 1000;
  tracker.record('sampling', 'old-client-a');
  tracker.record('roots', 'old-client-b');
  assert.equal(tracker.totalUses(), 3);
  assert.equal(tracker.anyUsed(), true);
  assert.deepEqual(tracker.countsByFeature(), { roots: 1, sampling: 2 });
  assert.deepEqual(tracker.featuresUsed(), ['roots', 'sampling']);
  assert.equal(tracker.warningsFor('sampling').length, 2);
  assert.equal(tracker.warningsFor('logging').length, 0);
  assert.equal(tracker.allWarnings().length, 3);

  // Non-deprecated use is not recorded.
  assert.equal(tracker.record('tools/call', 'anyone'), undefined);
  assert.equal(tracker.totalUses(), 3);

  tracker.clear();
  assert.equal(tracker.totalUses(), 0);
  assert.deepEqual(tracker.countsByFeature(), {});
  assert.equal(tracker.anyUsed(), false);
});

test('tracker: max warnings cap drops the oldest first', () => {
  const tracker = new McpV8DeprecationTracker({ maxWarnings: 3 });
  for (let i = 0; i < 5; i += 1) tracker.record('logging', `caller-${i}`);
  assert.equal(tracker.totalUses(), 3);
  assert.equal(tracker.allWarnings()[0].caller, 'caller-2');
  assert.equal(tracker.countsByFeature().logging, 5);
});

test('removal status: 252 days from 2026-11-18 to the 2027-07-28 floor', () => {
  const tracker = new McpV8DeprecationTracker({ nowMs: () => Date.parse('2026-11-18T00:00:00Z') });
  tracker.record('sampling', 'x');
  const status = tracker.removalStatus();
  assert.equal(status.removalFloor, '2027-07-28');
  assert.equal(status.daysUntilRemoval, 252);
  assert.equal(status.pastFloor, false);
  assert.deepEqual(status.featuresInUse, ['sampling']);
  const past = tracker.removalStatus(Date.parse('2027-07-29T00:00:00Z'));
  assert.equal(past.daysUntilRemoval, -1);
  assert.equal(past.pastFloor, true);
});

test('transport policy: streamable-http preferred, http-sse warns, unknown refused', () => {
  const policy = defaultMcpV8TransportPolicy();
  assert.equal(policy.preferred, 'streamable-http');
  assert.equal(policy.deprecated, 'http-sse');
  const good = checkMcpV8Transport('streamable-http', policy);
  assert.equal(good.allowed, true);
  assert.equal(good.preferred, true);
  assert.equal(good.warning, undefined);
  const stdio = checkMcpV8Transport('stdio', policy);
  assert.equal(stdio.allowed, true);
  assert.equal(stdio.preferred, false);
  const sse = checkMcpV8Transport('http-sse', policy);
  assert.equal(sse.allowed, true);
  assert.equal(sse.preferred, false);
  assert.match(sse.warning ?? '', /deprecated/);
  assert.equal(sse.replacement, 'streamable-http');
  const bad = checkMcpV8Transport('carrier-pigeon', policy);
  assert.equal(bad.allowed, false);
  assert.match(bad.warning ?? '', /not allowed/);
});

test('deprecation report: rows carry uses + migration step counts', () => {
  const tracker = new McpV8DeprecationTracker();
  tracker.record('sampling', 'a');
  tracker.record('sampling', 'a');
  tracker.record('logging', 'b');
  const report = buildMcpV8DeprecationReport(tracker);
  assert.equal(report.length, 6);
  const sampling = report.find((r) => r.feature === 'sampling');
  assert.equal(sampling?.uses, 2);
  assert.equal(sampling?.migrationSteps, 3);
  assert.equal(sampling?.earliestRemoval, '2027-07-28');
  const roots = report.find((r) => r.feature === 'roots');
  assert.equal(roots?.uses, 0);
  const empty = buildMcpV8DeprecationReport();
  assert.equal(empty.length, 6);
  assert.ok(empty.every((r) => r.uses === 0));
});
