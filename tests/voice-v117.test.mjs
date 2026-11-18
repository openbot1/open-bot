/**
 * Tests for v1.17 — voice realtime v16 (Team T5).
 *
 *   1. Streaming STT v4 (s2sV16.ts): word schedule → partials with
 *      timings, final after silence, force-final, stats.
 *   2. Bounded queue v4: FIFO order, drop-oldest at capacity,
 *      high-water pause / low-water resume, stats.
 *   3. S2S pipeline v4: full path mic → STT → agent → TTS → speaker
 *      on mock transport; backpressure drops counted; resume token
 *      snapshot; drop mid-turn → reconnect → resume from the first
 *      unspoken chunk (no replay); failure → pipeline fallback.
 *   4. Barge-in v4 (bargeInV16.ts): immediate cut while TTS plays,
 *      spoken prefix + remaining text + turn context kept, partial
 *      vs full cut, echo-aware suppression while TTS plays,
 *      delayed cut, interruption capture.
 *   5. Semantic turn-taking v4 (smartTurnV16.ts): end on complete
 *      sentence + silence, hold on trailing conjunction / open
 *      question / list in progress, backchannel ends at once,
 *      max-wait timeout → prompt → end, question-wait boost.
 *   6. Wake word v4 (wakeWordV16.ts): multi-word + per-word
 *      sensitivity, wake + command in one breath, auto-sleep after
 *      silence, manual sleep, wake-storm mute, labelled evaluation.
 *   7. TTS streaming v2 (ttsStreamV16.ts): small chunks, first
 *      chunk plays at once, gapless joins (negative gaps =
 *      crossfade), pause/resume shifts the timeline, cancel keeps
 *      the spoken prefix, underrun counted only after the first
 *      chunk.
 *   8. Session v16 (sessionV16.ts): connect, full turn (transcript
 *      → reply → TTS v2), barge-in cut mid-speech keeps the spoken
 *      prefix, wake from asleep (bare + with command), auto-sleep,
 *      manager registry.
 *   9. Tools (voiceV16Tools.ts): 10 tools, unique names, full
 *      lifecycle through the tools (create → talk → stats →
 *      barge-in → s2s → wake-word → tts → stop → delete).
 *  10. Core root re-exports + i18n: v16 classes importable from
 *      `@open-bot/core`; 48 `voice.realtime.v16.*` keys in all 6
 *      locales, non-empty, same key set everywhere.
 *
 * No network, no sound card, no live provider, no key. Every audio
 * path is mock (synthetic PCM frames, scripted S2S events, mock
 * synth, scripted replies). Run after building core + tools:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/voice-v117.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  StreamingSttV16,
  BoundedQueueV16,
  SpeechToSpeechPipelineV16,
  S2S_V16_FRAME_SAMPLES,
  BargeInEngineV16,
  defaultBargeInV16Options,
  validateBargeInV16Options,
  SmartTurnDetectorV16,
  decideSmartTurnV16,
  speechRateWpsV16,
  isListInProgressV16,
  WakeWordDetectorV16,
  extractWakeCommandV16,
  TtsStreamV16,
  ttsChunkDurationMsV16,
  VoiceSessionV16,
  VoiceSessionManagerV16,
} from '../packages/core/dist/voiceV16/index.js';
import { syntheticFrameV15, defaultVoiceProfileV15 } from '../packages/core/dist/voiceV15/index.js';
import {
  createVoiceV16Tools,
  VOICE_V16_TOOLS,
  VOICE_V16_TOOL_NAMES,
  isVoiceV16ToolName,
} from '../packages/tools/dist/voiceV16Tools.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Feed `count` loud frames (20 ms each) to a barge-in engine. */
function feedSpeechFrames(engine, count, atMsStart, rms = 0.2) {
  let atMs = atMsStart;
  let last;
  for (let i = 0; i < count; i += 1) {
    last = engine.feed({ frame: syntheticFrameV15(rms), atMs });
    atMs += 20;
  }
  return { last, endMs: atMs };
}

function feedSilenceFrames(engine, count, atMsStart) {
  let atMs = atMsStart;
  let last;
  for (let i = 0; i < count; i += 1) {
    last = engine.feed({ frame: syntheticFrameV15(0.001), atMs });
    atMs += 20;
  }
  return { last, endMs: atMs };
}

// ---------------------------------------------------------------- STT v4

