/**
 * Tests for repo map v5 — incremental index (v1.13, Doi T3):
 * `packages/core/src/codingV5/incrementalIndex.ts` (FNV-1a content
 * hash, metadata-only vs changed classification, dependency
 * invalidation, disk cache v5 round-trip, record merge).
 *
 * Pure logic — no fs, no git. Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/coding-v5-incremental.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCodingV5Importers,
  buildCodingV5IndexCacheFile,
  checkCodingV5IndexFreshness,
  codingV5ContentHash,
  codingV5ContentHashOfParts,
  codingV5RecordOf,
  mergeCodingV5Records,
  parseCodingV5IndexCache,
  planCodingV5Incremental,
  serializeCodingV5IndexCache,
  summarizeCodingV5Index,
  CODING_V5_INDEX_CACHE_VERSION,
} from '../packages/core/dist/codingV5/incrementalIndex.js';

function record(relPath, { mtimeMs = 1000, size = 10, contentHash = 'aaaa', symbols = 2, imports = [], hasError = false } = {}) {
  return { relPath, mtimeMs, size, contentHash, symbols, imports, hasError };
}

function fp(relPath, mtimeMs = 1000, size = 10) {
  return { relPath, mtimeMs, size };
}

test('content hash: deterministic, changes with content, stable for parts', () => {
  const h1 = codingV5ContentHash('export function alpha() {}');
  const h2 = codingV5ContentHash('export function alpha() {}');
  const h3 = codingV5ContentHash('export function beta() {}');
  assert.equal(h1, h2);
  assert.notEqual(h1, h3);
  assert.match(h1, /^[0-9a-f]{16}$/);
  assert.equal(codingV5ContentHashOfParts(['abc', 'def']), codingV5ContentHash('abcdef'));
  assert.equal(codingV5ContentHash(''), codingV5ContentHash(''));
  assert.notEqual(codingV5ContentHash('a'), codingV5ContentHash(''));
});

test('plan: unchanged files stay unchanged', () => {
  const plan = planCodingV5Incremental({
    current: new Map([['a.ts', fp('a.ts')], ['b.ts', fp('b.ts')]]),
    previous: new Map([['a.ts', record('a.ts')], ['b.ts', record('b.ts')]]),
  });
  assert.deepEqual(plan.unchanged, ['a.ts', 'b.ts']);
  assert.deepEqual(plan.changed, []);
  assert.deepEqual(plan.added, []);
  assert.deepEqual(plan.removed, []);
  assert.equal(plan.needsRebuild, false);
  assert.equal(plan.invalidatedCount, 0);
});

test('plan: mtime changed but same content hash is metadata-only, not changed', () => {
  const plan = planCodingV5Incremental({
    current: new Map([['a.ts', fp('a.ts', 2000, 10)]]),
    contentHashes: new Map([['a.ts', 'aaaa']]),
    previous: new Map([['a.ts', record('a.ts', { mtimeMs: 1000 })]]),
  });
  assert.deepEqual(plan.metadataOnly, ['a.ts']);
  assert.deepEqual(plan.changed, []);
  assert.equal(plan.needsRebuild, true); // fingerprint still needs updating on disk
});

test('plan: mtime changed with a different hash is changed', () => {
  const plan = planCodingV5Incremental({
    current: new Map([['a.ts', fp('a.ts', 2000, 12)]]),
    contentHashes: new Map([['a.ts', 'bbbb']]),
    previous: new Map([['a.ts', record('a.ts', { mtimeMs: 1000 })]]),
  });
  assert.deepEqual(plan.changed, ['a.ts']);
  assert.deepEqual(plan.metadataOnly, []);
});

test('plan: mtime changed with no hash available is changed (fail safe)', () => {
  const plan = planCodingV5Incremental({
    current: new Map([['a.ts', fp('a.ts', 2000, 10)]]),
    previous: new Map([['a.ts', record('a.ts', { mtimeMs: 1000 })]]),
  });
  assert.deepEqual(plan.changed, ['a.ts']);
});

test('plan: added and removed files are classified', () => {
  const plan = planCodingV5Incremental({
    current: new Map([['a.ts', fp('a.ts')], ['c.ts', fp('c.ts')]]),
    previous: new Map([['a.ts', record('a.ts')], ['b.ts', record('b.ts')]]),
  });
  assert.deepEqual(plan.added, ['c.ts']);
  assert.deepEqual(plan.removed, ['b.ts']);
  assert.deepEqual(plan.unchanged, ['a.ts']);
});

test('plan: dependency invalidation spreads to importers, transitively, up to depth', () => {
  // a <- b <- c <- d (d imports c, c imports b, b imports a).
  const previous = new Map([
    ['a.ts', record('a.ts', { imports: [] })],
    ['b.ts', record('b.ts', { imports: ['a.ts'] })],
    ['c.ts', record('c.ts', { imports: ['b.ts'] })],
    ['d.ts', record('d.ts', { imports: ['c.ts'] })],
  ]);
  const changedA = planCodingV5Incremental({
    current: new Map([
      ['a.ts', fp('a.ts', 2000, 11)],
      ['b.ts', fp('b.ts')],
      ['c.ts', fp('c.ts')],
      ['d.ts', fp('d.ts')],
    ]),
    contentHashes: new Map([['a.ts', 'zzzz']]),
    previous,
    invalidationDepth: 2,
  });
  assert.deepEqual(changedA.changed, ['a.ts']);
  assert.deepEqual(changedA.invalidatedByDependency, ['b.ts', 'c.ts']); // depth 2: b, c — not d
  assert.equal(changedA.invalidatedCount, 3);
  const deep = planCodingV5Incremental({
    current: new Map([
      ['a.ts', fp('a.ts', 2000, 11)],
      ['b.ts', fp('b.ts')],
      ['c.ts', fp('c.ts')],
      ['d.ts', fp('d.ts')],
    ]),
    contentHashes: new Map([['a.ts', 'zzzz']]),
    previous,
    invalidationDepth: 10,
  });
  assert.deepEqual(deep.invalidatedByDependency, ['b.ts', 'c.ts', 'd.ts']);
  const shallow = planCodingV5Incremental({
    current: new Map([
      ['a.ts', fp('a.ts', 2000, 11)],
      ['b.ts', fp('b.ts')],
      ['c.ts', fp('c.ts')],
      ['d.ts', fp('d.ts')],
    ]),
    contentHashes: new Map([['a.ts', 'zzzz']]),
    previous,
    invalidationDepth: 0,
  });
  assert.deepEqual(shallow.invalidatedByDependency, []);
});

test('plan: a removed file invalidates its importers', () => {
  const previous = new Map([
    ['a.ts', record('a.ts')],
    ['b.ts', record('b.ts', { imports: ['a.ts'] })],
  ]);
  const plan = planCodingV5Incremental({
    current: new Map([['b.ts', fp('b.ts')]]),
    previous,
  });
  assert.deepEqual(plan.removed, ['a.ts']);
  assert.deepEqual(plan.invalidatedByDependency, ['b.ts']);
});

test('plan: accepts plain objects as well as Maps', () => {
  const plan = planCodingV5Incremental({
    current: { 'a.ts': fp('a.ts') },
    previous: { 'a.ts': record('a.ts') },
  });
  assert.deepEqual(plan.unchanged, ['a.ts']);
});

test('importers graph: built from records, sorted, deduped', () => {
  const importers = buildCodingV5Importers({
    'a.ts': record('a.ts', { imports: [] }),
    'b.ts': record('b.ts', { imports: ['a.ts'] }),
    'c.ts': record('c.ts', { imports: ['a.ts', 'b.ts'] }),
  });
  assert.deepEqual(importers.get('a.ts'), ['b.ts', 'c.ts']);
  assert.deepEqual(importers.get('b.ts'), ['c.ts']);
  assert.deepEqual(importers.get('c.ts'), []);
});

test('index cache: serialize/parse round-trip keeps records and importers', () => {
  const records = new Map([
    ['a.ts', record('a.ts', { imports: [] })],
    ['b.ts', record('b.ts', { imports: ['a.ts'], symbols: 5 })],
  ]);
  const cache = buildCodingV5IndexCacheFile('/repo', records);
  assert.equal(cache.version, CODING_V5_INDEX_CACHE_VERSION);
  assert.equal(cache.files, 2);
  assert.deepEqual(cache.importers['a.ts'], ['b.ts']);
  const text = serializeCodingV5IndexCache(cache);
  const parsed = parseCodingV5IndexCache(text, '/repo');
  assert.ok(!('error' in parsed), JSON.stringify(parsed));
  assert.equal(parsed.cache.files, 2);
  assert.equal(parsed.cache.records['b.ts']?.symbols, 5);
  assert.deepEqual(parsed.cache.importers['a.ts'], ['b.ts']);
  const summary = summarizeCodingV5Index(parsed.cache);
  assert.equal(summary.files, 2);
  assert.equal(summary.symbols, 7);
  assert.equal(summary.imports, 1);
});

test('index cache: wrong version / wrong root / broken JSON are errors, not crashes', () => {
  const cache = buildCodingV5IndexCacheFile('/repo', new Map([['a.ts', record('a.ts')]]));
  const text = serializeCodingV5IndexCache(cache);
  assert.ok('error' in parseCodingV5IndexCache(text, '/other'));
  assert.ok('error' in parseCodingV5IndexCache('not json', '/repo'));
  const wrongVersion = text.replace(`"version": ${CODING_V5_INDEX_CACHE_VERSION}`, '"version": 4');
  assert.ok('error' in parseCodingV5IndexCache(wrongVersion, '/repo'));
  assert.ok('error' in parseCodingV5IndexCache('{"version": 5}', '/repo'));
});

test('merge records: fresh replace, removed drop, metadata-only updates fingerprint', () => {
  const previous = new Map([
    ['a.ts', record('a.ts', { mtimeMs: 1000 })],
    ['b.ts', record('b.ts')],
    ['gone.ts', record('gone.ts')],
  ]);
  const merged = mergeCodingV5Records(
    previous,
    [record('a.ts', { mtimeMs: 2000, contentHash: 'bbbb', symbols: 9 })],
    ['gone.ts'],
    [fp('b.ts', 3000, 10)],
  );
  assert.equal(merged.get('a.ts')?.mtimeMs, 2000);
  assert.equal(merged.get('a.ts')?.symbols, 9);
  assert.equal(merged.get('b.ts')?.mtimeMs, 3000);
  assert.equal(merged.has('gone.ts'), false);
  assert.equal(merged.size, 2);
});

test('record of: built from a v2 entry plus content hash', () => {
  const entry = {
    relPath: 'a.ts',
    language: 'typescript',
    mtimeMs: 1234,
    size: 55,
    symbols: [{ kind: 'function', name: 'f', qualifiedName: 'f', line: 1, column: 1, endLine: 2 }],
    imports: ['b.ts', 'a.ts'],
    hasError: false,
  };
  const rec = codingV5RecordOf(entry, 'deadbeef');
  assert.equal(rec.contentHash, 'deadbeef');
  assert.equal(rec.symbols, 1);
  assert.deepEqual(rec.imports, ['a.ts', 'b.ts']);
});

test('check freshness: cache matches current entries', () => {
  const records = new Map([['a.ts', record('a.ts', { mtimeMs: 1000, size: 10 })]]);
  const cache = buildCodingV5IndexCacheFile('/repo', records);
  const entries = [{
    relPath: 'a.ts',
    language: 'typescript',
    mtimeMs: 1000,
    size: 10,
    symbols: [],
    imports: [],
    hasError: false,
  }];
  const plan = checkCodingV5IndexFreshness(cache, entries);
  assert.deepEqual(plan.unchanged, ['a.ts']);
  assert.equal(plan.needsRebuild, false);
});
