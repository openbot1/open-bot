/**
 * Tests for fleet v30 A2A task board v2 + peer groups (v1.44, Team T6).
 *
 * Covers:
 * - Board v2 metadata: lazy creation, priority, deadline + SLA
 *   states (on-track / at-risk / overdue / no-deadline).
 * - Assignment: reassign a submitted task re-runs the v29 gate
 *   (unregistered / unallowlisted peer refused, working task
 *   refused, same-peer refused); assignment history + timeline.
 * - Dependencies: add/remove, blocked flag, ready list excludes
 *   blocked tasks, cycles refused (direct + transitive), self-block
 *   refused.
 * - Deadlines/SLA: sweepOverdue flags + escalates once (second
 *   sweep does not re-escalate).
 * - Retry: failed task retries within budget (new board task,
 *   counter + timeline), retry of a non-failed task refused,
 *   exhausted budget refused, retry onto a de-allowlisted peer
 *   refused by the gate.
 * - Saved views: create/apply/delete, invalid state/priority
 *   refused, filters (peer/state/priority/query/active/overdue).
 * - Kanban: default columns, setKanban requires every A2A state
 *   exactly once, kanbanBoard groups tasks.
 * - Bulk: bulkCancel (applies + per-task refusals), bulkReassign,
 *   bulkSetPriority.
 * - Peer groups: create/rename/delete, add/remove peer (group tag
 *   mirrored onto the peer), groupsForPeer, peersInGroup,
 *   removePeerFromAllGroups.
 * - Capability scoring: skill match drives the score, streaming
 *   required without streaming = 0, unverified card caps the
 *   score, pickPeer returns the best, pickFailover excludes the
 *   failed peer, discovery probes feed v29 health samples.
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/fleet-v30-board-groups-v144.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { FleetV29Allowlist } from '../packages/core/dist/fleetV29/allowlist.js';
import { FleetV29PeerRegistry } from '../packages/core/dist/fleetV29/peerRegistry.js';
import { FleetV29TaskBoard } from '../packages/core/dist/fleetV29/taskBoard.js';
import { buildAgentCard } from '../packages/core/dist/a2a/card.js';
import { FleetV30BoardV2 } from '../packages/core/dist/fleetV30/boardV2.js';
import { FleetV30PeerGroups, fleetV30GroupTag } from '../packages/core/dist/fleetV30/peerGroups.js';

const NOW = '2026-11-19T05:00:00.000Z';

function makePeer(registry, peerId, opts = {}) {
  const card = buildAgentCard({
    name: `Agent ${peerId}`,
    description: 'Test peer.',
    url: opts.url ?? 'http://127.0.0.1:4199/',
    version: '1.0.0',
    protocolVersion: '1.0.1',
    streaming: opts.streaming ?? true,
    skills: (opts.skills ?? []).map((id) => ({ id, name: id, description: `${id} skill.` })),
  });
  const peer = registry.registerPeer({ peerId, card, tags: opts.tags ?? [] });
  registry.recordVerification(peerId, opts.cardStatus ?? 'verified', 'signature', [], NOW);
  return peer;
}

function makeSetup() {
  const registry = new FleetV29PeerRegistry();
  const allowlist = new FleetV29Allowlist();
  const board = new FleetV29TaskBoard({ registry, allowlist, nowIso: () => NOW });
  const boardV2 = new FleetV30BoardV2({ board, registry, allowlist, nowIso: () => NOW });
  const groups = new FleetV30PeerGroups({ registry, board });
  return { registry, allowlist, board, boardV2, groups };
}

async function makeTask(board, peerId, title = 'Task') {
  const result = await board.submit({
    peerId,
    delegatedBy: 'local-user',
    title,
    messageText: `Do: ${title}`,
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.boardTask.task.id;
}

function allowlistPeer(setup, peerId, maxConcurrent) {
  const added = setup.allowlist.add(peerId, 'admin', maxConcurrent !== undefined ? { maxConcurrentTasks: maxConcurrent } : undefined);
  assert.equal(added.ok, true, JSON.stringify(added));
}

/* ---------------- board v2 metadata + SLA ---------------- */

