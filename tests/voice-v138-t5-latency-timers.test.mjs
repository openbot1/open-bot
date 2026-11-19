/**
 * Tests for voice v25 latency + turn timers + panel + session
 * (v1.38, Team T5).
 *
 * Covers ProviderLatencyTrackerV25 (rolling p50/p95, slow /
 * failing flags, fastest-first ranking, cooldown-guarded
 * fallback recommendations), TurnTimerRegistryV25 (phase
 * spans, per-session aggregates, slow-turn / long-silence
 * alerts, live running turns, v24 tool-time attachment),
 * TurnPanelV25 (snapshot + markdown) and VoiceSessionV25
 * (the whole flow end to end, transcript truncation on
 * barge-in, latency fallback moving the session).
 *
 * All offline, deterministic, no key / network / audio.
 * All clocks virtual (atMs passed by the test).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ProviderLatencyTrackerV25,
  createProviderLatencyTrackerV25,
  defaultProviderLatencyV25Options,
  validateProviderLatencyV25Options,
} from '../packages/core/dist/voiceV25/latencyProbeV25.js';
import {
  TurnTimerRegistryV25,
  createTurnTimerRegistryV25,
  defaultTurnTimerV25Options,
  validateTurnTimerV25Options,
} from '../packages/core/dist/voiceV25/turnTimersV25.js';
import {
  TurnPanelV25,
  createTurnPanelV25,
  defaultTurnPanelV25Options,
  validateTurnPanelV25Options,
  VOICE_V25_PANEL_I18N_KEYS,
} from '../packages/core/dist/voiceV25/turnPanelV25.js';
import {
  VoiceSessionV25,
  createVoiceSessionV25,
} from '../packages/core/dist/voiceV25/voiceSessionV25.js';
import {
  DynamicProviderCatalogV24,
  createDynamicProviderCatalogV24,
  ToolCallTimerRegistryV24,
  createToolCallTimerRegistryV24,
} from '../packages/core/dist/voiceV24/index.js';

function catalogWithTwoProviders() {
  const catalog = createDynamicProviderCatalogV24();
  catalog.register({
    id: 'codex', label: 'Codex', kind: 'subscription',
    models: [{ id: 'gpt-5.2', label: 'GPT-5.2', supportsVoice: true }],
    configured: true, accountLabel: 'demo@example.com', source: 'cli',
  }, 0);
  catalog.register({
    id: 'ollama', label: 'Ollama', kind: 'local',
    models: [{ id: 'qwen3:8b', label: 'Qwen3 8B', supportsVoice: true }],
    configured: true, source: 'local',
  }, 0);
  catalog.recordProbe({ providerId: 'codex', atMs: 100, ok: true, latencyMs: 120 });
  catalog.recordProbe({ providerId: 'ollama', atMs: 100, ok: true, latencyMs: 400 });
  return catalog;
}

// ----------------------------------------------------------------- latency

test('latency: rolling stats, slow flag after consecutive slow turns', () => {
  const tracker = createProviderLatencyTrackerV25();
  for (let i = 0; i < 5; i += 1) {
    tracker.record({
      providerId: 'codex', model: 'gpt-5.2', sessionId: 's1',
      atMs: 1000 + i * 1000, ttftMs: 400, firstAudioMs: 800, totalMs: 1500, ok: true,
    });
  }
  const stats = tracker.stats('codex', 's1');
  assert.ok(stats !== null);
  assert.equal(stats.samples, 5);
  assert.equal(stats.totalMeanMs, 1500);
  assert.equal(stats.totalP50Ms, 1500);
  assert.equal(stats.totalP95Ms, 1500);
  assert.equal(stats.ttftP95Ms, 400);
  assert.equal(stats.isSlow, false);
  assert.equal(stats.isFailing, false);
  // Three consecutive slow turns (total 4000 > 3000 threshold).
  for (let i = 0; i < 3; i += 1) {
    tracker.record({
      providerId: 'codex', model: 'gpt-5.2', sessionId: 's1',
      atMs: 6000 + i * 1000, ttftMs: 1200, firstAudioMs: 2000, totalMs: 4000, ok: true,
    });
  }
  const slow = tracker.stats('codex', 's1');
  assert.ok(slow !== null);
  assert.equal(slow.consecutiveSlow, 3);
  assert.equal(slow.isSlow, true);
  assert.ok(slow.totalP95Ms > 3000);
  assert.equal(tracker.stats('nope'), null);
  assert.equal(tracker.count(), 8);
  assert.ok(tracker.summary('s1').includes('codex'));
  assert.ok(tracker.markdown('s1').includes('| codex |'));
});

test('latency: failing provider flags after consecutive failures; no-data provider has no stats', () => {
  const tracker = createProviderLatencyTrackerV25();
  for (let i = 0; i < 3; i += 1) {
    tracker.record({
      providerId: 'codex', model: 'gpt-5.2', sessionId: 's1',
      atMs: 1000 + i * 1000, ttftMs: null, firstAudioMs: null, totalMs: null,
      ok: false, error: 'timeout',
    });
  }
  const stats = tracker.stats('codex', 's1');
  assert.ok(stats !== null);
  assert.equal(stats.consecutiveFailures, 3);
  assert.equal(stats.isFailing, true);
  assert.equal(stats.failedSamples, 3);
  // One ok turn resets the failure streak.
  tracker.record({
    providerId: 'codex', model: 'gpt-5.2', sessionId: 's1',
    atMs: 5000, ttftMs: 300, firstAudioMs: 600, totalMs: 1200, ok: true,
  });
  assert.equal(tracker.stats('codex', 's1')?.consecutiveFailures, 0);
  assert.equal(tracker.stats('codex', 's1')?.isFailing, false);
  assert.throws(
    () => tracker.record({ providerId: 'codex', model: 'gpt-5.2', sessionId: 's1', atMs: 6000, ok: true }),
    /At least one of ttftMs/,
  );
  assert.throws(
    () => tracker.record({ providerId: 'codex', model: 'gpt-5.2', sessionId: 's1', atMs: 6000, totalMs: -5, ok: true }),
    /totalMs must be/,
  );
  assert.deepEqual(validateProviderLatencyV25Options({ slowThresholdMs: 50 }), ['slowThresholdMs must be 100..60000']);
  assert.equal(defaultProviderLatencyV25Options().slowThresholdMs, 3000);
});

test('latency: fallback picks the fastest healthy provider, respects cooldown, never picks slow/failing', () => {
  const tracker = createProviderLatencyTrackerV25({ fallbackCooldownMs: 10000 });
  const slow = (i) => tracker.record({
    providerId: 'codex', model: 'gpt-5.2', sessionId: 's1',
    atMs: 1000 + i * 1000, ttftMs: 1200, firstAudioMs: 2000, totalMs: 4000, ok: true,
  });
  const fast = (i) => tracker.record({
    providerId: 'ollama', model: 'qwen3:8b', sessionId: 's1',
    atMs: 1000 + i * 1000, ttftMs: 200, firstAudioMs: 400, totalMs: 900, ok: true,
  });
  for (let i = 0; i < 3; i += 1) { slow(i); fast(i); }
  // codex is slow; ollama is healthy and fastest.
  const decision = tracker.recommendFallback('s1', 'codex', ['ollama', 'codex'], 5000);
  assert.equal(decision.switched, true);
  assert.equal(decision.toProviderId, 'ollama');
  assert.equal(decision.reason, 'slow');
  assert.equal(decision.triggerP95Ms, 4000);
  // Inside the cooldown the same recommendation stays put.
  const cooled = tracker.recommendFallback('s1', 'codex', ['ollama'], 8000);
  assert.equal(cooled.switched, false);
  assert.equal(cooled.toProviderId, null);
  // After the cooldown it switches again.
  const later = tracker.recommendFallback('s1', 'codex', ['ollama'], 20000);
  assert.equal(later.switched, true);
  // A healthy current provider never switches.
  const healthy = tracker.recommendFallback('s1', 'ollama', ['codex'], 21000);
  assert.equal(healthy.switched, false);
  // No healthy candidate: stay, with the reason recorded.
  const tracker2 = createProviderLatencyTrackerV25();
  for (let i = 0; i < 3; i += 1) {
    tracker2.record({ providerId: 'slow1', model: 'm', sessionId: 's9', atMs: i * 1000, totalMs: 5000, ok: true });
    tracker2.record({ providerId: 'slow2', model: 'm', sessionId: 's9', atMs: i * 1000, totalMs: 6000, ok: true });
  }
  const stuck = tracker2.recommendFallback('s9', 'slow1', ['slow2'], 5000);
  assert.equal(stuck.switched, false);
  assert.equal(stuck.toProviderId, null);
  assert.equal(tracker2.decisionsFor('s9').length, 1);
  const ranked = tracker.rankProviders('s1');
  assert.equal(ranked[0].providerId, 'ollama');
  assert.equal(ranked[1].providerId, 'codex');
  assert.equal(ranked[0].hasData, true);
  // Prune drops old samples.
  const beforePrune = tracker.count();
  const dropped = tracker.prune(50000, 10000);
  assert.equal(dropped, beforePrune);
  assert.equal(tracker.count(), 0);
});

// ------------------------------------------------------------- turn timers

test('turn timers: phase spans, per-session aggregates, slow-turn + long-silence alerts', () => {
  const timers = createTurnTimerRegistryV25();
  const userId = timers.startTurn('s1', 'user', 0, { index: 0, text: 'hello' });
  timers.enterPhase(userId, 'silence-wait', 1500);
  timers.addAudio(userId, 1200, 1500, 1200);
  const user = timers.endTurn(userId, 2700);
  assert.equal(user.status, 'completed');
  assert.equal(user.durationMs, 2700);
  assert.equal(user.silenceMs, 1200);
  assert.equal(timers.phaseMs(user, 'listening'), 1500);
  assert.equal(timers.phaseMs(user, 'silence-wait'), 1200);

  const agentId = timers.startTurn('s1', 'assistant', 2700, { index: 1, providerId: 'codex', model: 'gpt-5.2', text: 'hi there' });
  timers.enterPhase(agentId, 'speaking', 3800);
  const agent = timers.endTurn(agentId, 9000);
  assert.equal(timers.phaseMs(agent, 'thinking'), 1100);
  assert.equal(timers.phaseMs(agent, 'speaking'), 5200);

  const stats = timers.sessionStats('s1');
  assert.equal(stats.turns, 2);
  assert.equal(stats.completed, 2);
  assert.equal(stats.totalMs, 2700 + 6300);
  assert.equal(stats.meanThinkMs, 550);
  assert.equal(stats.meanSpeakMs, 2600);
  assert.equal(stats.meanListenMs, 750);
  assert.equal(stats.meanSilenceWaitMs, 600);
  assert.equal(stats.byRole.length, 2);

  // A slow turn raises a slow-turn alert on finish.
  const slowId = timers.startTurn('s1', 'user', 10000, { index: 2 });
  timers.endTurn(slowId, 10000 + 16000);
  const alerts = timers.alertsList('s1');
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].kind, 'slow-turn');
  assert.equal(alerts[0].turnId, slowId);
  // A long silence inside a turn raises long-silence on finish.
  const quietId = timers.startTurn('s1', 'user', 30000, { index: 3 });
  timers.addAudio(quietId, 6000, 100, 6000);
  timers.endTurn(quietId, 31000);
  const alerts2 = timers.alertsList('s1');
  assert.equal(alerts2.length, 2);
  assert.equal(alerts2[1].kind, 'long-silence');
  assert.ok(timers.markdown('s1').includes('| 1 | assistant | completed |'));
  assert.ok(timers.summary('s1').includes('4 turns'));
});

test('turn timers: live running turns, checkRunning flags slow turns without waiting', () => {
  const timers = createTurnTimerRegistryV25({ slowTurnMs: 5000, timeoutTurnMs: 20000 });
  const id = timers.startTurn('s1', 'assistant', 0, { index: 0, text: 'speaking...' });
  timers.enterPhase(id, 'speaking', 500);
  const running = timers.running('s1', 3000);
  assert.equal(running.length, 1);
  assert.equal(running[0].phase, 'speaking');
  assert.equal(running[0].elapsedMs, 3000);
  assert.equal(running[0].phaseElapsedMs, 2500);
  assert.equal(running[0].overSlowThreshold, false);
  assert.deepEqual(timers.checkRunning(3000), []);
  const raised = timers.checkRunning(6000);
  assert.equal(raised.length, 1);
  assert.equal(raised[0].kind, 'slow-turn');
  assert.deepEqual(timers.checkRunning(7000), [], 'same slow turn is not alerted twice');
  const finished = timers.endTurn(id, 8000);
  assert.equal(finished.durationMs, 8000);
  assert.equal(timers.running('s1', 9000).length, 0);
  assert.equal(timers.clearAlerts('s1'), 1);
  assert.equal(timers.alertsList('s1').length, 0);
});

test('turn timers: interrupt keeps the spoken prefix; v24 tool time attaches per turn', () => {
  const timers = createTurnTimerRegistryV25();
  const toolTimers = createToolCallTimerRegistryV24();
  timers.attachToolTimers(toolTimers);
  const agentId = timers.startTurn('s1', 'assistant', 0, { index: 0, text: 'Hello, I can help you plan the trip.' });
  timers.enterPhase(agentId, 'speaking', 100);
  const callId = toolTimers.start('s1', 'search', 200, 0);
  toolTimers.end(callId, 1400);
  const cut = timers.interruptTurn(agentId, 2000, 'bi-1', 'Hello, I can', 12);
  assert.equal(cut.status, 'interrupted');
  assert.equal(cut.text, 'Hello, I can');
  assert.equal(cut.spokenChars, 12);
  assert.equal(cut.bargeInId, 'bi-1');
  assert.equal(cut.interruptedAtMs, 2000);
  assert.equal(timers.toolTimeForTurn(cut), 1200);
  const stats = timers.sessionStats('s1');
  assert.equal(stats.interrupted, 1);
  assert.equal(stats.toolTimeMs, 1200);
  assert.throws(() => timers.endTurn(agentId, 3000), /already finished/);
  assert.throws(() => timers.startTurn('s1', 'user', 0, { turnId: agentId }), /already exists/);
  assert.deepEqual(validateTurnTimerV25Options({ slowTurnMs: 0 }), ['slowTurnMs must be > 0 and <= 600000']);
  assert.equal(defaultTurnTimerV25Options().slowTurnMs, 15000);
});

test('turn timers: closeSession abandons running turns', () => {
  const timers = createTurnTimerRegistryV25();
  timers.startTurn('s1', 'user', 0, { index: 0 });
  timers.startTurn('s2', 'user', 0, { index: 0 });
  assert.equal(timers.closeSession('s1', 5000), 1);
  assert.equal(timers.list({ sessionId: 's1' })[0].status, 'abandoned');
  assert.equal(timers.list({ sessionId: 's2' })[0].status, 'active');
});

// ------------------------------------------------------------------- panel

test('panel: snapshot merges turns, floor, barge-ins, silence and latency', () => {
  const timers = createTurnTimerRegistryV25();
  const userId = timers.startTurn('s1', 'user', 0, { index: 0, text: 'hello' });
  timers.endTurn(userId, 2000);
  const agentId = timers.startTurn('s1', 'assistant', 2000, { index: 1, text: 'hi' });
  timers.enterPhase(agentId, 'speaking', 2500);
  const panel = createTurnPanelV25();
  const snapshot = panel.snapshot({ sessionId: 's1', timers, atMs: 4000 });
  assert.equal(snapshot.sessionId, 's1');
  assert.equal(snapshot.running.length, 1);
  assert.equal(snapshot.running[0].record.index, 1);
  assert.equal(snapshot.finished.length, 1);
  assert.equal(snapshot.finished[0].role, 'user');
  assert.equal(snapshot.totals.turns, 2);
  assert.equal(snapshot.floorHolder, 'none');
  assert.equal(snapshot.turnTakingState, 'idle');
  assert.equal(snapshot.bargeIns.length, 0);
  assert.equal(snapshot.latency.length, 0);
  assert.ok(panel.summary(snapshot).includes('2 turns'));
  const md = panel.markdown(snapshot);
  assert.ok(md.includes('## Running turns'));
  assert.ok(md.includes('## Finished turns'));
  assert.ok(md.includes('## Barge-ins'));
  assert.ok(md.includes('No barge-ins yet.'));
  assert.ok(md.includes('## Provider latency'));
  assert.ok(md.includes('No latency samples yet.'));
  assert.deepEqual(validateTurnPanelV25Options({ maxAlerts: 0 }), ['maxAlerts must be an integer 1..200']);
  assert.equal(defaultTurnPanelV25Options().maxAlerts, 20);
  assert.ok(VOICE_V25_PANEL_I18N_KEYS.includes('voice.v25.panel.title'));
  assert.ok(VOICE_V25_PANEL_I18N_KEYS.includes('voice.v25.panel.bargeIns'));
  assert.ok(VOICE_V25_PANEL_I18N_KEYS.includes('voice.v25.panel.stopLatency'));
});

// ----------------------------------------------------------------- session

test('session: full flow — user turn, agent turn, barge-in truncates the transcript', () => {
  const catalog = catalogWithTwoProviders();
  const session = VoiceSessionV25.open('s1', { providerId: 'codex', model: 'gpt-5.2' }, catalog, 0);
  assert.equal(session.phaseOf(), 'open');
  const u = session.userStarted(0, 'xin chào');
  assert.equal(u.ok, true);
  session.userSpeechEnded(1500);
  const yielded = session.silenceYielded(2700);
  assert.equal(yielded.ok, true);
  const reply = 'Hello, I can help you plan the trip to Da Lat this weekend.';
  const agent = session.agentStartedReply(3800, reply);
  assert.equal(agent.ok, true);
  assert.equal(session.snapshot(4000).floorHolder, 'agent');
  const burst = session.reportBurst({
    atMs: 5000, atMsIntoReply: 1200, energy: 0.8, sustainMs: 600,
    words: ['dừng'], userText: 'dừng lại',
  });
  assert.equal(burst.bargeIn !== null, true);
  assert.equal(session.snapshot(5100).turnTakingState, 'interrupted');
  const stopped = session.agentStopped(5300, 12);
  assert.ok(stopped !== null);
  assert.equal(stopped.spokenText, reply.slice(0, 12));
  assert.equal(stopped.bargeIn.stopLatencyMs, 300);
  // Transcript keeps only what was spoken: user turn + truncated reply.
  assert.equal(session.transcriptCount(), 2);
  const snap = session.snapshot(5400);
  assert.equal(snap.timers.turns, 2);
  assert.equal(snap.timers.interrupted, 1);
  assert.equal(snap.bargeIns, 1);
  assert.equal(snap.currentTurn, null);
  assert.ok(session.turnChecksum().length === 8);
  // The interrupting user turn starts fresh.
  const next = session.userStarted(5500, 'dừng lại đi');
  assert.equal(next.ok, true);
  assert.equal(next.turn?.index, 2);
  const closed = session.close(9000);
  assert.equal(closed.abandonedTurns, 1);
  assert.equal(session.phaseOf(), 'closed');
  assert.throws(() => session.userStarted(9100), /closed/);
  assert.ok(session.markdown(9000).includes('# Voice v25 session — s1'));
});

test('session: silence frames auto-yield the floor; tool calls attach to the turn', () => {
  const catalog = catalogWithTwoProviders();
  const session = VoiceSessionV25.open('s1', { providerId: 'codex', model: 'gpt-5.2' }, catalog, 0);
  session.userStarted(0, 'hello');
  // Speech frames, then the user stops: speech-end moves the
  // floor machine to silence-wait; quiet confirms silence at
  // 700ms and yields the floor at 1200ms.
  session.feedSpeech(true, 100);
  session.feedSpeech(true, 300);
  session.userSpeechEnded(1000);
  session.feedSpeech(false, 1000);
  session.feedSpeech(false, 1700);
  assert.equal(session.snapshot(1800).turnTakingState, 'user-done');
  session.feedSpeech(false, 2200);
  assert.equal(session.snapshot(2300).turnTakingState, 'agent-thinking');
  const agent = session.agentStartedReply(3000, 'Hi there, how can I help?');
  assert.equal(agent.ok, true);
  const callId = session.startToolCall('search', 3100);
  session.endToolCall(callId, 3900);
  const done = session.agentFinishedReply(5000);
  assert.equal(done.ok, true);
  const stats = session.turnTimerRegistry().sessionStats('s1');
  assert.equal(stats.toolTimeMs, 800);
  assert.equal(stats.turns, 2);
  // Thinking phase has its real duration (yield 2200 -> reply 3000).
  const agentTurn = session.turnTimerRegistry().list({ sessionId: 's1', role: 'assistant' })[0];
  assert.equal(session.turnTimerRegistry().phaseMs(agentTurn, 'thinking'), 800);
  assert.equal(session.turnTimerRegistry().phaseMs(agentTurn, 'speaking'), 2000);
});

test('session: latency fallback moves the session to the faster provider', () => {
  const catalog = catalogWithTwoProviders();
  const session = VoiceSessionV25.open('s1', { providerId: 'codex', model: 'gpt-5.2' }, catalog, 0);
  for (let i = 0; i < 3; i += 1) {
    session.recordLatency({
      providerId: 'codex', model: 'gpt-5.2', atMs: 1000 + i * 1000,
      ttftMs: 1200, firstAudioMs: 2000, totalMs: 4000, ok: true,
    });
    session.recordLatency({
      providerId: 'ollama', model: 'qwen3:8b', atMs: 1000 + i * 1000,
      ttftMs: 200, firstAudioMs: 400, totalMs: 900, ok: true,
    });
  }
  const decision = session.applyLatencyFallback(5000);
  assert.equal(decision.switched, true);
  assert.equal(decision.toProviderId, 'ollama');
  assert.equal(session.currentModelRef().providerId, 'ollama');
  assert.equal(session.currentModelRef().model, 'qwen3:8b');
  assert.equal(session.snapshot(5100).switches, 1);
  // Cooldown blocks an immediate second switch.
  const again = session.applyLatencyFallback(6000);
  assert.equal(again.switched, false);
});

test('session: timeout check closes the over-long turn; backchannel is noted', () => {
  const catalog = catalogWithTwoProviders();
  const session = VoiceSessionV25.open(
    's1', { providerId: 'codex', model: 'gpt-5.2' }, catalog, 0,
    { turnTakingOptions: { maxUserTurnMs: 5000 } },
  );
  session.userStarted(0, 'hello');
  assert.equal(session.userBackchannel(1000, 'ừm'), true);
  const timedOut = session.timeoutCheck(6000);
  assert.ok(timedOut !== null);
  assert.equal(timedOut.status, 'timeout');
  assert.equal(session.turnTimerRegistry().list({ sessionId: 's1' })[0].status, 'timeout');
  assert.equal(session.snapshot(6100).turnTakingState, 'idle');
});
