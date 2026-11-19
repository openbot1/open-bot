/**
 * Tests for memory v27 — extraction + bi-temporal graph (v1.42, Doi T3).
 * packages/core/src/memory/v27/{extraction,graph}.ts
 *
 * Run after building core:
 *   node node_modules/typescript/bin/tsc -p packages/core/tsconfig.json --incremental
 *   node --test tests/memory-v27-extraction-graph-v142.test.mjs
 * No network. No model. Pure in-memory stores.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  V27Graph,
  extractTextV27,
  splitSentencesV27,
} from '../packages/core/dist/memory/v27/index.js';

const T0 = Date.parse('2026-11-19T00:00:00.000Z');
const T1 = T0 + 60_000;
const T2 = T0 + 120_000;

function candidate(subject, predicate, object, sentence = '') {
  return {
    subject,
    predicate,
    object,
    confidence: 0.9,
    sourceSentence: sentence || `${subject} ${predicate} ${object}`,
    entityIds: [],
    pattern: 'test',
    supersedesId: '',
    supersedeReason: '',
  };
}

test('v27 extraction: single-pass — 1 cau chi sinh toi da 1 candidate, pattern manh truoc', () => {
  const r = extractTextV27('Huy likes coffee. Huy lives in Saigon. The weather is nice today.');
  assert.equal(r.sentencesScanned, 3);
  assert.equal(r.candidates.length, 3);
  assert.equal(r.candidates[0].subject, 'Huy');
  assert.equal(r.candidates[0].predicate, 'likes');
  assert.equal(r.candidates[0].object, 'coffee');
  assert.equal(r.candidates[0].pattern, 'likes');
  assert.equal(r.candidates[1].predicate, 'lives_in');
  assert.equal(r.candidates[1].object, 'Saigon');
  // Cau khong co pattern nao thi dem vao sentencesWithNoFact.
  const r2 = extractTextV27('Hello world');
  assert.equal(r2.candidates.length, 0);
  assert.equal(r2.sentencesWithNoFact, 1);
});

test('v27 extraction: tieng Viet + my-name-is + dedup trong pass', () => {
  const r = extractTextV27('Huy thích cà phê. Huy thích cà phê. Tên tôi là Huy.');
  assert.equal(r.candidates.length, 2);
  assert.equal(r.duplicates, 1);
  const name = r.candidates.find((c) => c.predicate === 'name');
  assert.ok(name);
  assert.equal(name.subject, 'user');
  assert.equal(name.object, 'Huy');
});

test('v27 extraction: splitSentences cat cau qua dai, khong mat cau ngan', () => {
  const s = splitSentencesV27('Huy likes coffee. Huy likes tea! Huy likes milk?', 2000);
  assert.deepEqual(s, ['Huy likes coffee', 'Huy likes tea', 'Huy likes milk']);
});

test('v27 graph: add-only — them trung thi tra edge cu, khong them moi', () => {
  const g = new V27Graph();
  const first = g.addFact(candidate('Huy', 'likes', 'coffee'), { nowMs: T0 });
  assert.equal(first.ok, true);
  assert.equal(first.value.added, true);
  assert.equal(g.size, 1);
  const second = g.addFact(candidate('Huy', 'likes', 'coffee'), { nowMs: T1 });
  assert.equal(second.ok, true);
  assert.equal(second.value.added, false);
  assert.equal(second.value.duplicateOf, first.value.edge.id);
  assert.equal(g.size, 1);
});

test('v27 graph: fact doi -> ADD moi + DONG edge cu (supersede), lich su con nguyen', () => {
  const g = new V27Graph();
  const old = g.addFact(candidate('Huy', 'likes', 'coffee'), { nowMs: T0 });
  assert.equal(old.value.added, true);
  const next = g.addFact(candidate('Huy', 'likes', 'tea'), { nowMs: T1 });
  assert.equal(next.value.added, true);
  assert.equal(next.value.closed.length, 1);
  assert.equal(next.value.closed[0].id, old.value.edge.id);
  assert.equal(next.value.closed[0].status, 'superseded');
  assert.ok(next.value.closed[0].invalidAt !== null);
  assert.ok(next.value.closed[0].expiredAt !== null);
  // Edge cu van doc duoc (khong bi xoa vat ly).
  const oldFact = g.get(old.value.edge.id);
  assert.ok(oldFact);
  assert.equal(oldFact.status, 'superseded');
  assert.equal(oldFact.supersededById, next.value.edge.id);
  // Chi con 1 fact active cho cap (Huy, likes).
  assert.equal(g.queryCurrent({ subject: 'Huy', predicate: 'likes' }).length, 1);
  assert.equal(g.queryCurrent({ subject: 'Huy', predicate: 'likes' })[0].object, 'tea');
  // Lich su day du: cu -> moi theo thu tu thoi gian.
  const history = g.historyFor('Huy', 'likes');
  assert.equal(history.length, 2);
  assert.equal(history[0].object, 'coffee');
  assert.equal(history[1].object, 'tea');
});

test('v27 graph: time-travel chat — fact dung tai X (valid + transaction time)', () => {
  const g = new V27Graph();
  g.addFact(candidate('Huy', 'likes', 'coffee'), { nowMs: T0 });
  g.addFact(candidate('Huy', 'likes', 'tea'), { nowMs: T1 });
  // Tai T0+30s: chi coffee dung (tea chua duoc biet).
  const atT0 = g.queryAt(new Date(T0 + 30_000).toISOString());
  assert.equal(atT0.ok, true);
  assert.equal(atT0.value.length, 1);
  assert.equal(atT0.value[0].object, 'coffee');
  // Tai T2: chi tea dung (coffee da dong invalid_at=T1).
  const atT2 = g.queryAt(new Date(T2).toISOString());
  assert.equal(atT2.ok, true);
  assert.equal(atT2.value.length, 1);
  assert.equal(atT2.value[0].object, 'tea');
  // Truoc khi biet fact nao: rong.
  const before = g.queryAt(new Date(T0 - 1000).toISOString());
  assert.equal(before.ok, true);
  assert.equal(before.value.length, 0);
  // asOf khong hop le thi loi (khong throw).
  const bad = g.queryAt('khong-phai-ngay');
  assert.equal(bad.ok, false);
});

test('v27 graph: queryValidAt vs queryAt — fact nhap tre van dung ve valid time', () => {
  const g = new V27Graph();
  // Fact co validAt tu T0 nhung chi duoc he thong biet tai T1.
  g.addFact(candidate('Huy', 'lives_in', 'Saigon'), { nowMs: T1, validAt: new Date(T0).toISOString() });
  const mid = new Date(T0 + 30_000).toISOString();
  // queryValidAt (chi valid time): thay fact.
  assert.equal(g.queryValidAt(mid).value.length, 1);
  // queryAt chat (valid + transaction): chua biet tai mid -> khong thay.
  assert.equal(g.queryAt(mid).value.length, 0);
  // queryKnownAt: cung khong thay tai mid.
  assert.equal(g.queryKnownAt(mid).value.length, 0);
  assert.equal(g.queryKnownAt(new Date(T2).toISOString()).value.length, 1);
});

test('v27 graph: neighbors + twoHop + findPath', () => {
  const g = new V27Graph();
  g.addFact(candidate('Huy', 'likes', 'coffee'), { nowMs: T0 });
  g.addFact(candidate('Huy', 'works_at', 'xAI'), { nowMs: T0 });
  g.addFact(candidate('xAI', 'is', 'company'), { nowMs: T0 });
  g.addFact(candidate('Lan', 'likes', 'tea'), { nowMs: T0 });
  const huyLikes = g.queryCurrent({ subject: 'Huy', predicate: 'likes' })[0];
  const neighbors = g.neighbors(huyLikes.id);
  // Ke: Huy works_at xAI (chung subject Huy); khong co Lan likes tea.
  assert.equal(neighbors.some((f) => f.predicate === 'works_at'), true);
  assert.equal(neighbors.some((f) => f.subject === 'Lan'), false);
  const { hop1, hop2 } = g.twoHop(huyLikes.id);
  assert.ok(hop1.length >= 1);
  // Hop 2: xAI is company (ke cua Huy works_at xAI).
  assert.equal(hop2.some((f) => f.subject === 'xAI'), true);
  // Duong Huy -> xAI: 1 hop qua works_at.
  const path = g.findPath('Huy', 'xAI');
  assert.equal(path.length, 1);
  assert.equal(path[0].predicate, 'works_at');
  // Khong noi duoc Huy -> Lan.
  assert.deepEqual(g.findPath('Huy', 'Lan'), []);
});

test('v27 graph: validate + counts + close/expire khong xoa', () => {
  const g = new V27Graph();
  const added = g.addFact(candidate('Huy', 'likes', 'coffee'), { nowMs: T0 });
  assert.deepEqual(g.countByStatus(), { active: 1, superseded: 0, expired: 0 });
  assert.deepEqual(g.validate(), []);
  const expired = g.expireFact(added.value.edge.id, { nowMs: T1, reason: 'het han' });
  assert.equal(expired.ok, true);
  assert.equal(expired.value.status, 'expired');
  // Van doc duoc sau khi expire.
  assert.ok(g.get(added.value.edge.id));
  assert.equal(g.queryCurrent().length, 0);
  // Dong edge da dong thi loi (khong crash).
  const again = g.closeFact(added.value.edge.id, { nowMs: T2 });
  assert.equal(again.ok, false);
  // Fact rong thi tu choi.
  const bad = g.addFact(candidate('', 'likes', 'coffee'), { nowMs: T2 });
  assert.equal(bad.ok, false);
  assert.equal(g.size, 1);
});

test('v27 graph: toJSON/fromJSON giu nguyen edge + meta', () => {
  const g = new V27Graph();
  const added = g.addFact(
    { ...candidate('Huy', 'likes', 'coffee'), entityIds: ['ent_1'] },
    { nowMs: T0, episodeText: 'Huy likes coffee.' },
  );
  const json = g.toJSON();
  const restored = V27Graph.fromJSON(json);
  assert.equal(restored.size, 1);
  const fact = restored.get(added.value.edge.id);
  assert.ok(fact);
  assert.equal(fact.object, 'coffee');
  assert.deepEqual(fact.entityIds, ['ent_1']);
});
