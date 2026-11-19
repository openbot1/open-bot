/**
 * Tests for memory v24 — shared blocks + sleep (v1.39, Doi T1).
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/memory-v24-blocks-sleep-v139.test.mjs
 * No network. No model.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  V24SharedBlockStore,
  V24Store,
  blockFromMarkdownV24,
  blockToMarkdownV24,
  isLockLiveV24,
  isValidBlockNameV24,
  makeV24Scope,
  mergeBlockContentsV24,
  runV24Sleep,
  shouldRunSleepV24,
} from '../packages/core/dist/memory/v24/index.js';

const NOW = 1794000000000;
const DAY = 24 * 3600 * 1000;
const SCOPE = makeV24Scope({ userId: 'u1', agentId: 'bot-a' });

// --- Shared blocks ---

test('v24 block: ten hop le + tao + attach/detach', () => {
  assert.equal(isValidBlockNameV24('organization'), true);
  assert.equal(isValidBlockNameV24('current_plan'), true);
  assert.equal(isValidBlockNameV24('Bad Name!'), false);
  assert.equal(isValidBlockNameV24(''), false);
  const store = new V24SharedBlockStore({ now: () => NOW });
  const created = store.create({ name: 'organization', title: 'Organization', content: 'Team 5 nguoi.', scope: SCOPE, createdBy: 'bot-a' });
  assert.equal(created.ok, true);
  assert.equal(created.value.version, 1);
  assert.deepEqual(created.value.history.length, 1);
  const dup = store.create({ name: 'organization', title: 'X', content: 'Y', scope: SCOPE });
  assert.equal(dup.ok, false);
  const attached = store.attach(created.value.id, 'bot-b');
  assert.equal(attached.ok, true);
  assert.deepEqual(attached.value.attachedBotIds, ['bot-b']);
  const detached = store.detach(created.value.id, 'bot-b');
  assert.deepEqual(detached.value.attachedBotIds, []);
  assert.equal(store.getByName('organization', SCOPE).id, created.value.id);
});

test('v24 block: khoa lease + optimistic concurrency + history + revert', () => {
  let now = NOW;
  const store = new V24SharedBlockStore({ now: () => now });
  const created = store.create({ name: 'current_plan', title: 'Plan', content: 'Buoc 1.', scope: SCOPE, createdBy: 'bot-a' });
  const id = created.value.id;
  const lock = store.acquireLock(id, 'bot-a', { ttlMs: 60_000, reason: 'viet plan' });
  assert.equal(lock.ok, true);
  assert.equal(isLockLiveV24(store.get(id).lock, now), true);
  // Bot khac khong ghi duoc khi khoa song.
  const blocked = store.update(id, 'Bot B viet de.', { botId: 'bot-b' });
  assert.equal(blocked.ok, false);
  assert.ok(blocked.error.includes('bot-a'));
  // Sai expectedVersion -> loi version conflict.
  const wrongVersion = store.update(id, 'Bot A viet.', { botId: 'bot-a', expectedVersion: 99 });
  assert.equal(wrongVersion.ok, false);
  assert.ok(wrongVersion.error.includes('Version conflict'));
  // Ghi dung: version +1, history tang.
  const written = store.update(id, 'Buoc 1. Buoc 2.', { botId: 'bot-a', expectedVersion: 1, reason: 'them buoc 2' });
  assert.equal(written.ok, true);
  assert.equal(written.value.version, 2);
  assert.equal(store.history(id).length, 2);
  // Khoa het han -> bot khac ghi duoc.
  now += 120_000;
  assert.equal(isLockLiveV24(store.get(id).lock, now), false);
  assert.equal(store.releaseExpiredLocks(), 1);
  const written2 = store.update(id, 'Buoc 1. Buoc 2. Buoc 3.', { botId: 'bot-b' });
  assert.equal(written2.ok, true);
  assert.equal(written2.value.version, 3);
  // Revert ve v1.
  const reverted = store.revert(id, 1, 'bot-b');
  assert.equal(reverted.ok, true);
  assert.equal(reverted.value.version, 4);
  assert.equal(reverted.value.content, 'Buoc 1.');
  // Xoa: phai detach het bot truoc.
  store.attach(id, 'bot-a');
  const delBlocked = store.delete(id, 'bot-b');
  assert.equal(delBlocked.ok, false);
  store.detach(id, 'bot-a');
  assert.equal(store.delete(id, 'bot-b').ok, true);
  assert.equal(store.get(id), null);
});

test('v24 block: merge 3-way + markdown roundtrip', () => {
  const base = 'Dong A\nDong B';
  const mine = 'Dong A\nDong B\nDong C (mine)';
  const theirs = 'Dong A\nDong B\nDong D (theirs)';
  const merged = mergeBlockContentsV24(base, mine, theirs);
  assert.ok(merged.merged.includes('Dong C (mine)'));
  assert.ok(merged.merged.includes('Dong D (theirs)'));
  assert.ok(merged.merged.includes('Dong A'));
  const store = new V24SharedBlockStore({ now: () => NOW });
  const created = store.create({ name: 'notes', title: 'Notes', content: 'Hello.', scope: SCOPE, createdBy: 'bot-a' });
  const md = blockToMarkdownV24(created.value);
  assert.ok(md.startsWith('# Notes'));
  const parsed = blockFromMarkdownV24(md, 'notes', SCOPE, 'bot-a');
  assert.equal(parsed.title, 'Notes');
  assert.equal(parsed.content, 'Hello.');
});

test('v24 sleep: idle check', () => {
  assert.equal(shouldRunSleepV24(null, NOW), true);
  assert.equal(shouldRunSleepV24(NOW - 60_000, NOW), false);
  assert.equal(shouldRunSleepV24(NOW - 6 * 60_000, NOW), true);
});

// --- Sleep job ---

test('v24 sleep: decay + merge trung lap + promote + giai phong khoa', () => {
  let now = NOW;
  const blocks = new V24SharedBlockStore({ now: () => now });
  const store = new V24Store({ now: () => now, blocks });
  const prov = {
    episodeId: 'ep1', turnId: 't1', runId: '', botId: 'bot-a', userId: 'u1',
    sourceText: 'test', method: 'rule', extractor: 'v24-rule-v1',
  };
  // 1 fact hay duoc dung -> sleep promote (search 3 lan de tang accessCount).
  // Search NGAY sau khi put (luc store chi co 1 fact) de chi fact nay duoc access.
  const cand = { subject: 'user', edge: 'prefers', object: 'cà phê đen', kind: 'preference', confidence: 0.8, isNegation: false, validFrom: null, validTo: null, mentionedEntities: [], sourceText: 'Tôi thích cà phê đen.', reason: 'test' };
  const popular = store.putFact(
    { ...cand, object: 'cà phê sữa', kind: 'preference' },
    { scope: SCOPE, provenance: prov },
  ).value;
  store.search('cà phê sữa', { nowMs: NOW });
  store.search('cà phê sữa', { nowMs: NOW });
  store.search('cà phê sữa', { nowMs: NOW });
  assert.equal(store.getFact(popular.id).accessCount, 3);
  // 2 fact trung lap chinh xac -> sleep gop 1.
  store.putFact(cand, { scope: SCOPE, provenance: prov });
  store.putFact(cand, { scope: SCOPE, provenance: prov });
  // 1 fact het han -> sleep archive.
  store.putFact(
    { ...cand, object: 'trà sữa', kind: 'preference' },
    { scope: SCOPE, provenance: prov, expiresAt: new Date(NOW - DAY).toISOString() },
  );
  // 1 block bi khoa het han.
  const block = blocks.create({ name: 'plan', title: 'Plan', content: 'X', scope: SCOPE, createdBy: 'bot-a' }).value;
  blocks.acquireLock(block.id, 'bot-a', { ttlMs: 1000 });
  now += 5000;

  const report = runV24Sleep(store, { force: true, nowMs: now, lastActivityAtMs: now - 10 * 60_000 });
  assert.equal(report.idleTriggered, false);
  assert.equal(report.merged, 1, `merge=${report.merged}`);
  assert.equal(report.archived, 1, `archived=${report.archived}`);
  assert.equal(report.promoted, 1, `promoted=${report.promoted}`);
  assert.equal(report.locksReleased, 1, `locks=${report.locksReleased}`);
  assert.ok(store.getFact(popular.id).importance > 0.5);
  assert.equal(report.budgetHit, false);
  assert.ok(report.actions.length > 0);
});

test('v24 sleep: chua idle thi bo qua; budget nho thi budgetHit', () => {
  const store = new V24Store({ now: () => NOW });
  const skipped = runV24Sleep(store, { nowMs: NOW, lastActivityAtMs: NOW - 60_000 });
  assert.equal(skipped.scanned, 0);
  assert.ok(skipped.actions[0].detail.includes('Chua du idle'));

  const prov = {
    episodeId: 'ep1', turnId: 't1', runId: '', botId: 'bot-a', userId: 'u1',
    sourceText: 'test', method: 'rule', extractor: 'v24-rule-v1',
  };
  for (let i = 0; i < 5; i++) {
    store.putFact(
      { subject: 'user', edge: 'owns', object: `do ${i}`, kind: 'fact', confidence: 0.05, isNegation: false, validFrom: null, validTo: null, mentionedEntities: [], sourceText: 'test', reason: 'test' },
      { scope: SCOPE, provenance: prov, expiresAt: new Date(NOW - DAY).toISOString() },
    );
  }
  const tiny = runV24Sleep(store, { force: true, nowMs: NOW, maxOps: 1 });
  assert.equal(tiny.budgetHit, true);
});
