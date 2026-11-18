/**
 * Tests for memory v21 — versioning + sync + tombstones (v1.29, Doi T1).
 * packages/core/src/memory/v21/{versioning,sync,tombstones}.ts
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/memory-v21-sync-versioning-tombstone-v129.test.mjs
 * No network. No model.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  V21RecordStore,
  V21TombstoneStore,
  V21VersionLog,
  applySyncV21,
  bumpVersionVectorV21,
  compareVersionVectorsV21,
  createTombstoneV21,
  detectSyncConflictsV21,
  resolveSyncConflictV21,
  snapshotOfRecordV21,
  threeWayMergeV21,
} from '../packages/core/dist/memory/v21/index.js';

function record(id, body = `Body cua ${id}.`, version = 1) {
  return {
    id,
    type: 'fact',
    title: `Tieu de ${id}`,
    body,
    tags: [],
    sources: [],
    codeRefs: [],
    version,
    createdAt: 1000,
    updatedAt: 1000 + version,
    originFormat: 'okf',
  };
}

test('v21 versioning: store CRUD bumps version + keeps append-only history', () => {
  const store = new V21RecordStore();
  const created = store.create(record('a'), 'tester');
  assert.equal(created.ok, true);
  assert.equal(created.data.version, 1);
  assert.equal(store.create(record('a'), 'tester').ok, false);
  const updated = store.update('a', { body: 'Body moi.\nDong 2.' }, 'tester');
  assert.equal(updated.ok, true);
  assert.equal(updated.data.version, 2);
  const history = store.listVersions('a');
  assert.equal(history.length, 2);
  assert.equal(history[0].change, 'create');
  assert.equal(history[0].parentVersion, 0);
  assert.equal(history[1].change, 'update');
  assert.equal(history[1].parentVersion, 1);
  assert.equal(history[1].hash.length, 64);
  const summary = store.summary('a');
  assert.equal(summary.currentVersion, 2);
  assert.equal(summary.totalVersions, 2);
  assert.equal(summary.lastBy, 'tester');
});

test('v21 versioning: diff + rollback create a NEW version (history intact)', () => {
  const store = new V21RecordStore();
  store.create(record('a', 'Dong 1.\nDong 2.\nDong 3.'), 'tester');
  store.update('a', { body: 'Dong 1.\nDong 2 sua.\nDong 3.\nDong 4 moi.' }, 'tester');
  const diff = store.diffVersions('a', 1, 2);
  assert.equal(diff.ok, true);
  assert.equal(diff.data.addedCount, 2);
  assert.equal(diff.data.removedCount, 1);
  assert.equal(diff.data.unchangedCount, 2);
  const badDiff = store.diffVersions('a', 1, 99);
  assert.equal(badDiff.ok, false);
  const rolled = store.rollback('a', 1, 'tester', 'sai noi dung v2');
  assert.equal(rolled.ok, true);
  assert.equal(rolled.data.version, 3);
  assert.equal(rolled.data.body, 'Dong 1.\nDong 2.\nDong 3.');
  assert.equal(store.listVersions('a').length, 3);
  assert.equal(store.getVersionContent('a', 2).body, 'Dong 1.\nDong 2 sua.\nDong 3.\nDong 4 moi.');
  assert.equal(store.rollback('a', 3, 'tester', 'ly do').ok, false);
  assert.equal(store.rollback('a', 1, 'tester', 'x').ok, false);
});

test('v21 versioning: delete/restore are soft (snapshot kept, history kept)', () => {
  const store = new V21RecordStore();
  store.create(record('a'), 'tester');
  assert.equal(store.delete('a', 'tester', 'x').ok, false);
  const deleted = store.delete('a', 'tester', 'khong can nua');
  assert.equal(deleted.ok, true);
  assert.equal(store.get('a'), undefined);
  assert.equal(store.isDeleted('a'), true);
  assert.equal(store.getIncludingDeleted('a').id, 'a');
  assert.equal(store.size(), 0);
  assert.equal(store.size(true), 1);
  const restored = store.restore('a', 'tester');
  assert.equal(restored.ok, true);
  assert.equal(restored.data.version, 3);
  assert.equal(store.get('a').body, 'Body cua a.');
  assert.equal(store.restore('a', 'tester').ok, false);
});

test('v21 versioning: V21VersionLog JSON round-trip', () => {
  const log = new V21VersionLog();
  log.record({ recordId: 'a', version: 1, at: 100, by: 'u', change: 'create', summary: 'tao', parentVersion: 0 });
  log.record({ recordId: 'a', version: 2, at: 200, by: 'u', change: 'update', summary: 'sua', parentVersion: 1 });
  log.record({ recordId: 'b', version: 1, at: 150, by: 'u', change: 'create', summary: 'tao b', parentVersion: 0 });
  assert.deepEqual(log.recordIds(), ['a', 'b']);
  assert.equal(log.latest('a').version, 2);
  const restored = V21VersionLog.fromJSON(log.toJSON());
  assert.equal(restored.count('a'), 2);
  assert.equal(restored.summary('b').lastChange, 'create');
  assert.equal(restored.summary('missing'), undefined);
});

function snapMap(records) {
  const map = new Map();
  for (const r of records) map.set(r.id, snapshotOfRecordV21(r, r.deleted ?? false));
  return map;
}

test('v21 sync: fast-forward cases (remote-only, local-only, both-same, new)', () => {
  const base = snapMap([record('a'), record('b')]);
  const local = snapMap([record('a'), record('b')]);
  const remote = snapMap([
    { ...record('a'), body: 'Remote sua a.', version: 2, updatedAt: 2000 },
    record('b'),
    record('c'),
  ]);
  const merged = threeWayMergeV21({ base, local, remote });
  assert.deepEqual(merged.remoteOnlyChanged, ['a']);
  assert.deepEqual(merged.remoteOnlyNew, ['c']);
  assert.deepEqual(merged.conflicts, []);
  // Ca hai cung sua giong nhau -> khong conflict.
  const same = threeWayMergeV21({
    base,
    local: snapMap([{ ...record('a'), body: 'Cung sua.', version: 2, updatedAt: 2000 }, record('b')]),
    remote: snapMap([{ ...record('a'), body: 'Cung sua.', version: 2, updatedAt: 2000 }, record('b')]),
  });
  assert.deepEqual(same.bothChangedSame, ['a']);
  assert.deepEqual(same.conflicts, []);
});

test('v21 sync: conflicts — edit_edit, delete_edit, version_fork, tombstone_edit', () => {
  const base = snapMap([record('a'), record('b'), record('c')]);
  // edit_edit
  const editEdit = detectSyncConflictsV21({
    base,
    local: snapMap([{ ...record('a'), body: 'Local sua.', version: 2, updatedAt: 2000 }, record('b'), record('c')]),
    remote: snapMap([{ ...record('a'), body: 'Remote sua.', version: 2, updatedAt: 2000 }, record('b'), record('c')]),
  });
  assert.equal(editEdit.length, 1);
  assert.equal(editEdit[0].kind, 'edit_edit');
  // delete_edit: local xoa (khong co trong map), remote sua.
  const deleteEdit = detectSyncConflictsV21({
    base,
    local: snapMap([record('b'), record('c')]),
    remote: snapMap([{ ...record('a'), body: 'Remote sua.', version: 2, updatedAt: 2000 }, record('b'), record('c')]),
  });
  assert.equal(deleteEdit.length, 1);
  assert.equal(deleteEdit[0].kind, 'delete_edit');
  // version_fork: ca hai cung tao moi cung id, noi dung khac.
  const fork = detectSyncConflictsV21({
    base: new Map(),
    local: snapMap([{ ...record('x'), body: 'Local tao.' }]),
    remote: snapMap([{ ...record('x'), body: 'Remote tao.' }]),
  });
  assert.equal(fork.length, 1);
  assert.equal(fork[0].kind, 'version_fork');
  assert.equal(fork[0].baseVersion, 0);
  // tombstone_edit: local xoa (deleted=true, tombstone sau), remote sua SAU khi xoa.
  const localTomb = snapshotOfRecordV21({ ...record('b'), version: 2, updatedAt: 3000 }, true, {
    recordId: 'b',
    format: 'okf',
    previousVersion: 1,
    previousHash: 'h',
    deletedAt: 3000,
    deletedBy: 'user',
    reason: 'xoa',
  });
  const tombEdit = detectSyncConflictsV21({
    base,
    local: new Map([['a', snapshotOfRecordV21(record('a'))], ['b', localTomb], ['c', snapshotOfRecordV21(record('c'))]]),
    remote: snapMap([record('a'), { ...record('b'), body: 'Remote sua sau khi xoa.', version: 2, updatedAt: 4000 }, record('c')]),
  });
  assert.equal(tombEdit.length, 1);
  assert.equal(tombEdit[0].kind, 'tombstone_edit');
  // Xoa mot ben, ben kia khong doi -> khong conflict, chi deletedOneSide.
  const oneSide = threeWayMergeV21({
    base,
    local: snapMap([record('a'), record('c')]),
    remote: snapMap([record('a'), record('b'), record('c')]),
  });
  assert.deepEqual(oneSide.deletedOneSide, [{ recordId: 'b', deletedBy: 'local' }]);
  assert.deepEqual(oneSide.conflicts, []);
});

test('v21 sync: resolve strategies — keep_local/remote/both/manual', () => {
  const conflict = { recordId: 'a', kind: 'edit_edit', baseVersion: 1, localVersion: 2, remoteVersion: 2, detail: 'x' };
  const local = snapshotOfRecordV21({ ...record('a'), body: 'Local.', version: 2 });
  const remote = snapshotOfRecordV21({ ...record('a'), body: 'Remote.', version: 2 });
  const keepLocal = resolveSyncConflictV21({ conflict, strategy: 'keep_local', local, remote });
  assert.equal(keepLocal.outcome, 'local');
  assert.equal(keepLocal.kept.body, 'Local.');
  const keepRemote = resolveSyncConflictV21({ conflict, strategy: 'keep_remote', local, remote });
  assert.equal(keepRemote.outcome, 'remote');
  assert.equal(keepRemote.kept.body, 'Remote.');
  const both = resolveSyncConflictV21({ conflict, strategy: 'keep_both', local, remote });
  assert.equal(both.outcome, 'both');
  assert.equal(both.renamedCopy.id, 'a-remote');
  assert.equal(both.renamedCopy.title, 'Tieu de a (remote)');
  assert.ok(both.renamedCopy.sources.includes('sync-conflict:a'));
  const manual = resolveSyncConflictV21({ conflict, strategy: 'manual', local, remote });
  assert.equal(manual.outcome, 'pending');
});

test('v21 sync: applySyncV21 end-to-end with keep_both + pending', () => {
  const base = snapMap([record('a'), record('b')]);
  const local = snapMap([
    { ...record('a'), body: 'Local sua a.', version: 2, updatedAt: 2000 },
    record('b'),
  ]);
  const remote = snapMap([
    { ...record('a'), body: 'Remote sua a.', version: 2, updatedAt: 2000 },
    { ...record('b'), body: 'Remote sua b.', version: 2, updatedAt: 2000 },
    record('c'),
  ]);
  const { report, toApply, toCreateRenamed, pendingConflicts } = applySyncV21({
    base,
    local,
    remote,
    defaultStrategy: 'keep_both',
  });
  assert.deepEqual(report.appliedRemote, ['b']);
  assert.deepEqual(report.created, ['c', 'a-remote']);
  assert.equal(toApply.get('b').body, 'Remote sua b.');
  assert.equal(toCreateRenamed.get('a-remote').body, 'Remote sua a.');
  assert.equal(pendingConflicts.length, 0);
  assert.equal(report.conflicts.length, 1);
  const manual = applySyncV21({ base, local, remote, defaultStrategy: 'manual' });
  assert.equal(manual.pendingConflicts.length, 1);
  assert.deepEqual(manual.report.skipped, ['a']);
});

test('v21 sync: version vectors — equal/before/after/concurrent', () => {
  assert.equal(compareVersionVectorsV21({ a: 2 }, { a: 2 }), 'equal');
  assert.equal(compareVersionVectorsV21({ a: 1 }, { a: 2 }), 'before');
  assert.equal(compareVersionVectorsV21({ a: 3 }, { a: 2 }), 'after');
  assert.equal(compareVersionVectorsV21({ a: 2, b: 1 }, { a: 1, b: 2 }), 'concurrent');
  assert.deepEqual(bumpVersionVectorV21({ a: 2 }, 'a', 5), { a: 5 });
  assert.deepEqual(bumpVersionVectorV21({ a: 2 }, 'b', 1), { a: 2, b: 1 });
});

test('v21 tombstones: create/restore/audit/purge keeps the tombstone itself', () => {
  const store = new V21TombstoneStore();
  const rec = record('a');
  assert.equal(createTombstoneV21(rec, 'tester', 'x').ok, false);
  const created = store.create(rec, 'tester', 'khong can nua', 'okf', 'a.md');
  assert.equal(created.ok, true);
  assert.equal(created.data.previousHash.length, 64);
  assert.equal(created.data.snapshot.body, 'Body cua a.');
  assert.equal(store.create(rec, 'tester', 'lan nua').ok, false);
  assert.equal(store.getSnapshot('a').body, 'Body cua a.');
  assert.equal(store.auditFor('a').length, 1);
  assert.equal(store.auditFor('a')[0].action, 'tombstone_created');
  // Purge khi chua du tuoi: skip (deletedAt ~ now, retention 90 ngay).
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  const tooRecent = store.purgeExpiredSnapshots(90, now + 10 * dayMs);
  assert.deepEqual(tooRecent.skippedTooRecent, ['a']);
  assert.ok(store.getSnapshot('a'));
  // Purge khi qua han: snapshot mat, tombstone van con.
  const purged = store.purgeExpiredSnapshots(90, now + 100 * dayMs);
  assert.deepEqual(purged.purgedSnapshots, ['a']);
  assert.equal(store.getSnapshot('a'), undefined);
  assert.ok(store.get('a'), 'tombstone van giu lai sau purge');
  assert.equal(store.restore('a').ok, false);
  assert.equal(store.auditLog().length, 2);
  // Export/import JSON giu nguyen.
  const store2 = new V21TombstoneStore();
  store2.create(record('b'), 'tester', 'xoa b');
  const roundTripped = V21TombstoneStore.importJson(store2.exportJson());
  assert.equal(roundTripped.size(), 1);
  assert.equal(roundTripped.get('b').reason, 'xoa b');
  const restored = roundTripped.restore('b', 'tester');
  assert.equal(restored.ok, true);
  assert.equal(roundTripped.size(), 0);
});
