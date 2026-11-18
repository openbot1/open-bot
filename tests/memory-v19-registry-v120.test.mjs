/**
 * Tests for memory v19 — writer registry + token budget + eval harness
 * (v1.20, Đội T1, phan viet truoc — file nay bo sung test con thieu):
 * packages/core/src/memory/v19/{writerModels,tokenBudget,evalFrontier}.ts
 *
 * Covers:
 *  - registry: bang tham khao (Opus 5.5 LoCoMo 93,5%, Sonnet 5.5
 *    93,4% nua gia, GPT-6 Luna chot FrontierMemory 28,9%), chon
 *    model re nhat dat minAccuracy, chi phi cheap-tier <$10/1000
 *    adds, Opus dat nhat, canh bao mau thuan benchmark.
 *  - token budget: cap 20% / san 15% context, heuristic chars/4,
 *    planReplay chon theo diem uu tien trong budget, record +
 *    usage report.
 *  - eval harness: dataset xay duoc, mock writer chay ca hai
 *    benchmark local, detectBenchmarkContradictionV19 bat truong
 *    hop LoCoMo cao / FrontierMemory thap (GPT-6 Luna).
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/memory-v19-registry-v120.test.mjs
 *
 * No network. No model (chi MockWriterV19 local).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  TemporalGraphStore,
  InMemoryGraphBackend,
  getDefaultWriterRegistryV19,
  V19_WRITER_MODEL_REFERENCE,
  pickWriterModelV19,
  rankWriterModelsV19,
  estimateCostPer1000AddsV19,
  costOfOneAddV19,
  detectWriterRankingContradictionV19,
  V19TokenBudgetGovernor,
  estimateTokensV19,
  replayCandidateFromFactV19,
  V19_DEFAULT_MEMORY_FRACTION_MAX,
  V19_DEFAULT_MEMORY_FRACTION_MIN,
  buildV19FrontierDataset,
  MockWriterV19,
  runV19WriterEval,
  detectBenchmarkContradictionV19,
  formatV19WriterEvalReport,
} from '../packages/core/dist/index.js';

function freshStore() {
  return new TemporalGraphStore(new InMemoryGraphBackend());
}

// --- writer registry ------------------------------------------------------

test('v19 registry: bang tham khao co so nhu brief nghien cuu', () => {
  const byId = new Map(V19_WRITER_MODEL_REFERENCE.map((p) => [p.id, p]));
  assert.equal(byId.get('opus-5.5')?.locomoAccuracy, 0.935);
  assert.equal(byId.get('opus-5.5')?.frontierAccuracy, 0.733);
  assert.equal(byId.get('sonnet-5.5')?.locomoAccuracy, 0.934);
  assert.equal(byId.get('gpt-6-luna')?.frontierAccuracy, 0.289);
  assert.equal(byId.get('gpt-6-luna')?.locomoAccuracy, 0.92);
  assert.equal(byId.get('mock-writer')?.inputUsdPerMillion, 0);
  // Sonnet nua gia Opus (input).
  assert.equal(
    byId.get('sonnet-5.5')?.inputUsdPerMillion,
    (byId.get('opus-5.5')?.inputUsdPerMillion ?? 0) / 2,
  );
});

test('v19 registry: chi phi — Opus dat nhat, cheap-tier duoi $10/1000 adds', () => {
  const registry = getDefaultWriterRegistryV19();
  const opus = registry.get('opus-5.5');
  const sonnet = registry.get('sonnet-5.5');
  const cheap = registry.get('cheap-tier');
  assert.ok(opus && sonnet && cheap);
  const opusCost = estimateCostPer1000AddsV19(opus);
  const sonnetCost = estimateCostPer1000AddsV19(sonnet);
  const cheapCost = estimateCostPer1000AddsV19(cheap);
  assert.ok(opusCost > sonnetCost);
  assert.ok(cheapCost !== null && cheapCost < 10);
  assert.ok(costOfOneAddV19(opus, 600, 200) > costOfOneAddV19(sonnet, 600, 200));
  // Mock writer mien phi.
  assert.equal(estimateCostPer1000AddsV19(registry.get('mock-writer')), 0);
});

test('v19 registry: pick re nhat dat minAccuracy tren LoCoMo', () => {
  const registry = getDefaultWriterRegistryV19();
  const pick = pickWriterModelV19(registry, { benchmark: 'locomo', minAccuracy: 0.9 });
  assert.equal(pick.profile.id, 'cheap-tier');
  assert.ok((pick.accuracy ?? 0) >= 0.9);
  assert.ok(pick.reason.length > 0);
  const cheapOnly = pickWriterModelV19(registry, { benchmark: 'locomo', tier: 'cheap' });
  assert.equal(cheapOnly.profile.tier, 'cheap');
  assert.throws(
    () => pickWriterModelV19(registry, { benchmark: 'locomo', minAccuracy: 0.99 }),
    /Khong co writer model nao/,
  );
});

test('v19 registry: rank LoCoMo — Opus dau; canh bao mau thuan benchmark', () => {
  const registry = getDefaultWriterRegistryV19();
  const ranked = rankWriterModelsV19(registry, 'locomo');
  assert.equal(ranked[0].profile.id, 'opus-5.5');
  const warnings = detectWriterRankingContradictionV19(registry);
  assert.ok(warnings.length >= 1);
  assert.match(warnings[0], /MAU THUAN BENCHMARK/);
});

// --- token budget ---------------------------------------------------------

test('v19 token budget: cap 20% / san 15% context', () => {
  assert.equal(V19_DEFAULT_MEMORY_FRACTION_MAX, 0.2);
  assert.equal(V19_DEFAULT_MEMORY_FRACTION_MIN, 0.15);
  const gov = new V19TokenBudgetGovernor({ contextTokens: 100_000 });
  assert.equal(gov.budgetTokens(), 20_000);
  assert.equal(gov.floorTokens(), 15_000);
  assert.throws(() => new V19TokenBudgetGovernor({ contextTokens: 0 }), /contextTokens/);
});

test('v19 token budget: heuristic chars/4, plan theo diem uu tien', () => {
  assert.equal(estimateTokensV19('x'.repeat(400)), 100);
  assert.equal(estimateTokensV19(''), 0); // text rong -> 0 token
  const gov = new V19TokenBudgetGovernor({ contextTokens: 1000 }); // cap 200 token
  const plan = gov.planReplay([
    { factId: 'low', text: 'x'.repeat(400), score: 0.1 },
    { factId: 'high', text: 'y'.repeat(400), score: 0.9 },
    { factId: 'mid', text: 'z'.repeat(400), score: 0.5 },
  ]);
  // Cap 200 token = 2 fact (100 token/fact); high + mid duoc chon, low bi cat.
  assert.deepEqual(plan.selected.map((c) => c.factId), ['high', 'mid']);
  assert.equal(plan.dropped.length, 1);
  assert.equal(plan.dropped[0].candidate.factId, 'low');
  assert.ok(plan.usedTokens <= 200);
  const record = gov.record(plan);
  assert.equal(record.usedTokens, plan.usedTokens);
  const report = gov.usageReport();
  assert.equal(report.totalReplays, 1);
  assert.ok(report.totalUsedTokens >= 0);
});

test('v19 token budget: replayCandidateFromFactV19 lay text tu fact', () => {
  const store = freshStore();
  const { id: episodeId } = store.ingestEpisode({
    turnId: 'e1',
    runId: 'r1',
    botId: 'b1',
    userId: 'u1',
    role: 'user',
    text: 'An song o Ha Noi.',
  });
  const fact = store.addFact({
    subjectName: 'An',
    predicate: 'lives_in',
    objectText: 'Ha Noi',
    confidence: 0.9,
    scope: { userId: 'u1', botId: 'b1', runId: 'r1' },
    provenance: {
      episodeId,
      turnId: 'e1',
      runId: 'r1',
      botId: 'b1',
      userId: 'u1',
      at: '2026-01-01T00:00:00.000Z',
      sourceText: 'An song o Ha Noi.',
    },
  });
  const cand = replayCandidateFromFactV19(fact, 'An', 0.8);
  assert.equal(cand.factId, fact.id);
  assert.equal(cand.score, 0.8);
  assert.equal(cand.text, 'An lives in Ha Noi');
});

// --- eval harness ---------------------------------------------------------

test('v19 eval: dataset frontier xay duoc, co case + scope', () => {
  const dataset = buildV19FrontierDataset();
  assert.ok(dataset.cases.length > 0);
  assert.ok(dataset.scope);
  assert.ok(dataset.cases.every((c) => c.queries.length > 0));
});

test('v19 eval: mock writer chay ca hai benchmark local', async () => {
  const store = freshStore();
  const result = await runV19WriterEval(store, new MockWriterV19());
  assert.equal(result.writerId, 'mock-writer');
  assert.equal(result.locomo.benchmark, 'locomo');
  assert.equal(result.frontier.benchmark, 'frontier');
  assert.ok(result.locomo.total > 0);
  assert.ok(result.frontier.total > 0);
  assert.ok(result.writeStats);
  assert.ok(result.provenanceNote.length > 0);
  assert.match(formatV19WriterEvalReport(result), /mock-writer/);
});

test('v19 eval: detectBenchmarkContradictionV19 bat GPT-6 Luna', () => {
  const warnings = detectBenchmarkContradictionV19(0.92, 0.289, 'GPT-6 Luna');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /MAU THUAN BENCHMARK \(GPT-6 Luna\)/);
  // Hai benchmark deu tot -> khong canh bao.
  assert.deepEqual(detectBenchmarkContradictionV19(0.9, 0.85, 'X'), []);
  // Hai benchmark deu kem -> khong phai mau thuan, chi la kem.
  assert.deepEqual(detectBenchmarkContradictionV19(0.3, 0.2, 'X'), []);
});
