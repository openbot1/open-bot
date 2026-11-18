/**
 * Tests for v1.14 (Team T1) — memory v13:
 * packages/core/src/memory/v13/{extraction,benchmark}.ts
 *
 * Covers:
 *  - extraction: rule-based candidates from Vietnamese + English
 *    turns (likes/lives_in/works_at/speaks/prefers/wants/uses);
 *    greeting/question-only turns produce none; "không thích"
 *    yields dislikes only (never a likes twin); applyExtractionV13
 *    appends add-only, dedupes exact repeats, invalidates the old
 *    fact on contradiction (history kept, invalidAt set), defers
 *    invalidation when confidence is below threshold, and never
 *    deletes a fact.
 *  - benchmark: sample dataset is deterministic (12 questions, 4
 *    categories, 12 seed facts); seeding stores facts; answer
 *    matching is accent-insensitive; runV13Benchmark scores a
 *    perfect retriever at 100% and a blind retriever near 0%;
 *    per-category breakdowns add up; formatBenchmarkReport renders
 *    markdown with totals.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/memory-v13-extraction-benchmark-v114.test.mjs
 *
 * No network. No model.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  TemporalGraphStore,
  InMemoryGraphBackend,
  extractCandidatesFromText,
  appendCandidateAddOnly,
  invalidateFactV13,
  applyExtractionV13,
  buildSampleBenchmarkDataset,
  seedBenchmarkFacts,
  normalizeAnswerText,
  answerAppearsIn,
  supportingFactRetrieved,
  runV13Benchmark,
  formatBenchmarkReport,
  multiSignalRetrieve,
  factSearchText,
  isFactValidAt,
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

// ---------- extraction: patterns ----------

test('extraction: Vietnamese likes/lives_in/works_at patterns', () => {
  const likes = extractCandidatesFromText('Tôi rất thích phở bò.');
  assert.equal(likes.length, 1);
  assert.equal(likes[0].predicate, 'likes');
  assert.equal(likes[0].objectText, 'phở bò');
  assert.equal(likes[0].subject, 'user');
  assert.equal(likes[0].pattern, 'likes');
  assert.ok(likes[0].confidence >= 0.5);

  const lives = extractCandidatesFromText('Tôi đang sống ở Đà Nẵng.');
  assert.equal(lives.length, 1);
  assert.equal(lives[0].predicate, 'lives_in');
  assert.equal(lives[0].objectText, 'Đà Nẵng');

  const works = extractCandidatesFromText('Tôi đang làm việc tại Công ty Xanh.');
  assert.equal(works.length, 1);
  assert.equal(works[0].predicate, 'works_at');
  assert.equal(works[0].objectText, 'Công ty Xanh');
});

test('extraction: English patterns + speaks/prefers/wants/uses', () => {
  const en = extractCandidatesFromText('I really like bun cha.');
  assert.equal(en.length, 1);
  assert.equal(en[0].predicate, 'likes');
  assert.equal(en[0].objectText, 'bun cha');

  const speaks = extractCandidatesFromText('Tôi nói tiếng Nhật.');
  assert.ok(speaks.some((c) => c.predicate === 'speaks' && c.objectText === 'Nhật'));

  const wants = extractCandidatesFromText('Tôi muốn đi Đà Lạt vào tháng sau.');
  assert.ok(wants.some((c) => c.predicate === 'wants'));

  const uses = extractCandidatesFromText('Tôi đang dùng Obsidian để ghi chú.');
  assert.ok(uses.some((c) => c.predicate === 'uses' && c.objectText === 'Obsidian'));

  const prefers = extractCandidatesFromText('I prefer tea over coffee.');
  assert.ok(prefers.some((c) => c.predicate === 'prefers' && c.objectText === 'tea'));
});

test('extraction: named subjects are captured as the fact subject', () => {
  const named = extractCandidatesFromText('An rất thích phở bò.');
  assert.ok(named.some((c) => c.subject === 'An' && c.predicate === 'likes'));
  const lives = extractCandidatesFromText('Binh lives in Hanoi.');
  assert.ok(lives.some((c) => c.subject === 'Binh' && c.predicate === 'lives_in'));
});

test('extraction: "không thích" yields dislikes only, never a likes twin', () => {
  const cands = extractCandidatesFromText('Tôi không thích sầu riêng.');
  assert.equal(cands.length, 1);
  assert.equal(cands[0].predicate, 'dislikes');
  assert.equal(cands[0].objectText, 'sầu riêng');
});

test('extraction: greetings, questions and empty text yield no candidates', () => {
  assert.deepEqual(extractCandidatesFromText('Xin chào bạn!'), []);
  assert.deepEqual(extractCandidatesFromText('Hôm nay trời thế nào?'), []);
  assert.deepEqual(extractCandidatesFromText('Cảm ơn bạn nhé.'), []);
  assert.deepEqual(extractCandidatesFromText(''), []);
  assert.deepEqual(extractCandidatesFromText('   '), []);
  // Object too short is dropped.
  assert.deepEqual(extractCandidatesFromText('Tôi thích a.'), []);
});

// ---------- extraction: add-only apply ----------

test('extraction: apply appends facts add-only with provenance', () => {
  const store = freshStore();
  const report = applyExtractionV13(store, [
    { text: 'Tôi rất thích phở bò.', episodeId: 'ep1', turnId: 't1' },
    { text: 'Tôi đang sống ở Hà Nội.', episodeId: 'ep1', turnId: 't2' },
  ]);
  assert.equal(report.turns, 2);
  assert.equal(report.candidates, 2);
  assert.equal(report.appended.length, 2);
  assert.equal(report.duplicates.length, 0);
  assert.equal(report.invalidated.length, 0);

  const facts = store.listFacts({ status: 'active' });
  assert.equal(facts.length, 2);
  const likes = facts.find((f) => f.predicate === 'likes');
  assert.equal(likes.objectText, 'phở bò');
  assert.equal(likes.provenance.episodeId, 'ep1');
  assert.equal(likes.provenance.sourceText, 'Tôi rất thích phở bò.');
  assert.equal(likes.status, 'active');
});

test('extraction: exact duplicate turns dedupe instead of appending', () => {
  const store = freshStore();
  const turns = [{ text: 'Tôi rất thích phở bò.', episodeId: 'ep1', turnId: 't1' }];
  const first = applyExtractionV13(store, turns);
  assert.equal(first.appended.length, 1);
  const second = applyExtractionV13(store, turns);
  assert.equal(second.appended.length, 0);
  assert.equal(second.duplicates.length, 1);
  assert.equal(store.listFacts({ status: 'active' }).length, 1);
});

test('extraction: contradiction invalidates the old fact, never deletes it', () => {
  const store = freshStore();
  applyExtractionV13(store, [
    { text: 'Tôi đang sống ở Hà Nội.', episodeId: 'ep1', turnId: 't1', at: '2026-01-01T00:00:00.000Z' },
  ]);
  const oldFacts = store.listFacts({ status: 'active' });
  assert.equal(oldFacts.length, 1);
  const oldId = oldFacts[0].id;

  const report = applyExtractionV13(store, [
    { text: 'Tôi đang sống ở Đà Nẵng.', episodeId: 'ep2', turnId: 't1', at: '2026-03-01T00:00:00.000Z' },
  ]);
  assert.equal(report.appended.length, 1);
  assert.equal(report.invalidated.length, 1);
  assert.equal(report.invalidated[0].record.factId, oldId);
  assert.match(report.invalidated[0].record.reason, /Mau thuan/);
  const danangFact = store.listFacts({}).find((f) => f.objectText === 'Đà Nẵng');
  assert.equal(report.invalidated[0].record.conflictingFactId, danangFact.id);

  // Old fact still exists in history with invalidAt set. Its status
  // stays 'active' (v12 invalidation closes the validity window
  // instead of flipping status) — but it is no longer valid NOW.
  const old = store.getFact(oldId);
  assert.ok(old);
  assert.equal(old.status, 'active');
  // Invalidation closes the validity window (validUntil = invalidAt).
  assert.equal(old.validUntil, '2026-03-01T00:00:00.000Z');
  assert.ok(old.invalidAt);
  assert.equal(old.invalidationReason !== undefined, true);
  assert.equal(isFactValidAt(old), false);

  // New fact is the only one still valid now.
  const current = store.findActiveFacts('user', 'lives_in').filter((f) => isFactValidAt(f));
  assert.equal(current.length, 1);
  assert.equal(current[0].objectText, 'Đà Nẵng');
  // Full history still lists both facts.
  assert.equal(store.listFacts({}).length, 2);
});

test('extraction: low-confidence candidates are dropped, not stored', () => {
  const store = freshStore();
  const report = applyExtractionV13(store, [
    { text: 'Tôi rất thích phở bò.', episodeId: 'ep1', turnId: 't1' },
  ], { minConfidence: 0.95 });
  assert.equal(report.appended.length, 0);
  assert.equal(report.dropped.length, 1);
  assert.equal(store.listFacts({}).length, 0);
});

test('extraction: contradiction below the invalidate threshold is deferred', () => {
  const store = freshStore();
  applyExtractionV13(store, [
    { text: 'Tôi đang sống ở Hà Nội.', episodeId: 'ep1', turnId: 't1', at: '2026-01-01T00:00:00.000Z' },
  ]);
  // New fact confidence 0.85 < threshold 0.99 -> old fact survives.
  const report = applyExtractionV13(store, [
    { text: 'Tôi đang sống ở Đà Nẵng.', episodeId: 'ep2', turnId: 't1', at: '2026-03-01T00:00:00.000Z' },
  ], { minConfidenceToInvalidate: 0.99 });
  assert.equal(report.appended.length, 1);
  assert.equal(report.invalidated.length, 0);
  assert.equal(report.deferred.length, 1);
  assert.match(report.deferred[0].reason, /nguong invalidate/);
  assert.equal(store.findActiveFacts('user', 'lives_in').length, 2);
});

test('extraction: appendCandidateAddOnly dedupes exact repeats directly', () => {
  const store = freshStore();
  const candidate = {
    subject: 'user', predicate: 'likes', objectText: 'phở bò',
    confidence: 0.8, sourceText: 'Tôi thích phở bò.', pattern: 'likes',
  };
  const first = appendCandidateAddOnly(store, candidate, SCOPE, prov('Tôi thích phở bò.'));
  assert.equal(first.duplicate, false);
  const second = appendCandidateAddOnly(store, candidate, SCOPE, prov('Tôi thích phở bò.'));
  assert.equal(second.duplicate, true);
  assert.equal(second.existingFactId, first.fact.id);
  assert.equal(store.listFacts({}).length, 1);
});

test('extraction: invalidateFactV13 records reason and keeps history', () => {
  const store = freshStore();
  const fact = store.addFact({
    subjectName: 'An', predicate: 'likes', objectText: 'tra sua',
    confidence: 0.8, scope: SCOPE, provenance: prov('An thich tra sua.'),
    validFrom: '2026-01-01T00:00:00.000Z',
  });
  const { record } = invalidateFactV13(
    store, fact.id, 'User noi khong thich nua.', 'user',
    { invalidAt: '2026-02-01T00:00:00.000Z' },
  );
  assert.equal(record.factId, fact.id);
  assert.equal(record.reason, 'User noi khong thich nua.');
  assert.equal(record.actor, 'user');
  assert.equal(record.invalidAt, '2026-02-01T00:00:00.000Z');
  const after = store.getFact(fact.id);
  assert.equal(after.invalidAt, '2026-02-01T00:00:00.000Z');
  assert.equal(after.validUntil, '2026-02-01T00:00:00.000Z');
  assert.equal(after.invalidatedBy, 'user');

  // Empty reason / unknown fact throw — on FRESH facts (an already
  // invalidated fact throws a window error first, by design).
  const fresh = store.addFact({
    subjectName: 'Binh', predicate: 'likes', objectText: 'bun cha',
    confidence: 0.8, scope: SCOPE, provenance: prov('Binh thich bun cha.'),
    validFrom: '2026-01-01T00:00:00.000Z',
  });
  assert.throws(
    () => invalidateFactV13(store, fresh.id, '   ', 'user'),
    /không được rỗng/,
  );
  assert.throws(
    () => invalidateFactV13(store, 'missing', 'ly do', 'user'),
    /tìm thấy fact/,
  );
});

// ---------- benchmark ----------

test('benchmark: sample dataset is deterministic with 12 questions in 4 categories', () => {
  const a = buildSampleBenchmarkDataset();
  const b = buildSampleBenchmarkDataset();
  assert.deepEqual(a, b);
  assert.equal(a.name, 'open-bot-memory-v13-sample');
  assert.equal(a.version, 1);
  assert.equal(a.questions.length, 12);
  assert.equal(a.seedFacts.length, 12);
  const cats = [...new Set(a.questions.map((q) => q.category))].sort();
  assert.deepEqual(cats, ['contradiction', 'multi-hop', 'preference', 'temporal']);
  for (const q of a.questions) {
    assert.ok(q.expectedAnswer.length > 0);
    assert.ok(q.supportingFactKeys.length >= 1);
    for (const key of q.supportingFactKeys) {
      assert.ok(a.seedFacts.some((f) => f.key === key), `missing seed fact ${key}`);
    }
  }
});

test('benchmark: seedBenchmarkFacts stores all seed facts in the store', () => {
  const store = freshStore();
  const dataset = buildSampleBenchmarkDataset();
  const map = seedBenchmarkFacts(store, dataset);
  assert.equal(map.size, 12);
  assert.equal(store.listFacts({}).length, 12);
  const an = map.get('an|lives_in|da nang');
  assert.equal(an.objectText, 'Da Nang');
  assert.equal(an.validFrom, '2026-03-01T00:00:00.000Z');
});

test('benchmark: answer matching is accent-insensitive', () => {
  assert.equal(normalizeAnswerText('Phở Bò'), 'pho bo');
  assert.equal(answerAppearsIn('Hà Nội', ['An song o Ha Noi.']), true);
  assert.equal(answerAppearsIn('Đà Nẵng', ['An song o Ha Noi.']), false);
  assert.equal(answerAppearsIn('pho bo', ['An thich pho bo.']), true);
  assert.equal(answerAppearsIn('', ['bat cu gi']), false);
  const dataset = buildSampleBenchmarkDataset();
  const seed = dataset.seedFacts.find((f) => f.key === 'an|likes|pho bo');
  assert.equal(supportingFactRetrieved(seed, ['An thich pho bo.']), true);
  assert.equal(supportingFactRetrieved(seed, ['Binh thich bun cha.']), false);
});

test('benchmark: perfect retriever scores 100% on every metric', async () => {
  const store = freshStore();
  const dataset = buildSampleBenchmarkDataset();
  const seeded = seedBenchmarkFacts(store, dataset);
  const perfect = (q) => {
    // Chi tra ve text cua fact ho tro (da chua dap an) — khong them
    // text phu, neu khong precision uoc luong se < 1.
    const texts = [];
    for (const key of q.supportingFactKeys) {
      const fact = seeded.get(key);
      texts.push(factSearchText(fact, fact.subjectId ? store.getEntity(fact.subjectId).name : 'user'));
    }
    return texts;
  };
  const result = await runV13Benchmark(perfect, dataset, { topK: 5 });
  assert.equal(result.questions, 12);
  assert.equal(result.answerHitRate, 1);
  assert.equal(result.supportRecall, 1);
  assert.equal(result.f1, 1);
  assert.equal(result.perCategory.length, 4);
  for (const c of result.perCategory) {
    assert.equal(c.answerHitRate, 1);
    assert.equal(c.supportRecall, 1);
  }
  assert.equal(result.perQuestion.length, 12);
  assert.ok(result.perQuestion.every((p) => p.answerHit));
});

test('benchmark: blind retriever scores near zero', async () => {
  const dataset = buildSampleBenchmarkDataset();
  const blind = () => ['khong co thong tin gi o day'];
  const result = await runV13Benchmark(blind, dataset, { topK: 5 });
  assert.equal(result.answerHitRate, 0);
  assert.equal(result.supportRecall, 0);
  assert.equal(result.f1, 0);
  assert.ok(result.perQuestion.every((p) => !p.answerHit));
});

test('benchmark: real multi-signal retriever beats blind on the sample set', async () => {
  const store = freshStore();
  const dataset = buildSampleBenchmarkDataset();
  seedBenchmarkFacts(store, dataset);
  const retriever = async (q) => {
    const res = await multiSignalRetrieve(store, q.question, {
      topK: 5,
      onlyValidNow: false,
    });
    return res.hits.map((h) =>
      factSearchText(h.fact, h.subjectName, h.objectName),
    );
  };
  const result = await runV13Benchmark(retriever, dataset, { topK: 5 });
  assert.ok(result.answerHitRate > 0, 'real retriever should hit some answers');
  assert.ok(result.supportRecall > 0);
  assert.equal(result.questions, 12);
  assert.equal(result.perCategory.length, 4);
});

test('benchmark: per-question rows match totals; report renders markdown', async () => {
  const dataset = buildSampleBenchmarkDataset();
  const result = await runV13Benchmark(() => ['An thich pho bo.'], dataset, { topK: 5 });
  const hits = result.perQuestion.filter((p) => p.answerHit).length;
  assert.equal(hits / result.questions, result.answerHitRate);
  const catTotal = result.perCategory.reduce((s, c) => s + c.questions, 0);
  assert.equal(catTotal, result.questions);

  const md = formatBenchmarkReport(result);
  assert.match(md, /# Benchmark memory v13/);
  assert.match(md, /Answer hit rate/);
  assert.match(md, /Support recall/);
  assert.match(md, /\| temporal \|/);
  assert.match(md, /## Tung cau/);
  assert.match(md, /q01/);
});

test('benchmark: retriever errors are recorded, not thrown', async () => {
  const dataset = buildSampleBenchmarkDataset();
  const boom = () => {
    throw new Error('retriever hong');
  };
  const result = await runV13Benchmark(boom, dataset);
  assert.equal(result.answerHitRate, 0);
  assert.equal(result.notes.length, 12);
  assert.match(result.notes[0], /retriever hong/);
});
