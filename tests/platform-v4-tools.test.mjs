/**
 * Tests for the platform v4 tools (packages/tools/src/platformV4Tools.ts).
 *
 * Covers registry membership (each of the 5 names exactly once in
 * ALL_TOOLS), the unbound placeholder message, bound execution
 * against a temp userData dir (schedule a bot run on a registered
 * node, fleet status, both eval suites, eval report list/load), and
 * `createDefaultTools` binding without duplicates.
 *
 * Run after building tools (which builds core first):
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/platform-v4-tools.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { ALL_TOOLS, createDefaultTools } from '../packages/tools/dist/tools.js';
import {
  PLATFORM_V4_TOOL_NAMES,
  PLATFORM_V4_TOOLS,
  createPlatformV4Tools,
} from '../packages/tools/dist/platformV4Tools.js';
import {
  recordNodeHeartbeat,
  registerFleetNode,
} from '../packages/core/dist/fleet/nodes.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-platform-v4-'));
}

const GB = 1024 ** 3;

function toolByName(tools, name) {
  const found = tools.filter((t) => t.definition.name === name);
  assert.equal(found.length, 1, `expected exactly one tool named ${name}, got ${found.length}`);
  return found[0];
}

function toolNames(tools) {
  return tools.map((t) => t.definition.name);
}

function setupNode(base) {
  const fleetRoot = path.join(base, 'fleet');
  const node = registerFleetNode(fleetRoot, {
    hostname: 'local', host: '127.0.0.1', port: 18080, role: 'worker',
    cpuCores: 4, ramBytes: 8 * GB, diskBytes: 100 * GB,
  });
  recordNodeHeartbeat(fleetRoot, node.id, { runningJobs: 0, queuedJobs: 0, cpuUsedFraction: 0.1, ramUsedBytes: 1 * GB }, Date.now());
  return node;
}

test('platform v4 tools: all 5 names in ALL_TOOLS exactly once, and in PLATFORM_V4_TOOLS', () => {
  assert.deepEqual([...PLATFORM_V4_TOOL_NAMES], [
    'platform_v4_schedule_bot',
    'platform_v4_fleet_status',
    'platform_v4_run_memory_eval',
    'platform_v4_run_mcp_eval',
    'platform_v4_eval_report',
  ]);
  assert.equal(PLATFORM_V4_TOOLS.length, 5);
  for (const name of PLATFORM_V4_TOOL_NAMES) {
    assert.equal(toolNames(ALL_TOOLS).filter((n) => n === name).length, 1, `${name} must appear exactly once in ALL_TOOLS`);
    assert.equal(toolNames(PLATFORM_V4_TOOLS).filter((n) => n === name).length, 1);
  }
  const scheduleTool = toolByName(ALL_TOOLS, 'platform_v4_schedule_bot');
  assert.equal(scheduleTool.needsApproval, true);
  assert.equal(toolByName(ALL_TOOLS, 'platform_v4_fleet_status').needsApproval, false);
});

test('platform v4 tools: unbound placeholders explain they are not wired', async () => {
  const tools = createPlatformV4Tools();
  for (const name of PLATFORM_V4_TOOL_NAMES) {
    const out = await toolByName(tools, name).execute({});
    assert.match(out, /not wired/);
  }
});

test('platform_v4_schedule_bot + platform_v4_fleet_status on a bound fleet', async () => {
  const base = tmpDir();
  const node = setupNode(base);
  const tools = createPlatformV4Tools(() => base);
  const scheduled = JSON.parse(await toolByName(tools, 'platform_v4_schedule_bot').execute({
    botId: 'bot-a', summary: 'test run', priority: 'high',
    cpuCores: 1, ramBytes: 1 * GB, diskBytes: 10 * GB,
  }));
  assert.equal(scheduled.scheduled, true);
  assert.equal(scheduled.nodeId, node.id);
  assert.equal(scheduled.run.botId, 'bot-a');
  assert.equal(scheduled.run.status, 'scheduled');
  assert.equal(scheduled.queue.scheduled, 1);

  const status = JSON.parse(await toolByName(tools, 'platform_v4_fleet_status').execute({}));
  assert.equal(status.counts.totalNodes, 1);
  assert.equal(status.counts.aliveNodes, 1);
  assert.equal(status.bots.length, 1);
  assert.equal(status.bots[0].botId, 'bot-a');
  assert.equal(status.bots[0].scheduled, 1);
  assert.equal(status.nodes[0].utilization.activeRuns, 1);

  const filtered = JSON.parse(await toolByName(tools, 'platform_v4_fleet_status').execute({ botId: 'bot-a' }));
  assert.equal(filtered.bots.length, 1);
  const none = JSON.parse(await toolByName(tools, 'platform_v4_fleet_status').execute({ botId: 'bot-nope' }));
  assert.equal(none.bots.length, 0);
  fs.rmSync(base, { recursive: true, force: true });
});

test('platform_v4_schedule_bot rejects a bad priority', async () => {
  const base = tmpDir();
  setupNode(base);
  const tools = createPlatformV4Tools(() => base);
  const out = await toolByName(tools, 'platform_v4_schedule_bot').execute({
    botId: 'bot-a', summary: 'x', priority: 'urgent',
  });
  assert.match(out, /priority must be one of/);
  fs.rmSync(base, { recursive: true, force: true });
});

test('platform_v4_run_memory_eval + platform_v4_run_mcp_eval pass and save reports', async () => {
  const base = tmpDir();
  const tools = createPlatformV4Tools(() => base);
  const memOut = await toolByName(tools, 'platform_v4_run_memory_eval').execute({});
  assert.match(memOut, /\[memory\] 8 passed, 0 failed/);
  assert.match(memOut, /Report saved to:/);
  const mcpOut = await toolByName(tools, 'platform_v4_run_mcp_eval').execute({});
  assert.match(mcpOut, /\[mcp-conformance\] 7 passed, 0 failed/);
  const reportsDir = path.join(base, 'eval-reports');
  assert.equal(fs.readdirSync(reportsDir).length, 2);
  fs.rmSync(base, { recursive: true, force: true });
});

test('platform_v4_eval_report lists reports and loads one by id', async () => {
  const base = tmpDir();
  const tools = createPlatformV4Tools(() => base);
  const empty = JSON.parse(await toolByName(tools, 'platform_v4_eval_report').execute({}));
  assert.deepEqual(empty, []);
  await toolByName(tools, 'platform_v4_run_memory_eval').execute({});
  const listed = JSON.parse(await toolByName(tools, 'platform_v4_eval_report').execute({}));
  assert.equal(listed.length, 1);
  assert.equal(listed[0].passed, 8);
  const one = await toolByName(tools, 'platform_v4_eval_report').execute({ reportId: listed[0].id });
  assert.match(one, /8 passed, 0 failed/);
  assert.match(one, /PASS  memory\.recall-after-20-turns/);
  const missing = await toolByName(tools, 'platform_v4_eval_report').execute({ reportId: 'eval-nope' });
  assert.match(missing, /not found/);
  const badSuite = await toolByName(tools, 'platform_v4_eval_report').execute({ suite: 'nope' });
  assert.match(badSuite, /suite must be/);
  fs.rmSync(base, { recursive: true, force: true });
});

test('platform v4 tools: createDefaultTools binds them without duplicates', async () => {
  const base = tmpDir();
  setupNode(base);
  const bound = createDefaultTools({ getPlatformV4BaseDir: () => base });
  for (const name of PLATFORM_V4_TOOL_NAMES) {
    assert.equal(toolNames(bound).filter((n) => n === name).length, 1, `${name} must appear exactly once after binding`);
  }
  const status = JSON.parse(await toolByName(bound, 'platform_v4_fleet_status').execute({}));
  assert.equal(status.counts.totalNodes, 1);
  const plain = createDefaultTools();
  assert.match(await toolByName(plain, 'platform_v4_fleet_status').execute({}), /not wired/);
  fs.rmSync(base, { recursive: true, force: true });
});
