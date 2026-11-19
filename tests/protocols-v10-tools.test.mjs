/**
 * Tests for v1.41 (Team T2) — protocols v10 tools:
 * packages/tools/src/protocolV118Tools.ts
 * packages/tools/src/registry.ts (registerProtocolV118Tools)
 * packages/tools/src/tools.ts (ALL_TOOLS spread + bind)
 *
 * Covers:
 *  - 12 tools, unique names, object parameters, descriptions,
 *    registry registration (fresh ToolRegistry -> 12 tools)
 *  - protocol_v10_versions: matrix / changes / downgrade /
 *    negotiate / flags (loopback guard must stay on)
 *  - protocol_v10_stateless: discover / list / call / subscribe
 *  - protocol_v10_oauth: validate-issuer / validate-token /
 *    binding / dcr-status (DCR deprecated)
 *  - protocol_v10_tool_search: register / search / load / counts
 *  - protocol_v10_script: validate + run a script
 *  - protocol_v10_tasks: create / run-next / complete / counts
 *  - protocol_v10_apps: validate-resource / csp / validate-message
 *  - protocol_v10_apps_bridge: open / initialize / call / audit
 *  - protocol_v10_roundtrip: validate-request / validate-answer /
 *    run-demo
 *  - protocol_v10_a2a: validate-card / well-known / negotiate /
 *    handshake / message (non-loopback refused)
 *  - protocol_v10_deprecation: list / register / check-removal
 *  - protocol_v10_registry: unified counts
 *  - ALL_TOOLS contains the 12 v10 tools exactly once, and the
 *    bind path replaces them in place (same count, no duplicates)
 *
 * Run after building core + tools:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/protocols-v10-tools.test.mjs
 *
 * No network, no model, no credential access.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PROTOCOL_V118_TOOLS,
  PROTOCOL_V118_TOOL_NAMES,
  createProtocolV118Tools,
  isProtocolV118ToolName,
} from '../packages/tools/dist/protocolV118Tools.js';
import { ALL_TOOLS, createDefaultTools } from '../packages/tools/dist/tools.js';
import { ToolRegistry } from '../packages/tools/dist/registry.js';

const SHARED_TOOLS = createProtocolV118Tools();

function tool(name) {
  const found = SHARED_TOOLS.find((t) => t.definition.name === name);
  assert.ok(found, `tool ${name} not found`);
  return found;
}

async function run(name, args) {
  const result = await tool(name).execute(args, {
    workspaceDir: '/tmp',
    botId: 'test-bot',
  });
  if (result.startsWith('Error:')) throw new Error(result);
  return JSON.parse(result);
}

test('12 tools, unique names, object parameters, isProtocolV118ToolName', () => {
  assert.equal(PROTOCOL_V118_TOOLS.length, 12);
  assert.equal(PROTOCOL_V118_TOOL_NAMES.length, 12);
  assert.deepEqual(
    PROTOCOL_V118_TOOLS.map((t) => t.definition.name).sort(),
    [...PROTOCOL_V118_TOOL_NAMES].sort(),
  );
  const names = new Set();
  for (const t of PROTOCOL_V118_TOOLS) {
    assert.ok(t.definition.name.startsWith('protocol_v10_'), t.definition.name);
    assert.ok(!names.has(t.definition.name), `duplicate ${t.definition.name}`);
    names.add(t.definition.name);
    assert.equal(t.definition.parameters.type, 'object');
    assert.ok(t.definition.description.length > 20);
    assert.equal(typeof t.needsApproval, 'boolean');
    assert.equal(typeof t.execute, 'function');
  }
  assert.equal(isProtocolV118ToolName('protocol_v10_versions'), true);
  assert.equal(isProtocolV118ToolName('protocol_v9_versions'), false);
  assert.equal(isProtocolV118ToolName('nope'), false);
});

test('registry registration: fresh ToolRegistry gets exactly the 12 tools', () => {
  const registry = new ToolRegistry();
  registry.registerProtocolV118Tools();
  for (const name of PROTOCOL_V118_TOOL_NAMES) {
    assert.ok(registry.get(name), `registry is missing ${name}`);
  }
  // Re-registering throws (register() refuses duplicates) — the
  // registry never silently holds a tool twice.
  assert.throws(() => registry.registerProtocolV118Tools(), /already registered/);
});

test('protocol_v10_versions: matrix / changes / downgrade / negotiate / flags', async () => {
  const matrix = await run('protocol_v10_versions', { action: 'matrix' });
  assert.equal(matrix.current.mcp, '2026-07-28');
  assert.equal(matrix.current.a2a, '1.1');
  const changes = await run('protocol_v10_versions', { action: 'changes' });
  assert.ok(changes.changes.length >= 8);
  const down = await run('protocol_v10_versions', { action: 'downgrade' });
  assert.match(down.downgrade.mcp, /[Ss]tateless v10/);
  const neg = await run('protocol_v10_versions', { action: 'negotiate', family: 'a2a', peerVersions: '1.0,1.1' });
  assert.equal(neg.agreed, '1.1');
  const all = await run('protocol_v10_versions', {
    action: 'negotiate-all',
    offered: { mcp: '2026-07-28', a2a: '1.0' },
  });
  assert.equal(all.mcp.agreed, '2026-07-28');
  const flags = await run('protocol_v10_versions', { action: 'flags' });
  assert.deepEqual(flags.problems, []);
  assert.equal(flags.defaults.loopbackOnly, true);
  const summary = await run('protocol_v10_versions', { action: 'summary' });
  assert.match(summary.summary, /mcp 2026-07-28/);
  const bad = await tool('protocol_v10_versions').execute({ action: 'nope' }, { workspaceDir: '/tmp', botId: 't' });
  assert.ok(bad.startsWith('Error:'));
});

test('protocol_v10_stateless: discover / list / call / subscribe / counts', async () => {
  const discovery = await run('protocol_v10_stateless', { action: 'discover' });
  assert.equal(discovery.protocolVersion, '2026-07-28');
  const list = await run('protocol_v10_stateless', { action: 'list' });
  assert.deepEqual(list.tools.map((t) => t.name), ['echo']);
  const call = await run('protocol_v10_stateless', { action: 'call', tool: 'echo', arguments: { x: 1 } });
  assert.deepEqual(call.result, { echoed: { x: 1 } });
  assert.equal(typeof call.stateHandle, 'string');
  const sub = await run('protocol_v10_stateless', { action: 'subscribe', listenerId: 'l1', kinds: ['tools'] });
  assert.equal(typeof sub.subscriptionId, 'string');
  const counts = await run('protocol_v10_stateless', { action: 'counts' });
  assert.ok(counts.totalCalls >= 1);
  assert.equal(counts.subscriptions.tools, 1);
});

test('protocol_v10_oauth: issuer, token, binding, DCR deprecated', async () => {
  const issuer = await run('protocol_v10_oauth', {
    action: 'validate-issuer',
    tokenIssuer: 'https://auth.example.com/',
    expectedIssuer: 'https://auth.example.com',
  });
  assert.equal(issuer.ok, true);
  const badIssuer = await run('protocol_v10_oauth', {
    action: 'validate-issuer',
    tokenIssuer: 'https://evil.example.com',
    expectedIssuer: 'https://auth.example.com',
  });
  assert.equal(badIssuer.ok, false);
  const token = {
    value: 'opaque',
    issuer: 'https://auth.example.com',
    audience: 'https://mcp.example.com',
    expiresAtSec: Math.floor(Date.now() / 1000) + 3600,
    scope: 'tools:call',
  };
  const valid = await run('protocol_v10_oauth', {
    action: 'validate-token',
    token,
    server: { issuer: 'https://auth.example.com', audience: 'https://mcp.example.com', requiredScopes: ['tools:call'] },
  });
  assert.equal(valid.ok, true);
  const fp = await run('protocol_v10_oauth', { action: 'binding-fingerprint', token });
  assert.equal(typeof fp.fingerprint, 'string');
  const bound = await run('protocol_v10_oauth', { action: 'check-binding', token, fingerprint: fp.fingerprint });
  assert.equal(bound.ok, true);
  const dcr = await run('protocol_v10_oauth', { action: 'dcr-status' });
  assert.equal(dcr.status, 'deprecated');
  assert.equal(dcr.earliestRemoval, '2027-07-28');
});

test('protocol_v10_tool_search + script: register / search / load / run', async () => {
  const counts0 = await run('protocol_v10_tool_search', { action: 'counts' });
  assert.equal(counts0.total, 5);
  const search = await run('protocol_v10_tool_search', { action: 'search', query: 'v10' });
  assert.ok(search.hits.length >= 2);
  assert.ok(search.hits.some((h) => h.tool.name === 'protocol_v10_versions'));
  assert.ok(search.hits.some((h) => h.tool.name === 'protocol_v10_stateless'));
  const load = await run('protocol_v10_tool_search', { action: 'load', name: 'protocol_v10_tasks' });
  assert.equal(load.cacheHit, false);
  const load2 = await run('protocol_v10_tool_search', { action: 'load', name: 'protocol_v10_tasks' });
  assert.equal(load2.cacheHit, true);
  const reg = await run('protocol_v10_tool_search', {
    action: 'register',
    tool: { name: 'demo_searchable', description: 'A demo tool for search.', category: 'demo', deferLoading: true, keywords: ['demo'] },
  });
  assert.equal(reg.total, 6);
  const found = await run('protocol_v10_tool_search', { action: 'search', query: 'demo' });
  assert.ok(found.hits.some((h) => h.tool.name === 'demo_searchable'));
  const script = await run('protocol_v10_script', {
    action: 'run',
    script: {
      name: 'demo',
      steps: [
        { tool: 'protocol_v10_versions', args: { action: 'summary' }, saveAs: 'v' },
        { tool: 'protocol_v10_versions', args: { action: 'summary' } },
      ],
    },
  });
  assert.equal(script.ok, true);
  assert.equal(script.steps.length, 2);
  const badScript = await run('protocol_v10_script', {
    action: 'validate',
    script: { name: 'bad', steps: [{ tool: 'nope' }] },
  });
  assert.ok(badScript.problems.length > 0);
});

test('protocol_v10_tasks: create / run-next / counts / events', async () => {
  const created = await run('protocol_v10_tasks', { action: 'create', toolName: 'echo', taskArgs: { hello: 'world' } });
  assert.equal(created.state, 'submitted');
  const done = await run('protocol_v10_tasks', { action: 'run-next' });
  assert.equal(done.state, 'completed');
  assert.deepEqual(done.result, { echoed: { hello: 'world' } });
  const counts = await run('protocol_v10_tasks', { action: 'counts' });
  assert.equal(counts.completed, 1);
  const events = await run('protocol_v10_tasks', { action: 'events', id: created.id });
  assert.ok(events.events.some((e) => e.kind === 'created'));
  const got = await run('protocol_v10_tasks', { action: 'get', id: created.id });
  assert.equal(got.id, created.id);
  const snap = await run('protocol_v10_tasks', { action: 'snapshot' });
  assert.equal(snap.tasks.length, 1);
});

test('protocol_v10_apps: validate-resource / csp / validate-message', async () => {
  const resource = {
    uri: 'ui://demo/panel',
    mimeType: 'text/html;profile=mcp-app',
    html: '<html><body>hi</body></html>',
    domains: ['cdn.example.com'],
  };
  const valid = await run('protocol_v10_apps', { action: 'validate-resource', resource });
  assert.deepEqual(valid.problems, []);
  const csp = await run('protocol_v10_apps', { action: 'csp', resource, hostOrigin: 'app://open-bot' });
  assert.match(csp.csp, /default-src 'none'/);
  assert.ok(!csp.csp.includes('unsafe-inline'));
  const msg = await run('protocol_v10_apps', {
    action: 'validate-message',
    message: { jsonrpc: '2.0', id: 1, method: 'ui/initialize', params: {} },
  });
  assert.deepEqual(msg.problems, []);
});

test('protocol_v10_apps_bridge: open / initialize / call / audit / close', async () => {
  const opened = await run('protocol_v10_apps_bridge', {
    action: 'open', appId: 'app-t1', uri: 'ui://demo/panel', toolName: 'demo', allowedTools: ['echo'],
  });
  assert.equal(opened.appId, 'app-t1');
  const init = await run('protocol_v10_apps_bridge', {
    action: 'initialize', appId: 'app-t1', id: 'i1',
    capabilities: { bridgeVersions: ['1.0'] },
  });
  assert.equal(init.result.capabilities.bridgeVersion, '1.0');
  const call = await run('protocol_v10_apps_bridge', {
    action: 'call', appId: 'app-t1', id: 'c1', tool: 'echo', arguments: { x: 1 },
  });
  assert.equal(call.result.content.relayed, true);
  const denied = await run('protocol_v10_apps_bridge', {
    action: 'call', appId: 'app-t1', id: 'c2', tool: 'shell_exec', arguments: {},
  });
  assert.ok('error' in denied);
  const audit = await run('protocol_v10_apps_bridge', { action: 'audit', appId: 'app-t1' });
  assert.equal(audit.calls, 1);
  assert.ok(audit.rejected >= 1);
  const closed = await run('protocol_v10_apps_bridge', { action: 'close', appId: 'app-t1' });
  assert.equal(closed.closed, true);
});

test('protocol_v10_roundtrip: validate-request / validate-answer / run-demo', async () => {
  const request = {
    reason: 'Need a name.',
    fields: [{ name: 'who', type: 'string', required: true }],
  };
  const reqOk = await run('protocol_v10_roundtrip', { action: 'validate-request', request });
  assert.deepEqual(reqOk.problems, []);
  const ansOk = await run('protocol_v10_roundtrip', { action: 'validate-answer', request, answer: { who: 'Huy' } });
  assert.equal(ansOk.ok, true);
  const ansBad = await run('protocol_v10_roundtrip', { action: 'validate-answer', request, answer: {} });
  assert.equal(ansBad.ok, false);
  const demo = await run('protocol_v10_roundtrip', { action: 'run-demo', rounds: 2 });
  assert.equal(demo.result.done, true);
  assert.equal(demo.roundsUsed, 2);
});

test('protocol_v10_a2a: validate-card / well-known / negotiate / handshake / message', async () => {
  const card = {
    name: 'peer-agent',
    protocolVersions: ['1.1', '1.0'],
    capabilities: ['search', 'code'],
    authSchemes: ['none'],
    url: 'http://127.0.0.1:9000',
  };
  const valid = await run('protocol_v10_a2a', { action: 'validate-card', card });
  assert.deepEqual(valid.problems, []);
  const wk = await run('protocol_v10_a2a', { action: 'well-known', baseUrl: 'http://127.0.0.1:9000' });
  assert.equal(wk.url, 'http://127.0.0.1:9000/.well-known/agent-card.json');
  const neg = await run('protocol_v10_a2a', { action: 'negotiate', peerVersions: '1.0,1.1' });
  assert.equal(neg.agreed, '1.1');
  const hs = await run('protocol_v10_a2a', {
    action: 'handshake', card, baseUrl: 'http://127.0.0.1:9000',
    capabilities: ['search'], authSchemes: ['none'],
  });
  assert.equal(hs.version, '1.1');
  assert.deepEqual(hs.capabilities, ['search']);
  const msg = await run('protocol_v10_a2a', {
    action: 'message', card, baseUrl: 'http://127.0.0.1:9000',
    capabilities: ['search'], authSchemes: ['none'], text: 'hello',
  });
  assert.equal(msg.reply.text, 'echo: hello');
  assert.equal(msg.history.length, 2);
  const nonLoopback = await tool('protocol_v10_a2a').execute(
    { action: 'well-known', baseUrl: 'https://example.com' },
    { workspaceDir: '/tmp', botId: 't' },
  );
  assert.ok(nonLoopback.startsWith('Error:'));
});

test('protocol_v10_deprecation + registry: list / register / check-removal / counts', async () => {
  const list = await run('protocol_v10_deprecation', { action: 'list' });
  assert.equal(list.entries.length, 5);
  assert.ok(list.entries.some((e) => e.id === 'mcp.initialize'));
  const registered = await run('protocol_v10_deprecation', {
    action: 'register',
    id: 'demo.old', name: 'Demo Old', reason: 'replaced',
    deprecatedSince: '2026-07-28', replacedBy: 'demo.new',
  });
  assert.equal(registered.earliestRemoval, '2027-07-28');
  const check = await run('protocol_v10_deprecation', { action: 'check-removal', id: 'demo.old', today: '2026-08-01' });
  assert.equal(check.problems.length, 1);
  assert.match(check.problems[0], /cannot be removed yet/);
  const removable = await run('protocol_v10_deprecation', { action: 'removable-now', today: '2026-08-01' });
  assert.deepEqual(removable.entries, []);
  const counts = await run('protocol_v10_registry', { action: 'counts' });
  assert.match(counts.versions, /mcp 2026-07-28/);
  // The tool-search test registered one extra tool and the
  // deprecation test registered one extra entry on this shared
  // factory, so these are lower bounds, not exact counts.
  assert.ok(counts.toolSearch.total >= 5);
  assert.ok(counts.deprecations.total >= 5);
});

test('ALL_TOOLS contains the 12 v10 tools exactly once; bind replaces in place', () => {
  const names = ALL_TOOLS.map((t) => t.definition.name);
  for (const name of PROTOCOL_V118_TOOL_NAMES) {
    assert.equal(names.filter((n) => n === name).length, 1, `${name} must appear exactly once in ALL_TOOLS`);
  }
  const before = ALL_TOOLS.length;
  const bound = createDefaultTools({ getProtocolV118ToolOptions: () => ({}) });
  assert.equal(bound.length, before);
  for (const name of PROTOCOL_V118_TOOL_NAMES) {
    assert.equal(bound.filter((t) => t.definition.name === name).length, 1);
  }
});