test('streaming STT v4: word schedule fires partials, silence finalises', () => {
  const events = [];
  const stt = new StreamingSttV16(
    { wordSchedule: [{ word: 'xin', atMs: 0 }, { word: 'chào', atMs: 100 }, { word: 'bạn', atMs: 200 }] },
    (e) => events.push(e),
  );
  const frame = syntheticFrameV15(0.2);
  stt.feedFrame(frame, 0);
  stt.feedFrame(frame, 100);
  stt.feedFrame(frame, 200);
  assert.equal(events.filter((e) => e.kind === 'partial').length, 3);
  assert.equal(events[2].text, 'xin chào bạn');
  assert.deepEqual(events[2].words.map((w) => w.word), ['xin', 'chào', 'bạn']);
  const fin = stt.feedSilence(400, 700);
  assert.equal(fin?.kind, 'final');
  assert.equal(fin?.text, 'xin chào bạn');
  assert.equal(stt.stats().finals, 1);
  assert.equal(stt.stats().wordsHeard, 3);
});

test('streaming STT v4: force-final and empty turn', () => {
  const stt = new StreamingSttV16({ wordSchedule: [{ word: 'alo', atMs: 0 }] });
  assert.equal(stt.forceFinal(0), undefined);
  stt.feedFrame(syntheticFrameV15(0.2), 0);
  const fin = stt.forceFinal(50);
  assert.equal(fin?.kind, 'final');
  assert.equal(fin?.text, 'alo');
});

test('streaming STT v4: options validation', () => {
  assert.deepEqual(new StreamingSttV16().stats().partials, 0);
  assert.throws(() => new StreamingSttV16({ finalSilenceMs: 10 }), /finalSilenceMs/);
  assert.throws(() => new StreamingSttV16({ wordSchedule: [{ word: ' ', atMs: 0 }] }), /must not be empty/);
});

// ------------------------------------------------------------- bounded queue

test('bounded queue v4: FIFO, drop-oldest, pause/resume watermarks', () => {
  const q = new BoundedQueueV16(5, 0.8, 0.4);
  for (let i = 1; i <= 5; i += 1) q.push(i);
  assert.equal(q.isPaused, true); // 5 >= high-water 4
  assert.equal(q.stats().pauses, 1);
  const dropped = q.push(6);
  assert.equal(dropped.dropped, 1);
  assert.equal(q.stats().dropped, 1);
  assert.deepEqual([q.shift(), q.shift(), q.shift()], [2, 3, 4]);
  assert.equal(q.isPaused, false); // 2 <= low-water 2
  assert.deepEqual([q.shift(), q.shift(), q.shift()], [5, 6, undefined]);
  assert.throws(() => new BoundedQueueV16(0), /capacity/);
});

// ------------------------------------------------------------ S2S pipeline v4

test('s2s pipeline v4: full path mic → STT → agent → TTS → speaker', async () => {
  const events = [];
  const pipeline = new SpeechToSpeechPipelineV16(
    {
      sttWordSchedule: [{ word: 'thời', atMs: 0 }, { word: 'tiết', atMs: 100 }],
      replyChunksFor: () => ['Hôm nay trời đẹp.', 'Nhiệt độ 28 độ.'],
    },
    (e) => events.push(e),
  );
  await pipeline.connect();
  assert.equal(pipeline.getState(), 'streaming');
  const frame = syntheticFrameV15(0.2);
  for (let t = 0; t < 400; t += 20) {
    pipeline.feedMicFrame(frame);
    pipeline.tick(20);
  }
  pipeline.feedSilence(500);
  pipeline.tick(500);
  pipeline.tick(2000);
  const stats = pipeline.stats();
  assert.equal(stats.sttFinals, 1);
  assert.ok(stats.replyChunksSpoken >= 1, `reply chunks spoken: ${stats.replyChunksSpoken}`);
  assert.ok(stats.audioChunksPlayed >= 1, `audio chunks played: ${stats.audioChunksPlayed}`);
  assert.ok(events.some((e) => e.kind === 'stt-final' && e.text === 'thời tiết'));
  assert.ok(events.some((e) => e.kind === 'turn-end'));
  pipeline.disconnect();
  assert.equal(pipeline.getState(), 'closed');
});

test('s2s pipeline v4: backpressure drops oldest mic frames, counts them', async () => {
  const events = [];
  const pipeline = new SpeechToSpeechPipelineV16(
    { maxQueuedFrames: 5, sttWordSchedule: [] },
    (e) => events.push(e),
  );
  await pipeline.connect();
  const frame = syntheticFrameV15(0.2);
  // Flood the mic queue without ticking (no drain).
  for (let i = 0; i < 12; i += 1) pipeline.feedMicFrame(frame);
  const stats = pipeline.stats();
  assert.equal(stats.mic.dropped, 7);
  assert.ok(events.some((e) => e.kind === 'dropped' && e.queue === 'mic'));
  assert.ok(events.some((e) => e.kind === 'backpressure' && e.queue === 'mic'));
  pipeline.tick(20);
  assert.equal(pipeline.stats().mic.depth, 0);
});

