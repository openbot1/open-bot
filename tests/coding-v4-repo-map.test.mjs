/**
 * Tests for coding agent v4 — repo map PageRank v2 (v1.11, Doi T4):
 * `packages/core/src/codingV4/repoMapV4.ts` (weighted ranking:
 * PageRank + reference frequency + freshness, weighted map,
 * token-budget map, cache invalidation).
 *
 * Pure logic — no fs, no git. Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/coding-v4-repo-map.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCodingV2Graph,
} from '../packages/core/dist/codingV2/repoMapGraph.js';
import {
  buildCodingV4All,
  buildCodingV4CacheFile,
  buildCodingV4WeightedMap,
  checkCodingV4CacheFreshness,
  codingV4FreshnessScore,
  codingV4NormalizeLog,
  codingV4ReferenceTotals,
  codingV4TopFiles,
  normalizeCodingV4Weights,
  parseCodingV4Cache,
  planCodingV4Invalidation,
  rankCodingV4Files,
  rankCodingV4FilesForQuery,
  renderCodingV4BudgetMap,
  renderCodingV4QueryBudgetMap,
  serializeCodingV4Cache,
  CODING_V4_CACHE_VERSION,
  CODING_V4_DEFAULT_BUDGET_TOKENS,
} from '../packages/core/dist/codingV4/repoMapV4.js';

const NOW = 1_800_000_000_000; // fixed "now" for deterministic freshness
const DAY = 86_400_000;

function fileEntry(relPath, symbols, imports = [], mtimeMs = NOW) {
  return {
    relPath,
    language: 'typescript',
    mtimeMs,
    size: 100,
    symbols: symbols.map(([name, qualifiedName, kind = 'function', line = 1]) => ({
      kind,
      name,
      qualifiedName,
      line,
      column: 1,
      endLine: line,
    })),
    imports,
    hasError: false,
  };
}

/**
 * Fixture: a.ts defines alpha + Beta.save; b.ts imports a.ts and
 * mentions alpha 10x; c.ts isolated; d.ts imports b.ts, mentions gamma.
 */
function fixture() {
  const a = fileEntry('src/a.ts', [['alpha', 'alpha'], ['Beta', 'Beta', 'class'], ['save', 'Beta.save', 'method', 5]]);
  const b = fileEntry('src/b.ts', [['gamma', 'gamma']], ['src/a.ts']);
  const c = fileEntry('src/c.ts', [['delta', 'delta']]);
  const d = fileEntry('lib/d.ts', [['run', 'run']], ['src/b.ts']);
  const files = [a, b, c, d];
  const idents = new Map([
    ['src/b.ts', new Map([['alpha', 10], ['Beta', 2]])],
    ['lib/d.ts', new Map([['gamma', 3]])],
    ['src/a.ts', new Map()],
    ['src/c.ts', new Map()],
  ]);
  const graph = buildCodingV2Graph({ files, idents });
  return { files, idents, graph };
}

test('freshness: new file scores 1, half-life halves the score', () => {
  assert.equal(codingV4FreshnessScore(NOW, NOW), 1);
  assert.equal(codingV4FreshnessScore(NOW - 90 * DAY, NOW, 90), 0.5);
  assert.equal(codingV4FreshnessScore(NOW + DAY, NOW), 1); // future mtime clamps
  assert.ok(codingV4FreshnessScore(NOW - 365 * DAY, NOW, 90) < 0.1);
  assert.equal(codingV4FreshnessScore(NaN, NOW), 0);
});

test('weights: normalized to sum 1, invalid weights fall back to defaults', () => {
  const w = normalizeCodingV4Weights({ pageRank: 2, references: 2, freshness: 0 });
  assert.ok(Math.abs(w.pageRank + w.references + w.freshness - 1) < 1e-9);
  assert.equal(w.freshness, 0);
  const fallback = normalizeCodingV4Weights({ pageRank: -1, references: 0, freshness: 0 });
  assert.deepEqual(fallback, { pageRank: 0.5, references: 0.3, freshness: 0.2 });
  const partial = normalizeCodingV4Weights({ freshness: 1 });
  assert.ok(Math.abs(partial.pageRank + partial.references + partial.freshness - 1) < 1e-9);
});

test('reference totals: file whose symbols are mentioned most wins', () => {
  const { graph } = fixture();
  const totals = codingV4ReferenceTotals(graph);
  assert.ok((totals.get('src/a.ts') ?? 0) > (totals.get('src/b.ts') ?? 0));
  assert.ok((totals.get('src/b.ts') ?? 0) > 0); // gamma mentioned by d.ts
  assert.equal(totals.get('src/c.ts'), 0);
  const norm = codingV4NormalizeLog(totals);
  assert.equal(norm.get('src/a.ts'), 1); // max normalizes to 1
  assert.equal(norm.get('src/c.ts'), 0);
});

