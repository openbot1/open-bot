/**
 * Tests for v1.09 — voice realtime v8 (Team T5).
 *
 *   1. VAD v8 (vadV8.ts): Goertzel spectrum + flatness + per-band
 *      floors, noise classification (hum/fan/white/speech),
 *      dynamic hangover (confident turns end fast), end-of-speech
 *      latency, backchannels, false positives by reason/noise,
 *      calibration, live reconfigure, simple-energy fallback.
 *   2. Barge-in v8 (bargeInV8.ts): AEC-lite (learned echo gain,
 *      echo-only frames rejected), playback queue cancel receipt
 *      (exact words/audio played vs discarded + cut word), duck,
 *      grace + echo windows, cooldown, interrupt while thinking.
 *   3. Store v8 (voiceSessionV8Store.ts): atomic save, checksum
 *      validation + quarantine, version/schema checks, list/prune,
 *      resume instructions with the cut reply, markdown.
 *   4. Session v8 (voiceSessionV8.ts) on the mock transport:
 *      connect → listening, scripted turn, PTT vs auto, interrupt
 *      keeps the cut point + snapshot, drop → reconnectNow with
 *      retry budget restores the snapshot from disk.
 *   5. Voice v8 tools (packages/tools/src/voiceV8Tools.ts): 10
 *      tools, unique names, placeholder refuses, full lifecycle
 *      through the tools on a real manager (mock sessions),
 *      registry: all 10 in defaultToolFactory, total 649.
 *   6. Renderer-local view models (voiceSessionV8View.ts): row
 *      parsing, VAD/barge-in views, waveform bars, PTT view.
 *   7. i18n: 24 voice.v8.* keys in all 6 locales, 4388 keys each (v1.10 merge).
 *
 * No network, no sound card, no live provider. Run after building
 * the core + tools packages:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/voice-v109.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AdaptiveVadV8,
  SimpleEnergyVadV8,
  createVadV8,
  goertzelMagnitude,
  vadV8Spectrum,
  spectralFlatness,
  vadV8BandEnergies,
  classifyVadV8Noise,
  defaultVadV8Options,
  validateVadV8Options,
  isVadV8PresetName,
  isVadV8Engine,
  vadV8Summary,
  VAD_V8_PRESETS,
  VAD_V8_PRESET_NAMES,
} from '../packages/core/dist/voice/vadV8.js';
import {
  BargeInV8Controller,
  PlaybackQueueV8,
  aecResidualFrame,
  splitWordsV8,
  validateBargeInV8Options,
  bargeInV8Summary,
} from '../packages/core/dist/voice/bargeInV8.js';
import {
  VoiceSessionV8Store,
  voiceSessionV8SnapshotPath,
  createVoiceSessionV8Snapshot,
  validateVoiceSessionV8Snapshot,
  buildVoiceSessionV8ResumeInstructions,
  voiceSessionV8SnapshotMarkdown,
  VOICE_SESSION_V8_STORE_VERSION,
} from '../packages/core/dist/voice/voiceSessionV8Store.js';
import {
  VoiceSessionV8,
  VoiceV8Manager,
  createMockVoiceSessionV8,
  VOICE_V8_DEFAULT_MOCK_REPLY,
} from '../packages/core/dist/voice/voiceSessionV8.js';
import {
  createVoiceV8Tools,
  VOICE_V8_TOOLS,
  VOICE_V8_TOOL_NAMES,
  isVoiceV8ToolName,
} from '../packages/tools/dist/voiceV8Tools.js';
import { BotMemory, defaultToolFactory } from '../packages/core/dist/index.js';
import {
  toVoiceSessionV8RowView,
  toVoiceSessionV8RowViews,
  toVoiceV8VadView,
  toVoiceV8BargeInView,
  waveformBars,
  appendWaveformLevel,
  pttView,
  voiceV8StatusLabelKey,
  voiceV8NoiseKindLabelKey,
  voiceV8StatusSummary,
  formatVoiceV8Duration,
  formatVoiceV8AudioMs,
} from '../apps/desktop/src/renderer/voice/voiceSessionV8View.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SAMPLE_RATE = 16000;
const WINDOW_SAMPLES = 320; // 20 ms at 16 kHz

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** PCM16 frame of a sine at `freqHz`, amplitude 0..1 (deterministic). */
function sineFrame(freqHz, amplitude = 0.3, samples = WINDOW_SAMPLES) {
  const buf = new Uint8Array(samples * 2);
  for (let i = 0; i < samples; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * freqHz * i) / SAMPLE_RATE) * amplitude * 32767);
    buf[i * 2] = v & 0xff;
    buf[i * 2 + 1] = (v >> 8) & 0xff;
  }
  return buf;
}

/** Speech-like frame: formant sum (250 + 900 + 1400 Hz) — mid-band energy, in-band ZCR, low flatness. */
function speechFrame(amplitude = 0.3, samples = WINDOW_SAMPLES) {
  const buf = new Uint8Array(samples * 2);
  for (let i = 0; i < samples; i++) {
    const t = i / SAMPLE_RATE;
    const v =
      Math.sin(2 * Math.PI * 250 * t) * 0.5 +
      Math.sin(2 * Math.PI * 900 * t) * 0.35 +
      Math.sin(2 * Math.PI * 1400 * t) * 0.3;
    const s = Math.round(v * amplitude * 32767);
    buf[i * 2] = s & 0xff;
    buf[i * 2 + 1] = (s >> 8) & 0xff;
  }
  return buf;
}

/** PCM16 silence frame. */
function silenceFrame(samples = WINDOW_SAMPLES) {
  return new Uint8Array(samples * 2);
}

/** PCM16 white-noise frame (deterministic LCG, amplitude 0..1). */
function noiseFrame(amplitude = 0.1, samples = WINDOW_SAMPLES, seed = 12345) {
  const buf = new Uint8Array(samples * 2);
  let s = seed;
  for (let i = 0; i < samples; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const v = Math.round(((s / 0x7fffffff) * 2 - 1) * amplitude * 32767);
    buf[i * 2] = v & 0xff;
    buf[i * 2 + 1] = (v >> 8) & 0xff;
  }
  return buf;
}

/** Controllable clock for barge-in tests (ms). */
function fakeClock(start = 1000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms) => {
      now += ms;
    },
  };
}

function collectEvents() {
  const events = [];
  return { events, sink: (e) => events.push(e) };
}

// ---------------------------------------------------------------------------
// 1. VAD v8
// ---------------------------------------------------------------------------

