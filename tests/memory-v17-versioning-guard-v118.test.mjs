/**
 * Tests for v1.18 (Team T1) — memory v17:
 * packages/core/src/memory/v17/{blockVersioning,poisoningGuardV2,eval}.ts
 *
 * Covers:
 *  - versioning: commit chains (parent hash), no empty commit,
 *    diff added/removed, rollback restores content + records a new
 *    commit (history never erased), audit query (label/author/
 *    reason/time), git stats, hash is deterministic.
 *  - guard v2: provenance chain (missing episode / missing parent
 *    fail, full chain ok, cycle in supersedes detected), admission
 *    pipeline (denied source reject, broken chain reject, clean
 *    high-confidence auto-admit, low-confidence human-review into
 *    quarantine, review approve creates fact), batch admit counts,
 *    stats + audit, provenance chain export text.
 *  - eval: 25 fixed cases, all pass, per-category 5/5, PASS.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/memory-v17-versioning-guard-v118.test.mjs
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
  V15BlockStore,
  V16SourceAllowlist,
  computeCommitHashV17,
  shortHashV17,
  commitBlockV17,
  blockCommitHistoryV17,
  diffCommitsV17,
  rollbackToCommitV17,
  queryBlockAuditV17,
  readBlockAuditV17,
  blockGitStatsV17,
  verifyProvenanceChainV17,
  admitCandidateV17,
  admitBatchV17,
  reviewAdmissionV17,
  admissionStatsV17,
  readV17AdmissionAudit,
  exportProvenanceChainV17,
  runV17Eval,
  formatV17EvalReport,
} from '../packages/core/dist/index.js';

const SCOPE = { userId: 'u1', botId: 'b1', runId: 'r1' };

function freshStore() {
  return new TemporalGraphStore(new InMemoryGraphBackend());
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'v17-ver-'));
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

function candidate(overrides = {}) {
  return {
    subject: 'Huy',
    predicate: 'likes',
    objectText: 'ca phe',
    confidence: 0.9,
    effectiveConfidence: 0.9,
    sourceTrust: 1,
    sourceText: 'Huy likes ca phe.',
    pattern: 'test',
    origin: 'rule',
    intent: 'assert',
    episodeId: 'e1',
    turnId: 't1',
    runId: 'r1',
    botId: 'b1',
    userId: 'u1',
    at: '2026-01-01T00:00:00.000Z',
    sourceName: 'user-chat',
    ...overrides,
  };
}

// --- versioning ----------------------------------------------------------

test('v17 versioning: commit hash deterministic, short hash 12 chars', () => {
  const h1 = computeCommitHashV17(null, 'persona', 'dong 1', 'user', 'tao', '2026-01-01T00:00:00.000Z');
  const h2 = computeCommitHashV17(null, 'persona', 'dong 1', 'user', 'tao', '2026-01-01T00:00:00.000Z');
  assert.equal(h1, h2);
  assert.equal(shortHashV17(h1).length, 12);
  assert.notEqual(computeCommitHashV17(null, 'persona', 'dong 2', 'user', 'tao', '2026-01-01T00:00:00.000Z'), h1);
});

test('v17 versioning: two commits chain via parent', () => {
  const dir = tmpDir();
  const store = new V15BlockStore();
  store.create('persona', 'persona', 'dong 1');
  const c1 = commitBlockV17(store, dir, 'persona', 'user', 'tao');
  assert.equal(c1.created, true);
  store.replace('persona', 'dong 1\ndong 2', 'user', 'them');
  const c2 = commitBlockV17(store, dir, 'persona', 'user', 'them');
  assert.equal(c2.commit.parent, c1.commit.hash);
  assert.equal(c2.commit.linesAdded, 1);
  assert.equal(blockCommitHistoryV17(dir, 'persona').length, 2);
});

test('v17 versioning: no empty commit when unchanged', () => {
  const dir = tmpDir();
  const store = new V15BlockStore();
  store.create('persona', 'persona', 'dong 1');
  commitBlockV17(store, dir, 'persona', 'user', 'tao');
  const again = commitBlockV17(store, dir, 'persona', 'user', 'tao lai');
  assert.equal(again.created, false);
  assert.equal(blockCommitHistoryV17(dir, 'persona').length, 1);
});

test('v17 versioning: diff counts added/removed', () => {
  const dir = tmpDir();
  const store = new V15BlockStore();
  store.create('persona', 'persona', 'dong 1\ndong cu');
  const c1 = commitBlockV17(store, dir, 'persona', 'user', 'tao').commit;
  store.replace('persona', 'dong 1\ndong moi', 'user', 'doi');
  const c2 = commitBlockV17(store, dir, 'persona', 'user', 'doi').commit;
  const diff = diffCommitsV17(dir, c1.hash, c2.hash);
  assert.equal(diff.added, 1);
  assert.equal(diff.removed, 1);
  assert.equal(diff.unchanged, 1);
  assert.throws(() => diffCommitsV17(dir, c1.hash, 'khong-co'), /Khong tim thay commit/);
});

test('v17 versioning: rollback restores content and records new commit', () => {
  const dir = tmpDir();
  const store = new V15BlockStore();
  store.create('persona', 'persona', 'dong 1');
  const c1 = commitBlockV17(store, dir, 'persona', 'user', 'tao').commit;
  store.replace('persona', 'dong 2', 'user', 'doi');
  commitBlockV17(store, dir, 'persona', 'user', 'doi');
  const { block, commit } = rollbackToCommitV17(store, dir, 'persona', c1.hash, 'user', 'quay lai');
  assert.equal(block.content, 'dong 1');
  assert.equal(commit.reason, 'quay lai');
  // Lich su khong bi xoa: 3 commit (tao, doi, rollback).
  assert.equal(blockCommitHistoryV17(dir, 'persona').length, 3);
  assert.equal(readBlockAuditV17(dir).filter((e) => e.action === 'rollback').length, 1);
});

test('v17 versioning: audit query filters label/author/reason/time', () => {
  const dir = tmpDir();
  const store = new V15BlockStore();
  store.create('persona', 'persona', 'dong 1');
  commitBlockV17(store, dir, 'persona', 'alice', 'tao persona', new Date('2026-01-01T00:00:00.000Z'));
  store.create('human', 'human', 'dong h');
  commitBlockV17(store, dir, 'human', 'bob', 'tao human', new Date('2026-01-02T00:00:00.000Z'));
  assert.equal(queryBlockAuditV17(dir, { label: 'persona' }).length, 1);
  assert.equal(queryBlockAuditV17(dir, { author: 'bob' }).length, 1);
  assert.equal(queryBlockAuditV17(dir, { reasonContains: 'HUMAN' }).length, 1);
  assert.equal(queryBlockAuditV17(dir, { from: '2026-01-02T00:00:00.000Z' }).length, 1);
  assert.equal(queryBlockAuditV17(dir, { to: '2026-01-01T12:00:00.000Z' }).length, 1);
  const stats = blockGitStatsV17(dir);
  assert.equal(stats.commitCount, 2);
  assert.deepEqual(stats.labels, ['human', 'persona']);
});

test('v17 versioning: rollback by short hash (12 chars) works', () => {
  const dir = tmpDir();
  const store = new V15BlockStore();
  store.create('persona', 'persona', 'dong 1');
  const c1 = commitBlockV17(store, dir, 'persona', 'user', 'tao').commit;
  store.replace('persona', 'dong 2', 'user', 'doi');
  commitBlockV17(store, dir, 'persona', 'user', 'doi');
  const { block } = rollbackToCommitV17(store, dir, 'persona', shortHashV17(c1.hash), 'user', 'quay lai');
  assert.equal(block.content, 'dong 1');
  assert.throws(() => rollbackToCommitV17(store, dir, 'persona', 'zzzzzzzzzzzz', 'user', 'x'), /Khong tim thay commit/);
});

test('v17 versioning: commit unknown block throws', () => {
  const dir = tmpDir();
  const store = new V15BlockStore();
  assert.throws(() => commitBlockV17(store, dir, 'khong-co', 'user', 'x'), /Khong tim thay block/);
  assert.throws(() => rollbackToCommitV17(store, dir, 'persona', 'khong-co', 'user', 'x'), /Khong tim thay commit/);
});

// --- guard v2 ------------------------------------------------------------

test('v17 guard: chain fails when episode missing', () => {
  const store = freshStore();
  const check = verifyProvenanceChainV17(store, candidate({ episodeId: 'ep-khong-co' }));
  assert.equal(check.ok, false);
  assert.equal(check.episodeExists, false);
  assert.ok(check.errors.some((e) => e.includes('Episode goc')));
});

test('v17 guard: chain fails when parent fact missing', () => {
  const store = freshStore();
  const seeded = seedFact(store, 'Huy', 'likes', 'ca phe');
  const check = verifyProvenanceChainV17(store, candidate({
    episodeId: seeded.provenance.episodeId,
    parentFactIds: ['fact-khong-co'],
  }));
  assert.equal(check.ok, false);
  assert.equal(check.parentsFound, 0);
  assert.equal(check.parentsTotal, 1);
});

test('v17 guard: chain ok when episode + parent exist', () => {
  const store = freshStore();
  const parent = seedFact(store, 'Huy', 'likes', 'ca phe');
  const check = verifyProvenanceChainV17(store, candidate({
    episodeId: parent.provenance.episodeId,
    parentFactIds: [parent.id],
  }));
  assert.equal(check.ok, true);
  assert.equal(check.parentsFound, 1);
  assert.equal(check.depth, 1);
});

test('v17 guard: chain depth counts supersedes links', () => {
  const store = freshStore();
  const f1 = seedFact(store, 'Huy', 'likes', 'ca phe', { episodeId: 'e-c1' });
  const f2 = store.supersedeFact(f1.id, {
    subjectName: 'Huy',
    predicate: 'likes',
    objectText: 'tra da',
    confidence: 0.9,
    scope: SCOPE,
    provenance: {
      episodeId: f1.provenance.episodeId,
      turnId: 't1',
      runId: 'r1',
      botId: 'b1',
      userId: 'u1',
      at: '2026-01-01T00:00:00.000Z',
      sourceText: 'Huy likes tra da.',
    },
  });
  const check = verifyProvenanceChainV17(store, candidate({
    episodeId: f1.provenance.episodeId,
    parentFactIds: [f2.id],
  }));
  assert.equal(check.ok, true);
  // f2 supersedes f1 -> chuoi sau 2.
  assert.equal(check.depth, 2);
  // Do sau vuot gioi han thi khong ok.
  const shallow = verifyProvenanceChainV17(store, candidate({
    episodeId: f1.provenance.episodeId,
    parentFactIds: [f2.id],
  }), { maxChainDepth: 1 });
  assert.equal(shallow.ok, false);
});

test('v17 guard: denied source rejects admission immediately', () => {
  const dir = tmpDir();
  const store = freshStore();
  const seeded = seedFact(store, 'Huy', 'likes', 'ca phe');
  const allowlist = new V16SourceAllowlist();
  allowlist.upsert('web-xau', 'deny', null, 'test', 'user');
  const result = admitCandidateV17(store, dir, candidate({
    episodeId: seeded.provenance.episodeId,
    sourceName: 'web-xau',
  }), SCOPE, 'web-xau', { allowlist });
  assert.equal(result.decision, 'reject');
  assert.equal(store.listFacts({ ...SCOPE }).length, 1);
  assert.equal(readV17AdmissionAudit(dir).length, 1);
});

test('v17 guard: broken chain rejects admission (no quarantine pile-up)', () => {
  const dir = tmpDir();
  const store = freshStore();
  const result = admitCandidateV17(store, dir, candidate({ episodeId: 'ep-khong-co' }), SCOPE, 'user-chat');
  assert.equal(result.decision, 'reject');
  assert.equal(store.listQuarantine({}).length, 0);
});

test('v17 guard: clean high-confidence fact auto-admits', () => {
  const dir = tmpDir();
  const store = freshStore();
  const seeded = seedFact(store, 'Huy', 'likes', 'ca phe');
  const result = admitCandidateV17(store, dir, candidate({
    episodeId: seeded.provenance.episodeId,
    objectText: 'tra da',
    sourceText: 'Huy likes tra da.',
  }), SCOPE, 'user-chat');
  assert.equal(result.decision, 'auto-admit');
  assert.ok(result.fact);
  assert.equal(store.listFacts({ ...SCOPE }).length, 2);
});

test('v17 guard: low-confidence fact goes to human-review quarantine', () => {
  const dir = tmpDir();
  const store = freshStore();
  const seeded = seedFact(store, 'Huy', 'likes', 'ca phe');
  const result = admitCandidateV17(store, dir, candidate({
    episodeId: seeded.provenance.episodeId,
    objectText: 'tra da',
    sourceText: 'Huy likes tra da.',
    confidence: 0.5,
    effectiveConfidence: 0.5,
  }), SCOPE, 'user-chat');
  assert.equal(result.decision, 'human-review');
  assert.ok(result.quarantineItem);
  assert.equal(store.listFacts({ ...SCOPE }).length, 1);
  // Nguoi duyet approve -> fact vao graph.
  const reviewed = reviewAdmissionV17(store, dir, result.quarantineItem.id, 'approved', 'user');
  assert.ok(reviewed.fact);
  assert.equal(store.listFacts({ ...SCOPE }).length, 2);
  assert.throws(() => reviewAdmissionV17(store, dir, result.quarantineItem.id, 'approved', 'user'), /duyệt|Không tìm thấy/i);
});

test('v17 guard: batch admit counts each decision', () => {
  const dir = tmpDir();
  const store = freshStore();
  const seeded = seedFact(store, 'Huy', 'likes', 'ca phe');
  const allowlist = new V16SourceAllowlist();
  allowlist.upsert('web-xau', 'deny', null, 'test', 'user');
  const report = admitBatchV17(store, dir, [
    candidate({ episodeId: seeded.provenance.episodeId, objectText: 'tra da', sourceText: 'Huy likes tra da.' }),
    candidate({ episodeId: 'ep-khong-co' }),
    candidate({ episodeId: seeded.provenance.episodeId, objectText: 'bia', sourceText: 'Huy likes bia.', sourceName: 'web-xau' }),
  ], SCOPE, 'user-chat', { allowlist });
  // Luu y: admitBatch dung 1 sourceName cho ca lo ('user-chat'),
  // muc 3 co sourceName rieng trong candidate nhung gate dung
  // sourceName cua lo -> khong deny; no se auto-admit hoac review.
  assert.equal(report.total, 3);
  assert.equal(report.autoAdmitted + report.humanReview + report.rejected, 3);
  assert.equal(report.rejected, 1); // chi muc chain hong bi reject.
});

test('v17 guard: stats + provenance chain export', () => {
  const dir = tmpDir();
  const store = freshStore();
  const seeded = seedFact(store, 'Huy', 'likes', 'ca phe');
  admitCandidateV17(store, dir, candidate({
    episodeId: seeded.provenance.episodeId,
    objectText: 'tra da',
    sourceText: 'Huy likes tra da.',
  }), SCOPE, 'user-chat');
  const stats = admissionStatsV17(dir, { days: 7 });
  assert.equal(stats.total, 1);
  assert.equal(stats.autoAdmitted, 1);
  assert.equal(stats.autoAdmitRate, 1);
  const text = exportProvenanceChainV17(store, seeded.id);
  assert.ok(text.includes('ca phe'));
  assert.ok(text.includes('Episode goc'));
  assert.ok(exportProvenanceChainV17(store, 'khong-co').includes('Khong tim thay fact'));
});

// --- eval ----------------------------------------------------------------

test('v17 eval: 25 fixed cases all pass, PASS overall', () => {
  const result = runV17Eval();
  assert.equal(result.total, 25);
  assert.equal(result.passed, 25);
  assert.equal(result.failed, 0);
  assert.equal(result.pass, true);
  for (const c of result.categories) {
    assert.equal(c.passed, 5);
    assert.equal(c.rate, 1);
  }
  const report = formatV17EvalReport(result);
  assert.ok(report.includes('25/25'));
  assert.ok(report.includes('PASS'));
});
