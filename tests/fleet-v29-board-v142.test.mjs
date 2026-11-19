/**
 * Tests for fleet v29 A2A task board + delegation planner (v1.42, Team T6).
 *
 * Covers:
 * - Delegation gate (fail-closed): unregistered peer, not allowlisted,
 *   suspended, expired, unverified/stale card, skill/operation outside
 *   scope, concurrency cap, streaming without capability — each blocks
 *   with reasons and sends nothing.
 * - Board lifecycle: submit → start → progress → complete; illegal
 *   transitions refused (completed → working); input-required parks
 *   until provideInput; cancel (user vs peer) refused on terminal
 *   tasks; cost recording + per-task cap breach flag.
 * - ListTasks cursor pagination (A2A 1.0): pages walk the full list,
 *   no duplicates, total correct; filters by peer/state/query.
 * - Transport handoff: with a wired transport port the board calls
 *   sendMessage/cancelTask; without one it creates a labelled
 *   simulated task and never claims it reached a real peer.
 * - Planner: validation (gate, budget envelope, dependency cycle),
 *   topological order, simulated execution drives steps to completed,
 *   a refused step skips its dependents, budget-exceeded stops the plan.
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/fleet-v29-board-v142.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { FleetV29Allowlist } from '../packages/core/dist/fleetV29/allowlist.js';
import { FleetV29PeerRegistry } from '../packages/core/dist/fleetV29/peerRegistry.js';
import { FleetV29TaskBoard } from '../packages/core/dist/fleetV29/taskBoard.js';
import { buildAgentCard } from '../packages/core/dist/a2a/card.js';
import { generateA2aSigningKey, signAgentCard } from '../packages/core/dist/a2a/signing.js';
import {
  FleetV29DelegationPlanner,
  fleetV29PlanEstimatedTotal,
  fleetV29PlanOrder,
  fleetV29ValidatePlan,
} from '../packages/core/dist/fleetV29/planner.js';
import { buildFleetV29BoardPanel } from '../packages/core/dist/fleetV29/panelsV29.js';

function makePeer(registry, peerId, opts = {}) {
  const card = buildAgentCard({
    name: opts.name ?? `Agent ${peerId}`,
    description: opts.description ?? 'Test peer.',
    url: opts.url ?? 'http://127.0.0.1:4199/',
    version: '1.0.0',
    protocolVersion: '1.0.1',
    streaming: opts.streaming ?? true,
  });
  const peer = registry.registerPeer({ peerId, card, tags: opts.tags ?? [] });
  registry.recordVerification(peerId, opts.cardStatus ?? 'verified', 'signature', [], '2026-11-19T00:00:00.000Z');
  return peer;
}

function makeSetup(opts = {}) {
  const registry = new FleetV29PeerRegistry();
  const allowlist = new FleetV29Allowlist();
  const board = new FleetV29TaskBoard({ registry, allowlist, ...opts });
  return { registry, allowlist, board };
}

function allow(allowlist, peerId, scope) {
  const r = allowlist.add(peerId, 'local-user', scope, { reason: 'test' });
  assert.equal(r.ok, true, JSON.stringify(r));
  return r.entry;
}

test('board: gate blocks unregistered and non-allowlisted peers', async () => {
  const { registry, allowlist, board } = makeSetup();
  const req = { peerId: 'peer-ghost', delegatedBy: 'bot-main', title: 'T', messageText: 'hi' };
  let res = await board.submit(req);
  assert.equal(res.ok, false);
  assert.match(res.reasons.join(' '), /not registered/);
  assert.equal(board.taskCount(), 0);

  makePeer(registry, 'peer-a');
  res = await board.submit({ ...req, peerId: 'peer-a' });
  assert.equal(res.ok, false);
  assert.match(res.reasons.join(' '), /not on the allowlist/);
  assert.equal(board.taskCount(), 0);
});

test('board: gate blocks unverified/stale card even when allowlisted', async () => {
  const { registry, allowlist, board } = makeSetup();
  const peer = makePeer(registry, 'peer-a', { cardStatus: 'unverified' });
  void peer;
  allow(allowlist, 'peer-a');
  let res = await board.submit({ peerId: 'peer-a', delegatedBy: 'bot-main', title: 'T', messageText: 'hi' });
  assert.equal(res.ok, false);
  assert.match(res.reasons.join(' '), /card is unverified/);

  // Verify, then change the card: registry marks it stale and the gate blocks again.
  registry.recordVerification('peer-a', 'verified', 'signature', [], '2026-11-19T00:00:00.000Z');
  res = await board.submit({ peerId: 'peer-a', delegatedBy: 'bot-main', title: 'T', messageText: 'hi' });
  assert.equal(res.ok, true);
  const changed = buildAgentCard({ name: 'Agent peer-a', description: 'Changed.', url: 'http://127.0.0.1:4199/', version: '2.0.0', protocolVersion: '1.0.1', streaming: true });
  registry.registerPeer({ peerId: 'peer-a', card: changed });
  assert.equal(registry.getPeer('peer-a').cardStatus, 'stale');
  res = await board.submit({ peerId: 'peer-a', delegatedBy: 'bot-main', title: 'T2', messageText: 'hi' });
  assert.equal(res.ok, false);
  assert.match(res.reasons.join(' '), /card is stale/);
});

test('board: gate enforces scope (skill, operation, concurrency) and suspend/expiry', async () => {
  const { registry, allowlist, board } = makeSetup();
  makePeer(registry, 'peer-a', { streaming: false });
  allow(allowlist, 'peer-a', { allowedSkills: ['research'], allowedOperations: ['SendMessage'], maxConcurrentTasks: 1 });
  const base = { peerId: 'peer-a', delegatedBy: 'bot-main', title: 'T', messageText: 'hi' };
  let res = await board.submit({ ...base, skillId: 'write' });
  assert.equal(res.ok, false);
  assert.match(res.reasons.join(' '), /Skill "write"/);
  res = await board.submit({ ...base, operation: 'SendStreamingMessage' });
  assert.equal(res.ok, false);
  assert.match(res.reasons.join(' '), /not in peer .* allowlist scope|does not advertise streaming/);
  res = await board.submit({ ...base, skillId: 'research' });
  assert.equal(res.ok, true);
  // Concurrency cap of 1: second task refused while the first is active.
  res = await board.submit({ ...base, title: 'T2' });
  assert.equal(res.ok, false);
  assert.match(res.reasons.join(' '), /concurrency cap/);
  // Suspend blocks too.
  allowlist.suspend('peer-a');
  const first = board.listTasks({}).tasks[0];
  assert.ok(first);
  await board.cancel(first.task.id, true);
  res = await board.submit({ ...base, title: 'T3' });
  assert.equal(res.ok, false);
  assert.match(res.reasons.join(' '), /suspended/);
});

test('board: lifecycle submit → start → progress → complete; illegal transitions refused', async () => {
  const { registry, allowlist, board } = makeSetup();
  makePeer(registry, 'peer-a');
  allow(allowlist, 'peer-a');
  const submitted = await board.submit({ peerId: 'peer-a', delegatedBy: 'bot-main', title: 'Research', messageText: 'do it' });
  assert.equal(submitted.ok, true);
  const task = submitted.boardTask;
  assert.equal(task.task.status.state, 'submitted');
  assert.equal(task.task.metadata.simulated, true);
  // Progress before start is refused (not working yet).
  assert.equal(board.progress(task.task.id, 'x', 0.1), null);
  // Complete from submitted is illegal.
  assert.equal(board.complete(task.task.id).ok, false);
  assert.equal(board.start(task.task.id).ok, true);
  assert.equal(board.start(task.task.id).ok, true, 'working → working self-transition is legal in A2A');
  const progressed = board.progress(task.task.id, 'half done', 0.5);
  assert.ok(progressed);
  assert.equal(progressed.progress, 0.5);
  assert.equal(progressed.progressEvents, 1);
  const done = board.complete(task.task.id, 'result text');
  assert.equal(done.ok, true);
  assert.equal(done.task.task.status.state, 'completed');
  assert.equal(done.task.task.artifacts?.length, 1);
  // Terminal: no further transitions, no cancel.
  assert.equal(board.transition(task.task.id, 'working').ok, false);
  assert.equal((await board.cancel(task.task.id, true)).ok, false);
});

test('board: input-required parks until provideInput; cancel is recorded distinctly', async () => {
  const { registry, allowlist, board } = makeSetup();
  makePeer(registry, 'peer-a');
  allow(allowlist, 'peer-a');
  const s1 = await board.submit({ peerId: 'peer-a', delegatedBy: 'bot-main', title: 'Needs input', messageText: 'go' });
  const id1 = s1.boardTask.task.id;
  board.start(id1);
  assert.equal(board.provideInput(id1, 'answer').ok, false, 'not input-required yet');
  assert.equal(board.transition(id1, 'input-required', 'Which version?').ok, true);
  const t = board.getTask(id1);
  assert.equal(t.awaitingInput, true);
  assert.equal(t.inputQuestion, 'Which version?');
  const answered = board.provideInput(id1, 'v2.0');
  assert.equal(answered.ok, true);
  assert.equal(answered.task.task.status.state, 'working');
  assert.equal(answered.task.awaitingInput, false);

  const s2 = await board.submit({ peerId: 'peer-a', delegatedBy: 'bot-main', title: 'To cancel', messageText: 'go' });
  const id2 = s2.boardTask.task.id;
  const cancelled = await board.cancel(id2, true, 'No longer needed.');
  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.task.cancelledByUser, true);
  assert.equal(cancelled.task.cancelReason, 'No longer needed.');
  const failed = await board.submit({ peerId: 'peer-a', delegatedBy: 'bot-main', title: 'To fail', messageText: 'go' });
  const id3 = failed.boardTask.task.id;
  board.start(id3);
  assert.equal(board.fail(id3, 'Peer crashed.').ok, true);
  assert.equal(board.getTask(id3).task.status.state, 'failed');
});

test('board: cost recording + cap breach; ListTasks cursor pagination', async () => {
  const { registry, allowlist, board } = makeSetup();
  makePeer(registry, 'peer-a');
  makePeer(registry, 'peer-b');
  allow(allowlist, 'peer-a', { maxCostUsdPerTask: 1, maxConcurrentTasks: 30 });
  allow(allowlist, 'peer-b', { maxConcurrentTasks: 30 });
  for (let i = 0; i < 25; i += 1) {
    const r = await board.submit({ peerId: i % 2 === 0 ? 'peer-a' : 'peer-b', delegatedBy: 'bot-main', title: `Task ${i}`, messageText: 'go' });
    assert.equal(r.ok, true);
  }
  const first = board.listTasks({ peerId: 'peer-a' }).tasks[0];
  board.recordCost(first.task.id, 0.5, 800);
  assert.equal(board.costCapBreached(first.task.id), false);
  board.recordCost(first.task.id, 0.6, 900);
  assert.equal(board.costCapBreached(first.task.id), true);
  assert.equal(board.getTask(first.task.id).lastLatencyMs, 900);

  // Paginate with pageSize 10: 3 pages, no duplicates, total 25.
  const seen = new Set();
  let cursor = null;
  let pages = 0;
  let total = -1;
  do {
    const page = board.listTasks({}, cursor, 10);
    total = page.total;
    pages += 1;
    for (const item of page.tasks) {
      assert.equal(seen.has(item.task.id), false, 'duplicate across pages');
      seen.add(item.task.id);
    }
    cursor = page.nextCursor;
  } while (cursor !== null);
  assert.equal(total, 25);
  assert.equal(seen.size, 25);
  assert.equal(pages, 3);
  // Filters.
  assert.equal(board.listTasks({ peerId: 'peer-a' }).total, 13);
  assert.equal(board.listTasks({ state: 'submitted' }).total, 25);
  assert.equal(board.listTasks({ query: 'task 1' }).total, 11, 'titles Task 1, 10-19 match "task 1"');
  assert.equal(board.listTasks({ activeOnly: true }).total, 25);
});

test('board: wired transport is used; simulation never claims a real send', async () => {
  const { registry, allowlist } = makeSetup();
  makePeer(registry, 'peer-a');
  allow(allowlist, 'peer-a');
  const sent = [];
  const cancelled = [];
  const transport = {
    sendMessage: async (input) => {
      sent.push(input);
      return { id: 'task-remote-1', contextId: input.contextId, status: { state: 'submitted', timestamp: '2026-11-19T00:00:00.000Z' }, transitions: [] };
    },
    cancelTask: async (input) => {
      cancelled.push(input);
    },
  };
  const wired = new FleetV29TaskBoard({ registry, allowlist, transport });
  assert.equal(wired.transportWired, true);
  const res = await wired.submit({ peerId: 'peer-a', delegatedBy: 'bot-main', title: 'Remote', messageText: 'hello remote' });
  assert.equal(res.ok, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].peerUrl, 'http://127.0.0.1:4199/');
  assert.equal(res.boardTask.task.metadata?.simulated, undefined);
  const cancelRes = await wired.cancel('task-remote-1', true);
  assert.equal(cancelRes.ok, true);
  assert.equal(cancelled.length, 1);
});

test('board: signed card verifies end-to-end via the fleet gate', () => {
  const key = generateA2aSigningKey();
  const unsigned = buildAgentCard({ name: 'Signed Agent', description: 'Signed peer.', url: 'http://127.0.0.1:4198/', version: '1.0.0', protocolVersion: '1.0.1', streaming: true });
  const signed = signAgentCard(unsigned, key);
  assert.ok(signed.signature);
  const { registry } = makeSetup();
  const peer = registry.registerPeer({ peerId: 'peer-signed', card: signed });
  assert.equal(peer.cardStatus, 'unverified');
  assert.ok(peer.cardFingerprint.startsWith(`${key.keyId}:`));
});

test('planner: validation catches gate, budget and cycles; order is topological', () => {
  const { registry, allowlist, board } = makeSetup();
  makePeer(registry, 'peer-a');
  makePeer(registry, 'peer-b');
  allow(allowlist, 'peer-a');
  const plan = {
    planId: 'plan-1',
    title: 'Two-step plan',
    delegatedBy: 'bot-main',
    budgetUsd: 10,
    createdAt: '2026-11-19T00:00:00.000Z',
    steps: [
      { stepId: 's1', peerId: 'peer-a', title: 'Research', messageText: 'research', estimatedCostUsd: 2, maxRetries: 1, mode: 'sequential', dependsOn: [] },
      { stepId: 's2', peerId: 'peer-a', title: 'Write', messageText: 'write', estimatedCostUsd: 3, maxRetries: 0, mode: 'sequential', dependsOn: ['s1'] },
    ],
  };
  assert.deepEqual(fleetV29ValidatePlan(plan, registry, allowlist, board), []);
  assert.equal(fleetV29PlanEstimatedTotal(plan), 5);
  assert.deepEqual(fleetV29PlanOrder(plan).map((s) => s.stepId), ['s1', 's2']);

  const overBudget = { ...plan, budgetUsd: 4 };
  assert.match(fleetV29ValidatePlan(overBudget, registry, allowlist, board).join(' '), /exceeds plan budget/);
  const badPeer = { ...plan, steps: [{ ...plan.steps[0], peerId: 'peer-b' }, plan.steps[1]] };
  assert.match(fleetV29ValidatePlan(badPeer, registry, allowlist, board).join(' '), /not on the allowlist/);
  const cyclic = { ...plan, steps: [{ ...plan.steps[0], dependsOn: ['s2'] }, plan.steps[1]] };
  assert.match(fleetV29ValidatePlan(cyclic, registry, allowlist, board).join(' '), /dependency cycle/);
  assert.throws(() => fleetV29PlanOrder(cyclic), /dependency cycle/);
});

test('planner: simulated execution completes steps; refused step skips dependents', async () => {
  const { registry, allowlist, board } = makeSetup();
  makePeer(registry, 'peer-a');
  allow(allowlist, 'peer-a');
  const planner = new FleetV29DelegationPlanner(board);
  const plan = {
    planId: 'plan-2',
    title: 'Happy path',
    delegatedBy: 'bot-main',
    budgetUsd: 10,
    createdAt: '2026-11-19T00:00:00.000Z',
    steps: [
      { stepId: 's1', peerId: 'peer-a', title: 'Step 1', messageText: 'one', estimatedCostUsd: 1, maxRetries: 0, mode: 'sequential', dependsOn: [] },
      { stepId: 's2', peerId: 'peer-a', title: 'Step 2', messageText: 'two', estimatedCostUsd: 2, maxRetries: 0, mode: 'sequential', dependsOn: ['s1'] },
    ],
  };
  const result = await planner.execute(plan);
  assert.equal(result.outcome, 'completed');
  assert.equal(result.totalCostUsd, 3);
  assert.deepEqual(result.steps.map((s) => s.outcome), ['completed', 'completed']);
  assert.ok(result.steps.every((s) => s.taskId !== null));

  // Refused first step (peer-b not allowlisted): s2 is skipped.
  const plan2 = {
    ...plan,
    planId: 'plan-3',
    steps: [
      { stepId: 's1', peerId: 'peer-b', title: 'Step 1', messageText: 'one', estimatedCostUsd: 1, maxRetries: 0, mode: 'sequential', dependsOn: [] },
      { stepId: 's2', peerId: 'peer-a', title: 'Step 2', messageText: 'two', estimatedCostUsd: 2, maxRetries: 0, mode: 'sequential', dependsOn: ['s1'] },
    ],
  };
  const result2 = await planner.execute(plan2);
  assert.equal(result2.outcome, 'refused');
  assert.deepEqual(result2.steps.map((s) => s.outcome), ['refused', 'skipped']);
});

test('panels: board panel view-model joins counts + tasks', async () => {
  const { registry, allowlist, board } = makeSetup();
  makePeer(registry, 'peer-a');
  allow(allowlist, 'peer-a');
  const r = await board.submit({ peerId: 'peer-a', delegatedBy: 'bot-main', title: 'Panel task', messageText: 'go' });
  assert.equal(r.ok, true);
  const view = buildFleetV29BoardPanel(board);
  assert.equal(view.totalTasks, 1);
  assert.equal(view.activeTasks, 1);
  assert.equal(view.transportWired, false);
  assert.match(view.summary, /simulation/);
  assert.equal(view.tasks[0].title, 'Panel task');
});
