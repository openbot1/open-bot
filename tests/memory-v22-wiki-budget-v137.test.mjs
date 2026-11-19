/**
 * Tests for memory v22 — wiki representation + always-loaded budget
 * (v1.37, Doi T1).
 * packages/core/src/memory/v22/{wiki,budget}.ts
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/memory-v22-wiki-budget-v137.test.mjs
 * No network. No model.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  V22DreamStore,
  buildWikiV22,
  diffWikiV22,
  estimateTokensV22,
  findWikiPageForFactV22,
  groupFactsIntoPagesV22,
  measureAlwaysLoadedV22,
  planAlwaysLoadedV22,
  scoreDreamFactV22,
  slugifyWikiV22,
  summarizeBudgetChangeV22,
  topicTitleV22,
  wikiCoverageV22,
} from '../packages/core/dist/memory/v22/index.js';

const NOW = 1794000000000;
const DAY = 86_400_000;

function add(store, text, extra = {}) {
  const res = store.addFact({ text, ...extra }, NOW);
  assert.ok(res.ok, `addFact that bai: ${res.error}`);
  return res.data;
}

// --- wiki ----------------------------------------------------------------

test('v22 wiki: gom fact theo topic, slug + tieu de + markdown day du', () => {
  assert.equal(slugifyWikiV22('User | Thích Uống'), 'user-thich-uong');
  assert.equal(topicTitleV22('user|thich_uong'), 'User: Thich uong');
  const store = new V22DreamStore();
  const f1 = add(store, 'User thich ca phe den.', { topic: 'user|thich_uong', confidence: 0.9, tags: ['ca-phe'] });
  add(store, 'User uong ca phe moi sang.', { topic: 'user|thich_uong', confidence: 0.7, tags: ['ca-phe'] });
  add(store, 'User thich pho bo.', { topic: 'user|thich_an', confidence: 0.8, tags: ['pho'] });
  add(store, 'Du an open-bot dung TypeScript.', { tags: ['lam-viec'], confidence: 0.85 });
  const pages = groupFactsIntoPagesV22(store.list());
  assert.equal(pages.size, 3);
  const index = buildWikiV22(store.list(), { jobId: 'job-1', now: NOW });
  assert.equal(index.pages.length, 3);
  assert.equal(index.pagesAdded, 3);
  assert.equal(index.jobId, 'job-1');
  const drink = index.pages.find((p) => p.slug === 'user-thich-uong');
  assert.ok(drink);
  assert.equal(drink.factIds.length, 2);
  assert.equal(drink.factIds[0], f1.id); // confidence cao nhat dung dau
  assert.match(drink.markdown, /^# User: Thich uong\n/);
  assert.match(drink.markdown, /User thich ca phe den/);
  assert.match(drink.markdown, /confidence 0\.90/);
  assert.match(drink.summary, /User thich ca phe den/);
  // Trang tag-lam-viec (fact khong co topic thi gom theo tag dau tien).
  const work = index.pages.find((p) => p.slug === 'tag-lam-viec');
  assert.ok(work);
  assert.equal(work.title, 'Tag: Lam viec');
});

test('v22 wiki: link giua cac trang cung chu the + diff them/mat/doi', () => {
  const store = new V22DreamStore();
  add(store, 'User thich ca phe den.', { topic: 'user|thich_uong', confidence: 0.9 });
  add(store, 'User thich pho bo.', { topic: 'user|thich_an', confidence: 0.8 });
  const index1 = buildWikiV22(store.list(), { jobId: 'job-1', now: NOW });
  const drink1 = index1.pages.find((p) => p.slug === 'user-thich-uong');
  const food1 = index1.pages.find((p) => p.slug === 'user-thich-an');
  assert.ok(drink1.links.some((l) => l.slug === 'user-thich-an'));
  assert.ok(food1.links.some((l) => l.slug === 'user-thich-uong'));
  assert.match(drink1.links[0].reason, /cung chu the: user/);
  // Them fact moi vao trang uong -> trang doi; them topic moi -> trang them.
  add(store, 'User uong tra da buoi trua.', { topic: 'user|thich_uong', confidence: 0.75 });
  add(store, 'User chay bo moi sang.', { topic: 'user|the_thao', confidence: 0.7 });
  const index2 = buildWikiV22(store.list(), { jobId: 'job-2', previous: index1, now: NOW + 1000 });
  assert.equal(index2.pagesAdded, 1);
  assert.equal(index2.pagesRemoved, 0);
  assert.equal(index2.pagesChanged, 1);
  const diff = diffWikiV22(index1, index2);
  assert.deepEqual(diff.added, ['user-the-thao']);
  assert.deepEqual(diff.changed, ['user-thich-uong']);
  assert.deepEqual(diff.removed, []);
  // Tim trang chua mot fact + do phu wiki = 100%.
  const coverage = wikiCoverageV22(index2, store.list());
  assert.equal(coverage.total, 4);
  assert.equal(coverage.covered, 4);
  assert.equal(coverage.ratio, 1);
  const f = store.list({ topic: 'user|the_thao' })[0];
  assert.equal(findWikiPageForFactV22(index2, f.id).slug, 'user-the-thao');
  assert.equal(findWikiPageForFactV22(index2, 'khong-co'), undefined);
});

test('v22 wiki: store rong -> wiki rong; fact het han khong vao wiki', () => {
  const store = new V22DreamStore();
  const empty = buildWikiV22(store.list(), { jobId: 'job-1', now: NOW });
  assert.equal(empty.pages.length, 0);
  add(store, 'User dang o Ha Noi den 20/11.', { validUntil: NOW - DAY });
  store.setStatus(store.list()[0].id, 'expired');
  const index = buildWikiV22(store.list(), { jobId: 'job-2', now: NOW });
  assert.equal(index.pages.length, 0);
});

// --- budget --------------------------------------------------------------

test('v22 budget: uoc tinh token chars/4 + do luong vua ngan sach', () => {
  assert.equal(estimateTokensV22(''), 0);
  assert.equal(estimateTokensV22('abcd'), 1);
  assert.equal(estimateTokensV22('abcdefgh'), 2);
  const store = new V22DreamStore();
  add(store, 'User thich ca phe den.', { confidence: 0.9 });
  add(store, 'User thich pho bo.', { confidence: 0.8 });
  const m = measureAlwaysLoadedV22(store.list(), { budgetChars: 4000, now: NOW });
  assert.equal(m.withinBudget, true);
  assert.equal(m.factCount, 2);
  assert.equal(m.overByChars, 0);
  assert.equal(m.estimatedTokens, estimateTokensV22('- User thich ca phe den.\n- User thich pho bo.'));
  assert.ok(m.chars > 0 && m.chars <= 4000);
});

test('v22 budget: het ngan sach thi cat fact diem thap, co ly do tung fact', () => {
  const store = new V22DreamStore();
  const top = add(store, 'User thich ca phe den moi sang khong duong.', { confidence: 0.95 });
  add(store, 'User thich tra dao buoi chieu mat lanh.', { confidence: 0.6 });
  add(store, 'User thich xem phim vao cuoi tuan ranh roi.', { confidence: 0.55 });
  // Ngan sach chi du 1 dong dai (~45 ky tu).
  const plan = planAlwaysLoadedV22(store.list(), { budgetChars: 50, now: NOW });
  assert.equal(plan.measurement.factCount, 1);
  assert.deepEqual(plan.measurement.includedIds, [top.id]);
  assert.equal(plan.measurement.excludedIds.length, 2);
  assert.equal(Object.keys(plan.excludedReasons).length, 2);
  assert.match(plan.excludedReasons[plan.measurement.excludedIds[0]], /het ngan sach 50 ky tu/);
  assert.match(plan.renderedText, /User thich ca phe den/);
  assert.doesNotMatch(plan.renderedText, /xem phim/);
  assert.ok(plan.scores[top.id] > plan.scores[plan.measurement.excludedIds[0]]);
  const summary = summarizeBudgetChangeV22(
    { chars: 100, estimatedTokens: 25, factCount: 3, budgetChars: 50, withinBudget: false, overByChars: 50, includedIds: [], excludedIds: [] },
    plan.measurement,
  );
  assert.match(summary, /always-loaded: 100 ->/);
});

test('v22 budget: diem uu tien — pattern duoc boost, fact het han = 0', () => {
  const store = new V22DreamStore();
  const pattern = add(store, 'Pattern (3 quan sat, 3 session): User uong ca phe.', {
    kind: 'pattern', confidence: 0.8, sessionIds: ['s1', 's2', 's3'],
  });
  const plain = add(store, 'User uong ca phe.', { confidence: 0.8, sessionIds: ['s1'] });
  const expired = add(store, 'User dang o Ha Noi.', { confidence: 0.99, validUntil: NOW - DAY });
  assert.ok(scoreDreamFactV22(pattern, { now: NOW }) > scoreDreamFactV22(plain, { now: NOW }));
  assert.equal(scoreDreamFactV22(expired, { now: NOW }), 0);
  // Fact duoi nguong promote thi khong vao lop.
  const plan = planAlwaysLoadedV22(store.list(), { budgetChars: 4000, promoteThreshold: 0.85, now: NOW });
  assert.equal(plan.measurement.factCount, 0);
  assert.match(plan.excludedReasons[plain.id], /duoi nguong 0\.85/);
});

test('v22 budget: fact moi hon duoc uu tien hon fact cu cung confidence (decay)', () => {
  const store = new V22DreamStore();
  const oldFact = add(store, 'User thich tra xanh tu lau.', { confidence: 0.8, observedAt: NOW - 90 * DAY });
  const newFact = add(store, 'User thich ca phe den hien nay.', { confidence: 0.8, observedAt: NOW });
  assert.ok(scoreDreamFactV22(newFact, { now: NOW }) > scoreDreamFactV22(oldFact, { now: NOW }));
});
