/**
 * Tests for voice v22 durable sessions (v1.35, Team T5).
 *
 * Covers the durable store (journal, checkpoints, snapshots,
 * corruption detection), the resume engine (token validation,
 * rehydrate, journal replay, gaps), and the durable session
 * itself (checkpoint → disconnect → reconnect → resume).
 * All offline, deterministic, no key / network / audio.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DurableSessionStoreV22,
  createDurableSessionStoreV22,
  checkpointChecksumV22,
  validateCheckpointV22,
  checkpointIsCorruptV22,
  defaultSessionStoreV22Options,
  validateSessionStoreV22Options,
} from '../packages/core/dist/voiceV22/sessionStoreV22.js';
import {
  ResumeEngineV22,
  createResumeEngineV22,
  parseResumeTokenV22,
  validateResumeTokenV22,
  findJournalGapsV22,
  mergeTranscriptSegmentV22,
  defaultResumeV22Options,
  validateResumeV22Options,
} from '../packages/core/dist/voiceV22/resumeV22.js';
import {
  VoiceSessionV22,
  createVoiceSessionV22,
} from '../packages/core/dist/voiceV22/sessionV22.js';
import { zeroCountersV22, resumeTokenV22 } from '../packages/core/dist/voiceV22/types.js';

function checkpointInput(store, atMs = 1000) {
  return {
    atMs,
    turnState: 'listening',
    durability: 'live',
    floor: 'user',
    profileId: 'voice-v22-default',
    turns: [{ id: 't1', role: 'user', text: 'hello', atMs: 100, durationMs: 200 }],
    transcript: [{ id: 's1', turnId: 't1', text: 'hello', status: 'final', confidence: 0.95, atMs: 100, throughSeq: 0 }],
    pendingReply: null,
    unfinalisedPartial: '',
    counters: zeroCountersV22(),
  };
}

// ---------------------------------------------------------------- store options
test('voice v22: store options defaults + validation', () => {
  const d = defaultSessionStoreV22Options();
  assert.equal(d.maxJournalEntries, 1000);
  assert.equal(d.autoCheckpointEvery, 50);
  assert.deepEqual(validateSessionStoreV22Options({}), []);
  assert.ok(validateSessionStoreV22Options({ maxJournalEntries: 5 }).length > 0);
  assert.ok(validateSessionStoreV22Options({ autoCheckpointEvery: -1 }).length > 0);
  assert.ok(validateSessionStoreV22Options({ maxTurns: 0 }).length > 0);
});

// ---------------------------------------------------------------- journal
test('voice v22: store appends journal entries with monotonic seq', () => {
  const store = createDurableSessionStoreV22('s1');
  const e1 = store.append('session-open', 0);
  const e2 = store.append('transcript', 100, { text: 'hi' });
  assert.equal(e1.seq, 1);
  assert.equal(e2.seq, 2);
  assert.equal(store.latestSeq(), 2);
  assert.equal(store.earliestSeq(), 1);
  assert.equal(store.hasGap(), false);
  assert.deepEqual(store.entriesSince(1).map((e) => e.seq), [2]);
  assert.equal(store.stats().journalEntries, 2);
  assert.match(store.summary(), /journal 2 entries/);
});

test('voice v22: store compacts the journal past the cap, counting drops', () => {
  const store = createDurableSessionStoreV22('s1', { maxJournalEntries: 10, autoCheckpointEvery: 0 });
  for (let i = 0; i < 15; i += 1) store.append('transcript', i * 10, { text: `line ${i}` });
  const stats = store.stats();
  assert.equal(stats.journalEntries, 10);
  assert.equal(stats.droppedJournalEntries, 5);
  // Compaction runs on every append once over the cap (one entry each).
  assert.equal(stats.compactions, 5);
  assert.equal(store.hasGap(), false);
});

// ---------------------------------------------------------------- checkpoints
test('voice v22: checkpoint is stamped with journal seq + resume token + checksum', () => {
  const store = createDurableSessionStoreV22('s1');
  store.append('session-open', 0);
  store.append('transcript', 100, { text: 'hello' });
  const { checkpoint, checksum } = store.checkpointNow(checkpointInput(store, 1000));
  assert.equal(checkpoint.version, 1);
  assert.equal(checkpoint.sessionId, 's1');
  assert.equal(checkpoint.journalSeq, 2);
  assert.equal(checkpoint.resumeToken, resumeTokenV22('s1', 2));
  assert.equal(checksum, checkpointChecksumV22(checkpoint));
  assert.deepEqual(validateCheckpointV22(checkpoint), []);
  assert.equal(checkpointIsCorruptV22(checkpoint, checksum), false);
  assert.deepEqual(store.verifyCheckpoint(), { ok: true, errors: [] });
  assert.equal(store.durabilityScore(), 1);
  assert.equal(store.stats().lastCheckpointSeq, 2);
});

test('voice v22: tampered checkpoint fails validation and checksum', () => {
  const store = createDurableSessionStoreV22('s1');
  store.append('session-open', 0);
  const { checkpoint, checksum } = store.checkpointNow(checkpointInput(store, 1000));
  const tampered = { ...checkpoint, turns: 'not-an-array' };
  assert.ok(validateCheckpointV22(tampered).length > 0);
  assert.equal(checkpointIsCorruptV22(tampered, checksum), true);
  const wrongVersion = { ...checkpoint, version: 2 };
  assert.ok(validateCheckpointV22(wrongVersion).length > 0);
});

test('voice v22: auto-checkpoint fires after N journal entries', () => {
  const store = createDurableSessionStoreV22('s1', { autoCheckpointEvery: 3 });
  for (let i = 0; i < 2; i += 1) store.append('transcript', i);
  assert.equal(store.maybeAutoCheckpoint(checkpointInput(store, 100)), null);
  store.append('transcript', 200);
  const result = store.maybeAutoCheckpoint(checkpointInput(store, 300));
  assert.notEqual(result, null);
  assert.equal(result.checkpoint.journalSeq, 3);
  assert.equal(store.stats().entriesSinceCheckpoint, 0);
});

// ---------------------------------------------------------------- snapshots
test('voice v22: snapshot round-trips through JSON, wrong session refused', () => {
  const store = createDurableSessionStoreV22('s1');
  store.append('session-open', 0);
  store.checkpointNow(checkpointInput(store, 500));
  store.append('transcript', 600, { text: 'after checkpoint' });
  const json = store.snapshotJson(700);
  const restored = createDurableSessionStoreV22('s1');
  assert.deepEqual(restored.restoreJson(json), []);
  assert.equal(restored.latestSeq(), store.latestSeq());
  assert.equal(restored.latestCheckpoint()?.journalSeq, 1);
  assert.equal(restored.entries().length, 2);
  const wrongSession = createDurableSessionStoreV22('s2');
  assert.ok(wrongSession.restoreJson(json).length > 0);
  const other = createDurableSessionStoreV22('s1');
  assert.deepEqual(other.restoreJson('not json'), ['snapshot JSON is not valid JSON']);
});

// ---------------------------------------------------------------- resume tokens
test('voice v22: resume token parse + validate (expiry, wrong session)', () => {
  assert.deepEqual(parseResumeTokenV22('v22-resume-s1-42'), { sessionId: 's1', journalSeq: 42 });
  assert.equal(parseResumeTokenV22('garbage'), null);
  assert.equal(parseResumeTokenV22('v22-resume-s1-x'), null);
  const token = resumeTokenV22('s1', 2);
  assert.deepEqual(validateResumeTokenV22(token, 's1', 1000, 2000), []);
  assert.ok(validateResumeTokenV22(token, 's2', 1000, 2000).length > 0);
  assert.ok(validateResumeTokenV22(token, 's1', 1000, 1000 + 3_600_000 + 1).length > 0);
  assert.ok(validateResumeTokenV22('bad-token', 's1', 1000, 2000).length > 0);
  assert.ok(validateResumeV22Options({ tokenTtlMs: 1000 }).length > 0);
  assert.deepEqual(validateResumeV22Options({}), []);
  assert.deepEqual(defaultResumeV22Options().tokenTtlMs, 3_600_000);
});

test('voice v22: journal gap detection + transcript merge is idempotent', () => {
  const entries = [
    { seq: 3, kind: 'transcript', atMs: 30, sessionId: 's1' },
    { seq: 5, kind: 'transcript', atMs: 50, sessionId: 's1' },
  ];
  assert.deepEqual(findJournalGapsV22(entries, 2, 5), [4]);
  assert.deepEqual(findJournalGapsV22(entries, 2, 3), []);
  const seg = { id: 's1', turnId: 't1', text: 'hi', status: 'final', confidence: 0.9, atMs: 10, throughSeq: 0 };
  const partial = { id: 'p1', turnId: 't1', text: 'h', status: 'partial', confidence: 0.5, atMs: 5, throughSeq: 0 };
  let list = mergeTranscriptSegmentV22([], partial);
  list = mergeTranscriptSegmentV22(list, { ...seg, replacesId: 'p1' });
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 's1');
  list = mergeTranscriptSegmentV22(list, seg);
  assert.equal(list.length, 1);
});

// ---------------------------------------------------------------- resume engine
test('voice v22: resume engine rehydrates + replays the tail', () => {
  const store = createDurableSessionStoreV22('s1');
  store.append('session-open', 0);
  const { checkpoint } = store.checkpointNow(checkpointInput(store, 1000));
  store.append('transcript', 1100, { segmentId: 's2', turnId: 't2', text: 'second line', status: 'final', confidence: 0.9, throughSeq: 10 });
  store.append('profile-switch', 1200, { profileId: 'voice-v22-vi-calm' });
  const engine = createResumeEngineV22('s1');
  const tail = store.entriesSince(checkpoint.journalSeq);
  const { report, state } = engine.resume(checkpoint, tail, checkpoint.resumeToken, 2000);
  assert.equal(report.outcome, 'resumed');
  assert.equal(report.replayedEntries, 2);
  assert.equal(report.missingSeqs.length, 0);
  assert.notEqual(state, null);
  assert.equal(state.turns.length, 1);
  assert.equal(state.turns[0].restored, true);
  assert.equal(state.transcript.length, 2);
  assert.equal(state.profileId, 'voice-v22-vi-calm');
  assert.equal(state.counters.resumes, 1);
  assert.equal(engine.stats().resumed, 1);
  assert.equal(engine.successRate(), 1);
  assert.match(engine.summary(), /1 attempts/);
});

test('voice v22: resume with a journal gap reports resumed-with-gaps', () => {
  const store = createDurableSessionStoreV22('s1');
  store.append('session-open', 0);
  const { checkpoint } = store.checkpointNow(checkpointInput(store, 1000));
  const tail = [
    { seq: 3, kind: 'transcript', atMs: 1100, sessionId: 's1', detail: { segmentId: 's9', turnId: 't9', text: 'late', status: 'final' } },
    { seq: 5, kind: 'transcript', atMs: 1200, sessionId: 's1', detail: { segmentId: 's10', turnId: 't10', text: 'later', status: 'final' } },
  ];
  const engine = createResumeEngineV22('s1');
  const { report } = engine.resume(checkpoint, tail, checkpoint.resumeToken, 2000);
  assert.equal(report.outcome, 'resumed-with-gaps');
  assert.deepEqual(report.missingSeqs, [2, 4]);
  assert.equal(report.coveredSeq, 5);
  assert.match(report.reason, /missing journal seq/);
});

test('voice v22: resume with no checkpoint is a fresh start; bad token is rejected', () => {
  const engine = createResumeEngineV22('s1');
  const fresh = engine.resume(null, [], '', 1000);
  assert.equal(fresh.report.outcome, 'fresh-start');
  assert.equal(fresh.state, null);
  const store = createDurableSessionStoreV22('s1');
  store.append('session-open', 0);
  const { checkpoint } = store.checkpointNow(checkpointInput(store, 1000));
  const bad = engine.resume(checkpoint, [], 'v22-resume-other-1', 2000);
  assert.equal(bad.report.outcome, 'rejected');
  assert.equal(bad.report.failure?.kind, 'resume-token-unknown');
  assert.equal(bad.report.failure?.recoverable, false);
  const expired = engine.resume(checkpoint, [], checkpoint.resumeToken, 1000 + 3_600_000 + 5000);
  assert.equal(expired.report.outcome, 'rejected');
  assert.equal(expired.report.failure?.kind, 'resume-token-expired');
  assert.equal(engine.stats().rejected, 2);
  assert.equal(engine.stats().freshStarts, 1);
});

test('voice v22: resume maps speaking → paused so the agent never talks at an empty room', () => {
  const store = createDurableSessionStoreV22('s1');
  store.append('session-open', 0);
  const input = checkpointInput(store, 1000);
  input.turnState = 'speaking';
  const { checkpoint } = store.checkpointNow(input);
  const engine = createResumeEngineV22('s1');
  const { report, state } = engine.resume(checkpoint, [], checkpoint.resumeToken, 2000);
  assert.equal(report.outcome, 'resumed');
  assert.equal(state?.turnState, 'paused');
});

// ---------------------------------------------------------------- durable session
test('voice v22: session journals, checkpoints, disconnects and resumes', async () => {
  const session = createVoiceSessionV22('s1', {
    scriptedReplies: { hello: 'Hello there, this is a long reply that will be cut by the user.' },
    store: { autoCheckpointEvery: 0 },
  });
  session.start(0);
  assert.equal(session.state(), 'listening');
  const reply = await session.feedFinal('hello', 100);
  assert.match(reply, /Hello there/);
  assert.equal(session.state(), 'listening');
  const stats = session.stats();
  assert.equal(stats.turns, 1);
  assert.ok(stats.ttsChunksSpoken >= 1);
  assert.ok(session.store.latestSeq() > 0);
  const { checkpoint } = session.checkpointNow(200);
  assert.equal(checkpoint.turns.length, 2); // user + agent turns
  assert.equal(session.stats().checkpoints, 1);
  session.simulateDisconnect(300, 'wifi dropped');
  assert.equal(session.phase(), 'disconnected');
  assert.equal(session.state(), 'paused');
  const report = await session.attemptReconnect(5000, 'success');
  assert.notEqual(report, null);
  assert.equal(report.outcome, 'resumed');
  assert.equal(session.phase(), 'live');
  assert.equal(session.state(), 'listening');
  assert.equal(session.stats().resumes, 1);
  assert.equal(session.stats().disconnects, 1);
  assert.match(session.summary(), /phase=live/);
});

test('voice v22: session snapshot restores the store in a new session object', async () => {
  const session = createVoiceSessionV22('s1', { store: { autoCheckpointEvery: 0 } });
  session.start(0);
  await session.feedFinal('hello world', 100);
  session.checkpointNow(200);
  const json = session.snapshotJson(300);
  const other = createVoiceSessionV22('s1', { store: { autoCheckpointEvery: 0 } });
  assert.deepEqual(other.restoreSnapshotJson(json), []);
  assert.equal(other.store.latestSeq(), session.store.latestSeq());
  assert.notEqual(other.store.latestCheckpoint(), null);
  const bad = createVoiceSessionV22('s1');
  assert.ok(bad.restoreSnapshotJson('{"version": 9}').length > 0);
});

test('voice v22: failed reconnect keeps the session disconnected; resume-token path works', async () => {
  const session = createVoiceSessionV22('s1', { store: { autoCheckpointEvery: 0 } });
  session.start(0);
  await session.feedFinal('hello', 100);
  const { checkpoint } = session.checkpointNow(200);
  session.simulateDisconnect(300);
  const failed = await session.attemptReconnect(1500, 'failure');
  assert.equal(failed, null);
  assert.equal(session.phase(), 'disconnected');
  const report = session.resumeWithToken(checkpoint.resumeToken, 4000);
  assert.equal(report.outcome, 'resumed');
  assert.equal(session.phase(), 'live');
  const rejected = session.resumeWithToken('v22-resume-nope-1', 5000);
  assert.equal(rejected.outcome, 'rejected');
});

test('voice v22: pause/resume-paused round-trip + durability report', async () => {
  const session = createVoiceSessionV22('s1');
  session.start(0);
  session.pause(100);
  assert.equal(session.state(), 'paused');
  session.resumePaused(200);
  assert.equal(session.state(), 'listening');
  const report = session.durabilityReport(300);
  assert.equal(report.sessionId, 's1');
  assert.equal(report.phase, 'live');
  assert.equal(report.profileId, 'voice-v22-default');
  assert.equal(typeof report.durabilityScore, 'number');
  session.close(400);
  assert.equal(session.eventsOf('closed').length, 1);
});
