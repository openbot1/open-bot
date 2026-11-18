/**
 * Tests for v1.06 — voice realtime v5 (Team T4).
 *
 *   1. Multi-model voice router (voiceRouterV5.ts): catalog
 *      sanity, language/latency/cost scoring, fallback order,
 *      unavailable-provider demotion, per-bot config (pin +
 *      validation), health cooldown + recovery, ordered fallback
 *      attempts, cost estimate + markdown report.
 *   2. Adaptive VAD (vadV5.ts): silence stays silent, a 600 ms
 *      utterance is one turn, short bursts are backchannels, a
 *      brief dip inside a sentence does not split the turn, the
 *      noise floor lifts the threshold in a noisy room (adaptive
 *      vs fixed), live reconfiguration + validation.
 *   3. Speaker diarization (diarization.ts): same tone = same
 *      speaker, different pitch = new speaker, rename, merge,
 *      transcript turns + text attach, JSON round-trip, file
 *      store save/load.
 *   4. Voice session v5 + manager (voiceSessionV5.ts): two
 *      voices in one call become two speakers with a diarized
 *      transcript, rename shows in the transcript, duplicate /
 *      bad session ids rejected, stop removes the session.
 *   5. Voice v5 tools (voiceV5Tools.ts): all 9 tools end to end
 *      on a real manager (route, router config, start/stop,
 *      VAD config, speakers, rename, note turn, transcript),
 *      error paths, placeholder shape, registry count 354.
 *   6. i18n: all 6 locales carry the 16 `voice.realtime.v5.*` keys.
 *   7. Session snapshot persistence (voiceSessionV5.ts):
 *      snapshot round-trip keeps route + speakers + transcript,
 *      restored session keeps working, list/prune/corrupt file.
 *
 * No network, no sound card, no key. Run after building core +
 * tools:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/voice-v106.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  VoiceRouterV5,
  VoiceModelHealth,
  routeVoiceRequest,
  scoreVoiceModel,
  languageFit,
  findVoiceModel,
  validateVoiceBotRouterConfig,
  estimateVoiceCost,
  voiceRouteReportMarkdown,
  VOICE_V5_MODEL_CATALOG,
} from '../packages/core/dist/voice/voiceRouterV5.js';
import {
  AdaptiveVad,
  validateVadV5Options,
  defaultVadV5Options,
} from '../packages/core/dist/voice/vadV5.js';
import {
  DiarizationSession,
  FileSpeakerProfileStore,
  extractVoiceEmbedding,
  embeddingDistance,
  diarizedTranscriptMarkdown,
  DIARIZATION_EMBEDDING_SIZE,
} from '../packages/core/dist/voice/diarization.js';
import {
  VoiceSessionV5,
  VoiceV5Manager,
  FileVoiceSessionV5Store,
} from '../packages/core/dist/voice/voiceSessionV5.js';
import {
  sinePcm16Frame,
  silencePcm16Frame,
} from '../packages/core/dist/voice/audio.js';
import {
  createVoiceV5Tools,
  VOICE_V5_TOOLS,
  VOICE_V5_TOOL_NAMES,
  isVoiceV5ToolName,
} from '../packages/tools/dist/voiceV5Tools.js';
import { BotMemory, defaultToolFactory } from '../packages/core/dist/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 20 ms of audio at 16 kHz = 320 samples. */
const WINDOW_SAMPLES = 320;

/**
 * Phase-continuous tone split into 20 ms windows: one long sine
 * sliced up, so the windows join seamlessly like real mic audio.
 * (Calling sinePcm16Frame per window restarts the phase every
 * 20 ms — a 50 Hz buzz shared by every "voice" — which would
 * make two different tones look like the same speaker.)
 */
function toneWindows(frequencyHz, windows, amplitude = 0.2) {
  const full = sinePcm16Frame(WINDOW_SAMPLES * windows, amplitude, frequencyHz, 16000);
  const out = [];
  const bytes = WINDOW_SAMPLES * 2;
  for (let offset = 0; offset < full.length; offset += bytes) {
    out.push(full.slice(offset, offset + bytes));
  }
  return out;
}

function feedToneWindows(session, frequencyHz, windows) {
  for (const window of toneWindows(frequencyHz, windows)) session.feedAudio(window);
}

function feedWindows(target, frame, windows) {
  for (let i = 0; i < windows; i++) target.feed(frame);
}

function feedAudioWindows(session, frame, windows) {
  for (let i = 0; i < windows; i++) session.feedAudio(frame);
}

/** One second of a pure tone (for embeddings / diarization). */
function toneFrame(seconds, amplitude, frequencyHz) {
  return sinePcm16Frame(Math.round(16000 * seconds), amplitude, frequencyHz, 16000);
}

