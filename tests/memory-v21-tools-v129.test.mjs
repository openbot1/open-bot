/**
 * Tests for memory v21 tools (v1.29, Doi T1).
 * packages/tools/src/memoryV21Tools.ts
 *
 * Run after building core + tools (memoryV21Tools only):
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/memory-v21-tools-v129.test.mjs
 * No network. No model. Uses temp dirs under os.tmpdir().
 *
 * NOTE: chi import dist/memoryV21Tools.js (scoped) — khong import
 * dist/tools.js (ALL_TOOLS) vi build full tools can cac dep nang
 * (playwright/pdfjs/...); coordinator kiem tra ALL_TOOLS o luc gop.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MEMORY_V21_TOOLS,
  MEMORY_V21_TOOL_NAMES,
  createMemoryV21Tools,
} from '../packages/tools/dist/memoryV21Tools.js';
import { V21RecordStore } from '../packages/core/dist/memory/v21/index.js';

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'openbot-v21-tools-'));
}

function toolByName(tools, name) {
  const found = tools.find((t) => t.definition.name === name);
  assert.ok(found, `thieu tool ${name}`);
  return found;
}

function sampleRecord(id = 'user-thich-ca-phe') {
  return {
    id,
    type: 'fact',
    title: 'User thich ca phe',
    body: 'User uong ca phe den moi sang, khong duong.',
    tags: ['ca-phe'],
    sources: ['chat:session-1'],
    codeRefs: [],
    version: 1,
    createdAt: 1794000000000,
    updatedAt: 1794000000000,
  };
}

test('v21 tools: 10 tools, ten duy nhat, needsApproval dung (ghi=true, doc=false)', () => {
  assert.equal(MEMORY_V21_TOOL_NAMES.length, 10);
  assert.equal(new Set(MEMORY_V21_TOOL_NAMES).size, 10);
  assert.equal(MEMORY_V21_TOOLS.length, 10);
  const byName = new Map(MEMORY_V21_TOOLS.map((t) => [t.definition.name, t]));
  assert.equal(byName.get('memory_v21_convert').needsApproval, false);
  assert.equal(byName.get('memory_v21_validate').needsApproval, false);
  assert.equal(byName.get('memory_v21_bundle_info').needsApproval, false);
  for (const name of [
    'memory_v21_export',
    'memory_v21_import',
    'memory_v21_sync',
    'memory_v21_tombstone',
    'memory_v21_version',
    'memory_v21_sleep',
    'memory_v21_record',
  ]) {
    assert.equal(byName.get(name).needsApproval, true, `${name} ghi nen can duyet`);
  }
  for (const tool of MEMORY_V21_TOOLS) {
    assert.equal(tool.definition.parameters.type, 'object');
    assert.ok(tool.definition.description.length > 10);
    assert.equal(typeof tool.execute, 'function');
  }
  // Factory bound tra ve cung 10 tool.
  assert.equal(createMemoryV21Tools({}).length, 10);
});

test('v21 tools: record CRUD qua tool (create/get/list/update)', async () => {
  const tools = createMemoryV21Tools({});
  const recordTool = toolByName(tools, 'memory_v21_record');
  const created = await recordTool.execute({ action: 'create', record: JSON.stringify(sampleRecord()) });
  assert.match(created, /Da tao record "user-thich-ca-phe" v1/);
  const listed = await recordTool.execute({ action: 'list' });
  assert.match(listed, /Co 1 record/);
  const got = await recordTool.execute({ action: 'get', recordId: 'user-thich-ca-phe' });
  assert.equal(JSON.parse(got).title, 'User thich ca phe');
  const updated = await recordTool.execute({
    action: 'update',
    recordId: 'user-thich-ca-phe',
    patch: JSON.stringify({ body: 'User uong ca phe den, it duong.' }),
  });
  assert.match(updated, /len v2/);
  const missing = await recordTool.execute({ action: 'get', recordId: 'khong-co' });
  assert.match(missing, /^Error: khong tim thay record/);
});

test('v21 tools: export OKF -> bundle_info -> import (dry-run + that)', async (t) => {
  const dir = tmpDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new V21RecordStore();
  const tools = createMemoryV21Tools({ recordStore: store });
  const recordTool = toolByName(tools, 'memory_v21_record');
  await recordTool.execute({ action: 'create', record: JSON.stringify(sampleRecord()) });
  const exportTool = toolByName(tools, 'memory_v21_export');
  const exported = await exportTool.execute({ format: 'okf', dir });
  assert.match(exported, /Da xuat 1 record sang OKF/);
  assert.ok(existsSync(join(dir, 'user-thich-ca-phe.md')));
  assert.match(readFileSync(join(dir, 'user-thich-ca-phe.md'), 'utf8'), /^---\ntype: fact\n/);
  const infoTool = toolByName(tools, 'memory_v21_bundle_info');
  const info = await infoTool.execute({ dir });
  assert.match(info, /format doan duoc: okf/);
  assert.match(info, /Parse duoc 1 record/);
  // Nhap vao store moi: dry-run truoc, roi nhap that.
  const fresh = new V21RecordStore();
  const tools2 = createMemoryV21Tools({ recordStore: fresh });
  const importTool = toolByName(tools2, 'memory_v21_import');
  const dry = await importTool.execute({ dir, dryRun: true });
  assert.match(dry, /\[dry-run\] format okf: 1 record hop le/);
  assert.equal(fresh.size(), 0);
  const imported = await importTool.execute({ dir });
  assert.match(imported, /Da nhap 1 record \(okf\)/);
  assert.equal(fresh.size(), 1);
  assert.equal(fresh.get('user-thich-ca-phe').body, 'User uong ca phe den moi sang, khong duong.');
});

test('v21 tools: convert + validate qua tool', async () => {
  const tools = createMemoryV21Tools({});
  const convertTool = toolByName(tools, 'memory_v21_convert');
  const okf = '---\ntype: fact\ntitle: T\ncode_refs: [a/b.ts]\n---\n\nBody.\n';
  const converted = await convertTool.execute({
    from: 'okf',
    to: 'openhands',
    files: JSON.stringify([{ path: 't.md', content: okf }]),
  });
  assert.match(converted, /Convert okf -> openhands: 1 record/);
  assert.match(converted, /Field bi mat: code_refs/);
  assert.match(converted, /## T/);
  const strictFail = await convertTool.execute({
    from: 'okf',
    to: 'openhands',
    strict: true,
    files: JSON.stringify([{ path: 't.md', content: okf }]),
  });
  assert.match(strictFail, /strict mode/);
  const validateTool = toolByName(tools, 'memory_v21_validate');
  const bad = await validateTool.execute({ text: 'Khong co frontmatter.\n' });
  assert.match(bad, /\[LOI\]/);
  const good = await validateTool.execute({ text: okf });
  assert.match(good, /Hop le/);
});

test('v21 tools: tombstone delete/list/restore + version history/rollback', async () => {
  const store = new V21RecordStore();
  const tools = createMemoryV21Tools({ recordStore: store });
  const recordTool = toolByName(tools, 'memory_v21_record');
  await recordTool.execute({ action: 'create', record: JSON.stringify(sampleRecord()) });
  await recordTool.execute({
    action: 'update',
    recordId: 'user-thich-ca-phe',
    patch: JSON.stringify({ body: 'Body v2.' }),
  });
  const versionTool = toolByName(tools, 'memory_v21_version');
  const history = await versionTool.execute({ action: 'history', recordId: 'user-thich-ca-phe' });
  assert.match(history, /2 version/);
  const rolled = await versionTool.execute({
    action: 'rollback',
    recordId: 'user-thich-ca-phe',
    toVersion: 1,
    reason: 'sai noi dung v2',
  });
  assert.match(rolled, /ve v1 \(hien tai v3\)/);
  const tombTool = toolByName(tools, 'memory_v21_tombstone');
  const deleted = await tombTool.execute({ action: 'delete', recordId: 'user-thich-ca-phe', reason: 'khong can nua' });
  assert.match(deleted, /Da xoa "user-thich-ca-phe" \(tombstone/);
  const list = await tombTool.execute({ action: 'list' });
  assert.match(list, /Co 1 tombstone/);
  assert.match(list, /khong can nua/);
  const restored = await tombTool.execute({ action: 'restore', recordId: 'user-thich-ca-phe' });
  assert.match(restored, /Da khoi phuc "user-thich-ca-phe"/);
  assert.equal(store.get('user-thich-ca-phe').body, 'User uong ca phe den moi sang, khong duong.');
});

test('v21 tools: sync keep_remote ap dung remote + sleep pass chay duoc', async () => {
  const store = new V21RecordStore();
  store.create(sampleRecord(), 'tester');
  const tools = createMemoryV21Tools({ recordStore: store });
  const syncTool = toolByName(tools, 'memory_v21_sync');
  const base = [sampleRecord()];
  const local = [sampleRecord()];
  const remote = [{ ...sampleRecord(), body: 'Remote sua body.', version: 2, updatedAt: 2000 }];
  const synced = await syncTool.execute({
    base: JSON.stringify(base),
    local: JSON.stringify(local),
    remote: JSON.stringify(remote),
    strategy: 'keep_remote',
  });
  assert.match(synced, /remote ap dung 1/);
  assert.equal(store.get('user-thich-ca-phe').body, 'Remote sua body.');
  const sleepTool = toolByName(tools, 'memory_v21_sleep');
  const slept = await sleepTool.execute({
    sessions: JSON.stringify([
      { sessionId: 's1', facts: [{ text: 'User thich tra dao vao chieu.', source: 'chat', confidence: 0.9, observedAt: Date.now() }] },
    ]),
    trigger: 'manual',
  });
  assert.match(slept, /Sleep v21 xong/);
  assert.match(slept, /promote 1 vao block/);
});
