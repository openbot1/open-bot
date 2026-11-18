/**
 * Fleet sub-agent visualizer + tools v17 tests (v1.20, Đội T6 — node:test, no network).
 *
 * Covers visualizer:
 * - Map: one column per live node (removed nodes excluded), one
 *   card per live task (done/failed/cancelled excluded), layout
 *   x/y deterministic per node index and card order.
 * - Parent tree: depth computed from parent links, edges parent ->
 *   child, orphan flagged when the parent is gone (edge still
 *   listed, marked orphan).
 * - Overload/at-risk flags: node with CPU >= 80% flagged
 *   overloaded with a reason; node with unhealthy health flagged
 *   atRisk; summary counts, hottest node, longest-running agent,
 *   top owners, max depth.
 * - Validate: agent pointing at an unknown node, edge pointing at
 *   an unknown agent, node listing an unknown agent all fail.
 * - Summary text: one line with totals and flags.
 *
 * Covers tools v17:
 * - 27 tool defs, all names use a v17 prefix, no duplicates, every
 *   def has description + requiresAction; find by name works;
 *   validate rejects a bad prefix and a duplicate.
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/fleet-v120-visualizer-tools.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  allocateFleetV14Task,
  createFleetV14Snapshot,
  heartbeatFleetV14Node,
  registerFleetV14Node,
  releaseFleetV14Task,
} from '../packages/core/dist/fleetV14/index.js';

import {
  FLEET_V17_TOOLS,
  FLEET_V17_TOOL_COUNT,
  FLEET_V17_VIS_NODE_COLUMN_WIDTH,
  buildFleetV17SubAgentMap,
  checkFleetV17Health,
  findFleetV17Tool,
  fleetV17SubAgentMapSummaryText,
  summarizeFleetV17Capacity,
  validateFleetV17SubAgentMap,
  validateFleetV17Tools,
} from '../packages/core/dist/fleetV17/index.js';

const T0 = Date.UTC(2026, 11, 16, 0, 0, 0);

function cap(over = {}) {
  return { cpuCores: 8, ramTotalMb: 32768, vramTotalMb: 0, diskTotalMb: 500_000, maxTasks: 4, ...over };
}

function addNode(snap, id, over = {}) {
  const res = registerFleetV14Node(
    snap,
    { nodeId: id, hostname: `${id}.local`, fingerprint: `fp-${id}`, labels: {}, capacity: cap(over) },
    'u_owner',
    T0,
  );
  assert.equal(res.ok, true, res.reason);
  return heartbeatFleetV14Node(res.snapshot, id, T0);
}

function makeTask(id, over = {}) {
  return {
    taskId: id, kind: 'run-bot', cpuCores: 1, ramMb: 1000, vramMb: 0,
    priority: 1, requiredLabels: {}, allowedNodeIds: [], createdBy: 'u_owner', createdAt: T0, ...over,
  };
}

function buildMap(snap, parentLinks = [], now = T0 + 1000) {
  const capacity = summarizeFleetV17Capacity(snap);
  const health = checkFleetV17Health(snap, [], now);
  return buildFleetV17SubAgentMap(snap, health, capacity, parentLinks, now);
}

test('visualizer: nodes, agents, layout positions', () => {
  let snap = createFleetV14Snapshot(T0);
  snap = addNode(snap, 'n1');
  snap = addNode(snap, 'n2');
  const a1 = allocateFleetV14Task(snap, makeTask('t1'), T0);
  assert.equal(a1.ok, true, a1.reason);
  snap = a1.snapshot;
  const a2 = allocateFleetV14Task(snap, makeTask('t2', { createdBy: 'u_alice' }), T0);
  assert.equal(a2.ok, true, a2.reason);
  snap = a2.snapshot;
  const map = buildMap(snap);
  assert.equal(map.nodes.length, 2);
  assert.equal(map.nodes[0].nodeId, 'n1');
  assert.equal(map.nodes[0].x, 0);
  assert.equal(map.nodes[1].x, FLEET_V17_VIS_NODE_COLUMN_WIDTH);
  assert.equal(map.agents.length, 2);
  // Tie broken by nodeId: t1 -> n1, t2 -> n2 (least-loaded wins).
  const t1 = map.agents.find((a) => a.agentId === 't1');
  const t2 = map.agents.find((a) => a.agentId === 't2');
  assert.equal(t1.nodeId, 'n1');
  assert.equal(t2.nodeId, 'n2');
  assert.equal(t1.depth, 0);
  assert.equal(t1.parentAgentId, '');
  assert.equal(t1.orphan, false);
  assert.equal(t2.owner, 'u_alice');
  assert.equal(map.nodes[0].agentIds.length, 1);
  assert.equal(map.summary.totalAgents, 2);
  assert.equal(map.summary.runningAgents, 2);
  assert.equal(map.summary.maxDepth, 0);
  assert.equal(validateFleetV17SubAgentMap(map), '');
});

test('visualizer: parent tree, depth, orphan', () => {
  let snap = createFleetV14Snapshot(T0);
  snap = addNode(snap, 'n1');
  snap = addNode(snap, 'n2');
  for (const id of ['root', 'child', 'grandchild']) {
    const a = allocateFleetV14Task(snap, makeTask(id), T0);
    assert.equal(a.ok, true, a.reason);
    snap = a.snapshot;
  }
  const map = buildMap(snap, [
    { taskId: 'child', parentTaskId: 'root' },
    { taskId: 'grandchild', parentTaskId: 'child' },
  ]);
  const grandchild = map.agents.find((a) => a.agentId === 'grandchild');
  assert.equal(grandchild.depth, 2);
  assert.equal(grandchild.parentAgentId, 'child');
  assert.equal(map.summary.maxDepth, 2);
  assert.equal(map.edges.length, 2);
  assert.ok(map.edges.some((e) => e.fromAgentId === 'root' && e.toAgentId === 'child'));
  // Orphan: parent task 'ghost' is not in the snapshot.
  const orphanMap = buildMap(snap, [{ taskId: 'child', parentTaskId: 'ghost' }]);
  const orphan = orphanMap.agents.find((a) => a.agentId === 'child');
  assert.equal(orphan.orphan, true);
  assert.equal(orphan.depth, 0);
  assert.equal(orphanMap.summary.orphanAgents, 1);
  assert.equal(orphanMap.edges[0].orphan, true);
});

test('visualizer: overload and at-risk flags, summary, done tasks excluded', () => {
  let snap = createFleetV14Snapshot(T0);
  snap = addNode(snap, 'n1');
  snap = addNode(snap, 'n2');
  // Load n1 with 7 of 8 cores -> 87.5% CPU.
  const a = allocateFleetV14Task(snap, makeTask('heavy', { cpuCores: 7, ramMb: 1000 }), T0);
  assert.equal(a.ok, true, a.reason);
  snap = a.snapshot;
  const b = allocateFleetV14Task(snap, makeTask('light'), T0);
  assert.equal(b.ok, true, b.reason);
  snap = b.snapshot;
  // Mark light as done -> it leaves the map.
  snap = releaseFleetV14Task(snap, 'light', 'done', T0);
  const map = buildMap(snap);
  assert.equal(map.agents.length, 1);
  assert.equal(map.agents[0].agentId, 'heavy');
  const n1 = map.nodes.find((n) => n.nodeId === 'n1');
  assert.equal(n1.overloaded, true);
  assert.ok(n1.overloadReasons.some((r) => r.includes('CPU')));
  assert.equal(n1.cpuFraction, 0.875);
  assert.equal(map.summary.overloadedNodeCount, 1);
  assert.equal(map.summary.hottestNode.nodeId, 'n1');
  assert.equal(map.summary.longestRunning.agentId, 'heavy');
  assert.equal(map.summary.topOwners[0].owner, 'u_owner');
  assert.equal(map.summary.topOwners[0].count, 1);
  assert.match(fleetV17SubAgentMapSummaryText(map), /1 sub-agent trên 2 node/);
  assert.match(fleetV17SubAgentMapSummaryText(map), /quá tải/);
});

test('visualizer: at-risk node from stale heartbeat', () => {
  let snap = createFleetV14Snapshot(T0);
  snap = addNode(snap, 'n1');
  const map = buildMap(snap, [], T0 + 3 * 60 * 60 * 1000);
  assert.equal(map.nodes[0].atRisk, true);
  assert.equal(map.nodes[0].health, 'down');
  assert.equal(map.summary.atRiskNodeCount, 1);
});

test('visualizer: validate catches broken references', () => {
  let snap = createFleetV14Snapshot(T0);
  snap = addNode(snap, 'n1');
  const a = allocateFleetV14Task(snap, makeTask('t1'), T0);
  snap = a.snapshot;
  const map = buildMap(snap);
  const badAgent = { ...map, agents: [{ ...map.agents[0], nodeId: 'ghost' }] };
  assert.match(validateFleetV17SubAgentMap(badAgent), /ghost/);
  const badEdge = { ...map, edges: [{ fromAgentId: 't1', toAgentId: 'ghost', orphan: false }] };
  assert.match(validateFleetV17SubAgentMap(badEdge), /ghost/);
  const badNode = { ...map, nodes: [{ ...map.nodes[0], agentIds: ['ghost'] }] };
  assert.match(validateFleetV17SubAgentMap(badNode), /ghost/);
  assert.equal(validateFleetV17SubAgentMap(map), '');
});

test('toolsV17: 27 defs, valid prefixes, find, validate', () => {
  assert.equal(FLEET_V17_TOOL_COUNT, 27);
  assert.equal(FLEET_V17_TOOLS.length, 27);
  assert.equal(validateFleetV17Tools(FLEET_V17_TOOLS), '');
  const names = FLEET_V17_TOOLS.map((t) => t.name);
  assert.equal(new Set(names).size, 27);
  for (const prefix of ['fleetV17.', 'tenantV17.', 'gatewayV17.', 'auditV17.', 'adminV17.', 'fleetVizV17.']) {
    assert.ok(names.some((n) => n.startsWith(prefix)), `missing prefix ${prefix}`);
  }
  const writes = FLEET_V17_TOOLS.filter((t) => t.write);
  assert.ok(writes.length > 0);
  assert.ok(writes.every((t) => t.description.length > 0 && t.requiresAction.length > 0));
  assert.equal(findFleetV17Tool('fleetV17.planDrain').params.includes('nodeId'), true);
  assert.equal(findFleetV17Tool('nope'), null);
  assert.notEqual(validateFleetV17Tools([{ name: 'other.tool', description: 'x', write: false, requiresAction: 'view', params: [] }]), '');
  assert.notEqual(
    validateFleetV17Tools([FLEET_V17_TOOLS[0], FLEET_V17_TOOLS[0]]),
    '',
  );
});