test('board v2 meta: lazy creation, priority, deadline + SLA states', async () => {
  const s = makeSetup();
  makePeer(s.registry, 'peer-1');
  allowlistPeer(s, 'peer-1');
  const id = await makeTask(s.board, 'peer-1', 'Alpha');
  const view = s.boardV2.viewTask(id);
  assert.ok(view);
  assert.equal(view.meta.priority, 'normal');
  assert.equal(view.slaState, 'no-deadline');
  assert.equal(view.blocked, false);
  assert.equal(view.meta.assignmentHistory.length, 1);
  assert.equal(view.meta.timeline[0].kind, 'created');

  const set = s.boardV2.setPriority(id, 'urgent', 'admin');
  assert.equal(set.ok, true);
  assert.equal(set.ok && set.view.meta.priority, 'urgent');
  assert.equal(s.boardV2.setPriority(id, 'bogus').ok, false);
  assert.equal(s.boardV2.setPriority('nope', 'high', 'admin').ok, false);

  // Due in the past -> overdue.
  const past = s.boardV2.setDue(id, '2026-11-19T04:00:00.000Z', null, 'admin');
  assert.equal(past.ok, true);
  assert.equal(s.boardV2.viewTask(id)?.slaState, 'overdue');
  // Due in 10 minutes with a 60-minute SLA -> at-risk (under 25% left).
  const risk = s.boardV2.setDue(id, '2026-11-19T05:10:00.000Z', 60, 'admin');
  assert.equal(risk.ok, true);
  assert.equal(s.boardV2.viewTask(id)?.slaState, 'at-risk');
  // Due far away -> on-track.
  s.boardV2.setDue(id, '2026-11-19T09:00:00.000Z', 60, 'admin');
  assert.equal(s.boardV2.viewTask(id)?.slaState, 'on-track');
  // Clear -> no-deadline.
  s.boardV2.setDue(id, null, null, 'admin');
  assert.equal(s.boardV2.viewTask(id)?.slaState, 'no-deadline');
  assert.equal(s.boardV2.setDue(id, 'not-a-date', null, 'admin').ok, false);
  assert.equal(s.boardV2.setDue(id, null, -5, 'admin').ok, false);
});

/* ---------------- reassignment ---------------- */

test('board v2 reassign: gate re-runs, working tasks refused, history kept', async () => {
  const s = makeSetup();
  makePeer(s.registry, 'peer-1');
  makePeer(s.registry, 'peer-2');
  allowlistPeer(s, 'peer-1');
  allowlistPeer(s, 'peer-2');
  const id = await makeTask(s.board, 'peer-1', 'Move me');
  const moved = s.boardV2.reassign(id, 'peer-2', 'admin');
  assert.equal(moved.ok, true);
  if (moved.ok) {
    assert.equal(moved.view.boardTask.peerId, 'peer-2');
    assert.deepEqual(moved.view.meta.assignmentHistory, ['peer-1', 'peer-2']);
    assert.ok(moved.view.meta.timeline.some((e) => e.kind === 'reassigned'));
  }
  assert.equal(s.boardV2.reassign(id, 'peer-2', 'admin').ok, false); // same peer
  assert.equal(s.boardV2.reassign(id, 'peer-ghost', 'admin').ok, false); // unregistered
  makePeer(s.registry, 'peer-3');
  assert.equal(s.boardV2.reassign(id, 'peer-3', 'admin').ok, false); // not allowlisted
  // Working tasks cannot move.
  const started = s.board.start(id);
  assert.equal(started.ok, true);
  const working = s.boardV2.reassign(id, 'peer-1', 'admin');
  assert.equal(working.ok, false);
  if (!working.ok) assert.match(working.reasons[0], /only submitted tasks/);
  assert.equal(s.boardV2.reassign('nope', 'peer-1', 'admin').ok, false);
});

/* ---------------- dependencies ---------------- */

