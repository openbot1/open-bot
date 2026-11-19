/**
 * Tests for v1.41 (Team T2) — MCP stateless v10:
 * packages/core/src/protocolsV10/mcpStatelessV10.ts
 *
 * Covers:
 *  - _meta validation (protocolVersion required, trace shape,
 *    capabilities flags) + trace builder/validator (W3C
 *    traceparent must match traceId/spanId)
 *  - deterministic tool listing (sorted by name) + stable
 *    list hash (same tools -> same hash, any order)
 *  - state handles (issue / resolve / expiry / sweep)
 *  - subscriptions/listen hub (opt-in kinds only, no
 *    listener = dropped, counts by kind)
 *  - server dispatch: discover, tools/list, tools/call,
 *    session-only methods refused (initialize), bad _meta
 *    refused, unknown tool refused, trace echoed back
 *  - client: discover first, list order enforced, callTool
 *    stores the issued state handle and passes it back
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/protocols-v10-stateless.test.mjs
 *
 * No network, no model.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  McpV10StatelessClient,
  McpV10StatelessServer,
  McpV10SubscriptionHub,
  buildMcpV10RequestMeta,
  childMcpV10Trace,
  createLoopbackMcpV10Sender,
  formatMcpV10Traceparent,
  hashMcpV10ToolList,
  isMcpV10StateHandleExpired,
  issueMcpV10StateHandle,
  newMcpV10Trace,
  parseMcpV10Traceparent,
  sortMcpV10Tools,
  validateMcpV10DiscoverResult,
  validateMcpV10RequestMeta,
  validateMcpV10Trace,
} from '../packages/core/dist/index.js';

test('trace propagation: parse traceparent, derive a child span in the same trace', () => {
  const parent = newMcpV10Trace();
  const parsed = parseMcpV10Traceparent(parent.traceparent);
  assert.deepEqual(parsed, parent);
  assert.equal(parseMcpV10Traceparent('garbage'), undefined);
  assert.equal(parseMcpV10Traceparent(42), undefined);
  assert.equal(parseMcpV10Traceparent(`00-${'0'.repeat(32)}-${'0'.repeat(16)}-02`), undefined);
  const child = childMcpV10Trace(parent);
  assert.equal(child.traceId, parent.traceId);
  assert.notEqual(child.spanId, parent.spanId);
  assert.equal(child.sampled, parent.sampled);
  assert.equal(child.traceparent, formatMcpV10Traceparent(child));
  assert.deepEqual(validateMcpV10Trace(child), []);
  const unsampled = childMcpV10Trace(parent, false);
  assert.equal(unsampled.sampled, false);
  assert.match(unsampled.traceparent, /-00$/);
  assert.throws(() => childMcpV10Trace({ traceId: 'bad' }), /Cannot derive a child trace/);
  assert.throws(() => formatMcpV10Traceparent({ traceId: parent.traceId }), /without a spanId/);
});

test('trace validation: good trace passes, mismatched traceparent fails', () => {
  const trace = newMcpV10Trace();
  assert.deepEqual(validateMcpV10Trace(trace), []);
  assert.match(trace.traceId, /^[0-9a-f]{32}$/);
  assert.match(trace.traceparent, /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  assert.deepEqual(validateMcpV10Trace({ traceId: 'xyz' }), ['trace.traceId must be a 32-hex-char string.']);
  const mismatch = { ...trace, traceparent: `00-${'0'.repeat(32)}-${trace.spanId}-01` };
  assert.ok(validateMcpV10Trace(mismatch).some((p) => p.includes('does not match')));
  assert.deepEqual(validateMcpV10Trace(undefined), []);
  assert.deepEqual(validateMcpV10Trace({ traceId: trace.traceId, sampled: 'yes' }), ['trace.sampled must be a boolean.']);
});

test('_meta validation: protocolVersion required, flags must be booleans', () => {
  assert.deepEqual(validateMcpV10RequestMeta(buildMcpV10RequestMeta({})), []);
  assert.ok(validateMcpV10RequestMeta({}).length > 0);
  assert.ok(validateMcpV10RequestMeta({ protocolVersion: '2026-07-28', capabilities: { statelessHttp: 'yes' } }).length > 0);
  assert.ok(validateMcpV10RequestMeta({ protocolVersion: '2026-07-28', extensions: 'tasks' }).length > 0);
  assert.ok(validateMcpV10RequestMeta(null).length > 0);
  const meta = buildMcpV10RequestMeta({ clientName: 't', tenant: 'acme' });
  assert.equal(meta.protocolVersion, '2026-07-28');
  assert.equal(meta.clientName, 't');
  assert.equal(meta.capabilities.statelessHttp, true);
  assert.equal(meta.capabilities.toolSearch, true);
});

test('deterministic listing: sorted by name, hash stable regardless of input order', () => {
  const a = { name: 'zeta', description: 'z' };
  const b = { name: 'alpha', description: 'a', deferLoading: true };
  const c = { name: 'mid', description: 'm' };
  assert.deepEqual(sortMcpV10Tools([a, b, c]).map((t) => t.name), ['alpha', 'mid', 'zeta']);
  assert.equal(hashMcpV10ToolList([a, b, c]), hashMcpV10ToolList([c, a, b]));
  assert.notEqual(hashMcpV10ToolList([a, b]), hashMcpV10ToolList([a, { ...b, deferLoading: false }]));
});

test('state handles: issue, resolve, expire, sweep', () => {
  const handle = issueMcpV10StateHandle('tool:echo', 1000, 1_000_000);
  assert.equal(handle.scope, 'tool:echo');
  assert.equal(isMcpV10StateHandleExpired(handle, 1_000_500), false);
  assert.equal(isMcpV10StateHandleExpired(handle, 1_001_000), true);
  assert.throws(() => issueMcpV10StateHandle(''), /non-empty string/);
  const server = new McpV10StatelessServer();
  const issued = server.issueStateHandle('scope-a');
  assert.ok(server.resolveStateHandle(issued.handle));
  assert.equal(server.resolveStateHandle('sth-nope'), undefined);
  assert.equal(server.sweepHandles(Date.now() + 60 * 60 * 1000), 1);
  assert.equal(server.resolveStateHandle(issued.handle), undefined);
});

test('subscriptions hub: opt-in only, no listener means dropped', () => {
  const hub = new McpV10SubscriptionHub();
  assert.equal(hub.publish({ kind: 'tools', change: 'added', target: 'x' }), false);
  assert.equal(hub.dropped.length, 1);
  const sub = hub.subscribe('listener-1', ['tools']);
  assert.equal(hub.publish({ kind: 'tools', change: 'added', target: 'y' }), true);
  assert.equal(hub.delivered.length, 1);
  assert.equal(hub.publish({ kind: 'resources', change: 'added', target: 'r' }), false);
  assert.deepEqual(hub.countsByKind().tools, 1);
  assert.deepEqual(hub.countsByKind().resources, 0);
  assert.equal(hub.hasListener('tools'), true);
  assert.equal(hub.unsubscribe(sub.id), true);
  assert.equal(hub.hasListener('tools'), false);
  assert.throws(() => hub.subscribe('l2', []), /at least one kind/);
  assert.throws(() => hub.subscribe('', ['tools']), /non-empty listenerId/);
  assert.throws(() => hub.subscribe('l3', ['bogus']), /at least one kind/);
});

test('server dispatch: discover + list + call, trace echoed, session methods refused', async () => {
  const server = new McpV10StatelessServer({
    tools: [
      { name: 'beta', description: 'b', handler: (args) => ({ got: args }) },
      { name: 'alpha', description: 'a', handler: () => 'A' },
    ],
  });
  const meta = buildMcpV10RequestMeta({});
  const discover = await server.dispatch({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: meta } });
  assert.ok('result' in discover);
  assert.deepEqual(validateMcpV10DiscoverResult(discover.result), []);
  assert.equal(discover.result.protocolVersion, '2026-07-28');
  assert.equal(discover.result.stateHandles, true);
  const list = await server.dispatch({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: { _meta: meta } });
  assert.deepEqual(list.result.tools.map((t) => t.name), ['alpha', 'beta']);
  assert.equal(list.result.listHash, server.toolListHash());
  // Trace is echoed back in the result _meta.
  assert.equal(list.result._meta.trace.traceId, meta.trace.traceId);
  const call = await server.dispatch({
    jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: 'alpha', arguments: {}, _meta: meta },
  });
  assert.equal(call.result.content, 'A');
  assert.equal(typeof call.result.stateHandle, 'string');
  const init = await server.dispatch({ jsonrpc: '2.0', id: 4, method: 'initialize', params: { _meta: meta } });
  assert.ok('error' in init);
  assert.match(init.error.message, /session-only/);
  const badMeta = await server.dispatch({ jsonrpc: '2.0', id: 5, method: 'tools/list', params: { _meta: {} } });
  assert.ok('error' in badMeta);
  const unknown = await server.dispatch({
    jsonrpc: '2.0', id: 6, method: 'tools/call',
    params: { name: 'nope', arguments: {}, _meta: meta },
  });
  assert.ok('error' in unknown);
  assert.match(unknown.error.message, /Unknown tool/);
  const stale = await server.dispatch({
    jsonrpc: '2.0', id: 7, method: 'tools/call',
    params: { name: 'alpha', arguments: { state_handle: 'sth-stale' }, _meta: meta },
  });
  assert.ok('error' in stale);
  assert.match(stale.error.message, /unknown or expired/);
  assert.equal(server.totalCalls, 1);
});

test('client: discover first, list order enforced, state handle passed back', async () => {
  const server = new McpV10StatelessServer({
    tools: [{ name: 'echo', description: 'e', handler: (args) => ({ echoed: args }) }],
  });
  const client = new McpV10StatelessClient({ sender: createLoopbackMcpV10Sender(server) });
  assert.equal(client.discovery, undefined);
  const discovery = await client.discover();
  assert.equal(discovery.serverName, 'open-bot-mcp-v10');
  const list = await client.listTools();
  assert.deepEqual(list.tools.map((t) => t.name), ['echo']);
  assert.equal(client.listHash, list.listHash);
  const first = await client.callTool('echo', { x: 1 });
  assert.deepEqual(first, { echoed: { x: 1 } });
  assert.equal(typeof client.currentStateHandle, 'string');
  const firstHandle = client.currentStateHandle;
  // Second call passes the handle back as a plain argument (server accepts it).
  const second = await client.callTool('echo', { x: 2 });
  assert.deepEqual(second, { echoed: { x: 2, state_handle: firstHandle } });
  const sub = await client.subscribe('ui-1', ['tools']);
  assert.equal(typeof sub.subscriptionId, 'string');
  assert.deepEqual(sub.kinds, ['tools']);
  client.forgetStateHandle();
  assert.equal(client.currentStateHandle, undefined);
});

test('client refuses a server speaking the wrong protocol version', async () => {
  const bad = {
    dispatch: async () => ({
      jsonrpc: '2.0', id: 1,
      result: {
        protocolVersion: '1999-01-01', serverName: 'old', serverVersion: '0.1',
        capabilities: {}, extensions: [], methods: ['server/discover'],
        stateHandles: false, subscriptions: false,
      },
    }),
  };
  const client = new McpV10StatelessClient({ sender: bad.dispatch });
  await assert.rejects(() => client.discover(), /requires 2026-07-28/);
});
