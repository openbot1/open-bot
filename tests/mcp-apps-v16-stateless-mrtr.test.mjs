/**
 * Test v1.36 T3: MCP Apps v16 — stateless client v16 + MRTR SEP-2322 (node:test).
 * Local only, no network (fake transport + scripted server).
 *
 * Build core + tools first:
 *   npm run build --workspace=@open-bot/core && npm run build --workspace=@open-bot/tools
 * then: node --test tests/mcp-apps-v16-stateless-mrtr.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  StatelessClientV16,
  V16EndpointPool,
  V16TransportError,
  assertNoSessionIdHeader,
  buildV16RequestEnvelope,
  isTransientV16Error,
  parseV16DiscoverResult,
} from '../packages/core/dist/mcp/statelessClientV16.js';
import {
  MrtrV16Session,
  findSecretFieldInState,
  parseMrtrV16Result,
  sha256Hex,
  signMrtrV16RequestState,
  validateMrtrV16Response,
  verifyMrtrV16RequestState,
} from '../packages/core/dist/mcp/mrtrV16.js';

const DISCOVER_DOC = {
  protocolVersion: '2026-07-28',
  supportedVersions: ['2026-07-28', '2025-11-25'],
  capabilities: { tools: {}, apps: {} },
  serverInfo: { name: 'demo-server', version: '1.0.0' },
  extensions: ['io.modelcontextprotocol/ui'],
};

/** Fake transport ghi lại mọi request; behaviour điều khiển được. */
function makeFakeTransport(behavior) {
  const seen = [];
  return {
    seen,
    async request(endpointUrl, body, headers) {
      seen.push({ endpointUrl, body, headers });
      return behavior(endpointUrl, body, headers, seen.length);
    },
  };
}

test('v16 envelope: _meta mang protocol version + capabilities + idempotency key, không có Mcp-Session-Id', () => {
  const envelope = buildV16RequestEnvelope(
    'tools/call',
    { name: 'demo', arguments: {} },
    {
      protocolVersion: '2026-07-28',
      capabilities: { multiRoundTrip: true, apps: true },
      clientInfo: { name: 'open-bot', version: '1.36.0' },
    },
  );
  assert.equal(envelope.jsonrpc, '2.0');
  assert.equal(envelope.method, 'tools/call');
  const meta = envelope.params._meta;
  assert.equal(meta.protocolVersion, '2026-07-28');
  assert.equal(meta.clientCapabilities.multiRoundTrip, true);
  assert.equal(meta.clientCapabilities.apps, true);
  assert.equal(meta.clientInfo.name, 'open-bot');
  assert.equal(typeof meta.idempotencyKey, 'string');
  assert.ok(meta.idempotencyKey.length > 0);
  assert.equal('Mcp-Session-Id' in envelope.headers, false);
  assert.equal('mcp-session-id' in envelope.headers, false);
  // Hai envelope khác nhau có idempotency key khác nhau.
  const second = buildV16RequestEnvelope('tools/call', {}, {});
  assert.notEqual(second.params._meta.idempotencyKey, meta.idempotencyKey);
});

test('v16 envelope: initialize bị cấm; assertNoSessionIdHeader ném khi có session header', () => {
  assert.throws(
    () => buildV16RequestEnvelope('initialize', {}, {}),
    /không bao giờ gọi initialize/,
  );
  assert.throws(
    () => assertNoSessionIdHeader({ 'Mcp-Session-Id': 'abc' }),
    /Mcp-Session-Id.*bị cấm/,
  );
  assert.throws(
    () => assertNoSessionIdHeader({ 'mcp-session-id': 'abc' }),
    /Mcp-Session-Id.*bị cấm/,
  );
  assert.doesNotThrow(() => assertNoSessionIdHeader({ 'content-type': 'application/json' }));
  assert.doesNotThrow(() => assertNoSessionIdHeader(undefined));
});

test('v16 pool: round-robin có trọng số, fail 3 lần thì unhealthy, forceHealthy hồi phục', () => {
  let nowMs = 1_000_000;
  const pool = new V16EndpointPool(
    [
      { url: 'https://a.example/rpc', weight: 2 },
      { url: 'https://b.example/rpc', weight: 1 },
    ],
    { now: () => nowMs },
  );
  assert.equal(pool.healthyCount(), 2);
  const order = [pool.next().url, pool.next().url, pool.next().url, pool.next().url];
  assert.deepEqual(order, [
    'https://a.example/rpc',
    'https://a.example/rpc',
    'https://b.example/rpc',
    'https://a.example/rpc',
  ]);
  pool.markFailure('https://a.example/rpc');
  pool.markFailure('https://a.example/rpc');
  assert.equal(pool.healthyCount(), 2);
  pool.markFailure('https://a.example/rpc');
  assert.equal(pool.healthyCount(), 1);
  assert.equal(pool.next().url, 'https://b.example/rpc');
  // Chưa hết cooldown (30s) thì vẫn unhealthy.
  nowMs += 10_000;
  assert.equal(pool.healthyCount(), 1);
  // Hết cooldown thì được probe lại.
  nowMs += 25_000;
  assert.equal(pool.healthyCount(), 2);
  assert.equal(pool.forceHealthy('https://a.example/rpc'), true);
  assert.equal(pool.snapshot().find((s) => s.url === 'https://a.example/rpc').consecutiveFailures, 0);
  assert.throws(
    () => new V16EndpointPool([{ url: 'https://a.example/rpc' }, { url: 'https://a.example/rpc' }]),
    /trùng lặp/,
  );
  assert.throws(() => new V16EndpointPool([]), /ít nhất một endpoint/);
});