test('s2s pipeline v4: resume token snapshots the live turn', () => {
  const pipeline = new SpeechToSpeechPipelineV16({
    replyChunksFor: () => ['một', 'hai', 'ba'],
  });
  pipeline.startTurnFromText('xin chào');
  const token = pipeline.resumeToken();
  assert.ok(token);
  assert.equal(token.transcriptPrefix, 'xin chào');
  assert.deepEqual(token.pendingReplyChunks, ['một', 'hai', 'ba']);
  assert.equal(token.spokenReplyChunks, 0);
  assert.equal(token.turnId, 'turn-1');
});

test('s2s pipeline v4: drop mid-turn → reconnect → resume without replay', async () => {
  const events = [];
  const pipeline = new SpeechToSpeechPipelineV16(
    {
      // Words 40 ms apart, final after 200 ms of silence: the turn
      // finalises (~260 ms) AFTER the drop at 150 ms, while the
      // pipeline is reconnecting — so the reply chunks stay pending
      // and the reconnect must resume them, not replay them.
      sttWordSchedule: [{ word: 'kể', atMs: 0 }, { word: 'chuyện', atMs: 40 }],
      sttFinalSilenceMs: 200,
      s2sDropAtMs: 150,
      replyChunksFor: () => ['Ngày xửa ngày xưa.', 'Có một chú bot.'],
    },
    (e) => events.push(e),
  );
  await pipeline.connect();
  const frame = syntheticFrameV15(0.2);
  for (let t = 0; t < 500; t += 20) {
    pipeline.feedMicFrame(frame);
    pipeline.tick(20);
  }
  // Reconnect delay is 250 ms; tick well past it. The adapter's
  // reconnect is async, so flush microtasks before the next tick
  // lets the pipeline notice the reconnected stream.
  pipeline.tick(1000);
  await Promise.resolve();
  await Promise.resolve();
  pipeline.tick(100);
  pipeline.tick(1000);
  const stats = pipeline.stats();
  assert.ok(stats.reconnects >= 1, `reconnects: ${stats.reconnects}`);
  assert.equal(pipeline.getState(), 'streaming');
  assert.ok(events.some((e) => e.kind === 'reconnected'));
  assert.ok(stats.resumes >= 1, `resumes: ${stats.resumes}`);
  assert.ok(events.some((e) => e.kind === 'resumed'));
  assert.equal(stats.lastResumeTurnId, 'turn-1');
  pipeline.disconnect();
});

test('s2s pipeline v4: failed connect falls back to the pipeline', async () => {
  const events = [];
  const pipeline = new SpeechToSpeechPipelineV16(
    { s2sFailConnectWith: 'boom', maxReconnectAttempts: 0 },
    (e) => events.push(e),
  );
  await pipeline.connect();
  assert.equal(pipeline.getMode(), 'pipeline');
  assert.equal(pipeline.stats().fallbacks, 1);
  assert.ok(events.some((e) => e.kind === 'fallback'));
});

test('s2s pipeline v4: options validation', () => {
  assert.throws(() => new SpeechToSpeechPipelineV16({ maxQueuedFrames: 1 }), /maxQueuedFrames/);
  assert.throws(() => new SpeechToSpeechPipelineV16({ maxQueuedAudioChunks: 0 }), /maxQueuedAudioChunks/);
});

// ---------------------------------------------------------------- barge-in v4

test('barge-in v4: cut while TTS plays keeps spoken prefix + context', () => {
  const cuts = [];
  let ttsStopped = false;
  const engine = new BargeInEngineV16(
    {},
    {
      stopTts: () => {
        ttsStopped = true;
        return { spokenText: 'Xin chào, hôm nay', remainingText: 'trời rất đẹp.' };
      },
    },
    (e) => {
      if (e.kind === 'cut') cuts.push(e.receipt);
    },
  );
  engine.beginAgentTurn('turn-1', 'thời tiết thế nào', 'Xin chào, hôm nay trời rất đẹp.', 0);
  feedSpeechFrames(engine, 20, 0);
  assert.equal(ttsStopped, true);
  assert.equal(cuts.length, 1);
  const cut = cuts[0];
  assert.equal(cut.kind, 'partial');
  assert.equal(cut.context.spokenText, 'Xin chào, hôm nay');
  assert.equal(cut.context.remainingText, 'trời rất đẹp.');
  assert.equal(cut.context.turnId, 'turn-1');
  assert.equal(cut.context.userText, 'thời tiết thế nào');
  assert.ok(cut.cutLatencyMs >= 0);
  assert.equal(engine.stats().partialCuts, 1);
});

test('barge-in v4: short spoken prefix → full cut', () => {
  const cuts = [];
  const engine = new BargeInEngineV16(
    {},
    { stopTts: () => ({ spokenText: 'Hi', remainingText: 'there, friend.' }) },
    (e) => {
      if (e.kind === 'cut') cuts.push(e.receipt);
    },
  );
  engine.beginAgentTurn('turn-1', 'alo', 'Hi there, friend.', 0);
  feedSpeechFrames(engine, 20, 0);
  assert.equal(cuts.length, 1);
  assert.equal(cuts[0].kind, 'full');
});

