/**
 * Tests for memory v27 — episode provenance + shared block
 * bi-temporal + store/pipeline (v1.42, Doi T3).
 * packages/core/src/memory/v27/{episodes,sharedBlocks,store,pipeline}.ts
 *
 * Run after building core:
 *   node node_modules/typescript/bin/tsc -p packages/core/tsconfig.json --incremental
 *   node --test tests/memory-v27-episode-block-v142.test.mjs
 * No network. No model. Uses temp dirs under os.tmpdir() for save/load.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  V27Pipeline,
  V27Store,
  buildV27PanelView,
} from '../packages/core/dist/memory/v27/index.js';

const T0 = Date.parse('2026-11-19T00:00:00.000Z');
const T1 = T0 + 60_000;
const T2 = T0 + 120_000;

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'openbot-v27-ep-'));
}

test('v27 pipeline: ingest 1 pass — episode + fact + entity link + provenance', () => {
  const store = new V27Store();
  const pipeline = new V27Pipeline(store);
  const res = pipeline.ingestEpisode(
    { text: 'Huy likes coffee. Huy lives in Saigon.', source: 'chat', agentId: 'bot-a' },
    { nowMs: T0, by: 'bot-a' },
  );
  assert.equal(res.ok, true);
  assert.equal(res.value.factsAdded, 2);
  assert.equal(res.value.edgesClosed, 0);
  assert.equal(res.value.episode.factIds.length, 2);
  assert.ok(res.value.episode.entityIds.length >= 1);
  assert.equal(res.value.extraction.sentencesScanned, 2);
  assert.ok(res.value.extraction.entityLinks.some((l) => l.entityName === 'Huy'));
  // Provenance: fact -> episode goc.
  const factId = res.value.addedFacts[0].edge.id;
  const prov = pipeline.provenance(factId);
  assert.equal(prov.ok, true);
  assert.ok(prov.value.episode);
  assert.equal(prov.value.episode.id, res.value.episode.id);
  assert.match(prov.value.chain, /fact .* -> episode .*/);
  assert.equal(prov.value.siblingFacts.length, 1);
  // Fact khong co thi loi (khong throw).
  assert.equal(pipeline.provenance('fact_khong_co').ok, false);
});

test('v27 pipeline: ingest lan 2 fact doi — edge cu dong, episode moi giu provenance rieng', () => {
  const store = new V27Store();
  const pipeline = new V27Pipeline(store);
  const first = pipeline.ingestEpisode(
    { text: 'Huy likes coffee.', source: 'chat', agentId: 'bot-a' },
    { nowMs: T0, by: 'bot-a' },
  );
  const second = pipeline.ingestEpisode(
    { text: 'Huy likes tea.', source: 'chat', agentId: 'bot-a' },
    { nowMs: T1, by: 'bot-a' },
  );
  assert.equal(second.value.factsAdded, 1);
  assert.equal(second.value.edgesClosed, 1);
  // Ingest trung y het: khong them fact moi.
  const third = pipeline.ingestEpisode(
    { text: 'Huy likes tea.', source: 'chat', agentId: 'bot-a' },
    { nowMs: T2, by: 'bot-a' },
  );
  assert.equal(third.value.factsAdded, 0);
  assert.equal(third.value.extraction.duplicates, 1);
  // Episode nao cung giu provenance cua rieng no.
  assert.notEqual(first.value.episode.id, second.value.episode.id);
  const prov = pipeline.provenance(second.value.addedFacts[0].edge.id);
  assert.equal(prov.value.episode.id, second.value.episode.id);
  // Stats phan anh bo dem add-only.
  const stats = store.stats();
  assert.equal(stats.factsTotal, 2);
  assert.equal(stats.factsActive, 1);
  assert.equal(stats.factsSuperseded, 1);
  assert.equal(stats.duplicatesSkipped, 1);
  assert.equal(stats.edgesClosedBySupersede, 1);
  assert.equal(stats.episodesTotal, 3);
});

test('v27 pipeline: dry-run khong ghi gi', () => {
  const store = new V27Store();
  const pipeline = new V27Pipeline(store);
  const dry = pipeline.extractDryRun('Huy likes coffee.');
  assert.equal(dry.ok, true);
  assert.equal(dry.value.candidates.length, 1);
  assert.equal(store.factsTotal, 0);
  assert.equal(store.episodesTotal, 0);
  assert.equal(pipeline.extractDryRun('   ').ok, false);
});

