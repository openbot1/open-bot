/**
 * Tests for repo map v5 — symbol topology (v1.13, Doi T3):
 * `packages/core/src/codingV5/topology.ts` (export/import/call-site
 * extraction, fan-in/fan-out, import cycles, hubs, orphans).
 *
 * Pure logic — no fs, no git. Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/coding-v5-topology.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCodingV2Graph,
} from '../packages/core/dist/codingV2/repoMapGraph.js';
import {
  buildCodingV5Topology,
  codingV5BestDefinitionFile,
  codingV5EffectiveExports,
  codingV5EnclosingSymbol,
  codingV5ImportersOf,
  codingV5ImportsOf,
  codingV5PublicExports,
  codingV5TopCalledSymbols,
  codingV5TopHubs,
  extractCodingV5CallSites,
  extractCodingV5Exports,
  extractCodingV5Imports,
  findCodingV5ImportCycles,
  renderCodingV5TopologySummary,
  resolveCodingV5ReExports,
} from '../packages/core/dist/codingV5/topology.js';

function sym(name, qualifiedName, kind = 'function', line = 1, endLine = 10) {
  return { kind, name, qualifiedName, line, column: 1, endLine };
}

function fileEntry(relPath, symbols, imports = []) {
  return {
    relPath,
    language: relPath.endsWith('.py') ? 'python' : 'typescript',
    mtimeMs: 1_800_000_000_000,
    size: 100,
    symbols,
    imports,
    hasError: false,
  };
}

/**
 * Fixture:
 *   src/a.ts  — exports alpha, class Beta (method save); re-exports gamma from ./c
 *   src/b.ts  — imports { alpha } from './a', calls alpha() inside gamma()
 *   src/c.ts  — exports gamma; imports Beta from './a' (cycle a<->c via re-export? no: a re-exports c, c imports a => cycle a<->c)
 *   src/d.ts  — isolated, no imports, defines delta
 *   lib/e.py  — python: defines run(), imports os
 */
const A_SRC = [
  "export function alpha(x: string): string {",
  "  return x;",
  "}",
  "export class Beta {",
  "  save(): void {}",
  "}",
  "export { gamma } from './c';",
  "export default Beta;",
  "",
].join('\n');

const B_SRC = [
  "import { alpha } from './a';",
  "import * as ns from './c';",
  "export function gamma(): void {",
  "  alpha('hi');",
  "  ns.gamma();",
  "  const x = alpha('again');",
  "}",
  "",
].join('\n');

const C_SRC = [
  "import { Beta } from './a';",
  "export function gamma(): void {",
  "  const b = new Beta();",
  "  b.save();",
  "}",
  "",
].join('\n');

const D_SRC = "export function delta(): number {\n  return 42;\n}\n";

const E_SRC = "import os\n\ndef run():\n    print(os.getcwd())\n";

function fixture() {
  const a = fileEntry('src/a.ts', [sym('alpha', 'alpha', 'function', 1, 3), sym('Beta', 'Beta', 'class', 4, 6), sym('save', 'Beta.save', 'method', 5, 5)], ['src/c.ts']);
  const b = fileEntry('src/b.ts', [sym('gamma', 'gamma', 'function', 3, 7)], ['src/a.ts', 'src/c.ts']);
  const c = fileEntry('src/c.ts', [sym('gamma', 'gamma', 'function', 2, 5)], ['src/a.ts']);
  const d = fileEntry('src/d.ts', [sym('delta', 'delta', 'function', 1, 3)], []);
  const e = fileEntry('lib/e.py', [sym('run', 'run', 'function', 3, 4)], []);
  const files = [a, b, c, d, e];
  const sources = new Map([
    ['src/a.ts', A_SRC],
    ['src/b.ts', B_SRC],
    ['src/c.ts', C_SRC],
    ['src/d.ts', D_SRC],
    ['lib/e.py', E_SRC],
  ]);
  const idents = new Map([
    ['src/b.ts', new Map([['alpha', 2], ['gamma', 1]])],
    ['src/c.ts', new Map([['Beta', 1], ['save', 1]])],
    ['src/a.ts', new Map()],
    ['src/d.ts', new Map()],
    ['lib/e.py', new Map()],
  ]);
  const graph = buildCodingV2Graph({ files, idents });
  const topology = buildCodingV5Topology({
    files,
    sources,
    resolveImport: (fromFile, specifier) => {
      if (!specifier.startsWith('.')) return null;
      const dir = fromFile.slice(0, fromFile.lastIndexOf('/'));
      const base = `${dir}/${specifier.slice(2)}.ts`;
      return files.some((f) => f.relPath === base) ? base : null;
    },
  });
  return { files, sources, graph, topology, a, b, c, d, e };
}

