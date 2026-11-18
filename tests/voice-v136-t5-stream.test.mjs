/**
 * Tests for voice v23 streaming + endpointing + interruption
 * (v1.36, Team T5).
 *
 * All offline, deterministic, no key / network / audio.
 * Frames are synthetic (zero PCM); only seq/atMs/energy matter.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AdaptiveJitterBufferV23,
  FramePacerV23,
  recommendBufferTargetV23,
  traceJitterV23,
  defaultAdaptiveBufferV23Options,
  validateAdaptiveBufferV23Options,
} from '../packages/core/dist/voiceV23/streamingV23.js';
import {
  EndpointingEngineV23,
  defaultEndpointingV23Options,
  validateEndpointingV23Options,
} from '../packages/core/dist/voiceV23/endpointingV23.js';
import {
  InterruptionPolicyV23,
  InterruptionLedgerV23,
  createInterruptionPolicyV23,
  rollbackForCutV23,
  strategyForCutV23,
  defaultInterruptionV23Options,
  validateInterruptionV23Options,
} from '../packages/core/dist/voiceV23/interruptionV23.js';
import {
  EVAL_CORPUS_V23_INTERRUPTIONS,
  EVAL_CORPUS_V23_ENDPOINTS,
} from '../packages/core/dist/voiceV23/evalCorpusV23.js';
import { EvalHarnessV23 } from '../packages/core/dist/voiceV23/evalHarnessV23.js';
import { splitReplyAtCutV22 } from '../packages/core/dist/voiceV22/bargeInV22.js';

function frame(seq, atMs, energy = 0.5) {
  return { seq, atMs, samples: new Int16Array(320), energy };
}

// ---------------------------------------------------------------- adaptive buffer
test('voice v136-t5: adaptive buffer — in-order playout, duplicates + late frames dropped', () => {
  const buf = new AdaptiveJitterBufferV23();
  assert.equal(buf.targetBufferMs(), 120);
  assert.equal(buf.readyToPlay(), false);
  assert.equal(buf.push(frame(0, 0)), true);
  assert.equal(buf.push(frame(0, 20)), false, 'duplicate seq dropped');
  assert.equal(buf.push(frame(1, 20)), true);
  assert.equal(buf.push(frame(2, 40)), true);
  assert.equal(buf.pull(60)?.seq, 0);
  assert.equal(buf.pull(80)?.seq, 1);
  assert.equal(buf.pull(100)?.seq, 2);
  assert.equal(buf.pull(120), null, 'starved buffer underruns');
  const stats = buf.stats();
  assert.equal(stats.pushed, 4);
  assert.equal(stats.played, 3);
  assert.equal(stats.droppedDuplicate, 1);
  assert.equal(stats.underruns, 1);
  // A frame older than the playout point is late.
  assert.equal(buf.push(frame(1, 140)), false);
  assert.equal(buf.stats().droppedLate, 1);
  assert.match(buf.summary(), /adaptive buffer/);
  assert.deepEqual(validateAdaptiveBufferV23Options({ baseTargetMs: 5 }), ['baseTargetMs must be 20..1000']);
  assert.deepEqual(validateAdaptiveBufferV23Options({ minTargetMs: 500, maxTargetMs: 100 }), ['minTargetMs must not exceed maxTargetMs']);
  assert.equal(defaultAdaptiveBufferV23Options().baseTargetMs, 120);
  assert.throws(() => new AdaptiveJitterBufferV23({ baseTargetMs: 5 }), /Invalid AdaptiveBufferV23 options/);
});

test('voice v136-t5: adaptive buffer — target grows with jitter, shrinks when calm', () => {
  const buf = new AdaptiveJitterBufferV23();
  // Steady 20ms arrivals: no jitter, target stays at base.
  for (let i = 0; i < 10; i += 1) buf.push(frame(i, i * 20));
  assert.equal(buf.stats().targetMs, 120);
  assert.equal(buf.stats().jitterMs, 0);
  // Wild arrivals: gaps of 120ms instead of 20ms.
  const wild = new AdaptiveJitterBufferV23();
  let at = 0;
  for (let i = 0; i < 12; i += 1) {
    wild.push(frame(i, at));
    at += i % 2 === 0 ? 20 : 120;
  }
  const stats = wild.stats();
  assert.ok(stats.jitterMs > 20, `jitter ${stats.jitterMs} should be large`);
  assert.ok(stats.targetMs > 120, `target ${stats.targetMs} should grow with jitter`);
  assert.ok(stats.adaptations >= 1, 'adaptation recorded');
  assert.match(stats.lastAdaptationReason, /jitter p95/);
  // Overrun: capacity 5 frames, push 8 -> oldest dropped.
  const small = new AdaptiveJitterBufferV23({ capacityFrames: 5 });
  for (let i = 0; i < 8; i += 1) small.push(frame(i, i * 20));
  assert.equal(small.stats().droppedOverrun, 3);
  assert.equal(small.stats().overruns, 3);
  assert.equal(small.bufferedFrames(), 5);
  small.reset();
  assert.equal(small.stats().pushed, 0);
  assert.equal(small.targetBufferMs(), 120);
});

test('voice v136-t5: buffer target recommendation + trace jitter', () => {
  const calm = recommendBufferTargetV23(10, 0);
  assert.equal(calm.targetMs, 135);
  const bad = recommendBufferTargetV23(100, 5);
  assert.ok(bad.targetMs > calm.targetMs, 'worse network needs a deeper buffer');
  assert.match(bad.reason, /jitter p95 100ms/);
  assert.equal(traceJitterV23([]), 0);
  assert.equal(traceJitterV23([0]), 0);
  assert.equal(traceJitterV23([0, 20, 40, 60]), 0);
  assert.equal(traceJitterV23([0, 120, 140]), 50);
});

test('voice v136-t5: frame pacer — steady 20ms slots, late arrivals counted', () => {
  const pacer = new FramePacerV23();
  const first = pacer.schedule(0, 1000);
  assert.equal(first.playAtMs, 1000);
  assert.equal(first.lateMs, 0);
  const second = pacer.schedule(1, 1020);
  assert.equal(second.playAtMs, 1020);
  const late = pacer.schedule(2, 1100);
  assert.equal(late.playAtMs, 1040);
  assert.equal(late.lateMs, 60);
  const stats = pacer.stats();
  assert.equal(stats.scheduled, 3);
  assert.equal(stats.late, 1);
  assert.equal(stats.meanDriftMs, 20);
  pacer.resync(5000);
  assert.equal(pacer.schedule(3, 5000).playAtMs, 5000);
  pacer.reset();
  assert.equal(pacer.stats().scheduled, 0);
});

// ---------------------------------------------------------------- endpointing
test('voice v136-t5: endpointing — corpus ground truth (all 6 cases)', () => {
  const harness = new EvalHarnessV23();
  const report = harness.runEndpointSuite(EVAL_CORPUS_V23_ENDPOINTS, (c) => {
    const engine = new EndpointingEngineV23();
    return engine.runTrace(c.frames);
  });
  assert.equal(report.n, 6);
  assert.equal(report.correct, 6);
  assert.equal(report.accuracy, 1);
  assert.deepEqual(report.wrong, []);
});

test('voice v136-t5: endpointing — short blip never starts, pause inside a sentence does not end it', () => {
  const engine = new EndpointingEngineV23();
  for (let i = 0; i < 5; i += 1) engine.feedSpeech(true, i * 20);
  assert.equal(engine.currentState(), 'idle');
  engine.feedSpeech(false, 100);
  assert.equal(engine.stats().ignoredBlips, 1);
  assert.equal(engine.currentState(), 'idle');
  // Real utterance: 10 speech frames, 5 silence (inside hangover), more speech.
  for (let i = 0; i < 10; i += 1) engine.feedSpeech(true, 200 + i * 20);
  assert.equal(engine.currentState(), 'speech');
  for (let i = 0; i < 5; i += 1) engine.feedSpeech(false, 400 + i * 20);
  assert.equal(engine.currentState(), 'hangover');
  for (let i = 0; i < 10; i += 1) engine.feedSpeech(true, 500 + i * 20);
  assert.equal(engine.currentState(), 'speech');
  // Now 15 silence frames end it.
  const events = [];
  for (let i = 0; i < 15; i += 1) events.push(...engine.feedSpeech(false, 700 + i * 20));
  assert.equal(engine.currentState(), 'ended');
  assert.equal(events[events.length - 1].kind, 'speech-end');
  assert.equal(engine.stats().utterances, 1);
  assert.equal(engine.lastEndFrame(), 46);
  engine.nextUtterance();
  assert.equal(engine.currentState(), 'idle');
  assert.deepEqual(validateEndpointingV23Options({ hangoverFrames: 0 }), ['hangoverFrames must be 1..100']);
  assert.equal(defaultEndpointingV23Options().hangoverFrames, 15);
});

test('voice v136-t5: endpointing — max-length cut + noise-floor threshold', () => {
  const engine = new EndpointingEngineV23({ maxUtteranceFrames: 20 });
  const events = [];
  for (let i = 0; i < 25; i += 1) events.push(...engine.feedSpeech(true, i * 20));
  assert.equal(engine.currentState(), 'ended');
  assert.equal(events[events.length - 1].kind, 'max-length-cut');
  assert.equal(engine.stats().cutsByMaxLength, 1);
  // Quiet room: low floor -> low threshold; noisy room: threshold rises.
  const quiet = new EndpointingEngineV23();
  assert.equal(quiet.setNoiseFloor(0.01).energyThreshold, 0.05);
  const noisy = new EndpointingEngineV23();
  assert.equal(noisy.setNoiseFloor(0.15).energyThreshold, 0.45);
  assert.equal(noisy.feedEnergy(0.3, 0).length, 0, 'room noise below the adapted threshold is not speech');
  assert.match(noisy.summary(), /endpointing/);
});

// ---------------------------------------------------------------- interruption policy
test('voice v136-t5: interruption policy — corpus ground truth (all 12 cases)', () => {
  const harness = new EvalHarnessV23();
  const policy = createInterruptionPolicyV23();
  const report = harness.runInterruptionSuite(EVAL_CORPUS_V23_INTERRUPTIONS, (c) => policy.decide({
    atMs: c.atMsIntoReply,
    atMsIntoReply: c.atMsIntoReply,
    energy: c.energy,
    sustainMs: c.sustainMs,
    words: [...c.words],
    echo: c.echo,
    agentSpeaking: c.agentSpeaking,
  }).decision);
  assert.equal(report.n, 12);
  assert.equal(report.correct, 12);
  assert.equal(report.accuracy, 1);
  assert.deepEqual(report.wrong, []);
});

test('voice v136-t5: interruption policy — grace window, backchannel, echo rules in isolation', () => {
  const policy = new InterruptionPolicyV23();
  const strong = { atMs: 5000, atMsIntoReply: 2000, energy: 0.9, sustainMs: 800, words: ['dừng', 'lại'], echo: false, agentSpeaking: true };
  assert.equal(policy.decide(strong).decision, 'interrupt');
  assert.equal(policy.decide(strong).rule, 'v22-score');
  // Same burst 50ms into the reply: grace window ignores it.
  assert.deepEqual(policy.decide({ ...strong, atMsIntoReply: 50 }).rule, 'grace-window');
  assert.equal(policy.decide({ ...strong, atMsIntoReply: 50 }).decision, 'ignore');
  // Echo is never an interruption, however strong.
  assert.equal(policy.decide({ ...strong, echo: true }).rule, 'echo');
  // Agent silent: nothing to interrupt.
  assert.equal(policy.decide({ ...strong, agentSpeaking: false }).rule, 'not-speaking');
  // Backchannel: short -> ignore, sustained -> duck-soft.
  const bc = { atMs: 1000, atMsIntoReply: 1000, energy: 0.6, sustainMs: 200, words: ['ừm'], echo: false, agentSpeaking: true };
  assert.equal(policy.decide(bc).decision, 'ignore');
  assert.equal(policy.decide(bc).rule, 'backchannel');
  assert.equal(policy.decide({ ...bc, sustainMs: 500 }).decision, 'duck-soft');
  assert.equal(policy.decide({ ...bc, sustainMs: 500 }).rule, 'backchannel-duck');
  assert.deepEqual(validateInterruptionV23Options({ graceMs: -1 }), ['graceMs must be 0..5000']);
  assert.equal(defaultInterruptionV23Options().graceMs, 300);
  assert.throws(() => new InterruptionPolicyV23({ graceMs: -1 }), /Invalid InterruptionV23 options/);
});

test('voice v136-t5: rollback — cut restarts at the word boundary, never mid-word', () => {
  const reply = 'Xin chào, hôm nay thời tiết ở Hà Nội rất đẹp';
  // Cut at 20 chars lands inside "thời": v22 cuts back to "Xin chào, hôm nay" (17 chars).
  const cut = splitReplyAtCutV22(reply, 20);
  assert.equal(cut.spoken, 'Xin chào, hôm nay');
  assert.equal(cut.remaining, 'thời tiết ở Hà Nội rất đẹp');
  // v23 rolls back the partial word "nay" so the resume restarts at its start.
  const rb = rollbackForCutV23(reply, 20);
  assert.equal(rb.reSpeakFromChar, 14);
  assert.equal(rb.rolledBackChars, 3);
  assert.equal(rb.reSpeakText, 'nay thời tiết ở Hà Nội rất đẹp');
  assert.equal(cut.spoken.length + rb.rolledBackChars, 20, 'spoken + rolled back = original cut point');
  assert.ok(!rb.reSpeakText.startsWith(' '), 're-spoken text starts at a word, not a space');
  // Nothing spoken yet: the whole reply is re-spoken.
  const none = rollbackForCutV23(reply, 0);
  assert.equal(none.reSpeakFromChar, 0);
  assert.equal(none.rolledBackChars, 0);
  assert.equal(none.reSpeakText, reply);
  // A cut inside the first word rolls back the whole first word.
  const first = rollbackForCutV23(reply, 2);
  assert.equal(first.reSpeakFromChar, 0);
  assert.equal(first.rolledBackChars, 3);
  const policy = new InterruptionPolicyV23();
  assert.deepEqual(policy.rollback(reply, 20), rb);
});

test('voice v136-t5: resume strategy — drop / rephrase / summarise / resume', () => {
  const longReply = 'word '.repeat(120).trim(); // 599 chars, space-separated
  assert.equal(strategyForCutV23(splitReplyAtCutV22('hello world', 11), []), 'drop');
  assert.equal(strategyForCutV23(splitReplyAtCutV22(longReply, 100), []), 'summarise');
  assert.equal(strategyForCutV23(splitReplyAtCutV22(longReply, 100), ['lại']), 'rephrase');
  assert.equal(strategyForCutV23(splitReplyAtCutV22(longReply, 100), ['again']), 'rephrase');
  assert.equal(strategyForCutV23(splitReplyAtCutV22('short reply here', 5), ['ok']), 'resume');
});

test('voice v136-t5: interruption ledger — counts, stop latency, false positives', () => {
  const policy = new InterruptionPolicyV23();
  const ledger = new InterruptionLedgerV23();
  const d1 = policy.decide({ atMs: 100, atMsIntoReply: 1000, energy: 0.9, sustainMs: 800, words: ['dừng'], echo: false, agentSpeaking: true });
  const r1 = ledger.record(d1, 100, 180, 'resume');
  ledger.record(policy.decide({ atMs: 200, atMsIntoReply: 1000, energy: 0.5, sustainMs: 400, words: ['nói', 'chậm', 'lại'], echo: false, agentSpeaking: true }), 200, 0, null);
  ledger.record(policy.decide({ atMs: 300, atMsIntoReply: 1000, energy: 0.3, sustainMs: 200, words: ['ok'], echo: false, agentSpeaking: true }), 300, 0, null);
  const stats = ledger.stats();
  assert.equal(stats.total, 3);
  assert.equal(stats.interrupts, 1);
  assert.equal(stats.duckHard, 1);
  assert.equal(stats.ignored, 1);
  assert.equal(stats.meanStopLatencyMs, 180);
  assert.equal(stats.resumed, 1);
  assert.equal(ledger.markFalsePositive(r1.id), true);
  assert.equal(ledger.markFalsePositive('v23-int-999'), false);
  assert.equal(ledger.stats().falsePositives, 1);
  assert.match(ledger.summary(), /3 decided/);
  ledger.reset();
  assert.equal(ledger.stats().total, 0);
});
