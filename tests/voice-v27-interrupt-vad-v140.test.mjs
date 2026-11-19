/**
 * Tests for voice v27 interrupt policy + VAD tuning + turn manager
 * (v1.40, Team T5).
 *
 * Covers InterruptPolicyV27 (modes, grace, cooldown, storm,
 * stop + resume, event log), VadTunerV27 (presets, frame
 * classification, short-noise rejection, calibration, end
 * keyword) and TurnManagerV27 (VAD-driven turns, timeouts,
 * history + stats).
 *
 * All offline, deterministic, virtual clock, no key / network / audio.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  InterruptPolicyV27,
  TurnManagerV27,
  VadTunerV27,
  createInterruptPolicyV27,
  createTurnManagerV27,
  createVadTunerV27,
} from '../packages/core/dist/voiceV27/index.js';

const REPLY = 'Hello world this is a long reply for the test session';

function armedPolicy(sessionId = 's-int') {
  const policy = createInterruptPolicyV27(sessionId);
  policy.armReply({ turnId: 't1', replyText: REPLY, atMs: 0 });
  return policy;
}

test('v27 interrupt: sustained speech after the grace window confirms', () => {
  const policy = armedPolicy();
  const feed = policy.feedBurst({ atMs: 1000, speechMs: 500, energy: 0.8 });
  assert.equal(feed.decision, 'confirmed');
  assert.equal(feed.confirmed, true);
  assert.ok(feed.eventId);
  const current = policy.currentConfirmed();
  assert.ok(current);
  assert.equal(current.kind, 'speech');
  assert.equal(current.speechMs, 500);
  const stopped = policy.stop({ eventId: feed.eventId, atMs: 1120, spokenChars: 20, stopLatencyMs: 120 });
  assert.ok(stopped);
  assert.equal(stopped.spokenText, 'Hello world this is');
  assert.equal(stopped.remainingText, 'a long reply for the test session');
  assert.equal(stopped.resume, 'summarise-remainder');
  assert.equal(stopped.stopLatencyMs, 120);
  assert.equal(stopped.slow, false);
  assert.equal(policy.isAgentSpeaking(), false);
  const stats = policy.stats();
  assert.equal(stats.confirmed, 1);
  assert.equal(stats.meanStopLatencyMs, 120);
});

test('v27 interrupt: resume decision follows how much was spoken', () => {
  const early = armedPolicy('s-early');
  const f1 = early.feedBurst({ atMs: 1000, speechMs: 400, energy: 0.7 });
  const s1 = early.stop({ eventId: f1.eventId, atMs: 1100, spokenChars: 5, stopLatencyMs: 50 });
  assert.equal(s1.resume, 'resume-remaining');

  const late = armedPolicy('s-late');
  const f2 = late.feedBurst({ atMs: 1000, speechMs: 400, energy: 0.7 });
  const s2 = late.stop({ eventId: f2.eventId, atMs: 1100, spokenChars: 45, stopLatencyMs: 50 });
  assert.equal(s2.resume, 'drop-remainder');

  // A second stop on the same event is a no-op.
  assert.equal(late.stop({ eventId: f2.eventId, atMs: 1200, spokenChars: 45 }), null);
});

test('v27 interrupt: grace window, cooldown, short bursts, backchannels', () => {
  const policy = armedPolicy();
  // Inside the 400ms grace window: ignored.
  assert.equal(policy.feedBurst({ atMs: 200, speechMs: 500, energy: 0.8 }).ignoreReason, 'grace-period');
  // A 100ms burst is a backchannel, not an interruption.
  const short = policy.feedBurst({ atMs: 1000, speechMs: 100, energy: 0.5 });
  assert.equal(short.decision, 'ignored');
  assert.equal(short.ignoreReason, 'backchannel');
  // Confirm + stop, then the cooldown blocks the next burst.
  const feed = policy.feedBurst({ atMs: 1500, speechMs: 500, energy: 0.8 });
  assert.equal(feed.decision, 'confirmed');
  policy.stop({ eventId: feed.eventId, atMs: 1600, spokenChars: 8, stopLatencyMs: 80 });
  policy.armReply({ turnId: 't2', replyText: REPLY, atMs: 1700 });
  // Past the 400ms grace window (2200 - 1700 = 500) but inside the
  // 800ms post-stop cooldown (last stop 1600 -> until 2400).
  assert.equal(policy.feedBurst({ atMs: 2200, speechMs: 500, energy: 0.8 }).ignoreReason, 'cooldown');
  assert.ok(policy.cooldownRemainingMs(2000) > 0);
  assert.equal(policy.cooldownRemainingMs(3000), 0);
  const stats = policy.stats();
  assert.equal(stats.backchannels, 1);
  assert.equal(stats.ignored, 3);
});

test('v27 interrupt: keyword-only, never-critical, disabled modes', () => {
  const keywordOnly = createInterruptPolicyV27('s-kw', { mode: 'keyword-only' });
  keywordOnly.armReply({ turnId: 't1', replyText: REPLY, atMs: 0 });
  assert.equal(keywordOnly.feedBurst({ atMs: 1000, speechMs: 500, energy: 0.8, text: 'hello there' }).ignoreReason, 'not-keyword');
  const kw = keywordOnly.feedBurst({ atMs: 1000, speechMs: 500, energy: 0.8, text: 'dừng lại đi' });
  assert.equal(kw.decision, 'confirmed');
  assert.equal(kw.eventId !== null, true);
  assert.equal(keywordOnly.get(kw.eventId).kind, 'keyword');

  const critical = createInterruptPolicyV27('s-crit', { mode: 'never-critical' });
  critical.armReply({ turnId: 't1', replyText: REPLY, critical: true, atMs: 0 });
  assert.equal(critical.feedBurst({ atMs: 1000, speechMs: 500, energy: 0.8 }).ignoreReason, 'critical-turn');
  critical.armReply({ turnId: 't2', replyText: REPLY, critical: false, atMs: 0 });
  assert.equal(critical.feedBurst({ atMs: 1000, speechMs: 500, energy: 0.8 }).decision, 'confirmed');

  const disabled = createInterruptPolicyV27('s-off', { mode: 'disabled' });
  disabled.armReply({ turnId: 't1', replyText: REPLY, atMs: 0 });
  assert.equal(disabled.feedBurst({ atMs: 1000, speechMs: 500, energy: 0.8 }).ignoreReason, 'mode-disabled');

  // No reply armed at all: nothing to interrupt.
  const idle = createInterruptPolicyV27('s-idle');
  assert.equal(idle.feedBurst({ atMs: 1000, speechMs: 500, energy: 0.8 }).ignoreReason, 'not-speaking');
});

test('v27 interrupt: storm protection blocks the fifth interruption', () => {
  const policy = createInterruptPolicyV27('s-storm', { stormThreshold: 4, stormWindowMs: 10_000, stormCooldownMs: 5_000 });
  for (let i = 0; i < 4; i++) {
    policy.armReply({ turnId: `t${i}`, replyText: REPLY, atMs: i * 1000 });
    const feed = policy.feedBurst({ atMs: i * 1000 + 900, speechMs: 400, energy: 0.8 });
    assert.equal(feed.decision, 'confirmed', `burst ${i} confirms`);
    policy.stop({ eventId: feed.eventId, atMs: i * 1000 + 950, spokenChars: 5, stopLatencyMs: 40 });
  }
  policy.armReply({ turnId: 't4', replyText: REPLY, atMs: 5000 });
  const blocked = policy.feedBurst({ atMs: 5900, speechMs: 400, energy: 0.8 });
  assert.equal(blocked.decision, 'storm-blocked');
  assert.equal(blocked.stormBlocked, true);
  assert.equal(policy.stats().storms, 1);
  assert.equal(policy.stats().stormBlocked, 1);
  assert.equal(policy.stormActiveNow(5900), true);
  assert.equal(policy.stormActiveNow(11_000), false);
});

test('v27 interrupt: false positives, policy validation, markdown', () => {
  const policy = armedPolicy();
  const feed = policy.feedBurst({ atMs: 1000, speechMs: 500, energy: 0.8 });
  assert.equal(policy.markFalsePositive(feed.eventId), true);
  assert.equal(policy.markFalsePositive('nope'), false);
  assert.equal(policy.stats().falsePositives, 1);
  assert.equal(policy.list().length, 1);
  assert.equal(policy.confirmedList().length, 1);
  assert.equal(policy.ignoredList().length, 0);
  const md = policy.markdown();
  assert.match(md, /Interrupt policy v27/);
  assert.match(md, /v27-int-1/);
  assert.throws(() => policy.setPolicy({ mode: 'nope' }), /Invalid InterruptPolicyV27 options/);
  assert.throws(() => policy.setPolicy({ cooldownMs: -5 }), /Invalid InterruptPolicyV27 options/);
  assert.equal(policy.setPolicy({ mode: 'keyword-only' }).mode, 'keyword-only');
  policy.reset();
  assert.equal(policy.list().length, 0);
  assert.equal(policy.stats().events, 0);
});

test('v27 VAD: speech/silence classification and silence turn-end', () => {
  const tuner = createVadTunerV27();
  assert.equal(tuner.presetNow(), 'balanced');
  assert.equal(tuner.thresholdNow(), 0.135);
  // 6 speech frames (300ms >= min 220ms) then silence.
  for (let i = 0; i < 6; i++) {
    const r = tuner.classifyFrame({ atMs: i * 50, energy: 0.6 });
    assert.equal(r.kind, 'speech');
    assert.equal(r.turnEnded, false);
  }
  assert.equal(tuner.isSpeaking(), true);
  let ended = false;
  for (let i = 0; i < 14; i++) {
    const r = tuner.classifyFrame({ atMs: 300 + i * 50, energy: 0.02 });
    if (i < 13) assert.equal(r.turnEnded, false);
    if (i === 13) {
      assert.equal(r.turnEnded, true);
      assert.equal(r.endReason, 'silence');
      ended = true;
    }
  }
  assert.equal(ended, true);
  assert.equal(tuner.isSpeaking(), false);
  const stats = tuner.stats();
  assert.equal(stats.turnsEnded, 1);
  assert.equal(stats.turnsEndedBySilence, 1);
  assert.equal(stats.noiseRejections, 0);
});

test('v27 VAD: short bursts are rejected as noise, never a turn', () => {
  const tuner = createVadTunerV27();
  // 2 speech frames (100ms < min 220ms) then silence: cough.
  tuner.classifyFrame({ atMs: 0, energy: 0.6 });
  tuner.classifyFrame({ atMs: 50, energy: 0.6 });
  const r = tuner.classifyFrame({ atMs: 100, energy: 0.02 });
  assert.equal(r.noiseRejected, true);
  assert.equal(r.kind, 'noise');
  assert.equal(r.turnEnded, false);
  assert.equal(tuner.stats().noiseRejections, 1);
  assert.equal(tuner.isSpeaking(), false);
});

test('v27 VAD: presets, configure validation, end keyword, calibration', () => {
  const tuner = createVadTunerV27();
  const strict = tuner.applyPreset('strict');
  assert.equal(strict.silenceThreshold, 0.3);
  assert.equal(tuner.presetNow(), 'strict');
  // Energy 0.2 is speech under balanced but silence under strict.
  assert.equal(tuner.classifyFrame({ atMs: 0, energy: 0.2 }).kind, 'silence');
  tuner.applyPreset('sensitive');
  assert.equal(tuner.classifyFrame({ atMs: 50, energy: 0.2 }).kind, 'speech');
  assert.throws(() => tuner.configure({ silenceThreshold: 2 }), /Invalid VadTunerV27 config/);
  assert.throws(() => tuner.configure({ endSilenceMs: 50 }), /Invalid VadTunerV27 config/);
  assert.equal(tuner.configure({ endKeyword: 'xong' }).endKeyword, 'xong');
  assert.equal(tuner.presetNow(), 'custom');

  const kw = createVadTunerV27({ config: { endKeyword: 'xong' } });
  for (let i = 0; i < 6; i++) kw.classifyFrame({ atMs: i * 50, energy: 0.6 });
  const end = kw.classifyFrame({ atMs: 300, energy: 0.6, text: 'xong rồi nhé' });
  assert.equal(end.turnEnded, true);
  assert.equal(end.endReason, 'keyword');
  assert.equal(kw.stats().turnsEndedByKeyword, 1);

  // Calibration: quiet room (silence ~0.03) + speech (~0.7).
  const samples = [...Array(20).fill(0.03), ...Array(10).fill(0.7)];
  const cal = tuner.calibrate(samples, false);
  assert.equal(cal.samples, 30);
  assert.equal(cal.silenceP95, 0.03);
  assert.equal(cal.speechP50, 0.7);
  assert.equal(cal.suggestedThreshold, 0.365);
  assert.equal(cal.suggestedPreset, 'sensitive');
  assert.equal(cal.applied, false);
  const applied = tuner.calibrate(samples, true);
  assert.equal(applied.applied, true);
  assert.equal(tuner.configNow().silenceThreshold, 0.365);
  assert.equal(tuner.configNow().noiseFloor, 0.03);
  assert.throws(() => tuner.calibrate([0.1, 0.2]), /at least 10 samples/);
  assert.match(tuner.markdown(), /VAD tuning v27/);
});

test('v27 turn manager: VAD-driven user turn, agent turn, interrupt, timeout', () => {
  const manager = createTurnManagerV27('s-turn', { botId: 'bot-1' });
  const started = manager.userStart(0, 'xin chào');
  assert.equal(started.role, 'user');
  assert.equal(started.status, 'active');
  assert.equal(started.vadPreset, 'balanced');
  // Feed speech frames into the open turn, then silence to end it.
  for (let i = 0; i < 6; i++) manager.userFrame({ atMs: 100 + i * 50, energy: 0.6 });
  let ended = null;
  for (let i = 0; i < 14; i++) {
    const r = manager.userFrame({ atMs: 400 + i * 50, energy: 0.02 });
    if (r.turn !== null && r.turn.status === 'completed') ended = r.turn;
  }
  assert.ok(ended);
  assert.equal(ended.endReason, 'silence');
  assert.ok(ended.speechMs >= 300);

  const reply = manager.agentStart(2000, 'Chào bạn, tôi có thể giúp gì?');
  assert.equal(reply.role, 'assistant');
  assert.equal(reply.plannedChars, 'Chào bạn, tôi có thể giúp gì?'.length);
  const cut = manager.agentInterrupted(2500, 'v27-int-1', 10);
  assert.equal(cut.status, 'interrupted');
  assert.equal(cut.endReason, 'barge-in');
  assert.equal(cut.interruptId, 'v27-int-1');

  // A short burst never leaves a phantom turn behind.
  const noisy = createTurnManagerV27('s-noise');
  noisy.userFrame({ atMs: 0, energy: 0.6 });
  noisy.userFrame({ atMs: 50, energy: 0.6 });
  const rejected = noisy.userFrame({ atMs: 100, energy: 0.02 });
  assert.equal(rejected.frame.noiseRejected, true);
  assert.equal(rejected.turn.status, 'abandoned');
  assert.equal(noisy.currentTurn(), null);
  assert.equal(noisy.stats().noiseRejections, 1);

  // Timeout: a user turn held past maxListeningMs times out.
  const slow = createTurnManagerV27('s-slow', { maxListeningMs: 1000 });
  slow.userStart(0);
  const timedOut = slow.timeoutCheck(1500);
  assert.ok(timedOut);
  assert.equal(timedOut.status, 'timeout');
  assert.equal(slow.timeoutCheck(2000), null);

  const stats = manager.stats();
  assert.equal(stats.turns, 2);
  assert.equal(stats.userTurns, 1);
  assert.equal(stats.agentTurns, 1);
  assert.equal(stats.completed, 1);
  assert.equal(stats.interrupted, 1);
  assert.equal(stats.byEndReason.silence, 1);
  assert.equal(stats.byEndReason['barge-in'], 1);
  assert.equal(manager.getTurn(ended.id).id, ended.id);
  assert.equal(manager.getTurn('nope'), null);
  assert.match(manager.markdown(), /Turn-taking v27/);
  manager.reset();
  assert.equal(manager.listTurns().length, 0);
});

test('v27 turn manager: explicit end, abandon, agent done', () => {
  const manager = createTurnManagerV27('s-explicit');
  assert.equal(manager.userEnd(100), null);
  assert.equal(manager.agentDone(100), null);
  assert.equal(manager.abandon(100), null);
  manager.userStart(0, 'hi');
  const ended = manager.userEnd(500, 'hi there');
  assert.equal(ended.status, 'completed');
  assert.equal(ended.endReason, 'explicit');
  assert.equal(ended.text, 'hi there');
  manager.agentStart(600, 'hello');
  const done = manager.agentDone(900, 5);
  assert.equal(done.status, 'completed');
  assert.equal(done.spokenChars, 5);
  manager.userStart(1000);
  const abandoned = manager.abandon(1100);
  assert.equal(abandoned.status, 'abandoned');
  assert.equal(manager.stats().abandoned, 1);
});
