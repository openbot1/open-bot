/**
 * Repo map v4 tests (v1.17, Doi T3 — node:test).
 *
 * Covers:
 * - rm4LanguageForPath: duoi file -> ngon ngu.
 * - rm4ParseFile: TS (tai dung parser v8: class/function + import,
 *   khong lay than ham), Python, Go, Rust, Java; file la tra rong.
 * - rm4PageRank: tong diem = 1, node duoc import nhieu thi diem cao,
 *   personalization day diem node khop.
 * - buildRm4Graph: canh imports/calls/defines, resolve import tuong
 *   doi, ten goi mo ho dem vao stats (khong crash).
 * - rankRm4Files: file duoc import boi file quan trong thi rank cao.
 * - queryRm4Graph: tim theo ten, exact match truoc, kem reasons.
 * - renderRm4BudgetMap: cat theo budget token, bao included /
 *   omitted / partial, token khong vuot budget.
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/router-v117-repomap-v4.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRm4Graph,
  queryRm4Graph,
  rankRm4Files,
  renderRm4BudgetMap,
  rm4EstimateTokens,
  rm4LanguageForPath,
  rm4PageRank,
  rm4ParseFile,
  rm4ResolveImport,
} from '../packages/core/dist/routerV2/index.js';

const tsMain = `
import { save } from './store';
import { format } from './util';

/** Save a record. */
export async function handleSave(id: string): Promise<boolean> {
  const ok = await save(id);
  return ok && format(id).length > 0;
}

export class Service {
  async run(id: string): Promise<void> {
    await handleSave(id);
  }
}
`;

const tsStore = `
export async function save(id: string): Promise<boolean> {
  return id.length > 0;
}
`;

const tsUtil = `
export function format(id: string): string {
  return id.toUpperCase();
}
`;

const pyMod = `
import os

def load(path):
    """Load a file."""
    return open(path).read()

class Store:
    def get(self, key):
        return load(key)
`;

const goMod = `
package store

import "fmt"

type Store struct {
  Name string
}

// Save writes a record.
func (s *Store) Save(id string) error {
  fmt.Println(id)
  return nil
}

func Load(id string) (*Store, error) {
  return &Store{Name: id}, nil
}
`;

const rustMod = `
use std::fs;

pub struct Store {
    pub name: String,
}

impl Store {
    pub fn save(&self, id: &str) -> bool {
        let _ = fs::read(id);
        true
    }
}

pub fn load(id: &str) -> Store {
    Store { name: id.to_string() }
}
`;

const javaMod = `
package com.example;

import java.util.List;

public class Store {
    public boolean save(String id) {
        return id.length() > 0;
    }

