/**
 * Tests for memory v28 — time-travel (v1.44, Doi T1).
 * packages/core/src/memory/v28/timeTravel.ts
 *
 * Run after building core:
 *   node node_modules/typescript/bin/tsc -p packages/core/tsconfig.json --incremental
 *   node --test tests/memory-v28-timetravel-v144.test.mjs
 * No network. No model. Uses temp dirs under os.tmpdir().
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { V28Store } from '../packages/core/dist/memory/v28/index.js';

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'openbot-v28-tt-'));
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

function makeStore(dir) {
  return new V28Store({ rootDir: dir, botId: 'bot-a' });
}

test('v28 time-travel: get_state_at tra dung block + fact tai thoi diem', async () => {
  const dir = tmpDir();
  try {
    const store = makeStore(dir);
    store.gitStore.writeBlock('notes', 'version one', { actor: 'user', message: 'v1' });
    await new Promise((resolve) => setTimeout(resolve, 1200));
    store.gitStore.writeBlock('notes', 'version two', { actor: 'user', message: 'v2' });
    const fact = store.facts.addFact({
      subject: 'user',
      predicate: 'likes',
      object: 'pho',
      botId: 'bot-a',
      validFrom: '2026-01-01T00:00:00.000Z',
    });
    assert.equal(fact.ok, true);

    // Tai hien tai: block v2 + fact active.
    const now = store.timeTravel.getStateAt(new Date().toISOString());
    assert.equal(now.ok, true);
    assert.equal(now.value.blocks.find((b) => b.label === 'notes')?.version, 2);
    assert.equal(now.value.blocks.find((b) => b.label === 'notes')?.content, 'version two');
    assert.equal(now.value.facts.length, 1);

    // Tai 2025 (truoc khi fact co hieu luc + truoc khi block ton tai theo git):
    // block chua ton tai tai 2025 (commit 2026) -> khong co block nao; fact chua valid -> 0 fact.
    const past = store.timeTravel.getStateAt('2025-06-01T00:00:00.000Z');
    assert.equal(past.ok, true);
    assert.equal(past.value.blocks.length, 0);
    assert.equal(past.value.facts.length, 0);

    // Thoi diem khong hop le thi loi.
    assert.equal(store.timeTravel.getStateAt('not-a-date').ok, false);
  } finally {
    cleanup(dir);
  }
});

test('v28 time-travel: diff_timerange thay ro block doi + fact them/vo hieu', () => {
  const dir = tmpDir();
  try {
    const store = makeStore(dir);
    // Moc thoi gian la "bay gio": lay state truoc/sau thay doi that
    // (createdAt/invalidatedAt that cua fact, commit that cua block).
    const before = new Date(Date.now() - 1000).toISOString();
    store.gitStore.writeBlock('log', 'entry one', { actor: 'user' });
    const added = store.facts.addFact({ subject: 'user', predicate: 'likes', object: 'tea', botId: 'bot-a' });
    const added2 = store.facts.addFact({ subject: 'user', predicate: 'likes', object: 'bun cha', botId: 'bot-a' });
    store.facts.invalidateFact(added2.value.id, { reason: 'outdated', by: 'user' });
    const after = new Date().toISOString();

    const diff = store.timeTravel.diffTimerange(before, after);
    assert.equal(diff.ok, true);
    assert.equal(diff.value.blocksAdded, 1);
    assert.equal(diff.value.factsAdded, 2);
    assert.equal(diff.value.factsInvalidated, 1);
    const kinds = diff.value.entries.map((e) => `${e.kind}:${e.change}`);
    assert.ok(kinds.includes('block:added'));
    assert.ok(kinds.includes('fact:added'));
    assert.ok(kinds.includes('fact:invalidated'));

    // from > to thi loi.
    assert.equal(store.timeTravel.diffTimerange(after, before).ok, false);
  } finally {
    cleanup(dir);
  }
});

test('v28 time-travel: blockTimeline + factTimeline ke ro lich su', async () => {
  const dir = tmpDir();
  try {
    const store = makeStore(dir);
    store.gitStore.writeBlock('story', 'chapter 1', { actor: 'user', message: 'c1' });
    await new Promise((resolve) => setTimeout(resolve, 1200));
    store.gitStore.writeBlock('story', 'chapter 2', { actor: 'user', message: 'c2' });

    const timeline = store.timeTravel.blockTimeline('story');
    assert.equal(timeline.length, 2);
    assert.equal(timeline[0].version, 2);
    assert.match(timeline[0].content, /chapter 2/);
    assert.equal(timeline[1].version, 1);
    assert.match(timeline[1].content, /chapter 1/);

    const old = store.facts.addFact({ subject: 'user', predicate: 'lives-in', object: 'Hanoi', botId: 'bot-a' });
    store.facts.supersedeFact(
      old.value.id,
      { subject: 'user', predicate: 'lives-in', object: 'Saigon', source: 'user', botId: 'bot-a' },
      { by: 'user' },
    );
    const factTimeline = store.timeTravel.factTimeline('user');
    assert.equal(factTimeline.length, 2);
    assert.match(factTimeline[0].validWindow, /Hanoi|2026/);
    assert.equal(factTimeline[0].fact.status, 'superseded');
    assert.equal(factTimeline[1].fact.status, 'active');
    assert.equal(factTimeline[1].fact.object, 'Saigon');
  } finally {
    cleanup(dir);
  }
});

test('v28 time-travel: knownLabels gom ca block da archive', () => {
  const dir = tmpDir();
  try {
    const store = makeStore(dir);
    store.gitStore.writeBlock('keep', 'v1', { actor: 'user' });
    store.gitStore.writeBlock('gone', 'v1', { actor: 'user' });
    store.gitStore.archiveBlock('gone', { actor: 'user' });
    const labels = store.timeTravel.knownLabels();
    assert.ok(labels.includes('keep'));
    assert.ok(labels.includes('gone'));
    const state = store.timeTravel.getStateAt(new Date().toISOString());
    assert.equal(state.ok, true);
    // Block da archive khong con trong state hien tai.
    assert.equal(state.value.blocks.some((b) => b.label === 'gone'), false);
    assert.equal(state.value.blocks.some((b) => b.label === 'keep'), true);
  } finally {
    cleanup(dir);
  }
});
