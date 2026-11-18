/**
 * Tests for v1.19 (Team T1-TEST, wave 4) — memory v18 hybrid retrieval v2:
 * packages/core/src/memory/v18/hybridRetrievalV2.ts
 *
 * Covers:
 *  - normalizeWeightsV18 (sums to 1, negatives clamped, all-zero
 *    falls back to defaults, input not mutated).
 *  - clamp01V18Hybrid + minMaxNormalizeV18 (empty / all-zero).
 *  - entityScoreForFactV18 (name match, alias, no entity -> 0).
 *  - retrieveFromFactsV18 (empty query / empty pool, topK,
 *    minScore, predicate filter, activeOnly, semantic embed path).
 *  - retrieveV18 on a real store (BM25 top hit, explainHitV18).
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/memory-v18-hybrid-v119.test.mjs
 *
 * No network. No model.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  TemporalGraphStore,
  InMemoryGraphBackend,
  retrieveV18,
  retrieveFromFactsV18,
  entityScoreForFactV18,
  normalizeWeightsV18,
  clamp01V18Hybrid,
  minMaxNormalizeV18,
  explainHitV18,
  V18HybridError,
  V18_DEFAULT_HYBRID_WEIGHTS,
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
  });
}

function seedStore() {
  const store = freshStore();
  seedFact(store, 'An', 'lives_in', 'Hà Nội');
  seedFact(store, 'An', 'works_at', 'VNG');
  seedFact(store, 'Binh', 'lives_in', 'Đà Nẵng');
  return store;
}

test('v18 hybrid: default weights sum to 1 (semantic 0.5 / BM25 0.3 / entity 0.2)', () => {
  assert.deepEqual(V18_DEFAULT_HYBRID_WEIGHTS, { semantic: 0.5, bm25: 0.3, entity: 0.2 });
  const total = normalizeWeightsV18();
  assert.ok(Math.abs(total.semantic + total.bm25 + total.entity - 1) < 1e-9);
  assert.deepEqual(total, V18_DEFAULT_HYBRID_WEIGHTS);
});

test('v18 hybrid: normalizeWeightsV18 normalizes + clamps + falls back', () => {
  const w = normalizeWeightsV18({ semantic: 2, bm25: 1, entity: 1 });
  assert.deepEqual(w, { semantic: 0.5, bm25: 0.25, entity: 0.25 });
  const neg = normalizeWeightsV18({ semantic: -5, bm25: 1, entity: 0 });
  assert.equal(neg.semantic, 0);
  assert.ok(Math.abs(neg.bm25 - 1) < 1e-9);
  assert.deepEqual(normalizeWeightsV18({ semantic: 0, bm25: 0, entity: 0 }), V18_DEFAULT_HYBRID_WEIGHTS);
  const input = { semantic: 2, bm25: 1, entity: 1 };
  normalizeWeightsV18(input);
  assert.deepEqual(input, { semantic: 2, bm25: 1, entity: 1 }, 'input not mutated');
});

test('v18 hybrid: clamp01V18Hybrid + minMaxNormalizeV18', () => {
  assert.equal(clamp01V18Hybrid(-0.5), 0);
  assert.equal(clamp01V18Hybrid(1.5), 1);
  assert.equal(clamp01V18Hybrid(Number.NaN), 0);
  assert.deepEqual(minMaxNormalizeV18([]), []);
  assert.deepEqual(minMaxNormalizeV18([0, 0, 0]), [0, 0, 0]);
  assert.deepEqual(minMaxNormalizeV18([2, 4]), [0.5, 1]);
});

test('v18 hybrid: V18HybridError carries its name', () => {
  const err = new V18HybridError('boom');
  assert.equal(err.name, 'V18HybridError');
  assert.ok(err instanceof Error);
});

test('v18 hybrid: retrieveV18 ranks the BM25 match first', () => {
  const store = seedStore();
  const hits = retrieveV18(store, 'An sống ở Hà Nội', SCOPE);
  assert.ok(hits.length >= 1);
  assert.equal(hits[0].fact.objectText, 'Hà Nội');
  assert.equal(hits[0].topSignal, 'bm25');
  assert.ok(hits[0].score > 0 && hits[0].score <= 1);
  assert.ok(hits[0].signals.bm25 >= hits[0].signals.semantic);
  for (let i = 1; i < hits.length; i += 1) {
    assert.ok(hits[i - 1].score >= hits[i].score, 'sorted by score desc');
  }
});

test('v18 hybrid: explainHitV18 names the leading signal', () => {
  const store = seedStore();
  const hits = retrieveV18(store, 'An sống ở Hà Nội', SCOPE);
  const text = explainHitV18(hits[0]);
  assert.match(text, /diem 0\.\d\d/);
  assert.match(text, /dan dau: bm25/);
  assert.match(text, /semantic 0\.00, BM25 1\.00, entity 1\.00/);
});

test('v18 hybrid: empty query / empty store return []', () => {
  const store = seedStore();
  assert.deepEqual(retrieveV18(store, '   ', SCOPE), []);
  assert.deepEqual(retrieveV18(freshStore(), 'An sống ở Hà Nội', SCOPE), []);
  assert.deepEqual(retrieveFromFactsV18('An', [], () => undefined), []);
});

test('v18 hybrid: topK + minScore limit results', () => {
  const store = seedStore();
  assert.equal(retrieveV18(store, 'An', SCOPE, { topK: 1 }).length, 1);
  assert.equal(retrieveV18(store, 'An sống ở Hà Nội', SCOPE, { minScore: 0.99 }).length, 0);
  const hits = retrieveV18(store, 'An', SCOPE, { topK: 10 });
  assert.ok(hits.length >= 2, 'both An facts match the name query');
});

test('v18 hybrid: predicate filter narrows to one predicate', () => {
  const store = seedStore();
  const hits = retrieveV18(store, 'An', SCOPE, { predicate: 'works_at' });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].fact.objectText, 'VNG');
  assert.equal(retrieveV18(store, 'An', SCOPE, { predicate: 'no_such_pred' }).length, 0);
});

test('v18 hybrid: activeOnly excludes superseded facts', () => {
  const store = seedStore();
  const old = seedFact(store, 'An', 'lives_in', 'Hồ Chí Minh');
  store.supersedeFact(old.id, {
    subjectName: 'An',
    predicate: 'lives_in',
    objectText: 'Hà Nội',
    confidence: 0.9,
    scope: SCOPE,
    provenance: prov('An lives_in Hà Nội.'),
    validFrom: '2026-01-01T00:00:00.000Z',
  });
  const activeOnly = retrieveV18(store, 'Hồ Chí Minh', SCOPE, { activeOnly: true });
  assert.ok(activeOnly.every((h) => h.fact.id !== old.id), 'superseded fact excluded');
  const withHistory = retrieveV18(store, 'Hồ Chí Minh', SCOPE, { activeOnly: false });
  assert.ok(withHistory.some((h) => h.fact.id === old.id), 'history finds the old fact');
});

test('v18 hybrid: embed path lifts the semantic signal', () => {
  const store = seedStore();
  const facts = store.listFacts(SCOPE);
  const byId = new Map(facts.map((f) => [f.id, store.getEntity(f.subjectId)]));
  const entityById = (id) => store.getEntity(id);
  void byId;
  // Query embedding identical to the Hà Nội fact embedding -> cosine 1.
  const hn = facts.find((f) => f.objectText === 'Hà Nội');
  hn.embedding = [1, 0, 0];
  const vng = facts.find((f) => f.objectText === 'VNG');
  vng.embedding = [0, 1, 0];
  const hits = retrieveFromFactsV18('An sống ở Hà Nội', facts, entityById, {
    embed: () => [1, 0, 0],
    weights: { semantic: 1, bm25: 0, entity: 0 },
  });
  assert.ok(hits.length >= 1);
  assert.equal(hits[0].fact.objectText, 'Hà Nội');
  assert.equal(hits[0].signals.semantic, 1);
  assert.equal(hits[0].topSignal, 'semantic');
});

test('v18 hybrid: entityScoreForFactV18 matches name tokens, 0 without entities', () => {
  const store = seedStore();
  const facts = store.listFacts(SCOPE);
  const hn = facts.find((f) => f.objectText === 'Hà Nội');
  const entityById = (id) => store.getEntity(id);
  assert.equal(entityScoreForFactV18('An sống ở đâu', hn, entityById), 1);
  assert.equal(entityScoreForFactV18('', hn, entityById), 0);
  assert.equal(entityScoreForFactV18('An', hn, () => undefined), 0);
});
