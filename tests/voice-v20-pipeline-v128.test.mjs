/**
 * Tests for v1.28 — voice realtime v20 (Team T5).
 *
 *   1. VAD v7 (vadV20.ts): multi-band classification, speech
 *      start/end, false-trigger guard, speaker-change hint.
 *   2. Jitter buffer v20: reorder, duplicate, too-late, gap
 *      concealment (repeat then silence).
 *   3. Transcript reconciliation: partial → final → correction,
 *      stable prefix, extension check, live view.
 *   4. Barge-in v7: pure scoring, warn then cut, echo suppressed,
 *      resume modes, reply splitting.
 *   5. Prosody TTS v5: contours, emphasis, number reading, pause
 *      markers, long-sentence chunking.
 *   6. Mock providers: route by health/quality, failover on
 *      failure, probe recovery, registry stats.
 *   7. Reconnect: error decision table, deterministic backoff,
 *      circuit breaker, manager retry/failover/abort flow.
 *   8. Metrics: percentiles, barge-in P/R/F1, mock MOS, eval
 *      report verdicts.
 *   9. Pipeline: full user turn → agent reply → listening,
 *      snapshot/restore, eval latency, health window.
 *  10. Pipeline barge-in: loud interruption cuts the agent reply,
 *      the cut turn is recorded, the interrupting turn is answered.
 *  11. Session manager: create/checkpoint/handoff/compact/sweep,
 *      capacity eviction, recovery from a checkpoint.
 *  12. i18n: all 6 locales carry the 14 `voice.v128.*` keys.
 *
 * No network, no sound card, no Gemini image call. All audio is
 * synthetic, all clocks virtual. Run after building the core
 * package:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/voice-v20-pipeline-v128.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AdaptiveVadV20,
  classifyVadFrameV20,
  defaultVadV20Options,
  vadV20BandRms,
  validateVadV20Options,
} from '../packages/core/dist/voiceV20/vadV20.js';
import {
  JitterBufferV20,
  defaultJitterBufferV20Options,
  validateJitterBufferV20Options,
} from '../packages/core/dist/voiceV20/jitterBufferV20.js';
import {
  TranscriptReconcilerV20,
  countTranscriptWordsV20,
  isTranscriptExtensionV20,
  transcriptStablePrefixWordsV20,
  validateTranscriptV20Options,
} from '../packages/core/dist/voiceV20/transcriptV20.js';
import {
  BargeInEngineV20,
  decideBargeInV20,
  defaultBargeInV20Options,
  scoreBargeInV20,
  splitReplyAtCutV20,
  validateBargeInV20Options,
} from '../packages/core/dist/voiceV20/bargeInV20.js';
import {
  ProsodyTtsV20,
  detectContourV20,
  expandAbbreviationsV20,
  extractPausesV20,
  readNumbersAsWordsV20,
  splitSentencesV20,
  stripEmphasisMarkersV20,
  validateTtsV20Options,
} from '../packages/core/dist/voiceV20/ttsProsodyV20.js';
import {
  MockProviderV20,
  ProviderRegistryV20,
  createMockProviderV20,
  validateMockProviderV20Config,
} from '../packages/core/dist/voiceV20/providersV20.js';
import {
  CircuitBreakerV20,
  ReconnectManagerV20,
  backoffDelayMsV20,
  decideErrorActionV20,
  defaultReconnectV20Options,
  errorKindFromFailureModeV20,
  makeVoiceV20Error,
} from '../packages/core/dist/voiceV20/reconnectV20.js';
import {
  VoiceEvalV20,
  mockQualityV20,
  percentilesV20,
  scoreBargeInDecisionsV20,
} from '../packages/core/dist/voiceV20/metricsV20.js';
import {
  createVoicePipelineV20,
} from '../packages/core/dist/voiceV20/pipelineV20.js';
import {
  createSessionManagerV20,
  summariseTurnsV20,
} from '../packages/core/dist/voiceV20/sessionV20.js';
import {
  silentFrameV20,
  syntheticFrameV20,
} from '../packages/core/dist/voiceV20/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Frame driver: feeds frames with a 70ms network delay — just past the 60ms jitter target, so each frame releases at once but the next one is never concealed as a gap. */
function makeDriver() { return { seq: 0 }; }
function feedSpeech(p, d, atMs, count, amplitude = 8000) {
  for (let i = 0; i < count; i += 1) {
    const t = atMs + i * 20;
    p.feedFrame(syntheticFrameV20(d.seq, t, amplitude), t + 70);
    d.seq += 1;
  }
}
function feedSilence(p, d, atMs, count) {
  for (let i = 0; i < count; i += 1) {
    const t = atMs + i * 20;
    p.feedFrame(silentFrameV20(d.seq, t), t + 70);
    d.seq += 1;
  }
}
/** Feed silence in 100ms steps until the pipeline reaches `phase` (or the budget runs out). */
function settleTo(p, d, fromMs, phase, maxSteps = 60) {
  let t = fromMs;
  for (let i = 0; i < maxSteps && p.currentPhase !== phase; i += 1) {
    feedSilence(p, d, t, 5);
    t += 100;
  }
  return t;
}

