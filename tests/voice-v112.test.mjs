/**
 * Tests for v1.12 — voice realtime v11 (Team T5).
 *
 *   1. Mock audio (audioMockV11.ts): seeded PRNG is deterministic,
 *      silence/tone/noise/speech-like/hum/hiss frames have the
 *      expected RMS + ZCR, echo is a scaled copy, scripts assemble
 *      labelled frames in order.
 *   2. VAD v11 (vadV11.ts): presets + validation (stop < start
 *      hysteresis), calibration sets floors and fires an event,
 *      silence stays silent, speech-like audio is one turn,
 *      hum and hiss are rejected, echo never starts a turn,
 *      double-talk is counted, short bursts are backchannels,
 *      too-short bursts are false starts, a short pause merges
 *      into the same turn, a long turn is force-ended (max-turn).
 *   3. Barge-in v11 (bargeInV11.ts): guarded state machine
 *      (legal/illegal transitions, transition log), policies
 *      immediate/grace/confirm/smart (confidence + duration),
 *      duck/resume, exact interrupt receipt + latency, cooldown
 *      via tick().
 *   4. Turn-taking v11 (turnTakingV11.ts): floor hand-offs,
 *      overlap recording + resolution, silence timeout + nudges
 *      + call-idle, max-turn timeout, yield hint from falling
 *      energy, switch-latency stats.
 *   5. TTS stream v11 (ttsStreamV11.ts): sentence-boundary
 *      chunking, abbreviation protection, short-sentence
 *      accumulation, final flush, deterministic mock synth frames,
 *      virtual-clock playback, pause/resume, cancelPending receipt.
 *   6. Session v11 (voiceSessionV11.ts): connect, calibration +
 *      user turn + auto mock reply + drain back to listening,
 *      full barge-in round-trip over real audio frames (smart
 *      policy cuts the reply, TTS chunks cancelled, cooldown
 *      returns to listening), explicit interrupt, manager registry.
 *   7. Session v11 store (voiceSessionV11Store.ts): snapshot
 *      round-trip, checksum validation, corrupt quarantine,
 *      prune, resume instructions + markdown.
 *   8. Voice v11 tools (packages/tools/src/voiceV11Tools.ts): 8
 *      tools, unique names, placeholder refuses, full lifecycle
 *      through the tools on a real manager, registry wiring
 *      (ALL_TOOLS holds all 8, no duplicate names).
 *   9. Renderer-local view models (voiceSessionV11View.ts): row
 *      parsing, VAD probability bands, barge-in cut receipt,
 *      turn rows, TTS chunk progress, status keys, summary lines.
 *  10. i18n: 30 `voice.realtime.v11.*` keys in all 6 locales,
 *      non-empty, same key set everywhere.
 *  11. Core root re-exports: VadV11 / BargeInV11Controller /
 *      TurnTakingManagerV11 / TtsStreamV11 / session / store are
 *      importable from `@open-bot/core`.
 *
 * No network, no sound card, no live provider, no key. Every
 * audio path here is mock (audioMockV11 frames, scripted replies,
 * mock sine TTS synth).
 * Run after building core + tools:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/voice-v112.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  mulberry32,
  frameRms,
  frameZcr,
  silenceFrame,
  toneFrame,
  noiseFrame,
  speechLikeFrame,
  humFrame,
  hissFrame,
  echoFrame,
  buildMockAudioScript,
} from '../packages/core/dist/voice/audioMockV11.js';
import {
  VadV11,
  createVadV11,
  defaultVadV11Options,
  validateVadV11Options,
  isVadV11PresetName,
  vadV11Summary,
  vadV11Markdown,
  vadV11FrameFeatures,
  VAD_V11_PRESETS,
} from '../packages/core/dist/voice/vadV11.js';
import {
  BargeInV11Controller,
  splitWordsV11,
  defaultBargeInV11Options,
  validateBargeInV11Options,
  isBargeInV11Policy,
  isBargeInV11State,
  bargeInV11Summary,
  bargeInV11Markdown,
  BARGE_IN_V11_TRANSITIONS,
} from '../packages/core/dist/voice/bargeInV11.js';
import {
  TurnTakingManagerV11,
  defaultTurnTakingV11Options,
  validateTurnTakingV11Options,
  turnTakingV11Summary,
  turnTakingV11Markdown,
} from '../packages/core/dist/voice/turnTakingV11.js';
import {
  TtsStreamV11,
  createTtsStreamV11,
  splitTtsStreamChunks,
  mockTtsSynthV11,
  defaultTtsStreamV11Options,
  validateTtsStreamV11Options,
  ttsStreamV11Summary,
  ttsStreamV11Markdown,
} from '../packages/core/dist/voice/ttsStreamV11.js';
import {
  RealtimeVoiceSessionV11,
  VoiceV11Manager,
  createMockVoiceSessionV11,
  voiceSessionV11Summary,
  voiceSessionV11Markdown,
} from '../packages/core/dist/voice/voiceSessionV11.js';
import {
  VoiceSessionV11Store,
  createVoiceSessionV11Snapshot,
  validateVoiceSessionV11Snapshot,
  voiceSessionV11SnapshotPath,
  buildVoiceSessionV11ResumeInstructions,
  voiceSessionV11SnapshotMarkdown,
} from '../packages/core/dist/voice/voiceSessionV11Store.js';
import {
  VadV11 as RootVadV11,
  BargeInV11Controller as RootBargeInV11,
  TurnTakingManagerV11 as RootTurnTakingV11,
  TtsStreamV11 as RootTtsStreamV11,
  RealtimeVoiceSessionV11 as RootSessionV11,
  VoiceSessionV11Store as RootStoreV11,
} from '../packages/core/dist/index.js';
import {
  createVoiceV11Tools,
  VOICE_V11_TOOLS,
  VOICE_V11_TOOL_NAMES,
  isVoiceV11ToolName,
} from '../packages/tools/dist/voiceV11Tools.js';
import { ALL_TOOLS, createDefaultTools } from '../packages/tools/dist/tools.js';
import {
  parseVoiceSessionV11Row,
  voiceV11VadView,
  voiceV11BargeInView,
  voiceV11TurnRows,
  voiceV11TtsChunkRows,
  voiceV11TurnTakingView,
  voiceV11TtsView,
  voiceV11StatusKey,
  voiceV11SummaryLines,
  parseVoiceV11Status,
  parseVoiceV11Floor,
  parseVoiceV11BargeInPolicy,
} from '../apps/desktop/src/renderer/voice/voiceSessionV11View.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SILENCE = silenceFrame();

function feedScript(vad, segments, input) {
  for (const { frame } of buildMockAudioScript(segments)) {
    if (input) vad.feed(frame, input);
    else vad.feed(frame);
  }
}

function feedSessionScript(session, segments, input) {
  for (const { frame } of buildMockAudioScript(segments)) {
    if (input) session.feedAudio(frame, input);
    else session.feedAudio(frame);
  }
}

/** Calibrate a VAD on silence (25 frames = 500 ms). */
function calibrate(vad) {
  for (let i = 0; i < 30; i++) vad.feed(SILENCE);
  assert.equal(vad.isCalibrated(), true);
}

