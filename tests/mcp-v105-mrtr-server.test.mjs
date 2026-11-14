/**
 * Test v1.05 T2: MRTR elicitation phía server (node:test, không mạng).
 *
 * Covers packages/core/src/mcp/mrtrServer.ts:
 *  - requestElicitation -> needs_elicitation result, state waiting
 *  - resumeWithAnswer: accept (validate) / decline / cancel / sai schema
 *  - vòng nhiều lần, allAnswers gom đủ
 *  - complete() -> complete result, session terminal
 *  - TTL expiry + sweepExpired + store cap/evict
 *  - parseMrtrFollowUp
 *
 * Build core trước:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/mcp-v105-mrtr-server.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MrtrServerSession,
  MrtrServerSessionStore,
  parseMrtrFollowUp,
} from '../packages/core/dist/mcp/mrtrServer.js';

const SCHEMA = {
  type: 'object',
  properties: {
    nickname: { type: 'string', minLength: 2 },
    age: { type: 'integer', minimum: 0 },
  },
  required: ['nickname'],
};

test('full server round: ask -> resume -> complete', () => {
  const session = new MrtrServerSession('tools/call', { name: 'greet', arguments: {} });
  assert.equal(session.currentState, 'active');
  assert.equal(session.currentRound, 0);
  const need = session.requestElicitation('Cho biết nickname.', SCHEMA);
  assert.equal(need.resultType, 'needs_elicitation');
  assert.equal(need.roundTripId, session.roundTripId);
  assert.equal(need.need.prompt, 'Cho biết nickname.');
  assert.equal(session.currentState, 'waiting_elicitation');
  assert.equal(session.currentRound, 1);

  const outcome = session.resumeWithAnswer({
    action: 'accept',
    content: { nickname: 'Huy', age: 30, extra: 'bị loại' },
  });
  assert.deepEqual(outcome.content, { nickname: 'Huy', age: 30 });
  assert.equal(outcome.round, 1);
  assert.deepEqual(outcome.allAnswers, { 1: { nickname: 'Huy', age: 30 } });
  assert.equal(session.currentState, 'active');

  const done = session.complete({ greeted: 'Huy' });
  assert.equal(done.resultType, 'complete');
  assert.deepEqual(done.result, { greeted: 'Huy' });
  assert.equal(done.roundTripId, session.roundTripId);
  assert.equal(session.currentState, 'completed');
  assert.throws(() => session.resumeWithAnswer({ action: 'accept', content: {} }), /trạng thái cuối/);
});

test('requestElicitation validates schema up front', () => {
  const session = new MrtrServerSession('tools/call', {});
  assert.throws(
    () => session.requestElicitation('Tên?', { type: 'object', properties: {} }),
    /không có field nào/,
  );
  assert.throws(
    () =>
      session.requestElicitation('Tên?', {
        type: 'object',
        properties: { password: { type: 'string' } },
      }),
    /dữ liệu nhạy cảm/,
  );
  assert.throws(() => session.requestElicitation('   ', SCHEMA), /cần prompt/);
});

test('resume: invalid answer is rejected, session stays waiting', () => {
  const session = new MrtrServerSession('tools/call', {});
  session.requestElicitation('Cho biết nickname.', SCHEMA);
  assert.throws(
    () => session.resumeWithAnswer({ action: 'accept', content: { nickname: 'x' } }),
    /sai validate/,
  );
  assert.equal(session.currentState, 'waiting_elicitation');
  assert.throws(() => session.resumeWithAnswer('not-an-object'), /phải là một object/);
  assert.throws(
    () => session.resumeWithAnswer({ action: 'maybe' }),
    /action không hợp lệ/,
  );
  // Decline: handler gets a clear error; session back to active.
  assert.throws(
    () => session.resumeWithAnswer({ action: 'decline' }),
    /từ chối elicitation/,
  );
  assert.equal(session.currentState, 'active');
  // Cancel: session terminal.
  session.requestElicitation('Cho biết nickname.', SCHEMA);
  assert.throws(
    () => session.resumeWithAnswer({ action: 'cancel' }),
    /huỷ elicitation/,
  );
  assert.equal(session.currentState, 'cancelled');
});

test('multiple rounds accumulate answers', () => {
  const session = new MrtrServerSession('tools/call', {});
  session.requestElicitation('Nickname?', SCHEMA);
  session.resumeWithAnswer({ action: 'accept', content: { nickname: 'Huy' } });
  session.requestElicitation(
    'Tuổi?',
    { type: 'object', properties: { age: { type: 'integer', minimum: 0 } }, required: ['age'] },
  );
  const outcome = session.resumeWithAnswer({ action: 'accept', content: { age: 30 } });
  assert.equal(outcome.round, 2);
  assert.deepEqual(outcome.allAnswers, { 1: { nickname: 'Huy' }, 2: { age: 30 } });
  assert.equal(session.roundHistory.length, 2);
  assert.equal(session.roundHistory[0].answer.nickname, 'Huy');
});

test('TTL expiry: resume after expiry throws, store sweeps', () => {
  let now = 1000;
  const store = new MrtrServerSessionStore({ nowMs: () => now, ttlMs: 1000 });
  const session = store.create('tools/call', {}, { ttlMs: 1000 });
  assert.equal(store.size, 1);
  now = 500;
  assert.ok(store.get(session.roundTripId));
  now = 2001;
  assert.equal(store.get(session.roundTripId), undefined);
  assert.equal(store.size, 0);
  assert.throws(() => session.resumeWithAnswer({ action: 'accept', content: {} }), /hết hạn/);
  assert.equal(session.currentState, 'expired');
});

test('store: cap evicts oldest, getOrThrow, remove', () => {
  const store = new MrtrServerSessionStore({ maxSessions: 2, nowMs: () => 1000 });
  const s1 = store.create('tools/call', {});
  const s2 = store.create('tools/call', {});
  assert.equal(store.size, 2);
  const s3 = store.create('tools/call', {});
  assert.equal(store.size, 2);
  assert.equal(store.get(s1.roundTripId), undefined);
  assert.equal(s1.currentState, 'cancelled');
  assert.ok(store.get(s2.roundTripId));
  assert.ok(store.get(s3.roundTripId));
  assert.equal(store.getOrThrow(s2.roundTripId), s2);
  assert.throws(() => store.getOrThrow('nope'), /Không có MRTR session/);
  assert.equal(store.remove(s2.roundTripId), true);
  assert.equal(store.remove(s2.roundTripId), false);
  assert.equal(store.sweepExpired(1000), 0);
});

test('parseMrtrFollowUp: extracts roundTripId + answer', () => {
  assert.deepEqual(
    parseMrtrFollowUp({
      roundTripId: 'rt-1',
      round: 2,
      answer: { action: 'accept', content: { nickname: 'Huy' } },
    }),
    { roundTripId: 'rt-1', round: 2, answer: { action: 'accept', content: { nickname: 'Huy' } } },
  );
  assert.equal(parseMrtrFollowUp({ name: 'x' }), null);
  assert.equal(parseMrtrFollowUp(null), null);
  assert.equal(parseMrtrFollowUp({ roundTripId: '' }), null);
  assert.deepEqual(parseMrtrFollowUp({ roundTripId: 'rt-1' }), {
    roundTripId: 'rt-1',
    round: 1,
    answer: undefined,
  });
});
