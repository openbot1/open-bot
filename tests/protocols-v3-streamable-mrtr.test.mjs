/**
 * Tests for v1.19 (Team T3) — protocols v3, part 2:
 * packages/core/src/protocolsV3/streamableHttpV3.ts
 * packages/core/src/protocolsV3/mrtrV3.ts
 *
 * Covers:
 *  - SSE chunk parsing: id / event / multi-line data, comments,
 *    CRLF, incomplete trailing chunk as leftover, oversize events
 *    dropped + counted, JSON-RPC payload parsing (bad JSON / non
 *    object -> null).
 *  - Resume store: record / last id / counts / forget / urls.
 *  - Streamable HTTP transport (fake fetch only, no network):
 *    JSON answer, SSE answer (+ resume recording), 202 Accepted,
 *    HTTP error, bad JSON, non-object JSON, bad URL, missing
 *    fetchFn, legacy mode flag + closeLegacy gate, GET stream
 *    delivery + close, per-request timeout.
 *  - MRTR v3: result-type normalisation (input_required alias),
 *    answer validation against the server schema, driver happy
 *    path (single + multi round, transcript + history), wire
 *    `input_required` accepted (regression test for the
 *    pre-normalise fix), invalid answer rejected, confirmation
 *    denied, round budget, deprecated sampling blocked by the
 *    gate, cancellation, per-round timeout, server-side helper
 *    (input_required step + complete step).
 *
 * No network, no model. Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/protocols-v3-streamable-mrtr.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  STREAMABLE_HTTP_V3_MAX_BUFFERED_EVENTS,
  STREAMABLE_HTTP_V3_MAX_EVENT_BYTES,
  STREAMABLE_HTTP_V3_TIMEOUT_MS,
  StreamableHttpV3Error,
  StreamableHttpV3Transport,
  V3ResumeStore,
  buildFakeV3Fetch,
  parseV3SseChunk,
  parseV3SseJsonRpc,
} from '../packages/core/dist/protocolsV3/streamableHttpV3.js';
import {
  MRTR_V3_DEPRECATED_TYPES,
  MRTR_V3_FOLLOW_UP_TYPES,
  MrtrV3Driver,
  MrtrV3Error,
  MrtrV3Server,
  buildMrtrV3InputRequired,
  isMrtrV3InputRequired,
  normaliseMrtrV3ResultType,
  validateMrtrV3Answer,
} from '../packages/core/dist/protocolsV3/mrtrV3.js';
import { DeprecatedFeatureGate } from '../packages/core/dist/protocolsV3/mcpStatelessV3.js';

const URL = 'https://example.test/mcp';

// ---------------------------------------------------------------------------
// SSE parsing
// ---------------------------------------------------------------------------

test('v3 sse: parse id/event/data, multi-line data, comments, CRLF', () => {
  const { events, leftover, dropped } = parseV3SseChunk(
    ': a comment\r\nid: e1\r\nevent: message\r\ndata: {"a":1}\r\ndata: {"b":2}\r\n\r\n',
  );
  assert.equal(dropped, 0);
  assert.equal(leftover, '');
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], { id: 'e1', event: 'message', data: '{"a":1}\n{"b":2}' });

  const two = parseV3SseChunk('data: one\n\ndata: two\n\n');
  assert.equal(two.events.length, 2);
  assert.equal(two.events[0].data, 'one');
  assert.equal(two.events[1].data, 'two');
  assert.equal(two.events[0].id, undefined);

  // An event without data but with an id still counts.
  const idOnly = parseV3SseChunk('id: keep-alive\n\n');
  assert.equal(idOnly.events.length, 1);
  assert.equal(idOnly.events[0].id, 'keep-alive');
});

test('v3 sse: incomplete trailing chunk is leftover; oversize events dropped', () => {
  const { events, leftover } = parseV3SseChunk('data: full\n\nid: e2\ndata: par');
  assert.equal(events.length, 1);
  assert.equal(events[0].data, 'full');
  assert.equal(leftover, 'id: e2\ndata: par');

  // The leftover completes on the next chunk.
  const next = parseV3SseChunk(`${leftover}tial\n\n`);
  assert.equal(next.events.length, 1);
  assert.equal(next.events[0].id, 'e2');
  assert.equal(next.events[0].data, 'partial');

  const big = parseV3SseChunk(`data: ${'x'.repeat(100)}\n\n`, { maxEventBytes: 10 });
  assert.equal(big.events.length, 0);
  assert.equal(big.dropped, 1);
  assert.equal(STREAMABLE_HTTP_V3_MAX_EVENT_BYTES, 4 * 1024 * 1024);
});

test('v3 sse: parse JSON-RPC payload (bad JSON / non-object -> null)', () => {
  assert.deepEqual(
    parseV3SseJsonRpc({ data: '{"jsonrpc":"2.0","id":1,"result":{}}' }),
    { jsonrpc: '2.0', id: 1, result: {} },
  );
  assert.equal(parseV3SseJsonRpc({ data: 'not json' }), null);
  assert.equal(parseV3SseJsonRpc({ data: '[1,2]' }), null);
  assert.equal(parseV3SseJsonRpc({ data: '' }), null);
});

test('v3 resume store: record / last id / counts / forget / urls', () => {
  const store = new V3ResumeStore();
  assert.equal(store.lastEventId(URL), undefined);
  assert.equal(store.eventCount(URL), 0);
  store.record(URL, 'e1');
  store.record(URL, 'e2');
  store.record(URL, undefined); // counts, but keeps the last id
  assert.equal(store.lastEventId(URL), 'e2');
  assert.equal(store.eventCount(URL), 3);
  assert.deepEqual(store.urls(), [URL]);
  store.forget(URL);
  assert.equal(store.lastEventId(URL), undefined);
  assert.equal(store.eventCount(URL), 0);
  assert.deepEqual(store.urls(), []);
});

// ---------------------------------------------------------------------------
// Streamable HTTP transport (fake fetch)
// ---------------------------------------------------------------------------

function jsonTransport(body, extraHeaders) {
  const fetchFn = buildFakeV3Fetch({
    [`POST ${URL}`]: { status: 200, body, headers: extraHeaders },
  });
  return new StreamableHttpV3Transport({ fetchFn });
}

test('v3 transport: JSON answer + server protocol version header', async () => {
  const transport = jsonTransport('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}', {
    'MCP-Protocol-Version': '2026-07-28',
  });
  const out = await transport.postJsonRpc(URL, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.equal(out.mode, 'json');
  assert.equal(out.status, 200);
  assert.equal(out.serverProtocolVersion, '2026-07-28');
  assert.equal(out.messages.length, 1);
  assert.deepEqual(out.messages[0].message.result, { ok: true });
  assert.equal(out.droppedEvents, 0);
});

test('v3 transport: SSE answer records resume ids; 202 Accepted has no messages', async () => {
  const sse = new StreamableHttpV3Transport({
    fetchFn: buildFakeV3Fetch({
      [`POST ${URL}`]: {
        status: 200,
        contentType: 'text/event-stream',
        body: 'id: e1\ndata: {"jsonrpc":"2.0","id":1,"result":{"a":1}}\n\n'
          + 'id: e2\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\n',
      },
    }),
  });
  const out = await sse.postJsonRpc(URL, { jsonrpc: '2.0', id: 1, method: 'tools/call' });
  assert.equal(out.mode, 'sse');
  assert.equal(out.messages.length, 2);
  assert.equal(out.messages[0].eventId, 'e1');
  assert.equal(out.messages[1].eventType, undefined);
  assert.equal(sse.getResumeStore().lastEventId(URL), 'e2');
  assert.equal(sse.getResumeStore().eventCount(URL), 2);

  const accepted = new StreamableHttpV3Transport({
    fetchFn: buildFakeV3Fetch({ [`POST ${URL}`]: { status: 202, body: '' } }),
  });
  const acc = await accepted.postJsonRpc(URL, { jsonrpc: '2.0', id: 2, method: 'tools/call' });
  assert.equal(acc.mode, 'accepted');
  assert.deepEqual(acc.messages, []);
  assert.equal(acc.status, 202);
});

test('v3 transport: HTTP error / bad JSON / non-object / bad URL / no fetch', async () => {
  const failing = new StreamableHttpV3Transport({
    fetchFn: buildFakeV3Fetch({ [`POST ${URL}`]: { status: 500, body: 'boom' } }),
  });
  await assert.rejects(
    () => failing.postJsonRpc(URL, { jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    (err) => err instanceof StreamableHttpV3Error && err.code === 'HTTP_ERROR' && err.status === 500,
  );

  const badJson = jsonTransport('{not json');
  await assert.rejects(
    () => badJson.postJsonRpc(URL, { jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    (err) => err instanceof StreamableHttpV3Error && err.code === 'BAD_JSON',
  );
  const nonObject = jsonTransport('[1,2]');
  await assert.rejects(
    () => nonObject.postJsonRpc(URL, { jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    (err) => err instanceof StreamableHttpV3Error && err.code === 'BAD_JSON',
  );

  const transport = jsonTransport('{}');
  await assert.rejects(
    () => transport.postJsonRpc('ftp://example.test/mcp', {}),
    (err) => err instanceof StreamableHttpV3Error && err.code === 'BAD_URL',
  );
  assert.throws(
    () => new StreamableHttpV3Transport({ fetchFn: undefined }),
    (err) => err instanceof StreamableHttpV3Error && err.code === 'NO_FETCH',
  );
  assert.equal(STREAMABLE_HTTP_V3_TIMEOUT_MS, 30_000);
  assert.equal(STREAMABLE_HTTP_V3_MAX_BUFFERED_EVENTS, 500);
});

test('v3 transport: legacy mode flag + closeLegacy gate', async () => {
  const plain = jsonTransport('{"jsonrpc":"2.0","id":1,"result":{}}');
  assert.equal(plain.legacyUsed, false);
  await plain.postJsonRpc(URL, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.equal(plain.legacyUsed, false);
  await assert.rejects(
    () => plain.closeLegacy(URL),
    (err) => err instanceof StreamableHttpV3Error && err.code === 'NO_SESSION',
  );

  const legacy = new StreamableHttpV3Transport({
    fetchFn: buildFakeV3Fetch({
      [`POST ${URL}`]: { status: 200, body: '{"jsonrpc":"2.0","id":1,"result":{}}' },
      [`DELETE ${URL}`]: { status: 200, body: '' },
    }),
    legacyHttpSse: true,
    legacySessionId: 'sess-1',
  });
  await legacy.postJsonRpc(URL, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.equal(legacy.legacyUsed, true);
  await legacy.closeLegacy(URL); // DELETE sent, no throw
});

test('v3 transport: GET stream delivers messages and close() stops it', async () => {
  const transport = new StreamableHttpV3Transport({
    fetchFn: buildFakeV3Fetch({
      [`GET ${URL}`]: {
        status: 200,
        contentType: 'text/event-stream',
        body: 'id: g1\ndata: {"jsonrpc":"2.0","method":"notifications/message","params":{"text":"hi"}}\n\n',
      },
    }),
    reconnectDelayMs: 1,
  });
  const received = [];
  const close = await transport.openGetStream(URL, (msg) => received.push(msg));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(received.length, 1);
  assert.equal(received[0].message.method, 'notifications/message');
  assert.equal(received[0].eventId, 'g1');
  assert.equal(transport.getResumeStore().lastEventId(URL), 'g1');
  close();
  assert.equal(transport.isGetStreamOpen(), false);
});

test('v3 transport: per-request timeout', async () => {
  const hangingFetch = (_url, init) => new Promise((_resolve, reject) => {
    const signal = init?.signal;
    if (signal) {
      signal.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
    }
  });
  const transport = new StreamableHttpV3Transport({ fetchFn: hangingFetch, timeoutMs: 20 });
  await assert.rejects(
    () => transport.postJsonRpc(URL, { jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    (err) => err instanceof StreamableHttpV3Error && err.code === 'TIMEOUT',
  );
});

// ---------------------------------------------------------------------------
// MRTR v3: types + answer validation
// ---------------------------------------------------------------------------

test('v3 mrtr: result-type normalisation + follow-up / deprecated sets', () => {
  assert.equal(normaliseMrtrV3ResultType('input_required'), 'input_required');
  assert.equal(normaliseMrtrV3ResultType('needs_input'), 'input_required');
  assert.equal(normaliseMrtrV3ResultType('complete'), 'complete');
  assert.equal(normaliseMrtrV3ResultType('needs_sampling'), 'needs_sampling');
  assert.equal(normaliseMrtrV3ResultType('bogus'), null);
  assert.equal(normaliseMrtrV3ResultType(123), null);
  assert.equal(isMrtrV3InputRequired('input_required'), true);
  assert.equal(isMrtrV3InputRequired('needs_input'), true);
  assert.equal(isMrtrV3InputRequired('complete'), false);
  assert.deepEqual([...MRTR_V3_FOLLOW_UP_TYPES], [
    'input_required', 'needs_input', 'needs_sampling',
    'needs_elicitation', 'needs_roots', 'needs_confirmation',
  ]);
  assert.deepEqual([...MRTR_V3_DEPRECATED_TYPES], ['needs_sampling', 'needs_roots']);
});

test('v3 mrtr: answer validation against the server schema', () => {
  assert.deepEqual(validateMrtrV3Answer({ a: 1 }, undefined), []);
  assert.deepEqual(validateMrtrV3Answer('text', undefined), []);
  const schema = {
    required: ['name', 'age'],
    properties: { name: { type: 'string' }, age: { type: 'integer' }, tags: { type: 'array' } },
  };
  assert.deepEqual(validateMrtrV3Answer({ name: 'Bot', age: 3 }, schema), []);
  // Extra keys are allowed.
  assert.deepEqual(validateMrtrV3Answer({ name: 'Bot', age: 3, extra: true }, schema), []);
  const missing = validateMrtrV3Answer({ name: 'Bot' }, schema);
  assert.equal(missing.length, 1);
  assert.match(missing[0], /Missing required field: age/);
  const wrongType = validateMrtrV3Answer({ name: 'Bot', age: 2.5 }, schema);
  assert.equal(wrongType.length, 1);
  assert.match(wrongType[0], /Field age must be integer, got number/);
  const notObject = validateMrtrV3Answer('nope', schema);
  assert.equal(notObject.length, 1);
  assert.match(notObject[0], /must be an object/);
});

// ---------------------------------------------------------------------------
// MRTR v3: driver
// ---------------------------------------------------------------------------

/** Fake transport: answers each round from a scripted list. */
function scriptedTransport(script) {
  let i = 0;
  const seenParams = [];
  return {
    seenParams,
    async requestJsonRpc(method, params) {
      seenParams.push({ method, params });
      const step = script[Math.min(i, script.length - 1)];
      i += 1;
      return typeof step === 'function' ? step(params) : step;
    },
  };
}