test('v16 client: discover có cache, call thành công, header không chứa session id', async () => {
  const transport = makeFakeTransport(() => DISCOVER_DOC);
  const client = new StatelessClientV16(
    [{ url: 'https://a.example/rpc' }],
    transport,
    { clientInfo: { name: 'open-bot', version: '1.36.0' } },
  );
  const first = await client.discover();
  assert.equal(first.protocolVersion, '2026-07-28');
  assert.equal(first.serverInfo.name, 'demo-server');
  const second = await client.discover();
  assert.equal(second, first);
  assert.equal(transport.seen.length, 1, 'discover lần 2 phải dùng cache');
  const call = await client.call('tools/call', { name: 'demo' });
  assert.equal(call.endpointUrl, 'https://a.example/rpc');
  assert.equal(call.attempts, 1);
  assert.equal(call.protocolVersion, '2026-07-28');
  const callBody = transport.seen[transport.seen.length - 1].body;
  assert.equal(callBody.method, 'tools/call');
  assert.equal(callBody.params._meta.protocolVersion, '2026-07-28');
  assert.equal('Mcp-Session-Id' in transport.seen[transport.seen.length - 1].headers, false);
});

test('v16 client: lỗi transient thì retry ở endpoint khác, giữ nguyên idempotency key', async () => {
  const transport = makeFakeTransport((endpointUrl) => {
    if (endpointUrl === 'https://a.example/rpc') {
      throw new V16TransportError('Bad gateway', { transient: true, status: 502 });
    }
    return { result: { ok: true } };
  });
  const client = new StatelessClientV16(
    [{ url: 'https://a.example/rpc' }, { url: 'https://b.example/rpc' }],
    transport,
    { maxRetries: 2 },
  );
  const out = await client.call('tools/call', { name: 'demo' });
  assert.equal(out.endpointUrl, 'https://b.example/rpc');
  assert.equal(out.attempts, 2);
  assert.equal(transport.seen.length, 2);
  const firstKey = transport.seen[0].body.params._meta.idempotencyKey;
  const secondKey = transport.seen[1].body.params._meta.idempotencyKey;
  assert.equal(firstKey, secondKey, 'retry phải giữ nguyên idempotency key');
  assert.equal(transport.seen[0].body.id, transport.seen[1].body.id, 'retry giữ nguyên request id');
  const snapshot = client.poolSnapshot();
  assert.equal(snapshot.find((s) => s.url === 'https://a.example/rpc').totalFailures, 1);
});

test('v16 client: lỗi nghiệp vụ không retry; server pre-2.0 (không discover) bị từ chối', async () => {
  const business = makeFakeTransport(() => {
    throw new Error('boom: lỗi nghiệp vụ');
  });
  const client = new StatelessClientV16([{ url: 'https://a.example/rpc' }], business, { maxRetries: 3 });
  await assert.rejects(() => client.call('tools/call', {}), /boom/);
  assert.equal(business.seen.length, 1, 'lỗi nghiệp vụ không được retry');

  const oldServer = makeFakeTransport(() => ({
    error: { code: -32601, message: 'Method not found' },
  }));
  const oldClient = new StatelessClientV16([{ url: 'https://old.example/rpc' }], oldServer, {});
  await assert.rejects(() => oldClient.discover(), /không hỗ trợ server\/discover.*không fallback handshake/);
});

test('v16 discover parse: document hợp lệ qua, thiếu serverInfo thì ném', () => {
  const parsed = parseV16DiscoverResult(DISCOVER_DOC);
  assert.equal(parsed.serverInfo.version, '1.0.0');
  assert.deepEqual(parsed.extensions, ['io.modelcontextprotocol/ui']);
  assert.throws(
    () => parseV16DiscoverResult({ protocolVersion: '2026-07-28', capabilities: {} }),
    /serverInfo/,
  );
  assert.throws(() => parseV16DiscoverResult('not-an-object'), /non-object/);
});

