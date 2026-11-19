/**
 * Tests for fleet v24 stop hook feedback + CIDR sandbox rules (v1.37, Đội T6).
 *
 * Covers:
 * - Stop hook: record/validation, derived next-action suggestions,
 *   query by run/automation/trigger/action/acknowledged, acknowledge,
 *   summaries (fleet, per automation, per trigger), panels.
 * - CIDR: IPv4/IPv6 parsing + formatting, CIDR parse/normalise,
 *   validation problems, rule set add/update/remove/enable/disable,
 *   longest-prefix evaluation, route binding, overlaps, default
 *   decision, audit trail, router panel + probe.
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/fleet-v24-stophook-cidr.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FleetV24CidrRuleSet,
  FleetV24StopHookFeedbackStore,
  buildFleetV24CidrRouterPanel,
  buildFleetV24StopHookPanel,
  formatFleetV24Ipv4,
  formatFleetV24Ipv6,
  ipInFleetV24Cidr,
  parseFleetV24Cidr,
  parseFleetV24Ip,
  parseFleetV24Ipv4,
  parseFleetV24Ipv6,
  suggestFleetV24NextAction,
  validateFleetV24CidrInput,
  validateFleetV24StopHookInput,
} from '../packages/core/dist/fleetV24/index.js';

const T0 = 1794393600000;

// -- IPv4 / IPv6 parsing ------------------------------------------------------

test('fleet v24 cidr: IPv4 parse + format round-trip', () => {
  assert.equal(parseFleetV24Ipv4('203.0.113.10'), 0xcb00710an);
  assert.equal(parseFleetV24Ipv4('0.0.0.0'), 0n);
  assert.equal(parseFleetV24Ipv4('255.255.255.255'), 0xffffffffn);
  assert.equal(parseFleetV24Ipv4('256.0.0.1'), null);
  assert.equal(parseFleetV24Ipv4('01.2.3.4'), null); // leading zero rejected
  assert.equal(parseFleetV24Ipv4('1.2.3'), null);
  assert.equal(parseFleetV24Ipv4('1.2.3.4.5'), null);
  assert.equal(parseFleetV24Ipv4('a.b.c.d'), null);
  assert.equal(formatFleetV24Ipv4(0xcb00710an), '203.0.113.10');
  assert.equal(formatFleetV24Ipv4(0n), '0.0.0.0');
});

test('fleet v24 cidr: IPv6 parse + format round-trip', () => {
  assert.equal(parseFleetV24Ipv6('2001:db8::1'), 0x20010db8000000000000000000000001n);
  assert.equal(parseFleetV24Ipv6('::'), 0n);
  assert.equal(parseFleetV24Ipv6('::1'), 1n);
  assert.equal(parseFleetV24Ipv6('2001:DB8::1'), 0x20010db8000000000000000000000001n);
  assert.equal(parseFleetV24Ipv6('::ffff:192.0.2.1'), 0xffffc0000201n);
  assert.equal(parseFleetV24Ipv6('2001:db8:::1'), null);
  assert.equal(parseFleetV24Ipv6('2001:db8::1::2'), null);
  assert.equal(parseFleetV24Ipv6('gggg::1'), null);
  assert.equal(parseFleetV24Ipv6('2001:db8::1%eth0'), null);
  assert.equal(parseFleetV24Ipv6('1:2:3:4:5:6:7:8:9'), null);
  assert.equal(formatFleetV24Ipv6(0x20010db8000000000000000000000001n), '2001:db8::1');
  assert.equal(formatFleetV24Ipv6(0n), '::');
  assert.equal(formatFleetV24Ipv6(1n), '::1');
  assert.equal(formatFleetV24Ipv6(0x20010db80000000000000000ffffffffn), '2001:db8::ffff:ffff');
  assert.equal(formatFleetV24Ipv6(0x00010002000300040005000600070008n), '1:2:3:4:5:6:7:8');
});

test('fleet v24 cidr: parse IP (either family)', () => {
  assert.deepEqual(parseFleetV24Ip('10.0.0.1'), { value: 0x0a000001n, bits: 32 });
  assert.deepEqual(parseFleetV24Ip('2001:db8::1'), {
    value: 0x20010db8000000000000000000000001n,
    bits: 128,
  });
  assert.equal(parseFleetV24Ip('not-an-ip'), null);
  assert.equal(parseFleetV24Ip(''), null);
  assert.equal(parseFleetV24Ip('  10.0.0.1  ')?.bits, 32);
});

test('fleet v24 cidr: parse CIDR + normalise + host bits', () => {
  const v4 = parseFleetV24Cidr('203.0.113.0/24');
  assert.equal(v4?.text, '203.0.113.0/24');
  assert.equal(v4?.prefix, 24);
  assert.equal(v4?.bits, 32);
  assert.equal(v4?.hadHostBits, false);

  const hostBits = parseFleetV24Cidr('10.0.0.5/24');
  assert.equal(hostBits?.text, '10.0.0.0/24');
  assert.equal(hostBits?.hadHostBits, true);

  const bare = parseFleetV24Cidr('192.0.2.7');
  assert.equal(bare?.text, '192.0.2.7/32');
  assert.equal(bare?.prefix, 32);

  const v6 = parseFleetV24Cidr('2001:db8::/32');
  assert.equal(v6?.text, '2001:db8::/32');
  assert.equal(v6?.bits, 128);
  const v6Host = parseFleetV24Cidr('2001:db8::1/32');
  assert.equal(v6Host?.text, '2001:db8::/32');
  assert.equal(v6Host?.hadHostBits, true);

  assert.equal(parseFleetV24Cidr('10.0.0.0/33'), null);
  assert.equal(parseFleetV24Cidr('10.0.0.0/-1'), null);
  assert.equal(parseFleetV24Cidr('10.0.0.0/24/25'), null);
  assert.equal(parseFleetV24Cidr('10.0.0.0/abc'), null);
  assert.equal(parseFleetV24Cidr(''), null);
  assert.equal(parseFleetV24Cidr('2001:db8::/129'), null);
});

test('fleet v24 cidr: IP in CIDR (both families, no cross-family match)', () => {
  const range = parseFleetV24Cidr('203.0.113.0/24');
  assert.equal(ipInFleetV24Cidr(parseFleetV24Ip('203.0.113.10'), range), true);
  assert.equal(ipInFleetV24Cidr(parseFleetV24Ip('203.0.113.255'), range), true);
  assert.equal(ipInFleetV24Cidr(parseFleetV24Ip('203.0.114.1'), range), false);
  assert.equal(ipInFleetV24Cidr(parseFleetV24Ip('2001:db8::1'), range), false);

  const v6 = parseFleetV24Cidr('2001:db8::/32');
  assert.equal(ipInFleetV24Cidr(parseFleetV24Ip('2001:db8:ffff::1'), v6), true);
  assert.equal(ipInFleetV24Cidr(parseFleetV24Ip('2001:db9::1'), v6), false);

  const all = parseFleetV24Cidr('0.0.0.0/0');
  assert.equal(ipInFleetV24Cidr(parseFleetV24Ip('8.8.8.8'), all), true);
});

test('fleet v24 cidr: validation problems for the router UI', () => {
  assert.deepEqual(validateFleetV24CidrInput('203.0.113.0/24'), []);
  assert.deepEqual(validateFleetV24CidrInput('2001:db8::/32'), []);
  assert.deepEqual(validateFleetV24CidrInput('192.0.2.7'), []);
  assert.equal(validateFleetV24CidrInput('').length, 1);
  assert.equal(validateFleetV24CidrInput('not-a-cidr').length, 1);
  assert.ok(validateFleetV24CidrInput('not-a-cidr')[0].includes('not a valid IP'));
  assert.equal(validateFleetV24CidrInput('10.0.0.5/24').length, 1);
  assert.ok(validateFleetV24CidrInput('10.0.0.5/24')[0].includes('Host bits'));
  assert.equal(validateFleetV24CidrInput('0.0.0.0/0').length, 1);
  assert.ok(validateFleetV24CidrInput('0.0.0.0/0')[0].includes('/0'));
  assert.equal(validateFleetV24CidrInput('10.0.0.0 /24').length, 1);
});

// -- rule set -----------------------------------------------------------------

function seedRuleSet() {
  const set = new FleetV24CidrRuleSet('deny');
  set.add(
    { id: 'rule-deny-private', cidr: '10.0.0.0/8', action: 'deny', description: 'block private' },
    T0,
    'ops',
  );
  set.add(
    { id: 'rule-allow-docs', cidr: '203.0.113.0/24', action: 'allow', routeId: 'route-public', priority: 100 },
    T0,
    'ops',
  );
  set.add(
    { id: 'rule-deny-docs-sub', cidr: '203.0.113.128/25', action: 'deny', routeId: 'route-public', priority: 100 },
    T0,
    'ops',
  );
  set.add(
    { id: 'rule-allow-v6', cidr: '2001:db8::/32', action: 'allow', routeId: 'route-public' },
    T0,
    'ops',
  );
  return set;
}

test('fleet v24 cidr: add rule — normalisation, duplicates, invalid input', () => {
  const set = new FleetV24CidrRuleSet();
  const rule = set.add(
    { id: 'r1', cidr: '10.0.0.5/24', action: 'deny', routeId: 'route-a', priority: 5, description: ' x ', createdBy: 'ops' },
    T0,
  );
  assert.equal(rule.cidr, '10.0.0.0/24'); // normalised, host bits cleared
  assert.equal(rule.routeId, 'route-a');
  assert.equal(rule.priority, 5);
  assert.equal(rule.description, 'x');
  assert.equal(rule.enabled, true);
  assert.equal(set.size, 1);
  assert.throws(() => set.add({ id: 'r1', cidr: '10.0.0.0/8', action: 'deny' }, T0), /already exists/);
  assert.throws(() => set.add({ id: 'bad id', cidr: '10.0.0.0/8', action: 'deny' }, T0), /whitespace/);
  assert.throws(() => set.add({ id: 'r2', cidr: 'nope', action: 'deny' }, T0), /not a valid IP/);
  assert.throws(
    () => set.add({ id: 'r2', cidr: '10.0.0.0/8', action: 'maybe' }, T0),
    /allow.*deny/,
  );
  assert.throws(() => set.add({ id: 'r2', cidr: '10.0.0.0/8', action: 'deny', priority: -1 }, T0), /Priority/);
  // Bare IP becomes a /32 host rule.
  const host = set.add({ id: 'r3', cidr: '192.0.2.7', action: 'allow' }, T0);
  assert.equal(host.cidr, '192.0.2.7/32');
});

test('fleet v24 cidr: evaluate — longest prefix wins, deny wins ties, route binding', () => {
  const set = seedRuleSet();
  // 203.0.113.200 is in both /24 (allow) and /25 (deny): the /25 wins.
  const denied = set.evaluate('route-public', '203.0.113.200');
  assert.equal(denied.action, 'deny');
  assert.equal(denied.ruleId, 'rule-deny-docs-sub');
  assert.equal(denied.fromDefault, false);
  // 203.0.113.10 is only in the /24 allow rule.
  const allowed = set.evaluate('route-public', '203.0.113.10');
  assert.equal(allowed.action, 'allow');
  assert.equal(allowed.ruleId, 'rule-allow-docs');
  // Same IP on another route: the route-bound allow does not apply → default deny.
  const otherRoute = set.evaluate('route-internal', '203.0.113.10');
  assert.equal(otherRoute.action, 'deny');
  assert.equal(otherRoute.ruleId, null);
  assert.equal(otherRoute.fromDefault, true);
  // Global deny rule (10.0.0.0/8) applies on every route.
  assert.equal(set.evaluate('route-internal', '10.5.6.7').action, 'deny');
  assert.equal(set.evaluate(null, '10.5.6.7').ruleId, 'rule-deny-private');
  // IPv6 allow on route-public.
  assert.equal(set.evaluate('route-public', '2001:db8::5').action, 'allow');
  assert.equal(set.evaluate('route-public', '2001:db9::5').action, 'deny'); // default
  // Invalid IP fails closed.
  const bad = set.evaluate('route-public', 'not-an-ip');
  assert.equal(bad.action, 'deny');
  assert.equal(bad.fromDefault, true);
  assert.equal(set.allows('route-public', '203.0.113.10'), true);
  assert.equal(set.allows('route-public', '203.0.113.200'), false);
});

test('fleet v24 cidr: deny wins a full tie; priority breaks same-prefix ties', () => {
  const set = new FleetV24CidrRuleSet('allow');
  set.add({ id: 'tie-allow', cidr: '192.0.2.0/24', action: 'allow', priority: 50 }, T0);
  set.add({ id: 'tie-deny', cidr: '192.0.2.0/24', action: 'deny', priority: 50 }, T0);
  assert.equal(set.evaluate(null, '192.0.2.5').ruleId, 'tie-deny');
  assert.equal(set.evaluate(null, '192.0.2.5').action, 'deny');

  const set2 = new FleetV24CidrRuleSet('deny');
  set2.add({ id: 'low-prio', cidr: '192.0.2.0/24', action: 'allow', priority: 200 }, T0);
  set2.add({ id: 'high-prio', cidr: '192.0.2.0/24', action: 'deny', priority: 10 }, T0);
  assert.equal(set2.evaluate(null, '192.0.2.5').ruleId, 'high-prio');
});

test('fleet v24 cidr: enable/disable/update/remove + default change', () => {
  const set = seedRuleSet();
  assert.equal(set.disable('rule-deny-docs-sub', T0 + 100, 'ops'), true);
  // With the /25 deny disabled, the /24 allow decides.
  assert.equal(set.evaluate('route-public', '203.0.113.200').action, 'allow');
  assert.equal(set.disable('missing', T0), false);
  assert.equal(set.enable('rule-deny-docs-sub', T0 + 200, 'ops'), true);
  assert.equal(set.evaluate('route-public', '203.0.113.200').action, 'deny');

  const updated = set.update('rule-allow-docs', { action: 'deny', priority: 5 }, T0 + 300, 'ops');
  assert.equal(updated?.action, 'deny');
  assert.equal(updated?.priority, 5);
  assert.equal(set.evaluate('route-public', '203.0.113.10').action, 'deny');
  assert.equal(set.update('missing', { action: 'allow' }, T0), null);
  assert.throws(() => set.update('rule-allow-docs', { priority: -1 }, T0), /Priority/);

  set.setDefault('allow', T0 + 400, 'ops');
  assert.equal(set.defaultAction, 'allow');
  assert.equal(set.evaluate('route-public', '8.8.8.8').action, 'allow');
  set.setDefault('allow', T0 + 500, 'ops'); // no-op, no audit entry

  assert.equal(set.remove('rule-allow-v6', T0 + 600, 'ops'), true);
  assert.equal(set.remove('rule-allow-v6', T0 + 600), false);
  assert.equal(set.size, 3);
  // The CIDR itself is immutable: update cannot change the range.
  const before = set.get('rule-deny-private')?.cidr;
  set.update('rule-deny-private', { description: 'new note' }, T0 + 700, 'ops');
  assert.equal(set.get('rule-deny-private')?.cidr, before);
});

test('fleet v24 cidr: rules per route + overlaps + audit', () => {
  const set = seedRuleSet();
  assert.equal(set.rulesForRoute('route-public').length, 4); // 3 bound + 1 global
  assert.equal(set.rulesForRoute('route-internal').length, 1); // global only
  assert.equal(set.rulesForRoute('route-public', false).length, 3);
  assert.deepEqual(set.routesForRule('rule-allow-docs', ['route-public', 'route-x']), ['route-public']);
  assert.deepEqual(set.routesForRule('rule-deny-private', ['route-public', 'route-x']), ['route-public', 'route-x']);
  assert.deepEqual(set.routesForRule('missing', []), []);
  assert.equal(set.enabledRules().length, 4);

  // /24 allow and /25 deny overlap and disagree.
  const overlaps = set.overlaps();
  assert.ok(overlaps.length >= 1);
  const pair = overlaps.find(
    (o) => (o.ruleIdA === 'rule-allow-docs' && o.ruleIdB === 'rule-deny-docs-sub') ||
      (o.ruleIdA === 'rule-deny-docs-sub' && o.ruleIdB === 'rule-allow-docs'),
  );
  assert.ok(pair);
  assert.equal(pair?.conflicting, true);
  assert.equal(pair?.overlapCidr, '203.0.113.128/25');

  // Audit: 4 creates, newest first.
  const trail = set.auditTrail();
  assert.equal(trail.length, 4);
  assert.equal(trail[0].action, 'create');
  assert.ok(set.auditFor('rule-allow-docs').length === 1);
  assert.ok(set.auditFor('missing').length === 0);

  // Disabling a rule removes it from overlap detection.
  set.disable('rule-deny-docs-sub', T0 + 100, 'ops');
  assert.equal(set.overlaps().length, 0);
});

test('fleet v24 cidr: router panel + probe', () => {
  const set = seedRuleSet();
  const panel = buildFleetV24CidrRouterPanel(set, 'route-public', '203.0.113.200');
  assert.equal(panel.rules.length, 4);
  assert.equal(panel.enabledRules.length, 4);
  assert.equal(panel.rulesForRoute?.length, 4);
  assert.equal(panel.activeRouteId, 'route-public');
  assert.equal(panel.probe?.action, 'deny');
  assert.equal(panel.probe?.ruleId, 'rule-deny-docs-sub');
  assert.equal(panel.overlaps.length, 1);
  assert.equal(panel.audit.length, 4);
  assert.ok(panel.summary.includes('4 rules'));

  const plain = buildFleetV24CidrRouterPanel(set);
  assert.equal(plain.rulesForRoute, null);
  assert.equal(plain.probe, null);
  assert.equal(plain.defaultAction, 'deny');
});

// -- stop hook feedback --------------------------------------------------------

function seedFeedback() {
  const store = new FleetV24StopHookFeedbackStore();
  store.record(
    {
      id: 'sh-1', runId: 'run-1', automationId: 'auto-cleanup',
      reason: 'max-steps reached (120 steps)', triggeredBy: 'system',
      triggeredByName: 'agent-loop', action: 'stop',
    },
    T0,
  );
  store.record(
    {
      id: 'sh-2', runId: 'run-2', automationId: 'auto-weekly-report',
      reason: 'User pressed Stop', triggeredBy: 'user', triggeredByName: 'huy',
      action: 'pause',
    },
    T0 + 1000,
  );
  store.record(
    {
      id: 'sh-3', runId: 'run-3', automationId: 'auto-nightly-backup',
      reason: 'Rule nightly-guard tripped', triggeredBy: 'rule',
      triggeredByName: 'nightly-guard', action: 'retry',
      suggestedNextAction: 'Custom: check the overlap window first.',
    },
    T0 + 2000,
  );
  return store;
}

test('fleet v24 stophook: suggestions derived from reason + trigger', () => {
  assert.ok(suggestFleetV24NextAction('max-steps reached', 'system', 'stop').includes('step limit'));
  assert.ok(suggestFleetV24NextAction('approval denied by reviewer', 'approval', 'stop').includes('denied request'));
  assert.ok(suggestFleetV24NextAction('timed out after 30m', 'timeout', 'stop').includes('timeout'));
  assert.ok(suggestFleetV24NextAction('loop detected', 'process', 'stop').includes('repeating step'));
  assert.ok(suggestFleetV24NextAction('rule x tripped', 'rule', 'stop').includes('rule'));
  assert.ok(suggestFleetV24NextAction('user pressed stop', 'user', 'pause').includes('Resume'));
  assert.ok(suggestFleetV24NextAction('something odd', 'system', 'ignore').includes('overruled'));
  assert.ok(suggestFleetV24NextAction('something odd', 'system', 'escalate').includes('human'));
  assert.ok(suggestFleetV24NextAction('something odd', 'system', 'retry').includes('retry'));
  assert.ok(suggestFleetV24NextAction('something odd', 'system', 'stop').includes('run log'));
});

test('fleet v24 stophook: record validation', () => {
  assert.equal(
    validateFleetV24StopHookInput({
      id: '', runId: 'r', automationId: 'a', reason: 'x',
      triggeredBy: 'user', triggeredByName: 'u', action: 'stop',
    }),
    'Feedback id must not be empty.',
  );
  assert.equal(
    validateFleetV24StopHookInput({
      id: 'ok', runId: 'r', automationId: 'a', reason: '',
      triggeredBy: 'user', triggeredByName: 'u', action: 'stop',
    }),
    'Stop reason must not be empty.',
  );
  assert.equal(
    validateFleetV24StopHookInput({
      id: 'ok', runId: 'r', automationId: 'a', reason: 'x',
      triggeredBy: 'alien', triggeredByName: 'u', action: 'stop',
    }),
    'Unknown stop trigger "alien".',
  );
  assert.equal(
    validateFleetV24StopHookInput({
      id: 'ok', runId: 'r', automationId: 'a', reason: 'x',
      triggeredBy: 'user', triggeredByName: 'u', action: 'explode',
    }),
    'Unknown stop action "explode".',
  );
  assert.equal(
    validateFleetV24StopHookInput({
      id: 'ok', runId: 'r', automationId: 'a', reason: 'x',
      triggeredBy: 'user', triggeredByName: 'u', action: 'stop',
    }),
    null,
  );
});

test('fleet v24 stophook: record, query, acknowledge', () => {
  const store = seedFeedback();
  assert.equal(store.size, 3);
  assert.throws(
    () => store.record(
      { id: 'sh-1', runId: 'r', automationId: 'a', reason: 'x', triggeredBy: 'user', triggeredByName: 'u', action: 'stop' },
      T0,
    ),
    /already exists/,
  );

  // Derived suggestion for sh-1 (max-steps) and custom one for sh-3.
  assert.ok(store.get('sh-1')?.suggestedNextAction.includes('step limit'));
  assert.equal(store.get('sh-3')?.suggestedNextAction, 'Custom: check the overlap window first.');
  assert.equal(store.get('sh-2')?.acknowledged, false);

  assert.equal(store.forRun('run-1').length, 1);
  assert.equal(store.forRun('run-1')[0].id, 'sh-1');
  assert.equal(store.forAutomation('auto-cleanup').length, 1);
  assert.equal(store.query({ triggeredBy: 'rule' }).length, 1);
  assert.equal(store.query({ action: 'pause' }).length, 1);
  assert.equal(store.query({ acknowledged: false }).length, 3);
  assert.equal(store.query({ reasonContains: 'MAX-STEPS' }).length, 1);
  assert.equal(store.query({ fromMs: T0 + 1500 }).length, 1);
  assert.equal(store.query({ toMs: T0 + 1500 }).length, 2);
  assert.equal(store.query({ runId: 'run-1', triggeredBy: 'user' }).length, 0);
  assert.equal(store.unacknowledged().length, 3);
  assert.equal(store.recent(2).length, 2);
  assert.equal(store.recent(2)[0].id, 'sh-3');

  const acked = store.acknowledge('sh-1', 'ops-lead', T0 + 5000, 'Reviewed, will raise the limit.');
  assert.equal(acked?.acknowledged, true);
  assert.equal(acked?.acknowledgedBy, 'ops-lead');
  assert.equal(acked?.acknowledgedAtMs, T0 + 5000);
  assert.equal(acked?.acknowledgeNote, 'Reviewed, will raise the limit.');
  assert.equal(store.unacknowledged().length, 2);
  assert.equal(store.acknowledge('missing', 'ops', T0), null);
  assert.throws(() => store.acknowledge('sh-2', '  ', T0), /must not be empty/);
});

test('fleet v24 stophook: summaries + panel', () => {
  const store = seedFeedback();
  store.acknowledge('sh-2', 'huy', T0 + 3000);

  const fleet = store.summary();
  assert.equal(fleet.key, '*');
  assert.equal(fleet.total, 3);
  assert.equal(fleet.unacknowledged, 2);
  assert.equal(fleet.byTrigger.user, 1);
  assert.equal(fleet.byTrigger.rule, 1);
  assert.equal(fleet.byTrigger.system, 1);
  assert.equal(fleet.byAction.stop, 1);
  assert.equal(fleet.byAction.pause, 1);
  assert.equal(fleet.byAction.retry, 1);
  assert.equal(fleet.latestAtMs, T0 + 2000);

  const perAuto = store.summaryForAutomation('auto-cleanup');
  assert.equal(perAuto.total, 1);
  assert.equal(perAuto.unacknowledged, 1);
  assert.equal(store.summaryForAutomation('nope').total, 0);

  const byAuto = store.summariesByAutomation();
  assert.equal(byAuto.length, 3);
  const byTrigger = store.summariesByTrigger();
  assert.equal(byTrigger.length, 3); // only triggers that fired
  assert.ok(byTrigger.every((s) => s.total > 0));

  const panel = buildFleetV24StopHookPanel(store, 'auto-cleanup', 'run-1');
  assert.equal(panel.unacknowledged.length, 2);
  assert.equal(panel.recent.length, 3);
  assert.equal(panel.forAutomation?.length, 1);
  assert.equal(panel.forRun?.length, 1);
  assert.ok(panel.summary.includes('3 stop-hook events'));
  const plain = buildFleetV24StopHookPanel(store);
  assert.equal(plain.forAutomation, null);
  assert.equal(plain.forRun, null);
});
