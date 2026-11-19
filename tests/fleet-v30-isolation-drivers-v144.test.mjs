/**
 * Tests for fleet v30 per-conversation runtime isolation + drivers
 * (v1.44, Team T6).
 *
 * Covers:
 * - Driver capability matrix (bwrap isolates, docker isolates +
 *   resource limits, local does NOT isolate and only allows host
 *   networking).
 * - Driver selection: preferred kind when available; fallback to
 *   the next available kind with reasons; local only as fallback;
 *   null when nothing is available (or local is disallowed).
 * - Driver argv builders: bwrap (`--unshare-net` for none, refused
 *   for host), docker (`--network none/host/bridge`, `--cpus`,
 *   `--memory`), local (plain command). Shell metacharacters in
 *   the command are refused; unknown network modes are refused.
 * - Isolation manager: bind (bwrap default, docker-preferred falls
 *   back, host networking falls back to local labelled unisolated),
 *   double-bind refused, suspend/resume round trip, touch resets
 *   the idle clock, endConversation stops the runtime + lists the
 *   3 scratch paths + is idempotent, orphan sweep marks bindings
 *   whose v28 runtime vanished, aggregate usage sums live runtimes,
 *   events ledger records bind/suspend/resume/clean.
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/fleet-v30-isolation-drivers-v144.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { FleetV28RuntimeStore } from '../packages/core/dist/fleetV28/runtime.js';
import {
  FLEET_V30_DRIVER_CAPABILITIES,
  buildFleetV30BwrapCommand,
  buildFleetV30DockerCommand,
  buildFleetV30DriverCommand,
  buildFleetV30LocalCommand,
  fleetV30DriverAvailability,
  fleetV30DriverCapabilities,
  fleetV30DriverIsolates,
  fleetV30DriverSupportsNetwork,
  probeFleetV30DriverAvailability,
  selectFleetV30Driver,
  validateFleetV30DriverCommand,
} from '../packages/core/dist/fleetV30/drivers.js';
import { FleetV30IsolationManager } from '../packages/core/dist/fleetV30/isolation.js';
import { FleetV30ProfileQuotas } from '../packages/core/dist/fleetV30/quotas.js';

const AVAIL = [
  fleetV30DriverAvailability('bwrap', { available: true, binaryPath: '/usr/bin/bwrap', version: '0.8.0' }),
  fleetV30DriverAvailability('docker', { available: false, reason: 'Docker is not installed on this host.' }),
  fleetV30DriverAvailability('local', { available: true }),
];

const ALL_AVAIL = [
  fleetV30DriverAvailability('bwrap', { available: true }),
  fleetV30DriverAvailability('docker', { available: true, version: '27.0.0' }),
  fleetV30DriverAvailability('local', { available: true }),
];

function makeManager(opts = {}) {
  let now = 1780000000000;
  const store = new FleetV28RuntimeStore({ maxConcurrentRuntimes: 4 });
  const manager = new FleetV30IsolationManager({
    runtimeStore: store,
    workspaceBaseDir: '/tmp/open-bot-v144-t6-test',
    driverAvailability: opts.availability ?? AVAIL,
    nowMs: () => now,
    nowIso: () => new Date(now).toISOString(),
  });
  return { store, manager, advance: (ms) => { now += ms; } };
}

function baseCmd(overrides = {}) {
  return {
    command: 'node',
    args: ['--version'],
    cwd: '/tmp/open-bot-v144-t6-test/conv-1',
    workspaceRoot: '/tmp/open-bot-v144-t6-test/conv-1',
    networkMode: 'loopback',
    cpuCores: 1,
    ramMB: 1024,
    ...overrides,
  };
}

/* ---------------- driver capabilities ---------------- */

test('driver probe: three drivers, local always available', () => {
  const probed = probeFleetV30DriverAvailability();
  assert.deepEqual(probed.map((d) => d.kind), ['bwrap', 'docker', 'local']);
  assert.equal(probed[2].available, true);
  for (const d of probed) {
    if (d.available) assert.equal(d.reason, null);
    else assert.ok(d.reason);
  }
});

