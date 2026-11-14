/**
 * Test v1.05 T2: StatelessMcpClient hoàn chỉnh (node:test, không mạng).
 *
 * Covers packages/core/src/mcp/statelessClientFull.ts với fake transport:
 *  - connect mode 'auto': server 2026 → stateless; server pre-2.0
 *    (-32601) → fallback handshake, negotiation ghi đúng
 *  - mode true: stateless-only, không bao giờ handshake
 *  - mode false: handshake thuần
 *  - call() gắn _meta (protocol version + capabilities), không gửi
 *    Mcp-Session-Id (stripSessionIdHeader / buildStatelessHeaders)
 *  - callTool kiểm tra capability từ discovery cache
 *  - call trước connect() ném lỗi rõ ràng; discover() cập nhật cache
 *  - close() nhiều lần an toàn
 *
 * Build core trước:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/mcp-v105-stateless-client.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  StatelessMcpClient,
  buildStatelessHeaders,
  hasNoSessionIdHeader,
  stripSessionIdHeader,
} from '../packages/core/dist/mcp/statelessClientFull.js';

const DISCOVERY_2026 = {
  protocolVersion: '2026-07-28',
  supportedVersions: ['2026-07-28', '2025-11-25'],
  capabilities: {
    tools: {},
    resources: {},
    prompts: {},
    tasks: { extension: 'io.modelcontextprotocol/tasks' },
    apps: { extension: 'io.modelcontextprotocol/apps' },
  },
  serverInfo: { name: 'fake-2026', version: '1.0.0' },
  extensions: ['io.modelcontextprotocol/tasks', 'io.modelcontextprotocol/apps'],
};

/** Fake transport ghi lại mọi call; discover trả theo script. */
function makeTransport(script = {}) {
  const calls = [];
  let closed = false;
  return {
    calls,
    get closed() {
      return closed;
    },
    async requestJsonRpc(method, params) {
      calls.push({ method, params });
      const handler = script[method];
      if (typeof handler === 'function') return handler(calls.length, params);
      if (method === 'server/discover') return structuredClone(DISCOVERY_2026);
      throw new Error(`unexpected method ${method}`);
    },
    async discover() {
      const handler = script['__discover'];
      if (typeof handler === 'function') return handler();
      return structuredClone(DISCOVERY_2026);
    },
    async initialize() {
      const handler = script['__initialize'];
      if (typeof handler === 'function') return handler();
      return { protocolVersion: '2025-11-25' };
    },
    async close() {
      closed = true;
    },
  };
}

test('stateless headers: Mcp-Session-Id never sent (any casing)', () => {
  assert.deepEqual(stripSessionIdHeader(undefined), {});
  assert.deepEqual(stripSessionIdHeader({}), {});
  assert.deepEqual(
    stripSessionIdHeader({
      Authorization: 'Bearer x',
      'Mcp-Session-Id': 'abc',
      'mcp-session-id': 'def',
      'MCP-SESSION-ID': 'ghi',
      'Content-Type': 'application/json',
    }),
    { Authorization: 'Bearer x', 'Content-Type': 'application/json' },
  );
  assert.equal(hasNoSessionIdHeader(undefined), true);
  assert.equal(hasNoSessionIdHeader({ 'Mcp-Session-Id': 'x' }), false);
  assert.equal(hasNoSessionIdHeader({ 'mcp-session-id': 'x' }), false);
  assert.equal(hasNoSessionIdHeader({ Authorization: 'Bearer x' }), true);
  assert.equal(hasNoSessionIdHeader(buildStatelessHeaders({ 'Mcp-Session-Id': 'x' })), true);
});

test('connect auto: server 2026 -> stateless, discovery cached', async () => {
  const transport = makeTransport();
  const client = new StatelessMcpClient(transport, { mode: 'auto' });
  const result = await client.connect();
  assert.equal(result.mode, 'stateless');
  assert.equal(result.protocolVersion, '2026-07-28');
  assert.equal(result.fellBack, false);
  assert.equal(client.isStateless, true);
  assert.equal(client.isHandshakeFallback, false);
  assert.equal(client.discovery?.serverInfo.name, 'fake-2026');
  assert.match(client.describe(), /stateless 2026-07-28/);
  assert.match(client.describe(), /không Mcp-Session-Id/);
  await client.close();
  assert.equal(client.currentState, 'closed');
  assert.equal(transport.closed, true);
});

test('connect auto: server pre-2.0 (discover null) -> fallback handshake', async () => {
  const transport = makeTransport({
    __discover: () => null,
    __initialize: () => ({ protocolVersion: '2025-11-25' }),
  });
  const client = new StatelessMcpClient(transport, { mode: 'auto' });
  const result = await client.connect();
  assert.equal(result.mode, 'handshake');
  assert.equal(result.protocolVersion, '2025-11-25');
  assert.equal(result.fellBack, true);
  assert.equal(client.isStateless, false);
  assert.equal(client.isHandshakeFallback, true);
  assert.match(client.describe(), /fallback/);
  await client.close();
});

