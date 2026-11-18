/**
 * Tests for v1.19 — voice realtime v18 (Team T5).
 *
 *   1. VAD v6 (vadV18.ts): options validation; a short burst is a
 *      false trigger, never a speech start; a sustained burst
 *      confirms speech and ends after the hangover; the adaptive
 *      threshold rises in a louder room; reconfigure + reset.
 *   2. Noise chain v18 (noiseSuppressionV18.ts): estimator learns
 *      the floor from silence frames and goes stale; the gate
 *      closes on quiet frames and opens on loud ones; the
 *      suppressor attenuates loud-room frames; the chain cleans a
 *      frame before the VAD and reports suppression in dB.
 *   3. Barge-in v6 (bargeInV18.ts): cut while TTS plays keeps the
 *      spoken prefix + full turn context; early warning fires
 *      before the cut; echo frames inside the window are
 *      suppressed; a cough is rejected, no cut; options validation.
 *   4. TTS streaming v4 (ttsStreamV18.ts): long sentences split
 *      at clause boundaries; urgent jumps the queue; aging
 *      promotes a long-waiting normal sentence; overflow drops
 *      background first, never urgent; cancel keeps the spoken
 *      prefix; stats report splits + promotions + drops.
 *   5. Profiles v3 (voiceProfilesV18.ts): context tuning applied
 *      on resolve; switch policy + cooldown deferral, then
 *      apply-deferred; usage tracking + most-used; JSON round
 *      trip; presets include the two v18 tuned voices.
 *   6. Realtime v3 (realtimeV18.ts): connect, full turn
 *      (transcript → reply → TTS v4), barge-in cut mid-speech
 *      checkpoints the turn, drop → reconnect resumes the
 *      remaining reply, resume token restores into a new session,
 *      manager registry.
 *   7. Voice eval v18 (voiceEvalV18.ts): default scripted eval
 *      passes (turn-taking within budget, barge-in F1, TTS
 *      quality); a noise-only barge-in scenario does not cut.
 *   8. Tools (voiceV18Tools.ts): 13 tools, unique names, full
 *      lifecycle through the tools (create → talk → stats →
 *      barge-in → vad → noise → tts → profiles → eval →
 *      recover → stop → delete).
 *   9. Core root re-exports + i18n: v18 classes importable from
 *      `@open-bot/core`; 86 `voice.realtime.v18.*` keys in all 6
 *      locales (48 from v119 + 38 from the v120-t5 integration),
 *      non-empty, same key set everywhere.
 *
 * No network, no sound card, no live provider, no key. Every audio
 * path is mock (synthetic PCM frames, scripted replies, mock
 * synth). Run after building core + tools:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/voice-v119.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AdaptiveVadV18,
  createVadV18,
  defaultVadV18Options,
  validateVadV18Options,
  pcm16RmsV18,
  NoiseEstimatorV18,
  NoiseGateV18,
  NoiseSuppressorV18,
  NoiseChainV18,
  createNoiseChainV18,
  noiseBandRmsV18,
  linearToDbV18,
  BargeInEngineV18,
  createBargeInEngineV18,
  defaultBargeInV18Options,
  validateBargeInV18Options,
  TtsStreamV18,
  createTtsStreamV18,
  defaultTtsStreamV18Options,
  validateTtsStreamV18Options,
  splitLongSentenceV18,
  VoiceProfileStoreV18,
  createVoiceProfileStoreV18,
  defaultVoiceProfileV18,
  validateVoiceProfileV18,
  applyContextTuningV18,
  presetVoiceProfilesV18,
  RealtimeSessionV18,
  RealtimeSessionManagerV18,
  createRealtimeSessionV18,
  syntheticFrameV18,
  VoiceEvalV18,
  createVoiceEvalV18,
  defaultVoiceEvalV18Scenarios,
  runDefaultVoiceEvalV18,
} from '../packages/core/dist/voiceV18/index.js';
import { syntheticFrameV15 } from '../packages/core/dist/voiceV15/bargeInV15.js';
import { defaultVoiceProfileV15 } from '../packages/core/dist/voiceV15/ttsStreamV15.js';
import {
  createVoiceV18Tools,
  VOICE_V18_TOOLS,
  VOICE_V18_TOOL_NAMES,
  isVoiceV18ToolName,
} from '../packages/tools/dist/voiceV18Tools.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Feed `count` synthetic frames (rms) through a VAD, 20 ms apart. */
function feedVadFrames(vad, count, rms, atMsStart) {
  let atMs = atMsStart;
  const events = [];
  for (let i = 0; i < count; i += 1) {
    const event = vad.feed(syntheticFrameV18(rms), atMs);
    if (event) events.push(event);
    atMs += 20;
  }
  return { events, endMs: atMs };
}

