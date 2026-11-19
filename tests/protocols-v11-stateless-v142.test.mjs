/**
 * Tests for v1.42 (Team T2) — protocols v11 stateless core:
 * packages/core/src/protocols/v11/statelessV11.ts
 *
 * Covers:
 *  - _meta build/validate (version required, must be 2026-07-28,
 *    all capability flags required booleans, trace id shape)
 *  - routing headers (build / wire / parse, missing id rejected,
 *    wrong version rejected)
 *  - cacheable lists (stable hash regardless of input order,
 *    listVersion bumps when a tool is added, known-hash ->
 *    notModified, client cache hit/stale/invalidate)
 *  - server dispatch: discover, tools/list, tools/call,
 *    resources/prompts list; initialize refused, session id
 *    header refused, sampling/roots/logging refused, bad _meta
 *    refused, unknown tool refused
 *  - client: discover-first enforced, list caching (second list
 *    returns cached entries when the server says notModified),
 *    routing headers carried on every request
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/protocols-v11-stateless-v142.test.mjs
 *
 * No network, no model.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  McpV11ListCache,
  McpV11StatelessClient,
  McpV11StatelessServer,
  buildMcpV11RequestMeta,
  buildMcpV11RoutingHeaders,
  createLoopbackMcpV11Sender,
  hashMcpV11List,
  mcpV11OffersApps,
  mcpV11OffersTasks,
  mcpV11RoutingHeadersToWire,
  parseMcpV11RoutingHeaders,
  validateMcpV11DiscoverResult,
  validateMcpV11RequestMeta,
} from '../packages/core/dist/index.js';

function demoServer() {
  return new McpV11StatelessServer({
    tools: [
      { name: 'echo', description: 'Echo.', handler: (args) => ({ echoed: args }) },
      {
        name: 'add',
        description: 'Add.',
        handler: (args) => ({ sum: (args.a ?? 0) + (args.b ?? 0) }),
      },
    ],
    resources: [{ name: 'config', description: 'Config.' }],
    prompts: [{ name: 'greet', description: 'Greet.' }],
  });
}

test('meta: build produces a valid 2026-07-28 meta with all capabilities', () => {
  const meta = buildMcpV11RequestMeta();
  assert.equal(meta.protocolVersion, '2026-07-28');
  assert.deepEqual(validateMcpV11RequestMeta(meta), []);
  assert.deepEqual(meta.capabilities, {
    multiRoundTrip: true,
    tasks: true,
    apps: true,
    cacheableLists: true,
    routing: true,
  });
});

test('meta: validation rejects missing version, wrong version, missing flags, bad trace', () => {
  assert.ok(validateMcpV11RequestMeta(null).length > 0);
  assert.ok(validateMcpV11RequestMeta({}).some((p) => p.includes('protocolVersion')));
  assert.ok(validateMcpV11RequestMeta({ protocolVersion: '2025-11-25', capabilities: {} }).some((p) => p.includes('2026-07-28')));
  const partial = buildMcpV11RequestMeta();
  delete partial.capabilities.routing;
  assert.ok(validateMcpV11RequestMeta(partial).some((p) => p.includes('routing')));
  const badTrace = buildMcpV11RequestMeta({}, { traceId: 'not-hex' });
  assert.ok(validateMcpV11RequestMeta(badTrace).some((p) => p.includes('traceId')));
  const goodTrace = buildMcpV11RequestMeta({}, { traceId: 'a'.repeat(32) });
  assert.deepEqual(validateMcpV11RequestMeta(goodTrace), []);
});

test('routing headers: build -> wire -> parse round-trips; missing id / wrong version rejected', () => {
  const headers = buildMcpV11RoutingHeaders({ routingKey: 'route:alpha', targetServer: 'alpha' });
  assert.equal(headers.protocolVersion, '2026-07-28');
  assert.ok(headers.requestId.length > 0);
  const wire = mcpV11RoutingHeadersToWire(headers);
  assert.equal(wire['mcp-routing-key'], 'route:alpha');
  assert.equal(wire['mcp-target-server'], 'alpha');
  const parsed = parseMcpV11RoutingHeaders(wire);
  assert.deepEqual(parsed.problems, []);
  assert.equal(parsed.headers.requestId, headers.requestId);
  assert.deepEqual(parseMcpV11RoutingHeaders({}).problems.length > 0, true);
  assert.ok(parseMcpV11RoutingHeaders({ 'mcp-request-id': 'x', 'mcp-protocol-version': '2025-11-25' }).problems.some((p) => p.includes('2026-07-28')));
});

test('cacheable lists: hash is order-independent; listVersion bumps on register/remove', async () => {
  const server = demoServer();
  const a = hashMcpV11List([{ name: 'b' }, { name: 'a' }]);
  const b = hashMcpV11List([{ name: 'a' }, { name: 'b' }]);
  assert.equal(a, b);
  const meta = buildMcpV11RequestMeta();
  const first = await server.dispatch({ jsonrpc: '2.0', method: 'tools/list', params: { _meta: meta }, id: 1 });
  assert.equal(first.result.notModified, false);
  const v1 = first.result.listVersion;
  const hash1 = first.result.listHash;
  // Same hash -> notModified.
  const cached = await server.dispatch({ jsonrpc: '2.0', method: 'tools/list', params: { _meta: meta, knownListHash: hash1 }, id: 2 });
  assert.equal(cached.result.notModified, true);
  assert.equal(cached.result.listVersion, v1);
  // Register a tool -> version bumps, hash changes, old hash no longer matches.
  server.registerTool({ name: 'sub', description: 'Sub.', handler: () => ({}) });
  const second = await server.dispatch({ jsonrpc: '2.0', method: 'tools/list', params: { _meta: meta, knownListHash: hash1 }, id: 3 });
  assert.equal(second.result.notModified, false);
  assert.ok(second.result.listVersion > v1);
  assert.notEqual(second.result.listHash, hash1);
  assert.equal(second.result.entries.length, 3);
});

test('list cache: hit, stale after TTL, invalidate', async () => {
  const cache = new McpV11ListCache(50);
  assert.deepEqual(cache.get('tools'), { hit: false, stale: false });
  cache.put('tools', { notModified: false, entries: [{ name: 'echo' }], listHash: 'abcd1234', listVersion: 1 });
  const hit = cache.get('tools');
  assert.equal(hit.hit, true);
  assert.equal(hit.stale, false);
  assert.equal(hit.listHash, 'abcd1234');
  assert.deepEqual(cache.kinds(), ['tools']);
  await new Promise((r) => setTimeout(r, 70));
  assert.equal(cache.get('tools').stale, true);
  cache.invalidate('tools');
  assert.equal(cache.get('tools').hit, false);
  // notModified results never overwrite the cache.
  cache.put('tools', { notModified: true, listHash: 'abcd1234', listVersion: 1 });
  assert.equal(cache.get('tools').hit, false);
});

test('server dispatch: discover is valid and offers tasks + apps extensions', async () => {
  const server = demoServer();
  const res = await server.dispatch({ jsonrpc: '2.0', method: 'server/discover', params: {}, id: 1 });
  assert.equal(res.error, undefined);
  assert.deepEqual(validateMcpV11DiscoverResult(res.result), []);
  assert.equal(res.result.protocolVersion, '2026-07-28');
  assert.ok(mcpV11OffersTasks(res.result));
  assert.ok(mcpV11OffersApps(res.result));
  assert.deepEqual(res.result.cacheableLists, ['tools', 'resources', 'prompts']);
});

test('server dispatch: initialize refused, session id refused, deprecated callbacks refused', async () => {
  const server = demoServer();
  const meta = buildMcpV11RequestMeta();
  for (const method of ['initialize', 'notifications/initialized']) {
    const res = await server.dispatch({ jsonrpc: '2.0', method, params: { _meta: meta }, id: 1 });
    assert.ok(res.error, method);
    assert.equal(res.error.data.code, 'session-only-method');
    assert.equal(res.error.data.use, 'server/discover');
  }
  const sessionRes = await server.dispatch(
    { jsonrpc: '2.0', method: 'tools/list', params: { _meta: meta }, id: 1 },
    { 'mcp-session-id': 'sess-123' },
  );
  assert.ok(sessionRes.error);
  assert.equal(sessionRes.error.data.code, 'session-id-refused');
  for (const method of ['sampling/createMessage', 'roots/list', 'logging/setLevel']) {
    const res = await server.dispatch({ jsonrpc: '2.0', method, params: { _meta: meta }, id: 1 });
    assert.ok(res.error, method);
    assert.equal(res.error.data.code, 'deprecated-callback');
    assert.equal(res.error.data.earliestRemoval, '2027-07-28');
  }
});

test('server dispatch: bad _meta refused, unknown tool refused, tool errors surfaced', async () => {
  const server = demoServer();
  const noMeta = await server.dispatch({ jsonrpc: '2.0', method: 'tools/list', params: {}, id: 1 });
  assert.ok(noMeta.error);
  assert.equal(noMeta.error.data.code, 'invalid-meta');
  const badMeta = await server.dispatch({
    jsonrpc: '2.0',
    method: 'tools/list',
    params: { _meta: { protocolVersion: '2025-11-25', capabilities: {} } },
    id: 1,
  });
  assert.ok(badMeta.error);
  const meta = buildMcpV11RequestMeta();
  const unknown = await server.dispatch({ jsonrpc: '2.0', method: 'tools/call', params: { _meta: meta, name: 'nope', arguments: {} }, id: 1 });
  assert.ok(unknown.error);
  assert.equal(unknown.error.data.code, 'unknown-tool');
  const unknownMethod = await server.dispatch({ jsonrpc: '2.0', method: 'bogus/method', params: { _meta: meta }, id: 1 });
  assert.equal(unknownMethod.error.code, -32601);
});

test('client: discover-first enforced; list caches across calls; callTool works', async () => {
  const server = demoServer();
  const client = new McpV11StatelessClient(createLoopbackMcpV11Sender(server), {
    clientInfo: { name: 'open-bot-test', version: '1.42.0' },
    targetServer: 'demo',
  });
  await assert.rejects(() => client.listTools(), /discover/);
  await assert.rejects(() => client.callTool('echo'), /discover/);
  const discovered = await client.discover();
  assert.equal(discovered.serverInfo.name, 'open-bot-mcp-v11');
  assert.ok(client.hasExtension('io.modelcontextprotocol/tasks'));
  assert.ok(client.hasExtension('io.modelcontextprotocol/ui'));
  const first = await client.listTools();
  assert.equal(first.notModified, false);
  assert.equal(first.entries.length, 2);
  assert.deepEqual(first.entries.map((e) => e.name), ['add', 'echo']);
  // Second list: client sends the known hash, server says notModified,
  // client serves the cached entries.
  const second = await client.listTools();
  assert.equal(second.notModified, false);
  assert.deepEqual(second.entries.map((e) => e.name), ['add', 'echo']);
  const called = await client.callTool('add', { a: 2, b: 3 });
  assert.equal(called.sum, 5);
  // Routing headers were carried.
  assert.ok(client.lastRoutingHeaders);
  assert.equal(client.lastRoutingHeaders.protocolVersion, '2026-07-28');
  assert.ok(client.lastRoutingHeaders.requestId.length > 0);
  // Server state changed -> cache no longer matches, fresh list arrives.
  server.registerTool({ name: 'zap', description: 'Zap.', handler: () => ({}) });
  client.listCache.invalidate('tools');
  const third = await client.listTools();
  assert.equal(third.entries.length, 3);
});
