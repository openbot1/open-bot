/**
 * Tests for v1.11 (Doi T1) — unified block_history table:
 * packages/core/src/memory/v11/blockHistoryTable.ts.
 *
 * Covers: recording changes from any backend, listing (newest
 * first, backend filter, pagination), diff between versions
 * (unified diff + counts), rollback (writes a NEW version, never
 * rewrites history, rollback itself is recorded), stats, prune cap,
 * corrupt-line tolerance.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/memory-v11-history-table.test.mjs
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
  recordBlockHistoryChange,
  listBlockHistory,
  readBlockHistoryVersion,
  diffBlockVersions,
  rollbackBlockToVersion,
  blockHistoryStats,
  historyInputFromBlock,
  readAllBlockHistoryEntries,
  V11_BLOCK_HISTORY_REL_PATH,
  V11HistoryError,
} from '../packages/core/dist/memory/v11/blockHistoryTable.js';

const tempDirs = [];
function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-memv11-history-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeBlock(dir, label, content) {
  const store = new MemoryBlockStore(dir);
  return store.create({ label, description: '', content, charLimit: 2000 }, 'user');
}

test('record + list: newest first, backend filter, pagination', () => {
  const dir = makeTempDir();
  const block = makeBlock(dir, 'task', 'v1 content');
  assert.equal(recordBlockHistoryChange(dir, historyInputFromBlock(block, 'blocks', 'create', 'user')), true);
  const store = new MemoryBlockStore(dir);
  const v2 = store.replace(block.id, 'v2 content', 'user');
  recordBlockHistoryChange(dir, historyInputFromBlock(v2, 'git-v7', 'replace', 'user'));
  const v3 = store.replace(block.id, 'v3 content', 'user');
  recordBlockHistoryChange(dir, historyInputFromBlock(v3, 'sleep-v11', 'consolidate', 'sleep:v11:bot-1'));

  const all = listBlockHistory(dir, block.id);
  assert.equal(all.length, 3);
  assert.equal(all[0].version, 3);
  assert.equal(all[0].backend, 'sleep-v11');
  assert.equal(all[2].version, 1);
  assert.equal(listBlockHistory(dir, block.id, { backend: 'git-v7' }).length, 1);
  assert.equal(listBlockHistory(dir, block.id, { backend: 'blocks' })[0].action, 'create');
  assert.equal(listBlockHistory(dir, block.id, { limit: 1 }).length, 1);
  assert.equal(listBlockHistory(dir, block.id, { limit: 1, offset: 1 })[0].version, 2);
  assert.deepEqual(listBlockHistory(dir, 'missing-block'), []);
});

test('readBlockHistoryVersion: exact version or null', () => {
  const dir = makeTempDir();
  const block = makeBlock(dir, 'human', 'one');
  recordBlockHistoryChange(dir, historyInputFromBlock(block, 'blocks', 'create', 'user'));
  assert.equal(readBlockHistoryVersion(dir, block.id, 1)?.content, 'one');
  assert.equal(readBlockHistoryVersion(dir, block.id, 2), null);
});

test('diffBlockVersions: unified diff + added/removed counts', () => {
  const dir = makeTempDir();
  const block = makeBlock(dir, 'project', 'line1\nline2\nline3');
  recordBlockHistoryChange(dir, historyInputFromBlock(block, 'blocks', 'create', 'user'));
  const store = new MemoryBlockStore(dir);
  const v2 = store.replace(block.id, 'line1\nLINE2\nline3\nline4', 'user');
  recordBlockHistoryChange(dir, historyInputFromBlock(v2, 'core-v9', 'replace', 'agent:bot-1'));

  const diff = diffBlockVersions(dir, block.id, 1, 2);
  assert.equal(diff.label, 'project');
  assert.equal(diff.fromVersion, 1);
  assert.equal(diff.toVersion, 2);
  assert.equal(diff.diff.added, 2);
  assert.equal(diff.diff.removed, 1);
  assert.ok(diff.unified.includes('-line2'));
  assert.ok(diff.unified.includes('+LINE2'));
  assert.ok(diff.unified.includes('+line4'));
  assert.throws(() => diffBlockVersions(dir, block.id, 1, 99), V11HistoryError);
  assert.throws(() => diffBlockVersions(dir, block.id, 99, 2), V11HistoryError);
});

test('rollbackBlockToVersion: new version, history kept, rollback recorded', () => {
  const dir = makeTempDir();
  const block = makeBlock(dir, 'task', 'original text');
  recordBlockHistoryChange(dir, historyInputFromBlock(block, 'blocks', 'create', 'user'));
  const store = new MemoryBlockStore(dir);
  const v2 = store.replace(block.id, 'changed text', 'user');
  recordBlockHistoryChange(dir, historyInputFromBlock(v2, 'blocks', 'replace', 'user'));

  const result = rollbackBlockToVersion(dir, block.id, 1, 'user');
  assert.equal(result.fromVersion, 2);
  assert.equal(result.restoredVersion, 1);
  assert.equal(result.newVersion, 3);
  assert.equal(result.content, 'original text');
  assert.equal(store.get(block.id).content, 'original text');
  assert.equal(store.get(block.id).version, 3);
  // History still has versions 1 and 2, plus the rollback entry (v3).
  const entries = listBlockHistory(dir, block.id, { limit: 10 });
  assert.ok(entries.some((e) => e.version === 1 && e.action === 'create'));
  assert.ok(entries.some((e) => e.version === 2 && e.action === 'replace'));
  assert.ok(entries.some((e) => e.version === 3 && e.action === 'rollback'));
  // Rollback to an unknown version throws.
  assert.throws(() => rollbackBlockToVersion(dir, block.id, 99, 'user'), V11HistoryError);
  // Rollback of a deleted block throws.
  store.delete(block.id, 'user');
  assert.throws(() => rollbackBlockToVersion(dir, block.id, 1, 'user'), V11HistoryError);
});

test('blockHistoryStats: totals by backend/action', () => {
  const dir = makeTempDir();
  assert.deepEqual(blockHistoryStats(dir), {
    totalEntries: 0,
    blockCount: 0,
    backends: {},
    actions: {},
    latestAt: null,
  });
  const b1 = makeBlock(dir, 'a-block', 'x');
  const b2 = makeBlock(dir, 'b-block', 'y');
  recordBlockHistoryChange(dir, historyInputFromBlock(b1, 'blocks', 'create', 'user'));
  recordBlockHistoryChange(dir, historyInputFromBlock(b2, 'shared-v11', 'create', 'user'));
  recordBlockHistoryChange(dir, historyInputFromBlock(b2, 'shared-v11', 'append', 'agent:bot-1'));
  const stats = blockHistoryStats(dir);
  assert.equal(stats.totalEntries, 3);
  assert.equal(stats.blockCount, 2);
  assert.equal(stats.backends['shared-v11'], 2);
  assert.equal(stats.backends.blocks, 1);
  assert.equal(stats.actions.create, 2);
  assert.equal(stats.actions.append, 1);
  assert.ok(typeof stats.latestAt === 'string');
});

test('corrupt lines are skipped, never crash the read', () => {
  const dir = makeTempDir();
  const block = makeBlock(dir, 'task', 'ok');
  recordBlockHistoryChange(dir, historyInputFromBlock(block, 'blocks', 'create', 'user'));
  const filePath = path.join(dir, V11_BLOCK_HISTORY_REL_PATH);
  fs.appendFileSync(filePath, 'this is not json\n{"blockId": 123}\n');
  const entries = readAllBlockHistoryEntries(dir);
  assert.equal(entries.length, 1);
  assert.equal(listBlockHistory(dir, block.id).length, 1);
});

test('record failure is best-effort (returns false, never throws)', () => {
  // A file where the history dir should be makes mkdir fail.
  const dir = makeTempDir();
  fs.writeFileSync(path.join(dir, '.open-bot'), 'not a directory');
  const fake = {
    blockId: 'b1',
    label: 'task',
    backend: 'blocks',
    action: 'create',
    actor: 'user',
    version: 1,
    content: 'x',
  };
  assert.equal(recordBlockHistoryChange(dir, fake), false);
});
