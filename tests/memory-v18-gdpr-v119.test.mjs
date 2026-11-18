/**
 * Tests for v1.19 (Team T1-TEST, wave 4) — memory v18 GDPR erasure:
 * packages/core/src/memory/v18/gdprErasure.ts
 *
 * Covers:
 *  - countErasureV18 (user / entity / time-range, validation errors).
 *  - eraseV18 dry-run (counts but deletes nothing, still audits).
 *  - eraseV18 soft (facts marked deleted, episodes + quarantine
 *    removed) and hard (facts gone).
 *  - eraseV18 by entity with removeEntityIfOrphaned.
 *  - eraseV18 by time-range.
 *  - audit JSONL: append + readErasureAuditV18 (limit, empty dir).
 *  - targetLabelV18.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/memory-v18-gdpr-v119.test.mjs
 *
 * No network. No model.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  TemporalGraphStore,
  InMemoryGraphBackend,
  countErasureV18,
  eraseV18,
  readErasureAuditV18,
  targetLabelV18,
  V18ErasureError,
  V18_ERASURE_AUDIT_REL_PATH,
} from '../packages/core/dist/index.js';

const SCOPE = { userId: 'u1', botId: 'b1', runId: 'r1' };

function freshStore() {
  return new TemporalGraphStore(new InMemoryGraphBackend());
}

function prov(sourceText) {
  return {
    episodeId: 'e1',
    turnId: 't1',
    runId: 'r1',
    botId: 'b1',
    userId: 'u1',
    at: '2026-01-01T00:00:00.000Z',
    sourceText,
  };
}

function seedFact(store, subject, predicate, objectText, opts = {}) {
  return store.addFact({
    subjectName: subject,
    predicate,
    objectText,
    confidence: opts.confidence ?? 0.9,
    scope: opts.scope ?? SCOPE,
    provenance: prov(opts.sourceText ?? `${subject} ${predicate} ${objectText}.`),
    validFrom: opts.validFrom ?? '2025-01-01T00:00:00.000Z',
  });
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'v18-gdpr-'));
}

function seedUserData(store) {
  seedFact(store, 'An', 'likes', 'phở bò');
  seedFact(store, 'An', 'lives_in', 'Hà Nội');
  store.ingestEpisode({
    turnId: 'turn-1',
    runId: 'r1',
    botId: 'b1',
    userId: 'u1',
    role: 'user',
    text: 'Tôi thích phở bò.',
  });
  // Another user's data must survive a u1 erasure.
  seedFact(store, 'Binh', 'likes', 'cơm tấm', {
    scope: { userId: 'u2', botId: 'b1', runId: 'r1' },
  });
}

test('v18 gdpr: V18ErasureError + audit rel path', () => {
  const err = new V18ErasureError('boom');
  assert.equal(err.name, 'V18ErasureError');
  assert.equal(V18_ERASURE_AUDIT_REL_PATH, path.join('.open-bot', 'memory-erasure-audit.jsonl'));
});

test('v18 gdpr: countErasureV18 counts facts + episodes for a user', () => {
  const store = freshStore();
  seedUserData(store);
  const counted = countErasureV18(store, { kind: 'user', userId: 'u1', requestedBy: 'u1' });
  assert.equal(counted.kind, 'user');
  assert.equal(counted.mode, 'soft');
  assert.equal(counted.dryRun, true);
  assert.equal(counted.factsRemoved, 2);
  assert.equal(counted.episodesRemoved, 1);
  assert.equal(counted.quarantineRemoved, 0);
  assert.equal(counted.factIds.length, 2);
});

test('v18 gdpr: countErasureV18 validates its request', () => {
  const store = freshStore();
  seedUserData(store);
  assert.throws(
    () => countErasureV18(store, { kind: 'user', requestedBy: 'u1' }),
    (err) => err instanceof V18ErasureError && /can userId/.test(err.message),
  );
  assert.throws(
    () => countErasureV18(store, { kind: 'entity', requestedBy: 'u1' }),
    (err) => err instanceof V18ErasureError && /can entityId/.test(err.message),
  );
  assert.throws(
    () => countErasureV18(store, { kind: 'entity', entityId: 'no-such', requestedBy: 'u1' }),
    (err) => err instanceof V18ErasureError && /Khong tim thay entity/.test(err.message),
  );
  assert.throws(
    () => countErasureV18(store, {
      kind: 'time-range', from: '2026-02-01T00:00:00.000Z', to: '2026-01-01T00:00:00.000Z', requestedBy: 'u1',
    }),
    (err) => err instanceof V18ErasureError && /Khoang thoi gian/.test(err.message),
  );
  assert.throws(
    () => countErasureV18(store, { kind: 'bogus', requestedBy: 'u1' }),
    (err) => err instanceof V18ErasureError && /khong ho tro/.test(err.message),
  );
});

test('v18 gdpr: dry-run counts but deletes nothing, still writes audit', () => {
  const store = freshStore();
  seedUserData(store);
  const dir = tmpDir();
  const result = eraseV18(
    store,
    { kind: 'user', userId: 'u1', requestedBy: 'u1', reason: 'test dry-run' },
    { dryRun: true, workspaceDir: dir },
  );
  assert.equal(result.dryRun, true);
  assert.equal(result.factsRemoved, 2);
  assert.equal(result.episodesRemoved, 1);
  assert.equal(store.listFacts({ limit: 100 }).length, 3, 'nothing deleted on dry-run');
  const audit = readErasureAuditV18(dir);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].dryRun, true);
  assert.equal(audit[0].target, 'user:u1');
  assert.equal(audit[0].requestedBy, 'u1');
  assert.equal(audit[0].reason, 'test dry-run');
  assert.ok(fs.existsSync(path.join(dir, V18_ERASURE_AUDIT_REL_PATH)));
});

test('v18 gdpr: soft erase deletes facts (kept as history) + episodes, spares other users', () => {
  const store = freshStore();
  seedUserData(store);
  const dir = tmpDir();
  const result = eraseV18(
    store,
    { kind: 'user', userId: 'u1', requestedBy: 'u1', mode: 'soft', reason: 'GDPR article 17' },
    { workspaceDir: dir },
  );
  assert.equal(result.dryRun, false);
  assert.equal(result.mode, 'soft');
  assert.equal(result.factsRemoved, 2);
  assert.equal(result.episodesRemoved, 1);
  assert.equal(result.at.length > 0, true);
  assert.equal(result.requestedBy, 'u1');
  const remaining = store.listFacts({ status: 'active', limit: 100 });
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].scope.userId, 'u2', 'other user untouched');
  const deleted = store.listFacts({ status: 'deleted', limit: 100 });
  assert.equal(deleted.length, 2, 'soft-deleted facts stay as history');
  assert.equal(store.listUnprocessedEpisodes({ userId: 'u1' }, 10).length, 0);
  const audit = readErasureAuditV18(dir);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].dryRun, false);
  assert.equal(audit[0].factsRemoved, 2);
});

test('v18 gdpr: hard erase removes facts entirely', () => {
  const store = freshStore();
  seedUserData(store);
  const result = eraseV18(store, { kind: 'user', userId: 'u1', requestedBy: 'u1', mode: 'hard' });
  assert.equal(result.factsRemoved, 2);
  assert.equal(store.listFacts({ limit: 100 }).length, 1);
});

test('v18 gdpr: erase by entity removes its facts + the orphaned entity', () => {
  const store = freshStore();
  const fact = seedFact(store, 'An', 'likes', 'phở bò');
  const anId = store.listEntities().find((e) => e.name === 'An').id;
  void fact;
  const counted = countErasureV18(store, {
    kind: 'entity', entityId: anId, removeEntityIfOrphaned: true, requestedBy: 'u1',
  });
  assert.equal(counted.factsRemoved, 1);
  assert.equal(counted.entitiesRemoved, 1);
  const result = eraseV18(store, {
    kind: 'entity', entityId: anId, removeEntityIfOrphaned: true, requestedBy: 'u1', mode: 'hard',
  });
  assert.equal(result.factsRemoved, 1);
  assert.equal(result.entitiesRemoved, 1);
  assert.equal(store.getEntity(anId), undefined);
});

test('v18 gdpr: erase by entity without orphan removal keeps the entity', () => {
  const store = freshStore();
  seedFact(store, 'An', 'likes', 'phở bò');
  const anId = store.listEntities().find((e) => e.name === 'An').id;
  const result = eraseV18(store, {
    kind: 'entity', entityId: anId, requestedBy: 'u1', mode: 'hard',
  });
  assert.equal(result.factsRemoved, 1);
  assert.equal(result.entitiesRemoved, 0);
  assert.ok(store.getEntity(anId), 'entity kept when not orphaned-removal');
});

test('v18 gdpr: erase by time-range only touches facts created in range', () => {
  const store = freshStore();
  seedFact(store, 'An', 'likes', 'phở bò');
  // All facts were created "now" (2026-11-16); a 2025 range matches none.
  const empty = eraseV18(store, {
    kind: 'time-range',
    from: '2025-01-01T00:00:00.000Z',
    to: '2025-12-31T00:00:00.000Z',
    requestedBy: 'u1',
    mode: 'hard',
  });
  assert.equal(empty.factsRemoved, 0);
  assert.equal(store.listFacts({ limit: 100 }).length, 1);
  // A wide range covering "now" matches the fact.
  const hit = eraseV18(store, {
    kind: 'time-range',
    from: '2026-01-01T00:00:00.000Z',
    to: '2027-01-01T00:00:00.000Z',
    requestedBy: 'u1',
    mode: 'hard',
  });
  assert.equal(hit.factsRemoved, 1);
  assert.equal(store.listFacts({ limit: 100 }).length, 0);
});

test('v18 gdpr: readErasureAuditV18 returns [] without a file; limit applies', () => {
  const dir = tmpDir();
  assert.deepEqual(readErasureAuditV18(dir), []);
  const store = freshStore();
  seedUserData(store);
  eraseV18(store, { kind: 'user', userId: 'u1', requestedBy: 'u1' }, { dryRun: true, workspaceDir: dir });
  eraseV18(store, { kind: 'user', userId: 'u1', requestedBy: 'u1' }, { dryRun: true, workspaceDir: dir });
  eraseV18(store, { kind: 'user', userId: 'u1', requestedBy: 'u1' }, { dryRun: true, workspaceDir: dir });
  assert.equal(readErasureAuditV18(dir).length, 3);
  assert.equal(readErasureAuditV18(dir, 2).length, 2);
  assert.equal(readErasureAuditV18(dir, 1)[0].dryRun, true);
});

test('v18 gdpr: targetLabelV18 labels every kind without fact content', () => {
  assert.equal(targetLabelV18({ kind: 'user', userId: 'u1', requestedBy: 'u1' }), 'user:u1');
  assert.equal(targetLabelV18({ kind: 'entity', entityId: 'e-9', requestedBy: 'u1' }), 'entity:e-9');
  assert.equal(
    targetLabelV18({
      kind: 'time-range', from: '2026-01-01T00:00:00.000Z', to: '2026-02-01T00:00:00.000Z', requestedBy: 'u1',
    }),
    'time-range:2026-01-01T00:00:00.000Z..2026-02-01T00:00:00.000Z',
  );
});