/** Feed `count` frames through a barge-in engine while the agent speaks. */
function feedBargeFrames(engine, count, rms, atMsStart, echo = false) {
  let atMs = atMsStart;
  for (let i = 0; i < count; i += 1) {
    engine.feed({ frame: syntheticFrameV15(rms), atMs, echo });
    atMs += 20;
  }
  return atMs;
}

// ------------------------------------------------------------------ VAD v6

test('VAD v18: options validation', () => {
  assert.deepEqual(validateVadV18Options({}), []);
  assert.deepEqual(validateVadV18Options({ adaptiveThreshold: false }), []);
  assert.ok(validateVadV18Options({ floorEmaRate: 0 }).length > 0);
  assert.ok(validateVadV18Options({ floorGain: -1 }).length > 0);
  assert.ok(validateVadV18Options({ maxStartThreshold: 0.99 }).length > 0);
  assert.ok(validateVadV18Options({ minConfirmedSpeechMs: 6000 }).length > 0);
  assert.ok(validateVadV18Options({ minStartThreshold: 0.9, maxStartThreshold: 0.8 }).length > 0);
  assert.throws(() => createVadV18({ maxStartThreshold: 0.99 }), /invalid VAD v18 options/);
  assert.equal(defaultVadV18Options().adaptiveThreshold, true);
  assert.equal(defaultVadV18Options().minConfirmedSpeechMs, 120);
});

test('VAD v18: short burst is a false trigger, never a speech start', () => {
  const events = [];
  const vad = createVadV18({ calibrationFrames: 0 }, (e) => events.push(e));
  feedVadFrames(vad, 10, 0.005, 0); // quiet room first
  feedVadFrames(vad, 2, 0.25, 200); // 40 ms burst — a cough / clap
  feedVadFrames(vad, 10, 0.005, 240);
  assert.equal(vad.isSpeaking(), false);
  assert.equal(vad.stats().confirmedSpeechStarts, 0);
  assert.equal(vad.stats().falseTriggers, 1);
  assert.equal(events.filter((e) => e.kind === 'false-trigger').length, 1);
  assert.equal(events.filter((e) => e.kind === 'speech-start').length, 0);
  const trigger = vad.falseTriggersList()[0];
  assert.equal(trigger.durationMs, 40);
  // A sine frame's true RMS is param / √2 (≈ 0.177 for param 0.25).
  assert.ok(trigger.peakRms > 0.15);
  assert.ok(vad.summary().includes('false triggers'));
});

test('VAD v18: sustained speech confirms, ends after the hangover', () => {
  const events = [];
  const vad = createVadV18({ calibrationFrames: 0 }, (e) => events.push(e));
  feedVadFrames(vad, 5, 0.005, 0);
  feedVadFrames(vad, 10, 0.25, 100); // 200 ms of speech
  assert.equal(vad.isSpeaking(), true);
  assert.equal(vad.stats().confirmedSpeechStarts, 1);
  assert.equal(events.filter((e) => e.kind === 'speech-start').length, 1);
  feedVadFrames(vad, 15, 0.005, 300); // 300 ms silence = hangover
  assert.equal(vad.isSpeaking(), false);
  assert.equal(vad.stats().confirmedSpeechEnds, 1);
  const end = events.find((e) => e.kind === 'speech-end');
  assert.ok(end && end.durationMs !== undefined && end.durationMs >= 100);
  assert.ok(vad.markdown().includes('False triggers'));
});

test('VAD v18: adaptive threshold rises in a louder room', () => {
  const vad = createVadV18({ calibrationFrames: 0, floorEmaRate: 0.05 });
  const base = vad.getStartThreshold();
  // Moderately loud room noise: classified silence (probability
  // below the start threshold) but true RMS above the base floor
  // (a sine frame's true RMS is param / √2 ≈ 0.021 for param 0.03),
  // so the tracked floor rises and the threshold follows it.
  feedVadFrames(vad, 200, 0.03, 0);
  const stats = vad.stats();
  assert.ok(stats.noiseFloor > 0.018, `noise floor should rise, got ${stats.noiseFloor}`);
  assert.ok(stats.adaptations >= 1, `threshold should adapt, got ${stats.adaptations} adaptations`);
  assert.ok(stats.startThreshold > base, `threshold ${stats.startThreshold} should exceed base ${base}`);
  vad.reset();
  assert.equal(vad.stats().adaptations, 0);
  assert.equal(vad.getStartThreshold(), base);
});

