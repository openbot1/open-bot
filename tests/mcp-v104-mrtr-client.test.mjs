/**
 * Test v1.04 T2: MRTR wired into tool calls (node:test).
 * Local only, no network: fake JSON-RPC transports drive the rounds.
 *
 * Build core first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/mcp-v104-mrtr-client.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDefaultMrtrHandlers,
  extractMrtrToolResult,
  mrtrCoveredKinds,
  runToolCallMultiRoundTrip,
} from '../packages/core/dist/mcp/mrtrClient.js';
import { MrtrError } from '../packages/core/dist/mcp/mrtr.js';

function toolResult(text) {
  return { content: [{ type: 'text', text }], isError: false };
}

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

test('legacy server (no resultType) finishes in one round', async () => {
  const transport = scriptedTransport([toolResult('done')]);
  const out = await runToolCallMultiRoundTrip(transport, 'echo', { text: 'hi' }, {});
  assert.equal(out.rounds, 1);
  assert.deepEqual(out.result, toolResult('done'));
  assert.equal(transport.calls[0].method, 'tools/call');
  assert.equal(transport.calls[0].params.name, 'echo');
});

test('needs_input round merges the answer and completes', async () => {
  const transport = scriptedTransport([
    {
      resultType: 'needs_input',
      roundTripId: 'rt-1',
      need: { prompt: 'Thiếu trường city' },
    },
    { resultType: 'complete', result: toolResult('weather: Hanoi 30C') },
  ]);
  const out = await runToolCallMultiRoundTrip(
    transport,
    'weather',
    { city: '' },
    buildDefaultMrtrHandlers({
      onNeedsInput: async (need) => {
        assert.match(need.prompt, /city/);
        return { city: 'Hanoi' };
      },
    }),
  );
  assert.equal(out.rounds, 2);
  assert.equal(out.roundTripId, 'rt-1');
  assert.deepEqual(out.result, toolResult('weather: Hanoi 30C'));
  // Round 2 carries the round-trip continuation + the answer.
  assert.equal(transport.calls[1].params.answer.city, 'Hanoi');
  assert.equal(transport.calls[1].params.roundTripId, 'rt-1');
});

test('needs_elicitation + needs_confirmation chain through handlers', async () => {
  const transport = scriptedTransport([
    { resultType: 'needs_elicitation', need: { prompt: 'Email?' } },
    { resultType: 'needs_confirmation', need: { prompt: 'Gửi mail?' } },
    { resultType: 'complete', result: toolResult('sent') },
  ]);
  const seen = [];
  const out = await runToolCallMultiRoundTrip(
    transport,
    'send-mail',
    {},
    buildDefaultMrtrHandlers({
      onNeedsElicitation: async () => {
        seen.push('elicit');
        return { email: 'a@b.c' };
      },
      onNeedsConfirmation: async () => {
        seen.push('confirm');
        return true;
      },
      onRound: (record) => seen.push(record.resultType),
    }),
  );
  assert.equal(out.rounds, 3);
  assert.deepEqual(seen, ['needs_elicitation', 'elicit', 'needs_confirmation', 'confirm', 'complete']);
});

test('confirmation refused aborts with MrtrError, no follow-up sent', async () => {
  const transport = scriptedTransport([
    { resultType: 'needs_confirmation', need: { prompt: 'Xoá file?' } },
  ]);
  await assert.rejects(
    () =>
      runToolCallMultiRoundTrip(
        transport,
        'delete',
        {},
        buildDefaultMrtrHandlers({ onNeedsConfirmation: async () => false }),
      ),
    (err) => err instanceof MrtrError && /từ chối/.test(err.message),
  );
  assert.equal(transport.calls.length, 1);
});

test('missing handler for the asked kind fails loudly, never invents an answer', async () => {
  const transport = scriptedTransport([
    { resultType: 'needs_sampling', need: { prompt: 'Summarize' } },
  ]);
  await assert.rejects(
    () => runToolCallMultiRoundTrip(transport, 'summarize', {}, {}),
    (err) => err instanceof MrtrError && /onNeedsSampling/.test(err.message),
  );
});

test('maxRounds budget is enforced', async () => {
  const transport = scriptedTransport([
    { resultType: 'needs_input', need: {} },
    { resultType: 'needs_input', need: {} },
    { resultType: 'needs_input', need: {} },
  ]);
  await assert.rejects(
    () =>
      runToolCallMultiRoundTrip(
        transport,
        'loop',
        {},
        buildDefaultMrtrHandlers({ onNeedsInput: async () => ({}) }),
        { maxRounds: 2 },
      ),
    (err) => err instanceof MrtrError && /vượt quá 2 round/.test(err.message),
  );
  assert.equal(transport.calls.length, 2);
});

test('mrtrCoveredKinds lists exactly the registered kinds', () => {
  const handlers = buildDefaultMrtrHandlers({
    onNeedsInput: async () => ({}),
    onNeedsRoots: async () => [],
  });
  assert.deepEqual(mrtrCoveredKinds(handlers), ['complete', 'needs_input', 'needs_roots']);
  assert.deepEqual(mrtrCoveredKinds({}), ['complete']);
});

test('extractMrtrToolResult: MRTR shape passes through, ordinary results do not', () => {
  assert.deepEqual(extractMrtrToolResult({ resultType: 'needs_input', need: { prompt: 'x' } }), {
    resultType: 'needs_input',
    need: { prompt: 'x' },
  });
  assert.deepEqual(extractMrtrToolResult({ resultType: 'complete', result: { a: 1 } }), {
    resultType: 'complete',
    result: { a: 1 },
  });
  assert.equal(extractMrtrToolResult('plain text'), null);
  assert.equal(extractMrtrToolResult({ text: 'hi' }), null);
  assert.equal(extractMrtrToolResult({ resultType: 'bogus' }), null);
  assert.equal(extractMrtrToolResult(null), null);
});
