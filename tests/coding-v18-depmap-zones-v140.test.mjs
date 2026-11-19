/**
 * Tests cho coding agent v18 — dependency map toàn repo + topo order +
 * vùng sở hữu + xung đột (v1.40, Đội T4).
 *
 * Chạy thật: build đồ thị từ nội dung file mẫu, Tarjan SCC tìm cycle,
 * Kahn topo theo tầng, chia vùng theo tiền tố, kiểm tra xung đột
 * trước khi sửa. Không gọi model/mạng.
 *   npm run build --workspace=@open-bot/core  (scoped, trong worktree)
 *   node --test tests/coding-v18-depmap-zones-v140.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  renderV18DepGraph,
  renderV18GraphStats,
  renderV18ImpactSet,
  renderV18TopoPlan,
  renderV18ZoneConflicts,
  renderV18Zones,
  v18BuildDepGraph,
  v18BuildZones,
  v18CheckZoneConflicts,
  v18DefaultZoneDefs,
  v18DepNodeKind,
  v18EntryPoints,
  v18ExtractImports,
  v18FindCycles,
  v18FindOrphans,
  v18GraphStats,
  v18ImpactSet,
  v18LeafModules,
  v18NormalizePath,
  v18ParallelWaves,
  v18ResolveAlias,
  v18ResolveRelative,
  v18SortByTopo,
  v18TopoOrder,
  v18ZoneOfFile,
} from '../packages/core/dist/index.js';

function repoFixture() {
  return new Map([
    ['src/a.ts', "import { b } from './b';\nexport const a = 1;\n"],
    ['src/b.ts', "import { c } from './c';\nexport const b = 1;\n"],
    ['src/c.ts', 'export const c = 1;\n'],
    ['src/d.ts', "import { a } from './a';\nimport { c } from './c';\nexport const d = 1;\n"],
    ['tests/a.test.mjs', "import { a } from '../src/a';\n"],
  ]);
}

test('depmap: trích import tĩnh/động/require/export-from', () => {
  const imports = v18ExtractImports(
    "import { a } from './a';\nimport type { T } from './types';\nexport { x } from './x';\nconst y = require('./y');\nconst z = await import('./z');\n",
  );
  const specs = imports.map((i) => i.spec);
  assert.ok(specs.includes('./a'));
  assert.ok(specs.includes('./types'));
  assert.ok(specs.includes('./x'));
  assert.ok(specs.includes('./y'));
  assert.ok(specs.includes('./z'));
  assert.equal(imports.find((i) => i.spec === './types')?.kind, 'type');
  assert.equal(imports.find((i) => i.spec === './z')?.kind, 'dynamic');
  assert.equal(v18NormalizePath('src/../src/./a.ts'), 'src/a.ts');
  assert.equal(v18DepNodeKind('tests/a.test.mjs'), 'test');
  assert.equal(v18DepNodeKind('package.json'), 'config');
  assert.equal(v18DepNodeKind('src/a.ts'), 'source');
});

test('depmap: build đồ thị — node, edge, hub, depth, external import', () => {
  const files = repoFixture();
  files.set('src/e.ts', "import React from 'react';\nimport { a } from './a';\nexport const e = 1;\n");
  const graph = v18BuildDepGraph('repo', files, { now: 1000 });
  assert.equal(graph.fileCount, 6);
  assert.equal(graph.edges.length, 6);
  assert.equal(graph.cycles.length, 0);
  assert.deepEqual(graph.externalImports, ['react']);
  const a = graph.nodes.find((n) => n.path === 'src/a.ts');
  assert.deepEqual(a.imports, ['src/b.ts']);
  assert.deepEqual([...a.importedBy].sort(), ['src/d.ts', 'src/e.ts', 'tests/a.test.mjs']);
  const c = graph.nodes.find((n) => n.path === 'src/c.ts');
  assert.equal(c.depth, 3, 'c bị import qua chuỗi d/a/b nên depth dài nhất');
  const b = graph.nodes.find((n) => n.path === 'src/b.ts');
  assert.ok(c.depth > b.depth, 'file bị import sâu hơn có depth lớn hơn');
  assert.ok(b.depth > a.depth, 'b bị import qua a nên sâu hơn a');
  const d = graph.nodes.find((n) => n.path === 'src/d.ts');
  assert.equal(d.depth, 0, 'file không bị import là gốc (depth 0)');
  assert.match(renderV18DepGraph(graph), /6 files, 6 edges, 0 cycles/);
});

test('depmap: resolve tương đối + alias @open-bot/*', () => {
  const known = new Set(['packages/core/src/a.ts', 'packages/core/src/b.ts', 'packages/core/src/util/index.ts']);
  assert.equal(v18ResolveRelative('packages/core/src/a.ts', './b', known), 'packages/core/src/b.ts');
  assert.equal(v18ResolveRelative('packages/core/src/a.ts', './util', known), 'packages/core/src/util/index.ts');
  assert.equal(v18ResolveRelative('packages/core/src/a.ts', './missing', known), undefined);
  assert.equal(v18ResolveAlias('@open-bot/core/b', known), 'packages/core/src/b.ts');
  assert.equal(v18ResolveAlias('@open-bot/core/missing', known), undefined);
  assert.equal(v18ResolveAlias('react', known), undefined);
});

test('depmap: phát hiện cycle (Tarjan SCC) — cycle 2 node + cycle 3 node', () => {
  const files = new Map([
    ['src/x.ts', "import { y } from './y';\nexport const x = 1;\n"],
    ['src/y.ts', "import { x } from './x';\nexport const y = 1;\n"],
    ['src/p.ts', "import { q } from './q';\nexport const p = 1;\n"],
    ['src/q.ts', "import { r } from './r';\nexport const q = 1;\n"],
    ['src/r.ts', "import { p } from './p';\nexport const r = 1;\n"],
    ['src/z.ts', 'export const z = 1;\n'],
  ]);
  const graph = v18BuildDepGraph('repo', files, { now: 1000 });
  assert.equal(graph.cycles.length, 2);
  const flat = graph.cycles.flat();
  assert.ok(flat.includes('src/x.ts') && flat.includes('src/y.ts'));
  assert.ok(flat.includes('src/p.ts') && flat.includes('src/q.ts') && flat.includes('src/r.ts'));
  assert.equal(v18FindCycles(graph).length, 2);
  const topo = v18TopoOrder(graph);
  assert.deepEqual([...topo.blockedFiles].sort(), ['src/p.ts', 'src/q.ts', 'src/r.ts', 'src/x.ts', 'src/y.ts']);
  assert.deepEqual(topo.order, ['src/z.ts'], 'chỉ file ngoài cycle có thứ tự topo');
});

test('depmap: topo order theo tầng — dependency trước, dependent sau, cùng tầng sửa song song', () => {
  const graph = v18BuildDepGraph('repo', repoFixture(), { now: 1000 });
  const topo = v18TopoOrder(graph);
  assert.deepEqual(topo.order, ['src/c.ts', 'src/b.ts', 'src/a.ts', 'src/d.ts', 'tests/a.test.mjs']);
  assert.equal(topo.levels.length, 4);
  assert.deepEqual(topo.levels[0].files, ['src/c.ts']);
  assert.deepEqual(topo.levels[1].files, ['src/b.ts']);
  assert.deepEqual(topo.levels[2].files, ['src/a.ts']);
  assert.deepEqual(topo.levels[3].files, ['src/d.ts', 'tests/a.test.mjs']);
  assert.deepEqual(v18ParallelWaves(topo), topo.levels);
  assert.deepEqual(topo.blockedFiles, []);
  const text = renderV18TopoPlan(topo);
  assert.match(text, /4 tầng/);
  assert.match(text, /Tầng 3 \(2 files\)/);
});

test('depmap: sắp xếp file theo topo order', () => {
  const graph = v18BuildDepGraph('repo', repoFixture(), { now: 1000 });
  assert.deepEqual(
    v18SortByTopo(graph, ['src/d.ts', 'src/c.ts', 'src/a.ts']),
    ['src/c.ts', 'src/a.ts', 'src/d.ts'],
  );
  assert.deepEqual(
    v18SortByTopo(graph, ['src/unknown.ts', 'src/c.ts']),
    ['src/c.ts', 'src/unknown.ts'],
    'file chưa biết giữ cuối',
  );
});

test('depmap: root rỗng bị từ chối', () => {
  assert.throws(() => v18BuildDepGraph('', new Map()), /root không được rỗng/);
});

test('zones: chia vùng mặc định theo layout repo + file chưa gán', () => {
  const files = new Map([
    ['packages/core/src/a.ts', 'export const a = 1;\n'],
    ['packages/tools/src/t.ts', 'export const t = 1;\n'],
    ['apps/desktop/src/app.ts', 'export const app = 1;\n'],
    ['tests/x.test.mjs', 'test\n'],
    ['docs/guide.md', '# guide\n'],
    ['other.txt', 'hello\n'],
  ]);
  const graph = v18BuildDepGraph('repo', files, { now: 1000 });
  const plan = v18BuildZones(graph);
  assert.equal(plan.zones.length, 6);
  assert.equal(plan.zones.find((z) => z.id === 'core')?.fileCount, 1);
  assert.equal(plan.zones.find((z) => z.id === 'core')?.owner, 'core-team');
  assert.equal(plan.zones.find((z) => z.id === 'tools')?.fileCount, 1);
  assert.equal(plan.zones.find((z) => z.id === 'tests')?.fileCount, 1);
  assert.deepEqual(plan.unassigned, ['other.txt']);
  assert.equal(v18ZoneOfFile(plan.zones, 'packages/core/src/a.ts')?.id, 'core');
  assert.equal(v18ZoneOfFile(plan.zones, 'other.txt'), undefined);
  const text = renderV18Zones(plan);
  assert.match(text, /6 vùng, 1 files chưa gán/);
  assert.match(text, /core \(Core, owner core-team\): 1 files/);
});

test('zones: zone defs tuỳ chỉnh thắng mặc định', () => {
  const graph = v18BuildDepGraph('repo', new Map([
    ['services/api/handler.ts', 'export const h = 1;\n'],
    ['services/web/page.ts', 'export const p = 1;\n'],
  ]), { now: 1000 });
  const plan = v18BuildZones(graph, [
    { id: 'api', name: 'API', owner: 'api-team', prefixes: ['services/api/'] },
    { id: 'web', name: 'Web', owner: 'web-team', prefixes: ['services/web/'] },
  ]);
  assert.equal(plan.zones.find((z) => z.id === 'api')?.fileCount, 1);
  assert.equal(plan.zones.find((z) => z.id === 'web')?.fileCount, 1);
  assert.deepEqual(plan.unassigned, []);
  assert.deepEqual(v18DefaultZoneDefs().map((z) => z.id), ['core', 'tools', 'desktop', 'cli', 'tests', 'docs']);
});

test('zones: xung đột cross-zone — agent sửa file ngoài vùng của mình', () => {
  const files = new Map([
    ['packages/core/src/a.ts', "import { b } from './b';\nexport const a = 1;\n"],
    ['packages/core/src/b.ts', 'export const b = 1;\n'],
    ['packages/tools/src/t.ts', 'export const t = 1;\n'],
  ]);
  const graph = v18BuildDepGraph('repo', files, { now: 1000 });
  const plan = v18BuildZones(graph);
  const conflicts = v18CheckZoneConflicts(graph, plan.zones, ['packages/tools/src/t.ts'], { agentZone: 'core' });
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].kind, 'cross-zone');
  assert.equal(conflicts[0].zoneA, 'core');
  assert.equal(conflicts[0].zoneB, 'tools');
  assert.match(conflicts[0].message, /không được sửa/);
  // Cùng vùng thì không xung đột.
  assert.deepEqual(
    v18CheckZoneConflicts(graph, plan.zones, ['packages/core/src/a.ts'], { agentZone: 'core' }),
    [],
  );
  assert.match(renderV18ZoneConflicts([]), /Không có xung đột/);
  assert.match(renderV18ZoneConflicts(conflicts), /1 xung đột/);
});

test('zones: xung đột out-of-order — sửa dependent trước dependency', () => {
  const graph = v18BuildDepGraph('repo', repoFixture(), { now: 1000 });
  const plan = v18BuildZones(graph);
  // a import b: sửa a trước b là sai thứ tự.
  const conflicts = v18CheckZoneConflicts(graph, plan.zones, ['src/a.ts', 'src/b.ts'], {});
  const orderConflict = conflicts.find((c) => c.kind === 'out-of-order');
  assert.ok(orderConflict, 'phải phát hiện out-of-order');
  assert.deepEqual(orderConflict.files, ['src/a.ts', 'src/b.ts']);
  // Đúng thứ tự thì không xung đột (file src/* chưa gán vùng nên bỏ qua cross-zone bằng cách không truyền agentZone
  // và dùng graph có vùng: ở đây src/* đều unassigned nên chỉ kiểm tra out-of-order).
  const okOrder = v18CheckZoneConflicts(graph, plan.zones, ['src/b.ts', 'src/a.ts'], {});
  assert.equal(okOrder.filter((c) => c.kind === 'out-of-order').length, 0);
});

test('zones: xung đột cycle + file chưa gán vùng', () => {
  const files = new Map([
    ['src/x.ts', "import { y } from './y';\nexport const x = 1;\n"],
    ['src/y.ts', "import { x } from './x';\nexport const y = 1;\n"],
  ]);
  const graph = v18BuildDepGraph('repo', files, { now: 1000 });
  const plan = v18BuildZones(graph);
  const conflicts = v18CheckZoneConflicts(graph, plan.zones, ['src/x.ts'], {});
  assert.ok(conflicts.some((c) => c.kind === 'cycle'), 'file trong cycle phải bị báo');
  assert.ok(conflicts.some((c) => c.kind === 'cross-zone'), 'file chưa gán vùng phải bị báo');
});

test('depmap: impact set (blast radius) + entry points + leaf modules', () => {
  const graph = v18BuildDepGraph('repo', repoFixture(), { now: 1000 });
  // Đổi c: b và d import c, a import b, test import a => ảnh hưởng cả 5 files.
  assert.deepEqual(
    v18ImpactSet(graph, ['src/c.ts']),
    ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'tests/a.test.mjs'],
  );
  // Đổi d: không ai import d => chỉ mình d.
  assert.deepEqual(v18ImpactSet(graph, ['src/d.ts']), ['src/d.ts']);
  // Đổi b: a import b, d và test import a => b, a, d, test.
  assert.deepEqual(
    v18ImpactSet(graph, ['src/b.ts']),
    ['src/a.ts', 'src/b.ts', 'src/d.ts', 'tests/a.test.mjs'],
  );
  assert.deepEqual(v18EntryPoints(graph), ['src/d.ts', 'tests/a.test.mjs']);
  assert.deepEqual(v18LeafModules(graph), ['src/c.ts']);
  const text = renderV18ImpactSet(graph, ['src/c.ts']);
  assert.match(text, /ảnh hưởng tới 5 files/);
});

test('depmap: impact set trên repo có cycle vẫn kết thúc (không lặp vô hạn)', () => {
  const files = new Map([
    ['src/x.ts', "import { y } from './y';\nexport const x = 1;\n"],
    ['src/y.ts', "import { x } from './x';\nexport const y = 1;\n"],
  ]);
  const graph = v18BuildDepGraph('repo', files, { now: 1000 });
  assert.deepEqual(v18ImpactSet(graph, ['src/x.ts']), ['src/x.ts', 'src/y.ts']);
});

test('depmap: orphans + graph stats', () => {
  const graph = v18BuildDepGraph('repo', repoFixture(), { now: 1000 });
  // Chỉ d là orphan: test file khớp entry pattern /\.test\./ nên không tính.
  assert.deepEqual(v18FindOrphans(graph), ['src/d.ts']);
  assert.ok(!v18FindOrphans(graph).includes('tests/a.test.mjs'));
  assert.ok(!v18FindOrphans(graph).includes('src/a.ts'));
  assert.ok(!v18FindOrphans(graph).includes('src/c.ts'));
  // File index là entry quen thuộc nên không tính orphan.
  const withIndex = v18BuildDepGraph('repo', new Map([
    ['src/index.ts', "import { a } from './a';\n"],
    ['src/a.ts', 'export const a = 1;\n'],
    ['src/dead.ts', 'export const dead = 1;\n'],
  ]), { now: 1000 });
  assert.deepEqual(v18FindOrphans(withIndex), ['src/dead.ts']);

  const stats = v18GraphStats(graph);
  assert.equal(stats.fileCount, 5);
  assert.equal(stats.edgeCount, 5);
  assert.equal(stats.cycleCount, 0);
  assert.equal(stats.averageFanOut, 1);
  assert.equal(stats.averageFanIn, 1);
  assert.deepEqual(stats.maxFanIn, { file: 'src/a.ts', count: 2 });
  assert.deepEqual(stats.maxFanOut, { file: 'src/d.ts', count: 2 });
  assert.equal(stats.entryPoints, 2);
  assert.equal(stats.leafModules, 1);
  assert.match(renderV18GraphStats(graph), /5 files, 5 edges, 0 cycles/);
  assert.match(renderV18GraphStats(graph), /cao nhất: src\/a\.ts 2/);
});
