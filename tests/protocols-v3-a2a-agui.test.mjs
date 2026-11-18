/**
 * Tests for v1.19 (Team T3) — protocols v3, part 3:
 * packages/core/src/protocolsV3/a2aTwoWayV3.ts
 * packages/core/src/protocolsV3/aguiV3.ts
 *
 * Covers:
 *  - A2A frames: validation (good + every bad shape), upstream /
 *    downstream kind guards.
 *  - Send window: size, queue-while-full, ack releases queued
 *    frames, untracked frames never occupy a slot, pending frames
 *    for resume, queue-full + bad-size errors.
 *  - Two-way channel (in-process loopback): input / interrupt /
 *    cancel client->agent, status / message / artifact chunks /
 *    artifactDone / done / error agent->client, artifact assembly
 *    by chunk index, role enforcement (WRONG_ROLE is the typed
 *    A2aV3Error, not a ReferenceError — regression test for the
 *    rename fix), non-terminal done refused, oversize chunk
 *    refused, closed channel refuses sends, pause/unpause,
 *    duplicate inbound frames dropped, wrong-task frames ignored,
 *    resume re-sends unacked frames, heartbeat timer + stats.
 *  - AG-UI: event validation + building (unknown type refused),
 *    sequence-gap detection, run lifecycle (idle/running/paused/
 *    finished/error/cancelled), text + thinking accumulation,
 *    tool-call + subagent tracking, state snapshot/delta,
 *    generative-UI events, interrupt raise/resolve/cancel/timeout
 *    (finish deferred while an interrupt is pending), replay from
 *    a sequence, snapshot, event-buffer cap.
 *
 * No network, no model. Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/protocols-v3-a2a-agui.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  A2A_V3_DEFAULT_HEARTBEAT_MS,
  A2A_V3_DEFAULT_WINDOW,
  A2A_V3_MAX_CHUNK_BYTES,
  A2A_V3_MAX_QUEUED_FRAMES,
  A2A_V3_VERSION,
  A2aV3Error,
  A2aV3SendWindow,
  createLoopbackTwoWayChannel,
  isA2aV3DownstreamKind,
  isA2aV3UpstreamKind,
  validateA2aV3Frame,
} from '../packages/core/dist/protocolsV3/a2aTwoWayV3.js';
import { makeTextMessage } from '../packages/core/dist/a2a/types.js';
import {
  AGUI_V3_MAX_BUFFERED_EVENTS,
  AGUI_V3_VERSION,
  AgUiV3Error,
  AgUiV3Run,
  buildAgUiV3Event,
  detectAgUiV3Gaps,
  validateAgUiV3Event,
} from '../packages/core/dist/protocolsV3/aguiV3.js';

// ---------------------------------------------------------------------------
// A2A frames
// ---------------------------------------------------------------------------

function goodFrame(overrides = {}) {
  return {
    direction: 'down',
    kind: 'status',
    taskId: 'task-1',
    sequence: 0,
    payload: { state: 'working' },
    at: new Date().toISOString(),
    ...overrides,
  };
}

test('v3 a2a: frame validation (good + every bad shape)', () => {
  const ok = validateA2aV3Frame(goodFrame());
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.frame.taskId, 'task-1');

  const bad = [
    [null, /must be an object/],
    [[], /must be an object/],
    [goodFrame({ direction: 'sideways' }), /direction/],
    [goodFrame({ kind: '' }), /kind/],
    [goodFrame({ taskId: '' }), /taskId/],
    [goodFrame({ sequence: -1 }), /sequence/],
    [goodFrame({ sequence: 1.5 }), /sequence/],
    [goodFrame({ payload: null }), /payload/],
    [goodFrame({ payload: [] }), /payload/],
  ];
  for (const [value, pattern] of bad) {
    const out = validateA2aV3Frame(value);
    assert.equal(out.ok, false, JSON.stringify(value));
    assert.match(out.reason, pattern);
  }
});

test('v3 a2a: upstream / downstream kind guards', () => {
  assert.equal(A2A_V3_VERSION, '1.1');
  for (const kind of ['input', 'interrupt', 'cancel', 'ack', 'heartbeat']) {
    assert.equal(isA2aV3UpstreamKind(kind), true, kind);
  }
  assert.equal(isA2aV3UpstreamKind('status'), false);
  assert.equal(isA2aV3UpstreamKind('nope'), false);
  for (const kind of ['status', 'message', 'artifactChunk', 'artifactDone', 'error', 'done', 'heartbeat']) {
    assert.equal(isA2aV3DownstreamKind(kind), true, kind);
  }
  assert.equal(isA2aV3DownstreamKind('input'), false);
  assert.equal(isA2aV3DownstreamKind('nope'), false);
  assert.equal(A2A_V3_DEFAULT_WINDOW, 16);
  assert.equal(A2A_V3_DEFAULT_HEARTBEAT_MS, 15_000);
});

// ---------------------------------------------------------------------------
// A2A send window
// ---------------------------------------------------------------------------

test('v3 a2a: send window — queue while full, ack releases, untracked is free', () => {
  const window = new A2aV3SendWindow(2);
  assert.equal(window.getSize(), 2);
  assert.equal(window.peekSequence(), 0);
  assert.equal(window.canSend(), true);
  const first = window.register('up', 't', 'input', {});
  assert.equal(first.sendNow, true);
  assert.equal(first.frame.sequence, 0);
  const second = window.register('up', 't', 'input', {});
  assert.equal(second.sendNow, true);
  assert.equal(window.canSend(), false);
  assert.equal(window.unackedCount(), 2);
  const third = window.register('up', 't', 'input', {});
  assert.equal(third.sendNow, false);
  assert.equal(third.frame.sequence, 2);
  assert.equal(window.queuedCount(), 1);
  // Ack through 0 frees one slot and releases the queued frame.
  const released = window.ackThrough(0);
  assert.equal(released.length, 1);
  assert.equal(released[0].sequence, 2);
  assert.equal(window.queuedCount(), 0);
  assert.equal(window.unackedCount(), 2);
  // Untracked frames (acks/heartbeats) never occupy a slot.
  const untracked = window.registerUntracked('up', 't', 'ack', { ackSequence: 0 });
  assert.equal(untracked.sequence, 3);
  assert.equal(window.unackedCount(), 2);
  assert.equal(window.peekSequence(), 4);
  // Pending frames (for resume) are sorted by sequence.
  assert.deepEqual(window.pendingFrames().map((f) => f.sequence), [1, 2]);
  assert.throws(
    () => new A2aV3SendWindow(0),
    (err) => err instanceof A2aV3Error && err.code === 'BAD_WINDOW',
  );
});

test('v3 a2a: send window — queue-full error', () => {
  const window = new A2aV3SendWindow(1);
  window.register('up', 't', 'input', {});
  for (let i = 0; i < A2A_V3_MAX_QUEUED_FRAMES; i++) {
    window.register('up', 't', 'input', {});
  }
  assert.equal(window.queuedCount(), A2A_V3_MAX_QUEUED_FRAMES);
  assert.throws(
    () => window.register('up', 't', 'input', {}),
    (err) => err instanceof A2aV3Error && err.code === 'WINDOW_QUEUE_FULL',
  );
});

// ---------------------------------------------------------------------------
// A2A two-way channel (loopback)
// ---------------------------------------------------------------------------

function workingTask() {
  return { id: 'task-1', contextId: 'ctx-1', status: { state: 'working' } };
}

function completedTask() {
  return { id: 'task-1', contextId: 'ctx-1', status: { state: 'completed' } };
}

test('v3 a2a: loopback channel — full exchange both directions', async () => {
  const seen = { input: [], status: [], message: [], chunk: [], done: [], error: [] };
  const { client, agent } = createLoopbackTwoWayChannel(
    workingTask(),
    {
      onStatus: (state, note) => seen.status.push([state, note]),
      onMessage: (message) => seen.message.push(message),
      onArtifactChunk: (chunk) => seen.chunk.push(chunk),
      onDone: (task) => seen.done.push(task),
      onError: (error) => seen.error.push(error),
    },
    {
      onInput: (message) => seen.input.push(message),
      onInterrupt: () => seen.input.push('interrupt'),
      onCancel: () => seen.input.push('cancel'),
    },
    { heartbeatMs: 0 },
  );
  try {
    assert.equal(client.getStatus(), 'open');
    assert.equal(client.getTaskState(), 'working');

    await client.sendInput(makeTextMessage('user', 'hello'));
    assert.equal(seen.input.length, 1);
    assert.equal(seen.input[0].parts[0].text, 'hello');

    const statusFrame = await agent.sendStatus('working', 'still going');
    assert.equal(statusFrame.kind, 'status');
    assert.deepEqual(seen.status, [['working', 'still going']]);
    assert.equal(client.getTaskState(), 'working');

    await agent.sendMessage(makeTextMessage('agent', 'working on it'));
    assert.equal(seen.message.length, 1);
    assert.equal(seen.message[0].parts[0].text, 'working on it');

    // Chunks arrive out of order but assemble by index.
    await agent.sendArtifactChunk({ artifactId: 'a1', index: 1, data: 'world', encoding: 'utf8' });
    await agent.sendArtifactChunk({ artifactId: 'a1', index: 0, data: 'hello ', encoding: 'utf8' });
    assert.equal(client.artifactText('a1'), 'hello world');
    assert.deepEqual(client.artifactIds(), ['a1']);
    assert.equal(seen.chunk.length, 2);
    await agent.sendArtifactDone('a1');

    await agent.sendDone(completedTask());
    assert.equal(seen.done.length, 1);
    assert.equal(seen.done[0].status.state, 'completed');
    assert.equal(client.getTaskState(), 'completed');
    assert.equal(client.lastReceived() >= 0, true);
    assert.ok(client.received().length >= 5);

    await agent.sendError('something broke');
    assert.deepEqual(seen.error, ['something broke']);

    await client.sendInterrupt('change of plan', 'use the other tool');
    await client.sendCancel();
    assert.deepEqual(seen.input.slice(1), ['interrupt', 'cancel']);

    const beat = await client.sendHeartbeat();
    assert.equal(beat.kind, 'heartbeat');
    assert.deepEqual(client.heartbeatStats(), { sent: 1, received: 0 });
  } finally {
    client.close();
    agent.close();
  }
  assert.equal(client.getStatus(), 'closed');
  assert.equal(agent.getStatus(), 'closed');
});

test('v3 a2a: role enforcement + closed channel + non-terminal done + oversize chunk', async () => {
  const { client, agent } = createLoopbackTwoWayChannel(workingTask(), {}, {}, { heartbeatMs: 0 });
  try {
    // Wrong role: the typed A2aV3Error (this used to be a ReferenceError
    // before the rename fix — the class was A2aTwoWayV3Error while the
    // throw sites said A2aV3Error).
    await assert.rejects(
      () => agent.sendInput(makeTextMessage('agent', 'x')),
      (err) => err instanceof A2aV3Error && err.code === 'WRONG_ROLE',
    );
    await assert.rejects(
      () => client.sendStatus('working'),
      (err) => err instanceof A2aV3Error && err.code === 'WRONG_ROLE',
    );
    await assert.rejects(
      () => client.sendMessage(makeTextMessage('user', 'x')),
      (err) => err instanceof A2aV3Error && err.code === 'WRONG_ROLE',
    );
    await assert.rejects(
      () => agent.sendDone(workingTask()),
      (err) => err instanceof A2aV3Error && err.code === 'NOT_TERMINAL',
    );
    await assert.rejects(
      () => agent.sendArtifactChunk({
        artifactId: 'big', index: 0, data: 'x'.repeat(A2A_V3_MAX_CHUNK_BYTES + 1), encoding: 'utf8',
      }),
      (err) => err instanceof A2aV3Error && err.code === 'CHUNK_TOO_LARGE',
    );

    client.close();
    await assert.rejects(
      () => client.sendInput(makeTextMessage('user', 'late')),
      (err) => err instanceof A2aV3Error && err.code === 'CHANNEL_CLOSED',
    );
  } finally {
    client.close();
    agent.close();
  }
});

test('v3 a2a: pause/unpause, duplicate + wrong-task frames dropped, resume re-sends', async () => {
  // Pause: inbound frames are still recorded while paused.
  const { client, agent } = createLoopbackTwoWayChannel(workingTask(), {}, {}, { heartbeatMs: 0 });
  try {
    client.pause();
    assert.equal(client.getStatus(), 'paused');
    await agent.sendStatus('working');
    assert.equal(client.received().length, 1);
    client.unpause();
    assert.equal(client.getStatus(), 'open');
  } finally {
    client.close();
    agent.close();
  }

  // Manual transport: duplicates dropped, wrong-task + invalid ignored.
  let handler = null;
  const sent = [];
  const transport = {
    send: (frame) => { sent.push(frame); },
    onFrame: (h) => { handler = h; return () => { handler = null; }; },
  };
  const { A2aV3TwoWayChannel } = await import('../packages/core/dist/protocolsV3/a2aTwoWayV3.js');
  const solo = new A2aV3TwoWayChannel(workingTask(), 'client', transport, {}, { heartbeatMs: 0 });
  try {
    const frame = goodFrame({ direction: 'down', kind: 'status', sequence: 0, payload: { state: 'working' } });
    handler(frame);
    handler(frame); // duplicate sequence — dropped
    handler(goodFrame({ taskId: 'other-task', sequence: 1 }));
    handler({ direction: 'down', kind: 'status', taskId: 'task-1', sequence: 2, payload: null, at: '' });
    assert.equal(solo.received().length, 1);
    assert.equal(solo.lastReceived(), 0);
    // The channel acked the one accepted frame.
    assert.ok(sent.some((f) => f.kind === 'ack' && f.payload.ackSequence === 0));

    // Resume re-sends unacked frames.
    await solo.sendInput(makeTextMessage('user', 'again'));
    const sentBefore = sent.length;
    const resent = await solo.resume();
    assert.equal(resent, 1);
    assert.equal(sent.length, sentBefore + 1);
  } finally {
    solo.close();
  }
});

test('v3 a2a: heartbeat timer sends on schedule', async () => {
  const { client, agent } = createLoopbackTwoWayChannel(
    workingTask(), {}, {}, { heartbeatMs: 15, windowSize: 4 },
  );
  try {
    await new Promise((resolve) => setTimeout(resolve, 70));
    assert.ok(client.heartbeatStats().sent >= 1, `sent=${client.heartbeatStats().sent}`);
    assert.ok(agent.heartbeatStats().received >= 1, `received=${agent.heartbeatStats().received}`);
  } finally {
    client.close();
    agent.close();
  }
});

// ---------------------------------------------------------------------------
// AG-UI events
// ---------------------------------------------------------------------------

test('v3 agui: validate + build events, unknown type refused', () => {
  assert.equal(AGUI_V3_VERSION, '1.0');
  const event = buildAgUiV3Event('TEXT_MESSAGE_CONTENT', 'run-1', 0, { delta: 'hi' });
  assert.equal(event.type, 'TEXT_MESSAGE_CONTENT');
  assert.equal(event.runId, 'run-1');
  assert.equal(event.sequence, 0);
  assert.deepEqual(validateAgUiV3Event(event), []);

  const problems = validateAgUiV3Event({
    type: 'NOPE', runId: '', sequence: -1, timestamp: 'not-a-date', data: null,
  });
  assert.ok(problems.length >= 4);
  assert.deepEqual(validateAgUiV3Event(null), ['event is not an object']);
  assert.deepEqual(validateAgUiV3Event('x'), ['event is not an object']);

  assert.throws(
    () => buildAgUiV3Event('NOPE', 'run-1', 0, {}),
    (err) => err instanceof AgUiV3Error && err.code === 'INVALID_EVENT',
  );
});

test('v3 agui: sequence-gap detection', () => {
  const events = [0, 1, 3, 4, 7].map((sequence) =>
    buildAgUiV3Event('TEXT_MESSAGE_CONTENT', 'run-1', sequence, { delta: 'x' }));
  assert.deepEqual(detectAgUiV3Gaps(events), [{ from: 2, to: 2 }, { from: 5, to: 6 }]);
  assert.deepEqual(detectAgUiV3Gaps([]), []);
  const contiguous = [0, 1, 2].map((sequence) =>
    buildAgUiV3Event('TEXT_MESSAGE_CONTENT', 'run-1', sequence, { delta: 'x' }));
  assert.deepEqual(detectAgUiV3Gaps(contiguous), []);
});

// ---------------------------------------------------------------------------
// AG-UI run
// ---------------------------------------------------------------------------

test('v3 agui run: lifecycle, text/thinking, tool calls, state, subagents, generative UI', () => {
  const emitted = [];
  const run = new AgUiV3Run('run-1', { title: 'Demo', onEvent: (e) => emitted.push(e) });
  assert.equal(run.getStatus(), 'idle');
  assert.equal(run.eventCount(), 0);
  assert.throws(() => run.textDelta('x'), (err) => err instanceof AgUiV3Error && err.code === 'BAD_STATE');
  assert.throws(() => run.finish(), (err) => err instanceof AgUiV3Error && err.code === 'BAD_STATE');

  const started = run.start();
  assert.equal(started.type, 'RUN_STARTED');
  assert.equal(run.getStatus(), 'running');
  assert.throws(() => run.start(), (err) => err instanceof AgUiV3Error && err.code === 'BAD_STATE');

  run.textDelta('hello ');
  run.textDelta('world', 'msg-1');
  run.thinkingDelta('hmm');
  assert.equal(run.snapshot().text, 'hello world');
  assert.equal(run.snapshot().thinkingText, 'hmm');

  run.toolCallStart('tc-1', 'web_search');
  run.toolCallArgs('tc-1', '{"q":');
  run.toolCallArgs('tc-1', '"cats"}');
  run.toolCallEnd('tc-1');
  run.toolCallResult('tc-1', '3 results');
  assert.throws(
    () => run.toolCallArgs('tc-nope', 'x'),
    (err) => err instanceof AgUiV3Error && err.code === 'UNKNOWN_TOOL_CALL',
  );
  const tool = run.snapshot().toolCalls.find((t) => t.toolCallId === 'tc-1');
  assert.equal(tool.status, 'result');
  assert.equal(tool.argsText, '{"q":"cats"}');
  assert.equal(tool.resultText, '3 results');

  run.toolCallStart('tc-2', 'failing_tool');
  run.toolCallError('tc-2', 'boom');
  assert.equal(run.snapshot().toolCalls.find((t) => t.toolCallId === 'tc-2').status, 'error');

  run.stateSnapshot({ todos: 2 });
  run.stateDelta({ done: 1 });
  assert.deepEqual(run.snapshot().state, { todos: 2, done: 1 });

  run.subagentStart('sub-1', 'researcher');
  run.subagentFinish('sub-1');
  run.subagentStart('sub-2');
  run.subagentError('sub-2', 'timeout');
  assert.throws(
    () => run.subagentFinish('sub-nope'),
    (err) => err instanceof AgUiV3Error && err.code === 'UNKNOWN_SUBAGENT',
  );
  assert.deepEqual(
    run.snapshot().subagents.map((s) => [s.subagentId, s.status]),
    [['sub-1', 'finished'], ['sub-2', 'error']],
  );

  run.generativeUiStart('surface-1', 'v3-tabs');
  run.generativeUiDelta('surface-1', { activeTab: 'a' });
  run.generativeUiEnd('surface-1');
  run.activity('almost done');

  // Sequences are contiguous from 0; replay re-emits from a sequence.
  const buffered = run.bufferedEvents();
  assert.deepEqual(buffered.map((e) => e.sequence), buffered.map((_, i) => i));
  assert.equal(emitted.length, buffered.length);
  assert.deepEqual(run.replayFrom(2).map((e) => e.sequence), buffered.slice(2).map((e) => e.sequence));

  const finished = run.finish();
  assert.equal(finished.type, 'RUN_FINISHED');
  assert.equal(run.getStatus(), 'finished');
  assert.equal(run.snapshot().status, 'finished');
  assert.equal(run.snapshot().eventCount, run.eventCount());
});

test('v3 agui run: interrupt raise / resolve / cancel, finish deferred while pending', async () => {
  const run = new AgUiV3Run('run-2');
  run.start();
  run.textDelta('before');

  const first = run.raiseInterrupt('approval', { question: 'Proceed?' });
  assert.equal(run.getStatus(), 'paused');
  assert.equal(run.getPendingInterrupt().interruptId, first.interruptId);
  assert.equal(run.getPendingInterrupt().kind, 'approval');
  assert.throws(
    () => run.raiseInterrupt('form', {}),
    (err) => err instanceof AgUiV3Error && err.code === 'INTERRUPT_PENDING',
  );
  assert.throws(() => run.textDelta('blocked'), (err) => err instanceof AgUiV3Error && err.code === 'PAUSED');
  // Finish is deferred while the interrupt is pending.
  assert.equal(run.finish(), null);
  assert.equal(run.getStatus(), 'paused');

  const resolved = run.resolveInterrupt(first.interruptId, { approved: true });
  assert.equal(resolved.type, 'INTERRUPT_RESOLVED');
  assert.equal(run.getStatus(), 'finished'); // deferred finish ran
  assert.deepEqual(await first.answer, { approved: true });
  assert.equal(run.getPendingInterrupt(), null);
  assert.throws(
    () => run.resolveInterrupt(first.interruptId, {}),
    (err) => err instanceof AgUiV3Error && err.code === 'NO_SUCH_INTERRUPT',
  );

  // Cancel path: the answer promise rejects.
  const run2 = new AgUiV3Run('run-3');
  run2.start();
  const pending = run2.raiseInterrupt('choice', { options: ['a', 'b'] });
  const answer = pending.answer;
  answer.catch(() => {}); // avoid an unhandled rejection while asserting
  const cancelled = run2.cancelInterrupt(pending.interruptId);
  assert.equal(cancelled.type, 'INTERRUPT_CANCELLED');
  assert.equal(run2.getStatus(), 'running');
  await assert.rejects(
    answer,
    (err) => err instanceof AgUiV3Error && err.code === 'INTERRUPT_CANCELLED',
  );
  const finished = run2.finish();
  assert.equal(finished.type, 'RUN_FINISHED');
});

test('v3 agui run: interrupt timeout rejects the answer', async () => {
  const run = new AgUiV3Run('run-4', { interruptTimeoutMs: 20 });
  run.start();
  const pending = run.raiseInterrupt('form', { fields: ['name'] });
  const answer = pending.answer;
  answer.catch(() => {});
  await assert.rejects(answer, /timeout/);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(run.getStatus(), 'running');
  assert.equal(run.getPendingInterrupt(), null);
  assert.ok(run.bufferedEvents().some((e) => e.type === 'INTERRUPT_TIMEOUT'));
  run.finish();
});

test('v3 agui run: fail + cancel, event-buffer cap', () => {
  const failing = new AgUiV3Run('run-5');
  failing.start();
  const failed = failing.fail('model exploded');
  assert.equal(failed.type, 'RUN_ERROR');
  assert.equal(failing.getStatus(), 'error');

  const cancelling = new AgUiV3Run('run-6');
  cancelling.start();
  const cancelled = cancelling.cancel();
  assert.equal(cancelled.type, 'RUN_CANCELLED');
  assert.equal(cancelling.getStatus(), 'cancelled');

  // The buffer keeps at most AGUI_V3_MAX_BUFFERED_EVENTS events.
  assert.equal(AGUI_V3_MAX_BUFFERED_EVENTS, 2000);
  const big = new AgUiV3Run('run-7');
  big.start();
  for (let i = 0; i < AGUI_V3_MAX_BUFFERED_EVENTS + 5; i++) big.textDelta('x');
  assert.equal(big.bufferedEvents().length, AGUI_V3_MAX_BUFFERED_EVENTS);
  assert.equal(big.eventCount(), AGUI_V3_MAX_BUFFERED_EVENTS);
});
