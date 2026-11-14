/**
 * Tests for fleet nodes v1 (packages/core/src/fleet/nodes.ts).
 *
 * Covers node registration (validation, duplicates, public-host
 * rejection), heartbeat + liveness (alive/stale/dead/never-seen),
 * dead-node detection + pruning, and dispatch scoring
 * (loopback-first, dead nodes never picked, resource fit).
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/fleet-nodes-v104.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  detectDeadNodes,
  findFleetNode,
  isLoopbackHost,
  isPrivateOrLoopbackHost,
  listFleetNodeViews,
  loadFleetNodes,
  nodeLiveness,
  pickBestNode,
  pruneDeadNodes,
  recordNodeHeartbeat,
  registerFleetNode,
  removeFleetNode,
  scoreNodeForDispatch,
  validateRegisterNodeInput,
} from '../packages/core/dist/fleet/nodes.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-fleet-nodes-'));
}

const GB = 1024 ** 3;
const T0 = 1_790_000_000_000;

function nodeInput(overrides = {}) {
  return {
    hostname: 'may-phong-khach',
    host: '192.168.1.10',
    port: 18080,
    role: 'worker',
    cpuCores: 4,
    ramBytes: 8 * GB,
    diskBytes: 100 * GB,
    ...overrides,
  };
}

const LOAD_IDLE = { runningJobs: 0, queuedJobs: 0, cpuUsedFraction: 0.1, ramUsedBytes: 1 * GB };
const LOAD_BUSY = { runningJobs: 4, queuedJobs: 5, cpuUsedFraction: 0.9, ramUsedBytes: 7 * GB };

// --- host classification ---------------------------------------------------

test('fleet nodes: loopback / private-LAN host classification', () => {
  assert.equal(isLoopbackHost('127.0.0.1'), true);
  assert.equal(isLoopbackHost('localhost'), true);
  assert.equal(isLoopbackHost('::1'), true);
  assert.equal(isLoopbackHost('192.168.1.10'), false);
  assert.equal(isPrivateOrLoopbackHost('10.0.0.5'), true);
  assert.equal(isPrivateOrLoopbackHost('172.16.0.9'), true);
  assert.equal(isPrivateOrLoopbackHost('172.31.255.1'), true);
  assert.equal(isPrivateOrLoopbackHost('172.32.0.1'), false);
  assert.equal(isPrivateOrLoopbackHost('192.168.0.1'), true);
  assert.equal(isPrivateOrLoopbackHost('8.8.8.8'), false);
  assert.equal(isPrivateOrLoopbackHost('example.com'), false);
  assert.equal(isPrivateOrLoopbackHost('may-lan.local'), true);
  assert.equal(isPrivateOrLoopbackHost('may-lan'), true);
});

// --- registration ----------------------------------------------------------

test('fleet nodes: validateRegisterNodeInput rejects bad input', () => {
  assert.throws(() => validateRegisterNodeInput({}), /hostname/);
  assert.throws(() => validateRegisterNodeInput(nodeInput({ host: '' })), /host/);
  assert.throws(() => validateRegisterNodeInput(nodeInput({ host: '8.8.8.8' })), /not a loopback or private LAN/);
  assert.throws(() => validateRegisterNodeInput(nodeInput({ host: 'example.com' })), /not a loopback or private LAN/);
  assert.throws(() => validateRegisterNodeInput(nodeInput({ port: 80 })), /port/);
  assert.throws(() => validateRegisterNodeInput(nodeInput({ port: 70000 })), /port/);
  assert.throws(() => validateRegisterNodeInput(nodeInput({ role: 'superuser' })), /role/);
  assert.throws(() => validateRegisterNodeInput(nodeInput({ cpuCores: 0 })), /cpuCores/);
  assert.throws(() => validateRegisterNodeInput(nodeInput({ ramBytes: -1 })), /ramBytes/);
});

test('fleet nodes: register / duplicate / remove round-trip', () => {
  const dir = tmpDir();
  assert.deepEqual(loadFleetNodes(dir), []);
  const node = registerFleetNode(dir, nodeInput());
  assert.equal(node.id.startsWith('fn-'), true);
  assert.equal(node.loopback, false);
  assert.equal(node.lastHeartbeatAt, null);
  assert.equal(findFleetNode(dir, node.id)?.hostname, 'may-phong-khach');
  // Duplicate hostname / host+port / id all rejected.
  assert.throws(() => registerFleetNode(dir, nodeInput({ host: '192.168.1.11' })), /hostname/);
  assert.throws(() => registerFleetNode(dir, nodeInput({ hostname: 'may-khac' })), /already registered/);
  assert.throws(() => registerFleetNode(dir, nodeInput({ hostname: 'may-khac2', id: node.id })), /already registered/);
  // Loopback node is flagged loopback.
  const local = registerFleetNode(dir, nodeInput({ hostname: 'may-local', host: '127.0.0.1', port: 18081 }));
  assert.equal(local.loopback, true);
  assert.equal(loadFleetNodes(dir).length, 2);
  const removed = removeFleetNode(dir, node.id);
  assert.equal(removed.id, node.id);
  assert.equal(loadFleetNodes(dir).length, 1);
  assert.throws(() => removeFleetNode(dir, node.id), /not registered/);
});

test('fleet nodes: corrupt registry file throws instead of guessing', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'fleet-nodes.json'), '{not json', 'utf8');
  assert.throws(() => loadFleetNodes(dir), /not valid JSON/);
  fs.writeFileSync(path.join(dir, 'fleet-nodes.json'), '{"a":1}', 'utf8');
  assert.throws(() => loadFleetNodes(dir), /JSON array/);
});

// --- heartbeat + liveness ----------------------------------------------------

test('fleet nodes: heartbeat updates liveness alive/stale/dead/never-seen', () => {
  const dir = tmpDir();
  const node = registerFleetNode(dir, nodeInput());
  assert.equal(nodeLiveness(node, T0), 'never-seen');
  const after = recordNodeHeartbeat(dir, node.id, LOAD_IDLE, T0);
  assert.equal(after.lastHeartbeatAt, T0);
  assert.deepEqual(after.lastLoad, LOAD_IDLE);
  assert.equal(nodeLiveness(after, T0 + 1000), 'alive');
  assert.equal(nodeLiveness(after, T0 + 10_000), 'stale');
  assert.equal(nodeLiveness(after, T0 + 29_999), 'stale');
  assert.equal(nodeLiveness(after, T0 + 30_000), 'dead');
  assert.equal(nodeLiveness(after, T0 + 600_000), 'dead');
  // Heartbeat from unknown node is rejected (no auto-registration).
  assert.throws(() => recordNodeHeartbeat(dir, 'fn-nope', LOAD_IDLE, T0), /unknown fleet node/);
  // Bad load is rejected.
  assert.throws(() => recordNodeHeartbeat(dir, node.id, { runningJobs: -1, queuedJobs: 0, cpuUsedFraction: 0, ramUsedBytes: 0 }, T0), /runningJobs/);
  assert.throws(() => recordNodeHeartbeat(dir, node.id, { runningJobs: 0, queuedJobs: 0, cpuUsedFraction: 1.5, ramUsedBytes: 0 }, T0), /cpuUsedFraction/);
});

test('fleet nodes: detectDeadNodes + pruneDeadNodes', () => {
  const dir = tmpDir();
  // Use a real-now base so registeredAt (Date.now()) lines up with the
  // fake heartbeat times used below.
  const now = Date.now();
  const alive = registerFleetNode(dir, nodeInput({ hostname: 'alive', host: '192.168.1.10' }));
  const dead = registerFleetNode(dir, nodeInput({ hostname: 'dead', host: '192.168.1.11', port: 18081 }));
  const never = registerFleetNode(dir, nodeInput({ hostname: 'never', host: '192.168.1.12', port: 18082 }));
  recordNodeHeartbeat(dir, alive.id, LOAD_IDLE, now);
  recordNodeHeartbeat(dir, dead.id, LOAD_IDLE, now - 60_000);
  const nodes = loadFleetNodes(dir);
  const found = detectDeadNodes(nodes, now);
  assert.deepEqual(found.map((n) => n.hostname).sort(), ['dead']);
  // Never-seen node is dead only after TTL (10 min default) — and by
  // then the once-alive node is dead too (its heartbeat is 11 min old).
  assert.deepEqual(detectDeadNodes(nodes, now + 11 * 60_000).map((n) => n.hostname).sort(), ['alive', 'dead', 'never']);
  const pruned = pruneDeadNodes(dir, now);
  assert.deepEqual(pruned.map((n) => n.hostname), ['dead']);
  assert.deepEqual(loadFleetNodes(dir).map((n) => n.hostname).sort(), ['alive', 'never']);
  const views = listFleetNodeViews(dir, now);
  assert.equal(views[0].node.hostname, 'alive');
  assert.equal(views[0].liveness, 'alive');
  assert.equal(views[0].msSinceHeartbeat, 0);
});

// --- dispatch scoring -------------------------------------------------------

test('fleet nodes: scoreNodeForDispatch — dead/never-seen never score, loopback wins ties', () => {
  const request = { cpuCores: 1, ramBytes: 1 * GB, diskBytes: 10 * GB };
  const deadNode = {
    id: 'fn-dead', hostname: 'dead', host: '192.168.1.11', port: 18081, role: 'worker',
    cpuCores: 8, ramBytes: 16 * GB, diskBytes: 200 * GB, loopback: false,
    lastHeartbeatAt: T0 - 60_000, lastLoad: LOAD_IDLE, registeredAt: T0 - 3600_000, updatedAt: T0 - 60_000,
  };
  const neverNode = { ...deadNode, id: 'fn-never', hostname: 'never', lastHeartbeatAt: null, lastLoad: null };
  assert.equal(scoreNodeForDispatch(deadNode, request, T0).score, 0);
  assert.equal(scoreNodeForDispatch(deadNode, request, T0).fits, false);
  assert.equal(scoreNodeForDispatch(neverNode, request, T0).score, 0);
  const lan = {
    ...deadNode, id: 'fn-lan', hostname: 'lan', host: '192.168.1.10', port: 18080,
    lastHeartbeatAt: T0, lastLoad: LOAD_IDLE,
  };
  const local = { ...lan, id: 'fn-local', hostname: 'local', host: '127.0.0.1', loopback: true };
  const busy = { ...lan, id: 'fn-busy', hostname: 'busy', host: '192.168.1.12', lastLoad: LOAD_BUSY };
  const lanScore = scoreNodeForDispatch(lan, request, T0);
  const localScore = scoreNodeForDispatch(local, request, T0);
  const busyScore = scoreNodeForDispatch(busy, request, T0);
  assert.equal(lanScore.fits, true);
  assert.ok(localScore.score > lanScore.score, 'loopback node should outscore an identical LAN node');
  assert.ok(busyScore.score < lanScore.score, 'busy node should score lower than an idle node');
  // Too big a request fits nowhere.
  const huge = { cpuCores: 99, ramBytes: 1 * GB, diskBytes: 10 * GB };
  assert.equal(scoreNodeForDispatch(lan, huge, T0).fits, false);
  // pickBestNode prefers alive loopback over stale LAN.
  const staleLan = { ...lan, id: 'fn-stale', hostname: 'stale', host: '192.168.1.13', lastHeartbeatAt: T0 - 15_000 };
  const best = pickBestNode([staleLan, local, deadNode], request, T0);
  assert.equal(best?.node.id, 'fn-local');
  assert.equal(pickBestNode([deadNode, neverNode], request, T0), null);
});
