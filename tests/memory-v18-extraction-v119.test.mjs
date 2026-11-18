/**
 * Tests for v1.19 (Team T1-TEST, wave 4) — memory v18 extraction v2:
 * packages/core/src/memory/v18/extractionV2.ts
 *
 * Covers:
 *  - detectSubjectV18 (VI + EN identity patterns, empty input).
 *  - clamp01V18 (bounds, NaN).
 *  - dedupeCandidatesV18 (same subject+predicate+object merges,
 *    keeps highest confidence, merges patterns).
 *  - extractV18 (v15 candidates upgraded: identity subject,
 *    userDisplayName fallback, sourceTrust scaling, provenance).
 *  - extractAndWriteV18 (writes above minConfidence, skips below
 *    with a reason, reports factIds).
 *  - extractEpisodeV18 (extracts from a stored episode, marks it
 *    processed; null for an unknown episode).
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/memory-v18-extraction-v119.test.mjs
 *
 * No network. No model.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  TemporalGraphStore,
  InMemoryGraphBackend,
  extractV18,
  extractAndWriteV18,
  extractEpisodeV18,
  detectSubjectV18,
  clamp01V18,
  dedupeCandidatesV18,
  V18ExtractionError,
  V18_DEFAULT_MIN_CONFIDENCE,
} from '../packages/core/dist/index.js';

const SCOPE = { userId: 'u1', botId: 'b1', runId: 'r1' };

function freshStore() {
  return new TemporalGraphStore(new InMemoryGraphBackend());
}

test('v18 extraction: detectSubjectV18 finds VI + EN identity names', () => {
  assert.equal(detectSubjectV18('Tôi tên là An, tôi thích phở bò.'), 'An');
  assert.equal(detectSubjectV18('My name is Binh and I like coffee.'), 'Binh');
  assert.equal(detectSubjectV18("I'm Chi, I live in Hanoi."), 'Chi');
  assert.equal(detectSubjectV18('Tôi là Dũng.'), 'Dũng');
  assert.equal(detectSubjectV18('Tôi thích phở bò.'), '');
  assert.equal(detectSubjectV18(''), '');
  assert.equal(detectSubjectV18('   '), '');
});

test('v18 extraction: clamp01V18 bounds + NaN', () => {
  assert.equal(clamp01V18(-1), 0);
  assert.equal(clamp01V18(2), 1);
  assert.equal(clamp01V18(0.5), 0.5);
  assert.equal(clamp01V18(Number.NaN), 0);
  assert.equal(clamp01V18(Number.POSITIVE_INFINITY), 0);
});

test('v18 extraction: V18ExtractionError carries its name', () => {
  const err = new V18ExtractionError('boom');
  assert.equal(err.name, 'V18ExtractionError');
  assert.ok(err instanceof Error);
  assert.equal(V18_DEFAULT_MIN_CONFIDENCE, 0.5);
});

test('v18 extraction: extractV18 returns [] for empty text', () => {
  const store = freshStore();
  assert.deepEqual(extractV18(store, { text: '' }), []);
  assert.deepEqual(extractV18(store, { text: '   ' }), []);
});

test('v18 extraction: identity subject + likes fact + provenance', () => {
  const store = freshStore();
  const facts = extractV18(store, {
    text: 'Tôi tên là An. Tôi thích phở bò.',
    episodeId: 'e1',
    turnId: 't1',
    runId: 'r1',
    botId: 'b1',
    userId: 'u1',
  });
  assert.equal(facts.length, 1);
  const [fact] = facts;
  assert.equal(fact.subjectName, 'An');
  assert.equal(fact.predicate, 'likes');
  assert.equal(fact.objectText, 'phở bò');
  assert.equal(fact.rawConfidence, 0.8);
  assert.equal(fact.confidence, 0.8);
  assert.equal(fact.sourceTrust, 1);
  assert.deepEqual(fact.patterns, ['likes']);
  assert.equal(fact.provenance.episodeId, 'e1');
  assert.equal(fact.provenance.turnId, 't1');
  assert.equal(fact.provenance.sourceName, 'user-chat');
  assert.equal(fact.provenance.sourceText, 'Tôi tên là An. Tôi thích phở bò.');
  assert.equal(fact.subjectEntity.name, 'An');
});

test('v18 extraction: lives_in fact from a plain sentence', () => {
  const store = freshStore();
  const facts = extractV18(store, { text: 'An sống ở Hà Nội.' });
  assert.equal(facts.length, 1);
  assert.equal(facts[0].subjectName, 'An');
  assert.equal(facts[0].predicate, 'lives_in');
  assert.equal(facts[0].objectText, 'Hà Nội');
  assert.equal(facts[0].confidence, 0.85);
});

test('v18 extraction: userDisplayName is the fallback subject', () => {
  const store = freshStore();
  const named = extractV18(store, { text: 'Tôi làm việc tại VNG.', userDisplayName: 'Huy' });
  assert.equal(named.length, 1);
  assert.equal(named[0].subjectName, 'Huy');
  assert.equal(named[0].predicate, 'works_at');
  assert.equal(named[0].objectText, 'VNG');

  const anonymous = extractV18(store, { text: 'Tôi làm việc tại VNG.' });
  assert.equal(anonymous[0].subjectName, 'user');
});

test('v18 extraction: sourceTrust scales confidence', () => {
  const store = freshStore();
  const facts = extractV18(store, {
    text: 'Tôi tên là An. Tôi thích phở bò.',
    sourceTrust: 0.5,
    sourceName: 'web-scrape',
  });
  assert.equal(facts.length, 1);
  assert.equal(facts[0].rawConfidence, 0.8);
  assert.equal(facts[0].confidence, 0.4);
  assert.equal(facts[0].sourceTrust, 0.5);
  assert.equal(facts[0].provenance.sourceName, 'web-scrape');
});

test('v18 extraction: dedupeCandidatesV18 merges duplicates, keeps max confidence', () => {
  const store = freshStore();
  const hi = extractV18(store, { text: 'Tôi tên là An. Tôi thích phở bò.' });
  const lo = extractV18(store, {
    text: 'Tôi tên là An. Tôi thích phở bò.',
    sourceTrust: 0.5,
  });
  assert.equal(hi.length, 1);
  assert.equal(lo.length, 1);
  const merged = dedupeCandidatesV18([...hi, ...lo]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].confidence, 0.8);
  assert.equal(merged[0].rawConfidence, 0.8);
  assert.deepEqual(merged[0].patterns, ['likes']);

  const other = extractV18(store, { text: 'An sống ở Hà Nội.' });
  assert.equal(dedupeCandidatesV18([...hi, ...other]).length, 2);
  assert.deepEqual(dedupeCandidatesV18([]), []);
});

test('v18 extraction: extractAndWriteV18 writes fact + report', () => {
  const store = freshStore();
  const report = extractAndWriteV18(
    store,
    {
      text: 'Tôi tên là An. Tôi thích phở bò.',
      scope: SCOPE,
      episodeId: 'e1',
      turnId: 't1',
    },
  );
  assert.equal(report.extracted, 1);
  assert.equal(report.written, 1);
  assert.deepEqual(report.skipped, []);
  assert.equal(report.factIds.length, 1);
  assert.equal(typeof report.entitiesCreated, 'number');
  assert.ok(report.entitiesCreated >= 0);
  const facts = store.listFacts(SCOPE);
  assert.equal(facts.length, 1);
  assert.equal(facts[0].id, report.factIds[0]);
  assert.equal(facts[0].predicate, 'likes');
  assert.equal(facts[0].objectText, 'phở bò');
});

test('v18 extraction: extractAndWriteV18 skips below minConfidence with a reason', () => {
  const store = freshStore();
  const report = extractAndWriteV18(
    store,
    { text: 'Tôi tên là An. Tôi thích phở bò.', scope: SCOPE },
    { minConfidence: 0.95 },
  );
  assert.equal(report.extracted, 1);
  assert.equal(report.written, 0);
  assert.equal(report.skipped.length, 1);
  assert.equal(report.skipped[0].predicate, 'likes');
  assert.equal(report.skipped[0].confidence, 0.8);
  assert.match(report.skipped[0].reason, /duoi nguong/);
  assert.deepEqual(report.factIds, []);
  assert.equal(store.listFacts(SCOPE).length, 0);
});

test('v18 extraction: extractEpisodeV18 extracts + marks episode processed', () => {
  const store = freshStore();
  const { id } = store.ingestEpisode({
    turnId: 'turn-1',
    runId: 'r1',
    botId: 'b1',
    userId: 'u1',
    role: 'user',
    text: 'Tôi tên là An. Tôi thích phở bò.',
  });
  assert.equal(store.listUnprocessedEpisodes({ userId: 'u1' }, 10).length, 1);
  const report = extractEpisodeV18(store, id);
  assert.ok(report);
  assert.equal(report.episodeId, id);
  assert.equal(report.written, 1);
  assert.equal(store.listFacts(SCOPE).length, 1);
  assert.equal(store.listUnprocessedEpisodes({ userId: 'u1' }, 10).length, 0);
  assert.equal(extractEpisodeV18(store, 'no-such-episode'), null);
});
