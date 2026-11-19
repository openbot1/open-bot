/**
 * Tests for memory v25 — bi-temporal fact edges (v1.40, Doi T1).
 * packages/core/src/memory/v25/factEdges.ts (+ types.ts)
 *
 * Run after building core (memory/v25 only):
 *   node node_modules/typescript/bin/tsc -p packages/core/tsconfig.json --incremental
 *   node --test tests/memory-v25-facts-v140.test.mjs
 * No network. No model.
 *
 * NOTE: chi import dist/memory/v25/index.js (scoped) — khong import
 * dist/index.js vi build full core nang; coordinator kiem tra o luc gop.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  V25FactEdgeStore,
  edgeIsCurrentV25,
  edgeKnownAtV25,
  edgeValidAtV25,
} from '../packages/core/dist/memory/v25/index.js';

function freshStore() {
  return new V25FactEdgeStore();
}

test('v25 facts: add tao edge voi 4 moc thoi gian, status active', () => {
  const store = freshStore();
  const res = store.add({
    subject: 'Huy',
    predicate: 'is',
    object: 'engineer',
    validAt: '2026-01-01T00:00:00.000Z',
    episodeId: 'turn:1',
    sourceText: 'Huy is an engineer.',
  });
  assert.equal(res.ok, true);
  const edge = res.value;
  assert.equal(edge.status, 'active');
  assert.equal(edge.validAt, '2026-01-01T00:00:00.000Z');
  assert.equal(edge.invalidAt, null);
  assert.equal(edge.expiredAt, null);
  assert.ok(edge.createdAt.length > 0);
  assert.equal(edge.history.length, 1);
  assert.equal(edge.history[0].kind, 'created');
  assert.equal(edgeIsCurrentV25(edge), true);
});

test('v25 facts: add tu choi input rong / validAt tuong lai / validAt sai', () => {
  const store = freshStore();
  assert.equal(store.add({ subject: '', predicate: 'is', object: 'x' }).ok, false);
  assert.equal(store.add({ subject: 'A', predicate: '', object: 'x' }).ok, false);
  assert.equal(store.add({ subject: 'A', predicate: 'is', object: '' }).ok, false);
  assert.equal(store.add({ subject: 'A', predicate: 'is', object: 'x', validAt: 'not-a-date' }).ok, false);
  assert.equal(
    store.add({ subject: 'A', predicate: 'is', object: 'x', validAt: '2999-01-01T00:00:00.000Z' }).ok,
    false,
  );
});

test('v25 facts: supersede dong cua so fact cu, khong xoa vat ly', () => {
  const store = freshStore();
  const old = store.add({ subject: 'Huy', predicate: 'is', object: 'engineer' });
  assert.equal(old.ok, true);
  const res = store.addSuperseding({ subject: 'Huy', predicate: 'is', object: 'manager' });
  assert.equal(res.ok, true);
  assert.equal(res.value.closed.length, 1);
  assert.equal(res.value.closed[0].id, old.value.id);
  assert.equal(res.value.edge.supersedesId, old.value.id);
  // Fact cu van lay duoc — chi dong hieu luc.
  const closedEdge = store.get(old.value.id);
  assert.ok(closedEdge);
  assert.equal(closedEdge.status, 'superseded');
  assert.ok(closedEdge.invalidAt);
  assert.ok(closedEdge.expiredAt);
  assert.equal(closedEdge.supersededById, res.value.edge.id);
  assert.equal(closedEdge.history.length, 2);
  assert.equal(closedEdge.history[1].kind, 'superseded');
  // Fact moi hien tai.
  assert.equal(store.queryCurrent().length, 1);
  assert.equal(store.queryCurrent()[0].id, res.value.edge.id);
  assert.equal(store.countByStatus().superseded, 1);
  assert.equal(store.countByStatus().active, 1);
});

test('v25 facts: closeEdge 2 lan loi; close edge khong co loi', () => {
  const store = freshStore();
  const added = store.add({ subject: 'A', predicate: 'is', object: 'x' });
  assert.equal(added.ok, true);
  assert.equal(store.closeEdge(added.value.id, { reason: 'test close' }).ok, true);
  assert.equal(store.closeEdge(added.value.id).ok, false);
  assert.equal(store.closeEdge('edge_khong-co').ok, false);
});

test('v25 facts: queryAt — fact dung tai X, khong dung truoc/sau cua so', () => {
  const store = freshStore();
  const added = store.add({
    subject: 'Huy',
    predicate: 'works_as',
    object: 'engineer',
    validAt: '2026-01-01T00:00:00.000Z',
  });
  assert.equal(added.ok, true);
  // Truoc validAt: khong dung.
  assert.equal(store.queryAt('2025-06-01T00:00:00.000Z').value.length, 0);
  // Trong cua so: dung.
  assert.equal(store.queryAt('2026-06-01T00:00:00.000Z').value.length, 1);
  // Dong edge (invalidAt = now ~2026-11) roi hoi lai diem sau khi dong.
  store.closeEdge(added.value.id, { nowMs: Date.parse('2026-11-01T00:00:00.000Z') });
  assert.equal(store.queryAt('2026-12-01T00:00:00.000Z').value.length, 0);
  // Nhung tai diem giua validAt va invalidAt van dung (lich su con).
  assert.equal(store.queryAt('2026-06-01T00:00:00.000Z').value.length, 1);
  // queryAt sai dinh dang tra loi.
  assert.equal(store.queryAt('khong-phai-ngay').ok, false);
});

test('v25 facts: transaction time luu rieng — edgeKnownAtV25 (audit)', () => {
  const store = freshStore();
  const added = store.add({
    subject: 'Huy',
    predicate: 'is',
    object: 'engineer',
    validAt: '2020-01-01T00:00:00.000Z',
  });
  assert.equal(added.ok, true);
  const edge = added.value;
  // Valid window chua 2021, nhung he thong chi biet fact tu createdAt
  // (~now 2026-11) — queryAt van tra ve (loc theo valid time),
  // con edgeKnownAtV25 phan biet duoc "he thong chua biet luc do".
  assert.equal(store.queryAt('2021-01-01T00:00:00.000Z').value.length, 1);
  assert.equal(edgeKnownAtV25(edge, Date.parse('2021-01-01T00:00:00.000Z')), false);
  assert.equal(edgeKnownAtV25(edge, Date.parse(edge.createdAt) + 1000), true);
});

test('v25 facts: queryCurrent chi tra cua so mo; expireEdge doi status', () => {
  const store = freshStore();
  const a = store.add({ subject: 'A', predicate: 'is', object: 'x' });
  const b = store.add({ subject: 'B', predicate: 'is', object: 'y' });
  assert.equal(a.ok && b.ok, true);
  assert.equal(store.queryCurrent().length, 2);
  assert.equal(store.expireEdge(b.value.id, { reason: 'het han' }).ok, true);
  assert.equal(store.get(b.value.id).status, 'expired');
  assert.equal(store.queryCurrent().length, 1);
  assert.equal(store.queryCurrent()[0].id, a.value.id);
  // Expire 2 lan loi.
  assert.equal(store.expireEdge(b.value.id).ok, false);
});

test('v25 facts: activeFor + list loc theo subject/predicate/status', () => {
  const store = freshStore();
  store.add({ subject: 'Huy', predicate: 'is', object: 'engineer' });
  store.add({ subject: 'Huy', predicate: 'likes', object: 'coffee' });
  store.add({ subject: 'Lan', predicate: 'is', object: 'designer' });
  assert.equal(store.activeFor('Huy', 'is').length, 1);
  assert.equal(store.list({ subject: 'Huy' }).length, 2);
  assert.equal(store.list({ predicate: 'is' }).length, 2);
  assert.equal(store.list({ status: 'active' }).length, 3);
  assert.equal(store.list({ status: 'superseded' }).length, 0);
  assert.equal(store.list({ limit: 2 }).length, 2);
});

test('v25 facts: history + validate cua so', () => {
  const store = freshStore();
  const added = store.add({ subject: 'A', predicate: 'is', object: 'x' });
  assert.equal(added.ok, true);
  const history = store.history(added.value.id);
  assert.equal(history.ok, true);
  assert.equal(history.value.length, 1);
  assert.equal(store.history('edge_khong-co').ok, false);
  assert.deepEqual(store.validate(), []);
});

test('v25 facts: edgeValidAt / edgeKnownAt bien dung', () => {
  const store = freshStore();
  const added = store.add({
    subject: 'A',
    predicate: 'is',
    object: 'x',
    validAt: '2026-01-01T00:00:00.000Z',
  });
  const edge = added.value;
  assert.equal(edgeValidAtV25(edge, Date.parse('2026-06-01T00:00:00.000Z')), true);
  assert.equal(edgeValidAtV25(edge, Date.parse('2025-06-01T00:00:00.000Z')), false);
  assert.equal(edgeKnownAtV25(edge, Date.parse(edge.createdAt) + 1000), true);
  assert.equal(edgeKnownAtV25(edge, Date.parse(edge.createdAt) - 1000), false);
});

test('v25 facts: toJSON/fromJSON giu nguyen ca edge da dong', () => {
  const store = freshStore();
  const old = store.add({ subject: 'Huy', predicate: 'is', object: 'engineer' });
  store.addSuperseding({ subject: 'Huy', predicate: 'is', object: 'manager' });
  const restored = V25FactEdgeStore.fromJSON(store.toJSON());
  assert.equal(restored.size, 2);
  assert.equal(restored.get(old.value.id).status, 'superseded');
  assert.equal(restored.queryCurrent().length, 1);
  assert.deepEqual(V25FactEdgeStore.fromJSON(null).size, 0);
  assert.deepEqual(V25FactEdgeStore.fromJSON('khong-phai-array').size, 0);
});
