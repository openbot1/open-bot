/**
 * Tests for v1.19 (Team T1-TEST, wave 4) — memory v18 bi-temporal v2:
 * packages/core/src/memory/v18/biTemporalV2.ts
 *
 * Covers:
 *  - snapshotAtV18 (knowledge known at R about time T, current /
 *    superseded counts, invalid dates throw).
 *  - toBiTemporalViewV18 (learnedAt = createdAt, knownAtRecordTime).
 *  - applyCorrectionV18 (supersedes the old fact, closes its
 *    window, records the correction; same value / empty value /
 *    empty reason / unknown fact throw).
 *  - correctionTimelineV18 (steps in order, reason attached to
 *    the new step).
 *  - diffKnownAtV18 (facts learned between R1 and R2).
 *  - explainBiTemporalViewV18.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/memory-v18-bitemporal-v119.test.mjs
 *
 * No network. No model.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  TemporalGraphStore,
  InMemoryGraphBackend,
  snapshotAtV18,
  toBiTemporalViewV18,
  applyCorrectionV18,
  correctionTimelineV18,
  diffKnownAtV18,
  explainBiTemporalViewV18,
  V18BiTemporalError,
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
    scope: SCOPE,
    provenance: prov(opts.sourceText ?? `${subject} ${predicate} ${objectText}.`),
    validFrom: opts.validFrom ?? '2025-01-01T00:00:00.000Z',
    ...(opts.validUntil !== undefined ? { validUntil: opts.validUntil } : {}),
  });
}

test('v18 bitemporal: V18BiTemporalError carries its name', () => {
  const err = new V18BiTemporalError('boom');
  assert.equal(err.name, 'V18BiTemporalError');
  assert.ok(err instanceof Error);
});

test('v18 bitemporal: snapshotAtV18 sees a fact valid at T, known at R', () => {
  const store = freshStore();
  seedFact(store, 'An', 'lives_in', 'Hà Nội', { validFrom: '2025-01-01T00:00:00.000Z' });
  const snap = snapshotAtV18(store, '2026-01-01T00:00:00.000Z', {
    recordedAt: '2027-06-01T00:00:00.000Z',
    scope: SCOPE,
  });
  assert.equal(snap.facts.length, 1);
  assert.equal(snap.currentCount, 1);
  assert.equal(snap.supersededCount, 0);
  const [view] = snap.facts;
  assert.equal(view.subjectName, 'An');
  assert.equal(view.validAt, '2025-01-01T00:00:00.000Z');
  assert.equal(view.validUntil, null);
  assert.equal(view.learnedAt, view.fact.createdAt);
  assert.equal(view.knownAtRecordTime, true);
  assert.equal(view.currentAtRecordTime, true);
  assert.equal(snap.at, '2026-01-01T00:00:00.000Z');
});

test('v18 bitemporal: snapshot before the fact was learned is empty', () => {
  const store = freshStore();
  seedFact(store, 'An', 'lives_in', 'Hà Nội', { validFrom: '2025-01-01T00:00:00.000Z' });
  const snap = snapshotAtV18(store, '2026-01-01T00:00:00.000Z', {
    recordedAt: '2020-06-01T00:00:00.000Z',
    scope: SCOPE,
  });
  assert.equal(snap.facts.length, 0);
  assert.equal(snap.currentCount, 0);
});

test('v18 bitemporal: snapshotAtV18 rejects invalid dates', () => {
  const store = freshStore();
  assert.throws(
    () => snapshotAtV18(store, 'not-a-date', {}),
    (err) => err instanceof V18BiTemporalError && /khong hop le/.test(err.message),
  );
  assert.throws(
    () => snapshotAtV18(store, '2026-01-01T00:00:00.000Z', { recordedAt: 'not-a-date' }),
    (err) => err instanceof V18BiTemporalError,
  );
});

test('v18 bitemporal: applyCorrectionV18 supersedes + records the correction', () => {
  const store = freshStore();
  const old = seedFact(store, 'An', 'lives_in', 'Hà Nội', { validFrom: '2025-01-01T00:00:00.000Z' });
  const { fact, record } = applyCorrectionV18(store, old.id, {
    newObjectText: 'Đà Nẵng',
    reason: 'An đã chuyển nhà',
    evidence: 'An nhắn đã chuyển',
    actor: 'user',
    correctedAt: '2026-02-01T00:00:00.000Z',
  });
  assert.equal(fact.objectText, 'Đà Nẵng');
  assert.notEqual(fact.id, old.id);
  assert.equal(record.oldFactId, old.id);
  assert.equal(record.newFactId, fact.id);
  assert.equal(record.oldObjectText, 'Hà Nội');
  assert.equal(record.newObjectText, 'Đà Nẵng');
  assert.equal(record.reason, 'An đã chuyển nhà');
  assert.equal(record.evidence, 'An nhắn đã chuyển');
  assert.equal(record.actor, 'user');
  assert.equal(record.correctedAt, '2026-02-01T00:00:00.000Z');
  assert.equal(record.subjectName, 'An');
  assert.equal(record.predicate, 'lives_in');
  // Old fact is still queryable as superseded history.
  const oldAfter = store.getFact(old.id);
  assert.equal(oldAfter.status, 'superseded');
  // A later snapshot sees the new fact as current.
  const snap = snapshotAtV18(store, '2026-03-01T00:00:00.000Z', {
    recordedAt: '2027-06-01T00:00:00.000Z',
    scope: SCOPE,
  });
  assert.equal(snap.currentCount, 1);
  assert.equal(snap.facts.find((v) => v.currentAtRecordTime).fact.objectText, 'Đà Nẵng');
});

test('v18 bitemporal: applyCorrectionV18 validates its inputs', () => {
  const store = freshStore();
  const old = seedFact(store, 'An', 'lives_in', 'Hà Nội');
  assert.throws(
    () => applyCorrectionV18(store, 'no-such-fact', { newObjectText: 'X', reason: 'r', actor: 'user' }),
    (err) => err instanceof V18BiTemporalError && /Khong tim thay fact/.test(err.message),
  );
  assert.throws(
    () => applyCorrectionV18(store, old.id, { newObjectText: '   ', reason: 'r', actor: 'user' }),
    (err) => err instanceof V18BiTemporalError && /khong duoc rong/.test(err.message),
  );
  assert.throws(
    () => applyCorrectionV18(store, old.id, { newObjectText: 'Hà Nội', reason: 'r', actor: 'user' }),
    (err) => err instanceof V18BiTemporalError && /giong gia tri cu/.test(err.message),
  );
  assert.throws(
    () => applyCorrectionV18(store, old.id, { newObjectText: 'Đà Nẵng', reason: '   ', actor: 'user' }),
    (err) => err instanceof V18BiTemporalError && /Ly do hieu chinh/.test(err.message),
  );
  assert.throws(
    () => applyCorrectionV18(store, old.id, {
      newObjectText: 'Đà Nẵng', reason: 'r', actor: 'user', correctedAt: 'not-a-date',
    }),
    (err) => err instanceof V18BiTemporalError && /khong hop le/.test(err.message),
  );
});

test('v18 bitemporal: correctionTimelineV18 lists versions with the reason on the new step', () => {
  const store = freshStore();
  const old = seedFact(store, 'An', 'lives_in', 'Hà Nội', { validFrom: '2025-01-01T00:00:00.000Z' });
  const { record } = applyCorrectionV18(store, old.id, {
    newObjectText: 'Đà Nẵng',
    reason: 'An đã chuyển nhà',
    actor: 'user',
    correctedAt: '2026-02-01T00:00:00.000Z',
  });
  const steps = correctionTimelineV18(store, 'An', 'lives_in', [record], SCOPE);
  assert.ok(steps.length >= 2, 'at least old + new version');
  const last = steps[steps.length - 1];
  assert.equal(last.objectText, 'Đà Nẵng');
  assert.equal(last.status, 'active');
  assert.equal(last.correctionReason, 'An đã chuyển nhà');
  const oldSteps = steps.filter((s) => s.objectText === 'Hà Nội');
  assert.ok(oldSteps.length >= 1);
  assert.ok(oldSteps.every((s) => s.status === 'superseded'));
  assert.ok(oldSteps.every((s) => s.correctionReason === null));
  assert.deepEqual(correctionTimelineV18(store, 'Nobody', 'lives_in', [], SCOPE), []);
});

test('v18 bitemporal: diffKnownAtV18 finds facts learned between R1 and R2', () => {
  const store = freshStore();
  const fact = seedFact(store, 'An', 'lives_in', 'Hà Nội', { validFrom: '2025-01-01T00:00:00.000Z' });
  const diff = diffKnownAtV18(
    store,
    '2026-01-01T00:00:00.000Z',
    '2020-01-01T00:00:00.000Z',
    '2027-01-01T00:00:00.000Z',
    SCOPE,
  );
  assert.equal(diff.added.length, 1);
  assert.equal(diff.added[0].fact.id, fact.id);
  assert.deepEqual(diff.changed, []);
  const noDiff = diffKnownAtV18(
    store,
    '2026-01-01T00:00:00.000Z',
    '2027-01-01T00:00:00.000Z',
    '2027-06-01T00:00:00.000Z',
    SCOPE,
  );
  assert.deepEqual(noDiff.added, []);
  assert.deepEqual(noDiff.changed, []);
});

test('v18 bitemporal: toBiTemporalViewV18 + explainBiTemporalViewV18', () => {
  const store = freshStore();
  const fact = seedFact(store, 'An', 'lives_in', 'Hà Nội', { validFrom: '2025-01-01T00:00:00.000Z' });
  const view = toBiTemporalViewV18(
    { fact, subjectName: 'An', currentAtRecordTime: true },
    Date.parse('2027-01-01T00:00:00.000Z'),
  );
  assert.equal(view.learnedAt, fact.createdAt);
  assert.equal(view.knownAtRecordTime, true);
  assert.equal(view.validUntil, null);
  const text = explainBiTemporalViewV18(view);
  assert.match(text, /Hà Nội/);
  assert.match(text, /dung tu 2025-01-01T00:00:00\.000Z den nay/);
  assert.match(text, /he thong biet tu/);
  assert.doesNotMatch(text, /da co phien ban moi hon/);
  const oldView = { ...view, currentAtRecordTime: false };
  assert.match(explainBiTemporalViewV18(oldView), /da co phien ban moi hon/);
});