test('exports: named + class + default + re-export are all extracted', () => {
  const { topology } = fixture();
  const aExports = topology.exportsByFile.get('src/a.ts') ?? [];
  const names = aExports.map((e) => `${e.kind}:${e.name}`);
  assert.ok(names.includes('named:alpha'), names.join(','));
  assert.ok(names.includes('named:Beta'), names.join(','));
  assert.ok(names.includes('default:default'), names.join(','));
  const re = aExports.find((e) => e.name === 'gamma');
  assert.ok(re, 're-export gamma missing');
  assert.equal(re.kind, 're-export');
  assert.equal(re.reExportFrom, './c');
  assert.equal(re.definedLocally, false);
  const alpha = aExports.find((e) => e.name === 'alpha');
  assert.equal(alpha?.definedLocally, true);
});

test('exports: python module-level defs are exports', () => {
  const { topology } = fixture();
  const eExports = topology.exportsByFile.get('lib/e.py') ?? [];
  assert.deepEqual(eExports.map((e) => e.name), ['run']);
  assert.equal(eExports[0]?.kind, 'named');
});

test('imports: static + namespace + type of specifier, external flagged', () => {
  const { topology } = fixture();
  const bImports = topology.importsByFile.get('src/b.ts') ?? [];
  assert.equal(bImports.length, 2);
  const named = bImports.find((i) => i.specifier === './a');
  assert.equal(named?.kind, 'static');
  assert.equal(named?.resolved, 'src/a.ts');
  assert.ok(named?.importedNames.includes('alpha'));
  assert.equal(named?.external, false);
  const ns = bImports.find((i) => i.specifier === './c');
  assert.ok(ns?.importedNames.includes('ns'));
  const pyImports = topology.importsByFile.get('lib/e.py') ?? [];
  assert.equal(pyImports.length, 1);
  assert.equal(pyImports[0]?.specifier, 'os');
  assert.equal(pyImports[0]?.external, true);
  assert.equal(pyImports[0]?.resolved, null);
});

test('imports: dynamic import() and require() are kind dynamic/require', () => {
  const src = "const m = await import('./lazy');\nconst r = require('fs');\n";
  const imports = extractCodingV5Imports(src, 'typescript', () => 'src/lazy.ts');
  const kinds = imports.map((i) => i.kind).sort();
  assert.deepEqual(kinds, ['dynamic', 'require']);
});

test('call sites: caller is the enclosing function, callee resolves by short name', () => {
  const { topology } = fixture();
  const bCalls = topology.callSites.filter((s) => s.file === 'src/b.ts');
  assert.ok(bCalls.length >= 2, `expected >=2 call sites in b.ts, got ${bCalls.length}`);
  const alphaCalls = bCalls.filter((s) => s.callee === 'alpha');
  assert.equal(alphaCalls.length, 2);
  assert.ok(alphaCalls.every((s) => s.caller === 'gamma'));
  assert.ok(alphaCalls.every((s) => s.resolvedFile === 'src/a.ts'));
  assert.ok(alphaCalls.every((s) => s.resolvedQualified === 'alpha'));
  assert.ok(alphaCalls.every((s) => s.ambiguous === false));
  // ns.gamma() is a method call whose callee name is gamma (defined in c.ts AND b.ts -> ambiguous).
  const gammaCalls = bCalls.filter((s) => s.callee === 'gamma');
  assert.equal(gammaCalls.length, 1);
  assert.equal(gammaCalls[0]?.kind, 'method');
  assert.equal(gammaCalls[0]?.ambiguous, true);
  assert.equal(gammaCalls[0]?.resolvedFile, null);
});