test('driver capabilities: bwrap/docker isolate, local does not', () => {
  assert.equal(fleetV30DriverCapabilities('bwrap').isolates, true);
  assert.equal(fleetV30DriverCapabilities('docker').isolates, true);
  assert.equal(fleetV30DriverCapabilities('docker').resourceLimits, true);
  assert.equal(fleetV30DriverCapabilities('bwrap').resourceLimits, false);
  assert.equal(fleetV30DriverCapabilities('local').isolates, false);
  assert.equal(fleetV30DriverCapabilities('local').binary, null);
  assert.equal(fleetV30DriverIsolates('bwrap'), true);
  assert.equal(fleetV30DriverIsolates('local'), false);
  assert.equal(Object.keys(FLEET_V30_DRIVER_CAPABILITIES).length, 3);
});

test('driver network modes: bwrap refuses host, local only allows host', () => {
  assert.equal(fleetV30DriverSupportsNetwork('bwrap', 'none'), true);
  assert.equal(fleetV30DriverSupportsNetwork('bwrap', 'loopback'), true);
  assert.equal(fleetV30DriverSupportsNetwork('bwrap', 'host'), false);
  assert.equal(fleetV30DriverSupportsNetwork('docker', 'host'), true);
  assert.equal(fleetV30DriverSupportsNetwork('local', 'none'), false);
  assert.equal(fleetV30DriverSupportsNetwork('local', 'host'), true);
});

/* ---------------- driver selection ---------------- */

test('driver selection: preferred available kind wins', () => {
  const sel = selectFleetV30Driver('docker', ALL_AVAIL, 'loopback');
  assert.ok(sel);
  assert.equal(sel.kind, 'docker');
  assert.equal(sel.viaFallback, false);
  assert.deepEqual(sel.reasons, []);
});

test('driver selection: unavailable preferred falls back with reasons', () => {
  const sel = selectFleetV30Driver('docker', AVAIL, 'loopback');
  assert.ok(sel);
  assert.equal(sel.kind, 'bwrap');
  assert.equal(sel.viaFallback, false);
  assert.equal(sel.reasons.length, 1);
  assert.match(sel.reasons[0], /docker.*unavailable/);
});

test('driver selection: host networking with no docker falls back to local (labelled)', () => {
  const sel = selectFleetV30Driver(null, AVAIL, 'host');
  assert.ok(sel);
  assert.equal(sel.kind, 'local');
  assert.equal(sel.viaFallback, true);
});

test('driver selection: null when nothing available, or local disallowed', () => {
  const none = [
    fleetV30DriverAvailability('bwrap', { available: false, reason: 'no bwrap' }),
    fleetV30DriverAvailability('docker', { available: false, reason: 'no docker' }),
    fleetV30DriverAvailability('local', { available: false, reason: 'fallback disabled' }),
  ];
  assert.equal(selectFleetV30Driver(null, none, 'loopback'), null);
  const localOnly = [
    fleetV30DriverAvailability('bwrap', { available: false, reason: 'no bwrap' }),
    fleetV30DriverAvailability('docker', { available: false, reason: 'no docker' }),
    fleetV30DriverAvailability('local', { available: true }),
  ];
  assert.equal(selectFleetV30Driver(null, localOnly, 'loopback', false), null);
  const fallback = selectFleetV30Driver(null, localOnly, 'host', true);
  assert.ok(fallback);
  assert.equal(fallback.kind, 'local');
});

/* ---------------- driver argv builders ---------------- */

test('bwrap argv: loopback keeps networking, none unshares it, host refused', () => {
  const loopback = buildFleetV30BwrapCommand(baseCmd({ networkMode: 'loopback' }));
  assert.equal(loopback.ok, true);
  if (loopback.ok) {
    assert.equal(loopback.argv[0], 'bwrap');
    assert.ok(!loopback.argv.includes('--unshare-net'));
    assert.ok(loopback.argv.includes('/tmp/open-bot-v144-t6-test/conv-1'));
    assert.equal(loopback.argv[loopback.argv.length - 2], 'node');
  }
  const none = buildFleetV30BwrapCommand(baseCmd({ networkMode: 'none' }));
  assert.equal(none.ok, true);
  if (none.ok) assert.ok(none.argv.includes('--unshare-net'));
  const host = buildFleetV30BwrapCommand(baseCmd({ networkMode: 'host' }));
  assert.equal(host.ok, false);
  if (!host.ok) assert.ok(host.reasons.some((r) => r.includes('host')));
});

