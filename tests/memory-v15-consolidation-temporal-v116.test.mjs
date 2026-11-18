/**
 * Tests for v1.16 (Team T1) — memory v15:
 * packages/core/src/memoryV15/{consolidation,temporalKg}.ts
 *
 * Covers:
 *  - consolidation Mem0-v3: new v15 rule predicates (daily_routine /
 *    goal / constraint / reads / watches / lives_with / commutes_by)
 *    + inherited v13/v14 patterns (likes / lives_in / dislikes /
 *    prefers); mock LLM v15 (catches "me man", "nghien", "thuong day
 *    luc"); single-pass (llmCalls == turns); ADD-ONLY write-time
 *    (contradicting fact coexists, old fact stays active, store
 *    never supersedes at write-time); retrieval-time supersede
 *    (resolveCurrentV15: newest validFrom wins, tie -> highest
 *    confidence; old fact only marked superseded IN VIEW);
 *    resolveAllCurrentV15 groups; retract closes the old window.
 *  - temporal KG v3: bi-temporal intervals, window overlap +
 *    intersection, factsValidAtV15 (history answers "true at T"),
 *    time-travel (validAt + txAt, not-yet-known excluded),
 *    findContradictionsV15 (only overlapping single-valued pairs),
 *    loser rule (lower confidence loses; tie -> older loses),
 *    invalidateFactV15 + scanAndInvalidateContradictionsV15
 *    (invalidated fact still answers for T before invalidAt),
 *    factTimelineV15 + formatTimelineV15.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/memory-v15-consolidation-temporal-v116.test.mjs
 *
 * No network. No model.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  TemporalGraphStore,
  InMemoryGraphBackend,
  extractFactsV15Sync,
  extractV15RuleCandidates,
  V15MockLlmExtractor,
  extractFactsV15,
  consolidateTurnsV15,
  resolveCurrentV15,
  resolveAllCurrentV15,
  isSingleValuedPredicateV15,
  intervalOfFactV15,
  isFactValidAtV15,
  intervalsOverlapV15,
  intervalIntersectionV15,
  factsValidAtV15,
  timeTravelQueryV15,
  findContradictionsV15,
  loserOfContradictionV15,
  invalidateFactV15,
  scanAndInvalidateContradictionsV15,
  factTimelineV15,
  formatTimelineV15,
} from '../packages/core/dist/index.js';

const SCOPE = { userId: 'u1', botId: 'b1', runId: 'r1' };

function freshStore() {
  return new TemporalGraphStore(new InMemoryGraphBackend());
}

function prov(sourceText, episodeId = 'e1') {
  return {
    episodeId,
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
    ...(opts.validUntil ? { validUntil: opts.validUntil } : {}),
  });
}

// --- v15 rule predicates (new) --------------------------------------------

test('v15 rule extraction: daily_routine / goal / constraint / reads / watches / lives_with / commutes_by', () => {
  const found = (text, predicate) =>
    extractV15RuleCandidates(text).find((c) => c.predicate === predicate);
  assert.equal(found('Mỗi sáng tôi tập yoga.', 'daily_routine')?.objectText, 'tập yoga');
  assert.equal(
    found('Mục tiêu của tôi là đạt IELTS 7.5.', 'goal')?.objectText,
    'đạt IELTS 7.5',
  );
  assert.equal(found('Tôi không được ăn đường.', 'constraint')?.objectText, 'ăn đường');
  assert.equal(found('Tôi đang đọc Dune.', 'reads')?.objectText, 'Dune');
  assert.equal(found('Tôi hay xem phim Hàn Quốc.', 'watches')?.objectText, 'phim Hàn Quốc');
  assert.equal(found('Tôi sống cùng mẹ.', 'lives_with')?.objectText, 'mẹ');
  assert.equal(found('Tôi đi làm bằng xe buýt.', 'commutes_by')?.objectText, 'xe buýt');
  assert.equal(found('I usually watch Korean dramas.', 'watches')?.objectText, 'Korean dramas');
  assert.equal(found('My goal is to run a marathon.', 'goal')?.objectText, 'run a marathon');
  assert.equal(found('Tôi thích phở bò.', 'daily_routine'), undefined);
});

test('v15 rule extraction inherits v13/v14 (likes / lives_in / dislikes / prefers, no duplicates)', () => {
  const all = extractFactsV15Sync('Tôi thích phở bò. Tôi ghét đồ cay. Tôi sống ở Hà Nội.');
  const byPred = (p) => all.filter((c) => c.predicate === p);
  assert.equal(byPred('likes').length, 1);
  assert.equal(byPred('likes')[0].objectText, 'phở bò');
  assert.equal(byPred('dislikes').length, 1);
  assert.equal(byPred('dislikes')[0].objectText, 'đồ cay');
  assert.equal(byPred('lives_in').length, 1);
  assert.equal(byPred('lives_in')[0].objectText, 'Hà Nội');
  // prefers comes from v13 only — v15 must not append a second one.
  const prefers = extractFactsV15Sync('Tôi thích trà đào hơn cà phê.');
  assert.equal(prefers.filter((c) => c.predicate === 'prefers').length, 1);
  assert.equal(prefers.find((c) => c.predicate === 'prefers')?.objectText, 'trà đào');
});

test('v15 mock LLM: catches "me man" / "nghien" / "thuong day luc", rule wins on overlap', async () => {
  const llm = new V15MockLlmExtractor();
  assert.equal(llm.name, 'mock-llm-v15');
  const a = await extractFactsV15('Tôi mê mẩn nhạc jazz.', { llmExtractor: llm });
  assert.equal(a.find((c) => c.predicate === 'likes')?.objectText, 'nhạc jazz');
  assert.equal(a.find((c) => c.predicate === 'likes')?.origin, 'llm');
  const b = await extractFactsV15('Tôi nghiện cà phê.', { llmExtractor: llm });
  assert.equal(b.find((c) => c.predicate === 'likes')?.objectText, 'cà phê');
  const c = await extractFactsV15('Tôi thường dậy lúc 6 giờ sáng.', { llmExtractor: llm });
  assert.equal(c.find((c2) => c2.predicate === 'daily_routine')?.objectText, '6 giờ sáng');
  // Rule wins: "Tôi thích phở bò" is rule, LLM must not duplicate it.
  const d = await extractFactsV15('Tôi thích phở bò.', { llmExtractor: llm });
  assert.equal(d.filter((x) => x.predicate === 'likes').length, 1);
  assert.equal(d.find((x) => x.predicate === 'likes')?.origin, 'rule');
});

test('v15 single-valued predicates: prefers/lives_with/commutes_by are single-valued, likes is not', () => {
  assert.equal(isSingleValuedPredicateV15('lives_in'), true);
  assert.equal(isSingleValuedPredicateV15('prefers'), true);
  assert.equal(isSingleValuedPredicateV15('lives_with'), true);
  assert.equal(isSingleValuedPredicateV15('commutes_by'), true);
  assert.equal(isSingleValuedPredicateV15('likes'), false);
  assert.equal(isSingleValuedPredicateV15('daily_routine'), false);
});

// --- consolidation: add-only + single-pass --------------------------------

test('v15 consolidate: single-pass (llmCalls == turns), add-only, contradiction coexists', async () => {
  const store = freshStore();
  const report = await consolidateTurnsV15(
    store,
    [
      { text: 'Tôi sống ở Hà Nội.', at: '2025-01-01T00:00:00.000Z' },
      { text: 'Tôi sống ở Đà Nẵng.', at: '2026-03-01T00:00:00.000Z' },
    ],
    { llmExtractor: new V15MockLlmExtractor() },
  );
  assert.equal(report.turns, 2);
  assert.equal(report.llmCalls, 2, 'Mem0 v3: at most 1 LLM call per turn');
  assert.equal(report.appended.length, 2);
  assert.equal(report.coexisting.length, 1, 'contradiction recorded, not resolved at write-time');
  assert.equal(report.coexisting[0].existingFact.objectText, 'Hà Nội');
  // BOTH facts stay active in the store — v15 never supersedes at write-time.
  const facts = store.listFacts({ ...SCOPE, status: 'active', predicate: 'lives_in' });
  assert.equal(facts.length, 2);
  assert.ok(facts.every((f) => f.status === 'active'));
});

test('v15 consolidate: duplicate turn appends nothing; low-confidence dropped', async () => {
  const store = freshStore();
  const first = await consolidateTurnsV15(store, [{ text: 'Tôi thích phở bò.' }]);
  assert.equal(first.appended.length, 1);
  const second = await consolidateTurnsV15(store, [{ text: 'Tôi thích phở bò.' }]);
  assert.equal(second.appended.length, 0);
  assert.equal(second.duplicates.length, 1);
  assert.equal(store.listFacts({ ...SCOPE, status: 'active' }).length, 1);
});

test('v15 consolidate: retract closes the old window but keeps history', async () => {
  const store = freshStore();
  await consolidateTurnsV15(store, [{ text: 'Tôi thích phở bò.', at: '2025-01-01T00:00:00.000Z' }]);
  const report = await consolidateTurnsV15(store, [
    { text: 'Tôi không còn thích phở bò nữa.', at: '2026-05-01T00:00:00.000Z' },
  ]);
  assert.equal(report.retracted.length, 1);
  assert.equal(report.retracted[0].closedFact.validUntil, '2026-05-01T00:00:00.000Z');
  // History still answers "true at T" before the retract.
  const at2025 = factsValidAtV15(store, '2025-06-01T00:00:00.000Z', SCOPE, { predicate: 'likes' });
  assert.equal(at2025.facts.length, 1);
  const now = factsValidAtV15(store, '2026-11-16T00:00:00.000Z', SCOPE, { predicate: 'likes' });
  assert.equal(now.facts.length, 0);
});

// --- retrieval-time supersede ----------------------------------------------

test('v15 resolveCurrent: newest validFrom wins; view only, store untouched', () => {
  const store = freshStore();
  seedFact(store, 'user', 'lives_in', 'Hà Nội', { validFrom: '2023-01-01T00:00:00.000Z', confidence: 0.9 });
  seedFact(store, 'user', 'lives_in', 'Đà Nẵng', { validFrom: '2026-03-01T00:00:00.000Z', confidence: 0.85 });
  const res = resolveCurrentV15(store, 'user', 'lives_in', SCOPE, '2026-11-16T00:00:00.000Z');
  assert.equal(res.winner?.objectText, 'Đà Nẵng');
  assert.equal(res.supersededInView.length, 1);
  assert.equal(res.supersededInView[0].fact.objectText, 'Hà Nội');
  assert.match(res.supersededInView[0].reason, /Đà Nẵng/);
  // Store untouched: both still active.
  assert.equal(store.listFacts({ ...SCOPE, status: 'active', predicate: 'lives_in' }).length, 2);
  // As-of in the past: the old fact wins there.
  const past = resolveCurrentV15(store, 'user', 'lives_in', SCOPE, '2024-06-01T00:00:00.000Z');
  assert.equal(past.winner?.objectText, 'Hà Nội');
});

test('v15 resolveCurrent: tie on validFrom -> highest confidence wins', () => {
  const store = freshStore();
  seedFact(store, 'user', 'works_at', 'VNG', { validFrom: '2025-01-01T00:00:00.000Z', confidence: 0.8 });
  seedFact(store, 'user', 'works_at', 'MoMo', { validFrom: '2025-01-01T00:00:00.000Z', confidence: 0.95 });
  const res = resolveCurrentV15(store, 'user', 'works_at', SCOPE);
  assert.equal(res.winner?.objectText, 'MoMo');
});

test('v15 resolveAllCurrent: groups single-valued predicates, skips multi-valued', () => {
  const store = freshStore();
  seedFact(store, 'user', 'lives_in', 'Hà Nội', { validFrom: '2023-01-01T00:00:00.000Z' });
  seedFact(store, 'user', 'lives_in', 'Đà Nẵng', { validFrom: '2026-03-01T00:00:00.000Z' });
  seedFact(store, 'user', 'likes', 'phở bò');
  const all = resolveAllCurrentV15(store, SCOPE, '2026-11-16T00:00:00.000Z');
  assert.equal(all.length, 1, 'only lives_in is single-valued');
  assert.equal(all[0].winner?.objectText, 'Đà Nẵng');
});

// --- temporal KG v3 ---------------------------------------------------------

test('v15 temporal: bi-temporal interval + window overlap/intersection', () => {
  const store = freshStore();
  const fact = seedFact(store, 'user', 'lives_in', 'Hà Nội', {
    validFrom: '2023-01-01T00:00:00.000Z',
    validUntil: '2026-03-01T00:00:00.000Z',
  });
  const iv = intervalOfFactV15(fact);
  assert.equal(iv.validFrom, '2023-01-01T00:00:00.000Z');
  assert.equal(iv.validUntil, '2026-03-01T00:00:00.000Z');
  assert.equal(iv.txFrom, fact.createdAt);
  assert.equal(iv.txTo, null);
  assert.equal(isFactValidAtV15(fact, '2024-01-01T00:00:00.000Z'), true);
  assert.equal(isFactValidAtV15(fact, '2026-03-01T00:00:00.000Z'), false, 'validUntil is exclusive');
  assert.equal(isFactValidAtV15(fact, '2022-01-01T00:00:00.000Z'), false);
  assert.equal(
    intervalsOverlapV15(
      { validFrom: '2023-01-01T00:00:00.000Z', validUntil: '2026-03-01T00:00:00.000Z' },
      { validFrom: '2026-01-01T00:00:00.000Z', validUntil: null },
    ),
    true,
  );
  assert.equal(
    intervalsOverlapV15(
      { validFrom: '2023-01-01T00:00:00.000Z', validUntil: '2026-03-01T00:00:00.000Z' },
      { validFrom: '2026-03-01T00:00:00.000Z', validUntil: null },
    ),
    false,
    'touching windows (end == start) do not overlap',
  );
  const inter = intervalIntersectionV15(
    { validFrom: '2023-01-01T00:00:00.000Z', validUntil: '2026-03-01T00:00:00.000Z' },
    { validFrom: '2026-01-01T00:00:00.000Z', validUntil: null },
  );
  assert.equal(inter?.validFrom, '2026-01-01T00:00:00.000Z');
  assert.equal(inter?.validUntil, '2026-03-01T00:00:00.000Z');
  assert.equal(
    intervalIntersectionV15(
      { validFrom: '2023-01-01T00:00:00.000Z', validUntil: '2024-01-01T00:00:00.000Z' },
      { validFrom: '2025-01-01T00:00:00.000Z', validUntil: null },
    ),
    null,
  );
});

test('v15 temporal: factsValidAtV15 answers history; time-travel excludes not-yet-known', () => {
  const store = freshStore();
  seedFact(store, 'user', 'lives_in', 'Hà Nội', {
    validFrom: '2023-01-01T00:00:00.000Z',
    validUntil: '2026-03-01T00:00:00.000Z',
  });
  seedFact(store, 'user', 'lives_in', 'Đà Nẵng', { validFrom: '2026-03-01T00:00:00.000Z' });
  const at2024 = factsValidAtV15(store, '2024-06-01T00:00:00.000Z', SCOPE, { predicate: 'lives_in' });
  assert.deepEqual(at2024.facts.map((f) => f.fact.objectText), ['Hà Nội']);
  const at2026 = factsValidAtV15(store, '2026-06-01T00:00:00.000Z', SCOPE, { predicate: 'lives_in' });
  assert.deepEqual(at2026.facts.map((f) => f.fact.objectText), ['Đà Nẵng']);
  // Time-travel: facts were created NOW (wall clock) — txAt in 2020 knows nothing.
  const past = timeTravelQueryV15(store, SCOPE, {
    validAt: '2024-06-01T00:00:00.000Z',
    txAt: '2020-01-01T00:00:00.000Z',
  });
  assert.equal(past.facts.length, 0);
  assert.equal(past.excludedNotYetKnown, 2);
  // "now" = wall clock at run time: facts were created just now, so the
  // system knows them. (Was a hardcoded '2026-11-17' — a time bomb: the
  // test started failing the day the wall clock moved past that date,
  // because createdAt > txAt excludes the facts as not-yet-known.)
  const now = timeTravelQueryV15(store, SCOPE, {
    validAt: '2024-06-01T00:00:00.000Z',
    txAt: new Date().toISOString(),
  });
  assert.deepEqual(now.facts.map((f) => f.fact.objectText), ['Hà Nội']);
  assert.equal(now.excludedNotYetKnown, 0);
  assert.throws(() => factsValidAtV15(store, 'not-a-date', SCOPE), /ngay ISO hop le/);
  assert.throws(
    () => timeTravelQueryV15(store, SCOPE, { validAt: 'not-a-date' }),
    /validAt khong phai/,
  );
});

test('v15 temporal: contradictions only for overlapping single-valued pairs', () => {
  const store = freshStore();
  // Overlapping lives_in, different objects -> contradiction.
  seedFact(store, 'user', 'lives_in', 'Hà Nội', {
    validFrom: '2023-01-01T00:00:00.000Z',
    validUntil: null,
    confidence: 0.9,
  });
  seedFact(store, 'user', 'lives_in', 'Đà Nẵng', {
    validFrom: '2026-03-01T00:00:00.000Z',
    validUntil: null,
    confidence: 0.95,
  });
  // Sequential (non-overlapping) works_at -> no contradiction.
  seedFact(store, 'user', 'works_at', 'VNG', {
    validFrom: '2020-01-01T00:00:00.000Z',
    validUntil: '2025-12-01T00:00:00.000Z',
  });
  seedFact(store, 'user', 'works_at', 'MoMo', { validFrom: '2025-12-01T00:00:00.000Z' });
  // Multi-valued likes, same window -> never a contradiction.
  seedFact(store, 'user', 'likes', 'phở bò');
  seedFact(store, 'user', 'likes', 'bún chả');
  const scan = findContradictionsV15(store, SCOPE);
  assert.equal(scan.contradictions.length, 1);
  assert.equal(scan.contradictions[0].predicate, 'lives_in');
  assert.equal(scan.contradictions[0].overlap.validFrom, '2026-03-01T00:00:00.000Z');
  assert.equal(scan.contradictions[0].overlap.validUntil, null);
  const loser = loserOfContradictionV15(scan.contradictions[0]);
  assert.equal(loser.loser.objectText, 'Hà Nội', 'lower confidence loses');
  assert.equal(loser.winner.objectText, 'Đà Nẵng');
});

test('v15 temporal: invalidate keeps history (true before invalidAt, false after)', () => {
  const store = freshStore();
  const hanoi = seedFact(store, 'user', 'lives_in', 'Hà Nội', {
    validFrom: '2023-01-01T00:00:00.000Z',
    validUntil: null,
    confidence: 0.9,
  });
  const danang = seedFact(store, 'user', 'lives_in', 'Đà Nẵng', {
    validFrom: '2026-03-01T00:00:00.000Z',
    validUntil: null,
    confidence: 0.95,
  });
  const invalidated = invalidateFactV15(store, hanoi.id, danang.id, {
    at: '2026-03-01T00:00:00.000Z',
    actor: 'user',
  });
  assert.equal(invalidated.invalidAt, '2026-03-01T00:00:00.000Z');
  assert.equal(invalidated.invalidatedBy, 'user');
  assert.match(invalidated.invalidationReason ?? '', /Mau thuan/);
  assert.equal(invalidated.validUntil, '2026-03-01T00:00:00.000Z');
  // Still true before invalidAt, false after — history kept, not deleted.
  assert.equal(isFactValidAtV15(store.getFact(hanoi.id), '2024-06-01T00:00:00.000Z'), true);
  assert.equal(isFactValidAtV15(store.getFact(hanoi.id), '2026-06-01T00:00:00.000Z'), false);
  assert.equal(store.getFact(hanoi.id)?.status, 'active', 'invalidate does not delete or supersede');
});

test('v15 temporal: scanAndInvalidate resolves all contradictions at once', () => {
  const store = freshStore();
  seedFact(store, 'user', 'lives_in', 'Hà Nội', {
    validFrom: '2023-01-01T00:00:00.000Z',
    validUntil: null,
    confidence: 0.9,
  });
  seedFact(store, 'user', 'lives_in', 'Đà Nẵng', {
    validFrom: '2026-03-01T00:00:00.000Z',
    validUntil: null,
    confidence: 0.95,
  });
  seedFact(store, 'user', 'works_at', 'VNG', {
    validFrom: '2020-01-01T00:00:00.000Z',
    validUntil: null,
    confidence: 0.8,
  });
  seedFact(store, 'user', 'works_at', 'MoMo', {
    validFrom: '2025-01-01T00:00:00.000Z',
    validUntil: null,
    confidence: 0.9,
  });
  const result = scanAndInvalidateContradictionsV15(store, SCOPE, {
    at: '2026-03-01T00:00:00.000Z',
    actor: 'system',
  });
  assert.equal(result.scanned.contradictions.length, 2);
  assert.equal(result.resolved.length, 2);
  assert.deepEqual(
    result.resolved.map((r) => r.invalidated.objectText).sort(),
    ['Hà Nội', 'VNG'],
  );
  assert.equal(result.skippedAlreadyInvalid, 0);
  // Second run: nothing left to invalidate (already invalid, scan skips them).
  const again = scanAndInvalidateContradictionsV15(store, SCOPE, {
    at: '2026-03-01T00:00:00.000Z',
  });
  assert.equal(again.resolved.length, 0);
  assert.equal(again.scanned.contradictions.length, 0);
  assert.equal(findContradictionsV15(store, SCOPE).contradictions.length, 0);
});

test('v15 temporal: timeline orders versions + format shows invalidated flag', () => {
  const store = freshStore();
  const hanoi = seedFact(store, 'user', 'lives_in', 'Hà Nội', {
    validFrom: '2023-01-01T00:00:00.000Z',
    validUntil: '2026-03-01T00:00:00.000Z',
  });
  seedFact(store, 'user', 'lives_in', 'Đà Nẵng', { validFrom: '2026-03-01T00:00:00.000Z' });
  invalidateFactV15(store, hanoi.id, 'other', { at: '2024-01-01T00:00:00.000Z', actor: 'user' });
  const steps = factTimelineV15(store, 'user', 'lives_in', SCOPE);
  assert.equal(steps.length, 2);
  assert.equal(steps[0].objectText, 'Hà Nội');
  assert.equal(steps[0].invalidated, true);
  assert.equal(steps[1].objectText, 'Đà Nẵng');
  assert.equal(steps[1].invalidated, false);
  const text = formatTimelineV15(steps, 'user', 'lives_in');
  assert.match(text, /Hà Nội/);
  assert.match(text, /Đà Nẵng/);
  assert.match(text, /INVALIDATED/);
  assert.equal(formatTimelineV15([], 'user', 'lives_in'), 'Khong co lich su cho (user, lives_in).');
});