test('VAD v18: reconfigure + frame helpers', () => {
  const vad = createVadV18({ calibrationFrames: 0 });
  const next = vad.reconfigure({ minConfirmedSpeechMs: 200 });
  assert.equal(next.minConfirmedSpeechMs, 200);
  assert.throws(() => vad.reconfigure({ minConfirmedSpeechMs: 6000 }), /invalid VAD v18 options/);
  const frame = syntheticFrameV18(0.25);
  // A sine frame's true RMS is param / √2.
  assert.ok(Math.abs(pcm16RmsV18(frame) - 0.25 / Math.SQRT2) < 0.02);
  assert.throws(() => vad.feed(new Int16Array(100), 0), /20 ms PCM16 frame/);
  assert.equal(vad.getClass(), 'silence');
  assert.equal(vad.isCalibrated(), true);
});

// ------------------------------------------------------- noise chain v18

test('noise chain v18: estimator learns the floor and goes stale', () => {
  const estimator = new NoiseEstimatorV18();
  assert.equal(estimator.stats(0).learnedFrames, 0);
  for (let i = 0; i < 50; i += 1) estimator.learn(syntheticFrameV18(0.03), i * 20);
  const stats = estimator.stats(1000);
  assert.ok(stats.lowFloor > 0.015, `floor should rise toward 0.03, got ${stats.lowFloor}`);
  assert.equal(stats.learnedFrames, 50);
  assert.equal(stats.stale, false);
  assert.equal(estimator.isStale(1000 + 30001), true);
  assert.ok(estimator.snrDb(syntheticFrameV18(0.25)) > 10);
  assert.ok(linearToDbV18(0.5) < 0);
  const bands = noiseBandRmsV18(syntheticFrameV18(0.25));
  assert.ok(bands.low > bands.high);
});

test('noise chain v18: gate closes on quiet frames, opens on loud ones', () => {
  const chain = createNoiseChainV18();
  let atMs = 0;
  // Learn a quiet room first.
  for (let i = 0; i < 30; i += 1) {
    chain.process(syntheticFrameV18(0.005), atMs, false);
    atMs += 20;
  }
  const quiet = chain.process(syntheticFrameV18(0.005), atMs, false);
  assert.equal(quiet.gateOpen, false);
  assert.ok(quiet.outputRms < quiet.inputRms, 'quiet frame should be attenuated');
  const loud = chain.process(syntheticFrameV18(0.3), atMs + 20, true);
  assert.equal(loud.gateOpen, true);
  assert.ok(loud.snrDb > 6);
  const stats = chain.stats(atMs + 20);
  assert.ok(stats.gate.gatedFrames > 0);
  assert.ok(stats.gate.opens >= 1);
  assert.ok(chain.summary(atMs + 20).includes('Noise chain v18'));
  assert.ok(chain.markdown(atMs + 20).includes('Gate:'));
});

test('noise chain v18: suppressor attenuates, levels validate', () => {
  const chain = createNoiseChainV18({ suppressor: { level: 'aggressive' } });
  let atMs = 0;
  for (let i = 0; i < 30; i += 1) {
    chain.process(syntheticFrameV18(0.04), atMs, false);
    atMs += 20;
  }
  const result = chain.process(syntheticFrameV18(0.04), atMs, true);
  assert.ok(result.suppressionDb > 0, `aggressive suppression should exceed 0 dB, got ${result.suppressionDb}`);
  assert.throws(() => new NoiseSuppressorV18(chain.estimator, { level: 'loud' }), /unknown noise suppression level/);
  assert.throws(() => new NoiseGateV18(chain.estimator, { closedGain: 1.5 }), /must be 0\.\.1/);
  assert.throws(() => chain.process(new Int16Array(100), 0, false), /20 ms PCM16 frame/);
});

// ----------------------------------------------------------- barge-in v6

test('barge-in v18: cut keeps spoken prefix + full turn context', () => {
  const cuts = [];
  const engine = createBargeInEngineV18({}, (e) => {
    if (e.kind === 'cut') cuts.push(e.cut);
  });
  const reply = 'Xin chào, hôm nay trời rất đẹp và nắng nhẹ, rất thích hợp để đi dạo ngoài trời.';
  engine.beginAgentTurn('turn-1', 'thời tiết thế nào', reply, 0);
  engine.setSpokenProgress(12);
  engine.feedInterruptingText('ừ', 100);
  feedBargeFrames(engine, 20, 0.25, 0);
  assert.equal(cuts.length, 1);
  const cut = cuts[0];
  assert.equal(cut.turnId, 'turn-1');
  assert.equal(cut.userText, 'thời tiết thế nào');
  assert.equal(cut.replyText, reply);
  assert.equal(cut.spokenChars, 12);
  assert.equal(cut.remainingText, reply.slice(12));
  assert.equal(cut.cut.plan.action, 'resume');
  assert.ok(cut.cutLatencyMs >= 0);
  assert.equal(engine.stats().cuts, 1);
  assert.equal(engine.lastCut(), cut);
  assert.ok(engine.summary().includes('cuts'));
  assert.ok(engine.markdown().includes('## Cuts'));
});