test('docker argv: network mapping + cpu/memory flags', () => {
  const none = buildFleetV30DockerCommand(baseCmd({ networkMode: 'none' }));
  assert.equal(none.ok, true);
  if (none.ok) {
    assert.equal(none.argv[0], 'docker');
    assert.ok(none.argv.includes('none'));
    assert.ok(none.argv.includes('--cpus'));
    assert.ok(none.argv.includes('--memory'));
    assert.ok(none.argv.includes('1024m'));
  }
  const host = buildFleetV30DockerCommand(baseCmd({ networkMode: 'host' }));
  assert.equal(host.ok, true);
  if (host.ok) assert.ok(host.argv.includes('host'));
  const loopback = buildFleetV30DockerCommand(baseCmd({ networkMode: 'loopback' }), 'my-image:1');
  assert.equal(loopback.ok, true);
  if (loopback.ok) {
    assert.ok(loopback.argv.includes('bridge'));
    assert.ok(loopback.argv.includes('my-image:1'));
  }
});

test('local argv is the plain command; dispatch picks the right builder', () => {
  const local = buildFleetV30LocalCommand(baseCmd({ networkMode: 'host' }));
  assert.deepEqual(local, { ok: true, argv: ['node', '--version'] });
  const viaDispatch = buildFleetV30DriverCommand('docker', baseCmd({ networkMode: 'none' }));
  assert.equal(viaDispatch.ok, true);
  if (viaDispatch.ok) assert.equal(viaDispatch.argv[0], 'docker');
  const viaLocal = buildFleetV30DriverCommand('local', baseCmd({ networkMode: 'host' }));
  assert.deepEqual(viaLocal, { ok: true, argv: ['node', '--version'] });
});

test('driver command validation refuses shell metacharacters and bad modes', () => {
  const bad = validateFleetV30DriverCommand('bwrap', baseCmd({ command: 'node; rm -rf /' }));
  assert.ok(bad.length > 0);
  const badArgs = validateFleetV30DriverCommand('docker', baseCmd({ args: ['a', 'b|c'] }));
  assert.ok(badArgs.some((r) => r.includes('blocked') || r.includes('pattern') || r.includes('|')));
  const badMode = validateFleetV30DriverCommand('bwrap', baseCmd({ networkMode: 'host' }));
  assert.ok(badMode.some((r) => r.includes('host')));
  const ok = validateFleetV30DriverCommand('bwrap', baseCmd());
  assert.deepEqual(ok, []);
});

/* ---------------- isolation manager ---------------- */

test('isolation bind: bwrap default, isolated, runtime running', () => {
  const { manager, store } = makeManager();
  const result = manager.bind('conv-1', 'profile-a');
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.binding.conversationId, 'conv-1');
  assert.equal(result.binding.driverKind, 'bwrap');
  assert.equal(result.binding.isolated, true);
  assert.equal(result.binding.status, 'active');
  assert.equal(result.binding.networkMode, 'loopback');
  assert.equal(result.binding.workspaceRoot, '/tmp/open-bot-v144-t6-test/conv-1');
  assert.equal(store.getRuntime('conv-1')?.state, 'running');
  assert.equal(manager.activeCount(), 1);
  assert.equal(manager.bindingCount(), 1);
});

test('isolation bind: docker preferred but unavailable falls back to bwrap', () => {
  const { manager } = makeManager();
  const result = manager.bind('conv-1', 'profile-a', { driverKind: 'docker' });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.binding.driverKind, 'bwrap');
});

test('isolation bind: host networking with no docker falls back to local, labelled unisolated', () => {
  const { manager } = makeManager();
  const result = manager.bind('conv-1', 'profile-a', { networkMode: 'host' });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.binding.driverKind, 'local');
  assert.equal(result.binding.isolated, false);
  const panel = manager.listBindings().filter((b) => !b.isolated);
  assert.equal(panel.length, 1);
});