test('v3 mrtr driver: single-round complete + multi-round input flow', async () => {
  const single = scriptedTransport([{ resultType: 'complete', result: { ok: 1 } }]);
  const driver = new MrtrV3Driver();
  const out = await driver.run(single, 'tools/call', { x: 1 }, {});
  assert.deepEqual(out.result, { ok: 1 });
  assert.equal(out.rounds, 1);
  assert.equal(out.history.length, 1);
  assert.equal(out.history[0].resultType, 'complete');
  assert.deepEqual(out.transcript, []);
  assert.ok(out.totalMs >= 0);
  assert.equal(single.seenParams.length, 1);

  const rounds = [];
  const transcripts = [];
  const multi = scriptedTransport([
    buildMrtrV3InputRequired({
      prompt: 'Your name?',
      schema: { required: ['name'], properties: { name: { type: 'string' } } },
      roundTripId: 'rt-1',
    }),
    { resultType: 'complete', result: 'hello Bot', roundTripId: 'rt-1' },
  ]);
  const driver2 = new MrtrV3Driver({
    onRound: (r) => rounds.push(r),
    onTranscript: (t) => transcripts.push(t),
  });
  const out2 = await driver2.run(multi, 'tools/call', {}, {
    onNeedsInput: async () => ({ name: 'Bot' }),
  });
  assert.equal(out2.result, 'hello Bot');
  assert.equal(out2.rounds, 2);
  assert.equal(out2.roundTripId, 'rt-1');
  assert.equal(out2.history[0].resultType, 'needs_input');
  assert.equal(out2.history[1].resultType, 'complete');
  // Transcript records the canonical v3 name, not the v1 alias.
  assert.equal(transcripts.length, 1);
  assert.equal(transcripts[0].resultType, 'input_required');
  assert.deepEqual(transcripts[0].answerKeys, ['name']);
  assert.match(transcripts[0].needSummary, /Your name\?/);
  assert.equal(rounds.length, 2);
  // The follow-up carries the answer + stateless continuation in _meta.
  assert.equal(multi.seenParams[1].params.answer.name, 'Bot');
  assert.equal(multi.seenParams[1].params._meta.roundTrip.roundTripId, 'rt-1');
});