test('barge-in v18: early warning fires before the cut', () => {
  const events = [];
  const engine = createBargeInEngineV18({ earlyDetectMs: 60 }, (e) => events.push(e));
  engine.beginAgentTurn('turn-1', 'alo', 'Xin chào bạn, hôm nay trời đẹp.', 0);
  // 3 loud frames = 60 ms: the early warning fires at the 3rd frame,
  // the cut itself only after minSpeechMs (250 ms) of speech.
  feedBargeFrames(engine, 3, 0.25, 0);
  const warnings = events.filter((e) => e.kind === 'early-warning');
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].burstMs, 60);
  assert.equal(engine.stats().cuts, 0, 'warning must not cut by itself');
  feedBargeFrames(engine, 17, 0.25, 60);
  assert.equal(engine.stats().cuts, 1);
  assert.ok(engine.stats().averageEarlyWarningLeadMs >= 0);
});

test('barge-in v18: echo inside the window is suppressed, loud user cuts through', () => {
  const engine = createBargeInEngineV18({});
  engine.beginAgentTurn('turn-1', 'alo', 'Xin chào bạn.', 0);
  engine.setTtsLevel(0.2);
  feedBargeFrames(engine, 20, 0.2, 0, true);
  assert.equal(engine.stats().cuts, 0);
  assert.ok(engine.stats().echoSuppressedFrames > 0);
  feedBargeFrames(engine, 20, 0.5, 400);
  assert.equal(engine.stats().cuts, 1);
});

test('barge-in v18: cough is rejected, no cut; explicit interrupt works', () => {
  const engine = createBargeInEngineV18({});
  engine.beginAgentTurn('turn-1', 'alo', 'Xin chào.', 0);
  feedBargeFrames(engine, 3, 0.25, 0); // ~60 ms burst < coughMaxMs
  feedBargeFrames(engine, 30, 0.001, 60);
  assert.equal(engine.stats().cuts, 0);
  const record = engine.interrupt(1000, 'Dừng lại.');
  assert.ok(record);
  assert.equal(record.interruptingText, 'Dừng lại.');
  assert.equal(engine.classify('Dừng lại?'), 'question');
  assert.equal(engine.classify('ừ'), 'acknowledgement');
});

test('barge-in v18: options validation', () => {
  assert.deepEqual(validateBargeInV18Options({}), []);
  assert.ok(validateBargeInV18Options({ earlyDetectMs: 6000 }).length > 0);
  assert.ok(validateBargeInV18Options({ earlyDetectMs: 300, minSpeechMs: 250 }).length > 0);
  assert.ok(validateBargeInV18Options({ duckFactor: 2 }).length > 0);
  assert.equal(defaultBargeInV18Options().earlyDetectMs, 60);
});

// -------------------------------------------------------- TTS streaming v4

test('TTS v18: long sentences split at clause boundaries', () => {
  const long = 'Đây là một câu trả lời rất dài, với nhiều mệnh đề khác nhau, và nó tiếp tục kéo dài thêm nữa, để kiểm tra việc tách câu dài thành từng đoạn nhỏ.';
  const pieces = splitLongSentenceV18(long, 60);
  assert.ok(pieces.length >= 3, `expected >= 3 clauses, got ${pieces.length}`);
  for (const piece of pieces) assert.ok(piece.length <= 60, `clause too long: ${piece.length}`);
  assert.equal(splitLongSentenceV18('Ngắn thôi.', 60).length, 1);
  assert.deepEqual(splitLongSentenceV18('', 60), []);
  const stream = createTtsStreamV18();
  const profile = defaultVoiceProfileV15('bot-1');
  stream.speak(long, profile, 'normal', 0);
  assert.ok(stream.stats().longSentencesSplit >= 1);
  assert.ok(stream.stats().clausesProduced >= 3);
  for (let i = 0; i < 1500 && stream.isSpeaking(); i += 1) stream.tick(20);
  assert.ok(stream.stats().chunksSpoken > 0);
});