test('v109 vad: presets exist, defaults are office/auto, unknown preset/engine rejected', () => {
  assert.deepEqual([...VAD_V8_PRESET_NAMES], ['quiet', 'office', 'noisy', 'very-noisy']);
  assert.equal(isVadV8PresetName('noisy'), true);
  assert.equal(isVadV8PresetName('loud'), false);
  assert.equal(isVadV8Engine('spectral'), true);
  assert.equal(isVadV8Engine('simple'), true);
  assert.equal(isVadV8Engine('auto'), true);
  assert.equal(isVadV8Engine('neural'), false);
  const def = defaultVadV8Options();
  assert.equal(def.preset, 'office');
  assert.equal(def.engine, 'auto');
  assert.equal(def.threshold, VAD_V8_PRESETS.office.threshold);
  assert.ok(VAD_V8_PRESETS['very-noisy'].threshold > VAD_V8_PRESETS.quiet.threshold);
  assert.ok(VAD_V8_PRESETS['very-noisy'].minConfidence > VAD_V8_PRESETS.quiet.minConfidence);
  const vad = new AdaptiveVadV8({ preset: 'noisy' });
  assert.equal(vad.getConfig().preset, 'noisy');
  assert.equal(vad.getConfig().debounceFrames, 3);
  const back = vad.setPreset('quiet');
  assert.equal(back.preset, 'quiet');
  assert.throws(() => vad.setPreset('loud'), /Unknown VAD v8 preset/);
  assert.deepEqual(validateVadV8Options({}), []);
  assert.ok(validateVadV8Options({ threshold: 99 }).length > 0);
  assert.ok(validateVadV8Options({ minZcr: 0.6, maxZcr: 0.5 }).length > 0);
  assert.throws(() => new AdaptiveVadV8({ threshold: 99 }), /Invalid AdaptiveVadV8/);
});

test('v109 vad: Goertzel finds the tone, flatness separates tone from noise', () => {
  // 440 Hz sine: strong near the 400 Hz bin, weak at 6 kHz.
  const spectrum = vadV8Spectrum(sineFrame(440, 0.3), SAMPLE_RATE);
  assert.equal(spectrum.length, 60, '100 Hz grid from 100 Hz to 6 kHz');
  const mag400 = spectrum[3]; // 400 Hz bin
  const mag6000 = spectrum[59]; // 6 kHz bin
  assert.ok(mag400 > mag6000 * 5, `400Hz bin ${mag400} should dominate 6kHz ${mag6000}`);
  assert.ok(goertzelMagnitude(silenceFrame(), 440, SAMPLE_RATE) < 1e-6);
  assert.ok(spectralFlatness(sineFrame(440, 0.3)) < 0.6, 'tone is not flat');
  assert.ok(spectralFlatness([0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1]) > 0.99, 'equal bins are flat');
  const bands = vadV8BandEnergies(vadV8Spectrum(sineFrame(440, 0.3), SAMPLE_RATE));
  assert.ok(bands.low > bands.high, '440 Hz lives in the low band');
  const speechBands = vadV8BandEnergies(vadV8Spectrum(speechFrame(), SAMPLE_RATE));
  assert.ok(speechBands.mid > 0.002, `speech-like frame needs mid-band energy, got ${speechBands.mid}`);
  // A tone between grid bins still registers (dense grid, no dead zones).
  const offBin = vadV8Spectrum(sineFrame(445, 0.3), SAMPLE_RATE);
  assert.ok(offBin[3] > 0.01, `445 Hz tone must leak into the 400 Hz bin, got ${offBin[3]}`);
});

test('v109 vad: noise classification tells hum, white and speech apart', () => {
  assert.equal(
    classifyVadV8Noise({ rms: 0.2, zcr: 0.006, spectralFlatness: 0.2, bandLow: 0.2, bandMid: 0.01, bandHigh: 0.005, threshold: 0.02 }),
    'hum',
  );
  assert.equal(
    classifyVadV8Noise({ rms: 0.1, zcr: 0.5, spectralFlatness: 0.9, bandLow: 0.05, bandMid: 0.05, bandHigh: 0.05, threshold: 0.02 }),
    'white',
  );
  assert.equal(
    classifyVadV8Noise({ rms: 0.2, zcr: 0.15, spectralFlatness: 0.3, bandLow: 0.05, bandMid: 0.12, bandHigh: 0.02, threshold: 0.02 }),
    'speech',
  );
  assert.equal(
    classifyVadV8Noise({ rms: 0.001, zcr: 0, spectralFlatness: 1, bandLow: 0, bandMid: 0, bandHigh: 0, threshold: 0.02 }),
    'silence',
  );
});

test('v109 vad: speech-like frames open a turn, silence ends it with a fast hangover', () => {
  const { events, sink } = collectEvents();
  const vad = new AdaptiveVadV8({ sink });
  for (let i = 0; i < 12; i++) vad.feed(speechFrame());
  assert.equal(vad.getState(), 'speaking');
  assert.equal(events.filter((e) => e.kind === 'speech-start').length, 1);
  assert.equal(events[0].startedAtMs, 0);
  assert.ok(events[0].peakConfidence >= 0.55, `confidence ${events[0].peakConfidence}`);
  assert.equal(events[0].noiseKind, 'speech');
  const stats = vad.getStats();
  assert.ok(stats.spectralFlatness < 0.75, `flatness ${stats.spectralFlatness}`);
  assert.ok(stats.bandFloors.mid > 0, 'mid-band floor learned');
  for (let i = 0; i < 20; i++) vad.feed(silenceFrame());
  assert.equal(vad.getState(), 'idle');
  const end = events.find((e) => e.kind === 'speech-end');
  assert.ok(end, 'speech-end expected');
  assert.ok(end.durationMs >= 200, `duration ${end.durationMs} should cover the turn`);
  assert.ok(end.hangoverAppliedMs !== undefined && end.hangoverAppliedMs < 700, 'dynamic hangover applied');
  assert.equal(vad.getStats().turns, 1);
  assert.ok(vad.getStats().meanEndLatencyMs !== null && vad.getStats().meanEndLatencyMs > 0);
  assert.match(vadV8Summary(vad.getStats()), /VAD v8 \(auto\/office\) idle/);
});

