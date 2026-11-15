/**
 * Fleet campaign v2 tests (v1.10, Đội T6 — node:test, no network).
 *
 * Covers:
 *  - planFleetV7Stages: canary (1 bot / >=10%) → staged slices
 *    (25/50/75%) → full; full-only / staged-only strategies; tiny
 *    campaigns (1-2 bots) collapse empty stages
 *  - createFleetV7Campaign: validation (duplicate bot, unknown node
 *    maxBots overflow, bad strategy/percents), node defaults
 *  - start + advance gate: unfinished bots block, failures over cap
 *    block, success rate under min blocks, offline next-stage node
 *    blocks, draining only warns
 *  - reportFleetV7BotProgress: pending → running → done (100%),
 *    fail requeues until maxAttempts then failed
 *  - rollback: running/pending → rolled-back, done kept, snapshot
 *    recorded, campaign cannot advance afterwards
 *  - summarizeFleetV7Campaign: per-status / per-stage / per-node
 *    aggregates, success rate, auto-finish when all bots end
 *  - persistence: save/load round-trip, corrupt JSON throws,
 *    missing file loads as []
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/fleet-v110-campaign.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  advanceFleetV7Rollout,
  cancelFleetV7Campaign,
  checkFleetV7AdvanceGate,
  cloneFleetV7Campaign,
  createFleetV7Campaign,
  findFleetV7Campaign,
  loadFleetV7Campaigns,
  pauseFleetV7Campaign,
  planFleetV7Rollout,
  planFleetV7Stages,
  reportFleetV7BotProgress,
  resumeFleetV7Campaign,
  rollbackFleetV7Campaign,
  saveFleetV7Campaigns,
  startFleetV7Campaign,
  summarizeFleetV7Campaign,
  validateFleetV7Campaign,
  FLEET_V7_CAMPAIGNS_FILE,
} from '../packages/core/dist/fleet/fleetV7Campaign.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-fleet-v110-'));
}

function bots(n, nodes = ['node-a', 'node-b']) {
  return Array.from({ length: n }, (_, i) => ({
    botId: `bot-${i + 1}`,
    nodeId: nodes[i % nodes.length],
  }));
}

function finishStageBots(campaign, stageIndex, statuses, now = 1000) {
  // statuses: botId -> 'done' | 'failed' (failed uses maxAttempts 1).
  const stage = campaign.stages[stageIndex];
  for (const botId of stage.botIds) {
    const status = statuses[botId] ?? 'done';
    if (status === 'done') {
      reportFleetV7BotProgress(campaign, botId, { progressPercent: 100, status: 'done' }, now);
    } else {
      reportFleetV7BotProgress(
        campaign,
        botId,
        { progressPercent: 50, status: 'failed', error: 'mock failure', maxAttempts: 1 },
        now,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Stage planning
// ---------------------------------------------------------------------------

test('fleet v110: plan stages 10 bots canary 1 → staged 25/50/75% → full', () => {
  const stages = planFleetV7Stages(bots(10).map((b) => b.botId), 'canary-staged-full');
  assert.deepEqual(
    stages.map((s) => [s.stage, s.botIds.length]),
    [
      ['canary', 1],
      ['staged', 2],
      ['staged', 2],
      ['staged', 3],
      ['full', 2],
    ],
  );
  // Every bot in exactly one stage, order preserved.
  assert.deepEqual(
    stages.flatMap((s) => s.botIds),
    bots(10).map((b) => b.botId),
  );
  for (const s of stages) {
    assert.equal(s.minSuccessRate, 0.8);
    assert.equal(s.maxFailures, 1);
    assert.equal(s.status, 'pending');
  }
});

test('fleet v110: plan stages respects canaryCount and custom percents', () => {
  const ids = bots(20).map((b) => b.botId);
  const stages = planFleetV7Stages(ids, 'canary-staged-full', {
    canaryCount: 2,
    stagedPercents: [50],
    minSuccessRate: 0.9,
    maxFailures: 0,
  });
  assert.deepEqual(
    stages.map((s) => [s.stage, s.botIds.length]),
    [
      ['canary', 2],
      ['staged', 8],
      ['full', 10],
    ],
  );
  assert.equal(stages[0].minSuccessRate, 0.9);
  assert.equal(stages[0].maxFailures, 0);
});

test('fleet v110: tiny campaigns collapse empty stages', () => {
  assert.deepEqual(
    planFleetV7Stages(['only-bot'], 'canary-staged-full').map((s) => [s.stage, s.botIds.length]),
    [['canary', 1]],
  );
  assert.deepEqual(
    planFleetV7Stages(['a', 'b'], 'canary-staged-full').map((s) => [s.stage, s.botIds.length]),
    [
      ['canary', 1],
      ['full', 1],
    ],
  );
  assert.deepEqual(
    planFleetV7Stages(['a', 'b', 'c'], 'full-only').map((s) => [s.stage, s.botIds.length]),
    [['full', 3]],
  );
  assert.deepEqual(
    planFleetV7Stages(['a', 'b', 'c', 'd'], 'staged-only').map((s) => [s.stage, s.botIds.length]),
    [
      ['staged', 1],
      ['staged', 1],
      ['staged', 1],
      ['full', 1],
    ],
  );
});

test('fleet v110: plan stages rejects bad input', () => {
  assert.throws(() => planFleetV7Stages([], 'canary-staged-full'), /ít nhất 1 bot/);
  assert.throws(
    () => planFleetV7Stages(['a'], 'canary-staged-full', { canaryCount: 0 }),
    /canaryCount/,
  );
  assert.throws(
    () => planFleetV7Stages(['a'], 'canary-staged-full', { minSuccessRate: 1.5 }),
    /minSuccessRate/,
  );
  assert.throws(
    () => planFleetV7Stages(['a'], 'canary-staged-full', { maxFailures: -1 }),
    /maxFailures/,
  );
});

// ---------------------------------------------------------------------------
// Create + validate
// ---------------------------------------------------------------------------

test('fleet v110: create campaign — nodes default online, draft, history', () => {
  const campaign = createFleetV7Campaign({ goal: 'Ship v1.10 everywhere', bots: bots(4) }, 1000);
  assert.equal(campaign.status, 'draft');
  assert.equal(campaign.strategy, 'canary-staged-full');
  assert.equal(campaign.currentStageIndex, -1);
  assert.equal(campaign.nodes.length, 2);
  assert.deepEqual(
    campaign.nodes.map((n) => [n.id, n.status, n.maxBots]),
    [
      ['node-a', 'online', null],
      ['node-b', 'online', null],
    ],
  );
  assert.equal(campaign.assignments.length, 4);
  assert.ok(campaign.assignments.every((a) => a.status === 'pending' && a.progressPercent === 0));
  assert.equal(campaign.history.length, 1);
  assert.equal(campaign.history[0].event, 'created');
  validateFleetV7Campaign(campaign);
});

test('fleet v110: create campaign rejects duplicate bots, node overflow, bad strategy', () => {
  assert.throws(
    () =>
      createFleetV7Campaign({
        goal: 'x',
        bots: [
          { botId: 'b1', nodeId: 'n1' },
          { botId: 'b1', nodeId: 'n1' },
        ],
      }),
    /botId trùng/,
  );
  assert.throws(() => createFleetV7Campaign({ goal: '', bots: bots(1) }), /goal không rỗng/);
  assert.throws(() => createFleetV7Campaign({ goal: 'x', bots: [] }), /ít nhất 1 bot/);
  assert.throws(
    () =>
      createFleetV7Campaign({
        goal: 'x',
        bots: bots(3, ['n1']),
        nodes: [{ id: 'n1', maxBots: 2 }],
      }),
    /tối đa 2 bot/,
  );
  assert.throws(
    () => createFleetV7Campaign({ goal: 'x', bots: bots(1), strategy: 'nope' }),
    /strategy/,
  );
});

test('fleet v110: validate rejects bot on unknown node and bot in two stages', () => {
  const good = createFleetV7Campaign({ goal: 'x', bots: bots(2) }, 1000);
  const badNode = JSON.parse(JSON.stringify(good));
  badNode.assignments[0].nodeId = 'ghost-node';
  assert.throws(() => validateFleetV7Campaign(badNode), /node không tồn tại/);
  const badStage = JSON.parse(JSON.stringify(good));
  badStage.stages[1].botIds.push(badStage.stages[0].botIds[0]);
  assert.throws(() => validateFleetV7Campaign(badStage), /nhiều stage/);
});

// ---------------------------------------------------------------------------
// Advance gate
// ---------------------------------------------------------------------------

test('fleet v110: gate blocks while canary unfinished, opens when done', () => {
  const campaign = createFleetV7Campaign({ goal: 'x', bots: bots(10) }, 1000);
  startFleetV7Campaign(campaign, 1000);
  assert.equal(campaign.status, 'active');
  assert.equal(campaign.currentStageIndex, 0);
  let gate = checkFleetV7AdvanceGate(campaign);
  assert.equal(gate.pass, false);
  assert.match(gate.reason, /chưa kết thúc/);
  assert.equal(gate.unfinished, 1);

  reportFleetV7BotProgress(campaign, 'bot-1', { progressPercent: 100, status: 'done' }, 2000);
  gate = checkFleetV7AdvanceGate(campaign);
  assert.equal(gate.pass, true);
  assert.equal(gate.reason, null);
  const result = advanceFleetV7Rollout(campaign, 2000);
  assert.equal(result.advanced, true);
  assert.equal(result.stage, 'staged');
  assert.equal(campaign.currentStageIndex, 1);
  assert.equal(campaign.stages[0].status, 'done');
  assert.equal(campaign.stages[1].status, 'active');
});

test('fleet v110: gate blocks when failures exceed maxFailures', () => {
  const campaign = createFleetV7Campaign(
    { goal: 'x', bots: bots(10), canaryCount: 2, maxFailures: 1 },
    1000,
  );
  startFleetV7Campaign(campaign, 1000);
  // Canary has 2 bots: both fail.
  finishStageBots(campaign, 0, { 'bot-1': 'failed', 'bot-2': 'failed' });
  const gate = checkFleetV7AdvanceGate(campaign);
  assert.equal(gate.pass, false);
  assert.equal(gate.failures, 2);
  assert.match(gate.reason, /2 bot fail/);
  const result = advanceFleetV7Rollout(campaign, 2000);
  assert.equal(result.advanced, false);
  assert.equal(campaign.currentStageIndex, 0);
});

test('fleet v110: gate blocks on low success rate even within failure cap', () => {
  const campaign = createFleetV7Campaign(
    { goal: 'x', bots: bots(10), canaryCount: 4, maxFailures: 2, minSuccessRate: 0.8 },
    1000,
  );
  startFleetV7Campaign(campaign, 1000);
  // 2 done + 2 failed = 50% success, failures (2) within cap (2).
  finishStageBots(campaign, 0, { 'bot-1': 'done', 'bot-2': 'done', 'bot-3': 'failed', 'bot-4': 'failed' });
  const gate = checkFleetV7AdvanceGate(campaign);
  assert.equal(gate.pass, false);
  assert.equal(gate.successRate, 0.5);
  assert.match(gate.reason, /50%/);
});

test('fleet v110: offline next-stage node blocks, draining only warns', () => {
  const campaign = createFleetV7Campaign(
    {
      goal: 'x',
      bots: bots(4),
      nodes: [
        { id: 'node-a', status: 'online' },
        { id: 'node-b', status: 'offline' },
      ],
    },
    1000,
  );
  startFleetV7Campaign(campaign, 1000);
  // Canary bot-1 is on node-a; staged bot-2 is on node-b (offline).
  reportFleetV7BotProgress(campaign, 'bot-1', { progressPercent: 100, status: 'done' }, 2000);
  const gate = checkFleetV7AdvanceGate(campaign);
  assert.equal(gate.pass, false);
  assert.deepEqual(gate.offlineNodes, ['node-b']);
  assert.match(gate.reason, /node offline/);

  // Bring node-b to draining: gate opens, advance warns.
  campaign.nodes.find((n) => n.id === 'node-b').status = 'draining';
  const gate2 = checkFleetV7AdvanceGate(campaign);
  assert.equal(gate2.pass, true);
  assert.deepEqual(gate2.drainingNodes, ['node-b']);
  const result = advanceFleetV7Rollout(campaign, 3000);
  assert.equal(result.advanced, true);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /draining/);
});

test('fleet v110: advance throws when campaign not active or at last stage', () => {
  const campaign = createFleetV7Campaign({ goal: 'x', bots: bots(1) }, 1000);
  assert.throws(() => advanceFleetV7Rollout(campaign), /chỉ advance được campaign active/);
  startFleetV7Campaign(campaign, 1000);
  reportFleetV7BotProgress(campaign, 'bot-1', { progressPercent: 100, status: 'done' }, 2000);
  // Single-bot campaign auto-finishes when its only bot is done.
  assert.equal(campaign.status, 'done');
  assert.throws(() => advanceFleetV7Rollout(campaign), /chỉ advance được campaign active/);
});

// ---------------------------------------------------------------------------
// Progress reporting
// ---------------------------------------------------------------------------

test('fleet v110: progress pending → running → done sets 100% + finishedAt', () => {
  const campaign = createFleetV7Campaign({ goal: 'x', bots: bots(2) }, 1000);
  startFleetV7Campaign(campaign, 1000);
  const a = reportFleetV7BotProgress(campaign, 'bot-1', { progressPercent: 40 }, 1500);
  assert.equal(a.status, 'running');
  assert.equal(a.progressPercent, 40);
  assert.equal(a.startedAt, 1500);
  const b = reportFleetV7BotProgress(campaign, 'bot-1', { progressPercent: 90, status: 'done' }, 2000);
  assert.equal(b.status, 'done');
  assert.equal(b.progressPercent, 100);
  assert.equal(b.finishedAt, 2000);
  assert.throws(
    () => reportFleetV7BotProgress(campaign, 'bot-1', { progressPercent: 100, status: 'done' }),
    /đã done/,
  );
});

test('fleet v110: fail requeues until maxAttempts, then failed for good', () => {
  const campaign = createFleetV7Campaign({ goal: 'x', bots: bots(2) }, 1000);
  startFleetV7Campaign(campaign, 1000);
  const first = reportFleetV7BotProgress(
    campaign,
    'bot-1',
    { progressPercent: 30, status: 'failed', error: 'boom', maxAttempts: 2 },
    1500,
  );
  assert.equal(first.status, 'pending');
  assert.equal(first.attempts, 1);
  assert.equal(first.lastError, 'boom');
  const second = reportFleetV7BotProgress(
    campaign,
    'bot-1',
    { progressPercent: 30, status: 'failed', error: 'boom again', maxAttempts: 2 },
    2000,
  );
  assert.equal(second.status, 'failed');
  assert.equal(second.attempts, 2);
});

test('fleet v110: pause/resume/cancel', () => {
  const campaign = createFleetV7Campaign({ goal: 'x', bots: bots(2) }, 1000);
  startFleetV7Campaign(campaign, 1000);
  pauseFleetV7Campaign(campaign, 1500);
  assert.equal(campaign.status, 'paused');
  resumeFleetV7Campaign(campaign, 2000);
  assert.equal(campaign.status, 'active');
  assert.throws(() => resumeFleetV7Campaign(campaign), /chỉ resume được campaign paused/);
  cancelFleetV7Campaign(campaign, 3000, 'no longer needed');
  assert.equal(campaign.status, 'cancelled');
  assert.ok(campaign.assignments.every((a) => a.status === 'skipped'));
  assert.throws(() => cancelFleetV7Campaign(campaign), /không huỷ được/);
});

// ---------------------------------------------------------------------------
// Rollback
// ---------------------------------------------------------------------------

test('fleet v110: rollback keeps done bots, rolls back running/pending, snapshots', () => {
  const campaign = createFleetV7Campaign({ goal: 'x', bots: bots(10) }, 1000);
  startFleetV7Campaign(campaign, 1000);
  reportFleetV7BotProgress(campaign, 'bot-1', { progressPercent: 100, status: 'done' }, 2000);
  advanceFleetV7Rollout(campaign, 2000);
  // Staged bots 2-3: one running, one untouched.
  reportFleetV7BotProgress(campaign, 'bot-2', { progressPercent: 55 }, 2500);
  const result = rollbackFleetV7Campaign(campaign, 'canary regression in prod', 3000);
  assert.deepEqual(result.rolledBackBots.sort(), ['bot-10', 'bot-2', 'bot-3', 'bot-4', 'bot-5', 'bot-6', 'bot-7', 'bot-8', 'bot-9']);
  assert.deepEqual(result.keptDoneBots, ['bot-1']);
  assert.equal(result.snapshot.reason, 'canary regression in prod');
  assert.equal(result.snapshot.stageIndex, 1);
  assert.equal(result.snapshot.assignments.length, 10);
  assert.equal(campaign.status, 'rolled-back');
  assert.equal(campaign.rollbackSnapshots.length, 1);
  assert.equal(campaign.stages[1].status, 'rolled-back');
  assert.throws(() => rollbackFleetV7Campaign(campaign, 'again'), /chỉ rollback được campaign active\/paused/);
  assert.throws(() => advanceFleetV7Rollout(campaign), /chỉ advance được campaign active/);
});

// ---------------------------------------------------------------------------
// Report + persistence
// ---------------------------------------------------------------------------

test('fleet v110: report aggregates per stage and per node, auto-finishes', () => {
  const campaign = createFleetV7Campaign({ goal: 'x', bots: bots(4) }, 1000);
  startFleetV7Campaign(campaign, 1000);
  reportFleetV7BotProgress(campaign, 'bot-1', { progressPercent: 100, status: 'done' }, 2000);
  advanceFleetV7Rollout(campaign, 2000);
  finishStageBots(campaign, 1, { 'bot-2': 'done' });
  const report = summarizeFleetV7Campaign(campaign, 5000);
  assert.equal(report.totalBots, 4);
  assert.equal(report.done, 2);
  assert.equal(report.progressPercent, 50);
  assert.equal(report.successRate, 1);
  assert.equal(report.stages.length, 4);
  assert.equal(report.stages[0].successRate, 1);
  assert.equal(report.nodes.length, 2);
  assert.equal(report.nodes.find((n) => n.nodeId === 'node-a').done, 1);
  assert.equal(report.elapsedMs, 4000);
  // Finish the rest: campaign auto-finishes.
  finishStageBots(campaign, 2, { 'bot-3': 'done' });
  finishStageBots(campaign, 3, { 'bot-4': 'done' });
  assert.equal(campaign.status, 'done');
  const final = summarizeFleetV7Campaign(campaign, 6000);
  assert.equal(final.progressPercent, 100);
  assert.equal(final.successRate, 1);
});

test('fleet v110: clone resets run state, keeps plan + gates', () => {
  const campaign = createFleetV7Campaign(
    { goal: 'original', bots: bots(4), minSuccessRate: 0.9, maxFailures: 0 },
    1000,
  );
  startFleetV7Campaign(campaign, 1000);
  reportFleetV7BotProgress(campaign, 'bot-1', { progressPercent: 100, status: 'done' }, 2000);
  const cloned = cloneFleetV7Campaign(campaign, 5000, 'rerun');
  assert.notEqual(cloned.id, campaign.id);
  assert.equal(cloned.goal, 'rerun');
  assert.equal(cloned.status, 'draft');
  assert.equal(cloned.currentStageIndex, -1);
  assert.equal(cloned.rollbackSnapshots.length, 0);
  assert.deepEqual(
    cloned.stages.map((s) => [s.stage, s.botIds.length, s.status, s.minSuccessRate, s.maxFailures]),
    campaign.stages.map((s) => [s.stage, s.botIds.length, 'pending', 0.9, 0]),
  );
  assert.ok(cloned.assignments.every((a) => a.status === 'pending' && a.progressPercent === 0 && a.attempts === 0));
  assert.match(cloned.history[0].note, /Cloned from campaign/);
  validateFleetV7Campaign(cloned);
  // Clone without a goal override keeps the goal.
  assert.equal(cloneFleetV7Campaign(campaign, 5000).goal, 'original');
  assert.throws(() => cloneFleetV7Campaign(campaign, 5000, '  '), /goal mới không rỗng/);
});

test('fleet v110: rollout plan is a read-only dry-run with node warnings', () => {
  const campaign = createFleetV7Campaign(
    {
      goal: 'x',
      bots: bots(4),
      nodes: [
        { id: 'node-a', status: 'online' },
        { id: 'node-b', status: 'offline' },
      ],
    },
    1000,
  );
  const plan = planFleetV7Rollout(campaign);
  assert.equal(plan.campaignId, campaign.id);
  assert.equal(plan.totalBots, 4);
  assert.equal(plan.steps.length, 4);
  assert.deepEqual(
    plan.steps.map((s) => [s.stage, s.botIds]),
    [
      ['canary', ['bot-1']],
      ['staged', ['bot-2']],
      ['staged', ['bot-3']],
      ['full', ['bot-4']],
    ],
  );
  assert.deepEqual(plan.steps[0].nodeIds, ['node-a']);
  assert.deepEqual(plan.steps[1].nodeIds, ['node-b']);
  assert.equal(plan.steps[0].warnings.length, 0);
  assert.equal(plan.steps[1].warnings.length, 1);
  assert.match(plan.steps[1].warnings[0], /offline/);
  assert.equal(plan.warnings.length, 2); // bot-2 + bot-4 are on offline node-b
  // Pure: planning changes nothing.
  assert.equal(campaign.status, 'draft');
  assert.equal(campaign.currentStageIndex, -1);
});

test('fleet v110: persistence round-trip + corrupt file + missing file', () => {
  const dir = tmpDir();
  const fleetRoot = path.join(dir, 'fleet');
  assert.deepEqual(loadFleetV7Campaigns(fleetRoot), []);
  const campaign = createFleetV7Campaign({ goal: 'persist me', bots: bots(3) }, 1000);
  startFleetV7Campaign(campaign, 1000);
  saveFleetV7Campaigns(fleetRoot, [campaign]);
  const filePath = path.join(fleetRoot, FLEET_V7_CAMPAIGNS_FILE);
  assert.ok(fs.existsSync(filePath));
  const loaded = loadFleetV7Campaigns(fleetRoot);
  assert.equal(loaded.length, 1);
  assert.equal(findFleetV7Campaign(loaded, campaign.id).goal, 'persist me');
  assert.equal(loaded[0].status, 'active');
  // Corrupt JSON throws a clear error.
  fs.writeFileSync(filePath, '{not json', 'utf8');
  assert.throws(() => loadFleetV7Campaigns(fleetRoot), /not valid JSON/);
  fs.writeFileSync(filePath, '[]', 'utf8');
  assert.deepEqual(loadFleetV7Campaigns(fleetRoot), []);
});