// ---------------------------------------------------------------- VAD v7
test('voice v20: VAD classifies speech/silence, starts and ends an utterance', () => {
  const events = [];
  const vad = new AdaptiveVadV20({}, (e) => events.push(e));
  assert.deepEqual(validateVadV20Options({ lowBandWeight: 2 }), ['lowBandWeight must be 0..1']);
  assert.deepEqual(validateVadV20Options({ endThreshold: 9999, startThreshold: 10 }), ['endThreshold must be < startThreshold']);

  const loud = syntheticFrameV20(0, 0, 8000);
  assert.equal(classifyVadFrameV20(loud, defaultVadV20Options()), 'speech');
  const bands = vadV20BandRms(loud);
  assert.ok(bands.total > 1000);
  assert.equal(classifyVadFrameV20(silentFrameV20(1, 20), defaultVadV20Options()), 'silence');
  assert.equal(classifyVadFrameV20({ ...loud, echo: true }, defaultVadV20Options()), 'echo');

  for (let i = 0; i < 8; i += 1) vad.feed(syntheticFrameV20(i, i * 20, 8000));
  assert.equal(vad.isSpeaking, true);
  assert.equal(events.filter((e) => e.kind === 'speech-start').length, 1);
  for (let i = 0; i < 14; i += 1) vad.feed(silentFrameV20(100 + i, 200 + i * 20));
  assert.equal(vad.isSpeaking, false);
  assert.equal(events.filter((e) => e.kind === 'speech-end').length, 1);
  const s = vad.getStats();
  assert.equal(s.speechStarts, 1);
  assert.equal(s.speechEnds, 1);
  assert.ok(s.speechMs >= 120);
});

test('voice v20: VAD rejects a too-short burst as a false trigger', () => {
  const events = [];
  const vad = new AdaptiveVadV20({}, (e) => events.push(e));
  for (let i = 0; i < 3; i += 1) vad.feed(syntheticFrameV20(i, i * 20, 8000));
  // A mid-energy frame classifies as 'noise' (between the end and start thresholds).
  vad.feed(syntheticFrameV20(3, 60, 1500));
  assert.equal(vad.isSpeaking, false);
  assert.ok(vad.getStats().falseTriggers >= 1);
  assert.ok(events.some((e) => e.kind === 'false-trigger'));
});

// ---------------------------------------------------------------- jitter buffer
test('voice v20: jitter buffer reorders, dedupes, rejects too-late, conceals gaps', () => {
  assert.deepEqual(validateJitterBufferV20Options({ targetDelayMs: -1 }), ['targetDelayMs must be >= 0']);
  const buf = new JitterBufferV20({ targetDelayMs: 0 });
  // Anchor the playhead with seq 0, then arrive out of order.
  assert.equal(buf.push(syntheticFrameV20(0, 0)), 'accepted');
  assert.equal(buf.push(syntheticFrameV20(2, 40)), 'accepted');
  assert.equal(buf.push(syntheticFrameV20(1, 20)), 'accepted');
  assert.equal(buf.push(syntheticFrameV20(1, 20)), 'duplicate');
  // Pop at 50ms: frames 0-2 are due, but seq 3 (due at 60ms) is not yet concealed.
  const out = buf.popDue(50);
  assert.deepEqual(out.map((r) => r.frame.seq), [0, 1, 2]);
  assert.ok(out.every((r) => !r.concealed));

  // Too-late needs a sequence far behind the playhead.
  const late = new JitterBufferV20({ targetDelayMs: 0 });
  for (let i = 0; i < 15; i += 1) late.push(syntheticFrameV20(i, i * 20));
  late.popDue(10000);
  assert.equal(late.push(syntheticFrameV20(0, 0)), 'too-late');
  assert.equal(late.getStats().tooLate, 1);

  // Gap: next expected is 3, only 5 is held. After releasing 5 the
  // run continues one more step and conceals the next gap (6) too.
  buf.push(syntheticFrameV20(5, 100));
  const out2 = buf.popDue(2000);
  assert.deepEqual(out2.map((r) => r.frame.seq), [3, 4, 5, 6]);
  assert.equal(out2[0].concealed, true);
  assert.equal(out2[0].concealment, 'repeat');
  assert.equal(out2[1].concealed, true);
  assert.equal(out2[2].concealed, false);
  assert.equal(out2[3].concealed, true);
  const s = buf.getStats();
  assert.equal(s.duplicates, 1);
  assert.equal(s.gaps, 3);
  assert.equal(s.concealedFrames, 3);
  assert.equal(s.released, 4);
});

test('voice v20: jitter buffer never conceals a frame before its scheduled time', () => {
  const buf = new JitterBufferV20({ targetDelayMs: 60 });
  buf.push(syntheticFrameV20(0, 0));
  // Frame 0 is due at 60ms; frame 1 (not yet arrived) is due at 80ms.
  const out = buf.popDue(70);
  assert.deepEqual(out.map((r) => r.frame.seq), [0]);
  assert.ok(out.every((r) => !r.concealed));
  assert.equal(buf.getStats().gaps, 0);
  // At 80ms frame 1 is due — still missing, so now it is concealed.
  const out2 = buf.popDue(80);
  assert.equal(out2.length, 1);
  assert.equal(out2[0].concealed, true);
  assert.equal(buf.getStats().gaps, 1);
});

