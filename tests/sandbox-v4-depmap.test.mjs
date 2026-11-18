/**
 * Tests cho Sandbox v4 — dependency map (v1.36, Đội T4).
 *
 * Run sau khi build core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/sandbox-v4-depmap.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  SandboxV4DependencyMapBuilder,
  affectedSetSandboxV4DepMap,
  detectSandboxV4DepConflicts,
  dependentsOfSandboxV4DepMap,
  dependenciesOfSandboxV4DepMap,
  extractImportSpecifiers,
  findSandboxV4DepCycles,
  isRelativeSpecifier,
  planSandboxV4Changes,
  topoOrderSandboxV4DepMap,
} from '../packages/core/dist/sandboxV4/index.js';

const tempDirs = [];
function makeTempDir(prefix = 'open-bot-sandbox-v4-depmap-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function cleanupTempDirs() {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
}

/** A small tree: a→b→c, d→a, e↔f cycle, g standalone, h uses node:fs + react. */
function writeTree(root) {
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'c.ts'), 'export const c = 1;\n');
  fs.writeFileSync(path.join(root, 'src', 'b.ts'), "import { c } from './c';\nexport const b = c + 1;\n");
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), "import { b } from './b';\nimport { c } from './c';\nexport const a = b + c;\n");
  fs.writeFileSync(path.join(root, 'src', 'd.ts'), "import { a } from './a';\nexport const d = a;\n");
  fs.writeFileSync(path.join(root, 'src', 'e.ts'), "import { f } from './f';\nexport const e = f;\n");
  fs.writeFileSync(path.join(root, 'src', 'f.ts'), "import { e } from './e';\nexport const f = e;\n");
  fs.writeFileSync(path.join(root, 'src', 'g.ts'), 'export const g = 1;\n');
  fs.writeFileSync(
    path.join(root, 'src', 'h.ts'),
    "import * as fs from 'node:fs';\nimport React from 'react';\nimport { a } from './a';\nexport const h = a;\n",
  );
  fs.writeFileSync(path.join(root, 'src', 'i.py'), 'from .a import x\nimport os\n');
  fs.writeFileSync(path.join(root, 'src', 'bad.ts'), "import { nope } from './missing';\nexport const bad = 1;\n");
  // Skipped dirs: node_modules + dist are never scanned.
  fs.mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules', 'pkg', 'index.js'), "require('./deep');\n");
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(root, 'dist', 'out.js'), "import './x';\n");
}

test('depmap: extractImportSpecifiers handles ES, CJS, dynamic and Python imports', () => {
  const js = `
    import { a } from './a';
    import './side';
    import type { T } from '../types';
    export { b } from './b';
    const c = require('./c');
    const d = await import('./d');
    import fs from 'node:fs';
  `;
  const specs = extractImportSpecifiers(js, '.ts');
  assert.deepEqual(specs, ['../types', './a', './b', './c', './d', './side', 'node:fs']);
  assert.deepEqual(extractImportSpecifiers('from .a import x\nimport os\n', '.py'), ['.a', 'os']);
  assert.equal(isRelativeSpecifier('./x'), true);
  assert.equal(isRelativeSpecifier('../x'), true);
  assert.equal(isRelativeSpecifier('react'), false);
  assert.equal(isRelativeSpecifier('node:fs'), false);
});

test('depmap: build — nodes, edges, external imports, skipped dirs, cycles', () => {
  const root = makeTempDir();
  try {
    writeTree(root);
    const builder = new SandboxV4DependencyMapBuilder({ rootDir: root });
    const { map, skippedOversize, unresolvable } = builder.build();
    assert.equal(map.rootDir, root);
    assert.equal(map.fileCount, 10);
    assert.deepEqual(Object.keys(map.nodes).sort(), [
      'src/a.ts',
      'src/b.ts',
      'src/bad.ts',
      'src/c.ts',
      'src/d.ts',
      'src/e.ts',
      'src/f.ts',
      'src/g.ts',
      'src/h.ts',
      'src/i.py',
    ]);
    assert.deepEqual(map.nodes['src/a.ts'].imports, ['src/b.ts', 'src/c.ts']);
    assert.deepEqual(map.nodes['src/b.ts'].imports, ['src/c.ts']);
    assert.deepEqual(map.nodes['src/c.ts'].imports, []);
    assert.deepEqual(map.nodes['src/c.ts'].importedBy, ['src/a.ts', 'src/b.ts']);
    assert.deepEqual(map.nodes['src/h.ts'].externalImports, ['node:fs', 'react']);
    assert.deepEqual(map.nodes['src/h.ts'].imports, ['src/a.ts']);
    assert.equal(map.edgeCount, 7);
    assert.deepEqual(skippedOversize, []);
    // bad.ts imports './missing' — relative but unresolvable in the tree.
    assert.deepEqual(unresolvable, [{ from: 'src/bad.ts', specifier: './missing' }]);
    assert.equal(map.cycles.length, 1);
    assert.deepEqual(map.cycles[0].files, ['src/e.ts', 'src/f.ts']);
    assert.equal(builder.getLastMap()?.fileCount, 10);
    assert.throws(() => new SandboxV4DependencyMapBuilder({ rootDir: path.join(root, 'nope') }), /not a directory/);
    assert.throws(() => new SandboxV4DependencyMapBuilder({ rootDir: '' }), /non-empty rootDir/);
  } finally {
    cleanupTempDirs();
  }
});