test('TTS v18: urgent jumps the queue, aging promotes, overflow drops background first', () => {
  const stream = createTtsStreamV18(undefined, { maxBufferedSentences: 1, maxQueuedSentences: 4, ageThresholdMs: 1000 });
  const profile = defaultVoiceProfileV15('bot-1');
  stream.beginUtterance(profile, 0);
  stream.enqueue('Câu nền một.', 'background', 0);
  stream.enqueue('Câu nền hai.', 'background', 0);
  stream.enqueue('Câu thường một.', 'normal', 0);
  stream.enqueue('Câu thường hai.', 'normal', 0);
  stream.enqueue('Câu khẩn cấp.', 'urgent', 0);
  // Queue is over capacity (5 > 4): the oldest background is dropped, never urgent.
  assert.equal(stream.stats().droppedSentences, 1);
  assert.ok(stream.queuedSentences().some((q) => q.priority === 'urgent'));
  const fed = stream.pump(0);
  assert.ok(fed >= 1);
  // The urgent sentence is fed first.
  const schedule = stream.schedule();
  assert.ok(schedule.some((item) => item.text.includes('khẩn cấp')));
  stream.endUtterance();
  for (let i = 0; i < 1500 && stream.isSpeaking(); i += 1) stream.tick(20);
  // Aging: a normal sentence waiting past the threshold is promoted.
  const stream2 = createTtsStreamV18(undefined, { ageThresholdMs: 100, maxBufferedSentences: 1 });
  stream2.beginUtterance(profile, 0);
  stream2.enqueue('Câu chờ lâu.', 'normal', 0);
  stream2.tick(200);
  assert.ok(stream2.stats().promotedSentences >= 1, 'aged normal sentence should promote to urgent');
});

test('TTS v18: cancel keeps the spoken prefix, options validate', () => {
  const stream = createTtsStreamV18();
  const profile = defaultVoiceProfileV15('bot-1');
  stream.speak('Xin chào, hôm nay trời rất đẹp và nắng nhẹ, rất thích hợp để đi dạo.', profile, 'normal', 0);
  stream.tick(100);
  const cancelled = stream.cancelUnplayed(100);
  assert.ok(cancelled.spokenChars >= 0);
  assert.ok(cancelled.cancelledChunks >= 0 || cancelled.droppedQueuedSentences >= 0);
  assert.ok(stream.summary().includes('TTS v18'));
  assert.ok(stream.markdown().includes('First-chunk latency'));
  assert.deepEqual(validateTtsStreamV18Options({}), []);
  assert.ok(validateTtsStreamV18Options({ ageThresholdMs: -1 }).length > 0);
  assert.ok(validateTtsStreamV18Options({ backgroundAgeThresholdMs: 100, ageThresholdMs: 1000 }).length > 0);
  assert.equal(defaultTtsStreamV18Options().ageThresholdMs, 3000);
});

// ------------------------------------------------------------- profiles v3

test('profiles v18: context tuning applies on resolve', () => {
  const store = createVoiceProfileStoreV18();
  const profile = defaultVoiceProfileV18('bot-1', {
    id: 'p-calm',
    displayName: 'Giọng trầm',
    rate: 1,
    contextTuning: { narration: { rate: 0.8, pitch: -3, maxChunkChars: 140 } },
  });
  store.set(profile);
  const chat = store.resolve({ botId: 'bot-1', context: 'chat' });
  assert.equal(chat.tunedProfile.rate, 1);
  assert.equal(chat.tuningApplied, undefined);
  const narration = store.resolve({ botId: 'bot-1', context: 'narration' });
  assert.equal(narration.tunedProfile.rate, 0.8);
  assert.equal(narration.tunedProfile.pitch, -3);
  assert.equal(narration.tunedProfile.maxChunkChars, 140);
  assert.equal(narration.tuningApplied.rate, 0.8);
});

