/**
 * Composio v114 checkpoint store tests (v1.14, Doi T4 — node:test,
 * no network, no key).
 *
 * Covers:
 * - Memory store: save/load/remove/clear + round-trip copies
 * - JSON file store: save/load round-trip, saveAll merge, remove,
 *   clear, missing file -> [], corrupt JSON / bad entry / duplicate
 *   scheduleId throw, atomic write keeps the old file intact
 * - loadComposioV114CheckpointForSchedule helper
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/composio-v114-checkpoints.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  COMPOSIO_V114_CHECKPOINTS_FILE,
  JsonFileComposioV114CheckpointStore,
  MemoryComposioV114CheckpointStore,
  getComposioV114CheckpointsPath,
  loadComposioV114CheckpointForSchedule,
} from '../packages/core/dist/composio/pollCheckpointStoreV114.js';
import {
  checkpointComposioV114Schedule,
  createComposioV114Schedule,
  nextComposioV114PollAfterSuccess,
} from '../packages/core/dist/composio/pollSchedulerV2.js';

const NO_JITTER = () => 0.5;

function makeCheckpoint(scheduleId, nowMs = 5000) {
  const schedule = createComposioV114Schedule({
    id: scheduleId,
    connectionId: `ca_${scheduleId}`,
    toolkit: 'gmail',
    triggerSlug: 'GMAIL_NEW_GMAIL_MESSAGE',
    startAtMs: 1000,
    jitterFraction: 0,
  });
  const done = nextComposioV114PollAfterSuccess(
    schedule,
    2000,
    { newItems: 2, duplicates: 0, cursor: 'cur_1' },
    NO_JITTER,
  );
  return checkpointComposioV114Schedule(done, [{ id: 'm1', atMs: 2000 }], nowMs);
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-v114-cp-'));
}

test('composio v114 checkpoints: memory store round-trip', () => {
  const store = new MemoryComposioV114CheckpointStore();
  assert.deepEqual(store.loadAll(), []);
  assert.equal(store.load('poll:gmail:m1'), undefined);
  const cp = makeCheckpoint('poll:gmail:m1');
  store.save(cp);
  assert.deepEqual(store.load('poll:gmail:m1'), cp);
  // Load tra ban sao — sua ban tra ve khong anh huong store.
  const loaded = store.load('poll:gmail:m1');
  loaded.seen.push({ id: 'evil', atMs: 1 });
  assert.equal(store.load('poll:gmail:m1').seen.length, 1);
  // SaveAll merge + ghi de cung scheduleId.
  const cp2 = makeCheckpoint('poll:gmail:m2');
  store.saveAll([cp, cp2]);
  assert.equal(store.loadAll().length, 2);
  const updated = { ...cp, lastCursor: 'cur_2' };
  store.save(updated);
  assert.equal(store.load('poll:gmail:m1').lastCursor, 'cur_2');
  assert.equal(store.loadAll().length, 2);
  assert.equal(store.remove('poll:gmail:m2'), true);
  assert.equal(store.remove('poll:gmail:m2'), false);
  assert.equal(store.loadAll().length, 1);
  store.clear();
  assert.deepEqual(store.loadAll(), []);
  assert.throws(() => store.load(''), /scheduleId must be a non-empty string/);
  assert.throws(() => store.save({ ...cp, version: 99 }), /unsupported checkpoint version/);
});

test('composio v114 checkpoints: json file store round-trip + merge + remove', () => {
  const dir = tmpDir();
  assert.equal(getComposioV114CheckpointsPath(dir), path.join(dir, COMPOSIO_V114_CHECKPOINTS_FILE));
  const store = new JsonFileComposioV114CheckpointStore({ dir });
  assert.equal(store.path, path.join(dir, COMPOSIO_V114_CHECKPOINTS_FILE));
  // Chua co file -> [] (khong throw).
  assert.deepEqual(store.loadAll(), []);
  const cp1 = makeCheckpoint('poll:gmail:f1');
  const cp2 = makeCheckpoint('poll:slack:f2');
  store.save(cp1);
  assert.ok(fs.existsSync(store.path), 'file must exist after save');
  assert.deepEqual(store.load('poll:gmail:f1'), cp1);
  store.saveAll([cp1, cp2]);
  assert.equal(store.loadAll().length, 2);
  // Store moi doc lai tu dia thay du lieu cu.
  const reopened = new JsonFileComposioV114CheckpointStore({ dir });
  assert.equal(reopened.loadAll().length, 2);
  assert.equal(reopened.load('poll:slack:f2').lastCursor, 'cur_1');
  assert.equal(reopened.remove('poll:slack:f2'), true);
  assert.equal(reopened.load('poll:slack:f2'), undefined);
  assert.equal(reopened.loadAll().length, 1);
  reopened.clear();
  assert.deepEqual(reopened.loadAll(), []);
  assert.deepEqual(JSON.parse(fs.readFileSync(store.path, 'utf-8')), []);
  assert.throws(() => new JsonFileComposioV114CheckpointStore({ dir: '' }), /dir must be a non-empty string/);
  assert.throws(() => store.load(''), /scheduleId must be a non-empty string/);
});

test('composio v114 checkpoints: corrupt file throws, helper loads by id', () => {
  const dir = tmpDir();
  const store = new JsonFileComposioV114CheckpointStore({ dir });
  store.save(makeCheckpoint('poll:gmail:c1'));
  // JSON hong.
  fs.writeFileSync(store.path, '{not json', 'utf-8');
  assert.throws(() => store.loadAll(), /not valid JSON/);
  // JSON hop le nhung khong phai mang.
  fs.writeFileSync(store.path, '{"a":1}', 'utf-8');
  assert.throws(() => store.loadAll(), /must contain an array/);
  // Entry sai version.
  const bad = makeCheckpoint('poll:gmail:c1');
  fs.writeFileSync(store.path, JSON.stringify([{ ...bad, version: 42 }]), 'utf-8');
  assert.throws(() => store.loadAll(), /unsupported checkpoint version/);
  // Trung scheduleId.
  fs.writeFileSync(store.path, JSON.stringify([bad, bad]), 'utf-8');
  assert.throws(() => store.loadAll(), /duplicate scheduleId/);
  // Helper: co thi tra checkpoint, khong co thi undefined.
  const dir2 = tmpDir();
  const store2 = new JsonFileComposioV114CheckpointStore({ dir: dir2 });
  store2.save(makeCheckpoint('poll:gmail:h1'));
  assert.equal(loadComposioV114CheckpointForSchedule(store2, 'poll:gmail:h1')?.scheduleId, 'poll:gmail:h1');
  assert.equal(loadComposioV114CheckpointForSchedule(store2, 'poll:gmail:nope'), undefined);
  assert.throws(() => loadComposioV114CheckpointForSchedule(store2, ''), /scheduleId must be a non-empty string/);
});
