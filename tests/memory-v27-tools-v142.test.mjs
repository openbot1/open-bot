/**
 * Tests for memory v27 tools (v1.42, Doi T3).
 * packages/tools/src/memoryV27Tools.ts
 *
 * Run after building core + tools (memoryV27Tools only):
 *   node node_modules/typescript/bin/tsc -p packages/core/tsconfig.json --incremental
 *   node node_modules/typescript/bin/tsc packages/tools/src/memoryV27Tools.ts --outDir packages/tools/dist --rootDir packages/tools/src --module commonjs --moduleResolution node --target ES2022 --strict --skipLibCheck --esModuleInterop --declaration --sourceMap
 *   node --test tests/memory-v27-tools-v142.test.mjs
 * No network. No model. Uses temp dirs under os.tmpdir().
 *
 * NOTE: chi import dist/memoryV27Tools.js (scoped) — khong import
 * dist/tools.js (ALL_TOOLS) vi build full tools can cac dep nang;
 * coordinator kiem tra ALL_TOOLS o luc gop.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MEMORY_V27_TOOLS,
  MEMORY_V27_TOOL_NAMES,
  createMemoryV27Tools,
} from '../packages/tools/dist/memoryV27Tools.js';
import { V27Store } from '../packages/core/dist/memory/v27/index.js';

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'openbot-v27-tools-'));
}

function tool(tools, name) {
  const t = tools.find((x) => x.definition.name === name);
  assert.ok(t, `thieu tool ${name}`);
  return t;
}

test('v27 tools: 10 tool, ten + needsApproval dung', async () => {
  assert.deepEqual([...MEMORY_V27_TOOL_NAMES], [
    'memory_v27_ingest',
    'memory_v27_extract',
    'memory_v27_fact',
    'memory_v27_search',
    'memory_v27_time_travel',
    'memory_v27_entity',
    'memory_v27_episode',
    'memory_v27_graph',
    'memory_v27_block',
    'memory_v27_stats',
  ]);
  assert.equal(MEMORY_V27_TOOLS.length, 10);
  const byName = Object.fromEntries(MEMORY_V27_TOOLS.map((t) => [t.definition.name, t.needsApproval]));
  assert.equal(byName.memory_v27_ingest, true);
  assert.equal(byName.memory_v27_extract, false);
  assert.equal(byName.memory_v27_fact, true);
  assert.equal(byName.memory_v27_search, false);
  assert.equal(byName.memory_v27_time_travel, false);
  assert.equal(byName.memory_v27_entity, true);
  assert.equal(byName.memory_v27_episode, true);
  assert.equal(byName.memory_v27_graph, false);
  assert.equal(byName.memory_v27_block, true);
  assert.equal(byName.memory_v27_stats, true);
  assert.equal(new Set(MEMORY_V27_TOOL_NAMES).size, 10);
});

test('v27 tools: ingest + search + time-travel qua tool', async () => {
  const store = new V27Store();
  const tools = createMemoryV27Tools({ store, botId: 'bot-a' });
  const ingested = await tool(tools, 'memory_v27_ingest').execute({
    text: 'Huy likes coffee. Huy lives in Saigon.',
  });
  assert.match(ingested, /Da ingest episode/);
  assert.match(ingested, /2 fact moi/);
  assert.match(ingested, /Huy likes coffee/);
  // Dry-run: khong ghi them.
  const dry = await tool(tools, 'memory_v27_extract').execute({ text: 'Huy likes tea.' });
  assert.match(dry, /1 candidate/);
  assert.match(dry, /se dong edge cu/);
  assert.equal(store.factsTotal, 2);
  // Search qua tool: tim duoc fact.
  const found = await tool(tools, 'memory_v27_search').execute({ query: 'Huy coffee' });
  assert.match(found, /coffee/);
  assert.match(found, /emb-proxy/);
  // Search khong co ket qua.
  const none = await tool(tools, 'memory_v27_search').execute({ query: 'zzzzqqqq' });
  assert.match(none, /Khong tim thay fact nao/);
});

test('v27 tools: fact add trung + supersede + history qua tool', async () => {
  const store = new V27Store();
  const tools = createMemoryV27Tools({ store, botId: 'bot-a' });
  const added = await tool(tools, 'memory_v27_fact').execute({
    action: 'add', subject: 'Huy', predicate: 'likes', object: 'coffee',
  });
  assert.match(added, /Da ADD fact/);
  const dup = await tool(tools, 'memory_v27_fact').execute({
    action: 'add', subject: 'Huy', predicate: 'likes', object: 'coffee',
  });
  assert.match(dup, /da ton tai/);
  assert.equal(store.factsTotal, 1);
  const sup = await tool(tools, 'memory_v27_fact').execute({
    action: 'add', subject: 'Huy', predicate: 'likes', object: 'tea',
  });
  assert.match(sup, /da dong 1 edge cu/);
  assert.equal(store.factsTotal, 2);
  const history = await tool(tools, 'memory_v27_fact').execute({
    action: 'history', subject: 'Huy', predicate: 'likes',
  });
  assert.match(history, /coffee/);
  assert.match(history, /tea/);
  const listed = await tool(tools, 'memory_v27_fact').execute({
    action: 'list', currentOnly: true,
  });
  assert.match(listed, /tea/);
  assert.doesNotMatch(listed, /coffee/);
});

test('v27 tools: entity register/link + episode provenance + graph qua tool', async () => {
  const store = new V27Store();
  const tools = createMemoryV27Tools({ store, botId: 'bot-a' });
  const reg = await tool(tools, 'memory_v27_entity').execute({
    action: 'register', name: 'Huy', kind: 'person', aliases: ['Huy Nguyen'],
  });
  assert.match(reg, /Da dang ky entity "Huy"/);
  const linked = await tool(tools, 'memory_v27_entity').execute({
    action: 'link', mention: 'Huy Nguyen',
  });
  assert.match(linked, /Huy Nguyen.*Huy/);
  const listed = await tool(tools, 'memory_v27_entity').execute({ action: 'list' });
  assert.match(listed, /Huy/);
  // Episode: ingest + provenance.
  const ingested = await tool(tools, 'memory_v27_ingest').execute({
    text: 'Huy likes coffee.',
  });
  const m = ingested.match(/ADD (\S+):/);
  assert.ok(m, 'khong lay duoc fact id tu ket qua ingest');
  const prov = await tool(tools, 'memory_v27_episode').execute({
    action: 'provenance', id: m[1],
  });
  assert.match(prov, /Provenance fact/);
  assert.match(prov, /episode/);
  // Episode list.
  const eps = await tool(tools, 'memory_v27_episode').execute({ action: 'list' });
  assert.match(eps, /1 episode/);
  // Graph counts + validate.
  const counts = await tool(tools, 'memory_v27_graph').execute({ action: 'counts' });
  assert.match(counts, /active 1/);
  const valid = await tool(tools, 'memory_v27_graph').execute({ action: 'validate' });
  assert.match(valid, /nhat quan/);
});

test('v27 tools: block bi-temporal — register/update/value-at/timeline qua tool', async () => {
  const store = new V27Store();
  const tools = createMemoryV27Tools({ store, botId: 'bot-a' });
  // Tao block v26 truoc (qua v26 store ben duoi).
  const created = store.v26.registry.create(
    { label: 'human', value: '## Ten\nHuy', ownerBotId: 'bot-a', kind: 'human', attachBotIds: ['bot-b'] },
    { nowMs: Date.parse('2026-11-19T00:00:00.000Z') },
  );
  assert.equal(created.ok, true);
  const blockId = created.value.block.id;
  const registered = await tool(tools, 'memory_v27_block').execute({
    action: 'register', blockId,
  });
  assert.match(registered, /Da dang ky block "human"/);
  const updated = await tool(tools, 'memory_v27_block').execute({
    action: 'update', blockId, value: '## Ten\nHuy\n\n## Thich\nCa phe',
  });
  assert.match(updated, /Da cap nhat block "human" len v2/);
  assert.match(updated, /dong bo cho 2 agent/);
  const past = await tool(tools, 'memory_v27_block').execute({
    action: 'value-at', blockId, at: '2026-11-19T00:30:00.000Z',
  });
  assert.match(past, /Ten/);
  const timeline = await tool(tools, 'memory_v27_block').execute({
    action: 'timeline', blockId,
  });
  assert.match(timeline, /2 entry/);
  const sees = await tool(tools, 'memory_v27_block').execute({
    action: 'sees-latest', blockId, agentId: 'bot-b',
  });
  assert.match(sees, /thay gia tri moi nhat/);
});

test('v27 tools: stats + export/import + persist xuong workspaceDir', async () => {
  const dir = tmpDir();
  try {
    const tools = createMemoryV27Tools({ workspaceDir: dir, botId: 'bot-a' });
    await tool(tools, 'memory_v27_ingest').execute({ text: 'Huy likes coffee.' });
    const stats = await tool(tools, 'memory_v27_stats').execute({ action: 'stats' });
    assert.match(stats, /Fact: 1 tong/);
    assert.match(stats, /Add-only/);
    const health = await tool(tools, 'memory_v27_stats').execute({ action: 'health' });
    assert.match(health, /khoe/);
    const exported = await tool(tools, 'memory_v27_stats').execute({ action: 'export' });
    const snap = JSON.parse(exported);
    assert.equal(snap.version, '27.0.0');
    assert.equal(snap.facts.length, 1);
    // Import vao store moi (qua tool khac): them duoc.
    const tools2 = createMemoryV27Tools({ botId: 'bot-a' });
    const imported = await tool(tools2, 'memory_v27_stats').execute({
      action: 'import', json: exported,
    });
    assert.match(imported, /1 fact moi/);
    // Time-travel qua tool.
    const tt = await tool(tools, 'memory_v27_time_travel').execute({
      at: new Date(Date.now() + 60_000).toISOString(),
    });
    assert.match(tt, /1 fact dung/);
    assert.match(tt, /coffee/);
    // Action sai thi loi ro rang, khong crash.
    const bad = await tool(tools, 'memory_v27_fact').execute({ action: 'xoa' });
    assert.match(bad, /Error: action "xoa" khong hop le/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