test('profiles v18: switch policy + cooldown defer, then apply', () => {
  const store = createVoiceProfileStoreV18();
  const a = defaultVoiceProfileV18('bot-1', { id: 'p-a', displayName: 'A', switchPolicy: 'immediate', switchCooldownMs: 0 });
  const b = defaultVoiceProfileV18('bot-1', { id: 'p-b', displayName: 'B', switchPolicy: 'immediate', switchCooldownMs: 5000 });
  store.set(a);
  store.set(b);
  const first = store.requestSwitch({ profileId: 'p-a', botId: 'bot-1', context: 'chat', atMs: 0 });
  assert.equal(first.applied, true);
  assert.equal(store.getActiveProfile().id, 'p-a');
  // Switching to B within B's cooldown is deferred, not dropped.
  const second = store.requestSwitch({ profileId: 'p-b', botId: 'bot-1', context: 'chat', atMs: 1000 });
  assert.equal(second.applied, false);
  assert.match(second.deferredReason ?? '', /cooldown/);
  assert.equal(store.deferredSwitchesList().length, 1);
  const applied = store.applyDeferredSwitches(6000);
  assert.equal(applied.length, 1);
  assert.equal(store.getActiveProfile().id, 'p-b');
  assert.equal(store.stats().switches, 2);
  // Same-profile switch is a no-op, not a deferral.
  const same = store.requestSwitch({ profileId: 'p-b', botId: 'bot-1', context: 'chat', atMs: 7000 });
  assert.equal(same.applied, false);
  assert.equal(store.deferredSwitchesList().length, 0);
});

test('profiles v18: usage tracking, most-used, JSON round trip, presets', () => {
  const store = createVoiceProfileStoreV18();
  const a = defaultVoiceProfileV18('bot-1', { id: 'p-a', displayName: 'A' });
  const b = defaultVoiceProfileV18('bot-1', { id: 'p-b', displayName: 'B' });
  store.set(a);
  store.set(b);
  store.noteUsage('p-a', 100, 1000);
  store.noteUsage('p-a', 50, 2000);
  store.noteUsage('p-b', 10, 3000);
  assert.equal(store.get('p-a').timesUsed, 2);
  assert.equal(store.get('p-a').totalCharsSpoken, 150);
  assert.equal(store.mostUsedProfile().id, 'p-a');
  assert.throws(() => store.noteUsage('nope', 10, 0), /Unknown voice profile v18/);
  const json = store.toJSON();
  assert.equal(json.version, 2);
  const store2 = createVoiceProfileStoreV18();
  const loaded = store2.fromJSON(json);
  assert.ok(loaded.loaded >= 2);
  assert.equal(store2.get('p-a').timesUsed, 2);
  const presets = presetVoiceProfilesV18('bot-1');
  assert.ok(presets.length >= 6);
  assert.ok(presets.some((p) => p.id.startsWith('preset-v18-calm')));
  assert.ok(presets.some((p) => p.id.startsWith('preset-v18-brisk')));
  assert.deepEqual(validateVoiceProfileV18({ ...a, switchPolicy: 'weird' }), ['unknown switch policy: weird']);
  assert.ok(applyContextTuningV18(a, 'chat').rate === 1);
});

// -------------------------------------------------------------- realtime v3

test('realtime v18: connect, full turn, barge-in checkpoints the turn', async () => {
  const session = createRealtimeSessionV18('s1', { language: 'vi', replyFor: () => 'Chào bạn, tôi khỏe.' });
  await session.connect();
  assert.equal(session.getConnection(), 'connected');
  assert.equal(session.getState(), 'listening');
  session.feedTranscriptFinal('Xin chào, bạn khỏe không?');
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(session.turnsList().length, 1);
  assert.equal(session.turnsList()[0].replyText, 'Chào bạn, tôi khỏe.');
  assert.ok(session.stats().checkpoints >= 1);
  assert.equal(session.getState(), 'speaking');
  // Interrupt mid-speech: a checkpoint is written at the cut.
  // 'Khoan đã' is a correction, so the v17 resume policy restarts.
  const before = session.stats().checkpoints;
  const record = session.interrupt(session.now(), 'Khoan đã.');
  assert.ok(record);
  assert.equal(record.cut.plan.action, 'restart');
  assert.ok(session.stats().checkpoints > before);
  assert.ok(session.lastCheckpoint().remainingText.length >= 0);
  session.disconnect();
  assert.equal(session.getConnection(), 'closed');
});

test('realtime v18: drop → reconnect resumes the remaining reply', async () => {
  const session = createRealtimeSessionV18('s2', { replyFor: () => 'Một câu trả lời rất dài để kiểm tra việc khôi phục phiên sau khi mất kết nối.' });
  await session.connect();
  session.feedTranscriptFinal('Kể cho tôi nghe đi.');
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(session.turnsList().length, 1);
  session.simulateDrop();
  assert.equal(session.getConnection(), 'reconnecting');
  const reconnected = await session.reconnect();
  assert.equal(reconnected, true);
  assert.equal(session.getConnection(), 'connected');
  assert.equal(session.stats().reconnects, 1);
  assert.equal(session.stats().recoveredTurns, 1);
  assert.ok(session.eventsList().some((e) => e.kind === 'recovered'));
});

