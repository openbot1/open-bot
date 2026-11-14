/**
 * Tests for the memory eval v3 (packages/core/src/eval/).
 *
 * Covers the built-in fixture dataset (validation, 48 facts /
 * 36 questions, 12 per category), the deterministic mock embedding
 * (same input -> same vector, cosine self-similarity 1), the mock
 * retriever (topK, determinism, ranking), per-question scoring
 * (recall/precision/F1, temporal accuracy, multi-hop coverage,
 * mock judge), and a full offline run of the builtin dataset.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/eval-memory-v105.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BUILTIN_MEMORY_EVAL_DATASET,
  InMemoryMockRetriever,
  cosineSimilarity,
  fnv1aHash32,
  mockEmbed,
  mockJudgeAnswer,
  runMemoryEval,
  scoreMemoryQuestion,
  tokenizeEvalText,
  validateMemoryEvalDataset,
  indexFactsById,
} from '../packages/core/dist/eval/index.js';

const dataset = BUILTIN_MEMORY_EVAL_DATASET;

test('builtin dataset validates and has the expected shape', () => {
  const valid = validateMemoryEvalDataset(structuredClone(dataset));
  assert.equal(valid.facts.length, 60);
  assert.equal(valid.questions.length, 61);
  const byCategory = { recall: 0, temporal: 0, 'multi-hop': 0 };
  for (const q of valid.questions) byCategory[q.category] += 1;
  assert.deepEqual(byCategory, { recall: 24, temporal: 20, 'multi-hop': 17 });
  // Every temporal question has an expectedDate; every multi-hop
  // question has hops covering its expected facts.
  for (const q of valid.questions) {
    if (q.category === 'temporal') assert.match(q.expectedDate, /^\d{4}-\d{2}-\d{2}$/);
    if (q.category === 'multi-hop') {
      assert.ok(Array.isArray(q.hops) && q.hops.length > 0);
      const hopFacts = new Set(q.hops.flat());
      for (const fid of q.expectedFactIds) assert.ok(hopFacts.has(fid), `${q.id} hop must cover ${fid}`);
    }
  }
});

test('dataset validation rejects bad references', () => {
  const bad = structuredClone(dataset);
  bad.questions[0].expectedFactIds = ['fact-does-not-exist'];
  assert.throws(() => validateMemoryEvalDataset(bad), /unknown fact/);
  const badDate = structuredClone(dataset);
  badDate.questions.find((q) => q.category === 'temporal').expectedDate = 'not-a-date';
  assert.throws(() => validateMemoryEvalDataset(badDate), /expectedDate/);
  const dup = structuredClone(dataset);
  dup.facts.push({ ...dup.facts[0] });
  assert.throws(() => validateMemoryEvalDataset(dup), /duplicate fact id/);
});

test('tokenize + fnv1a hash are deterministic', () => {
  assert.deepEqual(tokenizeEvalText('Hello,  World! 123'), ['hello', 'world', '123']);
  assert.equal(fnv1aHash32('peanut'), fnv1aHash32('peanut'));
  assert.notEqual(fnv1aHash32('peanut'), fnv1aHash32('almond'));
});

test('mock embedding is deterministic and self-similar', () => {
  const a = mockEmbed('Minh prefers dark mode in every app');
  const b = mockEmbed('Minh prefers dark mode in every app');
  assert.deepEqual(a, b);
  assert.equal(a.length, 64);
  assert.ok(Math.abs(cosineSimilarity(a, b) - 1) < 1e-9);
  const c = mockEmbed('unrelated words about quantum zebras');
  assert.ok(cosineSimilarity(a, c) < cosineSimilarity(a, b));
  assert.throws(() => mockEmbed('x', 0), /dim/);
});

test('mock retriever ranks the right fact first for a direct question', () => {
  const retriever = new InMemoryMockRetriever(dataset.facts);
  const hits = retriever.retrieve('What is Minh allergic to?', 5);
  assert.equal(hits.length, 5);
  assert.equal(hits[0].factId, 'fact-03');
  // Deterministic: same query twice -> same order.
  const again = retriever.retrieve('What is Minh allergic to?', 5);
  assert.deepEqual(hits, again);
  assert.throws(() => new InMemoryMockRetriever([]), /at least one fact/);
  assert.throws(() => retriever.retrieve('', 5), /non-empty query/);
  assert.throws(() => retriever.retrieve('x', 0), /topK/);
});

test('scoreMemoryQuestion: perfect retrieval scores 1 on every metric', () => {
  const factsById = indexFactsById(dataset);
  const q = dataset.questions.find((x) => x.id === 'q-recall-01');
  const score = scoreMemoryQuestion(q, [{ factId: 'fact-03', text: factsById.get('fact-03').text, score: 0.9 }], factsById);
  assert.equal(score.recall, 1);
  assert.equal(score.precision, 1);
  assert.equal(score.f1, 1);
  assert.equal(score.temporalAccuracy, null);
  assert.equal(score.multiHopScore, null);
  assert.equal(score.judgeScore, 1);
});

test('scoreMemoryQuestion: partial retrieval lowers recall and precision', () => {
  const factsById = indexFactsById(dataset);
  const q = dataset.questions.find((x) => x.id === 'q-temp-01');
  // Only one of the two expected facts, plus one irrelevant fact.
  const score = scoreMemoryQuestion(
    q,
    [
      { factId: 'fact-13', text: factsById.get('fact-13').text, score: 0.8 },
      { factId: 'fact-01', text: factsById.get('fact-01').text, score: 0.1 },
    ],
    factsById,
  );
  assert.equal(score.recall, 0.5);
  assert.equal(score.precision, 0.5);
  assert.equal(score.f1, 0.5);
  // fact-13 carries the expected date -> temporal accuracy 1.
  assert.equal(score.temporalAccuracy, 1);
});

test('scoreMemoryQuestion: temporal accuracy is 0 when the date is wrong', () => {
  const factsById = indexFactsById(dataset);
  const q = dataset.questions.find((x) => x.id === 'q-temp-01');
  // fact-15 is about the Hanoi trip but dated 2026-09-16, not 2026-09-14.
  const score = scoreMemoryQuestion(
    q,
    [{ factId: 'fact-15', text: factsById.get('fact-15').text, score: 0.8 }],
    factsById,
  );
  assert.equal(score.temporalAccuracy, 0);
  assert.equal(score.recall, 0);
});

test('scoreMemoryQuestion: multi-hop score counts covered hops', () => {
  const factsById = indexFactsById(dataset);
  const q = dataset.questions.find((x) => x.id === 'q-hop-03');
  const oneHop = scoreMemoryQuestion(
    q,
    [{ factId: 'fact-32', text: factsById.get('fact-32').text, score: 0.8 }],
    factsById,
  );
  assert.equal(oneHop.multiHopScore, 0.5);
  const bothHops = scoreMemoryQuestion(
    q,
    [
      { factId: 'fact-32', text: factsById.get('fact-32').text, score: 0.8 },
      { factId: 'fact-33', text: factsById.get('fact-33').text, score: 0.7 },
    ],
    factsById,
  );
  assert.equal(bothHops.multiHopScore, 1);
  assert.equal(bothHops.recall, 1);
});

test('mockJudgeAnswer counts keyword coverage in retrieved text', () => {
  const factsById = indexFactsById(dataset);
  const q = dataset.questions.find((x) => x.id === 'q-recall-01');
  const { judgeScore } = mockJudgeAnswer(q, [
    { factId: 'fact-03', text: factsById.get('fact-03').text, score: 0.9 },
  ]);
  assert.equal(judgeScore, 1);
  const empty = mockJudgeAnswer(q, []);
  assert.equal(empty.judgeScore, 0);
  assert.match(empty.answer, /could not find/);
});

test('runMemoryEval: full offline run over the builtin dataset', async () => {
  const retriever = new InMemoryMockRetriever(dataset.facts);
  const report = await runMemoryEval(dataset, retriever, { topK: 5, retrieverVersion: 'mock-embedding-v1', at: 1792000000000 });
  assert.equal(report.datasetId, dataset.id);
  assert.equal(report.perQuestion.length, 61);
  assert.equal(report.byCategory.length, 3);
  assert.equal(report.overall.count, 61);
  // Scores are in [0, 1] and the mock retriever is decent on this
  // fixture: recall well above random. Note F1 is capped by design
  // here — most questions have 1 expected fact while topK is 5, so
  // max precision is 0.2 and max F1 ~0.33; recall is the metric
  // that shows retrieval quality.
  assert.ok(report.overall.recall > 0.6, `expected overall recall > 0.6, got ${report.overall.recall}`);
  assert.ok(report.overall.f1 > 0.25, `expected overall F1 > 0.25, got ${report.overall.f1}`);
  assert.ok(report.overall.f1 <= 1 && report.overall.recall <= 1);
  const temporal = report.byCategory.find((c) => c.category === 'temporal');
  assert.notEqual(temporal.temporalAccuracy, null);
  const hops = report.byCategory.find((c) => c.category === 'multi-hop');
  assert.notEqual(hops.multiHopScore, null);
  // Deterministic: a second run gives the same scores.
  const again = await runMemoryEval(dataset, new InMemoryMockRetriever(dataset.facts), { topK: 5, retrieverVersion: 'mock-embedding-v1', at: 1792000000000 });
  assert.deepEqual(report, again);
  await assert.rejects(runMemoryEval(dataset, retriever, { topK: 0 }), /topK/);
});

test('second dataset validates: handover fixture (24 facts / 18 questions)', async () => {
  const { HANDOVER_MEMORY_EVAL_DATASET, BUILTIN_MEMORY_EVAL_DATASETS, getBuiltinMemoryEvalDataset, validateMemoryEvalDataset } =
    await import('../packages/core/dist/eval/index.js');
  validateMemoryEvalDataset(structuredClone(HANDOVER_MEMORY_EVAL_DATASET));
  assert.equal(HANDOVER_MEMORY_EVAL_DATASET.facts.length, 24);
  assert.equal(HANDOVER_MEMORY_EVAL_DATASET.questions.length, 20);
  assert.equal(BUILTIN_MEMORY_EVAL_DATASETS.length, 2);
  assert.equal(getBuiltinMemoryEvalDataset('builtin-handover-v1').id, 'builtin-handover-v1');
  assert.equal(getBuiltinMemoryEvalDataset('nope'), null);
  // The handover dataset also scores sanely with the mock retriever.
  const retriever = new InMemoryMockRetriever(HANDOVER_MEMORY_EVAL_DATASET.facts);
  const report = await runMemoryEval(HANDOVER_MEMORY_EVAL_DATASET, retriever, { topK: 5 });
  assert.ok(report.overall.recall > 0.5, `handover recall ${report.overall.recall}`);
});

test('KeywordMockRetriever scores by token overlap and is deterministic', async () => {
  const { KeywordMockRetriever } = await import('../packages/core/dist/eval/index.js');
  const retriever = new KeywordMockRetriever(dataset.facts);
  assert.equal(retriever.name, 'keyword-v1');
  const hits = retriever.retrieve('What is Minh allergic to?', 3);
  assert.equal(hits[0].factId, 'fact-03');
  assert.deepEqual(hits, retriever.retrieve('What is Minh allergic to?', 3));
  const report = await runMemoryEval(dataset, retriever, { topK: 5 });
  assert.ok(report.overall.recall > 0.4, `keyword recall ${report.overall.recall}`);
  assert.throws(() => new KeywordMockRetriever([]), /at least one fact/);
});

test('report rendering: markdown + history trend', async () => {
  const { renderMemoryEvalReportMarkdown, renderEvalComparisonMarkdown, renderRegressionAlertsMarkdown, summarizeEvalHistory, compareMemoryEvalReports } =
    await import('../packages/core/dist/eval/index.js');
  const retriever = new InMemoryMockRetriever(dataset.facts);
  const report = await runMemoryEval(dataset, retriever, { topK: 5, retrieverVersion: 'mock-v1', at: 1000 });
  const md = renderMemoryEvalReportMarkdown(report);
  assert.match(md, /Memory eval report — builtin-memory-v1/);
  assert.match(md, /mock-v1/);
  assert.match(md, /\| overall \(61\)/);
  const worse = await runMemoryEval(dataset, retriever, { topK: 1, retrieverVersion: 'mock-v1-top1', at: 2000 });
  const cmp = compareMemoryEvalReports(report, worse);
  const cmpMd = renderEvalComparisonMarkdown(cmp);
  assert.match(cmpMd, /mock-v1-top1/);
  assert.match(cmpMd, /improved/);
  assert.equal(renderRegressionAlertsMarkdown([]), 'No regression alerts.\n');
  const trend = summarizeEvalHistory([report, worse]);
  assert.equal(trend.runs, 2);
  assert.ok(typeof trend.f1SlopePerRun === 'number');
  // Note: on this fixture topK 1 has the HIGHER F1 (precision 1.0
  // on the one fact it retrieves outweighs its lower recall), so the
  // top1 run is the "best" by F1 even though it recalls less.
  assert.equal(trend.bestRun.retrieverVersion, 'mock-v1-top1');
  assert.equal(trend.worstRun.retrieverVersion, 'mock-v1');
  assert.equal(trend.latestF1, worse.overall.f1);
  assert.equal(trend.firstF1, report.overall.f1);
  assert.deepEqual(summarizeEvalHistory([]).runs, 0);
});

test('retriever benchmark: embedding vs keyword on the same dataset', async () => {
  const { runRetrieverBenchmark, renderBenchmarkMarkdown, KeywordMockRetriever } =
    await import('../packages/core/dist/eval/index.js');
  const benchmark = await runRetrieverBenchmark(
    dataset,
    [
      { retriever: new InMemoryMockRetriever(dataset.facts), version: 'mock-embedding-v1' },
      { retriever: new KeywordMockRetriever(dataset.facts), version: 'keyword-v1' },
    ],
    { topK: 5, at: 1792000000000 },
  );
  assert.equal(benchmark.rows.length, 2);
  assert.equal(benchmark.datasetId, dataset.id);
  assert.ok(benchmark.winners.f1.value > 0);
  assert.ok(['mock-embedding-v1', 'keyword-v1'].includes(benchmark.winners.recall.version));
  const md = renderBenchmarkMarkdown(benchmark);
  assert.match(md, /Retriever benchmark/);
  assert.match(md, /mock-embedding-v1/);
  assert.match(md, /keyword-v1/);
  await assert.rejects(runRetrieverBenchmark(dataset, [], {}), /at least one retriever/);
  await assert.rejects(
    runRetrieverBenchmark(dataset, [{ retriever: new KeywordMockRetriever(dataset.facts), version: '' }], {}),
    /non-empty version/,
  );
});

test('dataset coverage: builtin dataset is well covered, warnings fire when thin', async () => {
  const { analyzeDatasetCoverage, renderCoverageMarkdown } = await import('../packages/core/dist/eval/index.js');
  const coverage = analyzeDatasetCoverage(dataset);
  assert.equal(coverage.totalFacts, 60);
  assert.equal(coverage.totalQuestions, 61);
  assert.equal(coverage.coverageRatio, 1, 'every fact should be asked about');
  assert.deepEqual(coverage.uncoveredFacts, []);
  assert.equal(coverage.questionsByCategory.recall, 24);
  assert.ok(coverage.mostAskedFact !== null);
  const md = renderCoverageMarkdown(coverage);
  assert.match(md, /Dataset coverage — builtin-memory-v1/);
  // A thin dataset warns.
  const thin = analyzeDatasetCoverage({
    id: 'thin',
    name: 'thin',
    version: 1,
    description: '',
    facts: [
      { id: 'f1', text: 'Alpha is red.', tags: ['color'] },
      { id: 'f2', text: 'Beta is blue.', tags: ['color'] },
      { id: 'f3', text: 'Gamma is green.', tags: ['color'] },
      { id: 'f4', text: 'Delta is yellow.', tags: ['color'] },
      { id: 'f5', text: 'Epsilon is purple.', tags: ['color'] },
    ],
    questions: [
      { id: 'q1', category: 'recall', question: 'What color is Alpha?', expectedFactIds: ['f1'], expectedAnswerKeywords: ['red'] },
    ],
  });
  assert.equal(thin.coverageRatio, 0.2);
  assert.equal(thin.uncoveredFacts.length, 4);
  assert.ok(thin.warnings.some((w) => w.includes('coverage is 20.0%')));
  assert.ok(thin.warnings.some((w) => w.includes('no temporal questions')));
});
