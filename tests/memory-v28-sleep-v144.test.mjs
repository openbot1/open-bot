/**
 * Tests for memory v28 — sleep-time consolidation (v1.44, Doi T1).
 * packages/core/src/memory/v28/sleepConsolidation.ts
 *
 * Run after building core:
 *   node node_modules/typescript/bin/tsc -p packages/core/tsconfig.json --incremental
 *   node --test tests/memory-v28-sleep-v144.test.mjs
 * No network. No model. Uses temp dirs under os.tmpdir().
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  V28Store,
  extractSleepCandidatesV28,
  shouldSleepRunNowV28,
  summarizeSleepCandidatesV28,
  nextSleepRunAtV28,
} from '../packages/core/dist/memory/v28/index.js';

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'openbot-v28-sleep-'));
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

function makeStore(dir) {
  return new V28Store({ rootDir: dir, botId: 'bot-a' });
}

const EPISODES = [
  { id: 'ep1', text: 'Hi, my name is Huy. I really like pho and I live in Ho Chi Minh City.', botId: 'bot-a', at: new Date().toISOString() },
  { id: 'ep2', text: 'Tôi rất thích cà phê sữa đá. Tôi nói được tiếng Việt và tiếng Anh.', botId: 'bot-a', at: new Date().toISOString() },
  { id: 'ep3', text: 'Nothing to remember here, just small talk about the weather today.', botId: 'bot-a', at: new Date().toISOString() },
];

test('v28 sleep: extract candidate tu episode EN + VI (moi cau 1 lan)', () => {
  const candidates = extractSleepCandidatesV28(EPISODES[0]);
  const predicates = candidates.map((c) => c.predicate);
  assert.ok(predicates.includes('name-is'));
  assert.ok(predicates.includes('likes'));
  assert.ok(predicates.includes('lives-in'));
  const name = candidates.find((c) => c.predicate === 'name-is');
  assert.equal(name.object, 'Huy');
  const likes = candidates.find((c) => c.predicate === 'likes');
  assert.match(likes.object, /pho/);

  const vi = extractSleepCandidatesV28(EPISODES[1]);
  assert.ok(vi.some((c) => c.predicate === 'likes'));
  assert.ok(vi.some((c) => c.predicate === 'speaks'));

  // Cau chuyen phim khong trich duoc gi.
  assert.equal(extractSleepCandidatesV28(EPISODES[2]).length, 0);
});

test('v28 sleep: shouldRunNow — tat / chua du idle / dang ban / du dieu kien', () => {
  const base = {
    now: new Date('2026-11-19T03:00:00'),
    idleMinutes: 30,
    activeBots: 0,
    lastRunAt: null,
    botId: 'bot-a',
  };
  const off = shouldSleepRunNowV28({ enabled: false }, base);
  assert.equal(off.run, false);
  assert.match(off.reason, /tat/);

  const config = { enabled: true, minIdleMinutes: 15, onlyInQuietHours: false, quietHoursStart: 1, quietHoursEnd: 5, allowedBotIds: [] };
  const notIdle = shouldSleepRunNowV28(config, { ...base, idleMinutes: 5 });
  assert.equal(notIdle.run, false);
  assert.match(notIdle.reason, /idle/);

  const busy = shouldSleepRunNowV28(config, { ...base, activeBots: 2 });
  assert.equal(busy.run, false);
  assert.match(busy.reason, /dang chay/);

  const ok = shouldSleepRunNowV28(config, base);
  assert.equal(ok.run, true);

  const quietOnly = shouldSleepRunNowV28(
    { ...config, onlyInQuietHours: true },
    { ...base, now: new Date('2026-11-19T10:00:00') },
  );
  assert.equal(quietOnly.run, false);
  assert.match(quietOnly.reason, /quiet hours/);

  const notAllowed = shouldSleepRunNowV28({ ...config, allowedBotIds: ['bot-z'] }, base);
  assert.equal(notAllowed.run, false);

  // Vua chay xong (5 phut truoc, trong khoang minIdleMinutes) thi chua chay lai.
  const recent = shouldSleepRunNowV28(config, {
    ...base,
    lastRunAt: new Date(base.now.getTime() - 5 * 60_000).toISOString(),
  });
  assert.equal(recent.run, false);
});

test('v28 sleep: nextRunAt ton trong minIdleMinutes + quiet hours', () => {
  const config = { enabled: true, minIdleMinutes: 15, onlyInQuietHours: false, quietHoursStart: 1, quietHoursEnd: 5 };
  const now = new Date('2026-11-19T10:00:00');
  const next = nextSleepRunAtV28(config, null, now);
  assert.equal(next.getTime(), now.getTime() + 15 * 60_000);

  const quiet = nextSleepRunAtV28({ ...config, onlyInQuietHours: true }, null, now);
  // 10:00 ngoai quiet hours (1-5h) -> doi den 1h sang hom sau.
  assert.equal(quiet.getHours(), 1);
  assert.equal(quiet.getDate(), 20);
});

test('v28 sleep: dry-run chi bao cao, khong ghi fact nao', () => {
  const dir = tmpDir();
  try {
    const store = makeStore(dir);
    const report = store.sleep.consolidate(EPISODES, { dryRun: true, botId: 'bot-a' });
    assert.equal(report.dryRun, true);
    assert.equal(report.episodesScanned, 3);
    assert.ok(report.candidatesExtracted >= 4);
    assert.ok(report.factsAdded >= 1);
    assert.equal(store.facts.size, 0);
    assert.equal(store.gitStore.listBlocks().length, 0);
    assert.equal(store.sleep.lastRun, null);
  } finally {
    cleanup(dir);
  }
});

test('v28 sleep: run that — them fact + promote tom tat vao block human', () => {
  const dir = tmpDir();
  try {
    const store = makeStore(dir);
    store.sleep.updateConfig({ enabled: true });
    const report = store.sleep.consolidate(EPISODES, { botId: 'bot-a' });
    assert.equal(report.dryRun, false);
    assert.ok(report.factsAdded >= 4, `ky vong >= 4 fact, duoc ${report.factsAdded}`);
    assert.equal(report.duplicatesSkipped, 0);
    assert.equal(store.facts.activeCount, report.factsAdded);
    assert.equal(report.summaryPromoted, true);
    const human = store.gitStore.readBlock('human');
    assert.ok(human);
    assert.match(human.content, /Sleep consolidation/);
    assert.match(human.content, /likes/);
    assert.ok(store.sleep.lastRun);
    assert.equal(store.sleep.runsTotal, 1);

    // Chay lai cung episode: tat ca deu trung -> khong them fact moi.
    const second = store.sleep.consolidate(EPISODES, { botId: 'bot-a' });
    assert.equal(second.factsAdded, 0);
    assert.ok(second.duplicatesSkipped >= 4);
    assert.equal(store.facts.size, report.factsAdded);
  } finally {
    cleanup(dir);
  }
});

test('v28 sleep: xung dot — supersede fact cu thay vi ghi de', () => {
  const dir = tmpDir();
  try {
    const store = makeStore(dir);
    store.sleep.updateConfig({ enabled: true });
    const old = store.facts.addFact({ subject: 'user', predicate: 'likes', object: 'tea', botId: 'bot-a' });
    assert.equal(old.ok, true);
    const report = store.sleep.consolidate(
      [{ id: 'ep-x', text: 'I really like coffee now.', botId: 'bot-a', at: new Date().toISOString() }],
      { botId: 'bot-a' },
    );
    assert.equal(report.factsSuperseded, 1);
    assert.equal(report.factsInvalidated, 1);
    assert.equal(store.facts.get(old.value.id).status, 'superseded');
    const current = store.facts.factsForSubjectPredicate('user', 'likes').filter((f) => f.status === 'active');
    assert.equal(current.length, 1);
    assert.equal(current[0].object, 'coffee');
  } finally {
    cleanup(dir);
  }
});

test('v28 sleep: summarize gom theo subject + updateConfig chan gia tri vo ly', () => {
  const lines = summarizeSleepCandidatesV28([
    { subject: 'user', predicate: 'likes', object: 'pho', text: 'I like pho', confidence: 0.9, episodeId: 'e1', pattern: 'likes-en' },
    { subject: 'user', predicate: 'speaks', object: 'Vietnamese', text: 'I speak Vietnamese', confidence: 0.9, episodeId: 'e1', pattern: 'speaks-en' },
  ]);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /likes pho/);
  assert.match(lines[0], /speaks Vietnamese/);

  const dir = tmpDir();
  try {
    const store = makeStore(dir);
    const updated = store.sleep.updateConfig({ minIdleMinutes: 0, maxFactsPerRun: 99999, dedupeThreshold: 2, quietHoursStart: 99 });
    assert.equal(updated.minIdleMinutes, 1);
    assert.equal(updated.maxFactsPerRun, 500);
    assert.equal(updated.dedupeThreshold, 1);
    assert.equal(updated.quietHoursStart, 23);
  } finally {
    cleanup(dir);
  }
});

test('v28 sleep: snapshot save/load giu config + lastRun', () => {
  const dir = tmpDir();
  try {
    const first = makeStore(dir);
    first.sleep.updateConfig({ enabled: true, minIdleMinutes: 30 });
    first.sleep.consolidate(EPISODES.slice(0, 1), { botId: 'bot-a' });
    const saved = first.saveSnapshot();
    assert.equal(saved.facts >= 1, true);
    const second = makeStore(dir);
    const restored = second.restoreFromDisk();
    assert.equal(restored.ok, true);
    assert.equal(second.sleep.config.enabled, true);
    assert.equal(second.sleep.config.minIdleMinutes, 30);
    assert.ok(second.sleep.lastRun);
    assert.equal(second.facts.size, first.facts.size);
  } finally {
    cleanup(dir);
  }
});