test('connect stateless-only: discover null -> still stateless, never handshake', async () => {
  let initializeCalled = false;
  const transport = makeTransport({
    __discover: () => null,
    __initialize: () => {
      initializeCalled = true;
      return { protocolVersion: '2025-11-25' };
    },
  });
  const client = new StatelessMcpClient(transport, { mode: true });
  const result = await client.connect();
  assert.equal(result.mode, 'stateless');
  assert.equal(initializeCalled, false);
  await client.close();
});

test('connect handshake-only: initialize straight away, no discover', async () => {
  let discoverCalled = false;
  const transport = makeTransport({
    __discover: () => {
      discoverCalled = true;
      return null;
    },
    __initialize: () => ({ protocolVersion: '2025-06-18' }),
  });
  const client = new StatelessMcpClient(transport, { mode: false });
  const result = await client.connect();
  assert.equal(result.mode, 'handshake');
  assert.equal(result.protocolVersion, '2025-06-18');
  assert.equal(discoverCalled, false);
  await client.close();
});

test('connect fails when both discover and handshake fail', async () => {
  const transport = makeTransport({
    __discover: () => {
      throw new Error('discover boom');
    },
    __initialize: () => {
      throw new Error('handshake boom');
    },
  });
  const client = new StatelessMcpClient(transport, { mode: 'auto' });
  await assert.rejects(() => client.connect(), /thương lượng kết nối thất bại/);
  assert.equal(client.currentState, 'idle');
});

test('call: stateless mode attaches _meta, handshake mode sends raw params', async () => {
  const transport = makeTransport({
    'tools/call': () => ({ content: [{ type: 'text', text: 'ok' }] }),
  });
  const client = new StatelessMcpClient(transport, { mode: 'auto' });
  await client.connect();
  const out = await client.callTool('echo', { msg: 'hi' });
  assert.deepEqual(out, { content: [{ type: 'text', text: 'ok' }] });
  const call = transport.calls.find((c) => c.method === 'tools/call');
  assert.ok(call);
  const meta = call.params._meta;
  assert.equal(meta.protocolVersion, '2026-07-28');
  assert.equal(meta.clientCapabilities.multiRoundTrip, true);
  assert.equal(meta.clientCapabilities.tasks, true);
  assert.equal(call.params.name, 'echo');
  assert.deepEqual(call.params.arguments, { msg: 'hi' });
  // No session id anywhere in the request.
  assert.equal(JSON.stringify(call.params).includes('Mcp-Session-Id'), false);
  assert.equal(JSON.stringify(call.params).includes('sessionId'), false);
  await client.close();
});

test('callTool: server without tools capability -> clear error before calling', async () => {
  const noToolsDiscovery = {
    ...structuredClone(DISCOVERY_2026),
    capabilities: { resources: {} },
  };
  const transport = makeTransport({ __discover: () => structuredClone(noToolsDiscovery) });
  const client = new StatelessMcpClient(transport, { mode: 'auto' });
  await client.connect();
  await assert.rejects(
    () => client.callTool('echo'),
    /không khai capability "tools"/,
  );
  assert.equal(transport.calls.some((c) => c.method === 'tools/call'), false);
  await client.close();
});

test('call before connect throws; close twice is safe', async () => {
  const transport = makeTransport();
  const client = new StatelessMcpClient(transport, { mode: 'auto' });
  await assert.rejects(() => client.call('tools/list'), /chưa connect/);
  await client.connect();
  await client.close();
  await client.close();
  await assert.rejects(() => client.connect(), /đã đóng/);
});

test('discover() refreshes the cache and negotiates version', async () => {
  let version = '2026-07-28';
  let supported = ['2026-07-28', '2025-11-25'];
  const transport = makeTransport({
    __discover: () => {
      const doc = structuredClone(DISCOVERY_2026);
      doc.protocolVersion = version;
      doc.supportedVersions = [...supported];
      return doc;
    },
  });
  const client = new StatelessMcpClient(transport, { mode: 'auto' });
  await client.connect();
  version = '2025-11-25';
  // Server cũ chỉ còn hỗ trợ 2025-11-25 (không liệt kê 2026 nữa).
  supported = ['2025-11-25'];
  const doc = await client.discover();
  assert.equal(doc?.protocolVersion, '2025-11-25');
  assert.equal(client.negotiatedProtocolVersion, '2025-11-25');
  await client.close();
});

test('callTaskMethod / listTools / listResources / listPrompts use discovery gate', async () => {
  const transport = makeTransport({
    'tasks/get': () => ({ taskId: 't-1', status: 'completed', result: 42 }),
    'tools/list': () => ({ tools: [] }),
    'resources/list': () => ({ resources: [] }),
    'prompts/list': () => ({ prompts: [] }),
  });
  const client = new StatelessMcpClient(transport, { mode: 'auto' });
  await client.connect();
  assert.deepEqual(await client.callTaskMethod('tasks/get', { taskId: 't-1' }), {
    taskId: 't-1',
    status: 'completed',
    result: 42,
  });
  assert.deepEqual(await client.listTools(), { tools: [] });
  assert.deepEqual(await client.listResources(), { resources: [] });
  assert.deepEqual(await client.listPrompts(), { prompts: [] });
  // withMeta does not mutate the caller's params object.
  const params = { name: 'x' };
  const withMeta = client.withMeta(params);
  assert.equal(params._meta, undefined);
  assert.equal(withMeta._meta.protocolVersion, '2026-07-28');
  await client.close();
});
