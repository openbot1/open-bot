/**
 * Tests for v1.16 — voice realtime v15 (Team T5).
 *
 *   1. Speech-to-speech (s2sV15.ts): mock transport + OpenAI/Gemini
 *      wire shapes, state machine, reconnect backoff, failure →
 *      fallback, function calls mid-conversation, PCM16 24 kHz
 *      frame validation, transcript accumulation.
 *   2. Latency pipeline v3 (pipelineV15.ts): per-stage budgets,
 *      warn/critical alerts, e2e budget + broken threshold,
 *      percentiles, auto-degrade / auto-recover ladder, session
 *      report + markdown.
 *   3. Barge-in v3 (bargeInV15.ts): energy gate, min-speech /
 *      min-silence, cough / breath / noise / echo / cooldown
 *      rejection, cancel scope + cut receipt.
 *   4. Semantic turn-taking v3 (smartTurnV15.ts): weighted
 *      rule-based scoring in vi + en, trailing conjunctions, open
 *      vs closed questions, filler-only, backchannels, detector
 *      hold/release + false-end saves.
 *   5. TTS streaming v3 (ttsStreamV15.ts): chunking, per-bot voice
 *      profiles, first-audio latency, mid-stream cancellation +
 *      remaining text.
 *   6. Wake word v3 (wakeWordV15.ts): multi-word, sensitivity
 *      thresholds, near-miss / low-energy / cooldown suppression,
 *      confirmation window + expiry, labelled-set evaluation.
 *   7. Provider registry v2 (providerRegistryV15.ts): plugin
 *      registration + validation, health gating, pick by goal,
 *      STT+TTS pair + hourly cost.
 *   8. Session v15 (sessionV15.ts): S2S connect, pipeline fallback,
 *      full turn (transcript → reply → TTS), barge-in cut while
 *      speaking, wake-word gating from asleep, manager registry.
 *   9. Tools (voiceV15Tools.ts): 10 tools, unique names, full
 *      lifecycle through the tools (create → talk → stats →
 *      barge-in → latency → wake-word → provider → stop → delete).
 *  10. Core root re-exports + i18n: v15 classes importable from
 *      `@open-bot/core`; 48 `voice.realtime.v15.*` keys in all 6
 *      locales, non-empty, same key set everywhere.
 *
 * No network, no sound card, no live provider, no key. Every audio
 * path is mock (synthetic PCM frames, scripted S2S events, mock
 * synth, scripted replies). Run after building core + tools:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/voice-v116.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  S2SAdapterV15,
  MockS2STransportV15,
  s2sReconnectDelayV15,
  validateS2SAdapterOptionsV15,
  S2S_V15_FRAME_SAMPLES,
  LatencyPipelineV15,
  percentileV15,
  pipelineQualityPolicyV15,
  defaultPipelineBudgetsV15,
  BargeInDetectorV15,
  BargeInEngineV15,
  frameRmsV15,
  syntheticFrameV15,
  SmartTurnDetectorV15,
  scoreTurnCompletenessV15,
  detectSmartTurnLanguageV15,
  sensitivityPresetV15,
  TtsStreamV15,
  VoiceProfileStoreV15,
  chunkTtsTextV15,
  defaultVoiceProfileV15,
  validateVoiceProfileV15,
  WakeWordDetectorV15,
  wakeWordSimilarityV15,
  levenshteinV15,
  sensitivityThresholdV15,
  VoiceProviderRegistryV15,
  scoreVoiceProviderV15,
  VoiceSessionV15,
  VoiceSessionManagerV15,
} from '../packages/core/dist/voiceV15/index.js';
import {
  createVoiceV15Tools,
  VOICE_V15_TOOLS,
  VOICE_V15_TOOL_NAMES,
  isVoiceV15ToolName,
} from '../packages/tools/dist/voiceV15Tools.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function collectEvents() {
  const events = [];
  return { events, sink: (e) => events.push(e) };
}

function feedSpeechFrames(detector, count, startMs = 0, rms = 0.06) {
  const fired = [];
  for (let i = 0; i < count; i += 1) {
    const event = detector.feed({ frame: syntheticFrameV15(rms), atMs: startMs + i * 20 });
    if (event) fired.push(event);
  }
  return fired;
}

function feedSilenceFrames(detector, count, startMs = 0) {
  const fired = [];
  for (let i = 0; i < count; i += 1) {
    const event = detector.feed({ frame: syntheticFrameV15(0.005), atMs: startMs + i * 20 });
    if (event) fired.push(event);
  }
  return fired;
}

// ---------------------------------------------------------------- S2S ---

test('v15 s2s: mock connect sends a session.update and reaches connected', async () => {
  const { events, sink } = collectEvents();
  const transport = new MockS2STransportV15('mock', { connectDelayMs: 10 });
  const adapter = new S2SAdapterV15(transport, { provider: 'mock', model: 'gpt-realtime' }, sink);
  assert.equal(adapter.getState(), 'idle');
  await adapter.connect();
  assert.equal(adapter.getState(), 'connected');
  const updates = transport.sentJson().filter((m) => m.type === 'session.update');
  assert.equal(updates.length, 1);
  assert.equal(updates[0].session.input_audio_format, 'pcm16');
  assert.equal(updates[0].session.output_audio_format, 'pcm16');
  assert.equal(adapter.stats().connectAttempts, 1);
  assert.ok(adapter.summary().includes('connected'));
  assert.ok(adapter.markdown().includes('Speech-to-speech v15'));
});

test('v15 s2s: Gemini Live shapes a setup message, OpenAI shapes session.update', () => {
  const gemini = new MockS2STransportV15('gemini-live');
  const geminiAdapter = new S2SAdapterV15(gemini, { provider: 'gemini-live' }, () => {});
  assert.equal(geminiAdapter.shapeSessionUpdate().type, 'setup');
  assert.deepEqual(geminiAdapter.shapeResponseCancel(), { type: 'cancel' });
  const openai = new MockS2STransportV15('openai-realtime');
  const openaiAdapter = new S2SAdapterV15(openai, { provider: 'openai-realtime' }, () => {});
  assert.equal(openaiAdapter.shapeSessionUpdate().type, 'session.update');
  assert.deepEqual(openaiAdapter.shapeResponseCancel(), { type: 'response.cancel' });
  const result = openaiAdapter.shapeFunctionResult('call_1', 'ok');
  assert.equal(result.item.call_id, 'call_1');
});

test('v15 s2s: reconnect backoff is exponential and capped', () => {
  const options = { provider: 'mock', baseReconnectDelayMs: 250, reconnectBackoffMultiplier: 2, maxReconnectDelayMs: 8000 };
  assert.equal(s2sReconnectDelayV15(options, 0), 250);
  assert.equal(s2sReconnectDelayV15(options, 1), 500);
  assert.equal(s2sReconnectDelayV15(options, 2), 1000);
  assert.equal(s2sReconnectDelayV15(options, 10), 8000);
  assert.deepEqual(validateS2SAdapterOptionsV15({ provider: 'nope' }), ['unknown provider: nope']);
  assert.deepEqual(validateS2SAdapterOptionsV15({ provider: 'mock', maxReconnectAttempts: 99 }), ['maxReconnectAttempts must be 0..20']);
});

test('v15 s2s: one failed connect reconnects and succeeds', async () => {
  const { events, sink } = collectEvents();
  const transport = new MockS2STransportV15('mock', { failNextConnectWith: 'boom' });
  const adapter = new S2SAdapterV15(transport, { provider: 'mock', maxReconnectAttempts: 3 }, sink);
  await adapter.connect();
  assert.equal(adapter.getState(), 'reconnecting');
  assert.equal(adapter.stats().reconnects, 1);
  adapter.tick(250);
  await flush();
  assert.equal(adapter.getState(), 'connected');
  assert.equal(adapter.stats().connectAttempts, 2);
  assert.ok(events.some((e) => e.kind === 'error' && /reconnecting/.test(e.message ?? '')));
});

test('v15 s2s: exhausted reconnects go failed and ask for pipeline fallback', async () => {
  const failing = {
    kind: 'mock',
    onEvent: null,
    connect: async () => { throw new Error('no network'); },
    disconnect: () => {},
    isConnected: () => false,
    sendJson: () => {},
    sendAudio: () => {},
    tick: () => {},
    sentJson: () => [],
    sentAudioFrames: () => [],
  };
  const { events, sink } = collectEvents();
  const adapter = new S2SAdapterV15(failing, { provider: 'mock', maxReconnectAttempts: 0 }, sink);
  await adapter.connect();
  assert.equal(adapter.getState(), 'failed');
  assert.deepEqual(adapter.shouldFallbackToPipeline(), { fallback: true, reason: 'no network' });
  assert.ok(events.some((e) => e.kind === 'fallback'));
  assert.equal(adapter.stats().fallbacks, 1);
});

test('v15 s2s: scripted transcript + function call mid-conversation', async () => {
  const { events, sink } = collectEvents();
  const transport = new MockS2STransportV15('mock', {
    script: [
      { atMs: 50, kind: 'transcript-partial', text: 'xin chào', speaker: 'user' },
      { atMs: 100, kind: 'transcript-final', text: 'xin chào bạn', speaker: 'user' },
      { atMs: 150, kind: 'function-call', callName: 'get_weather', callArgs: { city: 'Hà Nội' } },
      { atMs: 200, kind: 'audio', audioSamples: 480 },
      { atMs: 250, kind: 'transcript-final', text: 'Trời Hà Nội hôm nay nắng.', speaker: 'agent' },
    ],
  });
  const adapter = new S2SAdapterV15(transport, { provider: 'mock', tools: ['get_weather'] }, sink);
  adapter.registerFunction('get_weather', (call) => `sunny in ${call.args.city}`);
  await adapter.connect();
  adapter.tick(300);
  await flush();
  assert.equal(adapter.userTranscriptText(), 'xin chào bạn');
  assert.equal(adapter.agentTranscriptText(), 'Trời Hà Nội hôm nay nắng.');
  assert.equal(adapter.stats().functionCalls, 1);
  assert.equal(adapter.stats().functionResults, 1);
  assert.equal(adapter.stats().audioChunksReceived, 1);
  const results = transport.sentJson().filter((m) => m.type === 'conversation.item.create' && m.item.type === 'function_call_output');
  assert.equal(results.length, 1);
  assert.match(results[0].item.output, /sunny in Hà Nội/);
  assert.ok(events.some((e) => e.kind === 'function-result'));
});

test('v15 s2s: audio frames must be exactly 20 ms @ 24 kHz', async () => {
  const adapter = new S2SAdapterV15(new MockS2STransportV15('mock'), { provider: 'mock' }, () => {});
  await adapter.connect();
  assert.throws(() => adapter.sendAudioFrame(new Int16Array(100)), /480 samples/);
  adapter.sendAudioFrame(new Int16Array(S2S_V15_FRAME_SAMPLES));
  assert.equal(adapter.stats().audioFramesSent, 1);
  adapter.disconnect();
  assert.equal(adapter.getState(), 'closed');
  // Sending while closed is a silent no-op, not a crash.
  adapter.sendAudioFrame(new Int16Array(S2S_V15_FRAME_SAMPLES));
  assert.equal(adapter.stats().audioFramesSent, 1);
});

// ------------------------------------------------------------- pipeline ---

test('v15 pipeline: in-budget turns are compliant with no alerts', () => {
  const pipeline = new LatencyPipelineV15();
  pipeline.recordTurn({ turnId: 't1', endToEndMs: 320, atMs: 0, stages: { vad: 80, stt: 150, llm: 400, tts: 120, network: 30, orchestrator: 20 } });
  pipeline.recordTurn({ turnId: 't2', endToEndMs: 410, atMs: 1000, stages: { vad: 90, stt: 180, llm: 500, tts: 150, network: 40, orchestrator: 25 } });
  const report = pipeline.sessionReport();
  assert.equal(report.turns, 2);
  assert.equal(report.endToEndComplianceRate, 1);
  assert.equal(report.alerts, 0);
  assert.equal(report.quality, 'full');
  assert.equal(report.worstStage, 'llm');
  assert.ok(pipeline.markdown().includes('Latency pipeline v15'));
});

test('v15 pipeline: over-budget stages alert warn, 2x alerts critical, e2e >1000 ms is broken', () => {
  const pipeline = new LatencyPipelineV15();
  const warn = pipeline.recordStage('t1', 'stt', 350, 0);
  assert.equal(warn?.level, 'warn');
  const critical = pipeline.recordStage('t1', 'tts', 450, 0);
  assert.equal(critical?.level, 'critical');
  const broken = pipeline.recordTurn({ turnId: 't1', endToEndMs: 1200, atMs: 0, stages: {} });
  assert.equal(broken?.level, 'critical');
  assert.equal(broken?.stage, 'end-to-end');
  assert.equal(pipeline.sessionReport().criticalAlerts, 2);
  assert.equal(pipeline.stageStats('stt').overBudget, 1);
  assert.equal(pipeline.stageStats('stt').complianceRate, 0);
});

test('v15 pipeline: p95 over budget degrades quality, recovery steps back up', () => {
  const pipeline = new LatencyPipelineV15({ degradeAfterTurns: 2, recoverAfterTurns: 2, windowTurns: 5 });
  const slow = (id, atMs) => pipeline.recordTurn({ turnId: id, endToEndMs: 700, atMs, stages: {} });
  const fast = (id, atMs) => pipeline.recordTurn({ turnId: id, endToEndMs: 200, atMs, stages: {} });
  slow('t1', 0);
  assert.equal(pipeline.getQuality(), 'full');
  slow('t2', 1000);
  assert.equal(pipeline.getQuality(), 'reduced');
  assert.equal(pipeline.qualityStepsList().length, 1);
  assert.equal(pipeline.qualityStepsList()[0].from, 'full');
  // p95 over a 5-turn window stays high until enough fast turns land,
  // so the ladder steps down once more (to minimal) before recovering.
  fast('t3', 2000);
  fast('t4', 3000);
  fast('t5', 4000);
  fast('t6', 5000);
  fast('t7', 6000);
  fast('t8', 7000);
  fast('t9', 8000);
  fast('t10', 9000);
  assert.equal(pipeline.getQuality(), 'full');
  assert.equal(pipeline.sessionReport().recoveries, 2);
  assert.equal(pipelineQualityPolicyV15('minimal').ttsVoice, 'minimal');
  assert.equal(pipelineQualityPolicyV15('full').llmMaxTokens, 1024);
});

test('v15 pipeline: percentiles and budget validation', () => {
  assert.equal(percentileV15([], 95), 0);
  assert.equal(percentileV15([100, 200, 300, 400], 50), 200);
  assert.equal(percentileV15([100, 200, 300, 400], 95), 400);
  const budgets = defaultPipelineBudgetsV15();
  assert.equal(budgets.endToEndMs, 500);
  assert.equal(budgets.brokenMs, 1000);
  assert.throws(() => new LatencyPipelineV15({ budgets: { endToEndMs: -1 } }), /invalid pipeline budgets/);
});

// ------------------------------------------------------------- barge-in ---

test('v15 barge-in: silence never starts a burst; sustained speech does', () => {
  const detector = new BargeInDetectorV15();
  assert.deepEqual(feedSilenceFrames(detector, 30), []);
  assert.equal(detector.isSpeechActive(), false);
  const fired = feedSpeechFrames(detector, 15);
  assert.equal(fired.filter((e) => e.kind === 'speech-started').length, 1);
  assert.equal(detector.isSpeechActive(), true);
  const ended = feedSilenceFrames(detector, 25, 300);
  assert.equal(ended.filter((e) => e.kind === 'speech-ended').length, 1);
  assert.equal(detector.isSpeechActive(), false);
});

test('v15 barge-in: short burst is a cough, low sustained burst is a breath, echo is rejected', () => {
  const cough = new BargeInDetectorV15();
  feedSpeechFrames(cough, 5);
  const rejected = feedSilenceFrames(cough, 3, 100);
  assert.equal(rejected.filter((e) => e.kind === 'rejected' && e.reason === 'cough').length, 1);

  const breath = new BargeInDetectorV15();
  feedSpeechFrames(breath, 15, 0, 0.03);
  const breathRejected = feedSilenceFrames(breath, 3, 300);
  assert.equal(breathRejected.filter((e) => e.kind === 'rejected' && e.reason === 'breath').length, 1);
  assert.equal(breath.stats().totalRejections, 1);

  const echo = new BargeInDetectorV15();
  const echoEvent = echo.feed({ frame: syntheticFrameV15(0.06), atMs: 0, echo: true });
  assert.equal(echoEvent?.kind, 'rejected');
  assert.equal(echoEvent?.reason, 'echo');
});

test('v15 barge-in: frame RMS separates silence from speech', () => {
  assert.ok(frameRmsV15(syntheticFrameV15(0.005)) < 0.01);
  assert.ok(frameRmsV15(syntheticFrameV15(0.06)) > 0.02);
  assert.ok(frameRmsV15(new Int16Array(480)) === 0);
});

test('v15 barge-in: engine interrupt cancels TTS + LLM with a cut receipt, then cooldown', () => {
  const engine = new BargeInEngineV15({ cooldownMs: 800, minSilenceMs: 100 });
  engine.setDiscardCounts({ ttsChunks: 4, llmTokens: 120, sttPartials: 2 });
  feedSpeechFrames(engine.detector, 15);
  const receipt = engine.interrupt(0, 300, { tts: true, llm: true, stt: true });
  assert.equal(receipt.cutLatencyMs, 300);
  assert.equal(receipt.discardedTtsChunks, 4);
  assert.equal(receipt.discardedLlmTokens, 120);
  assert.equal(receipt.discardedSttPartials, 2);
  assert.equal(engine.stats().cuts, 1);
  assert.equal(engine.stats().averageCutLatencyMs, 300);
  // End the utterance with a short silence, then start a new burst
  // while the cooldown (800 ms from the cut at 300 ms) is still live.
  const ended = feedSilenceFrames(engine.detector, 6, 300);
  assert.ok(ended.some((e) => e.kind === 'speech-ended'));
  const fired = feedSpeechFrames(engine.detector, 15, 440);
  assert.ok(fired.some((e) => e.kind === 'rejected' && e.reason === 'cooldown'));
  assert.ok(engine.markdown().includes('Barge-in v15'));
  assert.ok(engine.summary().includes('1 cuts'));
});

// ----------------------------------------------------------- smart turn ---

test('v15 smart-turn: language detection vi vs en', () => {
  assert.equal(detectSmartTurnLanguageV15('Tôi muốn đặt lịch họp vào thứ sáu'), 'vi');
  assert.equal(detectSmartTurnLanguageV15('I want to book a meeting on Friday'), 'en');
  assert.equal(detectSmartTurnLanguageV15('Bạn nghĩ sao?'), 'vi');
});

test('v15 smart-turn: complete sentences end, trailing conjunctions continue (vi)', () => {
  const done = scoreTurnCompletenessV15('Xin chào bạn, tôi muốn đặt lịch họp.');
  assert.equal(done.decision, 'end');
  assert.equal(done.classification, 'complete');
  assert.ok(done.score >= 0.6);
  assert.ok(done.reasons.includes('terminal punctuation'));

  const hanging = scoreTurnCompletenessV15('Tôi muốn đặt lịch vào thứ sáu, và');
  assert.equal(hanging.decision, 'continue');
  assert.equal(hanging.classification, 'incomplete');
  assert.equal(hanging.signals.trailingConjunction, 'và');
  assert.ok(hanging.score < 0.3);

  const thinking = scoreTurnCompletenessV15('Ừm, à thì…');
  assert.equal(thinking.classification, 'filler-only');
  assert.equal(thinking.decision, 'continue');
});

test('v15 smart-turn: open questions wait longer, closed questions end fast', () => {
  const open = scoreTurnCompletenessV15('Bạn nghĩ sao về kế hoạch này?');
  assert.equal(open.signals.isOpenQuestion, true);
  assert.equal(open.decision, 'end');
  assert.ok(open.recommendedWaitMs > 450, `open wait ${open.recommendedWaitMs}`);

  const closed = scoreTurnCompletenessV15('Bạn đi họp không?');
  assert.equal(closed.signals.isClosedQuestion, true);
  assert.equal(closed.decision, 'end');
  assert.equal(closed.recommendedWaitMs, 450);
});

test('v15 smart-turn: English trailing conjunctions and open questions', () => {
  const hanging = scoreTurnCompletenessV15('I want to book a flight and', { language: 'en' });
  assert.equal(hanging.decision, 'continue');
  assert.equal(hanging.signals.trailingConjunction, 'and');

  const done = scoreTurnCompletenessV15('Please book a flight to Hanoi tomorrow.', { language: 'en' });
  assert.equal(done.decision, 'end');

  const open = scoreTurnCompletenessV15('What do you think about this plan?', { language: 'en' });
  assert.equal(open.signals.isOpenQuestion, true);
  assert.ok(open.recommendedWaitMs > 450);

  const ack = scoreTurnCompletenessV15('Yeah, right.', { language: 'en' });
  assert.equal(ack.signals.backchannel, 'ack');
});

test('v15 smart-turn: detector holds a thinking-pause through silence and saves a false end', () => {
  const detector = new SmartTurnDetectorV15();
  detector.feedPartial('Tôi muốn đặt lịch vào thứ sáu, và');
  const held = detector.feedSilence(2000, 2000);
  assert.equal(held, undefined);
  assert.equal(detector.isEnded(), false);
  assert.ok(detector.stats().falseEndSaves >= 1);

  detector.reset();
  detector.feedPartial('Xin chào bạn, tôi muốn đặt lịch họp.');
  const ended = detector.feedSilence(450, 500);
  assert.equal(ended?.kind, 'end');
  assert.equal(detector.isEnded(), true);
  assert.equal(detector.stats().ends, 1);
  assert.ok(detector.markdown().includes('Semantic turn-taking v15'));
});

test('v15 smart-turn: sensitivity presets order eagerness', () => {
  assert.ok(sensitivityPresetV15('high').endThreshold < sensitivityPresetV15('balanced').endThreshold);
  assert.ok(sensitivityPresetV15('balanced').endThreshold < sensitivityPresetV15('low').endThreshold);
  assert.ok(sensitivityPresetV15('high').baseSilenceMs < sensitivityPresetV15('low').baseSilenceMs);
});

// ------------------------------------------------------------------ TTS ---

test('v15 tts: chunker splits at clause boundaries and respects the cap', () => {
  const chunks = chunkTtsTextV15('Xin chào bạn. Tôi muốn đặt lịch vào thứ sáu, và nhắc tôi lúc 9 giờ.', 20);
  assert.ok(chunks.length >= 3);
  assert.ok(chunks.every((c) => c.text.length <= 20 || c.text.split(' ').length === 1));
  assert.equal(chunks[chunks.length - 1].sentenceEnd, true);
  assert.deepEqual(chunkTtsTextV15('   ', 20), []);
  assert.deepEqual(chunkTtsTextV15('Một câu ngắn.', 120).map((c) => c.text), ['Một câu ngắn.']);
});

test('v15 tts: voice profiles validate and step up/down', () => {
  const profile = defaultVoiceProfileV15('bot-1');
  assert.deepEqual(validateVoiceProfileV15(profile), []);
  assert.deepEqual(validateVoiceProfileV15({ ...profile, rate: 5 }), ['rate must be 0.5..2']);
  assert.deepEqual(validateVoiceProfileV15({ ...profile, maxChunkChars: 5 }), ['maxChunkChars must be 10..1000']);
  const store = new VoiceProfileStoreV15();
  store.set({ ...profile, voiceId: 'nova', quality: 'high' });
  assert.equal(store.get('bot-1').voiceId, 'nova');
  assert.equal(store.get('unknown-bot').voiceId, 'default');
  assert.equal(store.count(), 1);
});

test('v15 tts: stream emits audio in order, measures first audio, cancels mid-stream', () => {
  const { events, sink } = collectEvents();
  const stream = new TtsStreamV15(undefined, sink);
  const profile = { ...defaultVoiceProfileV15('bot-1'), maxChunkChars: 20 };
  const chunks = stream.speak('Xin chào bạn. Tôi muốn đặt lịch vào thứ sáu, và nhắc tôi lúc 9 giờ sáng mai.', profile);
  assert.ok(chunks.length >= 3);
  stream.tick(200);
  const audioEvents = events.filter((e) => e.kind === 'audio');
  assert.ok(audioEvents.length >= 1);
  assert.ok(stream.stats().firstAudioMs !== undefined && stream.stats().firstAudioMs <= 200);
  const cancelled = stream.cancel();
  assert.equal(cancelled.cancelledChunks, chunks.length - audioEvents.length);
  assert.ok(cancelled.remainingText.length > 0);
  assert.equal(stream.getState(), 'cancelled');
  assert.equal(stream.stats().cancellations, 1);
  assert.ok(stream.summary().includes('tts v15'));
  assert.ok(stream.markdown().includes('TTS streaming v15'));
  assert.throws(() => stream.speak('', profile), /empty text/);
});

test('v15 tts: fast profile synthesises faster than high quality', () => {
  const fast = new TtsStreamV15(undefined, () => {});
  const slow = new TtsStreamV15(undefined, () => {});
  const text = 'Xin chào bạn, tôi muốn đặt lịch họp vào thứ sáu.';
  fast.speak(text, { ...defaultVoiceProfileV15('b'), quality: 'fast', maxChunkChars: 120 });
  slow.speak(text, { ...defaultVoiceProfileV15('b'), quality: 'high', maxChunkChars: 120 });
  fast.tick(100);
  slow.tick(100);
  assert.ok(fast.stats().chunksSpoken >= slow.stats().chunksSpoken);
});

// ------------------------------------------------------------ wake word ---

test('v15 wake-word: exact match activates, follow-up speech confirms', () => {
  const detector = new WakeWordDetectorV15();
  const activated = detector.feedTranscript('hey bot, giúp tôi đặt lịch', 0);
  assert.equal(activated?.kind, 'activated');
  assert.equal(activated?.word, 'hey bot');
  const confirmed = detector.feedTranscript('đặt lịch họp lúc 9 giờ sáng mai', 1000);
  assert.equal(confirmed?.kind, 'confirmed');
  assert.equal(detector.isAwake(), true);
  assert.equal(detector.stats().activations, 1);
  assert.equal(detector.stats().confirmations, 1);
});

test('v15 wake-word: near-miss suppressed at low sensitivity, accepted at high', () => {
  const low = new WakeWordDetectorV15([
    { word: 'hey bot', language: 'en', sensitivity: 'low', minEnergy: 0.01, cooldownMs: 3000, confirmMs: 5000, enabled: true },
  ]);
  const suppressed = low.feedTranscript('hey bod, are you there', 0);
  assert.equal(suppressed?.kind, 'suppressed');
  assert.equal(suppressed?.reason, 'near-miss');
  assert.ok(wakeWordSimilarityV15('hey bod', 'hey bot') > 0.8);

  const high = new WakeWordDetectorV15([
    { word: 'hey bot', language: 'en', sensitivity: 'high', minEnergy: 0.01, cooldownMs: 3000, confirmMs: 5000, enabled: true },
  ]);
  assert.equal(high.feedTranscript('hey bod, are you there', 0)?.kind, 'activated');
  assert.equal(sensitivityThresholdV15('low'), 1.0);
  assert.equal(sensitivityThresholdV15('high'), 0.6);
  assert.equal(levenshteinV15('bot', 'bod'), 1);
  assert.equal(levenshteinV15('hey bot', 'hey bot'), 0);
});

test('v15 wake-word: low energy, cooldown and no-follow-up expiry suppress', () => {
  const detector = new WakeWordDetectorV15();
  const quiet = detector.feedTranscript('hey bot', 0, 0.001);
  assert.equal(quiet?.reason, 'low-energy');
  const first = detector.feedTranscript('hey bot', 100);
  assert.equal(first?.kind, 'activated');
  const again = detector.feedTranscript('hey bot', 200);
  assert.equal(again?.reason, 'cooldown');
  const expired = detector.tick(100 + 5000);
  assert.equal(expired?.kind, 'expired');
  assert.equal(detector.stats().expirations, 1);
  assert.equal(detector.stats().totalSuppressions, 3);
  assert.ok(detector.markdown().includes('Wake word v15'));
});

test('v15 wake-word: labelled evaluation measures false accepts and rejects', () => {
  const detector = new WakeWordDetectorV15();
  const evaluation = detector.evaluate([
    { transcript: 'hey bot, mở nhạc giúp tôi', containsWakeWord: true },
    { transcript: 'này bot, hôm nay thời tiết thế nào', containsWakeWord: true },
    { transcript: 'tôi đang nói về con robot hôm qua', containsWakeWord: false },
    { transcript: 'open bot giúp tôi ghi chú', containsWakeWord: true },
    { transcript: 'hôm nay trời đẹp quá', containsWakeWord: false },
    { transcript: 'hey buddy, are you there', containsWakeWord: false },
  ]);
  assert.equal(evaluation.total, 6);
  assert.equal(evaluation.truePositives, 3);
  assert.equal(evaluation.falsePositives, 0);
  assert.equal(evaluation.trueNegatives, 3);
  assert.equal(evaluation.falseNegatives, 0);
  assert.equal(evaluation.accuracy, 1);
});

// ------------------------------------------------------- provider registry ---

test('v15 registry: seeds mocks, registers plugins, rejects duplicates and bad ids', () => {
  const registry = new VoiceProviderRegistryV15();
  assert.equal(registry.count(), 3);
  registry.register({
    kind: 'stt', id: 'fast-stt', label: 'Fast STT', languages: ['vi', 'en'],
    streaming: true, sampleRatesHz: [16000], latencyMs: 90, costPerMinuteUsd: 0.01, quality: 0.8, requiresKey: true,
  });
  assert.equal(registry.count(), 4);
  assert.throws(() => registry.register({
    kind: 'stt', id: 'fast-stt', label: 'dup', languages: ['en'],
    streaming: true, sampleRatesHz: [16000], latencyMs: 90, costPerMinuteUsd: 0, quality: 0.5, requiresKey: false,
  }), /already registered/);
  assert.throws(() => registry.register({
    kind: 'stt', id: 'Bad ID!', label: 'bad', languages: ['en'],
    streaming: true, sampleRatesHz: [16000], latencyMs: 90, costPerMinuteUsd: 0, quality: 0.5, requiresKey: false,
  }), /kebab-case/);
  assert.equal(registry.unregister('fast-stt'), true);
  assert.equal(registry.unregister('fast-stt'), false);
});

test('v15 registry: pick by goal, health gating, pair + hourly cost', async () => {
  const registry = new VoiceProviderRegistryV15();
  registry.register({
    kind: 'stt', id: 'accurate-stt', label: 'Accurate STT', languages: ['vi', 'en'],
    streaming: true, sampleRatesHz: [16000], latencyMs: 280, costPerMinuteUsd: 0.02, quality: 0.95, requiresKey: true,
    health: () => ({ ok: false, reason: 'no key in Vault' }),
  });
  registry.register({
    kind: 'stt', id: 'quick-stt', label: 'Quick STT', languages: ['vi', 'en'],
    streaming: true, sampleRatesHz: [16000], latencyMs: 110, costPerMinuteUsd: 0, quality: 0.7, requiresKey: false,
  });
  await registry.refreshHealth();
  // The accurate provider is unhealthy (no key) so it never wins a pick.
  assert.equal(registry.pick('stt', { goal: 'quality' })?.plugin.id, 'quick-stt');
  assert.equal(registry.pick('stt', { goal: 'latency' })?.plugin.id, 'quick-stt');
  const pair = registry.pickPair({ goal: 'balanced', language: 'vi' });
  assert.equal(pair.stt?.plugin.id, 'quick-stt');
  assert.equal(pair.tts?.plugin.id, 'mock-tts');
  assert.equal(pair.hourlyCostUsd, 0);
  assert.equal(registry.pick('tts', { language: 'ja' }), undefined);
  const scored = scoreVoiceProviderV15(registry.get('mock-stt'), 'balanced', true);
  assert.ok(scored.score > 0 && scored.score <= 1);
  assert.ok(registry.markdown().includes('Voice provider registry v15'));
});

// --------------------------------------------------------------- session ---

test('v15 session: pipeline mode full turn — transcript to reply to TTS', async () => {
  const session = new VoiceSessionV15('s1', { mode: 'pipeline', botId: 'bot-1' });
  assert.equal(session.getState(), 'idle');
  await session.connect();
  assert.equal(session.getState(), 'active');
  assert.equal(session.getMode(), 'pipeline');
  session.feedTranscriptFinal('Xin chào bạn, tôi muốn đặt lịch họp.');
  await flush();
  session.tick(3000);
  assert.equal(session.turnsList().length, 1);
  assert.match(session.turnsList()[0].replyText, /Xin chào bạn/);
  assert.equal(session.stats().pipeline.turns, 1);
  assert.equal(session.stats().pipeline.endToEndComplianceRate, 1);
  assert.ok(session.tts.stats().chunksSpoken >= 1);
  assert.ok(session.summary().includes('turns=1'));
  assert.ok(session.markdown().includes('Voice session v15'));
  session.disconnect();
  assert.equal(session.getState(), 'closed');
});

test('v15 session: S2S script drives a turn, then fallback when the transport dies', async () => {
  const session = new VoiceSessionV15('s2', {
    mode: 's2s',
    s2sScript: [
      { atMs: 50, kind: 'transcript-final', text: 'Xin chào bạn.', speaker: 'user' },
    ],
  });
  await session.connect();
  assert.equal(session.getMode(), 's2s');
  session.tick(200);
  await flush();
  session.tick(3000);
  assert.equal(session.turnsList().length, 1);

  const failing = new VoiceSessionV15('s3', {
    mode: 's2s',
    s2sFailConnectWith: 'no network',
    s2sMaxReconnectAttempts: 0,
  });
  await failing.connect();
  assert.equal(failing.getMode(), 'pipeline');
  assert.equal(failing.getState(), 'active');
  assert.equal(failing.stats().fallbacks, 1);
  assert.ok(failing.eventsList().some((e) => e.kind === 'fallback'));
});

test('v15 session: barge-in while the agent speaks cancels the TTS stream', async () => {
  const session = new VoiceSessionV15('s4', { mode: 'pipeline', botId: 'bot-1' });
  await session.connect();
  await session.speakReply('Xin chào bạn, tôi muốn kể cho bạn nghe một câu chuyện rất dài về ngày hôm qua và ngày hôm nay.');
  assert.equal(session.tts.isSpeaking(), true);
  // 15 speech frames, 20 ms apart, on the virtual clock.
  for (let i = 0; i < 15; i += 1) {
    session.tick(20);
    session.feedAudioFrame(syntheticFrameV15(0.06));
  }
  assert.ok(session.stats().bargeIns >= 1, `barge-ins=${session.stats().bargeIns}`);
  assert.equal(session.tts.isSpeaking(), false);
  assert.ok(session.eventsList().some((e) => e.kind === 'barge-in'));
});

test('v15 session: asleep behind the wake word, wakes on confirmation only', async () => {
  const session = new VoiceSessionV15('s5', { mode: 'pipeline', startAsleep: true });
  assert.equal(session.getState(), 'asleep');
  session.feedTranscriptFinal('hey bot, chào bạn');
  assert.equal(session.getState(), 'asleep');
  assert.equal(session.wakeWord.pendingWord(), 'hey bot');
  session.feedTranscriptFinal('giúp tôi đặt lịch họp lúc 9 giờ');
  assert.equal(session.getState(), 'active');
  assert.equal(session.stats().wakeUps, 1);
  // Mentioning the bot without follow-up speech expires instead of waking.
  const sleepy = new VoiceSessionV15('s6', { mode: 'pipeline', startAsleep: true });
  sleepy.feedTranscriptFinal('hey bot');
  sleepy.tick(6000);
  assert.equal(sleepy.getState(), 'asleep');
  assert.equal(sleepy.wakeWord.stats().expirations, 1);
});

test('v15 session: manager registry create/get/delete', async () => {
  const manager = new VoiceSessionManagerV15();
  const a = manager.create('a', { mode: 'pipeline' });
  assert.equal(manager.count(), 1);
  assert.equal(manager.get('a'), a);
  assert.throws(() => manager.create('a', {}), /already exists/);
  assert.equal(manager.delete('a'), true);
  assert.equal(manager.count(), 0);
  assert.equal(manager.delete('missing'), false);
});

// ----------------------------------------------------------------- tools ---

test('v15 tools: 10 tools with unique names; create → talk → stats → delete lifecycle', async () => {
  assert.equal(VOICE_V15_TOOLS.length, 10);
  assert.deepEqual([...VOICE_V15_TOOL_NAMES], VOICE_V15_TOOLS.map((t) => t.definition.name));
  assert.equal(new Set(VOICE_V15_TOOL_NAMES).size, 10);
  assert.equal(isVoiceV15ToolName('voice_v15_session_create'), true);
  assert.equal(isVoiceV15ToolName('voice_v14_session_create'), false);

  const tools = createVoiceV15Tools();
  const byName = (name) => tools.find((t) => t.definition.name === name);
  const ctx = {};
  const create = byName('voice_v15_session_create');
  const created = JSON.parse(await create.execute({ sessionId: 'tool-1', connect: true, mockReply: 'Đã rõ, tôi sẽ đặt lịch cho bạn.' }, ctx));
  assert.equal(created.created, true);
  assert.match(created.summary, /active/);

  const talk = byName('voice_v15_talk');
  const talked = JSON.parse(await talk.execute({ sessionId: 'tool-1', text: 'Xin chào bạn, tôi muốn đặt lịch họp.' }, ctx));
  assert.equal(talked.turns, 1);
  assert.match(talked.lastTurn.replyText, /Đã rõ/);

  const stats = byName('voice_v15_session_stats');
  const statOut = JSON.parse(await stats.execute({ sessionId: 'tool-1' }, ctx));
  assert.equal(statOut.stats.turns, 1);
  assert.ok(statOut.markdown.includes('Voice session v15'));

  const latency = byName('voice_v15_latency');
  const latOut = JSON.parse(await latency.execute({ sessionId: 'tool-1' }, ctx));
  assert.equal(latOut.report.turns, 1);
  assert.equal(latOut.report.endToEndComplianceRate, 1);

  const provider = byName('voice_v15_provider');
  const provOut = JSON.parse(await provider.execute({ goal: 'latency' }, ctx));
  assert.equal(provOut.pick.stt, 'mock-stt');
  assert.equal(provOut.pick.tts, 'mock-tts');
  assert.equal(provOut.providers.length, 3);

  const wake = byName('voice_v15_wake_word');
  const wakeOut = JSON.parse(await wake.execute({ sessionId: 'tool-1' }, ctx));
  assert.equal(wakeOut.words.length, 3);
  const evaluated = JSON.parse(await wake.execute({
    sessionId: 'tool-1',
    action: 'evaluate',
    samples: JSON.stringify([
      { transcript: 'hey bot, chào bạn', containsWakeWord: true },
      { transcript: 'hôm nay trời đẹp', containsWakeWord: false },
    ]),
  }, ctx));
  assert.equal(evaluated.evaluation.accuracy, 1);

  const barge = byName('voice_v15_barge_in');
  const bargeOut = JSON.parse(await barge.execute({ sessionId: 'tool-1' }, ctx));
  assert.equal(bargeOut.interrupted, true);
  assert.ok(bargeOut.cut.cutLatencyMs >= 0);

  const list = byName('voice_v15_session_list');
  const listOut = JSON.parse(await list.execute({}, ctx));
  assert.equal(listOut.sessions.length, 1);
  assert.equal(listOut.sessions[0].sessionId, 'tool-1');

  const stop = byName('voice_v15_session_stop');
  const stopped = JSON.parse(await stop.execute({ sessionId: 'tool-1' }, ctx));
  assert.equal(stopped.state, 'closed');

  const remove = byName('voice_v15_session_delete');
  const removed = JSON.parse(await remove.execute({ sessionId: 'tool-1' }, ctx));
  assert.equal(removed.deleted, true);

  const missing = await stats.execute({ sessionId: 'tool-1' }, ctx);
  assert.match(missing, /^Error: Unknown voice v15 session/);

  const badCreate = await create.execute({ sessionId: 'tool-2', mode: 'warp' }, ctx);
  assert.match(badCreate, /^Error: Unknown mode/);
});

test('v15 tools: placeholder tools refuse without a bound manager session', async () => {
  const placeholder = VOICE_V15_TOOLS.find((t) => t.definition.name === 'voice_v15_session_stats');
  const out = await placeholder.execute({ sessionId: 'nope' }, {});
  assert.match(out, /^Error: Unknown voice v15 session/);
});

// ------------------------------------------------------- core re-exports ---

test('v15 core: root re-exports importable from @open-bot/core', async () => {
  const core = await import('../packages/core/dist/index.js');
  for (const name of [
    'S2SAdapterV15', 'MockS2STransportV15', 'LatencyPipelineV15',
    'BargeInEngineV15', 'SmartTurnDetectorV15', 'TtsStreamV15',
    'WakeWordDetectorV15', 'VoiceProviderRegistryV15',
    'VoiceSessionV15', 'VoiceSessionManagerV15',
  ]) {
    assert.equal(typeof core[name], 'function', `${name} should be exported from @open-bot/core`);
  }
});

// ------------------------------------------------------------------ i18n ---

test('v15 i18n: 48 voice.realtime.v15.* keys in all 6 locales, non-empty, same set', () => {
  const locales = ['en', 'es', 'fr', 'ja', 'vi', 'zh'];
  const sets = {};
  for (const locale of locales) {
    const data = JSON.parse(fs.readFileSync(path.join(repoRoot, 'apps/desktop/src/renderer/i18n/locales', `${locale}.json`), 'utf8'));
    const keys = Object.keys(data).filter((k) => k.startsWith('voice.realtime.v15.'));
    sets[locale] = new Set(keys);
    assert.equal(keys.length, 48, `${locale} should have 48 v15 keys, got ${keys.length}`);
    for (const key of keys) {
      assert.equal(typeof data[key], 'string', `${locale}:${key} must be a string`);
      assert.ok(data[key].trim().length > 0, `${locale}:${key} must not be empty`);
    }
    const allKeys = Object.keys(data);
    assert.deepEqual(allKeys, [...allKeys].sort(), `${locale}.json keys must stay sorted`);
  }
  const base = [...sets.en].sort();
  for (const locale of locales.slice(1)) {
    assert.deepEqual([...sets[locale]].sort(), base, `${locale} v15 keys must match en`);
  }
});
