/**
 * Tests for repo map v5 — hierarchical summaries + code graph search
 * + jump-to-definition (v1.13, Doi T3):
 * `packages/core/src/codingV5/summaries.ts`,
 * `packages/core/src/codingV5/search.ts`,
 * `packages/core/src/codingV5/jumpToDefinition.ts`.
 *
 * Pure logic — no fs, no git. Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/coding-v5-summaries-search.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCodingV2Graph,
} from '../packages/core/dist/codingV2/repoMapGraph.js';
import {
  buildCodingV5Topology,
} from '../packages/core/dist/codingV5/topology.js';
import {
  buildCodingV5SummaryTree,
  codingV5AncestorDirs,
  codingV5PathToDirectory,
  codingV5SummaryOf,
  renderCodingV5Directory,
  renderCodingV5Skeleton,
} from '../packages/core/dist/codingV5/summaries.js';
import {
  codingV5FuzzyMatch,
  codingV5FuzzyScore,
  codingV5NameMatch,
  findCodingV5Callers,
  findCodingV5Callees,
  findCodingV5Importers,
  impactCodingV5Of,
  renderCodingV5Impact,
  renderCodingV5SymbolHits,
  searchCodingV5Symbols,
} from '../packages/core/dist/codingV5/search.js';
import {
  jumpCodingV5ToDefinition,
  renderCodingV5JumpResult,
} from '../packages/core/dist/codingV5/jumpToDefinition.js';

function sym(name, qualifiedName, kind = 'function', line = 1, endLine = 5) {
  return { kind, name, qualifiedName, line, column: 1, endLine };
}

function fileEntry(relPath, symbols, imports = []) {
  return {
    relPath,
    language: 'typescript',
    mtimeMs: 1_800_000_000_000,
    size: 100,
    symbols,
    imports,
    hasError: false,
  };
}

const A_SRC = [
  "export function alpha(x: string): string {",
  "  return x;",
  "}",
  "export class Beta {",
  "  save(): void {}",
  "}",
  "",
].join('\n');

const B_SRC = [
  "import { alpha } from './a';",
  "import { saveAll } from '../../lib/util';",
  "export function gamma(): void {",
  "  alpha('hi');",
  "}",
  "",
].join('\n');

const UTIL_SRC = [
  "export function saveAll(): void {",
  "  return;",
  "}",
  "",
].join('\n');

function fixture() {
  const a = fileEntry('src/core/a.ts', [sym('alpha', 'alpha', 'function', 1, 3), sym('Beta', 'Beta', 'class', 4, 6), sym('save', 'Beta.save', 'method', 5, 5)], []);
  const b = fileEntry('src/core/b.ts', [sym('gamma', 'gamma', 'function', 3, 5)], ['src/core/a.ts', 'lib/util.ts']);
  const u = fileEntry('lib/util.ts', [sym('saveAll', 'saveAll', 'function', 1, 3)], []);
  const files = [a, b, u];
  const sources = new Map([
    ['src/core/a.ts', A_SRC],
    ['src/core/b.ts', B_SRC],
    ['lib/util.ts', UTIL_SRC],
  ]);
  const idents = new Map([
    ['src/core/b.ts', new Map([['alpha', 2], ['saveAll', 1]])],
    ['src/core/a.ts', new Map()],
    ['lib/util.ts', new Map()],
  ]);
  const graph = buildCodingV2Graph({ files, idents });
  const topology = buildCodingV5Topology({
    files,
    sources,
    resolveImport: (fromFile, specifier) => {
      if (!specifier.startsWith('.')) return null;
      const parts = fromFile.split('/').slice(0, -1);
      for (const seg of specifier.split('/')) {
        if (seg === '.') continue;
        if (seg === '..') parts.pop();
        else parts.push(seg);
      }
      const base = `${parts.join('/')}.ts`;
      return files.some((f) => f.relPath === base) ? base : null;
    },
  });
  const tree = buildCodingV5SummaryTree(files, graph, topology);
  const sourceLines = new Map([...sources].map(([k, v]) => [k, v.split('\n')]));
  return { files, sources, sourceLines, graph, topology, tree, a, b, u };
}

// --- Ancestors / paths -------------------------------------------------------

test('ancestor dirs: file at root has only root; nested file lists every level', () => {
  assert.deepEqual(codingV5AncestorDirs('a.ts'), ['']);
  assert.deepEqual(codingV5AncestorDirs('src/core/a.ts'), ['', 'src', 'src/core']);
  assert.deepEqual(codingV5PathToDirectory('src/core'), ['', 'src', 'src/core']);
  assert.deepEqual(codingV5PathToDirectory(''), ['']);
});

// --- Summary tree ------------------------------------------------------------

test('summary tree: root aggregates all files/symbols; children roll up', () => {
  const { tree } = fixture();
  assert.equal(tree.stats.directories, 4); // '', src, src/core, lib
  assert.equal(tree.stats.files, 3);
  assert.equal(tree.stats.symbols, 5);
  assert.equal(tree.root.filesTotal, 3);
  assert.equal(tree.root.symbolsTotal, 5);
  const core = codingV5SummaryOf(tree, 'src/core');
  assert.ok(core);
  assert.equal(core.filesTotal, 2);
  assert.equal(core.filesDirect, 2);
  assert.equal(core.symbolsTotal, 4);
  assert.equal(core.symbolsByKind.function, 2);
  assert.equal(core.symbolsByKind.class, 1);
  assert.equal(core.symbolsByKind.method, 1);
  assert.equal(core.exportsTotal, 3); // alpha, Beta, gamma
  const src = codingV5SummaryOf(tree, 'src');
  assert.ok(src);
  assert.equal(src.filesTotal, 2);
  assert.deepEqual(src.children, ['src/core']);
  const lib = codingV5SummaryOf(tree, 'lib');
  assert.ok(lib);
  assert.equal(lib.filesTotal, 1);
  assert.equal(codingV5SummaryOf(tree, 'nope'), null);
});

test('summary tree: top symbols are the highest PageRank symbols', () => {
  const { tree } = fixture();
  const core = codingV5SummaryOf(tree, 'src/core');
  assert.ok(core);
  assert.ok(core.topSymbols.length > 0);
  assert.ok(core.topSymbols.some((s) => s.qualifiedName === 'alpha'));
  // Every top symbol carries file + line.
  for (const s of core.topSymbols) {
    assert.ok(s.file.length > 0);
    assert.ok(s.line >= 1);
  }
});

test('summary tree: dependencies point across directories, not inside one', () => {
  const { tree } = fixture();
  const core = codingV5SummaryOf(tree, 'src/core');
  assert.ok(core);
  // src/core/b.ts imports lib/util.ts -> depends on lib.
  assert.ok(core.dependsOn.some((d) => d.directory === 'lib' && d.edges >= 1));
  const lib = codingV5SummaryOf(tree, 'lib');
  assert.ok(lib);
  assert.ok(lib.dependedBy.some((d) => d.directory === 'src/core'));
  // No directory depends on itself.
  for (const s of tree.byPath.values()) {
    assert.ok(!s.dependsOn.some((d) => d.directory === s.path), s.path);
  }
});

test('render directory: text lists files, symbols, top symbols', () => {
  const { tree } = fixture();
  const text = renderCodingV5Directory(tree, 'src/core');
  assert.match(text, /core\/ — 2 file\(s\), 4 symbol\(s\)/);
  assert.match(text, /alpha/);
  assert.equal(renderCodingV5Directory(tree, 'nope'), '');
});

test('skeleton: fits a tiny budget, keeps root, reports truncation', () => {
  const { tree } = fixture();
  const small = renderCodingV5Skeleton(tree, { budgetTokens: 40 });
  assert.ok(small.includedDirectories.includes(''));
  assert.equal(small.truncated, true);
  // Root is always kept even when the budget is too small for it alone.
  assert.ok(small.includedDirectories.length >= 1);
  assert.ok(small.estimatedTokens > 40);
  const big = renderCodingV5Skeleton(tree, { budgetTokens: 2000 });
  assert.equal(big.truncated, false);
  assert.equal(big.includedDirectories.length, 4);
  assert.match(big.text, /Repo skeleton v5/);
  // Seed directory path is always kept.
  const seeded = renderCodingV5Skeleton(tree, { budgetTokens: 40, seedDirectory: 'lib' });
  assert.ok(seeded.includedDirectories.includes('lib'));
  assert.ok(seeded.includedDirectories.includes(''));
});

// --- Name matching -----------------------------------------------------------

test('name match: exact > prefix > substring; regex invalid returns null', () => {
  assert.deepEqual(codingV5NameMatch('alpha', 'alpha', 'alpha', 'exact'), { match: 'exact', score: 1 });
  assert.equal(codingV5NameMatch('alpha', 'beta', 'beta', 'exact'), null);
  assert.equal(codingV5NameMatch('alp', 'alpha', 'alpha', 'prefix')?.match, 'prefix');
  assert.equal(codingV5NameMatch('pha', 'alpha', 'alpha', 'prefix'), null);
  assert.equal(codingV5NameMatch('pha', 'alpha', 'alpha', 'substring')?.match, 'substring');
  assert.equal(codingV5NameMatch('alp.*', 'alpha', 'alpha', 'regex')?.match, 'regex');
  assert.equal(codingV5NameMatch('[invalid', 'alpha', 'alpha', 'regex'), null);
  assert.equal(codingV5NameMatch('', 'alpha', 'alpha', 'substring'), null);
});

test('fuzzy: subsequence matches, score prefers shorter names', () => {
  assert.equal(codingV5FuzzyMatch('rmp', 'RepoMapParser'), true);
  assert.equal(codingV5FuzzyMatch('rmpx', 'RepoMapParser'), false);
  assert.ok(codingV5FuzzyScore('alp', 'alpha') > codingV5FuzzyScore('alp', 'alphabetical'));
});

// --- Symbol search -----------------------------------------------------------

test('search symbols: substring finds alpha; exact outranks', () => {
  const { files, graph, topology } = fixture();
  const { hits, modeUsed, fellBack } = searchCodingV5Symbols(files, 'alpha', topology, graph);
  assert.equal(modeUsed, 'substring');
  assert.equal(fellBack, false);
  assert.equal(hits[0]?.qualifiedName, 'alpha');
  assert.equal(hits[0]?.file, 'src/core/a.ts');
  assert.ok(hits[0]?.relevance > 0);
  const exact = searchCodingV5Symbols(files, 'alpha', topology, graph, { mode: 'exact' });
  assert.equal(exact.hits.length, 1);
  assert.equal(exact.hits[0]?.match, 'exact');
});

test('search symbols: kind + directory filters narrow results', () => {
  const { files, graph, topology } = fixture();
  const byKind = searchCodingV5Symbols(files, 'a', topology, graph, { kind: 'class' });
  assert.ok(byKind.hits.every((h) => h.kind === 'class'));
  assert.ok(byKind.hits.some((h) => h.qualifiedName === 'Beta'));
  const inLib = searchCodingV5Symbols(files, 'save', topology, graph, { directory: 'lib' });
  assert.ok(inLib.hits.every((h) => h.file.startsWith('lib/')));
  assert.ok(inLib.hits.some((h) => h.qualifiedName === 'saveAll'));
  const noHit = searchCodingV5Symbols(files, 'zzz-no-such-symbol', topology, graph);
  assert.equal(noHit.hits.length, 0);
  assert.equal(noHit.fellBack, true); // substring fell back to fuzzy, still nothing
});

test('search symbols: fuzzy mode finds by subsequence', () => {
  const { files, graph, topology } = fixture();
  const { hits } = searchCodingV5Symbols(files, 'svl', topology, graph, { mode: 'fuzzy' });
  assert.ok(hits.some((h) => h.qualifiedName === 'saveAll'));
});

test('search symbols: works without a graph (scores fall back to 0)', () => {
  const { files, topology } = fixture();
  const { hits } = searchCodingV5Symbols(files, 'alpha', topology, null);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.symbolScore, 0);
  assert.equal(hits[0]?.fileScore, 0);
});

test('render symbol hits: empty and non-empty', () => {
  assert.equal(renderCodingV5SymbolHits([]), '(no symbols found)');
  const { files, graph, topology } = fixture();
  const { hits } = searchCodingV5Symbols(files, 'alpha', topology, graph);
  assert.match(renderCodingV5SymbolHits(hits), /alpha \(function\) — src\/core\/a\.ts:1/);
});

// --- Callers / callees / importers -------------------------------------------

test('callers: gamma calls alpha; alpha is called from b.ts', () => {
  const { files, topology } = fixture();
  const { callers, definitions, ambiguous } = findCodingV5Callers(topology, files, 'alpha');
  assert.equal(ambiguous, false);
  assert.deepEqual(definitions, ['src/core/a.ts#alpha']);
  assert.equal(callers.length, 1);
  assert.equal(callers[0]?.caller, 'gamma');
  assert.equal(callers[0]?.callerFile, 'src/core/b.ts');
  assert.equal(callers[0]?.callLine, 4);
  const none = findCodingV5Callers(topology, files, 'no-such');
  assert.equal(none.callers.length, 0);
  assert.equal(none.definitions.length, 0);
});

test('callees: gamma calls alpha; unknown symbol reports found=false', () => {
  const { topology } = fixture();
  const { callees, found } = findCodingV5Callees(topology, 'src/core/b.ts', 'gamma');
  assert.equal(found, true);
  assert.equal(callees.length, 1);
  assert.equal(callees[0]?.callee, 'alpha');
  assert.equal(callees[0]?.calleeFile, 'src/core/a.ts');
  const missing = findCodingV5Callees(topology, 'src/core/b.ts', 'nope');
  assert.equal(missing.callees.length, 0);
  assert.equal(missing.found, false);
});

test('importers: by resolved file, by file name, and by bare specifier', () => {
  const { topology } = fixture();
  const byPath = findCodingV5Importers(topology, 'src/core/a.ts');
  assert.equal(byPath.resolvedTarget, 'src/core/a.ts');
  assert.equal(byPath.totalImporters, 1);
  assert.equal(byPath.importers[0]?.file, 'src/core/b.ts');
  const byName = findCodingV5Importers(topology, 'a.ts');
  assert.equal(byName.totalImporters, 1);
  const bare = findCodingV5Importers(topology, 'react');
  assert.equal(bare.totalImporters, 0);
  assert.equal(bare.resolvedTarget, null);
  assert.deepEqual(findCodingV5Importers(topology, '').importers, []);
});

// --- Jump-to-definition ------------------------------------------------------

test('jump: alpha resolves with signature, context and usages', () => {
  const { files, graph, topology, sourceLines } = fixture();
  const result = jumpCodingV5ToDefinition(files, 'alpha', topology, graph, sourceLines);
  assert.equal(result.found, true);
  assert.equal(result.definition?.file, 'src/core/a.ts');
  assert.equal(result.definition?.line, 1);
  assert.equal(result.definition?.kind, 'function');
  assert.equal(result.definition?.exported, true);
  assert.match(result.definition?.signature ?? '', /export function alpha/);
  assert.ok((result.definition?.context.length ?? 0) >= 1);
  assert.ok(result.definition?.context.some((c) => c.line === 1));
  assert.ok(result.totalUsages >= 1);
  assert.ok(result.usages.some((u) => u.kind === 'call' && u.file === 'src/core/b.ts'));
  assert.equal(result.ambiguous, false);
  const text = renderCodingV5JumpResult(result);
  assert.match(text, /alpha \(function\) defined at src\/core\/a\.ts:1:1/);
  assert.match(text, /Signature: export function alpha/);
});

test('jump: fromFile prefers the definition in the file being read', () => {
  const { files, graph, topology, sourceLines } = fixture();
  // 'gamma' is defined only in b.ts; 'save' only as Beta.save.
  const save = jumpCodingV5ToDefinition(files, 'Beta.save', topology, graph, sourceLines, { fromFile: 'src/core/b.ts' });
  assert.equal(save.found, true);
  assert.equal(save.definition?.file, 'src/core/a.ts');
  assert.equal(save.definition?.qualifiedName, 'Beta.save');
});

test('jump: unknown symbol returns suggestions, not a crash', () => {
  const { files, graph, topology, sourceLines } = fixture();
  const result = jumpCodingV5ToDefinition(files, 'alph', topology, graph, sourceLines);
  assert.equal(result.found, false);
  assert.equal(result.definition, null);
  assert.ok(result.suggestions.some((s) => s.startsWith('alpha ')));
  assert.match(result.notFoundReason ?? '', /no symbol named/);
  const text = renderCodingV5JumpResult(result);
  assert.match(text, /not found/);
  assert.match(text, /Did you mean/);
  const empty = jumpCodingV5ToDefinition(files, '   ', topology, graph, sourceLines);
  assert.equal(empty.found, false);
  assert.equal(empty.notFoundReason, 'empty symbol name');
});

test('jump: ambiguous name lists every definition', () => {
  const { files, graph, topology, sourceLines } = fixture();
  // Add a second definition of 'alpha' in lib/util.ts.
  const extra = fileEntry('lib/util2.ts', [sym('alpha', 'alpha', 'function', 1, 2)], []);
  const allFiles = [...files, extra];
  const result = jumpCodingV5ToDefinition(allFiles, 'alpha', topology, graph, sourceLines);
  assert.equal(result.found, true);
  assert.equal(result.ambiguous, true);
  assert.equal(result.allDefinitions.length, 2);
  const text = renderCodingV5JumpResult(result);
  assert.match(text, /2 definitions share this name/);
});

// --- Impact analysis ---------------------------------------------------------

test('impact: changing alpha affects its caller gamma and the importing file', () => {
  const { files, topology } = fixture();
  const result = impactCodingV5Of(topology, files, 'alpha');
  assert.equal(result.found, true);
  assert.equal(result.ambiguous, false);
  assert.deepEqual(result.definitions, ['src/core/a.ts#alpha']);
  // Depth 0: the definition itself; depth 1: gamma (calls alpha) + b.ts (imports a.ts).
  assert.ok(result.impacted.some((h) => h.depth === 0 && h.qualifiedName === 'alpha'));
  assert.ok(result.impacted.some((h) => h.depth === 1 && h.kind === 'symbol' && h.qualifiedName === 'gamma' && h.file === 'src/core/b.ts'));
  assert.ok(result.impacted.some((h) => h.depth === 1 && h.kind === 'file' && h.file === 'src/core/b.ts'));
  assert.ok(result.totalImpacted >= 3);
  const text = renderCodingV5Impact(result);
  assert.match(text, /may affect 3 node\(s\)/);
  assert.match(text, /gamma in src\/core\/b\.ts/);
});

test('impact: depth 0 reports only the definition', () => {
  const { files, topology } = fixture();
  const result = impactCodingV5Of(topology, files, 'alpha', { maxDepth: 0 });
  assert.equal(result.totalImpacted, 1);
  assert.equal(result.impacted[0]?.depth, 0);
  assert.equal(result.maxDepthReached, 0);
});

test('impact: unknown symbol reports not found; empty query is safe', () => {
  const { files, topology } = fixture();
  const missing = impactCodingV5Of(topology, files, 'no-such-symbol');
  assert.equal(missing.found, false);
  assert.equal(missing.totalImpacted, 0);
  assert.match(renderCodingV5Impact(missing), /not found/);
  assert.equal(impactCodingV5Of(topology, files, '   ').found, false);
});

test('impact: limit truncates and reports it', () => {
  const { files, topology } = fixture();
  const result = impactCodingV5Of(topology, files, 'alpha', { limit: 1 });
  assert.equal(result.impacted.length, 1);
  assert.equal(result.truncated, true);
  assert.ok(result.totalImpacted > 1);
});
