/**
 * Tests for fleet v23 topology (v1.36, Đội T6).
 *
 * Covers:
 * - Zones/groups: create, validate (spread > bots, quorum > bots,
 *   pair outside group, self-pair), add to topology (duplicate id,
 *   node to missing zone).
 * - Placement check: unplaced bot, affinity broken, anti-affinity
 *   broken, spread short, unknown zone.
 * - Zone failure: lost bots/nodes, groups losing quorum, worst zone.
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/fleet-v23-topology.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  checkFleetV23GroupPlacement,
  checkFleetV23TopologyPlacement,
  createFleetV23BotGroup,
  createFleetV23Topology,
  createFleetV23Zone,
  placementSatisfiesTopologyV23,
  summarizeFleetV23Topology,
  topologyAddGroup,
  topologyAddZone,
  topologyAssignNode,
  topologyGroupOfBot,
  topologyNodesInZone,
  topologyZoneOfNode,
  validateFleetV23BotGroup,
  validateFleetV23Zone,
  worstZoneFailureV23,
  zoneFailureImpactV23,
} from '../packages/core/dist/fleetV23/topology.js';

function makeTopology() {
  let topo = createFleetV23Topology();
  topo = topologyAddZone(topo, createFleetV23Zone({ id: 'zone-a', region: 'hcm', name: 'Zone A' }));
  topo = topologyAddZone(topo, createFleetV23Zone({ id: 'zone-b', region: 'hcm', name: 'Zone B' }));
  topo = topologyAddZone(topo, createFleetV23Zone({ id: 'zone-c', region: 'sin', name: 'Zone C' }));
  topo = topologyAssignNode(topo, 'node-1', 'zone-a');
  topo = topologyAssignNode(topo, 'node-2', 'zone-b');
  topo = topologyAssignNode(topo, 'node-3', 'zone-c');
  topo = topologyAssignNode(topo, 'node-4', 'zone-a');
  return topo;
}

test('topology: zone/group create + validate', () => {
  const zone = createFleetV23Zone({ id: 'z1', region: 'hcm' });
  assert.equal(zone.name, 'z1');
  assert.deepEqual(validateFleetV23Zone(zone), []);
  assert.deepEqual(validateFleetV23Zone({ id: '', region: '' }), [
    'zone.id phải là chuỗi không rỗng.',
    'zone.region phải là chuỗi không rỗng.',
  ]);
  assert.deepEqual(validateFleetV23Zone(null), ['zone phải là object.']);

  const group = createFleetV23BotGroup({ id: 'g1', botIds: ['b1', 'b2', 'b3'] });
  assert.equal(group.quorum, 2); // đa số của 3
  assert.equal(group.spreadMinZones, 1);
  assert.deepEqual(validateFleetV23BotGroup(group), []);

  // spread > số bot → lỗi
  assert.ok(
    validateFleetV23BotGroup({ id: 'g', botIds: ['b1'], spreadMinZones: 2, quorum: 1 }).some((e) =>
      e.includes('spreadMinZones'),
    ),
  );
  // quorum > số bot → lỗi
  assert.ok(
    validateFleetV23BotGroup({ id: 'g', botIds: ['b1'], spreadMinZones: 1, quorum: 2 }).some((e) =>
      e.includes('quorum'),
    ),
  );
  // cặp có bot ngoài group → lỗi
  assert.ok(
    validateFleetV23BotGroup({ id: 'g', botIds: ['b1'], spreadMinZones: 1, quorum: 1, affinityPairs: [['b1', 'bX']] }).some(
      (e) => e.includes('không thuộc group'),
    ),
  );
  // cặp tự trỏ chính mình → lỗi
  assert.ok(
    validateFleetV23BotGroup({ id: 'g', botIds: ['b1'], spreadMinZones: 1, quorum: 1, antiAffinityPairs: [['b1', 'b1']] }).some(
      (e) => e.includes('tự trỏ'),
    ),
  );
  // botIds rỗng → lỗi
  assert.ok(validateFleetV23BotGroup({ id: 'g', botIds: [] }).some((e) => e.includes('không rỗng')));
});

test('topology: add zone/group/node — duplicate + missing zone throw', () => {
  let topo = createFleetV23Topology();
  topo = topologyAddZone(topo, createFleetV23Zone({ id: 'z1', region: 'r1' }));
  assert.throws(() => topologyAddZone(topo, createFleetV23Zone({ id: 'z1', region: 'r1' })), /đã có trong topology/);
  assert.throws(() => topologyAssignNode(topo, 'n1', 'no-such-zone'), /chưa có trong topology/);
  topo = topologyAssignNode(topo, 'n1', 'z1');
  assert.equal(topologyZoneOfNode(topo, 'n1'), 'z1');
  assert.equal(topologyZoneOfNode(topo, 'n2'), undefined);
  assert.deepEqual(topologyNodesInZone(topo, 'z1'), ['n1']);

  const group = createFleetV23BotGroup({ id: 'g1', botIds: ['b1', 'b2'] });
  topo = topologyAddGroup(topo, group);
  assert.throws(() => topologyAddGroup(topo, group), /đã có trong topology/);
  assert.equal(topologyGroupOfBot(topo, 'b1')?.id, 'g1');
  assert.equal(topologyGroupOfBot(topo, 'bX'), undefined);
  // group lỗi validate → throw khi add
  assert.throws(
    () => topologyAddGroup(topo, createFleetV23BotGroup({ id: 'g2', botIds: ['b1'], spreadMinZones: 5 })),
    /không hợp lệ/,
  );

  const summary = summarizeFleetV23Topology(topo);
  assert.equal(summary.zones, 1);
  assert.equal(summary.nodes, 1);
  assert.equal(summary.groups, 1);
  assert.equal(summary.bots, 2);
  assert.deepEqual(summary.regionNames, ['r1']);
});

test('topology: placement check — spread/affinity/anti-affinity/unplaced/unknown-zone', () => {
  let topo = makeTopology();
  const group = createFleetV23BotGroup({
    id: 'writers',
    botIds: ['w1', 'w2', 'w3'],
    spreadMinZones: 2,
    affinityPairs: [['w1', 'w2']],
    antiAffinityPairs: [['w1', 'w3']],
    quorum: 2,
  });
  topo = topologyAddGroup(topo, group);

  // Placement tốt: w1+w2 chung node-1 (zone-a), w3 node-2 (zone-b) → spread 2 zone.
  const good = { w1: 'node-1', w2: 'node-1', w3: 'node-2' };
  assert.deepEqual(checkFleetV23TopologyPlacement(topo, good), []);
  assert.equal(placementSatisfiesTopologyV23(topo, good), true);

  // Affinity vỡ: w1 node-1, w2 node-2.
  const affinityBroken = { w1: 'node-1', w2: 'node-2', w3: 'node-3' };
  const v1 = checkFleetV23GroupPlacement(topo, group, affinityBroken);
  assert.ok(v1.some((v) => v.kind === 'affinity-broken' && v.botIds.includes('w1')));

  // Anti-affinity vỡ: w1 + w3 chung node-1.
  const antiBroken = { w1: 'node-1', w2: 'node-1', w3: 'node-1' };
  const v2 = checkFleetV23GroupPlacement(topo, group, antiBroken);
  assert.ok(v2.some((v) => v.kind === 'anti-affinity-broken'));

  // Spread thiếu: cả 3 bot cùng zone-a (node-1 + node-4).
  const spreadShort = { w1: 'node-1', w2: 'node-1', w3: 'node-4' };
  const v3 = checkFleetV23GroupPlacement(topo, group, spreadShort);
  assert.ok(v3.some((v) => v.kind === 'spread-short'));

  // Bot chưa đặt + node chưa gắn zone.
  const v4 = checkFleetV23GroupPlacement(topo, group, { w1: 'node-1', w2: 'node-1', w3: 'node-orphan' });
  assert.ok(v4.some((v) => v.kind === 'unknown-zone'));
  const v5 = checkFleetV23GroupPlacement(topo, group, { w1: 'node-1', w2: 'node-1' });
  assert.ok(v5.some((v) => v.kind === 'unplaced-bot' && v.botIds.includes('w3')));

  // Placement dạng Map cũng kiểm được.
  assert.deepEqual(checkFleetV23TopologyPlacement(topo, new Map(Object.entries(good))), []);
});

test('topology: zone failure impact + worst zone', () => {
  let topo = makeTopology();
  topo = topologyAddGroup(
    topo,
    createFleetV23BotGroup({ id: 'g1', botIds: ['b1', 'b2', 'b3'], spreadMinZones: 2, quorum: 2 }),
  );
  const placement = { b1: 'node-1', b2: 'node-1', b3: 'node-2' };

  const impactA = zoneFailureImpactV23(topo, placement, 'zone-a');
  assert.deepEqual(impactA.lostBotIds, ['b1', 'b2']);
  assert.deepEqual(impactA.lostNodeIds, ['node-1', 'node-4']);
  assert.deepEqual(impactA.survivingBotIds, ['b3']);
  assert.deepEqual(impactA.groupsLostQuorum, ['g1']); // còn 1 < quorum 2
  assert.deepEqual(impactA.groupsAlive, []);

  const impactB = zoneFailureImpactV23(topo, placement, 'zone-b');
  assert.deepEqual(impactB.lostBotIds, ['b3']);
  assert.deepEqual(impactB.groupsAlive, ['g1']); // còn 2 >= quorum 2

  // Zone không có node/bot nào chết → không mất bot.
  const impactC = zoneFailureImpactV23(topo, placement, 'zone-c');
  assert.deepEqual(impactC.lostBotIds, []);
  assert.deepEqual(impactC.groupsAlive, ['g1']);

  const worst = worstZoneFailureV23(topo, placement);
  assert.equal(worst?.zoneId, 'zone-a');

  // Topology không có zone → worst = null.
  assert.equal(worstZoneFailureV23(createFleetV23Topology(), placement), null);
});
