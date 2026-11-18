/**
 * Tests for fleet v21 tier-aware scheduling (v1.34, Đội T6).
 *
 * Covers:
 * - Tier model: ordering, satisfies, shortfall, parse, validation.
 * - Node model: free capacity, load, overload, fits, reject reasons,
 *   registry (duplicate add throws, totals), heartbeat ageing.
 * - Scoring: emptier node wins, reliability matters, latency matters,
 *   tier-fit prefers a just-sufficient node over a microVM node for a
 *   bwrap run, preferred-node bonus.
 * - Scheduling: best node chosen; refusal when no node meets the tier,
 *   when every node is offline, when capacity is short, when labels
 *   are missing — each with a clear reason (never a silent no-fit).
 * - Request validation.
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/fleet-v21-scheduler.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SANDBOX_TIERS_V21,
  compareSandboxTierV21,
  isSandboxTierV21,
  maxTierOfV21,
  minTierOfV21,
  parseSandboxTierV21,
  recommendedTierV21,
  tierSatisfiesV21,
  tierShortfallV21,
  validateTierRequirementV21,
} from '../packages/core/dist/fleetV21/tiers.js';
import {
  FleetV21NodeRegistry,
  NODE_DEAD_AFTER_MS,
  createFleetV21Node,
  nodeAgeStatusV21,
  nodeCanAcceptV21,
  nodeCpuFractionV21,
  nodeFitsDemandV21,
  nodeFreeCpuV21,
  nodeFreeRamV21,
  nodeIsOverloadedV21,
  nodeLoadV21,
  nodeRejectReasonsV21,
  validateFleetV21Node,
} from '../packages/core/dist/fleetV21/nodes.js';
import {
  evaluateFleetV21Schedule,
  scheduleFleetV21Run,
  scoreFleetV21Node,
  summarizeScheduleRejectionV21,
  validateScheduleRequestV21,
} from '../packages/core/dist/fleetV21/scheduler.js';

const GB = 1024 ** 3;
const NOW = 1780000000000;

function makeNode(id, overrides = {}) {
  return createFleetV21Node({
    id,
    name: id,
    maxTier: 'bwrap',
    cpuCores: 8,
    ramBytes: 32 * GB,
    diskBytes: 200 * GB,
    latencyMs: 10,
    now: NOW,
    ...overrides,
  });
}

function makeRequest(overrides = {}) {
  return {
    runId: 'run-1',
    botId: 'bot-1',
    minTier: 'bwrap',
    demand: { cpuCores: 1, ramBytes: 1 * GB, diskBytes: 1 * GB },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tier model
// ---------------------------------------------------------------------------

test('tiers: ordering bwrap < syscall-policy < microvm', () => {
  assert.deepEqual([...SANDBOX_TIERS_V21], ['bwrap', 'syscall-policy', 'microvm']);
  assert.ok(compareSandboxTierV21('bwrap', 'microvm') < 0);
  assert.ok(compareSandboxTierV21('microvm', 'syscall-policy') > 0);
  assert.equal(compareSandboxTierV21('syscall-policy', 'syscall-policy'), 0);
  assert.equal(maxTierOfV21(['bwrap', 'microvm', 'syscall-policy']), 'microvm');
  assert.equal(minTierOfV21(['bwrap', 'microvm', 'syscall-policy']), 'bwrap');
  assert.equal(maxTierOfV21([]), undefined);
});

test('tiers: satisfies / shortfall / parse / recommend', () => {
  assert.equal(tierSatisfiesV21('microvm', 'bwrap'), true);
  assert.equal(tierSatisfiesV21('microvm', 'microvm'), true);
  assert.equal(tierSatisfiesV21('bwrap', 'microvm'), false);
  assert.equal(tierSatisfiesV21('syscall-policy', 'microvm'), false);
  assert.equal(tierShortfallV21('bwrap', 'microvm'), 'microvm');
  assert.equal(tierShortfallV21('microvm', 'bwrap'), undefined);
  assert.equal(parseSandboxTierV21('microvm'), 'microvm');
  assert.equal(parseSandboxTierV21('kvm'), undefined);
  assert.equal(parseSandboxTierV21(42), undefined);
  assert.equal(isSandboxTierV21('bwrap'), true);
  assert.equal(isSandboxTierV21('docker'), false);
  assert.equal(recommendedTierV21('internal'), 'bwrap');
  assert.equal(recommendedTierV21('marketplace'), 'syscall-policy');
  assert.equal(recommendedTierV21('untrusted'), 'microvm');
});

test('tiers: validateTierRequirementV21 rejects bad / inconsistent tiers', () => {
  assert.deepEqual(validateTierRequirementV21({ minTier: 'bwrap' }), []);
  assert.deepEqual(validateTierRequirementV21({ minTier: 'bwrap', preferredTier: 'microvm' }), []);
  assert.ok(validateTierRequirementV21({}).length > 0);
  assert.ok(validateTierRequirementV21({ minTier: 'nope' }).length > 0);
  // preferredTier weaker than minTier is inconsistent.
  assert.ok(
    validateTierRequirementV21({ minTier: 'microvm', preferredTier: 'bwrap' }).length > 0,
  );
});

// ---------------------------------------------------------------------------
// Node model
// ---------------------------------------------------------------------------

test('nodes: free capacity, load and overload flags', () => {
  const node = { ...makeNode('n1'), cpuUsed: 7, ramUsed: 30 * GB, diskUsed: 10 * GB };
  assert.equal(nodeFreeCpuV21(node), 1);
  assert.equal(nodeFreeRamV21(node), 2 * GB);
  assert.equal(nodeCpuFractionV21(node), 7 / 8);
  assert.ok(nodeLoadV21(node) > 0.9);
  assert.equal(nodeIsOverloadedV21(node), true);
  const idle = makeNode('n2');
  assert.equal(nodeIsOverloadedV21(idle), false);
  assert.equal(nodeLoadV21(idle), 0);
  // Overused node clamps free capacity to 0, never negative.
  const over = { ...makeNode('n3'), cpuUsed: 99, ramUsed: 99 * GB };
  assert.equal(nodeFreeCpuV21(over), 0);
  assert.equal(nodeFreeRamV21(over), 0);
});

test('nodes: fits demand and reject reasons explain every gap', () => {
  const node = makeNode('n1', { maxTier: 'syscall-policy' });
  const demand = { cpuCores: 1, ramBytes: 1 * GB, diskBytes: 1 * GB };
  assert.equal(nodeFitsDemandV21(node, demand), true);
  assert.equal(nodeCanAcceptV21(node, demand, 'bwrap'), true);
  assert.equal(nodeCanAcceptV21(node, demand, 'microvm'), false);
  const reasons = nodeRejectReasonsV21(node, demand, 'microvm');
  assert.ok(reasons.some((r) => r.includes('microvm')));
  const huge = { cpuCores: 99, ramBytes: 1 * GB, diskBytes: 1 * GB };
  assert.equal(nodeFitsDemandV21(node, huge), false);
  assert.ok(nodeRejectReasonsV21(node, huge, 'bwrap').some((r) => r.includes('CPU')));
  const draining = { ...node, status: 'draining' };
  assert.ok(nodeRejectReasonsV21(draining, demand, 'bwrap').some((r) => r.includes('draining')));
});

test('nodes: registry add/update/upsert/remove/totals', () => {
  const registry = new FleetV21NodeRegistry();
  const a = makeNode('a', { maxTier: 'microvm', cpuUsed: 4 });
  const b = makeNode('b', { maxTier: 'bwrap' });
  registry.add(a);
  registry.add(b);
  assert.equal(registry.size, 2);
  assert.throws(() => registry.add(a), /đã tồn tại/);
  assert.equal(registry.get('a')?.maxTier, 'microvm');
  assert.equal(registry.get('nope'), undefined);
  registry.update({ ...a, cpuUsed: 5 });
  assert.equal(registry.get('a')?.cpuUsed, 5);
  assert.equal(registry.online().length, 2);
  assert.equal(registry.supporting('microvm').length, 1);
  const totals = registry.totals();
  assert.equal(totals.nodes, 2);
  assert.equal(totals.cpuCores, 16);
  assert.equal(totals.cpuUsed, 5);
  assert.equal(registry.remove('b'), true);
  assert.equal(registry.remove('b'), false);
  assert.equal(registry.size, 1);
});

test('nodes: heartbeat ageing offline -> dead after silence', () => {
  const node = makeNode('n1');
  const silent = { ...node, lastSeenAt: NOW - NODE_DEAD_AFTER_MS - 1000 };
  const aged = nodeAgeStatusV21(silent, NOW);
  assert.equal(aged.changed, true);
  assert.equal(aged.node.status, 'offline');
  const longSilent = { ...aged.node, lastSeenAt: NOW - NODE_DEAD_AFTER_MS * 2 };
  const dead = nodeAgeStatusV21(longSilent, NOW);
  assert.equal(dead.node.status, 'dead');
  assert.match(dead.node.statusReason ?? '', /heartbeat/);
  // Dead nodes never age back.
  assert.equal(nodeAgeStatusV21(dead.node, NOW).changed, false);
});

test('nodes: validateFleetV21Node catches bad input', () => {
  assert.deepEqual(validateFleetV21Node(makeNode('n1')), []);
  assert.ok(validateFleetV21Node({}).length > 0);
  assert.ok(validateFleetV21Node({ id: 'x', maxTier: 'docker', cpuCores: 1, ramBytes: 1, diskBytes: 1 }).length > 0);
  assert.ok(validateFleetV21Node({ id: 'x', maxTier: 'bwrap', cpuCores: -1, ramBytes: 1, diskBytes: 1 }).length > 0);
  assert.ok(validateFleetV21Node({ id: 'x', maxTier: 'bwrap', cpuCores: 1, ramBytes: 1, diskBytes: 1, reliability: 2 }).length > 0);
});

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

test('scoring: emptier node beats fuller node', () => {
  const empty = makeNode('empty');
  const full = { ...makeNode('full'), cpuUsed: 7, ramUsed: 28 * GB };
  const req = makeRequest();
  assert.ok(scoreFleetV21Node(empty, req).score > scoreFleetV21Node(full, req).score);
});

test('scoring: unreliable node is penalised heavily', () => {
  const good = makeNode('good', { reliability: 1 });
  const flaky = makeNode('flaky', { reliability: 0.2 });
  const req = makeRequest();
  const diff = scoreFleetV21Node(good, req).score - scoreFleetV21Node(flaky, req).score;
  assert.ok(diff > 15, `expected reliability gap > 15, got ${diff}`);
  assert.equal(scoreFleetV21Node(flaky, req).breakdown.reliability, 5);
});

test('scoring: low latency beats high latency, unknown latency is middling', () => {
  const fast = makeNode('fast', { latencyMs: 5 });
  const slow = makeNode('slow', { latencyMs: 600 });
  const unknown = makeNode('unknown', { latencyMs: null });
  const req = makeRequest();
  assert.ok(scoreFleetV21Node(fast, req).breakdown.latency > scoreFleetV21Node(slow, req).breakdown.latency);
  assert.equal(scoreFleetV21Node(slow, req).breakdown.latency, 0);
  assert.equal(scoreFleetV21Node(unknown, req).breakdown.latency, 5);
});

test('scoring: tier-fit prefers just-sufficient node over microVM for a bwrap run', () => {
  const bwrapNode = makeNode('bwrap-node', { maxTier: 'bwrap' });
  const vmNode = makeNode('vm-node', { maxTier: 'microvm' });
  const req = makeRequest({ minTier: 'bwrap' });
  const bwrapScore = scoreFleetV21Node(bwrapNode, req);
  const vmScore = scoreFleetV21Node(vmNode, req);
  assert.equal(bwrapScore.breakdown.tierFit, 10);
  assert.equal(vmScore.breakdown.tierFit, 0);
  assert.ok(bwrapScore.score > vmScore.score);
  // For a microvm run the bwrap node is not even eligible, so it is never scored here;
  // the microVM node gets full tier-fit for its own tier.
  const vmReq = makeRequest({ minTier: 'microvm' });
  assert.equal(scoreFleetV21Node(vmNode, vmReq).breakdown.tierFit, 10);
});

test('scoring: preferred node gets the bonus', () => {
  const a = makeNode('a');
  const b = makeNode('b');
  const req = makeRequest({ preferredNodeId: 'b' });
  assert.equal(scoreFleetV21Node(a, req).breakdown.preferredNodeBonus, 0);
  assert.equal(scoreFleetV21Node(b, req).breakdown.preferredNodeBonus, 5);
  assert.ok(scoreFleetV21Node(b, req).score > scoreFleetV21Node(a, req).score);
});

// ---------------------------------------------------------------------------
// Scheduling decisions
// ---------------------------------------------------------------------------

test('scheduling: picks the best node and ranks the rest', () => {
  const nodes = [
    makeNode('busy', { cpuUsed: 7, ramUsed: 30 * GB }),
    makeNode('best'),
    makeNode('mid', { cpuUsed: 4, ramUsed: 16 * GB }),
  ];
  const decision = scheduleFleetV21Run(nodes, makeRequest());
  assert.equal(decision.placed, true);
  assert.equal(decision.nodeId, 'best');
  assert.equal(decision.evaluation.ranked[0].nodeId, 'best');
  assert.equal(decision.evaluation.ranked.length, 3);
  assert.deepEqual(decision.evaluation.rejected, []);
});

test('scheduling: refuses when no node meets the tier, with a tier reason', () => {
  const nodes = [makeNode('a', { maxTier: 'bwrap' }), makeNode('b', { maxTier: 'syscall-policy' })];
  const decision = scheduleFleetV21Run(nodes, makeRequest({ minTier: 'microvm' }));
  assert.equal(decision.placed, false);
  assert.match(decision.reason, /microvm/);
  assert.equal(decision.evaluation.tierRejectedNodeIds.length, 2);
  assert.equal(decision.evaluation.ranked.length, 0);
  const summary = summarizeScheduleRejectionV21(decision.evaluation);
  assert.match(summary, /tier tối thiểu microvm/);
});

test('scheduling: refuses when every node is offline', () => {
  const nodes = [{ ...makeNode('a'), status: 'offline' }];
  const decision = scheduleFleetV21Run(nodes, makeRequest());
  assert.equal(decision.placed, false);
  assert.match(decision.reason, /online/);
  assert.equal(decision.evaluation.statusRejectedNodeIds.length, 1);
});

test('scheduling: refuses when no node has capacity, naming the shortage', () => {
  const nodes = [makeNode('a', { cpuUsed: 8, ramUsed: 32 * GB })];
  const decision = scheduleFleetV21Run(nodes, makeRequest());
  assert.equal(decision.placed, false);
  assert.match(decision.reason, /CPU\/RAM\/disk/);
  assert.equal(decision.evaluation.capacityRejectedNodeIds.length, 1);
  assert.ok(decision.evaluation.rejected[0].reasons.some((r) => r.includes('thiếu')));
});

test('scheduling: refuses when no node has the required labels', () => {
  const nodes = [makeNode('a', { labels: ['cpu-only'] })];
  const decision = scheduleFleetV21Run(nodes, makeRequest({ requiredLabels: ['gpu'] }));
  assert.equal(decision.placed, false);
  assert.match(decision.reason, /nhãn/);
});

test('scheduling: empty fleet explains itself', () => {
  const decision = scheduleFleetV21Run([], makeRequest());
  assert.equal(decision.placed, false);
  assert.match(decision.reason, /không có node/);
});

test('scheduling: draining node never wins even when empty', () => {
  const nodes = [
    { ...makeNode('draining-empty'), status: 'draining' },
    { ...makeNode('busy-online'), cpuUsed: 6, ramUsed: 24 * GB },
  ];
  const decision = scheduleFleetV21Run(nodes, makeRequest());
  assert.equal(decision.placed, true);
  assert.equal(decision.nodeId, 'busy-online');
});

test('scheduling: evaluate() ranks deterministically on ties', () => {
  const nodes = [makeNode('b'), makeNode('a')];
  const evaluation = evaluateFleetV21Schedule(nodes, makeRequest());
  assert.equal(evaluation.ranked[0].nodeId, 'a');
  assert.equal(evaluation.ranked[1].nodeId, 'b');
});

test('scheduling: validateScheduleRequestV21 catches bad requests', () => {
  assert.deepEqual(validateScheduleRequestV21(makeRequest()), []);
  assert.ok(validateScheduleRequestV21({}).length > 0);
  assert.ok(validateScheduleRequestV21(makeRequest({ minTier: 'docker' })).length > 0);
  assert.ok(validateScheduleRequestV21(makeRequest({ demand: { cpuCores: -1, ramBytes: 0, diskBytes: 0 } })).length > 0);
  assert.ok(validateScheduleRequestV21(makeRequest({ maxLifetimeMs: 0 })).length > 0);
});