test('voice v20: jitter buffer overflows by dropping the oldest held frame', () => {
  const buf = new JitterBufferV20({ targetDelayMs: 10000, maxBufferedFrames: 3 });
  assert.equal(buf.push(syntheticFrameV20(0, 0)), 'accepted');
  buf.push(syntheticFrameV20(1, 20));
  buf.push(syntheticFrameV20(2, 40));
  buf.push(syntheticFrameV20(3, 60));
  assert.equal(buf.getStats().overflowDropped, 1);
  assert.equal(buf.buffered, 3);
});

// ---------------------------------------------------------------- transcript
test('voice v20: transcript partial -> final -> correction with audit trail', () => {
  assert.deepEqual(validateTranscriptV20Options({ minPartialConfidence: 2 }), ['minPartialConfidence must be 0..1']);
  const events = [];
  const r = new TranscriptReconcilerV20({}, (e) => events.push(e));
  assert.equal(r.ingest({ id: 's1', turnId: 't1', text: 'xin chào', status: 'partial', confidence: 0.9, atMs: 0, throughSeq: 5 }), null);
  assert.equal(r.ingest({ id: 's1', turnId: 't1', text: 'xin chào bạn', status: 'partial', confidence: 0.92, atMs: 20, throughSeq: 8 }), null);
  // Stale partial (older throughSeq) is ignored.
  assert.equal(r.ingest({ id: 's1', turnId: 't1', text: 'xin', status: 'partial', confidence: 0.9, atMs: 40, throughSeq: 3 }), null);
  // Too-quiet partial is dropped.
  assert.equal(r.ingest({ id: 's2', turnId: 't1', text: 'ừ', status: 'partial', confidence: 0.01, atMs: 50, throughSeq: 9 }), null);
  const committed = r.ingest({ id: 's1', turnId: 't1', text: 'xin chào bạn nhé', status: 'final', confidence: 0.95, atMs: 60, throughSeq: 10 });
  assert.ok(committed);
  assert.equal(committed.text, 'xin chào bạn nhé');
  assert.deepEqual(committed.supersedes, ['s1']);
  assert.equal(committed.speaker, 'user');
  const corrected = r.ingest({ id: 's3', turnId: 't1', text: 'xin chào các bạn nhé', status: 'corrected', confidence: 0.97, atMs: 80, throughSeq: 10, replacesId: 's1' });
  assert.ok(corrected);
  assert.equal(corrected.status, 'corrected');
  assert.equal(corrected.supersedes.length, 2);
  assert.equal(r.fullText(), 'xin chào các bạn nhé');
  assert.equal(r.liveView().text, 'xin chào các bạn nhé');
  assert.equal(r.getStats().corrections, 1);
  assert.equal(r.getStats().droppedLowConfidencePartials, 1);
  assert.equal(countTranscriptWordsV20('xin chào các bạn nhé'), 5);
  assert.equal(transcriptStablePrefixWordsV20('xin chào bạn', 'xin chào các bạn'), 2);
  assert.equal(isTranscriptExtensionV20('xin chào', 'xin chào bạn'), true);
  assert.equal(isTranscriptExtensionV20('xin chào bạn', 'xin chào'), false);
  assert.ok(events.some((e) => e.kind === 'final'));
  assert.ok(events.some((e) => e.kind === 'corrected'));
});

// ---------------------------------------------------------------- barge-in
test('voice v20: barge-in scoring table and reply splitting', () => {
  const o = defaultBargeInV20Options();
  assert.deepEqual(validateBargeInV20Options({ warnThreshold: 0.9, cutThreshold: 0.8 }), ['warnThreshold must be < cutThreshold']);
  const strong = scoreBargeInV20(o, 1, 600, 4, false);
  assert.equal(strong.score, 1);
  assert.equal(decideBargeInV20(o, strong.score), 'cut');
  assert.equal(decideBargeInV20(o, 0.5), 'warn');
  assert.equal(decideBargeInV20(o, 0.1), 'ignore');
  const echo = scoreBargeInV20(o, 1, 600, 4, true);
  assert.ok(echo.score < strong.score);
  assert.equal(echo.echoMultiplier, 1 - o.echoDiscount);
  const split = splitReplyAtCutV20('Hello world. Goodbye now.', 6);
  assert.equal(split.spoken, 'Hello ');
  assert.equal(split.remaining, 'Goodbye now.');
});