// ---------------------------------------------------------------------------
// 1. Mock audio
// ---------------------------------------------------------------------------

test('mock audio v11: seeded PRNG is deterministic, frames have expected features', () => {
  const a = mulberry32(42);
  const b = mulberry32(42);
  const seqA = [a(), a(), a(), a(), a()];
  const seqB = [b(), b(), b(), b(), b()];
  assert.deepEqual(seqA, seqB, 'same seed yields the same stream');
  assert.notDeepEqual(seqA, [mulberry32(43)(), mulberry32(43)(), mulberry32(43)(), mulberry32(43)(), mulberry32(43)()]);
  const n1 = noiseFrame(0.05, 3);
  const n2 = noiseFrame(0.05, 3);
  assert.deepEqual([...n1], [...n2]);
  assert.notDeepEqual([...n1], [...noiseFrame(0.05, 4)]);
  assert.equal(frameRms(SILENCE), 0);
  assert.equal(frameZcr(SILENCE), 0);
  const tone = toneFrame(300, 0.2);
  assert.ok(Math.abs(frameRms(tone) - 0.2 / Math.SQRT2) < 0.01, `tone rms ${frameRms(tone)}`);
  assert.ok(frameZcr(tone) >= 8 && frameZcr(tone) <= 16, `tone zcr ${frameZcr(tone)}`);
  const speech = speechLikeFrame(0.25);
  assert.ok(frameRms(speech) > 0.02, `speech rms ${frameRms(speech)}`);
  assert.ok(frameZcr(speech) >= 4 && frameZcr(speech) <= 60, `speech zcr ${frameZcr(speech)}`);
  const hum = humFrame(0.2);
  assert.ok(frameRms(hum) > 0.1);
  assert.ok(frameZcr(hum) <= 4, `hum zcr ${frameZcr(hum)}`);
  const hiss = hissFrame(0.1);
  assert.ok(frameZcr(hiss) > 100, `hiss zcr ${frameZcr(hiss)}`);
  const echoed = echoFrame(tone, 0.5);
  assert.ok(Math.abs(frameRms(echoed) - frameRms(tone) * 0.5) < 0.005);
  assert.throws(() => echoFrame(tone, 1.5), /factor/);
});

test('mock audio v11: scripts assemble labelled frames in order', () => {
  const script = buildMockAudioScript([
    { label: 'silence', durationMs: 100 },
    { label: 'speech', durationMs: 100, amplitude: 0.25 },
    { label: 'noise', durationMs: 40, amplitude: 0.05, seed: 5 },
  ]);
  assert.equal(script.length, 5 + 5 + 2);
  assert.deepEqual(script.map((s) => s.label), [
    'silence', 'silence', 'silence', 'silence', 'silence',
    'speech', 'speech', 'speech', 'speech', 'speech',
    'noise', 'noise',
  ]);
  assert.equal(script[0].offsetMs, 0);
  assert.equal(script[5].offsetMs, 0);
  assert.throws(() => buildMockAudioScript([{ label: 'speech', durationMs: 0 }]), /durationMs/);
});

// ---------------------------------------------------------------------------
// 2. VAD v11
// ---------------------------------------------------------------------------

test('vad v11: presets, defaults, validation (hysteresis needs a gap)', () => {
  assert.deepEqual(Object.keys(VAD_V11_PRESETS).sort(), ['noisy', 'office', 'quiet', 'street']);
  assert.equal(isVadV11PresetName('street'), true);
  assert.equal(isVadV11PresetName('cafe'), false);
  const defaults = defaultVadV11Options();
  assert.equal(defaults.preset, 'office');
  assert.ok(defaults.stopThreshold < defaults.startThreshold);
  assert.equal(defaults.minSpeechMs, VAD_V11_PRESETS.office.minSpeechMs);
  assert.throws(() => validateVadV11Options({ preset: 'cafe' }), /preset/);
  assert.throws(() => validateVadV11Options({ startThreshold: 0.3, stopThreshold: 0.4 }), /stopThreshold/);
  assert.throws(() => validateVadV11Options({ smoothingAlpha: 2 }), /smoothingAlpha/);
  const street = validateVadV11Options({ preset: 'street' });
  assert.equal(street.startThreshold, VAD_V11_PRESETS.street.startThreshold);
  assert.equal(street.initialLowFloor, VAD_V11_PRESETS.street.initialLowFloor);
});

test('vad v11: calibration fires, silence stays silent, speech is one turn', () => {
  const events = [];
  const vad = createVadV11({}, (e) => events.push(e));
  assert.equal(vad.isCalibrated(), false);
  for (let i = 0; i < 24; i++) vad.feed(SILENCE);
  assert.equal(vad.isCalibrated(), false);
  vad.feed(SILENCE);
  assert.equal(vad.isCalibrated(), true);
  assert.equal(events.filter((e) => e.kind === 'calibration-done').length, 1);
  assert.equal(events[0].frames, 25);
  assert.ok(events[0].lowFloor > 0);
  for (let i = 0; i < 10; i++) vad.feed(SILENCE);
  assert.equal(vad.isSpeaking(), false);
  assert.equal(vad.getStats().turns, 0);
  feedScript(vad, [{ label: 'speech', durationMs: 600, amplitude: 0.25 }]);
  assert.equal(vad.isSpeaking(), true);
  assert.equal(events.filter((e) => e.kind === 'speech-start').length, 1);
  assert.ok(events.find((e) => e.kind === 'speech-start').confidence >= 0.6);
  for (let i = 0; i < 40; i++) vad.feed(SILENCE);
  assert.equal(vad.isSpeaking(), false);
  assert.equal(events.filter((e) => e.kind === 'speech-end').length, 1);
  const stats = vad.getStats();
  assert.equal(stats.turns, 1);
  assert.ok(stats.speechMs >= 300, `speechMs ${stats.speechMs}`);
  assert.ok(vadV11Summary(stats).includes('1 turns'));
  assert.ok(vadV11Markdown(stats).includes('## VAD v11'));
  const features = vadV11FrameFeatures(speechLikeFrame(0.25));
  assert.ok(features.probability > 0.5, `speech frame p=${features.probability}`);
  assert.ok(vadV11FrameFeatures(SILENCE).probability < 0.35, 'silence frame p is low');
});

