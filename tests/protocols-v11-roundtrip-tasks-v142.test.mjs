/**
 * Tests for v1.42 (Team T2) — protocols v11 MRTR + Tasks:
 * packages/core/src/protocols/v11/multiRoundTripV11.ts
 * packages/core/src/protocols/v11/tasksV11.ts
 *
 * Covers:
 *  - input request validation (missing id/title/reason, empty
 *    fields, duplicate names, enum without options, bad bounds)
 *  - answer validation (missing required, wrong type, enum
 *    outside options, number out of range, unknown field)
 *  - round-trip loop: confirm demo completes in exactly 2
 *    rounds; two-step demo completes in exactly 3 rounds;
 *    single-round tools finish in 1 round; invalid answers
 *    fail loudly; a tool that keeps asking hits max-rounds
 *  - tasks: create/get/list/counts, progress events, complete,
 *    fail, cancel, terminal guard (no double-complete),
 *    request-input / provide-input round, engine runs the
 *    handler in the background and pollMcpV11Task resolves,
 *    failing handler -> failed task, expiry sweep fails
 *    stale tasks closed, snapshot/restore round-trip
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/protocols-v11-roundtrip-tasks-v142.test.mjs
 *
 * No network, no model.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  McpV11RoundTripLoop,
  McpV11TaskEngine,
  McpV11TaskStore,
  buildMcpV11InputRequiredResult,
  isMcpV11InputRequired,
  isMcpV11TaskTerminal,
  mcpV11DemoConfirmHandler,
  mcpV11DemoTwoStepHandler,
  pollMcpV11Task,
  validateMcpV11InputAnswer,
  validateMcpV11InputRequest,
} from '../packages/core/dist/index.js';

const CONFIRM_REQUEST = {
  id: 'confirm-delete',
  title: 'Confirm deletion',
  reason: 'Needs confirmation.',
  fields: [
    { name: 'confirmed', prompt: 'Delete?', type: 'boolean', required: true },
    { name: 'count', prompt: 'How many?', type: 'number', required: true, minimum: 1, maximum: 10 },
    { name: 'mode', prompt: 'Mode?', type: 'enum', required: false, options: ['fast', 'safe'] },
  ],
};

test('input request validation: valid passes, broken requests list every problem', () => {
  assert.deepEqual(validateMcpV11InputRequest(CONFIRM_REQUEST), []);
  assert.ok(validateMcpV11InputRequest(null).length > 0);
  const missing = validateMcpV11InputRequest({ id: 'x', fields: [] });
  assert.ok(missing.some((p) => p.includes('title')));
  assert.ok(missing.some((p) => p.includes('reason')));
  assert.ok(missing.some((p) => p.includes('fields')));
  const dup = validateMcpV11InputRequest({
    ...CONFIRM_REQUEST,
    fields: [
      { name: 'a', prompt: 'A', type: 'string' },
      { name: 'a', prompt: 'A again', type: 'string' },
    ],
  });
  assert.ok(dup.some((p) => p.includes('duplicated')));
  const badEnum = validateMcpV11InputRequest({
    ...CONFIRM_REQUEST,
    fields: [{ name: 'mode', prompt: 'Mode?', type: 'enum' }],
  });
  assert.ok(badEnum.some((p) => p.includes('options')));
  const badBounds = validateMcpV11InputRequest({
    ...CONFIRM_REQUEST,
    fields: [{ name: 'n', prompt: 'N', type: 'number', minimum: 5, maximum: 2 }],
  });
  assert.ok(badBounds.some((p) => p.includes('minimum')));
});

test('answer validation: types, bounds, enums, required and unknown fields', () => {
  assert.deepEqual(validateMcpV11InputAnswer(CONFIRM_REQUEST, { confirmed: true, count: 3 }), []);
  assert.deepEqual(validateMcpV11InputAnswer(CONFIRM_REQUEST, { confirmed: true, count: 3, mode: 'fast' }), []);
  const missing = validateMcpV11InputAnswer(CONFIRM_REQUEST, { count: 3 });
  assert.ok(missing.some((p) => p.includes('confirmed')));
  const wrongType = validateMcpV11InputAnswer(CONFIRM_REQUEST, { confirmed: 'yes', count: 3 });
  assert.ok(wrongType.some((p) => p.includes('boolean')));
  const outOfRange = validateMcpV11InputAnswer(CONFIRM_REQUEST, { confirmed: true, count: 99 });
  assert.ok(outOfRange.some((p) => p.includes('<= 10')));
  const badEnum = validateMcpV11InputAnswer(CONFIRM_REQUEST, { confirmed: true, count: 3, mode: 'wild' });
  assert.ok(badEnum.some((p) => p.includes('fast, safe')));
  const unknown = validateMcpV11InputAnswer(CONFIRM_REQUEST, { confirmed: true, count: 3, nope: 1 });
  assert.ok(unknown.some((p) => p.includes('not a field')));
  assert.ok(validateMcpV11InputAnswer(CONFIRM_REQUEST, null).length > 0);
});

test('round-trip loop: confirm demo completes in exactly 2 rounds, journal records both', async () => {
  const loop = new McpV11RoundTripLoop();
  const outcome = await loop.run({
    args: { item: 'old-report' },
    call: (args, round) => mcpV11DemoConfirmHandler(args, round),
    answerInput: async () => ({ confirmed: true, reason: 'stale' }),
  });
  assert.equal(outcome.rounds, 2);
  assert.equal(outcome.multiRound, true);
  assert.equal(outcome.result.deleted, true);
  assert.equal(outcome.result.item, 'old-report');
  assert.equal(outcome.journal.length, 2);
  assert.equal(outcome.journal[0].inputRequest.id, 'confirm-delete');
  assert.equal(outcome.journal[0].answer.confirmed, true);
  assert.equal(outcome.journal[1].inputRequest, null);
});

test('round-trip loop: two-step demo completes in exactly 3 rounds', async () => {
  const loop = new McpV11RoundTripLoop();
  const outcome = await loop.run({
    args: {},
    call: (args, round) => mcpV11DemoTwoStepHandler(args, round),
    answerInput: async (request) => {
      if (request.id === 'pick-mode') return { mode: 'safe' };
      return { count: 7 };
    },
  });
  assert.equal(outcome.rounds, 3);
  assert.equal(outcome.result.mode, 'safe');
  assert.equal(outcome.result.count, 7);
});

test('round-trip loop: single-round tools finish in 1 round; invalid answers fail loudly', async () => {
  const loop = new McpV11RoundTripLoop();
  const single = await loop.run({
    args: { a: 1 },
    call: () => ({ resultType: 'completed', result: { ok: true } }),
    answerInput: async () => ({}),
  });
  assert.equal(single.rounds, 1);
  assert.equal(single.multiRound, false);
  await assert.rejects(
    () =>
      loop.run({
        args: {},
        call: (args, round) => mcpV11DemoConfirmHandler(args, round),
        answerInput: async () => ({ confirmed: 'maybe' }),
      }),
    /invalid-answer/,
  );
  await assert.rejects(
    () =>
      loop.run({
        args: {},
        call: () => buildMcpV11InputRequiredResult({ id: '', title: '', reason: '', fields: [] }),
        answerInput: async () => ({}),
      }),
    /invalid-input-request/,
  );
});

test('round-trip loop: a tool that keeps asking hits max-rounds instead of looping forever', async () => {
  const loop = new McpV11RoundTripLoop(3);
  await assert.rejects(
    () =>
      loop.run({
        args: {},
        call: () =>
          buildMcpV11InputRequiredResult({
            id: 'again',
            title: 'Again',
            reason: 'Always asks.',
            fields: [{ name: 'x', prompt: 'X?', type: 'string', required: true }],
          }),
        answerInput: async () => ({ x: 'y' }),
      }),
    /max-rounds/,
  );
  assert.equal(isMcpV11InputRequired({ resultType: 'input_required' }), true);
  assert.equal(isMcpV11InputRequired({ resultType: 'completed' }), false);
});

test('tasks store: lifecycle, progress, terminal guard', () => {
  const store = new McpV11TaskStore();
  const task = store.create('echo', { hello: 'world' });
  assert.equal(task.status, 'created');
  assert.equal(task.progress, 0);
  store.progress(task.id, 40, 'working');
  assert.equal(store.get(task.id).status, 'running');
  assert.equal(store.get(task.id).progress, 40);
  assert.equal(store.get(task.id).progressEvents.length, 1);
  const done = store.complete(task.id, { ok: true });
  assert.equal(done.status, 'completed');
  assert.equal(done.progress, 100);
  assert.equal(isMcpV11TaskTerminal('completed'), true);
  assert.equal(isMcpV11TaskTerminal('running'), false);
  assert.throws(() => store.complete(task.id, {}), /already completed/);
  assert.throws(() => store.cancel(task.id), /already completed/);
  const counts = store.counts();
  assert.equal(counts.total, 1);
  assert.equal(counts.completed, 1);
  assert.throws(() => store.require('task-nope'), /No task/);
});

test('tasks store: input_required round, fail, cancel, sweep expiry', () => {
  const store = new McpV11TaskStore(1000);
  const task = store.create('needs-input', {});
  store.requestInput(task.id, { id: 'q1', title: 'Question', reason: 'Need it.', fields: ['answer'] });
  assert.equal(store.get(task.id).status, 'input_required');
  assert.throws(() => store.provideInput('task-nope', {}), /No task/);
  const resumed = store.provideInput(task.id, { answer: 'yes' });
  assert.equal(resumed.status, 'running');
  assert.equal(resumed.providedInput.answer, 'yes');
  const failed = store.create('boom', {});
  store.fail(failed.id, 'kaboom');
  assert.equal(store.get(failed.id).error, 'kaboom');
  const cancelled = store.create('stop-me', {});
  store.cancel(cancelled.id);
  assert.equal(store.get(cancelled.id).status, 'cancelled');
  // Expiry: a stale non-terminal task fails closed on sweep.
  const stale = store.create('stale', {});
  const expired = store.sweep(Date.now() + 60_000);
  assert.ok(expired.includes(stale.id));
  assert.equal(store.get(stale.id).status, 'failed');
  assert.match(store.get(stale.id).error, /expired/);
  // Snapshot / restore round-trip. Note the sweep above expired the
  // still-running task, so assert on the terminal tasks instead.
  const snap = store.snapshot();
  const restored = new McpV11TaskStore();
  assert.equal(restored.restore(snap), store.counts().total);
  assert.equal(restored.get(cancelled.id).status, 'cancelled');
  assert.equal(restored.get(failed.id).status, 'failed');
  assert.equal(restored.get(stale.id).status, 'failed');
});

test('tasks engine: background handler + poll resolves; failing handler -> failed', async () => {
  const engine = new McpV11TaskEngine();
  const task = engine.create('sum', { numbers: [1, 2, 3] }, async (input, ctx) => {
    ctx.progress(50, 'halfway');
    const numbers = input.numbers;
    return { sum: numbers.reduce((a, n) => a + n, 0) };
  });
  assert.equal(task.status, 'running');
  const done = await pollMcpV11Task(engine, task.id, { intervalMs: 5, maxPolls: 100 });
  assert.equal(done.status, 'completed');
  assert.equal(done.result.sum, 6);
  assert.ok(done.progressEvents.length >= 1);
  const failing = engine.create('boom', {}, async () => {
    throw new Error('handler exploded');
  });
  const failed = await pollMcpV11Task(engine, failing.id, { intervalMs: 5, maxPolls: 100 });
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /handler exploded/);
  // poll timeout rejects.
  const slow = engine.create('slow', {}, async () => {
    await new Promise((r) => setTimeout(r, 500));
    return {};
  });
  await assert.rejects(() => pollMcpV11Task(engine, slow.id, { intervalMs: 5, maxPolls: 3 }), /poll-timeout/);
  await engine.cancel(slow.id);
});