test('voice v20: barge-in engine warns, then cuts; echo never cuts; resume modes work', () => {
  const events = [];
  const e = new BargeInEngineV20({}, (ev) => events.push(ev));
  e.agentStart('Hello world. This is a long reply for testing cuts.', 't1', 0);
  e.advanceSpoken(6);
  e.noteTranscriptWords(4);
  let decision = 'ignore';
  for (let i = 0; i < 12; i += 1) {
    decision = e.feed(syntheticFrameV20(i, i * 20, 16000));
    if (decision === 'cut') break;
  }
  assert.equal(decision, 'cut');
  assert.equal(e.getCuts().length, 1);
  assert.equal(e.isAgentSpeaking, false);
  const cut = e.lastCut;
  assert.ok(cut);
  assert.equal(cut.turnId, 't1');
  assert.equal(cut.spokenChars, 6);
  assert.ok(cut.remainingText.length > 0);
  assert.equal(cut.resumeMode, 'resume');
  assert.equal(e.chooseResume('resume', 300), cut.remainingText);
  assert.equal(e.chooseResume('restart', 300), cut.replyText);
  assert.equal(e.chooseResume('drop', 300), '');
  assert.ok(e.getStats().warnings >= 1);
  assert.ok(events.some((ev) => ev.kind === 'warning'));
  assert.ok(events.some((ev) => ev.kind === 'cut'));

  // Echo frames are suppressed, never trusted.
  const e2 = new BargeInEngineV20({}, (ev) => events.push(ev));
  e2.agentStart('Another reply that keeps going here.', 't2', 0);
  assert.equal(e2.feed({ ...syntheticFrameV20(0, 0, 16000), echo: true }), 'ignore');
  assert.equal(e2.getStats().echoSuppressed, 1);
  assert.equal(e2.isAgentSpeaking, true);
});

// ---------------------------------------------------------------- prosody TTS
test('voice v20: prosody TTS plans contours, emphasis, numbers, pauses, chunking', () => {
  assert.deepEqual(validateTtsV20Options({ maxChunkChars: 5 }), ['maxChunkChars must be >= 20']);
  assert.equal(detectContourV20('Bạn có khỏe không?'), 'question');
  assert.equal(detectContourV20('Tuyệt vời!'), 'exclamation');
  assert.equal(detectContourV20('1. Mở đầu'), 'list-item');
  assert.deepEqual(splitSentencesV20('Một câu. Hai câu? Ba câu!'), ['Một câu.', 'Hai câu?', 'Ba câu!']);
  assert.deepEqual(stripEmphasisMarkersV20('**Rất** tốt'), { text: 'Rất tốt', emphasis: 'strong' });
  assert.deepEqual(extractPausesV20('[pause:800] hello [pause] world'), { text: 'hello world', pauses: [800, 0] });
  assert.equal(readNumbersAsWordsV20('Số 3 là ba'), 'Số ba là ba');
  assert.equal(expandAbbreviationsV20('VD: TP HCM'), 'ví dụ: Thành phố Hồ Chí Minh');

  const tts = new ProsodyTtsV20();
  const chunks = tts.plan('Bạn có khỏe không? **Rất** tốt! [pause:500] Số 3 là ba.');
  const question = chunks.find((c) => c.prosody.contour === 'question');
  assert.ok(question);
  assert.equal(question.prosody.pitchSt, 2.5);
  const strong = chunks.find((c) => c.prosody.emphasis === 'strong');
  assert.ok(strong);
  assert.equal(strong.prosody.rate, 0.85);
  assert.ok(chunks.some((c) => c.kind === 'pause' && c.estDurationMs === 500));
  assert.ok(chunks.some((c) => c.text.includes('Số ba')));
  assert.ok(chunks.every((c) => c.kind === 'pause' || !c.text.includes('**')));
  const stats = tts.getStats();
  assert.equal(stats.questions, 1);
  assert.equal(stats.exclamations, 1);
  assert.equal(stats.strongEmphasis, 1);
  assert.ok(stats.totalEstMs > 0);

  const long = new ProsodyTtsV20({ maxChunkChars: 60 });
  const longChunks = long.plan(`${'một từ '.repeat(40).trim()}.`);
  assert.ok(longChunks.filter((c) => c.kind === 'speech').length >= 2);
  assert.ok(longChunks.every((c) => c.kind === 'pause' || c.text.length <= 61));
  assert.equal(long.totalMs(longChunks), longChunks.reduce((a, c) => a + c.estDurationMs + (c.kind === 'speech' ? c.prosody.pauseBeforeMs : 0), 0));
});

