/**
 * Test v1.05 T2: MRTR elicitation state machine (node:test, không mạng).
 *
 * Covers packages/core/src/mcp/mrtrElicitation.ts với fake transport:
 *  - vòng đầy đủ: needs_elicitation -> hỏi user -> follow-up ->
 *    complete; state pending -> input_required -> responded
 *  - validate fail -> hỏi lại (retry) rồi mới xong
 *  - validate fail quá số lần -> lỗi rõ ràng
 *  - user decline / cancel -> state cancelled, lỗi rõ ràng
 *  - prompt timeout từng vòng -> state timeout
 *  - overall timeout -> state timeout
 *  - URL-mode: accept ngay, không chờ completion trong round
 *  - mrtrNeedToElicitationRequest + buildMrtrElicitationHandler
 *
 * Build core trước:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/mcp-v105-mrtr-elicitation.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MrtrElicitationSession,
  buildMrtrElicitationHandler,
  describeMrtrElicitationState,
  isMrtrElicitationTerminal,
  mrtrNeedToElicitationRequest,
} from '../packages/core/dist/mcp/mrtrElicitation.js';

const SCHEMA = {
  type: 'object',
  properties: {
    nickname: { type: 'string', minLength: 2 },
    age: { type: 'integer', minimum: 0 },
  },
  required: ['nickname'],
};

function needsElicitation(roundTripId = 'rt-1', prompt = 'Cho biết nickname của bạn.') {
  return {
    resultType: 'needs_elicitation',
    roundTripId,
    need: { resultType: 'needs_elicitation', prompt, schema: SCHEMA },
  };
}

function complete(result, roundTripId = 'rt-1') {
  return { resultType: 'complete', result, roundTripId };
}

/** Fake transport: round 1 trả needs_elicitation, round sau complete. */
function makeTransport({ roundsBeforeComplete = 1, completeResult = { ok: true } } = {}) {
  const calls = [];
  let n = 0;
  return {
    calls,
    async requestJsonRpc(method, params) {
      calls.push({ method, params });
      n += 1;
      if (n <= roundsBeforeComplete) return needsElicitation();
      return complete(completeResult);
    },
  };
}

test('full round: pending -> input_required -> responded, result returned', async () => {
  const transport = makeTransport();
  const states = [];
  const prompt = async () => ({ action: 'accept', content: { nickname: 'Huy', age: 30 } });
  const session = new MrtrElicitationSession(transport, {
    serverName: 'fake',
    prompt,
    onStateChange: (state) => states.push(state),
  });
  assert.equal(session.currentState, 'pending');
  const outcome = await session.run('tools/call', { name: 'greet', arguments: {} });
  assert.equal(outcome.state, 'responded');
  assert.deepEqual(outcome.result, { ok: true });
  assert.equal(outcome.rounds, 2);
  assert.equal(outcome.roundTripId, 'rt-1');
  assert.deepEqual(states, ['input_required', 'responded']);
  assert.equal(session.currentState, 'responded');
  assert.equal(isMrtrElicitationTerminal('responded'), true);
  // Follow-up round mang inputResponses + _meta.roundTrip.
  const followUp = transport.calls[1];
  assert.equal(followUp.params.roundTripId, 'rt-1');
  assert.equal(followUp.params.round, 2);
  assert.deepEqual(followUp.params.answer, {
    action: 'accept',
    content: { nickname: 'Huy', age: 30 },
  });
  assert.equal(followUp.params._meta.roundTrip.roundTripId, 'rt-1');
});

test('validate fail -> re-ask (retry) then succeed', async () => {
  const transport = makeTransport();
  let attempts = 0;
  const prompt = async () => {
    attempts += 1;
    // Lần 1: nickname quá ngắn (minLength 2) -> validate fail -> hỏi lại.
    if (attempts === 1) return { action: 'accept', content: { nickname: 'x' } };
    return { action: 'accept', content: { nickname: 'Huy' } };
  };
  const session = new MrtrElicitationSession(transport, {
    serverName: 'fake',
    prompt,
    maxValidationRetries: 2,
  });
  const outcome = await session.run('tools/call', { name: 'greet', arguments: {} });
  assert.equal(outcome.state, 'responded');
  assert.equal(attempts, 2);
  assert.ok(session.rounds[0].validationError);
});

test('validate fail past retries -> clear error, session not responded', async () => {
  const transport = makeTransport();
  const prompt = async () => ({ action: 'accept', content: { nickname: 'x' } });
  const session = new MrtrElicitationSession(transport, {
    serverName: 'fake',
    prompt,
    maxValidationRetries: 1,
  });
  await assert.rejects(
    () => session.run('tools/call', { name: 'greet', arguments: {} }),
    /sai validate sau 2 lần hỏi/,
  );
});

test('user decline -> server gets action, session continues to complete', async () => {
  const transport = makeTransport({ completeResult: { declined: true } });
  const prompt = async () => ({ action: 'decline' });
  const session = new MrtrElicitationSession(transport, {
    serverName: 'fake',
    prompt,
  });
  const outcome = await session.run('tools/call', { name: 'greet', arguments: {} });
  assert.equal(outcome.state, 'responded');
  assert.deepEqual(outcome.result, { declined: true });
  assert.equal(transport.calls[1].params.answer.action, 'decline');
});