test('v109 vad: loud white noise and 50 Hz hum never open a turn', () => {
  const { events, sink } = collectEvents();
  const vad = new AdaptiveVadV8({ sink });
  for (let i = 0; i < 20; i++) vad.feed(noiseFrame(0.3));
  assert.equal(vad.getState(), 'idle');
  assert.equal(events.filter((e) => e.kind === 'speech-start').length, 0);
  assert.equal(vad.getStats().turns, 0);
  for (let i = 0; i < 20; i++) vad.feed(sineFrame(50, 0.3));
  assert.equal(vad.getState(), 'idle');
  assert.equal(vad.getStats().turns, 0);
  // The noise kind was seen (not speech) — the panel can show why.
  assert.ok(['fan', 'white', 'hum'].includes(vad.getStats().noiseKind));
});

test('v109 vad: short confident burst is a backchannel, dying burst is a false positive', () => {
  const { events, sink } = collectEvents();
  const vad = new AdaptiveVadV8({ sink });
  for (let i = 0; i < 3; i++) vad.feed(speechFrame());
  for (let i = 0; i < 20; i++) vad.feed(silenceFrame());
  assert.equal(events.filter((e) => e.kind === 'backchannel').length, 1);
  assert.equal(vad.getStats().backchannels, 1);
  assert.equal(vad.getStats().turns, 0);

  const second = collectEvents();
  const vad2 = new AdaptiveVadV8({ sink: second.sink });
  vad2.feed(speechFrame()); // one frame only — dies before debounce
  for (let i = 0; i < 25; i++) vad2.feed(silenceFrame());
  const fp = second.events.find((e) => e.kind === 'false-positive');
  assert.ok(fp, 'false-positive expected for a burst that dies early');
  assert.ok(fp.reason, 'false-positive carries a reason');
  assert.equal(vad2.getStats().falsePositives, 1);
  assert.equal(vad2.getStats().falsePositivesByReason[fp.reason], 1);
});

test('v109 vad: calibration learns the floor fast; live reconfigure validates', () => {
  const vad = new AdaptiveVadV8({});
  vad.startCalibration(200);
  assert.equal(vad.getStats().calibrating, true);
  for (let i = 0; i < 15; i++) vad.feed(noiseFrame(0.05));
  assert.equal(vad.getStats().calibrating, false);
  const cfg = vad.updateOptions({ threshold: 0.03, minConfidence: 0.6 });
  assert.equal(cfg.threshold, 0.03);
  assert.equal(cfg.minConfidence, 0.6);
  assert.throws(() => vad.updateOptions({ threshold: 99 }), /Invalid AdaptiveVadV8/);
  assert.throws(() => vad.feed(new Uint8Array([1])), /even-length PCM16/);
});

test('v109 vad: simple engine falls back to energy-only and still detects speech', () => {
  const { events, sink } = collectEvents();
  const vad = createVadV8({ engine: 'simple', sink });
  assert.ok(vad instanceof SimpleEnergyVadV8);
  for (let i = 0; i < 12; i++) vad.feed(speechFrame());
  assert.equal(vad.getState(), 'speaking');
  assert.ok(vad.getStats().fallbackWindows > 0, 'simple engine counts fallback windows');
  for (let i = 0; i < 20; i++) vad.feed(silenceFrame());
  assert.equal(vad.getStats().turns, 1);
  const auto = createVadV8({ engine: 'auto' });
  assert.ok(auto instanceof AdaptiveVadV8);
  assert.equal(events.filter((e) => e.kind === 'speech-start').length, 1);
});

// ---------------------------------------------------------------------------
// 2. Barge-in v8
// ---------------------------------------------------------------------------

test('v109 barge-in: playback queue cancel receipt is exact', () => {
  const q = new PlaybackQueueV8();
  q.enqueue('hello world this is a test reply', 300);
  assert.equal(q.getWords().length, 7);
  assert.equal(q.getRemainingMs(), 2100);
  q.markPlayedUpTo(3);
  assert.equal(q.getPlayedCount(), 3);
  assert.equal(q.getPlayedMs(), 900);
  assert.equal(q.getSpokenText(), 'hello world this');
  assert.equal(q.getRemainingText(), 'is a test reply');
  const receipt = q.cancelFrom(3);
  assert.equal(receipt.wordsPlayed, 3);
  assert.equal(receipt.wordsDiscarded, 4);
  assert.equal(receipt.audioPlayedMs, 900);
  assert.equal(receipt.audioDiscardedMs, 1200);
  assert.equal(receipt.spokenText, 'hello world this');
  assert.equal(receipt.remainingText, 'is a test reply');
  assert.equal(receipt.cutWordIndex, 3);
  assert.equal(receipt.cutAudioOffsetMs, 900);
  assert.equal(q.getQueuedCount(), 0);
  // Second cancel is idempotent — nothing left to discard.
  const again = q.cancelFrom(3);
  assert.equal(again.wordsDiscarded, 0);
  assert.equal(again.audioDiscardedMs, 0);
  assert.deepEqual(splitWordsV8('  a  b   c '), ['a', 'b', 'c']);
});

test('v109 barge-in: AEC learns the echo gain and echo-only frames do not interrupt', () => {
  const clock = fakeClock();
  const ctrl = new BargeInV8Controller({ clock: clock.now, graceMs: 0, echoWindowMs: 0 });
  ctrl.noteModelSpeechStarted('hello world this is a long reply here');
  const playback = speechFrame(0.3);
  // Quiet moments: mic == playback (pure echo) — the gain learns toward 1.
  for (let i = 0; i < 60; i++) {
    ctrl.notePlaybackFrame(playback);
    ctrl.noteAudioFrame({ frame: playback, vadActive: false, confidence: 0 });
  }
  assert.ok(ctrl.getEchoGain() > 0.85, `echo gain should converge, got ${ctrl.getEchoGain()}`);
  clock.advance(1000);
  // Same frame again, now with VAD claiming speech: it is mostly echo.
  ctrl.notePlaybackFrame(playback);
  const decision = ctrl.noteAudioFrame({ frame: playback, vadActive: true, confidence: 0.9 });
  assert.equal(decision.action, 'ignore');
  assert.equal(decision.reason, 'echo-only');
  assert.ok(decision.residualRatio < 0.35, `residual ratio ${decision.residualRatio}`);
  assert.ok(ctrl.getStats().echoOnlyFrames > 0, 'echo-only frames were rejected while learning');
  assert.equal(ctrl.getStats().interrupts, 0);
});

