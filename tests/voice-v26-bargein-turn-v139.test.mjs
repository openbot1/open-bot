/**
 * Tests for voice v26 barge-in + guarded turn-taking (v1.39, Team T5).
 *
 * Covers BargeInDetectorV26 (frame-level suspect -> duck ->
 * confirm -> stop, spoken prefix at a word boundary, resume
 * strategy + context, echo/backchannel discrimination, adaptive
 * noise floor) and TurnTakingMachineV26 (anti-overlap guard
 * queues agent replies while the user holds the floor,
 * per-phase timeouts, barge-in freeze, queued delivery).
 *
 * All offline, deterministic, virtual clocks, synthetic frame
 * energy. No key / network / mic / sound card.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BargeInDetectorV26,
  TurnTakingMachineV26,
  cutAtWordBoundaryV26,
  strategyForSpokenFractionV26,
} from '../packages/core/dist/voiceV26/index.js';

const REPLY = 'The quick brown fox jumps over the lazy dog and runs away into the forest.';

function feedSpeech(detector, fromMs, toMs, stepMs, energy) {
  let last = null;
  for (let at = fromMs; at <= toMs; at += stepMs) {
    last = detector.feedFrame({ atMs: at, energy });
  }
  return last;
}

test('barge-in: sustained speech confirms, ducks first, then stops with word-boundary prefix', () => {
  const d = new BargeInDetectorV26('s1', { duckAfterMs: 100, confirmAfterMs: 300, graceAfterReplyStartMs: 0 });
  d.agentStartedSpeaking({ turnId: 'turn26-1', turnIndex: 0, replyText: REPLY, atMs: 0 });
  d.agentSpeechProgress(500, 20);
  const r1 = d.feedFrame({ atMs: 1000, energy: 0.6 });
  assert.equal(r1.stage, 'suspect');
  const r2 = d.feedFrame({ atMs: 1100, energy: 0.65 });
  assert.equal(r2.stage, 'ducking');
  assert.equal(r2.ducking, true);
  assert.equal(d.ducksList().length, 1);
  assert.equal(d.ducksList()[0].gain, 0.25);
  const r3 = feedSpeech(d, 1200, 1400, 50, 0.7);
  assert.equal(r3.stage, 'confirmed');
  assert.equal(r3.confirmed, true);
  const stopped = d.stop({ atMs: 1450, spokenChars: 20, userText: 'wait, stop there' });
  assert.ok(stopped);
  assert.equal(stopped.spokenText, 'The quick brown fox');
  assert.equal(stopped.remainingText, 'jumps over the lazy dog and runs away into the forest.');
  assert.equal(stopped.resumeStrategy, 'ask-clarify');
  assert.equal(stopped.context.spokenFraction, 0.26);
  assert.equal(d.count(), 1);
  const stats = d.stats();
  assert.equal(stats.stopped, 1);
  assert.equal(stats.ducked, 1);
  assert.equal(stats.strategies['ask-clarify'], 1);
});

test('barge-in: single loud frame never confirms; quiet frames track the noise floor', () => {
  const d = new BargeInDetectorV26('s2', { duckAfterMs: 100, confirmAfterMs: 300, graceAfterReplyStartMs: 0 });
  d.agentStartedSpeaking({ turnId: 't1', turnIndex: 0, replyText: REPLY, atMs: 0 });
  const r = d.feedFrame({ atMs: 100, energy: 0.9 });
  assert.equal(r.stage, 'suspect');
  assert.equal(r.confirmed, false);
  // Several quiet frames pull the EMA noise floor below its start.
  for (let at = 200; at <= 1100; at += 100) {
    d.feedFrame({ atMs: at, energy: 0.01 });
  }
  assert.equal(d.currentStage(), 'none');
  assert.equal(d.count(), 0);
  assert.ok(d.noiseFloorEstimate() < 0.08);
});

test('barge-in: echo frames ignored, short bursts are backchannels', () => {
  const d = new BargeInDetectorV26('s3', { duckAfterMs: 100, confirmAfterMs: 600, backchannelMaxMs: 400, graceAfterReplyStartMs: 0 });
  d.agentStartedSpeaking({ turnId: 't1', turnIndex: 0, replyText: REPLY, atMs: 0 });
  const echo = d.feedFrame({ atMs: 100, energy: 0.9, echo: true });
  assert.equal(echo.echo, true);
  assert.equal(echo.stage, 'none');
  assert.equal(d.stats().echoes, 1);
  // Short burst (350ms: >= minSpeechMs 250, < backchannelMaxMs 400),
  // then silence -> backchannel.
  d.feedFrame({ atMs: 200, energy: 0.6 });
  d.feedFrame({ atMs: 300, energy: 0.6 });
  d.feedFrame({ atMs: 400, energy: 0.6 });
  d.feedFrame({ atMs: 500, energy: 0.6 });
  const end = d.feedFrame({ atMs: 550, energy: 0.01 });
  assert.equal(end.backchannel, true);
  assert.equal(d.backchannelsList().length, 1);
  assert.equal(d.count(), 0);
});

test('barge-in: grace window absorbs speech right after a reply starts', () => {
  const d = new BargeInDetectorV26('s4', { duckAfterMs: 100, confirmAfterMs: 300, graceAfterReplyStartMs: 600 });
  d.agentStartedSpeaking({ turnId: 't1', turnIndex: 0, replyText: REPLY, atMs: 1000 });
  const r = d.feedFrame({ atMs: 1100, energy: 0.7 });
  assert.equal(r.stage, 'suspect');
  // Speech stops inside the grace window: no confirmation.
  const end = d.feedFrame({ atMs: 1150, energy: 0.01 });
  assert.equal(end.stage, 'none');
  assert.equal(d.count(), 0);
});

test('barge-in: false positives can be marked; stop without confirm returns null', () => {
  const d = new BargeInDetectorV26('s5');
  assert.equal(d.stop({ atMs: 100 }), null);
  d.agentStartedSpeaking({ turnId: 't1', turnIndex: 0, replyText: REPLY, atMs: 0 });
  feedSpeech(d, 0, 500, 50, 0.7);
  const stopped = d.stop({ atMs: 550, spokenChars: 10 });
  assert.ok(stopped);
  assert.equal(d.markFalsePositive(stopped.bargeInId), true);
  assert.equal(d.markFalsePositive('bi26-999'), false);
  assert.equal(d.get(stopped.bargeInId).falsePositive, true);
  assert.equal(d.stats().falsePositives, 1);
  assert.match(d.markdown(), /Barge-in v26/);
  assert.match(d.summary(), /1 barge-ins/);
});

test('helpers: word-boundary cut and resume strategy', () => {
  assert.equal(cutAtWordBoundaryV26('hello world again', 8), 'hello');
  assert.equal(cutAtWordBoundaryV26('hello world again', 0), '');
  assert.equal(cutAtWordBoundaryV26('hello world again', 100), 'hello world again');
  assert.equal(strategyForSpokenFractionV26(0.9, null), 'drop-remainder');
  assert.equal(strategyForSpokenFractionV26(0.5, null), 'summarise-remainder');
  assert.equal(strategyForSpokenFractionV26(0.1, null), 'resume-remaining');
  assert.equal(strategyForSpokenFractionV26(0.9, 'wait'), 'ask-clarify');
});

test('turn-taking: agent reply is queued while the user holds the floor, delivered on yield', () => {
  const m = new TurnTakingMachineV26('s1');
  const user = m.userStart(0, 'hello there');
  assert.equal(m.stateNow(), 'listening');
  assert.equal(m.floorHolder(), 'user');
  const queued = m.agentStart({ atMs: 500, text: 'Hi! How can I help?' });
  assert.equal(queued.outcome, 'queued');
  assert.equal(queued.queuePosition, 1);
  assert.equal(m.queueLength(), 1);
  assert.equal(m.stateNow(), 'listening');
  m.userEnd(1000, 'hello there');
  assert.equal(m.stateNow(), 'thinking');
  const delivered = m.deliverQueued(1100);
  assert.equal(delivered.outcome, 'started');
  assert.ok(delivered.turnId);
  assert.equal(m.stateNow(), 'speaking');
  const done = m.agentDone(3000, 19);
  assert.equal(done.status, 'completed');
  assert.equal(m.stateNow(), 'idle');
  const stats = m.stats();
  assert.equal(stats.turns, 2);
  assert.equal(stats.completed, 2);
  assert.equal(stats.queued, 0);
  assert.match(m.markdown(), /Turn-taking v26/);
});

test('turn-taking: agent cannot start while already speaking; backchannel never changes state', () => {
  const m = new TurnTakingMachineV26('s2');
  m.userStart(0, 'hi');
  m.userEnd(500, 'hi');
  const started = m.agentStart({ atMs: 600, text: 'Hello.' });
  assert.equal(started.outcome, 'started');
  const rejected = m.agentStart({ atMs: 700, text: 'Another reply.' });
  assert.equal(rejected.outcome, 'rejected');
  m.backchannel(800, 'uh-huh');
  assert.equal(m.stateNow(), 'speaking');
  assert.equal(m.backchannelsList().length, 1);
  assert.equal(m.stats().rejectedAgentStarts, 1);
});

test('turn-taking: barge-in freezes the cut turn; timeout releases a stuck phase', () => {
  const m = new TurnTakingMachineV26('s3', { maxThinkingMs: 1000, maxSpeakingMs: 5000 });
  m.userStart(0, 'hi');
  m.userEnd(500, 'hi');
  const started = m.agentStart({ atMs: 600, text: REPLY });
  assert.equal(started.outcome, 'started');
  const frozen = m.bargeIn({ atMs: 1500, bargeInId: 'bi26-1', spokenText: 'The quick brown', spokenChars: 15 });
  assert.equal(frozen.status, 'interrupted');
  assert.equal(frozen.spokenChars, 15);
  assert.equal(m.stateNow(), 'interrupted');
  // Next user turn starts fresh.
  const next = m.userStart(2000, 'never mind');
  assert.equal(next.role, 'user');
  assert.equal(next.index, 2);
  // Thinking timeout: user ends, nobody replies within maxThinkingMs.
  m.userEnd(2500, 'never mind');
  const timedOut = m.timeoutCheck(2500 + 1001);
  assert.ok(timedOut);
  assert.equal(timedOut.status, 'timeout');
  assert.equal(m.stateNow(), 'idle');
  const stats = m.stats();
  assert.equal(stats.interrupted, 1);
  assert.equal(stats.timeouts, 1);
});

test('turn-taking: invalid options throw; transitions are audited', () => {
  assert.throws(() => new TurnTakingMachineV26('bad', { maxThinkingMs: 5 }), /Invalid TurnTakingV26Options/);
  const m = new TurnTakingMachineV26('s4');
  m.userStart(0, 'hi');
  m.userEnd(100, 'hi');
  m.agentStart({ atMs: 200, text: 'Hello.' });
  m.agentDone(500);
  const transitions = m.transitionsList();
  assert.ok(transitions.length >= 3);
  assert.equal(transitions[0].from, 'idle');
  assert.equal(transitions[0].to, 'listening');
  assert.equal(transitions[transitions.length - 1].to, 'idle');
});