test('board v2 dependencies: blocked, ready list, cycles refused', async () => {
  const s = makeSetup();
  makePeer(s.registry, 'peer-1');
  allowlistPeer(s, 'peer-1');
  const a = await makeTask(s.board, 'peer-1', 'A');
  const b = await makeTask(s.board, 'peer-1', 'B');
  const c = await makeTask(s.board, 'peer-1', 'C');
  assert.equal(s.boardV2.addDependency(b, a, 'admin').ok, true);
  assert.equal(s.boardV2.viewTask(b)?.blocked, true);
  assert.equal(s.boardV2.viewTask(a)?.blocked, false);
  assert.ok(!s.boardV2.readyTasks().some((t) => t.boardTask.task.id === b));
  assert.ok(s.boardV2.readyTasks().some((t) => t.boardTask.task.id === a));
  assert.ok(s.boardV2.readyTasks().some((t) => t.boardTask.task.id === c));
  // Self-block + direct cycle + transitive cycle refused.
  assert.equal(s.boardV2.addDependency(a, a, 'admin').ok, false);
  assert.equal(s.boardV2.addDependency(a, b, 'admin').ok, false);
  assert.equal(s.boardV2.addDependency(c, b, 'admin').ok, true);
  assert.equal(s.boardV2.addDependency(a, c, 'admin').ok, false); // a->c->b->a
  assert.equal(s.boardV2.addDependency(b, a, 'admin').ok, false); // duplicate
  assert.equal(s.boardV2.addDependency(b, 'nope', 'admin').ok, false);
  // Complete A: B unblocks (C still blocked by B).
  assert.equal(s.board.start(a).ok, true);
  assert.equal(s.board.complete(a).ok, true);
  assert.equal(s.boardV2.viewTask(b)?.blocked, false);
  assert.equal(s.boardV2.viewTask(c)?.blocked, true);
  // Remove the edge: C unblocks too.
  assert.equal(s.boardV2.removeDependency(c, b, 'admin').ok, true);
  assert.equal(s.boardV2.viewTask(c)?.blocked, false);
  assert.equal(s.boardV2.removeDependency(c, b, 'admin').ok, false);
});

/* ---------------- overdue sweep + retry ---------------- */

test('board v2 sweepOverdue escalates once; retry honours budget + gate', async () => {
  const s = makeSetup();
  makePeer(s.registry, 'peer-1');
  allowlistPeer(s, 'peer-1', 10);
  const id = await makeTask(s.board, 'peer-1', 'Late');
  s.boardV2.setDue(id, '2026-11-19T04:00:00.000Z', 30, 'admin');
  const first = s.boardV2.sweepOverdue('system');
  assert.deepEqual(first.overdue, [id]);
  assert.deepEqual(first.escalated, [id]);
  assert.equal(s.boardV2.viewTask(id)?.meta.escalated, true);
  const second = s.boardV2.sweepOverdue('system');
  assert.deepEqual(second.overdue, [id]);
  assert.deepEqual(second.escalated, []); // not re-escalated

  // Retry: fail the task, retry within budget.
  const failId = await makeTask(s.board, 'peer-1', 'Flaky');
  assert.equal(s.board.start(failId).ok, true);
  assert.equal(s.board.fail(failId, 'boom').ok, true);
  assert.equal((await s.boardV2.retryFailed(failId, 'admin')).ok, true);
  const retried = await s.boardV2.retryFailed(failId, 'admin');
  assert.equal(retried.ok, true);
  if (retried.ok) {
    assert.notEqual(retried.newTaskId, failId);
    assert.equal(s.boardV2.viewTask(failId)?.meta.retryCount, 2);
    assert.equal(s.boardV2.viewTask(retried.newTaskId)?.meta.maxRetries, 2);
  }
  // Budget exhausted (default maxRetries 2).
  assert.equal((await s.boardV2.retryFailed(failId, 'admin')).ok, false);
  // Retry of a non-failed task refused.
  assert.equal((await s.boardV2.retryFailed(id, 'admin')).ok, false);
  // Retry onto a de-allowlisted peer is refused by the gate.
  const doomed = await makeTask(s.board, 'peer-1', 'Doomed');
  assert.equal(s.board.start(doomed).ok, true);
  assert.equal(s.board.fail(doomed, 'boom').ok, true);
  assert.equal(s.allowlist.remove('peer-1').ok, true);
  assert.equal((await s.boardV2.retryFailed(doomed, 'admin')).ok, false);
  // Retry policy validation.
  assert.equal(s.boardV2.setRetryPolicy(id, -1, 100).ok, false);
  assert.equal(s.boardV2.setRetryPolicy(id, 1, -1).ok, false);
  assert.equal(s.boardV2.setRetryPolicy(id, 0, 0).ok, true);
});