test('v109 barge-in: AEC residual separates real speech from speaker echo', () => {
  // Pure echo (mic == playback, gain 1) leaves ~nothing; real speech leaves a big residual.
  const mic = speechFrame(0.3);
  const res = aecResidualFrame(mic, mic, 1.0);
  assert.ok(res.residualRms < 0.001, `pure echo residual ${res.residualRms}`);
  assert.ok(res.echoRms > 0.1);
  const res2 = aecResidualFrame(speechFrame(0.3), silenceFrame(), 0.5);
  assert.ok(res2.residualRms > 0.1, 'speech over silence keeps its residual');
  assert.equal(res2.echoRms, 0);
});

test('v109 barge-in: loud speech interrupts, grace window protects the first words', async () => {
  const clock = fakeClock();
  const ctrl = new BargeInV8Controller({ clock: clock.now, graceMs: 300, echoWindowMs: 0, debounceFrames: 2 });
  ctrl.noteModelSpeechStarted('hello world this is a long reply here', 300);
  ctrl.noteWordPlayed(0);
  ctrl.noteWordPlayed(1);
  // Inside the grace window: ignored.
  let d = ctrl.noteAudioFrame({ frame: speechFrame(0.3), vadActive: true, confidence: 0.9 });
  assert.equal(d.action, 'ignore');
  assert.equal(d.reason, 'grace');
  clock.advance(400);
  // First confirming frame: debouncing.
  d = ctrl.noteAudioFrame({ frame: speechFrame(0.3), vadActive: true, confidence: 0.9 });
  assert.equal(d.action, 'ignore');
  assert.equal(d.reason, 'debouncing');
  // Second confirming frame: interrupt.
  d = ctrl.noteAudioFrame({ frame: speechFrame(0.3), vadActive: true, confidence: 0.9 });
  assert.equal(d.action, 'interrupt');
  assert.equal(d.reason, 'confirmed');
  assert.equal(d.phase, 'speaking');
  const result = await ctrl.requestInterrupt({});
  assert.equal(result.stopped, true);
  assert.equal(result.withinBudget, true);
  assert.equal(result.wordsPlayed, 2);
  assert.equal(result.wordsDiscarded, 6);
  assert.equal(result.audioPlayedMs, 600);
  assert.equal(result.audioDiscardedMs, 1800);
  assert.equal(result.spokenText, 'hello world');
  assert.equal(result.remainingText, 'this is a long reply here');
  assert.equal(result.cutWordIndex, 2);
  assert.equal(result.cutAudioOffsetMs, 600);
  assert.equal(ctrl.getStats().interrupts, 1);
  assert.equal(ctrl.getStats().totalAudioDiscardedMs, 1800);
  assert.equal(ctrl.getStats().totalWordsDiscarded, 6);
  assert.match(bargeInV8Summary(ctrl.getStats()), /interrupts 1/);
  // Cooldown: no second interrupt right away.
  clock.advance(100);
  ctrl.noteModelSpeechStarted('another reply here');
  d = ctrl.noteAudioFrame({ frame: speechFrame(0.3), vadActive: true, confidence: 0.9 });
  assert.equal(d.reason, 'cooldown');
});

test('v109 barge-in: interrupt while thinking discards the pending reply before a word is spoken', async () => {
  const clock = fakeClock();
  const ctrl = new BargeInV8Controller({ clock: clock.now, graceMs: 0, echoWindowMs: 0, debounceFrames: 1 });
  ctrl.noteThinkingStarted();
  assert.equal(ctrl.getPhase(), 'thinking');
  const d = ctrl.noteAudioFrame({ frame: speechFrame(0.3), vadActive: true, confidence: 0.9 });
  assert.equal(d.action, 'interrupt');
  assert.equal(d.reason, 'confirmed-thinking');
  const result = await ctrl.requestInterrupt({});
  assert.equal(result.wordsDiscarded, 0);
  assert.equal(result.audioDiscardedMs, 0);
  assert.equal(ctrl.getStats().thinkingInterrupts, 1);
  assert.equal(ctrl.getStats().interrupts, 1);
});

test('v109 barge-in: quiet frames duck, options validate', () => {
  const clock = fakeClock();
  const ctrl = new BargeInV8Controller({ clock: clock.now, graceMs: 0, echoWindowMs: 0 });
  ctrl.noteModelSpeechStarted('hello world');
  // Below the interrupt threshold but above the duck threshold: duck.
  const d = ctrl.noteAudioFrame({ frame: sineFrame(440, 0.035), vadActive: true, confidence: 0.9 });
  assert.equal(d.action, 'duck');
  assert.equal(ctrl.getState(), 'ducked');
  assert.equal(ctrl.getStats().ducks, 1);
  assert.deepEqual(validateBargeInV8Options({}), []);
  assert.ok(validateBargeInV8Options({ duckThreshold: 0.05, energyThreshold: 0.03 }).length > 0);
  assert.throws(() => new BargeInV8Controller({ energyThreshold: 99 }), /Invalid BargeInV8/);
});

// ---------------------------------------------------------------------------
// 3. Store v8
// ---------------------------------------------------------------------------

