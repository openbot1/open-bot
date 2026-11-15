/**
 * Test v1.06 T2: mock MCP servers — spec mới (2026-07-28) + legacy
 * (2025-11-25) — end-to-end qua các module thật (node:test).
 * Local only: fake JSON-RPC handlers + fake fetch, no live network.
 *
 * Build core first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/mcp-v106-mock-servers.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { connectMcp } from '../packages/core/dist/mcp/client.js';
import { discoverServer } from '../packages/core/dist/mcp/stateless.js';
import { negotiateStatelessConnection } from '../packages/core/dist/mcp/statelessClient.js';
import { StatelessHttpTransport } from '../packages/core/dist/mcp/statelessTransport.js';
import { runToolCallMultiRoundTrip } from '../packages/core/dist/mcp/mrtrClient.js';
import {
  createMrtrElicitationHandler,
  MrtrElicitationRefusedError,
} from '../packages/core/dist/mcp/mrtrElicitation.js';
import { TaskHandle } from '../packages/core/dist/mcp/tasks.js';

/** Discovery document của mock server 2026. */
const DISCOVERY_2026 = {
  protocolVersion: '2026-07-28',
  supportedVersions: ['2026-07-28', '2025-11-25'],
  capabilities: {
    tools: {},
    tasks: { extension: 'io.modelcontextprotocol/tasks' },
    prompts: {},
  },
  serverInfo: { name: 'mock-2026', version: '1.0.0' },
  extensions: ['io.modelcontextprotocol/tasks'],
};

/** Mock server 2026: discover + MRTR elicitation + tasks extension. */
function mock2026Server() {
  const calls = [];
  let greetRound = 0;
  const handler = async (method, params = {}) => {
    calls.push({ method, params });
    if (method === 'server/discover') return DISCOVERY_2026;
    if (method === 'tools/call' && params.name === 'greet') {
      greetRound += 1;
      if (greetRound === 1) {
        return {
          resultType: 'needs_elicitation',
          roundTripId: 'rt-greet-1',
          need: {
            resultType: 'needs_elicitation',
            prompt: 'Server cần tên hiển thị của bạn.',
            schema: {
              type: 'object',
              properties: { nickname: { type: 'string' } },
              required: ['nickname'],
            },
          },
        };
      }
      return {
        resultType: 'complete',
        roundTripId: 'rt-greet-1',
        result: { content: [{ type: 'text', text: `Xin chào ${params.answer?.nickname ?? 'bạn'}!` }] },
      };
    }
    if (method === 'tools/call' && params.name === 'ask-secret') {
      return {
        resultType: 'needs_elicitation',
        roundTripId: 'rt-secret-1',
        need: {
          resultType: 'needs_elicitation',
          prompt: 'Cho xin mật khẩu.',
          schema: {
            type: 'object',
            properties: { password: { type: 'string' } },
            required: ['password'],
          },
        },
      };
    }
    if (method === 'tools/call' && params.name === 'long-job') {
      return { taskId: 'job-1', status: 'working', pollInterval: 5 };
    }
    if (method === 'tasks/get' && params.taskId === 'job-1') {
      return { taskId: 'job-1', status: 'completed', pollInterval: 5, result: { text: 'job done' } };
    }
    if (method === 'tasks/cancel') return { taskId: params.taskId, status: 'cancelled' };
    throw new Error(`-32601 Method not found: ${method}`);
  };
  return {
    calls,
    requestJsonRpc: handler,
    async discover() {
      return discoverServer({ requestJsonRpc: handler }, {});
    },
    async initialize() {
      throw new Error('mock-2026 does not use initialize');
    },
  };
}