test('barge-in v4: echo-aware gate suppresses TTS echo while speaking', () => {
  const events = [];
  const engine = new BargeInEngineV16({ echoMarginRatio: 1.6 }, {}, (e) => events.push(e));
  engine.beginAgentTurn('turn-1', 'alo', 'Xin chào bạn.', 0);
  engine.setTtsLevel(0.2);
  // Frames at the echo level (0.2) are below echo × 1.6 → suppressed.
  feedSpeechFrames(engine, 20, 0, 0.2);
  assert.equal(engine.stats().cuts, 0);
  assert.ok(engine.stats().echoSuppressions > 0);
  // A loud user (0.5 > 0.2 × 1.6) cuts through.
  feedSpeechFrames(engine, 20, 400, 0.5);
  assert.equal(engine.stats().cuts, 1);
});

test('barge-in v4: cough is rejected, no cut', () => {
  const engine = new BargeInEngineV16({}, { stopTts: () => ({ spokenText: '', remainingText: '' }) });
  engine.beginAgentTurn('turn-1', 'alo', 'Xin chào.', 0);
  feedSpeechFrames(engine, 3, 0); // ~60 ms burst < coughMaxMs
  feedSilenceFrames(engine, 30, 60);
  assert.equal(engine.stats().cuts, 0);
  assert.ok((engine.stats().rejections.cough ?? 0) >= 1);
});

test('barge-in v4: delayed cut fires after cutDelayMs', () => {
  const cuts = [];
  const engine = new BargeInEngineV16(
    { cutDelayMs: 100 },
    { stopTts: () => ({ spokenText: 'Xin', remainingText: 'chào.' }) },
    (e) => {
      if (e.kind === 'cut') cuts.push(e.receipt);
    },
  );
  engine.beginAgentTurn('turn-1', 'alo', 'Xin chào.', 0);
  feedSpeechFrames(engine, 20, 0);
  assert.equal(cuts.length, 0, 'no cut before the delay');
  engine.tick(400);
  assert.equal(cuts.length, 1);
});

test('barge-in v4: options validation', () => {
  assert.deepEqual(validateBargeInV16Options({ cutDelayMs: 0 }), []);
  assert.ok(validateBargeInV16Options({ cutDelayMs: -1 }).length > 0);
  assert.ok(validateBargeInV16Options({ echoMarginRatio: 0.5 }).length > 0);
  assert.ok(validateBargeInV16Options({ coughMaxMs: 300, minSpeechMs: 250 }).length > 0);
  assert.equal(defaultBargeInV16Options().minSpeechMs, 250);
});

// ------------------------------------------------------------ smart turn v4

test('smart turn v4: complete sentence + silence ends the turn', () => {
  const ends = [];
  const detector = new SmartTurnDetectorV16({ language: 'vi' }, (e) => {
    if (e.kind === 'end') ends.push(e);
  });
  detector.feedPartial('Thời tiết hôm nay đẹp.', 0);
  detector.feedSilence(500, 500);
  assert.equal(ends.length, 1);
  assert.equal(ends[0].text, 'Thời tiết hôm nay đẹp.');
  assert.equal(detector.stats().ends, 1);
});

test('smart turn v4: trailing conjunction holds the turn (no mid-sentence cut)', () => {
  const events = [];
  const detector = new SmartTurnDetectorV16({ language: 'vi' }, (e) => events.push(e));
  detector.feedPartial('Tôi muốn hỏi và', 0);
  const out = detector.feedSilence(900, 900);
  assert.equal(out.decision, 'hold');
  assert.ok(out.holdReasons.includes('trailing-conjunction'));
  assert.equal(detector.stats().ends, 0);
  assert.ok(detector.stats().falseEndSaves >= 1);
});

test('smart turn v4: open question + list in progress hold', () => {
  const detector = new SmartTurnDetectorV16({ language: 'vi' });
  const q = detector.feedPartial('Bạn nghĩ sao về', 0);
  assert.equal(q.decision, 'hold');
  assert.ok(q.holdReasons.includes('open-question') || q.holdReasons.includes('trailing-conjunction'));
  const detector2 = new SmartTurnDetectorV16({ language: 'vi' });
  const list = decideSmartTurnV16({ text: 'Thứ nhất là giá, thứ hai là', silenceMs: 900, elapsedMs: 2000 });
  assert.equal(list.decision, 'hold');
  assert.ok(isListInProgressV16('Thứ nhất là giá, thứ hai là'));
});