/* ---------------- saved views + kanban + bulk ---------------- */

test('board v2 views: filters, invalid values refused, delete', async () => {
  const s = makeSetup();
  makePeer(s.registry, 'peer-1');
  makePeer(s.registry, 'peer-2');
  allowlistPeer(s, 'peer-1');
  allowlistPeer(s, 'peer-2');
  const urgent = await makeTask(s.board, 'peer-1', 'Urgent fix');
  const normal = await makeTask(s.board, 'peer-2', 'Routine');
  s.boardV2.setPriority(urgent, 'urgent', 'admin');
  assert.equal(s.boardV2.createView({ name: '', createdBy: 'admin' }).ok, false);
  assert.equal(s.boardV2.createView({ name: 'Bad', createdBy: 'admin', state: 'bogus' }).ok, false);
  assert.equal(s.boardV2.createView({ name: 'Bad', createdBy: 'admin', priority: 'bogus' }).ok, false);
  const created = s.boardV2.createView({ name: 'Urgent', createdBy: 'admin', priority: 'urgent' });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const applied = s.boardV2.applyView(created.view.viewId);
  assert.equal(applied.ok, true);
  if (applied.ok) {
    assert.deepEqual(applied.tasks.map((t) => t.boardTask.task.id), [urgent]);
  }
  const byPeer = s.boardV2.createView({ name: 'P2', createdBy: 'admin', peerId: 'peer-2' });
  assert.equal(byPeer.ok, true);
  if (byPeer.ok) {
    const got = s.boardV2.applyView(byPeer.view.viewId);
    assert.equal(got.ok, true);
    if (got.ok) assert.deepEqual(got.tasks.map((t) => t.boardTask.task.id), [normal]);
  }
  const byQuery = s.boardV2.createView({ name: 'Q', createdBy: 'admin', query: 'routine' });
  assert.equal(byQuery.ok, true);
  if (byQuery.ok) {
    const got = s.boardV2.applyView(byQuery.view.viewId);
    assert.equal(got.ok, true);
    if (got.ok) assert.deepEqual(got.tasks.map((t) => t.boardTask.task.id), [normal]);
  }
  assert.equal(s.boardV2.applyView('view-nope').ok, false);
  assert.equal(s.boardV2.deleteView(created.view.viewId), true);
  assert.equal(s.boardV2.applyView(created.view.viewId).ok, false);
  assert.equal(s.boardV2.deleteView(created.view.viewId), false);
  assert.equal(s.boardV2.listViews().length, 2);
});

test('board v2 kanban: defaults group tasks; setKanban needs every state once', async () => {
  const s = makeSetup();
  makePeer(s.registry, 'peer-1');
  allowlistPeer(s, 'peer-1');
  const id = await makeTask(s.board, 'peer-1', 'K');
  const kanban = s.boardV2.kanbanBoard();
  assert.deepEqual(kanban.map((c) => c.column.columnId), ['queued', 'working', 'done']);
  assert.equal(kanban[0].tasks.length, 1);
  assert.equal(kanban[0].tasks[0].boardTask.task.id, id);
  assert.equal(s.board.start(id).ok, true);
  assert.equal(s.boardV2.kanbanBoard()[1].tasks.length, 1);
  const bad = s.boardV2.setKanban([
    { columnId: 'a', title: 'A', states: ['submitted'] },
    { columnId: 'b', title: 'B', states: ['submitted', 'working'] },
  ]);
  assert.equal(bad.ok, false); // duplicate submitted + missing states
  const good = s.boardV2.setKanban([
    { columnId: 'todo', title: 'To do', states: ['submitted', 'rejected'] },
    { columnId: 'doing', title: 'Doing', states: ['working', 'input-required', 'auth-required'] },
    { columnId: 'over', title: 'Over', states: ['completed', 'failed', 'cancelled'] },
  ]);
  assert.equal(good.ok, true);
  assert.equal(s.boardV2.getKanban().length, 3);
});

