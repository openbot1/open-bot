/**
 * Tests for coding agent v3 — repo map v3 (v1.10, Đội T4):
 * `packages/core/src/codingV3/repoMapV3.ts` (call edges file->file,
 * module graph, token-budget map, v3 cache serialize/parse).
 *
 * Pure logic — no fs, no git. Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/coding-v3-repo-map.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCodingV2Graph,
} from '../packages/core/dist/codingV2/repoMapGraph.js';
import {
  buildCodingV3All,
  buildCodingV3CacheSummary,
  buildCodingV3CallGraph,
  buildCodingV3ModuleGraph,
  codingV3ModuleOf,
  codingV3TopCallersOf,
  codingV3TopCallsFrom,
  estimateCodingV3Tokens,
  parseCodingV3Cache,
  renderCodingV3BudgetMap,
  renderCodingV3QueryBudgetMap,
  serializeCodingV3Cache,
  CODING_V3_CACHE_VERSION,
  CODING_V3_DEFAULT_BUDGET_TOKENS,
} from '../packages/core/dist/codingV3/repoMapV3.js';

function fileEntry(relPath, symbols, imports = []) {
  return {
    relPath,
    language: 'typescript',
    mtimeMs: 1000,
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
 * Fixture: a.ts defines alpha + Beta (method save); b.ts imports a.ts
 * and mentions alpha + Beta.save; c.ts is isolated; d.ts (other module)
 * imports b.ts and mentions gamma.
 */
function fixture() {
  const a = fileEntry('packages/core/src/a.ts', [
    ['alpha', 'alpha'],
    ['Beta', 'Beta', 'class'],
    ['save', 'Beta.save', 'method', 5],
  ]);
  const b = fileEntry('packages/core/src/b.ts', [['gamma', 'gamma']], ['packages/core/src/a.ts']);
  const c = fileEntry('packages/core/src/c.ts', [['delta', 'delta']]);
  const d = fileEntry('apps/desktop/src/d.ts', [['run', 'run']], ['packages/core/src/b.ts']);
  const idents = new Map([
    ['packages/core/src/a.ts', new Map([['alpha', 1]])],
    ['packages/core/src/b.ts', new Map([['alpha', 4], ['Beta', 2], ['save', 1]])],
    ['packages/core/src/c.ts', new Map([['delta', 1]])],
    ['apps/desktop/src/d.ts', new Map([['gamma', 3]])],
  ]);
  return { files: [a, b, c, d], idents };
}

function fixtureGraph() {
  const { files, idents } = fixture();
  return { files, graph: buildCodingV2Graph({ files, idents }) };
}

test('moduleOf: packages/apps group by 2 segments, plain dirs by 1, root files to "."', () => {
  assert.equal(codingV3ModuleOf('packages/core/src/a.ts'), 'packages/core');
  assert.equal(codingV3ModuleOf('apps/desktop/src/d.ts'), 'apps/desktop');
  assert.equal(codingV3ModuleOf('tools/x.ts'), 'tools');
  assert.equal(codingV3ModuleOf('README.md'), '.');
  assert.equal(codingV3ModuleOf('packages/core/a.ts'), 'packages/core');
});

test('call graph: b calls a (import + symbols), d calls b, c is isolated', () => {
  const { graph } = fixtureGraph();
  const callGraph = buildCodingV3CallGraph(graph);
  assert.ok(callGraph.edges.length >= 2, `expected >= 2 call edges, got ${callGraph.edges.length}`);
  const bToA = callGraph.edges.find((e) => e.from === 'packages/core/src/b.ts' && e.to === 'packages/core/src/a.ts');
  assert.ok(bToA, 'b -> a call edge exists');
  assert.ok(bToA.importWeight > 0, 'b imports a');
  assert.ok(bToA.callWeight > 0, 'b mentions symbols of a');
  assert.equal(bToA.distinctSymbolsCalled, 3, 'b mentions alpha, Beta, save');
  const dToB = callGraph.edges.find((e) => e.from === 'apps/desktop/src/d.ts' && e.to === 'packages/core/src/b.ts');
  assert.ok(dToB, 'd -> b call edge exists');
  assert.equal(dToB.callWeight, Math.sqrt(3), 'call weight = sqrt(3 mentions of gamma)');
  assert.equal(callGraph.edges.some((e) => e.from === 'packages/core/src/c.ts'), false);
  assert.equal(callGraph.edges.some((e) => e.to === 'packages/core/src/c.ts'), false);
  assert.equal(callGraph.stats.bothEdges, 2, 'b->a and d->b have both import and call weight');
});

test('call graph: topCallsFrom / topCallersOf are weight-sorted', () => {
  const { graph } = fixtureGraph();
  const callGraph = buildCodingV3CallGraph(graph);
  const fromB = codingV3TopCallsFrom(callGraph, 'packages/core/src/b.ts');
  assert.equal(fromB.length, 1);
  assert.equal(fromB[0].to, 'packages/core/src/a.ts');
  const callersOfA = codingV3TopCallersOf(callGraph, 'packages/core/src/a.ts');
  assert.equal(callersOfA.length, 1);
  assert.equal(callersOfA[0].from, 'packages/core/src/b.ts');
  assert.deepEqual(codingV3TopCallsFrom(callGraph, 'packages/core/src/c.ts'), []);
});

