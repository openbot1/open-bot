/**
 * Test v1.06 T2: stateless server probe (node:test).
 * Local only: fake fetch backed by mock servers, no live network.
 *
 * Build core first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/mcp-v106-stateless-probe.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  describeStatelessProbe,
  probeStatelessServer,
} from '../packages/core/dist/mcp/statelessProbe.js';

function fakeHeaders(map = {}) {
  const lower = {};
  for (const [k, v] of Object.entries(map)) lower[k.toLowerCase()] = v;
  return { get: (name) => lower[name.toLowerCase()] ?? null };
}

function jsonRpcResponse(id, payload, headers = {}) {
  return {
    status: 200,
    headers: fakeHeaders({ 'content-type': 'application/json', ...headers }),
    text: async () => JSON.stringify({ jsonrpc: '2.0', id, ...payload }),
  };
}

/** Fake fetch routing methods to a handler table. */
function routingFetch(routes, { sessionHeader = false } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    const route = routes[body.method];
    if (!route) {
      return jsonRpcResponse(body.id, {
        error: { code: -32601, message: `Method not found: ${body.method}` },
      });
    }
    if (route instanceof Error) throw route;
    return jsonRpcResponse(
      body.id,
      { result: typeof route === 'function' ? route(body.params) : route },
      sessionHeader ? { 'mcp-session-id': 'probe-session-should-drop' } : {},
    );
  };
  fn.calls = calls;
  return fn;
}

const DISCOVERY = {
  protocolVersion: '2026-07-28',
  supportedVersions: ['2026-07-28'],
  capabilities: { tools: {}, tasks: {}, prompts: {} },
  serverInfo: { name: 'mock-probe', version: '2.0.0' },
  extensions: ['io.modelcontextprotocol/tasks'],
};

test('stateless probe: modern server — discovered, tools counted, session header dropped', async () => {
  const fetchFn = routingFetch(
    {
      'server/discover': DISCOVERY,
      'tools/list': { tools: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] },
    },
    { sessionHeader: true },
  );
  const result = await probeStatelessServer('https://probe.invalid/mcp', { fetchFn });
  assert.equal(result.discovered, true);
  assert.equal(result.protocolVersion, '2026-07-28');
  assert.equal(result.serverName, 'mock-probe');
  assert.equal(result.serverVersion, '2.0.0');
  // parseServerDiscoverResult sắp capability theo thứ tự cố định
  // (tools, resources, prompts, tasks, ...) — không theo thứ tự JSON gốc.
  assert.deepEqual(result.capabilities, ['tools', 'prompts', 'tasks']);
  assert.deepEqual(result.extensions, ['io.modelcontextprotocol/tasks']);
  assert.equal(result.toolsListed, 3);
  assert.equal(result.droppedSessionHeaders, 2);
  assert.equal(result.requestsSent, 2);
  assert.equal(result.error, undefined);
  const summary = describeStatelessProbe(result);
  assert.match(summary, /2026-07-28/);
  assert.match(summary, /mock-probe/);
  assert.match(summary, /3 tools/);
  assert.match(summary, /2 session header/);
});

test('stateless probe: legacy server (-32601 on discover) reports fallback need, does not throw', async () => {
  const fetchFn = routingFetch({});
  const result = await probeStatelessServer('https://legacy.invalid/mcp', { fetchFn });
  assert.equal(result.discovered, false);
  assert.match(result.error, /pre-2\.0/);
  assert.equal(result.requestsSent, 1);
  assert.equal(result.toolsListed, undefined);
  assert.match(describeStatelessProbe(result), /không discover được/);
});

test('stateless probe: malformed discovery document reports a shape error', async () => {
  const fetchFn = routingFetch({
    'server/discover': { capabilities: {} },
    'tools/list': { tools: [] },
  });
  const result = await probeStatelessServer('https://bad.invalid/mcp', { fetchFn });
  assert.equal(result.discovered, false);
  assert.match(result.error, /sai shape/);
});

test('stateless probe: discover OK but tools/list fails keeps discovery + error', async () => {
  const fetchFn = routingFetch({
    'server/discover': DISCOVERY,
    'tools/list': new Error('-32601 Method not found: tools/list'),
  });
  // routingFetch throws the Error for tools/list — the transport wraps
  // it as a StatelessTransportError; probe records it in `error`.
  const result = await probeStatelessServer('https://partial.invalid/mcp', { fetchFn });
  assert.equal(result.discovered, true);
  assert.equal(result.protocolVersion, '2026-07-28');
  assert.equal(result.toolsListed, undefined);
  assert.match(result.error, /tools\/list/);
  assert.match(describeStatelessProbe(result), /lưu ý/);
});

test('stateless probe: transport error (network down) is reported, not thrown', async () => {
  const fetchFn = async () => {
    throw new Error('connect ECONNREFUSED');
  };
  const result = await probeStatelessServer('https://down.invalid/mcp', { fetchFn });
  assert.equal(result.discovered, false);
  assert.match(result.error, /ECONNREFUSED/);
  assert.equal(result.requestsSent, 1);
});
