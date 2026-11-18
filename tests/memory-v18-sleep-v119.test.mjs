/**
 * Tests for v1.19 (Team T1-TEST, wave 4) — memory v18 sleep-time
 * consolidation v2:
 * packages/core/src/memory/v18/sleepConsolidationV2.ts
 *
 * Covers:
 *  - findDuplicateFactGroupsV18 (same subject+predicate+object,
 *    non-active excluded, no duplicates -> []).
 *  - pickKeepFactV18 (highest confidence wins, then newest).
 *  - isStaleFactV18 (boundary by days, bad date -> false).
 *  - runSleepConsolidationV18 (merges duplicates, reports counts,
 *    respects maxMergesPerRun budget, writes the JSONL run log,
 *    does not delete anything, decay path via config).
 *  - Defaults (V18_SLEEP_DEFAULT_MIN_CONFIDENCE = 0.2, etc.).
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/memory-v18-sleep-v119.test.mjs
 *
 * No network. No model.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  TemporalGraphStore,
  InMemoryGraphBackend,
  findDuplicateFactGroupsV18,
  pickKeepFactV18,
  isStaleFactV18,
  runSleepConsolidationV18,
  V18SleepConsolidationError,
  V18_SLEEP_CONSOLIDATION_RUNS_REL_PATH,
  V18_DEFAULT_MAX_FACTS_PER_RUN,
  V18_DEFAULT_MAX_MERGES_PER_RUN,
  V18_DEFAULT_MAX_MS_PER_RUN,
  V18_DEFAULT_STALE_AFTER_DAYS,
  V18_DEFAULT_DECAY_STEP,
  V18_SLEEP_DEFAULT_MIN_CONFIDENCE,
  V18_DEFAULT_SLEEP_CONSOLIDATION_CONFIG,
} from '../packages/core/dist/index.js';

const SCOPE = { userId: 'u1', botId: 'b1', runId: 'r1' };

function freshStore() {
  return new TemporalGraphStore(new InMemoryGraphBackend());
}

function prov(sourceText) {
  return {
    episodeId: 'e1',
    turnId: 't1',
    runId: 'r1',
    botId: 'b1',
    userId: 'u1',
    at: '2026-01-01T00:00:00.000Z',
    sourceText,
  };
}

function seedFact(store, subject, predicate, objectText, opts = {}) {
  return store.addFact({
    subjectName: subject,
    predicate,
    objectText,
    confidence: opts.confidence ?? 0.9,
    scope: SCOPE,
    provenance: prov(opts.sourceText ?? `${subject} ${predicate} ${objectText}.`),
    validFrom: opts.validFrom ?? '2025-01-01T00:00:00.000Z',
  });
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'v18-sleep-'));
}

test('v18 sleep: defaults + error name', () => {
  assert.equal(V18_DEFAULT_MAX_FACTS_PER_RUN, 2000);
  assert.equal(V18_DEFAULT_MAX_MERGES_PER_RUN, 50);
  assert.equal(V18_DEFAULT_MAX_MS_PER_RUN, 30_000);
  assert.equal(V18_DEFAULT_STALE_AFTER_DAYS, 90);
  assert.equal(V18_DEFAULT_DECAY_STEP, 0.1);
  assert.equal(V18_SLEEP_DEFAULT_MIN_CONFIDENCE, 0.2);
  assert.equal(V18_SLEEP_CONSOLIDATION_RUNS_REL_PATH, path.join('.open-bot', 'memory-sleep-consolidation-v18.jsonl'));
  assert.deepEqual(V18_DEFAULT_SLEEP_CONSOLIDATION_CONFIG, {
    maxFactsPerRun: 2000,
    maxMergesPerRun: 50,
    maxMsPerRun: 30_000,
    staleAfterDays: 90,
    decayStep: 0.1,
    minConfidence: 0.2,
    mergeEntities: false,
    mergeEntityThreshold: 0.95,
  });
  const err = new V18SleepConsolidationError('boom');
  assert.equal(err.name, 'V18SleepConsolidationError');
});

test('v18 sleep: findDuplicateFactGroupsV18 groups exact duplicates only', () => {
  const store = freshStore();
  const a = seedFact(store, 'An', 'likes', 'phở bò', { confidence: 0.9 });
  const b = seedFact(store, 'An', 'likes', 'phở bò', { confidence: 0.7 });
  seedFact(store, 'An', 'likes', 'cơm tấm');
  seedFact(store, 'Binh', 'likes', 'phở bò');
  const groups = findDuplicateFactGroupsV18(store.listFacts({ limit: 100 }));
  assert.equal(groups.length, 1);
  assert.equal(groups[0].length, 2);
  assert.deepEqual(new Set(groups[0].map((f) => f.id)), new Set([a.id, b.id]));
  assert.deepEqual(findDuplicateFactGroupsV18([]), []);
  const single = freshStore();
  seedFact(single, 'An', 'likes', 'phở bò');
  assert.deepEqual(findDuplicateFactGroupsV18(single.listFacts({ limit: 100 })), []);
});

test('v18 sleep: findDuplicateFactGroupsV18 ignores non-active facts', () => {
  const store = freshStore();
  seedFact(store, 'An', 'likes', 'phở bò', { confidence: 0.9 });
  const dup = seedFact(store, 'An', 'likes', 'phở bò', { confidence: 0.7 });
  store.deleteFact(dup.id, 'test');
  assert.deepEqual(findDuplicateFactGroupsV18(store.listFacts({ limit: 100 })), []);
});

test('v18 sleep: pickKeepFactV18 keeps highest confidence, then newest', () => {
  const store = freshStore();
  const low = seedFact(store, 'An', 'likes', 'phở bò', { confidence: 0.7 });
  const high = seedFact(store, 'An', 'likes', 'phở bò', { confidence: 0.9 });
  assert.equal(pickKeepFactV18([low, high]).id, high.id);
  assert.equal(pickKeepFactV18([high, low]).id, high.id);
  const older = { ...high, updatedAt: '2026-01-01T00:00:00.000Z' };
  const newer = { ...high, id: 'other-id', updatedAt: '2026-06-01T00:00:00.000Z' };
  assert.equal(pickKeepFactV18([older, newer]).id, 'other-id');
});

test('v18 sleep: isStaleFactV18 uses the day threshold', () => {
  const fact = {
    updatedAt: '2025-01-01T00:00:00.000Z',
  };
  const now = Date.parse('2026-06-01T00:00:00.000Z');
  assert.equal(isStaleFactV18(fact, now, 90), true);
  assert.equal(isStaleFactV18(fact, now, 600), false);
  assert.equal(isStaleFactV18({ updatedAt: '2026-05-31T00:00:00.000Z' }, now, 90), false);
  assert.equal(isStaleFactV18({ updatedAt: 'not-a-date' }, now, 90), false);
});

test('v18 sleep: run merges one duplicate group and reports it', () => {
  const store = freshStore();
  seedFact(store, 'An', 'likes', 'phở bò', { confidence: 0.9 });
  seedFact(store, 'An', 'likes', 'phở bò', { confidence: 0.7 });
  seedFact(store, 'An', 'likes', 'cơm tấm');
  assert.equal(store.listFacts({ status: 'active', limit: 100 }).length, 3);
  const report = runSleepConsolidationV18(store, SCOPE);
  assert.equal(report.factsScanned, 3);
  assert.equal(report.duplicateGroups, 1);
  assert.equal(report.factsMerged, 1);
  assert.equal(report.factsDecayed, 0);
  assert.equal(report.factsBelowMin, 0);
  assert.equal(report.entitiesMerged, 0);
  assert.equal(report.budgetExhausted, false);
  assert.equal(report.stoppedBecause, 'done');
  assert.ok(report.durationMs >= 0);
  assert.equal(store.listFacts({ status: 'active', limit: 100 }).length, 2, 'duplicate merged away');
  assert.equal(store.listFacts({ limit: 100 }).length, 3, 'nothing hard-deleted');
});

test('v18 sleep: run on a clean store reports zeroes', () => {
  const store = freshStore();
  seedFact(store, 'An', 'likes', 'phở bò');
  const report = runSleepConsolidationV18(store, SCOPE);
  assert.equal(report.factsScanned, 1);
  assert.equal(report.duplicateGroups, 0);
  assert.equal(report.factsMerged, 0);
  assert.equal(report.stoppedBecause, 'done');
});

test('v18 sleep: maxMergesPerRun budget stops after one merge', () => {
  const store = freshStore();
  for (let i = 0; i < 3; i += 1) {
    seedFact(store, 'An', 'likes', 'phở bò', { confidence: 0.9 - i * 0.1 });
  }
  for (let i = 0; i < 3; i += 1) {
    seedFact(store, 'An', 'likes', 'cơm tấm', { confidence: 0.9 - i * 0.1 });
  }
  const report = runSleepConsolidationV18(store, SCOPE, { maxMergesPerRun: 1 });
  assert.equal(report.duplicateGroups, 2);
  assert.equal(report.factsMerged, 2, 'first group of 3 merges 2 duplicates, then budget stops');
  assert.equal(report.budgetExhausted, true);
  assert.match(report.stoppedBecause, /het budget gop/);
});

test('v18 sleep: run writes a JSONL log line when workspaceDir is given', () => {
  const store = freshStore();
  seedFact(store, 'An', 'likes', 'phở bò');
  const dir = tmpDir();
  const report = runSleepConsolidationV18(store, SCOPE, {}, { workspaceDir: dir });
  const logPath = path.join(dir, V18_SLEEP_CONSOLIDATION_RUNS_REL_PATH);
  assert.ok(fs.existsSync(logPath));
  const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  const logged = JSON.parse(lines[0]);
  assert.equal(logged.factsScanned, report.factsScanned);
  assert.equal(logged.stoppedBecause, 'done');
});

test('v18 sleep: maxFactsPerRun caps the scan', () => {
  const store = freshStore();
  seedFact(store, 'An', 'likes', 'phở bò');
  seedFact(store, 'An', 'likes', 'cơm tấm');
  seedFact(store, 'An', 'lives_in', 'Hà Nội');
  const report = runSleepConsolidationV18(store, SCOPE, { maxFactsPerRun: 2 });
  assert.equal(report.factsScanned, 2);
});
