/**
 * Tests for memory v19 — async consolidation + supersedes (v1.20, Đội T1):
 * packages/core/src/memory/v19/{consolidationAsync,supersedes}.ts
 *
 * Covers:
 *  - decayConfidenceV19: half-life math (0.8 -> 0.4 sau 1 half-life),
 *    age 0 = khong doi, clamp [0,1].
 *  - findConflictGroupsV19: chi predicate don tri (lives_in) moi
 *    thanh nhom mau thuan; predicate da tri (likes) thi khong.
 *  - runConsolidationPassV19: dedup (gop fact trung), giai quyet
 *    mau thuan (thang o lai, thua bi invalidate), giu ca hai khi
 *    gap < minConflictGap, decay ham mu cho fact cu, dem below-min
 *    (khong xoa), het budget (maxMergesPerRun), ghi log JSONL +
 *    doc lai.
 *  - runConsolidationAsyncV19: job chay xong (status done),
 *    cancel truoc khi chay -> cancelled.
 *  - supersedes: topicKeyV19, added / no-change / superseded /
 *    rejected-weak / forced, lich su 2 phien ban, rollback tao
 *    phien ban moi copy noi dung cu.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/memory-v19-consolidation-supersedes-v120.test.mjs
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
  decayConfidenceV19,
  findConflictGroupsV19,
  pickConflictWinnerV19,
  runConsolidationPassV19,
  runConsolidationAsyncV19,
  readConsolidationRunLogV19,
  formatV19ConsolidationReport,
  topicKeyV19,
  findSupersedeCandidatesV19,
  applySupersedeV19,
  supersedeHistoryV19,
  rollbackSupersedeV19,
  formatV19SupersedeRecord,
  V19_DEFAULT_MIN_CONFLICT_GAP,
} from '../packages/core/dist/index.js';

const SCOPE = { userId: 'u1', botId: 'b1', runId: 'r1' };

function freshStore() {
  return new TemporalGraphStore(new InMemoryGraphBackend());
}

function seedFact(store, subject, predicate, objectText, opts = {}) {
  const { id: episodeId } = store.ingestEpisode({
    turnId: opts.episodeId ?? 'e1',
    runId: 'r1',
    botId: 'b1',
    userId: 'u1',
    role: 'user',
    text: `${subject} ${predicate} ${objectText}.`,
  });
  return store.addFact({
    subjectName: subject,
    predicate,
    objectText,
    confidence: opts.confidence ?? 0.9,
    scope: SCOPE,
    provenance: {
      episodeId,
      turnId: opts.episodeId ?? 'e1',
      runId: 'r1',
      botId: 'b1',
      userId: 'u1',
      at: '2026-01-01T00:00:00.000Z',
      sourceText: `${subject} ${predicate} ${objectText}.`,
    },
    validFrom: opts.validFrom ?? '2025-01-01T00:00:00.000Z',
  });
}

function candidate(subject, predicate, objectText, confidence, extra = {}) {
  return {
    subject,
    predicate,
    objectText,
    confidence,
    effectiveConfidence: confidence,
    sourceTrust: 1,
    sourceText: `${subject} ${predicate} ${objectText}.`,
    pattern: 'test',
    origin: 'rule',
    intent: 'assert',
    ...extra,
  };
}

// --- decay ------------------------------------------------------------

test('v19 consolidation: decayConfidenceV19 half-life math', () => {
  assert.equal(decayConfidenceV19(0.8, 180, 180), 0.4);
  assert.equal(decayConfidenceV19(0.8, 0, 180), 0.8);
  assert.equal(decayConfidenceV19(0.8, 360, 180), 0.2);
  assert.ok(decayConfidenceV19(1.5, 0, 180) <= 1);
  assert.ok(decayConfidenceV19(-0.5, 0, 180) >= 0);
});

// --- conflict groups ---------------------------------------------------

test('v19 consolidation: findConflictGroupsV19 chi xet predicate don tri', () => {
  const store = freshStore();
  seedFact(store, 'An', 'lives_in', 'Ha Noi', { confidence: 0.9 });
  seedFact(store, 'An', 'lives_in', 'Sai Gon', { confidence: 0.6 });
  seedFact(store, 'An', 'likes', 'pho', { confidence: 0.9 });
  seedFact(store, 'An', 'likes', 'bun cha', { confidence: 0.9 });
  const groups = findConflictGroupsV19(store.listFacts({ ...SCOPE, status: 'active' }));
  assert.equal(groups.length, 1);
  assert.equal(groups[0].length, 2);
  assert.equal(pickConflictWinnerV19(groups[0]).objectText, 'Ha Noi');
});

// --- sync pass: dedup + conflicts + decay ------------------------------

test('v19 consolidation: sync pass gop fact trung', () => {
  const store = freshStore();
  const a = seedFact(store, 'An', 'lives_in', 'Ha Noi', { confidence: 0.9 });
  seedFact(store, 'An', 'lives_in', 'Ha Noi', { confidence: 0.7 });
  const report = runConsolidationPassV19(store, SCOPE);
  assert.equal(report.duplicateGroups, 1);
  assert.equal(report.factsMerged, 1);
  assert.equal(report.stoppedBecause, 'done');
  assert.equal(store.getFact(a.id)?.status, 'active');
  const actives = store.listFacts({ ...SCOPE, status: 'active' });
  assert.equal(actives.filter((f) => f.predicate === 'lives_in').length, 1);
});

test('v19 consolidation: sync pass giai quyet mau thuan (thang o lai)', () => {
  const store = freshStore();
  const winner = seedFact(store, 'An', 'lives_in', 'Ha Noi', { confidence: 0.9 });
  const loser = seedFact(store, 'An', 'lives_in', 'Sai Gon', { confidence: 0.6 });
  const report = runConsolidationPassV19(store, SCOPE);
  assert.equal(report.conflictsResolved, 1);
  assert.equal(report.factsInvalidated, 1);
  assert.equal(report.conflictsUnresolved, 0);
  assert.equal(store.getFact(winner.id)?.status, 'active');
  const loserAfter = store.getFact(loser.id);
  assert.ok(loserAfter?.invalidAt !== undefined);
  assert.match(loserAfter?.invalidationReason ?? '', new RegExp(winner.id));
});

test('v19 consolidation: gap nho hon nguong thi giu ca hai', () => {
  const store = freshStore();
  seedFact(store, 'An', 'lives_in', 'Ha Noi', { confidence: 0.9 });
  seedFact(store, 'An', 'lives_in', 'Sai Gon', { confidence: 0.88 });
  const report = runConsolidationPassV19(store, SCOPE, {
    minConflictGap: V19_DEFAULT_MIN_CONFLICT_GAP,
  });
  assert.equal(report.conflictsUnresolved, 1);
  assert.equal(report.conflictsResolved, 0);
  assert.equal(report.factsInvalidated, 0);
  assert.equal(store.listFacts({ ...SCOPE, status: 'active' }).length, 2);
});

test('v19 consolidation: decay fact cu, dem below-min ma khong xoa', () => {
  const store = freshStore();
  const old = seedFact(store, 'An', 'likes', 'pho', { confidence: 0.25 });
  // now = 200 ngay sau updatedAt (fact moi tao, updatedAt = now thuc).
  const now = new Date(Date.now() + 200 * 24 * 60 * 60 * 1000);
  const report = runConsolidationPassV19(store, SCOPE, {}, { now });
  assert.equal(report.factsDecayed, 1);
  assert.equal(report.factsBelowMin, 1);
  const after = store.getFact(old.id);
  assert.ok(after !== undefined && after.confidence < 0.25 && after.confidence > 0);
  assert.equal(after.status, 'active'); // chi dem, khong xoa/invalidate
});

test('v19 consolidation: het budget gop thi dung som, bao cao ro', () => {
  const store = freshStore();
  seedFact(store, 'An', 'lives_in', 'Ha Noi', { confidence: 0.9 });
  seedFact(store, 'An', 'lives_in', 'Ha Noi', { confidence: 0.8 });
  seedFact(store, 'Binh', 'lives_in', 'Hue', { confidence: 0.9 });
  seedFact(store, 'Binh', 'lives_in', 'Hue', { confidence: 0.8 });
  const report = runConsolidationPassV19(store, SCOPE, { maxMergesPerRun: 1 });
  assert.equal(report.factsMerged, 1);
  assert.equal(report.budgetExhausted, true);
  assert.match(report.stoppedBecause, /budget/);
});

test('v19 consolidation: log JSONL ghi + doc lai', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v19-consol-'));
  const store = freshStore();
  seedFact(store, 'An', 'lives_in', 'Ha Noi');
  seedFact(store, 'An', 'lives_in', 'Ha Noi');
  const report = runConsolidationPassV19(store, SCOPE, {}, { workspaceDir: dir });
  assert.equal(report.factsMerged, 1);
  const logs = readConsolidationRunLogV19(dir);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].jobId, report.jobId);
  assert.match(formatV19ConsolidationReport(report), /Consolidation v19/);
});

// --- async job ----------------------------------------------------------

test('v19 consolidation: async job chay xong, status done', async () => {
  const store = freshStore();
  seedFact(store, 'An', 'lives_in', 'Ha Noi', { confidence: 0.9 });
  seedFact(store, 'An', 'lives_in', 'Ha Noi', { confidence: 0.7 });
  const seen = [];
  const job = runConsolidationAsyncV19(store, SCOPE, {}, {
    onProgress: (p) => seen.push(p.phase),
  });
  assert.equal(job.status, 'queued');
  const report = await job.run();
  assert.equal(job.status, 'done');
  assert.equal(report.factsMerged, 1);
  assert.equal(report.stoppedBecause, 'done');
  assert.ok(seen.includes('done'));
});

test('v19 consolidation: async job cancel truoc khi chay', async () => {
  const store = freshStore();
  seedFact(store, 'An', 'lives_in', 'Ha Noi');
  const job = runConsolidationAsyncV19(store, SCOPE);
  job.cancel();
  const report = await job.run();
  assert.equal(job.status, 'cancelled');
  assert.match(report.stoppedBecause, /huy/);
});

test('v19 consolidation: config sai thi throw', () => {
  const store = freshStore();
  assert.throws(() => runConsolidationAsyncV19(store, SCOPE, { maxFactsPerRun: 0 }), /maxFactsPerRun/);
  assert.throws(() => runConsolidationPassV19(store, SCOPE, { decayHalfLifeDays: 0 }), /decayHalfLifeDays/);
});

// --- supersedes ---------------------------------------------------------

test('v19 supersedes: topicKeyV19 chuan hoa', () => {
  assert.equal(topicKeyV19('An', 'lives_in'), 'an|lives_in');
  assert.equal(topicKeyV19('  An  ', 'Lives In'), 'an|lives_in');
});

test('v19 supersedes: added khi chua co ban cu, no-change khi trung object', () => {
  const store = freshStore();
  const r1 = applySupersedeV19(store, candidate('An', 'lives_in', 'Ha Noi', 0.9), { scope: SCOPE });
  assert.equal(r1.record.action, 'added');
  assert.ok(r1.newFact);
  const r2 = applySupersedeV19(store, candidate('An', 'lives_in', 'Ha Noi', 0.9), { scope: SCOPE });
  assert.equal(r2.record.action, 'no-change');
  assert.equal(r2.newFact, undefined);
  assert.match(formatV19SupersedeRecord(r2.record), /khong doi/);
});

test('v19 supersedes: ban moi manh hon thay the ban cu, lich su giu lai', () => {
  const store = freshStore();
  const r1 = applySupersedeV19(store, candidate('An', 'lives_in', 'Ha Noi', 0.7), { scope: SCOPE });
  const oldId = r1.newFact.id;
  const r2 = applySupersedeV19(store, candidate('An', 'lives_in', 'Sai Gon', 0.95), { scope: SCOPE });
  assert.equal(r2.record.action, 'superseded');
  assert.equal(r2.newFact?.supersedes, oldId);
  assert.equal(store.getFact(oldId)?.status, 'superseded');
  assert.equal(store.getFact(oldId)?.supersededBy, r2.newFact.id);
  const history = supersedeHistoryV19(store, r2.newFact.id);
  assert.equal(history.length, 2);
  assert.equal(history[0].version, 1);
  assert.equal(history[0].objectText, 'Ha Noi');
  assert.equal(history[1].version, 2);
  assert.equal(history[1].objectText, 'Sai Gon');
  assert.equal(history[1].isCurrent, true);
  assert.equal(history[0].isCurrent, false);
});

test('v19 supersedes: ban moi yeu hon bi tu choi, force thi thay the', () => {
  const store = freshStore();
  applySupersedeV19(store, candidate('An', 'lives_in', 'Ha Noi', 0.9), { scope: SCOPE });
  const weak = applySupersedeV19(store, candidate('An', 'lives_in', 'Sai Gon', 0.5), { scope: SCOPE });
  assert.equal(weak.record.action, 'rejected-weak');
  assert.equal(weak.newFact, undefined);
  assert.equal(store.listFacts({ ...SCOPE, status: 'active' }).length, 1);
  const forced = applySupersedeV19(store, candidate('An', 'lives_in', 'Sai Gon', 0.5), {
    scope: SCOPE,
    force: true,
  });
  assert.equal(forced.record.action, 'superseded');
  assert.equal(forced.record.forced, true);
});

test('v19 supersedes: findSupersedeCandidatesV19 bo qua predicate da tri', () => {
  const store = freshStore();
  seedFact(store, 'An', 'likes', 'pho', { confidence: 0.9 });
  const found = findSupersedeCandidatesV19(store, candidate('An', 'likes', 'bun cha', 0.9), SCOPE);
  assert.equal(found.length, 0);
  const foundForced = findSupersedeCandidatesV19(
    store,
    candidate('An', 'likes', 'bun cha', 0.9),
    SCOPE,
    { forceMultiValued: true },
  );
  assert.equal(foundForced.length, 1);
});

test('v19 supersedes: rollback tao phien ban moi copy noi dung cu', () => {
  const store = freshStore();
  applySupersedeV19(store, candidate('An', 'lives_in', 'Ha Noi', 0.7), { scope: SCOPE });
  const r2 = applySupersedeV19(store, candidate('An', 'lives_in', 'Sai Gon', 0.95), { scope: SCOPE });
  const rb = rollbackSupersedeV19(store, r2.newFact.id, { scope: SCOPE });
  assert.equal(rb.newFact?.objectText, 'Ha Noi');
  assert.equal(rb.record.action, 'superseded');
  const history = supersedeHistoryV19(store, rb.newFact.id);
  assert.equal(history.length, 3);
  assert.equal(history[2].version, 3);
  assert.equal(history[2].objectText, 'Ha Noi');
  assert.equal(history[2].isCurrent, true);
  assert.throws(
    () => rollbackSupersedeV19(store, applySupersedeV19(store, candidate('Binh', 'lives_in', 'Hue', 0.9), { scope: SCOPE }).newFact.id),
    /phien ban/,
  );
});

test('v19 supersedes: candidate rong / confidence sai thi throw', () => {
  const store = freshStore();
  assert.throws(() => applySupersedeV19(store, candidate('', 'lives_in', 'Ha Noi', 0.9)), /subject/);
  assert.throws(() => applySupersedeV19(store, candidate('An', 'lives_in', 'Ha Noi', 1.5)), /confidence/);
});
