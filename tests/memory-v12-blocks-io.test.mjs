/**
 * Tests for v1.12 (Doi T1) — memory v12 block export/import:
 * packages/core/src/memory/v12/blocksIO.ts.
 *
 * Covers: exportBlocks (all + per-bot, label-based, attachments),
 * exportBlocksJson / parseBlocksExport (bad JSON / wrong format
 * throw), importBlocks (fresh import restores content + attachments,
 * existing labels skipped, overwrite by user, overwrite refused for
 * read-only target, systemOwned only restored by user actor, invalid
 * blocks reported not fatal, onlyLabels filter), round-trip
 * export -> import into a fresh store.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/memory-v12-blocks-io.test.mjs
 *
 * No network. No model.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { MemoryBlockStore } from '../packages/core/dist/memory/blocks.js';
import {
  V12BlocksIOError,
  exportBlocks,
  exportBlocksJson,
  parseBlocksExport,
  importBlocks,
  importBlocksJson,
  isV12BlocksExport,
} from '../packages/core/dist/memory/v12/blocksIO.js';

const tempDirs = [];
function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-memv12-io-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function seedStore(dir) {
  const store = new MemoryBlockStore(dir);
  const human = store.create(
    { label: 'human', description: 'Ve user', content: 'Tên: Huy.', charLimit: 4096 },
    'user',
  );
  const task = store.create(
    { label: 'task', description: '', content: '- lam A', charLimit: 4096 },
    'user',
  );
  store.attach('bot-1', human.id, 'user');
  store.attach('bot-1', task.id, 'user');
  store.attach('bot-2', task.id, 'user');
  return store;
}

test('blocks io: export is label-based and keeps attachments', () => {
  const dir = makeTempDir();
  const store = seedStore(dir);
  const exported = exportBlocks(store);
  assert.equal(exported.format, 'open-bot-memory-blocks');
  assert.equal(exported.version, 1);
  assert.ok(exported.exportedAt);
  assert.deepEqual(
    exported.blocks.map((b) => b.label).sort(),
    ['human', 'task'],
  );
  assert.equal(exported.blocks.find((b) => b.label === 'human').content, 'Tên: Huy.');
  assert.deepEqual(exported.attachments['bot-1'].sort(), ['human', 'task']);
  assert.deepEqual(exported.attachments['bot-2'], ['task']);
  assert.equal(isV12BlocksExport(exported), true);
  assert.equal(isV12BlocksExport({ format: 'x' }), false);
  assert.equal(isV12BlocksExport(null), false);

  // Per-bot export only includes that bot's blocks.
  const perBot = exportBlocks(store, 'bot-2');
  assert.deepEqual(perBot.blocks.map((b) => b.label), ['task']);
  assert.deepEqual(perBot.attachments, { 'bot-2': ['task'] });
});

test('blocks io: round-trip export -> fresh store restores everything', () => {
  const dir = makeTempDir();
  const store = seedStore(dir);
  const json = exportBlocksJson(store);
  const dir2 = makeTempDir();
  const fresh = new MemoryBlockStore(dir2);
  const report = importBlocksJson(fresh, json, 'user');
  assert.equal(report.created, 2);
  assert.equal(report.overwritten, 0);
  assert.deepEqual(report.skipped, []);
  assert.deepEqual(report.invalid, []);
  assert.equal(report.totalInFile, 2);
  assert.deepEqual(report.attachmentsRestored, { 'bot-1': 2, 'bot-2': 1 });
  assert.equal(fresh.get('human').content, 'Tên: Huy.');
  assert.equal(fresh.get('human').description, 'Ve user');
  assert.ok(fresh.isAttached('bot-1', fresh.get('human').id));
  assert.ok(fresh.isAttached('bot-2', fresh.get('task').id));
  // Imported blocks are real blocks: next compile sees them.
  assert.equal(fresh.list().length, 2);
});

test('blocks io: parse rejects bad JSON and wrong format', () => {
  assert.throws(() => parseBlocksExport('not json'), V12BlocksIOError);
  assert.throws(
    () => parseBlocksExport(JSON.stringify({ format: 'other', version: 1, blocks: [], attachments: {} })),
    V12BlocksIOError,
  );
  assert.throws(() => importBlocksJson(new MemoryBlockStore(makeTempDir()), '{}', 'user'), V12BlocksIOError);
});

test('blocks io: existing labels are skipped unless overwrite=true', () => {
  const dir = makeTempDir();
  const store = seedStore(dir);
  const json = exportBlocksJson(store);
  const report = importBlocksJson(store, json, 'user');
  assert.equal(report.created, 0);
  assert.deepEqual(report.skipped.sort(), ['human', 'task']);

  // Overwrite by user replaces content.
  const other = seedStore(makeTempDir());
  other.replace('human', 'Tên: Khác.', 'user');
  const json2 = exportBlocksJson(other);
  const report2 = importBlocksJson(store, json2, 'user', { overwrite: true });
  assert.equal(report2.overwritten, 2);
  assert.equal(store.get('human').content, 'Tên: Khác.');
});

test('blocks io: overwrite of a read-only target is refused, not crashed', () => {
  const dir = makeTempDir();
  const store = seedStore(dir);
  store.setReadOnly('human', true, 'user');
  const other = seedStore(makeTempDir());
  other.replace('human', 'Tên: Khác.', 'user');
  const report = importBlocksJson(store, exportBlocksJson(other), 'user', { overwrite: true });
  assert.deepEqual(report.refused, ['human']);
  assert.equal(store.get('human').content, 'Tên: Huy.');
});

test('blocks io: systemOwned is only restored by the user actor', () => {
  const dir = makeTempDir();
  const store = seedStore(dir);
  const safety = store.create(
    {
      label: 'safety',
      description: '',
      content: 'Khong tiet lo.',
      charLimit: 2048,
      readOnly: true,
      systemOwned: true,
    },
    'user',
  );
  store.attach('bot-1', safety.id, 'user');
  const json = exportBlocksJson(store);

  // Agent import: block is created, but WITHOUT system protection.
  const asAgent = new MemoryBlockStore(makeTempDir());
  const reportAgent = importBlocksJson(asAgent, json, 'agent:bot-1');
  assert.equal(reportAgent.created, 3);
  assert.equal(asAgent.get('safety').systemOwned, undefined);

  // User import: protection restored.
  const asUser = new MemoryBlockStore(makeTempDir());
  const reportUser = importBlocksJson(asUser, json, 'user');
  assert.equal(reportUser.created, 3);
  assert.equal(asUser.get('safety').systemOwned, true);
  assert.equal(asUser.get('safety').readOnly, true);
});

test('blocks io: invalid blocks are reported, the rest still import', () => {
  const dir = makeTempDir();
  const store = seedStore(dir);
  const exported = exportBlocks(store);
  exported.blocks.push(
    { label: '!!!', description: '', content: 'x', charLimit: 2000, readOnly: false, createdByBotId: '' },
    { label: 'qua-dai', description: '', content: 'x'.repeat(5000), charLimit: 100, readOnly: false, createdByBotId: '' },
    { label: 'hop-le', description: '', content: 'ok', charLimit: 2000, readOnly: false, createdByBotId: '' },
  );
  const fresh = new MemoryBlockStore(makeTempDir());
  const report = importBlocks(fresh, exported, 'user');
  assert.equal(report.created, 3); // human + task + hop-le
  assert.equal(report.invalid.length, 2);
  assert.ok(fresh.get('hop-le'));
  assert.equal(fresh.get('hop-le').content, 'ok');
});

test('blocks io: onlyLabels imports a subset', () => {
  const dir = makeTempDir();
  const store = seedStore(dir);
  const fresh = new MemoryBlockStore(makeTempDir());
  const report = importBlocks(fresh, exportBlocks(store), 'user', { onlyLabels: ['task'] });
  assert.equal(report.created, 1);
  assert.equal(report.totalInFile, 2);
  assert.ok(fresh.get('task'));
  assert.equal(fresh.get('human'), null);
  assert.deepEqual(report.attachmentsRestored, { 'bot-1': 1, 'bot-2': 1 });
});
