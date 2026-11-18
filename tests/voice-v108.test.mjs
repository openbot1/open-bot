/**
 * Tests for v1.08 — voice realtime v7 + UI (Team T5).
 *
 *   1. VAD v7 (vadV7.ts): presets, energy+ZCR joint decision
 *      (sine = speech, 50 Hz hum = false positive, short burst =
 *      backchannel), calibration, live reconfigure + validation,
 *      noise-floor adaptation.
 *   2. Barge-in v7 (bargeInV7.ts): grace window, echo window
 *      (quiet echo ignored, loud voice passes), duck vs interrupt
 *      grading, debounce, cooldown, word-level partial + resume
 *      prompt, stop-budget stats.
 *   3. Transcript stream v7 (transcriptStreamV7.ts): word
 *      streaming, interim → final, speaker split, phase, token
 *      estimates, interrupt marks the cut line, markdown, cap.
 *   4. Voice session v7 (voiceSessionV7.ts) on the mock
 *      transport: connect → listening, scripted turn streams
 *      words, interrupt keeps the partial, VAD preset switch,
 *      manager create/list/remove + bad ids, stats (duration +
 *      tokens), store snapshot/restore/validate/prune/markdown.
 *   5. Voice v7 tools (packages/tools/src/voiceV7Tools.ts): 9
 *      tools, unique names, placeholder refuses, full lifecycle
 *      through the tools on a real manager (mock sessions),
 *      registry: all 9 in defaultToolFactory, total 649.
 *   6. Renderer-local view models (voiceSessionV7View.ts),
 *      memory-blocks diff (memoryBlocksDiff.ts) and event-log
 *      time travel (eventLogTimeTravel.ts): pure functions,
 *      imported straight from the renderer sources.
 *
 * No network, no sound card, no live provider. Run after building
 * the core + tools packages:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/voice-v108.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AdaptiveVadV7,
  pcm16ZeroCrossingRate,
  defaultVadV7Options,
  validateVadV7Options,
  isVadV7PresetName,
  VAD_V7_PRESETS,
  VAD_V7_PRESET_NAMES,
} from '../packages/core/dist/voice/vadV7.js';
import {
  BargeInV7Controller,
  buildResumeUtteranceV7,
  splitWords,
  validateBargeInV7Options,
} from '../packages/core/dist/voice/bargeInV7.js';
import {
  TranscriptStreamV7,
  estimateTranscriptV7Tokens,
} from '../packages/core/dist/voice/transcriptStreamV7.js';
import {
  VoiceSessionV7,
  VoiceV7Manager,
  createMockVoiceSessionV7,
  VOICE_V7_SESSION_ID_RE,
} from '../packages/core/dist/voice/voiceSessionV7.js';
import {
  FileVoiceSessionV7Store,
  snapshotVoiceSessionV7,
  validateVoiceSessionV7Snapshot,
  restoreVoiceSessionV7,
  voiceSessionV7SnapshotSummary,
  voiceSessionV7SnapshotMarkdown,
} from '../packages/core/dist/voice/voiceSessionV7Store.js';
import {
  createVoiceV7Tools,
  VOICE_V7_TOOLS,
  VOICE_V7_TOOL_NAMES,
  isVoiceV7ToolName,
} from '../packages/tools/dist/voiceV7Tools.js';
import { BotMemory, defaultToolFactory } from '../packages/core/dist/index.js';
import {
  toVoiceSessionV7RowView,
  toVoiceSessionV7RowViews,
  toTranscriptV7LineViews,
  formatVoiceV7Duration,
  formatVoiceV7Tokens,
  isVoiceV7SessionLive,
  splitVoiceV7Sessions,
  filterTranscriptV7Lines,
  openTranscriptV7Line,
  voiceV7SessionRowSummary,
} from '../apps/desktop/src/renderer/components/voiceSessionV7View.ts';
import {
  diffLines,
  diffSummary,
  diffSummaryText,
  diffToMarkdown,
  diffHunks,
} from '../apps/desktop/src/renderer/components/memoryBlocksDiff.ts';
import {
  buildTimeTravelSteps,
  stateAtStep,
  replaySchedule,
  isTimeTravelSpeed,
  formatTimeTravelSpan,
  timeTravelStepLabel,
  TIME_TRAVEL_SPEEDS,
} from '../apps/desktop/src/renderer/components/eventLogTimeTravel.ts';

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

function collectVadEvents(vad) {
  const events = [];
  return { events, sink: (e) => events.push(e) };
}

// ---------------------------------------------------------------------------
// 1. VAD v7
// ---------------------------------------------------------------------------

test('v108 vad: presets exist, defaults are office, unknown preset rejected', () => {
  assert.deepEqual([...VAD_V7_PRESET_NAMES], ['quiet', 'office', 'noisy', 'very-noisy']);
  assert.equal(isVadV7PresetName('noisy'), true);
  assert.equal(isVadV7PresetName('loud'), false);
  const def = defaultVadV7Options();
  assert.equal(def.preset, 'office');
  assert.equal(def.baseThreshold, VAD_V7_PRESETS.office.baseThreshold);
  assert.ok(VAD_V7_PRESETS['very-noisy'].baseThreshold > VAD_V7_PRESETS.quiet.baseThreshold);
  assert.ok(VAD_V7_PRESETS['very-noisy'].minConfidence > VAD_V7_PRESETS.quiet.minConfidence);
  const vad = new AdaptiveVadV7({ preset: 'noisy' });
  assert.equal(vad.getPreset(), 'noisy');
  assert.equal(vad.getOptions().debounceFrames, 3);
  const back = vad.setPreset('quiet');
  assert.equal(back.preset, 'quiet');
  assert.throws(() => vad.setPreset('loud'), /Unknown VAD v7 preset/);
});

test('v108 vad: zcr separates speech from hum (same energy, different shape)', () => {
  // 440 Hz sine: ZCR ~0.055 (in band). 50 Hz hum: ZCR ~0.006 (below band).
  assert.ok(pcm16ZeroCrossingRate(sineFrame(440)) > 0.02);
  assert.ok(pcm16ZeroCrossingRate(sineFrame(440)) < 0.5);
  assert.ok(pcm16ZeroCrossingRate(sineFrame(50)) < 0.02);
  assert.equal(pcm16ZeroCrossingRate(silenceFrame()), 0);
});

test('v108 vad: sine speech opens a turn, silence ends it', () => {
  const { events, sink } = collectVadEvents();
  const vad = new AdaptiveVadV7({ sink });
  for (let i = 0; i < 10; i++) vad.feed(sineFrame(440));
  assert.equal(vad.getState(), 'speaking');
  assert.equal(events.filter((e) => e.kind === 'speech-start').length, 1);
  assert.equal(events[0].startedAtMs, 0);
  assert.ok(events[0].peakConfidence >= 0.55);
  for (let i = 0; i < 21; i++) vad.feed(silenceFrame());
  assert.equal(vad.getState(), 'idle');
  const end = events.find((e) => e.kind === 'speech-end');
  assert.ok(end, 'speech-end expected');
  assert.ok(end.durationMs >= 400, `duration ${end.durationMs} should cover speech + hangover`);
  assert.equal(vad.getStats().turns, 1);
  assert.ok(vad.getStats().totalSpeechMs >= 400);
});

test('v108 vad: 50 Hz hum at speech energy is a false positive, not a turn', () => {
  const { events, sink } = collectVadEvents();
  const vad = new AdaptiveVadV7({ sink });
  for (let i = 0; i < 6; i++) vad.feed(sineFrame(50));
  assert.equal(vad.getState(), 'maybe-speech');
  for (let i = 0; i < 3; i++) vad.feed(silenceFrame());
  assert.equal(vad.getState(), 'idle');
  assert.equal(vad.getStats().turns, 0);
  assert.equal(vad.getStats().falsePositives, 1);
  assert.equal(vad.getStats().falsePositivesByReason['zcr-out-of-band'], 1);
  const fp = events.find((e) => e.kind === 'false-positive');
  assert.ok(fp, 'false-positive event expected');
  assert.equal(fp.reason, 'zcr-out-of-band');
});

test('v108 vad: short confident burst is a backchannel, not a turn', () => {
  const { events, sink } = collectVadEvents();
  const vad = new AdaptiveVadV7({ sink });
  for (let i = 0; i < 3; i++) vad.feed(sineFrame(440));
  assert.equal(vad.getState(), 'maybe-speech');
  for (let i = 0; i < 3; i++) vad.feed(silenceFrame());
  assert.equal(vad.getState(), 'idle');
  assert.equal(vad.getStats().turns, 0);
  assert.equal(vad.getStats().backchannels, 1);
  assert.equal(events.filter((e) => e.kind === 'backchannel').length, 1);
  assert.equal(vad.getStats().falsePositives, 0);
});

test('v108 vad: white noise is a low-confidence false positive', () => {
  const { events, sink } = collectVadEvents();
  const vad = new AdaptiveVadV7({ sink });
  for (let i = 0; i < 6; i++) vad.feed(noiseFrame(0.1));
  for (let i = 0; i < 3; i++) vad.feed(silenceFrame());
  assert.equal(vad.getState(), 'idle');
  assert.equal(vad.getStats().turns, 0);
  assert.ok(vad.getStats().falsePositives >= 1, 'noise should be rejected');
  assert.ok(events.some((e) => e.kind === 'false-positive'), 'false-positive event expected');
});

test('v108 vad: calibration learns the floor fast; updateOptions validates', () => {
  const vad = new AdaptiveVadV7({});
  assert.equal(vad.getNoiseFloor(), 0.001);
  vad.startCalibration(1000);
  assert.equal(vad.getStats().calibrating, true);
  for (let i = 0; i < 50; i++) vad.feed(silenceFrame());
  assert.equal(vad.getStats().calibrating, false);
  assert.ok(vad.getNoiseFloor() < 0.001, 'silence should pull the floor down fast');
  assert.deepEqual(validateVadV7Options({ baseThreshold: 5 }), ['baseThreshold must be a finite number 0.005..0.25.']);
  assert.deepEqual(validateVadV7Options({ minZcr: 0.6, maxZcr: 0.4 }), ['minZcr must be below maxZcr.']);
  assert.deepEqual(validateVadV7Options({ preset: 'loud' }), ['preset must be one of quiet, office, noisy, very-noisy.']);
  assert.throws(() => vad.updateOptions({ baseThreshold: 5 }), /Invalid VAD v7 options/);
  const updated = vad.updateOptions({ preset: 'noisy', hangoverMs: 500 });
  assert.equal(updated.preset, 'noisy');
  assert.equal(updated.hangoverMs, 500);
  // A preset reset keeps the explicit override above it.
  assert.equal(updated.baseThreshold, VAD_V7_PRESETS.noisy.baseThreshold);
});

test('v108 vad: noise floor adapts so steady noise stops opening turns', () => {
  const { events, sink } = collectVadEvents();
  const vad = new AdaptiveVadV7({ noiseLearnMs: 200, thresholdMultiplier: 4 });
  // Steady low-level noise for a while: the floor rises to meet it.
  for (let i = 0; i < 100; i++) vad.feed(noiseFrame(0.02));
  assert.ok(vad.getNoiseFloor() > 0.005, `floor ${vad.getNoiseFloor()} should have risen`);
  assert.ok(vad.getThreshold() > 0.02, 'threshold should follow the floor');
  assert.equal(vad.getStats().turns, 0);
  assert.equal(events.filter((e) => e.kind === 'speech-start').length, 0);
  // Speech well above the adapted threshold still opens a turn.
  for (let i = 0; i < 10; i++) vad.feed(sineFrame(440, 0.5));
  assert.equal(vad.getState(), 'speaking');
});

// ---------------------------------------------------------------------------
// 2. Barge-in v7
// ---------------------------------------------------------------------------

function fakeClock() {
  let now = 10_000;
  return {
    clock: () => now,
    advance: (ms) => {
      now += ms;
    },
  };
}

test('v108 barge-in: grace window blocks early frames, echo blocks quiet echo', () => {
  const { clock, advance } = fakeClock();
  const c = new BargeInV7Controller({ clock });
  c.modelSpeechStarted('Hello world');
  // 100 ms in (grace 300): loud frame is ignored as grace.
  advance(100);
  let d = c.noteAudioFrame({ rms: 0.5, vadActive: true });
  assert.equal(d.action, 'ignore');
  assert.equal(d.reason, 'grace');
  // 400 ms in (past grace, inside echo window to 550 ms): a quiet
  // frame (echo residue, below threshold*3) is ignored as echo.
  advance(300);
  d = c.noteAudioFrame({ rms: 0.03, vadActive: true });
  assert.equal(d.action, 'ignore');
  assert.equal(d.reason, 'echo');
  // Same window, a genuinely loud voice passes the echo gate and
  // starts the debounce (not yet an interrupt).
  d = c.noteAudioFrame({ rms: 0.5, vadActive: true });
  assert.equal(d.action, 'ignore');
  assert.equal(d.reason, 'debouncing');
  assert.equal(c.getStats().ignored.echo, 1);
  assert.equal(c.getStats().ignored.grace, 1);
});

test('v108 barge-in: quiet burst ducks, sustained speech interrupts', () => {
  const { clock, advance } = fakeClock();
  const c = new BargeInV7Controller({ clock });
  c.modelSpeechStarted('Hello world this is a long reply');
  advance(1000);
  // RMS between the duck line (0.012) and the interrupt line (0.02): duck.
  let d = c.noteAudioFrame({ rms: 0.015, vadActive: true });
  assert.equal(d.action, 'duck');
  assert.equal(d.reason, 'confirmed-duck');
  const duck = c.duck(0.015);
  assert.equal(duck.ducked, true);
  assert.equal(c.getState(), 'ducked');
  assert.equal(c.getStats().ducks, 1);
  // The duck expires on its own (800 ms) — back to listening.
  advance(900);
  assert.equal(c.getState(), 'listening');
  // Three loud + VAD + confident frames inside the window: interrupt.
  for (let i = 0; i < 2; i++) {
    d = c.noteAudioFrame({ rms: 0.5, vadActive: true, confidence: 0.9 });
    assert.equal(d.action, 'ignore');
    assert.equal(d.reason, 'debouncing');
    advance(10);
  }
  d = c.noteAudioFrame({ rms: 0.5, vadActive: true, confidence: 0.9 });
  assert.equal(d.action, 'interrupt');
  assert.equal(d.reason, 'confirmed');
});

test('v108 barge-in: low confidence breaks the streak; no VAD means no interrupt', () => {
  const { clock, advance } = fakeClock();
  const c = new BargeInV7Controller({ clock });
  c.modelSpeechStarted('Hello');
  advance(1000);
  let d = c.noteAudioFrame({ rms: 0.5, vadActive: false });
  assert.equal(d.reason, 'no-vad');
  d = c.noteAudioFrame({ rms: 0.5, vadActive: true, confidence: 0.1 });
  assert.equal(d.action, 'ignore');
  assert.equal(d.reason, 'debouncing');
  assert.equal(d.frames, 0, 'low confidence resets the streak');
  advance(10);
  d = c.noteAudioFrame({ rms: 0.5, vadActive: true, confidence: 0.9 });
  assert.equal(d.reason, 'debouncing');
  assert.equal(d.frames, 1);
});

test('v108 barge-in: interrupt keeps the word-level partial + resume prompt, then cooldown', async () => {
  const { clock, advance } = fakeClock();
  const c = new BargeInV7Controller({ clock });
  c.modelSpeechStarted();
  c.notePlannedReply('Hello world this is a test and more words here');
  c.noteModelWords(['Hello', 'world', 'this', 'is', 'a', 'test']);
  advance(1000);
  const result = await c.interrupt(() => 5);
  assert.equal(result.stopped, true);
  assert.equal(result.stopLatencyMs, 5);
  assert.equal(result.withinBudget, true);
  assert.equal(result.partialText, 'Hello world this is a test');
  assert.deepEqual(result.spokenWords, ['Hello', 'world', 'this', 'is', 'a', 'test']);
  assert.equal(result.cutWordIndex, 6);
  assert.equal(result.remainingText, 'and more words here');
  assert.equal(c.getState(), 'cooldown');
  assert.ok(c.getCooldownRemainingMs() > 0);
  // Frames during the cooldown are refused as cooldown.
  const d = c.noteAudioFrame({ rms: 0.5, vadActive: true, confidence: 0.9 });
  assert.equal(d.reason, 'cooldown');
  // The resume prompt names the cut word and the spoken text.
  const resumed = c.resumePartial();
  assert.ok(resumed, 'resume expected');
  assert.match(resumed.resumePrompt, /"test"/);
  assert.match(resumed.resumePrompt, /6 word\(s\) spoken/);
  assert.match(resumed.resumePrompt, /Hello world this is a test/);
  assert.equal(c.getState(), 'listening');
  // Resume with nothing cut returns null.
  const fresh = new BargeInV7Controller({ clock });
  assert.equal(fresh.resumePartial(), null);
  assert.equal(buildResumeUtteranceV7({ text: '', spokenWords: [], cutWordIndex: 0, remainingText: '', cutAtMs: null, stopLatencyMs: null, at: 0 }).includes('interrupted before it started'), true);
});

test('v108 barge-in: splitWords + option validation', () => {
  assert.deepEqual(splitWords('  hello   world  '), ['hello', 'world']);
  assert.deepEqual(splitWords(''), []);
  assert.deepEqual(validateBargeInV7Options({ duckThreshold: 0.5, energyThreshold: 0.1 }), [
    'duckThreshold must not exceed energyThreshold (a duck is weaker than an interrupt).',
  ]);
  assert.deepEqual(validateBargeInV7Options({ graceMs: -1 }), ['graceMs must be a finite number 0..5000.']);
  assert.deepEqual(validateBargeInV7Options({}), []);
});

// ---------------------------------------------------------------------------
// 3. Transcript stream v7
// ---------------------------------------------------------------------------

test('v108 transcript: word streaming, interim then final, speaker split, phase', () => {
  let now = 5000;
  const events = [];
  const stream = new TranscriptStreamV7({ clock: () => now, onEvent: (e) => events.push(e) });
  assert.equal(stream.getPhase(), 'idle');
  const l1 = stream.appendWords('user', ['hello', 'world']);
  assert.equal(l1.isFinal, false);
  assert.equal(l1.text, 'hello world');
  assert.equal(l1.speaker, 'user');
  // Same speaker, still interim: the words join the same line.
  const l1b = stream.appendWords('user', [{ text: 'how', confidence: 0.8 }, 'are', 'you']);
  assert.equal(l1b.id, l1.id);
  assert.equal(l1b.text, 'hello world how are you');
  assert.ok(l1b.confidence < 1 && l1b.confidence > 0.8);
  const closed = stream.finalizeLine();
  assert.equal(closed.isFinal, true);
  assert.equal(closed.id, l1.id);
  stream.setPhase('thinking');
  assert.equal(stream.getPhase(), 'thinking');
  stream.appendWords('agent', ['I', 'am', 'fine']);
  assert.equal(stream.getPhase(), 'thinking', 'words do not move the phase by themselves');
  stream.setPhase('speaking');
  stream.finalizeLine();
  stream.setPhase('listening');
  const stats = stream.getStats();
  assert.equal(stats.lines, 2);
  assert.equal(stats.userWords, 5);
  assert.equal(stats.agentWords, 3);
  assert.equal(stats.inputTokens, estimateTranscriptV7Tokens('hello world how are you'));
  assert.equal(stats.outputTokens, estimateTranscriptV7Tokens('I am fine'));
  assert.equal(stats.phase, 'listening');
  assert.ok(events.some((e) => e.kind === 'line-finalized'));
  assert.ok(events.some((e) => e.kind === 'phase-changed'));
  const md = stream.toMarkdown();
  assert.match(md, /# Voice transcript/);
  assert.match(md, /\*\*User\*\*: hello world how are you/);
  assert.match(md, /\*\*Agent\*\*: I am fine/);
});

test('v108 transcript: interrupt marks the cut line, cap drops oldest final lines', () => {
  // maxLines is floored at 10 by the stream — use the real floor.
  const stream = new TranscriptStreamV7({ maxLines: 10 });
  stream.appendText('agent', 'one two three', {});
  const cut = stream.interruptLine('agent');
  assert.ok(cut);
  assert.equal(cut.interrupted, true);
  assert.equal(cut.isFinal, true);
  assert.equal(stream.interruptLine('agent'), null, 'nothing open to interrupt');
  assert.equal(stream.getStats().interruptedLines, 1);
  // Fill to the cap with final lines, then one more: the oldest
  // final line (the cut one) drops.
  for (const w of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']) {
    stream.appendText('user', w, { final: true });
  }
  assert.equal(stream.getLines().length, 10);
  stream.appendText('user', 'j', { final: true });
  assert.equal(stream.getLines().length, 10);
  assert.ok(!stream.getLines().some((l) => l.text === 'one two three'), 'oldest final line dropped');
  // appendText with final closes the line at once.
  const final = stream.appendText('agent', 'done now', { final: true });
  assert.equal(final.isFinal, true);
  assert.equal(final.text, 'done now');
  assert.ok(!stream.getLines().some((l) => l.text === 'a'), 'next oldest final line dropped');
  stream.clear();
  assert.equal(stream.getLines().length, 0);
  assert.equal(stream.getPhase(), 'idle');
});

test('v108 transcript: token estimate is chars/4 rounded up', () => {
  assert.equal(estimateTranscriptV7Tokens(''), 0);
  assert.equal(estimateTranscriptV7Tokens('a'), 1);
  assert.equal(estimateTranscriptV7Tokens('1234'), 1);
  assert.equal(estimateTranscriptV7Tokens('12345'), 2);
});

// ---------------------------------------------------------------------------
// 4. Voice session v7
// ---------------------------------------------------------------------------

function makeV7Session(opts = {}) {
  let now = 20_000;
  const session = createMockVoiceSessionV7({
    clock: () => now,
    mockWordDelayMs: 0,
    sleepMs: async () => {},
    ...opts,
  });
  return {
    session,
    advance: (ms) => {
      now += ms;
    },
    now: () => now,
  };
}

test('v108 session: mock connect, scripted turn streams words, stats count tokens', async () => {
  const { session, advance } = makeV7Session();
  await session.connect({});
  assert.equal(session.isConnected(), true);
  assert.equal(session.getCallState(), 'listening');
  assert.equal(session.getPhase(), 'listening');
  advance(1000);
  const started = await session.simulateTurn('hello there', 'short reply here');
  assert.equal(started, true);
  const lines = session.getTranscriptStream().getLines();
  assert.equal(lines.length, 2);
  assert.equal(lines[0].speaker, 'user');
  assert.equal(lines[0].text, 'hello there');
  assert.equal(lines[0].isFinal, true);
  assert.equal(lines[1].speaker, 'agent');
  assert.equal(lines[1].text, 'short reply here');
  assert.equal(lines[1].isFinal, true);
  assert.equal(session.getPhase(), 'listening');
  const stats = session.getV7Stats();
  assert.equal(stats.transcript.lines, 2);
  assert.ok(stats.transcript.inputTokens > 0);
  assert.ok(stats.transcript.outputTokens > 0);
  assert.ok(stats.durationMs >= 1000);
  assert.equal(stats.vad.preset, 'office');
  assert.equal(stats.bargeIn.interrupts, 0);
  const summary = session.getSummary();
  assert.equal(summary.provider, 'openai');
  assert.equal(summary.lines, 2);
  session.disconnect();
  assert.equal(session.isConnected(), false);
  assert.equal(session.getPhase(), 'idle');
});

test('v108 session: a second simulateTurn while one runs is refused', async () => {
  let resolvers = [];
  const session = createMockVoiceSessionV7({
    mockWordDelayMs: 0,
    sleepMs: () => new Promise((resolve) => resolvers.push(resolve)),
  });
  await session.connect({});
  const first = session.simulateTurn('hello', 'one two three four five');
  // Let the first turn start (it awaits the first sleep).
  await new Promise((resolve) => setTimeout(resolve, 0));
  const second = await session.simulateTurn('again', 'reply');
  assert.equal(second, false, 'concurrent turn refused');
  // Drain the sleeps so the first turn finishes.
  for (let i = 0; i < 20 && resolvers.length > 0; i++) {
    const pending = resolvers;
    resolvers = [];
    for (const r of pending) r();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.equal(await first, true);
  session.disconnect();
});

test('v108 session: interrupt keeps the partial and marks the transcript line', async () => {
  const { session } = makeV7Session();
  await session.connect({});
  session.getBargeIn().modelSpeechStarted();
  session.noteModelText('word one two three four five six', {});
  assert.equal(session.getTranscriptStream().getOpenLine()?.text, 'word one two three four five six');
  const result = await session.interrupt();
  assert.equal(result.stopped, true);
  assert.equal(result.partialText, 'word one two three four five six');
  assert.equal(result.cutWordIndex, 7);
  const lines = session.getTranscriptStream().getLines();
  assert.equal(lines[lines.length - 1].interrupted, true);
  assert.equal(lines[lines.length - 1].isFinal, true);
  const resumed = session.resumePartial();
  assert.ok(resumed);
  assert.match(resumed.resumePrompt, /"six"/);
  assert.match(resumed.resumePrompt, /7 word\(s\) spoken/);
  assert.match(resumed.resumePrompt, /word one two three four five six/);
  session.disconnect();
});

test('v108 session: VAD preset switch + calibration flow through the session', async () => {
  const { session } = makeV7Session({ vadPreset: 'quiet' });
  assert.equal(session.getVad().getPreset(), 'quiet');
  const config = session.setVadPreset('very-noisy');
  assert.equal(config.preset, 'very-noisy');
  assert.equal(session.getVad().getStats().preset, 'very-noisy');
  session.calibrateVad(200);
  assert.equal(session.getVad().getStats().calibrating, true);
  const updated = session.updateVadOptions({ hangoverMs: 500 });
  assert.equal(updated.hangoverMs, 500);
  assert.throws(() => session.updateVadOptions({ baseThreshold: 9 }), /Invalid VAD v7 options/);
  await session.connect({});
  session.disconnect();
});

test('v108 session: manager create/list/remove, bad ids, totals', async () => {
  let now = 30_000;
  const manager = new VoiceV7Manager({ clock: () => now });
  assert.throws(() => manager.createSession('bad id!'), /Invalid voice v7 session id/);
  assert.throws(() => manager.createSession(''), /Invalid voice v7 session id/);
  const a = manager.createSession('call-a', { vadPreset: 'noisy' });
  assert.throws(() => manager.createSession('call-a'), /already exists/);
  manager.createSession('call-b', { provider: 'gemini' });
  assert.equal(manager.hasSession('call-a'), true);
  assert.equal(manager.getSession('call-b')?.getProvider(), 'gemini');
  assert.equal(a.getVad().getPreset(), 'noisy');
  await a.connect({});
  now += 5000;
  const rows = manager.listSessions();
  assert.equal(rows.length, 2);
  const rowA = rows.find((r) => r.id === 'call-a');
  assert.equal(rowA.callState, 'listening');
  assert.ok(rowA.durationMs >= 5000);
  assert.equal(rowA.voiceId, 'vi-nam', 'default voice is the first built-in profile');
  assert.equal(rowA.voiceName, 'Tiếng Việt — miền Nam');
  const totals = manager.getStats();
  assert.equal(totals.sessions, 2);
  assert.equal(totals.live, 1);
  assert.equal(manager.removeSession('call-a'), true);
  assert.equal(manager.removeSession('call-a'), false);
  assert.equal(manager.getSession('call-a'), undefined);
  assert.equal(manager.listSessions().length, 1);
  assert.deepEqual(manager.listVoices().map((v) => v.id).slice(0, 1), ['vi-nam']);
});

test('v108 session: feedAudioFrame drives VAD + barge-in on loud speech', async () => {
  // Use the session's own clock (makeV7Session's advance): the
  // outer `now` here would not move the session at all.
  const { session, advance } = makeV7Session();
  await session.connect({});
  // The model is speaking (barge-in watching) with a long reply.
  session.getBargeIn().modelSpeechStarted();
  session.getBargeIn().notePlannedReply('alpha beta gamma delta epsilon zeta eta theta');
  session.noteModelText('alpha beta gamma', {});
  // Feed loud sine frames: the VAD needs ~10 frames to speak, the
  // grace (300ms) + echo (250ms) windows need ~28 frames at 20ms.
  let lastDecision = null;
  for (let i = 0; i < 40; i++) {
    advance(20);
    lastDecision = await session.feedAudioFrame(sineFrame(440, 0.5));
    if (lastDecision?.action === 'interrupt') break;
  }
  assert.ok(lastDecision, 'a decision is expected once the model speaks');
  assert.equal(lastDecision.action, 'interrupt');
  const lines = session.getTranscriptStream().getLines();
  assert.equal(lines[lines.length - 1].interrupted, true);
  assert.equal(session.getV7Stats().bargeIn.interrupts, 1);
  session.disconnect();
});

test('v108 session: invalid audio frame throws', async () => {
  const { session } = makeV7Session();
  await assert.rejects(session.feedAudioFrame(new Uint8Array([1])), /non-empty even-length PCM16/);
  await assert.rejects(session.feedAudioFrame(new Uint8Array(0)), /non-empty even-length PCM16/);
  session.disconnect();
});

// ---------------------------------------------------------------------------
// 5. Voice session v7 store
// ---------------------------------------------------------------------------

test('v108 store: snapshot / save / load / list / restore / prune / markdown', async () => {
  const dir = tmpDir('open-bot-voice-v108-store-');
  const store = new FileVoiceSessionV7Store(dir);
  const { session } = makeV7Session();
  await session.connect({});
  await session.simulateTurn('hi', 'hello back to you');
  const snapshot = snapshotVoiceSessionV7('call-1', session, 60_000);
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.sessionId, 'call-1');
  assert.equal(snapshot.transcript.length, 2);
  assert.equal(snapshot.inputTokens, snapshot.stats.transcript.inputTokens);
  assert.equal(validateVoiceSessionV7Snapshot(snapshot)?.sessionId, 'call-1');
  assert.equal(validateVoiceSessionV7Snapshot({ version: 2 }), null);
  assert.equal(validateVoiceSessionV7Snapshot(null), null);
  store.saveSnapshot(snapshot);
  const loaded = store.load('call-1');
  assert.equal(loaded?.transcript[1].text, 'hello back to you');
  assert.equal(store.load('missing'), null);
  // A corrupt file loads as null and is skipped by list.
  fs.writeFileSync(path.join(dir, 'bad.v7.json'), '{not json', 'utf8');
  assert.equal(store.load('bad'), null);
  const list = store.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].sessionId, 'call-1');
  assert.equal(list[0].lines, 2);
  // Restore into a fresh manager: fresh counters, snapshot attached.
  const manager = new VoiceV7Manager();
  const restored = restoreVoiceSessionV7(manager, snapshot);
  assert.ok(restored);
  assert.equal(restored.session.getProvider(), 'openai');
  assert.equal(restored.session.getRestoredSnapshot(), snapshot);
  assert.equal(restoreVoiceSessionV7(manager, snapshot), null, 'id already exists');
  // Summary + markdown name the session and its transcript.
  assert.match(voiceSessionV7SnapshotSummary(snapshot), /call-1/);
  const md = voiceSessionV7SnapshotMarkdown(snapshot);
  assert.match(md, /# Voice v7 session — call-1/);
  assert.match(md, /hello back to you/);
  // Prune removes snapshots older than the window.
  assert.equal(store.prune(1000, 60_000 + 2000), 1);
  assert.equal(store.list().length, 0);
  assert.equal(store.delete('call-1'), false);
  session.disconnect();
});

// ---------------------------------------------------------------------------
// 6. Voice v7 tools
// ---------------------------------------------------------------------------

function makeV7Tools() {
  const manager = new VoiceV7Manager();
  const tools = createVoiceV7Tools({ getManager: () => manager });
  const byName = new Map(tools.map((t) => [t.definition.name, t]));
  return { manager, tools, byName };
}

async function runToolRaw(byName, name, args) {
  const tool = byName.get(name);
  assert.ok(tool, `tool ${name} must exist`);
  return tool.execute(args);
}

async function runTool(byName, name, args) {
  const raw = await runToolRaw(byName, name, args);
  assert.doesNotMatch(raw, /^Error:/, `${name} should not error: ${raw}`);
  return JSON.parse(raw);
}

test('v108 tools: 9 tools, unique names, placeholder shape, approval flags', async () => {
  assert.equal(VOICE_V7_TOOLS.length, 9);
  assert.deepEqual([...VOICE_V7_TOOL_NAMES], [
    'voice_v7_session_create',
    'voice_v7_session_list',
    'voice_v7_session_stats',
    'voice_v7_session_stop',
    'voice_v7_session_delete',
    'voice_v7_transcript',
    'voice_v7_vad',
    'voice_v7_barge_in',
    'voice_v7_simulate_turn',
  ]);
  assert.equal(new Set(VOICE_V7_TOOL_NAMES).size, 9);
  assert.equal(isVoiceV7ToolName('voice_v7_transcript'), true);
  assert.equal(isVoiceV7ToolName('voice_v6_state'), false);
  const { tools } = makeV7Tools();
  assert.equal(tools.length, 9);
  assert.deepEqual(
    tools.map((t) => t.definition.name),
    [...VOICE_V7_TOOL_NAMES],
  );
  for (const tool of tools) {
    assert.equal(tool.definition.parameters.type, 'object');
    assert.ok(tool.definition.description.length > 20, tool.definition.name);
    assert.equal(typeof tool.needsApproval, 'boolean');
  }
  // Placeholder (no manager bound) refuses every tool with an error, never throws.
  const placeholder = new Map(VOICE_V7_TOOLS.map((t) => [t.definition.name, t]));
  assert.match(await runToolRaw(placeholder, 'voice_v7_session_list', {}), /^Error: voice v7 session manager is not available/);
  assert.match(await runToolRaw(placeholder, 'voice_v7_transcript', { sessionId: 'x' }), /^Error: voice v7 session manager is not available/);
});

test('v108 tools: full lifecycle on a real manager (mock sessions)', async () => {
  const { manager, byName } = makeV7Tools();
  // Unknown session errors, never throws.
  assert.match(await runToolRaw(byName, 'voice_v7_session_stats', { sessionId: 'nope' }), /^Error: Unknown voice v7 session/);
  // Bad args are refused.
  assert.match(
    await runToolRaw(byName, 'voice_v7_session_create', { sessionId: 'x', provider: 'nope' }),
    /^Error: Unknown voice v7 provider/,
  );
  assert.match(
    await runToolRaw(byName, 'voice_v7_session_create', { sessionId: 'x', vadPreset: 'loud' }),
    /^Error: Unknown VAD v7 preset/,
  );
  const created = await runTool(byName, 'voice_v7_session_create', {
    sessionId: 'call-1',
    provider: 'openai',
    vadPreset: 'noisy',
    connect: true,
  });
  assert.equal(created.created, true);
  assert.equal(created.sessionId, 'call-1');
  assert.equal(created.summary.callState, 'listening');
  assert.equal(created.summary.provider, 'openai');
  assert.match(await runToolRaw(byName, 'voice_v7_session_create', { sessionId: 'call-1' }), /already exists/);

  const listed = await runTool(byName, 'voice_v7_session_list', {});
  assert.equal(listed.sessions.length, 1);
  assert.equal(listed.sessions[0].id, 'call-1');
  assert.equal(listed.manager.sessions, 1);
  assert.equal(listed.manager.live, 1);

  // Scripted turn streams words into the transcript.
  const sim = await runTool(byName, 'voice_v7_simulate_turn', {
    sessionId: 'call-1',
    userText: 'hello bot',
    modelReply: 'hello human nice to meet you',
  });
  assert.equal(sim.simulated, true);
  assert.equal(sim.phase, 'listening');
  const transcript = await runTool(byName, 'voice_v7_transcript', { sessionId: 'call-1' });
  assert.equal(transcript.lines.length, 2);
  assert.equal(transcript.lines[0].speaker, 'user');
  assert.equal(transcript.lines[0].text, 'hello bot');
  assert.equal(transcript.lines[1].speaker, 'agent');
  assert.equal(transcript.lines[1].text, 'hello human nice to meet you');
  assert.equal(transcript.stats.userWords, 2);
  assert.equal(transcript.stats.agentWords, 6); // hello human nice to meet you
  const agentOnly = await runTool(byName, 'voice_v7_transcript', { sessionId: 'call-1', speaker: 'agent', limit: 1 });
  assert.equal(agentOnly.lines.length, 1);
  assert.equal(agentOnly.lines[0].speaker, 'agent');
  assert.match(await runToolRaw(byName, 'voice_v7_transcript', { sessionId: 'call-1', speaker: 'bot' }), /^Error: Unknown transcript speaker/);
  assert.match(await runToolRaw(byName, 'voice_v7_transcript', { sessionId: 'call-1', limit: 0 }), /^Error: limit must be an integer/);

  // VAD: status, then live config to another preset.
  const vadStatus = await runTool(byName, 'voice_v7_vad', { sessionId: 'call-1' });
  assert.equal(vadStatus.config.preset, 'noisy');
  assert.equal(vadStatus.stats.preset, 'noisy');
  const vadConfig = await runTool(byName, 'voice_v7_vad', {
    sessionId: 'call-1',
    action: 'config',
    preset: 'quiet',
    hangoverMs: 500,
  });
  assert.equal(vadConfig.config.preset, 'quiet');
  assert.equal(vadConfig.config.hangoverMs, 500);
  assert.match(
    await runToolRaw(byName, 'voice_v7_vad', { sessionId: 'call-1', action: 'config' }),
    /^Error: action=config needs a preset/,
  );
  assert.match(
    await runToolRaw(byName, 'voice_v7_vad', { sessionId: 'call-1', action: 'bogus' }),
    /^Error: Unknown VAD action/,
  );

  // Barge-in: status, resume with nothing cut, then interrupt + resume.
  const bargeStatus = await runTool(byName, 'voice_v7_barge_in', { sessionId: 'call-1' });
  assert.equal(bargeStatus.stats.interrupts, 0);
  const resumeEmpty = await runTool(byName, 'voice_v7_barge_in', { sessionId: 'call-1', action: 'resume' });
  assert.equal(resumeEmpty.resumed, false);
  const ducked = await runTool(byName, 'voice_v7_barge_in', { sessionId: 'call-1', action: 'duck', rms: 0.015 });
  assert.equal(ducked.result.ducked, true);
  // Force an interrupt: the session's model must be speaking — drive
  // a turn first, then interrupt mid-stream is timing-dependent, so
  // interrupt the (idle) controller directly: it still records the
  // partial path through the session interrupt.
  const session = manager.getSession('call-1');
  session.getBargeIn().modelSpeechStarted();
  session.noteModelText('alpha beta gamma delta', {});
  const interrupted = await runTool(byName, 'voice_v7_barge_in', { sessionId: 'call-1', action: 'interrupt' });
  assert.equal(interrupted.result.stopped, true);
  assert.equal(interrupted.result.partialText, 'alpha beta gamma delta');
  assert.equal(interrupted.result.cutWordIndex, 4);
  const resumed = await runTool(byName, 'voice_v7_barge_in', { sessionId: 'call-1', action: 'resume' });
  assert.equal(resumed.resumed, true);
  assert.match(resumed.resumePrompt, /alpha beta gamma delta/);

  // Stats, stop (keeps the session), delete (drops it).
  const stats = await runTool(byName, 'voice_v7_session_stats', { sessionId: 'call-1' });
  assert.equal(stats.stats.transcript.lines, 3, 'user + agent + interrupted agent line');
  assert.equal(stats.stats.bargeIn.interrupts, 1);
  assert.equal(stats.stats.bargeIn.ducks, 1);
  const stopped = await runTool(byName, 'voice_v7_session_stop', { sessionId: 'call-1' });
  assert.equal(stopped.stopped, true);
  assert.equal(stopped.summary.connected, false);
  const afterStop = await runTool(byName, 'voice_v7_session_list', {});
  assert.equal(afterStop.sessions.length, 1, 'stop keeps the session for inspection');
  const deleted = await runTool(byName, 'voice_v7_session_delete', { sessionId: 'call-1' });
  assert.equal(deleted.deleted, true);
  assert.equal((await runTool(byName, 'voice_v7_session_list', {})).sessions.length, 0);
  const deletedAgain = await runTool(byName, 'voice_v7_session_delete', { sessionId: 'call-1' });
  assert.equal(deletedAgain.deleted, false);
});

test('v108 registry: all 9 voice_v7 tools in defaultToolFactory, total 858', () => {
  const ws = tmpDir('open-bot-voice-v108-registry-');
  const mem = new BotMemory(ws);
  try {
    const tools = defaultToolFactory(mem, ws, 'bot-1');
    const names = tools.map((t) => t.definition.name);
    assert.equal(names.length, 1274, `expected 1200 tools, got ${names.length}`); // v1.14 T2: 820 + 8 mcpAppsV2 = 828; v1.13 merge: 769 + 51 = 820; v1.09 merge: 500 + 11 teams + 23 letta + 10 fleet_v6 + 10 voice_v8 + 2 a2a_v11 = 584; / v1.08 merge (T5): 428 + 9 voice_v7_* = 437 // v1.36 re-pin: factory 1274 (ALL_TOOLS 899 + 375).
    assert.equal(new Set(names).size, names.length, 'duplicate tool names in the agent registry');
    for (const name of VOICE_V7_TOOL_NAMES) {
      assert.ok(names.includes(name), `${name} must be registered`);
      assert.equal(names.filter((n) => n === name).length, 1, `${name} exactly once`);
    }
  } finally {
    mem.close();
  }
});

// ---------------------------------------------------------------------------
// 7. Renderer-local pure modules
// ---------------------------------------------------------------------------

test('v108 renderer: voice session view models parse + format + split', () => {
  assert.equal(toVoiceSessionV7RowView(null), null);
  assert.equal(toVoiceSessionV7RowView({}), null);
  assert.equal(toVoiceSessionV7RowView({ id: '' }), null);
  const row = toVoiceSessionV7RowView({
    id: 'call-1',
    callState: 'speaking',
    phase: 'speaking',
    provider: 'openai',
    voiceId: 'vi-nam',
    voiceName: 'Nam',
    connected: true,
    startedAtMs: 1000,
    durationMs: 90000,
    inputTokens: 1200,
    outputTokens: 3400,
    lines: 5,
    interrupts: 2,
    ducks: 1,
    restoredFrom: false,
  });
  assert.ok(row);
  assert.equal(row.id, 'call-1');
  assert.equal(isVoiceV7SessionLive(row), true);
  assert.equal(formatVoiceV7Duration(0), '0ms');
  assert.equal(formatVoiceV7Duration(999), '999ms');
  assert.equal(formatVoiceV7Duration(1500), '1s');
  assert.equal(formatVoiceV7Duration(90000), '1m 30s');
  assert.equal(formatVoiceV7Duration(3661000), '1h 1m');
  assert.equal(formatVoiceV7Tokens(1234567), '1,234,567');
  assert.match(voiceV7SessionRowSummary(row), /call-1/);
  assert.match(voiceV7SessionRowSummary(row), /1m 30s/);
  // List parsing drops malformed rows; split separates live/finished.
  const rows = toVoiceSessionV7RowViews([
    row,
    { id: 'call-2', connected: false, startedAtMs: 500, durationMs: 1000 },
    'junk',
    null,
  ]);
  assert.equal(rows.length, 2);
  const split = splitVoiceV7Sessions(rows);
  assert.equal(split.running.length, 1);
  assert.equal(split.finished.length, 1);
  assert.equal(split.finished[0].id, 'call-2');
  // Transcript parsing + filtering + open line.
  const lines = toTranscriptV7LineViews([
    { id: 'l1', speaker: 'user', text: 'hi', isFinal: true, confidence: 1, startedAtMs: 0, endedAtMs: 1, interrupted: false, tokensEstimate: 1 },
    { id: 'l2', speaker: 'agent', text: 'hello', isFinal: false, confidence: 0.9, startedAtMs: 2, endedAtMs: null, interrupted: false, tokensEstimate: 1 },
    { id: 'bad', speaker: 'bot', text: 'x' },
  ]);
  assert.equal(lines.length, 2);
  assert.equal(filterTranscriptV7Lines(lines, 'agent').length, 1);
  assert.equal(filterTranscriptV7Lines(lines).length, 2);
  assert.equal(openTranscriptV7Line(lines)?.id, 'l2');
  assert.equal(openTranscriptV7Line(lines.slice(0, 1)), null);
});

test('v108 renderer: memory-blocks diff (lines, summary, hunks, markdown)', () => {
  assert.deepEqual(diffLines('', ''), []);
  assert.deepEqual(
    diffLines('a\nb', 'a\nb').map((r) => r.type),
    ['same', 'same'],
  );
  const diff = diffLines('one\ntwo\nthree', 'one\nTWO\nthree\nfour');
  assert.deepEqual(
    diff.map((r) => `${r.type}:${r.text}`),
    ['same:one', 'del:two', 'add:TWO', 'same:three', 'add:four'],
  );
  assert.equal(diff[1].oldLineNo, 2);
  assert.equal(diff[2].newLineNo, 2);
  const summary = diffSummary(diff);
  assert.equal(summary.added, 2);
  assert.equal(summary.deleted, 1);
  assert.equal(summary.unchanged, 2);
  assert.equal(summary.coarse, false);
  assert.equal(diffSummaryText(summary), '+2 −1 · 2 unchanged');
  const md = diffToMarkdown(diff);
  assert.match(md, /^```diff/m);
  assert.match(md, /^\+ TWO$/m);
  assert.match(md, /^- two$/m);
  // Hunks: context 0 keeps only the changed rows (a `same` row
  // between two changes starts a new hunk).
  const hunks = diffHunks(diff, 0);
  assert.equal(hunks.length, 2);
  assert.deepEqual(
    hunks[0].map((r) => r.type),
    ['del', 'add'],
  );
  assert.deepEqual(
    hunks[1].map((r) => r.type),
    ['add'],
  );
  // Two far-apart changes make two hunks with context 1.
  const far = diffLines('a\nb\nc\nd\ne\nf\ng\nh', 'A\nb\nc\nd\ne\nf\ng\nH');
  assert.equal(diffHunks(far, 1).length, 2);
  // Coarse fallback past the line cap: whole-block replace —
  // every old line deleted, every new line added.
  const big = Array.from({ length: 2001 }, (_, i) => `line ${i}`).join('\n');
  const coarse = diffLines(big, `${big}\nlast`);
  assert.equal(diffSummary(coarse).added, 2002);
  assert.equal(diffSummary(coarse).deleted, 2001);
  assert.equal(diffSummary(coarse).coarse, true);
});

test('v108 renderer: event-log time travel (steps, state at step, replay)', () => {
  const entries = [
    { at: '2026-11-15T00:00:00.000Z', botId: 'b1', threadId: 'b1', kind: 'text', payload: { text: 'hello' } },
    { at: '2026-11-15T00:00:01.000Z', botId: 'b1', threadId: 'b1', kind: 'tool_call', payload: { tool: 'read_file', argKeys: ['path'] } },
    { at: '2026-11-15T00:00:02.000Z', botId: 'b1', threadId: 'b1', kind: 'result', payload: { tool: 'read_file', ok: true, output: 'ok' } },
    { at: '2026-11-15T00:00:05.000Z', botId: 'b1', threadId: 'b1', kind: 'error', payload: { message: 'boom' } },
    { at: '2026-11-15T00:00:06.000Z', botId: 'b1', threadId: 'b1', kind: 'text', payload: { text: 'retrying' } },
  ];
  assert.equal(timeTravelStepLabel(entries[1]), 'read_file(path)');
  assert.equal(timeTravelStepLabel(entries[0]), 'hello');
  const steps = buildTimeTravelSteps(entries);
  assert.equal(steps.length, 5);
  assert.equal(steps[1].lastTool, 'read_file');
  assert.equal(steps[1].toolCalls, 1);
  assert.equal(steps[1].countsByKind.tool_call, 1);
  assert.equal(steps[3].errors, 1);
  assert.equal(steps[4].lastText, 'retrying');
  assert.equal(steps[4].totalSoFar, 5);
  // State at step 2: the first two entries are visible.
  const at2 = stateAtStep(entries, steps, 2);
  assert.equal(at2.step, 2);
  assert.equal(at2.visibleEntries.length, 2);
  assert.equal(at2.toolCalls, 1);
  assert.equal(at2.errors, 0);
  assert.equal(at2.lastTool, 'read_file');
  assert.equal(at2.lastText, 'hello');
  assert.equal(at2.spanMs, 1000);
  // Clamps: past the end lands on the last step, before the start on step 0.
  assert.equal(stateAtStep(entries, steps, 99).step, 5);
  assert.equal(stateAtStep(entries, steps, -3).step, 0);
  assert.equal(stateAtStep(entries, steps, 0).visibleEntries.length, 0);
  assert.equal(stateAtStep(entries, steps, 0).lastTool, null);
  // Replay schedule: steps after `from`, up to `to`.
  assert.deepEqual(replaySchedule(2, 5), [3, 4, 5]);
  assert.deepEqual(replaySchedule(5, 5), []);
  assert.deepEqual(replaySchedule(4, 2), []);
  assert.deepEqual([...TIME_TRAVEL_SPEEDS], [100, 250, 500, 1000]);
  assert.equal(isTimeTravelSpeed(250), true);
  assert.equal(isTimeTravelSpeed(333), false);
  assert.equal(formatTimeTravelSpan(0), '0ms');
  assert.equal(formatTimeTravelSpan(61000), '1m 1s');
  // Empty log: no steps, state is step 0.
  assert.deepEqual(buildTimeTravelSteps([]), []);
  assert.equal(stateAtStep([], [], 0).total, 0);
});

test('v108 misc: session id pattern + voice v7 constants', () => {
  assert.equal(VOICE_V7_SESSION_ID_RE.test('call-1'), true);
  assert.equal(VOICE_V7_SESSION_ID_RE.test('bad id'), false);
  assert.equal(VOICE_V7_SESSION_ID_RE.test(''), false);
  // NOTE (v1.08 merge): the old assertion pinned the team worktree name
  // ('open-bot-v108-voice-ui'); the merged tree is 'open-bot-merge-v108', so
  // the dirname is environment-specific, not a feature — only the session-id
  // pattern above is asserted here.
  assert.equal(typeof ROOT, 'string');
  assert.ok(ROOT.length > 0);
});