test('smart turn v4: backchannel ends at once', () => {
  const ends = [];
  const detector = new SmartTurnDetectorV16({ language: 'vi' }, (e) => {
    if (e.kind === 'end') ends.push(e);
  });
  detector.feedPartial('ừ', 0);
  assert.equal(ends.length, 1);
});

test('smart turn v4: max-wait timeout prompts, then ends', () => {
  const events = [];
  const detector = new SmartTurnDetectorV16(
    { language: 'en', maxWaitMs: 2000, promptWaitMs: 1000 },
    (e) => events.push(e),
  );
  detector.feedPartial('I was thinking about', 0);
  detector.tick(2000);
  assert.ok(events.some((e) => e.kind === 'prompt'), `events: ${events.map((e) => e.kind).join(',')}`);
  assert.equal(detector.getState(), 'prompted');
  detector.tick(3000);
  assert.ok(events.some((e) => e.kind === 'timeout'));
  assert.equal(detector.stats().timeouts, 1);
});

test('smart turn v4: question-wait boost delays the end', () => {
  const detector = new SmartTurnDetectorV16({ language: 'en', questionWaitBoostMs: 5000 });
  detector.noteAgentQuestion();
  detector.feedPartial('Yes, that sounds good.', 0);
  const out = detector.feedSilence(600, 600);
  assert.equal(out.decision, 'hold');
  assert.ok(out.holdReasons.includes('awaiting-answer'));
  assert.ok(out.requiredSilenceMs > 1000);
});

test('smart turn v4: speech rate helper', () => {
  assert.equal(speechRateWpsV16(10, 2000), 5);
  assert.equal(speechRateWpsV16(0, 1000), 0);
  assert.equal(speechRateWpsV16(5, 0), 0);
});

// ---------------------------------------------------------------- wake word v4

test('wake word v4: wake + command in one breath', () => {
  const events = [];
  const detector = new WakeWordDetectorV16(undefined, undefined, (e) => events.push(e));
  const event = detector.feedTranscript('hey bot thời tiết hôm nay thế nào', 1000);
  assert.equal(event?.kind, 'wake-command');
  assert.equal(event?.command, 'thời tiết hôm nay thế nào');
  assert.equal(detector.isAwake(), true);
  assert.equal(detector.stats().wakeCommands, 1);
});

test('wake word v4: bare wake word waits for confirmation, then wakes', () => {
  const detector = new WakeWordDetectorV16();
  const activated = detector.feedTranscript('hey bot', 1000);
  assert.equal(activated?.kind, 'activated');
  assert.equal(detector.isAwake(), false);
  const confirmed = detector.feedTranscript('mở nhạc giúp tôi', 2000);
  assert.equal(confirmed?.kind, 'confirmed');
  assert.equal(detector.isAwake(), true);
});

test('wake word v4: auto-sleep after silence while awake', () => {
  const events = [];
  const detector = new WakeWordDetectorV16(undefined, { sleepAfterSilenceMs: 5000 }, (e) => events.push(e));
  detector.feedTranscript('hey bot, bật đèn lên', 0);
  assert.equal(detector.isAwake(), true);
  detector.feedSpeechActivity(1000);
  const slept = detector.tick(6000);
  assert.equal(slept?.kind, 'sleep');
  assert.equal(slept?.reason, 'sleep-timeout');
  assert.equal(detector.isAwake(), false);
  assert.equal(detector.stats().timedSleeps, 1);
});

test('wake word v4: manual sleep + per-word action + sensitivity', () => {
  const detector = new WakeWordDetectorV16([
    { word: 'hey bot', language: 'en', sensitivity: 'balanced', minEnergy: 0.01, cooldownMs: 3000, confirmMs: 5000, enabled: true, action: 'chat' },
  ]);
  const event = detector.feedTranscript('hey bot, ghi chú mua sữa', 0);
  assert.equal(event?.kind, 'wake-command');
  assert.equal(event?.action, 'chat');
  detector.sleep(1000);
  assert.equal(detector.isAwake(), false);
  assert.equal(detector.stats().manualSleeps, 1);
  detector.setSensitivity('hey bot', 'low');
  assert.equal(detector.listWords()[0].sensitivity, 'low');
  assert.throws(() => detector.setSensitivity('nope', 'low'), /unknown wake word/);
});

test('wake word v4: wake storm mutes the detector', () => {
  const events = [];
  const detector = new WakeWordDetectorV16(undefined, { maxActivationsPerMinute: 2, stormMuteMs: 30000 }, (e) => events.push(e));
  for (let i = 0; i < 3; i += 1) {
    detector.sleep(0);
    detector.feedTranscript('hey bot', 1000 + i * 10000);
  }
  assert.ok(events.some((e) => e.kind === 'storm-muted'));
  assert.equal(detector.stats().stormMutes, 1);
  const muted = detector.feedTranscript('hey bot', 25000);
  assert.equal(muted?.kind, 'suppressed');
  assert.equal(muted?.reason, 'wake-storm');
});