test('board v2 export: NDJSON lines with meta, filterable by state', async () => {
  const s = makeSetup();
  makePeer(s.registry, 'peer-1');
  allowlistPeer(s, 'peer-1');
  const t1 = await makeTask(s.board, 'peer-1', 'Export A');
  const t2 = await makeTask(s.board, 'peer-1', 'Export B');
  s.boardV2.setPriority(t1, 'urgent', 'admin');
  assert.equal(s.board.start(t2).ok, true);
  const exported = s.boardV2.exportBoard();
  const lines = exported.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  const a = lines.find((l) => l.taskId === t1);
  assert.equal(a.priority, 'urgent');
  assert.equal(a.state, 'submitted');
  assert.equal(a.slaState, 'no-deadline');
  assert.equal(a.blocked, false);
  assert.equal(typeof a.timelineEvents, 'number');
  const working = s.boardV2.exportBoard('working').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.deepEqual(working.map((l) => l.taskId), [t2]);
  assert.equal(s.boardV2.exportBoard('completed'), '');
});

test('board v2 bulk: cancel + reassign + priority with per-task refusals', async () => {
  const s = makeSetup();
  makePeer(s.registry, 'peer-1');
  makePeer(s.registry, 'peer-2');
  allowlistPeer(s, 'peer-1');
  allowlistPeer(s, 'peer-2');
  const t1 = await makeTask(s.board, 'peer-1', 'T1');
  const t2 = await makeTask(s.board, 'peer-1', 'T2');
  const t3 = await makeTask(s.board, 'peer-1', 'T3');
  assert.equal(s.board.start(t3).ok, true);
  assert.equal(s.board.complete(t3).ok, true); // terminal: cancel refuses
  const cancelled = await s.boardV2.bulkCancel([t1, t3, 'nope'], true, 'Bulk cleanup.');
  assert.deepEqual(cancelled.applied, [t1]);
  assert.equal(cancelled.refused.length, 2);
  const moved = s.boardV2.bulkReassign([t2, t1], 'peer-2', 'admin');
  assert.deepEqual(moved.applied, [t2]); // t1 is cancelled, cannot move
  assert.equal(moved.refused.length, 1);
  const prio = s.boardV2.bulkSetPriority([t2, 'nope'], 'high', 'admin');
  assert.deepEqual(prio.applied, [t2]);
  assert.equal(prio.refused.length, 1);
  assert.equal(s.boardV2.countsByPriority()['high'], 1);
});

/* ---------------- peer groups ---------------- */