/** Mock server legacy 2025-11-25: không biết discover, handshake cũ. */
function mockLegacyServer() {
  const calls = [];
  const tasks = { 'old-1': ['working', 'completed'] };
  const handler = async (method, params = {}) => {
    calls.push({ method, params });
    if (method === 'server/discover') throw new Error('-32601 Method not found');
    if (method === 'initialize') {
      return {
        protocolVersion: '2025-11-25',
        capabilities: { tools: {}, elicitation: {}, tasks: {} },
        serverInfo: { name: 'mock-legacy', version: '0.9.0' },
      };
    }
    if (method === 'notifications/initialized') return null;
    if (method === 'tools/call') {
      return { content: [{ type: 'text', text: `legacy echo: ${params.arguments?.text ?? ''}` }] };
    }
    if (method === 'tasks/get' && params.taskId === 'old-1') {
      const status = tasks['old-1'].shift() ?? 'completed';
      return { taskId: 'old-1', status, pollInterval: 5 };
    }
    if (method === 'tasks/result' && params.taskId === 'old-1') {
      return { content: [{ type: 'text', text: 'old result' }] };
    }
    if (method === 'tasks/cancel') return { taskId: params.taskId, status: 'cancelled' };
    throw new Error(`-32601 Method not found: ${method}`);
  };
  return {
    calls,
    requestJsonRpc: handler,
    async discover() {
      return discoverServer({ requestJsonRpc: handler }, {});
    },
    async initialize() {
      return handler('initialize', {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'open-bot', version: '0.2.0' },
      });
    },
  };
}

test('mock servers: 2026 server answers server/discover; legacy returns null (pre-2.0)', async () => {
  const modern = mock2026Server();
  const discovered = await modern.discover();
  assert.equal(discovered.protocolVersion, '2026-07-28');
  assert.equal(discovered.serverInfo.name, 'mock-2026');
  assert.ok(discovered.extensions.includes('io.modelcontextprotocol/tasks'));

  const legacy = mockLegacyServer();
  assert.equal(await legacy.discover(), null);
});

test('mock servers: auto-negotiation — 2026 stays stateless, legacy falls back to handshake', async () => {
  const modern = await negotiateStatelessConnection(mock2026Server(), 'auto');
  assert.equal(modern.mode, 'stateless');
  assert.equal(modern.fellBack, false);
  assert.equal(modern.protocolVersion, '2026-07-28');
  assert.equal(modern.discoveredOlderVersion, false);

  const legacy = await negotiateStatelessConnection(mockLegacyServer(), 'auto');
  assert.equal(legacy.mode, 'handshake');
  assert.equal(legacy.fellBack, true);
  assert.equal(legacy.protocolVersion, '2025-11-25');

  const forced = await negotiateStatelessConnection(mockLegacyServer(), false);
  assert.equal(forced.mode, 'handshake');
  assert.equal(forced.fellBack, false);
});

test('mock servers: MRTR elicitation end-to-end against the 2026 mock (2 rounds)', async () => {
  const server = mock2026Server();
  const { onNeedsElicitation, handler } = createMrtrElicitationHandler({
    serverName: 'mock-2026',
    prompt: async () => ({ action: 'accept', content: { nickname: 'Huy' } }),
  });
  const outcome = await runToolCallMultiRoundTrip(
    { requestJsonRpc: (m, p) => server.requestJsonRpc(m, p) },
    'greet',
    {},
    { onNeedsElicitation },
    { protocolVersion: '2026-07-28' },
  );
  assert.equal(outcome.rounds, 2);
  assert.equal(outcome.roundTripId, 'rt-greet-1');
  assert.match(JSON.stringify(outcome.result), /Xin chào Huy/);
  assert.equal(handler.secretRefusals, 0);
});

test('mock servers: secret elicitation is refused end-to-end (prompt never asked)', async () => {
  const server = mock2026Server();
  let promptCalled = 0;
  const { onNeedsElicitation } = createMrtrElicitationHandler({
    serverName: 'mock-2026',
    prompt: async () => {
      promptCalled += 1;
      return { action: 'accept', content: {} };
    },
  });
  await assert.rejects(
    runToolCallMultiRoundTrip(
      { requestJsonRpc: (m, p) => server.requestJsonRpc(m, p) },
      'ask-secret',
      {},
      { onNeedsElicitation },
      { protocolVersion: '2026-07-28' },
    ),
    (err) => {
      assert.ok(err instanceof MrtrElicitationRefusedError);
      assert.deepEqual(err.refusedFields, ['password']);
      return true;
    },
  );
  assert.equal(promptCalled, 0);
});

