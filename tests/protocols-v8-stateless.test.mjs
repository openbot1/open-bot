/**
 * Tests for v1.39 (Team T2) — protocols v8 stateless core + legacy adapter:
 * packages/core/src/protocolsV8/mcpStatelessV8.ts
 *
 * Covers:
 *  - server/discover document (version, capabilities, extensions,
 *    deprecations, transports, matrix)
 *  - self-describing requests (missing _meta refused, bad version refused)
 *  - session-only methods refused on the stateless transport
 *  - per-request extension negotiation (UI hidden without the ui
 *    extension, shown with it; ping echoes negotiated extensions)
 *  - tools/resources/prompts dispatch + per-request auth + arg size
 *  - statelessness proof (identical results, zero sessions) + batch
 *  - legacy session adapter: initialize (with deprecation warning),
 *    calls through a session, unknown session refused, close,
 *    stateless server underneath still holds zero sessions
 *  - client over the loopback sender (discover first, then tools)
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/protocols-v8-stateless.test.mjs
 *
 * No network, no model.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  McpV8LegacySessionAdapter,
  McpV8StatelessClient,
  McpV8StatelessServer,
  buildMcpV8Request,
  checkMcpV8Stateless,
  createLoopbackMcpV8Sender,
  mcpV8RequestedExtensions,
  mcpV8StatelessMethods,
  requireMcpV8SelfDescribing,
  MCP_V8_LEGACY_SESSION_WARNING,
} from '../packages/core/dist/index.js';

const META = { protocolVersion: '2026-07-28', clientName: 'test', tenant: 'default' };
const UI_EXT = 'io.modelcontextprotocol/ui';
const TASK_EXT = 'io.modelcontextprotocol/tasks';

function makeServer(options = {}) {
  const server = new McpV8StatelessServer(options);
  server.registerTool(
    { name: 'add', description: 'Adds two numbers.', inputSchema: { type: 'object', properties: { a: {}, b: {} }, required: ['a', 'b'] } },
    (args) => ({
      content: [{ type: 'text', text: String(Number(args.a) + Number(args.b)) }],
      isError: false,
      structuredContent: { sum: Number(args.a) + Number(args.b) },
    }),
  );
  server.registerTool(
    {
      name: 'card',
      description: 'A tool with UI.',
      inputSchema: { type: 'object', properties: {} },
      ui: { resourceUri: 'ui://card/main' },
    },
    () => ({ content: [{ type: 'text', text: 'card' }], isError: false }),
  );
  server.registerResource(
    { uri: 'demo://greeting', name: 'greeting', mimeType: 'text/plain' },
    (uri) => ({ contents: [{ uri, mimeType: 'text/plain', text: 'hello from the v8 stateless server' }] }),
  );
  server.registerPrompt(
    { name: 'summarize', description: 'Summarize prompt.', arguments: [{ name: 'text', required: true }] },
    (args) => ({ messages: [{ role: 'user', content: { type: 'text', text: `Summarize: ${args.text}` } }] }),
  );
  return server;
}

test('method surface: server/discover first, no initialize', () => {
  assert.deepEqual([...mcpV8StatelessMethods()].sort(), [
    'ping', 'prompts/get', 'prompts/list', 'resources/list', 'resources/read',
    'server/discover', 'tools/call', 'tools/list',
  ]);
});

test('server/discover: version + capabilities + extensions + deprecations + transports', async () => {
  const server = makeServer();
  const res = await server.handle(buildMcpV8Request('server/discover', {}, { ...META, extensions: [TASK_EXT] }));
  assert.ok(!('error' in res));
  const doc = res.result;
  assert.equal(doc.protocolVersion, '2026-07-28');
  assert.equal(doc.serverInfo.name, 'open-bot');
  assert.equal(doc.capabilities.mcpStatelessHttp, true);
  assert.equal(doc.capabilities.mcpDiscover, true);
  assert.equal(doc.extensions.length, 6);
  assert.deepEqual(doc.negotiatedExtensions, [TASK_EXT]);
  assert.equal(doc.deprecations.length, 6);
  assert.ok(doc.deprecations.some((d) => d.feature === 'sampling'));
  assert.deepEqual(doc.transports, ['streamable-http', 'stdio', 'http-sse']);
  assert.match(doc.matrix, /mcp 2026-07-28/);
  assert.equal(server.discoverCount(), 1);
  assert.equal(server.handledCount(), 1);
});

test('self-describing: missing _meta refused, bad version refused, session-only refused', async () => {
  const server = makeServer();
  const noMeta = await server.handle({ jsonrpc: '2.0', id: 1, method: 'ping', params: {} });
  assert.ok('error' in noMeta);
  assert.equal(noMeta.error.code, -32005);
  const badVersion = await server.handle(
    buildMcpV8Request('ping', {}, { ...META, protocolVersion: '1999-01-01' }),
  );
  assert.ok('error' in badVersion);
  assert.match(badVersion.error.message, /Unsupported MCP protocol version/);
  const init = await server.handle(
    buildMcpV8Request('initialize', { protocolVersion: '2026-07-28' }, META),
  );
  assert.ok('error' in init);
  assert.equal(init.error.code, -32006);
  assert.match(init.error.message, /needs a session/);
  const badShape = await server.handle({ jsonrpc: '1.0', id: 2, method: 'ping' });
  assert.ok('error' in badShape);
  assert.equal(badShape.error.code, -32600);
  const unknown = await server.handle(buildMcpV8Request('nope/method', {}, META));
  assert.ok('error' in unknown);
  assert.equal(unknown.error.code, -32601);
});

test('requireMcpV8SelfDescribing + mcpV8RequestedExtensions merge _meta fields', () => {
  const req = buildMcpV8Request('ping', {}, {
    ...META,
    extensions: [TASK_EXT],
    capabilities: { extensions: [UI_EXT], statelessHttp: true },
  });
  const meta = requireMcpV8SelfDescribing(req, ['2026-07-28']);
  assert.equal(meta.protocolVersion, '2026-07-28');
  assert.deepEqual(mcpV8RequestedExtensions(meta), [TASK_EXT, UI_EXT]);
  assert.throws(
    () => requireMcpV8SelfDescribing({ jsonrpc: '2.0', id: 1, method: 'ping', params: {} }, ['2026-07-28']),
    /must carry _meta/,
  );
});

test('per-request extension negotiation: UI hidden without ui extension, shown with it', async () => {
  const server = makeServer();
  const client = new McpV8StatelessClient(createLoopbackMcpV8Sender(server), { extensions: [] });
  const plain = await client.listTools();
  const cardPlain = plain.tools.find((t) => t.name === 'card');
  assert.equal(cardPlain?.ui, undefined);
  const pingPlain = await client.ping();
  assert.deepEqual(pingPlain.extensions, []);

  const uiClient = new McpV8StatelessClient(createLoopbackMcpV8Sender(server), { extensions: [UI_EXT] });
  const withUi = await uiClient.listTools();
  const cardUi = withUi.tools.find((t) => t.name === 'card');
  assert.equal(cardUi?.ui?.resourceUri, 'ui://card/main');
  const pingUi = await uiClient.ping();
  assert.deepEqual(pingUi.extensions, [UI_EXT]);

  // Two clients, same server, different negotiations: extensions are per-request, never stored.
  assert.equal(server.sessionCount(), 0);
  assert.deepEqual(server.uiToolNames(), ['card']);
});

test('tools/resources/prompts dispatch, auth, arg validation, batch', async () => {
  const server = makeServer({ tenantTokens: { team: 'secret-token' } });
  const client = new McpV8StatelessClient(createLoopbackMcpV8Sender(server), { tenant: 'team', bearerToken: 'secret-token' });
  const sum = await client.callTool('add', { a: 2, b: 3 });
  assert.equal(sum.structuredContent.sum, 5);
  assert.equal(sum.isError, false);
  const res = await client.readResource('demo://greeting');
  assert.equal(res.contents[0].text, 'hello from the v8 stateless server');
  const prompt = await client.getPrompt('summarize', { text: 'hello' });
  assert.match(prompt.messages[0].content.text, /Summarize: hello/);

  // Missing required arg is a transport error, not a throw.
  const bad = await server.handle(
    buildMcpV8Request('tools/call', { name: 'add', arguments: { a: 1 } }, { ...META, tenant: 'team' }),
    'Bearer secret-token',
  );
  assert.ok('error' in bad);
  assert.match(bad.error.message, /needs argument "b"/);

  // Wrong tenant token is refused.
  const unauth = await server.handle(
    buildMcpV8Request('ping', {}, { ...META, tenant: 'team' }),
    'Bearer wrong-token',
  );
  assert.ok('error' in unauth);
  assert.equal(unauth.error.code, -32001);

  // Unknown tool / resource / prompt.
  const noTool = await server.handle(buildMcpV8Request('tools/call', { name: 'nope', arguments: {} }, META));
  assert.ok('error' in noTool);
  assert.equal(noTool.error.code, -32002);

  // Batch: each request answered independently.
  const batch = await server.handleBatch([
    buildMcpV8Request('ping', {}, META, 'b1'),
    buildMcpV8Request('tools/call', { name: 'add', arguments: { a: 1, b: 2 } }, META, 'b2'),
    { jsonrpc: '2.0', id: 'b3', method: 'initialize', params: {} },
  ]);
  assert.equal(batch.length, 3);
  assert.ok(!('error' in batch[0]));
  assert.equal(batch[1].result.structuredContent.sum, 3);
  assert.ok('error' in batch[2]);
});

test('tool with non-ui:// UI declaration is refused at registration', () => {
  const server = new McpV8StatelessServer();
  assert.throws(
    () => server.registerTool(
      { name: 'bad', description: 'x', inputSchema: { type: 'object' }, ui: { resourceUri: 'https://example.com/ui' } },
      () => ({ content: [], isError: false }),
    ),
    /must point at a ui:\/\//,
  );
});

test('statelessness proof: identical results, zero sessions', async () => {
  const server = makeServer();
  const req = buildMcpV8Request('tools/call', { name: 'add', arguments: { a: 4, b: 5 } }, { ...META, requestId: 'fixed-1' });
  const proof = await checkMcpV8Stateless(server, req);
  assert.equal(proof.stateless, true);
  assert.equal(proof.sessions, 0);
  assert.equal(proof.identical, true);
});

test('legacy adapter: initialize warns, calls run through the session, unknown session refused', async () => {
  const server = makeServer();
  const adapter = new McpV8LegacySessionAdapter(server);
  assert.equal(adapter.sessionCount(), 0);
  assert.equal(adapter.statelessServer().sessionCount(), 0);

  const init = await adapter.handleLegacy({
    jsonrpc: '2.0', id: 'i1', method: 'initialize',
    params: { protocolVersion: '2026-07-28', clientInfo: { name: 'old-client', version: '0.9' } },
  });
  assert.ok(!('error' in init));
  assert.equal(init.result.deprecated, true);
  assert.equal(init.result.warning, MCP_V8_LEGACY_SESSION_WARNING);
  const sessionId = init.result.sessionId;
  assert.equal(typeof sessionId, 'string');
  assert.equal(adapter.sessionCount(), 1);
  const session = adapter.getSession(sessionId);
  assert.equal(session?.clientName, 'old-client');
  assert.equal(session?.deprecationWarning, MCP_V8_LEGACY_SESSION_WARNING);

  const notified = await adapter.handleLegacy({ jsonrpc: '2.0', id: 'i2', method: 'notifications/initialized', params: {} });
  assert.ok(!('error' in notified));

  const call = await adapter.handleLegacy({
    jsonrpc: '2.0', id: 'i3', method: 'tools/call',
    params: { name: 'add', arguments: { a: 10, b: 20 }, _sessionId: sessionId },
  });
  assert.ok(!('error' in call));
  assert.equal(call.result.structuredContent.sum, 30);
  assert.equal(adapter.getSession(sessionId)?.requests, 1);

  // Unknown session id is refused (and counted).
  const refused = await adapter.handleLegacy({
    jsonrpc: '2.0', id: 'i4', method: 'ping',
    params: { _sessionId: 'no-such-session' },
  });
  assert.ok('error' in refused);
  assert.equal(refused.error.code, -32006);
  assert.equal(adapter.refusedCount(), 1);

  // The wrapped stateless server still holds zero sessions.
  assert.equal(server.sessionCount(), 0);

  assert.equal(adapter.closeSession(sessionId), true);
  assert.equal(adapter.sessionCount(), 0);
  assert.equal(adapter.closeSession(sessionId), false);
  assert.equal(adapter.closeAllSessions(), 0);

  // Max sessions: oldest evicted first.
  const small = new McpV8LegacySessionAdapter(makeServer(), { maxSessions: 2 });
  const ids = [];
  for (let i = 0; i < 3; i += 1) {
    const r = await small.handleLegacy({
      jsonrpc: '2.0', id: `m${i}`, method: 'initialize',
      params: { protocolVersion: '2026-07-28', clientInfo: { name: `c${i}` } },
    });
    ids.push(r.result.sessionId);
  }
  assert.equal(small.sessionCount(), 2);
  assert.equal(small.getSession(ids[0]), undefined);
  assert.notEqual(small.getSession(ids[2]), undefined);
});

test('client discover() caches the document; ping stamps capabilities', async () => {
  const server = makeServer();
  const client = new McpV8StatelessClient(createLoopbackMcpV8Sender(server), {
    extensions: [TASK_EXT],
    mcpTasks: true,
  });
  assert.equal(client.discovered(), undefined);
  const doc = await client.discover();
  assert.equal(doc.protocolVersion, '2026-07-28');
  assert.deepEqual(doc.negotiatedExtensions, [TASK_EXT]);
  assert.equal(client.discovered()?.protocolVersion, '2026-07-28');
  const meta = client.meta();
  assert.equal(meta.capabilities?.mcpTasks, true);
  assert.deepEqual(meta.extensions, [TASK_EXT]);
});