test('vad v11: hum and hiss are rejected, noise stays silent', () => {
  const events = [];
  const vad = createVadV11({}, (e) => events.push(e));
  calibrate(vad);
  feedScript(vad, [{ label: 'hum', durationMs: 400, amplitude: 0.2 }]);
  assert.equal(vad.isSpeaking(), false);
  assert.equal(events.filter((e) => e.kind === 'speech-start').length, 0);
  assert.ok(vad.getStats().humRejections > 0, 'hum frames counted');
  feedScript(vad, [{ label: 'hiss', durationMs: 400, amplitude: 0.1, seed: 11 }]);
  assert.equal(vad.isSpeaking(), false);
  assert.ok(vad.getStats().hissRejections > 0, 'hiss frames counted');
  for (let i = 0; i < 10; i++) vad.feed(noiseFrame(0.03, 100 + i));
  assert.equal(vad.isSpeaking(), false);
  // The same detector still hears real speech afterwards.
  feedScript(vad, [{ label: 'speech', durationMs: 400, amplitude: 0.25 }]);
  assert.equal(vad.isSpeaking(), true);
});

test('vad v11: echo never starts a turn, double-talk is counted', () => {
  const vad = createVadV11({});
  calibrate(vad);
  feedScript(vad, [{ label: 'speech', durationMs: 400, amplitude: 0.25 }], { echo: true });
  assert.equal(vad.isSpeaking(), false);
  assert.ok(vad.getStats().echoRejections > 0);
  feedScript(vad, [{ label: 'speech', durationMs: 300, amplitude: 0.25 }]);
  assert.equal(vad.isSpeaking(), true);
  const before = vad.getStats().doubleTalkFrames;
  feedScript(vad, [{ label: 'speech', durationMs: 100, amplitude: 0.25 }], { echo: true });
  assert.ok(vad.getStats().doubleTalkFrames > before, 'echo on top of speech counts as double-talk');
});

test('vad v11: short burst is a backchannel, too-short burst is a false start', () => {
  const events = [];
  const vad = createVadV11({}, (e) => events.push(e));
  calibrate(vad);
  feedScript(vad, [{ label: 'speech', durationMs: 200, amplitude: 0.25 }]);
  assert.equal(vad.isSpeaking(), true);
  for (let i = 0; i < 40; i++) vad.feed(SILENCE);
  assert.equal(events.filter((e) => e.kind === 'backchannel').length, 1);
  assert.equal(events.filter((e) => e.kind === 'speech-end').length, 0);

  const events2 = [];
  const vad2 = createVadV11({ minBackchannelMs: 200, minSpeechMs: 120 }, (e) => events2.push(e));
  calibrate(vad2);
  feedScript(vad2, [{ label: 'speech', durationMs: 160, amplitude: 0.25 }]);
  assert.equal(vad2.isSpeaking(), true);
  for (let i = 0; i < 40; i++) vad2.feed(SILENCE);
  assert.equal(events2.filter((e) => e.kind === 'false-start').length, 1);
  assert.equal(vad2.getStats().falseStarts, 1);
});

test('vad v11: a short pause merges into the same turn', () => {
  const events = [];
  const vad = createVadV11({ mergePauseMs: 400 }, (e) => events.push(e));
  calibrate(vad);
  feedScript(vad, [{ label: 'speech', durationMs: 600, amplitude: 0.25 }]);
  assert.equal(vad.isSpeaking(), true);
  // Hangover (400 ms) + 100 ms of extra silence, then speech again.
  for (let i = 0; i < 25; i++) vad.feed(SILENCE);
  assert.equal(vad.isSpeaking(), false);
  assert.equal(events.filter((e) => e.kind === 'speech-end').length, 0, 'end is held for the merge window');
  feedScript(vad, [{ label: 'speech', durationMs: 600, amplitude: 0.25 }]);
  assert.equal(vad.isSpeaking(), true);
  assert.equal(events.filter((e) => e.kind === 'turn-merged').length, 1);
  assert.equal(events.filter((e) => e.kind === 'speech-start').length, 1, 'still one turn');
  assert.equal(vad.getStats().turns, 1);
  assert.equal(vad.getStats().mergedPauses, 1);
  // A long silence closes the turn for real (hangover + merge window).
  for (let i = 0; i < 50; i++) vad.feed(SILENCE);
  assert.equal(events.filter((e) => e.kind === 'speech-end').length, 1);
});

test('vad v11: max-turn force-ends a runaway turn, reset re-runs calibration', () => {
  const events = [];
  const vad = createVadV11({ maxTurnMs: 1000 }, (e) => events.push(e));
  calibrate(vad);
  // 1100 ms crosses the 1000 ms cap, but leaves too little speech
  // after the forced end to open a new turn (needs 120 ms).
  feedScript(vad, [{ label: 'speech', durationMs: 1100, amplitude: 0.25 }]);
  assert.equal(events.filter((e) => e.kind === 'max-turn').length, 1);
  assert.equal(vad.isSpeaking(), false);
  assert.equal(vad.getStats().maxTurns, 1);
  vad.reset();
  assert.equal(vad.isCalibrated(), false);
  assert.equal(vad.getStats().turns, 0);
  const next = vad.reconfigure({ preset: 'noisy' });
  assert.equal(next.preset, 'noisy');
  assert.equal(next.startThreshold, VAD_V11_PRESETS.noisy.startThreshold);
});

// ---------------------------------------------------------------------------
// 3. Barge-in v11
// ---------------------------------------------------------------------------

test('barge-in v11: guarded state machine, legal and illegal moves', () => {
  const transitions = [];
  const c = new BargeInV11Controller({}, (e) => {
    if (e.kind === 'transition') transitions.push(e.transition);
  });
  assert.equal(c.getState(), 'idle');
  assert.equal(c.transitionTo('speaking', 'test', 0), false, 'idle -> speaking is illegal');
  assert.equal(c.getStats().illegalTransitions, 1);
  assert.equal(c.getState(), 'idle');
  assert.equal(c.startListening(0), true);
  assert.equal(c.getState(), 'listening');
  assert.equal(c.beginThinking(10), true);
  assert.equal(c.beginSpeaking(splitWordsV11('hello world this is a test', 1000), 20), true);
  assert.equal(c.getState(), 'speaking');
  assert.equal(c.duck(30), true);
  assert.equal(c.getState(), 'ducked');
  assert.equal(c.resume(40), true);
  assert.equal(c.getState(), 'speaking');
  assert.ok(transitions.filter((t) => t.ok).length >= 5, `ok transitions ${transitions.filter((t) => t.ok).length}`);
  assert.equal(transitions.filter((t) => !t.ok).length, 1, 'the illegal idle -> speaking move is logged once');
  assert.equal(c.getLastTransition().to, 'speaking');
  assert.equal(c.finishSpeaking(50), true);
  assert.equal(c.getState(), 'listening');
  assert.equal(c.endCall(60), true);
  assert.equal(c.getState(), 'idle');
  assert.equal(BARGE_IN_V11_TRANSITIONS.idle.includes('listening'), true);
  assert.equal(isBargeInV11State('ducked'), true);
  assert.equal(isBargeInV11State('loud'), false);
});

