/**
 * Tests for fleet v23 placement v2 + rebalance v2 (v1.36, Đội T6).
 *
 * Covers:
 * - Placement: hard filters (offline, capacity, labels, zones),
 *   scoring breakdown sums to total, cost (free node = full cost
 *   points, expensive node penalised), Pareto frontier, rejection
 *   summary, topology-aware rejection (anti-affinity).
 * - Capacity forecast: burn rate, months until exhaustion, bottleneck
 *   = earliest resource, no-burn = never exhausts, urgent flag.
 * - Rebalance: imbalance measure (CV/spread, <2 nodes = no rebalance),
 *   plan moves hottest→coldest (pinned bots never move, capacity
 *   respected, maxMoves cap), dry-run changes nothing, execute with
 *   verify + rollback on failure (placement restored).
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/fleet-v23-placement-rebalance.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_FLEET_V23_SCORE_WEIGHTS,
  estimateFleetV23CostPerHour,
  evaluateFleetV23Placement,
  forecastFleetV23Capacity,
  paretoFrontierV23,
  placeFleetV23Bot,
  placementRejectReasonsV23,
  scoreFleetV23Node,
  summarizePlacementRejectionV23,
  validateFleetV23NodeSnapshot,
  validateFleetV23PlaceRequest,
  validateFleetV23ScoreWeights,
} from '../packages/core/dist/fleetV23/placementV2.js';
import {
  createFleetV23BotGroup,
  createFleetV23Topology,
  createFleetV23Zone,
  topologyAddGroup,
  topologyAddZone,
  topologyAssignNode,
} from '../packages/core/dist/fleetV23/topology.js';
import {
  DEFAULT_FLEET_V23_REBALANCE_THRESHOLDS,
  FleetV23RebalanceHistory,
  executeFleetV23RebalancePlan,
  measureFleetV23Imbalance,
  planFleetV23Rebalance,
  validateFleetV23NodeLoad,
} from '../packages/core/dist/fleetV23/rebalanceV2.js';

const GB = 1024 ** 3;
const NOW = 1780000000000;

function makeNode(id, overrides = {}) {
  return {
    id,
    zoneId: null,
    online: true,
    cpuCores: 8,
    cpuFree: 8,
    ramBytes: 32 * GB,
    ramFree: 32 * GB,
    diskBytes: 500 * GB,
    diskFree: 500 * GB,
    reliability: 90,
    latencyMs: 20,
    costPerHour: 0,
    labels: [],
    runningBotIds: [],
    ...overrides,
  };
}

const DEMAND = { cpuCores: 2, ramBytes: 4 * GB, diskBytes: 10 * GB };

test('placement: validate weights/snapshot/request', () => {
  assert.deepEqual(validateFleetV23ScoreWeights(DEFAULT_FLEET_V23_SCORE_WEIGHTS), []);
  assert.ok(validateFleetV23ScoreWeights({ ...DEFAULT_FLEET_V23_SCORE_WEIGHTS, cost: 16 }).some((e) => e.includes('= 100')));
  assert.ok(validateFleetV23ScoreWeights({ ...DEFAULT_FLEET_V23_SCORE_WEIGHTS, cost: -1 }).some((e) => e.includes('0..100')));

  assert.deepEqual(validateFleetV23NodeSnapshot(makeNode('n1')), []);
  assert.ok(validateFleetV23NodeSnapshot({ ...makeNode('n1'), cpuFree: 99 }).some((e) => e.includes('cpuFree')));
  assert.ok(validateFleetV23NodeSnapshot({ ...makeNode('n1'), reliability: 101 }).some((e) => e.includes('reliability')));
  assert.ok(validateFleetV23NodeSnapshot({ ...makeNode('n1'), costPerHour: -1 }).some((e) => e.includes('costPerHour')));

  assert.deepEqual(validateFleetV23PlaceRequest({ botId: 'b1', demand: DEMAND }), []);
  assert.ok(validateFleetV23PlaceRequest({ botId: 'b1', demand: { ...DEMAND, cpuCores: 0 } }).some((e) => e.includes('cpuCores')));
  assert.ok(validateFleetV23PlaceRequest(null).some((e) => e.includes('object')));
});

test('placement: hard filters reject with reasons', () => {
  const nodes = [
    makeNode('off', { online: false }),
    makeNode('small', { cpuFree: 1 }),
    makeNode('nolabel', { labels: [] }),
    makeNode('good', { labels: ['gpu'] }),
  ];
  const req = { botId: 'b1', demand: DEMAND, requiredLabels: ['gpu'] };
  assert.ok(placementRejectReasonsV23(nodes[0], req).some((r) => r.includes('không online')));
  assert.ok(placementRejectReasonsV23(nodes[1], req).some((r) => r.includes('chỉ còn 1 CPU')));
  assert.ok(placementRejectReasonsV23(nodes[2], req).some((r) => r.includes('thiếu nhãn')));
  assert.deepEqual(placementRejectReasonsV23(nodes[3], req), []);
  // Zone cấm / zone cho phép.
  const zoned = makeNode('z', { zoneId: 'zone-x' });
  assert.ok(placementRejectReasonsV23(zoned, { botId: 'b1', demand: DEMAND, forbiddenZones: ['zone-x'] }).some((r) => r.includes('zone cấm')));
  assert.ok(placementRejectReasonsV23(zoned, { botId: 'b1', demand: DEMAND, allowedZones: ['zone-y'] }).some((r) => r.includes('ngoài danh sách')));
  assert.deepEqual(placementRejectReasonsV23(zoned, { botId: 'b1', demand: DEMAND, allowedZones: ['zone-x'] }), []);
});

test('placement: scoring — breakdown sums, cost, latency, reliability', () => {
  const cheap = makeNode('cheap', { costPerHour: 0, reliability: 100, latencyMs: 5 });
  const pricey = makeNode('pricey', { costPerHour: 2, reliability: 50, latencyMs: 400 });
  const maxCost = estimateFleetV23CostPerHour(pricey, DEMAND);
  assert.ok(maxCost > 0);
  assert.equal(estimateFleetV23CostPerHour(cheap, DEMAND), 0);
  const sCheap = scoreFleetV23Node(cheap, { botId: 'b1', demand: DEMAND }, DEFAULT_FLEET_V23_SCORE_WEIGHTS, maxCost);
  const sPricey = scoreFleetV23Node(pricey, { botId: 'b1', demand: DEMAND }, DEFAULT_FLEET_V23_SCORE_WEIGHTS, maxCost);
  const sumCheap = Object.values(sCheap.breakdown).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sumCheap - sCheap.score) < 0.01);
  assert.equal(sCheap.breakdown.cost, 15); // node miễn phí = trọn điểm cost
  assert.ok(sCheap.score > sPricey.score);
  assert.ok(sCheap.breakdown.reliability > sPricey.breakdown.reliability);
  assert.ok(sCheap.breakdown.latency > sPricey.breakdown.latency);
  // Chưa đo latency → 50% điểm latency.
  const unknownLatency = scoreFleetV23Node(makeNode('u', { latencyMs: null }), { botId: 'b1', demand: DEMAND });
  assert.equal(unknownLatency.breakdown.latency, 5);
  // freeAfter trừ đúng demand.
  assert.equal(sCheap.freeAfter.cpuCores, 6);
  assert.equal(sCheap.freeAfter.ramBytes, 28 * GB);
});

test('placement: evaluate + place + pareto', () => {
  const nodes = [
    makeNode('n1', { cpuFree: 2, ramFree: 4 * GB, reliability: 95, latencyMs: 10, costPerHour: 0.1 }),
    makeNode('n2', { cpuFree: 8, ramFree: 32 * GB, reliability: 99, latencyMs: 5, costPerHour: 0 }),
    makeNode('n3', { cpuFree: 8, ramFree: 32 * GB, reliability: 60, latencyMs: 300, costPerHour: 5 }),
    makeNode('off', { online: false }),
  ];
  const ev = evaluateFleetV23Placement(nodes, { botId: 'b1', demand: DEMAND });
  assert.equal(ev.ranked[0]?.nodeId, 'n2');
  assert.equal(ev.rejected.length, 1);
  assert.deepEqual(ev.statusRejectedNodeIds, ['off']);
  assert.ok(ev.ranked.find((s) => s.nodeId === 'n2')?.onParetoFrontier);
  // n1 bị n2 vượt toàn diện (trống hơn, tin cậy hơn, trễ thấp hơn, rẻ hơn) → ngoài frontier.
  assert.equal(ev.ranked.find((s) => s.nodeId === 'n1')?.onParetoFrontier, false);
  const frontier = paretoFrontierV23(ev.ranked, nodes.filter((n) => n.online));
  assert.ok(frontier.includes('n2'));
  assert.ok(!frontier.includes('n1'));

  const decision = placeFleetV23Bot(nodes, { botId: 'b1', demand: DEMAND });
  assert.equal(decision.placed, true);
  if (decision.placed) assert.equal(decision.nodeId, 'n2');

  // Không node nào đặt được → từ chối kèm lý do.
  const noFit = placeFleetV23Bot([makeNode('tiny', { cpuFree: 1 })], { botId: 'b1', demand: DEMAND });
  assert.equal(noFit.placed, false);
  if (!noFit.placed) {
    assert.ok(noFit.reason.includes('tiny'));
    assert.equal(summarizePlacementRejectionV23(noFit.evaluation), 'Không node nào đặt được — nguyên nhân lớn nhất: thiếu tài nguyên (1/1 node).');
  }
  // Trọng số sai → throw.
  assert.throws(
    () => evaluateFleetV23Placement(nodes, { botId: 'b1', demand: DEMAND }, { weights: { ...DEFAULT_FLEET_V23_SCORE_WEIGHTS, cost: 99 } }),
    /Trọng số/,
  );
});

test('placement: topology-aware rejection (anti-affinity)', () => {
  let topo = createFleetV23Topology();
  topo = topologyAddZone(topo, createFleetV23Zone({ id: 'zone-a', region: 'r', name: 'A' }));
  topo = topologyAssignNode(topo, 'n1', 'zone-a');
  topo = topologyAssignNode(topo, 'n2', 'zone-a');
  topo = topologyAddGroup(
    topo,
    createFleetV23BotGroup({ id: 'g', botIds: ['b1', 'b2'], antiAffinityPairs: [['b1', 'b2']], quorum: 1 }),
  );
  const nodes = [makeNode('n1', { zoneId: 'zone-a' }), makeNode('n2', { zoneId: 'zone-a' })];
  const placement = { b2: 'n1' };
  // b1 đặt lên n1 → vi phạm anti-affinity với b2 → node n1 bị loại.
  const ev = evaluateFleetV23Placement(nodes, { botId: 'b1', demand: DEMAND }, { topology: topo, placement });
  assert.equal(ev.ranked[0]?.nodeId, 'n2');
  assert.ok(ev.topologyRejectedNodeIds.includes('n1'));
});

test('placement: capacity forecast — bottleneck + urgent + no burn', () => {
  const nodes = [makeNode('n1', { cpuFree: 4, ramFree: 8 * GB, diskFree: 100 * GB }), makeNode('n2', { cpuFree: 4, ramFree: 8 * GB, diskFree: 100 * GB })];
  const { forecasts, bottleneck } = forecastFleetV23Capacity(
    nodes,
    { botsPerMonth: 2, perBot: { cpuCores: 1, ramBytes: 2 * GB, diskBytes: 10 * GB } },
    NOW,
  );
  const cpu = forecasts.find((f) => f.resource === 'cpu');
  const ram = forecasts.find((f) => f.resource === 'ram');
  const disk = forecasts.find((f) => f.resource === 'disk');
  assert.equal(cpu?.freeNow, 8);
  assert.equal(cpu?.monthsUntilExhaustion, 4); // 8 CPU / 2 mỗi tháng
  assert.equal(ram?.monthsUntilExhaustion, 4); // 16GB / 4GB mỗi tháng
  assert.equal(disk?.monthsUntilExhaustion, 10); // 200GB / 20GB mỗi tháng
  assert.equal(bottleneck, 'cpu'); // hoà cpu/ram → cpu trước (thứ tự mảng)
  assert.equal(cpu?.urgent, false);
  assert.ok((cpu?.exhaustsAtMs ?? 0) > NOW);
  // Tăng trưởng nhanh → urgent.
  const fast = forecastFleetV23Capacity(nodes, { botsPerMonth: 4, perBot: { cpuCores: 1, ramBytes: 2 * GB, diskBytes: 10 * GB } }, NOW);
  assert.equal(fast.forecasts.find((f) => f.resource === 'cpu')?.urgent, true);
  // Không tăng trưởng → không bao giờ hết, bottleneck null.
  const flat = forecastFleetV23Capacity(nodes, { botsPerMonth: 0, perBot: DEMAND }, NOW);
  assert.equal(flat.bottleneck, null);
  assert.ok(flat.forecasts.every((f) => f.monthsUntilExhaustion === null));
});

test('rebalance: measure imbalance', () => {
  assert.deepEqual(validateFleetV23NodeLoad({ nodeId: 'n1', cpuUsedFraction: 0.5, ramUsedFraction: 0.5, bots: [] }), []);
  assert.ok(validateFleetV23NodeLoad({ nodeId: 'n1', cpuUsedFraction: 1.5, ramUsedFraction: 0.5, bots: [] }).some((e) => e.includes('cpuUsedFraction')));
  // 1 node → không rebalance.
  const single = measureFleetV23Imbalance([{ nodeId: 'n1', cpuUsedFraction: 0.9, ramUsedFraction: 0.9, bots: [] }]);
  assert.equal(single.needsRebalance, false);
  assert.equal(single.hottestNodeId, 'n1');
  // Cân bằng → không rebalance.
  const balanced = measureFleetV23Imbalance([
    { nodeId: 'n1', cpuUsedFraction: 0.5, ramUsedFraction: 0.5, bots: [] },
    { nodeId: 'n2', cpuUsedFraction: 0.52, ramUsedFraction: 0.5, bots: [] },
  ]);
  assert.equal(balanced.needsRebalance, false);
  assert.equal(balanced.meanCpu, 0.51);
  // Lệch mạnh → rebalance.
  const skewed = measureFleetV23Imbalance([
    { nodeId: 'n1', cpuUsedFraction: 0.95, ramUsedFraction: 0.9, bots: [] },
    { nodeId: 'n2', cpuUsedFraction: 0.05, ramUsedFraction: 0.1, bots: [] },
  ]);
  assert.equal(skewed.needsRebalance, true);
  assert.equal(skewed.hottestNodeId, 'n1');
  assert.equal(skewed.coldestNodeId, 'n2');
  assert.ok(skewed.cpuCv > DEFAULT_FLEET_V23_REBALANCE_THRESHOLDS.maxCv);
});

test('rebalance: plan moves hottest→coldest, pinned never moves, maxMoves', () => {
  const loads = [
    {
      nodeId: 'n1',
      cpuUsedFraction: 0.95,
      ramUsedFraction: 0.9,
      bots: [
        { botId: 'big', cpuCores: 4, ramBytes: 8 * GB, diskBytes: 10 * GB, pinned: false },
        { botId: 'pinned-bot', cpuCores: 2, ramBytes: 4 * GB, diskBytes: 10 * GB, pinned: true },
      ],
    },
    { nodeId: 'n2', cpuUsedFraction: 0.05, ramUsedFraction: 0.1, bots: [] },
  ];
  const nodes = [makeNode('n1', { cpuFree: 0.4, ramFree: 3 * GB }), makeNode('n2', { cpuFree: 8, ramFree: 32 * GB })];
  const placement = { big: 'n1', 'pinned-bot': 'n1' };
  const plan = planFleetV23Rebalance({ id: 'p1', loads, nodes, placement, now: NOW });
  assert.equal(plan.dryRun, true);
  assert.ok(plan.moves.length >= 1);
  assert.equal(plan.moves[0]?.botId, 'big'); // bot lớn nhất đi trước
  assert.equal(plan.moves[0]?.fromNodeId, 'n1');
  assert.equal(plan.moves[0]?.toNodeId, 'n2');
  assert.ok(!plan.moves.some((m) => m.botId === 'pinned-bot')); // pinned không bao giờ move
  assert.equal(plan.placementAfter.big, 'n2');
  assert.equal(plan.placementAfter['pinned-bot'], 'n1');
  assert.ok(plan.imbalanceAfter.cpuCv < plan.imbalanceBefore.cpuCv);
  // maxMoves = 1 → tối đa 1 move.
  const capped = planFleetV23Rebalance({
    id: 'p2',
    loads,
    nodes,
    placement,
    thresholds: { ...DEFAULT_FLEET_V23_REBALANCE_THRESHOLDS, maxMoves: 1 },
    now: NOW,
  });
  assert.equal(capped.moves.length, 1);
  // Tải đã cân → plan rỗng + warning.
  const calm = planFleetV23Rebalance({
    id: 'p3',
    loads: [
      { nodeId: 'n1', cpuUsedFraction: 0.5, ramUsedFraction: 0.5, bots: [] },
      { nodeId: 'n2', cpuUsedFraction: 0.52, ramUsedFraction: 0.5, bots: [] },
    ],
    nodes,
    placement: {},
    now: NOW,
  });
  assert.equal(calm.moves.length, 0);
  assert.ok(calm.warnings.length > 0);
});

test('rebalance: execute success + failure rolls back', async () => {
  const loads = [
    {
      nodeId: 'n1',
      cpuUsedFraction: 0.95,
      ramUsedFraction: 0.9,
      bots: [
        { botId: 'b1', cpuCores: 2, ramBytes: 4 * GB, diskBytes: 10 * GB, pinned: false },
        { botId: 'b2', cpuCores: 2, ramBytes: 4 * GB, diskBytes: 10 * GB, pinned: false },
      ],
    },
    { nodeId: 'n2', cpuUsedFraction: 0.05, ramUsedFraction: 0.1, bots: [] },
  ];
  const nodes = [makeNode('n1', { cpuFree: 4, ramFree: 28 * GB }), makeNode('n2', { cpuFree: 8, ramFree: 32 * GB })];
  const placement = { b1: 'n1', b2: 'n1' };
  const plan = planFleetV23Rebalance({ id: 'px', loads, nodes, placement, now: NOW });
  assert.ok(plan.moves.length >= 1);

  // Thực thi thành công: placement đổi theo plan.
  const ok = await executeFleetV23RebalancePlan(plan, placement, {
    moveBot: async () => {},
    verifyBot: async () => true,
  });
  assert.equal(ok.success, true);
  assert.equal(ok.failedMove, null);
  assert.equal(ok.appliedMoves.length, plan.moves.length);
  assert.deepEqual(ok.placementAfter, plan.placementAfter);

  // Verify fail ở move thứ 2 → dừng + rollback move 1 về node cũ.
  const twoMovePlan = { ...plan, moves: plan.moves.slice(0, 2) };
  if (twoMovePlan.moves.length < 2) {
    // Plan chỉ có 1 move thì tạo plan 2 move tay để test rollback.
    twoMovePlan.moves = [
      { botId: 'b1', fromNodeId: 'n1', toNodeId: 'n2', cpuRelief: 0.25, reason: 'test move 1' },
      { botId: 'b2', fromNodeId: 'n1', toNodeId: 'n2', cpuRelief: 0.25, reason: 'test move 2' },
    ];
  }
  let verifyCalls = 0;
  const failed = await executeFleetV23RebalancePlan(twoMovePlan, placement, {
    moveBot: async () => {},
    verifyBot: async () => {
      verifyCalls += 1;
      return verifyCalls !== 2; // move 2 verify fail; rollback verify ok
    },
  });
  assert.equal(failed.success, false);
  assert.notEqual(failed.failedMove, null);
  assert.equal(failed.appliedMoves.length, 1);
  assert.equal(failed.rolledBackMoves.length, 1);
  assert.deepEqual(failed.placementAfter, placement); // rollback xong → về như cũ

  // Lịch sử: ghi + đếm lỗi.
  const history = new FleetV23RebalanceHistory();
  history.record(ok);
  history.record(failed);
  assert.equal(history.size, 2);
  assert.equal(history.failureCount, 1);
  assert.equal(history.lastSuccess()?.planId, 'px');
});
