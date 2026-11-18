/**
 * Router v2 picker + fallback tests (v1.16, Doi T3 — node:test).
 *
 * Covers:
 * - PickerV2: task nhe -> local nho; task nang + quality cao -> cloud
 *   manh; preference speed/cost/quality doi trong so; manual override
 *   duoc ton trong + giai thich khi khong kha dung; khong co ung vien
 *   -> throw; explanation co noi dung.
 * - UserChoiceMemory: ghi nho lua chon, boost tang theo so lan (co
 *   tran), doi y reset dem, serialize round-trip, forget.
 * - CircuitBreaker: closed -> open sau threshold -> half-open sau
 *   timeout -> closed khi thanh cong; trial chi 1 tai mot thoi diem.
 * - FallbackChain: thu theo thu tu cloud -> CLI -> local; bo qua
 *   nguon tat / circuit mo / budget chan; ghi spend vao budget
 *   tracker; guidance co huong dan cu the khi tat ca loi.
 * - buildFailureGuidance: thong diep theo tung loai buoc.
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/router-v116-picker-fallback.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CircuitBreaker,
  FallbackChain,
  PickerV2,
  UserChoiceMemory,
  buildFailureGuidance,
  defaultPickerCandidates,
  normalizeHigherBetter,
  normalizeLowerBetter,
  taskHeavinessV2,
  taskKeyFor,
} from '../packages/core/dist/routerV2/index.js';
import { LocalBudgetTracker } from '../packages/core/dist/router/local/index.js';

const simpleTask = {
  kind: 'simple-chat', promptTokens: 200, needsToolUse: false,
  needsLongContext: false, qualityNeed: 0.2, preference: 'balanced',
};
const heavyCodeTask = {
  kind: 'code', promptTokens: 9000, needsToolUse: true,
  needsLongContext: true, qualityNeed: 0.95, preference: 'balanced',
};

test('taskHeavinessV2 + taskKeyFor', () => {
  assert.ok(taskHeavinessV2(heavyCodeTask) > 0.9);
  assert.ok(taskHeavinessV2(simpleTask) < 0.3);
  assert.equal(taskKeyFor(simpleTask), 'simple-chat:balanced:short');
  assert.equal(taskKeyFor({ ...simpleTask, promptTokens: 9000 }), 'simple-chat:balanced:long');
});

test('normalize helpers', () => {
  assert.equal(normalizeLowerBetter(0, 0, 100), 1);
  assert.equal(normalizeLowerBetter(100, 0, 100), 0);
  assert.equal(normalizeLowerBetter(50, 0, 100), 0.5);
  assert.equal(normalizeHigherBetter(100, 0, 100), 1);
  assert.equal(normalizeHigherBetter(0, 0, 100), 0);
  assert.equal(normalizeLowerBetter(5, 5, 5), 1); // degenerate range
});

test('picker: simple task -> small local model, heavy code -> strong cloud', () => {
  const picker = new PickerV2();
  const simple = picker.suggest(simpleTask, defaultPickerCandidates());
  assert.equal(simple.best.source, 'local');
  assert.ok(['qwen3-1p7b', 'qwen3-4b'].includes(simple.best.modelId));
  assert.ok(simple.reason.length > 20);
  assert.ok(simple.best.explanation.includes('Local'));
  assert.equal(simple.manualOverride, false);

  const heavy = picker.suggest(heavyCodeTask, defaultPickerCandidates());
  assert.ok(['cloud', 'cli'].includes(heavy.best.source));
  assert.ok(heavy.best.quality >= 0.95);
  assert.ok(heavy.reason.includes('nang'));
  // Ranked giam dan theo diem.
  for (let i = 1; i < heavy.ranked.length; i++) {
    assert.ok(heavy.ranked[i - 1].score >= heavy.ranked[i].score);
  }
});

test('picker: preference changes the winner', () => {
  const picker = new PickerV2();
  const costTask = { ...heavyCodeTask, preference: 'cost' };
  const costPick = picker.suggest(costTask, defaultPickerCandidates());
  // Uu tien cost: khong chon cloud dat (0.003); thang la nguon re
  // (CLI dung login san hoac gemini flash) ma van du chat luong.
  assert.ok(costPick.best.costPer1kTokensUsd <= 0.0003);
  assert.notEqual(costPick.best.modelId, 'claude-sonnet-4.5');
  const qualityTask = { ...heavyCodeTask, preference: 'quality' };
  const qualityPick = picker.suggest(qualityTask, defaultPickerCandidates());
  assert.ok(qualityPick.best.quality >= 0.96);
});

test('picker: manual override honored; infeasible override explained', () => {
  const picker = new PickerV2();
  const manual = picker.suggest({ ...simpleTask, manualModelId: 'qwen3-4b' }, defaultPickerCandidates());
  assert.equal(manual.best.modelId, 'qwen3-4b');
  assert.equal(manual.manualOverride, true);
  assert.ok(manual.reason.includes('chon'));

  const gone = picker.suggest(
    { ...simpleTask, manualModelId: 'qwen3-4b' },
    defaultPickerCandidates().map((c) =>
      c.modelId === 'qwen3-4b' ? { ...c, available: false, excludedReason: 'het RAM' } : c,
    ),
  );
  assert.notEqual(gone.best.modelId, 'qwen3-4b');
  assert.equal(gone.manualOverride, false);
  assert.ok(gone.reason.includes('het RAM'));

  assert.throws(
    () => picker.suggest(simpleTask, []),
    /Khong co model nao kha dung/,
  );
  assert.throws(
    () => picker.suggest({ ...simpleTask, manualModelId: 'khong-co' }, []),
    /Khong tim thay model/,
  );
});

test('picker: embedding task prefers local embedder candidate', () => {
  const picker = new PickerV2();
  const candidates = [
    { modelId: 'nomic-embed-text', source: 'local', costPer1kTokensUsd: 0.0001, estLatencyMs: 60, quality: 0.8, available: true, paramsB: 0.1 },
    { modelId: 'gemini-2.5-flash', source: 'cloud', costPer1kTokensUsd: 0.0003, estLatencyMs: 600, quality: 0.85, available: true },
  ];
  const s = picker.suggest(
    { kind: 'embedding', promptTokens: 500, needsToolUse: false, needsLongContext: false, qualityNeed: 0.5 },
    candidates,
  );
  assert.equal(s.best.modelId, 'nomic-embed-text');
});

test('user choice memory: boost grows with repetitions, caps, resets on change', () => {
  const memory = new UserChoiceMemory();
  const task = { ...simpleTask };
  assert.equal(memory.boostFor(task, 'qwen3-4b'), 0);
  memory.recordChoice(task, 'qwen3-4b', 'local');
  memory.recordChoice(task, 'qwen3-4b', 'local');
  const boost2 = memory.boostFor(task, 'qwen3-4b');
  assert.ok(boost2 > 0 && boost2 < 0.12);
  for (let i = 0; i < 10; i++) memory.recordChoice(task, 'qwen3-4b', 'local');
  assert.equal(memory.boostFor(task, 'qwen3-4b'), 0.12); // cap
  assert.equal(memory.boostFor(task, 'gemini-2.5-flash'), 0);
  // Doi y -> reset dem.
  const changed = memory.recordChoice(task, 'qwen3-1p7b', 'local');
  assert.equal(changed.timesChosen, 1);
  assert.equal(changed.modelId, 'qwen3-1p7b');
  // Serialize round-trip.
  const restored = UserChoiceMemory.fromJSON(memory.toJSON());
  assert.equal(restored.rememberedFor(task).modelId, 'qwen3-1p7b');
  assert.equal(restored.forget('simple-chat:balanced:short'), true);
  assert.equal(restored.rememberedFor(task), undefined);
});

test('picker: remembered choice influences suggestion', () => {
  const picker = new PickerV2();
  const task = { ...simpleTask };
  for (let i = 0; i < 5; i++) picker.rememberUserChoice(task, 'qwen3-4b', 'local');
  const s = picker.suggest(task, defaultPickerCandidates());
  assert.equal(s.best.modelId, 'qwen3-4b');
  assert.equal(s.influencedByMemory, true);
});

test('circuit breaker: closed -> open -> half-open -> closed', () => {
  const breaker = new CircuitBreaker('cloud', 'gemini-2.5-flash', { failureThreshold: 3, resetTimeoutMs: 1000 });
  assert.equal(breaker.state(0), 'closed');
  assert.equal(breaker.allowRequest(0), true);
  breaker.recordFailure('e1', 10);
  breaker.recordFailure('e2', 20);
  assert.equal(breaker.state(30), 'closed');
  breaker.recordFailure('e3', 30);
  assert.equal(breaker.state(40), 'open');
  assert.equal(breaker.allowRequest(40), false);
  assert.equal(breaker.state(1030), 'half-open');
  assert.equal(breaker.allowRequest(1030), true);
  assert.equal(breaker.allowRequest(1030), false); // chi 1 trial
  breaker.recordSuccess();
  assert.equal(breaker.state(1040), 'closed');
  assert.equal(breaker.getConsecutiveFailures(), 0);

  // Half-open fail -> open lai.
  breaker.recordFailure('x', 2000);
  breaker.recordFailure('x', 2001);
  breaker.recordFailure('x', 2002);
  assert.equal(breaker.state(2003), 'open');
  assert.equal(breaker.state(4000), 'half-open');
  breaker.recordFailure('x', 4000);
  assert.equal(breaker.state(4001), 'open');
});

test('fallback chain: cloud fails -> CLI fails -> local succeeds, spend recorded', async () => {
  const budget = new LocalBudgetTracker();
  const chain = new FallbackChain({
    sources: [
      { source: 'cloud', sourceId: 'gemini-2.5-flash', enabled: true },
      { source: 'cli', sourceId: 'claude', enabled: true },
      { source: 'local', sourceId: 'qwen3-4b', enabled: true },
    ],
    budget,
    executor: async (source) => {
      if (source === 'cloud') return { ok: false, error: 'API key het han' };
      if (source === 'cli') return { ok: false, error: 'CLI agent khong chay' };
      return { ok: true, promptTokens: 100, completionTokens: 50, pricePer1kTokensUsd: 0.0001 };
    },
  });
  const result = await chain.run({ botId: 'bot-1' });
  assert.equal(result.ok, true);
  assert.equal(result.servedBy, 'local');
  assert.equal(result.servedById, 'qwen3-4b');
  assert.deepEqual(result.attempts.map((a) => a.outcome), ['failed', 'failed', 'success']);
  assert.ok(result.costUsd !== undefined && result.costUsd > 0);
  const report = budget.report('daily', Date.now(), 'bot-1');
  assert.equal(report.totalCalls, 1);
  assert.equal(report.totalTokens, 150);
  assert.ok(report.totalUsd > 0);
  assert.equal(report.byModel[0].modelId, 'qwen3-4b');
  assert.equal(budget.recordCount(), 1);
});

test('fallback chain: all fail -> guidance mentions causes; disabled skipped', async () => {
  const chain = new FallbackChain({
    sources: [
      { source: 'cloud', sourceId: 'gemini-2.5-flash', enabled: true },
      { source: 'cli', sourceId: 'claude', enabled: false },
      { source: 'local', sourceId: 'qwen3-4b', enabled: true },
    ],
    executor: async (source) => ({ ok: false, error: source === 'cloud' ? 'mang loi' : 'khong co model' }),
  });
  const result = await chain.run();
  assert.equal(result.ok, false);
  assert.deepEqual(result.attempts.map((a) => a.outcome), ['failed', 'skipped-disabled', 'failed']);
  assert.ok(result.guidance.includes('mang loi'));
  assert.ok(result.guidance.includes('khong co model'));
  assert.ok(result.guidance.includes('qwen3-4b'));
});

test('fallback chain: circuit opens after threshold and skips source', async () => {
  let calls = 0;
  const chain = new FallbackChain({
    sources: [
      { source: 'cloud', sourceId: 'bad-cloud', enabled: true },
      { source: 'local', sourceId: 'qwen3-4b', enabled: true },
    ],
    failureThreshold: 2,
    resetTimeoutMs: 60_000,
    executor: async (source) => {
      calls += 1;
      if (source === 'cloud') return { ok: false, error: 'boom' };
      return { ok: true, promptTokens: 10, completionTokens: 5, pricePer1kTokensUsd: 0.0001 };
    },
  });
  await chain.run(); // cloud fail 1
  await chain.run(); // cloud fail 2 -> circuit open
  const third = await chain.run(); // cloud skipped
  assert.equal(third.attempts[0].outcome, 'skipped-circuit-open');
  assert.equal(third.servedBy, 'local');
  const health = chain.healthSnapshot();
  assert.equal(health.find((h) => h.sourceId === 'bad-cloud').circuit, 'open');
});

test('fallback chain: budget gate skips cloud but still tries local', async () => {
  const chain = new FallbackChain({
    sources: [
      { source: 'cloud', sourceId: 'gemini-2.5-flash', enabled: true },
      { source: 'local', sourceId: 'qwen3-4b', enabled: true },
    ],
    executor: async () => ({ ok: true, promptTokens: 10, completionTokens: 5, pricePer1kTokensUsd: 0.0001 }),
  });
  const result = await chain.run({ budgetGate: (source) => source !== 'cloud' });
  assert.equal(result.ok, true);
  assert.equal(result.attempts[0].outcome, 'skipped-budget');
  assert.equal(result.servedBy, 'local');
});

test('fallback chain: healthCheckAll updates breakers', async () => {
  const chain = new FallbackChain({
    sources: [{ source: 'cloud', sourceId: 'c1', enabled: true }],
    failureThreshold: 1,
    executor: async () => ({ ok: false, error: 'x' }),
  });
  const res = await chain.healthCheckAll(async () => false);
  assert.deepEqual(res, [{ sourceId: 'c1', healthy: false }]);
  assert.equal(chain.healthSnapshot()[0].circuit, 'open');
  const res2 = await chain.healthCheckAll(async () => true);
  assert.equal(res2[0].healthy, true);
  assert.equal(chain.healthSnapshot()[0].circuit, 'closed');
});

test('buildFailureGuidance: empty sources + budget hint', () => {
  assert.ok(buildFailureGuidance([]).includes('Chua co nguon'));
  const g = buildFailureGuidance([
    { source: 'cloud', sourceId: 'c', outcome: 'skipped-budget', latencyMs: 0, attemptedAt: 0 },
    { source: 'local', sourceId: 'l', outcome: 'skipped-circuit-open', latencyMs: 0, attemptedAt: 0 },
  ]);
  assert.ok(g.includes('budget'));
  assert.ok(g.includes('circuit'));
});
