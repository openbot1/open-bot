/**
 * Tests for v1.11 — voice realtime v10 (Team T5).
 *
 *   1. VAD v10 (vadV10.ts): silence stays silent, a 300 Hz tone is
 *      one turn, a 50 Hz hum is rejected (low band only), a Nyquist
 *      hiss is rejected (high band only), echo frames never start a
 *      turn, double-talk is counted, short bursts are backchannels,
 *      too-short bursts are false starts, presets + live reconfigure
 *      + validation, floor adaptation.
 *   2. Noise suppression (noiseSuppressionV10.ts): profile learns
 *      from silence, steady noise is pushed down (gain < 1, dB > 0),
 *      loud speech passes nearly untouched, level `off` passes
 *      through, invalid frames rejected, stale profile reported.
 *   3. Partial transcript buffer (realtimeV2.ts): repeats mark a
 *      hypothesis stable, a new text resets stability, clear keeps
 *      the text.
 *   4. Realtime pipeline v2 (realtimeV2.ts): mock transport connect,
 *      scripted partials + final, first-partial latency, scripted
 *      turn streaming, barge-in with `immediate` policy cuts the
 *      reply, transport drop falls back to batch, batch mode keeps
 *      taking turns, recover returns to realtime, dial failure
 *      falls back at once, mic-reopen grace swallows the echo tail.
 *   5. Voice settings v10 (voiceSettingsV10.ts): provider catalog,
 *      voices per language, preset validation (bad provider/voice/
 *      rate/language rejected), effective-settings precedence
 *      (bot preset > user profile > default), memory + file preset
 *      stores (round-trip, corrupt file loads empty).
 *   6. AG-UI voice v3 (agui/voiceV3.ts): 7 event types, builders cap
 *      text and clamp levels, validation rejects bad shapes, CUSTOM
 *      bridge round-trips, level smoother (attack fast, release
 *      slow, peak hold), event log sequences + gap counting, state
 *      snapshot builder clamps.
 *   7. Session v10 (voiceSessionV10.ts): manager create/connect/
 *      scripted turn, AG-UI voice events mirrored (STARTED, FINAL,
 *      STATE), preset apply mid-call, VAD/noise/barge-in live
 *      switches, live-key probe (no key read), duplicate id
 *      rejected, remove drops the session.
 *   8. Voice v10 tools (packages/tools/src/voiceV10Tools.ts): 10
 *      tools, unique names, placeholder refuses, full lifecycle
 *      through the tools on a real manager (mock sessions),
 *      preset set/get/catalog, realtime status + force-batch +
 *      recover, registry wiring (ALL_TOOLS 368, binding keeps 368).
 *   9. Renderer-local view models (voiceSessionV10View.ts): row
 *      parsing, VAD/noise/latency views, transcript rows with a
 *      stable interim, waveform bars (peak >= level), bounded
 *      level history, fallback banner, preset rows + active mark.
 *  10. i18n: 23 `voice.realtime.v10.*` keys in all 6 locales,
 *      non-empty, total 5029 per locale.
 *
 * No network, no sound card, no live provider, no key. TTS has no
 * Windows engine and no sound card on this VM — every audio path
 * here is a mock (scripted replies, injected batch STT/TTS).
 * Run after building core + tools:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/voice-v111.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  VadV10,
  createVadV10,
  defaultVadV10Options,
  validateVadV10Options,
  isVadV10PresetName,
  vadV10Summary,
  vadV10Markdown,
  VAD_V10_PRESETS,
} from '../packages/core/dist/voice/vadV10.js';
import {
  NoiseSuppressorV10,
  defaultNoiseSuppressionV10Options,
  validateNoiseSuppressionV10Options,
  noiseSuppressionV10Summary,
} from '../packages/core/dist/voice/noiseSuppressionV10.js';
import {
  RealtimeVoicePipelineV2,
  PartialTranscriptBufferV2,
  MockRealtimeV2Transport,
  createRealtimeVoicePipelineV2,
  realtimeV2Summary,
} from '../packages/core/dist/voice/realtimeV2.js';
import {
  MemoryBotVoicePresetStore,
  FileBotVoicePresetStore,
  validateBotVoicePreset,
  getBuiltinBotVoicePreset,
  getVoiceV10ProviderCatalog,
  findVoiceV10CatalogVoice,
  voicesForLanguageV10,
  defaultVoiceForProviderV10,
  resolveEffectiveVoiceSettings,
  pickPresetForLanguage,
  VOICE_V10_PROVIDER_CATALOG,
} from '../packages/core/dist/voice/voiceSettingsV10.js';
import { validateVoiceProfile } from '../packages/core/dist/voice/voiceProfiles.js';
import {
  AG_UI_VOICE_EVENT_TYPES,
  AG_UI_VOICE_CUSTOM_NAMESPACE,
  isAgUiVoiceEventType,
  validateAgUiVoiceEvent,
  voiceEventToCustom,
  voiceEventFromCustom,
  voiceStartedEvent,
  voicePartialEvent,
  voiceAudioLevelEvent,
  voiceStateEvent,
  voiceFallbackEvent,
  VoiceAudioLevelSmoother,
  VoiceV3EventLog,
  buildVoiceStateSnapshot,
} from '../packages/core/dist/agui/voiceV3.js';
import {
  RealtimeVoiceSessionV10,
  VoiceV10Manager,
  createMockVoiceSessionV10,
  probeLiveVoiceV10Key,
} from '../packages/core/dist/voice/voiceSessionV10.js';
import {
  sinePcm16Frame,
  silencePcm16Frame,
} from '../packages/core/dist/voice/audio.js';
import {
  createVoiceV10Tools,
  VOICE_V10_TOOLS,
  VOICE_V10_TOOL_NAMES,
  isVoiceV10ToolName,
} from '../packages/tools/dist/voiceV10Tools.js';
import { ALL_TOOLS, createDefaultTools } from '../packages/tools/dist/tools.js';
import {
  toVoiceV10RowView,
  toVoiceV10VadView,
  toVoiceV10NoiseView,
  toVoiceV10LatencyView,
  toVoiceV10TranscriptRows,
  toVoiceV10AgUiStateView,
  toVoiceV10FallbackView,
  toVoiceV10PresetRows,
  waveformBarsV10,
  appendWaveformLevelV10,
  voiceV10StatusSummary,
  formatVoiceV10Duration,
  formatVoiceV10Latency,
} from '../apps/desktop/src/renderer/voice/voiceSessionV10View.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WINDOW_SAMPLES = 320;

/** Phase-continuous tone split into 20 ms windows. */
function toneWindows(frequencyHz, windows, amplitude = 0.2) {
  const full = sinePcm16Frame(WINDOW_SAMPLES * windows, amplitude, frequencyHz, 16000);
  const out = [];
  const bytes = WINDOW_SAMPLES * 2;
  for (let offset = 0; offset < full.length; offset += bytes) {
    out.push(full.slice(offset, offset + bytes));
  }
  return out;
}

