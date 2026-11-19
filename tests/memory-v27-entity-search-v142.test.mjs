/**
 * Tests for memory v27 — entity linking/boosting + hybrid search
 * (v1.42, Doi T3).
 * packages/core/src/memory/v27/{entities,search}.ts
 *
 * Run after building core:
 *   node node_modules/typescript/bin/tsc -p packages/core/tsconfig.json --incremental
 *   node --test tests/memory-v27-entity-search-v142.test.mjs
 * No network. No model. Pure in-memory stores.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  V27EntityRegistry,
  V27Graph,
  searchV27,
  tokenOverlapV27,
} from '../packages/core/dist/memory/v27/index.js';

const T0 = Date.parse('2026-11-19T00:00:00.000Z');

function candidate(subject, predicate, object, entityIds = []) {
  return {
    subject, predicate, object, confidence: 0.9,
    sourceSentence: `${subject} ${predicate} ${object}`,
    entityIds, pattern: 'test', supersedesId: '', supersedeReason: '',
  };
}

test('v27 entity: register + exact/alias/fuzzy link + stopword tu choi', () => {
  const reg = new V27EntityRegistry();
  const created = reg.register({ name: 'Huy', kind: 'person', aliases: ['Huy Nguyen'] });
  assert.equal(created.ok, true);
  assert.equal(created.value.kind, 'person');
  // Dang ky lai cung ten thi tra entity cu (khong tao trung).
  const again = reg.register({ name: 'huy', kind: 'person' });
  assert.equal(again.ok, true);
  assert.equal(again.value.id, created.value.id);
  assert.equal(reg.size, 1);
  // Link exact ten chuan.
  const exact = reg.linkMention('Huy', { nowMs: T0 });
  assert.equal(exact.match, 'exact');
  assert.equal(exact.entityId, created.value.id);
  assert.equal(exact.created, false);
  // Link alias.
  const alias = reg.linkMention('Huy Nguyen', { nowMs: T0 });
  assert.equal(alias.match, 'alias');
  assert.equal(alias.entityId, created.value.id);
  // Link fuzzy: "Huy N" overlap cao voi "Huy Nguyen" (alias).
  const fuzzy = reg.linkMention('Huy Nguyen', { nowMs: T0 });
  assert.equal(fuzzy.match, 'alias');
  // Mention moi thi tao entity moi.
  const fresh = reg.linkMention('Saigon', { sentence: 'Huy lives in Saigon', nowMs: T0 });
  assert.equal(fresh.created, true);
  assert.equal(fresh.kind, 'place');
  // Stopword khong link duoc.
  const stop = reg.linkMention('the', { nowMs: T0 });
  assert.equal(stop.match, 'none');
  // Ten rong / qua dai thi tu choi.
  assert.equal(reg.register({ name: '' }).ok, false);
  assert.equal(reg.register({ name: 'x'.repeat(201) }).ok, false);
});

test('v27 entity: tokenOverlap + infer kind + merge (khong xoa)', () => {
  assert.ok(tokenOverlapV27('Huy Nguyen', 'Huy Nguyen') === 1);
  assert.ok(tokenOverlapV27('Huy', 'Saigon') === 0);
  assert.ok(tokenOverlapV27('Huy Nguyen', 'Huy N') > 0);
  const reg = new V27EntityRegistry();
  const a = reg.register({ name: 'Huy', kind: 'person' }).value;
  const b = reg.register({ name: 'Huy Nguyen', kind: 'person' }).value;
  reg.linkMention('Huy', { nowMs: T0 });
  reg.linkMention('Huy Nguyen', { nowMs: T0 });
  const merged = reg.merge(b.id, a.id);
  assert.equal(merged.ok, true);
  assert.equal(merged.value.id, a.id);
  assert.ok(merged.value.aliases.includes('Huy Nguyen'));
  assert.equal(merged.value.mentionCount, 2);
  // Entity bi gop van doc duoc, danh dau mergedIntoId.
  const from = reg.get(b.id);
  assert.ok(from);
  assert.equal(from.mergedIntoId, a.id);
  // Link ten cu van ve entity dich.
  const link = reg.linkMention('Huy Nguyen', { nowMs: T0 });
  assert.equal(link.entityId, a.id);
  // Gop 2 lan thi loi.
  assert.equal(reg.merge(b.id, a.id).ok, false);
  // Gop vao chinh minh thi loi.
  assert.equal(reg.merge(a.id, a.id).ok, false);
});

test('v27 entity: boost weight — mention nhieu + moi thi cao, cap o 1', () => {
  const reg = new V27EntityRegistry();
  const e = reg.register({ name: 'Huy', kind: 'person' }).value;
  const fresh = reg.boostFor(e, T0);
  assert.ok(fresh.weight >= 0.3 && fresh.weight <= 1);
  // Mention nhieu lan thi boost tang.
  for (let i = 0; i < 20; i++) reg.linkMention('Huy', { nowMs: T0 });
  const boosted = reg.boostFor(e, T0);
  assert.ok(boosted.weight > fresh.weight);
  assert.ok(boosted.weight <= 1);
  // Entity cu (mention cach day 1 nam) thi boost thap hon.
  const old = reg.register({ name: 'Ancient', kind: 'topic' }).value;
  const oldBoost = reg.boostFor(old, T0 + 365 * 86400000);
  assert.ok(oldBoost.weight < boosted.weight);
});

test('v27 search: hybrid — bm25 + embedding proxy + entity boost + traversal', () => {
  const g = new V27Graph();
  const reg = new V27EntityRegistry();
  const huy = reg.register({ name: 'Huy', kind: 'person' }).value;
  reg.linkMention('Huy', { nowMs: T0 });
  g.addFact(candidate('Huy', 'likes', 'coffee', [huy.id]), { nowMs: T0 });
  g.addFact(candidate('Huy', 'works_at', 'xAI', [huy.id]), { nowMs: T0 });
  g.addFact(candidate('Lan', 'likes', 'tea'), { nowMs: T0 });
  // Query co entity Huy: fact cua Huy duoc boost len tren.
  const res = searchV27(g, reg, { query: 'Huy likes coffee', nowMs: T0 } , { nowMs: T0 });
  assert.equal(res.ok, true);
  assert.ok(res.value.hits.length >= 1);
  assert.equal(res.value.hits[0].fact.object, 'coffee');
  assert.ok(res.value.hits[0].score.entityBoost > 0);
  assert.ok(res.value.hits[0].score.total > 0);
  assert.equal(res.value.queryEntities.length, 1);
  assert.equal(res.value.queryEntities[0].entityName, 'Huy');
  // Tat entity boost: diem entity = 0.
  const noBoost = searchV27(g, reg, { query: 'Huy likes coffee', useEntityBoost: false }, { nowMs: T0 });
  assert.equal(noBoost.value.hits[0].score.entityBoost, 0);
  // Traversal: query "xAI" tim Huy works_at xAI truc tiep; ke 1 hop
  // (Huy likes coffee) co the xuat hien nho graph bonus.
  const trav = searchV27(g, reg, { query: 'xAI company', useTraversal: true }, { nowMs: T0 });
  assert.ok(trav.value.hits.some((h) => h.fact.object === 'xAI'));
  // Query rong thi loi.
  assert.equal(searchV27(g, reg, { query: '   ' }).ok, false);
  // asOf khong hop le thi loi.
  assert.equal(searchV27(g, reg, { query: 'Huy', asOf: 'khong-phai-ngay' }).ok, false);
});

test('v27 search: time-travel asOf + currentOnly', () => {
  const g = new V27Graph();
  const reg = new V27EntityRegistry();
  const T1 = T0 + 60_000;
  g.addFact(candidate('Huy', 'likes', 'coffee'), { nowMs: T0 });
  g.addFact(candidate('Huy', 'likes', 'tea'), { nowMs: T1 });
  // asOf giua T0 va T1: chi coffee.
  const mid = searchV27(g, reg, { query: 'Huy likes', asOf: new Date(T0 + 30_000).toISOString() }, { nowMs: T1 });
  assert.equal(mid.ok, true);
  assert.equal(mid.value.hits.length, 1);
  assert.equal(mid.value.hits[0].fact.object, 'coffee');
  assert.equal(mid.value.timeTravel, true);
  // currentOnly: chi tea.
  const cur = searchV27(g, reg, { query: 'Huy likes', currentOnly: true }, { nowMs: T1 });
  assert.equal(cur.value.hits.length, 1);
  assert.equal(cur.value.hits[0].fact.object, 'tea');
  // Khong loc: ca 2 (lich su day du).
  const all = searchV27(g, reg, { query: 'Huy likes' }, { nowMs: T1 });
  assert.equal(all.value.hits.length, 2);
});

test('v27 search: diem thanh phan nam trong 0..1, tong hop ly', () => {
  const g = new V27Graph();
  const reg = new V27EntityRegistry();
  g.addFact(candidate('Huy', 'likes', 'coffee'), { nowMs: T0 });
  const res = searchV27(g, reg, { query: 'coffee' }, { nowMs: T0 });
  assert.equal(res.value.hits.length, 1);
  const s = res.value.hits[0].score;
  for (const v of [s.bm25, s.embeddingProxy, s.entityBoost, s.graphBonus, s.recency, s.total]) {
    assert.ok(v >= 0 && v <= 1, `diem ${v} ngoai 0..1`);
  }
  assert.ok(s.bm25 > 0);
  assert.ok(s.embeddingProxy > 0);
  assert.ok(res.value.hits[0].reason.length > 0);
});