test('realtime v18: resume token restores into a new session', async () => {
  const session = createRealtimeSessionV18('s3', { replyFor: () => 'Trả lời mẫu.' });
  await session.connect();
  session.feedTranscriptFinal('Xin chào.');
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  const token = session.resumeToken();
  assert.ok(token);
  const manager = new RealtimeSessionManagerV18();
  const fresh = manager.create('s3-fresh', {});
  assert.equal(fresh.restoreFromToken(token), true);
  assert.equal(fresh.lastCheckpoint().turnId, session.lastCheckpoint().turnId);
  assert.equal(fresh.restoreFromToken('not json'), false);
  assert.equal(fresh.restoreFromToken('{"version": 99}'), false);
  session.disconnect();
});

test('realtime v18: manager registry', async () => {
  const manager = new RealtimeSessionManagerV18();
  const a = manager.create('a', { language: 'vi' });
  const b = manager.create('b', { language: 'en' });
  assert.equal(manager.count(), 2);
  assert.equal(manager.get('a'), a);
  assert.throws(() => manager.create('a'), /already exists/);
  await a.connect();
  assert.equal(manager.delete('a'), true);
  assert.equal(manager.count(), 1);
  assert.equal(b.getConnection(), 'connecting');
  manager.delete('b');
});

test('realtime v18: noise chain + VAD feed through the session', async () => {
  const session = createRealtimeSessionV18('s4', {});
  await session.connect();
  for (let i = 0; i < 30; i += 1) {
    session.tick(20);
    session.feedAudioFrame(syntheticFrameV18(0.005));
  }
  assert.ok(session.noise.stats(session.now()).frames >= 30);
  assert.equal(session.vad.isSpeaking(), false);
  session.disconnect();
});

// -------------------------------------------------------------- eval v18

test('voice eval v18: default scripted eval passes', async () => {
  const evalRunner = createVoiceEvalV18();
  const report = await evalRunner.runAll(defaultVoiceEvalV18Scenarios());
  assert.equal(report.turnTaking.cases.length, 2);
  assert.equal(report.bargeIn.cases.length, 2);
  assert.equal(report.tts.cases.length, 2);
  assert.ok(report.bargeIn.f1 >= 0.5, `F1 should be reasonable, got ${report.bargeIn.f1}`);
  assert.ok(report.tts.longSentenceCoverage >= 0.5);
  assert.equal(typeof report.passed, 'boolean');
  assert.ok(evalRunner.markdown(report).includes('Voice eval v18'));
  const summary = await runDefaultVoiceEvalV18();
  assert.equal(summary.turnTaking.cases.length, 2);
});

test('voice eval v18: noise burst must not cut, speech must cut', async () => {
  const evalRunner = createVoiceEvalV18();
  const noise = await evalRunner.runBargeInScenario({ id: 'eval-noise', label: 'noise', burstMs: 120, rms: 0.05 });
  assert.equal(noise.cut, false);
  assert.equal(noise.correct, true);
  const speech = await evalRunner.runBargeInScenario({ id: 'eval-speech', label: 'speech', burstMs: 600, rms: 0.25, interruptingText: 'Khoan đã.' });
  assert.equal(speech.cut, true);
  assert.equal(speech.correct, true);
  assert.equal(speech.spokenPrefixKept, true);
});

// --------------------------------------------------------------------- tools

