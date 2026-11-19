/**
 * Tests for memory v23 tools (v1.38, Doi T1).
 * packages/tools/src/memoryV23Tools.ts
 *
 * Run after building core + tools (memoryV23Tools only):
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/memory-v23-tools-v138.test.mjs
 * No network. No model. Uses temp dirs under os.tmpdir().
 *
 * NOTE: chi import dist/memoryV23Tools.js (scoped) — khong import
 * dist/tools.js (ALL_TOOLS) vi build full tools can cac dep nang
 * (playwright/pdfjs/...); coordinator kiem tra ALL_TOOLS o luc gop.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MEMORY_V23_TOOLS,
  MEMORY_V23_TOOL_NAMES,
  createMemoryV23Tools,
} from '../packages/tools/dist/memoryV23Tools.js';
import { V23MemoryStore } from '../packages/core/dist/memory/v23/index.js';

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'openbot-v23-tools-'));
}

function toolByName(tools, name) {
  const found = tools.find((t) => t.definition.name === name);
  assert.ok(found, `thieu tool ${name}`);
  return found;
}

test('v23 tools: 10 tools, ten duy nhat, needsApproval dung (ghi=true, doc=false)', () => {
  assert.equal(MEMORY_V23_TOOL_NAMES.length, 10);
  assert.equal(new Set(MEMORY_V23_TOOL_NAMES).size, 10);
  assert.equal(MEMORY_V23_TOOLS.length, 10);
  const byName = new Map(MEMORY_V23_TOOLS.map((t) => [t.definition.name, t]));
  assert.equal(byName.get('memory_v23_extract').needsApproval, false);
  assert.equal(byName.get('memory_v23_search').needsApproval, false);
  assert.equal(byName.get('memory_v23_scope_search').needsApproval, false);
  assert.equal(byName.get('memory_v23_skill_search').needsApproval, false);
  assert.equal(byName.get('memory_v23_stats').needsApproval, false);
  for (const name of [
    'memory_v23_add',
    'memory_v23_consolidate',
    'memory_v23_sleep',
    'memory_v23_record',
    'memory_v23_skill',
  ]) {
    assert.equal(byName.get(name).needsApproval, true, name);
  }
});

test('v23 tools: add -> search -> scope_search chay tron vong', async () => {
  const tools = createMemoryV23Tools();
  const add = toolByName(tools, 'memory_v23_add');
  const out = await add.execute({ text: 'Toi thich ca phe den, khong duong.' });
  assert.ok(out.includes('+1 add') || out.includes('1 add') || out.includes('add'), out);
  const search = toolByName(tools, 'memory_v23_search');
  const found = await search.execute({ query: 'ca phe' });
  assert.ok(found.includes('ca phe'), found);
  const scopeSearch = toolByName(tools, 'memory_v23_scope_search');
  const scoped = await scopeSearch.execute({ query: 'ca phe', userId: 'u1' });
  assert.ok(scoped.includes('ca phe'), scoped);
  const extract = toolByName(tools, 'memory_v23_extract');
  const extracted = await extract.execute({ text: 'Toi thich ca phe den.' });
  assert.ok(extracted.includes('preference'), extracted);
  const empty = await extract.execute({ text: 'Chao ban!' });
  assert.ok(empty.includes('Khong trich duoc'), empty);
});

test('v23 tools: consolidate dryRun khong ghi, ghi that thi them record', async () => {
  const tools = createMemoryV23Tools();
  const consolidate = toolByName(tools, 'memory_v23_consolidate');
  const dry = await consolidate.execute({ text: 'Toi thich ca phe den.', dryRun: true });
  assert.ok(dry.includes('Preview'), dry);
  const stats = toolByName(tools, 'memory_v23_stats');
  const before = await stats.execute({});
  assert.ok(before.includes('Record: 0 tong'), before);
  const real = await consolidate.execute({ text: 'Toi thich ca phe den.' });
  assert.ok(real.includes('1 add') || real.includes('+1 add'), real);
  const after = await stats.execute({});
  assert.ok(after.includes('Record: 1 tong'), after);
});

test('v23 tools: record CRUD + sleep + skill vong doi', async () => {
  const tools = createMemoryV23Tools();
  const record = toolByName(tools, 'memory_v23_record');
  const put = await record.execute({ action: 'put', text: 'Du an dung Postgres.', kind: 'fact' });
  assert.ok(put.includes('Da them record'), put);
  const id = put.match(/record (\S+)/)[1];
  const get = await record.execute({ action: 'get', id });
  assert.ok(get.includes('Postgres'), get);
  const upd = await record.execute({ action: 'update', id, text: 'Du an dung Postgres 16.' });
  assert.ok(upd.includes('v2'), upd);
  const del = await record.execute({ action: 'delete', id });
  assert.ok(del.includes('soft-delete'), del);
  const restore = await record.execute({ action: 'restore', id });
  assert.ok(restore.includes('khoi phuc'), restore);
  const bad = await record.execute({ action: 'put', text: '   ' });
  assert.ok(bad.startsWith('Error:'), bad);
  const badAction = await record.execute({ action: 'nope' });
  assert.ok(badAction.startsWith('Error:'), badAction);

  const sleep = toolByName(tools, 'memory_v23_sleep');
  const slept = await sleep.execute({});
  assert.ok(slept.includes('Sleep v2:'), slept);

  const skill = toolByName(tools, 'memory_v23_skill');
  for (let i = 0; i < 3; i += 1) {
    const r = await skill.execute({ action: 'record', workflow: 'deploy-preview', steps: ['mo terminal', 'deploy'], outcome: 'success', durationMs: 1000 });
    assert.ok(r.includes('deploy-preview'), r);
  }
  const approved = await skill.execute({ action: 'approve', workflow: 'deploy-preview' });
  assert.ok(approved.includes('active'), approved);
  const rated = await skill.execute({ action: 'rate', workflow: 'deploy-preview', rating: 5 });
  assert.ok(rated.includes('5 sao'), rated);
  const skillSearch = toolByName(tools, 'memory_v23_skill_search');
  const found = await skillSearch.execute({ query: 'deploy preview' });
  assert.ok(found.includes('deploy-preview'), found);
  const list = await skill.execute({ action: 'list' });
  assert.ok(list.includes('deploy-preview'), list);
  const review = await skill.execute({ action: 'review' });
  assert.ok(review.includes('Khong co skill') || review.includes('deprecate'), review);
});

test('v23 tools: workspaceDir luu file JSON, stats kem eval', async (t) => {
  const dir = tmpDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const tools = createMemoryV23Tools({ workspaceDir: dir });
  const add = toolByName(tools, 'memory_v23_add');
  await add.execute({ text: 'Toi thich ca phe den.' });
  const stats = toolByName(tools, 'memory_v23_stats');
  const withEval = await stats.execute({ includeEval: true });
  assert.ok(withEval.includes('Eval: 30/30 pass'), withEval);
  assert.ok(withEval.includes('Health:'), withEval);
  // Mo lai tu file: store doc duoc record da luu.
  const { V23MemoryStore: Store } = await import('../packages/core/dist/memory/v23/index.js');
  const reloaded = new Store({ filePath: join(dir, 'memory-v23.json') });
  assert.equal(reloaded.size(), 1);
});

test('v23 tools: factory nhan store san + botId lam scope agent mac dinh', async () => {
  const store = new V23MemoryStore();
  const tools = createMemoryV23Tools({ store, botId: 'bot9' });
  const record = toolByName(tools, 'memory_v23_record');
  const put = await record.execute({ action: 'put', text: 'Bot ghi nho ca phe.' });
  assert.ok(put.includes('Da them record'), put);
  const listed = store.list({ scope: { agentId: 'bot9' } });
  assert.equal(listed.length, 1);
});
