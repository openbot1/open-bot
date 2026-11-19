/**
 * Tests for voice v28 transport + VAD hook + realtime session
 * (v1.41, Team T5).
 *
 * Covers the mock realtime transport (streaming chunks in/out,
 * latency + jitter, drop policies, jitter buffer, underruns),
 * the VAD hook (speech start/end, silence timeout, hangover,
 * short-noise rejection, calibration), and the realtime
 * session (start / pause / resume / stop, agent replies,
 * barge-in that stops playback and keeps the remainder,
 * resume-remainder, VAD-driven turn ending, session log).
 *
 * All offline, deterministic, no key / network / audio.
 * Only the v28 namespace is asserted — no global totals.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MockRealtimeTransportV28,
  RealtimeVoiceSessionV28,
  VadHookV28,
  VoiceSessionRegistryV28,
  chunkEnergyV28,
  createInMemoryBlockSourceV28,
  synthSilenceChunkV28,
  synthToneChunkV28,
  validateAudioChunkV28,
} from '../packages/core/dist/voiceV28/index.js';

function speechFrames(fromMs, count, energy = 0.8) {
  const out = [];
  for (let i = 0; i < count; i += 1) out.push({ atMs: fromMs + i * 50, energy });
  return out;
}

function silenceFrames(fromMs, count, energy = 0.05) {
  const out = [];
  for (let i = 0; i < count; i += 1) out.push({ atMs: fromMs + i * 50, energy });
  return out;
}

// --- transport ----------------------------------------------------------

test('voice v28 transport: push/pull with simulated latency', () => {
  const t = new MockRealtimeTransportV28();
  const chunk = synthToneChunkV28(0, 0, 'mic', { frequencyHz: 220, amplitude: 0.5 });
  assert.equal(chunkEnergyV28(chunk) > 0, true);
  assert.equal(t.pushIn(chunk), true);
  assert.equal(t.pullIn(0), null); // not deliverable before latency (40ms)
  const got = t.pullIn(40);
  assert.ok(got);
  assert.equal(got.seq, 0);
  assert.equal(t.stats().chunksIn, 1);
  assert.equal(t.stats().latencySamples, 1);
});

test('voice v28 transport: drop-oldest evicts the head when full', () => {
  const t = new MockRealtimeTransportV28({ config: { maxBufferedChunks: 2 } });
  for (let i = 0; i < 3; i += 1) {
    assert.equal(t.pushIn(synthToneChunkV28(i, i * 10, 'mic')), true);
  }
  const stats = t.stats();
  assert.equal(stats.droppedIn, 1);
  assert.equal(stats.chunksIn, 3);
  assert.equal(t.queueInDepth, 2);
  const first = t.pullIn(1000);
  assert.equal(first.seq, 1); // seq 0 was evicted
});

test('voice v28 transport: drop-newest and block policies', () => {
  const newest = new MockRealtimeTransportV28({ config: { maxBufferedChunks: 1, dropPolicy: 'drop-newest' } });
  assert.equal(newest.pushIn(synthToneChunkV28(0, 0, 'mic')), true);
  assert.equal(newest.pushIn(synthToneChunkV28(1, 10, 'mic')), false);
  assert.equal(newest.stats().droppedIn, 1);
  assert.equal(newest.pullIn(1000).seq, 0);

  const blocked = new MockRealtimeTransportV28({ config: { maxBufferedChunks: 1, dropPolicy: 'block' } });
  assert.equal(blocked.pushIn(synthToneChunkV28(0, 0, 'mic')), true);
  assert.equal(blocked.pushIn(synthToneChunkV28(1, 10, 'mic')), false);
  assert.equal(blocked.stats().droppedIn, 1);
});

test('voice v28 transport: jitter buffer holds outbound chunks until playout', () => {
  const t = new MockRealtimeTransportV28({ jitterBufferTargetMs: 120 });
  t.pushOut(synthToneChunkV28(0, 1000, 'tts'));
  assert.equal(t.pullOut(1000), null); // playout = deliver (1040) + 120
  assert.equal(t.pullOut(1160)?.seq, 0);
});

test('voice v28 transport: underrun counted when audio expected but queue empty', () => {
  const t = new MockRealtimeTransportV28();
  assert.equal(t.pullOut(0, true), null);
  assert.equal(t.stats().underruns, 1);
  assert.equal(t.pullOut(0, false), null);
  assert.equal(t.stats().underruns, 1); // not expecting: no underrun
});

test('voice v28 transport: flush + close', () => {
  const t = new MockRealtimeTransportV28();
  t.pushIn(synthToneChunkV28(0, 0, 'mic'));
  t.pushOut(synthToneChunkV28(0, 0, 'tts'));
  const flushed = t.flush(10);
  assert.deepEqual(flushed, { flushedIn: 1, flushedOut: 1 });
  assert.equal(t.queueInDepth, 0);
  t.close(20);
  assert.equal(t.closed, true);
  assert.equal(t.pushIn(synthToneChunkV28(1, 20, 'mic')), false);
  assert.equal(t.pullIn(1000), null);
});

test('voice v28 transport: silence chunk has zero energy; validation rejects bad chunks', () => {
  const silent = synthSilenceChunkV28(0, 0, 'mic');
  assert.equal(chunkEnergyV28(silent), 0);
  validateAudioChunkV28(silent);
  assert.throws(() => validateAudioChunkV28({ ...silent, samples: [2] }), /samples/);
  assert.throws(() => validateAudioChunkV28({ ...silent, source: 'x' }), /source/);
  assert.throws(() => validateAudioChunkV28({ ...silent, seq: -1 }), /seq/);
});

test('voice v28 transport: deterministic jitter from sequence', () => {
  const t = new MockRealtimeTransportV28({ config: { simulatedJitterMs: 20 } });
  assert.equal(t.deliverAtMs(1000, 7), t.deliverAtMs(1000, 7));
  const d0 = t.deliverAtMs(1000, 0) - 1000;
  const d1 = t.deliverAtMs(1000, 1) - 1000;
  assert.ok(d0 >= 40 && d0 <= 60);
  assert.ok(d1 >= 40 && d1 <= 60);
});

// --- VAD hook -----------------------------------------------------------

test('voice v28 VAD hook: speech start after minSpeechMs, silence timeout ends the turn', () => {
  const events = [];
  const hook = new VadHookV28({}, {
    onSpeechStart: (atMs) => events.push(['start', atMs]),
    onSpeechEnd: (atMs) => events.push(['end', atMs]),
    onSilenceTimeout: (atMs) => events.push(['timeout', atMs]),
  });
  // 4 speech frames = 200ms < minSpeech 220ms: no start yet.
  let last = hook.feedMany(speechFrames(0, 4)).at(-1);
  assert.equal(last.speechStarted, false);
  assert.equal(hook.isSpeaking, false);
  // 5th frame (250ms) confirms speech.
  last = hook.feed(speechFrames(200, 1)[0]);
  assert.equal(last.speechStarted, true);
  assert.equal(hook.isSpeaking, true);
  assert.equal(events[0][0], 'start');
  // Silence: 3 hangover frames then 16 silence frames = 800ms timeout.
  const results = hook.feedMany(silenceFrames(250, 19));
  const timedOut = results.find((r) => r.silenceTimedOut);
  assert.ok(timedOut);
  assert.equal(timedOut.turnEnded, true);
  assert.equal(timedOut.endReason, 'silence');
  assert.equal(hook.isSpeaking, false);
  assert.equal(events.some(([k]) => k === 'timeout'), true);
  assert.equal(events.some(([k]) => k === 'end'), true);
  assert.equal(hook.stats().speechStarts, 1);
  assert.equal(hook.stats().silenceTimeouts, 1);
});

test('voice v28 VAD hook: short burst is rejected as noise', () => {
  const hook = new VadHookV28();
  hook.feedMany(speechFrames(0, 2)); // 100ms < 220ms
  const result = hook.feed({ atMs: 100, energy: 0.05 });
  assert.equal(result.noiseRejected, true);
  assert.equal(result.kind, 'noise');
  assert.equal(hook.isSpeaking, false);
  assert.equal(hook.stats().noiseRejections, 1);
  assert.equal(hook.segments()[0].rejectedAsNoise, true);
});

test('voice v28 VAD hook: keyword ends the turn at once', () => {
  const hook = new VadHookV28({ config: { endKeyword: 'dừng' } });
  hook.feedMany(speechFrames(0, 5));
  assert.equal(hook.isSpeaking, true);
  const result = hook.feed({ atMs: 250, energy: 0.8, text: 'dừng lại đi' });
  assert.equal(result.turnEnded, true);
  assert.equal(result.endReason, 'keyword');
  assert.equal(hook.stats().keywordEnds, 1);
});

test('voice v28 VAD hook: presets + calibration', () => {
  const hook = new VadHookV28();
  const cfg = hook.applyPreset('strict');
  assert.equal(cfg.threshold, 0.32);
  assert.equal(cfg.silenceTimeoutMs, 500);
  const cal = hook.calibrate([0.02, 0.03, 0.02, 0.05, 0.9, 0.8]);
  assert.ok(cal.threshold > cal.noiseFloor);
  assert.equal(['sensitive', 'balanced', 'strict'].includes(cal.suggestedPreset), true);
  assert.throws(() => hook.updateConfig({ threshold: 2 }), /threshold/);
  assert.throws(() => new VadHookV28({ config: { threshold: 0.01, noiseFloor: 0.05 } }), /noiseFloor/);
});

// --- session ------------------------------------------------------------

function makeSession() {
  const source = createInMemoryBlockSourceV28({
    persona: { content: 'Tôi nói trang trọng, nói chậm.', version: 1 },
    human: { content: 'Tên tôi là Huy. Xưng hô: anh.', version: 1 },
  });
  const session = new RealtimeVoiceSessionV28('s1', {
    botId: 'bot1',
    styleBridge: { source, botId: 'bot1' },
  });
  return { session, source };
}

test('voice v28 session: start -> reply -> barge-in keeps remainder -> resume -> done -> pause/resume -> stop', () => {
  const { session } = makeSession();
  assert.equal(session.currentState, 'idle');
  assert.throws(() => session.agentReply('hi', 0), /not started/);
  const started = session.start(0);
  assert.equal(started.state, 'listening');
  assert.equal(started.style, 'formal'); // from the persona block
  assert.equal(started.language, 'vi');
  assert.equal(started.addressForm, 'anh');
  assert.equal(started.userName, 'Huy');
  assert.ok(session.greeting().includes('anh')); // formal vi greeting uses {address}

  const replyText = 'Hello world, this is a long reply for testing purposes';
  const reply = session.agentReply(replyText, 100);
  assert.equal(session.currentState, 'speaking');
  assert.equal(reply.text, replyText);
  assert.ok(reply.estimatedDurationMs > 0);
  assert.ok(session.stats().chunksOut > 0);

  // Barge-in inside the grace window is ignored.
  const grace = session.handleBargeIn(500, 200, 'khoan đã');
  assert.equal(grace.interrupted, false);
  assert.equal(grace.reason, 'grace-period');
  // Real barge-in after the grace window stops playback, keeps the rest.
  const cut = session.handleBargeIn(500, 1500, 'dừng lại đi');
  assert.equal(cut.interrupted, true);
  assert.equal(cut.reason, 'confirmed');
  assert.ok(cut.spokenText.length > 0);
  assert.ok(cut.spokenText.length < replyText.length);
  assert.ok(cut.remainingText.length > 0);
  assert.equal(session.keptRemainder, cut.remainingText);
  assert.equal(session.currentState, 'listening');
  assert.equal(session.stats().interruptions, 1);

  const resumed = session.resumeRemainder(1600);
  assert.ok(resumed);
  assert.equal(resumed.text, cut.remainingText);
  assert.equal(session.currentState, 'speaking');
  assert.equal(session.resumeRemainder(1700), null); // already consumed

  session.agentReplyDone(5000);
  assert.equal(session.currentState, 'listening');

  session.pause(5100);
  assert.equal(session.currentState, 'paused');
  session.resume(5200);
  assert.equal(session.currentState, 'listening');

  const stopped = session.stop(6000, 'user-request');
  assert.equal(stopped.state, 'ended');
  assert.equal(stopped.stopReason, 'user-request');
  assert.equal(stopped.endedAtMs, 6000);
  assert.throws(() => session.feedUserChunk(synthToneChunkV28(0, 6100, 'mic'), 6100), /ended/);
  assert.equal(session.sessionLog().length > 0, true);
  assert.equal(session.sessionLog()[0].kind, 'start');
});

test('voice v28 session: VAD-driven turn ends move listening -> thinking', () => {
  const { session } = makeSession();
  session.start(0);
  session.feedUserFrames(speechFrames(100, 5));
  assert.equal(session.vad.stats().speechStarts, 1);
  session.feedUserFrames(silenceFrames(350, 19));
  assert.equal(session.vad.stats().silenceTimeouts, 1);
  assert.equal(session.currentState, 'thinking');
});

test('voice v28 session: feedUserChunk flows through transport + VAD', () => {
  const { session } = makeSession();
  session.start(0);
  const fed = session.feedUserChunk(synthToneChunkV28(0, 100, 'mic'), 100);
  assert.equal(fed.accepted, true);
  assert.ok(fed.energy > 0);
  assert.equal(session.transport.stats().chunksIn, 1);
  assert.equal(session.transport.pullIn(140)?.seq, 0);
});

test('voice v28 session: invalid transitions throw; stop twice is a no-op', () => {
  const { session } = makeSession();
  assert.throws(() => session.pause(0), /not started/);
  assert.throws(() => session.resume(0), /cannot resume/);
  session.start(0);
  assert.throws(() => session.start(10), /cannot start/);
  session.stop(100);
  assert.equal(session.stop(200).state, 'ended');
  assert.equal(session.snapshot().endedAtMs, 100); // first stop wins
});

test('voice v28 session: idle timeout stops the session', () => {
  const session = new RealtimeVoiceSessionV28('s-idle', { idleTimeoutMs: 1000 });
  session.start(0);
  session.feedUserFrames([{ atMs: 100, energy: 0.8 }]);
  session.feedUserFrames([{ atMs: 1100, energy: 0.05 }]);
  assert.equal(session.currentState, 'ended');
  assert.equal(session.snapshot().stopReason, 'idle-timeout');
});

test('voice v28 session: max session length stops the session', () => {
  const session = new RealtimeVoiceSessionV28('s-max', { maxSessionMs: 500 });
  session.start(0);
  session.feedUserFrames([{ atMs: 600, energy: 0.05 }]);
  assert.equal(session.currentState, 'ended');
  assert.equal(session.snapshot().stopReason, 'timeout');
});

test('voice v28 report: registry aggregates live sessions without driving them', () => {
  const registry = new VoiceSessionRegistryV28();
  assert.equal(registry.size, 0);
  assert.deepEqual(registry.aggregate(0), {
    generatedAtMs: 0,
    sessions: 0,
    openSessions: 0,
    endedSessions: 0,
    turns: 0,
    interruptions: 0,
    chunksIn: 0,
    chunksOut: 0,
    chunksDropped: 0,
    avgTurnsPerSession: 0,
    avgInterruptionsPerSession: 0,
    avgDurationMs: null,
    byBot: {},
    byStyle: {},
    rollups: [],
  });
  assert.equal(registry.toMarkdown(0).includes('# Voice report v28'), true);

  const { session: s1 } = makeSession();
  const s2 = new RealtimeVoiceSessionV28('s2', { botId: 'bot2' });
  s1.start(0);
  s1.agentReply('Hello world, this is a long reply for testing purposes', 100);
  s1.agentReplyDone(2000);
  s2.start(0);
  s2.stop(500, 'user-request');
  registry.register(s1);
  registry.register(s2);
  registry.register(s1); // second registration is a no-op
  assert.equal(registry.size, 2);
  assert.equal(registry.has('s1'), true);
  assert.deepEqual(registry.ids(), ['s1', 's2']);

  const report = registry.aggregate(3000);
  assert.equal(report.sessions, 2);
  assert.equal(report.openSessions, 1);
  assert.equal(report.endedSessions, 1);
  assert.equal(report.turns, 1);
  assert.equal(report.byBot.bot1.sessions, 1);
  assert.equal(report.byBot.bot2.sessions, 1);
  assert.equal(report.byStyle.formal.sessions, 1);
  assert.equal(report.byStyle.default.sessions, 1);
  assert.equal(report.avgTurnsPerSession, 0.5);
  assert.equal(report.rollups[0].sessionId, 's1');
  assert.equal(report.rollups[0].durationMs, 3000);
  assert.equal(report.rollups[1].durationMs, 500);
  assert.equal(report.rollups[1].stopReason, 'user-request');

  const md = registry.toMarkdown(3000);
  assert.ok(md.includes('## By bot'));
  assert.ok(md.includes('| bot1 | 1 | 1 |'));
  assert.ok(md.includes('## Sessions'));
  assert.equal(registry.rollup('nope', 3000), null);
  assert.equal(registry.unregister('s2'), true);
  assert.equal(registry.size, 1);
  assert.equal(registry.unregister('s2'), false);
  registry.clear();
  assert.equal(registry.size, 0);
});
