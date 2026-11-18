/**
 * Tests for v1.18 — voice realtime v17 (Team T5, replacement wave).
 *
 *   1. VAD v5 (vadV17.ts): speech / silence / noise classes on mock
 *      PCM, debounce, speech + noise segments, noise bursts, echo
 *      suppression, live reconfigure, validation.
 *   2. Barge-in v5 (bargeInV17.ts): interruption classification,
 *      pure resume decision table (resume / restart / summarise /
 *      drop), escalation on repeated cuts, engine cut with receipt
 *      + plan, stats.
 *   3. TTS streaming v3 (ttsStreamV17.ts): sentence splitting,
 *      first-chunk latency with average + p95, urgent preemption,
 *      cancel-unplayed keeps the spoken prefix, queue-full guard,
 *      pause/resume, underruns on small-step playout.
 *   4. Turn-taking v5 (turnTakingV17.ts): listening / thinking /
 *      speaking / interrupted / idle / closed, event-driven
 *      transitions, rejected illegal events, listening prompt,
 *      stuck-state recovery (thinking / speaking / interrupted),
 *      reset, history, stats.
 *   5. Multi-voice profiles v2 (voiceProfilesV17.ts): presets,
 *      set/get/remove, per-user default, clone-for-user, resolve
 *      fallback chain (user-bot-context → … → preset → default),
 *      JSON export/import with invalid entries dropped.
 *   6. Session v17 (sessionV17.ts): connect, full turn (transcript
 *      → reply → TTS v3), barge-in cut mid-speech with auto-resume
 *      (resume) and manual resume (restart), VAD feed through the
 *      mic path, manager registry.
 *   7. Tools (voiceV17Tools.ts): 10 tools, unique names, full
 *      lifecycle through the tools (create → talk → stats → vad →
 *      tts speak → barge-in → profiles → stop → delete) + validation.
 *   8. Core root re-exports + i18n: v17 classes importable from
 *      `@open-bot/core`; 48 `voice.realtime.v17.*` keys in all 6
 *      locales, non-empty, same key set everywhere.
 *
 * No network, no sound card, no live provider, no key. Every audio
 * path is mock (synthetic PCM frames, DC hum frames, mock synth,
 * scripted replies). Run after building core + tools:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/voice-v118.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  VadV17,
  createVadV17,
  defaultVadV17Options,
  validateVadV17Options,
  vadV17FrameFeatures,
  classifyVadFrameV17,
  pcm16ToBytesV17,
  vadV17Summary,
  vadV17Markdown,
  VAD_V17_FRAME_MS,
  VAD_V17_FRAME_SAMPLES,
  BargeInEngineV17,
  createBargeInEngineV17,
  defaultBargeInV17Options,
  validateBargeInV17Options,
  classifyInterruptionV17,
  decideBargeInResumeV17,
  bargeInV17Summary,
  bargeInV17Markdown,
  TtsStreamV17,
  createTtsStreamV17,
  defaultTtsStreamV17Options,
  validateTtsStreamV17Options,
  splitSentencesV17,
  percentileV17,
  ttsV17Summary,
  ttsV17Markdown,
  TTS_V17_SAMPLE_RATE_HZ,
  TurnTakingMachineV17,
  createTurnTakingMachineV17,
  defaultTurnTakingV17Options,
  validateTurnTakingV17Options,
  isTurnTakingV17Live,
  isTurnTakingV17UserTurn,
  isTurnTakingV17ModelSpeaking,
  turnTakingV17Summary,
  turnTakingV17Markdown,
  TURN_TAKING_V17_STATES,
  VoiceProfileStoreV17,
  createVoiceProfileStoreV17,
  defaultVoiceProfileV17,
  validateVoiceProfileV17,
  presetVoiceProfilesV17,
  isVoiceProfileV17Context,
  voiceProfilesV17Summary,
  voiceProfilesV17Markdown,
  VOICE_V17_CONTEXTS,
  VoiceSessionV17,
  VoiceSessionManagerV17,
  createVoiceSessionV17,
  createVoiceSessionManagerV17,
} from '../packages/core/dist/voiceV17/index.js';
import { syntheticFrameV15, defaultVoiceProfileV15 } from '../packages/core/dist/voiceV15/index.js';
import {
  createVoiceV17Tools,
  VOICE_V17_TOOLS,
  VOICE_V17_TOOL_NAMES,
  isVoiceV17ToolName,
} from '../packages/tools/dist/voiceV17Tools.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 20 ms PCM16 frames: speech-like sine, near-silence, DC hum (noise). */
const speechFrame = () => syntheticFrameV15(0.5, VAD_V17_FRAME_SAMPLES);
const silenceFrame = () => syntheticFrameV15(0.001, VAD_V17_FRAME_SAMPLES);
/** True digital silence: all-zero samples (no energy, no crossings). */
const zeroFrame = () => new Int16Array(VAD_V17_FRAME_SAMPLES);
const dcFrame = () => {
  const frame = new Int16Array(VAD_V17_FRAME_SAMPLES);
  frame.fill(16384);
  return frame;
};

/** Feed `n` frames 20 ms apart through a VAD starting at `atMs`. */
function feedFrames(vad, n, makeFrame, atMs = 0) {
  let now = atMs;
  for (let i = 0; i < n; i += 1) {
    vad.feed(makeFrame(), now);
    now += VAD_V17_FRAME_MS;
  }
  return now;
}

/** Fake cut receipt for the pure resume decision. */
function fakeCut(spokenChars, remainingChars) {
  return {
    kind: 'full',
    atMs: 1000,
    latencyMs: 5,
    context: {
      turnId: 'turn-1',
      userText: 'xin chào',
      replyText: 'x'.repeat(spokenChars + remainingChars),
      spokenText: 'x'.repeat(spokenChars),
      spokenChars,
      remainingText: 'x'.repeat(remainingChars),
      remainingChars,
    },
    interruptingText: '',
    ttsLevelAtCut: 0.12,
  };
}

// --------------------------------------------------------------------- VAD v5