test('v3 mrtr driver: wire input_required is accepted (canonical v3 name)', async () => {
  const transport = scriptedTransport([
    { resultType: 'input_required', need: { prompt: 'Pick one', schema: { required: ['choice'] } }, roundTripId: 'rt-9' },
    { resultType: 'complete', result: 'picked', roundTripId: 'rt-9' },
  ]);
  const driver = new MrtrV3Driver();
  const out = await driver.run(transport, 'tools/call', {}, {
    onNeedsInput: async () => ({ choice: 'a' }),
  });
  assert.equal(out.result, 'picked');
  assert.equal(out.rounds, 2);
  assert.equal(out.transcript[0].resultType, 'input_required');
});

test('v3 mrtr driver: invalid answer, denied confirmation, budget, cancel', async () => {
  // Answer fails the server schema.
  const bad = scriptedTransport([
    buildMrtrV3InputRequired({ schema: { required: ['name'] } }),
    { resultType: 'complete', result: null },
  ]);
  await assert.rejects(
    () => new MrtrV3Driver().run(bad, 'tools/call', {}, { onNeedsInput: async () => ({}) }),
    (err) => err instanceof MrtrV3Error && err.code === 'INVALID_ANSWER',
  );

  // User denies confirmation.
  const deny = scriptedTransport([
    { resultType: 'needs_confirmation', need: { prompt: 'Proceed?' } },
    { resultType: 'complete', result: null },
  ]);
  await assert.rejects(
    () => new MrtrV3Driver().run(deny, 'tools/call', {}, { onNeedsConfirmation: async () => false }),
    (err) => err instanceof MrtrV3Error && err.code === 'CONFIRMATION_DENIED',
  );
  // ...but approving lets it finish.
  const allow = scriptedTransport([
    { resultType: 'needs_confirmation', need: { prompt: 'Proceed?' } },
    { resultType: 'complete', result: 'done' },
  ]);
  const allowed = await new MrtrV3Driver().run(allow, 'tools/call', {}, { onNeedsConfirmation: async () => true });
  assert.equal(allowed.result, 'done');

  // Round budget: server keeps asking.
  const endless = scriptedTransport([
    buildMrtrV3InputRequired({ prompt: 'again?' }),
  ]);
  await assert.rejects(
    () => new MrtrV3Driver({ maxRounds: 2 }).run(endless, 'tools/call', {}, { onNeedsInput: async () => ({ x: 1 }) }),
    (err) => err instanceof MrtrV3Error && err.code === 'ROUND_BUDGET_EXCEEDED' && err.round === 2,
  );
  assert.throws(
    () => new MrtrV3Driver({ maxRounds: 0 }),
    (err) => err instanceof MrtrV3Error && err.code === 'BAD_BUDGET',
  );

  // Cancel before the first round.
  const driver = new MrtrV3Driver();
  driver.cancel();
  assert.equal(driver.isCancelled(), true);
  await assert.rejects(
    () => driver.run(scriptedTransport([{ resultType: 'complete', result: 1 }]), 'tools/call', {}, {}),
    (err) => err instanceof MrtrV3Error && err.code === 'CANCELLED',
  );
});