test('barge-in v11: policies immediate / grace / confirm / smart', () => {
  const words = splitWordsV11('one two three four five six', 1200);
  // immediate cuts at once.
  const imm = new BargeInV11Controller({ policy: 'immediate' });
  imm.startListening(0);
  imm.beginThinking(0);
  imm.beginSpeaking(words, 0);
  imm.advancePlayed(400);
  const d1 = imm.decideSpeechStart({ nowMs: 100, speechMs: 200, confidence: 0.9 });
  assert.equal(d1.interrupt, true);
  assert.equal(d1.reason, 'speech-confirmed');
  const r1 = imm.interrupt(250);
  assert.equal(r1.interrupted, true);
  assert.equal(r1.cutWord, 'three');
  assert.deepEqual(r1.wordsPlayed, ['one', 'two']);
  assert.ok(r1.playedMs >= 400 && r1.playedMs <= 600, `playedMs ${r1.playedMs}`);
  assert.ok(r1.discardedMs > 0);
  assert.equal(r1.latencyMs, 150, 'interrupt at 250 - speech start at 100');

  // grace waits, then cuts.
  const grace = new BargeInV11Controller({ policy: 'grace', graceMs: 300 });
  grace.startListening(0);
  grace.beginThinking(0);
  grace.beginSpeaking(words, 0);
  const g1 = grace.decideSpeechStart({ nowMs: 0, speechMs: 200, confidence: 0.9 });
  assert.equal(g1.interrupt, false);
  assert.equal(g1.graceRemainingMs, 300);
  const g2 = grace.decideSpeechStart({ nowMs: 300, speechMs: 500, confidence: 0.9 });
  assert.equal(g2.interrupt, true);
  assert.equal(g2.reason, 'grace-expired');

  // confirm never cuts on speech alone.
  const confirm = new BargeInV11Controller({ policy: 'confirm' });
  confirm.startListening(0);
  confirm.beginThinking(0);
  confirm.beginSpeaking(words, 0);
  const cf = confirm.decideSpeechStart({ nowMs: 0, speechMs: 500, confidence: 1 });
  assert.equal(cf.interrupt, false);
  assert.equal(cf.reason, 'policy-confirm');

  // smart: confident + long cuts, confident + short ducks, low confidence ignored.
  const smart = new BargeInV11Controller({ policy: 'smart' });
  smart.startListening(0);
  smart.beginThinking(0);
  smart.beginSpeaking(words, 0);
  const s1 = smart.decideSpeechStart({ nowMs: 0, speechMs: 150, confidence: 0.95 });
  assert.equal(s1.interrupt, false);
  assert.equal(s1.duck, true);
  assert.equal(s1.reason, 'smart-duck');
  const s2 = smart.decideSpeechStart({ nowMs: 100, speechMs: 250, confidence: 0.95 });
  assert.equal(s2.interrupt, true);
  assert.equal(s2.reason, 'smart-confirmed');
  const s3 = smart.decideSpeechStart({ nowMs: 200, speechMs: 250, confidence: 0.3 });
  assert.equal(s3.interrupt, false);
  assert.equal(s3.reason, 'ignored-low-confidence');
  const s4 = smart.decideSpeechStart({ nowMs: 300, speechMs: 50, confidence: 0.95 });
  assert.equal(s4.reason, 'ignored-too-short');
  const s5 = smart.decideSpeechStart({ nowMs: 400, speechMs: 250, confidence: 0.95, echoOnly: true });
  assert.equal(s5.reason, 'ignored-echo');
  assert.throws(() => validateBargeInV11Options({ policy: 'loud' }), /policy/);
  assert.equal(isBargeInV11Policy('smart'), true);
  assert.equal(defaultBargeInV11Options().policy, 'smart');
});

test('barge-in v11: interrupt while thinking, cooldown via tick, summary', () => {
  const c = new BargeInV11Controller({ policy: 'immediate', cooldownMs: 1500 });
  c.startListening(0);
  c.beginThinking(0);
  const r = c.interrupt(50);
  assert.equal(r.interrupted, true);
  assert.equal(r.wasThinking, true);
  assert.equal(r.cutWord, '');
  assert.equal(c.getState(), 'interrupted');
  assert.equal(c.tick(60), 'cooldown');
  assert.equal(c.tick(1000), 'cooldown', 'cooldown has not expired yet');
  assert.equal(c.tick(2000), 'listening');
  // A second speech-start inside the cooldown is ignored.
  const c2 = new BargeInV11Controller({ policy: 'immediate', cooldownMs: 1500 });
  c2.startListening(0);
  c2.beginThinking(0);
  c2.beginSpeaking(splitWordsV11('a b c d e f', 1200), 0);
  c2.noteSpeechStarted(0);
  c2.interrupt(100);
  c2.tick(110);
  c2.startListening(120);
  c2.beginThinking(130);
  c2.beginSpeaking(splitWordsV11('a b c d e f', 1200), 140);
  const d = c2.decideSpeechStart({ nowMs: 200, speechMs: 300, confidence: 1 });
  assert.equal(d.reason, 'ignored-cooldown');
  assert.ok((d.cooldownRemainingMs ?? 0) > 0);
  const stats = c2.getStats();
  assert.equal(stats.interrupts, 1);
  assert.equal(stats.ignoredCooldown, 1);
  assert.ok(stats.meanLatencyMs !== null);
  assert.ok(bargeInV11Summary(stats).includes('1 interrupts'));
  assert.ok(bargeInV11Markdown(stats).includes('## Barge-in v11'));
});

// ---------------------------------------------------------------------------
// 4. Turn-taking v11
// ---------------------------------------------------------------------------

test('turn-taking v11: floor hand-offs, overlap, resolution', () => {
  const events = [];
  const m = new TurnTakingManagerV11({}, (e) => events.push(e));
  m.start(0);
  assert.equal(m.getFloor(), 'idle');
  const u = m.beginUserTurn(100);
  assert.equal(m.getFloor(), 'user');
  assert.equal(u.speaker, 'user');
  const closed = m.endUserTurn(600, 'speech-end');
  assert.equal(closed.durationMs, 500);
  assert.equal(m.getFloor(), 'idle');
  assert.equal(m.beginThinking(700), true);
  assert.equal(m.getFloor(), 'thinking');
  const a = m.beginAgentTurn(800);
  assert.equal(a.speaker, 'agent');
  assert.equal(m.getFloor(), 'agent');
  // User starts while the agent speaks: overlap.
  const overlapTurn = m.beginUserTurn(1500);
  assert.equal(overlapTurn, null);
  assert.equal(m.getFloor(), 'overlap');
  assert.equal(m.getStats(1500).overlaps, 1);
  assert.equal(events.filter((e) => e.kind === 'overlap').length, 1);
  // Resolve in the user's favour: agent turn closed as barged-in.
  const resolved = m.resolveOverlap('user', 1600);
  assert.equal(resolved.speaker, 'user');
  assert.equal(m.getFloor(), 'user');
  const history = m.getHistory();
  assert.equal(history.length, 2, 'user turn #1 + agent turn closed by the overlap');
  assert.equal(history[1].endedBy, 'barge-in');
  m.endUserTurn(2000, 'speech-end');
  const stats = m.getStats(2000);
  assert.equal(stats.turns, 3);
  assert.equal(stats.userTurns, 2);
  assert.equal(stats.agentTurns, 1);
  assert.ok(stats.meanSwitchMs >= 0);
  assert.ok(turnTakingV11Summary(stats).includes('floor=idle'));
  assert.ok(turnTakingV11Markdown(stats).includes('## Turn-taking v11'));
});