test('vad v17: defaults + validation', () => {
  assert.equal(VAD_V17_FRAME_MS, 20);
  assert.equal(VAD_V17_FRAME_SAMPLES, 320);
  assert.equal(TTS_V17_SAMPLE_RATE_HZ, 24000);
  const defaults = defaultVadV17Options();
  assert.equal(defaults.preset, 'office');
  assert.equal(defaults.startThreshold, 0.6);
  assert.equal(defaults.noiseRmsMultiplier, 3);
  assert.equal(defaults.noiseProbabilityCeiling, 0.45);
  assert.equal(defaults.noiseMinMs, 300);
  assert.equal(defaults.debounceMs, 40);
  assert.deepEqual(validateVadV17Options({}), []);
  assert.ok(validateVadV17Options({ noiseRmsMultiplier: 0 }).length > 0);
  assert.ok(validateVadV17Options({ noiseMinMs: -1 }).length > 0);
  assert.ok(validateVadV17Options({ debounceMs: 5000 }).length > 0);
  assert.ok(validateVadV17Options({ startThreshold: 2 }).length > 0);
  assert.ok(validateVadV17Options({ preset: 'cafe' }).length > 0);
});

test('vad v17: pure frame features + classification', () => {
  const speech = vadV17FrameFeatures(speechFrame());
  assert.ok(speech.rms > 0.2, `speech rms ${speech.rms}`);
  assert.ok(speech.probability >= 0.6, `speech probability ${speech.probability}`);
  assert.equal(classifyVadFrameV17(speech), 'speech');
  const quiet = vadV17FrameFeatures(silenceFrame());
  assert.ok(quiet.rms < 0.01, `silence rms ${quiet.rms}`);
  assert.equal(classifyVadFrameV17(quiet), 'silence');
  const hum = vadV17FrameFeatures(dcFrame());
  assert.ok(hum.rms >= 0.4, `hum rms ${hum.rms}`);
  assert.ok(hum.probability < 0.45, `hum probability ${hum.probability}`);
  assert.equal(classifyVadFrameV17(hum), 'noise');
  const bytes = pcm16ToBytesV17(speechFrame());
  assert.equal(bytes.length, VAD_V17_FRAME_SAMPLES * 2);
  assert.throws(() => vadV17FrameFeatures(new Int16Array(100)), /320 samples/);
});