test('ranking: sorted desc, ranks 1..n, scores in [0,1], breakdown present', () => {
  const { graph, files } = fixture();
  const ranking = rankCodingV4Files(graph, files, { nowMs: NOW });
  assert.equal(ranking.ranks.length, 4);
  assert.deepEqual(ranking.ranks.map((r) => r.rank), [1, 2, 3, 4]);
  for (let i = 1; i < ranking.ranks.length; i += 1) {
    assert.ok(ranking.ranks[i - 1].score >= ranking.ranks[i].score);
  }
  for (const r of ranking.ranks) {
    assert.ok(r.score >= 0 && r.score <= 1, r.relPath);
    assert.ok(r.pageRankScore >= 0 && r.pageRankScore <= 1);
    assert.ok(r.referenceScore >= 0 && r.referenceScore <= 1);
    assert.ok(r.freshnessScore >= 0 && r.freshnessScore <= 1);
    assert.equal(typeof r.mtimeMs, 'number');
  }
  assert.equal(ranking.stats.files, 4);
  assert.equal(ranking.stats.referencedFiles, 2); // a.ts + b.ts
  assert.equal(codingV4TopFiles(ranking, 2).length, 2);
});

test('ranking: freshness-only weights rank the newest file first', () => {
  const old = fileEntry('src/old.ts', [['oldFn', 'oldFn']], [], NOW - 365 * DAY);
  const fresh = fileEntry('src/new.ts', [['newFn', 'newFn']], [], NOW);
  const files = [old, fresh];
  const graph = buildCodingV2Graph({ files, idents: new Map() });
  const ranking = rankCodingV4Files(graph, files, {
    nowMs: NOW,
    weights: { pageRank: 0, references: 0, freshness: 1 },
  });
  assert.equal(ranking.ranks[0].relPath, 'src/new.ts');
  assert.equal(ranking.ranks[1].relPath, 'src/old.ts');
});

test('ranking: references-only weights rank the most-mentioned file first', () => {
  const { graph, files } = fixture();
  const ranking = rankCodingV4Files(graph, files, {
    nowMs: NOW,
    weights: { pageRank: 0, references: 1, freshness: 0 },
  });
  assert.equal(ranking.ranks[0].relPath, 'src/a.ts');
});

test('weighted map: edges carry endpoint scores and sort by combined weight', () => {
  const { graph, files } = fixture();
  const map = buildCodingV4WeightedMap(graph, files, { nowMs: NOW });
  assert.ok(map.edges.length > 0);
  assert.equal(map.ranking.ranks.length, 4);
  for (let i = 1; i < map.edges.length; i += 1) {
    assert.ok(map.edges[i - 1].combinedWeight >= map.edges[i].combinedWeight);
  }
  for (const e of map.edges) {
    assert.ok(e.combinedWeight > 0);
    assert.ok(e.fromScore >= 0 && e.toScore >= 0);
    assert.ok(e.weight > 0);
  }
  assert.equal(map.stats.files, 4);
  const all = buildCodingV4All({ graph, files, options: { nowMs: NOW } });
  assert.equal(all.ranking.ranks.length, 4);
});

test('budget map: fits the budget, always keeps >= 1 file, reports cuts', () => {
  const { graph, files } = fixture();
  const big = renderCodingV4BudgetMap(graph, files, { budgetTokens: CODING_V4_DEFAULT_BUDGET_TOKENS, nowMs: NOW });
  assert.equal(big.truncated, false);
  assert.equal(big.includedFiles.length, 4);
  assert.ok(big.text.includes('v4 '));
  const small = renderCodingV4BudgetMap(graph, files, { budgetTokens: 25, nowMs: NOW });
  assert.ok(small.includedFiles.length >= 1);
  assert.ok(small.truncated);
  assert.ok(small.excludedFiles.length > 0);
  assert.equal(small.totalFiles, 4);
});

test('query budget map: matching files seed first, unknown query falls back', () => {
  const { graph, files } = fixture();
  const hit = renderCodingV4QueryBudgetMap(graph, files, 'alpha', { budgetTokens: 2000, nowMs: NOW });
  assert.equal(hit.fellBackToGlobal, false);
  assert.ok(hit.seedFiles.includes('src/a.ts'));
  assert.equal(hit.includedFiles[0], 'src/a.ts');
  const miss = renderCodingV4QueryBudgetMap(graph, files, 'zzzqqq', { budgetTokens: 2000, nowMs: NOW });
  assert.equal(miss.fellBackToGlobal, true);
  assert.deepEqual(miss.seedFiles, []);
});

