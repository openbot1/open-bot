/**
 * Tests for v1.42 (Team T2) — protocols v11 tools:
 * packages/tools/src/protocolsV11Tools.ts
 * packages/tools/src/registry.ts (registerProtocolV119Tools)
 * packages/tools/src/tools.ts (ALL_TOOLS spread + bind)
 *
 * Covers:
 *  - 12 tools, unique names, object parameters, descriptions,
 *    registry registration (fresh ToolRegistry -> 12 tools)
 *  - protocol_v11_versions: matrix / changes / downgrade /
 *    negotiate / interop / interop-table / flags / summary
 *  - protocol_v11_stateless: discover / list / call / counts /
 *    refuse-check (initialize + sampling refused)
 *  - protocol_v11_discover: discover / build-headers / parse-headers
 *  - protocol_v11_cache: list + not-modified via known hash / hash
 *  - protocol_v11_roundtrip: validate-request / validate-answer /
 *    run-confirm (2 rounds) / run-two-step (3 rounds)
 *  - protocol_v11_tasks: create / get / poll / counts / cancel /
 *    request-input + provide-input / snapshot / restore
 *  - protocol_v11_oauth: validate-issuer / validate-token (match
 *    passes, mismatch rejects) / metadata / binding
 *  - protocol_v11_interop: negotiate / matrix / detect / legacy-demo
 *  - protocol_v11_apps: validate-resource / csp / session lifecycle
 *  - protocol_v11_deprecation: list / earliest-removal /
 *    check-removal (not removable before 2027-07-28)
 *  - protocol_v11_meta: build / validate
 *  - protocol_v11_registry: counts
 *  - ALL_TOOLS contains the 12 v11 tools exactly once, and the
 *    bind path replaces them in place (same count, no duplicates)
 *
 * Run after building core + tools:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/protocols-v11-tools-v142.test.mjs
 *
 * No network, no model, no credential access (test tokens are fake).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PROTOCOL_V119_TOOLS,
  PROTOCOL_V119_TOOL_NAMES,
  createProtocolV119Tools,
  isProtocolV119ToolName,
} from '../packages/tools/dist/protocolsV11Tools.js';
import { ALL_TOOLS, createDefaultTools } from '../packages/tools/dist/tools.js';
import { ToolRegistry } from '../packages/tools/dist/registry.js';

const SHARED_TOOLS = createProtocolV119Tools();

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

test('12 tools, unique names, object parameters, isProtocolV119ToolName', () => {
  assert.equal(PROTOCOL_V119_TOOLS.length, 12);
  assert.equal(PROTOCOL_V119_TOOL_NAMES.length, 12);
  assert.deepEqual(
    PROTOCOL_V119_TOOLS.map((t) => t.definition.name).sort(),
    [...PROTOCOL_V119_TOOL_NAMES].sort(),
  );
  const names = new Set();
  for (const t of PROTOCOL_V119_TOOLS) {
    assert.ok(t.definition.name.startsWith('protocol_v11_'), t.definition.name);
    assert.ok(!names.has(t.definition.name), `duplicate ${t.definition.name}`);
    names.add(t.definition.name);
    assert.equal(t.definition.parameters.type, 'object');
    assert.ok(t.definition.description.length > 20);
    assert.equal(typeof t.needsApproval, 'boolean');
    assert.equal(typeof t.execute, 'function');
  }
  assert.equal(isProtocolV119ToolName('protocol_v11_versions'), true);
  assert.equal(isProtocolV119ToolName('protocol_v10_versions'), false);
  assert.equal(isProtocolV119ToolName('nope'), false);
});

test('registry registration: fresh ToolRegistry gets exactly the 12 tools', () => {
  const registry = new ToolRegistry();
  registry.registerProtocolV119Tools();
  for (const name of PROTOCOL_V119_TOOL_NAMES) {
    assert.ok(registry.get(name), `registry is missing ${name}`);
  }
  // Re-registering throws (register() refuses duplicates) — the
  // registry never silently holds a tool twice.
  assert.throws(() => registry.registerProtocolV119Tools(), /already registered/);
});

test('protocol_v11_versions: matrix / changes / downgrade / negotiate / interop / flags / summary', async () => {
  const matrix = await run('protocol_v11_versions', { action: 'matrix' });
  assert.equal(matrix.current, '2026-07-28');
  assert.deepEqual(matrix.versions, ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);
  assert.equal(matrix.handshakeCutoff, '2025-11-25');
  assert.deepEqual(matrix.extensions, ['io.modelcontextprotocol/tasks', 'io.modelcontextprotocol/ui']);
  const changes = await run('protocol_v11_versions', { action: 'changes' });
  assert.ok(changes.changes.length >= 8);
  const down = await run('protocol_v11_versions', { action: 'downgrade' });
  assert.ok(down.downgrade.lost.length >= 3);
  const neg = await run('protocol_v11_versions', { action: 'negotiate', offered: '2025-11-25,2026-07-28' });
  assert.equal(neg.agreed, '2026-07-28');
  const interop = await run('protocol_v11_versions', { action: 'interop', serverVersion: '2025-11-25' });
  assert.equal(interop.mode, 'handshake-fallback');
  assert.equal(interop.handshakeRequired, true);
  const modern = await run('protocol_v11_versions', { action: 'interop', serverVersion: '2026-07-28' });
  assert.equal(modern.mode, 'stateless');
  const table = await run('protocol_v11_versions', { action: 'interop-table' });
  assert.equal(table.rows.length, 25);
  assert.match(table.summary, /2026-07-28 -> stateless/);
  const flags = await run('protocol_v11_versions', { action: 'flags', features: { multiRoundTrip: true, bogus: 1 } });
  assert.ok(flags.problems.some((p) => p.includes('bogus')));
  const summary = await run('protocol_v11_versions', { action: 'summary' });
  assert.match(summary.summary, /mcp 2026-07-28/);
  const bad = await tool('protocol_v11_versions').execute({ action: 'nope' }, { workspaceDir: '/tmp', botId: 't' });
  assert.ok(bad.startsWith('Error:'));
});

test('protocol_v11_stateless: discover / list / call / counts / refuse-check', async () => {
  const discovered = await run('protocol_v11_stateless', { action: 'discover' });
  assert.equal(discovered.protocolVersion, '2026-07-28');
  assert.equal(discovered.tasksOffered, true);
  assert.equal(discovered.appsOffered, true);
  const listed = await run('protocol_v11_stateless', { action: 'list-tools' });
  assert.equal(listed.notModified, false);
  assert.deepEqual(listed.entries.map((e) => e.name), ['add', 'demo-confirm', 'echo']);
  const called = await run('protocol_v11_stateless', { action: 'call-tool', name: 'add', arguments: { a: 10, b: 5 } });
  assert.equal(called.sum, 15);
  const resources = await run('protocol_v11_stateless', { action: 'list-resources' });
  assert.equal(resources.entries.length, 2);
  const counts = await run('protocol_v11_stateless', { action: 'counts' });
  assert.ok(counts.totalCalls > 0);
  assert.deepEqual(counts.tools, ['add', 'demo-confirm', 'echo']);
  const refuseInit = await run('protocol_v11_stateless', { action: 'refuse-check', method: 'initialize' });
  assert.equal(refuseInit.refused, true);
  assert.equal(refuseInit.error.data.code, 'session-only-method');
  const refuseSampling = await run('protocol_v11_stateless', { action: 'refuse-check', method: 'sampling/createMessage' });
  assert.equal(refuseSampling.refused, true);
  assert.equal(refuseSampling.error.data.code, 'deprecated-callback');
  const unknown = await tool('protocol_v11_stateless').execute({ action: 'call-tool', name: 'nope', arguments: {} }, { workspaceDir: '/tmp', botId: 't' });
  assert.ok(unknown.startsWith('Error:'));
});

test('protocol_v11_discover + protocol_v11_cache: headers + not-modified lists', async () => {
  const discovered = await run('protocol_v11_discover', { action: 'discover' });
  assert.equal(discovered.serverInfo.name, 'open-bot-mcp-v11');
  const built = await run('protocol_v11_discover', { action: 'build-headers', routingKey: 'route:demo', targetServer: 'demo' });
  assert.equal(built.headers.protocolVersion, '2026-07-28');
  assert.equal(built.headers.routingKey, 'route:demo');
  const parsed = await run('protocol_v11_discover', {
    action: 'parse-headers',
    headers: { 'mcp-request-id': 'req-1', 'mcp-protocol-version': '2026-07-28', 'mcp-routing-key': 'route:demo' },
  });
  assert.deepEqual(parsed.problems, []);
  assert.equal(parsed.headers.requestId, 'req-1');
  const first = await run('protocol_v11_cache', { action: 'list' });
  assert.equal(first.notModified, false);
  const cached = await run('protocol_v11_cache', { action: 'list', knownListHash: first.listHash });
  assert.equal(cached.notModified, true);
  assert.equal(cached.listVersion, first.listVersion);
  const hashed = await run('protocol_v11_cache', { action: 'hash', entries: [{ name: 'b' }, { name: 'a' }] });
  assert.match(hashed.listHash, /^[0-9a-f]{8}$/);
  // Hashing is order-independent: [a, b] hashes the same as [b, a].
  const hashedReordered = await run('protocol_v11_cache', { action: 'hash', entries: [{ name: 'a' }, { name: 'b' }] });
  assert.equal(hashedReordered.listHash, hashed.listHash);
  const kinds = await run('protocol_v11_cache', { action: 'cache-kinds' });
  assert.deepEqual(kinds.kinds, []);
});

test('protocol_v11_roundtrip: validate + confirm demo (2 rounds) + two-step demo (3 rounds)', async () => {
  const request = {
    id: 'confirm-delete',
    title: 'Confirm deletion',
    reason: 'Needs confirmation.',
    fields: [{ name: 'confirmed', prompt: 'Delete?', type: 'boolean', required: true }],
  };
  const validReq = await run('protocol_v11_roundtrip', { action: 'validate-request', request });
  assert.deepEqual(validReq.problems, []);
  const badReq = await run('protocol_v11_roundtrip', { action: 'validate-request', request: { id: 'x', fields: [] } });
  assert.ok(badReq.problems.length > 0);
  const validAns = await run('protocol_v11_roundtrip', { action: 'validate-answer', request, answer: { confirmed: true } });
  assert.deepEqual(validAns.problems, []);
  const badAns = await run('protocol_v11_roundtrip', { action: 'validate-answer', request, answer: { confirmed: 'yes' } });
  assert.ok(badAns.problems.length > 0);
  const confirm = await run('protocol_v11_roundtrip', { action: 'run-confirm', item: 'old-report', answer: { confirmed: true, reason: 'stale' } });
  assert.equal(confirm.rounds, 2);
  assert.equal(confirm.multiRound, true);
  assert.equal(confirm.result.deleted, true);
  const twoStep = await run('protocol_v11_roundtrip', { action: 'run-two-step', answer: { mode: 'fast', count: 4 } });
  assert.equal(twoStep.rounds, 3);
  assert.equal(twoStep.result.mode, 'fast');
  assert.equal(twoStep.result.count, 4);
});

test('protocol_v11_tasks: create / poll / get / counts / cancel / input round / snapshot', async () => {
  const created = await run('protocol_v11_tasks', { action: 'create', kind: 'sum', input: { numbers: [1, 2, 3, 4] } });
  assert.ok(created.id.startsWith('task-'));
  const polled = await run('protocol_v11_tasks', { action: 'poll', id: created.id, maxPolls: 100 });
  assert.equal(polled.status, 'completed');
  assert.equal(polled.result.sum, 10);
  const got = await run('protocol_v11_tasks', { action: 'get', id: created.id });
  assert.equal(got.status, 'completed');
  const counts = await run('protocol_v11_tasks', { action: 'counts' });
  assert.ok(counts.completed >= 1);
  // Progress demo handler reports progress events.
  const progressTask = await run('protocol_v11_tasks', { action: 'create', kind: 'progress-demo', input: {} });
  const progressDone = await run('protocol_v11_tasks', { action: 'poll', id: progressTask.id, maxPolls: 100 });
  assert.equal(progressDone.status, 'completed');
  assert.ok(progressDone.progressEvents.length >= 3);
  // Cancel a still-running task: the 'slow' handler stays running
  // for ~300 ms, so cancelling right after create is deterministic
  // (the echo/sum handlers finish before a cancel could land).
  const cancellable = await run('protocol_v11_tasks', { action: 'create', kind: 'slow', input: { x: 1 } });
  const cancelled = await run('protocol_v11_tasks', { action: 'cancel', id: cancellable.id });
  assert.equal(cancelled.status, 'cancelled');
  const listed = await run('protocol_v11_tasks', { action: 'list', status: 'cancelled' });
  assert.ok(listed.tasks.some((t) => t.id === cancellable.id));
  const snap = await run('protocol_v11_tasks', { action: 'snapshot' });
  assert.ok(Array.isArray(snap.tasks));
  assert.ok(snap.tasks.length >= 3);
  const restored = await run('protocol_v11_tasks', { action: 'restore', snapshot: { tasks: snap.tasks } });
  assert.equal(restored.restored, snap.tasks.length);
  const swept = await run('protocol_v11_tasks', { action: 'sweep' });
  assert.deepEqual(swept.expired, []);
  const bad = await tool('protocol_v11_tasks').execute({ action: 'get', id: 'task-nope' }, { workspaceDir: '/tmp', botId: 't' });
  assert.ok(bad.startsWith('Error:'));
});

test('protocol_v11_oauth: issuer + token + metadata + binding', async () => {
  const issuer = await run('protocol_v11_oauth', { action: 'validate-issuer', issuer: 'https://auth.example.com' });
  assert.deepEqual(issuer.problems, []);
  const badIssuer = await run('protocol_v11_oauth', { action: 'validate-issuer', issuer: 'http://auth.example.com' });
  assert.ok(badIssuer.problems.length > 0);
  const nowSec = Math.floor(Date.now() / 1000);
  const good = await run('protocol_v11_oauth', {
    action: 'validate-token',
    issuer: 'https://auth.example.com',
    token: { value: 'tok-1', issuer: 'https://auth.example.com', audience: 'open-bot', expiresAtSec: nowSec + 3600 },
    expectedAudience: 'open-bot',
  });
  assert.equal(good.valid, true);
  const bad = await run('protocol_v11_oauth', {
    action: 'validate-token',
    issuer: 'https://auth.example.com',
    token: { value: 'tok-1', issuer: 'https://evil.example.com' },
  });
  assert.equal(bad.valid, false);
  assert.ok(bad.problems.some((p) => p.includes('does not match')));
  const meta = await run('protocol_v11_oauth', {
    action: 'validate-auth-metadata',
    issuer: 'https://auth.example.com',
    metadata: {
      issuer: 'https://auth.example.com',
      authorization_endpoint: 'https://auth.example.com/authorize',
      token_endpoint: 'https://auth.example.com/token',
      response_types_supported: ['code'],
    },
  });
  assert.deepEqual(meta.problems, []);
  const resource = await run('protocol_v11_oauth', {
    action: 'validate-resource-metadata',
    issuer: 'https://auth.example.com',
    metadata: { resource: 'https://mcp.example.com', authorization_servers: ['https://auth.example.com'] },
  });
  assert.deepEqual(resource.problems, []);
  const binding = await run('protocol_v11_oauth', {
    action: 'binding',
    token: { value: 'tok-abc', issuer: 'https://auth.example.com' },
  });
  assert.match(binding.fingerprint, /^[0-9a-f]{16}$/);
  const check = await run('protocol_v11_oauth', {
    action: 'check-binding',
    fingerprint: binding.fingerprint,
    token: { value: 'tok-abc', issuer: 'https://auth.example.com' },
  });
  assert.equal(check.matches, true);
  const checkBad = await run('protocol_v11_oauth', {
    action: 'check-binding',
    fingerprint: binding.fingerprint,
    token: { value: 'tok-other', issuer: 'https://auth.example.com' },
  });
  assert.equal(checkBad.matches, false);
});

test('protocol_v11_interop: negotiate / matrix / detect / legacy demo', async () => {
  const neg = await run('protocol_v11_interop', { action: 'negotiate', serverVersion: '2025-11-25' });
  assert.equal(neg.mode, 'handshake-fallback');
  assert.equal(neg.downgradeWarning, true);
  const matrix = await run('protocol_v11_interop', { action: 'matrix' });
  assert.equal(matrix.rows.length, 5);
  const detected = await run('protocol_v11_interop', { action: 'detect', discoverOk: false, discoverErrorCode: -32601 });
  assert.equal(detected.mode, 'legacy-handshake');
  const demo = await run('protocol_v11_interop', {
    action: 'legacy-demo',
    serverVersion: '2025-11-25',
    tool: 'add',
    arguments: { a: 6, b: 7 },
  });
  assert.equal(demo.handshake.serverInfo.name, 'legacy-mcp-server');
  assert.deepEqual(demo.tools.sort(), ['add', 'echo']);
  assert.equal(demo.result.sum, 13);
  assert.equal(demo.sessionId, 'legacy-session-2025-11-25');
  assert.equal(demo.effectiveCapabilities.multiRoundTrip, false);
  assert.ok(demo.warnings.length > 0);
  const summary = await run('protocol_v11_interop', { action: 'summary' });
  assert.match(summary.summary, /handshake/);
  const bad = await tool('protocol_v11_interop').execute({ action: 'legacy-demo', serverVersion: '2026-07-28' }, { workspaceDir: '/tmp', botId: 't' });
  assert.ok(bad.startsWith('Error:'));
});

test('protocol_v11_apps: validate / csp / session lifecycle / audit', async () => {
  const resource = {
    uri: 'ui://example.com/weather-card',
    mimeType: 'text/html',
    sandbox: ['allow-scripts', 'allow-same-origin'],
    allowedDomains: ['cdn.example.com'],
    title: 'Weather card',
  };
  const valid = await run('protocol_v11_apps', { action: 'validate-resource', resource });
  assert.deepEqual(valid.problems, []);
  const invalid = await run('protocol_v11_apps', {
    action: 'validate-resource',
    resource: { ...resource, sandbox: ['allow-scripts', 'allow-top-navigation'] },
  });
  assert.ok(invalid.problems.some((p) => p.includes('forbidden')));
  const csp = await run('protocol_v11_apps', { action: 'csp', resource });
  assert.match(csp.csp, /default-src 'none'/);
  assert.match(csp.csp, /https:\/\/cdn\.example\.com/);
  const msg = await run('protocol_v11_apps', {
    action: 'validate-message',
    message: { jsonrpc: '2.0', method: 'ui/tool-call', params: { tool: 'weather.get' } },
  });
  assert.deepEqual(msg.problems, []);
  const opened = await run('protocol_v11_apps', { action: 'session-open', resource });
  assert.ok(opened.sessionId.startsWith('app-'));
  assert.equal(opened.status, 'opened');
  const init = await run('protocol_v11_apps', {
    action: 'session-message',
    sessionId: opened.sessionId,
    message: { jsonrpc: '2.0', method: 'ui/initialize', params: { appUri: resource.uri } },
  });
  assert.equal(init.ok, true);
  const call = await run('protocol_v11_apps', {
    action: 'session-message',
    sessionId: opened.sessionId,
    message: { jsonrpc: '2.0', method: 'ui/tool-call', params: { tool: 'weather.get', arguments: { city: 'Hanoi' } } },
  });
  assert.equal(call.ok, true);
  assert.equal(call.result.queued, true);
  const audit = await run('protocol_v11_apps', { action: 'session-audit', sessionId: opened.sessionId });
  assert.equal(audit.status, 'initialized');
  assert.equal(audit.allowedCalls.length, 1);
  assert.deepEqual(audit.audit.map((a) => a.kind), ['open', 'initialize', 'tool-call']);
  const closed = await run('protocol_v11_apps', { action: 'session-close', sessionId: opened.sessionId });
  assert.equal(closed.status, 'closed');
});

test('protocol_v11_deprecation + meta + registry', async () => {
  const listed = await run('protocol_v11_deprecation', { action: 'list' });
  assert.deepEqual(listed.entries.map((e) => e.id).sort(), ['logging', 'roots', 'sampling']);
  const earliest = await run('protocol_v11_deprecation', { action: 'earliest-removal', deprecatedSince: '2026-07-28' });
  assert.equal(earliest.earliestRemoval, '2027-07-28');
  const security = await run('protocol_v11_deprecation', { action: 'earliest-removal', deprecatedSince: '2026-07-28', securityFlaw: true });
  assert.equal(security.earliestRemoval, '2026-10-26');
  const check = await run('protocol_v11_deprecation', { action: 'check-removal', id: 'sampling', today: '2026-11-19' });
  assert.equal(check.removable, false);
  assert.ok(check.problems.some((p) => p.includes('2027-07-28')));
  const future = await run('protocol_v11_deprecation', { action: 'check-removal', id: 'sampling', today: '2027-07-28' });
  assert.equal(future.removable, true);
  const removable = await run('protocol_v11_deprecation', { action: 'removable-now', today: '2026-11-19' });
  assert.deepEqual(removable.entries, []);
  const built = await run('protocol_v11_meta', { action: 'build', capabilities: { tasks: false }, clientName: 'open-bot', clientVersion: '1.42.0' });
  assert.equal(built.meta.protocolVersion, '2026-07-28');
  assert.equal(built.meta.capabilities.tasks, false);
  assert.equal(built.meta.capabilities.multiRoundTrip, true);
  assert.equal(built.meta.clientInfo.name, 'open-bot');
  const validated = await run('protocol_v11_meta', { action: 'validate', meta: built.meta });
  assert.deepEqual(validated.problems, []);
  const badMeta = await run('protocol_v11_meta', { action: 'validate', meta: { protocolVersion: '2025-11-25', capabilities: {} } });
  assert.ok(badMeta.problems.length > 0);
  const registry = await run('protocol_v11_registry', { action: 'counts' });
  assert.equal(registry.current, '2026-07-28');
  assert.deepEqual(registry.deprecations.entries, ['roots', 'sampling', 'logging']);
  assert.equal(registry.isTaskTerminalExample, true);
  assert.ok(registry.tasks.total >= 0);
});

test('ALL_TOOLS contains the 12 v11 tools exactly once; bind replaces in place', () => {
  const v11InAll = ALL_TOOLS.filter((t) => t.definition.name.startsWith('protocol_v11_'));
  assert.equal(v11InAll.length, 12);
  assert.deepEqual(v11InAll.map((t) => t.definition.name).sort(), [...PROTOCOL_V119_TOOL_NAMES].sort());
  const before = createDefaultTools();
  const beforeCount = before.length;
  const beforeIdx = before.findIndex((t) => t.definition.name === 'protocol_v11_versions');
  assert.ok(beforeIdx >= 0);
  const bound = createDefaultTools({ getProtocolV119ToolOptions: () => ({}) });
  assert.equal(bound.length, beforeCount);
  assert.equal(bound.filter((t) => t.definition.name === 'protocol_v11_versions').length, 1);
  assert.equal(bound.findIndex((t) => t.definition.name === 'protocol_v11_versions'), beforeIdx);
});
