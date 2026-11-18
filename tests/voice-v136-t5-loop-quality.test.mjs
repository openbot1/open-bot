/**
 * Tests for voice v23 realtime loop v2, quality report and
 * manager export/import (v1.36, Team T5).
 *
 * All offline, deterministic, no key / network / audio.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RealtimeLoopV23,
  createRealtimeLoopV23,
} from '../packages/core/dist/voiceV23/realtimeLoopV23.js';
import {
  QualityReportV23,
  createQualityReportV23,
  scoreQualityV23,
  qualityGradeV23,
  werSubscoreV23,
  latencySubscoreV23,
  mosSubscoreV23,
  streamingSubscoreV23,
  interruptionSubscoreV23,
  calibrationSubscoreV23,
  defaultQualityV23Options,
  validateQualityV23Options,
} from '../packages/core/dist/voiceV23/qualityReportV23.js';
import { RealtimeSessionManagerV23 } from '../packages/core/dist/voiceV23/sessionManagerV23.js';
import { EvalHarnessV23 } from '../packages/core/dist/voiceV23/evalHarnessV23.js';
import {
  QualityTrendV23,
  createQualityTrendV23,
  trendSlopePerMinuteV23,
  qualityTrendV23,
  meanSubscoresV23,
  worstSubscoreV23,
  validateQualityTrendV23Options,
} from '../packages/core/dist/voiceV23/qualityTrendV23.js';

const LONG_REPLY = 'word '.repeat(120).trim(); // 599 chars, 5 TTS chunks of 120

// ---------------------------------------------------------------- realtime loop
test('voice v136-t5: realtime loop — frames feed buffer + endpointing, turn measures latency', async () => {
  const loop = createRealtimeLoopV23();
  const session = loop.openSession('s1', { scriptedReplies: { hello: 'Hi there' } }, 0);
  assert.equal(session.state(), 'listening');
  for (let i = 0; i < 10; i += 1) {
    const { buffered, endpointEvents } = loop.feedFrame({ seq: i, atMs: i * 20, samples: new Int16Array(320), energy: 0.6 });
    assert.equal(buffered, true);
    void endpointEvents;
  }
  assert.equal(loop.endpointing.currentState(), 'speech', '8+ speech frames start an utterance');
  assert.equal(loop.buffer.bufferedFrames(), 10);
  const pulled = loop.pullFrame(200);
  assert.equal(pulled.seq, 0);
  const turn = await loop.completeUtterance('s1', 'hello', 1000, 1300, 2500);
  assert.equal(turn.reply, 'Hi there');
  assert.equal(turn.firstTokenMs, 300);
  assert.equal(turn.totalMs, 1500);
  const agg = loop.latencyAggregate();
  assert.equal(agg.n, 1);
  assert.equal(agg.meanFirstTokenMs, 300);
  assert.equal(agg.p95FirstTokenMs, 300);
  const stats = loop.stats();
  assert.equal(stats.turns, 1);
  assert.equal(stats.utterances, 1);
  assert.equal(stats.meanFirstTokenMs, 300);
  assert.match(loop.summary(), /realtime loop v23: 1 turns/);
  await assert.rejects(() => loop.completeUtterance('gone', 'hi', 0, 0, 0), /No session/);
  await assert.rejects(() => loop.interrupt('gone', { atMs: 0, atMsIntoReply: 0, energy: 0, sustainMs: 0, words: [], agentSpeaking: true }, '', 0, 0), /No session/);
});

test('voice v136-t5: realtime loop — a real interruption cuts the live reply, echo does not', async () => {
  const loop = new RealtimeLoopV23();
  loop.openSession('s1', { scriptedReplies: { hello: LONG_REPLY } }, 0);
  const session = loop.manager.get('s1');
  // Speak the long reply in the background; interrupt mid-speech
  // (two macrotask yields: the first lets speak start, the second
  // lands after the first 120-char chunk was spoken).
  const speaking = session.feedFinal('hello', 100);
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  const result = await loop.interrupt(
    's1',
    { atMs: 200, atMsIntoReply: 1000, energy: 0.9, sustainMs: 800, words: ['dừng', 'ngay'], echo: false, agentSpeaking: true },
    LONG_REPLY,
    120,
    200,
  );
  assert.equal(result.decision.decision, 'interrupt');
  assert.equal(result.applied, 'interrupt');
  assert.notEqual(result.cut, null);
  assert.ok(result.cut.spokenChars > 0, 'some of the reply was spoken before the cut');
  assert.ok(result.rollback !== null && result.rollback.reSpeakFromChar <= 120);
  assert.equal(result.strategy, 'summarise', 'most of the long reply is still unspoken');
  assert.equal(result.record.decision, 'interrupt');
  assert.equal(loop.ledger.stats().interrupts, 1);
  await speaking;
  // Echo while the agent is idle: ignored, never reaches the session.
  const echoed = await loop.interrupt(
    's1',
    { atMs: 300, atMsIntoReply: 100, energy: 0.9, sustainMs: 800, words: ['dừng'], echo: true, agentSpeaking: true },
    LONG_REPLY,
    0,
    300,
  );
  assert.equal(echoed.decision.decision, 'ignore');
  assert.equal(echoed.applied, null);
  assert.equal(echoed.cut, null);
  assert.equal(loop.ledger.stats().total, 2);
});

test('voice v136-t5: realtime loop — calibrateDevice fits the threshold + profile at once', () => {
  const loop = createRealtimeLoopV23();
  const { result, profile, errors } = loop.calibrateDevice('device-headset', {
    noiseSamples: Array.from({ length: 100 }, () => 0.05),
    speechSamples: Array.from({ length: 100 }, () => 0.3),
  });
  assert.deepEqual(errors, []);
  assert.equal(result.environment, 'office');
  assert.equal(profile.calibrated, true);
  assert.equal(profile.environment, 'office');
  assert.equal(result.speechThreshold, 0.17);
  assert.equal(loop.endpointing.energyThreshold(), 0.15, 'endpointing fits floor x 3 from the noise floor');
  assert.equal(loop.stats().calibrations, 1);
  const bad = loop.calibrateDevice('nope', {
    noiseSamples: [0.01],
    speechSamples: [0.3],
  });
  assert.equal(bad.errors.length, 1);
  assert.equal(bad.profile, null);
});

// ---------------------------------------------------------------- export / import
test('voice v136-t5: manager export/import — a session moves to another manager intact', async () => {
  const from = new RealtimeSessionManagerV23();
  from.open('s1', { scriptedReplies: { hello: 'Hi there' } }, 0);
  await from.get('s1').feedFinal('hello', 100);
  const json = from.exportSession('s1', 200);
  assert.ok(json.includes('"sessionId":"s1"'));
  const to = new RealtimeSessionManagerV23();
  const imported = await to.importSession(json, 's1-copy', 300);
  assert.equal(imported.sessionId, 's1-copy');
  assert.equal(imported.turnHistory().length, 2);
  assert.equal(imported.transcriptHistory()[0].text, 'hello');
  assert.equal(to.phaseOf('s1-copy'), 'live');
  assert.ok(to.managedState('s1-copy').resumeToken.startsWith('v22-resume-s1-copy-'));
  await assert.rejects(() => to.importSession(json, 's1-copy', 400), /already exists/);
  await assert.rejects(() => to.importSession('not json', 'x', 400), /not valid JSON/);
  await assert.rejects(() => to.importSession('{"a":1}', 'x', 400), /sessionId/);
});

// ---------------------------------------------------------------- quality report
test('voice v136-t5: quality sub-scores — boundaries are exact', () => {
  assert.equal(werSubscoreV23(0), 100);
  assert.equal(werSubscoreV23(0.15), 0);
  assert.equal(werSubscoreV23(0.075), 50);
  assert.equal(latencySubscoreV23(0), 100);
  assert.equal(latencySubscoreV23(800), 0);
  assert.equal(latencySubscoreV23(400), 50);
  assert.equal(mosSubscoreV23(5), 100);
  assert.equal(mosSubscoreV23(1), 0);
  assert.equal(mosSubscoreV23(3), 50);
  assert.equal(streamingSubscoreV23({ underruns: 0, overruns: 0, jitterP95Ms: 0 }), 100);
  assert.equal(streamingSubscoreV23({ underruns: 5, overruns: 2, jitterP95Ms: 40 }), 32);
  assert.equal(interruptionSubscoreV23({ falsePositives: 0, meanStopLatencyMs: 0 }), 100);
  assert.equal(interruptionSubscoreV23({ falsePositives: 2, meanStopLatencyMs: 600 }), 50);
  assert.equal(calibrationSubscoreV23(null), 50);
  assert.equal(calibrationSubscoreV23({ confidence: 0.9 }), 90);
  assert.equal(qualityGradeV23(95), 'A');
  assert.equal(qualityGradeV23(90), 'A');
  assert.equal(qualityGradeV23(89.99), 'B');
  assert.equal(qualityGradeV23(80), 'B');
  assert.equal(qualityGradeV23(70), 'C');
  assert.equal(qualityGradeV23(60), 'D');
  assert.equal(qualityGradeV23(59.99), 'F');
  assert.deepEqual(validateQualityV23Options({ weights: { wer: 0.5, latency: 0.5, mos: 0.5, streaming: 0, interruptions: 0, calibration: 0 } }), ['weights must sum to 1 (got 1.5)']);
  assert.deepEqual(validateQualityV23Options({}), []);
  assert.equal(defaultQualityV23Options().weights.wer, 0.25);
  assert.throws(() => new QualityReportV23({ werBudget: 0 }), /Invalid QualityV23 options/);
});

test('voice v136-t5: quality score — healthy inputs grade B, broken inputs grade F + 7 recommendations', () => {
  const good = scoreQualityV23({
    eval: { transcript: { meanWer: 0.01 }, latency: { p95FirstTokenMs: 200 }, mos: { meanMos: 4.5 } },
    streaming: { underruns: 0, overruns: 0, jitterP95Ms: 0 },
    interruptions: { falsePositives: 0, meanStopLatencyMs: 0 },
    sessions: { failed: 0 },
    calibration: { confidence: 0.9 },
  });
  assert.equal(good.total, 88.58);
  assert.equal(good.grade, 'B');
  assert.deepEqual(good.recommendations, []);
  const bad = scoreQualityV23({
    eval: { transcript: { meanWer: 0.2 }, latency: { p95FirstTokenMs: 2000 }, mos: { meanMos: 2.0 } },
    streaming: { underruns: 5, overruns: 2, jitterP95Ms: 40 },
    interruptions: { falsePositives: 2, meanStopLatencyMs: 600 },
    sessions: { failed: 1 },
    calibration: null,
  });
  assert.equal(bad.total, 18.2);
  assert.equal(bad.grade, 'F');
  assert.equal(bad.recommendations.length, 7);
  assert.ok(bad.recommendations.some((r) => r.includes('WER')));
  assert.ok(bad.recommendations.some((r) => r.includes('p95 first-token')));
  assert.ok(bad.recommendations.some((r) => r.includes('failed')));
  const empty = scoreQualityV23({ eval: null, streaming: null, interruptions: null, sessions: null, calibration: null });
  assert.equal(empty.total, 50);
  assert.equal(empty.grade, 'F');
});

test('voice v136-t5: quality report class — mirrors the live stack, renders markdown', () => {
  const report = createQualityReportV23();
  const harness = new EvalHarnessV23({ latencyBudgetMs: 1200 });
  report.setEval(harness.runAll(0), 0);
  report.setStreaming({ underruns: 0, overruns: 0, jitterP95Ms: 10, pushed: 0, played: 0, droppedDuplicate: 0, droppedLate: 0, droppedOverrun: 0, bufferedFrames: 0, bufferedMs: 0, targetMs: 120, jitterMs: 5, adaptations: 0, lastAdaptationAtMs: null, lastAdaptationReason: '' }, 0);
  report.setInterruptions({ total: 0, interrupts: 0, duckHard: 0, duckSoft: 0, ignored: 0, falsePositives: 0, meanStopLatencyMs: 0, p95StopLatencyMs: 0, resumed: 0, dropped: 0, summarised: 0, rephrased: 0 }, 0);
  report.setSessions({ sessions: 0, live: 0, reconnecting: 0, failed: 0, closed: 0, totalAttempts: 0, totalResumes: 0, totalHandovers: 0 }, 0);
  const score = report.score();
  assert.ok(score.total > 50, `quality ${score.total} should clear 50 with a passing eval`);
  assert.match(report.markdown(0), /# Voice v23 quality report/);
  assert.match(report.markdown(0), /Health score:/);
  assert.match(report.summary(), /voice v23 quality:/);
});

// ---------------------------------------------------------------- quality trend
const trendScore = (total, subscores) => ({
  total,
  grade: total >= 90 ? 'A' : total >= 80 ? 'B' : 'C',
  subscores: subscores ?? { wer: 90, latency: 90, mos: 90, streaming: 90, interruptions: 90, calibration: 90 },
  recommendations: [],
});

test('voice v136-t5: quality trend — slope, trend labels, rolling mean, weakest sub-score', () => {
  assert.equal(trendSlopePerMinuteV23([]), null);
  assert.equal(trendSlopePerMinuteV23([trendScore(80, undefined)].map((s) => ({ atMs: 0, total: s.total, grade: s.grade, subscores: s.subscores }))), null);
  assert.equal(qualityTrendV23([]), 'unknown');
  assert.deepEqual(validateQualityTrendV23Options({ maxPoints: 1 }), ['maxPoints must be an integer 2..100000']);
  assert.deepEqual(validateQualityTrendV23Options({}), []);
  assert.throws(() => new QualityTrendV23({ maxPoints: 1 }), /Invalid QualityTrendV23 options/);

  const rising = createQualityTrendV23();
  rising.record(trendScore(60), 0);
  rising.record(trendScore(70), 60000);
  rising.record(trendScore(80), 120000);
  assert.equal(rising.slopePerMinute(), 10);
  assert.equal(rising.trend(), 'improving');
  assert.equal(rising.meanTotal(), 70);
  assert.equal(rising.rollingMean(2), 75);
  assert.equal(rising.bestTotal(), 80);
  assert.equal(rising.worstTotal(), 60);
  assert.equal(rising.coverageMinutes(), 2);
  assert.match(rising.summary(), /improving/);
  assert.match(rising.markdown(), /# Voice v23 quality trend/);
  assert.match(rising.markdown(), /Trend: improving/);

  const falling = new QualityTrendV23();
  falling.record(trendScore(80), 0);
  falling.record(trendScore(70), 60000);
  falling.record(trendScore(60), 120000);
  assert.equal(falling.trend(), 'degrading');
  assert.equal(falling.slopePerMinute(), -10);

  const flat = new QualityTrendV23();
  flat.record(trendScore(70), 0);
  flat.record(trendScore(70.5), 60000);
  assert.equal(flat.trend(), 'stable');

  const weak = new QualityTrendV23();
  weak.record(trendScore(70, { wer: 40, latency: 90, mos: 80, streaming: 95, interruptions: 95, calibration: 90 }), 0);
  weak.record(trendScore(70, { wer: 50, latency: 90, mos: 80, streaming: 95, interruptions: 95, calibration: 90 }), 60000);
  assert.deepEqual(weak.worstSubscore(), { name: 'wer', mean: 45 });
  assert.equal(weak.meanSubscores().wer, 45);
  assert.equal(meanSubscoresV23([]), null);
  assert.equal(worstSubscoreV23([]), null);

  const capped = new QualityTrendV23({ maxPoints: 2 });
  capped.record(trendScore(60), 0);
  capped.record(trendScore(70), 1000);
  capped.record(trendScore(80), 2000);
  assert.equal(capped.count(), 2);
  assert.equal(capped.history()[0].total, 70, 'oldest point dropped');
  capped.clear();
  assert.equal(capped.count(), 0);
  assert.equal(capped.meanTotal(), null);
  assert.equal(capped.summary(), 'voice quality trend: no scores recorded yet');
});