test('isolation bind: double-bind, bad ids, and no-driver refusals', () => {
  const { manager } = makeManager();
  assert.equal(manager.bind('conv-1', 'profile-a').ok, true);
  const again = manager.bind('conv-1', 'profile-a');
  assert.equal(again.ok, false);
  if (!again.ok) assert.ok(again.reasons.some((r) => r.includes('already has an active')));
  assert.equal(manager.bind('', 'profile-a').ok, false);
  assert.equal(manager.bind('conv-2', '').ok, false);
  assert.equal(manager.bind('conv with space', 'profile-a').ok, false);
  // Fail-closed: a workspace root outside the base dir is refused,
  // even when absolute — cleanup must never list host paths.
  assert.equal(manager.bind('conv-2', 'profile-a', { workspaceRoot: '/etc' }).ok, false);
  assert.equal(manager.bind('conv-2', 'profile-a', { workspaceRoot: '/tmp/elsewhere' }).ok, false);
  assert.equal(manager.bind('conv-2', 'profile-a', { workspaceRoot: '/tmp/open-bot-v144-t6-test/conv-2' }).ok, true);
  const noDriver = makeManager({
    availability: [
      fleetV30DriverAvailability('bwrap', { available: false, reason: 'no bwrap' }),
      fleetV30DriverAvailability('docker', { available: false, reason: 'no docker' }),
      fleetV30DriverAvailability('local', { available: true }),
    ],
  });
  const refused = noDriver.manager.bind('conv-9', 'profile-a', { networkMode: 'loopback', allowLocalFallback: false });
  assert.equal(refused.ok, false);
  assert.equal(noDriver.manager.listEvents().some((e) => e.kind === 'driver-unavailable'), true);
});

test('isolation suspend/resume round trip; wrong-state refusals', () => {
  const { manager, store } = makeManager();
  assert.equal(manager.bind('conv-1', 'profile-a').ok, true);
  const suspended = manager.suspend('conv-1', 'Paused by admin.');
  assert.equal(suspended.ok, true);
  if (suspended.ok) assert.equal(suspended.binding.status, 'suspended');
  assert.equal(store.getRuntime('conv-1')?.state, 'stopped');
  assert.equal(manager.suspend('conv-1').ok, false);
  const resumed = manager.resume('conv-1');
  assert.equal(resumed.ok, true);
  if (resumed.ok) assert.equal(resumed.binding.status, 'active');
  assert.equal(store.getRuntime('conv-1')?.state, 'running');
  assert.equal(manager.resume('conv-1').ok, false);
  assert.equal(manager.suspend('conv-missing').ok, false);
  assert.equal(manager.resume('conv-missing').ok, false);
});

test('isolation touch resets the idle clock', () => {
  const { manager, advance } = makeManager();
  assert.equal(manager.bind('conv-1', 'profile-a').ok, true);
  const before = manager.getBinding('conv-1')?.lastActivityMs;
  advance(60_000);
  assert.equal(manager.touch('conv-1'), true);
  assert.equal(manager.getBinding('conv-1')?.lastActivityMs, (before ?? 0) + 60_000);
  assert.equal(manager.touch('conv-missing'), false);
});

test('isolation endConversation: stops runtime, lists 3 scratch paths, idempotent', () => {
  const { manager, store } = makeManager();
  assert.equal(manager.bind('conv-1', 'profile-a').ok, true);
  const ended = manager.endConversation('conv-1', 'User ended the chat.');
  assert.equal(ended.cleaned, true);
  assert.deepEqual(ended.wipedPaths, [
    '/tmp/open-bot-v144-t6-test/conv-1/scratch',
    '/tmp/open-bot-v144-t6-test/conv-1/tmp',
    '/tmp/open-bot-v144-t6-test/conv-1/downloads',
  ]);
  assert.equal(store.getRuntime('conv-1')?.state, 'stopped');
  assert.equal(manager.getBinding('conv-1')?.status, 'cleaned');
  assert.equal(manager.getBinding('conv-1')?.cleanupReason, 'User ended the chat.');
  const again = manager.endConversation('conv-1');
  assert.equal(again.cleaned, false);
  const missing = manager.endConversation('conv-missing');
  assert.equal(missing.cleaned, false);
  assert.ok(missing.reasons[0].includes('No isolation binding'));
});

