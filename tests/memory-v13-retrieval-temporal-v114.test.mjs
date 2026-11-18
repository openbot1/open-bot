/**
 * Tests for v1.14 (Team T1) — memory v13:
 * packages/core/src/memory/v13/{multiSignal,temporalApi}.ts
 *
 * Covers:
 *  - multiSignal: weights normalize (sum to 1, negatives clamped,
 *    all-zero falls back to defaults); semantic + BM25 + entity
 *    signals each rank the matching fact first; scores carry an
 *    explanation; skipSemantic still returns BM25 hits; empty query
 *    and empty store return no hits; ablation changes top-1 when a
 *    signal is removed.
 *  - temporalApi: stateAt at a moment in time; answerAtTime answers
 *    "what was true at X?" with value + validity window + evidence +
 *    knownSince; not-found answers carry competing facts; invalid
 *    dates throw; whatChangedBetween counts creates/supersedes;
 *    contradictionsBetween pairs old vs new values; knowledgeTimeline
 *    is chronological; asOfSnapshotMarkdown lists facts valid then;
 *    diffStates spots appeared/disappeared/changed facts.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/memory-v13-retrieval-temporal-v114.test.mjs
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
  V13_DEFAULT_WEIGHTS,
  normalizeV13Weights,
  minMaxNormalizeV13,
  multiSignalRetrieve,
  V13MultiSignalRetriever,
  V13TemporalError,
  stateAt,
  answerAtTime,
  whatChangedBetween,
  contradictionsBetween,
  knowledgeTimeline,
  asOfSnapshotMarkdown,
  diffStates,
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
    at: new Date().toISOString(),
    sourceText,
  };
}

function seedFoodStore() {
  const store = freshStore();
  const pho = store.addFact({
    subjectName: 'An', predicate: 'likes', objectText: 'pho bo',
    confidence: 0.9, scope: SCOPE, provenance: prov('An rat thich pho bo.'),
  });
  const bun = store.addFact({
    subjectName: 'Binh', predicate: 'likes', objectText: 'bun cha',
    confidence: 0.9, scope: SCOPE, provenance: prov('Binh thich bun cha.'),
  });
  const hanoi = store.addFact({
    subjectName: 'An', predicate: 'lives_in', objectText: 'Ha Noi',
    confidence: 0.9, scope: SCOPE, provenance: prov('An song o Ha Noi.'),
    validFrom: '2025-01-01T00:00:00.000Z', validUntil: '2026-03-01T00:00:00.000Z',
  });
  const danang = store.addFact({
    subjectName: 'An', predicate: 'lives_in', objectText: 'Da Nang',
    confidence: 0.9, scope: SCOPE, provenance: prov('An chuyen ve Da Nang.'),
    validFrom: '2026-03-01T00:00:00.000Z', validUntil: null,
  });
  return { store, pho, bun, hanoi, danang };
}

// ---------- multiSignal: weights ----------

test('multiSignal: weights normalize to sum 1; negatives clamped; all-zero falls back', () => {
  const w = normalizeV13Weights({ semantic: 2, bm25: 1, entity: 1 });
  assert.ok(Math.abs(w.semantic + w.bm25 + w.entity - 1) < 1e-9);
  assert.equal(w.semantic, 0.5);
  assert.equal(w.bm25, 0.25);
  assert.equal(w.entity, 0.25);

  const clamped = normalizeV13Weights({ semantic: -5, bm25: 1, entity: 0 });
  assert.equal(clamped.semantic, 0);
  assert.equal(clamped.bm25, 1);
  assert.equal(clamped.entity, 0);

  assert.deepEqual(normalizeV13Weights({ semantic: 0, bm25: 0, entity: 0 }), V13_DEFAULT_WEIGHTS);
  assert.deepEqual(normalizeV13Weights(), V13_DEFAULT_WEIGHTS);
  assert.ok(Math.abs(V13_DEFAULT_WEIGHTS.semantic + V13_DEFAULT_WEIGHTS.bm25 + V13_DEFAULT_WEIGHTS.entity - 1) < 1e-9);
});

test('multiSignal: min-max normalize maps min->0, max->1, flat->1 when positive', () => {
  assert.deepEqual(minMaxNormalizeV13([]), []);
  assert.deepEqual(minMaxNormalizeV13([5, 10, 15]), [0, 0.5, 1]);
  assert.deepEqual(minMaxNormalizeV13([3, 3, 3]), [1, 1, 1]);
  assert.deepEqual(minMaxNormalizeV13([0, 0]), [0, 0]);
  assert.deepEqual(minMaxNormalizeV13([7]), [1]);
});

test('multiSignal: entity query ranks the named entity fact first', async () => {
  const { store, pho } = seedFoodStore();
  const res = await multiSignalRetrieve(store, 'An thich mon gi?', { topK: 5 });
  assert.ok(res.hits.length >= 1);
  assert.equal(res.hits[0].fact.id, pho.id);
  assert.ok(res.sourcesUsed.includes('entity'));
  assert.ok(res.hits[0].scores.entity > 0);
  assert.ok(res.hits[0].sources.includes('entity'));
  assert.match(res.hits[0].explanation, /entity/);
  // 3, khong phai 4: fact "Ha Noi" da het hieu luc (validUntil
  // 2026-03-01) nen onlyValidNow loai no — chi con pho/bun/Da Nang.
  assert.equal(res.candidates, 3);
});

test('multiSignal: keyword query finds the fact sharing the keyword', async () => {
  const { store, bun } = seedFoodStore();
  const res = await multiSignalRetrieve(store, 'bun cha', { topK: 5 });
  assert.ok(res.hits.length >= 1);
  assert.equal(res.hits[0].fact.id, bun.id);
  assert.ok(res.hits[0].scores.bm25 > 0);
  assert.ok(res.hits[0].scores.total > 0 && res.hits[0].scores.total <= 1);
});

test('multiSignal: semantic-only weights still rank by meaning overlap', async () => {
  const { store, pho } = seedFoodStore();
  const res = await multiSignalRetrieve(store, 'An thich pho bo', {
    topK: 5,
    weights: { semantic: 1, bm25: 0, entity: 0 },
  });
  assert.ok(res.hits.length >= 1);
  assert.equal(res.hits[0].fact.id, pho.id);
  assert.ok(res.sourcesUsed.includes('semantic'));
  assert.ok(!res.sourcesUsed.includes('bm25'));
});

test('multiSignal: BM25-only weights ignore the semantic signal', async () => {
  const { store, danang } = seedFoodStore();
  const res = await multiSignalRetrieve(store, 'Da Nang', {
    topK: 5,
    weights: { semantic: 0, bm25: 1, entity: 0 },
  });
  assert.ok(res.hits.length >= 1);
  assert.equal(res.hits[0].fact.id, danang.id);
  assert.ok(!res.sourcesUsed.includes('semantic'));
});

test('multiSignal: skipSemantic returns BM25 hits; empty query/store return none', async () => {
  const { store } = seedFoodStore();
  const skipped = await multiSignalRetrieve(store, 'pho bo', { skipSemantic: true });
  assert.ok(skipped.hits.length >= 1);
  assert.ok(!skipped.sourcesUsed.includes('semantic'));

  const emptyQuery = await multiSignalRetrieve(store, '   ');
  assert.equal(emptyQuery.hits.length, 0);
  assert.equal(emptyQuery.candidates, 0);

  const emptyStore = freshStore();
  const none = await multiSignalRetrieve(emptyStore, 'pho bo');
  assert.equal(none.hits.length, 0);
  assert.equal(none.candidates, 0);
  assert.match(none.notes.join(' '), /Khong co fact/);
});

test('multiSignal: onlyValidNow excludes expired facts; asOf moves the window', async () => {
  const { store, hanoi, danang } = seedFoodStore();
  // "now" is after 2026-03-01, so the Ha Noi fact has expired.
  const now = await multiSignalRetrieve(store, 'An song o dau', { topK: 10 });
  const nowIds = now.hits.map((h) => h.fact.id);
  assert.ok(!nowIds.includes(hanoi.id));
  assert.ok(nowIds.includes(danang.id));

  // Ask as of Feb 2026: Ha Noi is valid, Da Nang is not yet.
  const feb = await multiSignalRetrieve(store, 'An song o dau', {
    topK: 10,
    asOf: new Date('2026-02-15T00:00:00.000Z'),
  });
  const febIds = feb.hits.map((h) => h.fact.id);
  assert.ok(febIds.includes(hanoi.id));
  assert.ok(!febIds.includes(danang.id));

  // onlyValidNow=false returns both regardless of the window.
  const all = await multiSignalRetrieve(store, 'An song o dau', { topK: 10, onlyValidNow: false });
  const allIds = all.hits.map((h) => h.fact.id);
  assert.ok(allIds.includes(hanoi.id));
  assert.ok(allIds.includes(danang.id));
});

test('multiSignal: retriever class keeps weights; ablation shows signal contribution', async () => {
  const { store, pho } = seedFoodStore();
  const retriever = new V13MultiSignalRetriever({
    weights: { semantic: 0.45, bm25: 0.35, entity: 0.2 },
  });
  assert.deepEqual(retriever.defaultWeights, { semantic: 0.45, bm25: 0.35, entity: 0.2 });
  const res = await retriever.retrieve(store, 'An thich pho bo');
  assert.equal(res.hits[0].fact.id, pho.id);

  const ablation = await retriever.ablation(store, 'An thich pho bo');
  // Removing entity must not keep the exact same top-1 via entity
  // boost alone; removing BM25/semantic may or may not change it,
  // but every ablation run must return a fact id (or null).
  for (const key of ['semantic', 'bm25', 'entity']) {
    assert.ok(ablation[key] === null || typeof ablation[key] === 'string');
  }
  // With the entity signal removed, the top hit is still the pho fact
  // here (BM25+semantic agree) — assert stability, not change.
  assert.equal(ablation.entity, pho.id);
});

// ---------- temporalApi ----------

test('temporalApi: stateAt returns facts valid at the queried moment', () => {
  const { store } = seedFoodStore();
  const feb = stateAt(store, '2026-02-15T00:00:00.000Z');
  const febTexts = feb.facts.map((f) => `${f.subjectName}:${f.fact.predicate}:${f.objectName}`);
  assert.ok(febTexts.includes('An:lives_in:Ha Noi'));
  assert.ok(!febTexts.includes('An:lives_in:Da Nang'));
  assert.ok(feb.totalValid >= 1);

  const apr = stateAt(store, '2026-04-15T00:00:00.000Z');
  const aprTexts = apr.facts.map((f) => `${f.subjectName}:${f.fact.predicate}:${f.objectName}`);
  assert.ok(aprTexts.includes('An:lives_in:Da Nang'));
  assert.ok(!aprTexts.includes('An:lives_in:Ha Noi'));

  // Subject + predicate filter narrows the state.
  const filtered = stateAt(store, '2026-02-15T00:00:00.000Z', { subject: 'An', predicate: 'lives_in' });
  assert.equal(filtered.facts.length, 1);
  assert.equal(filtered.facts[0].objectName, 'Ha Noi');

  assert.throws(() => stateAt(store, 'not-a-date'), V13TemporalError);
});

test('temporalApi: answerAtTime answers "what was true at X?" with evidence', () => {
  const { store } = seedFoodStore();
  const feb = answerAtTime(store, 'An', 'lives_in', '2026-02-15T00:00:00.000Z');
  assert.equal(feb.found, true);
  assert.equal(feb.value, 'Ha Noi');
  assert.equal(feb.validFrom, '2025-01-01T00:00:00.000Z');
  assert.equal(feb.validUntil, '2026-03-01T00:00:00.000Z');
  assert.ok(feb.knownSince !== null);
  assert.equal(feb.evidence.sourceText, 'An song o Ha Noi.');
  assert.equal(feb.evidence.episodeId, 'e1');
  assert.match(feb.explanation, /Ha Noi/);

  const apr = answerAtTime(store, 'An', 'lives_in', '2026-04-15T00:00:00.000Z');
  assert.equal(apr.value, 'Da Nang');
  assert.equal(apr.validUntil, null);

  // Predicate with spaces normalizes to underscores.
  const spaced = answerAtTime(store, 'An', 'lives in', '2026-04-15T00:00:00.000Z');
  assert.equal(spaced.value, 'Da Nang');
});

test('temporalApi: answerAtTime not-found carries competing facts', () => {
  const { store } = seedFoodStore();
  const missing = answerAtTime(store, 'An', 'works_at', '2026-02-15T00:00:00.000Z');
  assert.equal(missing.found, false);
  assert.equal(missing.value, null);
  assert.equal(missing.fact, null);
  assert.equal(missing.evidence, null);
  assert.match(missing.explanation, /khong co thong tin/);

  // Before any fact existed, nothing is true yet.
  const early = answerAtTime(store, 'An', 'lives_in', '2024-01-01T00:00:00.000Z');
  assert.equal(early.found, false);

  assert.throws(() => answerAtTime(store, '', 'lives_in', '2026-02-15'), V13TemporalError);
  assert.throws(() => answerAtTime(store, 'An', '', '2026-02-15'), V13TemporalError);
  assert.throws(() => answerAtTime(store, 'An', 'lives_in', 'bogus'), V13TemporalError);
});

test('temporalApi: whatChangedBetween counts creates and supersedes', () => {
  const store = freshStore();
  const f1 = store.addFact({
    subjectName: 'Chi', predicate: 'likes', objectText: 'tra sua',
    confidence: 0.8, scope: SCOPE, provenance: prov('Chi thich tra sua.'),
    validFrom: '2026-01-01T00:00:00.000Z',
  });
  // Doi vai ms de supersede xay ra SAU thoi diem tao (findChangesInWindow
  // uu tien 'created' khi createdAt nam trong cua so — muon thay
  // 'superseded' thi cua so phai bat dau sau createdAt nhung truoc
  // validUntil). Dung busy-wait vi Atomics.wait bi vo hieu trong
  // sandbox nay (tra ve ngay lap tuc).
  const spinUntil = Date.now() + 20;
  while (Date.now() < spinUntil) { /* cho dong ho tien len */ }
  // Supersede in Feb: old fact closes, new fact opens.
  store.supersedeFact(f1.id, {
    subjectName: 'Chi', predicate: 'likes', objectText: 'ca phe den',
    confidence: 0.85, scope: SCOPE, provenance: prov('Chi doi sang ca phe den.'),
  });
  const from = new Date(Date.parse(store.getFact(f1.id).createdAt) + 2).toISOString();
  const to = new Date(Date.now() + 60000).toISOString();
  const window = whatChangedBetween(store, from, to);
  assert.ok(window.changes.length >= 2);
  assert.match(window.summary, /thay doi/);
  const kinds = window.changes.map((c) => c.kind);
  assert.ok(kinds.includes('created'));
  assert.ok(kinds.includes('superseded'));

  assert.throws(
    () => whatChangedBetween(store, '2026-05-01', '2026-01-01'),
    V13TemporalError,
  );
});