    private List<String> list() {
        return List.of();
    }
}
`;

test('rm4LanguageForPath: duoi file -> ngon ngu', () => {
  assert.equal(rm4LanguageForPath('a.ts'), 'typescript');
  assert.equal(rm4LanguageForPath('a.tsx'), 'typescript');
  assert.equal(rm4LanguageForPath('a.js'), 'javascript');
  assert.equal(rm4LanguageForPath('a.py'), 'python');
  assert.equal(rm4LanguageForPath('a.go'), 'go');
  assert.equal(rm4LanguageForPath('a.rs'), 'rust');
  assert.equal(rm4LanguageForPath('a.java'), 'java');
  assert.equal(rm4LanguageForPath('a.md'), 'unknown');
});

test('rm4ParseFile: TS lay signature + import, khong lay than ham', () => {
  const p = rm4ParseFile('src/main.ts', tsMain);
  assert.equal(p.language, 'typescript');
  assert.equal(p.hasError, false);
  const names = p.signatures.map((s) => s.name);
  assert.ok(names.includes('handleSave'));
  assert.ok(names.includes('Service'));
  const fn = p.signatures.find((s) => s.name === 'handleSave');
  assert.ok(fn.signature.includes('handleSave'));
  assert.ok(!fn.signature.includes('return ok'));
  assert.ok(fn.signature.length <= 200);
  assert.ok(p.imports.includes('./store'));
  assert.ok(p.calledNames.includes('save'));
});

test('rm4ParseFile: Python / Go / Rust / Java', () => {
  const py = rm4ParseFile('mod.py', pyMod);
  assert.ok(py.signatures.some((s) => s.name === 'load' && s.kind === 'function'));
  assert.ok(py.signatures.some((s) => s.name === 'Store' && s.kind === 'class'));
  assert.ok(py.imports.includes('os'));

  const go = rm4ParseFile('store.go', goMod);
  assert.ok(go.signatures.some((s) => s.name === 'Save' && s.kind === 'method' && s.exported));
  assert.ok(go.signatures.some((s) => s.name === 'Load' && s.kind === 'function'));
  assert.ok(go.signatures.some((s) => s.name === 'Store' && s.kind === 'class'));
  assert.ok(go.imports.includes('fmt'));

  const rs = rm4ParseFile('lib.rs', rustMod);
  assert.ok(rs.signatures.some((s) => s.name === 'save' && s.kind === 'method'));
  assert.ok(rs.signatures.some((s) => s.name === 'load' && s.kind === 'function'));
  assert.ok(rs.signatures.some((s) => s.name === 'Store'));

  const java = rm4ParseFile('Store.java', javaMod);
  assert.ok(java.signatures.some((s) => s.name === 'Store' && s.kind === 'class'));
  assert.ok(java.signatures.some((s) => s.name === 'save' && s.kind === 'method'));
  assert.ok(java.imports.some((i) => i.includes('java.util.List')));
});

test('rm4ParseFile: ngon ngu la tra file rong, khong crash', () => {
  const p = rm4ParseFile('README.md', '# hello\n');
  assert.equal(p.language, 'unknown');
  assert.deepEqual(p.signatures, []);
  assert.equal(p.hasError, false);
});

test('rm4ResolveImport: tuong doi -> file trong repo', () => {
  const known = new Set(['src/store.ts', 'src/util.ts', 'lib/c.py']);
  assert.equal(rm4ResolveImport('src/main.ts', './store', known), 'src/store.ts');
  assert.equal(rm4ResolveImport('src/deep/main.ts', '../util', known), 'src/util.ts');
  assert.equal(rm4ResolveImport('src/main.ts', 'node:fs', known), null);
  assert.equal(rm4ResolveImport('src/main.ts', './missing', known), null);
});

test('rm4PageRank: tong = 1, node duoc tro toi nhieu thi cao', () => {
  const nodes = ['a', 'b', 'c'];
  const edges = [
    { from: 'a', to: 'b', kind: 'imports', weight: 3 },
    { from: 'c', to: 'b', kind: 'imports', weight: 3 },
    { from: 'b', to: 'a', kind: 'imports', weight: 3 },
  ];
  const { scores, iterations } = rm4PageRank(nodes, edges);
  const total = [...scores.values()].reduce((s, v) => s + v, 0);
  assert.ok(Math.abs(total - 1) < 1e-6);
  assert.ok((scores.get('b') ?? 0) > (scores.get('c') ?? 0));
  assert.ok(iterations > 0);
  const empty = rm4PageRank([], []);
  assert.equal(empty.scores.size, 0);
});

test('rm4PageRank: personalization day diem node khop', () => {
  const nodes = ['a', 'b'];
  const edges = [{ from: 'a', to: 'b', kind: 'imports', weight: 3 }];
  const base = rm4PageRank(nodes, edges).scores;
  const boosted = rm4PageRank(nodes, edges, {
    personalization: new Map([['a', 10]]),
  }).scores;
  assert.ok((boosted.get('a') ?? 0) > (base.get('a') ?? 0));
});

const files = [
  { relPath: 'src/main.ts', content: tsMain },
  { relPath: 'src/store.ts', content: tsStore },
  { relPath: 'src/util.ts', content: tsUtil },
];

test('buildRm4Graph: canh imports/calls/defines + stats', () => {
  const graph = buildRm4Graph(files);
  assert.equal(graph.stats.filesParsed, 3);
  assert.ok(graph.stats.symbols >= 4);
  assert.ok(graph.edges.some((e) => e.kind === 'imports'));
  assert.ok(graph.edges.some((e) => e.kind === 'defines'));
  assert.ok(graph.edges.some((e) => e.kind === 'calls'));
  assert.equal(graph.stats.filesWithErrors, 0);
  // Khong co canh tu tro toi chinh minh.
  assert.ok(graph.edges.every((e) => e.from !== e.to));
});

test('rankRm4Files: file duoc import nhieu thi rank cao', () => {
  // Hub fixture: 3 file cung import store -> store phai dung dau.
  const mkUser = (fn) =>
    `import { save } from './store';\nexport function ${fn}(id: string): boolean { return save(id); }\n`;
  const hubFiles = [
    { relPath: 'src/store.ts', content: tsStore },
    { relPath: 'src/a.ts', content: mkUser('useA') },
    { relPath: 'src/b.ts', content: mkUser('useB') },
    { relPath: 'src/c.ts', content: mkUser('useC') },
  ];
  const graph = buildRm4Graph(hubFiles);
  const { ranks } = rankRm4Files(graph);
  assert.equal(ranks.length, 4);
  const total = ranks.reduce((s, r) => s + r.score, 0);
  assert.ok(Math.abs(total - 1) < 1e-6);
  assert.equal(ranks[0].relPath, 'src/store.ts');
  assert.ok((ranks[0].importedByCount ?? 0) === 3);
  // Fixture goc: store/util duoc main import cung co diem dang ke.
  const graph2 = buildRm4Graph(files);
  const ranks2 = rankRm4Files(graph2).ranks;
  assert.ok(ranks2.every((r) => r.score > 0));
  assert.ok(ranks2.find((r) => r.relPath === 'src/store.ts')?.importedByCount === 1);
});

test('rankRm4Files: personalization theo query nang file khop', () => {
  const graph = buildRm4Graph(files);
  const plain = rankRm4Files(graph).ranks;
  const boosted = rankRm4Files(graph, ['save']).ranks;
  const plainStore = plain.find((r) => r.relPath === 'src/store.ts')?.score ?? 0;
  const boostedStore = boosted.find((r) => r.relPath === 'src/store.ts')?.score ?? 0;
  assert.ok(boostedStore >= plainStore);
});

test('queryRm4Graph: tim theo ten, exact match + reasons', () => {
  const graph = buildRm4Graph(files);
  const { ranks } = rankRm4Files(graph);
  const hits = queryRm4Graph(graph, ranks, 'save');
  assert.ok(hits.length >= 1);
  assert.ok(hits[0].symbol?.toLowerCase().includes('save'));
  assert.ok(hits[0].reasons.length > 0);
  assert.ok(hits.every((h) => h.score > 0));
  assert.deepEqual(queryRm4Graph(graph, ranks, '   '), []);
  assert.deepEqual(queryRm4Graph(graph, ranks, 'no-such-symbol-xyz'), []);
});

test('renderRm4BudgetMap: cat theo budget, khong vuot budget', () => {
  const graph = buildRm4Graph(files);
  const { ranks } = rankRm4Files(graph);
  const parsed = new Map(files.map((f) => [f.relPath, rm4ParseFile(f.relPath, f.content)]));
  const big = renderRm4BudgetMap(parsed, ranks, 10000);
  assert.equal(big.includedFiles.length, 3);
  assert.deepEqual(big.omittedFiles, []);
  assert.ok(big.text.includes('handleSave'));
  assert.ok(!big.text.includes('return ok &&'));

  const small = renderRm4BudgetMap(parsed, ranks, 40);
  assert.ok(small.tokensUsed <= 40, `tokensUsed=${small.tokensUsed}`);
  assert.ok(small.omittedFiles.length > 0);
  assert.ok(small.includedFiles.length + small.partialFiles.length + small.omittedFiles.length === 3);
  assert.ok(rm4EstimateTokens('abcd') === 1);
});

test('buildRm4Graph: ten goi mo ho khong crash, dem vao stats', () => {
  const dup = [
    { relPath: 'a.ts', content: 'export function save(id: string): boolean { return true; }\n' },
    { relPath: 'b.ts', content: 'export function save(id: string): boolean { return true; }\n' },
    {
      relPath: 'c.ts',
      content: "import { save } from './a';\nimport { save as saveB } from './b';\nexport function run(): void { save('x'); saveB('y'); }\n",
    },
  ];
  const graph = buildRm4Graph(dup);
  assert.ok(graph.stats.ambiguousNames >= 0);
  assert.ok(graph.edges.length > 0);
});
