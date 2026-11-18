/**
 * Tests for v1.18 (Team T1) — memory v17:
 * packages/core/src/memory/v17/{blockLifecycle,archivalScoring}.ts
 *
 * Covers:
 *  - lifecycle: 5 templates (render + required vars + unknown var
 *    throws), createFromTemplate records template, pin (max 8,
 *    compile pinned first), readOnly blocks edits, per-block
 *    maxChars blocks over-limit edits, total quota blocks + report
 *    (near-limit, largest), lifecycle config JSON round-trip.
 *  - archival scoring: hot passage scores higher than cold,
 *    confidence moves score, stale after 90 days idle, score in
 *    [0,1], configurable weights change score, recordAccess
 *    persists, promote (via v16 gate) + demote (moves line to
 *    archival, registry written), scoring report counts.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/memory-v17-lifecycle-scoring-v118.test.mjs
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
  V17BlockLifecycleManager,
  V16V15BlockAdapter,
  listBlockTemplatesV17,
  getBlockTemplateV17,
  renderBlockTemplateV17,
  compileBlocksWithLifecycleV17,
  loadLifecycleConfigV17,
  saveLifecycleConfigV17,
  scorePassageV17,
  scoreAllPassagesV17,
  recordAccessV17,
  loadPassageAccessV17,
  promotePassagesV17,
  demotePassagesV17,
  archivalScoringReportV17,
  loadDemotedV17,
  V17_ARCHIVAL_SCORING_DEFAULTS,
} from '../packages/core/dist/index.js';

const SCOPE = { userId: 'u1', botId: 'b1', runId: 'r1' };

function freshStore() {
  return new TemporalGraphStore(new InMemoryGraphBackend());
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'v17-life-'));
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

// --- templates ---------------------------------------------------------

test('v17 lifecycle: 5 templates listed with kinds', () => {
  const names = listBlockTemplatesV17();
  assert.deepEqual([...names].sort(), ['custom', 'human', 'persona', 'project', 'skill']);
  assert.equal(getBlockTemplateV17('persona')?.kind, 'persona');
  assert.equal(getBlockTemplateV17('project')?.kind, 'custom');
  assert.equal(getBlockTemplateV17('khong-co'), undefined);
});

test('v17 lifecycle: render template substitutes vars, no {{ left', () => {
  const { content } = renderBlockTemplateV17('persona', { agentName: 'Bot', tone: 'hai huoc' });
  assert.ok(content.includes('Bot'));
  assert.ok(content.includes('hai huoc'));
  assert.ok(!content.includes('{{'));
});

test('v17 lifecycle: render template missing required var throws', () => {
  assert.throws(() => renderBlockTemplateV17('persona', {}), /agentName/);
  assert.throws(() => renderBlockTemplateV17('human', { userName: '' }), /userName/);
});

test('v17 lifecycle: render template unknown var throws', () => {
  assert.throws(() => renderBlockTemplateV17('persona', { agentName: 'B', sai: 'x' }), /sai/);
});

test('v17 lifecycle: render template unknown name throws', () => {
  assert.throws(() => renderBlockTemplateV17('khong-co', {}), /Khong co template/);
});

test('v17 lifecycle: createFromTemplate records template origin', () => {
  const store = new V15BlockStore();
  const m = new V17BlockLifecycleManager(store);
  const block = m.createFromTemplate('project', 'du-an-a', { projectName: 'open-bot', stack: 'TS' });
  assert.equal(block.kind, 'custom');
  assert.ok(block.content.includes('open-bot'));
  assert.equal(m.configOf('du-an-a').template, 'project');
});

// --- pin / readOnly / maxChars / quota ---------------------------------

test('v17 lifecycle: pin compiles first', () => {
  const store = new V15BlockStore();
  const m = new V17BlockLifecycleManager(store);
  m.createFromTemplate('custom', 'zzz-note', { title: 'Z' });
  m.createFromTemplate('persona', 'persona', { agentName: 'Bot' });
  m.setPinned('zzz-note', true);
  const compiled = compileBlocksWithLifecycleV17(m);
  assert.ok(compiled.indexOf('[custom:zzz-note]') < compiled.indexOf('[persona:persona]'));
  assert.equal(m.listPinned().length, 1);
});

test('v17 lifecycle: pin limit is 8', () => {
  const store = new V15BlockStore();
  const m = new V17BlockLifecycleManager(store);
  for (let i = 0; i < 8; i++) {
    m.createFromTemplate('custom', `note-${i}`, { title: `N${i}` });
    m.setPinned(`note-${i}`, true);
  }
  m.createFromTemplate('custom', 'note-8', { title: 'N8' });
  assert.throws(() => m.setPinned('note-8', true), /toi da 8/);
});

test('v17 lifecycle: readOnly blocks all edits, unlock re-allows', () => {
  const store = new V15BlockStore();
  const m = new V17BlockLifecycleManager(store);
  m.createFromTemplate('human', 'human', { userName: 'Huy' });
  m.setReadOnly('human', true);
  assert.equal(m.listReadOnly().length, 1);
  const reason = m.checkEdit({ action: 'append', label: 'human', text: 'them' });
  assert.ok(reason && reason.includes('chi doc'));
  assert.throws(() => m.applyEdit({ action: 'append', label: 'human', text: 'them' }), /chi doc/);
  m.setReadOnly('human', false);
  assert.equal(m.checkEdit({ action: 'append', label: 'human', text: 'them' }), null);
  m.applyEdit({ action: 'append', label: 'human', text: 'them' });
  assert.ok(store.get('human')?.content.includes('them'));
});

test('v17 lifecycle: per-block maxChars blocks over-limit edit', () => {
  const store = new V15BlockStore();
  const m = new V17BlockLifecycleManager(store);
  m.createFromTemplate('custom', 'note', { title: 'N' });
  // Content template ~47 ky tu -> dat gioi han 60 (tren content hien tai).
  m.setMaxChars('note', 60);
  assert.ok(m.checkEdit({ action: 'append', label: 'note', text: 'x'.repeat(50) })?.includes('vuot gioi han rieng'));
  assert.throws(() => m.setMaxChars('note', 10), /vuot gioi han moi/);
  assert.throws(() => m.setMaxChars('note', 0), /\[1, 8000\]/);
});

test('v17 lifecycle: total quota blocks create + report', () => {
  const store = new V15BlockStore();
  const m = new V17BlockLifecycleManager(store, { totalQuotaChars: 100 });
  m.createFromTemplate('custom', 'a', { title: 'A' });
  const report = m.quotaReport();
  assert.equal(report.totalQuotaChars, 100);
  assert.ok(report.totalChars > 0 && report.totalChars <= 100);
  assert.ok(report.remainingChars >= 0);
  assert.ok(report.largestBlock !== null);
  // Block moi vuot quota thi bi chan.
  assert.ok(m.checkEdit({ action: 'create', label: 'b', kind: 'custom', content: 'x'.repeat(200) })?.includes('quota'));
  assert.throws(() => m.setTotalQuota(10), /nho hon tong/);
});

test('v17 lifecycle: config JSON round-trip via file', () => {
  const dir = tmpDir();
  const store = new V15BlockStore();
  const m = new V17BlockLifecycleManager(store);
  m.createFromTemplate('persona', 'persona', { agentName: 'Bot' });
  m.setPinned('persona', true);
  m.setReadOnly('persona', true);
  saveLifecycleConfigV17(dir, m);
  const loaded = loadLifecycleConfigV17(store, dir);
  assert.equal(loaded.configOf('persona').pinned, true);
  assert.equal(loaded.configOf('persona').readOnly, true);
  assert.equal(loaded.configOf('persona').template, 'persona');
});

// --- archival scoring ---------------------------------------------------

test('v17 scoring: hot passage scores higher than cold', () => {
  const store = freshStore();
  const hot = seedFact(store, 'Huy', 'likes', 'ca phe', { episodeId: 'e-hot' });
  const cold = seedFact(store, 'Huy', 'likes', 'tra da', { episodeId: 'e-cold' });
  const now = new Date('2026-01-02T00:00:00.000Z');
  const hotScore = scorePassageV17(hot, { factId: hot.id, accessCount: 20, lastAccessedAt: '2026-01-02T00:00:00.000Z' }, V17_ARCHIVAL_SCORING_DEFAULTS, now);
  const coldScore = scorePassageV17(cold, undefined, V17_ARCHIVAL_SCORING_DEFAULTS, now);
  assert.ok(hotScore.score > coldScore.score);
  assert.ok(hotScore.score >= 0 && hotScore.score <= 1);
});

test('v17 scoring: stale after 90 days without access', () => {
  const store = freshStore();
  const fact = seedFact(store, 'Huy', 'likes', 'ca phe', { episodeId: 'e-stale' });
  const scored = scorePassageV17(fact, undefined, V17_ARCHIVAL_SCORING_DEFAULTS, new Date('2026-06-01T00:00:00.000Z'));
  assert.equal(scored.stale, true);
  const fresh = scorePassageV17(fact, { factId: fact.id, accessCount: 1, lastAccessedAt: '2026-05-31T00:00:00.000Z' }, V17_ARCHIVAL_SCORING_DEFAULTS, new Date('2026-06-01T00:00:00.000Z'));
  assert.equal(fresh.stale, false);
});

test('v17 scoring: recordAccess persists across loads', () => {
  const dir = tmpDir();
  const store = freshStore();
  const fact = seedFact(store, 'Huy', 'likes', 'ca phe');
  recordAccessV17(dir, fact.id);
  recordAccessV17(dir, fact.id);
  const loaded = loadPassageAccessV17(dir);
  assert.equal(loaded.get(fact.id)?.accessCount, 2);
  assert.throws(() => recordAccessV17(dir, ''), /factId khong duoc rong/);
});

test('v17 scoring: report counts promote/demote-ready', () => {
  const dir = tmpDir();
  const store = freshStore();
  seedFact(store, 'Huy', 'likes', 'ca phe', { confidence: 0.95, episodeId: 'e-r1' });
  seedFact(store, 'Huy', 'likes', 'tra da', { confidence: 0.2, episodeId: 'e-r2' });
  const report = archivalScoringReportV17(store, SCOPE, dir, { now: new Date('2026-01-02T00:00:00.000Z') });
  assert.equal(report.considered, 2);
  assert.ok(report.avgScore >= 0 && report.avgScore <= 1);
  assert.equal(report.top.length, 2);
});

test('v17 scoring: promote moves high-score fact into core block', () => {
  const dir = tmpDir();
  const store = freshStore();
  const fact = seedFact(store, 'Huy', 'likes', 'ca phe', { confidence: 0.95, episodeId: 'e-p1' });
  recordAccessV17(dir, fact.id);
  const blockStore = new V15BlockStore();
  const adapter = new V16V15BlockAdapter(blockStore);
  const report = promotePassagesV17(store, SCOPE, dir, adapter, 'user-chat', {
    config: {
      weights: V17_ARCHIVAL_SCORING_DEFAULTS.weights,
      thresholds: { ...V17_ARCHIVAL_SCORING_DEFAULTS.thresholds, promoteAt: 0.1 },
    },
    now: new Date('2026-01-02T00:00:00.000Z'),
  });
  assert.equal(report.promoted.length, 1);
  assert.ok(blockStore.get('v16-human')?.content.includes('ca phe'));
});

test('v17 scoring: demote moves stale low-score fact to archival + registry', () => {
  const dir = tmpDir();
  const store = freshStore();
  seedFact(store, 'Huy', 'likes', 'ca phe', { confidence: 0.2, episodeId: 'e-d1' });
  const blockStore = new V15BlockStore();
  const adapter = new V16V15BlockAdapter(blockStore);
  const report = demotePassagesV17(store, SCOPE, dir, adapter, {
    config: {
      weights: V17_ARCHIVAL_SCORING_DEFAULTS.weights,
      thresholds: { ...V17_ARCHIVAL_SCORING_DEFAULTS.thresholds, demoteAt: 0.9, staleAfterDays: 1 },
    },
    now: new Date('2026-06-01T00:00:00.000Z'),
  });
  assert.equal(report.demoted.length, 1);
  assert.equal(loadDemotedV17(dir).length, 1);
  assert.ok(blockStore.get('v16-archival')?.content.includes('ca phe'));
  // Demote lan 2 thi bo qua (da demote truoc do).
  const again = demotePassagesV17(store, SCOPE, dir, adapter, {
    config: {
      weights: V17_ARCHIVAL_SCORING_DEFAULTS.weights,
      thresholds: { ...V17_ARCHIVAL_SCORING_DEFAULTS.thresholds, demoteAt: 0.9, staleAfterDays: 1 },
    },
    now: new Date('2026-06-01T00:00:00.000Z'),
  });
  assert.equal(again.demoted.length, 0);
});

test('v17 scoring: scoreAllPassages sorts by score desc', () => {
  const dir = tmpDir();
  const store = freshStore();
  const hot = seedFact(store, 'Huy', 'likes', 'ca phe', { confidence: 0.95, episodeId: 'e-s1' });
  seedFact(store, 'Huy', 'likes', 'tra da', { confidence: 0.2, episodeId: 'e-s2' });
  recordAccessV17(dir, hot.id);
  const scored = scoreAllPassagesV17(store, SCOPE, dir, { now: new Date('2026-01-02T00:00:00.000Z') });
  assert.equal(scored.length, 2);
  assert.ok(scored[0].score >= scored[1].score);
});
