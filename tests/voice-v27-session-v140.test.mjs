/**
 * Tests for the voice v27 durable session (v1.40, Team T5).
 *
 * Covers VoiceSessionV27 end to end: open with a persona, the
 * full turn flow (user frames -> agent reply -> barge-in stop ->
 * agent done), pause / resume, checkpoint, close, state
 * confirmation errors, restore after a restart, and crash
 * recovery (unclean shutdown -> paused + recovered -> resume).
 *
 * All offline, deterministic, virtual clock, no key / network / audio.
 * Session files live in a fresh temp dir per test.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  DurableSessionStoreV27,
  VoiceSessionV27,
  createDurableSessionStoreV27,
  createVoiceSessionV27,
} from '../packages/core/dist/voiceV27/index.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'voice-v27-session-'));
}

function openSession(dir, sessionId = 's1', botId = 'bot-1', personaId = 'v27-friendly') {
  const session = createVoiceSessionV27(sessionId, { store: { baseDir: dir } });
  const snap = session.open(0, { botId, personaId });
  return { session, snap };
}

/** Drive one full user turn: speech frames then silence to end it. */
function driveUserTurn(session, startMs) {
  session.userStart(startMs, 'xin chào');
  let ended = null;
  for (let i = 0; i < 6; i++) {
    session.userFrame({ atMs: startMs + 100 + i * 50, energy: 0.6, isSpeech: true });
  }
  for (let i = 0; i < 14; i++) {
    const r = session.userFrame({ atMs: startMs + 400 + i * 50, energy: 0.02 });
    if (r.frame !== null && r.frame.turnEnded) ended = r.snapshot;
  }
  return ended;
}

test('v27 session: open, turn flow, barge-in stop, pause/resume, close', () => {
  const dir = tmpDir();
  const { session, snap } = openSession(dir);
  assert.equal(snap.state, 'listening');
  assert.equal(snap.botId, 'bot-1');
  assert.equal(snap.persona.id, 'v27-friendly');
  assert.equal(snap.vadPreset, 'balanced');
  assert.equal(snap.interruptMode, 'always');
  assert.equal(snap.turns, 0);
  assert.ok(fs.existsSync(path.join(dir, 's1.json')));
  assert.equal(session.stateNow(), 'listening');
  assert.equal(session.requireState(['listening'], 'user-start').ok, true);

  const afterTurn = driveUserTurn(session, 100);
  assert.ok(afterTurn);
  assert.equal(afterTurn.state, 'listening');
  assert.equal(afterTurn.turns, 1);

  const reply = 'Chào bạn, tôi có thể giúp gì cho bạn hôm nay?';
  const speaking = session.agentReply({ atMs: 1600, text: reply });
  assert.equal(speaking.state, 'speaking');
  assert.equal(speaking.currentTurn.role, 'assistant');
  assert.equal(speaking.agentSpeaking, true);
  session.agentSpeechProgress(1700, 10);

  // The user cuts in 900ms after the reply started: confirmed.
  const cut = session.userFrame({ atMs: 2500, energy: 0.8, speechMs: 500, text: 'khoan đã' });
  assert.ok(cut.interrupt);
  assert.equal(cut.interrupt.decision, 'confirmed');
  assert.equal(cut.snapshot.state, 'listening');
  assert.equal(cut.snapshot.interrupts, 1);
  assert.equal(cut.snapshot.agentSpeaking, false);

  // Reply again and let it finish.
  session.agentReply({ atMs: 2600, text: 'Vâng, tôi nghe đây.' });
  const done = session.agentDone(4000, 19);
  assert.equal(done.state, 'listening');
  assert.equal(done.turns, 3);

  const paused = session.pause(4100);
  assert.equal(paused.state, 'paused');
  const resumed = session.resume(4200);
  assert.equal(resumed.state, 'listening');
  const checkpointed = session.checkpoint('before-close', 4300);
  assert.equal(checkpointed.checkpoints.length, 1);
  assert.equal(checkpointed.checkpoints[0].label, 'before-close');

  const closed = session.close(5000);
  assert.equal(closed.state, 'ended');
  assert.equal(closed.closedAtMs, 5000);
  assert.equal(session.eventsList().length > 0, true);
  assert.match(session.summary(), /Voice session v27 s1/);
  assert.match(session.summary(), /Interrupts: 1 confirmed/);
  assert.match(session.markdown(), /Voice session v27/);

  // Ended is terminal: nothing else may run on this session.
  assert.throws(() => session.agentReply({ atMs: 5100, text: 'hi' }), /ended/);
  assert.throws(() => session.pause(5100), /ended/);
  assert.throws(() => session.userStart(5100), /ended/);
});