test('user cancel (prompt null) -> state cancelled + error', async () => {
  const transport = makeTransport();
  const states = [];
  const prompt = async () => null;
  const session = new MrtrElicitationSession(transport, {
    serverName: 'fake',
    prompt,
    onStateChange: (state) => states.push(state),
  });
  await assert.rejects(
    () => session.run('tools/call', { name: 'greet', arguments: {} }),
    /huỷ elicitation/,
  );
  assert.equal(session.currentState, 'cancelled');
  assert.deepEqual(states, ['input_required', 'cancelled']);
  assert.equal(isMrtrElicitationTerminal('cancelled'), true);
});

test('session.cancel() from outside aborts the run', async () => {
  let resolvePrompt;
  const promptGate = new Promise((resolve) => {
    resolvePrompt = resolve;
  });
  const transport = makeTransport();
  const session = new MrtrElicitationSession(transport, {
    serverName: 'fake',
    prompt: () => promptGate,
    promptTimeoutMs: 60_000,
    overallTimeoutMs: 60_000,
  });
  const runPromise = session.run('tools/call', { name: 'greet', arguments: {} });
  // Đợi handler vào trạng thái input_required rồi huỷ từ ngoài.
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(session.currentState, 'input_required');
  session.cancel('test cancel');
  resolvePrompt({ action: 'accept', content: { nickname: 'Huy' } });
  await assert.rejects(() => runPromise, /bị huỷ/);
  assert.equal(session.currentState, 'cancelled');
});

test('prompt timeout per round -> state timeout', async () => {
  const transport = makeTransport();
  const prompt = () => new Promise(() => undefined); // never answers
  const session = new MrtrElicitationSession(transport, {
    serverName: 'fake',
    prompt,
    promptTimeoutMs: 20,
    overallTimeoutMs: 5000,
  });
  await assert.rejects(
    () => session.run('tools/call', { name: 'greet', arguments: {} }),
    /Hết thời gian chờ user trả lời/,
  );
  assert.equal(session.currentState, 'timeout');
  assert.equal(describeMrtrElicitationState('timeout'), 'Hết thời gian chờ người dùng trả lời elicitation.');
});

test('overall timeout -> state timeout', async () => {
  const transport = makeTransport();
  const prompt = () => new Promise(() => undefined);
  const session = new MrtrElicitationSession(transport, {
    serverName: 'fake',
    prompt,
    promptTimeoutMs: 5000,
    overallTimeoutMs: 30,
  });
  await assert.rejects(
    () => session.run('tools/call', { name: 'greet', arguments: {} }),
    /hết thời gian chờ/,
  );
  assert.equal(session.currentState, 'timeout');
});

test('URL-mode: accept immediately, no in-round wait', async () => {
  const transport = {
    calls: [],
    async requestJsonRpc(method, params) {
      this.calls.push({ method, params });
      if (this.calls.length === 1) {
        return {
          resultType: 'needs_elicitation',
          roundTripId: 'rt-url',
          need: {
            resultType: 'needs_elicitation',
            prompt: 'Mở URL để xác minh.',
            detail: { url: 'https://example.com/verify' },
          },
        };
      }
      return complete({ verified: true }, 'rt-url');
    },
  };
  const prompt = async () => ({ action: 'accept' });
  const session = new MrtrElicitationSession(transport, {
    serverName: 'fake',
    prompt,
  });
  const outcome = await session.run('tools/call', { name: 'verify', arguments: {} });
  assert.equal(outcome.state, 'responded');
  assert.deepEqual(outcome.result, { verified: true });
});

test('mrtrNeedToElicitationRequest: form + url shapes', () => {
  const form = mrtrNeedToElicitationRequest(
    { resultType: 'needs_elicitation', prompt: 'Tên?', schema: SCHEMA },
    'srv',
  );
  assert.equal(form.mode, 'form');
  assert.equal(form.fields.length, 2);
  assert.equal(form.fields[0].name, 'nickname');
  assert.equal(form.fields[0].required, true);

  const url = mrtrNeedToElicitationRequest(
    {
      resultType: 'needs_elicitation',
      prompt: 'Xác minh',
      detail: { url: 'https://example.com/x' },
    },
    'srv',
  );
  assert.equal(url.mode, 'url');
  assert.equal(url.url, 'https://example.com/x');
});

test('buildMrtrElicitationHandler: validates via elicitation.ts', async () => {
  const handler = buildMrtrElicitationHandler(
    async () => ({ action: 'accept', content: { nickname: 'Huy', age: 31 } }),
    'srv',
  );
  const answer = await handler(
    { resultType: 'needs_elicitation', prompt: 'Tên?', schema: SCHEMA },
    1,
  );
  assert.deepEqual(answer, { action: 'accept', content: { nickname: 'Huy', age: 31 } });

  const badHandler = buildMrtrElicitationHandler(
    async () => ({ action: 'accept', content: { nickname: 'x' } }),
    'srv',
  );
  await assert.rejects(
    () =>
      badHandler(
        { resultType: 'needs_elicitation', prompt: 'Tên?', schema: SCHEMA },
        1,
      ),
    /dài ít nhất 2 ký tự/,
  );
});

test('run twice on a terminal session throws', async () => {
  const transport = makeTransport();
  const prompt = async () => ({ action: 'accept', content: { nickname: 'Huy' } });
  const session = new MrtrElicitationSession(transport, {
    serverName: 'fake',
    prompt,
  });
  await session.run('tools/call', { name: 'greet', arguments: {} });
  await assert.rejects(
    () => session.run('tools/call', { name: 'greet', arguments: {} }),
    /trạng thái cuối/,
  );
});