test('depmap: topo order (dependencies first), cycles stay unordered', () => {
  const root = makeTempDir();
  try {
    writeTree(root);
    const { map } = new SandboxV4DependencyMapBuilder({ rootDir: root }).build();
    const { order, unordered } = topoOrderSandboxV4DepMap(map);
    assert.deepEqual(unordered, ['src/e.ts', 'src/f.ts']);
    const idx = (f) => order.indexOf(f);
    assert.ok(idx('src/c.ts') < idx('src/b.ts'));
    assert.ok(idx('src/b.ts') < idx('src/a.ts'));
    assert.ok(idx('src/a.ts') < idx('src/d.ts'));
    assert.ok(idx('src/a.ts') < idx('src/h.ts'));
    assert.equal(order.length, 8);
    // Direct helpers.
    assert.deepEqual(dependenciesOfSandboxV4DepMap(map, 'src/a.ts'), ['src/b.ts', 'src/c.ts']);
    assert.deepEqual(dependentsOfSandboxV4DepMap(map, 'src/c.ts'), ['src/a.ts', 'src/b.ts']);
    assert.deepEqual(dependenciesOfSandboxV4DepMap(map, 'nope.ts'), []);
    assert.deepEqual(dependentsOfSandboxV4DepMap(map, 'nope.ts'), []);
  } finally {
    cleanupTempDirs();
  }
});