test('peer groups: CRUD + membership mirrored onto peer tags', () => {
  const s = makeSetup();
  makePeer(s.registry, 'peer-1');
  makePeer(s.registry, 'peer-2');
  assert.equal(s.groups.createGroup('', 'admin').ok, false);
  const created = s.groups.createGroup('Coding', 'admin', { description: 'Code agents.' });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const gid = created.group.groupId;
  assert.equal(s.groups.addPeer(gid, 'peer-ghost').ok, false);
  assert.equal(s.groups.addPeer(gid, 'peer-1').ok, true);
  assert.equal(s.groups.addPeer(gid, 'peer-1').ok, false); // duplicate
  assert.ok(s.registry.getPeer('peer-1')?.tags.includes(fleetV30GroupTag(gid)));
  assert.equal(s.groups.addPeer(gid, 'peer-2').ok, true);
  assert.deepEqual(s.groups.peersInGroup(gid).map((p) => p.peerId), ['peer-1', 'peer-2']);
  assert.equal(s.groups.groupsForPeer('peer-1').length, 1);
  assert.equal(s.groups.renameGroup(gid, 'Coding v2').ok, true);
  assert.equal(s.groups.getGroup(gid)?.name, 'Coding v2');
  assert.equal(s.groups.renameGroup(gid, '').ok, false);
  assert.equal(s.groups.removePeer(gid, 'peer-1').ok, true);
  assert.ok(!s.registry.getPeer('peer-1')?.tags.includes(fleetV30GroupTag(gid)));
  assert.equal(s.groups.removePeer(gid, 'peer-1').ok, false);
  const removed = s.groups.removePeerFromAllGroups('peer-2');
  assert.deepEqual(removed, [gid]);
  assert.equal(s.groups.deleteGroup(gid).ok, true);
  assert.equal(s.groups.getGroup(gid), null);
  assert.equal(s.groups.deleteGroup(gid).ok, false);
  assert.equal(s.groups.listGroups().length, 0);
});

test('peer groups: capability scoring, pick, failover, probes', () => {
  const s = makeSetup();
  makePeer(s.registry, 'peer-fast', { skills: ['code', 'research'], url: 'http://127.0.0.1:4201/' });
  makePeer(s.registry, 'peer-slow', { skills: ['code'], streaming: false, url: 'http://127.0.0.1:4202/' });
  makePeer(s.registry, 'peer-new', { skills: ['research'], cardStatus: 'unverified', url: 'http://127.0.0.1:4203/' });
  // Latency samples: fast is quick, slow is slow.
  s.registry.recordSample({ peerId: 'peer-fast', latencyMs: 120, costUsd: 0.01, failed: false, at: NOW });
  s.registry.recordSample({ peerId: 'peer-slow', latencyMs: 4000, costUsd: 0.05, failed: false, at: NOW });
  const req = { requiredSkills: ['code', 'research'], latencyBudgetMs: 1000, streamingRequired: false, groupId: null, excludePeerIds: [] };
  const scores = s.groups.scorePeers(req);
  assert.equal(scores[0].peerId, 'peer-fast');
  assert.ok(scores[0].score > scores[1].score);
  assert.ok(scores[0].reasons.length === 0);
  assert.ok(scores.find((x) => x.peerId === 'peer-slow')?.reasons.some((r) => r.includes('Missing skill')));
  assert.ok((scores.find((x) => x.peerId === 'peer-new')?.score ?? 100) <= 40); // unverified cap
  // Streaming required: the non-streaming peer scores 0.
  const streaming = s.groups.scorePeers({ ...req, streamingRequired: true });
  assert.equal(streaming.find((x) => x.peerId === 'peer-slow')?.score, 0);
  // Pick + failover.
  assert.equal(s.groups.pickPeer(req)?.peerId, 'peer-fast');
  assert.equal(s.groups.pickFailover(req, 'peer-fast')?.peerId, 'peer-slow');
  assert.equal(s.groups.pickPeer({ ...req, requiredSkills: ['no-such-skill'], latencyBudgetMs: 10 })?.peerId, 'peer-fast'); // still > 0 via health/capacity
  assert.equal(s.groups.pickPeer({ ...req, groupId: 'group-nope' }), null);
  // Probes feed health samples.
  const before = s.registry.listSamples('peer-fast').length;
  const probe = s.groups.recordProbe({ peerId: 'peer-fast', endpoint: 'http://127.0.0.1:4201/', reachable: true, latencyMs: 90, error: null });
  assert.equal(probe.reachable, true);
  assert.equal(s.registry.listSamples('peer-fast').length, before + 1);
  s.groups.recordProbe({ peerId: 'peer-slow', endpoint: 'http://127.0.0.1:4202/', reachable: false, latencyMs: null, error: 'timeout' });
  assert.equal(s.groups.lastProbeByPeer().get('peer-slow')?.reachable, false);
  assert.equal(s.groups.listProbes('peer-fast').length, 1);
});