test('v27 session: short burst while speaking is ignored, critical replies protected', () => {
  const dir = tmpDir();
  const { session } = openSession(dir, 's2');
  session.agentReply({ atMs: 100, text: 'This is a long reply that keeps going and going.' });
  // A 100ms burst is a backchannel: the reply keeps speaking.
  const ignored = session.userFrame({ atMs: 1000, energy: 0.5, speechMs: 100 });
  assert.equal(ignored.interrupt.decision, 'ignored');
  assert.equal(ignored.snapshot.state, 'speaking');
  assert.equal(ignored.snapshot.interrupts, 0);
  session.agentDone(2000, 10);

  // A critical reply cannot be interrupted in never-critical mode.
  const strict = createVoiceSessionV27('s3', {
    store: { baseDir: dir },
    interrupt: { mode: 'never-critical' },
  });
  strict.open(0, { botId: 'bot-1' });
  strict.agentReply({ atMs: 100, text: 'Your code is 4 8 1 5.', critical: true });
  const blocked = strict.userFrame({ atMs: 1000, energy: 0.8, speechMs: 500 });
  assert.equal(blocked.interrupt.decision, 'ignored');
  assert.equal(blocked.interrupt.ignoreReason, 'critical-turn');
  assert.equal(blocked.snapshot.state, 'speaking');
});

test('v27 session: mid-session persona switch is remembered', () => {
  const dir = tmpDir();
  const { session } = openSession(dir, 's4', 'bot-7', 'v27-energetic');
  assert.equal(session.personaNow().id, 'v27-energetic');
  session.agentReply({ atMs: 100, text: 'Hello there, ready when you are.' });
  const switched = session.switchPersona('v27-calm', 500);
  assert.equal(switched.persona.id, 'v27-calm');
  assert.equal(session.personas.assignmentFor('bot-7').personaId, 'v27-calm');
  assert.equal(session.personas.assignmentFor('bot-7').midSessionSwitches, 1);
  assert.throws(() => session.switchPersona('nope', 600), /Unknown persona/);
  session.agentDone(900, 5);
  const switchedBack = session.switchPersona('v27-friendly', 1000);
  assert.equal(switchedBack.persona.id, 'v27-friendly');
  assert.equal(session.personas.assignmentFor('bot-7').midSessionSwitches, 1);
});

test('v27 session: restore after restart keeps state, persona and counts', () => {
  const dir = tmpDir();
  const { session } = openSession(dir, 's5', 'bot-2', 'v27-formal');
  driveUserTurn(session, 100);
  session.agentReply({ atMs: 1600, text: 'Sure, let me check that for you right now.' });
  session.userFrame({ atMs: 2500, energy: 0.8, speechMs: 500 });
  session.agentReply({ atMs: 2600, text: 'Done.' });
  session.agentDone(3000, 5);
  session.checkpoint('mid', 3100);

  // Simulate a restart: a brand-new session object, same dir.
  const restarted = createVoiceSessionV27('s5', { store: { baseDir: dir } });
  const restored = restarted.restore(4000);
  assert.ok(restored);
  assert.equal(restored.state, 'listening');
  assert.equal(restored.persona.id, 'v27-formal');
  assert.equal(restored.interrupts, 1);
  assert.equal(restored.turns, 3);
  assert.equal(restored.checkpoints.length, 1);
  assert.equal(restored.botId, 'bot-2');
  // The restored session keeps working: pause, resume, close.
  assert.equal(restarted.pause(4100).state, 'paused');
  assert.equal(restarted.resume(4200).state, 'listening');
  assert.equal(restarted.close(4300).state, 'ended');

  // Restore on an unknown session returns null.
  const ghost = createVoiceSessionV27('ghost', { store: { baseDir: dir } });
  assert.equal(ghost.restore(100), null);
});

test('v27 session: crash recovery parks the session paused, then resumes', () => {
  const dir = tmpDir();
  const { session } = openSession(dir, 's6', 'bot-3', 'v27-warm-vi');
  driveUserTurn(session, 100);
  session.agentReply({ atMs: 1600, text: 'Xin chào, tôi đang nghe.' });
  // No close(): the process "crashes" here.

  const store = createDurableSessionStoreV27({ baseDir: dir });
  const recovered = store.recoverUnclean(5000);
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].sessionId, 's6');
  assert.equal(recovered[0].state, 'paused');

  const resumed = createVoiceSessionV27('s6', { store: { baseDir: dir } });
  const snap = resumed.restore(5100);
  assert.ok(snap);
  assert.equal(snap.state, 'paused');
  assert.equal(snap.recovered, true);
  assert.equal(snap.persona.id, 'v27-warm-vi');
  assert.equal(resumed.resume(5200).state, 'listening');
  assert.equal(resumed.close(5300).state, 'ended');
});

test('v27 session: timeout check ends a stuck turn', () => {
  const dir = tmpDir();
  const session = createVoiceSessionV27('s7', {
    store: { baseDir: dir },
    turnManager: { maxListeningMs: 1000 },
  });
  session.open(0, { botId: 'bot-1' });
  session.userStart(100, 'hello?');
  const snap = session.timeoutCheck(2000);
  assert.equal(snap.state, 'listening');
  assert.equal(session.turns.stats().timeouts, 1);
});
