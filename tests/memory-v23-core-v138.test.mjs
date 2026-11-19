/**
 * Tests for memory v23 core (v1.38, Doi T1): extractor, consolidator,
 * store, entity index, local embedder, migration, health.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/memory-v23-core-v138.test.mjs
 * No network. No model. Ollama is faked offline (hash fallback).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  V23Consolidator,
  V23EntityIndex,
  V23LocalEmbedder,
  V23MemoryStore,
  V23ProceduralStore,
  applyMigrationToStoreV23,
  checkV23Health,
  decideV23,
  extractEntitiesV23,
  extractV23Candidates,
  hashEmbedV23,
  isContradictionV23,
  jaccardV23,
  migrateLegacyEntriesToV23,
  migrateV21RecordsToV23,
  queryEntitiesV23,
} from '../packages/core/dist/memory/v23/index.js';

const NOW = 1794000000000;
const fakeOfflineEmbedder = { embed: async () => { throw new Error('ollama offline'); } };

function store(now = NOW) {
  return new V23MemoryStore({ now: () => now });
}

// --- extractor ---

test('v23 extract: preference + decision + procedure duoc phan loai', () => {
  const candidates = extractV23Candidates([
    { role: 'user', text: 'Toi thich ca phe den, khong duong. Chung ta da quyet dinh dung Postgres cho du an moi.' },
    { role: 'user', text: 'Cach lam: buoc 1 mo file config, buoc 2 sua port thanh 8080.' },
  ]);
  const kinds = candidates.map((c) => c.kind);
  assert.ok(kinds.includes('preference'), `thieu preference: ${kinds}`);
  assert.ok(kinds.includes('decision'), `thieu decision: ${kinds}`);
  assert.ok(kinds.includes('procedure'), `thieu procedure: ${kinds}`);
  for (const c of candidates) assert.ok(c.confidence >= 0.3 && c.confidence <= 0.95);
});

test('v23 extract: noise (chao hoi/cam on/cau hoi rong) bi loai, cau lap dedupe', () => {
  const none = extractV23Candidates([
    { role: 'user', text: 'Chao ban! Cam on ban rat nhieu. Ban co nghe khong?' },
  ]);
  assert.equal(none.length, 0);
  const dup = extractV23Candidates([
    { role: 'user', text: 'Toi thich ca phe den. Toi thich ca phe den.' },
  ]);
  assert.equal(dup.length, 1);
});

test('v23 extract: cau agent khong thanh preference cua user', () => {
  const candidates = extractV23Candidates([
    { role: 'agent', text: 'Toi thich lam viec voi ban.' },
  ]);
  assert.equal(candidates.filter((c) => c.kind === 'preference').length, 0);
});

// --- entity index ---

test('v23 entity: trich ten rieng + hashtag + alias, signal tinh dung', () => {
  const entities = extractEntitiesV23('Thoi tiet Ha Noi hom nay mua. Du an #openbot dung Postgres.');
  assert.ok(entities.includes('ha noi'), entities.join(','));
  assert.ok(entities.includes('openbot'), entities.join(','));
  assert.equal(queryEntitiesV23('Ha Noi').includes('ha noi'), true);
  const index = new V23EntityIndex();
  index.addRecord('r1', ['ha noi', 'ca phe']);
  index.addRecord('r2', ['ha noi', 'mua']);
  assert.deepEqual(index.recordsFor('ha noi'), ['r1', 'r2']);
  assert.deepEqual(index.recordsFor('HN'), ['r1', 'r2']); // alias HN -> ha noi
  assert.equal(index.topEntities(1)[0].entity, 'ha noi');
  const signal = V23EntityIndex.entitySignal(['ha noi'], ['ha noi', 'ca phe']);
  assert.equal(signal, 1);
  const partial = V23EntityIndex.entitySignal(['ha noi', 'da nang'], ['ha noi']);
  assert.equal(partial, 0.5);
  index.removeRecord('r1', ['ha noi', 'ca phe']);
  assert.deepEqual(index.recordsFor('ha noi'), ['r2']);
});

// --- local embedder ---

test('v23 embedder: hash xac dinh, fallback khi Ollama offline, cache hoat dong', async () => {
  const a = hashEmbedV23('ca phe den');
  const b = hashEmbedV23('ca phe den');
  assert.deepEqual(a, b);
  assert.equal(a.length, 128);
  const norm = Math.sqrt(a.reduce((s, v) => s + v * v, 0));
  assert.ok(Math.abs(norm - 1) < 1e-9, `norm=${norm}`);
  const similar = hashEmbedV23('ca phe den khong duong');
  const dot = a.reduce((s, v, i) => s + v * similar[i], 0);
  assert.ok(dot > 0.3, `cosine tuong tu qua thap: ${dot}`);

  const embedder = new V23LocalEmbedder({ embedder: fakeOfflineEmbedder });
  const res = await embedder.embed('ca phe den');
  assert.equal(res.ok, true);
  assert.equal(res.kind, 'hash');
  assert.equal(res.vector.length, 128);
  assert.equal(embedder.cacheSize(), 1);
  const res2 = await embedder.embed('ca phe den');
  assert.deepEqual(res2.vector, res.vector);
  assert.equal(embedder.cacheSize(), 1);
  const empty = await embedder.embed('   ');
  assert.equal(empty.ok, false);
});

// --- store ---

test('v23 store: put/get/update/delete/restore + version tang', () => {
  const s = store();
  const put = s.put({ text: 'User thich ca phe den.', kind: 'preference', confidence: 0.8, entities: ['ca phe'], source: 'test' });
  assert.equal(put.ok, true);
  const id = put.record.id;
  assert.equal(put.record.version, 1);
  assert.equal(put.record.status, 'active');
  assert.equal(s.get(id).text, 'User thich ca phe den.');
  const upd = s.update(id, { text: 'User thich ca phe den khong duong.', confidence: 0.9 });
  assert.equal(upd.ok, true);
  assert.equal(upd.record.version, 2);
  assert.equal(upd.record.confidence, 0.9);
  assert.equal(s.delete(id).ok, true);
  assert.equal(s.get(id).status, 'deleted');
  assert.equal(s.size(true), 0);
  assert.equal(s.size(false), 1);
  assert.equal(s.restore(id).ok, true);
  assert.equal(s.get(id).status, 'active');
  assert.equal(s.update('khong-co', { text: 'x' }).ok, false);
  assert.equal(s.put({ text: '   ' }).ok, false);
  assert.equal(s.put({ text: 'x'.repeat(2001) }).ok, false);
});

test('v23 store: list loc kind/scope/validity + stats + export/import JSON', () => {
  const s = store();
  s.put({ text: 'User thich ca phe den.', kind: 'preference', scope: { userId: 'u1' } });
  s.put({ text: 'Du an dung Postgres.', kind: 'fact', scope: { userId: 'u2' } });
  s.put({ text: 'Record het han.', kind: 'fact', validTo: '2020-01-01' });
  assert.equal(s.list({ kind: 'preference' }).length, 1);
  assert.equal(s.list({ scope: { userId: 'u1' } }).length, 1);
  assert.equal(s.list({ validAt: NOW }).length, 2);
  const stats = s.stats();
  assert.equal(stats.total, 3);
  assert.equal(stats.active, 3);
  assert.equal(stats.byKind.preference, 1);
  const json = s.exportJson();
  const s2 = store();
  const imported = s2.importJson(json);
  assert.equal(imported.imported, 3);
  assert.equal(imported.skipped, 0);
  assert.equal(s2.importJson('khong-phai-json').imported, 0);
  assert.equal(s2.findNearDuplicates('User thich ca phe den khong duong.').length, 1);
});

test('v23 store: embedRecord gan embedding hash khi Ollama offline', async () => {
  const s = new V23MemoryStore({ now: () => NOW, embedder: new V23LocalEmbedder({ embedder: fakeOfflineEmbedder }) });
  const put = s.put({ text: 'User thich ca phe den.' });
  const res = await s.embedRecord(put.record.id);
  assert.equal(res.ok, true);
  assert.equal(res.record.embeddingKind, 'hash');
  assert.equal(res.record.embedding.length, 128);
  const batch = await s.embedMissing(10);
  assert.equal(batch.embedded, 0); // da co embedding, khong con thieu
});

// --- consolidator ---

test('v23 consolidate: add moi, drop trung lap, supersede khi mau thuan', () => {
  const s = store();
  const c = new V23Consolidator({ now: () => NOW });
  const first = c.consolidate(
    extractV23Candidates([{ role: 'user', text: 'Toi thich ca phe den, khong duong.' }]),
    s,
    'test',
  );
  assert.equal(first.added, 1);
  assert.equal(s.size(), 1);
  const dup = c.consolidate(
    extractV23Candidates([{ role: 'user', text: 'Toi thich ca phe den, khong duong.' }]),
    s,
    'test',
  );
  assert.equal(dup.dropped, 1);
  assert.equal(s.size(), 1);
  // Mau thuan: thich -> khong thich
  assert.equal(isContradictionV23('Toi thich ca phe den.', 'Toi khong thich ca phe den.'), true);
  assert.equal(isContradictionV23('Toi thich ca phe den.', 'Du an dung Postgres.'), false);
  const contra = c.consolidate(
    extractV23Candidates([{ role: 'user', text: 'Toi khong thich ca phe den nua.' }]),
    s,
    'test',
  );
  assert.equal(contra.superseded, 1);
  assert.equal(s.list({ status: 'superseded' }).length, 1);
  assert.equal(s.size(), 1);
});

test('v23 consolidate: preview khong ghi store, jaccard tinh dung', () => {
  const s = store();
  s.put({ text: 'User thich ca phe den khong duong.' });
  const c = new V23Consolidator();
  const candidates = extractV23Candidates([{ role: 'user', text: 'User thich ca phe den khong duong moi sang.' }]);
  assert.equal(candidates.length, 1);
  const preview = c.preview(candidates, s);
  assert.equal(preview.length, 1);
  assert.ok(preview[0].decision === 'merge' || preview[0].decision === 'update', preview[0].decision);
  assert.equal(s.size(), 1); // preview khong ghi
  assert.ok(jaccardV23('ca phe den', 'ca phe den') > 0.99);
  assert.ok(jaccardV23('ca phe den', 'postgres database') < 0.1);
  const d = decideV23({ text: 'x', kind: 'fact', confidence: 0.1, entities: [], reason: 't', sentenceIndex: 0, speaker: 'user' }, s);
  assert.equal(d.decision, 'drop');
});

// --- migration ---

test('v23 migration: v21 + legacy -> input, apply vao store khong ghi de', () => {
  const migrated = migrateV21RecordsToV23([
    { id: 'user-thich-ca-phe', type: 'fact', title: 'Ca phe', body: 'User thich ca phe den.', tags: ['ca-phe'], sources: ['chat:s1'], version: 3, staleAfter: '2030-01-01' },
    { id: 'rong', type: 'fact', title: '', body: '' },
  ]);
  assert.equal(migrated.inputs.length, 1);
  assert.equal(migrated.skipped, 1);
  assert.equal(migrated.inputs[0].id, 'v23-migrated-user-thich-ca-phe');
  assert.ok(migrated.inputs[0].tags.includes('migrated:v21'));
  assert.ok(migrated.inputs[0].tags.includes('v21-version:3'));
  assert.equal(migrated.inputs[0].validTo, '2030-01-01');
  const legacy = migrateLegacyEntriesToV23([
    { text: 'User thich tra xanh.', kind: 'preference' },
    { text: '   ' },
  ]);
  assert.equal(legacy.inputs.length, 1);
  assert.equal(legacy.skipped, 1);
  const s = store();
  const applied = applyMigrationToStoreV23(s, migrated);
  assert.equal(applied.put, 1);
  const appliedAgain = applyMigrationToStoreV23(s, migrated);
  assert.equal(appliedAgain.put, 0);
  assert.equal(appliedAgain.skippedExisting, 1);
});

// --- health ---

test('v23 health: phat hien stale + trung lap + scope mo ho, store rong khoe 100%', () => {
  const empty = checkV23Health(store());
  assert.equal(empty.healthyRatio, 1);
  assert.equal(empty.issues.length, 0);
  const s = store();
  s.put({ text: 'Record het han tu lau.', validTo: '2020-01-01' });
  s.put({ text: 'User thich ca phe den khong duong moi sang.', scope: { runId: 'run1' } });
  const report = checkV23Health(s);
  assert.ok(report.issues.some((i) => i.code === 'stale-ratio-high' || i.code === 'scope-ambiguous' || i.code === 'missing-embeddings'), JSON.stringify(report.issues));
  const skills = new V23ProceduralStore({ now: () => NOW });
  const healthWithSkills = checkV23Health(s, skills);
  assert.equal(healthWithSkills.skillsScanned, 0);
});
