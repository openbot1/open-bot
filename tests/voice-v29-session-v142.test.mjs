/**
 * Tests for the voice v29 full-duplex session (v1.42, Team T4).
 *
 * Covers the session lifecycle (start / pause / resume / stop),
 * feeding user frames until a turn ends, server-driven responses,
 * barge-in (interrupt + resume remainder), a cascaded pipeline
 * turn, delegated async tool calling, proactive audio and
 * per-minute cost metering — all on the virtual clock, mock-only.
 *
 * All offline, deterministic, no key / network / audio.
 * Only the v29 namespace is asserted — no global totals.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createFullDuplexSessionV29,
} from '../packages/core/dist/voiceV29/index.js';

function feedSpeech(session, fromMs, frames, energy = 0.8) {
  let last = null;
  for (let i = 0; i < frames; i += 1) {
    last = session.feedUserFrame({ atMs: fromMs + i * 50, energy });
  }
  return last;
}

function feedSilence(session, fromMs, frames) {
  let last = null;
  for (let i = 0; i < frames; i += 1) {
    last = session.feedUserFrame({ atMs: fromMs + i * 50, energy: 0.02 });
  }
  return last;
}

test('v29 session lifecycle: start, pause, resume, stop', () => {
  const session = createFullDuplexSessionV29({ sessionId: 'life', modelId: 'mock-cascaded' });
  assert.equal(session.getState(), 'idle');
  const started = session.start(0);
  assert.equal(started.state, 'listening');
  assert.equal(started.sessionId, 'life');
  assert.equal(started.modelId, 'mock-cascaded');
  assert.equal(started.architecture, 'cascaded');
  const paused = session.pause(100);
  assert.equal(paused.state, 'paused');
  const resumed = session.resume(200);
  assert.equal(resumed.state, 'listening');
  const stopped = session.stop(300);
  assert.equal(stopped.state, 'ended');
  assert.throws(() => session.start(400), /Cannot start/);
});

test('v29 session: unknown model id is rejected at construction', () => {
  assert.throws(
    () => createFullDuplexSessionV29({ sessionId: 'bad', modelId: 'gpt-99' }),
    /Unknown voice model/,
  );
});

test('v29 session: user speech frames end a turn and move state to thinking', () => {
  const session = createFullDuplexSessionV29({ sessionId: 'turn', modelId: 'mock-cascaded' });
  session.start(0);
  feedSpeech(session, 100, 10);
  assert.equal(session.getState(), 'listening');
  let ended = null;
  for (let i = 0; i < 18; i += 1) {
    const result = session.feedUserFrame({ atMs: 600 + i * 50, energy: 0.02 });
    if (result.turnEnded) ended = result;
  }
  assert.notEqual(ended, null);
  assert.equal(ended?.endReason, 'silence');
  assert.equal(session.getState(), 'thinking');
  const snap = session.snapshot();
  assert.equal(snap.turns, 1);
  assert.equal(snap.turnIndex, 1);
  assert.equal(snap.contextItems, 1);
});

test('v29 session: server-driven response, barge-in interrupts, remainder resumes', () => {
  const session = createFullDuplexSessionV29({ sessionId: 'barge', modelId: 'gpt-live' });
  session.start(0);
  const response = session.serverRespond('Hello, this is a long reply that keeps going on and on.', 1000);
  assert.equal(typeof response.id, 'string');
  assert.ok(response.remainingText.length > 0);
  assert.equal(session.snapshot().activeResponseId, response.id);
  // Inside the grace period the interruption is ignored.
  const early = session.requestBargeIn(1100, 'user-speech', 600, 0.8);
  assert.equal(early.verdict, 'ignore-grace');
  assert.equal(session.snapshot().activeResponseId, response.id);
  // Past grace, sustained loud speech interrupts.
  const decision = session.requestBargeIn(2000, 'user-speech', 600, 0.8);
  assert.equal(decision.verdict, 'interrupt');
  assert.equal(decision.responseId, response.id);
  const snap = session.snapshot();
  assert.equal(snap.interruptions, 1);
  assert.equal(snap.activeResponseId, null);
  // The unspoken remainder can be resumed as a new response.
  const resumed = session.resumeRemainder(response.id, 2100);
  assert.notEqual(resumed, null);
  assert.ok((resumed?.remainingText.length ?? 0) > 0);
  const done = session.completeResponse(resumed.id, 3000);
  assert.notEqual(done, null);
  assert.equal(session.snapshot().activeResponseId, null);
});

test('v29 session: a too-short burst is ignored by the barge-in engine', () => {
  const session = createFullDuplexSessionV29({ sessionId: 'barge-short', modelId: 'gpt-live' });
  session.start(0);
  session.serverRespond('A reply that is being spoken right now.', 1000);
  const decision = session.requestBargeIn(2000, 'user-speech', 100, 0.8);
  assert.equal(decision.verdict, 'ignore-too-short');
  assert.notEqual(session.snapshot().activeResponseId, null);
});

test('v29 session: cascaded pipeline turn stays within the 800ms budget', async () => {
  const session = createFullDuplexSessionV29({ sessionId: 'pipe', modelId: 'mock-cascaded' });
  session.start(0);
  const { turn, response } = await session.runPipelineTurn('hello there', 100, 'cascaded', {
    stt: 120,
    llm: 280,
    tts: 140,
  });
  assert.equal(turn.mode, 'cascaded');
  assert.equal(turn.totalMs, 540);
  assert.equal(turn.withinBudget, true);
  assert.equal(typeof response.id, 'string');
  const snap = session.snapshot();
  assert.equal(snap.pipelineTurns, 1);
  assert.ok(snap.pipelineP95Ms >= 540);
});

test('v29 session: speech-to-speech turn is faster than cascaded', async () => {
  const session = createFullDuplexSessionV29({ sessionId: 's2s', modelId: 'gemini-3.8-live' });
  session.start(0);
  const { turn } = await session.runPipelineTurn('hi', 100, 'speech-to-speech', { 's2s-direct': 180 });
  assert.equal(turn.mode, 'speech-to-speech');
  assert.equal(turn.totalMs, 180);
  assert.equal(turn.withinBudget, true);
});

test('v29 session: delegated async tool call finishes through pump', async () => {
  const session = createFullDuplexSessionV29({ sessionId: 'del', modelId: 'gpt-live' });
  session.start(0);
  session.delegate.registerTool({
    name: 'lookup',
    description: 'Mock lookup.',
    sensitive: false,
    execute: (args) => JSON.stringify({ found: args.q ?? null }),
  });
  const call = session.delegateTool('lookup', { q: 'weather' }, 100);
  assert.equal(call.state, 'queued');
  assert.equal(call.mode, 'async');
  const finished = await session.pumpDelegated(200);
  assert.equal(finished.length, 1);
  assert.equal(finished[0].state, 'done');
  assert.match(finished[0].result ?? '', /weather/);
  // The result landed in the append-only context as a tool-call item.
  const items = session.context.byKind('tool-call');
  assert.equal(items.length, 1);
  assert.throws(() => session.delegateTool('no-such-tool', {}, 300), /Unknown delegated tool/);
});

test('v29 session: proactive greeting fires when enabled and due', () => {
  const session = createFullDuplexSessionV29({
    sessionId: 'pro',
    modelId: 'mock-cascaded',
    proactive: { enabled: true },
  });
  session.start(0);
  session.scheduleProactive('greeting', 'Hello! How can I help?', 5000);
  assert.equal(session.proactiveTick(4000), null);
  const fired = session.proactiveTick(5000);
  assert.notEqual(fired, null);
  assert.equal(fired?.kind, 'greeting');
  assert.equal(session.snapshot().proactiveFired, 1);
});

test('v29 session: proactive stays silent when opt-in is off', () => {
  const session = createFullDuplexSessionV29({ sessionId: 'pro-off', modelId: 'mock-cascaded' });
  session.start(0);
  session.scheduleProactive('greeting', 'Hello!', 5000);
  assert.equal(session.proactiveTick(6000), null);
  assert.equal(session.snapshot().proactiveFired, 0);
});

test('v29 session: cost is metered per minute on the virtual clock', () => {
  const session = createFullDuplexSessionV29({ sessionId: 'cost', modelId: 'gpt-live' });
  session.start(0);
  feedSpeech(session, 100, 20);
  const entry = session.tickCost(2000);
  assert.notEqual(entry, null);
  assert.ok((entry?.usd ?? 0) > 0);
  assert.ok((entry?.inputMinutes ?? 0) > 0);
  const snap = session.snapshot();
  assert.ok(snap.costUsd > 0);
  assert.ok(snap.minutesBilled > 0);
});

test('v29 session: append-only context never edits history', () => {
  const session = createFullDuplexSessionV29({ sessionId: 'ctx', modelId: 'mock-cascaded' });
  session.start(0);
  session.context.appendUserTurn('first thing I said', 100);
  session.context.appendAgentTurn('first reply', 200);
  const before = session.context.all().length;
  const result = session.context.compact(300);
  assert.notEqual(result, null);
  assert.equal(result?.supersededCount, 2);
  // History is kept: old items are still there, marked superseded.
  assert.equal(session.context.all().length, before + 1);
  assert.equal(session.context.live().length, 1);
  assert.equal(session.context.live()[0].kind, 'summary');
  // Time-travel: as of 150ms only the first item existed.
  assert.equal(session.context.asOf(150).length, 1);
});