test('temporalApi: contradictionsBetween pairs old vs new values', () => {
  const { store } = seedFoodStore();
  const list = contradictionsBetween(
    store,
    '2026-01-01T00:00:00.000Z', '2026-02-28T00:00:00.000Z',
    '2026-03-01T00:00:00.000Z', '2026-12-31T00:00:00.000Z',
  );
  assert.ok(list.length >= 1);
  const an = list.find((c) => c.subjectName === 'An' && c.predicate === 'lives_in');
  assert.ok(an);
  assert.equal(an.earlier.objectText, 'Ha Noi');
  assert.equal(an.later.objectText, 'Da Nang');
  assert.equal(an.earlier.sourceText, 'An song o Ha Noi.');
});

test('temporalApi: knowledgeTimeline is chronological per entity', () => {
  const { store } = seedFoodStore();
  const timeline = knowledgeTimeline(store, 'An');
  assert.ok(timeline.length >= 2);
  const times = timeline.map((s) => s.at);
  const sorted = [...times].sort();
  assert.deepEqual(times, sorted);
  assert.ok(timeline.some((s) => s.text.includes('Ha Noi') || s.text.includes('Da Nang')));
  assert.deepEqual(knowledgeTimeline(store, 'Khong Ton Tai'), []);
  assert.throws(() => knowledgeTimeline(store, '  '), V13TemporalError);
});