test('turn-taking v11: silence timeout nudges then call-idle, max-turn timeout, yield hint', () => {
  const events = [];
  const m = new TurnTakingManagerV11({ silenceTimeoutMs: 8000, maxNudges: 2 }, (e) => events.push(e));
  m.start(0);
  m.tick(7999);
  assert.equal(events.filter((e) => e.kind === 'silence-timeout').length, 0);
  m.tick(8000);
  assert.equal(events.filter((e) => e.kind === 'silence-timeout').length, 1);
  assert.equal(events.filter((e) => e.kind === 'nudge').length, 1);
  m.tick(16000);
  assert.equal(events.filter((e) => e.kind === 'nudge').length, 2);
  m.tick(24000);
  assert.equal(events.filter((e) => e.kind === 'call-idle').length, 1);
  assert.equal(m.getStats(24000).silenceTimeouts, 2);
  assert.equal(m.getStats(24000).nudges, 2);

  const m2 = new TurnTakingManagerV11({ maxUserTurnMs: 1000 }, (e) => events.push(e));
  m2.start(0);
  m2.beginUserTurn(100);
  m2.tick(1100);
  assert.ok(events.some((e) => e.kind === 'turn-timeout' && e.speaker === 'user'));
  assert.equal(m2.getFloor(), 'idle');

  const m3 = new TurnTakingManagerV11({ yieldFrames: 3 });
  m3.start(0);
  m3.beginAgentTurn(0);
  for (const rms of [0.3, 0.25, 0.2, 0.15]) m3.noteEnergy(rms, 0);
  assert.equal(m3.isYieldLikely(), true);
  assert.throws(() => validateTurnTakingV11Options({ silenceTimeoutMs: 10 }), /silenceTimeoutMs/);
  assert.equal(defaultTurnTakingV11Options().maxNudges, 2);
});

// ---------------------------------------------------------------------------
// 5. TTS stream v11
// ---------------------------------------------------------------------------

test('tts stream v11: chunking, accumulation, abbreviation, final flush', () => {
  const split = splitTtsStreamChunks('Xin chào bạn. Hôm nay trời đẹp.', { minChunkChars: 8, maxChunkChars: 160 });
  assert.deepEqual(split.chunks, ['Xin chào bạn.', 'Hôm nay trời đẹp.']);
  assert.equal(split.leftover, '');
  const incomplete = splitTtsStreamChunks('Xin chào', { minChunkChars: 8, maxChunkChars: 160 });
  assert.deepEqual(incomplete.chunks, []);
  assert.equal(incomplete.leftover, 'Xin chào');
  const abbr = splitTtsStreamChunks('Dr. Smith đến rồi. Chào bạn nhé.', { minChunkChars: 8, maxChunkChars: 160 });
  assert.deepEqual(abbr.chunks, ['Dr. Smith đến rồi.', 'Chào bạn nhé.']);
  // 'Ừ. Vâng.' is exactly 8 chars, so it closes a chunk on its own.
  const short = splitTtsStreamChunks('Ừ. Vâng. Chào bạn nhé.', { minChunkChars: 8, maxChunkChars: 160 });
  assert.deepEqual(short.chunks, ['Ừ. Vâng.', 'Chào bạn nhé.']);
  // Shorter still: two 2-char sentences accumulate into the next one.
  const shorter = splitTtsStreamChunks('Ừ. Ừ. Chào bạn nhé.', { minChunkChars: 8, maxChunkChars: 160 });
  assert.deepEqual(shorter.chunks, ['Ừ. Ừ. Chào bạn nhé.']);
  const long = splitTtsStreamChunks(
    'Đây là một câu rất dài, có nhiều mệnh đề, kéo dài mãi, vượt quá giới hạn chunk cho phép. Hết.',
    { minChunkChars: 8, maxChunkChars: 40 },
  );
  assert.ok(long.chunks.length >= 2, `long splits: ${JSON.stringify(long.chunks)}`);
  assert.ok(long.chunks.every((c) => c.length <= 45));
});

test('tts stream v11: deltas stream in, playback drains on the virtual clock', () => {
  const events = [];
  const stream = createTtsStreamV11({}, (e) => events.push(e));
  assert.equal(stream.isDrained(), true);
  const r1 = stream.feedTextDelta('Xin chào');
  assert.equal(r1.chunksReady, 0);
  assert.equal(r1.bufferedChars, 8);
  const r2 = stream.feedTextDelta(' bạn. Hôm nay trời đẹp.');
  assert.equal(r2.chunksReady, 2);
  assert.equal(r2.bufferedChars, 0);
  const stats0 = stream.getStats();
  assert.equal(stats0.chunks, 2);
  assert.equal(stats0.firstChunkLatencyMs, 0);
  stream.tick(800);
  assert.equal(stream.getStats().chunksDone, 1, 'first chunk (36 frames) drained in 800 ms');
  assert.equal(stream.isPlaying(), true);
  stream.tick(5000);
  assert.equal(stream.isDrained(), true);
  assert.equal(stream.getStats().chunksDone, 2);
  assert.ok(stream.getStats().playedMs >= 1600, `playedMs ${stream.getStats().playedMs}`);
  assert.ok(events.some((e) => e.kind === 'drained'));
  assert.ok(ttsStreamV11Summary(stream.getStats()).includes('2 chunks'));
  assert.ok(ttsStreamV11Markdown(stream.getStats()).includes('## TTS stream v11'));
  // Final flush speaks a tail without a terminator.
  const r3 = stream.feedTextDelta(' Tạm biệt', { final: true });
  assert.equal(r3.chunksReady, 1);
  assert.equal(stream.getStats().chunks, 3);
  stream.tick(5000);
  assert.equal(stream.isDrained(), true);
  assert.throws(() => validateTtsStreamV11Options({ minChunkChars: 10, maxChunkChars: 5 }), /maxChunkChars/);
  assert.equal(defaultTtsStreamV11Options().msPerChar, 55);
});

