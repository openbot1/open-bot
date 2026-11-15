/**
 * Tests for coding agent v2 — repo map graph (v1.08, Đội T2):
 * `packages/core/src/codingV2/repoMapGraph.ts` (symbol-level graph,
 * PageRank with query personalization, incremental classification,
 * disk-cache serialize/parse, query + symbol detail).
 *
 * Pure logic — no tree-sitter, no fs, no git. Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/coding-v2-repo-map-graph.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCodingV2Graph,
  classifyCodingV2Files,
  codingV2PageRank,
  codingV2SymbolDetail,
  mergeCodingV2Entries,
  parseCodingV2Cache,
  queryCodingV2Graph,
  rankCodingV2Files,
  rankCodingV2Symbols,
  serializeCodingV2Cache,
  CODING_V2_CACHE_VERSION,
} from '../packages/core/dist/codingV2/repoMapGraph.js';

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

/** a.ts defines alpha + Beta; b.ts imports a.ts and calls alpha; c.ts is isolated. */
function fixtureEntries() {
  const a = fileEntry('src/a.ts', [
    ['alpha', 'alpha'],
    ['Beta', 'Beta', 'class'],
    ['save', 'Beta.save', 'method', 5],
  ]);
  const b = fileEntry('src/b.ts', [['gamma', 'gamma']], ['src/a.ts']);
  const c = fileEntry('src/c.ts', [['delta', 'delta']]);
  return [a, b, c];
}

function fixtureIdents() {
  return new Map([
    ['src/a.ts', new Map([['alpha', 1]])],
    ['src/b.ts', new Map([['alpha', 3], ['Beta', 2], ['save', 1]])],
    ['src/c.ts', new Map([['delta', 1]])],
  ]);
}

function fixtureGraph() {
  return buildCodingV2Graph({ files: fixtureEntries(), idents: fixtureIdents() });
}

// --- PageRank ---------------------------------------------------------------

test('pagerank: hub file outranks isolated file; scores sum to 1', () => {
  const graph = fixtureGraph();
  assert.equal(graph.stats.files, 3);
  assert.equal(graph.stats.symbols, 5);
  assert.ok(graph.stats.referenceEdges > 0, 'expected reference edges b -> alpha/Beta/save');
  assert.ok(graph.stats.importEdges >= 1, 'expected import edge b -> a');
  const ranked = rankCodingV2Files(graph, 10);
  assert.equal(ranked[0].relPath, 'src/a.ts', 'a.ts is referenced by b.ts, must rank first');
  assert.equal(ranked[ranked.length - 1].relPath, 'src/c.ts', 'isolated c.ts ranks last');
  const total = [...graph.fileScores.values()].reduce((s, v) => s + v, 0);
  assert.ok(Math.abs(total - 1) < 1e-6, `file scores must sum to 1, got ${total}`);
});

test('pagerank: empty graph does not crash; single node scores 1', () => {
  const empty = buildCodingV2Graph({ files: [], idents: new Map() });
  assert.equal(empty.stats.files, 0);
  assert.equal(rankCodingV2Files(empty).length, 0);
  const solo = buildCodingV2Graph({
    files: [fileEntry('only.ts', [['solo', 'solo']])],
    idents: new Map(),
  });
  assert.equal(rankCodingV2Files(solo, 1)[0].relPath, 'only.ts');
  assert.ok(Math.abs(rankCodingV2Files(solo, 1)[0].score - 1) < 1e-9);
});

test('pagerank: personalization pulls seed nodes up', () => {
  const nodes = ['a', 'b', 'c'];
  const edges = [
    { from: 'a', to: 'b', weight: 1, kind: 'imports' },
    { from: 'b', to: 'c', weight: 1, kind: 'imports' },
    { from: 'c', to: 'a', weight: 1, kind: 'imports' },
  ];
  const plain = codingV2PageRank(nodes, edges);
  const seeded = codingV2PageRank(nodes, edges, {
    personalization: new Map([['c', 1]]),
  });
  assert.ok(
    (seeded.scores.get('c') ?? 0) > (plain.scores.get('c') ?? 0),
    'seeded node c must score higher than in the uniform run',
  );
});