// ---------------------------------------------------------------- providers
test('voice v20: provider registry routes healthy, fails over, probes back', () => {
  assert.deepEqual(validateMockProviderV20Config({ quality: 2 }), ['quality must be 0..1']);
  const events = [];
  const reg = new ProviderRegistryV20({}, (e) => events.push(e));
  const a = createMockProviderV20({
    id: 'stt-a', kind: 'stt', quality: 0.9,
    script: [
      { atMs: 0, outcome: 'fail', failureMode: 'timeout' },
      { atMs: 0, outcome: 'fail', failureMode: 'timeout' },
      { atMs: 0, outcome: 'fail', failureMode: 'overloaded' },
      { atMs: 0, outcome: 'fail', failureMode: 'disconnected' },
    ],
  });
  const b = createMockProviderV20({ id: 'stt-b', kind: 'stt', quality: 0.7 });
  reg.register(a);
  reg.register(b);
  assert.equal(reg.route('stt', 0)?.id, 'stt-a');
  for (let i = 0; i < 4; i += 1) {
    const res = a.call();
    assert.equal(res.ok, false);
    reg.reportCall(res, i * 10);
  }
  assert.equal(a.health, 'down');
  assert.equal(a.getStats().failures, 4);
  assert.equal(a.getStats().lastFailureMode, 'disconnected');
  assert.equal(reg.route('stt', 100)?.id, 'stt-b');
  assert.ok(events.some((e) => e.kind === 'failover'));
  assert.ok(reg.getStats().failovers >= 1);
  // Two consecutive ok probes bring A back (script exhausted = ok).
  assert.deepEqual(reg.probeDown(200), []);
  assert.deepEqual(reg.probeDown(300), ['stt-a']);
  assert.equal(a.health, 'healthy');
  assert.equal(reg.route('stt', 400)?.id, 'stt-a');

  const tts = createMockProviderV20({ id: 'tts-a', kind: 'tts' });
  reg.register(tts);
  assert.equal(reg.route('tts', 500)?.id, 'tts-a');
  assert.equal(reg.route('s2s', 500), null);
  assert.ok(events.some((e) => e.kind === 'no-healthy-provider'));
  assert.equal(reg.get('tts-a'), tts);
  assert.equal(reg.unregister('tts-a'), true);
  assert.equal(reg.get('tts-a'), undefined);
});

test('voice v20: mock provider validates script and tracks latency', () => {
  const p = new MockProviderV20({
    id: 'x', kind: 'tts', label: 'x', quality: 0.5, baseLatencyMs: 90,
    capabilities: ['streaming'], script: [{ atMs: 0, outcome: 'ok', latencyMs: 42 }],
    degradeAfterFailures: 2, downAfterFailures: 4,
  });
  const res = p.call();
  assert.equal(res.ok, true);
  assert.equal(res.latencyMs, 42);
  assert.equal(p.getStats().meanLatencyMs, 42);
  assert.equal(p.health, 'healthy');
  assert.equal(p.hasCapability('streaming'), true);
  assert.equal(p.hasCapability('prosody'), false);
});

// ---------------------------------------------------------------- reconnect
test('voice v20: error decision table', () => {
  assert.equal(errorKindFromFailureModeV20('auth'), 'auth');
  assert.equal(errorKindFromFailureModeV20('rate-limited'), 'rate-limited');
  const max = 5;
  assert.equal(decideErrorActionV20(makeVoiceV20Error('auth', 'bad key', 0, 0), max), 'abort');
  assert.equal(decideErrorActionV20(makeVoiceV20Error('protocol', 'bad frame', 0, 0), max), 'abort');
  assert.equal(decideErrorActionV20(makeVoiceV20Error('bad-audio', 'clip', 0, 0), max), 'ignore');
  assert.equal(decideErrorActionV20(makeVoiceV20Error('timeout', 'slow', 0, 0), max), 'retry-now');
  assert.equal(decideErrorActionV20(makeVoiceV20Error('timeout', 'slow', 0, 1), max), 'retry-backed-off');
  assert.equal(decideErrorActionV20(makeVoiceV20Error('rate-limited', 'slow down', 0, 0), max), 'retry-backed-off');
  assert.equal(decideErrorActionV20(makeVoiceV20Error('overloaded', 'busy', 0, 0), max), 'retry-backed-off');
  assert.equal(decideErrorActionV20(makeVoiceV20Error('disconnected', 'dropped', 0, 0), max), 'failover');
  assert.equal(decideErrorActionV20(makeVoiceV20Error('provider-down', 'down', 0, 0), max), 'failover');
  assert.equal(decideErrorActionV20(makeVoiceV20Error('timeout', 'slow', 0, 5), max), 'abort');
});

test('voice v20: backoff is deterministic and capped', () => {
  const o = defaultReconnectV20Options();
  assert.equal(backoffDelayMsV20(o, 0), backoffDelayMsV20(o, 0));
  assert.ok(backoffDelayMsV20(o, 0) >= 200 && backoffDelayMsV20(o, 0) <= 300);
  assert.ok(backoffDelayMsV20(o, 2) > backoffDelayMsV20(o, 0));
  assert.ok(backoffDelayMsV20(o, 20) <= o.maxDelayMs);
  assert.ok(backoffDelayMsV20(o, 20) > 0);
  const noJitter = { ...o, jitterFraction: 0 };
  assert.equal(backoffDelayMsV20(noJitter, 0), 250);
  assert.equal(backoffDelayMsV20(noJitter, 1), 500);
  assert.equal(backoffDelayMsV20(noJitter, 10), 30000);
});

