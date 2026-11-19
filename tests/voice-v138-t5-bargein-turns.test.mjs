/**
 * Tests for voice v25 barge-in + turn-taking + silence
 * (v1.38, Team T5).
 *
 * Covers BargeInManagerV25 (burst decision via v23, stop
 * latency, spoken-prefix truncation, resume strategy, ducks,
 * false positives, burst alerts), TurnTakingManagerV25 (floor
 * state machine, phase spans, timeouts, backchannels) and
 * SilenceDetectorV25 (energy + boolean frames, adaptive noise
 * floor, silence gaps, yield, per-turn stats).
 *
 * All offline, deterministic, no key / network / audio.
 * All clocks virtual (atMs passed by the test).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BargeInManagerV25,
  createBargeInManagerV25,
  defaultBargeInV25Options,
  validateBargeInV25Options,
} from '../packages/core/dist/voiceV25/bargeInV25.js';
import {
  TurnTakingManagerV25,
  createTurnTakingManagerV25,
  defaultTurnTakingV25Options,
  validateTurnTakingV25Options,
} from '../packages/core/dist/voiceV25/turnTakingV25.js';
import {
  SilenceDetectorV25,
  createSilenceDetectorV25,
  defaultSilenceDetectorV25Options,
  validateSilenceDetectorV25Options,
} from '../packages/core/dist/voiceV25/silenceDetectionV25.js';
import {
  formatDurationV25,
  formatDurationShortV25,
  durationBucketV25,
  turnChecksumV25,
  isValidVoiceV25Id,
} from '../packages/core/dist/voiceV25/types.js';

const REPLY = 'Hello, I can help you plan the trip to Da Lat this weekend.';

// ---------------------------------------------------------------- barge-in

test('barge-in: interrupt cuts the reply, stop latency measured, spoken prefix kept', () => {
  const manager = createBargeInManagerV25('s1');
  manager.agentStartedSpeaking('turn-2', 1, REPLY, 1000);
  manager.agentSpeechProgress(1800, 20);
  const burst = manager.reportBurst({
    atMs: 2000,
    atMsIntoReply: 1000,
    energy: 0.8,
    sustainMs: 600,
    words: ['dừng', 'ngay'],
    userText: 'dừng ngay',
  });
  assert.equal(burst.decision.decision, 'interrupt');
  assert.ok(burst.bargeIn !== null);
  assert.equal(burst.bargeIn.turnId, 'turn-2');
  assert.equal(burst.bargeIn.agentSpokenChars, 20);
  assert.ok(manager.pendingBargeIn() !== null);
  const stopped = manager.agentStopped(2300, 24);
  assert.ok(stopped !== null);
  assert.equal(stopped.bargeIn.stopLatencyMs, 300);
  assert.equal(stopped.spokenText, REPLY.slice(0, 24));
  assert.equal(stopped.bargeIn.resumeStrategy, 'resume');
  assert.equal(manager.pendingBargeIn(), null);
  assert.equal(manager.isAgentSpeaking(), false);
  const stats = manager.stats();
  assert.equal(stats.interruptions, 1);
  assert.equal(stats.meanStopLatencyMs, 300);
  assert.equal(stats.resumed, 1);
  assert.ok(manager.markdown().includes('| bi-1 | 1 |'));
});

test('barge-in: long remaining reply summarises, finished reply drops, rephrase word rephrases', () => {
  const manager = createBargeInManagerV25('s1');
  const longReply = 'A'.repeat(100) + ' ' + 'B'.repeat(500);
  manager.agentStartedSpeaking('turn-2', 1, longReply, 0);
  manager.agentSpeechProgress(500, 10);
  manager.reportBurst({ atMs: 800, atMsIntoReply: 800, energy: 0.9, sustainMs: 500, words: ['khoan'], userText: 'khoan' });
  const stopped = manager.agentStopped(900, 10);
  assert.ok(stopped !== null);
  assert.equal(stopped.resumeStrategy, 'summarise');

  const manager2 = createBargeInManagerV25('s2');
  manager2.agentStartedSpeaking('turn-2', 1, 'Done.', 0);
  manager2.agentSpeechProgress(400, 5);
  manager2.reportBurst({ atMs: 500, atMsIntoReply: 500, energy: 0.9, sustainMs: 500, words: ['xong'], userText: 'xong' });
  const stopped2 = manager2.agentStopped(600, 5);
  assert.ok(stopped2 !== null);
  assert.equal(stopped2.resumeStrategy, 'drop');

  const manager3 = createBargeInManagerV25('s3');
  manager3.agentStartedSpeaking('turn-2', 1, REPLY, 0);
  manager3.agentSpeechProgress(400, 10);
  manager3.reportBurst({ atMs: 500, atMsIntoReply: 500, energy: 0.9, sustainMs: 500, words: ['again'], userText: 'say it again' });
  const stopped3 = manager3.agentStopped(600, 10);
  assert.ok(stopped3 !== null);
  assert.equal(stopped3.resumeStrategy, 'rephrase');
});

test('barge-in: grace window, short burst and echo are ignored; backchannel ducks', () => {
  const manager = createBargeInManagerV25('s1');
  manager.agentStartedSpeaking('turn-2', 1, REPLY, 1000);
  // Inside the grace window (first 300ms of the reply).
  const grace = manager.reportBurst({ atMs: 1100, atMsIntoReply: 100, energy: 0.8, sustainMs: 500, words: ['này'], userText: 'này' });
  assert.equal(grace.decision.decision, 'ignore');
  assert.equal(grace.bargeIn, null);
  // Too short to be a real interruption.
  const short = manager.reportBurst({ atMs: 2000, atMsIntoReply: 1000, energy: 0.8, sustainMs: 50, words: ['ừ'], userText: 'ừ' });
  assert.equal(short.bargeIn, null);
  // Echo never interrupts.
  const echo = manager.reportBurst({ atMs: 2100, atMsIntoReply: 1100, energy: 0.9, sustainMs: 600, words: ['hello'], echo: true, userText: 'hello' });
  assert.equal(echo.decision.decision, 'ignore');
  // A sustained backchannel ducks instead of interrupting.
  const duck = manager.reportBurst({ atMs: 2200, atMsIntoReply: 1200, energy: 0.6, sustainMs: 500, words: ['ừm'], userText: 'ừm' });
  assert.equal(duck.decision.decision, 'duck-soft');
  assert.ok(duck.duck !== null);
  assert.equal(manager.stats().ducks, 1);
  assert.equal(manager.stats().interruptions, 0);
});

test('barge-in: no reply to cut, stop without pending, attach + false positive', () => {
  const manager = createBargeInManagerV25('s1');
  const burst = manager.reportBurst({ atMs: 100, atMsIntoReply: 0, energy: 0.8, sustainMs: 600, words: ['này'], userText: 'này' });
  assert.equal(burst.bargeIn, null);
  assert.equal(manager.agentStopped(200, 0), null);
  manager.agentStartedSpeaking('turn-2', 1, REPLY, 1000);
  manager.reportBurst({ atMs: 2000, atMsIntoReply: 1000, energy: 0.8, sustainMs: 600, words: ['dừng'], userText: 'dừng' });
  const stopped = manager.agentStopped(2100, 12);
  assert.ok(stopped !== null);
  assert.equal(manager.attachInterruptingTurn(stopped.bargeIn.id, 'turn-3'), true);
  assert.equal(manager.get(stopped.bargeIn.id)?.interruptingTurnId, 'turn-3');
  assert.equal(manager.attachInterruptingTurn('bi-nope', 'turn-3'), false);
  assert.equal(manager.markFalsePositive(stopped.bargeIn.id), true);
  assert.equal(manager.markFalsePositive('bi-nope'), false);
  assert.equal(manager.stats().falsePositives, 1);
});

test('barge-in: burst alert after 3 interruptions in one window, once per window', () => {
  const manager = createBargeInManagerV25('s1', { burstWindowMs: 10000, burstCount: 3 });
  for (let i = 0; i < 4; i += 1) {
    const base = 1000 + i * 1000;
    manager.agentStartedSpeaking(`turn-${i + 1}`, i, REPLY, base);
    const burst = manager.reportBurst({ atMs: base + 500, atMsIntoReply: 500, energy: 0.8, sustainMs: 600, words: ['dừng'], userText: 'dừng' });
    if (i === 2) assert.ok(burst.burstAlert !== null, '3rd barge-in raises the burst alert');
    if (i === 3) assert.equal(burst.burstAlert, null, '4th in the same window does not repeat the alert');
    manager.agentStopped(base + 600, 10);
  }
  assert.equal(manager.alertsList().length, 1);
  assert.equal(manager.stats().burstAlerts, 1);
});

test('barge-in: options validation rejects bad values', () => {
  assert.deepEqual(validateBargeInV25Options({ minUserSpeechMs: -1 }), ['minUserSpeechMs must be 0..5000']);
  assert.deepEqual(validateBargeInV25Options({ burstCount: 1 }), ['burstCount must be an integer 2..20']);
  assert.throws(() => new BargeInManagerV25('s1', { stopLatencySlowMs: 5 }), /stopLatencySlowMs/);
  assert.deepEqual(defaultBargeInV25Options().minUserSpeechMs, 250);
});

// -------------------------------------------------------------- turn-taking

test('turn-taking: full user -> agent flow with phase spans and floor', () => {
  const taking = createTurnTakingManagerV25('s1');
  assert.equal(taking.stateOf(), 'idle');
  assert.equal(taking.floorHolder(), 'none');
  const u = taking.userStarted(0, 'xin chào');
  assert.equal(u.ok, true);
  assert.equal(taking.stateOf(), 'user-speaking');
  assert.equal(taking.floorHolder(), 'user');
  const userTurn = u.turn;
  assert.ok(userTurn !== null);
  const ended = taking.userSpeechEnded(1500);
  assert.equal(ended.ok, true);
  assert.equal(taking.stateOf(), 'user-done');
  assert.equal(taking.floorHolder(), 'user');
  const yielded = taking.silenceYielded(2700);
  assert.equal(yielded.ok, true);
  assert.equal(taking.stateOf(), 'agent-thinking');
  assert.equal(taking.floorHolder(), 'agent');
  const agent = taking.agentStartedReply(3800, REPLY, 'codex', 'gpt-5.2');
  assert.equal(agent.ok, true);
  assert.equal(taking.stateOf(), 'agent-speaking');
  const agentTurn = agent.turn;
  assert.ok(agentTurn !== null);
  assert.equal(agentTurn.providerId, 'codex');
  assert.equal(agentTurn.model, 'gpt-5.2');
  const done = taking.agentFinishedReply(9000);
  assert.equal(done.ok, true);
  assert.equal(taking.stateOf(), 'idle');
  const turns = taking.list();
  assert.equal(turns.length, 2);
  const user = turns[0];
  assert.equal(user.role, 'user');
  assert.equal(user.status, 'completed');
  assert.equal(user.durationMs, 2700);
  const listenMs = user.phases.find((p) => p.phase === 'listening')?.durationMs;
  const waitMs = user.phases.find((p) => p.phase === 'silence-wait')?.durationMs;
  assert.equal(listenMs, 1500);
  assert.equal(waitMs, 1200);
  const agentDone = turns[1];
  assert.equal(agentDone.status, 'completed');
  const thinkMs = agentDone.phases.find((p) => p.phase === 'thinking')?.durationMs;
  const speakMs = agentDone.phases.find((p) => p.phase === 'speaking')?.durationMs;
  assert.equal(thinkMs, 1100);
  assert.equal(speakMs, 5200);
  const stats = taking.stats();
  assert.equal(stats.turns, 2);
  assert.equal(stats.completed, 2);
  assert.equal(stats.meanThinkMs, 1100);
  assert.equal(stats.meanSilenceWaitMs, 1200);
  assert.ok(taking.summary().includes('2 turns'));
  assert.ok(taking.markdown().includes('| 0 | user | completed |'));
});

test('turn-taking: illegal transitions fail without changing state', () => {
  const taking = createTurnTakingManagerV25('s1');
  assert.equal(taking.userSpeechEnded(100).ok, false);
  assert.equal(taking.silenceYielded(100).ok, false);
  assert.equal(taking.agentStartedReply(100, 'hi').ok, false);
  assert.equal(taking.agentFinishedReply(100).ok, false);
  assert.equal(taking.bargeIn(100, 'bi-1').ok, false);
  assert.equal(taking.abandonTurn(100).ok, false);
  assert.equal(taking.stateOf(), 'idle');
  taking.userStarted(0, 'hi');
  assert.equal(taking.agentStartedReply(100, 'hi').ok, false);
  assert.equal(taking.userStarted(200).ok, false);
  assert.equal(taking.stateOf(), 'user-speaking');
});

test('turn-taking: barge-in freezes the agent turn, interrupting turn starts fresh', () => {
  const taking = createTurnTakingManagerV25('s1');
  taking.userStarted(0, 'hello');
  taking.userSpeechEnded(1000);
  taking.silenceYielded(2000);
  taking.agentStartedReply(2500, REPLY);
  const cut = taking.bargeIn(4000, 'bi-1');
  assert.equal(cut.ok, true);
  assert.equal(cut.turn?.status, 'interrupted');
  assert.equal(cut.turn?.bargeInId, 'bi-1');
  assert.equal(cut.turn?.interruptedAtMs, 4000);
  assert.equal(taking.stateOf(), 'interrupted');
  assert.equal(taking.floorHolder(), 'none');
  const recorded = taking.recordInterruption(cut.turn.id, REPLY.slice(0, 12), 12, 4100);
  assert.equal(recorded, true);
  assert.equal(taking.get(cut.turn.id)?.text, REPLY.slice(0, 12));
  assert.equal(taking.get(cut.turn.id)?.spokenChars, 12);
  const next = taking.userStarted(4200, 'dừng lại đi');
  assert.equal(next.ok, true);
  assert.notEqual(next.turn?.id, cut.turn?.id);
  assert.equal(next.turn?.index, 2);
  assert.equal(taking.stats().interrupted, 1);
});

test('turn-taking: backchannel never changes state; timeout releases the floor', () => {
  const taking = createTurnTakingManagerV25('s1', { maxUserTurnMs: 5000, maxAgentTurnMs: 5000, maxThinkingMs: 2000 });
  taking.userStarted(0, 'hello');
  taking.userSpeechEnded(1000);
  taking.silenceYielded(2000);
  taking.agentStartedReply(2500, REPLY);
  assert.equal(taking.userBackchannel(3000, 'ừm'), true);
  assert.equal(taking.stateOf(), 'agent-speaking');
  assert.equal(taking.backchannelsList().length, 1);
  assert.throws(() => taking.userBackchannel(3100, ''), /non-empty/);
  const timedOut = taking.timeoutCheck(8000);
  assert.ok(timedOut !== null);
  assert.equal(timedOut.status, 'timeout');
  assert.equal(taking.stateOf(), 'idle');
  assert.equal(taking.timeoutCheck(9000), null);

  const thinking = createTurnTakingManagerV25('s2', { maxThinkingMs: 2000 });
  thinking.userStarted(0, 'hi');
  thinking.userSpeechEnded(500);
  thinking.silenceYielded(1000);
  assert.equal(thinking.timeoutCheck(3500), null);
  assert.equal(thinking.stateOf(), 'idle');

  const abandon = createTurnTakingManagerV25('s3');
  abandon.userStarted(0, 'hi');
  const ab = abandon.abandonTurn(500);
  assert.equal(ab.ok, true);
  assert.equal(ab.turn?.status, 'abandoned');
  assert.equal(abandon.stats().abandoned, 1);
});

test('turn-taking: audio totals and longest silence attach to turns', () => {
  const taking = createTurnTakingManagerV25('s1');
  const started = taking.userStarted(0, 'hi');
  const id = started.turn.id;
  assert.equal(taking.addTurnAudio(id, 800, 1500), true);
  assert.equal(taking.noteLongestSilence(id, 800), true);
  assert.equal(taking.noteLongestSilence(id, 300), true);
  assert.equal(taking.addTurnAudio('turn-nope', 1, 1), false);
  const turn = taking.get(id);
  assert.equal(turn?.silenceMs, 800);
  assert.equal(turn?.speechMs, 1500);
  assert.equal(turn?.longestSilenceMs, 800);
  assert.deepEqual(validateTurnTakingV25Options({ maxUserTurnMs: 10 }), ['maxUserTurnMs must be 1000..600000']);
  assert.equal(defaultTurnTakingV25Options().maxUserTurnMs, 60000);
});

// ----------------------------------------------------------- silence detection

test('silence: boolean frames debounce speech and silence, gaps yield the floor', () => {
  const detector = createSilenceDetectorV25('s1', { silenceThresholdMs: 700, yieldThresholdMs: 1200, minSpeechMs: 150 });
  // 100ms of speech: too short to confirm.
  let events = detector.feedSpeech(true, 100);
  assert.deepEqual(events, []);
  assert.equal(detector.stateOf(), 'unknown');
  // 150ms total (100 -> 250): speech confirmed.
  events = detector.feedSpeech(true, 250);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'speech-start');
  assert.equal(detector.stateOf(), 'speech');
  // Silence run starts at 1000; 700ms of quiet confirms silence at 1700.
  detector.feedSpeech(false, 1000);
  events = detector.feedSpeech(false, 1700);
  assert.equal(events.some((e) => e.kind === 'silence-start'), true);
  assert.equal(detector.stateOf(), 'silence');
  assert.equal(detector.currentSilenceMs(2000), 1000);
  // Yield line is 1200ms of silence: gap started at 1000.
  events = detector.feedSpeech(false, 2200);
  assert.equal(events.some((e) => e.kind === 'yield'), true);
  assert.equal(detector.shouldYield(2200), true);
  const gap = detector.gapsList()[0];
  assert.equal(gap.yielded, true);
  assert.equal(gap.startedAtMs, 1000);
  // Speech resumes: gap closes, speech-start fires after minSpeechMs.
  events = detector.feedSpeech(true, 3000);
  assert.equal(events.some((e) => e.kind === 'silence-end'), true);
  assert.equal(detector.gapsList()[0].durationMs, 2000);
  assert.equal(detector.gapsList()[0].endedBySpeech, true);
  events = detector.feedSpeech(true, 3200);
  assert.equal(events.some((e) => e.kind === 'speech-start'), true);
  const stats = detector.stats();
  assert.equal(stats.gaps, 1);
  assert.equal(stats.totalSilenceMs, 2000);
  assert.equal(stats.longestSilenceMs, 2000);
  assert.equal(stats.yieldedGaps, 1);
  assert.ok(detector.summary().includes('1 silence gaps'));
  assert.ok(detector.markdown().includes('| gap-1 |'));
});

test('silence: short blips never flip state; energy follows the noise floor', () => {
  const detector = createSilenceDetectorV25('s1', { silenceThresholdMs: 700, minSpeechMs: 150 });
  detector.setNoiseFloor(0.02);
  assert.equal(detector.thresholdOf(), 0.06);
  // A 50ms loud blip is not speech.
  let events = detector.feedEnergy(0.9, 50);
  assert.deepEqual(events, []);
  assert.equal(detector.stateOf(), 'unknown');
  // Quiet frames pull the floor down.
  for (let t = 100; t <= 500; t += 100) detector.feedEnergy(0.01, t);
  assert.ok(detector.noiseFloorOf() < 0.02);
  // Sustained loud frames confirm speech.
  detector.feedEnergy(0.9, 600);
  events = detector.feedEnergy(0.9, 800);
  assert.equal(events.some((e) => e.kind === 'speech-start'), true);
  // A 100ms quiet blip does not end speech.
  events = detector.feedEnergy(0.01, 900);
  assert.equal(detector.stateOf(), 'speech');
  assert.throws(() => detector.feedEnergy(0.9, 850), /before previous frame/);
  assert.throws(() => detector.feedEnergy(2, 1000), /energy must be/);
  assert.throws(() => detector.setNoiseFloor(0.9), /noise floor/);
  assert.deepEqual(validateSilenceDetectorV25Options({ yieldThresholdMs: 10 }), ['yieldThresholdMs must be 100..30000']);
  assert.equal(defaultSilenceDetectorV25Options().silenceThresholdMs, 700);
});

test('silence: endTurn closes the open gap without speech; stats per turn', () => {
  const detector = createSilenceDetectorV25('s1');
  detector.feedSpeech(true, 100, 'turn-1');
  detector.feedSpeech(true, 300, 'turn-1');
  detector.feedSpeech(false, 1000, 'turn-1');
  detector.feedSpeech(false, 1800, 'turn-1');
  assert.equal(detector.stateOf(), 'silence');
  const events = detector.endTurn(2500, 'turn-1');
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'silence-end');
  const gap = detector.gapsList('turn-1')[0];
  assert.equal(gap.endedBySpeech, false);
  assert.equal(gap.durationMs, 1500);
  assert.equal(detector.gapsList('turn-2').length, 0);
  const stats = detector.stats('turn-1');
  assert.equal(stats.gaps, 1);
  assert.equal(stats.totalSilenceMs, 1500);
  assert.equal(detector.stateOf(), 'unknown');
});

// ------------------------------------------------------------------- helpers

test('types: duration helpers, buckets, ids, checksum', () => {
  assert.equal(formatDurationV25(850), '850ms');
  assert.equal(formatDurationV25(1230), '1.23s');
  assert.equal(formatDurationV25(125000), '2m 05s');
  assert.equal(formatDurationV25(Number.NaN), '—');
  assert.equal(formatDurationShortV25(125000), '2m05s');
  assert.equal(durationBucketV25(100, 5000, 30000), 'fast');
  assert.equal(durationBucketV25(2000, 5000, 30000), 'normal');
  assert.equal(durationBucketV25(6000, 5000, 30000), 'slow');
  assert.equal(durationBucketV25(40000, 5000, 30000), 'very-slow');
  assert.equal(isValidVoiceV25Id('s1'), true);
  assert.equal(isValidVoiceV25Id('bad id'), false);
  assert.equal(isValidVoiceV25Id(''), false);
  const turns = [
    { role: 'user', text: 'hi', status: 'completed' },
    { role: 'assistant', text: 'hello', status: 'completed' },
  ];
  const checksum = turnChecksumV25(turns);
  assert.equal(typeof checksum, 'string');
  assert.equal(checksum.length, 8);
  assert.equal(turnChecksumV25(turns), checksum);
  assert.notEqual(turnChecksumV25([{ role: 'user', text: 'bye', status: 'completed' }]), checksum);
});