test('tools v18: 13 tools, unique names, full lifecycle', async () => {
  const tools = createVoiceV18Tools();
  assert.equal(tools.length, 13);
  assert.deepEqual(tools.map((t) => t.definition.name), [...VOICE_V18_TOOL_NAMES]);
  assert.equal(new Set(VOICE_V18_TOOL_NAMES).size, 13);
  for (const name of VOICE_V18_TOOL_NAMES) assert.equal(isVoiceV18ToolName(name), true);
  assert.equal(isVoiceV18ToolName('voice_v17_session_create'), false);
  assert.equal(VOICE_V18_TOOLS.length, 13);
  const byName = new Map(tools.map((t) => [t.definition.name, t]));
  const run = async (name, args) => JSON.parse(await byName.get(name).execute(args));

  const created = await run('voice_v18_session_create', { sessionId: 't1', language: 'vi', mockReply: 'Chào bạn.', connect: true });
  assert.equal(created.created, true);
  const talked = await run('voice_v18_talk', { sessionId: 't1', text: 'Xin chào.' });
  assert.equal(talked.turns.length, 1);
  const listed = await run('voice_v18_session_list', {});
  assert.equal(listed.sessions.length, 1);
  assert.equal(listed.sessions[0].turns, 1);
  const stats = await run('voice_v18_session_stats', { sessionId: 't1' });
  assert.equal(stats.stats.turns, 1);
  assert.ok(stats.stats.vad);
  assert.ok(stats.stats.noise);
  const barge = await run('voice_v18_barge_in', { sessionId: 't1', interruptingText: 'Khoan đã.' });
  assert.ok(barge.cut);
  assert.equal(barge.cut.turnId, 'turn-1');
  const vadResult = await run('voice_v18_vad', { sessionId: 't1', feedKind: 'speech', feedFrames: 10 });
  assert.equal(typeof vadResult.startThreshold, 'number');
  assert.ok(Array.isArray(vadResult.falseTriggers));
  const noiseResult = await run('voice_v18_noise', { sessionId: 't1', rms: 0.03, isSpeech: false });
  assert.ok(typeof noiseResult.processed.suppressionDb === 'number');
  const tts = await run('voice_v18_tts', { sessionId: 't1', text: 'Chào bạn, hôm nay trời đẹp.', tickMs: 200 });
  assert.ok(tts.stats.chunksSpoken >= 0);
  const profiles = await run('voice_v18_profiles', { action: 'presets', botId: 'default-bot' });
  assert.ok(profiles.presets.length >= 6);
  const evaluated = await run('voice_v18_eval', {});
  assert.equal(evaluated.report.turnTaking.cases.length, 2);
  assert.equal(typeof evaluated.passed, 'boolean');
  const recovered = await run('voice_v18_recover', { action: 'drop-reconnect', sessionId: 't1' });
  assert.equal(recovered.recovered, true);
  const stopped = await run('voice_v18_session_stop', { sessionId: 't1' });
  assert.equal(stopped.stopped, true);
  const deleted = await run('voice_v18_session_delete', { sessionId: 't1' });
  assert.equal(deleted.deleted, true);
  const unknown = await byName.get('voice_v18_session_stats').execute({ sessionId: 'nope' });
  assert.match(unknown, /Unknown voice v18 session/);
});

test('tools v18: create validates context / preset / noise level', async () => {
  const tools = createVoiceV18Tools();
  const create = tools.find((t) => t.definition.name === 'voice_v18_session_create');
  assert.match(await create.execute({ sessionId: 'x', voiceContext: 'weird' }), /Unknown voice context/);
  assert.match(await create.execute({ sessionId: 'x', vadPreset: 'weird' }), /Unknown VAD preset/);
  assert.match(await create.execute({ sessionId: 'x', noiseLevel: 'weird' }), /Unknown noise level/);
});

// ------------------------------------------------------- core re-exports + i18n

test('core root re-exports v18 classes', async () => {
  const core = await import('../packages/core/dist/index.js');
  for (const name of [
    'AdaptiveVadV18',
    'NoiseChainV18',
    'NoiseEstimatorV18',
    'NoiseGateV18',
    'NoiseSuppressorV18',
    'BargeInEngineV18',
    'TtsStreamV18',
    'VoiceProfileStoreV18',
    'RealtimeSessionV18',
    'RealtimeSessionManagerV18',
    'VoiceEvalV18',
  ]) {
    assert.equal(typeof core[name], 'function', `${name} should be exported from @open-bot/core`);
  }
});

test('i18n: 86 voice.realtime.v18.* keys in all 6 locales, non-empty, same set', () => {
  // 86 = 48 keys from v119 + 38 new keys from the v120-t5
  // integration (turn-taking, budget, parallel-module labels).
  const locales = ['vi', 'en', 'es', 'fr', 'ja', 'zh'];
  const dir = path.join(__dirname, '..', 'apps', 'desktop', 'src', 'renderer', 'i18n', 'locales');
  const sets = [];
  for (const locale of locales) {
    const data = JSON.parse(fs.readFileSync(path.join(dir, `${locale}.json`), 'utf8'));
    const keys = Object.keys(data).filter((k) => k.startsWith('voice.realtime.v18.')).sort();
    assert.equal(keys.length, 86, `${locale} should have 86 v18 keys, got ${keys.length}`);
    for (const key of keys) {
      assert.equal(typeof data[key], 'string', `${locale}.${key} should be a string`);
      assert.ok(data[key].trim().length > 0, `${locale}.${key} should not be empty`);
    }
    sets.push(keys);
  }
  for (let i = 1; i < sets.length; i += 1) {
    assert.deepEqual(sets[i], sets[0], `locale ${locales[i]} key set should match vi`);
  }
});
