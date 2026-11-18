/**
 * Tests for voice v22 profiles + recovery + monitor panel
 * (v1.35, Team T5).
 *
 * Covers the voice profile registry (built-ins, custom add /
 * update / remove, fallback chain, per-user defaults, switch
 * timing), the recovery engine (heartbeats, degradation,
 * disconnect, exponential backoff, give-up, mock transport),
 * and the durability monitor panel (snapshot, alerts,
 * markdown, session mirroring).
 * All offline, deterministic, no key / network / audio.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VoiceProfileRegistryV22,
  createVoiceProfileRegistryV22,
  builtinProfilesV22,
  clampProsodyV22,
  validateProfileV22,
  defaultVoiceProfilesV22Options,
  validateVoiceProfilesV22Options,
  profileCharsPerSecondV22,
  VOICE_V22_PROSODY_LIMITS,
} from '../packages/core/dist/voiceV22/voiceProfilesV22.js';
import {
  RecoveryEngineV22,
  MockTransportV22,
  createRecoveryEngineV22,
  backoffDelayV22,
  isRecoverableFailureV22,
  makeFailureV22,
  defaultRecoveryV22Options,
  validateRecoveryV22Options,
  VOICE_V22_UNRECOVERABLE_FAILURES,
} from '../packages/core/dist/voiceV22/recoveryV22.js';
import {
  MonitorPanelV22,
  createMonitorPanelV22,
  durabilityScoreV22,
  defaultMonitorPanelV22Options,
  validateMonitorPanelV22Options,
  VOICE_V22_PANEL_I18N_KEYS,
} from '../packages/core/dist/voiceV22/monitorPanelV22.js';
import {
  VoiceSessionV22,
  createVoiceSessionV22,
} from '../packages/core/dist/voiceV22/sessionV22.js';

// ---------------------------------------------------------------- profiles
test('voice v22: built-in profiles ship with the registry', () => {
  const builtins = builtinProfilesV22();
  assert.equal(builtins.length, 4);
  assert.deepEqual(builtins.map((p) => p.id), [
    'voice-v22-default', 'voice-v22-vi-calm', 'voice-v22-en-brisk', 'voice-v22-storyteller',
  ]);
  assert.ok(builtins.every((p) => p.builtin === true));
  assert.equal(builtins[1].locale, 'vi-VN');
  assert.equal(builtins[1].fallbackId, 'voice-v22-default');
  const registry = createVoiceProfileRegistryV22('s1');
  assert.equal(registry.current(), 'voice-v22-default');
  assert.equal(registry.list().length, 4);
  assert.equal(registry.listByLocale('vi-VN').length, 1);
  assert.equal(registry.listByLocale('en-US').length, 3);
  assert.equal(profileCharsPerSecondV22(registry.currentProfile()), 14);
  assert.match(registry.summary(), /4 profiles/);
});

test('voice v22: prosody clamping + profile validation', () => {
  assert.deepEqual(clampProsodyV22({ rate: 5, pitch: -99, volume: 3 }), { rate: 2, pitch: -6, volume: 1.5 });
  assert.deepEqual(clampProsodyV22({}), { rate: 1, pitch: 0, volume: 1 });
  assert.equal(VOICE_V22_PROSODY_LIMITS.rate.max, 2.0);
  const good = { id: 'my-voice', name: 'Mine', locale: 'vi-VN', engine: 'mock', prosody: { rate: 1, pitch: 0, volume: 1 } };
  assert.deepEqual(validateProfileV22(good), []);
  assert.ok(validateProfileV22({ ...good, id: '' }).length > 0);
  assert.ok(validateProfileV22({ ...good, id: 'bad id!' }).length > 0);
  assert.ok(validateProfileV22({ ...good, locale: 'vi-vn' }).length > 0);
  assert.ok(validateProfileV22({ ...good, locale: 'vietnamese' }).length > 0);
  assert.ok(validateProfileV22({ ...good, prosody: { rate: 9, pitch: 0, volume: 1 } }).length > 0);
  assert.ok(validateProfileV22({ ...good, fallbackId: 'my-voice' }).length > 0);
  assert.deepEqual(validateVoiceProfilesV22Options({}), []);
  assert.ok(validateVoiceProfilesV22Options({ maxProfiles: 0 }).length > 0);
  assert.equal(defaultVoiceProfilesV22Options().maxProfiles, 32);
});

test('voice v22: custom profile add / update / remove rules', () => {
  const registry = createVoiceProfileRegistryV22('s1', { maxProfiles: 1 });
  const custom = {
    id: 'my-voice', name: 'Mine', locale: 'vi-VN', engine: 'mock',
    prosody: { rate: 1.2, pitch: 2, volume: 0.9 }, fallbackId: 'voice-v22-default',
  };
  assert.deepEqual(registry.add(custom), []);
  assert.equal(registry.list().length, 5);
  assert.deepEqual(registry.add(custom), ['profile "my-voice" already exists']);
  // The limit fires before the fallback check (maxProfiles = 1).
  assert.ok(registry.add({ ...custom, id: 'second', fallbackId: 'missing' }).length > 0);
  assert.deepEqual(registry.add({ ...custom, id: 'second' }).length > 0, true); // maxProfiles = 1
  assert.deepEqual(registry.update('my-voice', { prosody: { rate: 9 } }), []);
  assert.equal(registry.get('my-voice')?.prosody.rate, 2); // clamped
  assert.deepEqual(registry.update('ghost', { name: 'x' }), ['profile "ghost" does not exist']);
  assert.deepEqual(registry.remove('voice-v22-default'), ['builtin profile "voice-v22-default" cannot be removed']);
  registry.switchTo('my-voice', 100, false);
  assert.deepEqual(registry.remove('my-voice'), ['profile "my-voice" is current; switch away first']);
  registry.switchTo('voice-v22-default', 200, false);
  assert.deepEqual(registry.remove('my-voice'), []);
  assert.equal(registry.get('my-voice'), null);
  const stats = registry.stats();
  assert.equal(stats.customs, 0);
  assert.equal(stats.switches, 2);
});

test('voice v22: fallback chain resolves, unknown ids fall back to default', () => {
  const registry = createVoiceProfileRegistryV22('s1');
  const story = registry.resolve('voice-v22-storyteller');
  assert.equal(story.profile.id, 'voice-v22-storyteller');
  assert.equal(story.fellBack, false);
  const unknown = registry.resolve('no-such-voice');
  assert.equal(unknown.profile.id, 'voice-v22-default');
  assert.equal(unknown.fellBack, true);
  assert.deepEqual(unknown.chain, ['no-such-voice', 'voice-v22-default']);
  assert.equal(registry.stats().fallbacksUsed, 1);
  // A non-mock engine falls back to its fallbackId.
  registry.add({
    id: 'cloud-voice', name: 'Cloud', locale: 'en-US', engine: 'cloud-x',
    prosody: { rate: 1, pitch: 0, volume: 1 }, fallbackId: 'voice-v22-en-brisk',
  });
  const cloud = registry.resolve('cloud-voice');
  assert.equal(cloud.profile.id, 'voice-v22-en-brisk');
  assert.equal(cloud.fellBack, true);
  assert.deepEqual(cloud.chain, ['cloud-voice', 'voice-v22-en-brisk']);
});

test('voice v22: fallback cycle is detected, not looped', () => {
  const registry = createVoiceProfileRegistryV22('s1');
  registry.add({
    id: 'a-voice', name: 'A', locale: 'en-US', engine: 'mock',
    prosody: { rate: 1, pitch: 0, volume: 1 }, fallbackId: 'voice-v22-default',
  });
  registry.add({
    id: 'b-voice', name: 'B', locale: 'en-US', engine: 'mock',
    prosody: { rate: 1, pitch: 0, volume: 1 }, fallbackId: 'a-voice',
  });
  assert.deepEqual(
    registry.update('a-voice', { fallbackId: 'b-voice' }),
    ['fallback chain for "a-voice" would cycle'],
  );
  assert.equal(registry.get('a-voice')?.fallbackId, 'voice-v22-default');
  assert.deepEqual(registry.remove('a-voice'), ['profile "a-voice" is a fallback for b-voice']);
});

test('voice v22: switch timing — now when idle, parked when speaking', () => {
  const registry = createVoiceProfileRegistryV22('s1');
  assert.deepEqual(registry.switchTo('voice-v22-vi-calm', 100, false), []);
  assert.equal(registry.current(), 'voice-v22-vi-calm');
  assert.equal(registry.pendingSwitch(), null);
  assert.deepEqual(registry.switchTo('voice-v22-en-brisk', 200, true), []);
  assert.equal(registry.current(), 'voice-v22-vi-calm'); // not yet applied
  assert.deepEqual(registry.pendingSwitch(), {
    profileId: 'voice-v22-en-brisk', requestedAtMs: 200, timing: 'after-reply',
  });
  const applied = registry.applyPending(300);
  assert.equal(applied?.id, 'voice-v22-en-brisk');
  assert.equal(registry.current(), 'voice-v22-en-brisk');
  assert.equal(registry.applyPending(400), null);
  assert.deepEqual(registry.switchTo('ghost', 500, false), ['profile "ghost" does not exist']);
  assert.equal(registry.cancelPending(), false);
  registry.switchTo('voice-v22-vi-calm', 600, true);
  assert.equal(registry.cancelPending(), true);
  assert.equal(registry.current(), 'voice-v22-en-brisk');
});

test('voice v22: per-user defaults + restore after resume', () => {
  const registry = createVoiceProfileRegistryV22('s1');
  assert.equal(registry.userDefault('u1'), null);
  assert.equal(registry.profileForUser('u1').id, 'voice-v22-default');
  assert.deepEqual(registry.setUserDefault('u1', 'voice-v22-vi-calm'), []);
  assert.equal(registry.userDefault('u1'), 'voice-v22-vi-calm');
  assert.equal(registry.profileForUser('u1').id, 'voice-v22-vi-calm');
  assert.deepEqual(registry.setUserDefault('u1', 'ghost'), ['profile "ghost" does not exist']);
  assert.deepEqual(registry.setUserDefault('', 'voice-v22-vi-calm'), ['userId must be a non-empty string']);
  assert.equal(registry.clearUserDefault('u1'), true);
  assert.equal(registry.clearUserDefault('u1'), false);
  assert.deepEqual(registry.restoreCurrent('voice-v22-storyteller', 100), []);
  assert.equal(registry.current(), 'voice-v22-storyteller');
  assert.deepEqual(
    registry.restoreCurrent('ghost', 200),
    ['restored profile "ghost" missing; fell back to default'],
  );
  assert.equal(registry.current(), 'voice-v22-default');
  assert.equal(registry.stats().perUserDefaults, 0);
});

test('voice v22: session switches profile, parked switch applies after the reply', async () => {
  const session = createVoiceSessionV22('s1', {
    scriptedReplies: { hello: 'A fairly long reply that takes several TTS chunks to finish speaking aloud.' },
    ttsChunkChars: 20,
  });
  session.start(0);
  assert.deepEqual(session.switchProfile('voice-v22-vi-calm', 50), []);
  assert.equal(session.profiles.current(), 'voice-v22-vi-calm');
  const feed = session.feedFinal('hello', 100);
  // Wait until the agent is really mid-sentence, then switch.
  for (let i = 0; i < 100 && session.stats().ttsChunksSpoken === 0; i += 1) {
    await new Promise((r) => setTimeout(r, 2));
  }
  assert.ok(session.stats().ttsChunksSpoken > 0);
  assert.equal(session.state(), 'speaking');
  // Switch mid-reply: parked until the reply ends.
  assert.deepEqual(session.switchProfile('voice-v22-en-brisk', 150, 'user asked'), []);
  assert.equal(session.profiles.current(), 'voice-v22-vi-calm');
  assert.notEqual(session.profiles.pendingSwitch(), null);
  await feed;
  assert.equal(session.profiles.current(), 'voice-v22-en-brisk');
  assert.equal(session.stats().profileSwitches, 2);
  assert.deepEqual(session.switchProfile('ghost', 200), ['profile "ghost" does not exist']);
});

// ---------------------------------------------------------------- recovery
test('voice v22: backoff is exponential, capped, deterministic', () => {
  assert.equal(backoffDelayV22(1), 1000 + 37);
  assert.equal(backoffDelayV22(2), 2000 + 74);
  assert.equal(backoffDelayV22(3), 4000 + 111);
  assert.ok(backoffDelayV22(10) <= 30_000);
  assert.equal(backoffDelayV22(10), backoffDelayV22(10)); // deterministic
  assert.deepEqual(validateRecoveryV22Options({}), []);
  assert.ok(validateRecoveryV22Options({ disconnectAfterMs: 1000, degradedAfterMs: 5000 }).length > 0);
  assert.ok(validateRecoveryV22Options({ maxReconnectAttempts: 0 }).length > 0);
  assert.deepEqual(defaultRecoveryV22Options().maxReconnectAttempts, 5);
});

test('voice v22: unrecoverable failures are classified, recoverable ones are not', () => {
  assert.equal(isRecoverableFailureV22('transport-lost'), true);
  assert.equal(isRecoverableFailureV22('heartbeat-timeout'), true);
  assert.equal(isRecoverableFailureV22('checkpoint-corrupt'), false);
  assert.equal(isRecoverableFailureV22('resume-token-expired'), false);
  assert.equal(isRecoverableFailureV22('resume-token-unknown'), false);
  assert.ok(VOICE_V22_UNRECOVERABLE_FAILURES.includes('checkpoint-corrupt'));
  const f = makeFailureV22('journal-gap', 100, 'gap at seq 7', 7);
  assert.equal(f.recoverable, true);
  assert.equal(f.journalSeq, 7);
  assert.equal(f.message, 'gap at seq 7');
});

test('voice v22: heartbeat loop — live → degraded → disconnected → reconnecting → live', () => {
  const engine = createRecoveryEngineV22('s1', {
    degradedAfterMs: 1000, disconnectAfterMs: 2000, backoffBaseMs: 100, backoffMaxMs: 1000,
  });
  assert.equal(engine.phaseNow(), 'live');
  engine.heartbeat({ atMs: 0, rttMs: 120, ok: true });
  engine.heartbeat({ atMs: 500, rttMs: 3000, ok: true }); // late beat
  assert.equal(engine.stats().lateBeats, 1);
  assert.equal(engine.checkClock(1600), 'degraded');
  assert.deepEqual(engine.degradation(), ['tts-cache-off']);
  assert.equal(engine.isDegraded('tts-cache-off'), true);
  assert.equal(engine.checkClock(2600), 'disconnected');
  assert.equal(engine.stats().disconnects, 1);
  assert.deepEqual(engine.degradation(), ['tts-cache-off', 'panel-throttled', 'replies-summarised']);
  assert.ok(engine.nextAttemptAt() !== null);
  assert.equal(engine.attemptDue(2600), false);
  assert.equal(engine.attemptDue(engine.nextAttemptAt() ?? 0), true);
  const phase = engine.reportAttempt(engine.nextAttemptAt() ?? 0, 'success');
  assert.equal(phase, 'reconnecting');
  assert.equal(engine.stats().reconnectSuccesses, 1);
  assert.equal(engine.markResumed(3000, false), 'live');
  assert.equal(engine.stats().recoveries, 1);
  assert.equal(engine.degradation().length, 0);
  assert.match(engine.summary(), /phase=live/);
});

test('voice v22: failed attempts back off and give up after the cap', () => {
  const engine = createRecoveryEngineV22('s1', { maxReconnectAttempts: 2, backoffBaseMs: 100, backoffMaxMs: 500 });
  engine.heartbeat({ atMs: 0, rttMs: 100, ok: true });
  engine.markDisconnected(100, 'transport-lost', 'wifi dropped', 42);
  assert.equal(engine.phaseNow(), 'disconnected');
  assert.equal(engine.failuresHistory().length, 1);
  assert.equal(engine.failuresHistory()[0].journalSeq, 42);
  engine.reportAttempt(200, 'failure', 'transport-lost');
  assert.equal(engine.phaseNow(), 'disconnected');
  assert.equal(engine.stats().reconnectAttempts, 1);
  engine.reportAttempt(400, 'failure', 'transport-lost');
  assert.equal(engine.phaseNow(), 'closed');
  assert.equal(engine.stats().gaveUp, true);
  assert.equal(engine.attemptDue(99999), false);
});

test('voice v22: unrecoverable reconnect failure closes at once', () => {
  const engine = createRecoveryEngineV22('s1');
  engine.heartbeat({ atMs: 0, rttMs: 100, ok: true });
  engine.markDisconnected(100, 'transport-lost', 'lost');
  engine.reportAttempt(200, 'failure', 'checkpoint-corrupt');
  assert.equal(engine.phaseNow(), 'closed');
  assert.equal(engine.stats().gaveUp, true);
});

test('voice v22: mock transport scripts beats, failures and misses', () => {
  const transport = new MockTransportV22({ rttsMs: [100, 200], failAt: [1], missAt: [2] });
  assert.deepEqual(transport.beat(0), { atMs: 0, rttMs: 100, ok: true });
  assert.deepEqual(transport.beat(100), { atMs: 100, rttMs: 200, ok: false });
  assert.deepEqual(transport.beat(200), { atMs: 200, rttMs: 0, ok: false });
  assert.equal(transport.beatsSent(), 3);
  transport.reset();
  assert.equal(transport.beatsSent(), 0);
  const engine = createRecoveryEngineV22('s1');
  engine.heartbeat(transport.beat(0));
  assert.equal(engine.stats().heartbeats, 1);
  assert.equal(engine.stats().missedBeats, 0);
});

// ---------------------------------------------------------------- monitor panel
test('voice v22: panel options + snapshot defaults', () => {
  assert.deepEqual(validateMonitorPanelV22Options({}), []);
  assert.ok(validateMonitorPanelV22Options({ lowDurabilityThreshold: 2 }).length > 0);
  assert.deepEqual(defaultMonitorPanelV22Options().maxTranscriptLines, 10);
  const panel = createMonitorPanelV22('s1');
  const snap = panel.snapshot(0);
  assert.equal(snap.sessionId, 's1');
  assert.equal(snap.turnState, 'idle');
  assert.equal(snap.durability.phase, 'live');
  assert.equal(snap.durability.durabilityScore, 1);
  assert.deepEqual(snap.alerts, []);
  assert.ok(VOICE_V22_PANEL_I18N_KEYS.includes('voice.v22.panel.phase.disconnected'));
  assert.ok(VOICE_V22_PANEL_I18N_KEYS.includes('voice.v22.panel.resumeWithGaps'));
  assert.equal(durabilityScoreV22(null, 10), 0);
  assert.equal(durabilityScoreV22(10, 10), 1);
  assert.equal(durabilityScoreV22(5, 10), 0.5);
  assert.equal(durabilityScoreV22(null, 0), 1);
});

test('voice v22: panel tracks durability, recovery, queued replies and alerts', () => {
  const panel = createMonitorPanelV22('s1');
  panel.setTurnState('speaking', 100);
  panel.setFloor('agent', 100);
  panel.setProfile('voice-v22-vi-calm', 100);
  panel.addFinalTranscript('hello there', 200);
  panel.setLivePartial('how are', 300);
  panel.recordBargeIn('interrupt', 400);
  panel.recordBargeIn('duck-soft', 500);
  panel.recordBargeIn('duck-hard', 600);
  panel.setDurability({ phase: 'disconnected', journalSeq: 42, lastCheckpointSeq: 30, durabilityScore: 0.4, disconnects: 1 }, 700);
  panel.setRecovery({ heartbeats: 10, meanRttMs: 2500, maxRttMs: 4000, reconnectAttempts: 2, gaveUp: false, degradationSteps: ['tts-cache-off'] }, 700);
  panel.setQueuedReplies([{ id: 'q1', turnId: 't1', remainingChars: 120, disposition: 'summarise', queuedAtMs: 650 }], 700);
  const snap = panel.snapshot(800);
  assert.equal(snap.turnState, 'speaking');
  assert.equal(snap.floor, 'agent');
  assert.equal(snap.profileId, 'voice-v22-vi-calm');
  assert.deepEqual(snap.finalTranscript, ['hello there']);
  assert.equal(snap.livePartial, 'how are');
  assert.equal(snap.bargeIns, 1);
  assert.equal(snap.ducksSoft, 1);
  assert.equal(snap.ducksHard, 1);
  assert.equal(snap.lastBargeInDecision, 'duck-hard');
  assert.equal(snap.queuedReplies.length, 1);
  assert.equal(snap.queuedReplies[0].disposition, 'summarise');
  assert.ok(snap.alerts.some((a) => a.includes('disconnected')));
  assert.ok(snap.alerts.some((a) => a.includes('Durability low')));
  assert.ok(snap.alerts.some((a) => a.includes('RTT high')));
  assert.ok(snap.alerts.some((a) => a.includes('Load shedding')));
  const md = panel.markdown(800);
  assert.match(md, /# Voice monitor v22/);
  assert.match(md, /Phase: disconnected/);
  assert.match(md, /hello there/);
  assert.match(md, /## Alerts/);
  assert.match(panel.summary(800), /phase=disconnected/);
});

test('voice v22: panel mirrorSession + last-resume alerts', () => {
  const session = createVoiceSessionV22('s1');
  session.start(0);
  const panel = createMonitorPanelV22('s1');
  panel.mirrorSession(session.stats(), 100);
  let snap = panel.snapshot(100);
  assert.equal(snap.turnState, 'listening');
  assert.equal(snap.floor, 'user');
  panel.setLastResume({
    outcome: 'resumed-with-gaps', sessionId: 's1', atMs: 200, coveredSeq: 9,
    replayedEntries: 3, missingSeqs: [7, 8], turns: 2, transcriptSegments: 2,
    pendingReply: null, unfinalisedPartial: '', reason: 'gaps',
  }, 200);
  snap = panel.snapshot(300);
  assert.equal(snap.durability.lastResumeOutcome, 'resumed-with-gaps');
  assert.equal(snap.durability.lastResumeMissingSeqs, 2);
  assert.ok(snap.alerts.some((a) => a.includes('missing journal seq')));
});

test('voice v22: session heartbeat drives recovery; disconnected session summarises long replies', async () => {
  const session = createVoiceSessionV22('s1', {
    recovery: { degradedAfterMs: 1000, disconnectAfterMs: 5000 },
    scriptedReplies: { hello: 'x'.repeat(300) },
  });
  session.start(0);
  session.heartbeat({ atMs: 0, rttMs: 100, ok: true });
  assert.equal(session.phase(), 'live');
  session.advance(6000); // no beat since 0 → degraded, then disconnected (load shedding on)
  assert.equal(session.phase(), 'disconnected');
  assert.equal(session.recovery.isDegraded('replies-summarised'), true);
  const short = await session.feedFinal('hello', 6000);
  assert.ok(short.endsWith('…'));
  assert.ok(short.length < 300);
  // Reconnect: the session comes back live and speaks in full again.
  const report = await session.attemptReconnect(7000, 'success');
  assert.notEqual(report, null);
  assert.equal(session.phase(), 'live');
  const full = await session.feedFinal('hello', 8000);
  assert.equal(full.length, 300);
  assert.equal(full.endsWith('…'), false);
});
