/**
 * Tests for memory v26 — archival + recall (v1.41, Doi T1).
 * packages/core/src/memory/v26/{archival,pipeline}.ts
 *
 * Run after building core (incremental):
 *   node node_modules/typescript/bin/tsc -p packages/core/tsconfig.json --incremental
 *   node --test tests/memory-v26-archival-recall-v141.test.mjs
 * No network. No model. Pure in-memory.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  V26ArchiveStore,
  V26Pipeline,
  V26Store,
} from '../packages/core/dist/memory/v26/index.js';

test('v26 archival: add + dayKey dung + search theo tu khoa', () => {
  const store = new V26ArchiveStore();
  const a = store.add({
    kind: 'note', content: 'Quyet dinh chot deadline 30-11 cho du an Alpha',
    at: '2026-11-17T10:00:00.000Z', tags: ['quyet-dinh'], by: 'bot-a',
  });
  assert.equal(a.ok, true);
  assert.equal(a.value.dayKey, '2026-11-17');
  store.add({ kind: 'turn', content: 'user: hom nay troi dep', at: '2026-11-17T11:00:00.000Z', by: 'bot-a' });
  store.add({ kind: 'note', content: 'Mua sam tuan sau', at: '2026-11-18T09:00:00.000Z', by: 'bot-b' });
  assert.equal(store.size, 3);
  // Search tu khoa.
  const hits = store.search({ query: 'deadline' });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].entry.kind, 'note');
  assert.ok(hits[0].score > 0.5);
  // Search theo ngay.
  const day17 = store.search({ fromDay: '2026-11-17', toDay: '2026-11-17' });
  assert.equal(day17.length, 2);
  // Search theo tag + kind.
  assert.equal(store.search({ tag: 'quyet-dinh' }).length, 1);
  assert.equal(store.search({ kind: 'turn' }).length, 1);
  // Ngay sai thi tra rong (khong throw).
  assert.deepEqual(store.search({ fromDay: '17-11-2026' }), []);
  // Content rong thi loi.
  assert.equal(store.add({ kind: 'note', content: '   ' }).ok, false);
});

test('v26 archival: archiveBlockVersion khong trung lap + archiveTurns', () => {
  const store = new V26ArchiveStore();
  // Pin "today" explicitly: archiveBlockVersion defaults to Date.now(),
  // so without nowMs this test only passed on the day it was written.
  const atDay = Date.parse('2026-11-18T08:00:00.000Z');
  const first = store.archiveBlockVersion('blk1', 'human', 1, 'gia tri v1', 'bot-a', { nowMs: atDay });
  assert.equal(first.ok, true);
  const again = store.archiveBlockVersion('blk1', 'human', 1, 'gia tri v1', 'bot-a', { nowMs: atDay });
  assert.equal(again.ok, true);
  assert.equal(again.value.id, first.value.id);
  assert.equal(store.size, 1);
  const turns = store.archiveTurns([
    { role: 'user', text: 'chao', at: '2026-11-18T08:00:00.000Z' },
    { role: 'agent', text: 'chao ban', at: '2026-11-18T08:01:00.000Z' },
    { role: 'user', text: '   ', at: '2026-11-18T08:02:00.000Z' },
  ]);
  assert.equal(turns.ok, true);
  assert.equal(turns.value.added, 2);
  assert.equal(turns.value.skipped, 1);
  assert.equal(store.countByKind().turn, 2);
  assert.deepEqual(store.daysWithEntries(), ['2026-11-18']);
});

test('v26 recall: recall theo ngay + ngay ke truoc/sau co muc', () => {
  const store = new V26ArchiveStore();
  store.add({ kind: 'turn', content: 'user: viec ngay 16', at: '2026-11-16T10:00:00.000Z' });
  store.add({ kind: 'turn', content: 'user: viec ngay 18a', at: '2026-11-18T10:00:00.000Z' });
  store.add({ kind: 'note', content: 'ghi chu ngay 18', at: '2026-11-18T11:00:00.000Z' });
  store.add({ kind: 'turn', content: 'user: viec ngay 20', at: '2026-11-20T10:00:00.000Z' });
  const day18 = store.recallDay('2026-11-18');
  assert.equal(day18.ok, true);
  assert.equal(day18.value.total, 2);
  assert.equal(day18.value.prevDayWithEntries, '2026-11-16');
  assert.equal(day18.value.nextDayWithEntries, '2026-11-20');
  assert.match(day18.value.summary, /Ngay 2026-11-18: 2 muc/);
  // Ngay khong co muc: total 0 nhung van biet ngay ke truoc/sau.
  const day17 = store.recallDay('2026-11-17');
  assert.equal(day17.ok, true);
  assert.equal(day17.value.total, 0);
  assert.equal(day17.value.prevDayWithEntries, '2026-11-16');
  assert.equal(day17.value.nextDayWithEntries, '2026-11-18');
  // Ngay sai thi loi.
  assert.equal(store.recallDay('18-11-2026').ok, false);
  assert.equal(store.recallDay('2026-13-40').ok, false);
});

test('v26 archival: prune chi xoa muc cu hon N ngay', () => {
  const store = new V26ArchiveStore();
  store.add({ kind: 'note', content: 'cu', at: '2026-01-01T00:00:00.000Z' });
  store.add({ kind: 'note', content: 'moi', at: '2026-11-18T00:00:00.000Z' });
  const nowMs = Date.parse('2026-11-18T12:00:00.000Z');
  const pruned = store.pruneOlderThan(30, nowMs);
  assert.equal(pruned.ok, true);
  assert.equal(pruned.value.pruned, 1);
  assert.equal(pruned.value.kept, 1);
  assert.equal(store.size, 1);
  assert.equal(store.pruneOlderThan(0).ok, false);
});

test('v26 pipeline: searchAll gom block hien tai + archival, ton trong quyen doc', () => {
  const pipeline = new V26Pipeline();
  const created = pipeline.createBlock({
    label: 'project-search', value: 'Du an Alpha deadline 30-11', ownerBotId: 'bot-a', kind: 'project', attachBotIds: ['bot-b'],
  });
  assert.equal(created.ok, true);
  pipeline.store.archive.add({
    kind: 'note', content: 'Hop ve deadline du an Alpha', at: '2026-11-17T10:00:00.000Z',
  });
  const hits = pipeline.searchAll({ query: 'Alpha' });
  assert.ok(hits.some((h) => h.kind === 'block' && h.label === 'project-search'));
  assert.ok(hits.some((h) => h.kind === 'archive'));
  // Bot chua attach thi khong thay block trong searchAll.
  const hidden = pipeline.searchAll({ query: 'Alpha', botId: 'bot-z' });
  assert.ok(!hidden.some((h) => h.kind === 'block'));
  assert.ok(hidden.some((h) => h.kind === 'archive'));
});

test('v26 pipeline: writeBlock luu tru version cu + tu curate khi vuot budget', () => {
  const pipeline = new V26Pipeline();
  const created = pipeline.createBlock({
    label: 'cur-auto', value: 'dong ngan', ownerBotId: 'bot-a', kind: 'task', tokenBudget: 30,
  });
  assert.equal(created.ok, true);
  const id = created.value.block.id;
  pipeline.store.budgets.setBudget({
    blockId: id, label: 'cur-auto', maxTokens: 30, warnRatio: 0.8,
    onExceed: 'curate', curateTargetTokens: 10,
  });
  const longValue = ['# Tieu de quan trong', 'Noi dung dai '.repeat(20), 'Ket luan quan trong'].join('\n');
  const written = pipeline.writeBlock(id, longValue, 'bot-a');
  assert.equal(written.ok, true, written.ok ? '' : written.error);
  // Da tu curate sau khi ghi vuot budget.
  assert.ok(written.value.curated);
  assert.equal(written.value.curated.applied, true);
  // Version cu (truoc khi ghi) da luu tru.
  const archived = pipeline.store.archive.list({ sourceBlockId: id, kind: 'block-version' });
  assert.ok(archived.length >= 1);
  assert.ok(archived.some((e) => e.content === 'dong ngan'));
});

test('v26 pipeline: resolveConflict merge-lines ghi block + audit resolved', () => {
  const pipeline = new V26Pipeline();
  const created = pipeline.createBlock({
    label: 'cf-block', value: 'dong goc', ownerBotId: 'bot-a', kind: 'project', attachBotIds: ['bot-b'],
  });
  const id = created.value.block.id;
  pipeline.writeBlock(id, 'dong cua bot-a', 'bot-a', { expectedVersion: 1 });
  const conflicted = pipeline.writeBlock(id, 'dong cua bot-b', 'bot-b', {
    expectedVersion: 1, baseValue: 'dong goc',
  });
  assert.equal(conflicted.ok, false);
  const conflictId = conflicted.error.split(':')[1];
  const resolved = pipeline.resolveConflict(conflictId, 'merge-lines', 'bot-a');
  assert.equal(resolved.ok, true, resolved.ok ? '' : resolved.error);
  assert.ok(resolved.value.block.value.includes('dong cua bot-a'));
  assert.ok(resolved.value.block.value.includes('dong cua bot-b'));
  assert.equal(resolved.value.conflict.status, 'resolved');
  assert.equal(pipeline.store.registry.listAudit({ action: 'resolved' }).length, 1);
  assert.equal(pipeline.store.registry.getEntry(id).hasOpenConflict, false);
});

test('v26 pipeline: snapshotForPrompt chi render block bot duoc doc, trong budget', () => {
  const pipeline = new V26Pipeline();
  pipeline.createBlock({ label: 'human', value: 'h'.repeat(100), ownerBotId: 'bot-a', kind: 'human', attachBotIds: ['bot-b'] });
  pipeline.createBlock({ label: 'secret', value: 's'.repeat(100), ownerBotId: 'bot-a', kind: 'custom' });
  const snap = pipeline.snapshotForPrompt('bot-b', 100);
  assert.equal(snap.blocksRendered, 1);
  assert.equal(snap.blocks[0].label, 'human');
  assert.ok(!snap.text.includes('secret'));
  // Owner thay ca 2 block; botId rong (khong phai bot nao) thi khong thay block nao.
  const owner = pipeline.snapshotForPrompt('bot-a', 100);
  assert.equal(owner.blocksRendered, 2);
  assert.equal(pipeline.snapshotForPrompt('', 100).blocksRendered, 0);
});