test('depmap: affected set answers "what breaks if I change this"', () => {
  const root = makeTempDir();
  try {
    writeTree(root);
    const { map } = new SandboxV4DependencyMapBuilder({ rootDir: root }).build();
    assert.deepEqual(affectedSetSandboxV4DepMap(map, ['src/c.ts']), ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/h.ts']);
    assert.deepEqual(affectedSetSandboxV4DepMap(map, ['src/d.ts']), ['src/d.ts']);
    assert.deepEqual(affectedSetSandboxV4DepMap(map, ['src/g.ts']), ['src/g.ts']);
    assert.deepEqual(affectedSetSandboxV4DepMap(map, ['nope.ts']), []);
    assert.deepEqual(affectedSetSandboxV4DepMap(map, ['src/a.ts', 'src/c.ts']), ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/h.ts']);
  } finally {
    cleanupTempDirs();
  }
});

test('depmap: conflicts — same file, overlapping impact, clean sets', () => {
  const root = makeTempDir();
  try {
    writeTree(root);
    const { map } = new SandboxV4DependencyMapBuilder({ rootDir: root }).build();
    const same = detectSandboxV4DepConflicts(map, [
      { agentId: 'agent-1', files: ['src/a.ts'], description: 'refactor a' },
      { agentId: 'agent-2', files: ['src/a.ts', 'src/g.ts'], description: 'fix a' },
    ]);
    assert.equal(same.length, 1);
    assert.equal(same[0].kind, 'same-file');
    assert.deepEqual(same[0].files, ['src/a.ts']);

    // agent-1 edits c (a, b, d, h depend on it); agent-2 edits d.
    const impact = detectSandboxV4DepConflicts(map, [
      { agentId: 'agent-1', files: ['src/c.ts'], description: 'change c' },
      { agentId: 'agent-2', files: ['src/d.ts'], description: 'change d' },
    ]);
    assert.equal(impact.length, 1);
    assert.equal(impact[0].kind, 'overlapping-impact');
    assert.ok(impact[0].files.includes('src/d.ts'));

    const clean = detectSandboxV4DepConflicts(map, [
      { agentId: 'agent-1', files: ['src/g.ts'], description: 'change g' },
      { agentId: 'agent-2', files: ['src/e.ts'], description: 'change e' },
    ]);
    assert.deepEqual(clean, []);
    assert.deepEqual(detectSandboxV4DepConflicts(map, [
      { agentId: 'agent-1', files: [], description: 'nothing' },
      { agentId: 'agent-2', files: ['src/a.ts'], description: 'change a' },
    ]), []);
    assert.throws(
      () => detectSandboxV4DepConflicts(map, [
        { agentId: 'dup', files: [], description: '' },
        { agentId: 'dup', files: [], description: '' },
      ]),
      /Duplicate agentId/,
    );
  } finally {
    cleanupTempDirs();
  }
});

test('depmap: change plan waves run in dependency order; cycles unordered', () => {
  const root = makeTempDir();
  try {
    writeTree(root);
    const { map } = new SandboxV4DependencyMapBuilder({ rootDir: root }).build();
    const plan = planSandboxV4Changes(map, ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts']);
    assert.equal(plan.hasCycles, true);
    assert.deepEqual(plan.unordered, []);
    assert.deepEqual(plan.waves, [['src/c.ts'], ['src/b.ts'], ['src/a.ts'], ['src/d.ts']]);
    const cyclic = planSandboxV4Changes(map, ['src/e.ts', 'src/f.ts']);
    assert.deepEqual(cyclic.waves, []);
    assert.deepEqual(cyclic.unordered, ['src/e.ts', 'src/f.ts']);
    const partial = planSandboxV4Changes(map, ['src/d.ts', 'src/g.ts']);
    assert.deepEqual(partial.waves, [['src/d.ts', 'src/g.ts']]);
  } finally {
    cleanupTempDirs();
  }
});

test('depmap: rebuildChanged re-scans only moved files', () => {
  const root = makeTempDir();
  try {
    writeTree(root);
    const builder = new SandboxV4DependencyMapBuilder({ rootDir: root });
    const first = builder.build();
    assert.equal(first.map.fileCount, 10);
    const untouched = builder.rebuildChanged();
    assert.deepEqual(untouched.rescanned, []);
    assert.deepEqual(untouched.removed, []);
    // Edit b.ts to drop its import of c.
    fs.writeFileSync(path.join(root, 'src', 'b.ts'), 'export const b = 2;\n');
    const changed = builder.rebuildChanged();
    assert.deepEqual(changed.rescanned, ['src/b.ts']);
    assert.deepEqual(changed.map.nodes['src/b.ts'].imports, []);
    assert.deepEqual(changed.map.nodes['src/c.ts'].importedBy, ['src/a.ts']);
    // Delete a file: it is reported removed and leaves the map.
    fs.rmSync(path.join(root, 'src', 'g.ts'));
    const removed = builder.rebuildChanged();
    assert.deepEqual(removed.removed, ['src/g.ts']);
    assert.equal(removed.map.nodes['src/g.ts'], undefined);
    const fresh = new SandboxV4DependencyMapBuilder({ rootDir: root });
    assert.throws(() => fresh.rebuildChanged(), /call build\(\) before rebuildChanged/);
  } finally {
    cleanupTempDirs();
  }
});

test('depmap: findSandboxV4DepCycles finds a self-import and a 3-cycle', () => {
  const nodes = {
    'a.ts': { path: 'a.ts', kind: 'ts', imports: ['a.ts'], importedBy: ['a.ts'], externalImports: [], sizeBytes: 1, mtimeMs: 1 },
    'x.ts': { path: 'x.ts', kind: 'ts', imports: ['y.ts'], importedBy: ['z.ts'], externalImports: [], sizeBytes: 1, mtimeMs: 1 },
    'y.ts': { path: 'y.ts', kind: 'ts', imports: ['z.ts'], importedBy: ['x.ts'], externalImports: [], sizeBytes: 1, mtimeMs: 1 },
    'z.ts': { path: 'z.ts', kind: 'ts', imports: ['x.ts'], importedBy: ['y.ts'], externalImports: [], sizeBytes: 1, mtimeMs: 1 },
  };
  const cycles = findSandboxV4DepCycles(nodes);
  assert.equal(cycles.length, 2);
  assert.deepEqual(cycles[0].files, ['a.ts']);
  assert.deepEqual(cycles[1].files, ['x.ts', 'y.ts', 'z.ts']);
});
