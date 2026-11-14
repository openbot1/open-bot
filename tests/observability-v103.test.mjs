/**
 * Tests for the observability v3 core (packages/core/src/observability).
 *
 * Covers the event-stream helpers (filter / summary / buckets / tail /
 * types present — pure over run events, no T1 code touched) and the
 * eval harness (suite + case CRUD, every check kind scored against a
 * replayed run, suite reports with skipped cases).
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/observability-v103.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  bucketEventStream,
  filterRunEvents,
  listEventTypesPresent,
  summarizeEventStream,
  tailEvents,
} from '../packages/core/dist/observability/eventStream.js';
import {
  addEvalCase,
  createEvalSuite,
  listEvalSuites,
  removeEvalCase,
  removeEvalSuite,
  runEvalSuite,
  scoreEvalCase,
} from '../packages/core/dist/observability/evalHarness.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-obs-v103-'));
}

const T0 = 1_790_000_000_000; // ~2026-09-21T00:00:00Z
const iso = (ms) => new Date(ms).toISOString();

function makeEvent(seq, type, at, payload = {}) {
  return { seq, runId: 'run-1', at: iso(at), type, payload };
}

const EVENTS = [
  makeEvent(1, 'run.started', T0, { botId: 'bot-a' }),
  makeEvent(2, 'tool.call', T0 + 1000, { tool: 'web_search', args: { query: 'cats' } }),
  makeEvent(3, 'tool.result', T0 + 2000, { tool: 'web_search', status: 'ok' }),
  makeEvent(4, 'model.response', T0 + 3000, { text: 'Cats are lovely.', inputTokens: 40, outputTokens: 20 }),
  makeEvent(5, 'tool.call', T0 + 61_000, { tool: 'file_read', args: { path: '/tmp/a.txt' } }),
  makeEvent(6, 'tool.result', T0 + 61_500, { tool: 'file_read', status: 'error', error: 'missing file' }),
  makeEvent(7, 'run.completed', T0 + 62_000, {}),
];

// --- event stream ----------------------------------------------------------

test('observability v3: filterRunEvents by type / text / window / limit / bot', () => {
  assert.equal(filterRunEvents(EVENTS, { types: ['tool.call'] }).length, 2);
  assert.equal(filterRunEvents(EVENTS, { text: 'cats' }).length, 2, 'query text matches the tool args and the model text');
  assert.equal(filterRunEvents(EVENTS, { text: 'lovely' }).length, 1);
  assert.equal(filterRunEvents(EVENTS, { fromAt: iso(T0 + 3000) }).length, 4);
  assert.equal(filterRunEvents(EVENTS, { toAt: iso(T0 + 2000) }).length, 3);
  assert.equal(filterRunEvents(EVENTS, { limit: 2 }).length, 2, 'limit keeps the newest N');
  assert.deepEqual(filterRunEvents(EVENTS, { limit: 2 }).map((e) => e.seq), [6, 7]);
  assert.equal(filterRunEvents(EVENTS, { runIds: ['run-2'] }).length, 0);
  // botIds needs run meta; without it, nothing matches (never guessed).
  assert.equal(filterRunEvents(EVENTS, { botIds: ['bot-a'] }).length, 0);
  assert.equal(
    filterRunEvents(EVENTS, { botIds: ['bot-a'] }, [{ runId: 'run-1', botId: 'bot-a' }]).length,
    7,
  );
  assert.equal(
    filterRunEvents(EVENTS, { botIds: ['bot-b'] }, [{ runId: 'run-1', botId: 'bot-a' }]).length,
    0,
  );
  assert.deepEqual(filterRunEvents([], {}), []);
  // limit is a non-negative number: 0 returns nothing, negative is ignored.
  assert.equal(filterRunEvents(EVENTS, { limit: 0 }).length, 0);
  assert.equal(filterRunEvents(EVENTS, { limit: -1 }).length, 7);
  // An unparseable fromAt is ignored (never guessed as a date).
  assert.equal(filterRunEvents(EVENTS, { fromAt: 'not-a-date' }).length, 7);
});

test('observability v3: summarizeEventStream + buckets + tail', () => {
  const summary = summarizeEventStream(EVENTS);
  assert.equal(summary.total, 7);
  assert.equal(summary.byType['tool.call'], 2);
  assert.equal(summary.byType['run.started'], 1);
  assert.equal(summary.byRun['run-1'], 7);
  assert.equal(summary.runs, 1);
  assert.equal(summary.toolCalls, 2);
  assert.equal(summary.errors, 1, 'one tool.result with status error');
  assert.equal(summary.tokensUsed, 60, '40 + 20 from the model.response event');
  assert.equal(summary.firstAt, iso(T0));
  assert.equal(summary.lastAt, iso(T0 + 62_000));
  assert.deepEqual(summarizeEventStream([]), {
    total: 0, byType: {}, byRun: {}, errors: 0, errorRate: 0, tokensUsed: 0, toolCalls: 0, runs: 0, firstAt: null, lastAt: null,
  });

  const buckets = bucketEventStream(EVENTS);
  assert.equal(buckets.length, 2, 'events fall in two minute-aligned buckets');
  assert.equal(buckets[0].count, 4);
  assert.equal(buckets[0].errors, 0);
  assert.equal(buckets[1].count, 3);
  assert.equal(buckets[1].errors, 1);
  assert.equal(bucketEventStream([]).length, 0);

  assert.deepEqual(tailEvents(EVENTS, 2).map((e) => e.seq), [6, 7]);
  assert.equal(tailEvents(EVENTS, 0).length, 0);
  assert.equal(tailEvents(EVENTS, 100).length, 7);
  assert.deepEqual(listEventTypesPresent(EVENTS), [
    'run.started', 'tool.call', 'tool.result', 'model.response', 'run.completed',
  ]);
});

// --- eval harness: CRUD ----------------------------------------------------

function makeSuite(base, name = 'Smoke') {
  return createEvalSuite(base, name, 'Basic checks.');
}

test('observability v3: eval suite + case CRUD with validation', () => {
  const base = tmpDir();
  assert.deepEqual(listEvalSuites(base), []);
  const suite = makeSuite(base);
  assert.match(suite.id, /^eval-smoke-/);
  assert.throws(() => createEvalSuite(base, '  '), /non-empty name/);
  const case1 = addEvalCase(base, suite.id, {
    name: 'Web search used',
    description: 'The run should search the web.',
    prompt: 'Tell me about cats.',
    checks: [{ kind: 'tool-used', tool: 'web_search' }],
  });
  assert.equal(case1.description, 'The run should search the web.');
  assert.equal(case1.prompt, 'Tell me about cats.');
  assert.throws(
    () => addEvalCase(base, suite.id, { name: 'Bad', checks: [{ kind: 'tool-used' }] }),
    /invalid check/,
  );
  assert.throws(() => addEvalCase(base, 'eval-nope', { name: 'X', checks: [{ kind: 'no-errors' }] }), /not found/);
  assert.throws(() => addEvalCase(base, suite.id, { name: 'X', checks: [] }), /at least one check/);
  assert.equal(listEvalSuites(base)[0].cases.length, 1);
  assert.equal(removeEvalCase(base, suite.id, case1.id), true);
  assert.equal(listEvalSuites(base)[0].cases.length, 0);
  assert.equal(removeEvalCase(base, suite.id, case1.id), false);
  assert.equal(removeEvalSuite(base, suite.id), true);
  assert.equal(removeEvalSuite(base, suite.id), false);
  assert.deepEqual(listEvalSuites(base), []);
});

// --- eval harness: scoring -------------------------------------------------

function fakeRun(overrides = {}) {
  return {
    runId: 'run-1',
    botId: 'bot-a',
    status: 'completed',
    prompt: 'Tell me about cats.',
    transcript: [
      { kind: 'text', step: 1, text: 'Cats are lovely.' },
      { kind: 'tool_result', step: 2, callId: 'c1', tool: 'web_search', status: 'ok', outputPreview: 'cats' },
    ],
    toolCalls: [
      { tool: 'web_search', status: 'ok', startedAt: iso(T0 + 1000), finishedAt: iso(T0 + 2000) },
      { tool: 'file_read', status: 'error', startedAt: iso(T0 + 61_000), finishedAt: iso(T0 + 61_500) },
    ],
    fileChanges: [{ path: 'notes.md', action: 'write', at: iso(T0 + 4000) }],
    compileErrors: [],
    errors: ['missing file'],
    steps: 3,
    tokensUsed: 70,
    startedAt: iso(T0),
    endedAt: iso(T0 + 62_000),
    digest: 'deadbeef',
    ...overrides,
  };
}

function scoreOne(check) {
  return scoreEvalCase(
    { id: 'case-x', name: 'Case', description: '', prompt: '', checks: [check], createdAt: iso(T0), updatedAt: iso(T0) },
    fakeRun(),
  );
}

test('observability v3: scoreEvalCase covers every check kind', () => {
  assert.equal(scoreOne({ kind: 'tool-used', tool: 'web_search' }).checks[0].passed, true);
  assert.equal(scoreOne({ kind: 'tool-used', tool: 'email_send' }).checks[0].passed, false);
  assert.equal(scoreOne({ kind: 'tool-not-used', tool: 'email_send' }).checks[0].passed, true);
  assert.equal(scoreOne({ kind: 'tool-not-used', tool: 'web_search' }).checks[0].passed, false);
  assert.equal(scoreOne({ kind: 'no-errors' }).checks[0].passed, false, 'run has one error');
  assert.equal(
    scoreEvalCase(
      { id: 'case-x', name: 'Case', description: '', prompt: '', checks: [{ kind: 'no-errors' }], createdAt: iso(T0), updatedAt: iso(T0) },
      fakeRun({ errors: [] }),
    ).passed,
    true,
  );
  assert.equal(scoreOne({ kind: 'tokens-under', maxTokens: 100 }).checks[0].passed, true);
  assert.equal(scoreOne({ kind: 'tokens-under', maxTokens: 50 }).checks[0].passed, false);
  assert.equal(scoreOne({ kind: 'duration-under', maxMs: 120_000 }).checks[0].passed, true);
  assert.equal(scoreOne({ kind: 'duration-under', maxMs: 10_000 }).checks[0].passed, false);
  assert.equal(scoreOne({ kind: 'text-contains', text: 'lovely' }).checks[0].passed, true);
  assert.equal(scoreOne({ kind: 'text-contains', text: 'dogs' }).checks[0].passed, false);
  assert.equal(scoreOne({ kind: 'file-changed', path: 'notes.md' }).checks[0].passed, true);
  assert.equal(scoreOne({ kind: 'file-changed', path: 'other.md' }).checks[0].passed, false);
  // A case passes only when every check passes; score is the fraction passed.
  const mixed = scoreEvalCase(
    {
      id: 'case-x', name: 'Case', description: '', prompt: '',
      checks: [{ kind: 'tool-used', tool: 'web_search' }, { kind: 'no-errors' }],
      createdAt: iso(T0), updatedAt: iso(T0),
    },
    fakeRun(),
  );
  assert.equal(mixed.passed, false);
  assert.equal(mixed.score, 0.5);
});

test('observability v3: runEvalSuite reports per case, skipped cases do not fail', () => {
  const base = tmpDir();
  const suite = makeSuite(base);
  const passing = addEvalCase(base, suite.id, {
    name: 'Passing',
    checks: [{ kind: 'tool-used', tool: 'web_search' }],
  });
  const failing = addEvalCase(base, suite.id, {
    name: 'Failing',
    checks: [{ kind: 'tool-used', tool: 'email_send' }],
  });
  const skipped = addEvalCase(base, suite.id, {
    name: 'Unscored',
    checks: [{ kind: 'no-errors' }],
  });
  const suiteNow = listEvalSuites(base)[0];
  const report = runEvalSuite(suiteNow, { [passing.id]: fakeRun(), [failing.id]: fakeRun() });
  assert.equal(report.passed, 1);
  assert.equal(report.failed, 1);
  assert.deepEqual(report.skipped, [skipped.id]);
  assert.equal(report.passRate, 0.5);
  assert.equal(report.totalTokens, 140);
  assert.equal(report.slowestMs, 62_000);
  assert.equal(report.results.find((c) => c.caseId === passing.id).passed, true);
  assert.equal(report.results.find((c) => c.caseId === failing.id).passed, false);
  assert.equal(report.results.find((c) => c.caseId === passing.id).runId, 'run-1');

  // A suite with no cases: nothing scored, nothing skipped.
  const empty = runEvalSuite(makeSuite(tmpDir()), {});
  assert.equal(empty.passed, 0);
  assert.equal(empty.failed, 0);
  assert.deepEqual(empty.skipped, []);
  assert.equal(empty.slowestMs, null);
});