test('tts stream v11: mock synth is deterministic, pause/resume, cancel receipt', () => {
  const synth = mockTtsSynthV11(55);
  const f1 = synth('Xin chào bạn.', { chunkId: 1, atMs: 0 });
  const f2 = synth('Xin chào bạn.', { chunkId: 1, atMs: 0 });
  assert.deepEqual(f1.map((f) => [...f]), f2.map((f) => [...f]));
  assert.ok(f1.length >= 30, `frames ${f1.length}`);
  assert.notDeepEqual(
    synth('Xin chào bạn.', { chunkId: 1, atMs: 0 }).map((f) => [...f]),
    synth('Tạm biệt nhé.', { chunkId: 2, atMs: 0 }).map((f) => [...f]),
  );

  const stream = createTtsStreamV11({});
  stream.feedTextDelta('Câu thứ nhất rất hay. Câu thứ hai cũng hay. Câu thứ ba nữa.', { final: true });
  assert.equal(stream.getStats().chunks, 3);
  stream.tick(100);
  assert.equal(stream.isPlaying(), true);
  assert.equal(stream.pause(), true);
  const playedBefore = stream.getStats().playedMs;
  stream.tick(1000);
  assert.equal(stream.getStats().playedMs, playedBefore, 'paused playback does not advance');
  assert.equal(stream.resume(), true);
  const cancelled = stream.cancelPending();
  assert.equal(cancelled.cutPlaying, true);
  assert.ok(cancelled.chunksCancelled >= 2, `chunksCancelled ${cancelled.chunksCancelled}`);
  assert.ok(cancelled.charsDiscarded > 0);
  assert.ok(cancelled.playedMs >= 0 && cancelled.playedMs <= 200);
  assert.equal(stream.getStats().chunksCancelled, cancelled.chunksCancelled);
  assert.equal(stream.isDrained(), true);
  const idle = stream.cancelPending();
  assert.equal(idle.cancelled, false);
});

// ---------------------------------------------------------------------------
// 6. Session v11
// ---------------------------------------------------------------------------

test('session v11: connect, user turn, auto mock reply, drain back to listening', async () => {
  const events = [];
  const session = createMockVoiceSessionV11({ sessionId: 's1', language: 'vi' }, (e) => events.push(e));
  await session.connect();
  assert.equal(session.getStatus(), 'listening');
  feedSessionScript(session, [{ label: 'silence', durationMs: 600 }]);
  assert.equal(session.getVad().isCalibrated(), true);
  feedSessionScript(session, [{ label: 'speech', durationMs: 600, amplitude: 0.25 }]);
  assert.equal(session.getTurnTaking().getFloor(), 'user');
  feedSessionScript(session, [{ label: 'silence', durationMs: 1200 }]);
  // Speech-end flushed after the merge window → auto mock reply.
  assert.equal(session.getStatus(), 'speaking');
  assert.equal(session.getStats().replies, 1);
  assert.ok(session.getStats().tts.chunks >= 1, 'reply chunked into the TTS stream');
  assert.ok(events.some((e) => e.kind === 'reply-started'));
  session.tick(8000);
  assert.equal(session.getStatus(), 'listening');
  assert.equal(session.getStats().agentTurns, 1);
  assert.equal(session.getStats().userTurns, 1);
  assert.ok(session.getSummary().includes('listening'));
  assert.ok(voiceSessionV11Summary(session.getStats()).includes('s1'));
  assert.ok(voiceSessionV11Markdown(session.getStats()).includes('# Voice session v11'));
  session.disconnect();
  assert.equal(session.getStatus(), 'closed');
  assert.throws(() => new RealtimeVoiceSessionV11({ sessionId: 'bad id!' }), /slug/);
});

test('session v11: barge-in over real audio cuts the reply and returns to listening', async () => {
  const session = createMockVoiceSessionV11(
    { sessionId: 's2', mockReplies: ['Hello mock reply one two three four five six seven eight.'] },
    null,
  );
  await session.connect();
  feedSessionScript(session, [{ label: 'silence', durationMs: 600 }]);
  const started = await session.simulateTurn('xin chào', 'Hello mock reply one two three four five six seven eight.');
  assert.equal(started, true);
  assert.equal(session.getStatus(), 'speaking');
  assert.ok(session.getStats().tts.chunks >= 1);
  session.tick(300);
  assert.equal(session.getStatus(), 'speaking');
  // The user barges in: keep talking until the smart policy cuts.
  feedSessionScript(session, [{ label: 'speech', durationMs: 800, amplitude: 0.25 }]);
  const stats = session.getStats();
  assert.equal(stats.repliesCut, 1, `repliesCut ${stats.repliesCut}, state ${stats.state}`);
  assert.ok(stats.bargeIn.interrupts >= 1);
  assert.ok(stats.tts.chunksCancelled >= 1, 'queued TTS chunks cancelled');
  const cut = session.getLastCut();
  assert.ok(cut !== null);
  assert.ok(cut.bargeIn.cutWord.length > 0, `cut word "${cut.bargeIn.cutWord}"`);
  assert.ok(cut.bargeIn.latencyMs !== null && cut.bargeIn.latencyMs >= 0);
  assert.ok(cut.tts.charsDiscarded > 0);
  // Cooldown returns the machine to listening.
  session.tick(3000);
  assert.equal(session.getStatus(), 'listening');
  // The user can talk again afterwards.
  feedSessionScript(session, [{ label: 'speech', durationMs: 600, amplitude: 0.25 }]);
  feedSessionScript(session, [{ label: 'silence', durationMs: 1200 }]);
  assert.equal(session.getStatus(), 'speaking', 'auto reply after the second turn');
  session.disconnect();
});

test('session v11: explicit interrupt, duck/resume, vad preset switch, manager registry', async () => {
  const manager = new VoiceV11Manager();
  const session = manager.create({ sessionId: 'm1', connectNow: false });
  assert.equal(manager.size(), 1);
  assert.equal(manager.get('m1'), session);
  assert.deepEqual(manager.ids(), ['m1']);
  assert.throws(() => manager.create({ sessionId: 'm1' }), /already exists/);
  await session.connect();
  assert.equal(session.interrupt(), null, 'nothing to interrupt while listening');
  await session.simulateTurn('hi', 'One two three four five six seven eight nine ten.');
  assert.equal(session.getStatus(), 'speaking');
  assert.equal(session.duck(), true);
  assert.equal(session.getStatus(), 'ducked');
  assert.equal(session.resumePlayback(), true);
  assert.equal(session.getStatus(), 'speaking');
  const result = session.interrupt('user');
  assert.ok(result !== null && result.interrupted);
  assert.equal(session.getStatus(), 'interrupted');
  session.tick(3000);
  assert.equal(session.getStatus(), 'listening');
  const vadOpts = session.setVadPreset('noisy');
  assert.equal(vadOpts.preset, 'noisy');
  assert.throws(() => session.setVadPreset('cafe'), /preset/);
  assert.equal(session.pauseTts(), true);
  assert.equal(session.resumeTts(), true);
  assert.equal(manager.remove('m1'), true);
  assert.equal(manager.size(), 0);
  assert.equal(manager.remove('m1'), false);
});

// ---------------------------------------------------------------------------
// 7. Session v11 store
// ---------------------------------------------------------------------------