test('v27 pipeline: timeTravel — fact + block value tai X', () => {
  const store = new V27Store();
  const pipeline = new V27Pipeline(store);
  // Tao block v26 + dang ky lop bi-temporal.
  const created = store.v26.registry.create(
    { label: 'human', value: '## Ten\nHuy', ownerBotId: 'bot-a', kind: 'human' },
    { nowMs: T0 },
  );
  assert.equal(created.ok, true);
  const blockId = created.value.block.id;
  const reg = store.blocks.registerBlock(blockId, { nowMs: T0 });
  assert.equal(reg.ok, true);
  // Cap nhat block tai T1.
  const upd = store.blocks.updateBlock(blockId, '## Ten\nHuy\n\n## Thich\nCa phe', 'bot-a', { nowMs: T1, reason: 'them so thich' });
  assert.equal(upd.ok, true);
  assert.equal(upd.value.version, 2);
  // Ingest fact tai T1.
  pipeline.ingestEpisode(
    { text: 'Huy likes coffee.', source: 'chat', agentId: 'bot-a' },
    { nowMs: T1, by: 'bot-a' },
  );
  // Time-travel ve T0+30s: fact chua co, block van gia tri cu.
  const past = pipeline.timeTravel(new Date(T0 + 30_000).toISOString());
  assert.equal(past.ok, true);
  assert.equal(past.value.factsAtTime, 0);
  assert.equal(past.value.blockValues.human, '## Ten\nHuy');
  // Time-travel ve T2: fact co, block gia tri moi.
  const now = pipeline.timeTravel(new Date(T2).toISOString());
  assert.equal(now.value.factsAtTime, 1);
  assert.match(now.value.blockValues.human, /Ca phe/);
  // asOf khong hop le thi loi.
  assert.equal(pipeline.timeTravel('khong-phai-ngay').ok, false);
});

test('v27 shared block: cap nhat dong bo cho moi agent attach + valueAt + timeline', () => {
  const store = new V27Store();
  const created = store.v26.registry.create(
    {
      label: 'project-alpha', value: 'v1', ownerBotId: 'bot-a', kind: 'project',
      attachBotIds: ['bot-b', 'bot-c'],
    },
    { nowMs: T0 },
  );
  assert.equal(created.ok, true);
  const blockId = created.value.block.id;
  assert.equal(store.blocks.registerBlock(blockId, { nowMs: T0 }).ok, true);
  // Cap nhat: owner + 2 agent attach deu nhan.
  const upd = store.blocks.updateBlock(blockId, 'v2 — them muc tieu', 'bot-a', { nowMs: T1, reason: 'cap nhat muc tieu' });
  assert.equal(upd.ok, true);
  assert.deepEqual([...upd.value.syncedAgents].sort(), ['bot-a', 'bot-b', 'bot-c']);
  assert.equal(upd.value.attachedCount, 3);
  // Agent attach thay gia tri moi nhat.
  assert.equal(store.blocks.agentSeesLatest(blockId, 'bot-b').value, true);
  assert.equal(store.blocks.agentSeesLatest(blockId, 'bot-c').value, true);
  // Agent khong attach thi khong thay.
  assert.equal(store.blocks.agentSeesLatest(blockId, 'bot-z').value, false);
  // Timeline: 2 entry (khoi tao + cap nhat); entry cu da dong.
  const timeline = store.blocks.timelineFor(blockId);
  assert.equal(timeline.length, 2);
  assert.ok(timeline[0].validTo !== null);
  assert.equal(timeline[1].validTo, null);
  assert.equal(timeline[1].value, 'v2 — them muc tieu');
  // valueAt: truoc T1 thi v1, sau T1 thi v2.
  assert.equal(store.blocks.valueAt(blockId, new Date(T0 + 30_000).toISOString()).value, 'v1');
  assert.equal(store.blocks.valueAt(blockId, new Date(T2).toISOString()).value, 'v2 — them muc tieu');
  // Sync log co muc cho tung agent.
  const log = store.blocks.syncLogFor(blockId);
  assert.equal(log.length, 3);
  // Append fact: noi dong moi vao block, khong ghi de.
  const appended = store.blocks.appendFactToBlock(blockId, 'Huy likes coffee', 'bot-a', { nowMs: T2 });
  assert.equal(appended.ok, true);
  assert.match(store.v26.listBlocks().find((b) => b.id === blockId).value, /Huy likes coffee/);
  // Block chua dang ky thi cap nhat bi tu choi.
  const created2 = store.v26.registry.create(
    { label: 'chua-dang-ky', value: 'x', ownerBotId: 'bot-a', kind: 'custom' },
    { nowMs: T0 },
  );
  assert.equal(store.blocks.updateBlock(created2.value.block.id, 'y', 'bot-a', { nowMs: T2 }).ok, false);
  // Dang ky 2 lan thi loi.
  assert.equal(store.blocks.registerBlock(blockId, { nowMs: T2 }).ok, false);
});

