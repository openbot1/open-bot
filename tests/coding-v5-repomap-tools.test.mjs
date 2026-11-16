/**
 * Tests for repo map v5 — tools integration (v1.13, Doi T3):
 * `packages/tools/src/codingV5RepoMap.ts` (store) and
 * `packages/tools/src/repoMapV5Tools.ts` (6 tools).
 *
 * Builds a small fixture repo in a temp dir, runs the real store
 * (tree-sitter parse via the v2 store) and the real tools with a
 * fake ToolContext. Run after building core + tools:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/coding-v5-tools.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CodingV5RepoMapStore,
  createRepomapV5Tools,
  REPOMAP_V5_TOOL_NAMES,
  isRepomapV5ToolName,
} from '../packages/tools/dist/index.js';

const CTX = (workspaceDir) => ({ workspaceDir, botId: 'test-bot' });

function fixtureRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'open-bot-v5-tools-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(
    join(dir, 'src', 'a.ts'),
    [
      'export function alpha(x: string): string {',
      '  return x;',
      '}',
      'export class Beta {',
      '  save(): void {}',
      '}',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(dir, 'src', 'b.ts'),
    [
      "import { alpha } from './a';",
      'export function gamma(): void {',
      "  alpha('hi');",
      '}',
      '',
    ].join('\n'),
  );
  writeFileSync(join(dir, 'src', 'lonely.ts'), 'export function lonely(): void {}\n');
  return dir;
}

function toolByName(tools, name) {
  const t = tools.find((x) => x.definition.name === name);
  assert.ok(t, `tool ${name} missing`);
  return t;
}

test('tool names: 6 tools, all with the repomap_v5_ prefix', () => {
  assert.deepEqual([...REPOMAP_V5_TOOL_NAMES], [
    'repomap_v5_build',
    'repomap_v5_search',
    'repomap_v5_definition',
    'repomap_v5_callers',
    'repomap_v5_summary',
    'repomap_v5_index',
  ]);
  assert.equal(isRepomapV5ToolName('repomap_v5_search'), true);
  assert.equal(isRepomapV5ToolName('repo_map'), false);
  const tools = createRepomapV5Tools();
  assert.equal(tools.length, 6);
  for (const t of tools) assert.equal(t.needsApproval, false);
});

test('store build: topology + summaries + index cache on disk', async () => {
  const dir = fixtureRepo();
  try {
    const store = new CodingV5RepoMapStore(dir);
    const result = await store.build();
    assert.equal(result.files, 3);
    assert.ok(result.symbols >= 4, `symbols ${result.symbols}`);
    assert.ok(result.topology, 'topology missing');
    assert.ok((result.topology?.exports ?? 0) >= 4, `exports ${result.topology?.exports}`);
    assert.ok((result.topology?.callSites ?? 0) >= 1, `callSites ${result.topology?.callSites}`);
    assert.equal(result.directories, 2); // '' and 'src'
    assert.equal(result.v5CacheWritten, true);
    assert.ok(existsSync(result.v5CachePath), 'v5 cache file missing');
    assert.ok(existsSync(join(dir, '.open-bot', 'coding-v5', 'repo-map-v5.json')));
    assert.equal(store.isBuilt, true);
    const stats = store.stats();
    assert.equal(stats.files, 3);
    assert.equal(stats.directories, 2);
    // Second build reuses everything: reparsed 0.
    const again = await store.build();
    assert.equal(again.reparsed, 0);
    assert.equal(again.reused, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('store search/callers/jump: real symbols from the fixture repo', async () => {
  const dir = fixtureRepo();
  try {
    const store = new CodingV5RepoMapStore(dir);
    await store.build();
    const { hits } = store.searchSymbols('alpha');
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.file, 'src/a.ts');
    const { callers } = store.callersOf('alpha');
    assert.equal(callers.length, 1);
    assert.equal(callers[0]?.caller, 'gamma');
    const { callees } = store.calleesOf('src/b.ts', 'gamma');
    assert.equal(callees.length, 1);
    assert.equal(callees[0]?.callee, 'alpha');
    const importers = store.importersOf('src/a.ts');
    assert.equal(importers.totalImporters, 1);
    assert.equal(importers.importers[0]?.file, 'src/b.ts');
    const { result, rendered } = store.jumpToDefinition('alpha');
    assert.equal(result.found, true);
    assert.equal(result.definition?.file, 'src/a.ts');
    assert.match(rendered, /defined at src\/a\.ts:1/);
    const summary = store.summaryOf('src');
    assert.ok(summary);
    assert.equal(summary.filesTotal, 3);
    const skeleton = store.skeleton({ budgetTokens: 2000 });
    assert.match(skeleton.text, /Repo skeleton v5/);
    assert.match(skeleton.text, /src\//);
    const freshness = store.checkIndexFreshness();
    assert.ok(!('error' in freshness));
    assert.equal(freshness.needsRebuild, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('store: touching a file (same content) is metadata-only on the next build', async () => {
  const dir = fixtureRepo();
  try {
    const store = new CodingV5RepoMapStore(dir);
    await store.build();
    // Rewrite a.ts with identical content but a newer mtime.
    const p = join(dir, 'src', 'a.ts');
    const content = readFileSync(p, 'utf8');
    await new Promise((r) => setTimeout(r, 20));
    writeFileSync(p, content);
    const second = await store.build();
    assert.ok(second.metadataOnly >= 1, `metadataOnly ${second.metadataOnly}`);
    assert.ok(second.plan, 'plan missing');
    assert.ok(second.plan.metadataOnly.includes('src/a.ts'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('store: editing a file invalidates its importers', async () => {
  const dir = fixtureRepo();
  try {
    const store = new CodingV5RepoMapStore(dir);
    await store.build();
    const p = join(dir, 'src', 'a.ts');
    writeFileSync(p, readFileSync(p, 'utf8') + '\nexport function extra(): void {}\n');
    const second = await store.build();
    assert.ok(second.plan?.changed.includes('src/a.ts'), 'a.ts should be changed');
    assert.ok(
      second.plan?.invalidatedByDependency.includes('src/b.ts'),
      `b.ts should be invalidated, got ${JSON.stringify(second.plan?.invalidatedByDependency)}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('tools: build + search + definition + callers + summary + index end to end', async () => {
  const dir = fixtureRepo();
  try {
    const tools = createRepomapV5Tools({ workspaceDir: dir });
    const build = await toolByName(tools, 'repomap_v5_build').execute({}, CTX(dir));
    assert.match(build, /Repo map v5 built/);
    assert.match(build, /3 file\(s\)/);
    const search = await toolByName(tools, 'repomap_v5_search').execute({ query: 'alpha' }, CTX(dir));
    assert.match(search, /alpha \(function\) — src\/a\.ts:1/);
    const badMode = await toolByName(tools, 'repomap_v5_search').execute({ query: 'alpha', mode: 'bogus' }, CTX(dir));
    assert.match(badMode, /^Error: mode must be one of/);
    const def = await toolByName(tools, 'repomap_v5_definition').execute({ symbol: 'Beta.save' }, CTX(dir));
    assert.match(def, /Beta\.save \(method\) defined at src\/a\.ts:5/);
    const missing = await toolByName(tools, 'repomap_v5_definition').execute({ symbol: 'nope' }, CTX(dir));
    assert.match(missing, /not found/);
    const callers = await toolByName(tools, 'repomap_v5_callers').execute({ kind: 'callers', symbol: 'alpha' }, CTX(dir));
    assert.match(callers, /gamma in src\/b\.ts:3/);
    const callees = await toolByName(tools, 'repomap_v5_callers').execute({ kind: 'callees', symbol: 'gamma', file: 'src/b.ts' }, CTX(dir));
    assert.match(callees, /alpha at line 3/);
    const importers = await toolByName(tools, 'repomap_v5_callers').execute({ kind: 'importers', symbol: 'src/a.ts' }, CTX(dir));
    assert.match(importers, /src\/b\.ts:1 imports/);
    const impact = await toolByName(tools, 'repomap_v5_callers').execute({ kind: 'impact', symbol: 'alpha' }, CTX(dir));
    assert.match(impact, /may affect 3 node\(s\)/);
    assert.match(impact, /gamma in src\/b\.ts/);
    const badKind = await toolByName(tools, 'repomap_v5_callers').execute({ kind: 'bogus', symbol: 'alpha' }, CTX(dir));
    assert.match(badKind, /^Error: kind must be one of/);
    const skeleton = await toolByName(tools, 'repomap_v5_summary').execute({ section: 'skeleton' }, CTX(dir));
    assert.match(skeleton, /Repo skeleton v5/);
    const dirSummary = await toolByName(tools, 'repomap_v5_summary').execute({ section: 'directory', directory: 'src' }, CTX(dir));
    assert.match(dirSummary, /Directory "src": 3 file\(s\)/);
    const topo = await toolByName(tools, 'repomap_v5_summary').execute({ section: 'topology' }, CTX(dir));
    assert.match(topo, /Topology v5: 3 file\(s\)/);
    const index = await toolByName(tools, 'repomap_v5_index').execute({}, CTX(dir));
    assert.match(index, /Index v5/);
    assert.match(index, /3 unchanged/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('tools: build on an empty directory reports empty, not a crash', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'open-bot-v5-empty-'));
  try {
    const tools = createRepomapV5Tools({ workspaceDir: dir });
    const out = await toolByName(tools, 'repomap_v5_build').execute({}, CTX(dir));
    assert.match(out, /0 file\(s\)/);
    const index = await toolByName(tools, 'repomap_v5_index').execute({}, CTX(dir));
    assert.match(index, /Index v5/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('tools: missing workspaceDir is a clear error', async () => {
  const tools = createRepomapV5Tools();
  const out = await toolByName(tools, 'repomap_v5_build').execute({}, { workspaceDir: '', botId: 't' });
  assert.match(out, /^Error: workspaceDir is required/);
});