test('invalidation: unchanged/changed/added/removed classified', () => {
  const prev = new Map([
    ['a.ts', { relPath: 'a.ts', mtimeMs: 1000, size: 10 }],
    ['b.ts', { relPath: 'b.ts', mtimeMs: 1000, size: 10 }],
    ['gone.ts', { relPath: 'gone.ts', mtimeMs: 1000, size: 10 }],
  ]);
  const curr = new Map([
    ['a.ts', { relPath: 'a.ts', mtimeMs: 1000, size: 10 }],
    ['b.ts', { relPath: 'b.ts', mtimeMs: 2000, size: 10 }], // changed mtime
    ['new.ts', { relPath: 'new.ts', mtimeMs: 1000, size: 5 }], // added
  ]);
  const plan = planCodingV4Invalidation(prev, curr);
  assert.deepEqual(plan.unchanged, ['a.ts']);
  assert.deepEqual(plan.changed, ['b.ts']);
  assert.deepEqual(plan.added, ['new.ts']);
  assert.deepEqual(plan.removed, ['gone.ts']);
  assert.equal(plan.invalidatedCount, 3);
  assert.equal(plan.needsRebuild, true);
  const fresh = planCodingV4Invalidation(prev, prev);
  assert.equal(fresh.needsRebuild, false);
  assert.equal(fresh.invalidatedCount, 0);
});

test('cache v4: serialize/parse round trip, freshness check, bad version rejected', () => {
  const { graph, files } = fixture();
  const ranking = rankCodingV4Files(graph, files, { nowMs: NOW });
  const cache = buildCodingV4CacheFile('/tmp/ws', graph, files, ranking, 3);
  assert.equal(cache.version, CODING_V4_CACHE_VERSION);
  assert.equal(cache.topRanks.length, 4);
  assert.equal(Object.keys(cache.fingerprints).length, 4);
  const parsed = parseCodingV4Cache(serializeCodingV4Cache(cache), '/tmp/ws');
  assert.ok('cache' in parsed);
  if ('cache' in parsed) {
    assert.equal(parsed.cache.files, 4);
    const plan = checkCodingV4CacheFreshness(parsed.cache, files);
    assert.equal(plan.needsRebuild, false);
    const staleFiles = files.map((f) => (f.relPath === 'src/a.ts' ? { ...f, mtimeMs: NOW + 5000 } : f));
    const plan2 = checkCodingV4CacheFreshness(parsed.cache, staleFiles);
    assert.deepEqual(plan2.changed, ['src/a.ts']);
    assert.equal(plan2.needsRebuild, true);
  }
  const wrongVersion = parseCodingV4Cache(JSON.stringify({ ...cache, version: 3 }), '/tmp/ws');
  assert.ok('error' in wrongVersion);
  const wrongRoot = parseCodingV4Cache(serializeCodingV4Cache(cache), '/tmp/other');
  assert.ok('error' in wrongRoot);
  const broken = parseCodingV4Cache('not json', '/tmp/ws');
  assert.ok('error' in broken);
});

test('query ranking: Personalized PageRank lifts the matching file to the top', () => {
  const { graph, files } = fixture();
  const global = rankCodingV4Files(graph, files, { nowMs: NOW });
  // c.ts is isolated: it is last globally.
  assert.equal(global.ranks[global.ranks.length - 1].relPath, 'src/c.ts');
  // With PageRank-only weights the personalized run must put c.ts first:
  // all teleport mass starts on c.ts / its symbol `delta`.
  const prOnly = rankCodingV4FilesForQuery(graph, files, 'delta', {
    nowMs: NOW,
    weights: { pageRank: 1, references: 0, freshness: 0 },
  });
  assert.equal(prOnly.fellBackToGlobal, false);
  assert.ok(prOnly.seedFiles.includes('src/c.ts'));
  assert.equal(prOnly.ranking.ranks[0].relPath, 'src/c.ts');
  // With default weights c.ts still climbs (reference/freshness of the
  // hub file a.ts keep it competitive, so only the climb is asserted).
  const { ranking, seedFiles, fellBackToGlobal } = rankCodingV4FilesForQuery(graph, files, 'delta', { nowMs: NOW });
  assert.equal(fellBackToGlobal, false);
  assert.ok(seedFiles.includes('src/c.ts'));
  assert.equal(ranking.ranks.length, 4);
  const globalRankOfC = global.ranks.find((r) => r.relPath === 'src/c.ts').rank;
  const queryRankOfC = ranking.ranks.find((r) => r.relPath === 'src/c.ts').rank;
  assert.ok(queryRankOfC < globalRankOfC, `c.ts should climb: global ${globalRankOfC} -> query ${queryRankOfC}`);
  const miss = rankCodingV4FilesForQuery(graph, files, 'zzzqqq', { nowMs: NOW });
  assert.equal(miss.fellBackToGlobal, true);
  assert.deepEqual(miss.ranking.ranks.map((r) => r.relPath), global.ranks.map((r) => r.relPath));
});
