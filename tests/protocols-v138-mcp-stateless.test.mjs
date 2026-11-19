/**
 * Protocols v7 — MCP stateless HTTP transport tests (v1.38, Team T2).
 *
 * Covers packages/core/src/protocolsV7/mcpStatelessV7.ts:
 * self-describing requests (missing _meta refused), session-only
 * methods refused, tools/resources/prompts dispatch, per-request
 * auth, statelessness proof (identical results, zero sessions),
 * client over the loopback sender, batch handling.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/protocols-v138-mcp-stateless.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  McpV7StatelessClient,
  McpV7StatelessServer,
  buildMcpV7Request,
  checkMcpV7Stateless,
  createLoopbackMcpV7Sender,
  mcpV7StatelessMethods,
  requireMcpV7SelfDescribing,
} from '../packages/core/dist/index.js';

const META = { protocolVersion: '2026-07-28', clientName: 'test', tenant: 'default' };

function makeServer(options = {}) {
  const server = new McpV7StatelessServer(options);
  server.registerTool(
    { name: 'add', description: 'Adds two numbers.', inputSchema: { type: 'object', properties: { a: {}, b: {} }, required: ['a', 'b'] } },
    (args) => ({
      content: [{ type: 'text', text: String(Number(args.a) + Number(args.b)) }],
      isError: false,
      structuredContent: { sum: Number(args.a) + Number(args.b) },
    }),
  );
  server.registerTool(
    { name: 'whoami', description: 'Reports the request tenant.', inputSchema: { type: 'object', properties: {} } },
    (_args, ctx) => ({
      content: [{ type: 'text', text: ctx.tenant }],
      isError: false,
      structuredContent: { tenant: ctx.tenant, requestId: ctx.requestId },
    }),
  );
  server.registerResource(
    { uri: 'demo://greeting', name: 'greeting', mimeType: 'text/plain' },
    (uri) => ({ contents: [{ uri, mimeType: 'text/plain', text: 'hello from the stateless server' }] }),
  );
  server.registerPrompt(
    { name: 'summarize', description: 'Summarize prompt.', arguments: [{ name: 'text', required: true }] },
    (args) => ({ messages: [{ role: 'user', content: { type: 'text', text: `Summarize: ${args.text}` } }] }),
  );
  return server;
}

test('method surface: stateless methods only, no initialize', () => {
  assert.deepEqual([...mcpV7StatelessMethods()].sort(), [
    'ping', 'prompts/get', 'prompts/list', 'resources/list', 'resources/read', 'tools/call', 'tools/list',
  ]);
});

test('self-describing check: missing _meta / missing version / wrong version refused', () => {
  const server = makeServer();
  assert.throws(
    () => requireMcpV7SelfDescribing({ jsonrpc: '2.0', id: 1, method: 'ping', params: {} }, ['2026-07-28']),
    /must carry _meta/,
  );
  assert.throws(
    () => requireMcpV7SelfDescribing({ jsonrpc: '2.0', id: 1, method: 'ping', params: { _meta: {} } }, ['2026-07-28']),
    /protocolVersion is required/,
  );
  assert.throws(
    () => requireMcpV7SelfDescribing({ jsonrpc: '2.0', id: 1, method: 'ping', params: { _meta: { protocolVersion: '1999-01-01' } } }, ['2026-07-28']),
    /Unsupported MCP protocol version/,
  );
  const meta = requireMcpV7SelfDescribing(buildMcpV7Request('ping', {}, META), ['2026-07-28']);
  assert.equal(meta.protocolVersion, '2026-07-28');
  assert.equal(server.sessionCount(), 0);
});

test('server: ping / tools list+call / resources / prompts over self-describing requests', async () => {
  const server = makeServer();
  const ping = await server.handle(buildMcpV7Request('ping', {}, META));
  assert.equal(ping.result.ok, true);
  assert.equal(ping.result.protocolVersion, '2026-07-28');
  const tools = await server.handle(buildMcpV7Request('tools/list', {}, META));
  assert.deepEqual(tools.result.tools.map((t) => t.name).sort(), ['add', 'whoami']);
  const sum = await server.handle(buildMcpV7Request('tools/call', { name: 'add', arguments: { a: 2, b: 3 } }, META));
  assert.equal(sum.result.structuredContent.sum, 5);
  assert.equal(sum.result.isError, false);
  const whoami = await server.handle(buildMcpV7Request('tools/call', { name: 'whoami', arguments: {} }, { ...META, tenant: 'acme' }));
  assert.equal(whoami.result.structuredContent.tenant, 'acme');
  const resources = await server.handle(buildMcpV7Request('resources/list', {}, META));
  assert.equal(resources.result.resources[0].uri, 'demo://greeting');
  const read = await server.handle(buildMcpV7Request('resources/read', { uri: 'demo://greeting' }, META));
  assert.match(read.result.contents[0].text, /hello from the stateless server/);
  const prompts = await server.handle(buildMcpV7Request('prompts/list', {}, META));
  assert.equal(prompts.result.prompts[0].name, 'summarize');
  const prompt = await server.handle(buildMcpV7Request('prompts/get', { name: 'summarize', arguments: { text: 'a long doc' } }, META));
  assert.match(prompt.result.messages[0].content.text, /Summarize: a long doc/);
  assert.equal(server.handledCount(), 8);
  assert.equal(server.sessionCount(), 0);
});

test('server: missing _meta refused, initialize refused, unknown tool/method refused', async () => {
  const server = makeServer();
  const noMeta = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
  assert.ok('error' in noMeta);
  assert.equal(noMeta.error.code, -32005);
  const init = await server.handle(buildMcpV7Request('initialize', {}, META));
  assert.ok('error' in init);
  assert.equal(init.error.code, -32006);
  assert.match(init.error.message, /stateless/);
  const init2 = await server.handle(buildMcpV7Request('notifications/initialized', {}, META));
  assert.equal(init2.error.code, -32006);
  const noTool = await server.handle(buildMcpV7Request('tools/call', { name: 'nope', arguments: {} }, META));
  assert.equal(noTool.error.code, -32002);
  const missingArg = await server.handle(buildMcpV7Request('tools/call', { name: 'add', arguments: { a: 1 } }, META));
  assert.equal(missingArg.error.code, -32602);
  const noMethod = await server.handle(buildMcpV7Request('sampling/createMessage', {}, META));
  assert.equal(noMethod.error.code, -32601);
  const malformed = await server.handle({ jsonrpc: '1.0', id: 9, method: 'ping' });
  assert.equal(malformed.error.code, -32600);
});

test('server: per-tenant auth; every request carries its own auth', async () => {
  const server = makeServer({ tenantTokens: { acme: 'tok-acme' } });
  const noAuth = await server.handle(buildMcpV7Request('tools/list', {}, { ...META, tenant: 'acme' }));
  assert.equal(noAuth.error.code, -32001);
  const badAuth = await server.handle(
    buildMcpV7Request('tools/list', {}, { ...META, tenant: 'acme' }), 'Bearer wrong',
  );
  assert.equal(badAuth.error.code, -32001);
  const ok = await server.handle(
    buildMcpV7Request('tools/list', {}, { ...META, tenant: 'acme' }), 'Bearer tok-acme',
  );
  assert.ok(!('error' in ok));
  // Other tenants need no auth (no token configured for them).
  const open = await server.handle(buildMcpV7Request('tools/list', {}, META));
  assert.ok(!('error' in open));
});

test('statelessness proof: identical requests, identical results, zero sessions', async () => {
  const server = makeServer();
  const request = buildMcpV7Request('tools/call', { name: 'add', arguments: { a: 10, b: 20 } }, META, 'fixed-id');
  const check = await checkMcpV7Stateless(server, request);
  assert.equal(check.stateless, true);
  assert.equal(check.sessions, 0);
  assert.equal(check.identical, true);
  // A stateful-looking server (session count > 0) would fail the proof.
  const lying = makeServer();
  lying.sessionCount = () => 3;
  const bad = await checkMcpV7Stateless(lying, request);
  assert.equal(bad.stateless, false);
});

test('client over loopback: every call builds a fresh self-describing request', async () => {
  const server = makeServer();
  const client = new McpV7StatelessClient(createLoopbackMcpV7Sender(server), { tenant: 'acme' });
  assert.equal((await client.ping()).tenant, 'acme');
  assert.equal((await client.listTools()).tools.length, 2);
  assert.equal((await client.callTool('add', { a: 7, b: 8 })).structuredContent.sum, 15);
  assert.equal((await client.listResources()).resources.length, 1);
  assert.equal((await client.readResource('demo://greeting')).contents[0].text, 'hello from the stateless server');
  assert.equal((await client.listPrompts()).prompts.length, 1);
  assert.equal((await client.getPrompt('summarize', { text: 'x' })).messages[0].content.text, 'Summarize: x');
  await assert.rejects(() => client.callTool('nope'), /not registered/);
  // Two identical client calls give identical results (no hidden state).
  const first = await client.callTool('add', { a: 1, b: 2 });
  const second = await client.callTool('add', { a: 1, b: 2 });
  assert.deepEqual(first, second);
  // Each request gets a fresh request id.
  assert.notEqual(client.meta().requestId, client.meta().requestId);
});

test('server: batch handling answers each request independently', async () => {
  const server = makeServer();
  const out = await server.handleBatch([
    buildMcpV7Request('ping', {}, META),
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    buildMcpV7Request('tools/call', { name: 'add', arguments: { a: 1, b: 1 } }, META),
  ]);
  assert.equal(out.length, 3);
  assert.ok(!('error' in out[0]));
  assert.ok('error' in out[1]);
  assert.equal(out[2].result.structuredContent.sum, 2);
});

test('server: oversized arguments refused; register/unregister tools', async () => {
  const server = makeServer({ maxArgsBytes: 64 });
  const big = await server.handle(buildMcpV7Request('tools/call', {
    name: 'add',
    arguments: { a: 1, b: 'x'.repeat(200) },
  }, META));
  assert.equal(big.error.code, -32602);
  assert.match(big.error.message, /bytes/);
  assert.deepEqual(server.toolNames(), ['add', 'whoami']);
  assert.equal(server.unregisterTool('add'), true);
  assert.equal(server.unregisterTool('add'), false);
  assert.deepEqual(server.toolNames(), ['whoami']);
  assert.deepEqual(server.resourceUris(), ['demo://greeting']);
  assert.deepEqual(server.promptNames(), ['summarize']);
});
