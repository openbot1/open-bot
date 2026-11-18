/**
 * Tests cho coding agent v11 (v1.19, Đội T2-TEST vòng 6): call graph
 * + PageRank v2 (`packages/core/src/codingV11/callGraph.ts`) — resolve
 * call theo import, PageRank v2 có trọng số + personalization, HITS,
 * Tarjan SCC, impact set, query map.
 *
 * Chạy thật trên repo TS tạm (parse bằng parser v8 thật), không chạy
 * code/lệnh ngoài, không git. Không chạy build/typecheck/full-suite
 * (máy quá tải): dist bundle nhẹ bằng esbuild (gitignored, xem ghi
 * chú ở tests/coding-v11-codeact.test.mjs).
 *
 *   node --test tests/coding-v11-callgraph.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  CodingV11Error,
  V11CallGraph,
  V11_IMPACT_MAX_DEPTH,
  V11_PAGERANK_DAMPING,
  V11_PAGERANK_EPSILON,
  V11_PAGERANK_MAX_ITERATIONS,
  V11_QUERY_MAP_DEFAULT_LIMIT,
  v11BuildCallGraphFromParsed,
  v11FindCycles,
  v11Hits,
  v11PageRankV2,
  v11ShortName,
} from '../packages/core/dist/codingV11/index.js';

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFile(dir, rel, content) {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  return abs;
}

const MATH_TS = `export function add(a: number, b: number): number {
  return a + b;
}

export function mul(a: number, b: number): number {
  return a * b;
}
`;

const USE_TS = `import { add, mul } from './math';

export function total(x: number): number {
  return add(x, 1) + mul(x, 2) + ghostFn(x);
}
`;

const CYCLE_A_TS = `import { pong } from './cycleB';

export function ping(): string {
  return pong();
}
`;

const CYCLE_B_TS = `import { ping } from './cycleA';

export function pong(): string {
  return ping();
}
`;

function makeRepo({ cycle = false } = {}) {
  const dir = tmpDir('v11-cg-');
  writeFile(dir, 'src/math.ts', MATH_TS);
  writeFile(dir, 'src/use.ts', USE_TS);
  if (cycle) {
    writeFile(dir, 'src/cycleA.ts', CYCLE_A_TS);
    writeFile(dir, 'src/cycleB.ts', CYCLE_B_TS);
  }
  return dir;
}

function buildRepo({ cycle = false } = {}) {
  const dir = makeRepo({ cycle });
  const graph = new V11CallGraph(dir);
  const data = graph.scanAndBuild();
  return { dir, graph, data };
}

test('hằng số PageRank v2 + v11ShortName', () => {
  assert.equal(V11_PAGERANK_DAMPING, 0.85);
  assert.equal(V11_PAGERANK_MAX_ITERATIONS, 80);
  assert.equal(V11_PAGERANK_EPSILON, 1e-7);
  assert.equal(V11_IMPACT_MAX_DEPTH, 6);
  assert.equal(V11_QUERY_MAP_DEFAULT_LIMIT, 10);
  assert.equal(v11ShortName('fs.readFile'), 'readFile');
  assert.equal(v11ShortName('save'), 'save');
  assert.equal(v11ShortName('a.b.c'), 'c');
});

test('v11PageRankV2: rỗng / 1 node / chuỗi A→B→C (điểm dồn về callee)', () => {
  const empty = v11PageRankV2([], []);
  assert.equal(empty.iterations, 0);
  assert.equal(empty.scores.size, 0);

  const single = v11PageRankV2(['only'], []);
  assert.ok(Math.abs((single.scores.get('only') ?? 0) - 1) < 1e-9);
  assert.ok(single.iterations >= 1);

  const chain = v11PageRankV2(
    ['A', 'B', 'C'],
    [
      { from: 'A', to: 'B', weight: 1 },
      { from: 'B', to: 'C', weight: 1 },
    ],
  );
  const sum = [...chain.scores.values()].reduce((s, v) => s + v, 0);
  assert.ok(Math.abs(sum - 1) < 1e-6, `tổng điểm phải ≈ 1, được ${sum}`);
  assert.ok((chain.scores.get('C') ?? 0) > (chain.scores.get('B') ?? 0));
  assert.ok((chain.scores.get('B') ?? 0) > (chain.scores.get('A') ?? 0));
  assert.ok(chain.iterations > 0 && chain.iterations <= V11_PAGERANK_MAX_ITERATIONS);
  assert.ok(chain.delta < V11_PAGERANK_EPSILON);
});

test('v11PageRankV2: personalization kéo điểm về node khớp query; trọng số cạnh nặng hơn', () => {
  const nodes = ['A', 'B', 'C'];
  const edges = [
    { from: 'A', to: 'B', weight: 1 },
    { from: 'A', to: 'C', weight: 1 },
  ];
  const base = v11PageRankV2(nodes, edges);
  const personalized = v11PageRankV2(nodes, edges, { personalization: new Map([['A', 1]]) });
  assert.ok((personalized.scores.get('A') ?? 0) > (base.scores.get('A') ?? 0));

  const weighted = v11PageRankV2(nodes, [
    { from: 'A', to: 'B', weight: 10 },
    { from: 'A', to: 'C', weight: 1 },
  ]);
  assert.ok((weighted.scores.get('B') ?? 0) > (weighted.scores.get('C') ?? 0));

  // Cạnh tới node lạ / weight <= 0 bị bỏ qua, không làm vỡ tổng điểm.
  const dirty = v11PageRankV2(nodes, [
    { from: 'A', to: 'ghost', weight: 5 },
    { from: 'A', to: 'B', weight: 0 },
    { from: 'A', to: 'B', weight: 1 },
  ]);
  const total = [...dirty.scores.values()].reduce((s, v) => s + v, 0);
  assert.ok(Math.abs(total - 1) < 1e-6);
});

test('v11Hits: hub gọi nhiều thì hub cao; được gọi nhiều thì authority cao', () => {
  const { hubs, authorities } = v11Hits(
    ['hub1', 'a', 'b', 'c'],
    [
      { from: 'hub1', to: 'a', weight: 1 },
      { from: 'hub1', to: 'b', weight: 1 },
      { from: 'hub1', to: 'c', weight: 1 },
    ],
  );
  assert.ok((hubs.get('hub1') ?? 0) > (hubs.get('a') ?? 0));
  assert.ok((authorities.get('a') ?? 0) > (authorities.get('hub1') ?? 0));
  assert.ok(Math.abs((authorities.get('a') ?? 0) - (authorities.get('b') ?? 0)) < 1e-9);

  const empty = v11Hits([], []);
  assert.equal(empty.iterations, 0);
  assert.equal(empty.hubs.size, 0);
});

test('v11FindCycles: chu trình 2 node, self-loop, không chu trình, rỗng', () => {
  assert.deepEqual(v11FindCycles(['A', 'B'], [
    { from: 'A', to: 'B' },
    { from: 'B', to: 'A' },
  ]), [{ members: ['A', 'B'], files: [] }]);
  assert.deepEqual(v11FindCycles(['C'], [{ from: 'C', to: 'C' }]), [{ members: ['C'], files: [] }]);
  assert.deepEqual(v11FindCycles(['A', 'B', 'C'], [
    { from: 'A', to: 'B' },
    { from: 'B', to: 'C' },
  ]), []);
  assert.deepEqual(v11FindCycles([], []), []);
});

test('scanAndBuild: stats + resolve call theo import + unresolved ghi lại', () => {
  const { graph, data } = buildRepo();
  assert.equal(graph.fileCount, 2);
  assert.equal(data.stats.files, 2);
  assert.ok(data.stats.symbols >= 3);
  assert.ok(data.stats.resolvedEdges >= 2);
  assert.equal(data.stats.unresolvedCalls, 1);
  assert.equal(data.stats.cyclicComponents, 0);
  assert.ok(data.stats.pageRankIterations > 0);
  const names = data.symbols.map((s) => s.qualifiedName);
  assert.ok(names.includes('add') && names.includes('mul') && names.includes('total'));

  const importEdges = data.edges.filter((e) => e.resolvedBy === 'import');
  assert.ok(importEdges.some((e) => e.caller === 'total' && e.callee === 'add' && e.calleeFile === 'src/math.ts'));
  assert.ok(importEdges.some((e) => e.caller === 'total' && e.callee === 'mul'));
  const unresolved = data.edges.find((e) => e.resolvedBy === 'unresolved');
  assert.equal(unresolved.callee, 'ghostFn');
  assert.equal(unresolved.caller, 'total');
  // PageRank của symbol là số > 0 và tổng ≈ 1.
  const totalRank = data.symbols.reduce((s, sym) => s + sym.pageRank, 0);
  assert.ok(Math.abs(totalRank - 1) < 1e-6);
});

test('rankFiles/rankSymbols: math được import, use import math', () => {
  const { graph } = buildRepo();
  const files = graph.rankFiles(10);
  assert.equal(files.length, 2);
  const math = files.find((f) => f.path === 'src/math.ts');
  const use = files.find((f) => f.path === 'src/use.ts');
  assert.equal(math.importedByCount, 1);
  assert.equal(math.symbolCount, 2);
  assert.equal(use.importsCount, 1);
  assert.equal(graph.rankFiles(1).length, 1);
  const top = graph.rankSymbols(1)[0];
  assert.ok(top.pageRank > 0);
  assert.ok(graph.rankByAuthority(2).length >= 1);
  assert.ok(graph.rankByHub(2).length >= 1);
});

test('callersOf/calleesOf: total gọi add+mul, add chỉ được total gọi', () => {
  const { graph } = buildRepo();
  const callers = graph.callersOf('add');
  assert.equal(callers.length, 1);
  assert.equal(callers[0].caller, 'total');
  assert.equal(callers[0].callerFile, 'src/use.ts');
  const callees = graph.calleesOf('total');
  const calleeNames = callees.map((e) => e.callee).sort();
  assert.ok(calleeNames.includes('add') && calleeNames.includes('mul'));
  assert.throws(() => graph.callersOf('ghost'), /không tìm thấy symbol/);
  assert.throws(() => graph.calleesOf('ghost'), /không tìm thấy symbol/);
});

test('impactSet: đổi add thì total bị ảnh hưởng ở depth 1', () => {
  const { graph } = buildRepo();
  const impact = graph.impactSet('add');
  assert.equal(impact.symbol, 'add');
  assert.equal(impact.file, 'src/math.ts');
  assert.deepEqual(impact.affectedFiles, ['src/use.ts']);
  assert.equal(impact.affectedSymbols.length, 1);
  assert.equal(impact.affectedSymbols[0].qualifiedName, 'total');
  assert.equal(impact.affectedSymbols[0].depth, 1);
  assert.equal(impact.maxDepthReached, 1);
  // Symbol không ai gọi thì impact rỗng.
  const none = graph.impactSet('total');
  assert.deepEqual(none.affectedSymbols, []);
  assert.deepEqual(none.affectedFiles, []);
  assert.throws(() => graph.impactSet('ghost'), /không tìm thấy symbol/);
});

test('queryMap: exact match lên đầu kèm reasons; token match; giới hạn limit', () => {
  const { graph } = buildRepo();
  const result = graph.queryMap('add');
  assert.equal(result.query, 'add');
  assert.ok(result.searched >= 2);
  const firstSymbol = result.hits.find((h) => h.kind === 'symbol');
  assert.equal(firstSymbol.symbol, 'add');
  assert.ok(firstSymbol.reasons.includes('exact name match'));
  assert.ok(firstSymbol.score > 0);
  const token = graph.queryMap('tot');
  assert.ok(token.hits.some((h) => h.symbol === 'total'));
  assert.equal(graph.queryMap('add', 1).hits.length, 1);
  assert.throws(() => graph.queryMap('   '), /Query map rỗng/);
});

test('findCycles: repo không chu trình → []; repo ping/pong → 1 chu trình', () => {
  const acyclic = buildRepo();
  assert.deepEqual(acyclic.graph.findCycles(), []);
  const cyclic = buildRepo({ cycle: true });
  const cycles = cyclic.graph.findCycles();
  assert.equal(cycles.length, 1);
  // Members là id symbol dạng `file#qualifiedName` (xem buildFromParsed).
  assert.deepEqual(cycles[0].members, ['src/cycleA.ts#ping', 'src/cycleB.ts#pong']);
  assert.deepEqual(cycles[0].files, ['src/cycleA.ts', 'src/cycleB.ts']);
  assert.equal(cyclic.data.stats.cyclicComponents, 1);
});

test('lỗi khi chưa build: rank/callers/impact/queryMap đều ném', () => {
  const graph = new V11CallGraph(tmpDir('v11-cg-empty-'));
  assert.equal(graph.current(), null);
  assert.throws(() => graph.rankFiles(), /chưa build/);
  assert.throws(() => graph.rankSymbols(), /chưa build/);
  assert.throws(() => graph.rankByHub(), /chưa build/);
  assert.throws(() => graph.rankByAuthority(), /chưa build/);
  assert.throws(() => graph.callersOf('add'), /chưa build/);
  assert.throws(() => graph.calleesOf('add'), /chưa build/);
  assert.throws(() => graph.impactSet('add'), /chưa build/);
  assert.throws(() => graph.queryMap('add'), /chưa build/);
  assert.throws(() => graph.findCycles(), /chưa build/);
});

test('v11BuildCallGraphFromParsed: build từ parsed sẵn, không cần quét đĩa', () => {
  const sym = (name, line, exported) => ({
    kind: 'function',
    name,
    qualifiedName: name,
    line,
    column: 1,
    endLine: line + 2,
    exported,
    async: false,
    signature: `function ${name}()`,
    params: [],
  });
  const files = [
    {
      relPath: 'a.ts',
      language: 'typescript',
      contentHash: 'x',
      size: 10,
      symbols: [sym('alpha', 1, true), sym('beta', 4, true)],
      calls: [{ caller: 'alpha', calleeName: 'beta', line: 2, memberCall: false }],
      imports: [],
      hasError: false,
      parseErrors: [],
    },
    {
      relPath: 'b.ts',
      language: 'typescript',
      contentHash: 'y',
      size: 10,
      symbols: [sym('gamma', 1, true)],
      calls: [{ caller: 'gamma', calleeName: 'alpha', line: 2, memberCall: false }],
      imports: [{ specifier: './a', resolved: 'a.ts', names: ['alpha'], line: 1 }],
      hasError: false,
      parseErrors: [],
    },
  ];
  const data = v11BuildCallGraphFromParsed(files, '/tmp');
  assert.equal(data.stats.files, 2);
  assert.equal(data.stats.symbols, 3);
  assert.equal(data.stats.unresolvedCalls, 0);
  assert.equal(data.stats.resolvedEdges, 2);
  const alphaCallers = data.edges.filter((e) => e.callee === 'alpha');
  assert.equal(alphaCallers.length, 1);
  assert.equal(alphaCallers[0].resolvedBy, 'import');
  const betaEdge = data.edges.find((e) => e.callee === 'beta');
  assert.equal(betaEdge.resolvedBy, 'same-file');
  // beta được alpha gọi nên authority/rank cao hơn alpha? Ít nhất
  // cả ba symbol đều có pageRank > 0.
  assert.ok(data.symbols.every((s) => s.pageRank > 0));
});
