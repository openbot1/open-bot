/**
 * Tests for v1.36 (Team T1) — memory v17 mem0-style tools:
 * packages/tools/src/memoryV17Mem0Tools.ts
 *
 * Covers:
 *  - registry: 11 memory_v17_mem0_* tools in ALL_TOOLS exactly once,
 *    names match MEMORY_V17_MEM0_TOOL_NAMES, no clash with the v1.18
 *    memory_v17_* tools, all names match [A-Za-z0-9_-] (no dots).
 *  - extract: ingest turns end-to-end (facts added, entities created),
 *    missing args -> Error, cross-scope isolation in search.
 *  - entity_link / entity_list / entity_merge: link creates entities +
 *    edge, list shows them, merge moves aliases, invalid edge rejected.
 *  - conflict_list / conflict_resolve: strong conflict queues, resolve
 *    overwrite supersedes old fact, invalid strategy rejected.
 *  - search: fusion returns ranked hits with score breakdown.
 *  - state_at: valid vs known mode.
 *  - fact_timeline: timeline steps shown.
 *  - scope_audit: clean report, no leak.
 *  - eval: 40/40 pass.
 *
 * Run after building core + tools:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/memory-v17-mem0-tools-v136.test.mjs
 *
 * No network. No model.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createMemoryV17Mem0Tools,
  MEMORY_V17_MEM0_TOOLS,
  MEMORY_V17_MEM0_TOOL_NAMES,
} from '../packages/tools/dist/memoryV17Mem0Tools.js';
import { ALL_TOOLS } from '../packages/tools/dist/tools.js';
import { M17Store } from '../packages/core/dist/index.js';

const CTX = { botId: 'bot-1', runId: 'run-1', workspaceDir: '' };
const SCOPE = { userId: 'user-a', botId: 'bot-1', conversationId: 'conv-1' };

function toolByName(tools, name) {
  const found = tools.find((t) => t.definition.name === name);
  assert.ok(found, `missing tool ${name}`);
  return found;
}

async function runRaw(tools, name, args = {}, ctx = CTX) {
  return toolByName(tools, name).execute(args, ctx);
}

async function runOk(tools, name, args = {}, ctx = CTX) {
  const raw = await runRaw(tools, name, args, ctx);
  assert.ok(!raw.startsWith('Error:'), `tool ${name} failed: ${raw}`);
  return raw;
}

function freshTools() {
  const store = new M17Store({ autoResolve: false });
  return { store, tools: createMemoryV17Mem0Tools({ store }) };
}

test('registry: 11 memory_v17_mem0 tools, exactly once in ALL_TOOLS, no dots in names', () => {
  assert.deepEqual([...MEMORY_V17_MEM0_TOOL_NAMES], [
    'memory_v17_mem0_extract',
    'memory_v17_mem0_entity_link',
    'memory_v17_mem0_entity_list',
    'memory_v17_mem0_entity_merge',
    'memory_v17_mem0_conflict_list',
    'memory_v17_mem0_conflict_resolve',
    'memory_v17_mem0_search',
    'memory_v17_mem0_state_at',
    'memory_v17_mem0_fact_timeline',
    'memory_v17_mem0_scope_audit',
    'memory_v17_mem0_eval',
  ]);
  assert.equal(MEMORY_V17_MEM0_TOOLS.length, 11);
  const names = ALL_TOOLS.map((t) => t.definition.name);
  for (const name of MEMORY_V17_MEM0_TOOL_NAMES) {
    assert.equal(names.filter((n) => n === name).length, 1, `${name} must appear exactly once`);
    assert.ok(/^[A-Za-z0-9_-]+$/.test(name), `name has invalid chars: ${name}`);
  }
  // No clash with the v1.18 memory_v17_* block tools.
  for (const name of MEMORY_V17_MEM0_TOOL_NAMES) {
    assert.notEqual(names.filter((n) => n === name).length, 0);
  }
  assert.ok(names.includes('memory_v17_eval')); // v1.18 tool still present
  assert.ok(names.includes('memory_v17_mem0_eval')); // ours is distinct
});

test('extract: ingest turns, facts added + entities created', async () => {
  const { tools } = freshTools();
  const out = await runOk(tools, 'memory_v17_mem0_extract', {
    turns: [
      { role: 'user', text: 'Tôi rất thích ăn phở bò.', episodeId: 'e1', turnId: 't1' },
      { role: 'user', text: 'Tôi đang sống ở Đà Nẵng.', episodeId: 'e1', turnId: 't2' },
    ],
    ...SCOPE,
  });
  assert.ok(out.includes('2 fact moi'), out);
  assert.ok(out.includes('2 edge moi'), out);
  // Single-turn form.
  const out2 = await runOk(tools, 'memory_v17_mem0_extract', {
    text: 'Tôi nói tiếng Nhật.',
    episodeId: 'e2',
    turnId: 't1',
    ...SCOPE,
  });
  assert.ok(out2.includes('1 fact moi'), out2);
  // Missing args -> Error.
  const bad = await runRaw(tools, 'memory_v17_mem0_extract', { ...SCOPE });
  assert.ok(bad.startsWith('Error:'), bad);
});

test('entity_link + entity_list: link creates entities and edge, list shows them', async () => {
  const { tools } = freshTools();
  const linked = await runOk(tools, 'memory_v17_mem0_entity_link', {
    subject: 'user',
    edge: 'owns',
    object: 'xe máy Honda',
    kind: 'thing',
    ...SCOPE,
  });
  assert.ok(linked.includes('xe máy Honda'), linked);
  assert.ok(linked.includes('owns'), linked);
  const listed = await runOk(tools, 'memory_v17_mem0_entity_list', { ...SCOPE });
  assert.ok(listed.includes('xe máy Honda'), listed);
  assert.ok(listed.includes('memory_v17_entities'), listed);
  // Invalid edge rejected.
  const bad = await runRaw(tools, 'memory_v17_mem0_entity_link', {
    subject: 'user',
    edge: 'loves.bad',
    object: 'x',
    ...SCOPE,
  });
  assert.ok(bad.startsWith('Error:'), bad);
});

test('entity_merge: merges aliases into survivor, source kept merged', async () => {
  const { store, tools } = freshTools();
  const now = new Date().toISOString();
  const a = store.entities.getOrCreate('Hà Nội', 'place', { tenantId: '', ...SCOPE }, now).entity;
  const b = store.entities.getOrCreate('Thu do Ha Noi', 'place', { tenantId: '', ...SCOPE }, now).entity;
  store.entities.addAlias(b.id, 'HN', { tenantId: '', ...SCOPE });
  const out = await runOk(tools, 'memory_v17_mem0_entity_merge', {
    sourceId: b.id,
    targetId: a.id,
    reason: 'Cung mot thanh pho.',
    ...SCOPE,
  });
  assert.ok(out.includes('da gop vao'), out);
  const listed = await runOk(tools, 'memory_v17_mem0_entity_list', { query: 'HN', ...SCOPE });
  assert.ok(listed.includes('Hà Nội'), listed);
});

test('conflict_list + conflict_resolve: queue then overwrite supersedes old', async () => {
  const { store, tools } = freshTools();
  await runOk(tools, 'memory_v17_mem0_extract', {
    text: 'Tôi đang sống ở Hà Nội.',
    episodeId: 'e1',
    turnId: 't1',
    ...SCOPE,
  });
  await runOk(tools, 'memory_v17_mem0_extract', {
    text: 'Tôi đang sống ở Đà Nẵng.',
    episodeId: 'e2',
    turnId: 't1',
    ...SCOPE,
  });
  const listed = await runOk(tools, 'memory_v17_mem0_conflict_list', { ...SCOPE });
  assert.ok(listed.includes('lives_in'), listed);
  const pending = store.conflicts.listPending()[0];
  assert.ok(pending, 'expected a pending conflict');
  const resolved = await runOk(tools, 'memory_v17_mem0_conflict_resolve', {
    conflictId: pending.id,
    strategy: 'overwrite',
    reason: 'User da chuyen nha.',
    ...SCOPE,
  });
  assert.ok(resolved.includes('overwrite'), resolved);
  assert.equal(store.graph.getFact(pending.existingFactId)?.status, 'superseded');
  // Invalid strategy rejected.
  const bad = await runRaw(tools, 'memory_v17_mem0_conflict_resolve', {
    conflictId: pending.id,
    strategy: 'explode',
    reason: 'x',
    ...SCOPE,
  });
  assert.ok(bad.startsWith('Error:'), bad);
  // History shows the resolution.
  const history = await runOk(tools, 'memory_v17_mem0_conflict_list', { history: true, ...SCOPE });
  assert.ok(history.includes('overwrite'), history);
});

test('search: fusion hits with score breakdown; cross-scope isolation', async () => {
  const { tools } = freshTools();
  await runOk(tools, 'memory_v17_mem0_extract', {
    text: 'Tôi rất thích ăn phở bò.',
    episodeId: 'e1',
    turnId: 't1',
    ...SCOPE,
  });
  const out = await runOk(tools, 'memory_v17_mem0_search', { query: 'phở bò', ...SCOPE });
  assert.ok(out.includes('phở'), out);
  assert.ok(out.includes('total='), out);
  assert.ok(out.includes('sem='), out);
  // Another user sees nothing.
  const other = await runOk(tools, 'memory_v17_mem0_search', {
    query: 'phở bò',
    userId: 'user-b',
    botId: 'bot-1',
    conversationId: 'conv-1',
  });
  assert.ok(other.includes('Khong tim thay fact nao'), other);
});

test('state_at + fact_timeline: valid/known modes and timeline steps', async () => {
  const { store, tools } = freshTools();
  await runOk(tools, 'memory_v17_mem0_extract', {
    text: 'Tôi đang sống ở Hà Nội.',
    episodeId: 'e1',
    turnId: 't1',
    ...SCOPE,
  });
  const fact = store.graph.listActive({ tenantId: '', ...SCOPE }).facts[0];
  const at = await runOk(tools, 'memory_v17_mem0_state_at', {
    atIso: new Date().toISOString(),
    mode: 'valid',
    ...SCOPE,
  });
  assert.ok(at.includes('Hà Nội'), at);
  const known = await runOk(tools, 'memory_v17_mem0_state_at', {
    atIso: '2020-01-01T00:00:00.000Z',
    mode: 'known',
    ...SCOPE,
  });
  assert.ok(known.includes('0 fact'), known);
  const timeline = await runOk(tools, 'memory_v17_mem0_fact_timeline', {
    factId: fact.id,
    ...SCOPE,
  });
  assert.ok(timeline.includes('learned'), timeline);
  assert.ok(timeline.includes('Hà Nội'), timeline);
  const bad = await runRaw(tools, 'memory_v17_mem0_state_at', { atIso: 'not-a-date', ...SCOPE });
  assert.ok(bad.startsWith('Error:'), bad);
});

test('scope_audit: clean store reports no leak', async () => {
  const { tools } = freshTools();
  await runOk(tools, 'memory_v17_mem0_extract', {
    text: 'Tôi thích ăn phở bò.',
    episodeId: 'e1',
    turnId: 't1',
    ...SCOPE,
  });
  const out = await runOk(tools, 'memory_v17_mem0_scope_audit', {});
  assert.ok(out.includes('KHONG CO LEAK'), out);
});

test('eval: 40/40 pass via tool', async () => {
  const { tools } = freshTools();
  const out = await runOk(tools, 'memory_v17_mem0_eval', {});
  assert.ok(out.includes('40/40 PASS'), out);
  const extractionOnly = await runOk(tools, 'memory_v17_mem0_eval', { category: 'extraction' });
  assert.ok(extractionOnly.includes('12/12 PASS'), extractionOnly);
});
