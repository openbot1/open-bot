/**
 * Tests for the fleet v5 tools (packages/tools/src/fleetV5Tools.ts).
 *
 * Covers registry membership (each of the 10 names exactly once in
 * ALL_TOOLS, no duplicates), the unbound behaviour (file-backed
 * tools say "not wired", the pure conflict scan still runs), bound
 * execution against a temp userData dir (campaign create/status/
 * task-add dedup/claim/complete round-trip, budget set/check/history
 * round-trip with soft/hard levels, health dashboard), and
 * `createDefaultTools` binding without duplicates.
 *
 * Run after building tools (which builds core first):
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/fleet-v108-tools.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { ALL_TOOLS, createDefaultTools } from '../packages/tools/dist/tools.js';
import {
  FLEET_V5_TOOL_NAMES,
  FLEET_V5_TOOLS,
  createFleetV5Tools,
} from '../packages/tools/dist/fleetV5Tools.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-fleet-v5-tools-'));
}

function toolByName(tools, name) {
  const found = tools.filter((t) => t.definition.name === name);
  assert.equal(found.length, 1, `expected exactly one tool named ${name}, got ${found.length}`);
  return found[0];
}

function toolNames(tools) {
  return tools.map((t) => t.definition.name);
}

const CTX = { workspaceDir: '/tmp', signal: undefined };
const GB = 1024 * 1024 * 1024;

function boundTools() {
  const base = tmpDir();
  return { base, tools: createFleetV5Tools(() => base) };
}

async function createCampaign(tools, overrides = {}) {
  const create = toolByName(tools, 'fleet_v5_campaign_create');
  const out = await create.execute(
    {
      goal: 'Nâng cấp fleet lên v5',
      repos: ['open-bot'],
      tasks: [
        { repo: 'open-bot', title: 'Viết budget v2', brief: 'Cài đặt budget.', priority: 'high', paths: ['packages/core/src/fleet/fleetV5Budget.ts'] },
        { repo: 'open-bot', title: 'Viết health dashboard', brief: 'Dashboard.', priority: 'medium', paths: ['packages/core/src/fleet/fleetV5Health.ts'] },
      ],
      ...overrides,
    },
    CTX,
  );
  assert.ok(!out.startsWith('Error:'), out);
  return JSON.parse(out).campaign;
}

test('registry: all 10 fleet v5 tools in ALL_TOOLS exactly once', () => {
  for (const name of FLEET_V5_TOOL_NAMES) {
    assert.ok(toolNames(ALL_TOOLS).includes(name), `ALL_TOOLS missing ${name}`);
    assert.equal(toolNames(ALL_TOOLS).filter((n) => n === name).length, 1, `${name} duplicated`);
  }
  assert.equal(FLEET_V5_TOOLS.length, 10);
  assert.equal(new Set(toolNames(ALL_TOOLS)).size, toolNames(ALL_TOOLS).length, 'ALL_TOOLS has duplicate names');
  assert.equal(ALL_TOOLS.length, 359); // v1.10 merge: 236 + 53 = 289; v1.11 merge: 289 + 70 = 359
});

test('unbound: file-backed tools say not wired; conflict scan still runs', async () => {
  const create = toolByName(FLEET_V5_TOOLS, 'fleet_v5_campaign_create');
  assert.match(await create.execute({ goal: 'g', repos: ['r'] }, CTX), /not wired/);
  const status = toolByName(FLEET_V5_TOOLS, 'fleet_v5_campaign_status');
  assert.match(await status.execute({}, CTX), /not wired/);
  const budget = toolByName(FLEET_V5_TOOLS, 'fleet_v5_budget_check');
  assert.match(await budget.execute({ botId: 'b', cpuCores: 1, ramBytes: 1, diskBytes: 1 }, CTX), /not wired/);
  const health = toolByName(FLEET_V5_TOOLS, 'fleet_v5_health_dashboard');
  assert.match(await health.execute({}, CTX), /not wired/);

  const scan = toolByName(FLEET_V5_TOOLS, 'fleet_v5_conflict_scan');
  const out = await scan.execute(
    {
      files: [
        { path: 'src/a.ts', content: `import { b } from './b';` },
        { path: 'src/b.ts', content: `// b` },
      ],
      tasks: [
        { id: 't1', repo: 'open-bot', paths: ['src/a.ts'] },
        { id: 't2', repo: 'open-bot', paths: ['src/b.ts'] },
      ],
    },
    CTX,
  );
  assert.ok(!out.startsWith('Error:'), out);
  const parsed = JSON.parse(out);
  assert.equal(parsed.sweep.edgeCount, 1);
  assert.equal(parsed.conflictCount, 1);
  assert.equal(parsed.conflicts[0].kind, 'dependency-order');
});

test('bound: campaign create/status round-trip + set-status pause/resume', async () => {
  const { tools } = boundTools();
  const campaign = await createCampaign(tools);
  assert.equal(campaign.totalTasks, 2);
  assert.equal(campaign.queued, 2);
  assert.equal(campaign.progressPercent, 0);

  const status = toolByName(tools, 'fleet_v5_campaign_status');
  const one = JSON.parse(await status.execute({ campaignId: campaign.id }, CTX));
  assert.equal(one.tasks.length, 2);
  assert.deepEqual(one.blocked, []);
  const all = JSON.parse(await status.execute({}, CTX));
  assert.equal(all.count, 1);

  const paused = JSON.parse(
    await status.execute({ campaignId: campaign.id, action: 'set-status', newStatus: 'paused' }, CTX),
  );
  assert.equal(paused.campaign.status, 'paused');
  assert.match(
    await status.execute({ campaignId: 'no-such', action: 'set-status', newStatus: 'paused' }, CTX),
    /Không có campaign/,
  );
});

test('bound: task add dedups; claim respects priority; complete advances progress', async () => {
  const { tools } = boundTools();
  const campaign = await createCampaign(tools);
  const add = toolByName(tools, 'fleet_v5_campaign_task_add');
  const dup = JSON.parse(
    await add.execute(
      { campaignId: campaign.id, repo: 'open-bot', title: 'Viết budget v2', brief: 'Làm lại.', paths: ['packages/core/src/fleet/fleetV5Budget.ts'] },
      CTX,
    ),
  );
  assert.equal(dup.deduplicated, true);
  assert.equal(dup.dedupMerged, 1);
  const fresh = JSON.parse(
    await add.execute(
      { campaignId: campaign.id, repo: 'open-bot', title: 'Viết docs', brief: 'Docs.', paths: ['docs/fleet.md'] },
      CTX,
    ),
  );
  assert.equal(fresh.deduplicated, false);

  const claim = toolByName(tools, 'fleet_v5_campaign_task_claim');
  const claimed = JSON.parse(await claim.execute({ botId: 'bot-1' }, CTX));
  assert.equal(claimed.claimed, true);
  assert.equal(claimed.task.title, 'Viết budget v2'); // high trước medium
  const none = JSON.parse(await claim.execute({ botId: 'bot-1' }, CTX));
  assert.equal(none.claimed, false); // bot-1 đã giữ 1 task (max mặc định 1)
  assert.match(none.reason, /đã giữ 1 task/);

  const complete = toolByName(tools, 'fleet_v5_campaign_task_complete');
  const started = JSON.parse(
    await complete.execute({ campaignId: campaign.id, taskId: claimed.task.id, outcome: 'start' }, CTX),
  );
  assert.equal(started.task.status, 'running');
  const done = JSON.parse(
    await complete.execute({ campaignId: campaign.id, taskId: claimed.task.id, outcome: 'done', note: 'Xong.' }, CTX),
  );
  assert.equal(done.task.status, 'done');
  assert.equal(done.campaign.progressPercent, 33); // 1/3 task done
  assert.match(
    await complete.execute({ campaignId: campaign.id, taskId: claimed.task.id, outcome: 'done' }, CTX),
    /chỉ complete được/,
  );
});

test('bound: task fail requeues then fails permanently after maxAttempts', async () => {
  const { tools } = boundTools();
  const campaign = await createCampaign(tools);
  const claim = toolByName(tools, 'fleet_v5_campaign_task_claim');
  const complete = toolByName(tools, 'fleet_v5_campaign_task_complete');
  const claimed = JSON.parse(await claim.execute({ botId: 'bot-1', maxActivePerBot: 1 }, CTX));
  const failOnce = JSON.parse(
    await complete.execute({ campaignId: campaign.id, taskId: claimed.task.id, outcome: 'failed', maxAttempts: 2 }, CTX),
  );
  assert.equal(failOnce.task.status, 'queued'); // còn lượt -> requeue
  assert.equal(failOnce.task.attempts, 1);
  const claimedAgain = JSON.parse(await claim.execute({ botId: 'bot-1' }, CTX));
  assert.equal(claimedAgain.task.id, claimed.task.id); // high vẫn claim trước
  const failLast = JSON.parse(
    await complete.execute({ campaignId: campaign.id, taskId: claimed.task.id, outcome: 'failed', maxAttempts: 2 }, CTX),
  );
  assert.equal(failLast.task.status, 'failed');
  assert.equal(failLast.task.attempts, 2);
});

test('bound: budget set/check/history — soft warn, over-soft throttle, over-hard stop', async () => {
  const { tools, base } = boundTools();
  const set = toolByName(tools, 'fleet_v5_budget_set');
  const check = toolByName(tools, 'fleet_v5_budget_check');
  const history = toolByName(tools, 'fleet_v5_budget_history');
  const soft = { cpuCores: 1, ramBytes: 1 * GB, diskBytes: 10 * GB };
  const hard = { cpuCores: 2, ramBytes: 2 * GB, diskBytes: 20 * GB };
  const saved = JSON.parse(
    await set.execute({ botId: 'bot-1', soft, hard }, CTX),
  );
  assert.equal(saved.budget.botId, 'bot-1');
  assert.equal(saved.budget.preSoftWarnPercent, 0.8);
  // hard < soft bị từ chối, không ghi đè.
  assert.match(
    await set.execute({ botId: 'bot-1', soft, hard: { cpuCores: 0.5, ramBytes: 2 * GB, diskBytes: 20 * GB } }, CTX),
    /không được nhỏ hơn soft/,
  );

  const ok = JSON.parse(await check.execute({ botId: 'bot-1', cpuCores: 0.5, ramBytes: 0.5 * GB, diskBytes: 5 * GB }, CTX));
  assert.equal(ok.action, 'none');
  const warn = JSON.parse(await check.execute({ botId: 'bot-1', cpuCores: 0.5, ramBytes: 0.85 * GB, diskBytes: 5 * GB }, CTX));
  assert.equal(warn.action, 'warn');
  assert.equal(warn.overallLevel, 'approaching-soft');
  const throttle = JSON.parse(await check.execute({ botId: 'bot-1', cpuCores: 1.5, ramBytes: 0.5 * GB, diskBytes: 5 * GB }, CTX));
  assert.equal(throttle.action, 'throttle');
  assert.equal(throttle.shouldBlockNewTasks, true);
  const stop = JSON.parse(await check.execute({ botId: 'bot-1', cpuCores: 0.5, ramBytes: 0.5 * GB, diskBytes: 25 * GB }, CTX));
  assert.equal(stop.action, 'stop');
  assert.equal(stop.shouldStop, true);

  const hist = JSON.parse(await history.execute({ botId: 'bot-1' }, CTX));
  assert.equal(hist.summary.samples, 4);
  assert.equal(hist.summary.overSoftCount, 1);
  assert.equal(hist.summary.overHardCount, 1);
  assert.equal(hist.summary.peak.diskBytes, 25 * GB);
  assert.equal(hist.recentSamples.length, 4);
  assert.equal(hist.latestEvaluation.action, 'stop');
  // File budget đã ghi xuống đĩa.
  assert.ok(fs.existsSync(path.join(base, 'fleet', 'fleet-budgets-v108.json')));
  assert.ok(fs.existsSync(path.join(base, 'fleet', 'fleet-budget-history-v108.json')));
  // Bot chưa đặt budget thì check vẫn chạy, không giới hạn.
  const noBudget = JSON.parse(await check.execute({ botId: 'bot-2', cpuCores: 99, ramBytes: 99, diskBytes: 99 }, CTX));
  assert.equal(noBudget.action, 'none');
  assert.equal(noBudget.budgetEnabled, false);
});

test('bound: health dashboard phản ánh campaign + budget + bot', async () => {
  const { tools } = boundTools();
  const campaign = await createCampaign(tools);
  const health = toolByName(tools, 'fleet_v5_health_dashboard');
  const empty = JSON.parse(await health.execute({}, CTX));
  assert.equal(empty.dashboard.campaigns.length, 1);
  assert.equal(empty.dashboard.totals.campaignsActive, 1);
  assert.equal(empty.dashboard.totals.tasksQueued, 2);
  assert.match(empty.line, /campaigns 1\/1 active/);
  // Đặt budget + ghi sample over-hard -> dashboard báo stopped + warning.
  const set = toolByName(tools, 'fleet_v5_budget_set');
  const check = toolByName(tools, 'fleet_v5_budget_check');
  await set.execute({
    botId: 'bot-1',
    soft: { cpuCores: 1, ramBytes: 1 * GB, diskBytes: 10 * GB },
    hard: { cpuCores: 2, ramBytes: 2 * GB, diskBytes: 20 * GB },
  }, CTX);
  await check.execute({ botId: 'bot-1', cpuCores: 3, ramBytes: 0.5 * GB, diskBytes: 5 * GB }, CTX);
  const after = JSON.parse(await health.execute({}, CTX));
  assert.equal(after.dashboard.bots.length, 1);
  assert.equal(after.dashboard.bots[0].status, 'stopped');
  assert.ok(after.dashboard.warnings.some((w) => w.code === 'bot-over-hard-budget'));
  assert.match(after.line, /1 warning\(s\)/);
  void campaign;
});

test('bound: conflict scan báo same-file + path-overlap khi không có sweep order', async () => {
  const { tools } = boundTools();
  const scan = toolByName(tools, 'fleet_v5_conflict_scan');
  const out = JSON.parse(
    await scan.execute(
      {
        files: [{ path: 'src/a.ts', content: '// no imports' }],
        tasks: [
          { id: 't1', repo: 'open-bot', paths: ['src/a.ts'] },
          { id: 't2', repo: 'open-bot', paths: ['src/a.ts'] },
          { id: 't3', repo: 'open-bot', paths: ['src/'] },
          { id: 't4', repo: 'open-bot', paths: ['src/a.ts'], status: 'done' },
        ],
      },
      CTX,
    ),
  );
  assert.ok(out.conflicts.some((c) => c.kind === 'same-file'));
  assert.ok(out.conflicts.some((c) => c.kind === 'path-overlap'));
  assert.ok(!out.conflicts.some((c) => c.taskAId === 't4' || c.taskBId === 't4')); // done thì bỏ qua
  assert.match(await scan.execute({ files: [], tasks: 'not-an-array' }, CTX), /must be an array of objects/);
});

test('createDefaultTools: bind fleet v5 không trùng tên, unbound giữ placeholder', () => {
  const base = tmpDir();
  const bound = createDefaultTools({ getFleetV5BaseDir: () => base });
  assert.equal(toolNames(bound).length, 359);
  assert.equal(new Set(toolNames(bound)).size, 359);
  for (const name of FLEET_V5_TOOL_NAMES) {
    assert.equal(toolNames(bound).filter((n) => n === name).length, 1);
  }
  const unbound = createDefaultTools({});
  assert.equal(toolNames(unbound).length, 359);
});