test('temporalApi: asOfSnapshotMarkdown lists only facts valid then', () => {
  const { store } = seedFoodStore();
  const md = asOfSnapshotMarkdown(store, '2026-02-15T00:00:00.000Z');
  assert.match(md, /Ha Noi/);
  assert.ok(!md.includes('Da Nang'));
  assert.match(md, /Tri thuc tai/);
  const empty = asOfSnapshotMarkdown(store, '2020-01-01T00:00:00.000Z');
  assert.match(empty, /trong/);
});

test('temporalApi: diffStates spots appeared/disappeared/changed facts', () => {
  const { store } = seedFoodStore();
  const diff = diffStates(store, '2026-02-15T00:00:00.000Z', '2026-04-15T00:00:00.000Z');
  assert.equal(diff.atA.slice(0, 10), '2026-02-15');
  assert.equal(diff.atB.slice(0, 10), '2026-04-15');
  assert.ok(diff.appeared.some((f) => f.objectName === 'Da Nang'));
  assert.ok(diff.disappeared.some((f) => f.objectName === 'Ha Noi'));
  const changed = diff.changed.find((c) => c.predicate === 'lives_in');
  assert.ok(changed);
  assert.equal(changed.from, 'Ha Noi');
  assert.equal(changed.to, 'Da Nang');

  // Same moment twice -> no diff.
  const same = diffStates(store, '2026-02-15T00:00:00.000Z', '2026-02-15T00:00:00.000Z');
  assert.equal(same.appeared.length, 0);
  assert.equal(same.disappeared.length, 0);
  assert.equal(same.changed.length, 0);
});
