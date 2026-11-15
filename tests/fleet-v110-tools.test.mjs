/**
 * Fleet v7 tools tests (v1.10, Đội T6 — node:test, no network).
 *
 * Covers:
 *  - Registry: all 9 fleet v7 tools in ALL_TOOLS, unique names, no
 *    duplicates; createDefaultTools({ getFleetV7BaseDir }) binds them
 *    without duplicating (same 9 names, same total)
 *  - Unbound campaign tools answer NOT_WIRED; the 3 pure tools
 *    (mock toolkit list/execute, cerebras models) work unbound
 *  - Bound end-to-end flow on a tmp userData dir: create → progress
 *    → rollout (gate closed, then open) → report → rollback, with
 *    state persisted to fleet-campaigns-v110.json
 *  - Tool arg validation: missing args / bad enum / unknown campaign
 *    return Error strings, never throw
 *  - Mock toolkit tools: list returns 4 mock toolkits; execute runs
 *    mock data; unknown slug returns an Error string
 *  - provider_cerebras_models returns baseUrl/default/known models
 *
 * Imports the BUILT tools + core — build first:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 * then: node --test tests/fleet-v110-tools.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { ALL_TOOLS, createDefaultTools } from '../packages/tools/dist/tools.js';
import { FLEET_V7_TOOLS, createFleetV7Tools } from '../packages/tools/dist/fleetV7Tools.js';

const V7_NAMES = [
  'fleet_campaign_create',
  'fleet_campaign_list',
  'fleet_campaign_rollout',
  'fleet_campaign_progress',
  'fleet_campaign_rollback',
  'fleet_campaign_report',
  'fleet_campaign_pause',
  'fleet_campaign_resume',
  'fleet_campaign_cancel',
  'fleet_campaign_clone',
  'fleet_campaign_plan',
  'composio_mock_toolkit_list',
  'composio_mock_toolkit_execute',
  'provider_cerebras_models',
];

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-fleet-v110-tools-'));
}

function toolByName(tools, name) {
  const tool = tools.find((t) => t.definition.name === name);
  assert.ok(tool, `missing tool ${name}`);
  return tool;
}

async function run(tools, name, args) {
  return toolByName(tools, name).execute(args, {});
}

test('fleet v110 tools: 14 tools in ALL_TOOLS, unique names', () => {
  assert.equal(FLEET_V7_TOOLS.length, 14);
  assert.deepEqual(
    FLEET_V7_TOOLS.map((t) => t.definition.name),
    V7_NAMES,
  );
  for (const name of V7_NAMES) {
    assert.equal(
      ALL_TOOLS.filter((t) => t.definition.name === name).length,
      1,
      `${name} must appear exactly once in ALL_TOOLS`,
    );
  }
  assert.equal(new Set(ALL_TOOLS.map((t) => t.definition.name)).size, ALL_TOOLS.length);
});

test('fleet v110 tools: createDefaultTools binds without duplicating', () => {
  const base = tmpDir();
  const bound = createDefaultTools({ getFleetV7BaseDir: () => base });
  assert.equal(bound.length, ALL_TOOLS.length);
  for (const name of V7_NAMES) {
    assert.equal(
      bound.filter((t) => t.definition.name === name).length,
      1,
      `${name} duplicated after binding`,
    );
  }
  // Bound tools sit where the placeholders were (order preserved).
  assert.deepEqual(
    bound.map((t) => t.definition.name).filter((n) => V7_NAMES.includes(n)),
    V7_NAMES,
  );
});

test('fleet v110 tools: unbound campaign tools say NOT_WIRED, pure tools work', async () => {
  const unbound = createFleetV7Tools();
  const createOut = await run(unbound, 'fleet_campaign_create', {
    goal: 'x',
    bots: [{ botId: 'b1', nodeId: 'n1' }],
  });
  assert.match(createOut, /^Error:.*not wired/);
  const listOut = await run(unbound, 'fleet_campaign_list', {});
  assert.match(listOut, /^Error:.*not wired/);

  const mockList = JSON.parse(await run(unbound, 'composio_mock_toolkit_list', {}));
  assert.equal(mockList.length, 6);
  assert.deepEqual(
    mockList.map((t) => t.slug),
    ['figma', 'supabase', 'vercel', 'todoist', 'intercom', 'miro'],
  );
  assert.ok(mockList.every((t) => t.mockOnly === true && t.liveVerified === false));

  const mockExec = JSON.parse(
    await run(unbound, 'composio_mock_toolkit_execute', { slug: 'TODOIST_LIST_TASKS', args: {} }),
  );
  assert.equal(mockExec.mock, true);
  assert.equal(mockExec.live, false);

  const cerebras = JSON.parse(await run(unbound, 'provider_cerebras_models', {}));
  assert.equal(cerebras.id, 'cerebras');
  assert.equal(cerebras.baseUrl, 'https://api.cerebras.ai/v1');
  assert.equal(cerebras.defaultModel, 'gpt-oss-120b');
  assert.ok(cerebras.knownModels.includes('qwen-3.8-27b'));
  assert.equal(cerebras.vaultNamespace, 'provider');
});

test('fleet v110 tools: bound flow create → progress → rollout → report → rollback', async () => {
  const base = tmpDir();
  const tools = createFleetV7Tools(() => base);
  const created = JSON.parse(
    await run(tools, 'fleet_campaign_create', {
      goal: 'Ship everywhere',
      bots: [
        { botId: 'bot-1', nodeId: 'node-a' },
        { botId: 'bot-2', nodeId: 'node-b' },
        { botId: 'bot-3', nodeId: 'node-a' },
        { botId: 'bot-4', nodeId: 'node-b' },
      ],
    }),
  );
  assert.ok(created.id);
  assert.equal(created.status, 'active');
  assert.equal(created.totalBots, 4);
  // 4 bots: canary [bot-1], staged [bot-2], staged [bot-3], full [bot-4].
  assert.deepEqual(
    created.stages.map((s) => [s.stage, s.bots]),
    [
      ['canary', 1],
      ['staged', 1],
      ['staged', 1],
      ['full', 1],
    ],
  );
  const campaignId = created.id;

  // Gate closed while canary is unfinished.
  const closed = JSON.parse(await run(tools, 'fleet_campaign_rollout', { campaignId }));
  assert.equal(closed.advanced, false);
  assert.match(closed.reason, /chưa kết thúc/);

  const progress = JSON.parse(
    await run(tools, 'fleet_campaign_progress', {
      campaignId,
      botId: 'bot-1',
      progressPercent: 100,
      status: 'done',
    }),
  );
  assert.equal(progress.status, 'done');
  assert.equal(progress.progressPercent, 100);

  const advanced = JSON.parse(await run(tools, 'fleet_campaign_rollout', { campaignId }));
  assert.equal(advanced.advanced, true);
  assert.equal(advanced.stage, 'staged');

  const listed = JSON.parse(await run(tools, 'fleet_campaign_list', {}));
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, campaignId);
  assert.equal(listed[0].done, 1);
  assert.equal(listed[0].currentStage, 'staged');

  const report = JSON.parse(await run(tools, 'fleet_campaign_report', { campaignId }));
  assert.equal(report.totalBots, 4);
  assert.equal(report.done, 1);
  assert.equal(report.progressPercent, 25);
  assert.equal(report.nodes.length, 2);

  const rolledBack = JSON.parse(
    await run(tools, 'fleet_campaign_rollback', { campaignId, reason: 'staging regression' }),
  );
  assert.equal(rolledBack.status, 'rolled-back');
  assert.deepEqual(rolledBack.keptDoneBots, ['bot-1']);
  assert.equal(rolledBack.rolledBackBots.length, 3);

  // State persisted on disk.
  const filePath = path.join(base, 'fleet', 'fleet-campaigns-v110.json');
  assert.ok(fs.existsSync(filePath));
  const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(onDisk[0].status, 'rolled-back');
  assert.equal(onDisk[0].rollbackSnapshots.length, 1);
});

test('fleet v110 tools: plan (dry-run) + pause/resume/cancel/clone', async () => {
  const base = tmpDir();
  const tools = createFleetV7Tools(() => base);
  const created = JSON.parse(
    await run(tools, 'fleet_campaign_create', {
      goal: 'Plan me',
      bots: [
        { botId: 'bot-1', nodeId: 'node-a' },
        { botId: 'bot-2', nodeId: 'node-b' },
      ],
      nodes: [
        { id: 'node-a', status: 'online' },
        { id: 'node-b', status: 'offline' },
      ],
    }),
  );
  const campaignId = created.id;

  const plan = JSON.parse(await run(tools, 'fleet_campaign_plan', { campaignId }));
  assert.equal(plan.totalBots, 2);
  assert.equal(plan.steps.length, 2);
  assert.equal(plan.warnings.length, 1);
  assert.match(plan.warnings[0], /offline/);
  assert.equal(plan.status, 'active'); // planning changes nothing

  const paused = JSON.parse(await run(tools, 'fleet_campaign_pause', { campaignId }));
  assert.equal(paused.status, 'paused');
  const resumed = JSON.parse(await run(tools, 'fleet_campaign_resume', { campaignId }));
  assert.equal(resumed.status, 'active');
  // Pause again then cancel from paused.
  await run(tools, 'fleet_campaign_pause', { campaignId });
  const cancelled = JSON.parse(
    await run(tools, 'fleet_campaign_cancel', { campaignId, note: 'no longer needed' }),
  );
  assert.equal(cancelled.status, 'cancelled');

  // Clone the cancelled campaign: new draft, same plan.
  const cloned = JSON.parse(
    await run(tools, 'fleet_campaign_clone', { campaignId, goal: 'Plan me again' }),
  );
  assert.ok(cloned.id);
  assert.notEqual(cloned.id, campaignId);
  assert.equal(cloned.goal, 'Plan me again');
  assert.equal(cloned.status, 'draft');
  assert.equal(cloned.totalBots, 2);
  const listed = JSON.parse(await run(tools, 'fleet_campaign_list', {}));
  assert.equal(listed.length, 2);
  // The clone is a fresh draft with the same plan (not auto-started).
  const cloneReport = JSON.parse(await run(tools, 'fleet_campaign_report', { campaignId: cloned.id }));
  assert.equal(cloneReport.status, 'draft');
  assert.equal(cloneReport.pending, 2);
});

test('fleet v110 tools: bad args return Error strings, never throw', async () => {
  const base = tmpDir();
  const tools = createFleetV7Tools(() => base);
  assert.match(await run(tools, 'fleet_campaign_create', { goal: 'x' }), /^Error:/);
  assert.match(
    await run(tools, 'fleet_campaign_create', {
      goal: 'x',
      bots: [{ botId: 'b1', nodeId: 'n1' }],
      strategy: 'nope',
    }),
    /^Error:.*strategy/,
  );
  assert.match(await run(tools, 'fleet_campaign_rollout', { campaignId: 'ghost' }), /^Error:/);
  assert.match(await run(tools, 'fleet_campaign_report', { campaignId: 'ghost' }), /^Error:/);
  assert.match(
    await run(tools, 'fleet_campaign_rollback', { campaignId: 'ghost', reason: 'x' }),
    /^Error:/,
  );
  assert.match(
    await run(tools, 'composio_mock_toolkit_execute', { slug: 'GMAIL_SEND_EMAIL' }),
    /^Error:.*không thuộc toolkit mock/,
  );
  assert.match(await run(tools, 'fleet_campaign_progress', {}), /^Error:/);
});
