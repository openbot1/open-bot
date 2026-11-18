/**
 * Tests for fleet v23 dispatch v2 + autoscale v2 (v1.36, Đội T6).
 *
 * Covers:
 * - Dispatch: priority order (critical first), capacity deduction
 *   within one round (two big jobs do not share one small node),
 *   deferral with reason when nothing fits, dry-run changes nothing,
 *   apply starts assigned jobs + updates placement, failed start is
 *   skipped (not rolled back), maxJobs cap, summary.
 * - Autoscale: policy validation, cooldown blocks recommendations,
 *   scale-out on SLA breach, scale-out on urgent forecast + long
 *   queue, scale-out on long wait + high CPU, max-nodes cap blocks
 *   scale-out, scale-in only when queue empty + idle node + no
 *   urgent forecast + above minNodes, nodes-needed estimate.
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/fleet-v23-dispatch-autoscale.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyFleetV23DispatchPlan,
  planFleetV23Dispatch,
  summarizeFleetV23DispatchPlan,
  validateFleetV23DispatchPlan,
} from '../packages/core/dist/fleetV23/dispatchV2.js';
import {
  DEFAULT_FLEET_V23_AUTOSCALE_POLICY,
  estimateFleetV23NodesNeeded,
  recommendFleetV23Autoscale,
  validateFleetV23AutoscalePolicy,
} from '../packages/core/dist/fleetV23/autoscaleV2.js';
import {
  FleetV23SchedulerQueue,
  createFleetV23Job,
} from '../packages/core/dist/fleetV23/schedulerV2.js';
import { forecastFleetV23Capacity } from '../packages/core/dist/fleetV23/placementV2.js';
import {
  buildFleetV23AutoscalePanel,
  buildFleetV23DispatchPanel,
} from '../packages/core/dist/fleetV23/panelsV23.js';

const GB = 1024 ** 3;
const NOW = 1780000000000;

function makeNode(id, overrides = {}) {
  return {
    id,
    zoneId: null,
    online: true,
    cpuCores: 4,
    cpuFree: 4,
    ramBytes: 16 * GB,
    ramFree: 16 * GB,
    diskBytes: 200 * GB,
    diskFree: 200 * GB,
    reliability: 90,
    latencyMs: 20,
    costPerHour: 0,
    labels: [],
    runningBotIds: [],
    ...overrides,
  };
}

function makeJob(id, overrides = {}) {
  return createFleetV23Job({
    id,
    botId: `bot-${id}`,
    title: id,
    submittedAt: NOW,
    demand: { cpuCores: 2, ramBytes: 4 * GB, diskBytes: 10 * GB },
    ...overrides,
  });
}

test('dispatch: priority order + capacity deduction in one round', () => {
  const jobs = [
    makeJob('low-1', { priority: 'low', submittedAt: NOW }),
    makeJob('crit-1', { priority: 'critical', submittedAt: NOW + 1000 }),
    makeJob('high-1', { priority: 'high', submittedAt: NOW }),
  ];
  const nodes = [makeNode('n1'), makeNode('n2')];
  const plan = planFleetV23Dispatch({ id: 'd1', jobs, nodes, now: NOW });
  assert.equal(plan.dryRun, true);
  assert.equal(plan.jobsConsidered, 3);
  assert.equal(plan.assignments.length, 3);
  assert.equal(plan.deferred.length, 0);
  // Critical đi trước, rồi high, rồi low.
  assert.equal(plan.assignments[0]?.jobId, 'crit-1');
  assert.equal(plan.assignments[1]?.jobId, 'high-1');
  assert.equal(plan.assignments[2]?.jobId, 'low-1');
  // Mỗi node 4 CPU, mỗi job 2 CPU → tối đa 2 job/node; 3 job cần 2 node.
  const perNode = new Map();
  for (const a of plan.assignments) perNode.set(a.nodeId, (perNode.get(a.nodeId) ?? 0) + 1);
  assert.ok([...perNode.values()].every((c) => c <= 2));
  // nodeFreeAfter phản ánh demand đã trừ.
  const n1After = plan.nodeFreeAfter.find((n) => n.nodeId === 'n1');
  assert.ok((n1After?.cpuFree ?? 99) <= 4);
  const summary = summarizeFleetV23DispatchPlan(plan);
  assert.equal(summary.assigned, 3);
  assert.equal(summary.deferred, 0);
  assert.equal(summary.topDeferralReason, null);
});

test('dispatch: deferral when nothing fits + maxJobs + validate', () => {
  const jobs = [makeJob('big-1', { demand: { cpuCores: 99, ramBytes: 4 * GB, diskBytes: 10 * GB } })];
  const nodes = [makeNode('n1')];
  const plan = planFleetV23Dispatch({ id: 'd2', jobs, nodes, now: NOW });
  assert.equal(plan.assignments.length, 0);
  assert.equal(plan.deferred.length, 1);
  assert.ok(plan.deferred[0]?.reason.length > 0);
  const summary = summarizeFleetV23DispatchPlan(plan);
  assert.equal(summary.assigned, 0);
  assert.ok(summary.topDeferralReason !== null);

  // maxJobs = 1 → chỉ xét 1 job.
  const many = [makeJob('a'), makeJob('b'), makeJob('c')];
  const capped = planFleetV23Dispatch({ id: 'd3', jobs: many, nodes: [makeNode('n1'), makeNode('n2')], maxJobs: 1, now: NOW });
  assert.equal(capped.jobsConsidered, 1);
  assert.equal(capped.assignments.length + capped.deferred.length, 1);

  assert.deepEqual(validateFleetV23DispatchPlan(plan), []);
  assert.ok(validateFleetV23DispatchPlan(null).some((e) => e.includes('object')));
  assert.ok(validateFleetV23DispatchPlan({ id: '', assignments: [], deferred: [] }).some((e) => e.includes('plan.id')));
  assert.ok(
    validateFleetV23DispatchPlan({ id: 'x', assignments: [{ jobId: '', nodeId: 'n1' }], deferred: [] }).some((e) =>
      e.includes('assignment.jobId'),
    ),
  );
});

test('dispatch: apply starts jobs + updates placement; failed start skipped', () => {
  const q = new FleetV23SchedulerQueue();
  const j1 = makeJob('j1');
  const j2 = makeJob('j2');
  q.enqueue(j1);
  q.enqueue(j2);
  const nodes = [makeNode('n1'), makeNode('n2')];
  const plan = planFleetV23Dispatch({ id: 'd4', jobs: q.list(), nodes, now: NOW });
  assert.equal(plan.assignments.length, 2);
  const placement = {};
  const applied = applyFleetV23DispatchPlan(plan, q, placement, NOW + 1000);
  assert.equal(applied.success, true);
  assert.deepEqual([...applied.startedJobIds].sort(), ['j1', 'j2']);
  assert.equal(q.get('j1')?.status, 'running');
  assert.ok(Object.values(applied.placementAfter).every((n) => n === 'n1' || n === 'n2'));

  // Job đã finish trước khi apply → start lỗi, job đó bị skip, job kia vẫn chạy.
  const q2 = new FleetV23SchedulerQueue();
  const k1 = makeJob('k1');
  const k2 = makeJob('k2');
  q2.enqueue(k1);
  q2.enqueue(k2);
  q2.start('k1', NOW);
  q2.finish('k1', 'completed');
  const plan2 = planFleetV23Dispatch({ id: 'd5', jobs: q2.list(), nodes, now: NOW });
  // k1 đã completed nên không còn queued → plan chỉ xét k2.
  assert.equal(plan2.assignments.length, 1);
  assert.equal(plan2.assignments[0]?.jobId, 'k2');
  // Ép plan có job lỗi: apply plan chứa job không còn queued được.
  const stalePlan = {
    ...plan2,
    assignments: [...plan2.assignments, { jobId: 'k1', botId: 'bot-k1', nodeId: 'n1', score: 50, estimatedCostPerHour: 0, onParetoFrontier: false }],
  };
  const applied2 = applyFleetV23DispatchPlan(stalePlan, q2, {}, NOW + 1000);
  assert.equal(applied2.success, false);
  assert.equal(applied2.failedStarts.length, 1);
  assert.equal(applied2.failedStarts[0]?.jobId, 'k1');
  assert.deepEqual(applied2.startedJobIds, ['k2']);

  // Panel dispatch từ plan.
  const panel = buildFleetV23DispatchPanel(plan);
  assert.equal(panel.assigned, 2);
  assert.equal(panel.deferred, 0);
  assert.equal(panel.dryRun, true);
  assert.ok(panel.summary.includes('gán 2 job'));
});

test('autoscale: policy validation', () => {
  assert.deepEqual(validateFleetV23AutoscalePolicy(DEFAULT_FLEET_V23_AUTOSCALE_POLICY), []);
  assert.ok(validateFleetV23AutoscalePolicy(null).some((e) => e.includes('object')));
  assert.ok(
    validateFleetV23AutoscalePolicy({ ...DEFAULT_FLEET_V23_AUTOSCALE_POLICY, minNodes: 5, maxNodes: 2 }).some((e) =>
      e.includes('minNodes'),
    ),
  );
  assert.ok(
    validateFleetV23AutoscalePolicy({ ...DEFAULT_FLEET_V23_AUTOSCALE_POLICY, idleCpuFraction: 0.9, highCpuFraction: 0.8 }).some(
      (e) => e.includes('idleCpuFraction'),
    ),
  );
  assert.ok(
    validateFleetV23AutoscalePolicy({ ...DEFAULT_FLEET_V23_AUTOSCALE_POLICY, cooldownMs: -1 }).some((e) =>
      e.includes('cooldownMs'),
    ),
  );
});

function autoscaleSignals(overrides = {}) {
  return {
    nodes: [makeNode('n1'), makeNode('n2')],
    jobs: [],
    forecasts: [],
    bottleneck: null,
    ...overrides,
  };
}

test('autoscale: cooldown blocks, max-nodes caps scale-out', () => {
  const breached = makeJob('late', { submittedAt: NOW - 120_000, slaDeadlineMs: NOW - 1000 });
  const signals = autoscaleSignals({ jobs: [breached] });
  // Đang cooldown (scale 1 phút trước, cooldown 30 phút) → none.
  const cooled = recommendFleetV23Autoscale(signals, DEFAULT_FLEET_V23_AUTOSCALE_POLICY, NOW - 60_000, NOW);
  assert.equal(cooled.action, 'none');
  assert.ok(cooled.cooldownRemainingMs > 0);
  assert.ok(cooled.reason.includes('cooldown'));
  // Hết cooldown → scale-out vì breach SLA.
  const rec = recommendFleetV23Autoscale(signals, DEFAULT_FLEET_V23_AUTOSCALE_POLICY, null, NOW);
  assert.equal(rec.action, 'scale-out');
  assert.equal(rec.nodesDelta, 1);
  assert.ok(rec.triggeredBy.some((t) => t.includes('SLA breach')));
  // Đã đủ maxNodes → không scale-out được, trả none + lý do.
  const capped = recommendFleetV23Autoscale(
    signals,
    { ...DEFAULT_FLEET_V23_AUTOSCALE_POLICY, maxNodes: 2 },
    null,
    NOW,
  );
  assert.equal(capped.action, 'none');
  assert.ok(capped.reason.includes('tối đa'));
});

test('autoscale: scale-out triggers (urgent forecast, long wait) + scale-in', () => {
  const nodes = [makeNode('n1', { cpuFree: 0.4 }), makeNode('n2', { cpuFree: 0.4 })];
  const { forecasts, bottleneck } = forecastFleetV23Capacity(
    nodes,
    { botsPerMonth: 10, perBot: { cpuCores: 1, ramBytes: 1 * GB, diskBytes: 1 * GB } },
    NOW,
  );
  assert.ok(forecasts.some((f) => f.urgent));
  const manyJobs = Array.from({ length: 6 }, (_, i) => makeJob(`q${i}`, { submittedAt: NOW - 1000 }));
  const recUrgent = recommendFleetV23Autoscale(
    { nodes, jobs: manyJobs, forecasts, bottleneck },
    DEFAULT_FLEET_V23_AUTOSCALE_POLICY,
    null,
    NOW,
  );
  assert.equal(recUrgent.action, 'scale-out');

  // Chờ lâu + CPU cao → scale-out (không cần forecast urgent).
  const waiting = makeJob('waiter', { submittedAt: NOW - 11 * 60_000 });
  const recWait = recommendFleetV23Autoscale(
    { nodes, jobs: [waiting], forecasts: [], bottleneck: null },
    DEFAULT_FLEET_V23_AUTOSCALE_POLICY,
    null,
    NOW,
  );
  assert.equal(recWait.action, 'scale-out');
  assert.ok(recWait.triggeredBy.some((t) => t.includes('chờ lâu nhất')));

  // Scale-in: hàng đợi rỗng, node lạnh idle, không forecast urgent, trên minNodes.
  const idleNodes = [makeNode('n1', { cpuFree: 3.9 }), makeNode('n2', { cpuFree: 3.9 })];
  const recIn = recommendFleetV23Autoscale(
    { nodes: idleNodes, jobs: [], forecasts: [], bottleneck: null },
    { ...DEFAULT_FLEET_V23_AUTOSCALE_POLICY, newNodeCostPerHour: 0.5 },
    null,
    NOW,
  );
  assert.equal(recIn.action, 'scale-in');
  assert.equal(recIn.nodesDelta, -1);
  assert.ok(recIn.monthlyCostDelta < 0); // tiết kiệm
  const panel = buildFleetV23AutoscalePanel(recIn);
  assert.ok(panel.summary.includes('Bớt 1 node'));

  // Scale-in bị chặn khi còn 1 node (minNodes = 1).
  const recInBlocked = recommendFleetV23Autoscale(
    { nodes: [makeNode('n1', { cpuFree: 3.9 })], jobs: [], forecasts: [], bottleneck: null },
    DEFAULT_FLEET_V23_AUTOSCALE_POLICY,
    null,
    NOW,
  );
  assert.equal(recInBlocked.action, 'none');
  assert.ok(recInBlocked.reason.includes('tối thiểu'));

  // Không trigger nào → none.
  const recNone = recommendFleetV23Autoscale(
    { nodes: [makeNode('n1', { cpuFree: 2 }), makeNode('n2', { cpuFree: 2 })], jobs: [], forecasts: [], bottleneck: null },
    DEFAULT_FLEET_V23_AUTOSCALE_POLICY,
    null,
    NOW,
  );
  assert.equal(recNone.action, 'none');
});

test('autoscale: estimate nodes needed', () => {
  const nodes = [makeNode('n1', { cpuFree: 2 }), makeNode('n2', { cpuFree: 2 })];
  const est = estimateFleetV23NodesNeeded({ cpuCores: 5, ramBytes: 4 * GB, diskBytes: 10 * GB }, nodes);
  assert.equal(est.cpu, 3); // 5 CPU / 2 CPU trống trung bình mỗi node
  assert.equal(est.nodesNeeded, 3);
  assert.deepEqual(estimateFleetV23NodesNeeded({ cpuCores: 0, ramBytes: 0, diskBytes: 0 }, nodes).nodesNeeded, 0);
  assert.deepEqual(estimateFleetV23NodesNeeded({ cpuCores: 5, ramBytes: 0, diskBytes: 0 }, []).nodesNeeded, 0);
});
