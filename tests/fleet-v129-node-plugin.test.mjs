/**
 * Node status + plugin SDK v4 tests (v1.29, Đội T6 — node:test, no network).
 *
 * Covers:
 * - Node status: allowed transitions table (incl. removed is terminal,
 *   down can only rejoin via joining); transition side effects
 *   (draining sets drainStartedAt+reason, active clears them);
 *   invalid transition throws with allowed list.
 * - Heartbeat staleness: fresh/stale/very-stale/lost/never thresholds;
 *   lost detection.
 * - Pressure: utilization per resource, tightest resource, pressure
 *   levels at 70/85/95%; disk-free math.
 * - Ranking: eligible only when active + healthy-ish + heartbeat fresh;
 *   score parts sum; sorted best first; ineligible reasons.
 * - Status snapshot: counts by status/health/pressure/staleness,
 *   eligible/busy counts, attention nodes sorted by reason count.
 * - Auto-drain + stale-down listing.
 * - Plugin SDK v4: capability parse/format/compat (major must match,
 *   minor <= host); registry build (duplicate throws); manifest
 *   validate (id/version/sdkVersion/main path/capability dupes/
 *   self-dependency); registry check (unknown capability, permission
 *   without covering capability); version ranges (^, ~, >= <, exact,
 *   bad range false); install/enable/disable/uninstall guards
 *   (dependency missing/version/cycle, dep must be enabled first,
 *   cannot disable/uninstall a depended-on plugin, enabled must be
 *   disabled before uninstall); approve/revoke permission; sandbox
 *   limits; load order topological; permission evaluation (not
 *   enabled, undeclared capability, high-risk/network needs approval,
 *   fs dir limits, network host limits, shell prefix limits);
 *   store summary.
 * - Tools-side SDK v4 bridge: JSON parse (valid + each invalid shape),
 *   capability check, v4->v3 conversion, sandbox summary readyToRun.
 *
 * Imports the BUILT core + tools — build first:
 *   ./node_modules/.bin/tsc -p packages/core/tsconfig.json
 *   ./node_modules/.bin/tsc -p packages/tools/tsconfig.json
 * then: node --test tests/fleet-v129-node-plugin.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FLEET_V19_HEARTBEAT_FRESH_MS,
  canFleetV19Transition,
  fleetV19AllowedTransitions,
  fleetV19HeartbeatLost,
  fleetV19HeartbeatStaleness,
  fleetV19NodePressure,
  fleetV19PressureOf,
  fleetV19ShouldAutoDrain,
  listFleetV19StaleDownNodes,
  rankFleetV19Nodes,
  summarizeFleetV19Status,
  transitionFleetV19NodeStatus,
} from '../packages/core/dist/fleetV19/nodeStatusV19.js';

import {
  PLUGIN_SDK_V19_MAX_SUPPORTED,
  approvePluginV19Permission,
  buildPluginV19CapabilityRegistry,
  checkPluginV19CapabilityCompat,
  checkPluginV19Dependencies,
  checkPluginV19ManifestAgainstRegistry,
  defaultPluginV19Capabilities,
  disablePluginV19,
  enablePluginV19,
  evaluatePluginV19Permission,
  formatPluginV19Capability,
  installPluginV19,
  parsePluginV19Capability,
  parsePluginV19Version,
  pluginV19VersionSatisfies,
  resolvePluginV19LoadOrder,
  revokePluginV19Permission,
  setPluginV19SandboxLimits,
  summarizePluginV19Store,
  uninstallPluginV19,
  validatePluginV19Manifest,
} from '../packages/core/dist/fleetV19/pluginSdkV19.js';

import {
  checkPluginSdkV4Capabilities,
  parsePluginSdkV4ManifestJson,
  pluginSdkV4ManifestToV3,
  summarizePluginSdkV4Sandbox,
} from '../packages/tools/dist/plugins/sdkV4.js';

const T0 = Date.UTC(2026, 11, 17, 0, 0, 0);
const MIN = 60 * 1000;

function node(id, over = {}) {
  return {
    nodeId: id, hostname: `${id}.local`, fingerprint: `fp-${id}`, labels: {},
    capacity: { cpuCores: 8, ramTotalMb: 32768, vramTotalMb: 0, diskTotalMb: 500000, maxTasks: 4 },
    status: 'active', health: 'healthy', lastHeartbeatAt: T0, registeredAt: T0,
    drainStartedAt: null, maintenanceReason: '', usedRamMb: 0, usedVramMb: 0,
    usedCpuCores: 0, runningTaskIds: [], ...over,
  };
}

// ---------------------------------------------------------------------------
// Node status
// ---------------------------------------------------------------------------

test('node v19: transition table — removed is terminal, down rejoins via joining', () => {
  assert.equal(canFleetV19Transition('active', 'draining'), true);
  assert.equal(canFleetV19Transition('active', 'joining'), false);
  assert.equal(canFleetV19Transition('down', 'active'), false);
  assert.equal(canFleetV19Transition('down', 'joining'), true);
  assert.deepEqual(fleetV19AllowedTransitions('removed'), []);
  assert.deepEqual(fleetV19AllowedTransitions('active'), ['draining', 'maintenance', 'down', 'removed']);
});

test('node v19: transition side effects + invalid transition error lists allowed', () => {
  const draining = transitionFleetV19NodeStatus(node('n1'), 'draining', T0 + MIN, 'kernel upgrade');
  assert.equal(draining.status, 'draining');
  assert.equal(draining.drainStartedAt, T0 + MIN);
  assert.equal(draining.maintenanceReason, 'kernel upgrade');
  const active = transitionFleetV19NodeStatus(draining, 'active', T0 + 2 * MIN);
  assert.equal(active.drainStartedAt, null);
  assert.equal(active.maintenanceReason, '');
  assert.throws(
    () => transitionFleetV19NodeStatus(node('n1', { status: 'removed' }), 'active', T0),
    /không chuyển được.*removed/,
  );
  assert.throws(
    () => transitionFleetV19NodeStatus(node('n1'), 'joining', T0),
    /chỉ được: draining, maintenance, down, removed/,
  );
});

test('node v19: heartbeat staleness thresholds + lost detection', () => {
  assert.equal(fleetV19HeartbeatStaleness(T0, T0 + 1000), 'fresh');
  assert.equal(fleetV19HeartbeatStaleness(T0, T0 + FLEET_V19_HEARTBEAT_FRESH_MS - 1), 'fresh');
  assert.equal(fleetV19HeartbeatStaleness(T0, T0 + FLEET_V19_HEARTBEAT_FRESH_MS), 'stale');
  assert.equal(fleetV19HeartbeatStaleness(T0, T0 + 5 * MIN), 'very-stale');
  assert.equal(fleetV19HeartbeatStaleness(T0, T0 + 30 * MIN), 'lost');
  assert.equal(fleetV19HeartbeatStaleness(null, T0), 'never');
  assert.equal(fleetV19HeartbeatLost(null, T0), true);
  assert.equal(fleetV19HeartbeatLost(T0, T0 + MIN), false);
  assert.equal(fleetV19HeartbeatStaleness(T0 + MIN, T0), 'fresh'); // clock skew: future heartbeat
});

test('node v19: pressure per resource, tightest wins, levels at 70/85/95', () => {
  assert.equal(fleetV19PressureOf(0.69), 'ok');
  assert.equal(fleetV19PressureOf(0.7), 'warm');
  assert.equal(fleetV19PressureOf(0.85), 'hot');
  assert.equal(fleetV19PressureOf(0.95), 'critical');
  const p = fleetV19NodePressure(
    node('n1', { usedCpuCores: 4, usedRamMb: 30000, runningTaskIds: ['a'] }),
    100000, // disk free 100GB of 500GB -> 80% used
  );
  assert.equal(p.cpu, 0.5);
  assert.equal(p.ram, 0.916);
  assert.equal(p.diskUsed, 0.8);
  assert.equal(p.tasks, 0.25);
  assert.equal(p.tightest, 'ram');
  assert.equal(p.pressure, 'hot');
  const idle = fleetV19NodePressure(node('n2'), 500000);
  assert.equal(idle.pressure, 'ok');
  assert.equal(idle.tightestUtilization, 0);
});

test('node v19: ranking eligible only when active/healthy/heartbeat fresh, sorted best first', () => {
  const nodes = [
    node('a', { usedCpuCores: 1 }),
    node('b', { usedCpuCores: 7, runningTaskIds: ['x', 'y', 'z'] }),
    node('c', { status: 'draining', usedCpuCores: 4 }),
    node('d', { health: 'down', lastHeartbeatAt: T0 - 60 * MIN }),
  ];
  const ranks = rankFleetV19Nodes(
    nodes,
    { a: 95, b: 90, c: 95, d: 10 },
    {
      a: fleetV19NodePressure(nodes[0], 500000),
      b: fleetV19NodePressure(nodes[1], 500000),
      c: fleetV19NodePressure(nodes[2], 500000),
      d: fleetV19NodePressure(nodes[3], 500000),
    },
    T0,
  );
  assert.equal(ranks[0].nodeId, 'a');
  assert.equal(ranks[0].eligible, true);
  assert.equal(ranks[0].parts.health + ranks[0].parts.load + ranks[0].parts.heartbeat, ranks[0].score);
  const byId = new Map(ranks.map((r) => [r.nodeId, r]));
  assert.equal(byId.get('b')?.eligible, true); // busy but still eligible
  assert.ok((byId.get('b')?.score ?? 99) < (byId.get('a')?.score ?? 0));
  assert.equal(byId.get('c')?.eligible, false);
  assert.match(byId.get('c')?.ineligibleReason ?? '', /không active/);
  assert.equal(byId.get('d')?.eligible, false);
});

test('node v19: status snapshot counts + attention sorted by reason count', () => {
  const nodes = [
    node('a'),
    node('b', { health: 'unhealthy', usedRamMb: 32000, lastHeartbeatAt: T0 - 40 * MIN, runningTaskIds: ['x'] }),
    node('c', { status: 'down', health: 'down', lastHeartbeatAt: T0 - 60 * MIN }),
    node('d', { status: 'removed' }),
  ];
  const pressures = new Map(nodes.map((n) => [n.nodeId, fleetV19NodePressure(n, 400000)]));
  const ranks = rankFleetV19Nodes(nodes, { a: 95, b: 40, c: 0, d: 90 }, pressures, T0);
  const snap = summarizeFleetV19Status(nodes, pressures, ranks, T0);
  assert.equal(snap.total, 4);
  assert.equal(snap.byStatus.active, 2);
  assert.equal(snap.byStatus.removed, 1);
  assert.equal(snap.byHealth.unhealthy, 1);
  assert.equal(snap.byStaleness.lost, 2);
  assert.equal(snap.eligibleCount, 1);
  assert.equal(snap.busyCount, 1);
  assert.equal(snap.attention[0].nodeId, 'b'); // most reasons first
  assert.ok(snap.attention.some((a) => a.nodeId === 'c'));
  assert.ok(!snap.attention.some((a) => a.nodeId === 'a'));
});

test('node v19: auto-drain when heartbeat lost with running tasks; stale-down listing', () => {
  const lost = node('n1', { lastHeartbeatAt: T0 - 60 * MIN, runningTaskIds: ['x'] });
  assert.equal(fleetV19ShouldAutoDrain(lost, T0), true);
  assert.equal(fleetV19ShouldAutoDrain(node('n2', { lastHeartbeatAt: T0 }), T0), false);
  assert.equal(fleetV19ShouldAutoDrain(node('n3', { lastHeartbeatAt: T0 - 60 * MIN }), T0), false);
  const down = node('n4', { status: 'down', lastHeartbeatAt: T0 - 25 * 60 * MIN });
  const recent = node('n5', { status: 'down', lastHeartbeatAt: T0 - 60 * MIN });
  assert.deepEqual(
    listFleetV19StaleDownNodes([down, recent, node('n6')], T0, 24 * 60 * MIN).map((n) => n.nodeId),
    ['n4'],
  );
});

// ---------------------------------------------------------------------------
// Plugin SDK v4
// ---------------------------------------------------------------------------

function manifest(id, over = {}) {
  return {
    id,
    name: `Plugin ${id}`,
    version: '1.2.0',
    sdkVersion: 4,
    description: 'Test plugin',
    author: 'tester',
    capabilities: [
      { name: 'tools', major: 1, minor: 2 },
      { name: 'fs.read', major: 2, minor: 1 },
    ],
    permissions: ['fs'],
    main: 'index.js',
    tools: [`${id}.run`],
    dependsOn: [],
    ...over,
  };
}

function registry() {
  return buildPluginV19CapabilityRegistry(defaultPluginV19Capabilities());
}

test('plugin v19: capability parse/format/compat', () => {
  assert.deepEqual(parsePluginV19Capability('fs.read@2.1'), { name: 'fs.read', major: 2, minor: 1 });
  assert.equal(parsePluginV19Capability('bogus'), null);
  assert.equal(parsePluginV19Capability('x@1'), null);
  assert.equal(formatPluginV19Capability({ name: 'tools', major: 1, minor: 2 }), 'tools@1.2');
  const reg = registry();
  const tools = reg.get('tools');
  assert.equal(checkPluginV19CapabilityCompat({ name: 'tools', major: 1, minor: 2 }, tools), '');
  assert.notEqual(checkPluginV19CapabilityCompat({ name: 'tools', major: 1, minor: 3 }, tools), '');
  assert.notEqual(checkPluginV19CapabilityCompat({ name: 'tools', major: 2, minor: 0 }, tools), '');
  assert.throws(
    () => buildPluginV19CapabilityRegistry([...defaultPluginV19Capabilities(), defaultPluginV19Capabilities()[0]]),
    /trùng tên/,
  );
});

test('plugin v19: manifest validate rejects bad id/version/sdk/main/dupes/self-dep', () => {
  assert.notEqual(validatePluginV19Manifest(manifest('bad id!')), '');
  assert.notEqual(validatePluginV19Manifest(manifest('ok', { version: '1.2' })), '');
  assert.notEqual(validatePluginV19Manifest(manifest('ok', { sdkVersion: PLUGIN_SDK_V19_MAX_SUPPORTED + 1 })), '');
  assert.notEqual(validatePluginV19Manifest(manifest('ok', { sdkVersion: 0 })), '');
  assert.notEqual(validatePluginV19Manifest(manifest('ok', { main: '../evil.js' })), '');
  assert.notEqual(validatePluginV19Manifest(manifest('ok', { main: '/abs.js' })), '');
  assert.notEqual(
    validatePluginV19Manifest(manifest('ok', {
      capabilities: [{ name: 'tools', major: 1, minor: 0 }, { name: 'tools', major: 1, minor: 1 }],
    })),
    '',
  );
  assert.notEqual(validatePluginV19Manifest(manifest('ok', { dependsOn: [{ id: 'ok', versionRange: '^1.0.0' }] })), '');
  assert.equal(validatePluginV19Manifest(manifest('ok')), '');
});

test('plugin v19: registry check — unknown capability, permission without capability', () => {
  const reg = registry();
  assert.deepEqual(checkPluginV19ManifestAgainstRegistry(manifest('ok'), reg), []);
  const unknown = checkPluginV19ManifestAgainstRegistry(
    manifest('ok', { capabilities: [{ name: 'nope', major: 1, minor: 0 }] }), reg);
  assert.ok(unknown.some((e) => e.includes('nope')));
  const uncovered = checkPluginV19ManifestAgainstRegistry(
    manifest('ok', { permissions: ['shell'] }), reg);
  assert.ok(uncovered.some((e) => e.includes('shell')));
  const wrongMajor = checkPluginV19ManifestAgainstRegistry(
    manifest('ok', { capabilities: [{ name: 'tools', major: 9, minor: 0 }] }), reg);
  assert.ok(wrongMajor.length > 0);
});

test('plugin v19: version ranges ^ ~ >= < exact, bad range false', () => {
  assert.deepEqual(parsePluginV19Version('1.2.3'), [1, 2, 3]);
  assert.equal(parsePluginV19Version('1.2'), null);
  assert.equal(pluginV19VersionSatisfies('1.2.3', '^1.0.0'), true);
  assert.equal(pluginV19VersionSatisfies('2.0.0', '^1.0.0'), false);
  assert.equal(pluginV19VersionSatisfies('1.2.9', '~1.2.3'), true);
  assert.equal(pluginV19VersionSatisfies('1.3.0', '~1.2.3'), false);
  assert.equal(pluginV19VersionSatisfies('1.5.0', '>=1.0.0 <2.0.0'), true);
  assert.equal(pluginV19VersionSatisfies('2.0.0', '>=1.0.0 <2.0.0'), false);
  assert.equal(pluginV19VersionSatisfies('1.2.3', '1.2.3'), true);
  assert.equal(pluginV19VersionSatisfies('1.2.4', '1.2.3'), false);
  assert.equal(pluginV19VersionSatisfies('1.2.3', '>=2.0.0'), false);
  assert.equal(pluginV19VersionSatisfies('1.2.3', 'nonsense'), false);
  assert.equal(pluginV19VersionSatisfies('bogus', '^1.0.0'), false);
});

test('plugin v19: lifecycle install/enable/disable/uninstall guards', () => {
  const reg = registry();
  const empty = new Map();
  const { store: s1 } = installPluginV19(empty, manifest('base'), reg, T0);
  assert.equal(s1.get('base')?.lifecycle, 'installed');
  assert.throws(() => installPluginV19(s1, manifest('base'), reg, T0), /đã cài/);
  assert.throws(() => installPluginV19(s1, manifest('bad id!'), reg, T0), /manifest không hợp lệ/);
  // Enable with missing dependency throws; install dep, enable dep, then enable child.
  const child = manifest('child', { dependsOn: [{ id: 'base', versionRange: '^1.0.0' }] });
  const { store: s2 } = installPluginV19(s1, child, reg, T0);
  assert.deepEqual(checkPluginV19Dependencies(s2, 'child'), []);
  assert.throws(() => enablePluginV19(s2, 'child', T0), /chưa enabled/);
  let s3 = enablePluginV19(s2, 'base', T0 + MIN);
  s3 = enablePluginV19(s3, 'child', T0 + 2 * MIN);
  assert.equal(s3.get('child')?.lifecycle, 'enabled');
  // Cannot disable base while child is enabled and depends on it.
  assert.throws(() => disablePluginV19(s3, 'base', T0), /phụ thuộc/);
  // Cannot uninstall an enabled plugin at all (enabled check fires first).
  assert.throws(() => uninstallPluginV19(s3, 'base', T0), /đang enabled/);
  assert.throws(() => uninstallPluginV19(s3, 'child', T0), /đang enabled/);
  let s4 = disablePluginV19(s3, 'child', T0 + 3 * MIN, 'user disabled');
  assert.equal(s4.get('child')?.lastReason, 'user disabled');
  s4 = disablePluginV19(s4, 'base', T0 + 3 * MIN);
  // Both disabled now, but child (still installed) depends on base -> blocked.
  assert.throws(() => uninstallPluginV19(s4, 'base', T0), /còn phụ thuộc/);
  s4 = uninstallPluginV19(s4, 'child', T0 + 4 * MIN);
  assert.equal(s4.get('child')?.lifecycle, 'uninstalled');
  s4 = uninstallPluginV19(s4, 'base', T0 + 5 * MIN);
  assert.equal(s4.get('base')?.lifecycle, 'uninstalled');
  // Version mismatch blocks enable.
  const picky = manifest('picky', { dependsOn: [{ id: 'base', versionRange: '^2.0.0' }] });
  const { store: s5 } = installPluginV19(s4, picky, reg, T0);
  assert.ok(checkPluginV19Dependencies(s5, 'picky').some((e) => e.includes('không thỏa')));
  assert.throws(() => enablePluginV19(s5, 'picky', T0), /không thỏa/);
  // Cycle blocks enable.
  const a = manifest('cyc-a', { dependsOn: [{ id: 'cyc-b', versionRange: '^1.0.0' }] });
  const b = manifest('cyc-b', { dependsOn: [{ id: 'cyc-a', versionRange: '^1.0.0' }] });
  let s6 = installPluginV19(new Map(), a, reg, T0).store;
  s6 = installPluginV19(s6, b, reg, T0).store;
  assert.ok(checkPluginV19Dependencies(s6, 'cyc-a').some((e) => e.includes('chu trình')));
});

test('plugin v19: load order is dependencies first; approve/revoke; sandbox limits', () => {
  const reg = registry();
  let store = new Map();
  store = installPluginV19(store, manifest('base'), reg, T0).store;
  store = installPluginV19(store, manifest('mid', { dependsOn: [{ id: 'base', versionRange: '^1.0.0' }] }), reg, T0).store;
  store = installPluginV19(store, manifest('top', { dependsOn: [{ id: 'mid', versionRange: '^1.0.0' }] }), reg, T0).store;
  assert.deepEqual(resolvePluginV19LoadOrder(store), []); // nothing enabled yet
  store = enablePluginV19(store, 'base', T0);
  store = enablePluginV19(store, 'mid', T0);
  store = enablePluginV19(store, 'top', T0);
  assert.deepEqual(resolvePluginV19LoadOrder(store), ['base', 'mid', 'top']);
  // Approve/revoke a declared permission.
  store = approvePluginV19Permission(store, 'base', 'fs', T0);
  assert.deepEqual(store.get('base')?.approvedPermissions, ['fs']);
  store = revokePluginV19Permission(store, 'base', 'fs', T0);
  assert.deepEqual(store.get('base')?.approvedPermissions, []);
  assert.throws(() => approvePluginV19Permission(store, 'base', 'shell', T0), /không khai/);
  // Sandbox limits stick.
  store = setPluginV19SandboxLimits(store, 'base', { allowedDirs: ['/data'], allowedHosts: [], allowedShellPrefixes: [] }, T0);
  assert.deepEqual(store.get('base')?.sandboxLimits.allowedDirs, ['/data']);
  const summary = summarizePluginV19Store(store);
  assert.equal(summary.total, 3);
  assert.equal(summary.byLifecycle.enabled, 3);
});

test('plugin v19: permission evaluation — enabled/capability/approval/limits', () => {
  const reg = registry();
  let store = new Map();
  const net = manifest('net', {
    capabilities: [
      { name: 'tools', major: 1, minor: 0 },
      { name: 'network.fetch', major: 1, minor: 3 },
      { name: 'shell.exec', major: 1, minor: 1 },
    ],
    permissions: ['network', 'shell'],
  });
  store = installPluginV19(store, net, reg, T0).store;
  const req = (capability, operation, target) => ({ pluginId: 'net', capability, operation, target });
  // Not enabled yet.
  assert.equal(evaluatePluginV19Permission(store, reg, req('network.fetch', 'fetch', 'example.com')).allowed, false);
  store = enablePluginV19(store, 'net', T0);
  // Network needs explicit approval.
  let d = evaluatePluginV19Permission(store, reg, req('network.fetch', 'fetch', 'example.com'));
  assert.equal(d.allowed, false);
  assert.match(d.reason, /duyệt/);
  store = approvePluginV19Permission(store, 'net', 'network', T0);
  assert.equal(evaluatePluginV19Permission(store, reg, req('network.fetch', 'fetch', 'example.com')).allowed, true);
  // Undeclared capability denied.
  assert.equal(evaluatePluginV19Permission(store, reg, req('fs.read', 'read', '/data/x')).allowed, false);
  // Shell: needs approval + prefix limits (none set -> deny even after approval).
  store = approvePluginV19Permission(store, 'net', 'shell', T0);
  d = evaluatePluginV19Permission(store, reg, req('shell.exec', 'exec', 'ls /tmp'));
  assert.equal(d.allowed, false);
  assert.match(d.reason, /prefix/);
  store = setPluginV19SandboxLimits(store, 'net', { allowedDirs: [], allowedHosts: ['example.com'], allowedShellPrefixes: ['ls'] }, T0);
  assert.equal(evaluatePluginV19Permission(store, reg, req('shell.exec', 'exec', 'ls /tmp')).allowed, true);
  assert.equal(evaluatePluginV19Permission(store, reg, req('shell.exec', 'exec', 'rm -rf /')).allowed, false);
  // Network host limit now applies.
  assert.equal(evaluatePluginV19Permission(store, reg, req('network.fetch', 'fetch', 'evil.com')).allowed, false);
  assert.equal(evaluatePluginV19Permission(store, reg, req('network.fetch', 'fetch', 'example.com')).allowed, true);
});

// ---------------------------------------------------------------------------
// Tools-side SDK v4 bridge
// ---------------------------------------------------------------------------

const V4_JSON = {
  id: 'notes-tools',
  name: 'Notes Tools',
  version: '1.2.0',
  sdkVersion: 4,
  description: 'Search notes',
  author: 'tester',
  capabilities: ['tools@1.2', 'fs.read@2.1'],
  permissions: ['fs'],
  main: 'index.js',
  tools: ['notes.search'],
  dependsOn: [],
};

test('sdkV4 tools: parse valid JSON, convert to v3, capability check, sandbox summary', () => {
  const { manifest: m, errors } = parsePluginSdkV4ManifestJson(V4_JSON);
  assert.deepEqual(errors, []);
  assert.equal(m?.id, 'notes-tools');
  assert.deepEqual(m?.capabilities, [
    { name: 'tools', major: 1, minor: 2 },
    { name: 'fs.read', major: 2, minor: 1 },
  ]);
  const v3 = pluginSdkV4ManifestToV3(m);
  assert.equal(v3.id, 'notes-tools');
  assert.deepEqual(v3.permissions, ['fs']);
  assert.deepEqual(v3.tools, ['notes.search']);
  assert.equal(v3.v4.sdkVersion, 4);
  assert.deepEqual(v3.v4.capabilities, ['tools@1.2', 'fs.read@2.1']);
  assert.deepEqual(
    checkPluginSdkV4Capabilities(m, defaultPluginV19Capabilities().map((c) => c.name)),
    [],
  );
  assert.ok(checkPluginSdkV4Capabilities(m, ['tools']).some((e) => e.includes('fs.read')));
  const summary = summarizePluginSdkV4Sandbox(m, []);
  assert.equal(summary.readyToRun, true); // fs needs no explicit approval
  assert.deepEqual(summary.needsApproval, []);
});

test('sdkV4 tools: parse rejects each invalid shape, collects errors', () => {
  assert.deepEqual(parsePluginSdkV4ManifestJson(null).errors.length > 0, true);
  assert.ok(parsePluginSdkV4ManifestJson({ ...V4_JSON, id: 'bad id!' }).errors.some((e) => e.includes('id')));
  assert.ok(parsePluginSdkV4ManifestJson({ ...V4_JSON, version: '1.0' }).errors.some((e) => e.includes('version')));
  assert.ok(parsePluginSdkV4ManifestJson({ ...V4_JSON, sdkVersion: 99 }).errors.some((e) => e.includes('sdkVersion')));
  assert.ok(parsePluginSdkV4ManifestJson({ ...V4_JSON, capabilities: ['tools'] }).errors.some((e) => e.includes('capability')));
  assert.ok(parsePluginSdkV4ManifestJson({ ...V4_JSON, permissions: ['root'] }).errors.some((e) => e.includes('permission')));
  assert.ok(parsePluginSdkV4ManifestJson({ ...V4_JSON, main: '../x.js' }).errors.some((e) => e.includes('main')));
  const shellJson = { ...V4_JSON, permissions: ['shell'], capabilities: ['tools@1.0', 'shell.exec@1.1'] };
  const { manifest: shellManifest } = parsePluginSdkV4ManifestJson(shellJson);
  const shellSummary = summarizePluginSdkV4Sandbox(shellManifest, []);
  assert.equal(shellSummary.readyToRun, false);
  assert.deepEqual(shellSummary.needsApproval, ['shell']);
  assert.equal(summarizePluginSdkV4Sandbox(shellManifest, ['shell']).readyToRun, true);
});
