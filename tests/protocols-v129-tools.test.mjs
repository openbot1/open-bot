/**
 * Tests for v1.29 (Team T2) — protocols v5 tools:
 * packages/tools/src/protocolV5Tools.ts
 * packages/tools/src/registry.ts (registerProtocolV5Tools)
 *
 * Covers:
 *  - 12 tools, unique names, object parameters, descriptions,
 *    registry registration (fresh ToolRegistry -> 12 tools),
 *    duplicate registration refused.
 *  - protocol_v5_negotiate: single family + all families + bad family.
 *  - protocol_v5_bg_task_start/get/list/cancel: placeholder,
 *    simulated result, cancel.
 *  - protocol_v5_permission_evaluate/set/ask_resolve: allow/deny/
 *    ask flow with the bound registry.
 *  - protocol_v5_oauth_state/reconnect: needs-auth listing and
 *    reconnect through a bound token provider.
 *  - protocol_v5_acp_discover/session: registry discovery and
 *    ACP session ops through bound instances.
 *
 * Run after building core + tools:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/protocols-v129-tools.test.mjs
 *
 * No network, no model. The tools are NOT wired into
 * defaultToolFactory yet (the coordinator wires them and re-pins
 * the totals at merge time, same as the v1.16 protocol v2 tools).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PROTOCOL_V5_TOOLS,
  PROTOCOL_V5_TOOL_NAMES,
  createProtocolV5Tools,
  isProtocolV5ToolName,
} from '../packages/tools/dist/protocolV5Tools.js';
import { ToolRegistry } from '../packages/tools/dist/registry.js';
import {
  AcpAgentRegistry,
  AcpV2ClientAdapter,
  BackgroundMcpTaskManager,
  McpAuthSessionManager,
  McpPermissionPolicyRegistry,
} from '../packages/core/dist/index.js';

const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

function toolsByName(tools) {
  return Object.fromEntries(tools.map((t) => [t.definition.name, t]));
}

function boundTools() {
  const bgTasks = new BackgroundMcpTaskManager();
  const permissions = new McpPermissionPolicyRegistry();
  const auth = new McpAuthSessionManager();
  const registry = new AcpAgentRegistry();
  registry.register({
    agentId: 'coder',
    name: 'Coder',
    description: 'Writes code.',
    capabilities: ['coding'],
    transports: ['stdio', 'acp'],
    acpVersions: ['2.0-draft'],
    a2aVersions: ['1.1'],
  });
  const acpClient = new AcpV2ClientAdapter({
    runner: async (_id, prompt) => ({ text: `Answer: ${prompt}` }),
  });
  const tools = createProtocolV5Tools({
    getBgTaskManager: () => bgTasks,
    getPermissionRegistry: () => permissions,
    getAuthSessionManager: () => auth,
    tokenProvider: async () => ({ accessToken: 'fresh', expiresAt: Date.now() + 3600_000 }),
    getAcpRegistry: () => registry,
    getAcpClient: () => acpClient,
  });
  return { tools, byName: toolsByName(tools), bgTasks, permissions, auth, registry, acpClient };
}

test('12 tools: unique names, object params, descriptions, registry registration', () => {
  assert.equal(PROTOCOL_V5_TOOL_NAMES.length, 12);
  assert.equal(new Set(PROTOCOL_V5_TOOL_NAMES).size, 12);
  assert.ok(PROTOCOL_V5_TOOL_NAMES.every((n) => n.startsWith('protocol_v5_')));
  assert.ok(PROTOCOL_V5_TOOL_NAMES.every((n) => isProtocolV5ToolName(n)));
  assert.equal(isProtocolV5ToolName('protocol_v3_negotiate'), false);
  assert.equal(PROTOCOL_V5_TOOLS.length, 12);

  const { tools } = boundTools();
  assert.equal(tools.length, 12);
  for (const tool of tools) {
    assert.equal(typeof tool.definition.description, 'string');
    assert.ok(tool.definition.description.length > 20, tool.definition.name);
    assert.equal(tool.definition.parameters.type, 'object');
    assert.equal(typeof tool.execute, 'function');
  }
  // permission_set / ask_resolve need approval; the rest do not.
  const byName = toolsByName(tools);
  assert.equal(byName['protocol_v5_permission_set'].needsApproval, true);
  assert.equal(byName['protocol_v5_permission_ask_resolve'].needsApproval, true);
  assert.equal(byName['protocol_v5_negotiate'].needsApproval, false);

  const registry = new ToolRegistry();
  registry.registerProtocolV5Tools();
  assert.equal(registry.list().length, 12);
  assert.throws(() => registry.registerProtocolV5Tools(), /already registered|duplicate/i);
});

test('negotiate: single family, all families, bad family', async () => {
  const { byName } = boundTools();
  const single = JSON.parse(await byName['protocol_v5_negotiate'].execute({ family: 'acp', serverVersions: ['2.0-draft'] }, {}));
  assert.equal(single.negotiation.negotiated, '2.0-draft');
  assert.equal(single.negotiation.unstable, true);

  const all = JSON.parse(
    await byName['protocol_v5_negotiate'].execute(
      { serverVersionsByFamily: { acp: ['2.0-draft'], a2a: ['1.1'], mcp: ['2026-07-28'] } },
      {},
    ),
  );
  assert.equal(all.negotiations.a2a.negotiated, '1.1');
  assert.equal(all.negotiations.mcp.negotiated, '2026-07-28');
  assert.equal(all.deprecationCalendar.length, 6);

  const bad = await byName['protocol_v5_negotiate'].execute({ family: 'nope', serverVersions: [] }, {});
  assert.match(bad, /Unknown protocol family/);
});

test('background tasks: start (placeholder) -> get (done) -> list -> cancel', async () => {
  const { byName } = boundTools();
  const started = JSON.parse(
    await byName['protocol_v5_bg_task_start'].execute(
      { serverName: 'srv', toolName: 'search', args: { q: 'hi' }, simulateDelayMs: 5 },
      {},
    ),
  );
  assert.equal(started.placeholder.kind, 'task_placeholder');
  assert.match(started.note, /Simulation/);
  const taskId = started.placeholder.taskId;

  // Poll until done (simulation is fast).
  let task;
  for (let i = 0; i < 50; i += 1) {
    task = JSON.parse(await byName['protocol_v5_bg_task_get'].execute({ taskId }, {})).task;
    if (task.status === 'done') break;
    await tick();
  }
  assert.equal(task.status, 'done');
  assert.equal(task.result.simulated, true);
  assert.deepEqual(task.result.args, { q: 'hi' });

  const listed = JSON.parse(await byName['protocol_v5_bg_task_list'].execute({ status: 'done' }, {}));
  assert.equal(listed.count, 1);
  const all = JSON.parse(await byName['protocol_v5_bg_task_list'].execute({}, {}));
  assert.equal(all.count, 1);

  const badList = await byName['protocol_v5_bg_task_list'].execute({ status: 'nope' }, {});
  assert.match(badList, /Unknown task status/);
  const badGet = await byName['protocol_v5_bg_task_get'].execute({ taskId: 'nope' }, {});
  assert.match(badGet, /Unknown background MCP task/);

  // Cancel a slow task.
  const slow = JSON.parse(
    await byName['protocol_v5_bg_task_start'].execute(
      { serverName: 'srv', toolName: 'slow', simulateDelayMs: 60_000 },
      {},
    ),
  );
  const cancelled = JSON.parse(
    await byName['protocol_v5_bg_task_cancel'].execute({ taskId: slow.placeholder.taskId }, {}),
  );
  assert.equal(cancelled.cancelled, true);
  const again = JSON.parse(
    await byName['protocol_v5_bg_task_cancel'].execute({ taskId: slow.placeholder.taskId }, {}),
  );
  assert.equal(again.cancelled, false);
});

test('permission: evaluate -> set rule -> ask -> resolve always', async () => {
  const { byName } = boundTools();
  const first = JSON.parse(
    await byName['protocol_v5_permission_evaluate'].execute({ serverName: 'fs', toolName: 'fs:read' }, {}),
  );
  assert.equal(first.evaluation.decision, 'ask');
  assert.ok(first.evaluation.askId);

  const set = JSON.parse(
    await byName['protocol_v5_permission_set'].execute(
      { serverName: 'fs', pattern: 'fs:read', decision: 'allow', note: 'Reads are safe.' },
      {},
    ),
  );
  assert.equal(set.rule.decision, 'allow');
  const after = JSON.parse(
    await byName['protocol_v5_permission_evaluate'].execute({ serverName: 'fs', toolName: 'fs:read' }, {}),
  );
  assert.equal(after.evaluation.decision, 'allow');

  // Ask flow on another tool, resolved allow-always.
  const ask = JSON.parse(
    await byName['protocol_v5_permission_evaluate'].execute({ serverName: 'fs', toolName: 'fs:write' }, {}),
  );
  const resolved = JSON.parse(
    await byName['protocol_v5_permission_ask_resolve'].execute(
      { serverName: 'fs', askId: ask.evaluation.askId, resolution: 'allow-always' },
      {},
    ),
  );
  assert.equal(resolved.resolved.resolution, 'allow-always');
  const recheck = JSON.parse(
    await byName['protocol_v5_permission_evaluate'].execute({ serverName: 'fs', toolName: 'fs:write' }, {}),
  );
  assert.equal(recheck.evaluation.decision, 'allow');

  const badDecision = await byName['protocol_v5_permission_set'].execute(
    { serverName: 'fs', pattern: 'x', decision: 'maybe' },
    {},
  );
  assert.match(badDecision, /Unknown permission decision/);
  const badResolution = await byName['protocol_v5_permission_ask_resolve'].execute(
    { serverName: 'fs', askId: 'ask-fs-999', resolution: 'sometimes' },
    {},
  );
  assert.match(badResolution, /Unknown resolution/);

  // Server default.
  const def = JSON.parse(
    await byName['protocol_v5_permission_set'].execute({ serverName: 'fs', decision: 'deny', setDefault: true }, {}),
  );
  assert.equal(def.defaultDecision, 'deny');
  const unknownTool = JSON.parse(
    await byName['protocol_v5_permission_evaluate'].execute({ serverName: 'fs', toolName: 'fs:delete' }, {}),
  );
  assert.equal(unknownTool.evaluation.decision, 'deny');
});

test('oauth: state lists servers needing auth; reconnect restores connected', async () => {
  const { byName, auth } = boundTools();
  const empty = JSON.parse(await byName['protocol_v5_oauth_state'].execute({}, {}));
  assert.deepEqual(empty.serversNeedingAuth, []);

  const session = auth.sessionFor('gh', { initialState: 'connected' });
  session.elicit({ authUrl: 'https://example.test/auth' });
  const state = JSON.parse(await byName['protocol_v5_oauth_state'].execute({ serverName: 'gh' }, {}));
  assert.equal(state.session.state, 'needs-auth');
  assert.equal(state.challenge.authUrl, 'https://example.test/auth');
  assert.ok(!JSON.stringify(state).includes('fresh')); // no token in output
  const listed = JSON.parse(await byName['protocol_v5_oauth_state'].execute({}, {}));
  assert.deepEqual(listed.serversNeedingAuth, ['gh']);

  const reconnected = JSON.parse(await byName['protocol_v5_oauth_reconnect'].execute({ serverName: 'gh' }, {}));
  assert.equal(reconnected.state, 'connected');
  assert.deepEqual(reconnected.replay, []);

  const unknown = JSON.parse(await byName['protocol_v5_oauth_state'].execute({ serverName: 'zzz' }, {}));
  assert.equal(unknown.state, 'unknown');
});

test('oauth reconnect without a bound token provider fails clearly', async () => {
  const tools = createProtocolV5Tools();
  const byName = toolsByName(tools);
  const out = await byName['protocol_v5_oauth_reconnect'].execute({ serverName: 'gh' }, {});
  assert.match(out, /No token provider is bound/);
});

test('acp discover + session: find the coder agent, run a prompt turn', async () => {
  const { byName } = boundTools();
  const found = JSON.parse(await byName['protocol_v5_acp_discover'].execute({ capability: 'coding' }, {}));
  assert.equal(found.count, 1);
  assert.equal(found.agents[0].agentId, 'coder');
  const byVersion = JSON.parse(await byName['protocol_v5_acp_discover'].execute({ acpVersion: '2.0-draft' }, {}));
  assert.equal(byVersion.count, 1);
  const none = JSON.parse(await byName['protocol_v5_acp_discover'].execute({ capability: 'voice' }, {}));
  assert.equal(none.count, 0);

  const created = JSON.parse(
    await byName['protocol_v5_acp_session'].execute({ action: 'new', agentId: 'coder' }, {}),
  );
  const sessionId = created.sessionId;
  assert.ok(sessionId);

  const answered = JSON.parse(
    await byName['protocol_v5_acp_session'].execute({ action: 'prompt', sessionId, text: 'Hello agent' }, {}),
  );
  assert.equal(answered.answer.text, 'Answer: Hello agent');

  const got = JSON.parse(
    await byName['protocol_v5_acp_session'].execute({ action: 'get', sessionId }, {}),
  );
  assert.equal(got.session.sessionId, sessionId);
  assert.equal(got.a2aTask.state, 'submitted');
  assert.equal(got.a2aTask.a2aVersion, '1.1');

  const listed = JSON.parse(await byName['protocol_v5_acp_session'].execute({ action: 'list' }, {}));
  assert.equal(listed.sessions.length, 1);

  const bad = await byName['protocol_v5_acp_session'].execute({ action: 'explode' }, {});
  assert.match(bad, /Unknown ACP session action/);
  const missing = await byName['protocol_v5_acp_session'].execute({ action: 'get', sessionId: 'nope' }, {});
  assert.match(missing, /Unknown ACP session/);
});