test('voice v20: circuit breaker opens, half-opens, closes', () => {
  const b = new CircuitBreakerV20({ breakerOpenAfter: 3, breakerOpenMs: 1000, breakerCloseAfter: 2 });
  assert.equal(b.currentState, 'closed');
  assert.equal(b.allowCall(0), true);
  b.recordFailure(0);
  b.recordFailure(0);
  assert.equal(b.currentState, 'closed');
  b.recordFailure(0);
  assert.equal(b.currentState, 'open');
  assert.equal(b.allowCall(500), false);
  assert.equal(b.getStats().rejectedWhileOpen, 1);
  assert.equal(b.allowCall(1000), true);
  assert.equal(b.currentState, 'half-open');
  b.recordSuccess();
  assert.equal(b.currentState, 'half-open');
  b.recordSuccess();
  assert.equal(b.currentState, 'closed');
  // A failure while half-open re-opens immediately.
  b.recordFailure(2000);
  b.recordFailure(2000);
  b.recordFailure(2000);
  assert.equal(b.allowCall(3000), true); // half-open probe
  b.recordFailure(3000);
  assert.equal(b.currentState, 'open');
  assert.equal(b.getStats().openedCount, 3);
});

test('voice v20: reconnect manager schedules retries, fails over, aborts', () => {
  const events = [];
  const m = new ReconnectManagerV20({}, (e) => events.push(e));
  m.connect(0);
  assert.equal(m.currentPhase, 'connecting');
  m.connected(0);
  assert.equal(m.currentPhase, 'connected');
  const r1 = m.handleError(makeVoiceV20Error('timeout', 'slow', 100, 0));
  assert.deepEqual(r1, { action: 'retry-now', retryAtMs: 100 });
  const r2 = m.handleError(makeVoiceV20Error('rate-limited', 'slow down', 200, 2));
  assert.equal(r2.action, 'retry-backed-off');
  assert.equal(r2.retryAtMs, 200 + backoffDelayMsV20(defaultReconnectV20Options(), 2));
  assert.equal(m.retryDue(200), false);
  assert.equal(m.retryDue(r2.retryAtMs), true);
  m.startRetry(r2.retryAtMs);
  assert.equal(m.currentPhase, 'retrying');
  m.connected(r2.retryAtMs);
  const r3 = m.handleError(makeVoiceV20Error('disconnected', 'dropped', 500, 0));
  assert.equal(r3.action, 'failover');
  assert.equal(m.getStats().failovers, 1);
  const r4 = m.handleError(makeVoiceV20Error('auth', 'bad key', 600, 0));
  assert.deepEqual(r4, { action: 'abort', retryAtMs: null });
  assert.equal(m.currentPhase, 'failed');
  assert.ok(events.some((e) => e.kind === 'failover-requested'));
  assert.ok(events.some((e) => e.kind === 'aborted'));
});

// ---------------------------------------------------------------- metrics
test('voice v20: percentiles, barge-in P/R/F1, mock MOS', () => {
  assert.deepEqual(percentilesV20([]), { p50: 0, p90: 0, p95: 0, p99: 0, mean: 0, min: 0, max: 0, count: 0 });
  const p = percentilesV20([10, 20, 30]);
  assert.equal(p.p50, 20);
  assert.equal(p.p90, 30);
  assert.equal(p.mean, 20);
  assert.equal(p.count, 3);

  const scores = scoreBargeInDecisionsV20([
    { atMs: 0, decision: 'cut', truth: 'interruption' },
    { atMs: 10, decision: 'cut', truth: 'non-interruption' },
    { atMs: 20, decision: 'ignore', truth: 'interruption' },
    { atMs: 30, decision: 'ignore', truth: 'non-interruption' },
  ]);
  assert.equal(scores.truePositives, 1);
  assert.equal(scores.falsePositives, 1);
  assert.equal(scores.falseNegatives, 1);
  assert.equal(scores.trueNegatives, 1);
  assert.equal(scores.precision, 0.5);
  assert.equal(scores.recall, 0.5);
  assert.equal(scores.f1, 0.5);

  const clean = mockQualityV20(1000, 0, 0, 0, 1);
  assert.equal(clean.mockMos, 4.5);
  assert.equal(clean.concealmentRate, 0);
  const lossy = mockQualityV20(100, 20, 5, 10, 1);
  assert.ok(lossy.mockMos < clean.mockMos);
  assert.ok(lossy.mockMos >= 1);
});

test('voice v20: eval collector reports latency and verdicts', () => {
  const v = new VoiceEvalV20();
  v.noteTurnLatency('t1', 1000, 1200);
  v.noteTurnLatency('t2', 2000, 2100);
  assert.equal(v.turnCount, 2);
  assert.equal(v.latencyPercentiles().p50, 100);
  assert.equal(v.latencyPercentiles().mean, 150);
  v.noteBargeIn({ atMs: 3000, decision: 'cut', truth: 'interruption' });
  const r = v.report();
  assert.equal(r.turns, 2);
  assert.equal(r.bargeIn.f1, 1);
  assert.equal(r.verdict, 'healthy');
  assert.equal(r.quality.mockMos, 4.5);

  const v2 = new VoiceEvalV20();
  v2.noteTurnLatency('t1', 0, 2000); // slow turn
  v2.noteHealthWindow({ atMs: 3000, released: 100, concealed: 20, gaps: 5, cuts: 0, errors: 0 });
  const r2 = v2.report();
  assert.equal(r2.slowTurns, 1);
  assert.equal(r2.verdict, 'poor');
});