test('v109 store: save/load roundtrip keeps turns, voice, cut point and reconnect budget', () => {
  const dir = tmpDir('open-bot-voice-v109-store-');
  const store = new VoiceSessionV8Store({ dir });
  const snapshot = createVoiceSessionV8Snapshot({ sessionId: 'call-1', provider: 'openai', voiceId: 'vi-nam', voiceName: 'Nam', nowMs: 1000 });
  snapshot.turns = [
    { speaker: 'user', text: 'xin chào', atMs: 100 },
    { speaker: 'agent', text: 'chào bạn', atMs: 200, interrupted: true, cutWordIndex: 1 },
  ];
  snapshot.cutPoint = { wordsPlayed: 1, audioPlayedMs: 300, spokenText: 'chào', remainingText: 'bạn, tôi có thể giúp gì?', cutWordIndex: 1 };
  snapshot.reconnects = 2;
  snapshot.totalDowntimeMs = 4500;
  snapshot.durationMs = 60000;
  const saved = store.save(snapshot);
  assert.equal(saved.ok, true);
  assert.ok(saved.bytes > 0);
  assert.equal(saved.turns, 2);
  assert.ok(fs.existsSync(voiceSessionV8SnapshotPath(dir, 'call-1')));
  const loaded = store.load('call-1');
  assert.equal(loaded.ok, true);
  if (loaded.ok) {
    assert.equal(loaded.snapshot.sessionId, 'call-1');
    assert.equal(loaded.snapshot.voiceId, 'vi-nam');
    assert.equal(loaded.snapshot.turns.length, 2);
    assert.equal(loaded.snapshot.cutPoint.remainingText, 'bạn, tôi có thể giúp gì?');
    assert.equal(loaded.snapshot.reconnects, 2);
    assert.deepEqual(validateVoiceSessionV8Snapshot(loaded.snapshot), []);
    const instructions = buildVoiceSessionV8ResumeInstructions(loaded.snapshot, 'Be helpful.');
    assert.match(instructions, /Resumed voice session call-1/);
    assert.match(instructions, /bạn, tôi có thể giúp gì\?/);
    assert.match(instructions, /xin chào/);
    const md = voiceSessionV8SnapshotMarkdown(loaded.snapshot);
    assert.match(md, /# Voice session call-1 \(v8\)/);
    assert.match(md, /cut off/);
  }
  assert.equal(store.has('call-1'), true);
  assert.equal(store.list().length, 1);
  assert.equal(store.list()[0].turns, 2);
  assert.equal(store.delete('call-1'), true);
  assert.equal(store.has('call-1'), false);
  assert.deepEqual(store.load('missing'), { ok: false, error: 'missing', detail: 'no snapshot on disk', path: voiceSessionV8SnapshotPath(dir, 'missing') });
});

test('v109 store: tampered snapshot fails the checksum and is quarantined, not deleted', () => {
  const dir = tmpDir('open-bot-voice-v109-store-tamper-');
  const store = new VoiceSessionV8Store({ dir });
  const snapshot = createVoiceSessionV8Snapshot({ sessionId: 'call-2', provider: 'openai' });
  assert.equal(store.save(snapshot).ok, true);
  const filePath = voiceSessionV8SnapshotPath(dir, 'call-2');
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  raw.snapshot.turns = [{ speaker: 'user', text: 'forged', atMs: 0 }];
  fs.writeFileSync(filePath, JSON.stringify(raw));
  const loaded = store.load('call-2');
  assert.equal(loaded.ok, false);
  if (!loaded.ok) assert.equal(loaded.error, 'checksum-mismatch');
  assert.equal(fs.existsSync(filePath), false, 'tampered file moved aside');
  const quarantined = fs.readdirSync(dir).filter((n) => n.includes('corrupt-'));
  assert.equal(quarantined.length, 1);
  // Bad JSON is corrupt-json; future version is unsupported-version.
  fs.writeFileSync(filePath, '{not json');
  assert.equal(store.load('call-2').ok, false);
  const good = createVoiceSessionV8Snapshot({ sessionId: 'call-3', provider: 'openai' });
  store.save(good);
  const raw3 = JSON.parse(fs.readFileSync(voiceSessionV8SnapshotPath(dir, 'call-3'), 'utf8'));
  raw3.snapshot.version = 99;
  raw3.checksum = 'x';
  fs.writeFileSync(voiceSessionV8SnapshotPath(dir, 'call-3'), JSON.stringify(raw3));
  const loaded3 = store.load('call-3');
  assert.equal(loaded3.ok, false);
  if (!loaded3.ok) assert.equal(loaded3.error, 'checksum-mismatch');
});

test('v109 store: turns are capped and old snapshots prune', () => {
  const dir = tmpDir('open-bot-voice-v109-store-prune-');
  const store = new VoiceSessionV8Store({ dir, maxTurns: 3, clock: () => 10_000 });
  const snapshot = createVoiceSessionV8Snapshot({ sessionId: 'old', provider: 'openai', nowMs: 1000 });
  snapshot.turns = [1, 2, 3, 4, 5].map((i) => ({ speaker: 'user', text: `turn ${i}`, atMs: i }));
  const saved = store.save(snapshot);
  assert.equal(saved.turns, 3);
  const loaded = store.load('old');
  assert.equal(loaded.ok, true);
  if (loaded.ok) assert.equal(loaded.snapshot.turns[0].text, 'turn 3');
  // Fresh snapshot now, old one pruned by age.
  const store2 = new VoiceSessionV8Store({ dir, clock: () => 10_000 + 8 * 24 * 60 * 60 * 1000 });
  const pruned = store2.prune();
  assert.deepEqual(pruned, ['old']);
  assert.equal(store2.list().length, 0);
  assert.equal(VOICE_SESSION_V8_STORE_VERSION, 1);
});

// ---------------------------------------------------------------------------
// 4. Session v8
// ---------------------------------------------------------------------------

test('v109 session: connect → listening, scripted turn records turns + snapshot', async () => {
  const dir = tmpDir('open-bot-voice-v109-session-');
  const session = createMockVoiceSessionV8({ sessionId: 'call-1', storeDir: dir, sleepMs: async () => {}, mockWordDelayMs: 0 });
  assert.equal(session.getStatus(), 'idle');
  await session.connect({});
  assert.equal(session.getStatus(), 'listening');
  assert.equal(session.isConnected(), true);
  const ok = await session.simulateTurn('xin chào', 'chào bạn, tôi nghe đây');
  assert.equal(ok, true);
  assert.equal(session.getTurnCount(), 2);
  assert.deepEqual(session.getTurns().map((t) => t.speaker), ['user', 'agent']);
  assert.equal(session.getStatus(), 'listening');
  const stats = session.getV8Stats();
  assert.equal(stats.status, 'listening');
  assert.equal(stats.inputMode, 'auto');
  assert.equal(stats.turns, 2);
  assert.equal(stats.snapshotSaved, true);
  assert.ok(fs.existsSync(voiceSessionV8SnapshotPath(dir, 'call-1')));
  const summary = session.getSummary();
  assert.equal(summary.id, 'call-1');
  assert.equal(summary.status, 'listening');
  assert.match(session.summary(), /v8 status=listening/);
  session.disconnect();
  assert.equal(session.getStatus(), 'disconnected');
  const loaded = new VoiceSessionV8Store({ dir }).load('call-1');
  assert.equal(loaded.ok, true);
  if (loaded.ok) assert.equal(loaded.snapshot.cleanShutdown, true);
});

test('v109 session: interrupt during a reply keeps the cut point in the snapshot', async () => {
  const dir = tmpDir('open-bot-voice-v109-session-cut-');
  const session = createMockVoiceSessionV8({ sessionId: 'call-2', storeDir: dir, sleepMs: async () => {}, mockWordDelayMs: 0 });
  await session.connect({});
  const bargeIn = session.getBargeIn();
  bargeIn.noteModelSpeechStarted('one two three four five six', 300);
  bargeIn.noteWordPlayed(0);
  bargeIn.noteWordPlayed(1);
  const result = await session.interrupt();
  assert.equal(result.wordsPlayed, 2);
  assert.equal(result.wordsDiscarded, 4);
  assert.equal(result.remainingText, 'three four five six');
  const cut = session.getLastCutPoint();
  assert.ok(cut);
  assert.equal(cut.remainingText, 'three four five six');
  assert.equal(cut.cutWordIndex, 2);
  const loaded = new VoiceSessionV8Store({ dir }).load('call-2');
  assert.equal(loaded.ok, true);
  if (loaded.ok) assert.equal(loaded.snapshot.cutPoint.remainingText, 'three four five six');
  // Resume re-queues the remainder from the cut word.
  const resumed = session.resumeRemaining();
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.text, 'three four five six');
  assert.equal(resumed.words, 4);
  session.disconnect();
});