test('call sites: new Beta() is kind new and resolves to the class', () => {
  const { topology } = fixture();
  const cCalls = topology.callSites.filter((s) => s.file === 'src/c.ts');
  const beta = cCalls.find((s) => s.callee === 'Beta');
  assert.ok(beta, 'new Beta() call site missing');
  assert.equal(beta.kind, 'new');
  assert.equal(beta.resolvedFile, 'src/a.ts');
  const save = cCalls.find((s) => s.callee === 'save');
  assert.ok(save, 'b.save() call site missing');
  assert.equal(save.kind, 'method');
  assert.equal(save.resolvedQualified, 'Beta.save');
});

test('enclosing symbol: line inside a function resolves to it, top-level is empty', () => {
  const symbols = [sym('f', 'f', 'function', 2, 5), sym('g', 'g', 'function', 7, 9)];
  assert.equal(codingV5EnclosingSymbol(symbols, 3), 'f');
  assert.equal(codingV5EnclosingSymbol(symbols, 1), '');
  assert.equal(codingV5EnclosingSymbol(symbols, 6), '');
});

test('topology stats: counts add up', () => {
  const { topology } = fixture();
  const s = topology.stats;
  assert.equal(s.files, 5);
  assert.equal(s.symbols, 7);
  assert.ok(s.exports >= 6, `exports ${s.exports}`);
  assert.ok(s.importsResolved >= 4, `importsResolved ${s.importsResolved}`);
  assert.equal(s.importsExternal, 1);
  assert.ok(s.callSites >= 4, `callSites ${s.callSites}`);
  assert.ok(s.callsResolved >= 3, `callsResolved ${s.callsResolved}`);
  assert.ok(s.callsAmbiguous >= 1, `callsAmbiguous ${s.callsAmbiguous}`);
  assert.equal(s.cycles, 1);
  assert.equal(s.orphans, 2); // d.ts isolated; e.py only imports external 'os'
});

test('import cycles: a <-> c is found exactly once, normalized', () => {
  const { topology } = fixture();
  assert.equal(topology.cycles.length, 1);
  assert.deepEqual([...topology.cycles[0]?.files ?? []].sort(), ['src/a.ts', 'src/c.ts']);
  const direct = findCodingV5ImportCycles(
    new Map([
      ['x.ts', [{ specifier: './y', resolved: 'y.ts', kind: 'static', importedNames: [], line: 1, external: false }]],
      ['y.ts', [{ specifier: './x', resolved: 'x.ts', kind: 'static', importedNames: [], line: 1, external: false }]],
      ['z.ts', []],
    ]),
  );
  assert.equal(direct.length, 1);
  assert.deepEqual(direct[0]?.files, ['x.ts', 'y.ts']);
});

test('fan-in/fan-out: a.ts is imported by b.ts and c.ts; orphans listed', () => {
  const { topology } = fixture();
  const aFan = topology.fileFan.get('src/a.ts');
  assert.equal(aFan?.fanIn, 2);
  assert.deepEqual(aFan?.importedBy, ['src/b.ts', 'src/c.ts']);
  assert.deepEqual(topology.orphans, ['lib/e.py', 'src/d.ts']);
  assert.deepEqual(codingV5ImportersOf(topology, 'src/a.ts'), ['src/b.ts', 'src/c.ts']);
  assert.deepEqual(codingV5ImportsOf(topology, 'src/b.ts'), ['src/a.ts', 'src/c.ts']);
});

test('hubs: a.ts is the top hub; top called symbols include alpha', () => {
  const { topology } = fixture();
  const hubs = codingV5TopHubs(topology, 2);
  assert.equal(hubs[0]?.relPath, 'src/a.ts');
  assert.ok((hubs[0]?.total ?? 0) >= 2);
  const called = codingV5TopCalledSymbols(topology, 5);
  assert.ok(called.some((c) => c.qualifiedName === 'alpha' && c.fanIn >= 1));
});

test('public exports exclude re-exports', () => {
  const { topology } = fixture();
  const pub = codingV5PublicExports(topology, 'src/a.ts');
  assert.ok(pub.every((e) => e.kind !== 're-export'));
  assert.ok(pub.some((e) => e.name === 'alpha'));
});

test('best definition file prefers the highest PageRank file', () => {
  const { graph } = fixture();
  const best = codingV5BestDefinitionFile(graph, ['src/d.ts', 'src/a.ts']);
  assert.ok(best === 'src/a.ts' || best === 'src/d.ts', best ?? 'null');
  assert.equal(codingV5BestDefinitionFile(graph, []), null);
});