function feedTone(vad, frequencyHz, windows, amplitude = 0.2, input) {
  for (const window of toneWindows(frequencyHz, windows, amplitude)) {
    if (input) vad.feed(window, input);
    else vad.feed(window);
  }
}

function feedTonePipeline(pipeline, frequencyHz, windows, amplitude = 0.2) {
  for (const window of toneWindows(frequencyHz, windows, amplitude)) pipeline.feedAudio(window);
}

/** One frame of alternating +a/-a samples (Nyquist hiss: max ZCR, huge high band). */
function hissFrame(amplitude = 0.2) {
  const frame = new Uint8Array(WINDOW_SAMPLES * 2);
  const value = Math.round(amplitude * 32767);
  for (let i = 0; i < WINDOW_SAMPLES; i++) {
    const s = i % 2 === 0 ? value : -value;
    const u = s < 0 ? s + 65536 : s;
    frame[i * 2] = u & 0xff;
    frame[i * 2 + 1] = (u >> 8) & 0xff;
  }
  return frame;
}

const silenceFrame = silencePcm16Frame(WINDOW_SAMPLES);

function tick(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// 1. VAD v10
// ---------------------------------------------------------------------------

test('vad v10: presets, defaults, validation', () => {
  assert.deepEqual(Object.keys(VAD_V10_PRESETS).sort(), ['noisy', 'office', 'quiet', 'street']);
  assert.equal(isVadV10PresetName('street'), true);
  assert.equal(isVadV10PresetName('cafe'), false);
  const defaults = defaultVadV10Options();
  assert.equal(defaults.preset, 'office');
  assert.equal(defaults.lowStartRatio, VAD_V10_PRESETS.office.lowStartRatio);
  assert.throws(() => validateVadV10Options({ preset: 'cafe' }), /preset/);
  assert.throws(() => validateVadV10Options({ lowStartRatio: 0.5 }), /lowStartRatio/);
  assert.throws(() => validateVadV10Options({ minZeroCrossings: 400 }), /minZeroCrossings/);
  const street = validateVadV10Options({ preset: 'street' });
  assert.equal(street.lowStartRatio, VAD_V10_PRESETS.street.lowStartRatio);
  assert.equal(street.initialLowFloor, VAD_V10_PRESETS.street.initialLowFloor);
});

test('vad v10: silence stays silent, a 300 Hz tone is one turn', () => {
  const events = [];
  const vad = createVadV10({}, (e) => events.push(e));
  for (let i = 0; i < 10; i++) vad.feed(silenceFrame);
  assert.equal(vad.isSpeaking(), false);
  assert.equal(vad.getStats().turns, 0);
  feedTone(vad, 300, 30);
  assert.equal(vad.isSpeaking(), true);
  assert.equal(events.filter((e) => e.kind === 'speech-start').length, 1);
  for (let i = 0; i < 15; i++) vad.feed(silenceFrame);
  assert.equal(vad.isSpeaking(), false);
  assert.equal(events.filter((e) => e.kind === 'speech-end').length, 1);
  const stats = vad.getStats();
  assert.equal(stats.turns, 1);
  assert.ok(stats.speechMs >= 300, `speechMs ${stats.speechMs}`);
  assert.ok(vadV10Summary(stats).includes('1 turns'));
  assert.ok(vadV10Markdown(stats).includes('## VAD v10'));
});

test('vad v10: 50 Hz hum is rejected, Nyquist hiss is rejected', () => {
  const events = [];
  const vad = createVadV10({}, (e) => events.push(e));
  for (let i = 0; i < 5; i++) vad.feed(silenceFrame);
  // Loud low-frequency hum: low band clears its floor, high band does not.
  feedTone(vad, 50, 20);
  assert.equal(vad.isSpeaking(), false);
  assert.equal(events.filter((e) => e.kind === 'speech-start').length, 0);
  assert.ok(vad.getStats().humRejections > 0, 'hum frames counted');
  // Alternating-sign hiss: extreme ZCR + blown-out high/low ratio.
  for (let i = 0; i < 10; i++) vad.feed(hissFrame());
  assert.equal(vad.isSpeaking(), false);
  assert.ok(vad.getStats().hissRejections > 0, 'hiss frames counted');
  // The same detector still hears real speech afterwards.
  feedTone(vad, 300, 10);
  assert.equal(vad.isSpeaking(), true);
});

test('vad v10: echo frames never start a turn, double-talk is counted', () => {
  const vad = createVadV10({});
  feedTone(vad, 300, 20, 0.2, { echo: true });
  assert.equal(vad.isSpeaking(), false);
  assert.ok(vad.getStats().echoRejections > 0);
  // Real speech starts a turn; echo arriving on top counts as double-talk.
  feedTone(vad, 300, 10);
  assert.equal(vad.isSpeaking(), true);
  const before = vad.getStats().doubleTalkFrames;
  feedTone(vad, 300, 5, 0.2, { echo: true });
  assert.ok(vad.getStats().doubleTalkFrames > before, 'double-talk frames counted');
  assert.equal(vad.isSpeaking(), true);
});

test('vad v10: short bursts are backchannels, too-short bursts are false starts', () => {
  const events = [];
  const vad = createVadV10({}, (e) => events.push(e));
  feedTone(vad, 300, 6); // 120 ms: just enough to start, too short for a turn
  for (let i = 0; i < 15; i++) vad.feed(silenceFrame);
  assert.equal(events.filter((e) => e.kind === 'backchannel').length, 1);
  assert.equal(vad.getStats().backchannels, 1);

  const fast = createVadV10({ minSpeechMs: 20, hangoverMs: 0, minBackchannelMs: 80 }, (e) => events.push(e));
  feedTone(fast, 300, 1);
  fast.feed(silenceFrame);
  assert.equal(fast.getStats().falseStarts, 1);
  assert.equal(events.filter((e) => e.kind === 'false-start').length, 1);
});

test('vad v10: live reconfigure + invalid frames rejected + floor adapts', () => {
  const vad = createVadV10({ preset: 'quiet' });
  const next = vad.reconfigure({ preset: 'noisy' });
  assert.equal(next.preset, 'noisy');
  assert.equal(next.lowStartRatio, VAD_V10_PRESETS.noisy.lowStartRatio);
  assert.throws(() => vad.reconfigure({ preset: 'cafe' }), /preset/);
  assert.throws(() => vad.feed(new Uint8Array(10)), /20 ms PCM16/);
  assert.throws(() => vad.feed(silencePcm16Frame(100)), /20 ms PCM16/);
  const before = vad.getStats().floorAdaptations;
  for (let i = 0; i < 10; i++) vad.feed(silenceFrame);
  assert.ok(vad.getStats().floorAdaptations > before, 'silence adapts the floors');
  vad.reset();
  assert.equal(vad.getStats().frames, 0);
  assert.equal(vad.isSpeaking(), false);
});

// ---------------------------------------------------------------------------
// 2. Noise suppression
// ---------------------------------------------------------------------------

test('noise v10: profile learns, steady noise is pushed down, speech passes', () => {
  const sup = new NoiseSuppressorV10({});
  assert.equal(sup.isProfileReady(), false);
  // Learn the room: 20 frames of quiet 100 Hz noise.
  for (let i = 0; i < 20; i++) {
    const frame = toneWindows(100, 1, 0.02)[0];
    sup.learn(frame, i * 20);
  }
  assert.equal(sup.isProfileReady(), true);
  // The same noise is now suppressed hard.
  let last;
  for (let i = 0; i < 10; i++) {
    last = sup.process(toneWindows(100, 1, 0.02)[0], 400 + i * 20);
  }
  assert.ok(last.gain < 0.6, `noise gain ${last.gain}`);
  assert.ok(last.suppressionDb > 0, `suppression ${last.suppressionDb} dB`);
  assert.ok(last.profileReady);
  // Loud speech passes nearly untouched (after the gain recovers).
  for (let i = 0; i < 10; i++) {
    last = sup.process(toneWindows(300, 1, 0.2)[0], 600 + i * 20);
  }
  assert.ok(last.gain > 0.6, `speech gain ${last.gain}`);
  const stats = sup.getStats(800);
  assert.ok(stats.suppressedFrames > 0);
  assert.ok(stats.meanSuppressionDb > 0);
  assert.ok(noiseSuppressionV10Summary(stats).includes('suppressed'));
});

test('noise v10: level off passes through, validation, stale profile', () => {
  const sup = new NoiseSuppressorV10({ level: 'off' });
  for (let i = 0; i < 20; i++) sup.learn(toneWindows(100, 1, 0.02)[0], i * 20);
  const out = sup.process(toneWindows(100, 1, 0.02)[0], 400);
  assert.equal(out.gain, 1);
  assert.equal(out.suppressionDb, 0);
  assert.throws(() => validateNoiseSuppressionV10Options({ level: 'extreme' }), /level/);
  assert.throws(() => validateNoiseSuppressionV10Options({ minGain: 2 }), /minGain/);
  assert.deepEqual(defaultNoiseSuppressionV10Options().level, 'moderate');
  const stats = sup.getStats(40000);
  assert.equal(stats.profileStale, true);
  const fresh = sup.getStats(500);
  assert.equal(fresh.profileStale, false);
  assert.throws(() => sup.process(new Uint8Array(10), 0), /20 ms PCM16/);
  assert.throws(() => sup.learn(new Uint8Array(10), 0), /20 ms PCM16/);
  const next = sup.setLevel('aggressive');
  assert.equal(next.level, 'aggressive');
  assert.equal(next.suppressionStrength, 0.85);
});

// ---------------------------------------------------------------------------
// 3. Partial transcript buffer
// ---------------------------------------------------------------------------

test('realtime v2 partial buffer: repeats mark stability, new text resets', () => {
  const buf = new PartialTranscriptBufferV2(2);
  let r = buf.push('xin', 0);
  assert.equal(r.stable, false);
  r = buf.push('xin', 20);
  assert.equal(r.stable, true);
  assert.equal(r.latencyMs, 20);
  r = buf.push('xin chào', 40);
  assert.equal(r.stable, false);
  assert.equal(buf.getText(), 'xin chào');
  assert.equal(buf.isStable(), false);
  r = buf.push('xin chào', 60);
  assert.equal(r.stable, true);
  assert.equal(buf.clear(), 'xin chào');
  assert.equal(buf.getText(), '');
  assert.throws(() => new PartialTranscriptBufferV2(0), /stability/);
  assert.throws(() => new PartialTranscriptBufferV2(11), /stability/);
  assert.throws(() => buf.push(42, 0), /string/);
});

// ---------------------------------------------------------------------------
// 4. Realtime pipeline v2
// ---------------------------------------------------------------------------

test('realtime v2: mock transport partials + final + first-partial latency', async () => {
  const events = [];
  const pipeline = createRealtimeVoicePipelineV2({ sessionId: 'p1' }, (e) => events.push(e));
  await pipeline.connect();
  assert.equal(pipeline.getState(), 'listening');
  assert.equal(pipeline.getMode(), 'realtime');
  const transport = pipeline.getTransport();
  assert.ok(transport instanceof MockRealtimeV2Transport);
  transport.injectServerReply('xin chào bạn');
  const partials = events.filter((e) => e.kind === 'partial');
  assert.equal(partials.length, 3);
  assert.equal(partials[2].text, 'xin chào bạn');
  assert.equal(events.filter((e) => e.kind === 'final').length, 1);
  assert.equal(pipeline.getStats().firstPartialLatencyMs, 0);
  assert.equal(pipeline.getStats().userTurns, 1);
  pipeline.disconnect();
  assert.equal(pipeline.getState(), 'closed');
});

test('realtime v2: scripted turn streams words, then returns to listening', async () => {
  const events = [];
  const pipeline = createRealtimeVoicePipelineV2(
    { sessionId: 'p2', mockReplies: ['chào bạn nhé'] },
    (e) => events.push(e),
  );
  await pipeline.connect();
  const ran = await pipeline.simulateTurn('xin chào', 'chào bạn nhé');
  assert.equal(ran, true);
  assert.equal(pipeline.getState(), 'speaking');
  pipeline.tick(500);
  assert.equal(pipeline.getState(), 'listening');
  const stats = pipeline.getStats();
  assert.equal(stats.userTurns, 1);
  assert.equal(stats.agentTurns, 1);
  assert.equal(stats.turns, 2);
  assert.ok(pipeline.transcriptMarkdown().includes('xin chào'));
  assert.ok(pipeline.transcriptMarkdown().includes('chào bạn nhé'));
  assert.ok(realtimeV2Summary(stats).includes('realtime'));
  assert.throws(() => pipeline.tick(-1), /tick/);
  pipeline.disconnect();
});

test('realtime v2: barge-in with immediate policy cuts the reply', async () => {
  const events = [];
  const pipeline = createRealtimeVoicePipelineV2(
    { sessionId: 'p3', bargeIn: { policy: 'immediate', minSpeechMs: 100 }, mockReplies: ['một hai ba bốn năm sáu bảy tám'] },
    (e) => events.push(e),
  );
  await pipeline.connect();
  await pipeline.simulateTurn('nói đi', 'một hai ba bốn năm sáu bảy tám');
  assert.equal(pipeline.getState(), 'speaking');
  pipeline.tick(150); // one word played
  feedTonePipeline(pipeline, 300, 8); // user barges in
  assert.equal(pipeline.getState(), 'listening');
  assert.equal(pipeline.getStats().interrupts, 1);
  assert.equal(events.filter((e) => e.kind === 'barge-in').length, 1);
  pipeline.disconnect();
});

test('realtime v2: transport drop falls back to batch, batch keeps turns, recover returns', async () => {
  const events = [];
  const pipeline = createRealtimeVoicePipelineV2(
    { sessionId: 'p4', recoverCooldownMs: 100, mockReplies: ['batch trả lời'] },
    (e) => events.push(e),
  );
  await pipeline.connect();
  const transport = pipeline.getTransport();
  transport.failNextSendWith = { code: 1011, reason: 'socket died' };
  pipeline.feedAudio(silenceFrame);
  assert.equal(pipeline.getMode(), 'batch');
  assert.equal(pipeline.getState(), 'listening');
  assert.equal(pipeline.getStats().fallbacks, 1);
  assert.equal(events.filter((e) => e.kind === 'fallback').length, 1);
  // Batch mode still takes a turn: VAD cuts it, batch STT transcribes it.
  feedTonePipeline(pipeline, 300, 30);
  for (let i = 0; i < 25; i++) pipeline.feedAudio(silenceFrame);
  await tick(10);
  assert.ok(pipeline.getStats().turns >= 1, `batch turns ${pipeline.getStats().turns}`);
  // Recover retries realtime and comes back.
  const recovered = await pipeline.tryRecover();
  assert.equal(recovered, true);
  assert.equal(pipeline.getMode(), 'realtime');
  assert.equal(pipeline.getStats().recoveries, 1);
  assert.equal(events.filter((e) => e.kind === 'recovered').length, 1);
  pipeline.disconnect();
});

test('realtime v2: dial failure falls back at once; manual force-batch + grace swallows echo tail', async () => {
  const failing = new MockRealtimeV2Transport();
  failing.failNextConnectWith = new Error('dial refused');
  const pipeline = createRealtimeVoicePipelineV2(
    { sessionId: 'p5', createTransport: () => failing },
    null,
  );
  await pipeline.connect();
  assert.equal(pipeline.getMode(), 'batch');
  assert.equal(pipeline.getStats().fallbacks, 1);
  await pipeline.forceBatch('manual test');
  assert.equal(pipeline.getMode(), 'batch');
  pipeline.disconnect();

  // Grace: after a reply finishes, mic frames inside the grace
  // never reach the VAD, so the echo tail starts no turn.
  const events = [];
  const p2 = createRealtimeVoicePipelineV2(
    { sessionId: 'p6', mockReplies: ['xong'] },
    (e) => events.push(e),
  );
  await p2.connect();
  await p2.simulateTurn('hi', 'xong');
  p2.tick(500); // reply finishes, grace starts (300 ms)
  assert.equal(p2.getState(), 'listening');
  feedTonePipeline(p2, 300, 10); // 200 ms of "echo tail" inside the grace
  assert.equal(p2.getStats().vad.turns, 0);
  p2.disconnect();
});

test('realtime v2: invalid session id + invalid options rejected', () => {
  assert.throws(() => createRealtimeVoicePipelineV2({ sessionId: 'bad id!' }), /session id/);
  assert.throws(() => createRealtimeVoicePipelineV2({ sessionId: 'ok', mockWordMs: -1 }), /mockWordMs/);
  assert.throws(() => createRealtimeVoicePipelineV2({ sessionId: 'ok', maxRecoverAttempts: 99 }), /maxRecoverAttempts/);
  const p = createRealtimeVoicePipelineV2({ sessionId: 'ok2' });
  assert.throws(() => p.feedAudio(new Uint8Array(10)), /20 ms PCM16/);
});

// ---------------------------------------------------------------------------
// 5. Voice settings v10
// ---------------------------------------------------------------------------

test('voice settings v10: provider catalog + voices per language', () => {
  assert.equal(VOICE_V10_PROVIDER_CATALOG.length, 5);
  const openai = getVoiceV10ProviderCatalog('openai');
  assert.ok(openai);
  assert.equal(openai.needsKey, true);
  assert.ok(findVoiceV10CatalogVoice('openai', 'alloy'));
  assert.equal(findVoiceV10CatalogVoice('openai', 'nope'), undefined);
  assert.equal(getVoiceV10ProviderCatalog('nope'), undefined);
  const viVoices = voicesForLanguageV10('openai', 'vi');
  assert.ok(viVoices.some((v) => v.id === 'alloy'));
  assert.ok(viVoices.some((v) => v.id === 'nova'));
  assert.equal(defaultVoiceForProviderV10('openai')?.id, 'alloy');
  assert.equal(defaultVoiceForProviderV10('system')?.id, 'vi-vn-x-south');
  assert.equal(voicesForLanguageV10('gemini', 'vi').length, 2);
});

test('voice settings v10: preset validation rejects bad input', () => {
  const base = { id: 'test', botId: 'default', provider: 'openai', voice: 'alloy', language: 'en', rate: 1 };
  assert.equal(validateBotVoicePreset(base).ok, true);
  assert.equal(validateBotVoicePreset({ ...base, provider: 'nope' }).ok, false);
  assert.equal(validateBotVoicePreset({ ...base, voice: 'nope' }).ok, false);
  assert.equal(validateBotVoicePreset({ ...base, rate: 3 }).ok, false);
  assert.equal(validateBotVoicePreset({ ...base, language: 'xx!' }).ok, false);
  assert.equal(validateBotVoicePreset({ ...base, noiseSuppression: 'extreme' }).ok, false);
  assert.equal(validateBotVoicePreset({ ...base, vadPreset: 'cafe' }).ok, false);
  assert.equal(validateBotVoicePreset({ ...base, id: 'Bad ID' }).ok, false);
  assert.equal(validateBotVoicePreset({ ...base, name: '' }).ok, false);
  assert.equal(validateBotVoicePreset({ ...base, voice: null }).ok, true);
  const builtin = getBuiltinBotVoicePreset('vi-slow');
  assert.ok(builtin);
  assert.equal(builtin.language, 'vi');
  assert.equal(getBuiltinBotVoicePreset('nope'), undefined);
});

test('voice settings v10: effective settings precedence (preset > profile > default)', () => {
  const profileResult = validateVoiceProfile({ id: 'p1', userId: 'u1', lang: 'vi', voice: 'vi', rate: 0.9 });
  assert.equal(profileResult.ok, true);
  const profile = profileResult.ok ? profileResult.profile : null;
  const presetResult = validateBotVoicePreset({
    id: 'en-fast', botId: 'default', provider: 'openai', voice: 'nova',
    language: 'en', rate: 1.3, noiseSuppression: 'light', vadPreset: 'quiet',
  });
  assert.equal(presetResult.ok, true);
  const preset = presetResult.ok ? presetResult.preset : null;
  const fromPreset = resolveEffectiveVoiceSettings({ botPreset: preset, userProfile: profile });
  assert.equal(fromPreset.source, 'bot-preset');
  assert.equal(fromPreset.provider, 'openai');
  assert.equal(fromPreset.voice, 'nova');
  assert.equal(fromPreset.rate, 1.3);
  const fromProfile = resolveEffectiveVoiceSettings({ userProfile: profile });
  assert.equal(fromProfile.source, 'user-profile');
  assert.equal(fromProfile.language, 'vi');
  assert.equal(fromProfile.rate, 0.9);
  const fromDefault = resolveEffectiveVoiceSettings({});
  assert.equal(fromDefault.source, 'default');
  assert.equal(fromDefault.provider, 'system');
  const picked = pickPresetForLanguage([preset], 'en-US');
  assert.equal(picked?.id, 'en-fast');
});

test('voice settings v10: memory + file preset stores', () => {
  const store = new MemoryBotVoicePresetStore();
  const created = store.create({
    id: 'vi-slow', botId: 'bot-a', provider: 'system', voice: 'vi-vn-x-south',
    language: 'vi', rate: 0.85,
  });
  assert.equal(created.ok, true);
  assert.equal(store.create({
    id: 'vi-slow', botId: 'bot-a', provider: 'system', voice: 'vi',
    language: 'vi', rate: 1,
  }).ok, false, 'duplicate rejected');
  assert.equal(store.list('bot-a').length, 1);
  assert.equal(store.get('bot-a', 'vi-slow')?.rate, 0.85);
  const updated = store.update('bot-a', 'vi-slow', { rate: 0.9 });
  assert.equal(updated.ok, true);
  assert.equal(store.get('bot-a', 'vi-slow')?.rate, 0.9);
  assert.equal(store.setActive('bot-a', 'vi-slow'), true);
  assert.equal(store.getActive('bot-a')?.id, 'vi-slow');
  assert.equal(store.setActive('bot-a', 'nope'), false);
  // Another bot may own the same preset id without colliding.
  store.create({ id: 'vi-slow', botId: 'bot-b', provider: 'system', voice: 'vi', language: 'vi', rate: 1 });
  assert.equal(store.list('bot-b').length, 1);
  assert.equal(store.getStats().presets, 2);
  assert.equal(store.remove('bot-a', 'vi-slow'), true);
  assert.equal(store.get('bot-a', 'vi-slow'), undefined);

  // File store round-trip + corrupt file loads empty.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-v10-presets-'));
  try {
    const file = path.join(dir, 'presets.json');
    const fileStore = new FileBotVoicePresetStore(file);
    fileStore.create({ id: 'en-us', botId: 'bot-c', provider: 'openai', voice: 'alloy', language: 'en', rate: 1 });
    fileStore.save();
    const reloaded = new FileBotVoicePresetStore(file);
    assert.equal(reloaded.getLoadError(), null);
    assert.equal(reloaded.get('bot-c', 'en-us')?.voice, 'alloy');
    fs.writeFileSync(file, '{not json', 'utf-8');
    const corrupt = new FileBotVoicePresetStore(file);
    assert.ok(corrupt.getLoadError());
    assert.equal(corrupt.list('bot-c').length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 6. AG-UI voice v3
// ---------------------------------------------------------------------------

test('agui voice v3: 7 types, builders cap text and clamp levels', () => {
  assert.equal(AG_UI_VOICE_EVENT_TYPES.length, 7);
  assert.equal(new Set(AG_UI_VOICE_EVENT_TYPES).size, 7);
  assert.equal(isAgUiVoiceEventType('VOICE_STATE'), true);
  assert.equal(isAgUiVoiceEventType('RUN_STARTED'), false);
  const long = 'x'.repeat(5000);
  const partial = voicePartialEvent('run-1', {
    sessionId: 's1', speakerId: 'user', text: long, stable: false, latencyMs: 10,
  });
  assert.equal(partial.data.text.length, 4000);
  assert.equal(partial.protocol, 'agui-voice/3.0');
  const level = voiceAudioLevelEvent('run-1', { sessionId: 's1', source: 'mic', level: 2, peak: -1 });
  assert.equal(level.data.level, 1);
  assert.equal(level.data.peak, 0);
  const started = voiceStartedEvent('run-1', {
    sessionId: 's1', mode: 'realtime', provider: 'openai', voice: 'alloy', language: 'en',
  });
  assert.equal(validateAgUiVoiceEvent(started).ok, true);
  assert.equal(validateAgUiVoiceEvent({ ...started, protocol: 'agui/1.0' }).ok, false);
  assert.equal(validateAgUiVoiceEvent({ ...started, type: 'NOPE' }).ok, false);
  assert.equal(validateAgUiVoiceEvent({ ...started, sessionId: '' }).ok, false);
  assert.equal(validateAgUiVoiceEvent(null).ok, false);
});

test('agui voice v3: CUSTOM bridge round-trips', () => {
  const fallback = voiceFallbackEvent('run-1', {
    sessionId: 's1', reason: 'transport-closed', detail: 'socket died', willRetry: true,
  }, { botId: 'bot-a' });
  const custom = voiceEventToCustom(fallback);
  assert.equal(custom.type, 'CUSTOM');
  assert.equal(custom.data.name, AG_UI_VOICE_CUSTOM_NAMESPACE);
  const back = voiceEventFromCustom(custom);
  assert.ok(back);
  assert.equal(back.type, 'VOICE_FALLBACK');
  assert.equal(back.sessionId, 's1');
  assert.equal(back.botId, 'bot-a');
  assert.equal(back.data.reason, 'transport-closed');
  // A non-voice CUSTOM event bridges to null.
  const other = voiceEventToCustom(voiceStateEvent('run-1', {
    snapshot: buildVoiceStateSnapshot({
      sessionId: 's1', status: 'listening', mode: 'realtime', provider: 'system',
      voice: 'en', language: 'en', level: 0.5, speaking: false, ducked: false,
      turns: 0, userTurns: 0, agentTurns: 0, partials: 0, fallbacks: 0,
      interrupts: 0, interimText: '', lastTurnText: '',
    }),
  }));
  assert.ok(voiceEventFromCustom(other));
  assert.equal(voiceEventFromCustom({ ...other, data: { name: 'other.ns', value: {} } }), null);
});

test('agui voice v3: level smoother + event log + snapshot builder', () => {
  const smoother = new VoiceAudioLevelSmoother();
  const first = smoother.push(0.8);
  assert.ok(first.level > 0 && first.level <= 0.8);
  assert.equal(first.peak, 0.8);
  // Release is slow: the level decays gradually, the peak decays slowly.
  let last = first;
  for (let i = 0; i < 5; i++) last = smoother.push(0);
  assert.ok(last.level < first.level, 'level decays');
  assert.ok(last.peak > 0 && last.peak < 0.8, 'peak decays slowly');
  smoother.reset();
  assert.equal(smoother.getLevel().level, 0);
  assert.throws(() => new VoiceAudioLevelSmoother({ attack: 2 }), /attack/);

  const log = new VoiceV3EventLog();
  const e1 = log.append(voiceStartedEvent('r', {
    sessionId: 's', mode: 'realtime', provider: 'system', voice: 'en', language: 'en',
  }));
  const e2 = log.append(voiceFallbackEvent('r', {
    sessionId: 's', reason: 'x', detail: 'y', willRetry: false,
  }));
  assert.equal(e1.sequence, 0);
  assert.equal(e2.sequence, 1);
  assert.equal(log.ofType('VOICE_FALLBACK').length, 1);
  log.noteGap(3);
  assert.equal(log.getGaps(), 3);
  log.clear();
  assert.equal(log.list().length, 0);

  const snap = buildVoiceStateSnapshot({
    sessionId: 's', status: 'speaking', mode: 'batch', provider: 'openai',
    voice: 'alloy', language: 'en', level: 5, speaking: true, ducked: true,
    turns: 2, userTurns: 1, agentTurns: 1, partials: 4, fallbacks: 1,
    interrupts: 0, interimText: 'hello', lastTurnText: 'hi',
  });
  assert.equal(snap.level, 1, 'level clamped');
  assert.equal(snap.status, 'speaking');
});

// ---------------------------------------------------------------------------
// 7. Session v10
// ---------------------------------------------------------------------------

test('voice session v10: manager lifecycle + AG-UI mirror + preset apply', async () => {
  const seen = [];
  const manager = new VoiceV10Manager();
  const session = manager.create({ sessionId: 's1', botId: 'default', language: 'vi' });
  assert.equal(manager.size(), 1);
  assert.equal(session.getStatus(), 'idle');
  assert.equal(session.getSettings().source, 'bot-preset');
  assert.throws(() => manager.create({ sessionId: 's1' }), /already exists/);
  // Wire the sink after creation (the manager creates with a null sink;
  // use a directly-created session to observe events).
  const observed = [];
  const direct = createMockVoiceSessionV10(
    { sessionId: 's2', botId: 'default', language: 'en' },
    (e) => observed.push(e),
  );
  await direct.connect();
  assert.equal(direct.getStatus(), 'listening');
  await direct.simulateTurn('hello', 'hi there friend');
  direct.tick(800);
  assert.equal(direct.getStatus(), 'listening');
  const agui = direct.getAgUiEvents();
  assert.ok(agui.some((e) => e.type === 'VOICE_STARTED'), 'VOICE_STARTED mirrored');
  assert.ok(agui.some((e) => e.type === 'VOICE_TRANSCRIPT_FINAL'), 'VOICE_TRANSCRIPT_FINAL mirrored');
  assert.ok(agui.some((e) => e.type === 'VOICE_STATE'), 'VOICE_STATE mirrored');
  assert.ok(agui.every((e, i) => e.sequence === i), 'AG-UI events sequenced');
  assert.ok(direct.transcriptMarkdown().includes('hello'));
  // Live switches.
  direct.setVadPreset('street');
  assert.equal(direct.getVadOptions().preset, 'street');
  direct.setNoiseLevel('aggressive');
  assert.equal(direct.getSettings().noiseSuppression, 'moderate', 'settings snapshot is from creation');
  direct.setBargeInPolicy('confirm');
  assert.equal(direct.getBargeInOptions().policy, 'confirm');
  // Apply a bot preset mid-call.
  const preset = getBuiltinBotVoicePreset('vi-slow');
  const applied = direct.applyPreset({ ...preset, botId: 'default' });
  assert.equal(applied.language, 'vi');
  assert.equal(applied.source, 'bot-preset');
  assert.throws(() => direct.applyPreset({ ...preset, botId: 'other-bot' }), /belongs to bot/);
  // Live-key probe never reads a key.
  assert.equal(direct.liveProbe(() => false).available, false);
  assert.equal(direct.liveProbe(() => true).available, true);
  assert.equal(probeLiveVoiceV10Key(() => false, 'gemini').provider, 'gemini');
  direct.disconnect();
  assert.equal(direct.getStatus(), 'closed');
  assert.ok(direct.getAgUiEvents().some((e) => e.type === 'VOICE_STOPPED'));
  assert.equal(manager.remove('s1'), true);
  assert.equal(manager.remove('s1'), false);
  assert.equal(manager.size(), 0);
  void seen;
});

test('voice session v10: duck/resume + interrupt + fallback through the session', async () => {
  const session = createMockVoiceSessionV10({
    sessionId: 's3',
    pipeline: { bargeIn: { policy: 'immediate' }, mockReplies: ['one two three four five'] },
  });
  await session.connect();
  await session.simulateTurn('go', 'one two three four five');
  session.tick(150);
  assert.equal(session.getStatus(), 'speaking');
  const result = session.interrupt('user');
  assert.ok(result);
  assert.equal(session.getStatus(), 'listening');
  assert.equal(session.getStats().interrupts, 1);
  await session.forceBatch('test');
  assert.equal(session.getMode(), 'batch');
  const recovered = await session.tryRecover();
  assert.equal(recovered, true);
  assert.equal(session.getMode(), 'realtime');
  session.disconnect();
});

// ---------------------------------------------------------------------------
// 8. Voice v10 tools
// ---------------------------------------------------------------------------

test('voice v10 tools: 10 tools, unique names, placeholder refuses', async () => {
  assert.equal(VOICE_V10_TOOLS.length, 10);
  assert.deepEqual([...VOICE_V10_TOOL_NAMES], [
    'voice_v10_session_create', 'voice_v10_session_list', 'voice_v10_session_stats',
    'voice_v10_session_stop', 'voice_v10_session_delete', 'voice_v10_simulate_turn',
    'voice_v10_vad', 'voice_v10_noise', 'voice_v10_preset', 'voice_v10_realtime',
  ]);
  assert.equal(new Set(VOICE_V10_TOOL_NAMES).size, 10);
  for (const name of VOICE_V10_TOOL_NAMES) assert.equal(isVoiceV10ToolName(name), true);
  assert.equal(isVoiceV10ToolName('voice_v9_session_create'), false);
  for (const tool of VOICE_V10_TOOLS) {
    assert.equal(tool.needsApproval, false);
    assert.equal(typeof tool.execute, 'function');
  }
  // Unbound placeholder refuses with a plain message (no manager bound).
  const create = VOICE_V10_TOOLS[0];
  const refused = await create.execute({ sessionId: 'x' });
  assert.ok(refused.startsWith('Error: '), refused);
});

test('voice v10 tools: full lifecycle on a real manager', async () => {
  const manager = new VoiceV10Manager();
  const tools = createVoiceV10Tools({ getManager: () => manager });
  assert.equal(tools.length, 10);
  const byName = Object.fromEntries(tools.map((t) => [t.definition.name, t]));
  const run = async (name, args) => JSON.parse(await byName[name].execute(args));

  const created = await run('voice_v10_session_create', {
    sessionId: 't1', botId: 'default', language: 'vi', vadPreset: 'office',
    noiseLevel: 'moderate', bargeInPolicy: 'grace', mockReply: 'xin chào', connect: true,
  });
  assert.equal(created.created, true);
  await tick(10); // let the async connect settle
  const listed = await run('voice_v10_session_list', {});
  assert.equal(listed.count, 1);
  assert.equal(listed.sessions[0].status, 'listening');
  const turned = await run('voice_v10_simulate_turn', { sessionId: 't1', userText: 'xin chào', modelReply: 'chào bạn' });
  assert.equal(turned.simulated, true);
  const session = manager.get('t1');
  session.tick(800);
  const stats = await run('voice_v10_session_stats', { sessionId: 't1' });
  assert.equal(stats.status, 'listening');
  assert.equal(stats.stats.turns, 2);
  assert.ok(stats.transcript.includes('xin chào'));
  assert.ok(stats.aguiEvents > 0, 'AG-UI voice events mirrored');

  const vad = await run('voice_v10_vad', { sessionId: 't1', preset: 'street' });
  assert.equal(vad.preset, 'street');
  const vadBad = await byName['voice_v10_vad'].execute({ sessionId: 't1', preset: 'cafe' });
  assert.ok(vadBad.startsWith('Error: '));
  const noise = await run('voice_v10_noise', { sessionId: 't1', level: 'aggressive' });
  assert.equal(noise.level, 'aggressive');
  const noiseRead = await run('voice_v10_noise', { sessionId: 't1' });
  assert.equal(noiseRead.noise.profileReady, false);

  const presetSet = await run('voice_v10_preset', {
    action: 'set', botId: 'default', presetId: 'en-fast', name: 'English fast',
    provider: 'openai', voice: 'nova', language: 'en', rate: 1.2,
    noiseLevel: 'light', vadPreset: 'office',
  });
  assert.equal(presetSet.saved, true);
  assert.equal(presetSet.preset.voice, 'nova');
  const presetGet = await run('voice_v10_preset', { action: 'get', botId: 'default' });
  assert.equal(presetGet.active.id, 'en-fast');
  assert.equal(presetGet.presets.length, 1);
  const catalog = await run('voice_v10_preset', { action: 'catalog', provider: 'gemini' });
  assert.ok(catalog.catalog.voices.some((v) => v.id === 'puck'));
  const presetBad = await byName['voice_v10_preset'].execute({
    action: 'set', botId: 'default', presetId: 'bad', provider: 'openai', voice: 'nope',
  });
  assert.ok(presetBad.startsWith('Error: '));

  const rt = await run('voice_v10_realtime', { sessionId: 't1', action: 'status' });
  assert.equal(rt.mode, 'realtime');
  assert.equal(rt.liveAvailable, false);
  const forced = await run('voice_v10_realtime', { sessionId: 't1', action: 'force-batch', reason: 'test' });
  assert.equal(forced.mode, 'batch');
  const recovered = await run('voice_v10_realtime', { sessionId: 't1', action: 'recover' });
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.mode, 'realtime');
  const rtBad = await byName['voice_v10_realtime'].execute({ sessionId: 't1', action: 'nope' });
  assert.ok(rtBad.startsWith('Error: '));

  const stopped = await run('voice_v10_session_stop', { sessionId: 't1' });
  assert.equal(stopped.stopped, true);
  const deleted = await run('voice_v10_session_delete', { sessionId: 't1' });
  assert.equal(deleted.deleted, true);
  assert.equal(deleted.remaining, 0);
  const missing = await byName['voice_v10_session_stats'].execute({ sessionId: 't1' });
  assert.ok(missing.startsWith('Error: '));
});

test('voice v10 tools: registry wiring (ALL_TOOLS 899, binding keeps 899)', () => {
  assert.ok(ALL_TOOLS.length >= 1078, `ALL_TOOLS ${ALL_TOOLS.length} below 1078 floor`); // v1.39 fix round 4b: floor >= 1078 (was v1.38 re-pin 1078).
  assert.equal(new Set(ALL_TOOLS.map((t) => t.definition.name)).size, ALL_TOOLS.length); // v1.39 fix round 4b: unique-name check (was pinned to 1078).
  for (const name of VOICE_V10_TOOL_NAMES) {
    assert.equal(ALL_TOOLS.filter((t) => t.definition.name === name).length, 1, `${name} duplicated`);
  }
  const manager = new VoiceV10Manager();
  const bound = createDefaultTools({ getVoiceV10Manager: () => manager });
  assert.ok(bound.length >= 1078, `bound ${bound.length} below 1078 floor`); // v1.39 fix round 4b: floor >= 1078 (was v1.38 re-pin 1078).
  assert.equal(new Set(bound.map((t) => t.definition.name)).size, bound.length); // v1.39 fix round 4b: unique-name check (was pinned to 1078).
  const plain = createDefaultTools();
  assert.ok(plain.length >= 1078, `plain ${plain.length} below 1078 floor`); // v1.39 fix round 4b: floor >= 1078 (was v1.38 re-pin 1078).
});

// ---------------------------------------------------------------------------
// 9. Renderer-local view models
// ---------------------------------------------------------------------------

test('voice v10 view: row, vad, noise, latency parsing', () => {
  assert.equal(toVoiceV10RowView(null), null);
  assert.equal(toVoiceV10RowView('nope'), null);
  const row = toVoiceV10RowView({
    sessionId: 's1', status: 'speaking', mode: 'realtime', botId: 'b1',
    settings: { language: 'vi', voice: 'alloy', provider: 'openai' },
    stats: { connectedMs: 65000, turns: 3, userTurns: 2, agentTurns: 1, partials: 5, stablePartials: 2, fallbacks: 1, recoveries: 1, interrupts: 0, ducks: 1 },
    level: 0.4, peak: 0.7,
  });
  assert.ok(row);
  assert.equal(row.id, 's1');
  assert.equal(row.status, 'speaking');
  assert.equal(row.language, 'vi');
  assert.equal(row.provider, 'openai');
  assert.equal(row.turns, 3);
  assert.equal(row.level, 0.4);
  assert.equal(voiceV10StatusSummary(row), 's1: speaking (realtime), 3 turns, 1 fallbacks, 0 interrupts');
  assert.equal(formatVoiceV10Duration(65000), '1:05');
  assert.equal(formatVoiceV10Latency(null), '—');
  assert.equal(formatVoiceV10Latency(123.6), '124ms');

  const vad = toVoiceV10VadView({ preset: 'noisy', lowFloor: 0.03, highFloor: 0.014, speaking: true, turns: 2, doubleTalkFrames: 3, humRejections: 1 });
  assert.ok(vad);
  assert.equal(vad.preset, 'noisy');
  assert.equal(vad.doubleTalkFrames, 3);
  assert.equal(toVoiceV10VadView(null), null);
  const noise = toVoiceV10NoiseView({ level: 'aggressive', lastGain: 0.3, meanSuppressionDb: 8.5, profileReady: true, profileStale: false, suppressedFrames: 9 });
  assert.ok(noise);
  assert.equal(noise.gain, 0.3);
  assert.equal(noise.suppressionDb, 8.5);
  const latency = toVoiceV10LatencyView({ firstPartialLatencyMs: 120, turnLatencyMs: 450, meanTurnLatencyMs: 430 });
  assert.ok(latency);
  assert.equal(latency.turnMs, 450);
  assert.equal(toVoiceV10LatencyView({}).firstPartialMs, null);
});

test('voice v10 view: transcript rows, waveform bars, fallback, presets', () => {
  const rows = toVoiceV10TranscriptRows({
    turns: [
      { id: 't1', speakerId: 'user', text: 'xin chào', startedAtMs: 0, endedAtMs: 1000, toolCalls: [{ name: 'read_file', ok: true }] },
      { id: 't2', speakerId: 'agent', text: 'chào bạn', startedAtMs: 1100, endedAtMs: 2000, toolCalls: [] },
    ],
    interim: { speakerId: 'user', text: 'xin chào bạn', stable: false, startedAtMs: 2100 },
  });
  assert.equal(rows.length, 3);
  assert.equal(rows[2].interim, true);
  assert.equal(rows[2].stable, false);
  assert.equal(rows[0].toolCalls[0].name, 'read_file');
  assert.deepEqual(toVoiceV10TranscriptRows(null), []);

  const bars = waveformBarsV10([0.1, 0.5, 0.9, 0.2], [0.2, 0.6, 1, 0.3], 4);
  assert.equal(bars.length, 4);
  assert.equal(bars[2].level, 0.9);
  assert.ok(bars.every((b) => b.peak >= b.level), 'peak >= level');
  const many = waveformBarsV10(Array.from({ length: 100 }, (_, i) => (i % 10) / 10), [], 32);
  assert.equal(many.length, 32);
  let levels = [];
  let peaks = [];
  for (let i = 0; i < 300; i++) {
    ({ levels, peaks } = appendWaveformLevelV10(levels, peaks, 0.5, 0.8));
  }
  assert.equal(levels.length, 240);
  assert.equal(peaks.length, 240);

  const state = toVoiceV10AgUiStateView({
    snapshot: {
      sessionId: 's1', status: 'degraded', mode: 'batch', provider: 'openai',
      voice: 'alloy', language: 'en', level: 0.3, speaking: false, ducked: false,
      turns: 2, fallbacks: 1, interrupts: 0, interimText: 'hi', lastTurnText: 'hello',
    },
  });
  assert.ok(state);
  assert.equal(state.status, 'degraded');
  assert.equal(state.mode, 'batch');
  const fallback = toVoiceV10FallbackView({ reason: 'transport-closed', detail: 'socket died', willRetry: true });
  assert.equal(fallback.visible, true);
  assert.equal(fallback.willRetry, true);
  assert.equal(toVoiceV10FallbackView(null).visible, false);

  const presets = toVoiceV10PresetRows({
    active: { id: 'en-fast' },
    presets: [
      { id: 'en-fast', botId: 'default', name: 'English fast', provider: 'openai', voice: 'nova', language: 'en', rate: 1.2, noiseSuppression: 'light', vadPreset: 'office' },
      { id: 'vi-slow', botId: 'default', name: 'Tiếng Việt chậm', provider: 'system', voice: 'vi', language: 'vi', rate: 0.85, noiseSuppression: 'moderate', vadPreset: 'office' },
    ],
  });
  assert.equal(presets.length, 2);
  assert.equal(presets[0].active, true);
  assert.equal(presets[1].active, false);
  assert.deepEqual(toVoiceV10PresetRows(null), []);
});

// ---------------------------------------------------------------------------
// 10. i18n
// ---------------------------------------------------------------------------

test('i18n: 23 voice.realtime.v10.* keys in all 6 locales, total 5278', () => {
  const localesDir = path.join(ROOT, 'apps/desktop/src/renderer/i18n/locales');
  const names = ['en', 'vi', 'es', 'fr', 'ja', 'zh'];
  const expected = [
    'voice.realtime.v10.audioLevel', 'voice.realtime.v10.batchMode',
    'voice.realtime.v10.ducked', 'voice.realtime.v10.fallbackNotice',
    'voice.realtime.v10.firstPartial', 'voice.realtime.v10.noiseSuppression',
    'voice.realtime.v10.partialTranscript', 'voice.realtime.v10.presetPerBot',
    'voice.realtime.v10.presetSaved', 'voice.realtime.v10.providerVoice',
    'voice.realtime.v10.realtimeMode', 'voice.realtime.v10.status.closed',
    'voice.realtime.v10.status.connecting', 'voice.realtime.v10.status.degraded',
    'voice.realtime.v10.status.idle', 'voice.realtime.v10.status.listening',
    'voice.realtime.v10.status.processing', 'voice.realtime.v10.status.speaking',
    'voice.realtime.v10.subtitle', 'voice.realtime.v10.title',
    'voice.realtime.v10.turnLatency', 'voice.realtime.v10.vadPreset',
    'voice.realtime.v10.willRetry',
  ];
  const counts = [];
  for (const name of names) {
    const locale = JSON.parse(fs.readFileSync(path.join(localesDir, `${name}.json`), 'utf-8'));
    for (const key of expected) {
      assert.ok(typeof locale[key] === 'string' && locale[key].length > 0, `${name} missing ${key}`);
    }
    counts.push(Object.keys(locale).length);
  }
  assert.ok(counts.every((c) => c === counts[0]), `locale totals must agree: ${counts}`);
  counts.forEach((c) => assert.ok(c >= 8072, `locale total ${c} below 8072 floor`)); // v1.39 fix round 4b: 6 locales equal + floor >= 8072 (was v1.38 re-pin [8072 x6]).
});
