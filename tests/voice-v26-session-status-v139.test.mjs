/**
 * Tests for voice v26 session + live status panel (v1.39, Team T5).
 *
 * Covers VoiceSessionV26 (open -> user frames -> barge-in stop
 * with resume context -> agent reply queued/delivered -> latency
 * + degraded mode -> snapshot/close) and StatusPanelV26 (level
 * meter smoothing + peak hold, rows, markdown, ui:// resource
 * descriptor, buildStatusSnapshotV26).
 *
 * All offline, deterministic, virtual clocks, synthetic levels.
 * No key / network / mic / sound card.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  StatusPanelV26,
  VoiceSessionV26,
  buildStatusSnapshotV26,
} from '../packages/core/dist/voiceV26/index.js';

test('session: full turn flow — user speaks, agent replies, barge-in cuts it, resume context kept', () => {
  const s = new VoiceSessionV26('sess-1', { profile: 'balanced' });
  s.open(0);
  assert.equal(s.isOpen(), true);
  assert.equal(s.stateNow(), 'idle');
  s.userStart(100, 'hello');
  s.userEnd(900, 'hello, are you there?');
  const reply = s.agentReply({ atMs: 1000, text: 'Yes, I am here and ready to help you with anything you need today.' });
  assert.equal(reply.outcome, 'started');
  assert.ok(reply.turnId);
  assert.equal(s.stateNow(), 'speaking');
  s.agentSpeechProgress(1500, 10);
  // User cuts in: sustained loud frames. The session stops the TTS
  // on the first confirming frame, so later frames open a fresh
  // (not yet confirmed) burst — track whether any frame confirmed.
  let sawConfirmed = false;
  let sawStopped = false;
  for (let at = 2000; at <= 2600; at += 50) {
    const r = s.userFrame({ atMs: at, energy: 0.7, userText: 'wait, actually' });
    if (r.confirmed) sawConfirmed = true;
    if (r.stopped) sawStopped = true;
  }
  assert.equal(sawConfirmed, true);
  assert.equal(sawStopped, true);
  assert.equal(s.stateNow(), 'interrupted');
  const resume = s.lastResume();
  assert.ok(resume);
  assert.equal(resume.strategy, 'ask-clarify');
  assert.ok(resume.spokenText.length > 0);
  assert.ok(resume.remainingText.length > 0);
  assert.ok(resume.spokenChars + resume.remainingChars <= resume.replyText.length);
  const snapshot = s.snapshot();
  assert.equal(snapshot.bargeIns.length, 1);
  assert.equal(snapshot.turns.length, 2);
  assert.equal(snapshot.turns[1].status, 'interrupted');
  // New user turn starts fresh after the interruption.
  s.userStart(3000, 'never mind that');
  assert.equal(s.stateNow(), 'listening');
  const closed = s.close(4000);
  assert.equal(closed.closedAtMs, 4000);
  assert.equal(s.isOpen(), false);
  assert.match(s.summary(), /1 barge-ins/);
});

test('session: agent reply queued while user speaks, delivered on yield; degraded reply cap applied', () => {
  const s = new VoiceSessionV26('sess-2', {
    profile: 'realtime',
    latency: { consecutiveBreachesToEscalate: 1, consecutiveCleanToRecover: 10 },
  });
  s.open(0);
  s.userStart(0, 'hi');
  const queued = s.agentReply({ atMs: 100, text: 'Hello there, how can I help you today?' });
  assert.equal(queued.outcome, 'queued');
  s.userEnd(500, 'hi');
  // userEnd auto-delivers the queued reply (the session drives the
  // machine), so the floor is already speaking here.
  assert.equal(s.stateNow(), 'speaking');
  const current = s.turnTaking().currentTurnNow();
  assert.ok(current);
  assert.equal(current.role, 'assistant');
  s.agentDone(2000, 40);
  // One breaching turn -> degraded light -> long replies get capped.
  s.recordTurnLatency({ turnId: 't9', sttMs: 900, modelMs: 900, ttsMs: 900, atMs: 3000 });
  assert.equal(s.degradedLevel(), 'light');
  s.userStart(4000, 'go on');
  s.userEnd(4500, 'go on');
  const longText = 'x'.repeat(1000);
  const capped = s.agentReply({ atMs: 4600, text: longText });
  assert.equal(capped.outcome, 'started');
  const turn = s.turnTaking().getTurn(capped.turnId);
  assert.ok(turn.text.length <= 601);
  assert.ok(turn.text.endsWith('…'));
});

test('session: latency recording + provider selection + mock audio', () => {
  const s = new VoiceSessionV26('sess-3');
  s.open(0);
  const stt = s.selectProvider({ kind: 'stt', language: 'en', atMs: 10 });
  assert.ok(stt);
  assert.equal(stt.kind, 'stt');
  const tts = s.selectProvider({ kind: 'tts', language: 'vi', atMs: 20 });
  assert.ok(tts);
  const fallbacks = s.fallbackProviders('tts', 30);
  assert.ok(Array.isArray(fallbacks));
  assert.ok(fallbacks.length >= 1);
  const synth = s.mockSynthesize({ text: 'Xin chào, tôi có thể giúp gì?', atMs: 40 });
  assert.equal(synth.kind, 'tts');
  assert.ok(synth.durationMs > 0);
  const transcript = s.mockTranscribe({ audioPayload: 'payload-abc', atMs: 50 });
  assert.equal(transcript.kind, 'stt');
  assert.ok(transcript.text.length > 0);
  const recorded = s.recordLatency({ stage: 'stt', ms: 9999, atMs: 60 });
  assert.equal(recorded.breach, true);
  assert.equal(recorded.overMs, 9999 - 800);
  const status = s.statusSnapshot(70);
  assert.equal(status.sessionId, 'sess-3');
  assert.equal(status.budgetMs, 4000);
  assert.equal(status.providerId, tts.providerId);
  assert.throws(() => s.open(80), /already open/);
  s.close(90);
  assert.throws(() => s.userStart(100), /closed/);
});

test('session: timeout check releases a stuck thinking phase', () => {
  const s = new VoiceSessionV26('sess-4', { turnTaking: { maxThinkingMs: 1000 } });
  s.open(0);
  s.userStart(0, 'hi');
  s.userEnd(100, 'hi');
  const timedOut = s.timeoutCheck(100 + 1001);
  assert.ok(timedOut);
  assert.equal(timedOut.status, 'timeout');
  assert.equal(s.stateNow(), 'idle');
});

test('status panel: level meter smooths + holds peak; rows + markdown + ui:// resource', () => {
  const p = new StatusPanelV26('sess-5');
  assert.equal(p.snapshotNow(), null);
  assert.equal(p.uiResource(), null);
  const s1 = p.feedLevel({ atMs: 0, level: 0.8, speaking: true });
  assert.equal(s1.level, 0.8);
  assert.equal(s1.peak, 0.8);
  assert.ok(s1.smoothed > 0 && s1.smoothed < 0.8);
  const s2 = p.feedLevel({ atMs: 1000, level: 0.1, speaking: false });
  assert.ok(s2.peak < 0.8);
  assert.ok(s2.peak >= 0.1);
  assert.equal(p.levelsList().length, 2);
  const snap = buildStatusSnapshotV26({
    sessionId: 'sess-5',
    floor: 'speaking',
    level: p.currentLevel(),
    latencyMs: 1500,
    budgetMs: 4000,
    providerId: 'mock-local-tts',
    providerName: 'Mock Local TTS',
    turnIndex: 2,
    bargeIns: 1,
    turns: 3,
    atMs: 1000,
  });
  assert.equal(snap.state, 'speaking');
  assert.equal(snap.floorHolder, 'agent');
  assert.equal(snap.overBudget, false);
  p.update(snap);
  const rows = p.rows();
  assert.ok(rows.some((r) => r.labelKey === 'voice.v26.panel.latency'));
  assert.ok(rows.some((r) => r.labelKey === 'voice.v26.panel.overBudget' || r.labelKey === 'voice.v26.panel.withinBudget'));
  const resource = p.uiResource();
  assert.ok(resource);
  assert.equal(resource.uri, 'ui://voice-v26/status?session=sess-5');
  assert.equal(resource.mimeType, 'application/vnd.open-bot.voice-status+json');
  assert.equal(resource.kind, 'voice-status');
  assert.equal(resource.version, 26);
  assert.equal(resource.snapshot.sessionId, 'sess-5');
  assert.ok(resource.i18nKeys.includes('voice.v26.panel.title'));
  assert.equal(p.uiUri(), 'ui://voice-v26/status?session=sess-5');
  assert.match(p.markdown(), /ui:\/\/voice-v26\/status\?session=sess-5/);
  assert.match(p.summary(), /speaking/);
  p.resetMeter();
  assert.equal(p.levelsList().length, 0);
  assert.equal(p.currentLevel(), null);
});

test('status panel: over-budget snapshot flags bad tone; interrupted state wins over degraded', () => {
  const over = buildStatusSnapshotV26({
    sessionId: 'sess-6', floor: 'thinking', latencyMs: 9999, budgetMs: 4000, atMs: 0,
  });
  assert.equal(over.overBudget, true);
  assert.equal(over.state, 'thinking');
  const interrupted = buildStatusSnapshotV26({
    sessionId: 'sess-6', floor: 'interrupted', degradedLevel: 'heavy', atMs: 0, budgetMs: 4000,
  });
  assert.equal(interrupted.state, 'interrupted');
  const degraded = buildStatusSnapshotV26({
    sessionId: 'sess-6', floor: 'speaking', degradedLevel: 'light', atMs: 0, budgetMs: 4000,
  });
  assert.equal(degraded.state, 'degraded');
  const p = new StatusPanelV26('sess-6');
  p.update(over);
  assert.ok(p.rows().some((r) => r.tone === 'bad'));
});