test('v109 session: push-to-talk gates the mic, auto mode does not', async () => {
  const session = createMockVoiceSessionV8({ sessionId: 'call-3', sleepMs: async () => {}, mockWordDelayMs: 0 });
  await session.connect({});
  assert.equal(session.setInputMode('push-to-talk'), 'push-to-talk');
  // Not holding: frames dropped.
  assert.equal(await session.feedAudioFrame(speechFrame()), null);
  session.pressPtt();
  assert.equal(session.isPttPressed(), true);
  // Holding with no model speaking: processed (null decision, no interrupt).
  assert.equal(await session.feedAudioFrame(speechFrame()), null);
  session.releasePtt();
  assert.equal(session.isPttPressed(), false);
  assert.equal(await session.feedAudioFrame(speechFrame()), null);
  assert.equal(session.setInputMode('auto'), 'auto');
  assert.equal(await session.feedAudioFrame(speechFrame()), null);
  assert.throws(() => session.setInputMode('shout'), /inputMode must be/);
  await assert.rejects(session.feedAudioFrame(new Uint8Array([1])), /even-length PCM16/);
  session.disconnect();
});

test('v109 session: barge-in through feedAudioFrame interrupts the speaking model', async () => {
  const clock = fakeClock();
  const session = createMockVoiceSessionV8({
    sessionId: 'call-4',
    clock: clock.now,
    sleepMs: async () => {},
    mockWordDelayMs: 0,
  });
  await session.connect({});
  const bargeIn = session.getBargeIn();
  bargeIn.noteModelSpeechStarted('one two three four five six', 300);
  bargeIn.noteWordPlayed(0);
  clock.advance(1000); // past grace (300) + echo window (400)
  await session.feedAudioFrame(speechFrame());
  const decision = await session.feedAudioFrame(speechFrame());
  assert.ok(decision, 'second confirming frame should decide');
  assert.equal(decision.action, 'interrupt');
  const cut = session.getLastCutPoint();
  assert.ok(cut);
  assert.equal(cut.wordsPlayed, 1);
  session.disconnect();
});

test('v109 session: drop → reconnectNow retries with budget and restores from disk', async () => {
  const dir = tmpDir('open-bot-voice-v109-session-resume-');
  const session = createMockVoiceSessionV8({
    sessionId: 'call-5',
    storeDir: dir,
    sleepMs: async () => {},
    mockWordDelayMs: 0,
    maxReconnectAttempts: 3,
    reconnectBaseDelayMs: 1,
    reconnectMaxDelayMs: 5,
  });
  await session.connect({});
  await session.simulateTurn('nhớ tôi là ai không', 'tôi nhớ bạn tên Huy');
  assert.equal(session.getTurnCount(), 2);
  const drop = session.noteDisconnected('socket closed');
  assert.equal(drop.retry, true);
  assert.equal(drop.attempt, 1);
  assert.equal(session.getStatus(), 'reconnecting');
  let dials = 0;
  const out = await session.reconnectNow(async () => {
    dials += 1;
    return dials >= 3; // fail twice, then succeed
  });
  assert.equal(out.ok, true);
  assert.equal(out.attempts, 3);
  assert.equal(out.restored, true);
  assert.match(out.resumeInstructions, /Resumed voice session call-5/);
  assert.match(out.resumeInstructions, /nhớ tôi là ai không/);
  assert.equal(session.getStatus(), 'listening');
  assert.ok(session.getRestoredSnapshot());
  // Terminal drop exhausts the budget immediately.
  const session2 = createMockVoiceSessionV8({ sessionId: 'call-6', sleepMs: async () => {}, mockWordDelayMs: 0 });
  const terminal = session2.noteDisconnected(new Error('auth failed'), { terminal: true });
  assert.equal(terminal.retry, false);
  const failed = await session2.reconnectNow(async () => false);
  assert.equal(failed.ok, false);
  session.disconnect();
  session2.disconnect();
});

test('v109 session: manager create/list/restore/remove + bad ids', async () => {
  const dir = tmpDir('open-bot-voice-v109-manager-');
  const manager = new VoiceV8Manager({ storeDir: dir });
  assert.throws(() => manager.createSession('bad id!'), /Invalid voice v8 session id/);
  const s1 = manager.createSession('a', { provider: 'openai', vadPreset: 'noisy', inputMode: 'push-to-talk' });
  assert.equal(s1.getInputMode(), 'push-to-talk');
  assert.throws(() => manager.createSession('a'), /already exists/);
  manager.createSession('b');
  assert.equal(manager.listSessions().length, 2);
  assert.equal(manager.getSession('a'), s1);
  assert.equal(manager.hasSession('zzz'), false);
  assert.equal(manager.listVoices().length > 0, true);
  // Persist + restore in a fresh manager.
  await s1.connect({});
  await s1.simulateTurn('hello', 'hi there friend');
  s1.disconnect();
  const manager2 = new VoiceV8Manager({ storeDir: dir });
  const { session, restored } = manager2.restoreSession('a');
  assert.ok(restored);
  assert.equal(session.getTurnCount(), 2);
  assert.equal(manager2.getStats().sessions, 1);
  assert.equal(manager.removeSession('a'), true);
  assert.equal(manager.removeSession('a'), false);
  assert.equal(manager.listSessions().length, 1);
});

// ---------------------------------------------------------------------------
// 5. Tools v8
// ---------------------------------------------------------------------------

async function runTool(byName, name, args) {
  const tool = byName.get(name);
  assert.ok(tool, `tool ${name} must exist`);
  const out = await tool.execute(args);
  return JSON.parse(out);
}

