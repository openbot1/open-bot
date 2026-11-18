/**
 * Tests for voice v21 turn-taking + barge-in + mid-speech
 * interruption (v1.34, Team T5).
 *
 * All offline, deterministic, no key / network / audio. The
 * session barge-in test uses a gated mock synthesiser so the
 * agent is really mid-sentence when the user interrupts.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TurnTakingMachineV21,
  createTurnTakingMachineV21,
  defaultTurnTakingV21Options,
  validateTurnTakingV21Options,
} from '../packages/core/dist/voiceV21/turnTakingV21.js';
import {
  BargeInEngineV21,
  createBargeInEngineV21,
  PartialTranscriptKeeperV21,
  scoreBargeInV21,
  decideBargeInV21,
  evaluateBargeInBurstV21,
  splitReplyAtCutV21,
  isBackchannelBurstV21,
  realWordsInBurstV21,
  defaultBargeInV21Options,
  validateBargeInV21Options,
} from '../packages/core/dist/voiceV21/bargeInV21.js';
import {
  VoiceSessionV21,
  createVoiceSessionV21,
} from '../packages/core/dist/voiceV21/sessionV21.js';

// ---------------------------------------------------------------- turn-taking machine
test('voice v21: turn machine walks idle → listening → waiting → speaking → listening', () => {
  const m = createTurnTakingMachineV21('s1');
  assert.equal(m.currentState(), 'idle');
  m.setListening(0);
  assert.equal(m.currentState(), 'listening');
  m.handle('user-speech-start', 100);
  m.handle('user-speech-end', 1500, { text: 'hello there' });
  assert.equal(m.currentState(), 'waiting');
  assert.equal(m.turnHistory().length, 1);
  assert.equal(m.turnHistory()[0].role, 'user');
  assert.equal(m.turnHistory()[0].durationMs, 1400);
  m.handle('agent-speak-start', 1800, { text: 'hi!' });
  assert.equal(m.currentState(), 'speaking');
  m.handle('agent-speak-end', 2500, { text: 'hi!' });
  assert.equal(m.currentState(), 'listening');
  assert.equal(m.turnHistory().length, 2);
  const stats = m.stats();
  assert.equal(stats.turns, 2);
  assert.equal(stats.meanResponseLatencyMs, 300);
  assert.equal(stats.invalidTransitions, 0);
  assert.match(m.summary(), /listening/);
});

test('voice v21: turn machine rejects invalid transitions without changing state', () => {
  const m = createTurnTakingMachineV21('s1');
  const rejected = m.handle('agent-speak-end', 100);
  assert.ok(rejected.rejectedReason);
  assert.equal(m.currentState(), 'idle');
  assert.equal(m.stats().invalidTransitions, 1);
  const badListening = m.setListening(200);
  assert.equal(badListening.to, 'listening');
  const again = m.setListening(300);
  assert.ok(again.rejectedReason);
  assert.deepEqual(validateTurnTakingV21Options({ overlapBargeInMs: -1 }), ['overlapBargeInMs must be 0..5000']);
  assert.deepEqual(validateTurnTakingV21Options({}), []);
  assert.equal(defaultTurnTakingV21Options().overlapBargeInMs, 400);
});

test('voice v21: overlap classification — backchannel, overlap, barge-in', () => {
  const m = createTurnTakingMachineV21('s1');
  assert.equal(m.classifyOverlap(100), 'backchannel');
  assert.equal(m.classifyOverlap(150), 'backchannel');
  assert.equal(m.classifyOverlap(250), 'overlap');
  assert.equal(m.classifyOverlap(400), 'barge-in');
  assert.equal(m.classifyOverlap(2000), 'barge-in');
  // Overlap while speaking is recorded with its duration.
  m.setListening(0);
  m.handle('user-speech-start', 100);
  m.handle('user-speech-end', 500);
  m.handle('agent-speak-start', 600, { text: 'a long reply here' });
  m.handle('user-speech-start', 700);
  m.handle('user-speech-end', 900);
  assert.equal(m.overlapHistory().length, 1);
  assert.equal(m.overlapHistory()[0].durationMs, 200);
  assert.equal(m.stats().overlaps, 1);
});

test('voice v21: waiting timeout fires back to idle', () => {
  const m = createTurnTakingMachineV21('s1', { waitingTimeoutMs: 1000 });
  m.setListening(0);
  m.handle('user-speech-start', 100);
  m.handle('user-speech-end', 200);
  assert.equal(m.currentState(), 'waiting');
  assert.equal(m.checkWaitingTimeout(500), false);
  assert.equal(m.checkWaitingTimeout(1500), true);
  assert.equal(m.currentState(), 'idle');
});

// ---------------------------------------------------------------- barge-in scoring
test('voice v21: barge-in scoring — strong burst interrupts, echo never does', () => {
  const strong = evaluateBargeInBurstV21({ atMs: 100, energy: 0.9, sustainMs: 800, words: ['stop', 'wait', 'listen'], agentSpeaking: true });
  assert.equal(strong.decision, 'interrupt');
  assert.ok(strong.score.total >= 0.65);

  const quiet = evaluateBargeInBurstV21({ atMs: 100, energy: 0.1, sustainMs: 50, words: [], agentSpeaking: true });
  assert.equal(quiet.decision, 'ignore');

  const echo = evaluateBargeInBurstV21({ atMs: 100, energy: 0.95, sustainMs: 1000, words: ['stop', 'wait'], echo: true, agentSpeaking: true });
  assert.equal(echo.decision, 'ignore');
  assert.equal(echo.score.total, 0);

  const silent = evaluateBargeInBurstV21({ atMs: 100, energy: 0.9, sustainMs: 800, words: ['stop'], agentSpeaking: false });
  assert.equal(silent.decision, 'ignore');
});

test('voice v21: backchannel bursts duck at most, never interrupt', () => {
  assert.equal(isBackchannelBurstV21(['ừ']), true);
  assert.equal(isBackchannelBurstV21(['yeah']), true);
  assert.equal(isBackchannelBurstV21(['stop', 'wait']), false);
  assert.equal(realWordsInBurstV21(['ừ', 'stop']), 1);
  const back = evaluateBargeInBurstV21({ atMs: 100, energy: 0.9, sustainMs: 900, words: ['ừ'], agentSpeaking: true });
  assert.notEqual(back.decision, 'interrupt');
  const mixed = evaluateBargeInBurstV21({ atMs: 100, energy: 0.6, sustainMs: 300, words: ['ừ', 'yeah'], agentSpeaking: true });
  assert.ok(['ignore', 'duck'].includes(mixed.decision));
  assert.deepEqual(validateBargeInV21Options({ duckThreshold: 0.9, interruptThreshold: 0.5 }), ['duckThreshold must be below interruptThreshold']);
  assert.deepEqual(validateBargeInV21Options({}), []);
  assert.equal(defaultBargeInV21Options().interruptThreshold, 0.65);
});

test('voice v21: reply cut splits on a word boundary, never mid-word', () => {
  const reply = 'Hello world, this is a long reply for you.';
  const cut = splitReplyAtCutV21(reply, 13);
  assert.equal(cut.spoken, 'Hello world,');
  assert.equal(cut.remaining, 'this is a long reply for you.');
  assert.equal(cut.spoken.length + 1 + cut.remaining.length, reply.length);
  assert.deepEqual(splitReplyAtCutV21(reply, 0), { spoken: '', remaining: reply, spokenChars: 0, remainingChars: reply.length });
  const full = splitReplyAtCutV21(reply, 999);
  assert.equal(full.remaining, '');
  assert.equal(full.spoken, reply);
});

test('voice v21: partial transcript keeper preserves half-heard words', () => {
  const keeper = new PartialTranscriptKeeperV21();
  keeper.add('t1', 'xin ch', 100);
  keeper.add('t1', 'xin chào bạn', 200);
  assert.equal(keeper.heardSoFar('t1'), 'xin chào bạn');
  assert.equal(keeper.unfinalised().length, 1);
  keeper.finalise('t1', 'xin chào bạn nhé', 300);
  assert.equal(keeper.unfinalised().length, 0);
  assert.equal(keeper.heardSoFar('t1'), 'xin chào bạn nhé');
  keeper.clearTurn('t1');
  assert.equal(keeper.heardSoFar('t1'), '');
});

// ---------------------------------------------------------------- barge-in engine + session
test('voice v21: barge-in engine records decisions and cuts the reply', () => {
  const engine = createBargeInEngineV21('s1');
  const { decision } = engine.observe({ atMs: 100, energy: 0.9, sustainMs: 800, words: ['stop', 'wait'], agentSpeaking: true });
  assert.equal(decision, 'interrupt');
  engine.keeper.add('t9', 'stop wait I need', 100);
  const cut = engine.cutReply('Hello world, this is a long reply.', 13, 150, 't9');
  assert.equal(cut.spoken, 'Hello world,');
  const last = engine.history()[0];
  assert.equal(last.cut?.spoken, 'Hello world,');
  assert.equal(last.preservedTranscript, 'stop wait I need');
  assert.equal(engine.stats().interrupted, 1);
  assert.match(engine.summary(), /1 interrupts/);
});

test('voice v21: session barge-in mid-speech stops TTS and returns to listening', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  async function* gatedSynth(text, voice, opts) {
    void text; void voice; void opts;
    yield new Uint8Array([1, 2, 3]);
    await gate;
    yield new Uint8Array([4, 5, 6]);
  }
  const session = createVoiceSessionV21('sess-barge', { synthesizer: gatedSynth });
  session.start(0);
  // Drive a turn whose reply blocks on the gate mid-speech.
  const turnPromise = session.feedFinal('xin chào', 1000);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(session.state(), 'speaking');
  const { decision, cut } = await session.feedBargeIn(
    { atMs: 1100, energy: 0.95, sustainMs: 900, words: ['dừng', 'lại', 'nghe', 'này'] },
    1100,
  );
  assert.equal(decision, 'interrupt');
  assert.ok(cut);
  release();
  await turnPromise;
  assert.equal(session.state(), 'listening');
  assert.equal(session.stats().bargeIns, 1);
  assert.ok(session.monitor(1200).bargeIns >= 1);
  // The cut agent turn is in history, marked as cut.
  assert.ok(session.turns.turnHistory().some((t) => t.role === 'agent' && t.bargeInCut === true));
});
