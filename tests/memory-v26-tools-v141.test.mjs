/**
 * Tests for memory v26 tools (v1.41, Doi T1).
 * packages/tools/src/memoryV26Tools.ts
 *
 * Run after building core + tools (memoryV26Tools only):
 *   node node_modules/typescript/bin/tsc -p packages/core/tsconfig.json --incremental
 *   node node_modules/typescript/bin/tsc packages/tools/src/memoryV26Tools.ts --outDir packages/tools/dist --rootDir packages/tools/src --module commonjs --moduleResolution node --target ES2022 --strict --skipLibCheck --esModuleInterop --declaration --sourceMap
 *   node --test tests/memory-v26-tools-v141.test.mjs
 * No network. No model. Uses temp dirs under os.tmpdir().
 *
 * NOTE: chi import dist/memoryV26Tools.js (scoped) — khong import
 * dist/tools.js (ALL_TOOLS) vi build full tools can cac dep nang;
 * coordinator kiem tra ALL_TOOLS o luc gop.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MEMORY_V26_TOOLS,
  MEMORY_V26_TOOL_NAMES,
  createMemoryV26Tools,
} from '../packages/tools/dist/memoryV26Tools.js';
import { V26Store } from '../packages/core/dist/memory/v26/index.js';

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'openbot-v26-tools-'));
}

function tool(tools, name) {
  const t = tools.find((x) => x.definition.name === name);
  assert.ok(t, `thieu tool ${name}`);
  return t;
}

test('v26 tools: 10 tool, ten + needsApproval dung', async () => {
  assert.deepEqual([...MEMORY_V26_TOOL_NAMES], [
    'memory_v26_registry',
    'memory_v26_block',
    'memory_v26_conflict',
    'memory_v26_audit',
    'memory_v26_budget',
    'memory_v26_curate',
    'memory_v26_archival',
    'memory_v26_recall',
    'memory_v26_template',
    'memory_v26_stats',
  ]);
  assert.equal(MEMORY_V26_TOOLS.length, 10);
  const byName = Object.fromEntries(MEMORY_V26_TOOLS.map((t) => [t.definition.name, t.needsApproval]));
  assert.equal(byName.memory_v26_registry, true);
  assert.equal(byName.memory_v26_block, true);
  assert.equal(byName.memory_v26_conflict, true);
  assert.equal(byName.memory_v26_audit, false);
  assert.equal(byName.memory_v26_budget, true);
  assert.equal(byName.memory_v26_curate, true);
  assert.equal(byName.memory_v26_archival, true);
  assert.equal(byName.memory_v26_recall, true);
  assert.equal(byName.memory_v26_template, true);
  assert.equal(byName.memory_v26_stats, true);
  // Ten khong trung nhau.
  assert.equal(new Set(MEMORY_V26_TOOL_NAMES).size, 10);
});

test('v26 tools: registry create-from-template + block write + audit qua tool', async () => {
  const store = new V26Store();
  const tools = createMemoryV26Tools({ store, botId: 'bot-a' });
  const created = await tool(tools, 'memory_v26_registry').execute({
    action: 'create-from-template', templateId: 'human', label: 'human', ownerBotId: 'bot-a',
  });
  assert.match(created, /Da tao block "human"/);
  assert.match(created, /template "human"/);
  const listed = await tool(tools, 'memory_v26_registry').execute({ action: 'list', botId: 'bot-a' });
  assert.match(listed, /human \[human\]/);
  // Ghi qua tool.
  const written = await tool(tools, 'memory_v26_block').execute({
    action: 'write', label: 'human', value: '## Ten\nHuy\n\n## Muc tieu\nXay open-bot', botId: 'bot-a',
  });
  assert.match(written, /v2/);
  // Audit qua tool thay muc write.
  const audit = await tool(tools, 'memory_v26_audit').execute({ label: 'human' });
  assert.match(audit, /write/);
  assert.match(audit, /bot-a/);
});

test('v26 tools: xung dot qua tool — ghi lech version bi tu choi, resolve merge-lines', async () => {
  const store = new V26Store();
  const tools = createMemoryV26Tools({ store, botId: 'bot-a' });
  await tool(tools, 'memory_v26_registry').execute({
    action: 'create', label: 'shared', value: 'goc', ownerBotId: 'bot-a',
    kind: 'project', attachBotIds: ['bot-b'],
  });
  await tool(tools, 'memory_v26_block').execute({
    action: 'write', label: 'shared', value: 'bot-a viet', botId: 'bot-a', expectedVersion: 1,
  });
  const conflicted = await tool(tools, 'memory_v26_block').execute({
    action: 'write', label: 'shared', value: 'bot-b viet', botId: 'bot-b',
    expectedVersion: 1, baseValue: 'goc',
  });
  assert.match(conflicted, /Error: CONFLICT:cf_/);
  const conflictId = conflicted.match(/CONFLICT:(cf_[a-z0-9_]+)/)[1];
  const list = await tool(tools, 'memory_v26_conflict').execute({ action: 'list' });
  assert.match(list, new RegExp(conflictId));
  const detail = await tool(tools, 'memory_v26_conflict').execute({ action: 'get', id: conflictId });
  assert.match(detail, /bot-a viet/);
  assert.match(detail, /bot-b viet/);
  const resolved = await tool(tools, 'memory_v26_conflict').execute({
    action: 'resolve', id: conflictId, resolution: 'merge-lines', botId: 'bot-a',
  });
  assert.match(resolved, /Da giai quyet conflict/);
  const read = await tool(tools, 'memory_v26_block').execute({ action: 'read', label: 'shared', botId: 'bot-b' });
  assert.match(read, /bot-a viet/);
  assert.match(read, /bot-b viet/);
});

test('v26 tools: budget + curate preview + curate block vuot budget', async () => {
  const store = new V26Store();
  const tools = createMemoryV26Tools({ store, botId: 'bot-a' });
  await tool(tools, 'memory_v26_registry').execute({
    action: 'create', label: 'big', value: 'ngan', ownerBotId: 'bot-a', kind: 'task',
  });
  const set = await tool(tools, 'memory_v26_budget').execute({
    action: 'set', label: 'big', maxTokens: 20, onExceed: 'curate', curateTargetTokens: 10,
  });
  assert.match(set, /Da dat budget block "big"/);
  const preview = await tool(tools, 'memory_v26_curate').execute({
    action: 'preview', text: '# Tieu de\nNoi dung quan trong ve deadline 30-11.\nChuyen linh tinh.', targetTokens: 15,
  });
  assert.match(preview, /Tom tat trich xuat/);
  assert.match(preview, /deadline 30-11/);
  // Ghi dai vao block: pipeline tu curate ngay vi vuot budget (onExceed=curate).
  const longValue = ['# Tieu de quan trong', 'Noi dung dai '.repeat(20), 'Ket luan'].join('\n');
  const written = await tool(tools, 'memory_v26_block').execute({ action: 'write', label: 'big', value: longValue, botId: 'bot-a' });
  assert.match(written, /Tu curate vi vuot budget/);
  // Sau khi tu curate, block da gon lai trong budget.
  const status = await tool(tools, 'memory_v26_budget').execute({ action: 'status', label: 'big' });
  assert.match(status, /status ok/);
  const curated = await tool(tools, 'memory_v26_curate').execute({ action: 'curate', label: 'big', botId: 'bot-a' });
  assert.match(curated, /khong can curate/);
});

test('v26 tools: archival search + recall day + template list/instantiate', async () => {
  const store = new V26Store();
  const tools = createMemoryV26Tools({ store, botId: 'bot-a' });
  const added = await tool(tools, 'memory_v26_archival').execute({
    action: 'add', kind: 'note', content: 'Hop chot deadline Alpha', sourceLabel: 'project-alpha',
    // Pin the note to 2026-11-18: add defaults to Date.now(), so without
    // `at` this test only passed on the day it was written.
    at: '2026-11-18T08:00:00.000Z',
  });
  assert.match(added, /Da luu tru muc arc_/);
  const found = await tool(tools, 'memory_v26_archival').execute({ action: 'search', query: 'deadline' });
  assert.match(found, /deadline Alpha/);
  const recalled = await tool(tools, 'memory_v26_recall').execute({
    action: 'add-turns',
    turns: [{ role: 'user', text: 'chao buoi sang', at: '2026-11-18T08:00:00.000Z' }],
  });
  assert.match(recalled, /Da ghi 1 turn/);
  const day = await tool(tools, 'memory_v26_recall').execute({ action: 'day', day: '2026-11-18' });
  assert.match(day, /2026-11-18: 2 muc/);
  assert.match(day, /chao buoi sang/);
  const templates = await tool(tools, 'memory_v26_template').execute({ action: 'list' });
  assert.match(templates, /human/);
  assert.match(templates, /persona/);
  assert.match(templates, /project/);
  const inst = await tool(tools, 'memory_v26_template').execute({ action: 'instantiate', id: 'task' });
  assert.match(inst, /## Muc tieu/);
});

test('v26 tools: stats + quota + export/import qua tool, persist xuong workspace dir', async () => {
  const dir = tmpDir();
  try {
    const tools = createMemoryV26Tools({ workspaceDir: dir, botId: 'bot-a' });
    await tool(tools, 'memory_v26_registry').execute({
      action: 'create', label: 'human', value: '## Ten\nHuy', ownerBotId: 'bot-a', kind: 'human',
    });
    const stats = await tool(tools, 'memory_v26_stats').execute({ action: 'stats' });
    assert.match(stats, /Memory v26:/);
    assert.match(stats, /Block: 1 tong/);
    const quota = await tool(tools, 'memory_v26_stats').execute({ action: 'quota', botId: 'bot-a' });
    assert.match(quota, /Quota bot "bot-a"/);
    assert.match(quota, /so huu 1\/50 block/);
    const exported = await tool(tools, 'memory_v26_stats').execute({ action: 'export', label: 'human' });
    assert.match(exported, /open-bot-memory-v26-block/);
    const imported = await tool(tools, 'memory_v26_stats').execute({ action: 'import', json: exported, botId: 'bot-b' });
    assert.match(imported, /Da import block "human-import-1"/);
    // Persist: store da luu xuong dir (file ton tai, load lai duoc).
    const { readFileSync, existsSync } = await import('node:fs');
    assert.equal(existsSync(join(dir, 'memory-v26-store.json')), true);
    const reloaded = JSON.parse(readFileSync(join(dir, 'memory-v26-store.json'), 'utf8'));
    assert.equal(reloaded.version, 26);
    assert.equal(reloaded.blocks.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('v26 tools: loi ro rang khi thieu arg / block khong co', async () => {
  const tools = createMemoryV26Tools({ store: new V26Store(), botId: 'bot-a' });
  const missing = await tool(tools, 'memory_v26_block').execute({ action: 'read', label: 'khong-co', botId: 'bot-a' });
  assert.match(missing, /Error:/);
  const badAction = await tool(tools, 'memory_v26_registry').execute({ action: 'khong-co' });
  assert.match(badAction, /Error: action/);
  const badDay = await tool(tools, 'memory_v26_recall').execute({ action: 'day', day: '18-11-2026' });
  assert.match(badDay, /Error:/);
});
