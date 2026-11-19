/**
 * Tests for v1.39 (Team T2) — protocols v8 tools:
 * packages/tools/src/protocolV116Tools.ts
 * packages/tools/src/registry.ts (registerProtocolV116Tools)
 * packages/tools/src/tools.ts (ALL_TOOLS spread + bind)
 *
 * Covers:
 *  - 12 tools, unique names, object parameters, descriptions,
 *    registry registration (fresh ToolRegistry -> 12 tools),
 *    duplicate registration refused (via registry semantics:
 *    the tools file itself only asserts the factory list)
 *  - protocol_v8_discover: local demo discover + tools list
 *  - protocol_v8_versions: matrix / extensions / deprecations /
 *    changes / downgrade / negotiate
 *  - protocol_v8_extensions: both-sides negotiation
 *  - protocol_v8_stateless: ping / tools-call (echo) / check
 *  - protocol_v8_legacy: initialize / call / sessions / close
 *  - protocol_v8_apps: register / render / validate / callback
 *  - protocol_v8_tasks: submit echo (poll to completed) +
 *    submit ask-name (MRTR update -> greeting) / cancel / counts
 *  - protocol_v8_oauth: pkce-generate (challenge verified against
 *    node:crypto) / pkce-verify / redirect-validate
 *  - protocol_v8_deprecation: record / counts / plan / transport
 *  - protocol_v8_nanda: identity-create / pin / trust-check /
 *    discover + server-card build
 *  - protocol_v8_skills: register / list / body / read
 *  - ALL_TOOLS contains the 12 v8 tools exactly once, and the
 *    bind path replaces them in place (same count, no duplicates)
 *
 * Run after building core + tools:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/protocols-v8-tools.test.mjs
 *
 * No network, no model.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  PROTOCOL_V116_TOOLS,
  PROTOCOL_V116_TOOL_NAMES,
  createProtocolV116Tools,
  isProtocolV116ToolName,
} from '../packages/tools/dist/protocolV116Tools.js';
import { ALL_TOOLS, createDefaultTools } from '../packages/tools/dist/tools.js';
import { ToolRegistry } from '../packages/tools/dist/registry.js';

async function call(tools, name, args) {
  const tool = tools.find((t) => t.definition.name === name);
  assert.notEqual(tool, undefined, `tool ${name} missing`);
  const out = await tool.execute(args);
  if (typeof out === 'string' && out.startsWith('Error:')) {
    throw new Error(`tool ${name} failed: ${out}`);
  }
  return JSON.parse(out);
}

async function waitFor(predicate, timeoutMs = 3000, stepMs = 10) {
  const start = Date.now();
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

const EXPECTED_NAMES = [
  'protocol_v8_discover',
  'protocol_v8_versions',
  'protocol_v8_extensions',
  'protocol_v8_stateless',
  'protocol_v8_legacy',
  'protocol_v8_apps',
  'protocol_v8_tasks',
  'protocol_v8_oauth',
  'protocol_v8_deprecation',
  'protocol_v8_nanda',
  'protocol_v8_server_card',
  'protocol_v8_skills',
];

test('12 tools: exact names, unique, object params, descriptions', () => {
  assert.deepEqual([...PROTOCOL_V116_TOOL_NAMES].sort(), [...EXPECTED_NAMES].sort());
  assert.equal(PROTOCOL_V116_TOOLS.length, 12);
  const names = PROTOCOL_V116_TOOLS.map((t) => t.definition.name);
  assert.equal(new Set(names).size, 12);
  for (const tool of PROTOCOL_V116_TOOLS) {
    assert.equal(tool.definition.parameters.type, 'object');
    assert.ok(tool.definition.description.length > 20);
    assert.equal(isProtocolV116ToolName(tool.definition.name), true);
  }
  assert.equal(isProtocolV116ToolName('protocol_v7_versions'), false);
  assert.equal(isProtocolV116ToolName('nope'), false);
  assert.equal(createProtocolV116Tools().length, 12);
});

test('ALL_TOOLS contains the 12 v8 tools exactly once; bind replaces in place', () => {
  const v8 = ALL_TOOLS.filter((t) => t.definition.name.startsWith('protocol_v8_'));
  assert.deepEqual(v8.map((t) => t.definition.name).sort(), [...EXPECTED_NAMES].sort());
  assert.equal(new Set(ALL_TOOLS.map((t) => t.definition.name)).size, ALL_TOOLS.length);
  const bound = createDefaultTools({ getProtocolV116ToolOptions: () => ({}) });
  assert.equal(bound.length, ALL_TOOLS.length);
  assert.equal(new Set(bound.map((t) => t.definition.name)).size, bound.length);
  assert.equal(bound.filter((t) => t.definition.name.startsWith('protocol_v8_')).length, 12);
});

test('ToolRegistry: registerProtocolV116Tools registers 12; duplicate refused', () => {
  const registry = new ToolRegistry();
  registry.registerProtocolV116Tools();
  assert.equal(registry.list().length, 12);
  assert.equal(registry.has('protocol_v8_discover'), true);
  assert.equal(registry.get('protocol_v8_tasks')?.definition.name, 'protocol_v8_tasks');
  assert.throws(() => registry.registerProtocolV116Tools(), /already registered/);
});

test('protocol_v8_discover: local demo discover + tools', async () => {
  const tools = createProtocolV116Tools();
  const out = await call(tools, 'protocol_v8_discover', {});
  assert.equal(out.discovered.protocolVersion, '2026-07-28');
  assert.equal(out.discovered.capabilities.mcpDiscover, true);
  assert.equal(out.discovered.extensions.length, 6);
  assert.equal(out.localDemo, true);
  assert.ok(out.tools.tools.some((t) => t.name === 'echo'));
});

test('protocol_v8_versions: matrix / extensions / deprecations / changes / downgrade / negotiate', async () => {
  const tools = createProtocolV116Tools();
  const matrix = await call(tools, 'protocol_v8_versions', { action: 'matrix' });
  assert.equal(matrix.current.mcp, '2026-07-28');
  assert.equal(matrix.current.nanda, '0.1-local');
  const ext = await call(tools, 'protocol_v8_versions', { action: 'extensions' });
  assert.equal(ext.count, 6);
  const dep = await call(tools, 'protocol_v8_versions', { action: 'deprecations' });
  assert.equal(dep.count, 6);
  assert.equal(dep.calendar.length, 9);
  const changes = await call(tools, 'protocol_v8_versions', { action: 'changes' });
  assert.ok(changes.changes.length >= 8);
  const down = await call(tools, 'protocol_v8_versions', { action: 'downgrade' });
  assert.equal(down.downgradeToV7.length, 9);
  const neg = await call(tools, 'protocol_v8_versions', {
    action: 'negotiate', family: 'mcp', serverVersions: ['2026-07-28'],
  });
  assert.equal(neg.negotiation.negotiated, '2026-07-28');
  const all = await call(tools, 'protocol_v8_versions', {
    action: 'negotiate-all', serverVersions: { mcp: ['2026-07-28'] },
  });
  assert.equal(all.negotiations.mcp.negotiated, '2026-07-28');
  const bad = await tools.find((t) => t.definition.name === 'protocol_v8_versions').execute({ action: 'nope' });
  assert.match(bad, /^Error: Unknown action/);
});

test('protocol_v8_extensions: active only on overlap; unknown never activates', async () => {
  const tools = createProtocolV116Tools();
  const out = await call(tools, 'protocol_v8_extensions', {
    peerOffer: ['io.modelcontextprotocol/tasks', 'io.modelcontextprotocol/nope'],
  });
  assert.deepEqual(out.negotiation.active, ['io.modelcontextprotocol/tasks']);
  assert.deepEqual(out.negotiation.unknown, ['io.modelcontextprotocol/nope']);
  assert.equal(out.negotiation.tasksActive, true);
  const none = await call(tools, 'protocol_v8_extensions', { peerOffer: [] });
  assert.deepEqual(none.negotiation.active, []);
});

test('protocol_v8_stateless: ping / echo call / stateless check', async () => {
  const tools = createProtocolV116Tools();
  const ping = await call(tools, 'protocol_v8_stateless', { action: 'ping' });
  assert.equal(ping.ping.ok, true);
  assert.equal(ping.ping.protocolVersion, '2026-07-28');
  const list = await call(tools, 'protocol_v8_stateless', { action: 'tools-list' });
  assert.ok(list.tools.some((t) => t.name === 'echo'));
  const echo = await call(tools, 'protocol_v8_stateless', {
    action: 'tools-call', name: 'echo', arguments: { text: 'hi-v8' },
  });
  assert.equal(echo.result.structuredContent.echo, 'hi-v8');
  const check = await call(tools, 'protocol_v8_stateless', { action: 'check' });
  assert.equal(check.check.stateless, true);
  assert.equal(check.check.sessions, 0);
  const err = await tools.find((t) => t.definition.name === 'protocol_v8_stateless').execute({ action: 'tools-call', name: 'nope', arguments: {} });
  assert.match(err, /^Error:/);
});

test('protocol_v8_legacy: initialize warns, call runs, sessions list, close', async () => {
  const tools = createProtocolV116Tools();
  const init = await call(tools, 'protocol_v8_legacy', { action: 'initialize', clientName: 'old-one' });
  assert.equal(init.response.result.deprecated, true);
  assert.match(init.response.result.warning, /deprecated/);
  const sessionId = init.response.result.sessionId;
  assert.equal(init.sessions, 1);
  const called = await call(tools, 'protocol_v8_legacy', {
    action: 'call', sessionId, method: 'tools/call',
    params: { name: 'echo', arguments: { text: 'legacy-hi' } },
  });
  assert.equal(called.response.result.structuredContent.echo, 'legacy-hi');
  const sessions = await call(tools, 'protocol_v8_legacy', { action: 'sessions' });
  assert.deepEqual(sessions.sessions, [sessionId]);
  const closed = await call(tools, 'protocol_v8_legacy', { action: 'close', sessionId });
  assert.equal(closed.closed, true);
  assert.equal(closed.remaining, 0);
});

test('protocol_v8_apps: register / render / validate / callback / list', async () => {
  const tools = createProtocolV116Tools();
  const html = '<!doctype html><html><body><h1>Hi</h1><img src="https://cdn.example.com/i.png"></body></html>';
  const resource = {
    uri: 'ui://demo-card/main',
    name: 'demo-card',
    html,
    mimeType: 'text/html;profile=mcp-app',
    domains: ['cdn.example.com'],
    allowedTools: ['echo'],
    toolName: 'demo',
  };
  const reg = await call(tools, 'protocol_v8_apps', { action: 'register', resource });
  assert.equal(reg.registration.uri, 'ui://demo-card/main');
  const rendered = await call(tools, 'protocol_v8_apps', {
    action: 'render', toolName: 'demo', resourceUri: 'ui://demo-card/main',
  });
  assert.match(rendered.render.csp, /cdn\.example\.com/);
  assert.match(rendered.render.sandbox, /allow-scripts/);
  const valid = await call(tools, 'protocol_v8_apps', {
    action: 'validate', html: '<button onclick="x()">y</button>', domains: [],
  });
  assert.equal(valid.validation.ok, false);
  const cbOk = await call(tools, 'protocol_v8_apps', {
    action: 'callback', callback: { resourceUri: 'ui://demo-card/main', tool: 'echo', arguments: { text: 'x' } },
  });
  assert.equal(cbOk.check.ok, true);
  const cbBad = await call(tools, 'protocol_v8_apps', {
    action: 'callback', callback: { resourceUri: 'ui://demo-card/main', tool: 'delete-all', arguments: {} },
  });
  assert.equal(cbBad.check.ok, false);
  const list = await call(tools, 'protocol_v8_apps', { action: 'list' });
  assert.deepEqual(list.uris, ['ui://demo-card/main']);
  const bad = await tools.find((t) => t.definition.name === 'protocol_v8_apps').execute({
    action: 'register',
    resource: { ...resource, uri: 'ui://bad/main', html: '<script src="https://evil.com/x.js"></script>' },
  });
  assert.match(bad, /^Error:/);
});

test('protocol_v8_tasks: echo completes; ask-name MRTR round completes with greeting', async () => {
  const tools = createProtocolV116Tools();
  const submitted = await call(tools, 'protocol_v8_tasks', {
    action: 'submit', toolName: 'echo', arguments: { text: 'task-hi' },
  });
  const taskId = submitted.task.taskId;
  assert.equal(submitted.task.status, 'submitted');
  const done = await waitFor(async () => {
    const t = await call(tools, 'protocol_v8_tasks', { action: 'get', taskId });
    return t.task.status === 'completed' ? t.task : null;
  });
  assert.deepEqual(done.result, { echo: 'task-hi' });

  const asked = await call(tools, 'protocol_v8_tasks', {
    action: 'submit', toolName: 'ask-name', arguments: { text: 'hey' },
  });
  const askId = asked.task.taskId;
  await waitFor(async () => {
    const t = await call(tools, 'protocol_v8_tasks', { action: 'get', taskId: askId });
    return t.task.status === 'input-required' ? t.task : null;
  });
  const resumed = await call(tools, 'protocol_v8_tasks', {
    action: 'update', taskId: askId, input: { name: 'Huy' },
  });
  assert.equal(resumed.task.status, 'working');
  const greeted = await waitFor(async () => {
    const t = await call(tools, 'protocol_v8_tasks', { action: 'get', taskId: askId });
    return t.task.status === 'completed' ? t.task : null;
  });
  assert.deepEqual(greeted.result, { greeting: 'Hello, Huy!', original: 'hey' });

  const counts = await call(tools, 'protocol_v8_tasks', { action: 'counts' });
  assert.equal(counts.counts.completed, 2);
  const methods = await call(tools, 'protocol_v8_tasks', { action: 'methods' });
  assert.deepEqual(methods.methods, ['tasks/get', 'tasks/update', 'tasks/cancel']);
  const swept = await call(tools, 'protocol_v8_tasks', { action: 'sweep' });
  assert.deepEqual(swept.swept, []);

  // Cancel path.
  const toCancel = await call(tools, 'protocol_v8_tasks', {
    action: 'submit', toolName: 'ask-name', arguments: { text: 'x' },
  });
  await waitFor(async () => {
    const t = await call(tools, 'protocol_v8_tasks', { action: 'get', taskId: toCancel.task.taskId });
    return t.task.status === 'input-required' ? t.task : null;
  });
  const canceled = await call(tools, 'protocol_v8_tasks', { action: 'cancel', taskId: toCancel.task.taskId });
  assert.equal(canceled.task.status, 'canceled');
});

test('protocol_v8_oauth: pkce-generate challenge matches node:crypto; verify + redirect', async () => {
  const tools = createProtocolV116Tools();
  const gen = await call(tools, 'protocol_v8_oauth', { action: 'pkce-generate', length: 64 });
  assert.equal(gen.verifier.length, 64);
  assert.equal(gen.method, 'S256');
  assert.equal(gen.challenge, createHash('sha256').update(gen.verifier, 'ascii').digest('base64url'));
  const verified = await call(tools, 'protocol_v8_oauth', {
    action: 'pkce-verify', verifier: gen.verifier, challenge: gen.challenge, method: 'S256',
  });
  assert.equal(verified.ok, true);
  const plain = await call(tools, 'protocol_v8_oauth', {
    action: 'pkce-verify', verifier: gen.verifier, challenge: gen.challenge, method: 'plain',
  });
  assert.equal(plain.ok, false);
  const redirectOk = await call(tools, 'protocol_v8_oauth', {
    action: 'redirect-validate', redirectUri: 'https://app.example.com/callback',
  });
  assert.equal(redirectOk.valid, true);
  const redirectBad = await call(tools, 'protocol_v8_oauth', {
    action: 'redirect-validate', redirectUri: 'http://app.example.com/callback',
  });
  assert.equal(redirectBad.valid, false);
  const matched = await call(tools, 'protocol_v8_oauth', {
    action: 'redirect-match',
    redirectUri: 'https://localhost:4317/callback',
    registered: ['https://localhost:4317/callback'],
  });
  assert.equal(matched.matched, 'https://localhost:4317/callback');
});

test('protocol_v8_deprecation: record / counts / plan / transport / features', async () => {
  const tools = createProtocolV116Tools();
  const recorded = await call(tools, 'protocol_v8_deprecation', {
    action: 'record', feature: 'sampling', caller: 'old-client',
  });
  assert.equal(recorded.recorded, true);
  assert.match(recorded.warning.message, /Deprecated feature "sampling"/);
  const clean = await call(tools, 'protocol_v8_deprecation', {
    action: 'record', feature: 'tools/call', caller: 'anyone',
  });
  assert.equal(clean.recorded, false);
  const counts = await call(tools, 'protocol_v8_deprecation', { action: 'counts' });
  assert.equal(counts.counts.sampling, 1);
  const plan = await call(tools, 'protocol_v8_deprecation', { action: 'plan', feature: 'sampling' });
  assert.equal(plan.plan.feature, 'sampling');
  assert.ok(plan.plan.steps.length >= 2);
  const transport = await call(tools, 'protocol_v8_deprecation', { action: 'transport', transport: 'http-sse' });
  assert.equal(transport.check.allowed, true);
  assert.equal(transport.check.preferred, false);
  assert.match(transport.check.warning, /deprecated/);
  const features = await call(tools, 'protocol_v8_deprecation', { action: 'features' });
  assert.equal(features.features.length, 6);
  const report = await call(tools, 'protocol_v8_deprecation', { action: 'report' });
  assert.equal(report.report.find((r) => r.feature === 'sampling').uses, 1);
});

test('protocol_v8_nanda + server_card: identity, pin, trust, discover, card', async () => {
  const tools = createProtocolV116Tools();
  const created = await call(tools, 'protocol_v8_nanda', {
    action: 'identity-create',
    name: 'tool-bot',
    description: 'A bot for tools tests.',
    endpoints: ['http://127.0.0.1:4317/mcp'],
    capabilities: ['summarize'],
  });
  assert.match(created.id, /^did:openbot:/);
  const verified = await call(tools, 'protocol_v8_nanda', {
    action: 'identity-verify', document: created.document,
  });
  assert.equal(verified.valid, true);
  const untrusted = await call(tools, 'protocol_v8_nanda', {
    action: 'trust-check', document: created.document,
  });
  assert.equal(untrusted.trusted, false);
  await call(tools, 'protocol_v8_nanda', {
    action: 'pin', fingerprint: created.fingerprint, note: 'test pin',
  });
  const trusted = await call(tools, 'protocol_v8_nanda', {
    action: 'trust-check', document: created.document,
  });
  assert.equal(trusted.trusted, true);
  const announced = await call(tools, 'protocol_v8_nanda', {
    action: 'announce-document', document: created.document, tenant: 'default',
  });
  assert.equal(announced.entry.name, 'tool-bot');
  const found = await call(tools, 'protocol_v8_nanda', {
    action: 'discover-capability', capabilities: ['summarize'],
  });
  assert.equal(found.entries.length, 1);
  const card = await call(tools, 'protocol_v8_server_card', {
    action: 'build', id: created.id, extensions: ['io.modelcontextprotocol/tasks'],
  });
  assert.equal(card.card.name, 'tool-bot');
  assert.equal(card.card.identityId, created.id);
  const cardValid = await call(tools, 'protocol_v8_server_card', { action: 'validate', card: card.card });
  assert.equal(cardValid.valid, true);
  await call(tools, 'protocol_v8_nanda', { action: 'revoke', fingerprint: created.fingerprint, reason: 'test' });
  const revoked = await call(tools, 'protocol_v8_nanda', {
    action: 'trust-check', document: created.document,
  });
  assert.equal(revoked.trusted, false);
});

test('protocol_v8_skills: register / list / body / read / search / unregister', async () => {
  const tools = createProtocolV116Tools();
  const pack = {
    name: 'summarize-doc',
    version: '1.0.0',
    description: 'Summarize a document.',
    body: '# summarize-doc\n\nReturn three bullets.',
    assets: [{ path: 'templates/b.md', content: '- x\n', mimeType: 'text/markdown' }],
  };
  const reg = await call(tools, 'protocol_v8_skills', { action: 'register', pack });
  assert.equal(reg.metadata.name, 'summarize-doc');
  const list = await call(tools, 'protocol_v8_skills', { action: 'list' });
  assert.equal(list.count, 1);
  assert.equal(list.skills[0].body, undefined);
  const body = await call(tools, 'protocol_v8_skills', { action: 'body', name: 'summarize-doc' });
  assert.match(body.body, /three bullets/);
  const read = await call(tools, 'protocol_v8_skills', { action: 'read', uri: 'skill://summarize-doc/assets/templates/b.md' });
  assert.equal(read.text, '- x\n');
  const found = await call(tools, 'protocol_v8_skills', { action: 'search', query: 'summarize' });
  assert.equal(found.skills.length, 1);
  const uris = await call(tools, 'protocol_v8_skills', { action: 'uris' });
  assert.equal(uris.uris.length, 3);
  const removed = await call(tools, 'protocol_v8_skills', { action: 'unregister', name: 'summarize-doc' });
  assert.equal(removed.unregistered, true);
  const bad = await tools.find((t) => t.definition.name === 'protocol_v8_skills').execute({
    action: 'register', pack: { ...pack, name: 'Bad' },
  });
  assert.match(bad, /^Error: Invalid skill pack/);
});