test('vad v17: speech segment, then silence back', () => {
  const vad = createVadV17({ calibrationFrames: 0 });
  assert.equal(vad.getClass(), 'silence');
  assert.equal(vad.isSpeaking(), false);
  assert.equal(vad.isCalibrated(), true);
  feedFrames(vad, 10, silenceFrame);
  assert.equal(vad.getClass(), 'silence');
  const afterSpeech = feedFrames(vad, 15, speechFrame, 200);
  assert.equal(vad.getClass(), 'speech');
  assert.equal(vad.isSpeaking(), true);
  assert.ok(vad.getProbability() >= 0.6);
  // True digital silence ends the turn: the faint 0.001-RMS sine
  // still looks speech-shaped to the v11 probability detector
  // (high zero-crossing + band-ratio fits), so it must not be used
  // as "silence" here.
  feedFrames(vad, 30, zeroFrame, afterSpeech);
  assert.equal(vad.getClass(), 'silence');
  const stats = vad.stats();
  assert.equal(stats.frames, 55);
  assert.ok(stats.speechFrames > 0);
  assert.equal(stats.segments, 1);
  assert.equal(stats.speechSegments, 1);
  const [segment] = vad.segmentsList();
  assert.equal(segment.class, 'speech');
  assert.ok(segment.durationMs >= 300, `segment ${segment.durationMs} ms`);
  assert.match(vad.summary(), /vad v17:/);
  assert.match(vad.markdown(), /## VAD v17/);
  assert.match(vadV17Summary(vad), /vad v17:/);
  assert.match(vadV17Markdown(vad), /## VAD v17/);
});

test('vad v17: noise burst on sustained hum, then a noise segment', () => {
  const events = [];
  const vad = createVadV17({ calibrationFrames: 0 }, (event) => events.push(event.kind));
  const afterNoise = feedFrames(vad, 25, dcFrame);
  assert.equal(vad.getClass(), 'noise');
  assert.equal(vad.stats().noiseBursts, 1);
  assert.equal(vad.stats().noiseFrames, 25);
  assert.ok(events.includes('noise-burst'), `events: ${events.join(',')}`);
  feedFrames(vad, 30, silenceFrame, afterNoise);
  assert.equal(vad.getClass(), 'silence');
  const [segment] = vad.segmentsList();
  assert.equal(segment.class, 'noise');
  assert.ok(segment.durationMs >= 400, `noise segment ${segment.durationMs} ms`);
});

test('vad v17: echo frames never count as user speech', () => {
  const vad = createVadV17({ calibrationFrames: 0 });
  let now = 0;
  for (let i = 0; i < 15; i += 1) {
    vad.feed(speechFrame(), now, true);
    now += VAD_V17_FRAME_MS;
  }
  assert.equal(vad.getClass(), 'silence');
  assert.equal(vad.stats().speechFrames, 0);
  assert.equal(vad.isSpeaking(), false);
});

test('vad v17: debounce holds a flickering class + live reconfigure', () => {
  const vad = createVadV17({ calibrationFrames: 0, debounceMs: 200 });
  feedFrames(vad, 5, speechFrame);
  // 100 ms of speech is not enough to flip a 200 ms debounce.
  assert.equal(vad.getClass(), 'silence');
  feedFrames(vad, 10, speechFrame, 100);
  assert.equal(vad.getClass(), 'speech');
  const next = vad.reconfigure({ debounceMs: 0 });
  assert.equal(next.debounceMs, 0);
  assert.throws(() => vad.reconfigure({ noiseMinMs: -5 }), /invalid VAD v17 options/);
  assert.throws(() => vad.feed(new Int16Array(10), 0), /320 samples/);
  vad.reset();
  assert.equal(vad.getClass(), 'silence');
  assert.equal(vad.stats().frames, 0);
});

// ------------------------------------------------------------------ barge-in v5

test('barge-in v17: classify interruptions', () => {
  assert.equal(classifyInterruptionV17('giá bao nhiêu?'), 'question');
  assert.equal(classifyInterruptionV17('thế còn ngày mai thì sao?'), 'question');
  assert.equal(classifyInterruptionV17('không phải thế'), 'correction');
  assert.equal(classifyInterruptionV17('sai rồi'), 'correction');
  assert.equal(classifyInterruptionV17('dừng lại'), 'correction');
  assert.equal(classifyInterruptionV17('stop'), 'correction');
  assert.equal(classifyInterruptionV17('ừ'), 'acknowledgement');
  assert.equal(classifyInterruptionV17('ok'), 'acknowledgement');
  assert.equal(classifyInterruptionV17('đúng rồi'), 'acknowledgement');
  assert.equal(classifyInterruptionV17('nói về thời tiết đi'), 'new-topic');
  assert.equal(classifyInterruptionV17(''), 'unclear');
  assert.equal(classifyInterruptionV17('   '), 'unclear');
});

test('barge-in v17: resume decision table (pure)', () => {
  // Acknowledgement with plenty left → resume from the cut point.
  const resume = decideBargeInResumeV17(fakeCut(30, 70), 'ừ');
  assert.equal(resume.action, 'resume');
  assert.equal(resume.resumeText, 'x'.repeat(70));
  assert.equal(resume.kind, 'acknowledgement');
  // Question / correction → restart with the interruption as prompt.
  const question = decideBargeInResumeV17(fakeCut(30, 70), 'giá bao nhiêu?');
  assert.equal(question.action, 'restart');
  assert.equal(question.restartPrompt, 'giá bao nhiêu?');
  assert.equal(question.resumeText, '');
  const correction = decideBargeInResumeV17(fakeCut(30, 70), 'không phải thế');
  assert.equal(correction.action, 'restart');
  // New topic after most of the reply was spoken → summarise + continue.
  const summarise = decideBargeInResumeV17(fakeCut(120, 60), 'nói về thời tiết đi');
  assert.equal(summarise.action, 'summarise');
  assert.match(summarise.resumeText, /Tóm lại phần vừa nói/);
  assert.ok(summarise.spokenFraction >= 0.6);
  // New topic early → just resume.
  assert.equal(decideBargeInResumeV17(fakeCut(30, 70), 'nói về thời tiết đi').action, 'resume');
  // Almost nothing left → drop the tail.
  const drop = decideBargeInResumeV17(fakeCut(95, 5), 'ừ');
  assert.equal(drop.action, 'drop');
  assert.equal(drop.resumeText, '');
  // Unclear interruption early in the reply → resume.
  assert.equal(decideBargeInResumeV17(fakeCut(10, 90), '').action, 'resume');
});

test('barge-in v17: escalation steps toward shorter replies', () => {
  const l1 = decideBargeInResumeV17(fakeCut(30, 70), 'ừ', {}, 1);
  assert.equal(l1.action, 'summarise');
  assert.equal(l1.escalationLevel, 1);
  const l2 = decideBargeInResumeV17(fakeCut(30, 70), 'ừ', {}, 2);
  assert.equal(l2.action, 'summarise');
  assert.equal(l2.nextReplyMaxChars, 280);
  // Restart is never escalated away: the user asked for it.
  const l2restart = decideBargeInResumeV17(fakeCut(30, 70), 'giá bao nhiêu?', {}, 2);
  assert.equal(l2restart.action, 'restart');
  assert.deepEqual(validateBargeInV17Options({}), []);
  assert.ok(validateBargeInV17Options({ minRemainingCharsToResume: -1 }).length > 0);
  assert.ok(validateBargeInV17Options({ summariseSpokenFraction: 2 }).length > 0);
  assert.deepEqual(defaultBargeInV17Options().minRemainingCharsToResume, 40);
});

test('barge-in v17: engine cut, receipt + plan, repeated-cut escalation', () => {
  let spoken = '';
  let remaining = '';
  const engine = createBargeInEngineV17(
    {},
    {
      stopTts: () => ({ spokenText: spoken, remainingText: remaining }),
      discardLlm: () => 0,
    },
  );
  const reply = 'Câu trả lời dài. Câu thứ hai của câu trả lời. Câu thứ ba nữa. Câu thứ tư.';
  const cutOnce = (turnId, atMs, text) => {
    spoken = 'Câu trả lời dài. ';
    remaining = 'Câu thứ hai của câu trả lời. Câu thứ ba nữa. Câu thứ tư.';
    engine.beginAgentTurn(turnId, 'xin chào', reply, atMs);
    engine.setAgentSpeaking(true);
    return engine.interrupt(atMs + 10, text);
  };
  const first = cutOnce('turn-1', 1000, 'ừ');
  assert.ok(first, 'first cut should land');
  assert.equal(first.plan.action, 'resume');
  assert.equal(first.receipt.context.spokenText, 'Câu trả lời dài. ');
  assert.equal(engine.getEscalationLevel(), 0);
  cutOnce('turn-2', 2000, 'ừ');
  assert.equal(engine.getEscalationLevel(), 1);
  const third = cutOnce('turn-3', 3000, 'ừ');
  assert.equal(engine.getEscalationLevel(), 2);
  assert.equal(third.plan.action, 'summarise');
  assert.equal(third.plan.nextReplyMaxChars, 280);
  const stats = engine.stats();
  assert.equal(stats.cuts, 3);
  assert.equal(stats.escalations, 2);
  assert.equal(stats.resumes, 1);
  assert.equal(stats.summarises, 2);
  assert.equal(engine.cutsList().length, 3);
  assert.equal(engine.lastPlanForCut().action, 'summarise');
  assert.match(engine.summary(), /barge-in v17:/);
  assert.match(engine.markdown(), /## Barge-in v17/);
  assert.match(bargeInV17Summary(engine), /barge-in v17:/);
  assert.match(bargeInV17Markdown(engine), /## Barge-in v17/);
});

// ---------------------------------------------------------------- TTS streaming v3

test('tts v17: sentence splitting + percentile + defaults', () => {
  assert.deepEqual(
    splitSentencesV17('Xin chào bạn. Tôi là bot! Bạn khỏe không? Chào'),
    ['Xin chào bạn.', 'Tôi là bot!', 'Bạn khỏe không?', 'Chào'],
  );
  assert.deepEqual(splitSentencesV17(''), []);
  assert.deepEqual(splitSentencesV17('một câu duy nhất'), ['một câu duy nhất']);
  assert.equal(percentileV17([10, 20, 30, 40, 50], 95), 48);
  assert.equal(percentileV17([10, 20, 30], 50), 20);
  assert.equal(percentileV17([], 95), 0);
  const defaults = defaultTtsStreamV17Options();
  assert.equal(defaults.maxChunkChars, 60);
  assert.equal(defaults.crossfadeMs, 15);
  assert.equal(defaults.maxQueuedChunks, 64);
  assert.deepEqual(validateTtsStreamV17Options({}), []);
  assert.ok(validateTtsStreamV17Options({ maxChunkChars: 5 }).length > 0);
  assert.ok(validateTtsStreamV17Options({ crossfadeMs: 500 }).length > 0);
});

test('tts v17: first-chunk latency (average + p95) on small-step playout', () => {
  const tts = createTtsStreamV17(undefined, {}, () => {});
  const profile = defaultVoiceProfileV15('b1');
  tts.beginUtterance(profile, 0);
  tts.feedSentence('Câu đầu tiên của câu trả lời.', 'normal', 0);
  tts.feedSentence('Câu thứ hai, dài hơn một chút.', 'normal', 0);
  tts.endUtterance();
  let steps = 0;
  while (tts.stats().chunksSpoken === 0 && steps < 50) {
    tts.tick(20);
    steps += 1;
  }
  assert.ok(tts.stats().chunksSpoken >= 1, 'first chunk should play');
  const latency = tts.stats().averageFirstChunkLatencyMs;
  assert.ok(latency > 0 && latency < 1000, `first-chunk latency ${latency} ms`);
  assert.equal(tts.stats().p95FirstChunkLatencyMs, latency);
  // Drain the rest in small steps: the second chunk is not synth-ready
  // when its turn comes, so at least one underrun is recorded.
  for (let i = 0; i < 100 && tts.getState() === 'speaking'; i += 1) tts.tick(20);
  assert.equal(tts.getState(), 'done');
  assert.equal(tts.stats().chunksSpoken, 2);
  assert.ok(tts.stats().underruns >= 1, `underruns ${tts.stats().underruns}`);
  // The second chunk was not synth-ready when its turn came, so its
  // playout was shifted forward: the join gap is positive, not the
  // -15 ms crossfade a jump-ahead tick would show.
  assert.equal(tts.stats().gapsMs.length, 1);
  assert.ok(tts.stats().gapsMs[0] > 0, `gap ${tts.stats().gapsMs[0]} ms`);
  assert.equal(tts.stats().charactersSpoken, 'Câu đầu tiên của câu trả lời.Câu thứ hai, dài hơn một chút.'.length);
  assert.match(tts.summary(), /tts v17:/);
  assert.match(tts.markdown(), /## TTS streaming v17/);
  assert.match(ttsV17Summary(tts), /tts v17:/);
  assert.match(ttsV17Markdown(tts), /## TTS streaming v17/);
});

test('tts v17: urgent sentences preempt the queue', () => {
  const tts = createTtsStreamV17(undefined, {}, () => {});
  tts.beginUtterance(defaultVoiceProfileV15('b1'), 0);
  tts.feedSentence('Câu thường thứ nhất.', 'normal', 0);
  tts.feedSentence('Câu thường thứ hai.', 'normal', 0);
  tts.feedSentence('Câu khẩn cấp!', 'urgent', 0);
  assert.equal(tts.schedule()[0].text, 'Câu khẩn cấp!');
  assert.equal(tts.stats().chunksPreempted, 2);
});

test('tts v17: cancel-unplayed keeps the spoken prefix', () => {
  const tts = createTtsStreamV17(undefined, {}, () => {});
  tts.beginUtterance(defaultVoiceProfileV15('b1'), 0);
  tts.feedSentence('Câu một. Câu hai. Câu ba. Câu bốn. Câu năm.', 'normal', 0);
  tts.endUtterance();
  tts.tick(20);
  tts.tick(20);
  const cancelled = tts.cancelUnplayed();
  assert.equal(cancelled.cancelledChars, 41);
  assert.equal(cancelled.cancelledText, 'Câu một. Câu hai. Câu ba. Câu bốn. Câu năm.');
  assert.ok(cancelled.cancelledChunks >= 1);
  assert.equal(tts.getState(), 'speaking');
});

test('tts v17: queue-full guard + pause/resume + one-shot speak', () => {
  const small = createTtsStreamV17(undefined, { maxQueuedChunks: 2 }, () => {});
  small.beginUtterance(defaultVoiceProfileV15('b1'), 0);
  small.feedSentence('Câu một. Câu hai.', 'normal', 0);
  assert.throws(() => small.feedSentence('Câu ba. Câu bốn. Câu năm. Câu sáu.', 'normal', 0), /queue full/);
  small.cancel();

  const tts = createTtsStreamV17(undefined, {}, () => {});
  tts.beginUtterance(defaultVoiceProfileV15('b1'), 0);
  tts.feedSentence('Câu đầu tiên. Câu thứ hai.', 'normal', 0);
  tts.pause(10);
  assert.equal(tts.getState(), 'paused');
  assert.equal(tts.isPaused(), true);
  assert.equal(tts.stats().pauses, 1);
  tts.resume(30);
  assert.equal(tts.getState(), 'speaking');
  assert.equal(tts.isSpeaking(), true);

  const once = createTtsStreamV17(undefined, {}, () => {});
  const chunks = once.speak('Một câu. Hai câu!', defaultVoiceProfileV15('b1'), 0);
  assert.equal(chunks.length, 2);
  for (let i = 0; i < 100 && once.getState() === 'speaking'; i += 1) once.tick(20);
  assert.equal(once.getState(), 'done');
  assert.equal(once.stats().sentences, 2);
});

// ---------------------------------------------------------------- turn-taking v5

test('turn-taking v17: defaults, validation, state helpers', () => {
  assert.deepEqual(TURN_TAKING_V17_STATES, ['idle', 'listening', 'thinking', 'speaking', 'interrupted', 'closed']);
  const defaults = defaultTurnTakingV17Options();
  assert.equal(defaults.initialState, 'idle');
  assert.equal(defaults.listeningSilenceTimeoutMs, 15000);
  assert.equal(defaults.thinkingTimeoutMs, 30000);
  assert.equal(defaults.speakingMaxMs, 120000);
  assert.equal(defaults.interruptedTimeoutMs, 10000);
  assert.deepEqual(validateTurnTakingV17Options({}), []);
  assert.ok(validateTurnTakingV17Options({ thinkingTimeoutMs: 100 }).length > 0);
  assert.ok(validateTurnTakingV17Options({ speakingMaxMs: 100 }).length > 0);
  assert.ok(validateTurnTakingV17Options({ initialState: 'bogus' }).length > 0);
  assert.equal(isTurnTakingV17Live('speaking'), true);
  assert.equal(isTurnTakingV17Live('idle'), false);
  assert.equal(isTurnTakingV17UserTurn('listening'), true);
  assert.equal(isTurnTakingV17UserTurn('speaking'), false);
  assert.equal(isTurnTakingV17ModelSpeaking('speaking'), true);
  assert.equal(isTurnTakingV17ModelSpeaking('thinking'), false);
});

test('turn-taking v17: full event-driven cycle', () => {
  const machine = createTurnTakingMachineV17({ initialState: 'idle' });
  assert.equal(machine.getState(), 'idle');
  assert.equal(machine.handle({ kind: 'connect', atMs: 0 }).ok, true);
  assert.equal(machine.getState(), 'listening');
  assert.equal(machine.handle({ kind: 'vad-speech-end', atMs: 100 }).ok, true);
  assert.equal(machine.getState(), 'thinking');
  assert.equal(machine.handle({ kind: 'reply-start', atMs: 200 }).ok, true);
  assert.equal(machine.getState(), 'speaking');
  assert.equal(machine.handle({ kind: 'sentence-end', atMs: 300 }).ok, true);
  assert.equal(machine.getState(), 'speaking');
  assert.equal(machine.handle({ kind: 'reply-done', atMs: 400 }).ok, true);
  assert.equal(machine.getState(), 'listening');
  assert.equal(machine.getStats().turnsCompleted, 1);
  assert.equal(machine.getStats().sentencesSpoken, 1);
  // Illegal here: reply-done while listening is rejected and counted.
  const rejected = machine.handle({ kind: 'reply-done', atMs: 500 });
  assert.equal(rejected.ok, false);
  assert.equal(machine.getStats().rejected, 1);
  assert.equal(machine.getState(), 'listening');
  // 4 recorded transitions: sentence-end stays in speaking (a null
  // target is noted, not recorded), so it adds no history entry.
  assert.equal(machine.getHistory().length, 4);
  assert.match(machine.summary(), /turn-taking v17:/);
  assert.match(machine.markdown(), /## Turn-taking v17/);
  assert.match(turnTakingV17Summary(machine), /turn-taking v17:/);
  assert.match(turnTakingV17Markdown(machine), /## Turn-taking v17/);
});

test('turn-taking v17: barge-in → interrupted → watchdog recovery', () => {
  const events = [];
  const machine = createTurnTakingMachineV17(
    { initialState: 'idle', interruptedTimeoutMs: 2000 },
    (event) => events.push(event.kind),
  );
  machine.handle({ kind: 'connect', atMs: 0 });
  machine.handle({ kind: 'reply-start', atMs: 100 });
  assert.equal(machine.getState(), 'speaking');
  machine.handle({ kind: 'barge-in', atMs: 200 });
  assert.equal(machine.getState(), 'interrupted');
  // Still inside the window: no recovery yet.
  assert.equal(machine.tick(1500), undefined);
  assert.equal(machine.getState(), 'interrupted');
  const recovered = machine.tick(2500);
  assert.ok(recovered, 'watchdog should recover a stuck interrupted state');
  assert.equal(recovered.to, 'listening');
  assert.equal(machine.getState(), 'listening');
  assert.equal(machine.getStats().recoveries, 1);
  assert.equal(machine.getStats().timeouts, 1);
  assert.ok(events.includes('turn-recovered'));
  // Resume from interrupted without waiting: vad-speech-start listens again.
  machine.handle({ kind: 'reply-start', atMs: 3000 });
  machine.handle({ kind: 'barge-in', atMs: 3100 });
  assert.equal(machine.handle({ kind: 'vad-speech-start', atMs: 3200 }).ok, true);
  assert.equal(machine.getState(), 'listening');
});

test('turn-taking v17: listening silence prompts, thinking/speaking timeouts, reset', () => {
  const machine = createTurnTakingMachineV17({
    initialState: 'idle',
    listeningSilenceTimeoutMs: 5000,
    thinkingTimeoutMs: 3000,
    speakingMaxMs: 10000,
  });
  machine.handle({ kind: 'connect', atMs: 0 });
  machine.tick(4000);
  assert.equal(machine.getStats().prompts, 0);
  machine.tick(5000);
  assert.equal(machine.getStats().prompts, 1);
  assert.equal(machine.getStats().timeouts, 1);
  assert.equal(machine.getState(), 'listening');
  assert.ok(machine.lastPromptAt() === 5000);

  machine.handle({ kind: 'vad-speech-end', atMs: 6000 });
  assert.equal(machine.getState(), 'thinking');
  machine.tick(9000);
  assert.equal(machine.getState(), 'listening');
  assert.equal(machine.getStats().recoveries, 1);

  machine.handle({ kind: 'reply-start', atMs: 10000 });
  assert.equal(machine.getState(), 'speaking');
  machine.tick(20000);
  assert.equal(machine.getState(), 'listening');
  assert.equal(machine.getStats().recoveries, 2);

  const reset = machine.reset('test-reset', 21000);
  assert.equal(reset.ok, true);
  assert.equal(machine.getState(), 'idle');
  machine.handle({ kind: 'disconnect', atMs: 22000 });
  assert.equal(machine.getState(), 'closed');
  assert.equal(machine.handle({ kind: 'connect', atMs: 23000 }).ok, true);
  assert.equal(machine.getState(), 'listening');
});

// ------------------------------------------------------------ voice profiles v2

test('profiles v17: defaults, validation, presets', () => {
  const profile = defaultVoiceProfileV17('bot1');
  assert.equal(profile.botId, 'bot1');
  assert.equal(profile.provider, 'mock');
  assert.equal(profile.language, 'vi');
  assert.equal(profile.rate, 1);
  assert.equal(profile.pitch, 0);
  assert.ok(profile.displayName.length > 0);
  assert.deepEqual(validateVoiceProfileV17(profile), []);
  assert.ok(validateVoiceProfileV17({ ...profile, rate: 5 }).length > 0);
  assert.ok(validateVoiceProfileV17({ ...profile, pitch: 99 }).length > 0);
  assert.ok(validateVoiceProfileV17({ ...profile, displayName: '' }).length > 0);
  assert.ok(validateVoiceProfileV17({ ...profile, context: 'bogus' }).length > 0);
  assert.ok(validateVoiceProfileV17({ ...profile, tags: [''] }).length > 0);
  const presets = presetVoiceProfilesV17('bot1');
  assert.equal(presets.length, 4);
  assert.ok(presets.some((p) => p.id === 'preset-vi-nu-nhe'));
  assert.ok(presets.some((p) => p.id === 'preset-vi-nam-tram'));
  assert.ok(presets.some((p) => p.language === 'en'));
  assert.deepEqual(VOICE_V17_CONTEXTS, ['chat', 'announcement', 'alert', 'narration', 'whisper']);
  assert.equal(isVoiceProfileV17Context('chat'), true);
  assert.equal(isVoiceProfileV17Context('bogus'), false);
});

test('profiles v17: store CRUD, user default, clone-for-user', () => {
  const store = createVoiceProfileStoreV17('bot1');
  assert.equal(store.count(), 4);
  const mine = defaultVoiceProfileV17('bot1', {
    id: 'my-voice',
    displayName: 'Giọng của tôi',
    language: 'vi',
    rate: 1.1,
    userId: 'u1',
    context: 'chat',
  });
  store.set(mine);
  assert.equal(store.count(), 5);
  assert.equal(store.get('my-voice').rate, 1.1);
  assert.equal(store.listForUser('u1').length, 1);
  assert.equal(store.listForBot('bot1').length, 5);
  assert.equal(store.listForContext('chat').length, 1);
  store.setUserDefault('u1', 'my-voice');
  assert.equal(store.getUserDefault('u1').id, 'my-voice');
  assert.equal(store.clearUserDefault('u1'), true);
  assert.equal(store.getUserDefault('u1'), undefined);
  assert.throws(() => store.setUserDefault('u1', 'no-such-profile'), /unknown voice profile/);
  const clone = store.cloneForUser('preset-vi-nu-nhe', 'u2');
  assert.equal(clone.userId, 'u2');
  assert.ok(clone.id.startsWith('preset-vi-nu-nhe-user-u2'));
  assert.equal(store.count(), 6);
  assert.equal(store.remove('my-voice'), true);
  assert.equal(store.remove('my-voice'), false);
  assert.equal(store.count(), 5);
  assert.throws(() => store.set({ ...mine, id: 'bad', rate: 9 }), /invalid voice profile/);
  assert.match(store.summary(), /voice profiles v17:/);
  assert.match(store.markdown(), /## Voice profiles v17/);
  assert.match(voiceProfilesV17Summary(store), /voice profiles v17:/);
  assert.match(voiceProfilesV17Markdown(store), /## Voice profiles v17/);
});

test('profiles v17: resolve fallback chain + JSON persistence', () => {
  const store = createVoiceProfileStoreV17('bot1');
  const mine = defaultVoiceProfileV17('bot1', {
    id: 'u1-chat',
    displayName: 'Giọng chat của u1',
    language: 'vi',
    userId: 'u1',
    context: 'chat',
  });
  store.set(mine);
  store.setUserDefault('u1', 'u1-chat');
  // Exact user + bot + context wins.
  assert.equal(store.resolve({ userId: 'u1', botId: 'bot1', context: 'chat', language: 'vi' }).via, 'user-bot-context');
  // Same user + bot, another context: the user+bot match beats the
  // user default (the chain checks user-bot before user-default).
  assert.equal(store.resolve({ userId: 'u1', botId: 'bot1', context: 'alert', language: 'vi' }).via, 'user-bot');
  // The user default wins when no user+bot profile matches the
  // language: the default lives on another bot, in English.
  const otherBot = defaultVoiceProfileV17('other-bot', {
    id: 'u1-other-en',
    displayName: 'Giọng tiếng Anh của u1',
    language: 'en',
    userId: 'u1',
  });
  store.set(otherBot);
  store.setUserDefault('u1', 'u1-other-en');
  assert.equal(store.resolve({ userId: 'u1', botId: 'bot1', context: 'alert', language: 'en' }).via, 'user-default');
  // Unknown user on the same bot → a bot profile.
  assert.equal(store.resolve({ userId: 'u9', botId: 'bot1', context: 'chat', language: 'vi' }).via, 'bot');
  // Unknown bot, known language → a preset in that language.
  assert.equal(store.resolve({ botId: 'other-bot', context: 'chat', language: 'en' }).via, 'preset');
  // Nothing matches the language at all → the built-in default.
  const fallback = store.resolve({ botId: 'other-bot', context: 'chat', language: 'de' });
  assert.equal(fallback.via, 'default');
  assert.equal(fallback.profile.language, 'de');

  const snapshot = store.toJSON();
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.profiles.length, 6);
  assert.equal(snapshot.userDefaults.u1, 'u1-other-en');
  const restored = createVoiceProfileStoreV17();
  assert.deepEqual(restored.fromJSON(snapshot), { loaded: 6, dropped: 0 });
  assert.equal(restored.count(), 6);
  assert.equal(restored.getUserDefault('u1').id, 'u1-other-en');
  // Invalid entries are dropped, never fatal.
  const dirty = JSON.parse(JSON.stringify(snapshot));
  dirty.profiles.push({ id: 'broken', rate: 99 });
  dirty.userDefaults.ghost = 'no-such-profile';
  const restored2 = createVoiceProfileStoreV17();
  assert.deepEqual(restored2.fromJSON(dirty), { loaded: 6, dropped: 2 });
  assert.equal(restored2.count(), 6);
  assert.throws(() => restored2.fromJSON({ version: 2, profiles: [] }), /unsupported.*version/);
  assert.throws(() => restored2.fromJSON(null), /must be an object/);
  const stats = store.stats();
  assert.equal(stats.profiles, 6);
  assert.equal(stats.presets, 4);
  assert.equal(stats.userDefaults, 1);
});

// ------------------------------------------------------------------ session v17

test('session v17: connect + full turn (transcript → reply → TTS v3)', async () => {
  const session = createVoiceSessionV17('s1', {
    language: 'vi',
    replyFor: (text) => `Trả lời cho: ${text}. Đây là câu thứ hai.`,
  });
  assert.equal(session.getState(), 'idle');
  await session.connect();
  assert.equal(session.getState(), 'listening');
  session.feedTranscriptFinal('Xin chào bot.');
  session.tick(600);
  session.feedSilence(600);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  session.tick(5000);
  assert.equal(session.getState(), 'listening');
  assert.equal(session.turnsList().length, 1);
  const [turn] = session.turnsList();
  assert.equal(turn.userText, 'Xin chào bot.');
  assert.match(turn.replyText, /Trả lời cho: Xin chào bot\./);
  assert.equal(turn.bargeIn, false);
  assert.equal(session.stats().turns, 1);
  assert.equal(session.stats().tts.chunksSpoken, 2);
  assert.match(session.summary(), /voice session v17 s1:/);
  assert.match(session.markdown(), /## Voice session v17 — s1/);
  session.disconnect();
  assert.equal(session.getState(), 'closed');
});

test('session v17: barge-in with manual resume restarts on correction', async () => {
  const longReply = 'Một câu trả lời rất dài. Câu thứ hai của câu trả lời. Câu thứ ba nữa. Câu thứ tư để chắc chắn còn nhiều chữ.';
  const session = createVoiceSessionV17('s2', {
    language: 'vi',
    autoResume: false,
    replyFor: () => longReply,
  });
  await session.connect();
  await session.speakReply(longReply);
  assert.equal(session.getState(), 'speaking');
  assert.equal(session.tts.isSpeaking(), true);
  session.tick(60);
  const record = session.interrupt(session.now(), 'khoan đã');
  assert.ok(record, 'cut should land while speaking');
  assert.equal(record.plan.action, 'restart');
  assert.equal(record.plan.kind, 'correction');
  assert.ok(record.receipt.context.remainingText.length > 0, 'remaining text is kept');
  assert.equal(session.getState(), 'interrupted');
  assert.ok(session.pendingResumePlan(), 'plan waits for an explicit resume');
  assert.equal(session.lastCutReceipt(), record);
  await session.resumeAfterCut();
  session.tick(5000);
  assert.equal(session.getState(), 'listening');
  assert.equal(session.pendingResumePlan(), undefined);
  const stats = session.stats();
  assert.equal(stats.bargeIns, 1);
  assert.equal(stats.restarts, 1);
  assert.equal(session.turnsList().length, 0, 'a direct speakReply records no turn');
  session.disconnect();
});

test('session v17: barge-in with auto-resume continues from the cut', async () => {
  const events = [];
  const session = createVoiceSessionV17(
    's3',
    {
      language: 'vi',
      autoResume: true,
      replyFor: () => 'Một câu trả lời rất dài. Câu thứ hai. Câu thứ ba. Câu thứ tư.',
    },
    (event) => events.push(event.kind),
  );
  await session.connect();
  await session.speakReply('Một câu trả lời rất dài. Câu thứ hai. Câu thứ ba. Câu thứ tư.');
  session.tick(60);
  const record = session.interrupt(session.now(), 'ừ');
  assert.ok(record);
  assert.equal(record.plan.action, 'resume');
  await Promise.resolve();
  await Promise.resolve();
  session.tick(5000);
  assert.equal(session.getState(), 'listening');
  assert.equal(session.stats().bargeIns, 1);
  assert.equal(session.stats().resumes, 1);
  assert.ok(events.includes('barge-in'));
  assert.ok(events.includes('resume-plan'));
  assert.ok(events.includes('resumed'));
  session.disconnect();
});

test('session v17: VAD feed through the mic path + manager registry', async () => {
  const manager = createVoiceSessionManagerV17('bot1');
  const a = manager.create('a', { language: 'vi' });
  const b = manager.create('b', { language: 'en' });
  assert.equal(manager.count(), 2);
  assert.equal(manager.get('a'), a);
  assert.throws(() => manager.create('a'), /already exists/);
  await a.connect();
  let now = 0;
  for (let i = 0; i < 15; i += 1) {
    a.feedAudioFrame(speechFrame());
    a.tick(20);
    now += 20;
  }
  assert.equal(a.vad.getClass(), 'speech');
  assert.equal(a.getState(), 'listening');
  // A profile resolves per user + bot + context, never hard-coded.
  const { profile, via } = a.resolveProfile();
  assert.ok(profile.id.length > 0);
  assert.ok(typeof via === 'string' && via.length > 0);
  await a.connect();
  assert.equal(manager.delete('a'), true);
  assert.equal(manager.count(), 1);
  assert.equal(b.getState(), 'idle');
  manager.delete('b');
  assert.equal(manager.count(), 0);
});

// --------------------------------------------------------------------- tools

test('tools v17: 10 tools, unique names, full lifecycle', async () => {
  const tools = createVoiceV17Tools();
  assert.equal(tools.length, 10);
  assert.deepEqual(tools.map((t) => t.definition.name), [...VOICE_V17_TOOL_NAMES]);
  assert.equal(new Set(VOICE_V17_TOOL_NAMES).size, 10);
  for (const name of VOICE_V17_TOOL_NAMES) assert.equal(isVoiceV17ToolName(name), true);
  assert.equal(isVoiceV17ToolName('voice_v16_session_create'), false);
  assert.equal(VOICE_V17_TOOLS.length, 10);
  const byName = new Map(tools.map((t) => [t.definition.name, t]));
  const run = async (name, args) => JSON.parse(await byName.get(name).execute(args));

  const created = await run('voice_v17_session_create', {
    sessionId: 't1', language: 'en', userId: 'u1', voiceContext: 'chat',
    mockReply: 'Hi there. This is the second sentence of the reply.',
    connect: true,
  });
  assert.equal(created.created, true);
  const talked = await run('voice_v17_talk', { sessionId: 't1', text: 'Hello.' });
  assert.equal(talked.turns.length, 1);
  const listed = await run('voice_v17_session_list', {});
  assert.equal(listed.sessions.length, 1);
  assert.equal(listed.sessions[0].turns, 1);
  assert.equal(listed.sessions[0].userId, 'u1');
  const stats = await run('voice_v17_session_stats', { sessionId: 't1' });
  assert.equal(stats.stats.turns, 1);
  assert.equal(stats.stats.tts.chunksSpoken, 2);
  // VAD: feed speech frames through the mic path, class flips to speech.
  const vadFed = await run('voice_v17_vad', { sessionId: 't1', action: 'feed', kind: 'speech', frames: 15 });
  assert.equal(vadFed.class, 'speech');
  assert.ok(vadFed.stats.frames >= 15);
  // TTS: speak a long text (16 sentences, so several chunks are
  // still unplayed after the tool's 1000 ms tick), then cut it.
  const longText = 'Sentence one here. Sentence two here. Sentence three here. Sentence four here. Sentence five here. Sentence six here. Sentence seven here. Sentence eight here. Sentence nine here. Sentence ten here. Sentence eleven here. Sentence twelve here. Sentence thirteen here. Sentence fourteen here. Sentence fifteen here. Sentence sixteen here.';
  const spoken = await run('voice_v17_tts', { sessionId: 't1', action: 'speak', text: longText });
  assert.equal(spoken.state, 'speaking');
  const barge = await run('voice_v17_barge_in', { sessionId: 't1', interruptingText: 'ừ' });
  assert.equal(barge.cut, true);
  assert.equal(barge.record.plan.action, 'resume');
  assert.ok(barge.record.receipt.context.remainingText.length > 40);
  // Profiles: set a user voice, resolve it, list presets.
  const saved = await run('voice_v17_profiles', {
    action: 'set', profileId: 'u1-voice', userId: 'u1', botId: 'default-bot',
    context: 'chat', displayName: 'U1 voice', language: 'en', rate: 1.1,
  });
  assert.equal(saved.saved, true);
  const resolved = await run('voice_v17_profiles', {
    action: 'resolve', userId: 'u1', botId: 'default-bot', context: 'chat', language: 'en',
  });
  assert.equal(resolved.profile.id, 'u1-voice');
  assert.equal(resolved.via, 'user-bot-context');
  const presets = await run('voice_v17_profiles', { action: 'presets', botId: 'default-bot' });
  assert.equal(presets.presets.length, 4);
  const stopped = await run('voice_v17_session_stop', { sessionId: 't1' });
  assert.equal(stopped.stopped, true);
  const deleted = await run('voice_v17_session_delete', { sessionId: 't1' });
  assert.equal(deleted.deleted, true);
  // Unknown sessions return a plain "Error: ..." string, not JSON.
  const unknown = await byName.get('voice_v17_session_stats').execute({ sessionId: 'nope' });
  assert.match(unknown, /Unknown voice v17 session/);
});

test('tools v17: create validates context / preset / priority / profile', async () => {
  const tools = createVoiceV17Tools();
  const byName = new Map(tools.map((t) => [t.definition.name, t]));
  const create = byName.get('voice_v17_session_create');
  assert.match(await create.execute({ sessionId: 'x', voiceContext: 'bogus' }), /Unknown voice context/);
  assert.match(await create.execute({ sessionId: 'x', vadPreset: 'cafe' }), /Unknown VAD preset/);
  await create.execute({ sessionId: 'y', connect: true });
  const tts = byName.get('voice_v17_tts');
  assert.match(await tts.execute({ sessionId: 'y', action: 'speak', text: 'hi', priority: 'bogus' }), /Unknown TTS priority/);
  assert.match(await tts.execute({ sessionId: 'y', action: 'bogus' }), /Unknown action/);
  const vad = byName.get('voice_v17_vad');
  assert.match(await vad.execute({ sessionId: 'y', action: 'feed', kind: 'noise' }), /Unknown VAD feed kind/);
  const profiles = byName.get('voice_v17_profiles');
  assert.match(await profiles.execute({ action: 'bogus' }), /Unknown action/);
  assert.match(
    await profiles.execute({ action: 'set', profileId: 'bad', rate: 9 }),
    /invalid voice profile/,
  );
  assert.match(await profiles.execute({ action: 'import', data: 'not json' }), /valid JSON/);
});

// ------------------------------------------------------- core re-exports + i18n

test('core root re-exports v17 classes', async () => {
  const core = await import('../packages/core/dist/index.js');
  for (const name of [
    'VadV17',
    'BargeInEngineV17',
    'TtsStreamV17',
    'TurnTakingMachineV17',
    'VoiceProfileStoreV17',
    'VoiceSessionV17',
    'VoiceSessionManagerV17',
  ]) {
    assert.equal(typeof core[name], 'function', `${name} should be exported from @open-bot/core`);
  }
});

test('i18n: 48 voice.realtime.v17.* keys in all 6 locales, non-empty, same set', () => {
  const locales = ['vi', 'en', 'es', 'fr', 'ja', 'zh'];
  const dir = path.join(__dirname, '..', 'apps', 'desktop', 'src', 'renderer', 'i18n', 'locales');
  const sets = [];
  for (const locale of locales) {
    const data = JSON.parse(fs.readFileSync(path.join(dir, `${locale}.json`), 'utf8'));
    const keys = Object.keys(data).filter((k) => k.startsWith('voice.realtime.v17.')).sort();
    assert.equal(keys.length, 48, `${locale} should have 48 v17 keys, got ${keys.length}`);
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
