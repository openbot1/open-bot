/**
 * Tests for voice v20 persistence + resume (v1.29, Team T5).
 *
 * Covers sessionPersistenceV20 (envelope sealing, checksum,
 * corruption detection, memory + disk stores, retention,
 * unsafe ids) and resumeV20 (decision rules, orchestrator
 * lifecycle, prosody carry-over, multi-drop refusal).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SessionPersistenceStoreV20,
  createSessionPersistenceStoreV20,
  sealCheckpointV20,
  parseCheckpointV20,
  checkpointChecksumV20,
  stableStringifyV20,
  fnv1aV20,
  isSafeSessionIdV20,
  payloadFromSnapshotV20,
  defaultSessionPersistenceV20Options,
  validateSessionPersistenceV20Options,
} from '../packages/core/dist/voiceV20/sessionPersistenceV20.js';
import {
  ResumeOrchestratorV20,
  createResumeOrchestratorV20,
  decideResumeV20,
  summariseRemainingV20,
  defaultResumeV20Options,
  validateResumeV20Options,
} from '../packages/core/dist/voiceV20/resumeV20.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function makeSnapshot(turns = []) {
  return {
    phase: 'listening',
    turnCounter: turns.length,
    turns,
    committedTranscript: turns.map((t) => t.text).join(' '),
    stats: {
      phase: 'listening', frames: 10, turns: turns.length,
      userTurns: 1, agentTurns: 1, cuts: 0,
      ttsChunksPlayed: 2, ttsCharsSpoken: 40, events: 5,
    },
  };
}

// ---------------------------------------------------------------- checksum + envelope
test('voice v129-t5: stable stringify sorts keys, FNV-1a is deterministic', () => {
  assert.equal(stableStringifyV20({ b: 1, a: { d: 2, c: 3 } }), '{"a":{"c":3,"d":2},"b":1}');
  assert.equal(fnv1aV20('hello'), fnv1aV20('hello'));
  assert.notEqual(fnv1aV20('hello'), fnv1aV20('hallo'));
  assert.equal(fnv1aV20(''), '811c9dc5');
});

test('voice v129-t5: seal + parse round-trips; tampering fails the checksum', () => {
  const payload = payloadFromSnapshotV20({
    sessionId: 's1', number: 1, atMs: 500,
    snapshot: makeSnapshot([{ id: 'turn-1', role: 'user', text: 'Xin chào', atMs: 0, durationMs: 200 }]),
    transcriptSegments: [],
    remainingText: 'phần còn lại của câu trả lời',
    resumeAction: 'resume',
  });
  const sealed = sealCheckpointV20(payload);
  assert.equal(sealed.formatVersion, 1);
  const { checksum: _sealedChecksum, ...sealedPayload } = sealed;
  assert.equal(sealed.checksum, checkpointChecksumV20(sealedPayload));
  const parsed = parseCheckpointV20(JSON.stringify(sealed));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.checkpoint?.sessionId, 's1');
  assert.equal(parsed.checkpoint?.remainingText, 'phần còn lại của câu trả lời');

  const tampered = { ...sealed, remainingText: 'đã sửa' };
  assert.equal(parseCheckpointV20(JSON.stringify(tampered)).ok, false);
  assert.match(parseCheckpointV20(JSON.stringify(tampered)).errors.join(' '), /checksum mismatch/);

  const wrongVersion = { ...sealed, formatVersion: 99 };
  assert.equal(parseCheckpointV20(JSON.stringify(wrongVersion)).ok, false);
  assert.equal(parseCheckpointV20('not json').ok, false);
  assert.equal(parseCheckpointV20('[]').ok, false);
});

test('voice v129-t5: unsafe session ids are rejected', () => {
  assert.equal(isSafeSessionIdV20('ok-session_1.2'), true);
  assert.equal(isSafeSessionIdV20('../escape'), false);
  assert.equal(isSafeSessionIdV20('a/b'), false);
  assert.equal(isSafeSessionIdV20(''), false);
  assert.equal(isSafeSessionIdV20('..'), false);
  assert.deepEqual(validateSessionPersistenceV20Options({ maxPerSession: 0 }), ['maxPerSession must be >= 1']);
  assert.deepEqual(validateSessionPersistenceV20Options({ maxBytes: 10 }), ['maxBytes must be >= 1024']);
  assert.deepEqual(validateSessionPersistenceV20Options({}), []);
  assert.equal(defaultSessionPersistenceV20Options().maxPerSession, 10);
});

// ---------------------------------------------------------------- memory store
test('voice v129-t5: memory store saves, loads latest, lists, deletes, prunes', () => {
  const store = createSessionPersistenceStoreV20({ maxPerSession: 3 });
  for (let n = 1; n <= 5; n += 1) {
    const saved = store.save(payloadFromSnapshotV20({
      sessionId: 'mem', number: n, atMs: n * 100, snapshot: makeSnapshot(),
    }), n * 100);
    assert.equal(saved.ok, true, `save #${n}`);
  }
  // Retention kept only the newest 3.
  assert.deepEqual(store.list('mem').map((e) => e.number), [3, 4, 5]);
  const latest = store.loadLatest('mem');
  assert.equal(latest.ok, true);
  assert.equal(latest.checkpoint?.number, 5);
  assert.equal(store.load('mem', 3).ok, true);
  assert.equal(store.load('mem', 1).ok, false);
  assert.equal(store.delete('mem', 4), true);
  assert.equal(store.delete('mem', 4), false);
  assert.deepEqual(store.list('mem').map((e) => e.number), [3, 5]);
  assert.equal(store.deleteSession('mem'), 2);
  assert.deepEqual(store.list('mem'), []);
  assert.equal(store.loadLatest('mem').ok, false);

  const bad = store.save(payloadFromSnapshotV20({
    sessionId: '../x', number: 1, atMs: 0, snapshot: makeSnapshot(),
  }), 0);
  assert.equal(bad.ok, false);
  assert.match(bad.error ?? '', /unsafe sessionId/);

  const tiny = createSessionPersistenceStoreV20({ maxBytes: 1024 });
  const huge = tiny.save(payloadFromSnapshotV20({
    sessionId: 'big', number: 1, atMs: 0,
    snapshot: makeSnapshot([{ id: 't', role: 'user', text: 'x'.repeat(5000), atMs: 0, durationMs: 1 }]),
  }), 0);
  assert.equal(huge.ok, false);
  assert.match(huge.error ?? '', /exceeds maxBytes/);

  const s = store.getStats();
  assert.equal(s.saves, 5);
  assert.equal(s.pruned, 2);
  assert.ok(store.summary().includes('memory-only'));
});

// ---------------------------------------------------------------- disk store
test('voice v129-t5: disk store survives a fresh instance (real files)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openbot-voice-v129-'));
  try {
    const store = new SessionPersistenceStoreV20({ baseDir: dir, maxPerSession: 5 });
    const saved = store.save(payloadFromSnapshotV20({
      sessionId: 'disk-1', number: 7, atMs: 700,
      snapshot: makeSnapshot([{ id: 'turn-1', role: 'agent', text: 'Chào bạn', atMs: 0, durationMs: 300 }]),
      spokenPrefix: 'Chào',
      remainingText: 'bạn',
    }), 700);
    assert.equal(saved.ok, true);
    assert.equal(saved.bytes !== undefined && saved.bytes > 0, true);
    // Files exist on disk, named by session + number.
    assert.deepEqual(fs.readdirSync(path.join(dir, 'disk-1')), ['disk-1.000007.json']);

    // A second store instance over the same dir sees the checkpoint.
    const reopened = new SessionPersistenceStoreV20({ baseDir: dir });
    const loaded = reopened.loadLatest('disk-1');
    assert.equal(loaded.ok, true);
    assert.equal(loaded.checkpoint?.number, 7);
    assert.equal(loaded.checkpoint?.spokenPrefix, 'Chào');
    assert.equal(loaded.checkpoint?.remainingText, 'bạn');
    assert.deepEqual(reopened.listSessions(), ['disk-1']);

    // Corrupt the file on disk: the next load reports corruption.
    fs.writeFileSync(path.join(dir, 'disk-1', 'disk-1.000007.json'), '{"formatVersion":1,"tampered":true}');
    const corrupt = reopened.loadLatest('disk-1');
    assert.equal(corrupt.ok, false);
    assert.equal(corrupt.corrupt, true);
    assert.equal(reopened.getStats().corruptLoads, 1);
    // The summary marks disk mode with "— disk: <path>" (vs "— memory-only");
    // the session id itself is proven by listSessions() above, not by
    // the summary text. (RC merge reconciliation: main renamed the
    // summary wording "dir" → "disk:" while v144's test still expected
    // /dir / — the merged src says "disk:", so the test must too.)
    assert.match(reopened.summary(), /disk/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- resume decisions
test('voice v129-t5: decideResumeV20 picks restart / resume / summarise / drop', () => {
  const full = 'Hà Nội là thủ đô của Việt Nam, nổi tiếng với phố cổ, hồ Hoàn Kiếm và ẩm thực đường phố rất phong phú và đa dạng.';
  // Nothing heard yet → restart the whole reply.
  assert.equal(decideResumeV20({ replyText: full, spokenChars: 0 }).action, 'restart');
  // Short tail → resume it.
  assert.equal(decideResumeV20({ replyText: full, spokenChars: full.length - 5 }).action, 'resume');
  // Long remainder → summarise. The remainder must actually be long:
  // summariseMinChars defaults to 400, so a ~102-char remainder (the
  // single-sentence reply) correctly resumes instead. Use a 4x reply
  // (~441 chars remain) to cross the default threshold.
  const longFull = `${full} ${full} ${full} ${full}`;
  const long = decideResumeV20({ replyText: longFull, spokenChars: 10 });
  assert.equal(long.action, 'summarise');
  assert.ok(long.summary.length > 0 && long.summary.length < longFull.length);
  assert.ok(long.speakText.length > 0);
  // Fully spoken → drop.
  assert.equal(decideResumeV20({ replyText: full, spokenChars: full.length }).action, 'drop');
  // Explicit user choice wins.
  assert.equal(decideResumeV20({ replyText: full, spokenChars: 10, userAction: 'drop' }).action, 'drop');
  assert.equal(decideResumeV20({ replyText: full, spokenChars: 10, userAction: 'restart' }).action, 'restart');
  assert.deepEqual(validateResumeV20Options({ maxAttempts: 0 }), ['maxAttempts must be >= 1']);
  assert.deepEqual(validateResumeV20Options({}), []);
  assert.equal(defaultResumeV20Options().maxAttempts, 3);
});

test('voice v129-t5: summariseRemainingV20 keeps first + last sentence', () => {
  const text = 'Câu đầu tiên rất quan trọng. Ở giữa có rất nhiều chi tiết dài dòng không cần thiết. Câu cuối cùng kết luận vấn đề.';
  // Cap 80 < text length 114: the default cap (200) exceeds the text,
  // so summariseRemainingV20 correctly returns it unchanged and the
  // "shorter than the original" assert can never hold.
  const s = summariseRemainingV20(text, 80);
  assert.ok(s.startsWith('Câu đầu tiên'));
  assert.ok(s.includes('Câu cuối cùng'));
  assert.ok(s.length < text.length);
  assert.equal(summariseRemainingV20('Ngắn thôi.', 200), 'Ngắn thôi.');
  assert.equal(summariseRemainingV20('', 200), '');
});

// ---------------------------------------------------------------- orchestrator
test('voice v129-t5: resume orchestrator interrupt → plan → confirm with prosody carry', () => {
  const orch = createResumeOrchestratorV20();
  const reply = 'Hà Nội là thủ đô của Việt Nam, nổi tiếng với phố cổ, hồ Hoàn Kiếm và ẩm thực đường phố.';
  orch.interrupt({
    sessionId: 'r1', turnId: 'turn-2', replyText: reply, spokenChars: 30,
    reason: 'barge-in', atMs: 1000,
    lastProsodyPlan: { rate: 0.85, pitchSt: 2.5, volume: 1, emphasis: 'strong', contour: 'statement', pauseBeforeMs: 0 },
  });
  const plan = orch.plan('r1', undefined, 1100);
  assert.ok(plan !== null);
  assert.equal(plan?.action, 'resume');
  assert.ok((plan?.speakText.length ?? 0) > 0);
  assert.ok((plan?.speakChunks.length ?? 0) > 0);
  // Prosody carried across the cut: first chunk keeps the cut pitch.
  assert.equal(plan?.speakChunks[0]?.prosody.pitchSt, 2.5);
  assert.equal(plan?.carriedProsody?.pitchSt, 2.5);
  assert.equal(plan?.attempt, 1);
  const confirmed = orch.confirm('r1', 1200);
  assert.equal(confirmed?.action, 'resume');
  const state = orch.getSessionState('r1');
  assert.equal(state?.resumes, 1);
  assert.equal(state?.consecutiveDrops, 0);
  assert.equal(orch.plan('r1'), null);
  assert.equal(orch.confirm('r1'), null);
  assert.ok(orch.summary().includes('1 interrupts'));
});

test('voice v129-t5: orchestrator refuses resume after the attempt budget', () => {
  const orch = new ResumeOrchestratorV20({ maxAttempts: 1 });
  const reply = 'Một câu trả lời dài để còn lại đủ nhiều ký tự cho việc nối lại sau khi bị ngắt giữa chừng.';
  orch.interrupt({ sessionId: 'r2', turnId: 't1', replyText: reply, spokenChars: 5, reason: 'network-lost', atMs: 0 });
  const first = orch.plan('r2', undefined, 10);
  assert.ok(first !== null);
  orch.confirm('r2', 20);
  // Second interrupt: the attempt budget is spent → plan refuses.
  orch.interrupt({ sessionId: 'r2', turnId: 't2', replyText: reply, spokenChars: 5, reason: 'network-lost', atMs: 100 });
  assert.equal(orch.canResume('r2').ok, false);
  assert.equal(orch.plan('r2', undefined, 110), null);
  assert.equal(orch.getStats().refused, 1);
  // An explicit user action still goes through (the user overrides).
  const forced = orch.plan('r2', 'drop', 120);
  assert.ok(forced !== null);
  assert.equal(forced?.action, 'drop');
  orch.confirm('r2', 130);
  // Backoff grows with attempts.
  const orch2 = createResumeOrchestratorV20();
  orch2.interrupt({ sessionId: 'b', turnId: 't', replyText: reply, spokenChars: 5, reason: 'timeout', atMs: 0 });
  const backoff0 = orch2.nextBackoffMs('b');
  orch2.plan('b', undefined, 1);
  assert.ok(orch2.nextBackoffMs('b') >= backoff0);
  orch2.forget('b');
  assert.equal(orch2.getSessionState('b'), undefined);
});

test('voice v129-t5: decline drops the remainder and counts a drop', () => {
  const orch = createResumeOrchestratorV20();
  const reply = 'Một câu trả lời dài để còn lại đủ nhiều ký tự cho việc nối lại sau khi bị ngắt giữa chừng.';
  orch.interrupt({ sessionId: 'r3', turnId: 't1', replyText: reply, spokenChars: 5, reason: 'crash', atMs: 0 });
  const declined = orch.decline('r3', 10);
  assert.equal(declined?.action, 'drop');
  assert.equal(orch.getSessionState('r3')?.drops, 1);
  assert.equal(orch.getSessionState('r3')?.consecutiveDrops, 1);
});