test('wake word v4: command extraction helper', () => {
  assert.equal(extractWakeCommandV16('hey bot', 'hey bot'), '');
  assert.equal(extractWakeCommandV16('Hey bot, mở cửa', 'hey bot'), 'mở cửa');
  assert.equal(extractWakeCommandV16('này bot cho tôi xem lịch', 'này bot'), 'cho tôi xem lịch');
});

test('wake word v4: labelled evaluation', () => {
  const detector = new WakeWordDetectorV16();
  const evaluation = detector.evaluate([
    { transcript: 'hey bot', containsWakeWord: true },
    { transcript: 'hey bot, mở nhạc', containsWakeWord: true },
    { transcript: 'the weather is nice', containsWakeWord: false },
    { transcript: 'open the door', containsWakeWord: false },
  ]);
  assert.equal(evaluation.total, 4);
  assert.equal(evaluation.truePositives, 2);
  assert.equal(evaluation.trueNegatives, 2);
  assert.equal(evaluation.accuracy, 1);
});

// -------------------------------------------------------------- TTS stream v2

test('tts v2: small chunks, first chunk plays at once, gapless joins', () => {
  const events = [];
  // A synth that keeps up with realtime (5 ms per chunk): the
  // scheduler's joins are what is under test, not synth speed.
  const fastSynth = (chunk) => ({ audio: new Int16Array(Math.max(480, chunk.text.length * 24)), synthMs: 5 });
  const stream = new TtsStreamV16(fastSynth, {}, (e) => events.push(e));
  const profile = defaultVoiceProfileV15('bot-1');
  const text = 'Xin chào bạn, hôm nay trời rất đẹp và nắng nhẹ, gió thổi mát rượi. Tôi sẽ kể cho bạn nghe một câu chuyện dài về chú bot nhỏ hay tò mò.';
  const chunks = stream.speak(text, profile, 0);
  assert.ok(chunks.length >= 2, `chunks: ${chunks.length}`);
  assert.ok(chunks.every((c) => c.text.length <= 60), 'chunks are small');
  stream.tick(20);
  assert.ok(events.some((e) => e.kind === 'first-audio')), 'first audio fired early';
  assert.ok(stream.stats().firstAudioMs <= 20);
  for (let i = 0; i < 200; i += 1) stream.tick(20);
  assert.equal(stream.getState(), 'done');
  const stats = stream.stats();
  assert.ok(stats.chunksSpoken >= 2);
  // Gapless by construction: joins are overlaps (negative gaps).
  assert.ok(stats.gapsMs.every((g) => g <= 0), `gaps: ${stats.gapsMs.join(',')}`);
  assert.equal(stats.underruns, 0);
});

test('tts v2: pause/resume shifts the timeline', () => {
  const stream = new TtsStreamV16();
  const profile = defaultVoiceProfileV15('bot-1');
  stream.speak('Một hai ba bốn năm sáu bảy tám chín mười. Câu thứ hai dài hơn một chút.', profile, 0);
  stream.tick(200);
  assert.equal(stream.isSpeaking(), true);
  stream.pause(200);
  assert.equal(stream.isPaused(), true);
  stream.resume(1200);
  assert.equal(stream.isSpeaking(), true);
  stream.tick(100000);
  stream.tick(100); // let the last chunk finish playing
  assert.equal(stream.getState(), 'done');
  assert.equal(stream.stats().pauses, 1);
});

test('tts v2: cancel keeps the spoken prefix + remaining text', () => {
  const stream = new TtsStreamV16();
  const profile = defaultVoiceProfileV15('bot-1');
  stream.speak('Xin chào bạn. Hôm nay trời rất đẹp. Tôi sẽ kể cho bạn nghe một câu chuyện dài.', profile, 0);
  stream.tick(200);
  const cancelled = stream.cancel(300);
  assert.ok(cancelled.spokenChars > 0);
  assert.ok(cancelled.cancelledChunks >= 1);
  assert.ok(cancelled.remainingText.length > 0);
  assert.equal(stream.spokenText().length, cancelled.spokenChars);
  assert.equal(stream.getState(), 'cancelled');
});

test('tts v2: chunk duration respects playback rate', () => {
  const audio = new Int16Array(24000);
  assert.equal(ttsChunkDurationMsV16(audio, 1), 1000);
  assert.equal(ttsChunkDurationMsV16(audio, 2), 500);
  assert.equal(ttsChunkDurationMsV16(new Int16Array(0), 1), 20);
});