// --- Query ------------------------------------------------------------------

test('query: "alpha" seeds a.ts first, b.ts as related', () => {
  const graph = fixtureGraph();
  const result = queryCodingV2Graph(graph, fixtureEntries(), 'alpha', { limit: 10 });
  assert.equal(result.fellBackToGlobal, false);
  assert.ok(result.seedFiles.includes('src/a.ts'));
  assert.equal(result.files[0].relPath, 'src/a.ts');
  assert.equal(result.files[0].match, 'seed');
  const b = result.files.find((f) => f.relPath === 'src/b.ts');
  assert.ok(b, 'b.ts references alpha, must appear');
  assert.equal(b.match, 'related');
  assert.ok(result.symbols.some((s) => s.qualifiedName === 'alpha'));
});

test('query: file-path fragment seeds by path', () => {
  const files = [
    fileEntry('core/engine.ts', [['run', 'run']]),
    fileEntry('core/helper.ts', [['help', 'help']]),
  ];
  const graph = buildCodingV2Graph({
    files,
    idents: new Map([
      ['core/engine.ts', new Map()],
      ['core/helper.ts', new Map()],
    ]),
  });
  const result = queryCodingV2Graph(graph, files, 'engine', { limit: 10 });
  assert.equal(result.fellBackToGlobal, false);
  assert.ok(result.seedFiles.includes('core/engine.ts'));
  assert.equal(result.files[0].relPath, 'core/engine.ts');
  assert.equal(result.files[0].match, 'seed');
});

test('query: unknown term falls back to the global ranking', () => {
  const graph = fixtureGraph();
  const result = queryCodingV2Graph(graph, fixtureEntries(), 'zzzzqqq', { limit: 10 });
  assert.equal(result.fellBackToGlobal, true);
  assert.equal(result.files[0].relPath, 'src/a.ts', 'global ranking still puts a.ts first');
});

test('query: empty query falls back to the global ranking', () => {
  const graph = fixtureGraph();
  const result = queryCodingV2Graph(graph, fixtureEntries(), '', { limit: 2 });
  assert.equal(result.fellBackToGlobal, true);
  assert.equal(result.files.length, 2);
});

test('query: top symbols per file are the file’s own symbols', () => {
  const graph = fixtureGraph();
  const result = queryCodingV2Graph(graph, fixtureEntries(), 'alpha', { limit: 10 });
  const a = result.files.find((f) => f.relPath === 'src/a.ts');
  assert.ok(a);
  assert.ok(a.topSymbols.length > 0);
  assert.ok(a.topSymbols.every((s) => ['alpha', 'Beta', 'Beta.save'].includes(s.qualifiedName)));
});

// --- Symbol detail ----------------------------------------------------------

test('symbol detail: alpha defined in a.ts, referenced by b.ts', () => {
  const graph = fixtureGraph();
  const detail = codingV2SymbolDetail(graph, fixtureEntries(), 'alpha');
  assert.equal(detail.found, true);
  assert.equal(detail.matches.length, 1);
  assert.equal(detail.matches[0].file, 'src/a.ts');
  assert.equal(detail.matches[0].line, 1);
  assert.deepEqual(
    detail.matches[0].referencedBy.map((r) => r.file),
    ['src/b.ts'],
  );
});

test('symbol detail: unknown name reports not found; empty name reports not found', () => {
  const graph = fixtureGraph();
  assert.equal(codingV2SymbolDetail(graph, fixtureEntries(), 'nope').found, false);
  assert.equal(codingV2SymbolDetail(graph, fixtureEntries(), '  ').found, false);
});

test('symbol detail: short name matches qualified name (Beta.save)', () => {
  const graph = fixtureGraph();
  const detail = codingV2SymbolDetail(graph, fixtureEntries(), 'Beta.save');
  assert.equal(detail.found, true);
  assert.equal(detail.matches[0].qualifiedName, 'Beta.save');
});

// --- Ranking helpers ----------------------------------------------------------

