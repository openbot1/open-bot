/**
 * Tests for memory v25 tools (v1.40, Doi T1).
 * packages/tools/src/memoryV25Tools.ts
 *
 * Run after building core + tools (memoryV25Tools only):
 *   node node_modules/typescript/bin/tsc -p packages/core/tsconfig.json --incremental
 *   node node_modules/typescript/bin/tsc packages/tools/src/memoryV25Tools.ts --outDir packages/tools/dist --rootDir packages/tools/src --module commonjs --moduleResolution node --target ES2022 --strict --skipLibCheck --esModuleInterop --declaration --sourceMap
 *   node --test tests/memory-v25-tools-v140.test.mjs
 * No network. No model. Uses temp dirs under os.tmpdir().
 *
 * NOTE: chi import dist/memoryV25Tools.js (scoped) — khong import
 * dist/tools.js (ALL_TOOLS) vi build full tools can cac dep nang;
 * coordinator kiem tra ALL_TOOLS o luc gop.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MEMORY_V25_TOOLS,
  MEMORY_V25_TOOL_NAMES,
  createMemoryV25Tools,
} from '../packages/tools/dist/memoryV25Tools.js';
import { V25Store } from '../packages/core/dist/memory/v25/index.js';

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'openbot-v25-tools-'));
}

function tool(tools, name) {
  const t = tools.find((x) => x.definition.name === name);
  assert.ok(t, `thieu tool ${name}`);
  return t;
}

test('v25 tools: 10 tool, ten + needsApproval dung', async () => {
  assert.deepEqual([...MEMORY_V25_TOOL_NAMES], [
    'memory_v25_sleep',
    'memory_v25_block',
    'memory_v25_fact',
    'memory_v25_judge',
    'memory_v25_add',
    'memory_v25_search',
    'memory_v25_consolidate',
    'memory_v25_config',
    'memory_v25_audit',
    'memory_v25_stats',
  ]);
  assert.equal(MEMORY_V25_TOOLS.length, 10);
  const byName = Object.fromEntries(MEMORY_V25_TOOLS.map((t) => [t.definition.name, t]));
  assert.equal(byName.memory_v25_sleep.needsApproval, true);
  assert.equal(byName.memory_v25_block.needsApproval, true);
  assert.equal(byName.memory_v25_fact.needsApproval, true);
  assert.equal(byName.memory_v25_judge.needsApproval, true);
  assert.equal(byName.memory_v25_add.needsApproval, true);
  assert.equal(byName.memory_v25_consolidate.needsApproval, true);
  assert.equal(byName.memory_v25_config.needsApproval, true);
  assert.equal(byName.memory_v25_search.needsApproval, false);
  assert.equal(byName.memory_v25_audit.needsApproval, false);
  assert.equal(byName.memory_v25_stats.needsApproval, false);
  for (const t of MEMORY_V25_TOOLS) {
    assert.equal(t.definition.parameters.type, 'object');
    assert.ok(t.definition.description.length > 20, `${t.definition.name} mo ta qua ngan`);
  }
});

test('v25 tools: add buffer turn (khong ghi fact) + sleep run tong hop', async () => {
  const store = new V25Store();
  const tools = createMemoryV25Tools({ store, botId: 'bot-a' });
  const add = tool(tools, 'memory_v25_add');
  const out = await add.execute({ text: 'Huy là kỹ sư phần mềm.' });
  assert.match(out, /Da buffer 1 turn/);
  assert.match(out, /chi duoc buffer/);
  assert.equal(store.facts.size, 0);
  // Sleep run tong hop.
  const sleep = tool(tools, 'memory_v25_sleep');
  const run = await sleep.execute({ action: 'run', reason: 'test' });
  assert.match(run, /Sleep pass .* xong/);
  assert.match(run, /\+1 add/);
  assert.equal(store.facts.size, 1);
  const status = await sleep.execute({ action: 'status' });
  assert.match(status, /Tong pass da chay: 1/);
});

test('v25 tools: block create/attach/readonly/write — bot khac chi doc', async () => {
  const store = new V25Store();
  const tools = createMemoryV25Tools({ store, botId: 'bot-a' });
  const block = tool(tools, 'memory_v25_block');
  const created = await block.execute({ action: 'create', label: 'human', description: 'Ve user', value: 'Ten la Huy.' });
  assert.match(created, /Da tao shared block human/);
  const id = store.blocks.list({})[0].id;
  // Attach bot-b.
  const attached = await block.execute({ action: 'attach', id, botId: 'bot-b' });
  assert.match(attached, /Da attach bot "bot-b"/);
  // Owner bat read-only.
  const ro = await block.execute({ action: 'readonly', id, botId: 'bot-a', readOnly: true });
  assert.match(ro, /READ-ONLY/);
  // Bot-b ghi bi chan.
  const denied = await block.execute({ action: 'write', id, botId: 'bot-b', value: 'Doi ten.' });
  assert.match(denied, /Error: .*read-only/);
  // Owner ghi duoc.
  const allowed = await block.execute({ action: 'write', id, botId: 'bot-a', value: 'Ten la Huy, 30 tuoi.' });
  assert.match(allowed, /len v2/);
  // Get + history + render.
  const got = await block.execute({ action: 'get', label: 'human' });
  assert.match(got, /30 tuoi/);
  const history = await block.execute({ action: 'history', id });
  assert.match(history, /2 version/);
  const rendered = await block.execute({ action: 'render', botId: 'bot-b' });
  assert.match(rendered, /<memory_blocks>/);
  assert.match(rendered, /read_only="true"/);
  // Bot chua attach khong doc duoc (get theo label + botId).
  const toolsB = createMemoryV25Tools({ store, botId: 'bot-z' });
  const deniedGet = await tool(toolsB, 'memory_v25_block').execute({ action: 'get', label: 'human' });
  assert.match(deniedGet, /Error: .*khong duoc doc/);
});

test('v25 tools: block transfer + revert + detach owner bi chan', async () => {
  const store = new V25Store();
  const tools = createMemoryV25Tools({ store, botId: 'bot-a' });
  const block = tool(tools, 'memory_v25_block');
  await block.execute({ action: 'create', label: 'notes', value: 'v1' });
  const id = store.blocks.list({})[0].id;
  await block.execute({ action: 'write', id, botId: 'bot-a', value: 'v2' });
  const reverted = await block.execute({ action: 'revert', id, botId: 'bot-a', version: 1 });
  assert.match(reverted, /ve v1/);
  assert.equal(store.blocks.get(id).version, 3);
  const detachOwner = await block.execute({ action: 'detach', id, botId: 'bot-a' });
  assert.match(detachOwner, /Error: .*Owner khong duoc detach/);
  const transferred = await block.execute({ action: 'transfer', id, botId: 'bot-a', toBotId: 'bot-b' });
  assert.match(transferred, /chuyen owner.*bot-b/);
  // Nguoi khong phai owner doi read-only bi chan.
  const denied = await block.execute({ action: 'readonly', id, botId: 'bot-a', readOnly: true });
  assert.match(denied, /Error: .*Chi owner/);
});

test('v25 tools: fact add/list/at/current/close — khong xoa vat ly', async () => {
  const store = new V25Store();
  const tools = createMemoryV25Tools({ store, botId: 'bot-a' });
  const fact = tool(tools, 'memory_v25_fact');
  const added = await fact.execute({
    action: 'add',
    subject: 'Huy',
    predicate: 'is',
    object: 'engineer',
    validAt: '2026-01-01T00:00:00.000Z',
  });
  assert.match(added, /Da them edge/);
  const id = store.facts.list({})[0].id;
  const current = await fact.execute({ action: 'current' });
  assert.match(current, /1 fact hien tai/);
  const atPast = await fact.execute({ action: 'at', at: '2025-06-01T00:00:00.000Z' });
  assert.match(atPast, /Khong co fact nao dung tai/);
  const atNow = await fact.execute({ action: 'at', at: '2026-06-01T00:00:00.000Z' });
  assert.match(atNow, /1 fact dung tai/);
  const closed = await fact.execute({ action: 'close', id, reason: 'het dung' });
  assert.match(closed, /Da dong hieu luc/);
  assert.match(closed, /khong bi xoa/);
  const after = await fact.execute({ action: 'current' });
  assert.match(after, /Khong co fact hien tai/);
  // Edge van lay duoc.
  const got = await fact.execute({ action: 'get', id });
  assert.match(got, /superseded/);
  // Supersede qua add.
  await fact.execute({ action: 'add', subject: 'Huy', predicate: 'is', object: 'manager', supersede: true });
  const list = await fact.execute({ action: 'list' });
  assert.match(list, /manager/);
});

test('v25 tools: judge ADD/UPDATE/DELETE/NOISE + log', async () => {
  const store = new V25Store();
  const tools = createMemoryV25Tools({ store, botId: 'bot-a' });
  const judge = tool(tools, 'memory_v25_judge');
  const add = await judge.execute({ action: 'judge', subject: 'Huy', predicate: 'is', object: 'engineer' });
  assert.match(add, /Judge: ADD/);
  assert.match(add, /Da ap dung/);
  const noise = await judge.execute({ action: 'judge', subject: 'Huy', predicate: 'is', object: 'engineer' });
  assert.match(noise, /Judge: NOISE/);
  const update = await judge.execute({ action: 'judge', subject: 'Huy', predicate: 'is', object: 'manager' });
  assert.match(update, /Judge: UPDATE/);
  const del = await judge.execute({
    action: 'judge',
    subject: 'Huy',
    predicate: 'is',
    object: 'manager',
    sourceText: 'Huy không còn là quản lý nữa.',
  });
  assert.match(del, /Judge: DELETE/);
  assert.equal(store.facts.queryCurrent().length, 0);
  // Preview (apply=false) khong ghi.
  const preview = await judge.execute({
    action: 'judge',
    subject: 'Lan',
    predicate: 'is',
    object: 'designer',
    apply: false,
  });
  assert.match(preview, /Judge: ADD/);
  assert.match(preview, /Chi xem truoc/);
  assert.equal(store.facts.size, 2);
  const log = await judge.execute({ action: 'log' });
  assert.match(log, /ADD 1, UPDATE 1, DELETE 1, NOISE 1/);
});

test('v25 tools: search + consolidate preview/run + config get/set', async () => {
  const store = new V25Store();
  const tools = createMemoryV25Tools({ store, botId: 'bot-a' });
  const search = tool(tools, 'memory_v25_search');
  const consolidate = tool(tools, 'memory_v25_consolidate');
  const config = tool(tools, 'memory_v25_config');
  const preview = await consolidate.execute({ action: 'preview', text: 'Huy là kỹ sư. Lan thích trà.' });
  assert.match(preview, /fact ung vien/);
  assert.match(preview, /kỹ sư/);
  const get = await config.execute({ action: 'get' });
  assert.match(get, /trigger sau 10 turn/);
  const set = await config.execute({ action: 'set', triggerSteps: 2 });
  assert.match(set, /trigger sau 2 turn/);
  const setBad = await config.execute({ action: 'set', triggerSteps: 0 });
  assert.match(setBad, /Error: /);
  const setEmpty = await config.execute({ action: 'set' });
  assert.match(setEmpty, /Error: .*Khong co truong nao/);
  // Buffer 2 turn roi consolidate run.
  const add = tool(tools, 'memory_v25_add');
  await add.execute({ text: 'Huy là kỹ sư phần mềm.' });
  await add.execute({ text: 'Huy thích cà phê.' });
  const run = await consolidate.execute({ action: 'run', reason: 'test' });
  assert.match(run, /Consolidation xong/);
  assert.match(run, /\+2 add/);
  const hits = await search.execute({ query: 'kỹ sư' });
  assert.match(hits, /Tim thay 1 memory/);
  const noHits = await search.execute({ query: 'xyz-khong-co' });
  assert.match(noHits, /Khong tim thay/);
});

test('v25 tools: audit superseded/judge/passes + stats + snapshot', async () => {
  const store = new V25Store();
  const tools = createMemoryV25Tools({ store, botId: 'bot-a' });
  const audit = tool(tools, 'memory_v25_audit');
  const stats = tool(tools, 'memory_v25_stats');
  const judge = tool(tools, 'memory_v25_judge');
  await judge.execute({ action: 'judge', subject: 'Huy', predicate: 'is', object: 'engineer' });
  await judge.execute({ action: 'judge', subject: 'Huy', predicate: 'is', object: 'manager' });
  const sup = await audit.execute({ action: 'superseded' });
  assert.match(sup, /1 fact da dong/);
  assert.match(sup, /khong bi xoa/);
  const jlog = await audit.execute({ action: 'judge' });
  assert.match(jlog, /2 muc judge/);
  const passes = await audit.execute({ action: 'passes' });
  assert.match(passes, /Chua co sleep pass/);
  const st = await stats.execute({});
  assert.match(st, /Memory v25:/);
  assert.match(st, /Fact: 2 tong \(1 active, 1 superseded/);
  assert.match(st, /Judge: 2 muc \(ADD 1, UPDATE 1/);
  const snap = await stats.execute({ includeSnapshot: true });
  assert.match(snap, /Snapshot prompt:/);
});

test('v25 tools: action sai + thieu arg tra Error ro rang', async () => {
  const store = new V25Store();
  const tools = createMemoryV25Tools({ store, botId: 'bot-a' });
  assert.match(await tool(tools, 'memory_v25_sleep').execute({ action: 'sai' }), /Error: /);
  assert.match(await tool(tools, 'memory_v25_block').execute({ action: 'sai' }), /Error: /);
  assert.match(await tool(tools, 'memory_v25_fact').execute({ action: 'sai' }), /Error: /);
  assert.match(await tool(tools, 'memory_v25_judge').execute({ action: 'sai' }), /Error: /);
  assert.match(await tool(tools, 'memory_v25_consolidate').execute({ action: 'sai' }), /Error: /);
  assert.match(await tool(tools, 'memory_v25_config').execute({ action: 'sai' }), /Error: /);
  assert.match(await tool(tools, 'memory_v25_audit').execute({ action: 'sai' }), /Error: /);
  assert.match(await tool(tools, 'memory_v25_add').execute({}), /Error: /);
  assert.match(await tool(tools, 'memory_v25_search').execute({}), /Error: /);
  assert.match(await tool(tools, 'memory_v25_fact').execute({ action: 'at', at: 'khong-phai-ngay' }), /Error: /);
});

test('v25 tools: workspaceDir luu store xuong disk', async () => {
  const dir = tmpDir();
  try {
    const tools = createMemoryV25Tools({ workspaceDir: dir, botId: 'bot-a' });
    await tool(tools, 'memory_v25_judge').execute({ action: 'judge', subject: 'Huy', predicate: 'is', object: 'engineer' });
    const tools2 = createMemoryV25Tools({ workspaceDir: dir, botId: 'bot-a' });
    const stats = await tool(tools2, 'memory_v25_stats').execute({});
    assert.match(stats, /Fact: 1 tong \(1 active/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
