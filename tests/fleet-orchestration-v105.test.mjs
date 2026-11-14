/**
 * Tests for the fleet orchestration v4 (packages/core/src/fleet/orchestration.ts).
 *
 * Covers bot registry, the priority task queue, scheduling by
 * affinity / capability / load / token quota, health checks + mock
 * auto-restart (including the per-hour restart limit), and fleet
 * shared memory groups (create group, add bot, publish block,
 * resolve blocks for a bot, sync report) built on
 * SharedBlockGroupStore without modifying it.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/fleet-orchestration-v105.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  FleetOrchestrator,
  MockBotHealthProbe,
} from '../packages/core/dist/fleet/orchestration.js';
import { MemoryBlockStore } from '../packages/core/dist/memory/blocks.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-fleet-orch-'));
}

function makeBot(overrides = {}) {
  return {
    botId: 'bot-a',
    name: 'Bot A',
    capabilities: ['code', 'research'],
    affinityTags: ['sales'],
    runningTasks: 0,
    cpuLoad: 0.2,
    status: 'healthy',
    lastHealthAt: null,
    restarts: 0,
    tokenUsage: 0,
    ...overrides,
  };
}

function makeOrchestrator(overrides = {}) {
  return new FleetOrchestrator({
    probe: new MockBotHealthProbe(),
    now: () => 1000000,
    ...overrides,
  });
}

test('bot registry: register / get / update load / remove + validation', () => {
  const orch = makeOrchestrator();
  const bot = orch.registerBot(makeBot());
  assert.equal(bot.botId, 'bot-a');
  assert.equal(orch.listBots().length, 1);
  const updated = orch.updateBotLoad('bot-a', { runningTasks: 2, cpuLoad: 0.5, tokenUsage: 1000 });
  assert.equal(updated.runningTasks, 2);
  assert.equal(updated.tokenUsage, 1000);
  assert.equal(orch.removeBot('bot-a'), true);
  assert.equal(orch.removeBot('bot-a'), false);
  assert.equal(orch.getBot('bot-a'), null);
  assert.throws(() => orch.registerBot(makeBot({ botId: '' })), /botId/);
  assert.throws(() => orch.registerBot(makeBot({ cpuLoad: 2 })), /cpuLoad/);
  assert.throws(() => orch.updateBotLoad('missing', {}), /not found/);
  assert.throws(() => orch.updateBotLoad('bot-a', { runningTasks: -1 }), /not found/);
});

test('task queue: priority order, cancel, done frees the bot slot', () => {
  const orch = makeOrchestrator();
  orch.registerBot(makeBot());
  const low = orch.submitTask({ title: 'low work', priority: 1, submittedBy: 'user' });
  const high = orch.submitTask({ title: 'urgent work', priority: 5, submittedBy: 'user' });
  const mid = orch.submitTask({ title: 'normal work', priority: 3, submittedBy: 'user' });
  const waiting = orch.listWaitingTasks();
  assert.deepEqual(waiting.map((t) => t.id), [high.id, mid.id, low.id]);
  assert.equal(low.priority, 1);
  // Default priority comes from the policy (3).
  const def = orch.submitTask({ title: 'no priority', submittedBy: 'user' });
  assert.equal(def.priority, 3);
  assert.throws(() => orch.submitTask({ title: '', submittedBy: 'user' }), /title/);
  assert.throws(() => orch.submitTask({ title: 'x', priority: 9, submittedBy: 'user' }), /priority/);

  const scheduled = orch.scheduleNext();
  assert.equal(scheduled.task.id, high.id);
  assert.equal(scheduled.botId, 'bot-a');
  assert.equal(orch.getBot('bot-a').runningTasks, 1);
  orch.markTaskDone(high.id);
  assert.equal(orch.getBot('bot-a').runningTasks, 0);
  assert.equal(orch.getTask(high.id).status, 'done');

  const cancelled = orch.cancelTask(low.id, 'no longer needed');
  assert.equal(cancelled.status, 'cancelled');
  assert.throws(() => orch.cancelTask(high.id), /cannot be cancelled/);
  assert.throws(() => orch.cancelTask('nope'), /not found/);
});

test('scheduling: affinity bot wins, then affinity tags, then lowest load', () => {
  const orch = makeOrchestrator();
  orch.registerBot(makeBot({ botId: 'bot-a', name: 'A', affinityTags: ['sales'], runningTasks: 0, cpuLoad: 0.8 }));
  orch.registerBot(makeBot({ botId: 'bot-b', name: 'B', affinityTags: ['support'], runningTasks: 0, cpuLoad: 0.1 }));
  // Pinned to bot-b via affinityBotId even though bot-a is listed first.
  orch.submitTask({ title: 'pinned', affinityBotId: 'bot-b', submittedBy: 'user' });
  const pinned = orch.scheduleNext();
  assert.equal(pinned.botId, 'bot-b');
  // Tag affinity: bot-a has the 'sales' tag.
  orch.submitTask({ title: 'sales work', affinityTags: ['sales'], submittedBy: 'user' });
  const tagged = orch.scheduleNext();
  assert.equal(tagged.botId, 'bot-a');
  // No affinity: lower CPU load wins (bot-b at 0.1 vs bot-a at 0.8).
  orch.submitTask({ title: 'plain work', submittedBy: 'user' });
  const plain = orch.scheduleNext();
  assert.equal(plain.botId, 'bot-b');
});

test('scheduling: capability, task cap and token quota block ineligible bots', () => {
  const orch = makeOrchestrator();
  orch.registerBot(makeBot({ botId: 'bot-a', capabilities: ['code'], runningTasks: 4 }));
  orch.registerBot(makeBot({ botId: 'bot-b', capabilities: ['code', 'voice'], runningTasks: 0, tokenUsage: 999000 }));
  // Missing capability: only bot-b has 'voice'.
  orch.submitTask({ title: 'voice work', requiredCapabilities: ['voice'], submittedBy: 'user' });
  assert.equal(orch.scheduleNext().botId, 'bot-b');
  // bot-a is full (4/4 tasks) and lacks voice anyway.
  orch.submitTask({ title: 'more voice', requiredCapabilities: ['voice'], submittedBy: 'user' });
  assert.equal(orch.scheduleNext().botId, 'bot-b');
  // Token quota: bot-b has 999000 used of 1000000; a 5000-token task does not fit.
  orch.submitTask({ title: 'heavy work', requiredCapabilities: ['voice'], tokenBudget: 5000, submittedBy: 'user' });
  assert.equal(orch.scheduleNext(), null);
  assert.equal(orch.listWaitingTasks().length, 1);
  // Scoring explains the ineligibility.
  const score = orch.scoreBotForTask(orch.getBot('bot-b'), orch.listWaitingTasks()[0]);
  assert.equal(score.eligible, false);
  assert.match(score.reason, /token quota/);
});

test('health check: healthy stays, degraded on slow probe, down auto-restarts (mock)', async () => {
  const probe = new MockBotHealthProbe();
  const orch = new FleetOrchestrator({ probe, now: () => 2000000 });
  orch.registerBot(makeBot({ botId: 'bot-a' }));
  orch.registerBot(makeBot({ botId: 'bot-b' }));
  orch.registerBot(makeBot({ botId: 'bot-c' }));
  probe.setHealth('bot-b', { healthy: true, latencyMs: 2500, detail: 'slow' });
  probe.setHealth('bot-c', { healthy: false, detail: 'connection refused' });
  const report = await orch.runHealthCheck();
  assert.equal(report.checked, 3);
  assert.equal(report.healthy, 2); // bot-a healthy + bot-c restarted back to healthy
  assert.equal(report.degraded, 1);
  assert.equal(report.down, 0);
  assert.equal(report.restarted.length, 1);
  assert.equal(report.restarted[0].botId, 'bot-c');
  assert.deepEqual(report.restartBlocked, []);
  assert.equal(orch.getBot('bot-b').status, 'degraded');
  assert.equal(orch.getBot('bot-c').status, 'healthy');
  assert.equal(orch.getBot('bot-c').restarts, 1);
  const summary = orch.getHealthSummary();
  assert.equal(summary.totalBots, 3);
  assert.equal(summary.byStatus.healthy, 2);
  assert.equal(summary.totalRestarts, 1);
});

test('health check: restart limit blocks further auto-restarts', async () => {
  const probe = new MockBotHealthProbe();
  const orch = new FleetOrchestrator({
    probe,
    now: () => 3000000,
    policy: { maxRestartsPerHour: 1 },
  });
  orch.registerBot(makeBot({ botId: 'bot-a' }));
  probe.setHealth('bot-a', { healthy: false, detail: 'crash loop' });
  const first = await orch.runHealthCheck();
  assert.equal(first.restarted.length, 1);
  const second = await orch.runHealthCheck();
  assert.equal(second.restarted.length, 0);
  assert.equal(second.restartBlocked.length, 1);
  assert.equal(second.down, 1);
  assert.equal(orch.getBot('bot-a').status, 'down');
  assert.equal(orch.restartsLastHour('bot-a', 3000000), 1);
  // Policy 0 restarts/hour = no auto-restart at all.
  const orch2 = new FleetOrchestrator({ probe: new MockBotHealthProbe(), now: () => 3000000, policy: { maxRestartsPerHour: 0 } });
  orch2.registerBot(makeBot({ botId: 'bot-a' }));
  const blocked = await orch2.restartBot('bot-a');
  assert.equal(blocked.restarted, false);
});

test('shared memory: group lifecycle via SharedBlockGroupStore (not modified)', () => {
  const dir = tmpDir();
  const orch = new FleetOrchestrator({ fleetRoot: dir, now: () => 4000000 });
  orch.registerBot(makeBot({ botId: 'bot-a' }));
  orch.registerBot(makeBot({ botId: 'bot-b', name: 'Bot B' }));
  // A block must exist in the store before it can be published.
  const blocks = new MemoryBlockStore(dir);
  const block = blocks.create({ label: 'team-notes', content: 'Launch on 2026-12-01.' });
  const group = orch.createSharedGroup('team-sales', 'Shared notes for the sales bots');
  assert.equal(group.name, 'team-sales');
  orch.addBotToSharedGroup(group.id, 'bot-a', 'write');
  orch.addBotToSharedGroup(group.id, 'bot-b', 'read');
  orch.publishBlockToSharedGroup(group.id, block.id);
  const forA = orch.sharedBlocksForBot('bot-a');
  assert.equal(forA.length, 1);
  assert.equal(forA[0].block.id, block.id);
  assert.equal(forA[0].viaGroupName, 'team-sales');
  const forB = orch.sharedBlocksForBot('bot-b');
  assert.equal(forB.length, 1);
  // Removing bot-b drops the group's blocks from it.
  orch.removeBotFromSharedGroup(group.id, 'bot-b');
  assert.equal(orch.sharedBlocksForBot('bot-b').length, 0);
  assert.equal(orch.sharedBlocksForBot('bot-a').length, 1);
  const report = orch.sharedGroupSyncReport(group.id);
  assert.equal(report.groupId, group.id);
  assert.equal(report.inSync, true);
  assert.deepEqual(report.missingAttachments, []);
  assert.deepEqual(report.orphanBlockIds, []);
  // Unregistered bot cannot join a group.
  assert.throws(() => orch.addBotToSharedGroup(group.id, 'bot-ghost'), /not found/);
});

test('shared memory: orchestrator without fleetRoot throws a clear error', () => {
  const orch = makeOrchestrator();
  assert.throws(() => orch.createSharedGroup('g1'), /fleetRoot/);
});

test('scheduleAll drains the queue; rebalance re-queues a dead bot’s tasks', () => {
  const orch = makeOrchestrator();
  orch.registerBot(makeBot({ botId: 'bot-a', runningTasks: 0 }));
  orch.registerBot(makeBot({ botId: 'bot-b', name: 'Bot B', runningTasks: 0 }));
  orch.submitTask({ title: 't1', priority: 5, submittedBy: 'user' });
  orch.submitTask({ title: 't2', priority: 4, submittedBy: 'user' });
  orch.submitTask({ title: 't3', priority: 1, submittedBy: 'user' });
  const all = orch.scheduleAll();
  assert.equal(all.scheduled.length, 3);
  assert.equal(all.stillWaiting, 0);
  assert.equal(orch.listTasks('assigned').length, 3);
  // Kill bot-a: its assigned tasks go back to waiting.
  const botATasks = orch.listTasks('assigned').filter((t) => t.assignedBotId === 'bot-a');
  assert.ok(botATasks.length > 0);
  const moved = orch.rebalanceAfterBotDown('bot-a');
  assert.equal(moved, botATasks.length);
  assert.equal(orch.listWaitingTasks().length, moved);
  assert.equal(orch.getBot('bot-a').runningTasks, 0);
  assert.throws(() => orch.rebalanceAfterBotDown('ghost'), /not found/);
});

test('durable task queue: save/load round-trip, corrupt file throws', () => {
  const dir = tmpDir();
  const orch = new FleetOrchestrator({ fleetRoot: dir, now: () => 5000000 });
  orch.submitTask({ title: 'persist me', priority: 4, submittedBy: 'user' });
  orch.submitTask({ title: 'and me', priority: 2, submittedBy: 'user' });
  assert.equal(orch.saveTasks(), 2);
  assert.ok(fs.existsSync(path.join(dir, 'fleet-tasks-v4.json')));
  const orch2 = new FleetOrchestrator({ fleetRoot: dir, now: () => 5000000 });
  assert.equal(orch2.loadTasks(), 2);
  assert.deepEqual(orch2.listWaitingTasks().map((t) => t.title), ['persist me', 'and me']);
  // Corrupt file -> throw with the file name in the message.
  fs.writeFileSync(path.join(dir, 'fleet-tasks-v4.json'), '[{ "id": 1 }]');
  const orch3 = new FleetOrchestrator({ fleetRoot: dir, now: () => 5000000 });
  assert.throws(() => orch3.loadTasks(), /fleet-tasks-v4\.json/);
  // No fleetRoot -> clear error.
  const mem = makeOrchestrator();
  assert.throws(() => mem.saveTasks(), /fleetRoot/);
  assert.throws(() => mem.loadTasks(), /fleetRoot/);
});

test('decision log: assign/requeue/restart recorded in memory + jsonl file', async () => {
  const dir = tmpDir();
  const orch = new FleetOrchestrator({ fleetRoot: dir, probe: new MockBotHealthProbe(), now: () => 6000000 });
  orch.registerBot(makeBot({ botId: 'bot-a' }));
  orch.registerBot(makeBot({ botId: 'bot-b', name: 'Bot B' }));
  orch.submitTask({ title: 'logged work', priority: 5, submittedBy: 'user' });
  const scheduled = orch.scheduleNext();
  assert.notEqual(scheduled, null);
  const decisions = orch.listSchedulingDecisions();
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].kind, 'assign');
  assert.equal(decisions[0].botId, scheduled.botId);
  assert.equal(decisions[0].taskTitle, 'logged work');
  // jsonl file got the same entry.
  const lines = fs.readFileSync(path.join(dir, 'fleet-scheduling-decisions.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).kind, 'assign');
  // Rebalance logs a requeue decision.
  orch.rebalanceAfterBotDown(scheduled.botId);
  assert.equal(orch.listSchedulingDecisions().length, 2);
  assert.equal(orch.listSchedulingDecisions()[1].kind, 'requeue');
  assert.equal(orch.listSchedulingDecisions(1).length, 1);
  assert.throws(() => orch.listSchedulingDecisions(-1), /limit/);
});

test('task templates: create/due/instantiate/advance/disable/remove', async () => {
  const {
    createFleetTaskTemplate,
    listFleetTaskTemplates,
    dueFleetTaskTemplates,
    instantiateFleetTaskTemplate,
    advanceFleetTaskTemplate,
    setFleetTaskTemplateEnabled,
    removeFleetTaskTemplate,
  } = await import('../packages/core/dist/fleet/taskTemplates.js');
  const dir = tmpDir();
  assert.deepEqual(listFleetTaskTemplates(dir), []);
  const tmpl = createFleetTaskTemplate(
    dir,
    { title: 'Weekly report', kind: 'report', priority: 4, submittedBy: 'user', intervalMs: 7 * 24 * 3600 * 1000, firstRunAt: 1000 },
    500,
  );
  assert.equal(tmpl.nextRunAt, 1000);
  assert.equal(tmpl.lastRunAt, null);
  assert.equal(tmpl.enabled, true);
  assert.deepEqual(dueFleetTaskTemplates(dir, 999), []);
  assert.equal(dueFleetTaskTemplates(dir, 1000).length, 1);
  const input = instantiateFleetTaskTemplate(tmpl);
  assert.equal(input.title, 'Weekly report');
  assert.equal(input.priority, 4);
  const advanced = advanceFleetTaskTemplate(dir, tmpl.id, 1000);
  assert.equal(advanced.lastRunAt, 1000);
  assert.equal(advanced.nextRunAt, 1000 + 7 * 24 * 3600 * 1000);
  assert.deepEqual(dueFleetTaskTemplates(dir, 2000), []);
  // Disabled template is never due.
  setFleetTaskTemplateEnabled(dir, tmpl.id, false);
  assert.deepEqual(dueFleetTaskTemplates(dir, 999999999), []);
  assert.equal(removeFleetTaskTemplate(dir, tmpl.id), true);
  assert.equal(removeFleetTaskTemplate(dir, tmpl.id), false);
  assert.throws(
    () => createFleetTaskTemplate(dir, { title: '', submittedBy: 'user', intervalMs: 1000 }),
    /title/,
  );
  assert.throws(
    () => createFleetTaskTemplate(dir, { title: 'x', submittedBy: 'user', intervalMs: 0 }),
    /intervalMs/,
  );
  assert.throws(() => advanceFleetTaskTemplate(dir, 'ghost'), /no fleet task template/);
});
