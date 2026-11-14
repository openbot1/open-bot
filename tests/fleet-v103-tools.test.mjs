/**
 * Tests for the fleet/marketplace v3 tools (packages/tools/src/fleetV103Tools.ts).
 *
 * Covers registry membership (each of the 4 names exactly once in
 * ALL_TOOLS), the unbound placeholder message, bound execution against
 * a temp userData dir (fleet overview on an empty fleet, placement
 * planning, marketplace search with compatibility, plugin update +
 * dependency check), and `createDefaultTools` binding without
 * duplicates.
 *
 * Run after building tools (which builds core first):
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/fleet-v103-tools.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { ALL_TOOLS, createDefaultTools } from '../packages/tools/dist/tools.js';
import {
  FLEET_V103_TOOL_NAMES,
  FLEET_V103_TOOLS,
  createFleetV103Tools,
} from '../packages/tools/dist/fleetV103Tools.js';
import { BotMemory, defaultToolFactory } from '../packages/core/dist/index.js';
import { createPluginTemplate, savePluginTemplate } from '../packages/core/dist/plugins/templates.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-fleet-tools-'));
}

function toolByName(tools, name) {
  const found = tools.filter((t) => t.definition.name === name);
  assert.equal(found.length, 1, `expected exactly one tool named ${name}, got ${found.length}`);
  return found[0];
}

function toolNames(tools) {
  return tools.map((t) => t.definition.name);
}

test('fleet v3 tools: all 4 are registered in ALL_TOOLS exactly once', () => {
  assert.equal(FLEET_V103_TOOLS.length, 4);
  assert.deepEqual([...FLEET_V103_TOOL_NAMES], ['fleet_overview', 'fleet_schedule_plan', 'marketplace_v3_search', 'plugin_marketplace_v3_check']);
  assert.deepEqual(toolNames(FLEET_V103_TOOLS), [...FLEET_V103_TOOL_NAMES]);
  for (const name of FLEET_V103_TOOL_NAMES) {
    assert.equal(toolNames(ALL_TOOLS).filter((n) => n === name).length, 1, `${name} must appear exactly once in ALL_TOOLS`);
    const tool = toolByName(ALL_TOOLS, name);
    assert.equal(tool.needsApproval, false, `${name} is read-only`);
    assert.equal(tool.definition.parameters.type, 'object');
  }
  assert.equal(new Set(toolNames(ALL_TOOLS)).size, ALL_TOOLS.length, 'no duplicate tool names in ALL_TOOLS');
  // The full agent registry (defaultToolFactory) counts every tool the
  // agent can call: 259 in v1.02 + 5 CodeAct/harness (T1) + 6 memory_v4_* (T2)
  // + 4 acp_host_* (T3) + 7 workspace_* (T4) + these 4 = 285; v1.04 (Đội T1): + 8 memory_v5_* = 293; v1.05 (Đội T1): + 8 memory_v6_* = 301; v1.05 (Đội T5): + 9 voice_v4_* = 310; v1.05 (Đội T4): + 9 context_v2_* = 319; v1.05 (Đội T3): + 8 openmausbot_v105_* = 327; v1.05 (Team T6): + 11 eval/fleet v105_* = 338; v1.05 (Đội T2): + 7 mcp_v2_* = 345.
  const ws = tmpDir();
  const mem = new BotMemory(ws);
  try {
    const tools = defaultToolFactory(mem, ws, 'bot-1');
    const names = toolNames(tools);
    assert.equal(names.length, 345, `expected 345 tools, got ${names.length}`);    assert.equal(new Set(names).size, names.length, 'duplicate tool names in the agent registry');
    for (const name of FLEET_V103_TOOL_NAMES) assert.ok(names.includes(name), name);
  } finally {
    mem.close();
  }
});

test('fleet v3 tools: unbound placeholders explain themselves instead of guessing paths', async () => {
  for (const tool of FLEET_V103_TOOLS) {
    const out = await tool.execute({ botId: 'bot-x', cpuCores: 1, ramBytes: 1024, diskBytes: 1024 });
    assert.match(out, /not wired/, `${tool.definition.name} must say it is not wired`);
    assert.match(out, /fleet console UI/);
  }
  // A resolver that throws is treated as unbound, never fatal.
  const broken = createFleetV103Tools(() => {
    throw new Error('boom');
  });
  assert.match(await broken[0].execute({}), /not wired/);
});

test('fleet v3 tools: bound fleet_overview + fleet_schedule_plan on an empty fleet', async () => {
  const base = tmpDir();
  const tools = createFleetV103Tools(() => base);
  const overview = JSON.parse(await toolByName(tools, 'fleet_overview').execute({}));
  assert.equal(overview.workspaces, 0);
  assert.equal(overview.ram.allocated, 0);
  assert.equal(overview.ram.used, null);
  assert.deepEqual(overview.alerts, { warning: 0, breach: 0 });
  const plan = JSON.parse(
    await toolByName(tools, 'fleet_schedule_plan').execute({
      botId: 'bot-new', cpuCores: 1, ramBytes: 1024 * 1024 * 1024, diskBytes: 10 * 1024 ** 3,
    }),
  );
  assert.equal(plan.best, null);
  assert.deepEqual(plan.candidates, []);
  // Invalid strategy is a clean error, not a crash.
  const bad = await toolByName(tools, 'fleet_schedule_plan').execute({
    botId: 'bot-new', cpuCores: 1, ramBytes: 1024, diskBytes: 1024, strategy: 'random',
  });
  assert.match(bad, /strategy must be 'spread' or 'binpack'/);
});

test('fleet v3 tools: marketplace_v3_search returns catalog entries with compatibility', async () => {
  const base = tmpDir();
  const tools = createFleetV103Tools(() => base, () => ['web_search']);
  const results = JSON.parse(await toolByName(tools, 'marketplace_v3_search').execute({ query: 'code' }));
  assert.ok(results.length > 0);
  assert.ok(results.length <= 20);
  for (const entry of results) {
    assert.ok(entry.compatibility, 'each result carries a compatibility check');
    assert.equal(entry.compatibility.entryId, entry.id);
    assert.ok(Array.isArray(entry.compatibility.requiredTools));
  }
  const badSort = await toolByName(tools, 'marketplace_v3_search').execute({ sort: 'weird' });
  assert.match(badSort, /sort must be rating, installs, name or newest/);
});

test('fleet v3 tools: plugin_marketplace_v3_check finds updates and missing deps', async () => {
  const base = tmpDir();
  const pluginsDir = path.join(base, 'plugins');
  const templatesDir = path.join(base, 'plugin-templates');
  const dir = path.join(pluginsDir, 'notes');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'manifest.json'),
    JSON.stringify({
      id: 'notes', name: 'Notes', version: '1.0.0', description: 'Notes.', permissions: ['fs'], main: 'index.js',
      dependencies: ['helper', 'missing-dep'],
    }),
    'utf8',
  );
  fs.writeFileSync(path.join(dir, 'index.js'), '// entry\n', 'utf8');
  const helperDir = path.join(pluginsDir, 'helper');
  fs.mkdirSync(helperDir, { recursive: true });
  fs.writeFileSync(
    path.join(helperDir, 'manifest.json'),
    JSON.stringify({ id: 'helper', name: 'Helper', version: '1.0.0', description: 'Helper.', permissions: [], main: 'index.js' }),
    'utf8',
  );
  fs.writeFileSync(path.join(helperDir, 'index.js'), '// entry\n', 'utf8');
  savePluginTemplate(
    templatesDir,
    createPluginTemplate({
      id: 'notes',
      name: 'Template notes',
      description: 'Template notes.',
      manifest: { id: 'notes', name: 'Template notes', version: '1.2.0', description: 'Template notes.', author: 'tester', permissions: ['fs'], main: 'index.js' },
      config: { entrySource: '// entry\n' },
    }),
  );

  const tools = createFleetV103Tools(() => base);
  const check = JSON.parse(await toolByName(tools, 'plugin_marketplace_v3_check').execute({}));
  assert.equal(check.updatesAvailable.length, 1);
  assert.equal(check.updatesAvailable[0].entryId, 'notes');
  assert.equal(check.updatesAvailable[0].installedVersion, '1.0.0');
  assert.equal(check.updatesAvailable[0].latestVersion, '1.2.0');
  assert.equal(check.upToDate, 1, 'helper has no template -> up to date');
  const notesDeps = check.dependencyChecks.find((c) => c.entryId === 'notes');
  assert.deepEqual(notesDeps.missing, ['missing-dep']);
  assert.equal(notesDeps.satisfied, false);
});

test('fleet v3 tools: createDefaultTools binds them without duplicates', async () => {
  const base = tmpDir();
  const bound = createDefaultTools({ getFleetV103BaseDir: () => base });
  assert.equal(bound.length, ALL_TOOLS.length);
  assert.equal(new Set(toolNames(bound)).size, bound.length);
  for (const name of FLEET_V103_TOOL_NAMES) {
    assert.equal(toolNames(bound).filter((n) => n === name).length, 1);
  }
  // The bound fleet_overview really reads the given base dir.
  const overview = JSON.parse(await toolByName(bound, 'fleet_overview').execute({}));
  assert.equal(overview.workspaces, 0);
  // No opts -> the plain registry (placeholders still present, once).
  const plain = createDefaultTools();
  assert.equal(plain.length, ALL_TOOLS.length);
  assert.match(await toolByName(plain, 'fleet_overview').execute({}), /not wired/);
});