test('tts v2: slow synth causes an underrun after the first chunk', () => {
  let calls = 0;
  const slowSynth = (chunk, profile) => {
    calls += 1;
    // First chunk fast, later chunks very slow.
    const synthMs = calls === 1 ? 10 : 5000;
    return { audio: new Int16Array(2400), synthMs };
  };
  const events = [];
  const stream = new TtsStreamV16(slowSynth, {}, (e) => events.push(e));
  const profile = defaultVoiceProfileV15('bot-1');
  stream.speak('Câu đầu tiên trong câu chuyện dài này. Câu thứ hai cũng dài không kém gì câu đầu. Câu thứ ba kết thúc mọi chuyện.', profile, 0);
  stream.tick(100);
  stream.tick(2000);
  assert.ok(stream.stats().underruns >= 1, `underruns: ${stream.stats().underruns}`);
  assert.ok(events.some((e) => e.kind === 'underrun'));
});

// ---------------------------------------------------------------- session v16

test('session v16: full turn transcript → reply → TTS v2', async () => {
  const session = new VoiceSessionV16('s1', { language: 'en', replyFor: (t) => `Echo: ${t}` });
  await session.connect();
  assert.equal(session.getState(), 'listening');
  session.feedTranscriptFinal('Hello there.', 1);
  session.tick(600);
  session.feedSilence(600);
  // The smart-turn end is async (replyFor); flush the microtasks.
  await Promise.resolve();
  await Promise.resolve();
  session.tick(5000);
  assert.equal(session.turnsList().length, 1);
  assert.equal(session.turnsList()[0].userText, 'Hello there.');
  assert.equal(session.turnsList()[0].replyText, 'Echo: Hello there.');
  assert.ok(session.stats().tts.chunksSpoken >= 1);
  session.disconnect();
  assert.equal(session.getState(), 'closed');
});

test('session v16: barge-in cut mid-speech keeps the spoken prefix', async () => {
  const session = new VoiceSessionV16('s1', {
    language: 'en',
    replyFor: () => 'This is a very long reply that keeps going and going and going.',
  });
  await session.connect();
  session.feedTranscriptFinal('Tell me a story.', 1);
  // "tell me" is an open-question phrase, so the turn-taking v4
  // waits longer — give it a full second of silence.
  session.tick(1000);
  session.feedSilence(1000);
  await Promise.resolve();
  await Promise.resolve();
  session.tick(300);
  assert.equal(session.getState(), 'speaking');
  const receipt = session.interrupt(session.now());
  assert.ok(receipt, 'cut happened');
  assert.equal(receipt.context.replyText, 'This is a very long reply that keeps going and going and going.');
  assert.ok(receipt.context.spokenChars >= 0);
  assert.equal(session.getState(), 'listening');
  assert.equal(session.stats().bargeIns, 1);
  assert.equal(session.turnsList()[0].bargeIn, true);
  session.disconnect();
});

test('session v16: wake from asleep, bare + with command', async () => {
  const session = new VoiceSessionV16('s1', {
    language: 'en',
    startAsleep: true,
    replyFor: (t) => `Got it: ${t}`,
  });
  assert.equal(session.getState(), 'asleep');
  session.feedTranscriptFinal('hey bot', 1);
  session.feedTranscriptFinal('what time is it', 1);
  assert.equal(session.getState(), 'listening');
  assert.equal(session.stats().wakeUps, 1);
  session.disconnect();

  const session2 = new VoiceSessionV16('s2', {
    language: 'en',
    startAsleep: true,
    replyFor: (t) => `Got it: ${t}`,
  });
  session2.feedTranscriptFinal('hey bot, what time is it', 1);
  await Promise.resolve();
  await Promise.resolve();
  // The wake-command starts a turn at once, so the session is
  // speaking the reply — not merely listening.
  assert.equal(session2.getState(), 'speaking');
  assert.equal(session2.stats().wakeUps, 1);
  assert.equal(session2.turnsList().length, 1);
  assert.equal(session2.turnsList()[0].userText, 'what time is it');
  session2.tick(5000);
  assert.equal(session2.getState(), 'listening');
  session2.disconnect();
});

test('session v16: auto-sleep after silence while awake', async () => {
  const session = new VoiceSessionV16('s1', {
    language: 'en',
    startAsleep: true,
    wakeWordOptions: { sleepAfterSilenceMs: 5000 },
  });
  session.feedTranscriptFinal('hey bot, hello', 1);
  assert.equal(session.getState(), 'listening');
  session.tick(6000);
  assert.equal(session.getState(), 'asleep');
  assert.equal(session.stats().sleeps, 1);
  session.disconnect();
});

test('session v16: manager registry', async () => {
  const manager = new VoiceSessionManagerV16();
  const a = manager.create('a', { language: 'vi' });
  const b = manager.create('b', { language: 'en' });
  assert.equal(manager.count(), 2);
  assert.equal(manager.get('a'), a);
  assert.throws(() => manager.create('a'), /already exists/);
  await a.connect();
  assert.equal(manager.delete('a'), true);
  assert.equal(manager.count(), 1);
  assert.equal(b.getState(), 'idle');
  manager.delete('b');
});

