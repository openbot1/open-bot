/**
 * Tests for coding agent v3 — model router (v1.10, Đội T4):
 * `packages/core/src/codingV3/modelRouter.ts` (rule table + scoring
 * by task type/difficulty/cost/latency, fallback chain, failure log).
 *
 * Pure logic — no API calls, no network. Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/coding-v3-model-router.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CodingV3ModelRouter,
  CODING_V3_DEFAULT_CATALOG,
} from '../packages/core/dist/codingV3/modelRouter.js';

test('catalog: 7 models, local-first entries are free', () => {
  assert.equal(CODING_V3_DEFAULT_CATALOG.length, 7);
  const local = CODING_V3_DEFAULT_CATALOG.filter((m) => m.kind === 'local');
  assert.equal(local.length, 3);
  assert.ok(local.every((m) => m.costPer1MInputUsd === 0 && m.costPer1MOutputUsd === 0));
  assert.ok(CODING_V3_DEFAULT_CATALOG.every((m) => m.maxDifficulty >= 1 && m.maxDifficulty <= 5));
  const ids = CODING_V3_DEFAULT_CATALOG.map((m) => m.id);
  assert.equal(new Set(ids).size, ids.length, 'model ids unique');
});

test('easy explore task: cheap fast model wins, reasons explain the pick', () => {
  const router = new CodingV3ModelRouter();
  const decision = router.pickModel({ type: 'explore', difficulty: 1 });
  assert.ok(decision.picked.score >= 70, `score ${decision.picked.score}`);
  assert.ok(decision.picked.reasons.length > 0);
  assert.ok(decision.picked.model.strengths.includes('explore'));
  assert.ok(decision.fallbacks.length >= 1);
  assert.ok(decision.fallbacks.every((f) => f.score <= decision.picked.score), 'fallbacks sorted by score desc');
  assert.equal(decision.profile.difficulty, 1);
});

test('hard codegen (difficulty 5): only max-difficulty-5 models score full difficulty points', () => {
  const router = new CodingV3ModelRouter();
  const decision = router.pickModel({ type: 'codegen', difficulty: 5 });
  assert.equal(decision.picked.model.maxDifficulty, 5);
  assert.ok(decision.picked.model.strengths.includes('codegen'));
  // A 7b local model is too weak for difficulty 5: it must not win.
  assert.notEqual(decision.picked.model.id, 'ollama/qwen2.5-coder:7b');
  const weak = decision.fallbacks.find((f) => f.model.id === 'ollama/qwen2.5-coder:7b');
  assert.ok(weak, 'weak model still listed as fallback');
  assert.equal(weak.breakdown.difficulty, 0, 'too weak => 0 difficulty points');
});

test('cost budget: a $0.001 budget forces a free local model', () => {
  const router = new CodingV3ModelRouter();
  const decision = router.pickModel({
    type: 'codegen',
    difficulty: 3,
    maxCostUsd: 0.001,
    estimatedInputTokens: 4000,
    estimatedOutputTokens: 1000,
  });
  assert.equal(decision.picked.model.kind, 'local');
  assert.equal(decision.picked.estimatedCostUsd, 0);
});

test('latency budget: a 1300ms budget excludes slow local models (hard constraint)', () => {
  const router = new CodingV3ModelRouter();
  const decision = router.pickModel({ type: 'explore', difficulty: 2, maxLatencyMs: 1300 });
  assert.ok(decision.picked.model.latencyMsP50 <= 1300, `picked p50 ${decision.picked.model.latencyMsP50}ms`);
  assert.equal(decision.picked.model.id, 'gemini-2.5-flash');
  assert.ok(decision.excludedByConstraint.some((e) => e.startsWith('ollama/qwen2.5-coder:7b')));
  assert.ok(decision.excludedByConstraint.length >= 5, 'slow models excluded, not just down-scored');
});

test('preferLocal restricts to local models; preferCloud restricts to cloud', () => {
  const router = new CodingV3ModelRouter();
  const localOnly = router.pickModel({ type: 'codegen', difficulty: 3, preferLocal: true });
  assert.equal(localOnly.picked.model.kind, 'local');
  assert.ok(localOnly.fallbacks.every((f) => f.model.kind === 'local'));
  const cloudOnly = router.pickModel({ type: 'codegen', difficulty: 3, preferCloud: true });
  assert.equal(cloudOnly.picked.model.kind, 'cloud');
  assert.ok(cloudOnly.fallbacks.every((f) => f.model.kind === 'cloud'));
});

test('recordFailure: failed model is excluded, next pick is the fallback; clearFailure restores it', () => {
  const router = new CodingV3ModelRouter();
  const profile = { type: 'explore', difficulty: 2 };
  const first = router.pickModel(profile);
  const firstId = first.picked.model.id;
  router.recordFailure(firstId, 'API 500');
  const second = router.pickModel(profile);
  assert.notEqual(second.picked.model.id, firstId);
  assert.ok(second.excludedByFailure.some((e) => e.startsWith(firstId)));
  assert.equal(router.failedModels().length, 1);
  router.clearFailure(firstId);
  const third = router.pickModel(profile);
  assert.equal(third.picked.model.id, firstId);
});

test('failure TTL: an old failure no longer excludes the model', async () => {
  const router = new CodingV3ModelRouter({ failureTtlMs: 50 });
  const profile = { type: 'explore', difficulty: 2 };
  const first = router.pickModel(profile);
  const firstId = first.picked.model.id;
  router.recordFailure(firstId, 'API 500');
  const excluded = router.pickModel(profile);
  assert.notEqual(excluded.picked.model.id, firstId);
  await new Promise((r) => setTimeout(r, 70));
  const restored = router.pickModel(profile);
  assert.equal(restored.picked.model.id, firstId);
});

test('no model available: all excluded => pick throws a clear error', () => {
  const router = new CodingV3ModelRouter({
    catalog: [{ id: 'only-one', provider: 'x', kind: 'local', contextTokens: 1000, costPer1MInputUsd: 0, costPer1MOutputUsd: 0, latencyMsP50: 100, strengths: ['chat'], maxDifficulty: 1, note: '' }],
  });
  router.recordFailure('only-one', 'down');
  assert.throws(() => router.pickModel({ type: 'chat', difficulty: 1 }), /không còn model khả dụng/);
});

test('decision log: recent decisions are kept newest-first', () => {
  const router = new CodingV3ModelRouter();
  router.pickModel({ type: 'chat', difficulty: 1 });
  router.pickModel({ type: 'fix', difficulty: 2 });
  const recent = router.recentDecisions(2);
  assert.equal(recent.length, 2);
  assert.equal(recent[0].profile.type, 'fix');
  assert.equal(recent[1].profile.type, 'chat');
  assert.equal(router.recentDecisions(1).length, 1);
});

test('score breakdown sums to the total score', () => {
  const router = new CodingV3ModelRouter();
  const decision = router.pickModel({ type: 'review', difficulty: 4 });
  const b = decision.picked.breakdown;
  assert.equal(b.taskType + b.difficulty + b.cost + b.latency + b.localBonus, decision.picked.score);
  assert.ok(b.taskType >= 0 && b.taskType <= 40);
  assert.ok(b.difficulty >= 0 && b.difficulty <= 20);
  assert.ok(b.cost >= 0 && b.cost <= 20);
  assert.ok(b.latency >= 0 && b.latency <= 10);
  assert.ok(b.localBonus >= 0 && b.localBonus <= 10);
});