test('session v11 store: snapshot round-trip, checksum, quarantine, prune', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-v11-store-'));
  try {
    const session = createMockVoiceSessionV11({ sessionId: 'store1', language: 'vi' });
    await session.connect();
    await session.simulateTurn('xin chào', 'Hello one two three four five.');
    session.tick(5000);
    const stats = session.getStats();
    const snapshot = createVoiceSessionV11Snapshot({
      sessionId: 'store1',
      botId: 'default',
      language: 'vi',
      voice: '',
      status: session.getStatus(),
      savedAtMs: Date.now(),
      connectedMs: stats.nowMs,
      turns: session.getTurnTaking().getHistory(),
      cutPoint: session.getLastCut(),
      stats: {
        userTurns: stats.userTurns,
        agentTurns: stats.agentTurns,
        interrupts: stats.interrupts,
        ducks: stats.ducks,
        replies: stats.replies,
        repliesCut: stats.repliesCut,
        ttsChunks: stats.tts.chunks,
        ttsChunksDone: stats.tts.chunksDone,
        ttsChunksCancelled: stats.tts.chunksCancelled,
        overlaps: stats.turnTaking.overlaps,
        meanSwitchMs: stats.turnTaking.meanSwitchMs,
        meanBargeInLatencyMs: stats.bargeIn.meanLatencyMs,
      },
      vadPreset: 'office',
      bargeInPolicy: 'smart',
      ttsMsPerChar: 55,
    });
    const store = new VoiceSessionV11Store(dir);
    const saved = store.save(snapshot);
    assert.equal(saved.ok, true);
    assert.equal(saved.path, voiceSessionV11SnapshotPath(dir, 'store1'));
    const loaded = store.load('store1');
    assert.equal(loaded.ok, true);
    assert.equal(loaded.snapshot.sessionId, 'store1');
    assert.deepEqual(loaded.snapshot.turns, snapshot.turns);
    assert.deepEqual(store.list(), ['store1']);
    assert.ok(buildVoiceSessionV11ResumeInstructions(loaded.snapshot).includes('store1'));
    assert.ok(voiceSessionV11SnapshotMarkdown(loaded.snapshot).includes('## Voice v11 snapshot store1'));
    // Tamper with the file: checksum must fail and the file quarantined.
    const file = voiceSessionV11SnapshotPath(dir, 'store1');
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    raw.stats.replies = 999;
    fs.writeFileSync(file, JSON.stringify(raw), 'utf-8');
    const bad = store.load('store1');
    assert.equal(bad.ok, false);
    assert.ok(fs.existsSync(`${file}.corrupt`), 'corrupt file quarantined');
    assert.equal(validateVoiceSessionV11Snapshot({ version: 99 }).ok, false);
    // Prune keeps the newest files.
    for (let i = 0; i < 3; i++) {
      const s = createVoiceSessionV11Snapshot({
        ...snapshot,
        sessionId: `store-p${i}`,
        stats: { ...snapshot.stats },
        turns: [],
        cutPoint: null,
      });
      store.save(s);
    }
    const pruned = store.prune(2);
    assert.equal(pruned.kept, 2);
    assert.equal(pruned.removed, 1);
    const kept = store.list();
    assert.equal(kept.length, 2);
    assert.equal(store.delete(kept[0]), true);
    session.disconnect();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 8. Voice v11 tools
// ---------------------------------------------------------------------------

test('voice v11 tools: placeholder refuses, lifecycle through bound tools', async () => {
  assert.equal(VOICE_V11_TOOLS.length, 8);
  assert.deepEqual([...VOICE_V11_TOOL_NAMES], [
    'voice_v11_session_create',
    'voice_v11_session_list',
    'voice_v11_session_stats',
    'voice_v11_session_stop',
    'voice_v11_session_delete',
    'voice_v11_feed_text',
    'voice_v11_interrupt',
    'voice_v11_vad',
  ]);
  assert.equal(isVoiceV11ToolName('voice_v11_vad'), true);
  assert.equal(isVoiceV11ToolName('voice_v10_vad'), false);
  const placeholder = createVoiceV11Tools();
  const refused = await placeholder[0].execute({ sessionId: 'x' });
  assert.ok(refused.startsWith('Error:'), refused);

  const manager = new VoiceV11Manager();
  const tools = createVoiceV11Tools({ getManager: () => manager });
  const byName = Object.fromEntries(tools.map((t) => [t.definition.name, t]));
  const run = async (name, args) => JSON.parse(await byName[name].execute(args));

  const created = await run('voice_v11_session_create', { sessionId: 't1', language: 'vi', connect: true });
  assert.equal(created.created, true);
  assert.ok(created.summary.includes('listening'));
  const badPreset = await byName['voice_v11_session_create'].execute({ sessionId: 't2', vadPreset: 'cafe' });
  assert.ok(badPreset.startsWith('Error:'), badPreset);
  const badPolicy = await byName['voice_v11_session_create'].execute({ sessionId: 't2', bargeInPolicy: 'loud' });
  assert.ok(badPolicy.startsWith('Error:'), badPolicy);

  const fed = await run('voice_v11_feed_text', { sessionId: 't1', replyText: 'Xin chào bạn. Hôm nay trời đẹp.' });
  assert.equal(fed.replyStarted, true);
  const listed = await run('voice_v11_session_list', {});
  assert.equal(listed.count, 1);
  assert.equal(listed.sessions[0].status, 'speaking');
  const interrupted = await run('voice_v11_interrupt', { sessionId: 't1' });
  assert.equal(interrupted.interrupted, true);
  assert.ok(interrupted.cutWord.length > 0);
  const vad = await run('voice_v11_vad', { sessionId: 't1' });
  assert.ok(typeof vad.vad === 'object');
  const switched = await run('voice_v11_vad', { sessionId: 't1', preset: 'noisy' });
  assert.equal(switched.preset, 'noisy');
  const vadBad = await byName['voice_v11_vad'].execute({ sessionId: 't1', preset: 'cafe' });
  assert.ok(vadBad.startsWith('Error:'), vadBad);
  const missing = await byName['voice_v11_session_stats'].execute({ sessionId: 'nope' });
  assert.ok(missing.startsWith('Error:'), missing);
  const stopped = await run('voice_v11_session_stop', { sessionId: 't1' });
  assert.equal(stopped.stopped, true);
  assert.equal(stopped.status, 'closed');
  const deleted = await run('voice_v11_session_delete', { sessionId: 't1' });
  assert.equal(deleted.deleted, true);
  assert.equal(deleted.remaining, 0);
});

test('voice v11 tools: ALL_TOOLS holds all 8 v11 tools, no duplicate names', () => {
  for (const name of VOICE_V11_TOOL_NAMES) {
    assert.ok(ALL_TOOLS.some((t) => t.definition.name === name), `ALL_TOOLS holds ${name}`);
  }
  assert.ok(ALL_TOOLS.length >= 367, `ALL_TOOLS ${ALL_TOOLS.length} (359 v1.11 + 8 v11)`);
  const names = ALL_TOOLS.map((t) => t.definition.name);
  assert.equal(new Set(names).size, names.length, 'no duplicate tool names');
  // Bound tools replace the placeholders in place (same 8 names).
  const manager = new VoiceV11Manager();
  const bound = createDefaultTools({ getVoiceV11Manager: () => manager });
  assert.equal(bound.length, ALL_TOOLS.length);
  assert.equal(bound.filter((t) => isVoiceV11ToolName(t.definition.name)).length, 8);
});

// ---------------------------------------------------------------------------
// 9. Renderer view models
// ---------------------------------------------------------------------------

test('voice v11 view: rows, VAD bands, barge-in receipt, turns, TTS chunks', () => {
  assert.equal(parseVoiceV11Status('ducked'), 'ducked');
  assert.equal(parseVoiceV11Status('loud'), 'idle');
  assert.equal(parseVoiceV11Floor('overlap'), 'overlap');
  assert.equal(parseVoiceV11Floor('x'), 'idle');
  assert.equal(parseVoiceV11BargeInPolicy('grace'), 'grace');
  assert.equal(parseVoiceV11BargeInPolicy('loud'), 'smart');
  assert.equal(voiceV11StatusKey('cooldown'), 'voice.v11.status.cooldown');

  const row = parseVoiceSessionV11Row({
    sessionId: 'v1',
    state: 'speaking',
    nowMs: 5000,
    connected: true,
    stats: {
      turns: 3, userTurns: 2, agentTurns: 1, interrupts: 1, ducks: 1, replies: 2, repliesCut: 1,
      turnTaking: { floor: 'agent', overlaps: 1 },
      vad: { probability: 0.82 },
    },
  });
  assert.equal(row.id, 'v1');
  assert.equal(row.status, 'speaking');
  assert.equal(row.floor, 'agent');
  assert.equal(row.turns, 3);
  assert.equal(row.probability, 0.82);
  assert.deepEqual(parseVoiceSessionV11Row(null).status, 'idle');
  const lines = voiceV11SummaryLines(row);
  assert.equal(lines.length, 3);
  assert.ok(lines[0].includes('3'));

  const vad = voiceV11VadView({ probability: 0.82, speaking: true, turns: 2, calibrated: true, lowFloor: 0.015, speechMs: 1200 }, 'office');
  assert.equal(vad.probabilityPct, 82);
  assert.equal(vad.probabilityBand, 'speech');
  assert.equal(voiceV11VadView({ probability: 0.5 }).probabilityBand, 'maybe');
  assert.equal(voiceV11VadView({ probability: 0.1 }).probabilityBand, 'silent');

  const bargeIn = voiceV11BargeInView(
    { state: 'cooldown', attempts: 5, interrupts: 1, meanLatencyMs: 210, maxLatencyMs: 210, ducks: 2 },
    { bargeIn: { cutWord: 'three', cutWordIndex: 2, playedMs: 400, discardedMs: 800, wordsPlayed: ['one', 'two'], wordsDiscarded: ['three'], wasThinking: false, latencyMs: 210, atMs: 100 }, tts: { chunksCancelled: 2, charsDiscarded: 40, cutChunkText: 'Hello world.' } },
    'smart',
  );
  assert.equal(bargeIn.policy, 'smart');
  assert.equal(bargeIn.cut.cutWord, 'three');
  assert.equal(bargeIn.cut.ttsChunksCancelled, 2);
  assert.equal(bargeIn.meanLatencyMs, 210);
  assert.equal(voiceV11BargeInView({}, null).cut, null);

  const turns = voiceV11TurnRows([
    { id: 1, speaker: 'user', durationMs: 1200, endedBy: 'speech-end', yieldLikely: false, overlaps: 0 },
    { id: 2, speaker: 'agent', durationMs: 3400, endedBy: 'drained', yieldLikely: true, overlaps: 1 },
  ]);
  assert.equal(turns.length, 2);
  assert.equal(turns[1].label, 'Bot 3.4s');
  assert.deepEqual(voiceV11TurnRows('nope'), []);

  const chunks = voiceV11TtsChunkRows([
    { id: 1, text: 'Xin chào bạn.', status: 'done', frames: new Array(36), playedFrames: 36, estDurationMs: 715 },
    { id: 2, text: 'Hôm nay trời đẹp.', status: 'playing', frames: new Array(50), playedFrames: 10, estDurationMs: 990 },
  ]);
  assert.equal(chunks[0].progress, 1);
  assert.equal(chunks[1].progress, 0.2);
  assert.equal(chunks[1].playedMs, 200);
  assert.equal(chunks[1].shortText, 'Hôm nay trời đẹp.');

  const tt = voiceV11TurnTakingView({ floor: 'user', turns: 2, overlaps: 1, meanSwitchMs: 120, p95SwitchMs: 300 });
  assert.equal(tt.floor, 'user');
  assert.equal(tt.p95SwitchMs, 300);
  const tts = voiceV11TtsView({ chunks: 3, chunksDone: 2, playedMs: 1500, drained: false });
  assert.equal(tts.chunksDone, 2);
  assert.equal(tts.drained, false);
});

// ---------------------------------------------------------------------------
// 10. i18n
// ---------------------------------------------------------------------------

test('i18n v11: 30 keys in all 6 locales, non-empty, same key set', () => {
  const locales = ['vi', 'en', 'zh', 'ja', 'es', 'fr'];
  const sets = [];
  for (const locale of locales) {
    const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps/desktop/src/renderer/i18n/locales', `${locale}.json`), 'utf-8'));
    assert.ok(Object.keys(data).length >= 4818, `${locale} has ${Object.keys(data).length} keys`);
    const v11 = Object.keys(data).filter((k) => k.startsWith('voice.realtime.v11.'));
    assert.equal(v11.length, 30, `${locale} v11 keys: ${v11.length}`);
    for (const key of v11) {
      assert.equal(typeof data[key], 'string', `${locale}:${key}`);
      assert.ok(data[key].length > 0, `${locale}:${key} is empty`);
    }
    sets.push(new Set(v11));
  }
  for (let i = 1; i < sets.length; i++) {
    assert.deepEqual([...sets[i]].sort(), [...sets[0]].sort(), `locale ${locales[i]} v11 key set differs`);
  }
  assert.ok(sets[0].has('voice.realtime.v11.status.cooldown'));
  assert.ok(sets[0].has('voice.realtime.v11.smartPolicy'));
});

// ---------------------------------------------------------------------------
// 11. Core root re-exports
// ---------------------------------------------------------------------------

test('core root: v11 voice API is importable from @open-bot/core', () => {
  assert.equal(typeof RootVadV11, 'function');
  assert.equal(typeof RootBargeInV11, 'function');
  assert.equal(typeof RootTurnTakingV11, 'function');
  assert.equal(typeof RootTtsStreamV11, 'function');
  assert.equal(typeof RootSessionV11, 'function');
  assert.equal(typeof RootStoreV11, 'function');
  const vad = new RootVadV11({ calibrationFrames: 0 });
  assert.equal(vad.isCalibrated(), true);
  const stream = new RootTtsStreamV11({});
  assert.equal(stream.isDrained(), true);
});