test('isolation orphan sweep marks bindings whose runtime vanished', () => {
  const { manager, store } = makeManager();
  assert.equal(manager.bind('conv-1', 'profile-a').ok, true);
  assert.equal(manager.bind('conv-2', 'profile-a').ok, true);
  assert.deepEqual(manager.sweepOrphans(), []);
  // Simulate a host crash: the v28 runtime disappears without cleanup.
  // The store keeps its map in a TS-private field (plain property at
  // runtime) — reach it the same way the host would after a restart.
  const storeAny = store;
  storeAny.runtimes?.delete?.('conv-2');
  const orphaned = manager.sweepOrphans();
  assert.deepEqual(orphaned, ['conv-2']);
  assert.equal(manager.getBinding('conv-2')?.status, 'cleaned');
  assert.match(manager.getBinding('conv-2')?.cleanupReason ?? '', /Orphaned/);
  assert.equal(manager.getBinding('conv-1')?.status, 'active');
  assert.equal(manager.eventsFor('conv-2').some((e) => e.kind === 'binding-orphaned'), true);
});

test('isolation bind enforces wired quotas (admission at bind time)', () => {
  const { manager } = makeManager();
  const quotas = new FleetV30ProfileQuotas({ isolation: manager });
  manager.setQuotas(quotas);
  assert.equal(quotas.setQuota('profile-a', 'root', { maxBindings: 1 }).ok, true);
  assert.equal(manager.bind('conv-1', 'profile-a').ok, true);
  const second = manager.bind('conv-2', 'profile-a');
  assert.equal(second.ok, false);
  if (!second.ok) assert.ok(second.reasons.some((r) => r.includes('binding quota')));
  // Another profile is unaffected.
  assert.equal(manager.bind('conv-3', 'profile-b').ok, true);
  // Unwiring quotas re-admits the profile.
  manager.setQuotas(undefined);
  assert.equal(manager.bind('conv-2', 'profile-a').ok, true);
});

test('isolation usage totals + events ledger', () => {
  const { manager, store } = makeManager();
  assert.equal(manager.bind('conv-1', 'profile-a').ok, true);
  assert.equal(manager.bind('conv-2', 'profile-a').ok, true);
  store.recordUsage('conv-1', { cpuCores: 0.5, ramMB: 512, diskMB: 100 });
  store.recordUsage('conv-2', { cpuCores: 1.5, ramMB: 1024, diskMB: 200 });
  const usage = manager.aggregateUsage();
  assert.equal(usage.cpuCores, 2);
  assert.equal(usage.ramMB, 1536);
  assert.equal(usage.diskMB, 300);
  assert.equal(usage.active, 2);
  manager.endConversation('conv-2');
  assert.equal(manager.aggregateUsage().active, 1);
  assert.equal(manager.aggregateUsage().cleaned, 1);
  const events = manager.listEvents();
  assert.ok(events.some((e) => e.kind === 'binding-created' && e.conversationId === 'conv-1'));
  assert.ok(events.some((e) => e.kind === 'binding-cleaned' && e.conversationId === 'conv-2'));
  assert.ok(events.every((e, i) => e.seq === i + 1));
  const byProfile = manager.listBindingsByProfile('profile-a');
  assert.equal(byProfile.length, 2);
});

test('isolation sweepEvictedBindings: idle-evicted runtime suspends its binding', () => {
  const { manager, store, advance } = makeManager();
  assert.equal(manager.bind('conv-1', 'profile-a', { limits: { idleTimeoutMs: 1000 } }).ok, true);
  assert.equal(manager.bind('conv-2', 'profile-a').ok, true);
  advance(5000);
  const swept = store.sweepIdle(1780000005000);
  assert.deepEqual(swept.evicted, ['conv-1']);
  assert.equal(store.getRuntime('conv-1')?.state, 'evicted');
  const suspended = manager.sweepEvictedBindings();
  assert.deepEqual(suspended, ['conv-1']);
  assert.equal(manager.getBinding('conv-1')?.status, 'suspended');
  assert.equal(manager.getBinding('conv-2')?.status, 'active');
  assert.ok(manager.eventsFor('conv-1').some((e) => e.kind === 'binding-suspended' && e.detail.includes('evicted')));
  // Second sweep is a no-op; the binding can resume.
  assert.deepEqual(manager.sweepEvictedBindings(), []);
  assert.equal(manager.resume('conv-1').ok, true);
});