// --------------------------------------------------------------------- tools

test('tools v16: 10 tools, unique names, full lifecycle', async () => {
  const tools = createVoiceV16Tools();
  assert.equal(tools.length, 10);
  assert.deepEqual(tools.map((t) => t.definition.name), [...VOICE_V16_TOOL_NAMES]);
  assert.equal(new Set(VOICE_V16_TOOL_NAMES).size, 10);
  for (const name of VOICE_V16_TOOL_NAMES) assert.equal(isVoiceV16ToolName(name), true);
  assert.equal(isVoiceV16ToolName('voice_v15_session_create'), false);
  assert.equal(VOICE_V16_TOOLS.length, 10);
  const byName = new Map(tools.map((t) => [t.definition.name, t]));
  const run = async (name, args) => JSON.parse(await byName.get(name).execute(args));

  const created = await run('voice_v16_session_create', { sessionId: 't1', language: 'en', mockReply: 'Hi there.', connect: true });
  assert.equal(created.created, true);
  const talked = await run('voice_v16_talk', { sessionId: 't1', text: 'Hello.' });
  assert.equal(talked.turns.length, 1);
  const listed = await run('voice_v16_session_list', {});
  assert.equal(listed.sessions.length, 1);
  assert.equal(listed.sessions[0].turns, 1);
  const stats = await run('voice_v16_session_stats', { sessionId: 't1' });
  assert.equal(stats.stats.turns, 1);
  const barge = await run('voice_v16_barge_in', { sessionId: 't1' });
  assert.equal(typeof barge.cut, 'boolean');
  const s2s = await run('voice_v16_s2s', { sessionId: 't1' });
  assert.equal(s2s.pipeline.state, 'streaming');
  const wake = await run('voice_v16_wake_word', { sessionId: 't1', action: 'status' });
  assert.equal(wake.words.length, 3);
  const evaluated = await run('voice_v16_wake_word', {
    sessionId: 't1',
    action: 'evaluate',
    samples: [
      { transcript: 'hey bot', containsWakeWord: true },
      { transcript: 'nice day', containsWakeWord: false },
    ],
  });
  assert.equal(evaluated.evaluation.total, 2);
  const tts = await run('voice_v16_tts', { sessionId: 't1' });
  assert.ok(Array.isArray(tts.schedule));
  const stopped = await run('voice_v16_session_stop', { sessionId: 't1' });
  assert.equal(stopped.stopped, true);
  const deleted = await run('voice_v16_session_delete', { sessionId: 't1' });
  assert.equal(deleted.deleted, true);
  // Unknown sessions return a plain "Error: ..." string, not JSON.
  const unknown = await byName.get('voice_v16_session_stats').execute({ sessionId: 'nope' });
  assert.match(unknown, /Unknown voice v16 session/);
});

test('tools v16: create validates mode / provider / sensitivity', async () => {
  const tools = createVoiceV16Tools();
  const create = tools.find((t) => t.definition.name === 'voice_v16_session_create');
  assert.match(await create.execute({ sessionId: 'x', mode: 'weird' }), /Unknown mode/);
  assert.match(await create.execute({ sessionId: 'x', s2sProvider: 'weird' }), /Unknown S2S provider/);
  assert.match(await create.execute({ sessionId: 'x', sensitivity: 'weird' }), /Unknown Smart Turn v4 sensitivity/);
});

// ------------------------------------------------------- core re-exports + i18n

test('core root re-exports v16 classes', async () => {
  const core = await import('../packages/core/dist/index.js');
  for (const name of [
    'SpeechToSpeechPipelineV16',
    'StreamingSttV16',
    'BoundedQueueV16',
    'BargeInEngineV16',
    'SmartTurnDetectorV16',
    'WakeWordDetectorV16',
    'TtsStreamV16',
    'VoiceSessionV16',
    'VoiceSessionManagerV16',
  ]) {
    assert.equal(typeof core[name], 'function', `${name} should be exported from @open-bot/core`);
  }
});

test('i18n: 48 voice.realtime.v16.* keys in all 6 locales, non-empty, same set', () => {
  const locales = ['vi', 'en', 'es', 'fr', 'ja', 'zh'];
  const dir = path.join(__dirname, '..', 'apps', 'desktop', 'src', 'renderer', 'i18n', 'locales');
  const sets = [];
  for (const locale of locales) {
    const data = JSON.parse(fs.readFileSync(path.join(dir, `${locale}.json`), 'utf8'));
    const keys = Object.keys(data).filter((k) => k.startsWith('voice.realtime.v16.')).sort();
    assert.equal(keys.length, 48, `${locale} should have 48 v16 keys, got ${keys.length}`);
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
