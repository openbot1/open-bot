/**
 * Tests for memory v23 sleep v2 + procedural + pipeline + eval (v1.38, Doi T1).
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/memory-v23-sleep-procedural-v138.test.mjs
 * No network. No model. Ollama faked offline (hash fallback).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  V23LocalEmbedder,
  V23MemoryStore,
  V23Pipeline,
  V23ProceduralStore,
  V23SleepConsolidator,
  consolidateBlocksV23,
  decayConfidenceV23,
  runV23Eval,
} from '../packages/core/dist/memory/v23/index.js';

const NOW = 1794000000000;
const DAY = 86_400_000;
const fakeOfflineEmbedder = { embed: async () => { throw new Error('ollama offline'); } };

function attempt(workflow, outcome, steps, durationMs = 1000, ranAt = NOW) {
  return { workflow, steps, toolsUsed: ['shell_exec'], outcome, durationMs, ranAt };
}

// --- sleep v2 ---

test('v23 sleep: decay giam confidence theo half-life; block helper thuan tuy', () => {
  assert.ok(Math.abs(decayConfidenceV23(0.8, 30 * DAY, 30) - 0.4) < 0.001);
  assert.ok(Math.abs(decayConfidenceV23(0.8, 60 * DAY, 30) - 0.2) < 0.001);
  assert.equal(decayConfidenceV23(0.8, 0, 30), 0.8);
  const res = consolidateBlocksV23([
    { id: 'b1', text: 'User thich ca phe den khong duong.', confidence: 0.8, updatedAt: NOW },
    { id: 'b2', text: 'User thich ca phe den khong duong moi sang.', confidence: 0.7, updatedAt: NOW },
    { id: 'b3', text: 'Chuyen khong lien quan gi het.', confidence: 0.8, updatedAt: NOW },
  ], { now: () => NOW });
  assert.equal(res.merged.length, 1);
  assert.equal(res.keep.length, 2);
  assert.equal(res.pruned.length, 0);
});

test('v23 sleep: merge trung lap + promote hay dung + stale validTo', () => {
  const s = new V23MemoryStore({ now: () => NOW });
  s.put({ text: 'User thich ca phe den khong duong moi sang.', confidence: 0.7, source: 'test' });
  s.put({ text: 'User thich ca phe den khong duong vao buoi sang.', confidence: 0.7, source: 'test' });
  const hot = s.put({ text: 'Du an dung Postgres.', confidence: 0.5, source: 'test' });
  for (let i = 0; i < 5; i += 1) s.markRetrieved(hot.record.id);
  s.put({ text: 'Khuyen mai cu het han.', confidence: 0.7, source: 'test', validTo: '2020-01-01' });
  const report = new V23SleepConsolidator({ now: () => NOW }).run(s);
  assert.equal(report.scanned, 4);
  assert.ok(report.merged >= 1, JSON.stringify(report));
  assert.ok(report.promoted >= 1, JSON.stringify(report));
  assert.equal(report.markedStale, 1);
  assert.equal(s.get(hot.record.id).confidence > 0.5, true);
});

test('v23 sleep: budget dung pass khi het maxOps; store rong khong loi', () => {
  const s = new V23MemoryStore({ now: () => NOW });
  for (let i = 0; i < 5; i += 1) s.put({ text: `Fact so ${i} ve ca phe den.`, confidence: 0.7, source: 'test' });
  const report = new V23SleepConsolidator({ maxOps: 1, now: () => NOW }).run(s);
  assert.equal(report.budgetHit, true);
  const empty = new V23SleepConsolidator({ now: () => NOW }).run(new V23MemoryStore({ now: () => NOW }));
  assert.equal(empty.scanned, 0);
  assert.equal(empty.budgetHit, false);
});

// --- procedural ---

test('v23 procedural: 3 success -> candidate, approve -> active, failure rieng khong tao skill', () => {
  const proc = new V23ProceduralStore({ now: () => NOW });
  proc.recordAttempt(attempt('deploy-preview', 'failure', ['mo terminal'], 500));
  assert.equal(proc.getSkill('deploy-preview'), undefined);
  for (let i = 0; i < 3; i += 1) {
    proc.recordAttempt(attempt('deploy-preview', 'success', ['mo terminal', 'chay test', 'deploy'], 1000, NOW + i));
  }
  const skill = proc.getSkill('deploy-preview');
  assert.ok(skill);
  assert.equal(skill.status, 'candidate');
  assert.equal(skill.successCount, 3);
  assert.equal(skill.totalCount, 4);
  assert.equal(skill.successRate, 0.75);
  assert.equal(proc.approve('deploy-preview').skill.status, 'active');
  assert.equal(proc.approve('khong-co').ok, false);
});

test('v23 procedural: steps cai tien tang version; rate + deprecate khi rating thap', () => {
  const proc = new V23ProceduralStore({ now: () => NOW });
  for (let i = 0; i < 3; i += 1) {
    proc.recordAttempt(attempt('fix-flaky-test', 'success', ['mo terminal', 'chay test', 'sua test'], 1000, NOW + i));
  }
  const improved = proc.recordAttempt(
    attempt('fix-flaky-test', 'success', ['mo terminal', 'chay test nhanh', 'sua test'], 500, NOW + 50),
  );
  assert.equal(improved.skill.version, 2);
  assert.deepEqual(improved.skill.steps, ['mo terminal', 'chay test nhanh', 'sua test']);
  proc.rate('fix-flaky-test', 1);
  proc.rate('fix-flaky-test', 1);
  proc.rate('fix-flaky-test', 1);
  assert.equal(proc.getSkill('fix-flaky-test').rating, 1);
  const deprecated = proc.reviewDeprecations();
  assert.ok(deprecated.includes('fix-flaky-test'));
  assert.equal(proc.getSkill('fix-flaky-test').status, 'deprecated');
  assert.equal(proc.rate('fix-flaky-test', 6).ok, false);
  assert.equal(proc.setTrigger('fix-flaky-test', '  ').ok, false);
  assert.equal(proc.retire('fix-flaky-test').skill.status, 'retired');
});

test('v23 procedural: search skill theo tu khoa, chi tra active/candidate', () => {
  const proc = new V23ProceduralStore({ now: () => NOW });
  for (let i = 0; i < 3; i += 1) {
    proc.recordAttempt(attempt('deploy-preview', 'success', ['mo terminal', 'deploy preview'], 1000, NOW + i));
  }
  proc.recordAttempt(attempt('deploy-preview', 'failure', ['mo terminal'], 1000, NOW + 10));
  const found = proc.searchSkills('deploy preview', 5);
  assert.equal(found.length, 1);
  assert.equal(found[0].skill.workflow, 'deploy-preview');
  assert.equal(found[0].score, 1);
  assert.deepEqual(proc.searchSkills('chuyen khong lien quan'), []);
  assert.equal(proc.history('deploy-preview').length, 4);
});

// --- pipeline ---

test('v23 pipeline: addConversation extract+consolidate+embed, searchScoped ghi retrieval', async () => {
  const s = new V23MemoryStore({ now: () => NOW });
  const embedder = new V23LocalEmbedder({ embedder: fakeOfflineEmbedder });
  const pipeline = new V23Pipeline(s, embedder, { now: () => NOW });
  const res = await pipeline.addConversation(
    [{ role: 'user', text: 'Toi thich ca phe den, khong duong. Chung ta da quyet dinh dung Postgres.' }],
    { userId: 'u1' },
    'test',
  );
  assert.ok(res.extracted >= 2, `extracted=${res.extracted}`);
  assert.ok(res.report.added >= 2, JSON.stringify(res.report));
  assert.ok(res.embedded >= 1, `embedded=${res.embedded}`);
  assert.equal(res.embedFailed, 0);
  const searched = await pipeline.searchScoped('ca phe', { userId: 'u1' });
  assert.ok(searched.hits.length >= 1);
  assert.equal(searched.embeddingKind, 'hash');
  assert.ok(searched.hits[0].record.retrievalCount >= 1 || s.get(searched.hits[0].record.id).retrievalCount >= 1);
  const preview = pipeline.preview([{ role: 'user', text: 'Chao ban!' }]);
  assert.equal(preview.length, 0);
  const sleep = pipeline.runSleep();
  assert.equal(sleep.scanned, s.size(false));
});

test('v23 pipeline: consolidateWithScope gan scope cho record moi', async () => {
  const pipeline = V23Pipeline.inMemory({ now: () => NOW });
  const candidates = pipeline.preview([
    { role: 'user', text: 'Toi thich ca phe den, khong duong.' },
  ]);
  assert.equal(candidates.length, 1);
  const report = pipeline.consolidateWithScope(candidates, { userId: 'u1', agentId: 'bot1' }, 'test');
  assert.equal(report.added, 1);
  const added = pipeline.store.list({ scope: { userId: 'u1' } });
  assert.equal(added.length, 1);
  assert.equal(added[0].scope.agentId, 'bot1');
});

// --- eval harness ---

test('v23 eval: 30/30 case pass offline', async () => {
  const summary = await runV23Eval();
  assert.equal(summary.total, 30);
  assert.equal(summary.failed, 0, JSON.stringify(summary.results.filter((r) => !r.passed)));
  assert.equal(summary.passed, 30);
});