test('module graph: scores sum to 1, top module is packages/core, cross-module edge exists', () => {
  const { files, graph } = fixtureGraph();
  const callGraph = buildCodingV3CallGraph(graph);
  const moduleGraph = buildCodingV3ModuleGraph(graph, callGraph, files);
  assert.equal(moduleGraph.modules.length, 2);
  const total = moduleGraph.modules.reduce((sum, m) => sum + m.score, 0);
  assert.ok(Math.abs(total - 1) < 1e-9, `module scores sum to 1, got ${total}`);
  assert.equal(moduleGraph.modules[0].module, 'packages/core');
  assert.equal(moduleGraph.modules[0].files, 3);
  assert.equal(moduleGraph.modules[1].module, 'apps/desktop');
  assert.equal(moduleGraph.modules[1].files, 1);
  assert.equal(moduleGraph.edges.length, 1);
  assert.equal(moduleGraph.edges[0].from, 'apps/desktop');
  assert.equal(moduleGraph.edges[0].to, 'packages/core');
  assert.equal(moduleGraph.edges[0].fileEdges, 1);
});

test('budget map: fits budget, estimates tokens as chars/4, reports cut files', () => {
  const { files, graph } = fixtureGraph();
  const tiny = renderCodingV3BudgetMap(graph, files, { budgetTokens: 40 });
  assert.ok(tiny.estimatedTokens <= 60, `tiny map ~${tiny.estimatedTokens} tokens`);
  assert.ok(tiny.includedFiles.length >= 1, 'at least 1 file always kept');
  assert.equal(tiny.truncated, true, 'tiny budget truncates');
  assert.ok(tiny.excludedFiles.length > 0);
  assert.equal(tiny.totalFiles, 4);
  assert.ok(tiny.text.includes(tiny.includedFiles[0]), 'included file is rendered');

  const big = renderCodingV3BudgetMap(graph, files, { budgetTokens: 100000 });
  assert.equal(big.truncated, false);
  assert.equal(big.includedFiles.length, 4);
  assert.equal(big.excludedFiles.length, 0);
  assert.equal(estimateCodingV3Tokens(big.text), big.estimatedTokens);
  assert.equal(estimateCodingV3Tokens('abcd'), 1);
  assert.equal(estimateCodingV3Tokens('abcde'), 2);
});

test('budget map: default budget is 2000 tokens', () => {
  assert.equal(CODING_V3_DEFAULT_BUDGET_TOKENS, 2000);
  const { files, graph } = fixtureGraph();
  const map = renderCodingV3BudgetMap(graph, files);
  assert.equal(map.budgetTokens, 2000);
  assert.equal(map.truncated, false);
});

test('query budget map: seed file ranks first, unknown query falls back to global', () => {
  const { files, graph } = fixtureGraph();
  const hit = renderCodingV3QueryBudgetMap(graph, files, 'gamma', { budgetTokens: 100000 });
  assert.equal(hit.fellBackToGlobal, false);
  assert.ok(hit.seedFiles.includes('packages/core/src/b.ts'));
  assert.equal(hit.includedFiles[0], 'packages/core/src/b.ts', 'seed file defining gamma ranks first');
  const miss = renderCodingV3QueryBudgetMap(graph, files, 'zzzzqqq', { budgetTokens: 100000 });
  assert.equal(miss.fellBackToGlobal, true);
  assert.deepEqual(miss.seedFiles, []);
});

test('v3 cache: round-trip serialize/parse, version/root mismatch rejected', () => {
  const { files, graph } = fixtureGraph();
  const callGraph = buildCodingV3CallGraph(graph);
  const moduleGraph = buildCodingV3ModuleGraph(graph, callGraph, files);
  const summary = buildCodingV3CacheSummary('/repo', graph, callGraph, moduleGraph);
  assert.equal(summary.version, CODING_V3_CACHE_VERSION);
  assert.equal(summary.files, 4);
  assert.equal(summary.modules.length, 2);
  const text = serializeCodingV3Cache(summary);
  const parsed = parseCodingV3Cache(text, '/repo');
  assert.ok(!('error' in parsed), 'round-trip parses');
  assert.equal(parsed.cache.rootDir, '/repo');
  assert.equal(parsed.cache.modules[0].module, 'packages/core');
  assert.ok('error' in parseCodingV3Cache(text, '/other'), 'wrong rootDir rejected');
  assert.ok('error' in parseCodingV3Cache('not json', '/repo'), 'broken JSON rejected');
  assert.ok(
    'error' in parseCodingV3Cache(JSON.stringify({ ...summary, version: 99 }), '/repo'),
    'wrong version rejected',
  );
});

test('buildCodingV3All: graph + call graph + module graph in one call', () => {
  const { files, idents } = fixture();
  const all = buildCodingV3All({ files, idents });
  assert.equal(all.graph.stats.files, 4);
  assert.ok(all.callGraph.edges.length >= 2);
  assert.equal(all.moduleGraph.modules.length, 2);
});