test('v16 transient: V16TransportError transient + status 503/429 retry được, lỗi thường thì không', () => {
  assert.equal(isTransientV16Error(new V16TransportError('x', { transient: true })), true);
  assert.equal(isTransientV16Error(new V16TransportError('x', { transient: false })), false);
  assert.equal(isTransientV16Error(Object.assign(new Error('timeout'), { status: 503 })), true);
  assert.equal(isTransientV16Error(Object.assign(new Error('bad'), { status: 400 })), false);
  assert.equal(isTransientV16Error(new Error('socket hang up')), true);
  assert.equal(isTransientV16Error(new Error('validation failed')), false);
});

test('mrtr v16: sha256Hex đúng giá trị chuẩn; secret scan tìm đúng trường nhạy cảm', () => {
  assert.equal(
    sha256Hex('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
  assert.equal(findSecretFieldInState({ name: 'Ada', age: 36 }), null);
  assert.equal(findSecretFieldInState({ password: 'x' }), 'password');
  assert.equal(findSecretFieldInState({ config: { apiKey: 'x' } }), 'apiKey');
  assert.equal(findSecretFieldInState({ nested: { deep: { accessToken: 'x' } } }), 'accessToken');
  assert.equal(findSecretFieldInState({ note: 'my password is safe' }), null, 'giá trị chứa từ password không tính — chỉ tên trường');
});

test('mrtr v16: ký + verify requestState; sai chữ ký / hết hạn thì ném', () => {
  const secret = 'test-secret-at-least-16-chars';
  const token = signMrtrV16RequestState(secret, {
    methodHash: sha256Hex('tools/call'),
    roundTripId: 'rt-1',
    round: 0,
    expiresAtMs: Date.now() + 60_000,
    inputCount: 1,
  });
  assert.ok(token.startsWith('v16.'));
  const state = verifyMrtrV16RequestState(secret, token);
  assert.equal(state.roundTripId, 'rt-1');
  assert.equal(state.round, 0);
  assert.equal(state.inputCount, 1);
  assert.throws(() => verifyMrtrV16RequestState(secret, `${token}x`), /chữ ký/);
  assert.throws(() => verifyMrtrV16RequestState('wrong-secret-123456', token), /chữ ký/);
  assert.throws(
    () => verifyMrtrV16RequestState(secret, token, Date.now() + 120_000),
    /hết hạn/,
  );
  assert.throws(
    () => signMrtrV16RequestState('short', { methodHash: 'x', roundTripId: 'r', round: 0, expiresAtMs: 1, inputCount: 0 }),
    /ít nhất 16 ký tự/,
  );
});

test('mrtr v16: parse input_required thiếu inputRequests thì ném; secret trong form thì ném', () => {
  assert.throws(
    () => parseMrtrV16Result({ resultType: 'input_required', inputRequests: [] }),
    /thiếu inputRequests/,
  );
  assert.throws(
    () =>
      parseMrtrV16Result({
        resultType: 'input_required',
        inputRequests: [{ id: 'api-key', prompt: 'Key?', mode: 'form', schema: { type: 'string', format: 'password' } }],
      }),
    /form mode bị cấm cho secret/,
  );
  const parsed = parseMrtrV16Result({
    resultType: 'input_required',
    inputRequests: [
      { id: 'project', prompt: 'Tên project?', mode: 'form', schema: { type: 'string' } },
      { id: 'oauth', prompt: 'Đăng nhập', mode: 'url', url: 'https://accounts.google.com/o/oauth2/auth' },
    ],
    requestState: 'opaque-state-123',
  });
  assert.equal(parsed.inputRequests.length, 2);
  assert.equal(parsed.inputRequests[1].mode, 'url');
  assert.equal(parsed.requestState, 'opaque-state-123');
  // Result thường (không có resultType) được coi là complete.
  const plain = parseMrtrV16Result({ content: [{ type: 'text', text: 'done' }] });
  assert.equal(plain.resultType, 'complete');
  // requestState chứa secret thì ném.
  assert.throws(
    () => parseMrtrV16Result({ resultType: 'complete', requestState: JSON.stringify({ apiKey: 'sk-x' }) }),
    /trường nhạy cảm/,
  );
});

test('mrtr v16: validate đáp án theo schema + required + decline', () => {
  const req = { id: 'count', prompt: 'Số lượng?', mode: 'form', schema: { type: 'integer' } };
  assert.equal(validateMrtrV16Response(req, { id: 'count', value: 3 }), null);
  assert.match(validateMrtrV16Response(req, { id: 'count', value: 3.5 }), /integer/);
  assert.match(validateMrtrV16Response(req, { id: 'count', value: 'ba' }), /integer/);
  assert.match(validateMrtrV16Response(req, undefined), /Thiếu đáp án/);
  assert.equal(
    validateMrtrV16Response(req, { id: 'count', value: 1, declined: true }),
    null,
    'decline là đáp án hợp lệ ở tầng validation — session mới quyết định dừng',
  );
  const optional = { id: 'nick', prompt: 'Nickname?', mode: 'form', required: false };
  assert.equal(validateMrtrV16Response(optional, undefined), null);
  assert.equal(validateMrtrV16Response(optional, { id: 'nick', value: null, declined: true }), null);
});

test('mrtr v16 session: input_required → thu đáp án → gọi lại method cũ kèm inputResponses + requestState', async () => {
  const calls = [];
  const callFn = async (method, params) => {
    calls.push({ method, params });
    if (calls.length === 1) {
      return {
        resultType: 'input_required',
        inputRequests: [
          { id: 'project-name', prompt: 'Tên project?', mode: 'form', schema: { type: 'string' } },
        ],
        requestState: 'server-opaque-state',
      };
    }
    return { resultType: 'complete', data: { created: params.inputResponses[0].value } };
  };
  let collectorCalls = 0;
  const collector = async (requests) => {
    collectorCalls += 1;
    return requests.map((r) => ({ id: r.id, value: 'open-bot' }));
  };
  const session = new MrtrV16Session(callFn, collector, { hmacSecret: 'test-secret-at-least-16-chars' });
  const outcome = await session.run('tools/call', { name: 'create-project' });
  assert.equal(outcome.completed, true);
  assert.equal(outcome.rounds, 2);
  assert.deepEqual(outcome.data, { created: 'open-bot' });
  assert.equal(collectorCalls, 1, 'collector chỉ hỏi một lần (idempotent)');
  assert.equal(session.cachedAnswers(), 1);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].method, 'tools/call', 'gọi lại đúng method cũ');
  assert.equal(calls[1].params.requestState, 'server-opaque-state');
  assert.deepEqual(calls[1].params.inputResponses, [{ id: 'project-name', value: 'open-bot' }]);
  assert.equal(calls[1].params._meta.roundTrip.round, 1);
  assert.equal(outcome.history.length, 2);
  assert.equal(outcome.history[0].resultType, 'input_required');
  assert.equal(outcome.history[1].resultType, 'complete');
});