// ---------------------------------------------------------------- pipeline
test('voice v20: pipeline runs a full user turn into an agent reply', () => {
  const seen = [];
  const p = createVoicePipelineV20('s1', {}, { replyFor: () => 'Xin chào, tôi có thể giúp gì cho bạn?' }, (e) => seen.push(e));
  assert.equal(p.currentPhase, 'idle');
  p.start(0);
  assert.equal(p.currentPhase, 'listening');
  const d = makeDriver();
  feedSpeech(p, d, 0, 8);
  assert.equal(p.currentPhase, 'user-speaking');
  feedSilence(p, d, 160, 12);
  p.ingestTranscript({ id: 'seg1', turnId: '', text: 'xin chào bạn', status: 'final', confidence: 0.9, atMs: 400, throughSeq: 7 });
  const t = settleTo(p, d, 400, 'agent-speaking');
  assert.equal(p.currentPhase, 'agent-speaking');
  const played = p.playAllChunks(t);
  assert.equal(played.length, 1);
  assert.equal(p.currentPhase, 'listening');
  const turns = p.getTurns();
  assert.equal(turns.length, 2);
  assert.equal(turns[0].role, 'user');
  assert.equal(turns[0].text, 'xin chào bạn');
  assert.equal(turns[1].role, 'agent');
  assert.equal(turns[1].text, 'Xin chào, tôi có thể giúp gì cho bạn?');
  assert.equal(p.getStats().userTurns, 1);
  assert.equal(p.getStats().agentTurns, 1);
  assert.equal(p.evaluator.turnCount, 1);
  assert.ok(p.evaluator.latencyPercentiles().p50 > 0);
  p.noteHealthWindow(t);
  assert.ok(p.evaluator.report().totalReleased > 0);
  assert.ok(seen.some((e) => e.kind === 'speech-start'));
  assert.ok(seen.some((e) => e.kind === 'tts-start'));
  assert.ok(seen.some((e) => e.kind === 'turn-end'));

  const snap = p.snapshot();
  assert.equal(snap.turns.length, 2);
  p.end(t);
  assert.equal(p.currentPhase, 'ended');
  const p2 = createVoicePipelineV20('s2', {});
  p2.start(t);
  p2.restore(snap, t);
  assert.equal(p2.getTurns().length, 2);
  assert.equal(p2.currentPhase, 'listening');
});

test('voice v20: pipeline barge-in cuts the agent reply and the interruption is answered', () => {
  const p = createVoicePipelineV20('s1', {}, { replyFor: () => 'Đây là một câu trả lời rất dài. '.repeat(8) });
  p.start(0);
  const d = makeDriver();
  feedSpeech(p, d, 0, 8);
  feedSilence(p, d, 160, 12);
  p.ingestTranscript({ id: 'seg1', turnId: '', text: 'kể chuyện đi', status: 'final', confidence: 0.9, atMs: 400, throughSeq: 7 });
  let t = settleTo(p, d, 400, 'agent-speaking');
  assert.equal(p.currentPhase, 'agent-speaking');
  // Agent is mid-reply (2 of 8 chunks spoken).
  assert.ok(p.playNextChunk(t));
  assert.ok(p.playNextChunk(t));
  // User interrupts loudly, with transcript evidence.
  p.bargeInEngine.noteTranscriptWords(4);
  feedSpeech(p, d, t, 30, 16000);
  assert.equal(p.getStats().cuts, 1);
  assert.equal(p.currentPhase, 'user-speaking');
  const cutTurn = p.getTurns().find((x) => x.role === 'agent');
  assert.ok(cutTurn);
  assert.equal(cutTurn.bargeInCut, true);
  const cut = p.bargeInEngine.lastCut;
  assert.ok(cut);
  assert.ok(cut.remainingText.length > 0);
  assert.equal(cut.resumeMode, 'resume');
  // Finish the interrupting turn; it gets its own reply.
  p.ingestTranscript({ id: 'seg2', turnId: '', text: 'dừng lại đi', status: 'final', confidence: 0.92, atMs: t + 700, throughSeq: d.seq });
  t = settleTo(p, d, t + 700, 'agent-speaking');
  assert.equal(p.currentPhase, 'agent-speaking');
  const userTurns = p.getTurns().filter((x) => x.role === 'user');
  assert.equal(userTurns.length, 2);
  assert.equal(userTurns[1].text, 'dừng lại đi');
  // Provider failure flows into the reconnect manager when attached.
  const p3 = createVoicePipelineV20('s3', {}, {}, undefined, {});
  p3.start(0);
  assert.equal(p3.reportProviderFailure('timeout', 'slow', 0, 0), 'abort');
});

