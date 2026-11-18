/**
 * Protocols v4 — AG-UI 1.0 conformance tests (v1.20, Team T2).
 *
 * Covers packages/core/src/protocolsV4/aguiConformanceV4.ts: the
 * spec 1.0 vocabulary (31 types), the gap report between
 * open-bot's vocabulary and the schema, builders + validators
 * for the missing spec event types, the stream checker
 * (ordering, terminal, sequence, THINKING_* rejection,
 * RUN_FINISHED outcome), and the open-bot -> spec translator.
 *
 * No network, no provider: everything runs in-process against
 * the built core dist.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/protocols-v120-agui-conformance.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AGUI_V4_SPEC_EVENT_TYPES,
  agUiV4ConformanceReport,
  agUiV4SpecEventFamily,
  checkAgUiV4Stream,
  isAgUiV4SpecEventType,
  makeAgUiV4SpecEvent,
  translateOpenBotEventToSpecV4,
  validateAgUiV4SpecEvent,
} from '../packages/core/dist/index.js';

test('spec vocabulary is 31 types across 8 families', () => {
  assert.equal(AGUI_V4_SPEC_EVENT_TYPES.length, 31);
  assert.equal(new Set(AGUI_V4_SPEC_EVENT_TYPES).size, 31);
  const byFamily = {};
  for (const t of AGUI_V4_SPEC_EVENT_TYPES) {
    const f = agUiV4SpecEventFamily(t);
    byFamily[f] = (byFamily[f] ?? 0) + 1;
  }
  assert.deepEqual(byFamily, {
    run: 5,
    text: 4,
    tool: 5,
    state: 3,
    reasoning: 7,
    activity: 2,
    raw: 2,
    subagents: 3,
  });
  assert.equal(isAgUiV4SpecEventType('REASONING_START'), true);
  assert.equal(isAgUiV4SpecEventType('THINKING_CONTENT'), false);
  assert.equal(isAgUiV4SpecEventType('RUN_CANCELLED'), false);
  assert.equal(isAgUiV4SpecEventType('STEP_STARTED'), true);
});

test('conformance report names the real gap: 13 missing, 13 open-bot-only, 18 shared', () => {
  const report = agUiV4ConformanceReport();
  assert.equal(report.conformant, false);
  assert.equal(report.missingSpecTypes.length, 13);
  assert.equal(report.openBotOnlyTypes.length, 13);
  assert.equal(report.sharedTypes.length, 18);
  for (const t of ['STEP_STARTED', 'STEP_FINISHED', 'TEXT_MESSAGE_CHUNK', 'TOOL_CALL_CHUNK',
    'REASONING_START', 'REASONING_MESSAGE_START', 'REASONING_MESSAGE_CONTENT',
    'REASONING_MESSAGE_END', 'REASONING_MESSAGE_CHUNK', 'REASONING_END',
    'REASONING_ENCRYPTED_VALUE', 'ACTIVITY_SNAPSHOT', 'ACTIVITY_DELTA']) {
    assert.ok(report.missingSpecTypes.includes(t), `missing should include ${t}`);
  }
  for (const t of ['THINKING_CONTENT', 'RUN_CANCELLED', 'RUN_PAUSED', 'TOOL_CALL_ERROR',
    'INTERRUPT_STARTED', 'INTERRUPT_RESOLVED', 'INTERRUPT_CANCELLED', 'INTERRUPT_TIMEOUT',
    'GENERATIVE_UI_START', 'GENERATIVE_UI_DELTA', 'GENERATIVE_UI_END', 'GENERATIVE_UI_RESPONSE',
    'ACTIVITY']) {
    assert.ok(report.openBotOnlyTypes.includes(t), `open-bot-only should include ${t}`);
  }
  assert.equal(report.mappings.length, 13);
  assert.match(report.summary, /13 spec 1\.0 type\(s\) missing/);
});

test('spec event builders validate required data; encrypted reasoning stays opaque', () => {
  const reasoning = makeAgUiV4SpecEvent('REASONING_MESSAGE_CONTENT', 'run-1', 0, {
    messageId: 'r-1',
    delta: 'thinking…',
  });
  assert.equal(reasoning.type, 'REASONING_MESSAGE_CONTENT');
  assert.deepEqual(validateAgUiV4SpecEvent(reasoning), []);

  const step = makeAgUiV4SpecEvent('STEP_STARTED', 'run-1', 1, { stepName: 'plan' });
  assert.equal(step.data.stepName, 'plan');

  const encrypted = makeAgUiV4SpecEvent('REASONING_ENCRYPTED_VALUE', 'run-1', 2, {
    messageId: 'r-1',
    value: 'opaque-blob',
  });
  assert.equal(encrypted.data.value, 'opaque-blob');
  assert.deepEqual(validateAgUiV4SpecEvent(encrypted), []);

  assert.throws(
    () => makeAgUiV4SpecEvent('REASONING_MESSAGE_CONTENT', 'run-1', 3, { delta: 'x' }),
    /messageId is required/,
  );
  assert.throws(
    () => makeAgUiV4SpecEvent('REASONING_ENCRYPTED_VALUE', 'run-1', 4, { messageId: 'r-1', value: '' }),
    /non-empty opaque string/,
  );
  assert.throws(
    () => makeAgUiV4SpecEvent('THINKING_CONTENT', 'run-1', 5, { delta: 'x' }),
    /not an AG-UI 1\.0 schema event type/,
  );
  assert.ok(
    validateAgUiV4SpecEvent({ type: 'RUN_FINISHED', runId: 'run-1', sequence: 6, data: {} })
      .some((p) => p.includes('outcome')),
  );
  assert.ok(
    validateAgUiV4SpecEvent({
      type: 'RUN_FINISHED', runId: 'run-1', sequence: 6,
      data: { outcome: { type: 'success' } },
    }).length === 0,
  );
});

test('stream checker accepts a conformant stream', () => {
  const stream = [
    { type: 'RUN_STARTED', sequence: 0, data: {} },
    { type: 'STEP_STARTED', sequence: 1, data: { stepName: 'plan' } },
    { type: 'TEXT_MESSAGE_START', sequence: 2, data: { messageId: 'm-1' } },
    { type: 'TEXT_MESSAGE_CONTENT', sequence: 3, data: { messageId: 'm-1', delta: 'hi' } },
    { type: 'TEXT_MESSAGE_END', sequence: 4, data: { messageId: 'm-1' } },
    { type: 'STEP_FINISHED', sequence: 5, data: { stepName: 'plan' } },
    { type: 'RUN_FINISHED', sequence: 6, data: { outcome: { type: 'success' } } },
  ];
  assert.deepEqual(checkAgUiV4Stream(stream), { ok: true, violations: [] });
});

test('stream checker rejects every spec violation it is asked about', () => {
  const base = (overrides) => ([
    { type: 'RUN_STARTED', sequence: 0, data: {} },
    { type: 'RUN_FINISHED', sequence: 1, data: { outcome: { type: 'success' } } },
  ].map((e, i) => ({ ...e, ...(overrides?.[i] ?? {}) })));

  assert.match(checkAgUiV4Stream([]).violations.join(' '), /empty/);

  const notStartedFirst = checkAgUiV4Stream(base({ 0: { type: 'TEXT_MESSAGE_START' } }));
  assert.equal(notStartedFirst.ok, false);
  assert.ok(notStartedFirst.violations.some((v) => v.includes('RUN_STARTED')));

  const noTerminal = checkAgUiV4Stream([{ type: 'RUN_STARTED', sequence: 0, data: {} }]);
  assert.ok(noTerminal.violations.some((v) => v.includes('no terminal event')));

  const afterTerminal = checkAgUiV4Stream([
    { type: 'RUN_STARTED', sequence: 0, data: {} },
    { type: 'RUN_FINISHED', sequence: 1, data: { outcome: { type: 'success' } } },
    { type: 'TEXT_MESSAGE_CONTENT', sequence: 2, data: { messageId: 'm-1', delta: 'late' } },
  ]);
  assert.ok(afterTerminal.violations.some((v) => v.includes('not last')));

  const thinking = checkAgUiV4Stream([
    { type: 'RUN_STARTED', sequence: 0, data: {} },
    { type: 'THINKING_CONTENT', sequence: 1, data: { delta: 'x' } },
    { type: 'RUN_FINISHED', sequence: 2, data: { outcome: { type: 'success' } } },
  ]);
  assert.ok(thinking.violations.some((v) => v.includes('THINKING_CONTENT')));

  const gap = checkAgUiV4Stream([
    { type: 'RUN_STARTED', sequence: 0, data: {} },
    { type: 'RUN_FINISHED', sequence: 5, data: { outcome: { type: 'success' } } },
  ]);
  assert.ok(gap.violations.some((v) => v.includes('sequence 5')));

  const unclosed = checkAgUiV4Stream([
    { type: 'RUN_STARTED', sequence: 0, data: {} },
    { type: 'TEXT_MESSAGE_START', sequence: 1, data: { messageId: 'm-1' } },
    { type: 'RUN_FINISHED', sequence: 2, data: { outcome: { type: 'success' } } },
  ]);
  assert.ok(unclosed.violations.some((v) => v.includes('never ended')));

  const noOutcome = checkAgUiV4Stream([
    { type: 'RUN_STARTED', sequence: 0, data: {} },
    { type: 'RUN_FINISHED', sequence: 1, data: {} },
  ]);
  assert.ok(noOutcome.violations.some((v) => v.includes('outcome')));

  const unknown = checkAgUiV4Stream([
    { type: 'RUN_STARTED', sequence: 0, data: {} },
    { type: 'WIDGET_SPIN', sequence: 1, data: {} },
    { type: 'RUN_FINISHED', sequence: 2, data: { outcome: { type: 'success' } } },
  ]);
  assert.ok(unknown.violations.some((v) => v.includes('WIDGET_SPIN')));
});

test('translator maps open-bot-only events onto the spec wire', () => {
  const cancelled = translateOpenBotEventToSpecV4(
    { type: 'RUN_CANCELLED', runId: 'r', sequence: 1, data: {} },
  );
  assert.equal(cancelled.dropped, false);
  assert.equal(cancelled.events[0].type, 'RUN_FINISHED');
  assert.equal(cancelled.events[0].data.outcome.type, 'cancelled');

  const paused = translateOpenBotEventToSpecV4(
    { type: 'RUN_PAUSED', runId: 'r', sequence: 1, data: {} },
  );
  assert.equal(paused.events[0].data.outcome.type, 'interrupt');

  const thinkingPrivate = translateOpenBotEventToSpecV4(
    { type: 'THINKING_CONTENT', runId: 'r', sequence: 1, data: { messageId: 't-1', delta: 'x' } },
  );
  assert.equal(thinkingPrivate.dropped, true);
  assert.deepEqual(thinkingPrivate.events, []);

  const thinkingOptIn = translateOpenBotEventToSpecV4(
    { type: 'THINKING_CONTENT', runId: 'r', sequence: 1, data: { messageId: 't-1', delta: 'x' } },
    { allowReasoning: true },
  );
  assert.equal(thinkingOptIn.events[0].type, 'REASONING_MESSAGE_CONTENT');

  const interrupt = translateOpenBotEventToSpecV4(
    { type: 'INTERRUPT_STARTED', runId: 'r', sequence: 1, data: { interruptId: 'i-1', kind: 'approval', title: 'ok?' } },
  );
  assert.equal(interrupt.dropped, true);
  assert.match(interrupt.note, /RUN_FINISHED outcome/);

  const toolError = translateOpenBotEventToSpecV4(
    { type: 'TOOL_CALL_ERROR', runId: 'r', sequence: 1, data: { toolCallId: 'tc-1', toolName: 'read', message: 'boom' } },
  );
  assert.equal(toolError.events[0].type, 'TOOL_CALL_RESULT');
  assert.equal(toolError.events[0].data.status, 'error');

  const genui = translateOpenBotEventToSpecV4(
    { type: 'GENERATIVE_UI_START', runId: 'r', sequence: 1, data: { componentId: 'c-1', kind: 'card' } },
  );
  assert.equal(genui.events[0].type, 'CUSTOM');
  assert.equal(genui.events[0].data.name, 'generative-ui:start');

  const activity = translateOpenBotEventToSpecV4(
    { type: 'ACTIVITY', runId: 'r', sequence: 1, data: { kind: 'progress', message: 'working' } },
  );
  assert.equal(activity.events[0].type, 'ACTIVITY_SNAPSHOT');

  const shared = translateOpenBotEventToSpecV4(
    { type: 'TEXT_MESSAGE_CONTENT', runId: 'r', sequence: 1, data: { messageId: 'm-1', delta: 'hi' } },
  );
  assert.equal(shared.dropped, false);
  assert.equal(shared.events[0].type, 'TEXT_MESSAGE_CONTENT');
});