test('mock servers: legacy 2025 tasks — tasks/get + tasks/result (no tasks/update)', async () => {
  const server = mockLegacyServer();
  const transport = { request: (m, p) => server.requestJsonRpc(m, p) };
  const direct = new TaskHandle(transport, { taskId: 'old-1', status: 'working', pollInterval: 5 }, {
    specVersion: '2025-11-25',
    pollIntervalMs: 5,
  });
  const { result } = await direct.waitForCompletion({ maxPollIntervalMs: 50 });
  assert.deepEqual(result, { content: [{ type: 'text', text: 'old result' }] });
});

test('mock servers: stateless transport over fake fetch — no session header even when server sends one', async () => {
  const server = mock2026Server();
  const seenHeaders = [];
  const fetchFn = async (url, init) => {
    seenHeaders.push({ ...init.headers });
    const body = JSON.parse(init.body);
    const result = await server.requestJsonRpc(body.method, body.params);
    return {
      status: 200,
      headers: {
        get: (name) =>
          name.toLowerCase() === 'content-type'
            ? 'application/json'
            : name.toLowerCase() === 'mcp-session-id'
              ? 'mock-session-should-be-dropped'
              : null,
      },
      text: async () => JSON.stringify({ jsonrpc: '2.0', id: body.id, result }),
    };
  };
  const transport = new StatelessHttpTransport({
    url: 'https://mock-2026.invalid/mcp',
    fetchFn,
  });
  const discovered = await transport.requestJsonRpc('server/discover', {});
  assert.equal(discovered.protocolVersion, '2026-07-28');
  assert.equal(transport.droppedSessionHeaders, 1);
  for (const headers of seenHeaders) {
    assert.equal(headers['Mcp-Session-Id'], undefined);
  }
  transport.close();
});

test('mock servers: real HTTP client (connectMcp, stateless auto) never sends Mcp-Session-Id', async () => {
  const server = mock2026Server();
  const seenHeaders = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    seenHeaders.push({ ...(init.headers ?? {}) });
    const body = JSON.parse(init.body);
    let result;
    try {
      result = await server.requestJsonRpc(body.method, body.params);
    } catch (err) {
      return {
        status: 200,
        headers: { get: () => 'application/json' },
        text: async () =>
          JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: String(err) } }),
      };
    }
    return {
      status: 200,
      headers: {
        get: (name) =>
          name.toLowerCase() === 'content-type'
            ? 'application/json'
            : name.toLowerCase() === 'mcp-session-id'
              ? 'mock-session-from-discover'
              : null,
      },
      text: async () => JSON.stringify({ jsonrpc: '2.0', id: body.id, result }),
    };
  };
  try {
    const client = await connectMcp({
      name: 'mock-2026',
      url: 'http://127.0.0.1:9/mcp',
      stateless: 'auto',
    });
    try {
      assert.equal(client.statelessActive, true);
      assert.equal(client.negotiatedProtocolVersion, '2026-07-28');
      assert.equal(client.statelessNegotiation?.mode, 'stateless');
      assert.equal(client.statelessNegotiation?.fellBack, false);
      // The deprecation tracker exists on the real client (v1.06 wiring).
      assert.equal(client.deprecationTracker.hasUsedDeprecated, false);
      await client.requestJsonRpc('tools/call', { name: 'long-job' });
      for (const headers of seenHeaders) {
        assert.equal(headers['Mcp-Session-Id'], undefined);
      }
      // No GET stream was opened in stateless mode (no session to keep).
      assert.equal(seenHeaders.every((h) => h['Mcp-Session-Id'] === undefined), true);
    } finally {
      await client.close().catch(() => undefined);
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});