test('v109 tools: 10 tools, unique names, placeholder refuses without a manager', async () => {
  assert.equal(VOICE_V8_TOOLS.length, 10);
  assert.deepEqual([...VOICE_V8_TOOL_NAMES], [
    'voice_v8_session_create',
    'voice_v8_session_list',
    'voice_v8_session_stats',
    'voice_v8_session_stop',
    'voice_v8_session_delete',
    'voice_v8_session_resume',
    'voice_v8_vad',
    'voice_v8_barge_in',
    'voice_v8_ptt',
    'voice_v8_simulate_turn',
  ]);
  assert.equal(new Set(VOICE_V8_TOOL_NAMES).size, 10);
  assert.equal(isVoiceV8ToolName('voice_v8_vad'), true);
  assert.equal(isVoiceV8ToolName('voice_v7_vad'), false);
  for (const tool of VOICE_V8_TOOLS) {
    assert.equal(tool.needsApproval, false);
    assert.ok(tool.definition.parameters.additionalProperties === false);
  }
  const byName = new Map(VOICE_V8_TOOLS.map((t) => [t.definition.name, t]));
  const out = await byName.get('voice_v8_session_list').execute({});
  assert.match(out, /not available/);
});

test('v109 tools: full lifecycle on a real manager (mock sessions)', async () => {
  const dir = tmpDir('open-bot-voice-v109-tools-');
  const manager = new VoiceV8Manager({ storeDir: dir });
  const tools = createVoiceV8Tools({ getManager: () => manager });
  const byName = new Map(tools.map((t) => [t.definition.name, t]));
  const created = await runTool(byName, 'voice_v8_session_create', {
    sessionId: 'call-1',
    provider: 'openai',
    vadPreset: 'office',
    inputMode: 'auto',
    connect: true,
  });
  assert.equal(created.created, true);
  assert.equal(created.summary.status, 'listening');
  const listed = await runTool(byName, 'voice_v8_session_list', {});
  assert.equal(listed.sessions.length, 1);
  assert.equal(listed.manager.sessions, 1);
  const turned = await runTool(byName, 'voice_v8_simulate_turn', { sessionId: 'call-1', userText: 'hi', modelReply: 'hello there' });
  assert.equal(turned.simulated, true);
  assert.equal(turned.turns.length, 2);
  const vad = await runTool(byName, 'voice_v8_vad', { sessionId: 'call-1', preset: 'noisy', calibrate: true });
  assert.equal(vad.config.preset, 'noisy');
  assert.equal(vad.stats.preset, 'noisy');
  assert.equal(vad.stats.calibrating, true);
  const barge = await runTool(byName, 'voice_v8_barge_in', { sessionId: 'call-1', action: 'status' });
  assert.equal(barge.stats.interrupts, 0);
  const ptt = await runTool(byName, 'voice_v8_ptt', { sessionId: 'call-1', action: 'set-mode', mode: 'push-to-talk' });
  assert.equal(ptt.inputMode, 'push-to-talk');
  const pressed = await runTool(byName, 'voice_v8_ptt', { sessionId: 'call-1', action: 'press' });
  assert.equal(pressed.pressed, true);
  const released = await runTool(byName, 'voice_v8_ptt', { sessionId: 'call-1', action: 'release' });
  assert.equal(released.pressed, false);
  const stats = await runTool(byName, 'voice_v8_session_stats', { sessionId: 'call-1' });
  assert.equal(stats.stats.inputMode, 'push-to-talk');
  assert.equal(stats.turns.length, 2);
  const resumed = await runTool(byName, 'voice_v8_session_resume', { sessionId: 'call-1', dropFirst: true });
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.reconnected.ok, true);
  assert.equal(resumed.reconnected.restored, true);
  assert.match(resumed.reconnected.resumeInstructions, /Resumed voice session call-1/);
  const stopped = await runTool(byName, 'voice_v8_session_stop', { sessionId: 'call-1' });
  assert.equal(stopped.stopped, true);
  const afterStop = await runTool(byName, 'voice_v8_session_list', {});
  assert.equal(afterStop.sessions.length, 1, 'stop keeps the session for inspection');
  const deleted = await runTool(byName, 'voice_v8_session_delete', { sessionId: 'call-1' });
  assert.equal(deleted.deleted, true);
  assert.equal((await runTool(byName, 'voice_v8_session_list', {})).sessions.length, 0);
  const deletedAgain = await runTool(byName, 'voice_v8_session_delete', { sessionId: 'call-1' });
  assert.equal(deletedAgain.deleted, false);
  // Unknown session / bad args surface as errors, not throws.
  const bad = await byName.get('voice_v8_session_stats').execute({ sessionId: 'nope' });
  assert.match(bad, /Unknown voice v8 session/);
  const badVad = await byName.get('voice_v8_vad').execute({ sessionId: 'call-1', preset: 'loud' });
  assert.match(badVad, /Unknown voice v8 session|Unknown VAD v8 preset/);
});

test('v109 registry: all 10 voice_v8 tools in defaultToolFactory, total 858', () => {
  const ws = tmpDir('open-bot-voice-v109-registry-');
  const mem = new BotMemory(ws);
  try {
    const tools = defaultToolFactory(mem, ws, 'bot-1');
    const names = tools.map((t) => t.definition.name);
    assert.ok(names.length >= 1453, `expected at least 1453 tools, got ${names.length}`); // v1.39 fix round 4b: floor >= 1453 (was v1.36 re-pin 1453).
    assert.equal(new Set(names).size, names.length, 'duplicate tool names in the agent registry');
    for (const name of VOICE_V8_TOOL_NAMES) {
      assert.ok(names.includes(name), `${name} must be registered`);
      assert.equal(names.filter((n) => n === name).length, 1, `${name} exactly once`);
    }
  } finally {
    mem.close();
  }
});

// ---------------------------------------------------------------------------
// 6. Renderer-local view models
// ---------------------------------------------------------------------------

