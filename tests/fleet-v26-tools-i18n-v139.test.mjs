/**
 * Tests for fleet v26 tools + i18n (v1.39, Team T6).
 *
 * Covers:
 * - Pure tool defs: 34 tools, unique snake_case names, no dots,
 *   write/read split.
 * - Runnable tools: unbound says "not configured"; bound state does
 *   the full loop (resources allocate/refuse, bot lifecycle, health,
 *   shared blocks, skill install/match/load, hook evaluate, plugin
 *   install/list, MCP Apps list/CSP, admission evaluate, dashboard)
 *   via `createFleetV26Tools` + `createEmptyFleetV26ToolState`.
 * - defaultToolFactory binding: bound v26 tools replace the
 *   placeholders (same 34 names, no duplicates).
 * - Panels: dashboard joins all nine areas; memory panel flattens a
 *   MemFS tree (cycle-safe, orphans listed); settings panel carries
 *   the admission policy + Apps settings.
 * - i18n: 96 fleet.v26.* keys in all 6 locales, non-empty values,
 *   total keys per locale = 8168 (8072 + 96 fleetV26).
 *
 * Imports the BUILT core + tools — build first:
 *   npm run build --workspace=@open-bot/core && npm run build --workspace=@open-bot/tools
 * then: node --test tests/fleet-v26-tools-i18n-v139.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  FLEET_V26_TOOLS,
  findFleetV26Tool,
  fleetV26ReadTools,
  fleetV26ToolNamesValid,
  fleetV26ToolsByGroup,
  fleetV26WriteTools,
} from '../packages/core/dist/fleetV26/toolsV26.js';
import { FLEET_V26_VERSION } from '../packages/core/dist/fleetV26/index.js';
import {
  buildFleetV26Dashboard,
  buildFleetV26MemoryPanel,
  buildFleetV26SettingsPanel,
} from '../packages/core/dist/fleetV26/panelsV26.js';
import { checkFleetV26FleetHealth } from '../packages/core/dist/fleetV26/health.js';
import {
  FLEET_V26_TOOLS as RUNNABLE_V26_TOOLS,
  createEmptyFleetV26ToolState,
  createFleetV26Tools,
  fleetV26ToolNamesUnique as runnableNamesUnique,
} from '../packages/tools/dist/fleetV26Tools.js';
import { ALL_TOOLS, createDefaultTools } from '../packages/tools/dist/index.js';

const LOCALES = ['en', 'vi', 'es', 'fr', 'ja', 'zh'];

function loadLocale(loc) {
  return JSON.parse(readFileSync(new URL(`../apps/desktop/src/renderer/i18n/locales/${loc}.json`, import.meta.url), 'utf-8'));
}

async function run(tools, name, args = {}) {
  const tool = tools.find((t) => t.definition.name === name);
  assert.ok(tool, `tool ${name} must exist`);
  const out = await tool.execute(args);
  return out;
}

function asJson(out) {
  assert.ok(!out.startsWith('Error:'), `expected JSON, got ${out}`);
  return JSON.parse(out);
}

test('tools v26: defs — 34 tools, names valid, groups', () => {
  assert.equal(FLEET_V26_VERSION, 'v26');
  assert.equal(FLEET_V26_TOOLS.length, 34);
  assert.equal(fleetV26ToolNamesValid(), true);
  assert.ok(FLEET_V26_TOOLS.every((t) => !t.name.includes('.')));
  assert.ok(FLEET_V26_TOOLS.every((t) => t.name.startsWith('fleet_v26_')));
  assert.equal(fleetV26ToolsByGroup('fleet_v26').length, 34);
  assert.equal(findFleetV26Tool('fleet_v26_bot_register')?.write, true);
  assert.equal(findFleetV26Tool('fleet_v26_resources_capacity')?.write, false);
  assert.equal(findFleetV26Tool('fleet_v26_block_write')?.write, true);
  assert.equal(findFleetV26Tool('fleet_v26_dashboard')?.write, false);
  assert.equal(findFleetV26Tool('fleet_v26_skill_install')?.write, true);
  assert.equal(findFleetV26Tool('no-such-tool'), undefined);
  assert.equal(fleetV26WriteTools().length, 17);
  assert.equal(fleetV26ReadTools().length, 17);
  assert.equal(fleetV26WriteTools().length + fleetV26ReadTools().length, 34);
  assert.ok(fleetV26WriteTools().every((t) => t.write));
  assert.ok(fleetV26ReadTools().every((t) => !t.write));
});

test('tools v26: runnable — unbound says not configured', async () => {
  assert.equal(RUNNABLE_V26_TOOLS.length, 34);
  assert.equal(runnableNamesUnique(), true);
  const names = RUNNABLE_V26_TOOLS.map((t) => t.definition.name);
  assert.deepEqual([...names].sort(), [...FLEET_V26_TOOLS.map((t) => t.name)].sort());
  const out = await run(RUNNABLE_V26_TOOLS, 'fleet_v26_dashboard');
  assert.ok(out.startsWith('Error: Fleet v26 is not configured'));
});

test('tools v26: runnable — bound full loop', async () => {
  const state = createEmptyFleetV26ToolState();
  const tools = createFleetV26Tools(() => state);

  // Resources: capacity shows a real host; allocate a bot quota.
  const cap = asJson(await run(tools, 'fleet_v26_resources_capacity'));
  assert.ok(cap.capacity.cpuCores >= 1);
  assert.ok(cap.capacity.totalRamMB > 0);
  assert.ok(cap.remaining.cpuCores >= 0);

  // Bots: register -> start -> list -> health.
  const reg = asJson(await run(tools, 'fleet_v26_bot_register', { id: 'bot-a', name: 'Alpha', tags: ['nightly'] }));
  assert.equal(reg.ok, true);
  assert.equal(asJson(await run(tools, 'fleet_v26_bot_start', { id: 'bot-a' })).to, 'starting');
  const list = asJson(await run(tools, 'fleet_v26_bot_list', {}));
  assert.equal(list.bots.length, 1);
  const health = asJson(await run(tools, 'fleet_v26_health_check', { id: 'bot-a' }));
  assert.equal(health.botId, 'bot-a');
  assert.ok(typeof health.score === 'number');
  const summary = asJson(await run(tools, 'fleet_v26_health_summary'));
  assert.equal(summary.health.bots, 1);

  // Quota: allocate for bot-a, then refuse an impossible one.
  const grant = asJson(await run(tools, 'fleet_v26_resources_allocate', { botId: 'bot-a', cpuCores: 1, ramMB: 512 }));
  assert.equal(grant.admitted, true);
  const refuse = asJson(await run(tools, 'fleet_v26_resources_allocate', { botId: 'bot-b', cpuCores: 9999, ramMB: 999999 }));
  assert.equal(refuse.admitted, false);
  const rel = asJson(await run(tools, 'fleet_v26_resources_release', { botId: 'bot-a' }));
  assert.equal(rel.released, true);

  // Shared blocks: create -> attach -> write -> read -> history.
  assert.equal(asJson(await run(tools, 'fleet_v26_block_create', { id: 'plan', title: 'Plan', text: 'v1' })).ok, true);
  assert.equal(asJson(await run(tools, 'fleet_v26_block_attach', { id: 'plan', botId: 'bot-a' })).ok, true);
  const w = asJson(await run(tools, 'fleet_v26_block_write', { id: 'plan', text: 'v2', byBotId: 'bot-a', expectedVersion: 1 }));
  assert.equal(w.ok, true);
  assert.equal(w.version, 2);
  assert.equal(asJson(await run(tools, 'fleet_v26_block_write', { id: 'plan', text: 'stale', byBotId: 'bot-a', expectedVersion: 1 })).ok, false);
  assert.equal(asJson(await run(tools, 'fleet_v26_block_read', { id: 'plan' })).block.text, 'v2');
  assert.equal(asJson(await run(tools, 'fleet_v26_block_history', { id: 'plan' })).history.length, 2);
  assert.equal(asJson(await run(tools, 'fleet_v26_block_detach', { id: 'plan', botId: 'bot-a' })).ok, true);

  // Skills: install from SKILL.md -> match -> load body.
  const md = '---\nname: code-review\ndescription: Review a diff for bugs.\n---\n# Code review\n\nRead the diff and list issues by severity. Never skip high-severity issues.';
  assert.equal(asJson(await run(tools, 'fleet_v26_skill_install', { markdown: md, name: 'code-review' })).ok, true);
  const skills = asJson(await run(tools, 'fleet_v26_skill_list'));
  assert.equal(skills.metadata.length, 1);
  assert.equal(skills.metadata[0].name, 'code-review');
  const match = asJson(await run(tools, 'fleet_v26_skill_match', { request: 'please review this diff' }));
  assert.equal(match.matches[0].name, 'code-review');
  const body = asJson(await run(tools, 'fleet_v26_skill_load', { name: 'code-review' }));
  assert.equal(body.ok, true);
  assert.ok(body.body.includes('Never skip'));

  // Hooks: add -> evaluate (deny wins) -> list.
  assert.equal(
    asJson(await run(tools, 'fleet_v26_hook_add', { id: 'no-shell', event: 'PreToolUse', toolPattern: 'shell-*', action: 'deny', message: 'No shell.' })).ok,
    true,
  );
  const ev = asJson(await run(tools, 'fleet_v26_hook_evaluate', { event: 'PreToolUse', toolName: 'shell-exec', botId: 'bot-a' }));
  assert.equal(ev.decision, 'deny');
  assert.equal(ev.decidingHook.id, 'no-shell');
  assert.equal(asJson(await run(tools, 'fleet_v26_hook_list', {})).hooks.length, 1);

  // Plugins: install a checksummed bundle (checksum recomputed when omitted) -> list -> disable.
  const bundle = {
    id: 'demo-pack', name: 'Demo pack', version: '1.0.0', description: 'Demo.',
    author: 'test', skills: [], hookIds: ['no-shell'],
    mcpServers: [], dependencies: [], signature: null, signatureVerified: false,
  };
  assert.equal(asJson(await run(tools, 'fleet_v26_plugin_install', { bundle: JSON.stringify(bundle) })).ok, true);
  const plugins = asJson(await run(tools, 'fleet_v26_plugin_list'));
  assert.equal(plugins.plugins.length, 1);
  assert.equal(asJson(await run(tools, 'fleet_v26_plugin_set_enabled', { id: 'demo-pack', enabled: false })).ok, true);

  // MCP Apps: none registered yet -> empty list; unknown CSP errors.
  const apps = asJson(await run(tools, 'fleet_v26_mcp_app_list'));
  assert.deepEqual(apps.apps, []);
  assert.ok((await run(tools, 'fleet_v26_mcp_app_csp', { uri: 'ui://ghost/x' })).startsWith('Error:'));

  // Admission: operator auto-admits; memory fact without evidence asks.
  assert.equal(asJson(await run(tools, 'fleet_v26_admission_evaluate', { source: 'operator', text: 'go' })).decision, 'admitted');
  assert.equal(asJson(await run(tools, 'fleet_v26_admission_evaluate', { source: 'memory-v24', text: 'fact', offeredBy: 'bot-a' })).decision, 'ask-user');
  const settings = asJson(await run(tools, 'fleet_v26_admission_settings'));
  assert.equal(settings.policy.defaultAction, 'ask');

  // Dashboard joins everything.
  const dash = asJson(await run(tools, 'fleet_v26_dashboard'));
  assert.ok(dash.summary.includes('1 bot(s)'));
  assert.equal(dash.bots.counts.total, 1);
  assert.equal(dash.skills.counts.skills, 1);
  assert.equal(dash.mcpApps.counts.resources, 0);

  // Bot removal also releases quota/usage.
  assert.equal(asJson(await run(tools, 'fleet_v26_bot_stop', { id: 'bot-a' })).to, 'stopping');
  // markStopped is a host report, not a tool: remove refuses a live bot.
  assert.equal(asJson(await run(tools, 'fleet_v26_bot_remove', { id: 'bot-a' })).ok, false);
});

test('tools v26: defaultToolFactory binding replaces placeholders', () => {
  const inAll = ALL_TOOLS.filter((t) => t.definition.name.startsWith('fleet_v26_'));
  assert.equal(inAll.length, 34);
  const state = createEmptyFleetV26ToolState();
  const bound = createDefaultTools({ getFleetV26State: () => state });
  const boundV26 = bound.filter((t) => t.definition.name.startsWith('fleet_v26_'));
  assert.equal(boundV26.length, 34);
  assert.deepEqual(
    [...boundV26.map((t) => t.definition.name)].sort(),
    [...inAll.map((t) => t.definition.name)].sort(),
  );
  // No duplicates anywhere in the bound list.
  const names = bound.map((t) => t.definition.name);
  assert.equal(new Set(names).size, names.length);
  // Without the wiring, the placeholders stay.
  const plain = createDefaultTools();
  assert.equal(plain.filter((t) => t.definition.name.startsWith('fleet_v26_')).length, 34);
});

test('panels v26: dashboard + memory tree + settings', () => {
  const state = createEmptyFleetV26ToolState();
  state.bots.register({ id: 'bot-a' }, 1000);
  state.skills.installFromMd(
    '---\nname: verify\ndescription: Verify a claim.\n---\n# Verify\n\nCheck the repo before stating anything. Always cite the file.',
    'verify',
  );
  const dash = buildFleetV26Dashboard({
    allocator: state.allocator,
    bots: state.bots,
    health: checkFleetV26FleetHealth(state.bots, state.usageByBot, 2000),
    sharedBlocks: state.blocks,
    skills: state.skills,
    hooks: state.hooks,
    plugins: state.plugins,
    mcpApps: state.mcpApps,
    memFsNodes: [],
    admission: state.admission,
    nowMs: 2000,
  });
  assert.ok(dash.summary.includes('1 bot(s)'));
  assert.equal(dash.skills.counts.skills, 1);
  assert.equal(dash.memory.nodes, 0);

  // MemFS tree: depth-first flatten, cycle-safe, orphans listed.
  const nodes = [
    { id: 'root', name: 'memory', kind: 'folder', parentId: null, children: ['f1', 'f2'], evidence: null, admission: 'admitted', updatedAtMs: 1000 },
    { id: 'f1', name: 'Plan', kind: 'fact', parentId: 'root', children: [], evidence: 'standup', admission: 'admitted', updatedAtMs: 1000 },
    { id: 'f2', name: 'Idea', kind: 'fact', parentId: 'root', children: [], evidence: null, admission: 'pending', updatedAtMs: 1000 },
    { id: 'loop', name: 'Loop', kind: 'fact', parentId: 'loop', children: ['loop'], evidence: null, admission: 'pending', updatedAtMs: 1000 },
  ];
  const mem = buildFleetV26MemoryPanel(nodes, state.admission);
  assert.equal(mem.nodes, 4);
  assert.equal(mem.facts, 3);
  assert.equal(mem.withEvidence, 1);
  assert.equal(mem.orphans.length, 2); // f2 + loop (pending, no evidence)
  assert.equal(mem.rows.length, 4); // loop renders once despite the self-cycle
  assert.equal(mem.rows.find((r) => r.id === 'f1')?.depth, 1);
  assert.equal(mem.maxDepth, 1);

  const settings = buildFleetV26SettingsPanel(state.admission, state.mcpApps);
  assert.equal(settings.admissionPolicy.defaultAction, 'ask');
  assert.equal(settings.mcpAppsSettings.defaultPolicy, 'ask');
  assert.equal(settings.mcpAppsSettings.appsEnabled, true);
});

test('i18n v26: 96 fleet.v26 keys in all 6 locales, totals equal', () => {
  const totals = new Set();
  for (const loc of LOCALES) {
    const data = loadLocale(loc);
    totals.add(Object.keys(data).length);
    const v26 = Object.keys(data).filter((k) => k.startsWith('fleet.v26.'));
    assert.equal(v26.length, 96, `${loc} must have 96 fleet.v26 keys`);
    for (const k of v26) {
      assert.equal(typeof data[k], 'string', `${loc}:${k} must be a string`);
      assert.ok(data[k].length > 0, `${loc}:${k} must be non-empty`);
    }
    // Spot checks: the UI's tab + policy keys exist.
    assert.ok(data['fleet.v26.tab.overview']);
    assert.ok(data['fleet.v26.policy.ask']);
    assert.ok(data['fleet.v26.memoryOrphansTitle'].includes('{count}'));
  }
  // Totals must be identical across all 6 locales and at least the
  // v139-T6 baseline (8072 base + 96 fleet.v26 keys). No hardcoded total:
  // later v139 teams add their own keys on top (v139 fix round 1 — the
  // old [8168] snapshot broke as soon as T5 merged its 59 voice.v26 keys).
  assert.equal(totals.size, 1, 'all 6 locales must have the same key total');
  assert.ok([...totals][0] >= 8168, 'total must cover base 8072 + 96 fleet.v26 keys');
});
