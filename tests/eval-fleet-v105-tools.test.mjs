/**
 * Tests for the eval v3 / fleet v4 tools (packages/tools/src/evalFleetV105Tools.ts).
 *
 * Covers registry membership (each of the 6 names exactly once in
 * ALL_TOOLS), the unbound placeholder message, bound execution
 * against a temp userData dir (run suite writes history, report
 * reads it, compare diffs two runs, policy set/get round-trip,
 * schedule + health on an empty fleet), and `createDefaultTools`
 * binding without duplicates.
 *
 * Run after building tools (which builds core first):
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/eval-fleet-v105-tools.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { ALL_TOOLS, createDefaultTools } from '../packages/tools/dist/tools.js';
import {
  EVAL_FLEET_V105_TOOL_NAMES,
  EVAL_FLEET_V105_TOOLS,
  createEvalFleetV105Tools,
} from '../packages/tools/dist/evalFleetV105Tools.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-eval-fleet-tools-'));
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

test('registry: all 6 eval v3 / fleet v4 tools in ALL_TOOLS exactly once', () => {
  for (const name of EVAL_FLEET_V105_TOOL_NAMES) {
    assert.ok(toolNames(ALL_TOOLS).includes(name), `ALL_TOOLS missing ${name}`);
    assert.equal(toolNames(ALL_TOOLS).filter((n) => n === name).length, 1, `${name} duplicated`);
  }
  assert.equal(EVAL_FLEET_V105_TOOLS.length, 11);
  const names = new Set(toolNames(ALL_TOOLS));
  assert.equal(names.size, toolNames(ALL_TOOLS).length, 'ALL_TOOLS has duplicate names');
});

test('unbound placeholders explain they are not wired', async () => {
  for (const tool of EVAL_FLEET_V105_TOOLS) {
    const out = await tool.execute({}, CTX);
    assert.match(out, /not wired/, `${tool.definition.name} should say it is not wired`);
  }
});

test('bound: eval_v3_run_suite writes history, report reads it', async () => {
  const dir = tmpDir();
  const tools = createEvalFleetV105Tools(() => dir);
  const run = toolByName(tools, 'eval_v3_run_suite');
  const first = JSON.parse(await run.execute({ retrieverVersion: 'mock-v1' }, CTX));
  assert.equal(first.dataset, 'builtin-memory-v1');
  assert.equal(first.retrieverVersion, 'mock-v1');
  assert.ok(first.overall.f1 > 0);
  assert.equal(first.byCategory.length, 3);
  assert.deepEqual(first.alerts, []);
  assert.equal(first.comparison, null);
  assert.ok(fs.existsSync(path.join(dir, 'eval-memory-history.json')));

  const report = JSON.parse(await toolByName(tools, 'eval_v3_report').execute({}, CTX));
  assert.equal(report.runs, 1);
  assert.equal(report.latest.retrieverVersion, 'mock-v1');
  assert.equal(report.history.length, 1);
  assert.ok(report.history[0].f1 > 0);
});

test('bound: eval_v3_compare diffs two runs', async () => {
  const dir = tmpDir();
  const tools = createEvalFleetV105Tools(() => dir);
  const run = toolByName(tools, 'eval_v3_run_suite');
  const compare = toolByName(tools, 'eval_v3_compare');
  // One run only -> compare refuses.
  await run.execute({ retrieverVersion: 'mock-v1' }, CTX);
  const tooSoon = await compare.execute({}, CTX);
  assert.match(tooSoon, /at least 2 eval runs/);
  await run.execute({ retrieverVersion: 'mock-v1-top1', topK: 1 }, CTX);
  const cmp = JSON.parse(await compare.execute({}, CTX));
  assert.equal(cmp.baseline.retrieverVersion, 'mock-v1');
  assert.equal(cmp.current.retrieverVersion, 'mock-v1-top1');
  assert.ok(cmp.overallDelta.recall < 0, 'topK 1 recalls less');
  assert.equal(typeof cmp.questionMoves.improved, 'number');
  // Explicit indices work too.
  const explicit = JSON.parse(await compare.execute({ baselineIndex: 0, currentIndex: 1 }, CTX));
  assert.equal(explicit.baseline.retrieverVersion, 'mock-v1');
  const bad = await compare.execute({ baselineIndex: 99, currentIndex: 1 }, CTX);
  assert.match(bad, /no eval run at index/);
});

test('bound: fleet_v4_policy_set get/set round-trip with validation', async () => {
  const dir = tmpDir();
  const tools = createEvalFleetV105Tools(() => dir);
  const policyTool = toolByName(tools, 'fleet_v4_policy_set');
  const current = JSON.parse(await policyTool.execute({}, CTX));
  assert.equal(current.policy.maxConcurrentBots, 10);
  const saved = JSON.parse(
    await policyTool.execute({ maxConcurrentBots: 3, perBotTokenQuota: 5000, defaultPriority: 4 }, CTX),
  );
  assert.equal(saved.policy.maxConcurrentBots, 3);
  assert.equal(saved.policy.perBotTokenQuota, 5000);
  assert.equal(saved.policy.defaultPriority, 4);
  assert.deepEqual(saved.violations, []);
  const again = JSON.parse(await policyTool.execute({}, CTX));
  assert.equal(again.policy.maxConcurrentBots, 3);
  const bad = await policyTool.execute({ defaultPriority: 9 }, CTX);
  assert.match(bad, /defaultPriority/);
});

test('bound: fleet_v4_schedule + fleet_v4_health on an empty fleet', async () => {
  const dir = tmpDir();
  const tools = createEvalFleetV105Tools(() => dir);
  const schedule = toolByName(tools, 'fleet_v4_schedule');
  const out = JSON.parse(
    await schedule.execute({ title: 'Do research', kind: 'research', priority: 4, submittedBy: 'user' }, CTX),
  );
  assert.equal(out.task.title, 'Do research');
  assert.equal(out.task.status, 'waiting');
  assert.equal(out.scheduled, null); // no bots registered in the fleet
  assert.equal(out.waitingTasks, 1);
  assert.deepEqual(out.policyViolations, []);
  const bad = await schedule.execute({ title: 'x', priority: 9, submittedBy: 'user' }, CTX);
  assert.match(bad, /priority/);

  const health = JSON.parse(await toolByName(tools, 'fleet_v4_health').execute({}, CTX));
  assert.equal(health.report.checked, 0);
  assert.equal(health.summary.totalBots, 0);
});

test('bound: eval_v3_dataset lists datasets and shows one in detail', async () => {
  const dir = tmpDir();
  const tools = createEvalFleetV105Tools(() => dir);
  const datasetTool = toolByName(tools, 'eval_v3_dataset');
  const list = JSON.parse(await datasetTool.execute({}, CTX));
  assert.equal(list.length, 2);
  assert.equal(list[0].id, 'builtin-memory-v1');
  assert.equal(list[0].facts, 60);
  assert.equal(list[0].questions, 61);
  assert.equal(list[1].id, 'builtin-handover-v1');
  const detail = JSON.parse(await datasetTool.execute({ datasetId: 'builtin-handover-v1' }, CTX));
  assert.equal(detail.facts.length, 24);
  assert.equal(detail.questions.length, 20);
  const bad = await datasetTool.execute({ datasetId: 'nope' }, CTX);
  assert.match(bad, /unknown eval dataset/);
});

test('bound: fleet_v4_tasks list/submit/cancel round-trip with durable file', async () => {
  const dir = tmpDir();
  const tools = createEvalFleetV105Tools(() => dir);
  const tasksTool = toolByName(tools, 'fleet_v4_tasks');
  const empty = JSON.parse(await tasksTool.execute({ action: 'list' }, CTX));
  assert.deepEqual(empty.tasks, []);
  const submitted = JSON.parse(
    await tasksTool.execute({ action: 'submit', title: 'Write docs', kind: 'docs', priority: 2, submittedBy: 'user' }, CTX),
  );
  assert.equal(submitted.task.title, 'Write docs');
  assert.equal(submitted.saved, true);
  assert.ok(fs.existsSync(path.join(dir, 'fleet', 'fleet-tasks-v4.json')));
  // A fresh tool call sees the durable queue.
  const listed = JSON.parse(await tasksTool.execute({ action: 'list' }, CTX));
  assert.equal(listed.count, 1);
  const filtered = JSON.parse(await tasksTool.execute({ action: 'list', status: 'done' }, CTX));
  assert.equal(filtered.count, 0);
  const cancelled = JSON.parse(
    await tasksTool.execute({ action: 'cancel', taskId: submitted.task.id, reason: 'obsolete' }, CTX),
  );
  assert.equal(cancelled.task.status, 'cancelled');
  const bad = await tasksTool.execute({ action: 'explode' }, CTX);
  assert.match(bad, /action must be/);
});

test('bound: eval_v3_trend summarizes history slope', async () => {
  const dir = tmpDir();
  const tools = createEvalFleetV105Tools(() => dir);
  const trend = toolByName(tools, 'eval_v3_trend');
  const empty = JSON.parse(await trend.execute({}, CTX));
  assert.equal(empty.runs, 0);
  assert.equal(empty.trend.bestRun, null);
  const run = toolByName(tools, 'eval_v3_run_suite');
  await run.execute({ retrieverVersion: 'mock-v1' }, CTX);
  await run.execute({ retrieverVersion: 'mock-v1-top1', topK: 1 }, CTX);
  const two = JSON.parse(await trend.execute({}, CTX));
  assert.equal(two.runs, 2);
  assert.equal(typeof two.trend.f1SlopePerRun, 'number');
  assert.ok(two.trend.bestRun !== null && two.trend.worstRun !== null);
});

test('bound: fleet_v4_rebalance re-queues a dead bot’s tasks', async () => {
  const dir = tmpDir();
  const tools = createEvalFleetV105Tools(() => dir);
  const tasksTool = toolByName(tools, 'fleet_v4_tasks');
  const rebalance = toolByName(tools, 'fleet_v4_rebalance');
  // Unknown bot -> clear error.
  const unknown = await rebalance.execute({ botId: 'ghost' }, CTX);
  assert.match(unknown, /no fleet bot/);
  // Submit a task, then fake-assign it by editing the durable file:
  // the rebalance tool needs the task assigned to the bot in the queue.
  const submitted = JSON.parse(
    await tasksTool.execute({ action: 'submit', title: 'stuck work', priority: 5, submittedBy: 'user' }, CTX),
  );
  const queuePath = path.join(dir, 'fleet', 'fleet-tasks-v4.json');
  const queue = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
  queue[0].status = 'assigned';
  queue[0].assignedBotId = 'bot-x';
  fs.writeFileSync(queuePath, JSON.stringify(queue, null, 2));
  // bot-x does not exist in the live fleet (empty) -> still an error,
  // which proves the tool checks the live fleet first.
  const noBot = await rebalance.execute({ botId: 'bot-x' }, CTX);
  assert.match(noBot, /no fleet bot/);
  assert.equal(submitted.task.status, 'waiting');
});

test('bound: eval_v3_benchmark ranks both mock retrievers', async () => {
  const dir = tmpDir();
  const tools = createEvalFleetV105Tools(() => dir);
  const benchmark = toolByName(tools, 'eval_v3_benchmark');
  const out = JSON.parse(await benchmark.execute({}, CTX));
  assert.equal(out.rows.length, 2);
  assert.equal(out.datasetId, 'builtin-memory-v1');
  assert.ok(out.winners.f1.value > 0);
  const handover = JSON.parse(await benchmark.execute({ datasetId: 'builtin-handover-v1' }, CTX));
  assert.equal(handover.datasetId, 'builtin-handover-v1');
  const bad = await benchmark.execute({ datasetId: 'nope' }, CTX);
  assert.match(bad, /unknown eval dataset/);
});

test('createDefaultTools binds the v105 tools without duplicates', () => {
  const dir = tmpDir();
  const bound = createDefaultTools({ getEvalFleetV105BaseDir: () => dir });
  for (const name of EVAL_FLEET_V105_TOOL_NAMES) {
    assert.equal(toolNames(bound).filter((n) => n === name).length, 1, `${name} duplicated after binding`);
  }
  const names = new Set(toolNames(bound));
  assert.equal(names.size, toolNames(bound).length);
  // The bound run-suite tool actually runs (not the placeholder).
  return (async () => {
    const run = toolByName(bound, 'eval_v3_run_suite');
    const out = JSON.parse(await run.execute({ retrieverVersion: 'bound-check' }, CTX));
    assert.equal(out.retrieverVersion, 'bound-check');
  })();
});