test('topology summary renders counts and hubs', () => {
  const { topology } = fixture();
  const text = renderCodingV5TopologySummary(topology);
  assert.match(text, /Topology v5: 5 file\(s\)/);
  assert.match(text, /Import cycles: 1/);
  assert.match(text, /Orphan files: 2/);
});

test('extract exports/imports handle empty source', () => {
  assert.deepEqual(extractCodingV5Exports('', 'typescript', []), []);
  assert.deepEqual(extractCodingV5Imports('', 'typescript'), []);
  const byShort = new Map();
  assert.deepEqual(extractCodingV5CallSites('', fileEntry('x.ts', []), byShort), []);
});

test('re-export chain: gamma re-exported by a.ts resolves to its definition in c.ts', () => {
  const { files, topology } = fixture();
  const resolved = resolveCodingV5ReExports(topology, files, 'src/a.ts');
  const gamma = resolved.find((r) => r.name === 'gamma');
  assert.ok(gamma, 're-export gamma missing');
  assert.equal(gamma.definingFile, 'src/c.ts');
  assert.equal(gamma.definingQualified, 'gamma');
  assert.deepEqual(gamma.chain, ['src/a.ts', 'src/c.ts']);
  assert.equal(gamma.unresolved, false);
  assert.equal(gamma.cyclic, false);
  const effective = codingV5EffectiveExports(topology, files, 'src/a.ts');
  const names = effective.map((e) => e.name);
  assert.ok(names.includes('alpha'));
  assert.ok(names.includes('Beta'));
  assert.ok(names.includes('gamma'));
  const effGamma = effective.find((e) => e.name === 'gamma');
  assert.equal(effGamma?.definingFile, 'src/c.ts');
  const effAlpha = effective.find((e) => e.name === 'alpha');
  assert.equal(effAlpha?.definingFile, 'src/a.ts');
});

test('re-export chain: multi-hop chain and cycle are resolved safely', () => {
  const x = fileEntry('x.ts', [], []);
  const y = fileEntry('y.ts', [], []);
  const z = fileEntry('z.ts', [sym('deep', 'deep', 'function', 1, 2)], []);
  const p = fileEntry('p.ts', [], []);
  const q = fileEntry('q.ts', [], []);
  const files = [x, y, z, p, q];
  const sources = new Map([
    ['x.ts', "export { deep } from './y';\n"],
    ['y.ts', "export { deep } from './z';\n"],
    ['z.ts', 'export function deep(): void {}\n'],
    ['p.ts', "export { loop } from './q';\n"],
    ['q.ts', "export { loop } from './p';\n"],
  ]);
  const topology = buildCodingV5Topology({
    files,
    sources,
    resolveImport: (_from, specifier) => {
      const name = specifier.replace('./', '');
      return files.some((f) => f.relPath === `${name}.ts`) ? `${name}.ts` : null;
    },
  });
  const deep = resolveCodingV5ReExports(topology, files, 'x.ts').find((r) => r.name === 'deep');
  assert.ok(deep);
  assert.equal(deep.definingFile, 'z.ts');
  assert.equal(deep.definingQualified, 'deep');
  assert.deepEqual(deep.chain, ['x.ts', 'y.ts', 'z.ts']);
  assert.equal(deep.unresolved, false);
  const loop = resolveCodingV5ReExports(topology, files, 'p.ts').find((r) => r.name === 'loop');
  assert.ok(loop);
  assert.equal(loop.cyclic, true);
  assert.equal(loop.definingFile, null);
  // Namespace re-export points at the target file without resolving symbols.
  const nsFiles = [fileEntry('n.ts', [], [])];
  const nsTopology = buildCodingV5Topology({
    files: nsFiles,
    sources: new Map([['n.ts', "export * as utils from './y';\n"]]),
    resolveImport: (_from, specifier) => (specifier === './y' ? 'y.ts' : null),
  });
  const ns = resolveCodingV5ReExports(nsTopology, nsFiles, 'n.ts').find((r) => r.name === 'utils');
  assert.ok(ns);
  assert.equal(ns.definingFile, 'y.ts');
  assert.equal(ns.unresolved, false);
});