test('rank symbols: most-referenced symbol first', () => {
  const graph = fixtureGraph();
  const ranked = rankCodingV2Symbols(graph, 10);
  assert.ok(ranked.length >= 3);
  // alpha is referenced 3x from b.ts — it must outrank isolated delta.
  const alpha = ranked.find((s) => s.symbol === 'alpha');
  const delta = ranked.find((s) => s.symbol === 'delta');
  assert.ok(alpha && delta && alpha.score > delta.score);
});

// --- Incremental classification + merge -------------------------------------

test('incremental: unchanged / changed / added / removed classification', () => {
  const old = new Map([
    ['a.ts', fileEntry('a.ts', [['x', 'x']])],
    ['b.ts', { ...fileEntry('b.ts', [['y', 'y']]), mtimeMs: 1000, size: 100 }],
    ['gone.ts', fileEntry('gone.ts', [['z', 'z']])],
  ]);
  const fingerprints = [
    { relPath: 'a.ts', mtimeMs: 1000, size: 100 },
    { relPath: 'b.ts', mtimeMs: 2000, size: 100 },
    { relPath: 'new.ts', mtimeMs: 3000, size: 50 },
  ];
  const plan = classifyCodingV2Files(old, fingerprints);
  assert.deepEqual(plan.unchanged, ['a.ts']);
  assert.deepEqual(plan.changed, ['b.ts']);
  assert.deepEqual(plan.added, ['new.ts']);
  assert.deepEqual(plan.removed, ['gone.ts']);
});

test('incremental: merge replaces changed, drops removed, keeps the rest', () => {
  const old = new Map([
    ['a.ts', fileEntry('a.ts', [['x', 'x']])],
    ['gone.ts', fileEntry('gone.ts', [['z', 'z']])],
  ]);
  const fresh = [{ ...fileEntry('a.ts', [['x2', 'x2']]), mtimeMs: 2000 }];
  const merged = mergeCodingV2Entries(old, fresh, ['gone.ts']);
  assert.equal(merged.size, 1);
  assert.equal(merged.get('a.ts').symbols[0].name, 'x2');
  assert.equal(merged.has('gone.ts'), false);
});

// --- Disk cache ---------------------------------------------------------------

test('cache: serialize -> parse round-trip keeps entries', () => {
  const cache = {
    version: CODING_V2_CACHE_VERSION,
    rootDir: '/repo',
    updatedAt: new Date().toISOString(),
    files: Object.fromEntries(fixtureEntries().map((f) => [f.relPath, f])),
  };
  const text = serializeCodingV2Cache(cache);
  const parsed = parseCodingV2Cache(text, '/repo');
  assert.ok('cache' in parsed, 'valid cache must parse');
  if ('cache' in parsed) {
    assert.equal(Object.keys(parsed.cache.files).length, 3);
    assert.equal(parsed.cache.files['src/a.ts'].symbols.length, 3);
  }
});

test('cache: wrong version / wrong root / broken JSON are rejected, not thrown', () => {
  const cache = {
    version: CODING_V2_CACHE_VERSION,
    rootDir: '/repo',
    updatedAt: new Date().toISOString(),
    files: {},
  };
  const good = serializeCodingV2Cache(cache);
  assert.ok('error' in parseCodingV2Cache(good.replace(`"version": ${CODING_V2_CACHE_VERSION}`, '"version": 1'), '/repo'));
  assert.ok('error' in parseCodingV2Cache(good, '/other-root'));
  assert.ok('error' in parseCodingV2Cache('{not json', '/repo'));
  assert.ok('error' in parseCodingV2Cache('[]', '/repo'));
});

test('cache: malformed entries are skipped, good ones kept', () => {
  const goodEntry = fileEntry('good.ts', [['g', 'g']]);
  const text = JSON.stringify({
    version: CODING_V2_CACHE_VERSION,
    rootDir: '/repo',
    updatedAt: new Date().toISOString(),
    files: {
      'good.ts': goodEntry,
      'bad.ts': { relPath: 'bad.ts', language: 'typescript' },
    },
  });
  const parsed = parseCodingV2Cache(text, '/repo');
  assert.ok('cache' in parsed);
  if ('cache' in parsed) {
    assert.equal(Object.keys(parsed.cache.files).length, 1);
    assert.ok(parsed.cache.files['good.ts']);
  }
});
