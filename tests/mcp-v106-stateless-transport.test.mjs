/**
 * Test v1.06 T2: stateless HTTP transport (node:test).
 * Local only, no live network: a fake fetch records requests.
 *
 * Build core first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/mcp-v106-stateless-transport.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildStatelessJsonRpcRequest,
  buildStatelessRequestHeaders,
  hasSessionIdHeader,
  parseStatelessResponseBody,
  StatelessHttpTransport,
  StatelessTransportError,
  DEFAULT_STATELESS_REQUEST_TIMEOUT_MS,
} from '../packages/core/dist/mcp/statelessTransport.js';

function fakeHeaders(map = {}) {
  const lower = {};
  for (const [k, v] of Object.entries(map)) lower[k.toLowerCase()] = v;
  return { get: (name) => lower[name.toLowerCase()] ?? null };
}

function fakeResponse({ status = 200, body = '{}', headers = {} } = {}) {
  return { status, headers: fakeHeaders(headers), text: async () => body };
}

/** Fake fetch that answers JSON-RPC with a fixed result and records calls. */
function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    if (init.signal?.aborted) {
      const err = new Error('The operation was aborted.');
      err.name = 'AbortError';
      throw err;
    }
    calls.push({ url, init, body: JSON.parse(init.body) });
    return handler(calls[calls.length - 1]);
  };
  fn.calls = calls;
  return fn;
}

const okResult = (result) =>
  fakeResponse({
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, result }),
    headers: { 'content-type': 'application/json' },
  });

test('stateless transport: headers never contain Mcp-Session-Id', () => {
  const headers = buildStatelessRequestHeaders({
    Authorization: 'Bearer x',
    'Mcp-Session-Id': 'should-be-dropped',
  });
  assert.equal(headers['Mcp-Session-Id'], undefined);
  assert.equal(headers['Authorization'], 'Bearer x');
  assert.equal(headers['Content-Type'], 'application/json');
  assert.equal(hasSessionIdHeader(headers), false);
  assert.equal(hasSessionIdHeader({ 'mcp-session-id': 'abc' }), true);
});

test('stateless transport: buildStatelessJsonRpcRequest attaches _meta, does not mutate params', () => {
  const params = { name: 'echo', arguments: { a: 1 } };
  const req = buildStatelessJsonRpcRequest(7, 'tools/call', params, {
    protocolVersion: '2026-07-28',
  });
  assert.equal(req.jsonrpc, '2.0');
  assert.equal(req.id, 7);
  assert.equal(req.method, 'tools/call');
  assert.equal(req.params._meta.protocolVersion, '2026-07-28');
  assert.equal(req.params._meta.clientCapabilities.multiRoundTrip, true);
  assert.equal(params._meta, undefined);
  assert.deepEqual(params.arguments, { a: 1 });
});

test('stateless transport: POST-only request carries _meta, returns result', async () => {
  const fetchFn = fakeFetch(() => okResult({ tools: [] }));
  const transport = new StatelessHttpTransport({
    url: 'https://example.invalid/mcp',
    fetchFn,
  });
  const result = await transport.requestJsonRpc('tools/list', {});
  assert.deepEqual(result, { tools: [] });
  assert.equal(fetchFn.calls.length, 1);
  assert.equal(fetchFn.calls[0].init.method, 'POST');
  assert.equal(fetchFn.calls[0].url, 'https://example.invalid/mcp');
  assert.equal(fetchFn.calls[0].body.method, 'tools/list');
  assert.equal(fetchFn.calls[0].body.params._meta.protocolVersion, '2026-07-28');
  assert.equal(fetchFn.calls[0].init.headers['Mcp-Session-Id'], undefined);
  assert.equal(transport.requestsSent, 1);
  assert.equal(transport.droppedSessionHeaders, 0);
});

test('stateless transport: server Mcp-Session-Id response header is dropped + noticed, never re-sent', async () => {
  const notices = [];
  const fetchFn = fakeFetch((call) =>
    fakeResponse({
      body: JSON.stringify({ jsonrpc: '2.0', id: call.body.id, result: { ok: true } }),
      headers: { 'content-type': 'application/json', 'mcp-session-id': 'sess-secret-123' },
    }),
  );
  const transport = new StatelessHttpTransport({
    url: 'https://example.invalid/mcp',
    fetchFn,
    onNotice: (n) => notices.push(n),
  });
  await transport.requestJsonRpc('ping');
  await transport.requestJsonRpc('tools/list', {});
  assert.equal(transport.droppedSessionHeaders, 2);
  assert.equal(notices.filter((n) => n.kind === 'session-header-dropped').length, 2);
  // The dropped value must never appear in a notice.
  assert.equal(JSON.stringify(notices).includes('sess-secret-123'), false);
  for (const call of fetchFn.calls) {
    assert.equal(call.init.headers['Mcp-Session-Id'], undefined);
  }
});

