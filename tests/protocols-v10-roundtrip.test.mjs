/**
 * Tests for v1.41 (Team T2) — multi round-trip v10:
 * packages/core/src/protocolsV10/multiRoundTripV10.ts
 *
 * Covers:
 *  - input_required detection (shape only)
 *  - request validation (reason, fields, types, enum
 *    values, duplicate names, timeout)
 *  - answer validation (required fields, types, enum
 *    membership, unknown fields refused, defaults filled)
 *  - the loop: zero rounds when the first call succeeds,
 *    one/more rounds with answers attached, rounds recorded
 *  - loop guard: more than maxRounds refuses to loop forever
 *  - invalid server request / invalid client answer fail
 *    fast with a clear message
 *  - builder refuses an invalid request
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/protocols-v10-roundtrip.test.mjs
 *
 * No network, no model.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  McpV10RoundTripLoop,
  buildMcpV10InputRequiredResult,
  isMcpV10InputRequiredResult,
  validateMcpV10InputAnswer,
  validateMcpV10InputAnswerField,
  validateMcpV10InputRequest,
} from '../packages/core/dist/index.js';

const REQUEST = {
  reason: 'Need a project name and a size.',
  fields: [
    { name: 'project', type: 'string', required: true, prompt: 'Project name?' },
    { name: 'size', type: 'enum', required: true, values: ['small', 'large'] },
    { name: 'verbose', type: 'boolean', required: false, default: false },
    { name: 'budget', type: 'number', required: false },
  ],
};

test('detection: only a real input_required result counts', () => {
  assert.equal(isMcpV10InputRequiredResult({ input_required: REQUEST }), true);
  assert.equal(isMcpV10InputRequiredResult({ input_required: { reason: 'x' } }), false);
  assert.equal(isMcpV10InputRequiredResult({ result: 'ok' }), false);
  assert.equal(isMcpV10InputRequiredResult(null), false);
  assert.equal(isMcpV10InputRequiredResult('input_required'), false);
});

test('request validation: good request passes, bad shapes fail', () => {
  assert.deepEqual(validateMcpV10InputRequest(REQUEST), []);
  assert.ok(validateMcpV10InputRequest({ reason: '', fields: [{ name: 'a', type: 'string' }] }).length > 0);
  assert.ok(validateMcpV10InputRequest({ reason: 'x', fields: [] }).length > 0);
  assert.ok(validateMcpV10InputRequest({ reason: 'x', fields: [{ name: 'a', type: 'weird' }] }).length > 0);
  assert.ok(validateMcpV10InputRequest({ reason: 'x', fields: [{ name: 'a', type: 'enum' }] }).some((p) => p.includes('values')));
  assert.ok(validateMcpV10InputRequest({ reason: 'x', fields: [{ name: 'a', type: 'string' }, { name: 'a', type: 'string' }] }).some((p) => p.includes('duplicate')));
  assert.ok(validateMcpV10InputRequest({ reason: 'x', fields: [{ name: 'a', type: 'string' }], timeoutMs: -5 }).length > 0);
  assert.ok(validateMcpV10InputRequest(null).length > 0);
});

test('answer field validation: types, enum membership, required', () => {
  assert.deepEqual(validateMcpV10InputAnswerField({ name: 'a', type: 'string' }, 'x'), []);
  assert.ok(validateMcpV10InputAnswerField({ name: 'a', type: 'string' }, 3).length > 0);
  assert.deepEqual(validateMcpV10InputAnswerField({ name: 'a', type: 'number' }, 3.5), []);
  assert.ok(validateMcpV10InputAnswerField({ name: 'a', type: 'number' }, Number.NaN).length > 0);
  assert.deepEqual(validateMcpV10InputAnswerField({ name: 'a', type: 'boolean' }, true), []);
  assert.ok(validateMcpV10InputAnswerField({ name: 'a', type: 'boolean' }, 'true').length > 0);
  assert.deepEqual(validateMcpV10InputAnswerField({ name: 'a', type: 'enum', values: ['x', 'y'] }, 'y'), []);
  assert.ok(validateMcpV10InputAnswerField({ name: 'a', type: 'enum', values: ['x', 'y'] }, 'z').length > 0);
  assert.ok(validateMcpV10InputAnswerField({ name: 'a', type: 'string', required: true }, undefined).length > 0);
  assert.deepEqual(validateMcpV10InputAnswerField({ name: 'a', type: 'string' }, undefined), []);
});

test('answer validation: unknown fields refused, defaults filled in', () => {
  const good = validateMcpV10InputAnswer(REQUEST, { project: 'p', size: 'small' });
  assert.equal(good.ok, true);
  assert.equal(good.normalised.verbose, false);
  assert.equal(good.normalised.project, 'p');
  assert.equal(good.normalised.size, 'small');
  assert.equal('budget' in good.normalised, false);
  const missing = validateMcpV10InputAnswer(REQUEST, { size: 'small' });
  assert.equal(missing.ok, false);
  assert.ok(missing.problems.some((p) => p.includes('"project"')));
  const wrongEnum = validateMcpV10InputAnswer(REQUEST, { project: 'p', size: 'huge' });
  assert.equal(wrongEnum.ok, false);
  const extra = validateMcpV10InputAnswer(REQUEST, { project: 'p', size: 'small', typo: 1 });
  assert.equal(extra.ok, false);
  assert.ok(extra.problems.some((p) => p.includes('unknown field "typo"')));
  const notObject = validateMcpV10InputAnswer(REQUEST, 'nope');
  assert.equal(notObject.ok, false);
});

test('loop: zero rounds when the first call succeeds', async () => {
  const loop = new McpV10RoundTripLoop();
  const outcome = await loop.run(
    () => ({ done: true }),
    () => {
      throw new Error('answerInput must not be called');
    },
  );
  assert.deepEqual(outcome.result, { done: true });
  assert.equal(outcome.roundsUsed, 0);
  assert.deepEqual(outcome.rounds, []);
});

test('loop: answers are attached and rounds are recorded', async () => {
  const loop = new McpV10RoundTripLoop();
  const outcome = await loop.run(
    (answers) => {
      if (!answers.project) {
        return buildMcpV10InputRequiredResult(REQUEST);
      }
      return { done: true, answers };
    },
    (request) => {
      assert.equal(request.reason, REQUEST.reason);
      return { project: 'open-bot', size: 'large', verbose: true, budget: 100 };
    },
  );
  assert.equal(outcome.result.done, true);
  assert.equal(outcome.result.answers.project, 'open-bot');
  assert.equal(outcome.roundsUsed, 1);
  assert.equal(outcome.rounds[0].round, 1);
  assert.equal(outcome.rounds[0].answer.project, 'open-bot');
  assert.equal(typeof outcome.rounds[0].tookMs, 'number');
});

test('loop: multi-round flow accumulates answers across rounds', async () => {
  const loop = new McpV10RoundTripLoop();
  let asked = 0;
  const outcome = await loop.run(
    (answers) => {
      asked += 1;
      if (asked === 1) {
        return buildMcpV10InputRequiredResult({
          reason: 'first',
          fields: [{ name: 'a', type: 'string', required: true }],
        });
      }
      if (asked === 2) {
        return buildMcpV10InputRequiredResult({
          reason: 'second',
          fields: [{ name: 'b', type: 'number', required: true }],
        });
      }
      return { a: answers.a, b: answers.b };
    },
    (request) => {
      if (request.fields[0].name === 'a') return { a: 'x' };
      return { b: 7 };
    },
  );
  assert.deepEqual(outcome.result, { a: 'x', b: 7 });
  assert.equal(outcome.roundsUsed, 2);
});

test('loop guard: more than maxRounds refuses to loop forever', async () => {
  const loop = new McpV10RoundTripLoop(2);
  await assert.rejects(
    () =>
      loop.run(
        () => buildMcpV10InputRequiredResult({ reason: 'always', fields: [{ name: 'a', type: 'string', required: true }] }),
        () => ({ a: 'x' }),
      ),
    /exceeded 2 rounds/,
  );
  assert.throws(() => new McpV10RoundTripLoop(0), /positive integer/);
});

test('loop: invalid server request and invalid client answer fail fast', async () => {
  const loop = new McpV10RoundTripLoop();
  await assert.rejects(
    () =>
      loop.run(
        () => ({ input_required: { reason: 'x', fields: [{ name: 'a', type: 'weird' }] } }),
        () => ({}),
      ),
    /invalid request/,
  );
  await assert.rejects(
    () =>
      loop.run(
        () => buildMcpV10InputRequiredResult({ reason: 'x', fields: [{ name: 'a', type: 'string', required: true }] }),
        () => ({ wrong: 1 }),
      ),
    /invalid/,
  );
  assert.throws(
    () => buildMcpV10InputRequiredResult({ reason: 'x', fields: [] }),
    /Cannot build input_required/,
  );
  const withPartial = buildMcpV10InputRequiredResult(
    { reason: 'x', fields: [{ name: 'a', type: 'string', required: true }] },
    { step: 1 },
  );
  assert.equal(withPartial.partial.step, 1);
});