function tmpDir(prefix = 'open-bot-voice-v106-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ---------------------------------------------------------------------------
// 1. Multi-model voice router
// ---------------------------------------------------------------------------

test('v106 router: catalog has all 3 lanes, sane tiers, unique ids', () => {
  const lanes = new Set(VOICE_V5_MODEL_CATALOG.map((m) => m.lane));
  assert.deepEqual([...lanes].sort(), ['realtime', 'stt', 'tts']);
  const ids = VOICE_V5_MODEL_CATALOG.map((m) => m.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate model ids in catalog');
  for (const m of VOICE_V5_MODEL_CATALOG) {
    assert.ok(m.costTier >= 0 && m.costTier <= 3, `${m.id} costTier`);
    assert.ok(m.latencyMsEstimate > 0, `${m.id} latencyMsEstimate`);
    assert.ok(m.languages.length > 0, `${m.id} languages`);
    assert.ok(['low', 'balanced', 'quality'].includes(m.latencyClass), `${m.id} latencyClass`);
  }
  assert.ok(findVoiceModel('whisper-local-base'));
  assert.equal(findVoiceModel('no-such-model'), undefined);
});

test('v106 router: default route picks local/free models first for balanced/en', () => {
  const route = routeVoiceRequest({});
  assert.equal(route.language, 'en');
  assert.equal(route.latencyClass, 'balanced');
  assert.equal(route.lanes.length, 3);
  assert.equal(route.usedOutOfBudget, false);
  for (const lane of route.lanes) {
    assert.ok(lane.primary, `${lane.lane} primary`);
    assert.ok(lane.fallbacks.length > 0, `${lane.lane} fallbacks`);
    assert.ok(lane.reason.length > 0, `${lane.lane} reason`);
    assert.ok(!lane.fallbacks.some((m) => m.id === lane.primary.id), 'primary not repeated in fallbacks');
  }
  // No keys anywhere: cloud models score below local ones.
  const stt = route.lanes.find((l) => l.lane === 'stt');
  assert.equal(stt.primary.provider, 'local');
});

test('v106 router: language fit — vi prefers a vi-capable TTS, unknown language still routes', () => {
  assert.equal(languageFit(findVoiceModel('piper-local'), 'vi'), 1);
  assert.equal(languageFit(findVoiceModel('piper-local'), 'vi-VN'), 1);
  assert.equal(languageFit(findVoiceModel('deepgram-nova-2'), 'vi'), 0);
  assert.equal(languageFit(findVoiceModel('openai-whisper-1'), 'xx'), 0.5);
  const vi = routeVoiceRequest({ language: 'vi' });
  const tts = vi.lanes.find((l) => l.lane === 'tts');
  assert.equal(languageFit(tts.primary, 'vi'), 1);
  // deepgram has no vi: it must never lead the vi STT lane.
  const stt = vi.lanes.find((l) => l.lane === 'stt');
  assert.notEqual(stt.primary.id, 'deepgram-nova-2');
  // An unknown language still gets a route (wildcard models).
  const xx = routeVoiceRequest({ language: 'xx' });
  assert.equal(xx.lanes.length, 3);
});

test('v106 router: latency class + cost cap steer the pick', () => {
  const low = routeVoiceRequest({ latencyClass: 'low' });
  for (const lane of low.lanes) {
    assert.equal(lane.primary.latencyClass, 'low', `${lane.lane} should be low latency`);
  }
  const free = routeVoiceRequest({ maxCostTier: 0 });
  for (const lane of free.lanes) {
    assert.equal(lane.primary.costTier, 0, `${lane.lane} should be free`);
  }
  const freeLow = routeVoiceRequest({ latencyClass: 'low', maxCostTier: 0 });
  assert.equal(freeLow.usedOutOfBudget, false);
  // Impossible budget: still routes, but flags out-of-budget.
  const impossible = routeVoiceRequest({ maxLatencyMs: 5 });
  assert.equal(impossible.usedOutOfBudget, true);
  assert.equal(impossible.lanes.length, 3);
});

test('v106 router: availability demotes key-needing models without a key', () => {
  const withKey = routeVoiceRequest(
    { language: 'en', latencyClass: 'quality' },
    { providersWithKey: ['openai', 'deepgram'] },
  );
  const sttWithKey = withKey.lanes.find((l) => l.lane === 'stt');
  // Exact language match beats latency class: Deepgram Nova-2
  // covers 'en' exactly and is low-latency, so it leads.
  assert.equal(sttWithKey.primary.id, 'deepgram-nova-2');
  const noKey = routeVoiceRequest({ language: 'en', latencyClass: 'quality' }, { providersWithKey: [] });
  const sttNoKey = noKey.lanes.find((l) => l.lane === 'stt');
  assert.equal(sttNoKey.primary.provider, 'local');
  assert.equal(sttNoKey.primary.id, 'whisper-local-large');
  // A disabled model never leads.
  const disabled = routeVoiceRequest({}, { disabledModelIds: ['whisper-local-base'] });
  assert.notEqual(disabled.lanes.find((l) => l.lane === 'stt').primary.id, 'whisper-local-base');
});

test('v106 router: per-bot config pins models and validates', () => {
  const router = new VoiceRouterV5();
  const bad = validateVoiceBotRouterConfig({ botId: 'b1', sttModel: 'piper-local' });
  assert.equal(bad.ok, false);
  assert.match(bad.errors.join(' '), /tts model/);
  assert.equal(validateVoiceBotRouterConfig({ botId: '' }).ok, false);
  assert.equal(validateVoiceBotRouterConfig({ botId: 'b1', maxCostTier: 9 }).ok, false);
  router.setBotConfig({
    botId: 'b1',
    sttModel: 'whisper-local-tiny',
    ttsModel: 'piper-local',
    latencyClass: 'low',
    maxCostTier: 0,
    preferLocal: true,
  });
  const route = router.routeForBot('b1', { language: 'vi' });
  assert.equal(route.lanes.find((l) => l.lane === 'stt').primary.id, 'whisper-local-tiny');
  assert.equal(route.lanes.find((l) => l.lane === 'tts').primary.id, 'piper-local');
  assert.match(route.lanes.find((l) => l.lane === 'stt').reason, /pinned by bot config/);
  // Pinned model still leads the fallback list (old primary demoted).
  assert.ok(route.lanes.find((l) => l.lane === 'stt').fallbacks.length > 0);
  assert.deepEqual(router.getBotConfig('b1').botId, 'b1');
  assert.equal(router.resetBotConfig('b1'), true);
  assert.equal(router.getBotConfig('b1'), undefined);
  assert.equal(router.resetBotConfig('b1'), false);
  assert.throws(() => router.setBotConfig({ botId: 'b2', realtimeModel: 'nope' }), /unknown voice model/);
});

test('v106 router: health cooldown skips a failed model, success clears it', () => {
  const health = new VoiceModelHealth();
  const now = 1_000_000;
  assert.equal(health.isHealthy('whisper-local-base', now), true);
  health.recordFailure('whisper-local-base', now);
  assert.equal(health.isHealthy('whisper-local-base', now), false);
  assert.equal(health.failureCount('whisper-local-base'), 1);
  assert.ok(health.cooldownRemainingMs('whisper-local-base', now) > 0);
  assert.equal(health.isHealthy('whisper-local-base', now + 31_000), true);
  health.recordFailure('whisper-local-base', now);
  health.recordFailure('whisper-local-base', now);
  assert.equal(health.failureCount('whisper-local-base'), 2);
  // Second consecutive failure doubles the cooldown (30s -> 60s).
  assert.ok(health.cooldownRemainingMs('whisper-local-base', now) > 30_000);
  health.recordSuccess('whisper-local-base');
  assert.equal(health.failureCount('whisper-local-base'), 0);
  assert.equal(health.isHealthy('whisper-local-base', now), true);
});

test('v106 router: router demotes an on-cooldown primary; routeWithFallback tries in order', async () => {
  const router = new VoiceRouterV5({ now: () => 5_000_000 });
  router.recordFailure('whisper-local-base');
  router.recordFailure('whisper-local-tiny');
  const route = router.route({ language: 'en' });
  const stt = route.lanes.find((l) => l.lane === 'stt');
  assert.notEqual(stt.primary.id, 'whisper-local-base');
  assert.notEqual(stt.primary.id, 'whisper-local-tiny');
  assert.match(stt.reason, /on cooldown/);
  router.recordSuccess('whisper-local-base');
  router.recordSuccess('whisper-local-tiny');

  const candidates = [findVoiceModel('openai-whisper-1'), findVoiceModel('whisper-local-base')];
  const attempts = [];
  const result = await router.routeWithFallback(candidates, async (model) => {
    attempts.push(model.id);
    if (model.id === 'openai-whisper-1') throw new Error('no key');
    return `ok:${model.id}`;
  });
  assert.deepEqual(attempts, ['openai-whisper-1', 'whisper-local-base']);
  assert.equal(result.modelId, 'whisper-local-base');
  assert.equal(result.result, 'ok:whisper-local-base');
  assert.equal(result.attempts.length, 2);
  assert.equal(result.attempts[0].ok, false);
  assert.match(result.attempts[0].error, /no key/);
  assert.equal(result.attempts[1].ok, true);
  // The failed model is now on cooldown; the winner is healthy.
  assert.equal(router.getHealth().failureCount('openai-whisper-1'), 1);
  assert.equal(router.getHealth().failureCount('whisper-local-base'), 0);

  const total = await router.routeWithFallback(candidates, async () => {
    throw new Error('all down');
  });
  assert.equal(total.modelId, null);
  assert.equal(total.result, null);
  assert.equal(total.attempts.length, 2);
});

test('v106 router: cost estimate is 0 for local routes; report names the models', () => {
  const free = routeVoiceRequest({ maxCostTier: 0, preferLocal: true });
  const cost = estimateVoiceCost(free, 10);
  assert.equal(cost.totalUnits, 0);
  assert.equal(cost.perLane.length, 3);
  const pricey = routeVoiceRequest(
    { language: 'en', latencyClass: 'quality' },
    {
      providersWithKey: ['openai', 'gemini', 'elevenlabs'],
      // Force cloud models: without this, free local/mock models
      // win on latency + cost and the route costs 0.
      disabledModelIds: [
        'mock-stt',
        'mock-tts',
        'mock-realtime',
        'whisper-local-tiny',
        'whisper-local-base',
        'whisper-local-large',
        'piper-local',
        'system-tts',
      ],
    },
  );
  assert.ok(estimateVoiceCost(pricey, 1).totalUnits > 0);
  const md = voiceRouteReportMarkdown(pricey, 2);
  assert.match(md, /## Voice route/);
  assert.match(md, /stt/);
  assert.match(md, /tts/);
  assert.match(md, /realtime/);
  assert.match(md, /Estimated relative cost/);
  const outOfBudget = voiceRouteReportMarkdown(routeVoiceRequest({ maxLatencyMs: 5 }));
  assert.match(outOfBudget, /No model inside the requested/);
});

test('v106 router: scoreVoiceModel ranks language above latency', () => {
  const viTts = findVoiceModel('piper-local');
  const anyTts = findVoiceModel('system-tts');
  assert.ok(scoreVoiceModel(viTts, { language: 'vi' }) > scoreVoiceModel(anyTts, { language: 'vi' }));
  assert.ok(
    scoreVoiceModel(findVoiceModel('whisper-local-tiny'), { latencyClass: 'low' }) >
      scoreVoiceModel(findVoiceModel('whisper-local-large'), { latencyClass: 'low' }),
  );
});

// ---------------------------------------------------------------------------
// 2. Adaptive VAD
// ---------------------------------------------------------------------------

function collectVadEvents(vad) {
  const events = [];
  return { events, sink: (e) => events.push(e) };
}

test('v106 vad: silence stays silent; 600ms speech is one turn', () => {
  const { events, sink } = collectVadEvents();
  const vad = new AdaptiveVad({ sink });
  const speech = sinePcm16Frame(WINDOW_SAMPLES, 0.2, 440, 16000);
  const silence = silencePcm16Frame(WINDOW_SAMPLES);
  feedWindows(vad, silence, 50);
  assert.equal(events.length, 0, 'silence must not start a turn');
  assert.equal(vad.getState(), 'idle');
  feedWindows(vad, speech, 30); // 600 ms
  assert.equal(events.filter((e) => e.kind === 'speech-start').length, 1);
  assert.equal(events[0].startedAtMs, 1000); // 50 silence windows (1000 ms) ran first
  assert.equal(vad.isSpeaking(), true);
  feedWindows(vad, silence, 30); // 600 ms quiet -> hangover ends the turn
  const ends = events.filter((e) => e.kind === 'speech-end');
  assert.equal(ends.length, 1);
  // 600 ms speech + ~420 ms quiet (gap forgiveness 400 + hangover).
  assert.ok(ends[0].durationMs >= 900 && ends[0].durationMs <= 1100, `duration ${ends[0].durationMs}`);
  assert.ok(ends[0].peakRms > 0.1, `peak ${ends[0].peakRms}`);
  assert.equal(vad.getState(), 'idle');
  const stats = vad.getStats();
  assert.equal(stats.turns, 1);
  assert.equal(stats.backchannels, 0);
  assert.ok(stats.totalSpeechMs >= 900);
});

test('v106 vad: short bursts are backchannels, not turns', () => {
  const { events, sink } = collectVadEvents();
  const vad = new AdaptiveVad({ sink });
  const blip = sinePcm16Frame(WINDOW_SAMPLES, 0.2, 440, 16000);
  const silence = silencePcm16Frame(WINDOW_SAMPLES);
  feedWindows(vad, blip, 5); // 100 ms — "ừ"
  feedWindows(vad, silence, 10);
  assert.equal(events.filter((e) => e.kind === 'backchannel').length, 1);
  assert.equal(events.filter((e) => e.kind === 'speech-start').length, 0);
  assert.equal(vad.getStats().backchannels, 1);
  assert.equal(vad.getStats().turns, 0);
  // A 300 ms burst clears minTurnMs (200) and becomes a real turn.
  feedWindows(vad, blip, 15);
  assert.equal(events.filter((e) => e.kind === 'speech-start').length, 1);
  feedWindows(vad, silence, 30);
  assert.equal(events.filter((e) => e.kind === 'speech-end').length, 1);
});

test('v106 vad: a brief dip inside a sentence does not split the turn', () => {
  const { events, sink } = collectVadEvents();
  const vad = new AdaptiveVad({ sink });
  const speech = sinePcm16Frame(WINDOW_SAMPLES, 0.2, 440, 16000);
  const silence = silencePcm16Frame(WINDOW_SAMPLES);
  feedWindows(vad, speech, 20); // 400 ms
  feedWindows(vad, silence, 10); // 200 ms dip (<= maxGapMs 400)
  feedWindows(vad, speech, 20); // 400 ms more
  feedWindows(vad, silence, 30);
  assert.equal(events.filter((e) => e.kind === 'speech-start').length, 1, 'one turn, not two');
  assert.equal(events.filter((e) => e.kind === 'speech-end').length, 1);
  const end = events.find((e) => e.kind === 'speech-end');
  assert.ok(end.durationMs >= 1300 && end.durationMs <= 1500, `duration ${end.durationMs}`);
});

test('v106 vad: noise floor lifts the threshold (adaptive vs fixed)', () => {
  const noise = sinePcm16Frame(WINDOW_SAMPLES, 0.02, 120, 16000); // RMS ~0.014
  const quietSpeech = sinePcm16Frame(WINDOW_SAMPLES, 0.04, 440, 16000); // RMS ~0.028
  const silence = silencePcm16Frame(WINDOW_SAMPLES);
  const adaptiveEvents = [];
  const adaptive = new AdaptiveVad({ adaptive: true, sink: (e) => adaptiveEvents.push(e) });
  const fixedEvents = [];
  const fixed = new AdaptiveVad({ adaptive: false, sink: (e) => fixedEvents.push(e) });
  for (const vad of [adaptive, fixed]) {
    feedWindows(vad, noise, 100); // 2 s of room noise
  }
  assert.ok(adaptive.getThreshold() > 0.03, `adaptive threshold ${adaptive.getThreshold()}`);
  assert.ok(adaptive.getNoiseFloor() > 0.005, `noise floor ${adaptive.getNoiseFloor()}`);
  assert.equal(fixed.getThreshold(), 0.02);
  for (const vad of [adaptive, fixed]) {
    feedWindows(vad, quietSpeech, 30);
    feedWindows(vad, silence, 30);
  }
  // Quiet speech (RMS 0.028) is above the fixed threshold but below
  // the adapted one — the adaptive VAD stays silent.
  assert.equal(adaptiveEvents.filter((e) => e.kind === 'speech-start').length, 0);
  assert.equal(fixedEvents.filter((e) => e.kind === 'speech-start').length, 1);
  // ...while louder speech still trips the adaptive VAD.
  const loud = sinePcm16Frame(WINDOW_SAMPLES, 0.3, 440, 16000);
  feedWindows(adaptive, loud, 30);
  feedWindows(adaptive, silence, 30);
  assert.equal(adaptiveEvents.filter((e) => e.kind === 'speech-start').length, 1);
});

test('v106 vad: live reconfiguration validates and takes effect', () => {
  const { events, sink } = collectVadEvents();
  const vad = new AdaptiveVad({ sink });
  assert.deepEqual(validateVadV5Options({ baseThreshold: 0.5 }), ['baseThreshold must be a finite number 0.005..0.25.']);
  assert.deepEqual(validateVadV5Options({ hangoverMs: 10 }), ['hangoverMs must be a finite number 50..5000.']);
  assert.deepEqual(validateVadV5Options({ minTurnMs: 300, backchannelMaxMs: 100 }), [
    'minTurnMs must not exceed backchannelMaxMs (a burst cannot be both a turn and a backchannel).',
  ]);
  assert.deepEqual(validateVadV5Options({ hangoverMs: 200 }), []);
  assert.throws(() => vad.updateOptions({ baseThreshold: 0.5 }), /Invalid VAD options/);
  const updated = vad.updateOptions({ hangoverMs: 100, maxGapMs: 50 });
  assert.equal(updated.hangoverMs, 100);
  assert.equal(updated.maxGapMs, 50);
  assert.equal(vad.getOptions().hangoverMs, 100);
  // With a 100 ms hangover + 50 ms gap forgiveness, a turn ends
  // ~100 ms after the speech stops instead of ~420 ms.
  const speech = sinePcm16Frame(WINDOW_SAMPLES, 0.2, 440, 16000);
  const silence = silencePcm16Frame(WINDOW_SAMPLES);
  feedWindows(vad, speech, 20);
  feedWindows(vad, silence, 10);
  const end = events.find((e) => e.kind === 'speech-end');
  assert.ok(end, 'turn should have ended');
  assert.ok(end.durationMs >= 450 && end.durationMs <= 600, `duration ${end.durationMs}`);
  const defaults = defaultVadV5Options();
  assert.equal(defaults.adaptive, true);
  assert.equal(defaults.hangoverMs, 350);
  assert.throws(() => vad.feed(new Uint8Array([1])), /even-length PCM16/);
  assert.throws(() => new AdaptiveVad().feed(new Uint8Array(0)), /even-length PCM16/);
});

test('v106 vad: flush ends an open turn; reset clears it', () => {
  const { events, sink } = collectVadEvents();
  const vad = new AdaptiveVad({ sink });
  const speech = sinePcm16Frame(WINDOW_SAMPLES, 0.2, 440, 16000);
  feedWindows(vad, speech, 15);
  assert.equal(vad.isSpeaking(), true);
  const flushed = vad.flush();
  assert.equal(flushed.kind, 'speech-end');
  assert.equal(vad.isSpeaking(), false);
  assert.equal(vad.flush(), null);
  vad.reset();
  assert.equal(vad.getStats().turns, 0);
  assert.equal(vad.nowMs > 0, true);
});

// ---------------------------------------------------------------------------
// 3. Speaker diarization
// ---------------------------------------------------------------------------

test('v106 diarization: same tone = same speaker, different pitch = new speaker', () => {
  const session = new DiarizationSession();
  const tone440 = toneFrame(1, 0.2, 440);
  const tone180 = toneFrame(1, 0.2, 180);
  const emb440a = extractVoiceEmbedding(tone440);
  const emb440b = extractVoiceEmbedding(tone440);
  assert.equal(emb440a.length, DIARIZATION_EMBEDDING_SIZE);
  assert.equal(embeddingDistance(emb440a, emb440b), 0);
  const emb180 = extractVoiceEmbedding(tone180);
  const cross = embeddingDistance(emb440a, emb180);
  assert.ok(cross > 0.25, `cross-tone distance ${cross}`);
  assert.throws(() => embeddingDistance([1, 2], [1, 2, 3]), /length mismatch/);
  assert.throws(() => extractVoiceEmbedding(new Uint8Array([1])), /even-length PCM16/);

  const first = session.identify({ audio: tone440, startedAtMs: 0, endedAtMs: 1000 });
  assert.equal(first.speakerId, 'speaker-1');
  assert.equal(first.isNew, true);
  assert.ok(first.confidence > 0.9);
  const again = session.identify({ audio: tone440, startedAtMs: 2000, endedAtMs: 3000 });
  assert.equal(again.speakerId, 'speaker-1');
  assert.equal(again.isNew, false);
  assert.ok(again.distance < 0.05, `same-tone distance ${again.distance}`);
  const other = session.identify({ audio: tone180, startedAtMs: 4000, endedAtMs: 5000 });
  assert.equal(other.speakerId, 'speaker-2');
  assert.equal(other.isNew, true);
  assert.equal(session.listSpeakers().length, 2);
  // Most turns first.
  assert.equal(session.listSpeakers()[0].id, 'speaker-1');
  assert.equal(session.listSpeakers()[0].turns, 2);
  assert.equal(session.speakerLabel('speaker-1'), 'speaker-1');
  assert.equal(session.speakerLabel('speaker-99'), 'speaker-99');
});

test('v106 diarization: rename, merge, turns + text attach', () => {
  const session = new DiarizationSession();
  const a = session.identify({ audio: toneFrame(1, 0.2, 440), startedAtMs: 0, endedAtMs: 1000 });
  const b = session.identify({ audio: toneFrame(1, 0.2, 180), startedAtMs: 1000, endedAtMs: 2000 });
  const c = session.identify({ audio: toneFrame(1, 0.2, 300), startedAtMs: 2000, endedAtMs: 3000 });
  assert.equal(c.speakerId, 'speaker-3');
  assert.equal(session.renameSpeaker('speaker-99', 'Nobody'), false);
  assert.equal(session.renameSpeaker('speaker-1', '  '), false);
  assert.equal(session.renameSpeaker('speaker-1', 'Huy'), true);
  assert.equal(session.speakerLabel('speaker-1'), 'Huy');
  const turn = session.noteTurn({
    speakerId: a.speakerId,
    startedAtMs: 0,
    endedAtMs: 1000,
    matchDistance: a.distance,
    isNewSpeaker: true,
  });
  assert.equal(turn.index, 0);
  assert.equal(turn.speakerLabel, 'Huy');
  assert.equal(turn.text, '');
  assert.equal(session.attachText(99, 'nope'), null);
  const updated = session.attachText(0, 'xin chào');
  assert.equal(updated.text, 'xin chào');
  session.noteTurn({ speakerId: b.speakerId, startedAtMs: 1000, endedAtMs: 2000 });
  assert.equal(session.attachTextToLatest('chào bạn').text, 'chào bạn');
  assert.equal(session.attachTextToLatest('nobody left'), null);
  // Merge speaker-3 into speaker-2 (same person, split profile).
  assert.equal(session.mergeSpeakers('speaker-3', 'speaker-2'), true);
  assert.equal(session.mergeSpeakers('speaker-2', 'speaker-2'), false);
  assert.equal(session.mergeSpeakers('speaker-9', 'speaker-2'), false);
  const speakers = session.listSpeakers();
  assert.equal(speakers.length, 2);
  assert.equal(speakers.find((s) => s.id === 'speaker-2').turns, 2);
  const md = diarizedTranscriptMarkdown(session.getTranscript());
  assert.match(md, /Huy/);
  assert.match(md, /xin chào/);
  assert.match(md, /0\.0s/);
  assert.equal(diarizedTranscriptMarkdown([]), '_No transcript turns yet._');
});

test('v106 diarization: max speakers caps creation; JSON round-trip + file store', () => {
  const capped = new DiarizationSession({ maxSpeakers: 1 });
  capped.identify({ audio: toneFrame(1, 0.2, 440), startedAtMs: 0, endedAtMs: 1000 });
  const second = capped.identify({ audio: toneFrame(1, 0.2, 180), startedAtMs: 1000, endedAtMs: 2000 });
  assert.equal(second.speakerId, 'speaker-1', 'cap reached: nearest speaker reused');
  assert.equal(second.isNew, false);
  assert.ok(second.distance > 0.25);

  const session = new DiarizationSession();
  session.identify({ audio: toneFrame(1, 0.2, 440), startedAtMs: 0, endedAtMs: 1000 });
  session.renameSpeaker('speaker-1', 'Huy');
  session.noteTurn({ speakerId: 'speaker-1', text: 'xin chào', startedAtMs: 0, endedAtMs: 1000 });
  const json = session.toJSON();
  assert.equal(json.version, 1);
  const restored = DiarizationSession.fromJSON(json);
  assert.equal(restored.listSpeakers().length, 1);
  assert.equal(restored.speakerLabel('speaker-1'), 'Huy');
  assert.equal(restored.getTranscript()[0].text, 'xin chào');
  assert.equal(DiarizationSession.fromJSON(null).listSpeakers().length, 0);
  assert.equal(DiarizationSession.fromJSON({ speakers: [{ id: 'x' }] }).listSpeakers().length, 0);

  const dir = tmpDir('open-bot-voice-v106-speakers-');
  const store = new FileSpeakerProfileStore(dir);
  assert.equal(store.load('call-1'), null);
  store.save('call-1', session);
  const loaded = store.load('call-1');
  assert.ok(loaded);
  assert.equal(loaded.speakerLabel('speaker-1'), 'Huy');
  assert.equal(store.delete('call-1'), true);
  assert.equal(store.load('call-1'), null);
  assert.equal(store.delete('call-1'), false);
  // Corrupt file reads as "no session", not a crash.
  fs.writeFileSync(path.join(dir, 'bad.speakers.json'), '{not json', 'utf8');
  assert.equal(store.load('bad'), null);
});

// ---------------------------------------------------------------------------
// 4. Voice session v5 + manager
// ---------------------------------------------------------------------------

test('v106 session: two voices in one call become two speakers with a diarized transcript', () => {
  const events = [];
  const manager = new VoiceV5Manager();
  const session = manager.createSession('call-1', {
    language: 'vi',
    preferLocal: true,
    sink: (e) => events.push(e),
  });
  assert.equal(session.language, 'vi');
  assert.equal(session.route.lanes.find((l) => l.lane === 'stt').primary.costTier, 0);
  const speech440 = sinePcm16Frame(WINDOW_SAMPLES, 0.2, 440, 16000);
  const speech180 = sinePcm16Frame(WINDOW_SAMPLES, 0.2, 180, 16000);
  const silence = silencePcm16Frame(WINDOW_SAMPLES);
  feedToneWindows(session, 440, 30);
  feedAudioWindows(session, silence, 30);
  const notedTurn = session.noteTranscript('xin chào');
  assert.ok(notedTurn);
  assert.equal(notedTurn.text, 'xin chào');
  const turn0 = session.getTranscript()[0];
  assert.equal(turn0.text, 'xin chào');
  assert.equal(turn0.speakerId, 'speaker-1');
  feedToneWindows(session, 180, 30);
  feedAudioWindows(session, silence, 30);
  session.noteTranscript('chào bạn');
  const turns = session.getTranscript();
  assert.equal(turns.length, 2);
  assert.equal(turns[1].speakerId, 'speaker-2');
  assert.equal(turns[1].text, 'chào bạn');
  assert.notEqual(turns[0].speakerId, turns[1].speakerId);
  // A speaker-change event fired when the second voice arrived.
  assert.ok(events.some((e) => e.kind === 'speaker-change' && e.speakerId === 'speaker-2'));
  assert.ok(events.some((e) => e.kind === 'turn'));
  const speakers = session.listSpeakers();
  assert.equal(speakers.length, 2);
  assert.equal(session.renameSpeaker('speaker-1', 'Huy'), true);
  assert.equal(session.getTranscript()[0].speakerLabel, 'Huy');
  assert.match(session.getTranscriptMarkdown(), /Huy/);
  assert.match(session.getTranscriptMarkdown(), /xin chào/);
  const stats = session.getStats();
  assert.equal(stats.turns, 2);
  assert.equal(stats.speakers, 2);
  assert.equal(stats.sessionId, 'call-1');
  assert.ok(stats.totalSpeechMs > 1000);
  assert.match(session.toMarkdown(), /## Voice session call-1/);
  assert.match(session.toMarkdown(), /Voice route/);
});

test('v106 session: manager guards ids, duplicates, closed sessions; VAD reconfigures live', () => {
  const manager = new VoiceV5Manager();
  assert.throws(() => manager.createSession('bad id!'), /sessionId must match/);
  assert.throws(() => new VoiceSessionV5({ sessionId: '' }), /sessionId must match/);
  manager.createSession('a', {});
  assert.throws(() => manager.createSession('a', {}), /already exists/);
  assert.deepEqual(manager.listSessionIds(), ['a']);
  const session = manager.getSession('a');
  const report = session.getVadReport();
  assert.equal(typeof report.options.baseThreshold, 'number');
  assert.equal(typeof report.stats.threshold, 'number');
  const updated = session.configureVad({ hangoverMs: 100, maxGapMs: 50 });
  assert.equal(updated.hangoverMs, 100);
  assert.throws(() => session.configureVad({ hangoverMs: 1 }), /Invalid VAD options/);
  assert.equal(manager.getStats().sessions, 1);
  assert.equal(manager.stopSession('missing'), false);
  assert.equal(manager.stopSession('a'), true);
  assert.equal(manager.getSession('a'), undefined);
  assert.equal(manager.getStats().closedSessions, 1);
  assert.equal(session.isClosed(), true);
  assert.equal(session.noteTranscript('too late'), null);
  assert.throws(() => session.feedAudio(sinePcm16Frame(WINDOW_SAMPLES, 0.2, 440, 16000)), /closed/);
  // Routing through the manager honours a bot config.
  manager.getRouter().setBotConfig({ botId: 'bot-9', sttModel: 'whisper-local-tiny' });
  const routed = manager.route({ language: 'en' }, 'bot-9');
  assert.equal(routed.lanes.find((l) => l.lane === 'stt').primary.id, 'whisper-local-tiny');
  const plain = manager.route({ language: 'en' });
  assert.notEqual(plain.lanes.find((l) => l.lane === 'stt').primary.id, 'whisper-local-tiny');
});

// ---------------------------------------------------------------------------
// 5. Voice v5 tools
// ---------------------------------------------------------------------------

const CTX = { botId: 'bot-a', runId: 'run-1', workspaceDir: '' };

function makeV5Tools() {
  const manager = new VoiceV5Manager();
  const tools = createVoiceV5Tools({ getManager: () => manager });
  const byName = new Map(tools.map((t) => [t.definition.name, t]));
  return { manager, tools, byName };
}

async function runTool(byName, name, args, ctx = CTX) {
  const tool = byName.get(name);
  assert.ok(tool, `tool ${name} should exist`);
  const raw = await tool.execute(args, { ...ctx, workspaceDir: ctx.workspaceDir || '' });
  assert.equal(typeof raw, 'string');
  assert.ok(!raw.startsWith('Error:'), `tool ${name} failed: ${raw}`);
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

async function runToolRaw(byName, name, args, ctx = CTX) {
  const tool = byName.get(name);
  assert.ok(tool, `tool ${name} should exist`);
  return tool.execute(args, { ...ctx, workspaceDir: ctx.workspaceDir || '' });
}

test('v106 tools: 9 tools, unique names, placeholder shape, approval flags', async () => {
  assert.equal(VOICE_V5_TOOLS.length, 9);
  assert.deepEqual([...VOICE_V5_TOOL_NAMES], [
    'voice_v5_route',
    'voice_v5_router_config',
    'voice_v5_start_session',
    'voice_v5_stop_session',
    'voice_v5_vad_config',
    'voice_v5_list_speakers',
    'voice_v5_name_speaker',
    'voice_v5_note_turn',
    'voice_v5_transcript',
  ]);
  assert.equal(new Set(VOICE_V5_TOOL_NAMES).size, 9);
  assert.equal(isVoiceV5ToolName('voice_v5_route'), true);
  assert.equal(isVoiceV5ToolName('voice_v4_route'), false);
  const { tools } = makeV5Tools();
  assert.equal(tools.length, 9);
  assert.deepEqual(
    tools.map((t) => t.definition.name),
    [...VOICE_V5_TOOL_NAMES],
  );
  for (const tool of tools) {
    assert.equal(tool.definition.parameters.type, 'object');
    assert.equal(typeof tool.definition.description, 'string');
    assert.ok(tool.definition.description.length > 20, tool.definition.name);
    assert.equal(typeof tool.needsApproval, 'boolean');
  }
  const byName = new Map(tools.map((t) => [t.definition.name, t]));
  assert.equal(byName.get('voice_v5_router_config').needsApproval, true);
  assert.equal(byName.get('voice_v5_route').needsApproval, false);
  assert.equal(byName.get('voice_v5_transcript').needsApproval, false);
  // Unbound placeholders report the missing manager instead of crashing.
  const unbound = createVoiceV5Tools();
  const raw = await unbound[0].execute({ language: 'vi' }, CTX);
  assert.match(raw, /^Error: voice v5 manager is not available/);
});

test('v106 tools: route + router config end to end', async () => {
  const { byName } = makeV5Tools();
  const route = await runTool(byName, 'voice_v5_route', { language: 'vi', latencyClass: 'low', maxCostTier: 0 });
  assert.equal(route.language, 'vi');
  assert.equal(route.lanes.length, 3);
  for (const lane of route.lanes) assert.equal(lane.primaryCostTier, 0);
  assert.match(route.report, /## Voice route/);
  const badRoute = await runToolRaw(byName, 'voice_v5_route', { latencyClass: 'warp' });
  assert.match(badRoute, /^Error: latencyClass must be one of/);
  const badCost = await runToolRaw(byName, 'voice_v5_route', { maxCostTier: 9 });
  assert.match(badCost, /^Error: maxCostTier must be an integer/);

  const getEmpty = await runTool(byName, 'voice_v5_router_config', { botId: 'bot-1', action: 'get' });
  assert.match(getEmpty, /no stored router config/);
  const set = await runTool(byName, 'voice_v5_router_config', {
    botId: 'bot-1',
    action: 'set',
    sttModel: 'whisper-local-tiny',
    latencyClass: 'low',
    maxCostTier: 0,
  });
  assert.equal(set.sttModel, 'whisper-local-tiny');
  assert.equal(set.latencyClass, 'low');
  const get = await runTool(byName, 'voice_v5_router_config', { botId: 'bot-1' });
  assert.equal(get.sttModel, 'whisper-local-tiny');
  const badSet = await runToolRaw(byName, 'voice_v5_router_config', {
    botId: 'bot-1',
    action: 'set',
    sttModel: 'piper-local',
  });
  assert.match(badSet, /^Error:.*tts model/);
  const badAction = await runToolRaw(byName, 'voice_v5_router_config', { botId: 'bot-1', action: 'drop' });
  assert.match(badAction, /^Error: action must be/);
  // The stored config steers later routes for that bot.
  const routed = await runTool(byName, 'voice_v5_route', { language: 'vi', botId: 'bot-1' });
  assert.equal(routed.lanes.find((l) => l.lane === 'stt').primary, 'whisper-local-tiny');
  const reset = await runTool(byName, 'voice_v5_router_config', { botId: 'bot-1', action: 'reset' });
  assert.match(reset, /reset to defaults/);
  const resetAgain = await runTool(byName, 'voice_v5_router_config', { botId: 'bot-1', action: 'reset' });
  assert.match(resetAgain, /had no stored router config/);
});

test('v106 tools: full session flow — start, speak, name, transcript, stop', async () => {
  const { manager, byName } = makeV5Tools();
  const started = await runTool(byName, 'voice_v5_start_session', {
    sessionId: 'call-9',
    language: 'vi',
    preferLocal: true,
  });
  assert.equal(started.sessionId, 'call-9');
  assert.equal(started.status, 'started');
  assert.equal(started.route.lanes.find((l) => l.lane === 'stt').primaryCostTier, 0);
  const dup = await runToolRaw(byName, 'voice_v5_start_session', { sessionId: 'call-9' });
  assert.match(dup, /^Error:.*already exists/);
  const badId = await runToolRaw(byName, 'voice_v5_start_session', { sessionId: 'bad id!' });
  assert.match(badId, /^Error:.*sessionId must match/);

  const session = manager.getSession('call-9');
  const silence = silencePcm16Frame(WINDOW_SAMPLES);
  feedToneWindows(session, 440, 30);
  feedAudioWindows(session, silence, 30);
  feedToneWindows(session, 180, 30);
  feedAudioWindows(session, silence, 30);

  const speakers = await runTool(byName, 'voice_v5_list_speakers', { sessionId: 'call-9' });
  assert.equal(speakers.total, 2);
  assert.deepEqual(
    speakers.speakers.map((s) => s.id).sort(),
    ['speaker-1', 'speaker-2'],
  );
  const renamed = await runTool(byName, 'voice_v5_name_speaker', {
    sessionId: 'call-9',
    speakerId: 'speaker-1',
    displayName: 'Huy',
  });
  assert.match(renamed, /now "Huy"/);
  const badRename = await runToolRaw(byName, 'voice_v5_name_speaker', {
    sessionId: 'call-9',
    speakerId: 'speaker-9',
    displayName: 'Nobody',
  });
  assert.match(badRename, /^Error: Cannot rename/);
  const emptySpeakers = await runToolRaw(byName, 'voice_v5_list_speakers', { sessionId: 'nope' });
  assert.match(emptySpeakers, /^Error: Unknown voice v5 session/);

  const noted = await runTool(byName, 'voice_v5_note_turn', { sessionId: 'call-9', text: 'chào bạn' });
  assert.equal(noted.speakerId, 'speaker-2');
  assert.equal(noted.text, 'chào bạn');
  const noted2 = await runTool(byName, 'voice_v5_note_turn', { sessionId: 'call-9', text: 'xin chào' });
  assert.equal(noted2.speakerId, 'speaker-1');
  const noTurn = await runToolRaw(byName, 'voice_v5_note_turn', { sessionId: 'call-9', text: 'nobody left' });
  assert.match(noTurn, /^Error:.*no turn waiting for text/);

  const transcript = await runTool(byName, 'voice_v5_transcript', { sessionId: 'call-9' });
  assert.equal(transcript.total, 2);
  assert.equal(transcript.turns[0].speakerLabel, 'Huy');
  assert.equal(transcript.turns[0].text, 'xin chào');
  const md = await runTool(byName, 'voice_v5_transcript', { sessionId: 'call-9', format: 'markdown' });
  assert.match(md, /## Diarized transcript/);
  assert.match(md, /Huy/);
  const badFormat = await runToolRaw(byName, 'voice_v5_transcript', { sessionId: 'call-9', format: 'xml' });
  assert.match(badFormat, /^Error: format must be/);

  // VAD config: get reports the live threshold; set retunes it.
  const vadGet = await runTool(byName, 'voice_v5_vad_config', { sessionId: 'call-9' });
  assert.ok(typeof vadGet.options.baseThreshold === 'number');
  assert.ok(typeof vadGet.stats.threshold === 'number');
  assert.ok(typeof vadGet.stats.noiseFloor === 'number');
  const vadSet = await runTool(byName, 'voice_v5_vad_config', {
    sessionId: 'call-9',
    action: 'set',
    hangoverMs: 200,
  });
  assert.equal(vadSet.updated.hangoverMs, 200);
  const vadBad = await runToolRaw(byName, 'voice_v5_vad_config', {
    sessionId: 'call-9',
    action: 'set',
    hangoverMs: 1,
  });
  assert.match(vadBad, /^Error: hangoverMs must be/);
  const vadEmpty = await runToolRaw(byName, 'voice_v5_vad_config', { sessionId: 'call-9', action: 'set' });
  assert.match(vadEmpty, /^Error:.*at least one VAD option/);

  const stopped = await runTool(byName, 'voice_v5_stop_session', { sessionId: 'call-9' });
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.turns, 2);
  assert.equal(stopped.speakers, 2);
  const stoppedAgain = await runToolRaw(byName, 'voice_v5_stop_session', { sessionId: 'call-9' });
  assert.match(stoppedAgain, /^Error: Unknown voice v5 session/);
});

test('v106 registry: all 9 voice_v5 tools in defaultToolFactory, total 858', () => {
  const ws = tmpDir('open-bot-voice-v106-registry-');
  const mem = new BotMemory(ws);
  try {
    const tools = defaultToolFactory(mem, ws, 'bot-1');
    const names = tools.map((t) => t.definition.name);
    assert.equal(names.length, 1274, `expected 1200 tools, got ${names.length}`); // v1.14 T2: 820 + 8 mcpAppsV2 = 828; v1.13 merge: 769 + 51 = 820; v1.09 merge: 500 + 11 teams + 23 letta + 10 fleet_v6 + 10 voice_v8 + 2 a2a_v11 = 584 // v1.36 re-pin: factory 1274 (ALL_TOOLS 899 + 375).
    assert.equal(new Set(names).size, names.length, 'duplicate tool names in the agent registry');
    for (const name of VOICE_V5_TOOL_NAMES) {
      assert.ok(names.includes(name), `${name} must be registered`);
      assert.equal(names.filter((n) => n === name).length, 1, `${name} exactly once`);
    }
  } finally {
    mem.close();
  }
});

// ---------------------------------------------------------------------------
// 6. i18n
// ---------------------------------------------------------------------------

const V106_KEYS = [
  'voice.realtime.v5.title',
  'voice.realtime.v5.routerTitle',
  'voice.realtime.v5.routePrimary',
  'voice.realtime.v5.routeFallback',
  'voice.realtime.v5.routeReason',
  'voice.realtime.v5.vadTitle',
  'voice.realtime.v5.vadAdaptive',
  'voice.realtime.v5.vadThreshold',
  'voice.realtime.v5.vadNoiseFloor',
  'voice.realtime.v5.speakersTitle',
  'voice.realtime.v5.speakersEmpty',
  'voice.realtime.v5.speakerTurns',
  'voice.realtime.v5.transcriptTitle',
  'voice.realtime.v5.transcriptEmpty',
  'voice.realtime.v5.sessionStarted',
  'voice.realtime.v5.sessionStopped',
];

test('i18n: all 6 locales carry the 16 voice.realtime.v5.* keys', () => {
  for (const locale of ['en', 'vi', 'es', 'fr', 'ja', 'zh']) {
    const file = path.join(ROOT, 'apps', 'desktop', 'src', 'renderer', 'i18n', 'locales', `${locale}.json`);
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(Object.keys(json).length, 7540, `${locale} should have 6863 keys`); // v1.13: 4818 + 165 = 4983. 1.10 merge: 4089 + 264 keys = 4353; v1.11: 4353 + 212 v1.11 = 4565 // v1.36 re-pin: 7540.
    for (const key of V106_KEYS) {
      assert.ok(typeof json[key] === 'string' && json[key].length > 0, `${locale} must carry ${key}`);
    }
  }
  // Placeholders survive in every locale (the panel interpolates them).
  const en = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps', 'desktop', 'src', 'renderer', 'i18n', 'locales', 'en.json'), 'utf8'));
  assert.match(en['voice.realtime.v5.routePrimary'], /\{model\}/);
  assert.match(en['voice.realtime.v5.sessionStarted'], /\{id\}/);
  assert.match(en['voice.realtime.v5.speakerTurns'], /\{count\}/);
});

// ---------------------------------------------------------------------------
// 7. Session snapshot persistence
// ---------------------------------------------------------------------------

test('v106 session store: snapshot round-trip keeps route, speakers, transcript', () => {
  const dir = tmpDir('open-bot-voice-v106-sessions-');
  const store = new FileVoiceSessionV5Store(dir);
  assert.deepEqual(store.list(), []);
  assert.equal(store.load('missing'), null);
  assert.equal(store.loadSnapshot('missing'), null);

  const manager = new VoiceV5Manager();
  const session = manager.createSession('call-77', { language: 'vi', preferLocal: true });
  const silence = silencePcm16Frame(WINDOW_SAMPLES);
  feedToneWindows(session, 440, 30);
  feedAudioWindows(session, silence, 30);
  feedToneWindows(session, 180, 30);
  feedAudioWindows(session, silence, 30);
  session.noteTranscript('xin chào');
  session.noteTranscript('chào bạn');
  session.renameSpeaker('speaker-1', 'Huy');

  const snapshot = store.save(session);
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.sessionId, 'call-77');
  assert.equal(snapshot.language, 'vi');
  assert.equal(snapshot.speakers.length, 2);
  assert.equal(snapshot.turns.length, 2);
  assert.equal(snapshot.turns[0].text, 'chào bạn'); // attach is LIFO: latest turn without text first
  assert.ok(snapshot.savedAtMs > 0);

  const listed = store.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].sessionId, 'call-77');
  assert.equal(listed[0].turns, 2);
  assert.equal(listed[0].speakers, 2);

  const loadedSnapshot = store.loadSnapshot('call-77');
  assert.equal(loadedSnapshot.sessionId, 'call-77');
  assert.equal(loadedSnapshot.turns[1].text, 'xin chào');

  const restored = store.load('call-77');
  assert.ok(restored);
  assert.equal(restored.sessionId, 'call-77');
  assert.equal(restored.language, 'vi');
  assert.equal(restored.listSpeakers().length, 2);
  assert.equal(restored.listSpeakers().find((s) => s.id === 'speaker-1').displayName, 'Huy');
  assert.equal(restored.getTranscript().length, 2);
  assert.equal(restored.getTranscript()[0].text, 'chào bạn');
  assert.equal(restored.route.lanes.find((l) => l.lane === 'stt').primary.costTier, 0);
  // The restored session keeps working: a new voice joins it.
  feedToneWindows(restored, 300, 30);
  feedAudioWindows(restored, silence, 30);
  assert.equal(restored.getTranscript().length, 3);
  assert.equal(restored.listSpeakers().length, 3);

  // toSnapshot / fromSnapshot directly (no file).
  assert.equal(VoiceSessionV5.fromSnapshot(null), null);
  assert.equal(VoiceSessionV5.fromSnapshot({ version: 2, sessionId: 'x' }), null);
  assert.equal(VoiceSessionV5.fromSnapshot({ version: 1, sessionId: 'x' }), null);
  const direct = VoiceSessionV5.fromSnapshot(snapshot);
  assert.ok(direct);
  assert.equal(direct.getTranscript().length, 2);

  // Prune: nothing old yet; then age the file out.
  assert.equal(store.prune(30 * 24 * 60 * 60 * 1000), 0);
  assert.equal(store.prune(0, Date.now() + 1000), 1);
  assert.deepEqual(store.list(), []);
  assert.equal(store.load('call-77'), null);
  assert.equal(store.delete('call-77'), false);
  // A corrupt file lists as nothing and loads as null.
  fs.writeFileSync(path.join(dir, 'bad.v5.json'), '{broken', 'utf8');
  assert.deepEqual(store.list(), []);
  assert.equal(store.load('bad'), null);
});
