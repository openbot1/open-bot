/**
 * Test v1.10 T2: InputRequiredResult — MRTR theo MCP spec 2026-07-28 (node:test).
 * Local only, no live network: fake JSON-RPC transports script the rounds.
 *
 * Build core first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/mcp-input-required-v110.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCompleteResult2026,
  buildInputRequiredResult,
  buildInputRequiredRetryParams,
  extractInputRequiredFollowUp,
  extractInputRequiredResult,
  InputRequiredError,
  isInputRequiredResult,
  isSpecResultType2026,
  parseSpecResult2026,
  runInputRequiredLoop,
  runToolCallInputRequired,
  validateInputAgainstSchema,
  MCP_INPUT_REQUIRED_MAX_ROUNDS_DEFAULT,
} from '../packages/core/dist/mcp/inputRequired.js';

function scriptedTransport(script) {
  let i = 0;
  return {
    calls: [],
    async requestJsonRpc(method, params) {
      this.calls.push({ method, params });
      const step = script[i];
      i += 1;
      if (typeof step === 'function') return step(this.calls[this.calls.length - 1]);
      return step;
    },
  };
}

function toolResult(text) {
  return { content: [{ type: 'text', text }], isError: false };
}

test('parseSpecResult2026: complete result passes through', () => {
  const parsed = parseSpecResult2026({ resultType: 'complete', result: { ok: 1 }, roundTripId: 'rt-1', note: 'done' });
  assert.equal(parsed.resultType, 'complete');
  assert.deepEqual(parsed.result, { ok: 1 });
  assert.equal(parsed.roundTripId, 'rt-1');
  assert.equal(parsed.note, 'done');
});

test('parseSpecResult2026: input_required result keeps input + state', () => {
  const parsed = parseSpecResult2026({
    resultType: 'input_required',
    input: { prompt: 'City?', schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } },
    state: { step: 2 },
    roundTripId: 'rt-9',
  });
  assert.equal(parsed.resultType, 'input_required');
  assert.equal(parsed.input.prompt, 'City?');
  assert.deepEqual(parsed.state, { step: 2 });
  assert.equal(parsed.roundTripId, 'rt-9');
});

test('parseSpecResult2026: result WITHOUT resultType is a protocol error (strict 2026)', () => {
  assert.throws(
    () => parseSpecResult2026(toolResult('done')),
    (err) => err instanceof InputRequiredError && /thiếu "resultType"/.test(err.message),
  );
  assert.throws(
    () => parseSpecResult2026('plain string'),
    (err) => err instanceof InputRequiredError,
  );
});

test('parseSpecResult2026: unknown resultType is a protocol error', () => {
  assert.throws(
    () => parseSpecResult2026({ resultType: 'needs_input' }),
    (err) => err instanceof InputRequiredError && /không hợp lệ/.test(err.message),
  );
});

test('isSpecResultType2026 / isInputRequiredResult', () => {
  assert.equal(isSpecResultType2026('complete'), true);
  assert.equal(isSpecResultType2026('input_required'), true);
  assert.equal(isSpecResultType2026('needs_input'), false);
  assert.equal(isSpecResultType2026(undefined), false);
  assert.equal(isInputRequiredResult({ resultType: 'input_required', input: {} }), true);
  assert.equal(isInputRequiredResult({ resultType: 'complete', result: 1 }), false);
  assert.equal(isInputRequiredResult({ resultType: 'input_required' }), false);
  assert.equal(isInputRequiredResult(null), false);
});

test('buildInputRequiredResult / buildCompleteResult2026 round-trip through parse', () => {
  const built = buildInputRequiredResult(
    { prompt: 'Pick a city', schema: { type: 'object', properties: { city: { type: 'string' } } } },
    { state: { step: 1 }, roundTripId: 'rt-1', note: 'need city' },
  );
  const parsed = parseSpecResult2026(built);
  assert.equal(parsed.resultType, 'input_required');
  assert.equal(parsed.input.prompt, 'Pick a city');
  assert.deepEqual(parsed.state, { step: 1 });
  const done = buildCompleteResult2026({ ok: true }, { roundTripId: 'rt-1' });
  assert.equal(parseSpecResult2026(done).resultType, 'complete');
});

test('validateInputAgainstSchema: types, required, enum, ranges, pattern', () => {
  const schema = {
    type: 'object',
    properties: {
      city: { type: 'string', minLength: 2 },
      age: { type: 'integer', minimum: 0, maximum: 150 },
      tier: { type: 'string', enum: ['free', 'pro'] },
      code: { type: 'string', pattern: '^[A-Z]{3}$' },
    },
    required: ['city', 'age'],
    additionalProperties: false,
  };
  assert.deepEqual(validateInputAgainstSchema({ city: 'HN', age: 30, tier: 'pro', code: 'ABC' }, schema), { valid: true, issues: [] });
  const bad = validateInputAgainstSchema({ age: -1, tier: 'vip', code: 'ab1', extra: 1 }, schema);
  assert.equal(bad.valid, false);
  const paths = bad.issues.map((i) => i.path);
  assert.ok(paths.includes('city'), 'missing required city reported');
  assert.ok(paths.includes('age'), 'age below minimum reported');
  assert.ok(paths.includes('tier'), 'tier outside enum reported');
  assert.ok(paths.includes('code'), 'code pattern mismatch reported');
  assert.ok(paths.includes('extra'), 'additional property reported');
  // No schema => always valid. Nested objects + arrays validate recursively.
  assert.equal(validateInputAgainstSchema({ anything: 1 }, undefined).valid, true);
  const nested = validateInputAgainstSchema(
    { tags: ['a', 2] },
    { type: 'object', properties: { tags: { type: 'array', items: { type: 'string' } } } },
  );
  assert.equal(nested.valid, false);
  assert.ok(nested.issues.some((i) => i.path === 'tags[1]'));
});

test('runInputRequiredLoop: single round complete', async () => {
  const transport = scriptedTransport([buildCompleteResult2026(toolResult('done'))]);
  let providerCalls = 0;
  const out = await runInputRequiredLoop(transport, 'tools/call', { name: 'echo' }, async () => {
    providerCalls += 1;
    return { answer: {} };
  });
  assert.equal(out.rounds, 1);
  assert.deepEqual(out.result, toolResult('done'));
  assert.equal(providerCalls, 0);
});

test('runInputRequiredLoop: multi-round input, answer + state retried on the ORIGINAL request', async () => {
  const transport = scriptedTransport([
    buildInputRequiredResult(
      { prompt: 'City?', schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } },
      { state: { step: 1 }, roundTripId: 'rt-1' },
    ),
    buildInputRequiredResult(
      { prompt: 'District?', schema: { type: 'object', properties: { district: { type: 'string' } }, required: ['district'] } },
      { state: { step: 2 }, roundTripId: 'rt-1' },
    ),
    buildCompleteResult2026(toolResult('weather: Hanoi 30C'), { roundTripId: 'rt-1' }),
  ]);
  const seen = [];
  const out = await runInputRequiredLoop(
    transport,
    'tools/call',
    { name: 'weather', arguments: {} },
    async (request, round, serverState) => {
      seen.push({ round, prompt: request.prompt, serverState });
      if (round === 1) return { answer: { city: 'Hanoi' }, state: { step: 2 } };
      return { answer: { district: 'Hoan Kiem' } };
    },
  );
  assert.equal(out.rounds, 3);
  assert.deepEqual(out.result, toolResult('weather: Hanoi 30C'));
  assert.equal(out.roundTripId, 'rt-1');
  assert.equal(out.history.length, 3);
  assert.deepEqual(out.history.map((h) => h.resultType), ['input_required', 'input_required', 'complete']);
  // Provider saw the server state from round 1.
  assert.deepEqual(seen[0].serverState, { step: 1 });
  assert.deepEqual(seen[1].serverState, { step: 2 });
  // Every retry re-sends the ORIGINAL request (same method + name) with answer + state.
  assert.equal(transport.calls.length, 3);
  for (const call of transport.calls) {
    assert.equal(call.method, 'tools/call');
    assert.equal(call.params.name, 'weather');
  }
  assert.deepEqual(transport.calls[1].params.answer, { city: 'Hanoi' });
  assert.deepEqual(transport.calls[1].params.state, { step: 2 });
  assert.equal(transport.calls[1].params.roundTripId, 'rt-1');
  assert.equal(transport.calls[1].params.round, 2);
  assert.deepEqual(transport.calls[2].params.answer, { district: 'Hoan Kiem' });
});

test('runInputRequiredLoop: answer failing the schema is rejected BEFORE retry', async () => {
  const transport = scriptedTransport([
    buildInputRequiredResult({
      prompt: 'Age?',
      schema: { type: 'object', properties: { age: { type: 'integer', minimum: 0 } }, required: ['age'] },
    }),
    buildCompleteResult2026(toolResult('ok')),
  ]);
  await assert.rejects(
    () => runInputRequiredLoop(transport, 'tools/call', { name: 't' }, async () => ({ answer: { age: -5 } })),
    (err) => err instanceof InputRequiredError && /không khớp schema/.test(err.message),
  );
  // No retry was sent: only the first request went out.
  assert.equal(transport.calls.length, 1);
});

test('runInputRequiredLoop: provider refusing (throw) stops the loop', async () => {
  const transport = scriptedTransport([
    buildInputRequiredResult({ prompt: 'Secret?' }),
  ]);
  await assert.rejects(
    () => runInputRequiredLoop(transport, 'tools/call', { name: 't' }, async () => {
      throw new Error('user refused');
    }),
    /user refused/,
  );
  assert.equal(transport.calls.length, 1);
});

test('runInputRequiredLoop: maxRounds budget stops an endless server', async () => {
  const script = Array.from({ length: 12 }, () =>
    buildInputRequiredResult({ prompt: 'More?' }),
  );
  const transport = scriptedTransport(script);
  await assert.rejects(
    () => runInputRequiredLoop(transport, 'tools/call', { name: 't' }, async () => ({ answer: { x: 1 } }), { maxRounds: 3 }),
    (err) => err instanceof InputRequiredError && /vượt quá 3 round/.test(err.message),
  );
  assert.equal(transport.calls.length, 3);
});

test('runInputRequiredLoop: legacy server without resultType fails fast (use the old mrtr driver)', async () => {
  const transport = scriptedTransport([toolResult('done')]);
  await assert.rejects(
    () => runInputRequiredLoop(transport, 'tools/call', { name: 't' }, async () => ({ answer: {} })),
    (err) => err instanceof InputRequiredError && /thiếu "resultType"/.test(err.message),
  );
});

test('runToolCallInputRequired: one-line tools/call through the loop', async () => {
  const transport = scriptedTransport([
    buildInputRequiredResult({ prompt: 'City?' }, { roundTripId: 'rt-7' }),
    buildCompleteResult2026(toolResult('ok'), { roundTripId: 'rt-7' }),
  ]);
  const out = await runToolCallInputRequired(transport, 'weather', {}, async () => ({ answer: { city: 'Hanoi' } }));
  assert.equal(out.rounds, 2);
  assert.equal(out.roundTripId, 'rt-7');
  assert.equal(transport.calls[0].params.name, 'weather');
});

test('buildInputRequiredRetryParams: carries state in _meta.roundTrip too', () => {
  const params = buildInputRequiredRetryParams({ name: 't', arguments: {} }, 'rt-1', 2, { a: 1 }, { step: 2 });
  assert.deepEqual(params.answer, { a: 1 });
  assert.deepEqual(params.state, { step: 2 });
  assert.equal(params.roundTripId, 'rt-1');
  assert.equal(params.round, 2);
  assert.equal(params._meta.roundTrip.roundTripId, 'rt-1');
  assert.equal(params._meta.roundTrip.round, 2);
  assert.deepEqual(params._meta.roundTrip.state, { step: 2 });
  // Original params untouched.
  assert.equal(params.name, 't');
});

test('extractInputRequiredResult / extractInputRequiredFollowUp (server side)', () => {
  const handlerResult = {
    resultType: 'input_required',
    input: { prompt: 'City?', schema: { type: 'object' } },
    state: { step: 1 },
    roundTripId: 'rt-1',
    note: 'need city',
  };
  const extracted = extractInputRequiredResult(handlerResult);
  assert.ok(extracted);
  assert.equal(extracted.resultType, 'input_required');
  assert.equal(extracted.input.prompt, 'City?');
  assert.deepEqual(extracted.state, { step: 1 });
  assert.equal(extractInputRequiredResult({ content: [{ type: 'text', text: 'hi' }] }), null);
  assert.equal(extractInputRequiredResult({ resultType: 'needs_input', need: {} }), null);
  assert.equal(extractInputRequiredResult(null), null);

  const followUp = extractInputRequiredFollowUp({
    name: 'weather',
    answer: { city: 'Hanoi' },
    state: { step: 2 },
    roundTripId: 'rt-1',
    round: 2,
  });
  assert.deepEqual(followUp.answer, { city: 'Hanoi' });
  assert.deepEqual(followUp.state, { step: 2 });
  assert.equal(followUp.roundTripId, 'rt-1');
  assert.equal(followUp.round, 2);
  assert.equal(extractInputRequiredFollowUp({ name: 'weather', arguments: {} }), null);
});

test('MCP_INPUT_REQUIRED_MAX_ROUNDS_DEFAULT is 8', () => {
  assert.equal(MCP_INPUT_REQUIRED_MAX_ROUNDS_DEFAULT, 8);
});
