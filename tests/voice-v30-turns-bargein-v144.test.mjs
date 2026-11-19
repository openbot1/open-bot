/**
 * Tests for voice v30 units: turn detector v2 + barge-in v2 (v1.44, Team T4).
 *
 * Covers: silence never starts a turn, the confirmation buffer
 * (short bursts never open a turn), spike rejection (a single loud
 * frame is dropped, sustained loud speech still opens a turn),
 * hysteresis (a dip below the high threshold but above the low
 * threshold keeps the turn open), the adaptive silence timeout
 * (long turns stretch it), echo frames (agent audio never opens
 * a turn), backchannel filtering, per-turn confidence, presets,
 * barge-in verdicts (grace, too-short, low-confidence, soft,
 * hard, cooldown), sentence-boundary resume, and false-positive
 * learning.
 *
 * All offline, deterministic, no key / network / audio.
 * Only the v30 namespace is asserted — no global totals.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AudioTurnDetectorV30,
  BargeInEngineV30,
  VOICE_V30_TURN_PRESETS,
  createAudioTurnDetectorV30,
  createBargeInEngineV30,
} from '../packages/core/dist/voiceV30/index.js';

function feed(detector, fromMs, count, energy, text) {
  const results = [];
  for (let i = 0; i < count; i += 1) {
    results.push(detector.feed({ atMs: fromMs + i * 50, energy, text: text ?? null }));
  }
  return results;
}

test('v30 turn detector: silence only never starts a turn', () => {
  const detector = createAudioTurnDetectorV30();
  const results = feed(detector, 0, 20, 0.02);
  assert.ok(results.every((r) => r.kind === 'silence'));
  assert.ok(results.every((r) => !r.turnStarted && !r.turnEnded));
  assert.equal(detector.stats().turns, 0);
});

test('v30 turn detector: speech confirms, then silence ends one turn', () => {
  const detector = createAudioTurnDetectorV30();
  const speech = feed(detector, 0, 10, 0.8, 'hello');
  // The first frames are still in the confirmation buffer.
  assert.equal(speech[0].kind, 'confirming');
  assert.equal(speech[0].turnStarted, false);
  // Confirmation (150ms) completes on the 4th frame (at 150ms).
  assert.equal(speech[3].turnStarted, true);
  assert.equal(speech[3].kind, 'speech');
  const silence = feed(detector, 500, 18, 0.02);
  const ended = silence.find((r) => r.turnEnded);
  assert.notEqual(ended, undefined);
  assert.equal(ended?.endReason, 'silence');
  assert.equal(detector.stats().turns, 1);
  const turn = detector.lastTurn();
  assert.notEqual(turn, null);
  assert.ok((turn?.durationMs ?? 0) >= 400);
  assert.equal(turn?.text, 'hello '.repeat(10).trim());
  assert.equal(turn?.frames, 10);
  assert.ok((turn?.confidence ?? 0) > 0.4);
  assert.equal(turn?.echoSuspect, false);
});

test('v30 turn detector: a burst that dies before confirmation is noise, never a turn', () => {
  const detector = createAudioTurnDetectorV30();
  const speech = feed(detector, 0, 2, 0.8);
  assert.ok(speech.every((r) => r.kind === 'confirming'));
  assert.ok(speech.every((r) => !r.turnStarted));
  const silence = feed(detector, 100, 4, 0.02);
  assert.ok(silence.some((r) => r.noiseRejected));
  assert.equal(detector.stats().turns, 0);
  assert.equal(detector.stats().noiseRejected, 1);
  assert.equal(detector.lastTurn(), null);
});

test('v30 turn detector: a single loud frame is a spike, sustained loud speech still opens a turn', () => {
  const detector = createAudioTurnDetectorV30();
  const spike = detector.feed({ atMs: 0, energy: 0.99 });
  assert.equal(spike.kind, 'noise');
  assert.equal(spike.noiseRejected, true);
  assert.equal(detector.stats().spikesRejected, 1);
  assert.equal(detector.stats().turns, 0);
  // Sustained loud speech: the first frame is a spike, the rest confirm.
  const speech = feed(detector, 50, 10, 0.9, 'loud');
  assert.ok(speech.some((r) => r.turnStarted));
  assert.equal(detector.stats().turns, 0); // not ended yet
  assert.equal(detector.isSpeaking(), true);
  const silence = feed(detector, 550, 18, 0.02);
  assert.ok(silence.some((r) => r.turnEnded));
  assert.equal(detector.stats().turns, 1);
});

test('v30 turn detector: hysteresis keeps the turn open through a dip below the high threshold', () => {
  const detector = createAudioTurnDetectorV30();
  feed(detector, 0, 6, 0.8);
  assert.equal(detector.isSpeaking(), true);
  // 0.15 is below the high threshold (0.22) but above the low (0.12):
  // the turn must stay open, not end.
  const dip = feed(detector, 300, 6, 0.15);
  assert.ok(dip.every((r) => r.kind === 'speech'));
  assert.equal(detector.isSpeaking(), true);
  assert.equal(detector.stats().turns, 0);
  const silence = feed(detector, 600, 18, 0.02);
  assert.ok(silence.some((r) => r.turnEnded));
  assert.equal(detector.stats().turns, 1);
});

test('v30 turn detector: adaptive silence timeout stretches after a long turn', () => {
  const detector = createAudioTurnDetectorV30();
  const base = detector.effectiveSilenceTimeoutMs();
  assert.equal(base, 700);
  feed(detector, 0, 80, 0.8); // 4 seconds of speech
  feed(detector, 4000, 30, 0.02);
  assert.equal(detector.stats().turns, 1);
  const stretched = detector.effectiveSilenceTimeoutMs();
  assert.ok(stretched > base, `expected stretched timeout > ${base}, got ${stretched}`);
  assert.ok(stretched <= 1500);
});

test('v30 turn detector: agent audio frames are echo, never a turn', () => {
  const detector = createAudioTurnDetectorV30();
  const results = [];
  for (let i = 0; i < 10; i += 1) {
    results.push(detector.feed({ atMs: i * 50, energy: 0.8, agentSpeaking: true }));
  }
  assert.ok(results.every((r) => r.kind === 'echo'));
  assert.ok(results.every((r) => r.echoSuppressed));
  assert.equal(detector.stats().turns, 0);
  assert.equal(detector.stats().echoFrames, 10);
});

test('v30 turn detector: a short quiet burst is a backchannel, not a turn', () => {
  const detector = createAudioTurnDetectorV30();
  feed(detector, 0, 6, 0.3);
  const ended = detector.endNow(300, 'explicit');
  assert.notEqual(ended, null);
  assert.equal(ended?.backchannel, true);
  assert.equal(detector.stats().turns, 0);
  assert.equal(detector.stats().backchannels, 1);
});

test('v30 turn detector: a long loud turn scores higher confidence than a short quiet one', () => {
  const loud = createAudioTurnDetectorV30();
  feed(loud, 0, 40, 0.9, 'a long sentence here');
  feed(loud, 2000, 18, 0.02);
  const loudTurn = loud.lastTurn();
  const quiet = createAudioTurnDetectorV30();
  feed(quiet, 0, 8, 0.25, 'mm');
  feed(quiet, 400, 18, 0.02);
  const quietTurn = quiet.lastTurn();
  assert.ok(loudTurn !== null && quietTurn !== null);
  assert.ok((loudTurn?.confidence ?? 0) > (quietTurn?.confidence ?? 0));
  assert.ok((loudTurn?.confidence ?? 0) >= 0.5);
});

test('v30 turn detector: presets change thresholds; unknown preset throws', () => {
  const detector = createAudioTurnDetectorV30();
  const noisy = detector.applyPreset('noisy-room');
  assert.equal(noisy.highThreshold, 0.35);
  assert.equal(noisy.lowThreshold, 0.2);
  assert.equal(noisy.confirmMs, 250);
  assert.throws(() => detector.applyPreset('nope'), /Unknown turn preset/);
  assert.deepEqual(Object.keys(VOICE_V30_TURN_PRESETS).sort(), ['balanced', 'noisy-room', 'push-to-talk', 'relaxed', 'sensitive']);
});

test('v30 turn detector: invalid config throws (low threshold must be below high)', () => {
  assert.throws(
    () => new AudioTurnDetectorV30({ config: { highThreshold: 0.1, lowThreshold: 0.2 } }),
    /lowThreshold must be below highThreshold/,
  );
  assert.throws(
    () => new AudioTurnDetectorV30({ config: { spikeThreshold: 0.1 } }),
    /spikeThreshold must be above highThreshold/,
  );
});

test('v30 barge-in: grace window ignores early interrupts', () => {
  const engine = createBargeInEngineV30();
  engine.serverStartResponse('Hello, this is a long answer.', 0, 's1');
  const early = engine.requestInterrupt('user-speech', 100, 1000, 0.9, [0.5, 0.7, 0.9]);
  assert.equal(early.verdict, 'ignore-grace');
  assert.equal(engine.stats().interruptions, 0);
});

test('v30 barge-in: too-short speech is ignored; sustained rising speech interrupts soft', () => {
  const engine = createBargeInEngineV30();
  const response = engine.serverStartResponse('Hello, this is a long answer with several sentences. It keeps going.', 0, 's1');
  engine.serverMarkSpoken(response.id, 20, 500);
  const short = engine.requestInterrupt('user-speech', 1000, 100, 0.9, [0.9]);
  assert.equal(short.verdict, 'ignore-too-short');
  const soft = engine.requestInterrupt('user-speech', 1100, 300, 0.6, [0.4, 0.5, 0.55, 0.6]);
  assert.equal(soft.verdict, 'interrupt-soft');
  assert.equal(soft.level, 'soft');
  assert.ok((soft.confidence ?? 0) >= 0.55);
  const paused = engine.getResponse(response.id);
  assert.equal(paused?.state, 'paused');
  // Resume starts at a sentence boundary, not mid-word.
  assert.ok((paused?.resumeAtChars ?? 0) >= 20);
  const resumedText = paused ? response.text.slice(paused.resumeAtChars) : '';
  assert.ok(!resumedText.startsWith(' ') || resumedText.length === 0);
  assert.equal(engine.stats().softInterruptions, 1);
  assert.equal(engine.stats().hardInterruptions, 0);
});

test('v30 barge-in: resume remainder starts a new response from the sentence boundary', () => {
  const engine = createBargeInEngineV30();
  const text = 'First sentence here. Second sentence follows. Third one ends it.';
  const response = engine.serverStartResponse(text, 0, 's1');
  engine.serverMarkSpoken(response.id, 10, 500);
  engine.requestInterrupt('user-speech', 1000, 300, 0.6, [0.4, 0.5, 0.55, 0.6]);
  const resumed = engine.resumeRemainder(response.id, 1500, 's1');
  assert.notEqual(resumed, null);
  assert.equal(resumed?.state, 'active');
  assert.ok(resumed?.text.startsWith('Second sentence'), `resumed text: ${resumed?.text}`);
  assert.equal(engine.stats().resumes, 1);
});

test('v30 barge-in: user button is always hard; cooldown blocks the next interrupt', () => {
  const engine = createBargeInEngineV30();
  const response = engine.serverStartResponse('A long answer that will be cut off.', 0, 's1');
  engine.serverMarkSpoken(response.id, 5, 500);
  const hard = engine.requestInterrupt('user-button', 1000);
  assert.equal(hard.verdict, 'interrupt-hard');
  assert.equal(hard.confidence, 1);
  assert.equal(engine.getResponse(response.id)?.state, 'cancelled');
  // Resume the cancelled remainder is impossible; start a fresh response.
  const fresh = engine.serverStartResponse('A fresh answer.', 1200, 's1');
  // Inside the 800ms cooldown after the 1000ms interrupt (and past grace).
  const cooled = engine.requestInterrupt('user-speech', 1600, 600, 0.8, [0.4, 0.6, 0.8]);
  assert.equal(cooled.verdict, 'ignore-cooldown');
  // After the cooldown, the same speech interrupts again.
  const later = engine.requestInterrupt('user-speech', 2000, 300, 0.6, [0.4, 0.5, 0.55, 0.6]);
  assert.equal(later.verdict, 'interrupt-soft');
  assert.equal(fresh.id, later.responseId);
});

test('v30 barge-in: falling energy scores lower than rising energy', () => {
  const engine = createBargeInEngineV30();
  const rising = engine.scoreInterruption(600, [0.3, 0.5, 0.7, 0.9], 0.9);
  const falling = engine.scoreInterruption(600, [0.9, 0.7, 0.5, 0.3], 0.9);
  assert.ok(rising > falling, `rising ${rising} should beat falling ${falling}`);
});

test('v30 barge-in: a false positive lowers sensitivity', () => {
  const engine = createBargeInEngineV30();
  const before = engine.sensitivityNow();
  const after = engine.markFalsePositive(0);
  assert.ok(after < before);
  assert.equal(after, before - 0.03);
  assert.equal(engine.stats().falsePositives, 1);
});

test('v30 barge-in: discard remainder cancels a paused response', () => {
  const engine = createBargeInEngineV30();
  const response = engine.serverStartResponse('Answer one. Answer two.', 0, 's1');
  engine.serverMarkSpoken(response.id, 8, 500);
  engine.requestInterrupt('user-speech', 1000, 300, 0.6, [0.4, 0.5, 0.55, 0.6]);
  assert.equal(engine.discardRemainder(response.id, 1200), true);
  assert.equal(engine.getResponse(response.id)?.state, 'cancelled');
  assert.equal(engine.stats().discards, 1);
  assert.equal(engine.resumeRemainder(response.id, 1300, 's1'), null);
});
