/**
 * Tests for v1.19 (Team T3) — protocols v3 tools:
 * packages/tools/src/protocolV3Tools.ts
 * packages/tools/src/registry.ts (registerProtocolV3Tools)
 *
 * Covers:
 *  - 11 tools, unique names, object parameters, descriptions,
 *    registry registration (fresh ToolRegistry -> 11 tools),
 *    duplicate registration refused.
 *  - protocol_v3_negotiate: single family + all families + bad family.
 *  - protocol_v3_stateless_request: _meta + headers, unknown
 *    version refused, extensions carried.
 *  - protocol_v3_migration_advisor: legacy vs modern server.
 *  - protocol_v3_deprecation_check: warn / block / pass-through.
 *  - protocol_v3_mrtr_answer_validate: valid + missing required.
 *  - protocol_v3_a2a_frame_validate: good + bad frame.
 *  - protocol_v3_agui_event: built event + unknown type refused.
 *  - protocol_v3_a2ui_render: render through the fallback catalog.
 *  - protocol_v3_skills_catalog: empty fallback + bound catalog.
 *  - protocol_v3_apps_lifecycle + protocol_v3_apps_permission:
 *    install/activate/permission/lifecycle through a bound manager.
 *
 * Run after building core + tools:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/protocols-v3-tools.test.mjs
 *
 * No network, no model. The tools are NOT wired into
 * defaultToolFactory yet (the coordinator wires them and re-pins
 * the totals at merge time, same as the v1.16 protocol v2 tools).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PROTOCOL_V3_TOOLS,
  PROTOCOL_V3_TOOL_NAMES,
  createProtocolV3Tools,
  isProtocolV3ToolName,
} from '../packages/tools/dist/protocolV3Tools.js';
import { ToolRegistry } from '../packages/tools/dist/registry.js';
import { SkillsMcpV3Catalog } from '../packages/core/dist/protocolsV3/skillsMcpV3.js';
import { SkillsMcpServer } from '../packages/core/dist/protocolsV2/skillsMcp.js';
import { McpAppsV3Manager } from '../packages/core/dist/protocolsV3/mcpAppsV3.js';

const SKILL_MD = `---
name: code-review
description: Review code changes for bugs and style when the user asks for a review.
version: 1.0.0
allowed-tools: [read_file, grep_search]
---
# Code review
Review the diff carefully.
`;

function byName(tools, name) {
  const tool = tools.find((t) => t.definition.name === name);
  assert.ok(tool, `missing tool ${name}`);
  return tool;
}

async function run(tools, name, args) {
  return byName(tools, name).execute(args);
}

test('v3 tools: 11 tools, unique names, registry registration', () => {
  assert.equal(PROTOCOL_V3_TOOL_NAMES.length, 11);
  assert.equal(new Set(PROTOCOL_V3_TOOL_NAMES).size, 11);
  assert.equal(PROTOCOL_V3_TOOLS.length, 11);
  assert.deepEqual(
    PROTOCOL_V3_TOOLS.map((t) => t.definition.name),
    [...PROTOCOL_V3_TOOL_NAMES],
  );
  for (const tool of PROTOCOL_V3_TOOLS) {
    assert.ok(isProtocolV3ToolName(tool.definition.name));
    assert.equal(tool.definition.parameters.type, 'object');
    assert.ok(tool.definition.description.length > 20);
    assert.equal(typeof tool.needsApproval, 'boolean');
  }
  assert.equal(isProtocolV3ToolName('protocol_v3_negotiate'), true);
  assert.equal(isProtocolV3ToolName('protocol_v2_negotiate'), false);
  // Only the permission tool needs approval (it grants capabilities).
  assert.equal(byName(PROTOCOL_V3_TOOLS, 'protocol_v3_apps_permission').needsApproval, true);
  assert.equal(byName(PROTOCOL_V3_TOOLS, 'protocol_v3_negotiate').needsApproval, false);

  const registry = new ToolRegistry();
  registry.registerProtocolV3Tools();
  assert.equal(registry.list().length, 11);
  assert.ok(registry.has('protocol_v3_negotiate'));
  assert.ok(registry.has('protocol_v3_apps_permission'));
  assert.throws(() => registry.registerProtocolV3Tools(), /already registered|duplicate/i);
});

test('v3 tools: negotiate single family + all families + bad family', async () => {
  const out = JSON.parse(await run(PROTOCOL_V3_TOOLS, 'protocol_v3_negotiate', {
    family: 'mcp',
    clientVersions: ['2025-03-26', '2026-07-28'],
    serverVersions: ['2026-07-28'],
  }));
  assert.equal(out.negotiation.version, '2026-07-28');
  assert.equal(out.negotiation.status, 'current');

  const all = JSON.parse(await run(PROTOCOL_V3_TOOLS, 'protocol_v3_negotiate', {
    serverVersionsByFamily: { mcp: ['2026-07-28'], a2a: ['1.1'], agui: ['1.0'], a2ui: ['1.0'] },
  }));
  assert.equal(all.negotiations.mcp.version, '2026-07-28');
  assert.equal(all.negotiations.a2a.version, '1.1');
  assert.equal(all.negotiations.agui.status, 'current');
  assert.equal(all.negotiations.a2ui.status, 'current');

  const empty = JSON.parse(await run(PROTOCOL_V3_TOOLS, 'protocol_v3_negotiate', {}));
  assert.equal(empty.negotiations.mcp.version, '2026-07-28');

  const bad = await run(PROTOCOL_V3_TOOLS, 'protocol_v3_negotiate', {
    family: 'nope', clientVersions: [], serverVersions: [],
  });
  assert.ok(bad.startsWith('Error:'));
});

test('v3 tools: stateless request + migration advisor', async () => {
  const out = JSON.parse(await run(PROTOCOL_V3_TOOLS, 'protocol_v3_stateless_request', {
    extensions: ['io.modelcontextprotocol/tasks'],
  }));
  assert.equal(out.request.protocolVersion, '2026-07-28');
  assert.equal(out.request.headers['MCP-Protocol-Version'], '2026-07-28');
  assert.equal(out.request.meta.protocolVersion, '2026-07-28');
  assert.deepEqual(out.request.extensions, ['io.modelcontextprotocol/tasks']);

  const bad = await run(PROTOCOL_V3_TOOLS, 'protocol_v3_stateless_request', {
    protocolVersion: '1999-01-01',
  });
  assert.ok(bad.startsWith('Error:'));

  const legacy = JSON.parse(await run(PROTOCOL_V3_TOOLS, 'protocol_v3_migration_advisor', {
    serverName: 'legacy',
    serverVersion: '2025-03-26',
    capabilities: { tools: true, sampling: true },
    discover: false,
  }));
  assert.equal(legacy.report.statelessReady, false);
  assert.equal(legacy.report.items.find((i) => i.area === 'stateless-core').status, 'needs-shim');
  assert.equal(legacy.report.items.find((i) => i.area === 'sampling').status, 'must-replace');

  const modern = JSON.parse(await run(PROTOCOL_V3_TOOLS, 'protocol_v3_migration_advisor', {
    serverName: 'modern',
    serverVersion: '2026-07-28',
    capabilities: { tools: true },
    discover: true,
    discoverExtensions: ['io.modelcontextprotocol/tasks'],
  }));
  assert.equal(modern.report.statelessReady, true);
  assert.equal(modern.report.negotiatedVersion, '2026-07-28');
});

test('v3 tools: deprecation check + MRTR answer validation', async () => {
  const warned = JSON.parse(await run(PROTOCOL_V3_TOOLS, 'protocol_v3_deprecation_check', {
    method: 'sampling/createMessage',
  }));
  assert.equal(warned.check.ok, true);
  assert.equal(warned.check.notice.area, 'sampling');

  const blocked = JSON.parse(await run(PROTOCOL_V3_TOOLS, 'protocol_v3_deprecation_check', {
    method: 'sampling/createMessage', sampling: 'block',
  }));
  assert.equal(blocked.check.ok, false);
  assert.match(blocked.check.reason, /blocked by policy/);

  const passthrough = JSON.parse(await run(PROTOCOL_V3_TOOLS, 'protocol_v3_deprecation_check', {
    method: 'tools/call',
  }));
  assert.deepEqual(passthrough.check, { ok: true });

  const badPolicy = await run(PROTOCOL_V3_TOOLS, 'protocol_v3_deprecation_check', {
    method: 'sampling/createMessage', sampling: 'maybe',
  });
  assert.ok(badPolicy.startsWith('Error:'));

  const valid = JSON.parse(await run(PROTOCOL_V3_TOOLS, 'protocol_v3_mrtr_answer_validate', {
    answer: { name: 'Bot' },
    schema: { required: ['name'], properties: { name: { type: 'string' } } },
  }));
  assert.deepEqual(valid.problems, []);
  const invalid = JSON.parse(await run(PROTOCOL_V3_TOOLS, 'protocol_v3_mrtr_answer_validate', {
    answer: {},
    schema: { required: ['name'] },
  }));
  assert.equal(invalid.problems.length, 1);
  assert.match(invalid.problems[0], /Missing required field: name/);
});

test('v3 tools: A2A frame validation + AG-UI event build', async () => {
  const good = JSON.parse(await run(PROTOCOL_V3_TOOLS, 'protocol_v3_a2a_frame_validate', {
    frame: {
      direction: 'down', kind: 'status', taskId: 'task-1', sequence: 0,
      payload: { state: 'working' }, at: new Date().toISOString(),
    },
  }));
  assert.equal(good.validation.ok, true);
  const bad = JSON.parse(await run(PROTOCOL_V3_TOOLS, 'protocol_v3_a2a_frame_validate', {
    frame: { direction: 'sideways', kind: 'status', taskId: 't', sequence: 0, payload: {} },
  }));
  assert.equal(bad.validation.ok, false);
  assert.match(bad.validation.reason, /direction/);

  const event = JSON.parse(await run(PROTOCOL_V3_TOOLS, 'protocol_v3_agui_event', {
    type: 'TEXT_MESSAGE_CONTENT', runId: 'run-1', sequence: 0, data: { delta: 'hi' },
  }));
  assert.equal(event.event.type, 'TEXT_MESSAGE_CONTENT');
  assert.equal(event.event.sequence, 0);
  const badType = await run(PROTOCOL_V3_TOOLS, 'protocol_v3_agui_event', {
    type: 'NOPE', runId: 'run-1', sequence: 0, data: {},
  });
  assert.ok(badType.startsWith('Error:'));
  const badSeq = await run(PROTOCOL_V3_TOOLS, 'protocol_v3_agui_event', {
    type: 'TEXT_MESSAGE_CONTENT', runId: 'run-1', sequence: -1, data: {},
  });
  assert.ok(badSeq.startsWith('Error:'));
});

test('v3 tools: A2UI render through the fallback catalog', async () => {
  const out = JSON.parse(await run(PROTOCOL_V3_TOOLS, 'protocol_v3_a2ui_render', {
    surfaceId: 's1',
    runId: 'r1',
    title: 'Report',
    tree: { kind: 'component', componentId: 'v3-markdown', state: { text: 'placeholder' } },
    bindings: [{ prop: 'text', path: 'title' }],
    runState: { title: '# Real title' },
  }));
  assert.equal(out.surface.status, 'rendered');
  assert.equal(out.surface.tree.state.text, '# Real title');
  assert.equal(out.frame.surfaceId, 's1');

  const bad = await run(PROTOCOL_V3_TOOLS, 'protocol_v3_a2ui_render', {
    surfaceId: 's2', runId: 'r1', title: 'Bad',
    tree: { kind: 'component', componentId: 'v3-nope' },
  });
  assert.ok(bad.startsWith('Error:'));
});

test('v3 tools: skills catalog — empty fallback + bound catalog', async () => {
  const empty = JSON.parse(await run(PROTOCOL_V3_TOOLS, 'protocol_v3_skills_catalog', {}));
  assert.deepEqual(empty, { count: 0, skills: [] });

  const server = new SkillsMcpServer();
  server.register('code-review', SKILL_MD, 'builtin');
  const catalog = new SkillsMcpV3Catalog();
  catalog.addServer({ serverId: 's1', serverName: 'Builtin', priority: 1, server });
  const tools = createProtocolV3Tools({ getSkillsV3Catalog: () => catalog });
  const out = JSON.parse(await run(tools, 'protocol_v3_skills_catalog', {}));
  assert.equal(out.count, 1);
  assert.equal(out.skills[0].name, 'code-review');
  assert.equal(out.skills[0].serverId, 's1');
  const found = JSON.parse(await run(tools, 'protocol_v3_skills_catalog', { query: 'review' }));
  assert.equal(found.count, 1);
  const missed = JSON.parse(await run(tools, 'protocol_v3_skills_catalog', { query: 'zzz' }));
  assert.equal(missed.count, 0);
});

test('v3 tools: apps lifecycle + permissions through a bound manager', async () => {
  const manager = new McpAppsV3Manager();
  const tools = createProtocolV3Tools({ getMcpAppsV3Manager: () => manager });

  const listed = JSON.parse(await run(tools, 'protocol_v3_apps_lifecycle', { action: 'list' }));
  assert.deepEqual(listed.apps, []);

  const installed = JSON.parse(await run(tools, 'protocol_v3_apps_lifecycle', {
    action: 'install',
    declaration: { id: 'app-one', serverName: 'srv', title: 'App One', allowedActions: ['tool-call'] },
  }));
  assert.equal(installed.record.lifecycle, 'installed');

  const checkBefore = JSON.parse(await run(tools, 'protocol_v3_apps_permission', {
    appId: 'app-one', capability: 'tool-call',
  }));
  assert.equal(checkBefore.check.decision, 'denied'); // not active yet

  const activated = JSON.parse(await run(tools, 'protocol_v3_apps_lifecycle', {
    action: 'activate', appId: 'app-one',
  }));
  assert.equal(activated.record.lifecycle, 'active');

  const checkDeclared = JSON.parse(await run(tools, 'protocol_v3_apps_permission', {
    appId: 'app-one', capability: 'tool-call',
  }));
  assert.equal(checkDeclared.check.decision, 'granted');
  const checkPrompt = JSON.parse(await run(tools, 'protocol_v3_apps_permission', {
    appId: 'app-one', capability: 'clipboard',
  }));
  assert.equal(checkPrompt.check.decision, 'prompt');

  const granted = JSON.parse(await run(tools, 'protocol_v3_apps_permission', {
    appId: 'app-one', capability: 'clipboard', decision: 'granted',
  }));
  assert.equal(granted.grant.decision, 'granted');
  const badCapability = await run(tools, 'protocol_v3_apps_permission', {
    appId: 'app-one', capability: 'nope',
  });
  assert.ok(badCapability.startsWith('Error:'));
  const badDecision = await run(tools, 'protocol_v3_apps_permission', {
    appId: 'app-one', capability: 'clipboard', decision: 'maybe',
  });
  assert.ok(badDecision.startsWith('Error:'));

  const suspended = JSON.parse(await run(tools, 'protocol_v3_apps_lifecycle', {
    action: 'suspend', appId: 'app-one', reason: 'policy',
  }));
  assert.equal(suspended.record.lifecycle, 'suspended');
  const resumed = JSON.parse(await run(tools, 'protocol_v3_apps_lifecycle', {
    action: 'resume', appId: 'app-one',
  }));
  assert.equal(resumed.record.lifecycle, 'active');
  const got = JSON.parse(await run(tools, 'protocol_v3_apps_lifecycle', {
    action: 'get', appId: 'app-one',
  }));
  assert.equal(got.record.template.id, 'app-one');
  const uninstalled = JSON.parse(await run(tools, 'protocol_v3_apps_lifecycle', {
    action: 'uninstall', appId: 'app-one',
  }));
  assert.equal(uninstalled.record.lifecycle, 'uninstalled');

  const badAction = await run(tools, 'protocol_v3_apps_lifecycle', { action: 'explode' });
  assert.ok(badAction.startsWith('Error:'));
  const badSuspend = await run(tools, 'protocol_v3_apps_lifecycle', {
    action: 'suspend', appId: 'app-one', reason: 'nope',
  });
  assert.ok(badSuspend.startsWith('Error:'));
});
