/**
 * Tests for memory v23 fusion + multi-scope retrieval (v1.38, Doi T1).
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/memory-v23-fusion-scope-v138.test.mjs
 * No network. No model. Embedder gia offline -> hash fallback.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  V23Bm25Index,
  V23LocalEmbedder,
  V23MemoryStore,
  auditScopeVisibilityV23,
  fuseV23,
  fuseV23Rrf,
  normalizeScoresV23,
  normalizeWeightsV23,
  retrieveV23Scoped,
} from '../packages/core/dist/memory/v23/index.js';

const NOW = 1794000000000;
const fakeOfflineEmbedder = { embed: async () => { throw new Error('ollama offline'); } };

function hashEmbedder() {
  return new V23LocalEmbedder({ embedder: fakeOfflineEmbedder });
}

function seedStore() {
  const s = new V23MemoryStore({ now: () => NOW });
  s.put({ text: 'User thich ca phe den khong duong.', confidence: 0.8, source: 'test' });
  s.put({ text: 'Du an dung Postgres lam database.', confidence: 0.8, source: 'test' });
  s.put({ text: 'Thoi tiet Ha Noi hom nay mua to.', confidence: 0.8, source: 'test' });
  return s;
}

test('v23 bm25: cham dung thu tu, chuan hoa theo max dung', () => {
  const index = new V23Bm25Index([
    { id: 'a', text: 'ca phe den khong duong' },
    { id: 'b', text: 'postgres database' },
  ]);
  const scores = index.score('ca phe den');
  assert.ok((scores.get('a') ?? 0) > 0);
  assert.equal(scores.get('b'), undefined);
  // Chuan hoa theo max: giu ti le (2/8, 5/8, 8/8), khong day min ve 0.
  const norm = normalizeScoresV23(new Map([['a', 2], ['b', 5], ['c', 8]]));
  assert.equal(norm.get('a'), 0.25);
  assert.equal(norm.get('b'), 0.625);
  assert.equal(norm.get('c'), 1);
  assert.equal(normalizeScoresV23(new Map()).size, 0);
  assert.equal(normalizeScoresV23(new Map([['a', 0], ['b', 0]])).get('a'), 0);
  const w = normalizeWeightsV23({ semantic: 2, bm25: 1, entity: 1 });
  assert.ok(Math.abs(w.semantic + w.bm25 + w.entity - 1) < 1e-9);
});

test('v23 fusion: BM25 tim dung top1, giai thich du 3 tin hieu', async () => {
  const s = seedStore();
  const hits = await fuseV23(s.listActive(), 'ca phe den', hashEmbedder(), {
    entityIndex: s.getEntityIndex(),
    now: () => NOW,
  });
  assert.ok(hits.length >= 1);
  assert.ok(hits[0].record.text.includes('ca phe'), hits[0].record.text);
  assert.ok(hits[0].explanation.includes('semantic'));
  assert.ok(hits[0].explanation.includes('bm25'));
  assert.ok(hits[0].explanation.includes('entity'));
  assert.ok(hits[0].score >= 0 && hits[0].score <= 1);
  // Xep giam dan theo diem.
  for (let i = 1; i < hits.length; i += 1) assert.ok(hits[i - 1].score >= hits[i].score);
});

test('v23 fusion: entity boost dua record ten rieng len top, het han bi loai', async () => {
  const s = seedStore();
  const hits = await fuseV23(s.listActive(), 'Ha Noi', hashEmbedder(), {
    entityIndex: s.getEntityIndex(),
    now: () => NOW,
  });
  assert.ok(hits[0].record.text.includes('Ha Noi'), hits[0].record.text);
  assert.ok(hits[0].signals.entity > 0, JSON.stringify(hits[0].signals));

  const s2 = new V23MemoryStore({ now: () => NOW });
  s2.put({ text: 'User thich ca phe den.', validTo: '2020-01-01' });
  const expired = await fuseV23(s2.listActive(), 'ca phe', hashEmbedder(), { now: () => NOW });
  assert.equal(expired.length, 0);
  const expiredKept = await fuseV23(s2.listActive(), 'ca phe', hashEmbedder(), { now: () => NOW, onlyValidNow: false });
  assert.equal(expiredKept.length, 1);
});

test('v23 fusion: khong embedder van tra ket qua BM25; query rong tra []', async () => {
  const s = seedStore();
  const hits = await fuseV23(s.listActive(), 'Postgres', undefined, {
    entityIndex: s.getEntityIndex(),
    now: () => NOW,
  });
  assert.ok(hits[0].record.text.includes('Postgres'));
  assert.equal(hits[0].signals.semantic, 0);
  assert.deepEqual(await fuseV23(s.listActive(), '   ', hashEmbedder()), []);
  const rrf = await fuseV23Rrf(s.listActive(), 'ca phe den', hashEmbedder(), {
    entityIndex: s.getEntityIndex(),
    now: () => NOW,
  });
  assert.ok(rrf.length >= 1);
  assert.ok(rrf[0].record.text.includes('ca phe'));
});

test('v23 scope: run thay agent, user khac bi chan, app-wide thay moi noi', async () => {
  const s = new V23MemoryStore({ now: () => NOW });
  s.put({ text: 'User thich ca phe den.', scope: { userId: 'u1', agentId: 'bot1', runId: 'run1' } });
  s.put({ text: 'Bot ghi nho du an Postgres.', scope: { userId: 'u1', agentId: 'bot1', runId: '' } });
  s.put({ text: 'Huong dan chung ve ca phe.', scope: { userId: '', agentId: '', runId: '' } });
  const runScope = { userId: 'u1', agentId: 'bot1', runId: 'run1', appId: '' };
  const hits = await retrieveV23Scoped(s, 'ca phe', runScope, undefined, { now: () => NOW });
  assert.ok(hits.length >= 1);
  const otherUser = await retrieveV23Scoped(
    s, 'ca phe', { userId: 'u2', agentId: 'bot1', runId: '', appId: '' }, undefined, { now: () => NOW },
  );
  // u2 chi thay duoc record app-wide.
  assert.ok(otherUser.every((h) => !h.record.scope.userId && !h.record.scope.agentId));
  const audit = auditScopeVisibilityV23(s, { userId: 'u2', agentId: 'bot1', runId: '', appId: '' });
  assert.equal(audit.visible, 1);
  assert.equal(audit.hidden, 2);
});

test('v23 scope: query rong tra recent; dedupe gop cung fact 2 scope', async () => {
  const s = new V23MemoryStore({ now: () => NOW });
  s.put({ text: 'User thich ca phe den khong duong.', scope: { userId: 'u1', agentId: 'bot1', runId: '' } });
  s.put({ text: 'User thich ca phe den khong duong.', scope: { userId: 'u1', agentId: '', runId: '' } });
  const scope = { userId: 'u1', agentId: 'bot1', runId: 'run1', appId: '' };
  const hits = await retrieveV23Scoped(s, 'ca phe', scope, undefined, { now: () => NOW });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].mergedSources.length, 1);
  const recent = await retrieveV23Scoped(s, '', scope, undefined, { now: () => NOW });
  assert.equal(recent.length, 1); // dedupe ca khi recent
  assert.equal(recent[0].explanation, 'recent (query rong)');
});

test('v23 scope: trong so run > user (hit run dung truoc)', async () => {
  const s = new V23MemoryStore({ now: () => NOW });
  s.put({ text: 'User thich ca phe den khong duong.', scope: { userId: 'u1', agentId: '', runId: '' } });
  s.put({ text: 'User uong ca phe den moi sang truoc khi lam viec.', scope: { userId: 'u1', agentId: 'bot1', runId: 'run1' } });
  const hits = await retrieveV23Scoped(
    s, 'ca phe', { userId: 'u1', agentId: 'bot1', runId: 'run1', appId: '' }, undefined, { now: () => NOW },
  );
  assert.equal(hits.length, 2);
  assert.equal(hits[0].scopeLevel, 'run');
  assert.equal(hits[0].scopeWeight, 1);
  assert.equal(hits[1].scopeLevel, 'user');
});