test('stateless transport: static Mcp-Session-Id in config headers is dropped at construction', async () => {
  const notices = [];
  const fetchFn = fakeFetch(() => okResult({}));
  const transport = new StatelessHttpTransport({
    url: 'https://example.invalid/mcp',
    fetchFn,
    headers: { 'Mcp-Session-Id': 'static-secret', 'X-Test': '1' },
    onNotice: (n) => notices.push(n),
  });
  await transport.requestJsonRpc('ping');
  assert.equal(fetchFn.calls[0].init.headers['Mcp-Session-Id'], undefined);
  assert.equal(fetchFn.calls[0].init.headers['X-Test'], '1');
  assert.equal(transport.droppedSessionHeaders, 1);
  assert.equal(JSON.stringify(notices).includes('static-secret'), false);
});

test('stateless transport: JSON-RPC error keeps its code', async () => {
  const fetchFn = fakeFetch((call) =>
    fakeResponse({
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: call.body.id,
        error: { code: -32601, message: 'Method not found' },
      }),
    }),
  );
  const transport = new StatelessHttpTransport({ url: 'https://example.invalid/mcp', fetchFn });
  await assert.rejects(transport.requestJsonRpc('nope/method'), (err) => {
    assert.ok(err instanceof StatelessTransportError);
    assert.equal(err.code, -32601);
    assert.match(err.message, /Method not found/);
    return true;
  });
});

test('stateless transport: HTTP error status throws with httpStatus', async () => {
  const fetchFn = fakeFetch(() => fakeResponse({ status: 500, body: 'boom' }));
  const transport = new StatelessHttpTransport({ url: 'https://example.invalid/mcp', fetchFn });
  await assert.rejects(transport.requestJsonRpc('tools/list'), (err) => {
    assert.ok(err instanceof StatelessTransportError);
    assert.equal(err.httpStatus, 500);
    return true;
  });
});

test('stateless transport: timeout aborts and reports timeout notice', async () => {
  const notices = [];
  const fetchFn = (url, init) =>
    new Promise((resolve, reject) => {
      init.signal?.addEventListener(
        'abort',
        () => {
          const err = new Error('The operation was aborted.');
          err.name = 'AbortError';
          reject(err);
        },
        { once: true },
      );
      setTimeout(() => resolve(okResult({})), 200);
    });
  const transport = new StatelessHttpTransport({
    url: 'https://example.invalid/mcp',
    fetchFn,
    timeoutMs: 20,
    onNotice: (n) => notices.push(n),
  });
  await assert.rejects(transport.requestJsonRpc('tools/list'), /hết thời gian/);
  assert.equal(notices.some((n) => n.kind === 'timeout'), true);
});

test('stateless transport: close() blocks further requests, is idempotent', async () => {
  const fetchFn = fakeFetch(() => okResult({}));
  const transport = new StatelessHttpTransport({ url: 'https://example.invalid/mcp', fetchFn });
  transport.close();
  transport.close();
  assert.equal(transport.isClosed, true);
  await assert.rejects(transport.requestJsonRpc('ping'), /đã đóng/);
  assert.equal(fetchFn.calls.length, 0);
});

test('stateless transport: SSE response — result frame wins, server messages dispatched', async () => {
  const seen = [];
  const sseBody =
    'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{"progress":1}}\n\n' +
    'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"done":true}}\n\n';
  const fetchFn = fakeFetch(() =>
    fakeResponse({ body: sseBody, headers: { 'content-type': 'text/event-stream' } }),
  );
  const transport = new StatelessHttpTransport({ url: 'https://example.invalid/mcp', fetchFn });
  transport.onServerMessage = (msg) => seen.push(msg);
  const result = await transport.requestJsonRpc('tools/call', { name: 'slow' });
  assert.deepEqual(result, { done: true });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].method, 'notifications/progress');
});

test('stateless transport: parseStatelessResponseBody rejects id mismatch and bad JSON', () => {
  assert.throws(
    () => parseStatelessResponseBody('{"jsonrpc":"2.0","id":99,"result":{}}', 'application/json', 1),
    /không khớp/,
  );
  assert.throws(
    () => parseStatelessResponseBody('{not json', 'application/json', 1),
    /không phải JSON/,
  );
  assert.equal(parseStatelessResponseBody('', 'application/json', 1), null);
  assert.equal(DEFAULT_STATELESS_REQUEST_TIMEOUT_MS, 30_000);
});

test('stateless transport: caller abort signal aborts the request', async () => {
  const controller = new AbortController();
  controller.abort();
  const fetchFn = fakeFetch(() => okResult({}));
  const transport = new StatelessHttpTransport({ url: 'https://example.invalid/mcp', fetchFn });
  await assert.rejects(
    transport.requestJsonRpc('tools/list', {}, { signal: controller.signal }),
    /đã bị huỷ/,
  );
});
