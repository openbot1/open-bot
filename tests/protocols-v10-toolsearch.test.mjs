/**
 * Tests for v1.41 (Team T2) — tool search + programmatic calling:
 * packages/core/src/protocolsV10/toolSearchV10.ts
 *
 * Covers:
 *  - scoring (exact name > prefix > keyword > description),
 *    deterministic order (score desc, name asc)
 *  - registry: core vs deferred counts, categories, search
 *    filters (category, loadedOnly, limit, minScore)
 *  - load on demand (cache hit on second load, loader
 *    mismatch refused, unknown tool refused, load-many
 *    reports unknown names)
 *  - load stats + promotion candidates (frequently loaded
 *    deferred tools)
 *  - snapshot / restore round-trip
 *  - programmatic caller: validation (unknown tool, bad
 *    $variable reference, duplicate saveAs, too many steps),
 *    run order + $variable substitution, stop on first
 *    failure, timeout
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/protocols-v10-toolsearch.test.mjs
 *
 * No network, no model.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  McpV10ProgrammaticCaller,
  McpV10ToolSearchRegistry,
  scoreMcpV10ToolSearch,
} from '../packages/core/dist/index.js';

function registry() {
  return new McpV10ToolSearchRegistry([
    { name: 'files_read', description: 'Read a file from the workspace.', category: 'files', deferLoading: false, keywords: ['read', 'open'] },
    { name: 'files_write', description: 'Write a file to the workspace.', category: 'files', deferLoading: false, keywords: ['write', 'save'] },
    { name: 'memory_search', description: 'Search long-term memory for facts.', category: 'memory', deferLoading: true, keywords: ['recall', 'remember'] },
    { name: 'memory_store', description: 'Store a fact in long-term memory.', category: 'memory', deferLoading: true, keywords: ['save fact'] },
    { name: 'web_fetch', description: 'Fetch a URL and return its text.', category: 'web', deferLoading: true, keywords: ['http', 'download'] },
  ]);
}

test('scoring: exact name beats prefix beats keyword beats description', () => {
  const tool = { name: 'memory_search', description: 'Search long-term memory.', category: 'memory', deferLoading: true, keywords: ['recall'] };
  assert.equal(scoreMcpV10ToolSearch(tool, ['memory_search']).score, 40);
  assert.equal(scoreMcpV10ToolSearch(tool, ['memory_search']).matchedOn, 'name');
  assert.ok(scoreMcpV10ToolSearch(tool, ['memory']).score >= 30);
  assert.equal(scoreMcpV10ToolSearch(tool, ['recall']).matchedOn, 'keyword');
  assert.equal(scoreMcpV10ToolSearch(tool, ['long']).matchedOn, 'description');
  assert.equal(scoreMcpV10ToolSearch(tool, ['zzz']).score, 0);
  assert.equal(scoreMcpV10ToolSearch(tool, []).score, 0);
});

test('registry counts: core loaded, deferred unloaded, categories sorted', () => {
  const reg = registry();
  assert.equal(reg.total, 5);
  assert.equal(reg.deferredCount, 3);
  assert.equal(reg.loadedCount, 2);
  assert.deepEqual(reg.categories(), ['files', 'memory', 'web']);
  assert.deepEqual(reg.listDeferredUnloaded().map((t) => t.name), ['memory_search', 'memory_store', 'web_fetch']);
  assert.deepEqual(reg.listLoaded().map((t) => t.name), ['files_read', 'files_write']);
  assert.equal(reg.isLoaded('files_read'), true);
  assert.equal(reg.isLoaded('web_fetch'), false);
  assert.equal(reg.get('nope'), undefined);
});

test('search: ranked, deterministic, filterable', () => {
  const reg = registry();
  const hits = reg.search('memory');
  assert.ok(hits.length >= 2);
  assert.equal(hits[0].tool.name, 'memory_search');
  assert.ok(hits.every((h) => h.score > 0));
  // Deterministic: same query, same order.
  assert.deepEqual(reg.search('memory').map((h) => h.tool.name), hits.map((h) => h.tool.name));
  assert.deepEqual(reg.search('memory', { category: 'web' }), []);
  assert.equal(reg.search('memory', { limit: 1 }).length, 1);
  assert.deepEqual(reg.search('memory', { loadedOnly: true }), []);
  assert.deepEqual(reg.search(''), []);
  assert.equal(reg.search('recall')[0].tool.name, 'memory_search');
  assert.equal(reg.search('recall')[0].matchedOn, 'keyword');
});

test('load on demand: cache hit, loader, mismatch and unknown refused', async () => {
  const reg = registry();
  let loaderCalls = 0;
  reg.register(
    { name: 'lazy_tool', description: 'Loads lazily.', category: 'web', deferLoading: true },
    () => {
      loaderCalls += 1;
      return { name: 'lazy_tool', description: 'Loads lazily (loaded).', category: 'web', deferLoading: true };
    },
  );
  const first = await reg.loadTool('lazy_tool');
  assert.equal(first.cacheHit, false);
  assert.equal(loaderCalls, 1);
  assert.equal(first.tool.description, 'Loads lazily (loaded).');
  const second = await reg.loadTool('lazy_tool');
  assert.equal(second.cacheHit, true);
  assert.equal(loaderCalls, 1);
  assert.equal(reg.loadStats('lazy_tool').loads, 1);
  assert.equal(reg.loadStats('lazy_tool').loaded, true);
  await assert.rejects(() => reg.loadTool('nope'), /Unknown tool/);
  reg.register(
    { name: 'liar', description: 'Lies about its name.', category: 'web', deferLoading: true },
    () => ({ name: 'other', description: 'x', category: 'web', deferLoading: true }),
  );
  await assert.rejects(() => reg.loadTool('liar'), /different tool/);
  const many = await reg.loadTools(['files_read', 'web_fetch', 'nope']);
  assert.deepEqual(many.cacheHits, ['files_read']);
  assert.deepEqual(many.unknown, ['nope']);
  assert.deepEqual(many.loaded.map((t) => t.name), ['web_fetch']);
});

test('promotion candidates: frequently loaded deferred tools surface', async () => {
  const reg = registry();
  await reg.loadTool('memory_search');
  await reg.loadTool('memory_search'); // cache hit: loads stays 1
  assert.equal(reg.loadStats('memory_search').loads, 1);
  assert.deepEqual(reg.promotionCandidates(1).map((s) => s.name), ['memory_search']);
  assert.deepEqual(reg.promotionCandidates(2), []);
  assert.deepEqual(reg.deferredStats()[0].name, 'memory_search');
});

test('snapshot / restore round-trip keeps tools and loaded set', () => {
  const reg = registry();
  const snap = reg.snapshot();
  const restored = McpV10ToolSearchRegistry.restore(snap);
  assert.equal(restored.total, 5);
  assert.equal(restored.loadedCount, 2);
  assert.deepEqual(restored.search('memory').map((h) => h.tool.name), reg.search('memory').map((h) => h.tool.name));
  assert.throws(() => reg.register({ name: '', description: 'x', category: 'y', deferLoading: false }), /non-empty string/);
  assert.throws(() => reg.register({ name: 'x', description: '', category: 'y', deferLoading: false }), /non-empty description/);
  assert.equal(reg.unregister('web_fetch'), true);
  assert.equal(reg.unregister('web_fetch'), false);
  assert.equal(reg.total, 4);
});

test('programmatic caller: validation catches unknown tools and bad references', () => {
  const reg = registry();
  const caller = new McpV10ProgrammaticCaller(reg, () => 'ok');
  assert.deepEqual(caller.validate({ name: 's', steps: [{ tool: 'files_read' }] }), []);
  assert.ok(caller.validate({ name: 's', steps: [{ tool: 'nope' }] }).some((p) => p.includes('unknown tool')));
  assert.ok(caller.validate({ name: 's', steps: [{ tool: 'files_read', args: { x: '$missing' } }] }).some((p) => p.includes('$missing')));
  assert.ok(caller.validate({ name: 's', steps: [{ tool: 'files_read', saveAs: 'a' }, { tool: 'files_read', saveAs: 'a' }] }).some((p) => p.includes('already used')));
  assert.ok(caller.validate({ name: 's', steps: [] }).some((p) => p.includes('at least one step')));
  assert.ok(caller.validate({ name: 's', steps: [{ tool: 'files_read' }], maxSteps: 0 }).some((p) => p.includes('over the max')));
  const tooMany = { name: 's', steps: Array.from({ length: 25 }, () => ({ tool: 'files_read' })) };
  assert.ok(caller.validate(tooMany).some((p) => p.includes('over the max')));
});

test('programmatic caller: run order, $variable substitution, stops on failure', async () => {
  const reg = registry();
  const calls = [];
  const caller = new McpV10ProgrammaticCaller(reg, (tool, args) => {
    calls.push({ tool, args });
    if (tool === 'files_write') return { written: args.path };
    if (tool === 'files_read') return { content: `file:${args.path}` };
    return null;
  });
  const result = await caller.run({
    name: 'write-then-read',
    steps: [
      { tool: 'files_write', args: { path: 'a.txt' }, saveAs: 'w' },
      { tool: 'files_read', args: { path: '$w.written' } },
    ],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.finalResult, { content: 'file:a.txt' });
  assert.equal(result.steps.length, 2);
  assert.ok(result.steps.every((s) => s.ok));
  assert.deepEqual(calls[1].args, { path: 'a.txt' });
  // Deferred tool loads on demand before its step runs.
  const withDeferred = await caller.run({
    name: 'deferred',
    steps: [{ tool: 'memory_search', args: { q: 'x' } }],
  });
  assert.equal(withDeferred.ok, true);
  assert.equal(reg.isLoaded('memory_search'), true);
  // Failure stops the script at the failing step.
  const failing = new McpV10ProgrammaticCaller(reg, (tool) => {
    if (tool === 'files_write') throw new Error('disk full');
    return 'ok';
  });
  const failed = await failing.run({
    name: 'fails',
    steps: [{ tool: 'files_read' }, { tool: 'files_write' }, { tool: 'files_read' }],
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.steps.length, 2);
  assert.match(failed.error, /disk full/);
  assert.equal(failed.finalResult, undefined);
});

test('programmatic caller: per-step timeout', async () => {
  const reg = registry();
  const caller = new McpV10ProgrammaticCaller(reg, () => new Promise((resolve) => setTimeout(() => resolve('late'), 500)));
  const result = await caller.run({
    name: 'slow',
    steps: [{ tool: 'files_read' }],
    stepTimeoutMs: 50,
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /timed out/);
});