test('v109 renderer: voice session v8 row parse + status labels + waveform + PTT', () => {
  assert.equal(toVoiceSessionV8RowView(null), null);
  assert.equal(toVoiceSessionV8RowView({}), null);
  assert.equal(toVoiceSessionV8RowView({ id: '' }), null);
  const row = toVoiceSessionV8RowView({
    id: 'call-1',
    status: 'reconnecting',
    inputMode: 'push-to-talk',
    pttPressed: true,
    callState: 'connected',
    phase: 'listening',
    provider: 'openai',
    voiceId: 'vi-nam',
    voiceName: 'Nam',
    connected: true,
    startedAtMs: 1000,
    durationMs: 65000,
    inputTokens: 10,
    outputTokens: 20,
    lines: 3,
    turns: 2,
    interrupts: 1,
    thinkingInterrupts: 0,
    ducks: 2,
    echoOnlyFrames: 5,
    reconnects: 1,
    vadEngine: 'spectral',
    vadPreset: 'noisy',
    level: 0.4,
    snapshotSaved: true,
    restoredFrom: true,
  });
  assert.ok(row);
  assert.equal(row.status, 'reconnecting');
  assert.equal(row.inputMode, 'push-to-talk');
  assert.equal(row.pttPressed, true);
  assert.equal(row.reconnects, 1);
  assert.equal(row.level, 0.4);
  assert.equal(toVoiceSessionV8RowViews([row, null, {}]).length, 1);
  assert.equal(voiceV8StatusLabelKey('reconnecting'), 'voice.v8.status.reconnecting');
  assert.equal(voiceV8NoiseKindLabelKey('fan'), 'voice.v8.noise.fan');
  assert.equal(voiceV8NoiseKindLabelKey('weird'), 'voice.v8.noise.unknown');
  assert.match(voiceV8StatusSummary(row), /reconnecting · push-to-talk/);
  assert.match(voiceV8StatusSummary(row), /reconnect #2/);
  assert.equal(formatVoiceV8Duration(65000), '1:05');
  assert.equal(formatVoiceV8Duration(900), '0:00');
  assert.equal(formatVoiceV8AudioMs(500), '500ms');
  assert.equal(formatVoiceV8AudioMs(1800), '1.8s');
  // PTT view: held in PTT mode, mic open; auto mode ignores the button.
  const ptt = pttView(row);
  assert.equal(ptt.enabled, true);
  assert.equal(ptt.micOpen, true);
  assert.equal(ptt.labelKey, 'voice.v8.ptt.release');
  const autoRow = { ...row, inputMode: 'auto', pttPressed: false };
  const pttAuto = pttView(autoRow);
  assert.equal(pttAuto.enabled, false);
  assert.equal(pttAuto.micOpen, true);
  assert.equal(pttAuto.labelKey, 'voice.v8.ptt.auto');
  // Waveform bars: sqrt curve, live bar last, capped count.
  const bars = waveformBars([0, 0.25, 1, 0.5], 4);
  assert.equal(bars.length, 4);
  assert.equal(bars[3].live, true);
  assert.equal(bars[2].height, 1);
  assert.ok(bars[1].height > 0.25 && bars[1].height < 1, 'sqrt curve lifts quiet bars');
  assert.equal(waveformBars([0.1, 0.2, 0.3, 0.4, 0.5], 3).length, 3);
  assert.deepEqual(appendWaveformLevel([0.1, 0.2], 0.3, 3), [0.1, 0.2, 0.3]);
  assert.deepEqual(appendWaveformLevel([0.1, 0.2, 0.3], 0.4, 3), [0.2, 0.3, 0.4]);
  // VAD + barge-in views parse defensively.
  const vadView = toVoiceV8VadView({
    engine: 'spectral',
    preset: 'noisy',
    threshold: 0.035,
    noiseFloor: 0.01,
    bandFloors: { low: 0.01, mid: 0.005, high: 0.008 },
    level: 0.2,
    zcr: 0.15,
    spectralFlatness: 0.4,
    confidence: 0.8,
    noiseKind: 'speech',
    hangoverMs: 220,
    calibrating: false,
    turns: 3,
    backchannels: 1,
    falsePositives: 2,
    falsePositivesByReason: { 'too-flat': 2 },
    falsePositivesByNoise: { fan: 2 },
    meanEndLatencyMs: 230,
    state: 'speaking',
  });
  assert.ok(vadView);
  assert.equal(vadView.noiseKind, 'speech');
  assert.equal(vadView.falsePositivesByReason['too-flat'], 2);
  assert.equal(vadView.meanEndLatencyMs, 230);
  assert.equal(toVoiceV8VadView(null), null);
  const bargeView = toVoiceV8BargeInView({
    state: 'speaking',
    interrupts: 2,
    thinkingInterrupts: 1,
    ducks: 1,
    ignored: 10,
    echoOnlyFrames: 7,
    meanResidualRatio: 0.8,
    echoGain: 0.9,
    totalAudioDiscardedMs: 1800,
    totalWordsDiscarded: 6,
    interruptsLastMinute: 2,
  });
  assert.ok(bargeView);
  assert.equal(bargeView.echoOnlyFrames, 7);
  assert.equal(bargeView.echoGain, 0.9);
  assert.equal(toVoiceV8BargeInView('nope'), null);
});

// ---------------------------------------------------------------------------
// 7. i18n
// ---------------------------------------------------------------------------

test('v109 i18n: 25 voice.v8.* keys in all 6 locales, 5278 keys each', () => {
  const localesDir = path.join(ROOT, 'apps/desktop/src/renderer/i18n/locales');
  const expected = [
    'voice.v8.bargeIn.echoOnly',
    'voice.v8.bargeIn.interrupted',
    'voice.v8.inputMode.auto',
    'voice.v8.inputMode.push-to-talk',
    'voice.v8.noise.click',
    'voice.v8.noise.fan',
    'voice.v8.noise.hum',
    'voice.v8.noise.silence',
    'voice.v8.noise.speech',
    'voice.v8.noise.unknown',
    'voice.v8.noise.white',
    'voice.v8.ptt.auto',
    'voice.v8.ptt.press',
    'voice.v8.ptt.release',
    'voice.v8.session.resumed',
    'voice.v8.session.restored',
    'voice.v8.session.saved',
    'voice.v8.status.disconnected',
    'voice.v8.status.idle',
    'voice.v8.status.listening',
    'voice.v8.status.reconnecting',
    'voice.v8.status.speaking',
    'voice.v8.status.thinking',
    'voice.v8.vad.calibrating',
    'voice.v8.title',
  ];
  const counts = [];
  for (const locale of ['en', 'vi', 'es', 'fr', 'ja', 'zh']) {
    const data = JSON.parse(fs.readFileSync(path.join(localesDir, `${locale}.json`), 'utf8'));
    counts.push(Object.keys(data).length);
    for (const key of expected) {
      assert.equal(typeof data[key], 'string', `${locale} must have ${key}`);
      assert.ok(data[key].length > 0, `${locale} ${key} must not be empty`);
    }
  }
  assert.ok(counts.every((c) => c === counts[0]), `locale totals must agree: ${counts}`);
  counts.forEach((c) => assert.ok(c >= 8072, `locale total ${c} below 8072 floor`)); // v1.39 fix round 4b: 6 locales equal + floor >= 8072 (was v1.38 re-pin [8072 x6]).
});
