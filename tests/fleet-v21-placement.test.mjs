/**
 * Tests for fleet v21 multi-node placement (v1.34, Đội T6).
 *
 * Covers:
 * - Bin-packing: many runs spread across many nodes; a run that does
 *   not fit one node lands on another; demand is subtracted within the
 *   batch (no double-booking the same free capacity).
 * - Anti-affinity: runs of the same bot land on different nodes when
 *   required; with a single node the second run waits with a clear
 *   anti-affinity reason (never silently co-located).
 * - Affinity: runs sharing an affinityKey prefer the same node.
 * - Priority + heavy-first: heavy/high-priority runs are placed before
 *   light ones, so a heavy run is not starved by light-run fragments.
 * - Rebalance: evacuate off a dead node, stranded when no node fits
 *   the tier or the run is not movable, balance moves load off the
 *   hottest node (at most a few moves, never a fleet shuffle).
 * - Placement log: append-only audit history (place/move/evacuate),
 *   per-run / per-node queries, capped size.
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/fleet-v21-placement.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createFleetV21Node } from '../packages/core/dist/fleetV21/nodes.js';
import {
  FleetV21PlacementLog,
  REBALANCE_IMBALANCE_THRESHOLD,
  placeFleetV21Runs,
  placementWeightV21,
  planFleetV21Rebalance,
} from '../packages/core/dist/fleetV21/placement.js';

const GB = 1024 ** 3;
const NOW = 1780000000000;

function makeNode(id, overrides = {}) {
  return createFleetV21Node({
    id,
    name: id,
    maxTier: 'bwrap',
    cpuCores: 4,
    ramBytes: 16 * GB,
    diskBytes: 100 * GB,
    latencyMs: 10,
    now: NOW,
    ...overrides,
  });
}

function makeReq(runId, botId, overrides = {}) {
  return {
    runId,
    botId,
    minTier: 'bwrap',
    demand: { cpuCores: 1, ramBytes: 1 * GB, diskBytes: 1 * GB },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Bin-packing across nodes
// ---------------------------------------------------------------------------

test('placement: spreads runs across nodes and never double-books capacity', () => {
  const nodes = [makeNode('n1'), makeNode('n2')];
  // Each node fits 4 cores; 6 x 1-core runs must spread (no node gets 6).
  const requests = Array.from({ length: 6 }, (_, i) => makeReq(`run-${i}`, `bot-${i}`));
  const plan = placeFleetV21Runs(nodes, requests);
  assert.equal(plan.placedCount, 6);
  assert.equal(plan.totalCount, 6);
  assert.deepEqual(plan.unplacedRunIds, []);
  const perNode = new Map();
  for (const r of plan.results) perNode.set(r.nodeId, (perNode.get(r.nodeId) ?? 0) + 1);
  assert.equal(perNode.get('n1'), 3);
  assert.equal(perNode.get('n2'), 3);
  assert.match(plan.summary, /6\/6/);
});

test('placement: a run too big for one node lands on a bigger node', () => {
  const nodes = [makeNode('small', { cpuCores: 1 }), makeNode('big', { cpuCores: 8 })];
  const plan = placeFleetV21Runs(nodes, [makeReq('run-big', 'bot-1', { demand: { cpuCores: 4, ramBytes: 1 * GB, diskBytes: 1 * GB } })]);
  assert.equal(plan.placedCount, 1);
  assert.equal(plan.results[0].nodeId, 'big');
});

test('placement: unplaced runs are reported, not fatal, and do not block later runs', () => {
  const nodes = [makeNode('n1', { cpuCores: 1 })];
  const requests = [
    makeReq('run-huge', 'bot-1', { demand: { cpuCores: 99, ramBytes: 1 * GB, diskBytes: 1 * GB } }),
    makeReq('run-small', 'bot-2'),
  ];
  const plan = placeFleetV21Runs(nodes, requests);
  assert.equal(plan.placedCount, 1);
  assert.deepEqual(plan.unplacedRunIds, ['run-huge']);
  assert.equal(plan.results.find((r) => r.runId === 'run-small')?.placed, true);
  assert.match(plan.results.find((r) => r.runId === 'run-huge')?.reason ?? '', /Không node/);
});

test('placement: heavy runs are placed before light ones (no starvation)', () => {
  // Node fits 4 cores total. Light runs arrive first in the array, but the
  // heavy 4-core run must still get placed (it is scheduled first).
  const nodes = [makeNode('n1', { cpuCores: 4 })];
  const requests = [
    makeReq('light-1', 'bot-1'),
    makeReq('light-2', 'bot-2'),
    makeReq('heavy', 'bot-3', { demand: { cpuCores: 4, ramBytes: 1 * GB, diskBytes: 1 * GB } }),
  ];
  const plan = placeFleetV21Runs(nodes, requests);
  assert.equal(plan.results.find((r) => r.runId === 'heavy')?.placed, true);
  assert.equal(plan.placedCount, 1);
});

test('placement: priority beats weight when both are set', () => {
  const nodes = [makeNode('n1', { cpuCores: 1 })];
  const requests = [
    makeReq('light-prio', 'bot-1', { priority: 10 }),
    makeReq('heavy-noprio', 'bot-2', { demand: { cpuCores: 1, ramBytes: 8 * GB, diskBytes: 1 * GB } }),
  ];
  const plan = placeFleetV21Runs(nodes, requests);
  assert.equal(plan.results.find((r) => r.runId === 'light-prio')?.placed, true);
  assert.equal(plan.results.find((r) => r.runId === 'heavy-noprio')?.placed, false);
});

test('placement: tier is respected across the whole batch', () => {
  const nodes = [makeNode('vm', { maxTier: 'microvm' }), makeNode('plain', { maxTier: 'bwrap' })];
  const requests = [
    makeReq('run-vm', 'bot-1', { minTier: 'microvm' }),
    makeReq('run-plain', 'bot-2', { minTier: 'bwrap' }),
  ];
  const plan = placeFleetV21Runs(nodes, requests);
  assert.equal(plan.results.find((r) => r.runId === 'run-vm')?.nodeId, 'vm');
  // The bwrap run prefers the just-sufficient node (tier-fit), not the VM.
  assert.equal(plan.results.find((r) => r.runId === 'run-plain')?.nodeId, 'plain');
});

test('placement: empty request list is a no-op with a clear summary', () => {
  const plan = placeFleetV21Runs([makeNode('n1')], []);
  assert.equal(plan.placedCount, 0);
  assert.equal(plan.totalCount, 0);
  assert.match(plan.summary, /Không có run/);
});

// ---------------------------------------------------------------------------
// Affinity / anti-affinity
// ---------------------------------------------------------------------------

test('placement: anti-affinity keeps same-bot runs on different nodes', () => {
  const nodes = [makeNode('n1'), makeNode('n2')];
  const requests = [
    makeReq('run-1', 'bot-x', { antiAffinityBot: true }),
    makeReq('run-2', 'bot-x', { antiAffinityBot: true }),
  ];
  const plan = placeFleetV21Runs(nodes, requests);
  assert.equal(plan.placedCount, 2);
  assert.notEqual(plan.results[0].nodeId, plan.results[1].nodeId);
});

test('placement: anti-affinity waits instead of co-locating on the only node', () => {
  const nodes = [makeNode('only')];
  const requests = [
    makeReq('run-1', 'bot-x', { antiAffinityBot: true }),
    makeReq('run-2', 'bot-x', { antiAffinityBot: true }),
  ];
  const plan = placeFleetV21Runs(nodes, requests);
  assert.equal(plan.placedCount, 1);
  assert.deepEqual(plan.unplacedRunIds, ['run-2']);
  assert.match(plan.results.find((r) => r.runId === 'run-2')?.reason ?? '', /Anti-affinity/);
  assert.deepEqual(plan.results.find((r) => r.runId === 'run-2')?.antiAffinityBlockedNodeIds, ['only']);
});

test('placement: without anti-affinity, same-bot runs may share a node', () => {
  const nodes = [makeNode('only')];
  const requests = [makeReq('run-1', 'bot-x'), makeReq('run-2', 'bot-x')];
  const plan = placeFleetV21Runs(nodes, requests);
  assert.equal(plan.placedCount, 2);
  assert.equal(plan.results[0].nodeId, plan.results[1].nodeId);
});

test('placement: affinity pulls same-key runs onto the same node', () => {
  const nodes = [makeNode('node-a'), makeNode('node-b')];
  const requests = [
    makeReq('run-1', 'bot-1', { affinityKey: 'shared-cache' }),
    makeReq('run-2', 'bot-2', { affinityKey: 'shared-cache' }),
  ];
  const plan = placeFleetV21Runs(nodes, requests);
  assert.equal(plan.placedCount, 2);
  assert.equal(plan.results[0].nodeId, plan.results[1].nodeId);
});

test('placement: placementWeightV21 ranks RAM-heavy above CPU-light', () => {
  const light = { cpuCores: 1, ramBytes: 1 * GB, diskBytes: 1 * GB };
  const heavy = { cpuCores: 1, ramBytes: 16 * GB, diskBytes: 1 * GB };
  assert.ok(placementWeightV21(heavy) > placementWeightV21(light));
});

// ---------------------------------------------------------------------------
// Rebalance
// ---------------------------------------------------------------------------

function runningRun(runId, botId, nodeId, overrides = {}) {
  return {
    runId,
    botId,
    nodeId,
    minTier: 'bwrap',
    demand: { cpuCores: 1, ramBytes: 1 * GB, diskBytes: 1 * GB },
    startedAt: NOW - 60000,
    movable: true,
    ...overrides,
  };
}

test('rebalance: evacuates runs off a dead node', () => {
  const nodes = [
    { ...makeNode('dead', { maxTier: 'microvm' }), status: 'dead', statusReason: 'mất heartbeat 400s' },
    makeNode('alive'),
  ];
  const runs = [runningRun('run-1', 'bot-1', 'dead')];
  const log = new FleetV21PlacementLog();
  const plan = planFleetV21Rebalance(nodes, runs, log);
  assert.equal(plan.moves.length, 1);
  assert.equal(plan.moves[0].runId, 'run-1');
  assert.equal(plan.moves[0].fromNodeId, 'dead');
  assert.equal(plan.moves[0].toNodeId, 'alive');
  assert.equal(plan.moves[0].reason, 'evacuate');
  assert.deepEqual(plan.stranded, []);
  assert.equal(log.forRun('run-1')[0].kind, 'evacuate');
});

test('rebalance: evacuates runs off a draining node too', () => {
  const nodes = [{ ...makeNode('drain'), status: 'draining' }, makeNode('alive')];
  const runs = [runningRun('run-1', 'bot-1', 'drain')];
  const plan = planFleetV21Rebalance(nodes, runs);
  assert.equal(plan.moves.length, 1);
  assert.equal(plan.moves[0].toNodeId, 'alive');
});

test('rebalance: stranded when no node fits the tier', () => {
  const nodes = [
    { ...makeNode('dead', { maxTier: 'microvm' }), status: 'dead' },
    makeNode('alive', { maxTier: 'bwrap' }),
  ];
  const runs = [runningRun('run-vm', 'bot-1', 'dead', { minTier: 'microvm' })];
  const plan = planFleetV21Rebalance(nodes, runs);
  assert.equal(plan.moves.length, 0);
  assert.equal(plan.stranded.length, 1);
  assert.match(plan.stranded[0].reason, /microvm/);
});

test('rebalance: non-movable (sticky) runs stay stranded, never force-moved', () => {
  const nodes = [{ ...makeNode('dead'), status: 'dead' }, makeNode('alive')];
  const runs = [runningRun('run-1', 'bot-1', 'dead', { movable: false })];
  const plan = planFleetV21Rebalance(nodes, runs);
  assert.equal(plan.moves.length, 0);
  assert.equal(plan.stranded.length, 1);
  assert.match(plan.stranded[0].reason, /sticky/);
});

test('rebalance: balances load off the hottest node', () => {
  assert.ok(REBALANCE_IMBALANCE_THRESHOLD > 0 && REBALANCE_IMBALANCE_THRESHOLD < 1);
  const nodes = [
    makeNode('hot', { cpuCores: 8, cpuUsed: 7.5, ramBytes: 32 * GB, ramUsed: 4 * GB }),
    makeNode('cold', { cpuCores: 8, cpuUsed: 0.5, ramBytes: 32 * GB, ramUsed: 4 * GB }),
  ];
  const runs = [runningRun('run-1', 'bot-1', 'hot', { demand: { cpuCores: 2, ramBytes: 1 * GB, diskBytes: 1 * GB } })];
  const plan = planFleetV21Rebalance(nodes, runs);
  const balance = plan.moves.filter((m) => m.reason === 'balance');
  assert.equal(balance.length, 1);
  assert.equal(balance[0].runId, 'run-1');
  assert.equal(balance[0].fromNodeId, 'hot');
  assert.equal(balance[0].toNodeId, 'cold');
});

test('rebalance: balanced fleet needs no moves', () => {
  const nodes = [makeNode('n1', { cpuUsed: 2 }), makeNode('n2', { cpuUsed: 2 })];
  const runs = [runningRun('run-1', 'bot-1', 'n1'), runningRun('run-2', 'bot-2', 'n2')];
  const plan = planFleetV21Rebalance(nodes, runs);
  assert.deepEqual(plan.moves, []);
  assert.deepEqual(plan.stranded, []);
  assert.match(plan.summary, /cân bằng/);
});

// ---------------------------------------------------------------------------
// Placement log
// ---------------------------------------------------------------------------

test('placement log: records placements and answers per-run/per-node queries', () => {
  const log = new FleetV21PlacementLog();
  const nodes = [makeNode('n1'), makeNode('n2')];
  const plan = placeFleetV21Runs(nodes, [makeReq('run-1', 'bot-1'), makeReq('run-2', 'bot-2')], log);
  assert.equal(plan.placedCount, 2);
  assert.equal(log.size, 2);
  assert.equal(log.forRun('run-1').length, 1);
  assert.equal(log.forRun('run-1')[0].kind, 'place');
  assert.equal(log.forRun('run-1')[0].minTier, 'bwrap');
  assert.ok(log.forRun('run-1')[0].score !== undefined);
  assert.equal(log.forNode(plan.results[0].nodeId).length, 1);
  assert.equal(log.recent(1)[0].runId, 'run-2');
  assert.deepEqual(log.list().map((r) => r.runId), ['run-1', 'run-2']);
});

test('placement log: caps history at maxRecords, oldest drops first', () => {
  const log = new FleetV21PlacementLog(3);
  for (let i = 0; i < 4; i += 1) {
    log.record({ runId: `run-${i}`, botId: 'bot-1', nodeId: 'n1', kind: 'place', reason: 'test', minTier: 'bwrap' });
  }
  assert.equal(log.size, 3);
  assert.deepEqual(log.list().map((r) => r.runId), ['run-1', 'run-2', 'run-3']);
});