test('v27 store: save/load giu nguyen fact + entity + episode + counters', () => {
  const dir = tmpDir();
  try {
    const store = new V27Store();
    const pipeline = new V27Pipeline(store);
    pipeline.ingestEpisode(
      { text: 'Huy likes coffee. Huy lives in Saigon.', source: 'chat', agentId: 'bot-a' },
      { nowMs: T0, by: 'bot-a' },
    );
    const saved = store.saveToDir(dir);
    assert.equal(saved.ok, true);
    const loaded = V27Store.loadFromDir(dir);
    assert.equal(loaded.ok, true);
    assert.equal(loaded.value.factsTotal, 2);
    assert.equal(loaded.value.episodesTotal, 1);
    assert.ok(loaded.value.entitiesTotal >= 1);
    assert.equal(loaded.value.stats().candidatesExtractedTotal, 2);
    // Load tu thu muc rong thi tra store rong (khong loi).
    const empty = V27Store.loadFromDir(join(dir, 'khong-co'));
    assert.equal(empty.ok, true);
    assert.equal(empty.value.factsTotal, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('v27 store: snapshot export/import add-only (khong ghi de cai cu)', () => {
  const store = new V27Store();
  const pipeline = new V27Pipeline(store);
  pipeline.ingestEpisode(
    { text: 'Huy likes coffee.', source: 'chat', agentId: 'bot-a' },
    { nowMs: T0, by: 'bot-a' },
  );
  const snap = store.snapshot();
  assert.equal(snap.version, '27.0.0');
  assert.equal(snap.facts.length, 1);
  // Import lai chinh snapshot cua minh: khong them gi (da co).
  const reimport = store.importSnapshot(snap);
  assert.equal(reimport.ok, true);
  assert.equal(reimport.value.factsAdded, 0);
  assert.equal(store.factsTotal, 1);
  // Import vao store khac: them duoc.
  const other = new V27Store();
  const imported = other.importSnapshot(snap);
  assert.equal(imported.value.factsAdded, 1);
  assert.equal(imported.value.episodesAdded, 1);
  assert.ok(imported.value.entitiesAdded >= 1);
  // Snapshot khong hop le thi loi.
  assert.equal(store.importSnapshot('khong-phai-object').ok, false);
});

test('v27 panel: build view — tong quan + top fact/entity/episode + history', () => {
  const store = new V27Store();
  const pipeline = new V27Pipeline(store);
  pipeline.ingestEpisode(
    { text: 'Huy likes coffee. Huy likes tea.', source: 'chat', agentId: 'bot-a' },
    { nowMs: T0, by: 'bot-a' },
  );
  const view = buildV27PanelView(store, { historySubject: 'Huy', historyPredicate: 'likes' });
  assert.equal(view.factsTotal, 2);
  assert.equal(view.factsActive, 1);
  assert.equal(view.factsSuperseded, 1);
  assert.equal(view.topFacts.length, 1);
  assert.equal(view.topFacts[0].object, 'tea');
  assert.ok(view.topEntities.some((e) => e.name === 'Huy'));
  assert.equal(view.recentEpisodes.length, 1);
  assert.equal(view.history.length, 2);
  assert.equal(view.history[0].object, 'coffee');
  assert.deepEqual(view.warnings, []);
  assert.match(view.summary, /memory v27/);
  // Revalidate: store khoe.
  assert.equal(pipeline.revalidate().ok, true);
  assert.match(pipeline.summary(), /memory v27/);
});