test('voice v20: pipeline with registry + reconnect reports failover', () => {
  const reconnect = new ReconnectManagerV20({});
  const reg = new ProviderRegistryV20({});
  reg.register(createMockProviderV20({ id: 'stt-a', kind: 'stt' }));
  const p = createVoicePipelineV20('s1', {}, {}, undefined, { registry: reg, reconnect });
  p.start(0);
  assert.equal(p.reportProviderFailure('disconnected', 'dropped', 100, 0), 'failover');
  assert.equal(reconnect.getStats().failovers, 1);
});

// ---------------------------------------------------------------- sessions
test('voice v20: session manager checkpoint, handoff, compact, sweep, recover', () => {
  const events = [];
  const m = createSessionManagerV20(
    { maxSessions: 2, checkpointIntervalMs: 1000, idleExpireMs: 1000, maxSessionAgeMs: 60000, keepTurnsAfterCompaction: 3 },
    {},
    { replyFor: (t) => `Trả lời: ${t}` },
    (e) => events.push(e),
  );
  const s1 = m.create(0);
  assert.equal(s1.state, 'active');
  assert.equal(m.size, 1);
  const cp = m.checkpoint(s1.id, 100);
  assert.ok(cp);
  assert.equal(cp.number, 1);
  assert.equal(cp.snapshot.turns.length, 0);

  // Fabricate 5 turns, then compact down to the keep window.
  const turns = Array.from({ length: 5 }, (_, i) => ({
    id: `turn-${i + 1}`, role: i % 2 === 0 ? 'user' : 'agent',
    text: `nội dung lượt thứ ${i + 1} ở đây`, atMs: i * 1000, durationMs: 500,
  }));
  s1.pipeline.restore({
    phase: 'listening', turnCounter: 5, turns, committedTranscript: '',
    stats: { phase: 'listening', frames: 0, turns: 5, userTurns: 3, agentTurns: 2, cuts: 0, ttsChunksPlayed: 0, ttsCharsSpoken: 0, events: 0 },
  }, 200);
  assert.equal(s1.pipeline.getTurns().length, 5);
  assert.equal(m.compact(s1.id, 300), 2);
  assert.equal(s1.pipeline.getTurns().length, 3);
  assert.equal(s1.compactedTurns, 2);
  assert.ok(s1.compactedSummary.includes('[user]'));
  assert.ok(summariseTurnsV20([{ role: 'user', text: 'a b c d e f g h i j' }]).includes('…'));

  const h = m.handoff(s1.id, 400);
  assert.ok(h);
  assert.equal(h.pipeline.getTurns().length, 3);
  assert.equal(h.handoffs, 1);
  assert.equal(h.state, 'active');

  // Sweep checkpoints the active session and expires the idle one.
  m.markIdle(s1.id, 500);
  const expired = m.sweep(2000);
  assert.ok(expired.includes(s1.id));
  assert.equal(s1.state, 'expired');
  assert.ok(events.some((e) => e.kind === 'checkpoint'));
  assert.ok(events.some((e) => e.kind === 'handoff'));
  assert.ok(events.some((e) => e.kind === 'compacted'));
  assert.ok(events.some((e) => e.kind === 'expired'));

  // Recovery from a checkpoint.
  const s2 = m.create(3000);
  const cp2 = m.checkpoint(s2.id, 3100);
  assert.ok(cp2);
  const recovered = m.recover(s2.id, cp2.number, 3200);
  assert.ok(recovered);
  assert.equal(recovered.state, 'active');
  assert.equal(m.recover(s2.id, 999, 3300), null);
  assert.equal(m.end(s2.id, 3400), true);
  assert.equal(s2.state, 'ended');
  const stats = m.getStats();
  assert.equal(stats.sessions, 2);
  assert.equal(stats.checkpoints, s1.checkpoints.length + s2.checkpoints.length);
});

test('voice v20: session manager evicts the oldest live session at capacity', () => {
  const m = createSessionManagerV20({ maxSessions: 1 });
  const a = m.create(0);
  const b = m.create(20);
  assert.equal(a.state, 'expired');
  assert.equal(b.state, 'active');
  assert.equal(m.liveCount(), 1);
  assert.equal(m.activeCount(), 1);
});

// ---------------------------------------------------------------- i18n
test('voice v20: all 6 locales carry the voice.v128 keys', () => {
  const keys = [
    'voice.v128.title',
    'voice.v128.pipeline',
    'voice.v128.sessions',
    'voice.v128.providers',
    'voice.v128.reconnect',
    'voice.v128.eval',
    'voice.v128.listening',
    'voice.v128.agentSpeaking',
    'voice.v128.interrupted',
    'voice.v128.resumed',
    'voice.v128.handoff',
    'voice.v128.compacted',
    'voice.v128.failover',
    'voice.v128.noProvider',
  ];
  for (const locale of ['vi', 'en', 'es', 'fr', 'ja', 'zh']) {
    const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'apps', 'desktop', 'src', 'renderer', 'i18n', 'locales', `${locale}.json`), 'utf8'));
    for (const k of keys) {
      assert.ok(typeof data[k] === 'string' && data[k].length > 0, `${locale} missing ${k}`);
    }
  }
});