test('mrtr v16 session: server không cấp state + có hmacSecret thì tự ký state; decline bắt buộc thì dừng', async () => {
  const calls = [];
  const callFn = async (_method, params) => {
    calls.push(params);
    if (calls.length === 1) {
      return {
        resultType: 'input_required',
        inputRequests: [{ id: 'confirm', prompt: 'Xác nhận?', mode: 'form' }],
      };
    }
    return { resultType: 'complete', data: { ok: true } };
  };
  const session = new MrtrV16Session(
    callFn,
    async (requests) => requests.map((r) => ({ id: r.id, value: 'yes' })),
    { hmacSecret: 'test-secret-at-least-16-chars' },
  );
  const outcome = await session.run('tools/call', {});
  assert.equal(outcome.completed, true);
  const selfSigned = calls[1].requestState;
  assert.equal(typeof selfSigned, 'string');
  assert.ok(selfSigned.startsWith('v16.'));
  const verified = verifyMrtrV16RequestState('test-secret-at-least-16-chars', selfSigned);
  assert.equal(verified.roundTripId, outcome.roundTripId);

  // Decline input bắt buộc → dừng, completed=false.
  const declineSession = new MrtrV16Session(
    async () => ({
      resultType: 'input_required',
      inputRequests: [{ id: 'note', prompt: 'Ghi chú?', mode: 'form' }],
    }),
    async (requests) => requests.map((r) => ({ id: r.id, value: null, declined: true })),
    {},
  );
  const declined = await declineSession.run('tools/call', {});
  assert.equal(declined.completed, false);
  assert.equal(declined.stoppedByDecline, true);
  assert.equal(declined.rounds, 1);
});

test('mrtr v16 session: vượt maxRounds thì ném; thiếu đáp án thì ném', async () => {
  const looping = new MrtrV16Session(
    async () => ({
      resultType: 'input_required',
      inputRequests: [{ id: 'more', prompt: 'Thêm?', mode: 'form' }],
    }),
    async (requests) => requests.map((r) => ({ id: r.id, value: 'x' })),
    { maxRounds: 2 },
  );
  await assert.rejects(() => looping.run('tools/call', {}), /vượt quá 2 vòng/);

  const missing = new MrtrV16Session(
    async () => ({
      resultType: 'input_required',
      inputRequests: [{ id: 'need', prompt: 'Cần?', mode: 'form' }],
    }),
    async () => [],
    {},
  );
  await assert.rejects(() => missing.run('tools/call', {}), /không có đáp án/);
});