test('v3 mrtr driver: deprecated sampling blocked by the gate; timeout per round', async () => {
  const blockingGate = new DeprecatedFeatureGate({ sampling: 'block' });
  const sampling = scriptedTransport([
    { resultType: 'needs_sampling', need: { prompt: 'sample this' } },
    { resultType: 'complete', result: null },
  ]);
  await assert.rejects(
    () => new MrtrV3Driver({ deprecationGate: blockingGate }).run(
      sampling, 'tools/call', {}, { onNeedsSampling: async () => 'text' },
    ),
    (err) => err instanceof MrtrV3Error && err.code === 'DEPRECATED_BLOCKED',
  );
  // Same server, warn gate (default): the round proceeds.
  const warned = scriptedTransport([
    { resultType: 'needs_sampling', need: { prompt: 'sample this' } },
    { resultType: 'complete', result: 'ok' },
  ]);
  const driver = new MrtrV3Driver();
  const out = await driver.run(warned, 'tools/call', {}, { onNeedsSampling: async () => 'text' });
  assert.equal(out.result, 'ok');
  assert.equal(driver.getDeprecationGate().getNotices().length, 1);

  // A round that never answers trips the per-round timeout.
  const hanging = { async requestJsonRpc() { return new Promise(() => {}); } };
  await assert.rejects(
    () => new MrtrV3Driver({ roundTimeoutMs: 20 }).run(hanging, 'tools/call', {}, {}),
    (err) => err instanceof MrtrV3Error && err.code === 'ROUND_TIMEOUT',
  );
});

test('v3 mrtr server: input_required step then complete step', () => {
  const server = new MrtrV3Server('rt-fixed');
  assert.equal(server.getRoundTripId(), 'rt-fixed');
  const first = server.step({}, () => ({
    need: { resultType: 'input_required', prompt: 'Name?' },
  }));
  assert.equal(first.resultType, 'needs_input');
  assert.equal(first.need.prompt, 'Name?');
  assert.equal(first.roundTripId, 'rt-fixed');
  const done = server.step({ round1: { name: 'Bot' } }, () => ({ result: 'hello Bot' }));
  assert.equal(done.resultType, 'complete');
  assert.equal(done.result, 'hello Bot');
  // A step with no need and no result completes with null.
  const empty = server.step({}, () => ({}));
  assert.equal(empty.resultType, 'complete');
  assert.equal(empty.result, null);
});
