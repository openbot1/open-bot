/**
 * Tests for memory v22 — dreaming core: store / dedupe / supersede /
 * expiry / patterns (v1.37, Doi T1).
 * packages/core/src/memory/v22/{store,dedupe,supersede,expiry,patterns}.ts
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/memory-v22-dream-core-v137.test.mjs
 * No network. No model.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  V22DreamStore,
  applyDedupeV22,
  applyExpiryV22,
  applyPatternsV22,
  applySupersedeV22,
  countPotentialDuplicatesV22,
  dreamFactSimilarityV22,
  expiryStatsV22,
  findContradictionGroupsV22,
  findPatternGroupsV22,
  groupDuplicateFactsV22,
  isFactExpiredV22,
  jaccardSimilarityV22,
  listExpiringSoonV22,
  normalizeDreamTextV22,
  normalizeTopicV22,
  patternKeyOfFactV22,
  rollbackSupersededV22,
  supersedeHistoryV22,
} from '../packages/core/dist/memory/v22/index.js';

const NOW = 1794000000000; // 2026-11-18 (co dinh de test xac dinh)
const DAY = 86_400_000;

function freshStore() {
  return new V22DreamStore();
}

function add(store, text, extra = {}) {
  const res = store.addFact({ text, ...extra }, NOW);
  assert.ok(res.ok, `addFact that bai: ${res.error}`);
  return res.data;
}

// --- store ---------------------------------------------------------------

test('v22 store: them fact hop le + chuan hoa topic/value', () => {
  const store = freshStore();
  const fact = add(store, 'User thich ca phe den.', {
    topic: 'User | Thích Uống',
    value: 'Cà-Phê Đen',
    confidence: 0.9,
    sources: ['chat:s1'],
    tags: ['ca-phe'],
    sessionIds: ['s1'],
  });
  assert.ok(fact.id.startsWith('dream-fact-'));
  assert.equal(fact.topic, 'user|thich_uong');
  assert.equal(fact.value, 'ca-phe-den');
  assert.equal(fact.status, 'active');
  assert.equal(fact.version, 1);
  assert.equal(store.size(), 1);
  assert.equal(store.activeCount(), 1);
});

test('v22 store: tu choi text rong / confidence sai / han nguoc', () => {
  const store = freshStore();
  assert.equal(store.addFact({ text: 'ab' }, NOW).errorCode, 'invalid_text');
  assert.equal(store.addFact({ text: 'x'.repeat(2001) }, NOW).errorCode, 'invalid_text');
  assert.equal(store.addFact({ text: 'Hop le roi.', confidence: 1.5 }, NOW).errorCode, 'invalid_confidence');
  assert.equal(store.addFact({ text: 'Hop le roi.', topic: '   ' }, NOW).errorCode, 'invalid_topic');
  assert.equal(
    store.addFact({ text: 'Co han.', validFrom: NOW + DAY, validUntil: NOW }, NOW).errorCode,
    'invalid_input',
  );
  assert.equal(store.size(), 0);
});

test('v22 store: loc theo status/kind/topic/tag + export/import giu nguyen', () => {
  const store = freshStore();
  add(store, 'User thich ca phe.', { kind: 'preference', topic: 'user|thich_uong', tags: ['ca-phe'] });
  add(store, 'User dang o Ha Noi.', { kind: 'fact', topic: 'user|dia_diem', sessionIds: ['s9'] });
  add(store, 'Ghi chu tam.', { kind: 'note' });
  assert.equal(store.list({ kind: 'preference' }).length, 1);
  assert.equal(store.list({ topic: 'user|thich_uong' }).length, 1);
  assert.equal(store.list({ tag: 'ca-phe' }).length, 1);
  assert.equal(store.list({ sessionId: 's9' }).length, 1);
  assert.equal(store.list({ minConfidence: 0.9 }).length, 0);
  const state = store.exportState();
  const copy = freshStore();
  const res = copy.importState(state);
  assert.equal(res.imported, 3);
  assert.equal(res.skipped, 0);
  assert.equal(copy.size(), 3);
  assert.deepEqual(copy.countByStatus(), { active: 3, superseded: 0, expired: 0, merged: 0, invalidated: 0 });
});

// --- dedupe --------------------------------------------------------------

test('v22 dedupe: Jaccard + gop fact trung, keeper thua huong nguon/session', () => {
  assert.equal(jaccardSimilarityV22(['a', 'b'], ['a', 'b']), 1);
  assert.equal(jaccardSimilarityV22(['a'], ['b']), 0);
  assert.equal(normalizeDreamTextV22('User Thích Cà-Phê!'), 'user thich ca phe');
  const store = freshStore();
  const keeper = add(store, 'User thich ca phe den moi sang.', { confidence: 0.9, sources: ['chat:s1'], sessionIds: ['s1'] });
  const dup = add(store, 'User thich ca phe den moi sang khong duong.', { confidence: 0.7, sources: ['chat:s2'], sessionIds: ['s2'] });
  add(store, 'Troi hom nay mua to o Ha Noi.', { confidence: 0.8 });
  assert.ok(dreamFactSimilarityV22(keeper, dup) >= 0.6);
  assert.equal(countPotentialDuplicatesV22(store.list()), 1);
  const res = applyDedupeV22(store, { now: NOW });
  assert.equal(res.mergedCount, 1);
  assert.equal(res.changes.length, 1);
  assert.equal(res.changes[0].kind, 'merge');
  assert.deepEqual(res.changes[0].factIdsAfter, [keeper.id]);
  assert.ok(res.changes[0].factIdsBefore.includes(dup.id));
  assert.match(res.changes[0].reason, /Jaccard/);
  const merged = store.get(dup.id);
  assert.equal(merged.status, 'merged');
  assert.equal(merged.mergedInto, keeper.id);
  const kept = store.get(keeper.id);
  assert.deepEqual(kept.sessionIds.sort(), ['s1', 's2']);
  assert.ok(kept.sources.includes('chat:s2'));
  assert.equal(kept.version, 2);
  assert.equal(store.activeCount(), 2);
});

test('v22 dedupe: nhom co so khac nhau thi KHONG tu gop (can xem lai)', () => {
  const store = freshStore();
  add(store, 'Hop voi An luc 9h sang.', { confidence: 0.9 });
  add(store, 'Hop voi An luc 10h sang.', { confidence: 0.85 });
  const groups = groupDuplicateFactsV22(store.list());
  assert.equal(groups.length, 1);
  assert.equal(groups[0].needsReview, true);
  assert.match(groups[0].reviewReason, /so khac nhau/);
  const res = applyDedupeV22(store, { now: NOW });
  assert.equal(res.mergedCount, 0);
  assert.equal(res.needsReviewCount, 1);
  assert.equal(res.skipped.length, 1);
  assert.equal(store.activeCount(), 2);
});

// --- supersede -----------------------------------------------------------

test('v22 supersede: fact manh hon thang, fact cu giu lich su', () => {
  const store = freshStore();
  const oldFact = add(store, 'User thich uong tra dao.', {
    topic: 'user|thich_uong', value: 'tra-dao', confidence: 0.6,
  });
  const newFact = add(store, 'User thich uong ca phe den.', {
    topic: 'user|thich_uong', value: 'ca-phe-den', confidence: 0.9,
  });
  const groups = findContradictionGroupsV22(store.list());
  assert.equal(groups.length, 1);
  assert.equal(groups[0].topic, 'user|thich_uong');
  assert.equal(groups[0].winner.id, newFact.id);
  assert.equal(groups[0].needsReview, false);
  const res = applySupersedeV22(store, { now: NOW });
  assert.equal(res.supersededCount, 1);
  assert.equal(res.changes.length, 1);
  assert.equal(res.changes[0].kind, 'supersede');
  assert.match(res.changes[0].reason, /thang va thay the/);
  const loser = store.get(oldFact.id);
  assert.equal(loser.status, 'superseded');
  assert.equal(loser.supersededBy, newFact.id);
  const winner = store.get(newFact.id);
  assert.deepEqual(winner.supersedes, [oldFact.id]);
  assert.equal(store.activeCount(), 1);
});

test('v22 supersede: chenh confidence qua nho thi can xem lai, khong tu thay', () => {
  const store = freshStore();
  add(store, 'User o Ha Noi.', { topic: 'user|dia_diem', value: 'ha-noi', confidence: 0.62 });
  add(store, 'User o Da Nang.', { topic: 'user|dia_diem', value: 'da-nang', confidence: 0.6 });
  const res = applySupersedeV22(store, { now: NOW });
  assert.equal(res.supersededCount, 0);
  assert.equal(res.needsReviewCount, 1);
  assert.equal(res.skipped.length, 1);
  assert.equal(store.activeCount(), 2);
  // Ep buoc (force) thi thay the va ghi ro.
  const forced = applySupersedeV22(store, { now: NOW, force: true });
  assert.equal(forced.supersededCount, 1);
  assert.match(forced.changes[0].reason, /ep buoc/);
});

test('v22 supersede: lich su thay the + rollback tao phien ban moi', () => {
  const store = freshStore();
  const oldFact = add(store, 'User thich uong tra dao.', {
    topic: 'user|thich_uong', value: 'tra-dao', confidence: 0.6,
  });
  const newFact = add(store, 'User thich uong ca phe den.', {
    topic: 'user|thich_uong', value: 'ca-phe-den', confidence: 0.9,
  });
  applySupersedeV22(store, { now: NOW });
  const history = supersedeHistoryV22(store, newFact.id);
  assert.equal(history.length, 2);
  assert.equal(history[0].factId, oldFact.id);
  assert.equal(history[0].version, 1);
  assert.equal(history[1].factId, newFact.id);
  assert.equal(history[1].isCurrent, true);
  assert.equal(history[1].supersedes[0], oldFact.id);
  const rolled = rollbackSupersededV22(store, newFact.id, { now: NOW + 1000 });
  assert.equal(rolled.ok, true);
  assert.match(rolled.newFact.text, /tra dao/);
  assert.equal(store.get(newFact.id).status, 'superseded');
  assert.equal(store.get(newFact.id).supersededBy, rolled.newFact.id);
  // Lich su van con, rollback la mot buoc moi (khong viet lai lich su).
  assert.equal(supersedeHistoryV22(store, rolled.newFact.id).length, 3);
});

// --- expiry --------------------------------------------------------------

test('v22 expiry: fact qua validUntil thi expired (khong xoa); chua toi validFrom thi bo qua', () => {
  const store = freshStore();
  const old = add(store, 'User dang o Ha Noi den 20/11.', { validUntil: NOW - DAY });
  const future = add(store, 'User se o Da Lat tu 01/12.', { validFrom: NOW + 10 * DAY });
  const alive = add(store, 'User thich ca phe.', { validUntil: NOW + 30 * DAY });
  assert.equal(isFactExpiredV22(old, NOW), true);
  assert.equal(isFactExpiredV22(alive, NOW), false);
  const res = applyExpiryV22(store, { now: NOW });
  assert.equal(res.expired.length, 1);
  assert.equal(res.expired[0].id, old.id);
  assert.equal(res.notYetValid.length, 1);
  assert.equal(res.notYetValid[0].id, future.id);
  assert.equal(res.changes[0].kind, 'expire');
  assert.match(res.changes[0].reason, /het han/);
  assert.equal(store.get(old.id).status, 'expired');
  assert.equal(store.get(future.id).status, 'active');
  assert.equal(store.get(alive.id).status, 'active');
  const stats = expiryStatsV22(store, NOW);
  assert.equal(stats.expired, 1);
  assert.equal(stats.notYetValid, 1);
  assert.equal(stats.withDeadline, 1);
});

test('v22 expiry: listExpiringSoon bao truoc fact sap het han trong 7 ngay', () => {
  const store = freshStore();
  const soon = add(store, 'Hop dong het han sap toi.', { validUntil: NOW + 3 * DAY });
  add(store, 'Hop dong dai han.', { validUntil: NOW + 90 * DAY });
  add(store, 'Khong co han.', {});
  const list = listExpiringSoonV22(store, { now: NOW });
  assert.equal(list.length, 1);
  assert.equal(list[0].id, soon.id);
});

// --- patterns ------------------------------------------------------------

test('v22 patterns: lap text o 3 session -> pattern fact (confidence boost)', () => {
  const store = freshStore();
  for (const s of ['s1', 's2', 's3']) {
    add(store, 'User uong ca phe den moi sang.', { confidence: 0.8, sessionIds: [s] });
  }
  const groups = findPatternGroupsV22(store);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].mechanism, 'repeat_text');
  assert.equal(groups[0].observations, 3);
  assert.equal(groups[0].sessions, 3);
  assert.equal(groups[0].confidence, 0.9); // 0.8 + 0.05 * (3-1)
  const res = applyPatternsV22(store, { now: NOW });
  assert.equal(res.created.length, 1);
  assert.equal(res.created[0].kind, 'pattern');
  assert.match(res.created[0].text, /^Pattern \(3 quan sat, 3 session\): User uong ca phe den moi sang\./);
  assert.equal(res.created[0].confidence, 0.9);
  assert.ok(patternKeyOfFactV22(res.created[0]).startsWith('text:'));
  assert.deepEqual(res.created[0].sessionIds, ['s1', 's2', 's3']);
  // Fact goc van active de truy vet.
  assert.equal(store.list({ status: 'active', kind: 'fact' }).length, 3);
});

test('v22 patterns: lap topic+value bang dien dat khac nhau -> pattern; chay lai thi cap nhat, khong tao trung', () => {
  const store = freshStore();
  add(store, 'User goi ca phe den buoi sang.', { topic: 'user|thich_uong', value: 'ca-phe-den', confidence: 0.7, sessionIds: ['s1'] });
  add(store, 'Sang nao user cung uong ca phe den.', { topic: 'user|thich_uong', value: 'ca-phe-den', confidence: 0.75, sessionIds: ['s2'] });
  add(store, 'User bao ca phe den la mon ruot.', { topic: 'user|thich_uong', value: 'ca-phe-den', confidence: 0.7, sessionIds: ['s3'] });
  const res1 = applyPatternsV22(store, { now: NOW });
  assert.equal(res1.created.length, 1);
  assert.equal(res1.groups[0].mechanism, 'repeat_topic_value');
  const patternId = res1.created[0].id;
  const version1 = res1.created[0].version;
  // Them 1 quan sat nua (session s4) roi chay lai: pattern cu duoc cap nhat.
  add(store, 'User lai goi ca phe den.', { topic: 'user|thich_uong', value: 'ca-phe-den', confidence: 0.7, sessionIds: ['s4'] });
  const res2 = applyPatternsV22(store, { now: NOW + 1000 });
  assert.equal(res2.created.length, 0);
  assert.equal(res2.updated.length, 1);
  assert.equal(res2.updated[0].id, patternId);
  assert.ok(res2.updated[0].version > version1);
  assert.match(res2.updated[0].text, /4 quan sat, 4 session/);
  assert.equal(store.list({ kind: 'pattern' }).length, 1);
});

test('v22 patterns: chua du session/quan sat thi khong tong hop', () => {
  const store = freshStore();
  add(store, 'User thich tra sua.', { confidence: 0.8, sessionIds: ['s1'] });
  add(store, 'User thich tra sua.', { confidence: 0.8, sessionIds: ['s1'] });
  const res = applyPatternsV22(store, { now: NOW });
  assert.equal(res.created.length, 0);
  assert.equal(res.groups.length, 0);
});
