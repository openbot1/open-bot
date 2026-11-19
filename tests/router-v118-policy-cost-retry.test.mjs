/**
 * Router local v118 — bot policy + cost-aware routing + retry/backoff
 * (v1.41, Doi T3, node:test).
 *
 * Covers (thuan, khong model that, khong network):
 * - Bot policy: validate (rong, am, overlap, maxScript > maxTurn),
 *   normalize (sort/dedupe), merge chat nhat thang (allow giao nhau,
 *   deny hop nhat, min gioi han, allowScript ca hai), isToolAllowed /
 *   isProviderAllowed (deny thang allow), filterToolsByPolicy,
 *   BotPolicyStore (global + bot + effective + remove).
 * - Cost routing: task de -> local $0; task kho/anh -> model dat
 *   chuan re nhat; budget loai model dat; tiet kiem vs model manh
 *   nhat; ledger (total/byModel/snapshot) + summarizeCostSaving.
 * - Retry: phan loai 429/5xx/timeout/network/400 tool_choice/
 *   sampling/fingerprint/401/403/404/400 chung; planRetry (dac biet
 *   chi 1 retry, thuong theo maxAttempts, delay tang exponential +
 *   jitter deterministic theo seed); Retry-After; cooldown tracker
 *   (5 loi lien tiep -> cooldown 60s).
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/router-v118-policy-cost-retry.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BotPolicyStore,
  filterToolsByPolicy,
  isProviderAllowed,
  isToolAllowed,
  mergeBotRouterPolicies,
  normalizeBotRouterPolicy,
  validateBotRouterPolicy,
} from '../packages/core/dist/router/local/botPolicyV118.js';

import {
  CostLedger,
  chooseCostAwareModel,
  defaultCostCandidates,
  estimateTurnCost,
  requiredQualityForDifficulty,
  summarizeCostSaving,
} from '../packages/core/dist/router/local/costAwareRoutingV118.js';

import {
  ProviderCooldownTracker,
  classifyProviderErrorV118,
  computeRetryDelayMs,
  defaultRetryConfig,
  effectiveRateLimitDelayMs,
  parseRetryAfterMs,
  planRetry,
  seededRandom,
} from '../packages/core/dist/router/local/retryBackoffV118.js';

test('bot policy: validate bat loi', () => {
  assert.equal(validateBotRouterPolicy({ botId: '' }).ok, false);
  assert.equal(validateBotRouterPolicy({ botId: 'b1', maxToolsPerTurn: -1 }).ok, false);
  assert.equal(validateBotRouterPolicy({ botId: 'b1', maxScriptCalls: 10, maxToolsPerTurn: 5 }).ok, false);
  assert.equal(validateBotRouterPolicy({ botId: 'b1', allowTools: ['a b'] }).ok, false);
  // Overlap allow/deny -> loi (nhung deny van thang khi chay).
  const overlap = validateBotRouterPolicy({ botId: 'b1', allowTools: ['a'], denyTools: ['a'] });
  assert.equal(overlap.ok, false);
  assert.ok(overlap.errors.join(' ').includes('deny'));
  assert.equal(validateBotRouterPolicy({ botId: 'b1', allowTools: ['a'], maxCostUsdPerTurn: 1 }).ok, true);
});

test('bot policy: normalize + merge chat nhat thang', () => {
  const normalized = normalizeBotRouterPolicy({
    botId: ' b1 ',
    allowTools: ['z', 'a', 'z'],
    denyTools: ['x'],
  });
  assert.equal(normalized.botId, 'b1');
  assert.deepEqual(normalized.allowTools, ['a', 'z']);
  assert.equal(normalized.allowScript, true);
  assert.equal(normalized.maxScriptCalls, 32);

  const base = normalizeBotRouterPolicy({
    botId: 'g', allowTools: ['a', 'b', 'c'], denyTools: ['x'], maxToolsPerTurn: 10, maxCostUsdPerTurn: 5, allowScript: true,
  });
  const over = normalizeBotRouterPolicy({
    botId: 'b1', allowTools: ['b', 'c', 'd'], denyTools: ['y'], maxToolsPerTurn: 4, maxCostUsdPerTurn: 0, allowScript: false,
  });
  const merged = mergeBotRouterPolicies(base, over);
  assert.deepEqual(merged.allowTools, ['b', 'c']); // giao nhau
  assert.deepEqual(merged.denyTools, ['x', 'y']); // hop nhat
  assert.equal(merged.maxToolsPerTurn, 4); // min
  assert.equal(merged.maxCostUsdPerTurn, 5); // 0 = khong gioi han -> lay 5
  assert.equal(merged.allowScript, false); // ca hai moi true
});

test('bot policy: allow/deny + store', () => {
  const policy = normalizeBotRouterPolicy({
    botId: 'b1', allowTools: ['search', 'read'], denyTools: ['read'], allowProviders: ['openai'], denyProviders: ['xai'],
  });
  // deny thang allow.
  assert.equal(isToolAllowed(policy, 'read').allowed, false);
  assert.equal(isToolAllowed(policy, 'search').allowed, true);
  assert.equal(isToolAllowed(policy, 'write').allowed, false);
  assert.equal(isProviderAllowed(policy, 'openai').allowed, true);
  assert.equal(isProviderAllowed(policy, 'xai').allowed, false);
  assert.equal(isProviderAllowed(policy, 'gemini').allowed, false);

  const filtered = filterToolsByPolicy(policy, ['search', 'read', 'write']);
  assert.deepEqual(filtered.allowed, ['search']);
  assert.equal(filtered.denied.length, 2);

  const store = new BotPolicyStore();
  store.setGlobal({ botId: 'g', denyTools: ['danger'] });
  assert.equal(store.setBot({ botId: 'b1', allowTools: ['search'] }).ok, true);
  assert.equal(store.setBot({ botId: '', allowTools: [] }).ok, false);
  const effective = store.effectivePolicy('b1');
  assert.equal(isToolAllowed(effective, 'danger').allowed, false); // deny global
  assert.equal(isToolAllowed(effective, 'search').allowed, true);
  assert.deepEqual(store.listBotIds(), ['b1']);
  assert.equal(store.count(), 1);
  assert.equal(store.removeBot('b1'), true);
  assert.equal(store.getBot('b1'), null);
});

test('cost routing: de -> local $0, kho/anh -> model dat chuan re nhat', () => {
  const candidates = defaultCostCandidates();
  const easy = chooseCostAwareModel({ difficulty: 0.1 }, candidates);
  assert.equal(easy.chosenModelId, 'qwen3-0.6b');
  assert.equal(easy.estimatedCostUsd, 0);
  assert.equal(easy.provider, 'ollama');

  const hard = chooseCostAwareModel({ difficulty: 0.9 }, candidates);
  assert.ok(hard.quality >= 0.9);
  assert.ok(hard.estimatedCostUsd > 0);
  // Re nhat trong nhom dat quality >= 0.9: sonnet-4-5 va grok-4-1
  // dong gia (0.0105 USD/turn) — hoa thi lay latency thap hon.
  assert.equal(hard.chosenModelId, 'claude-sonnet-4-5');
  assert.equal(hard.estimatedCostUsd, 0.0105);
  assert.ok(hard.savedUsd >= 0);
  assert.ok(hard.reasons.length >= 1);

  const image = chooseCostAwareModel({ difficulty: 0.2, hasImage: true }, candidates);
  assert.notEqual(image.chosenModelId, 'qwen3-0.6b');
  assert.ok(image.rejected.some((r) => r.reason.includes('da phuong thuc')));

  // Budget sieu nho loai het model tra phi -> local dat chuan van duoc.
  const budgeted = chooseCostAwareModel({ difficulty: 0.1, budgetRemainingUsd: 0.0001 }, candidates);
  assert.equal(budgeted.chosenModelId, 'qwen3-0.6b');

  // Nguong quality theo do kho.
  assert.equal(requiredQualityForDifficulty(0.1), 0.45);
  assert.equal(requiredQualityForDifficulty(0.6), 0.8);
  assert.equal(requiredQualityForDifficulty(0.95), 0.9);

  // estimateTurnCost: 1000 in + 500 out tren gpt-5-mini.
  const mini = candidates.find((c) => c.modelId === 'gpt-5-mini');
  assert.equal(estimateTurnCost(mini, 1000, 500), 0.00125);
});

test('cost ledger: tong hop + tiet kiem vs model manh nhat', () => {
  const ledger = new CostLedger();
  ledger.record({ botId: 'b1', modelId: 'qwen3-4b', provider: 'ollama', inputTokens: 1000, outputTokens: 500, costUsd: 0 });
  ledger.record({ botId: 'b1', modelId: 'gpt-5-mini', provider: 'openai', inputTokens: 1000, outputTokens: 500, costUsd: 0.00125 });
  ledger.record({ botId: 'b2', modelId: 'gpt-5-mini', provider: 'openai', inputTokens: 2000, outputTokens: 500, costUsd: 0.0015 });
  assert.equal(ledger.count(), 3);
  assert.equal(ledger.totalCostUsd('b1'), 0.00125);
  assert.equal(ledger.totalCostUsd(), 0.00275);
  assert.deepEqual(ledger.totalTokens('b1'), { input: 2000, output: 1000 });
  assert.equal(ledger.byModel('b1')[0].modelId, 'gpt-5-mini');
  assert.equal(ledger.snapshot('b2').length, 1);

  const saving = summarizeCostSaving(ledger, defaultCostCandidates(), 'b1');
  assert.equal(saving.turns, 2);
  assert.equal(saving.spentUsd, 0.00125);
  // Neu chay toan opus-5-1 (manh nhat, quality 1): (1000*.005+500*.025)*2 = 0.035.
  assert.equal(saving.wouldSpendUsd, 0.035);
  assert.equal(saving.savedUsd, 0.03375);
  assert.ok(saving.savedPct > 90);
});

test('retry: phan loai loi', () => {
  assert.deepEqual(
    (({ kind, retryable, action }) => ({ kind, retryable, action }))(
      classifyProviderErrorV118({ provider: 'openai', status: 429, message: 'rate limit' }),
    ),
    { kind: 'rate-limited', retryable: true, action: 'retry-same' },
  );
  const server = classifyProviderErrorV118({ provider: 'xai', status: 503, message: 'bad gateway' });
  assert.equal(server.kind, 'server-error');
  assert.equal(server.retryable, true);
  assert.equal(classifyProviderErrorV118({ provider: 'ollama', isTimeout: true }).kind, 'timeout');
  assert.equal(classifyProviderErrorV118({ provider: 'ollama', isNetwork: true }).kind, 'network');

  const toolChoice = classifyProviderErrorV118({ provider: 'anthropic', status: 400, message: 'tool_choice any is not supported' });
  assert.equal(toolChoice.kind, 'tool-choice-400');
  assert.equal(toolChoice.action, 'retry-downgrade-tool-choice');

  const sampling = classifyProviderErrorV118({ provider: 'anthropic', status: 400, message: 'temperature is not supported' });
  assert.equal(sampling.kind, 'sampling-param-400');
  assert.equal(sampling.action, 'retry-drop-sampling-params');

  const fp = classifyProviderErrorV118({ provider: 'anthropic', status: 400, message: 'thread_fingerprint_mismatch' });
  assert.equal(fp.kind, 'thread-fingerprint-mismatch');
  assert.equal(fp.action, 'retry-new-thread');

  assert.equal(classifyProviderErrorV118({ provider: 'openai', status: 401, message: 'bad key' }).retryable, false);
  assert.equal(classifyProviderErrorV118({ provider: 'openai', status: 403, message: 'forbidden' }).kind, 'auth');
  assert.equal(classifyProviderErrorV118({ provider: 'openai', status: 404, message: 'no such model' }).retryable, false);
  assert.equal(classifyProviderErrorV118({ provider: 'openai', status: 400, message: 'weird request' }).retryable, false);
  assert.equal(classifyProviderErrorV118({ provider: 'openai' }).retryable, false);
});

test('retry: plan + delay exponential + Retry-After + cooldown', () => {
  const plan = planRetry(
    { provider: 'openai', status: 429, message: 'slow down' },
    defaultRetryConfig('openai'),
    42,
  );
  assert.equal(plan.retryable, true);
  assert.equal(plan.maxAttempts, 4);
  assert.equal(plan.steps.length, 3);
  assert.ok(plan.steps[0].delayMs >= 500 && plan.steps[0].delayMs <= 625);
  assert.ok(plan.steps[1].delayMs > plan.steps[0].delayMs);
  assert.ok(plan.steps[2].delayMs > plan.steps[1].delayMs);
  // Cung seed -> cung lich (deterministic).
  const plan2 = planRetry({ provider: 'openai', status: 429, message: 'slow down' }, defaultRetryConfig('openai'), 42);
  assert.deepEqual(plan2.steps, plan.steps);

  // Loi sua duoc chi 1 retry dac biet, delay 0 (sua request chu khong cho).
  const special = planRetry(
    { provider: 'anthropic', status: 400, message: 'tool_choice any is not supported' },
    defaultRetryConfig('anthropic'),
    7,
  );
  assert.equal(special.steps.length, 1);
  assert.equal(special.steps[0].action, 'retry-downgrade-tool-choice');
  assert.equal(special.steps[0].delayMs, 0);
  assert.equal(special.maxAttempts, 2);

  // Loi khong retry -> khong co step.
  const never = planRetry({ provider: 'openai', status: 401, message: 'bad key' });
  assert.equal(never.steps.length, 0);

  // Delay tinh tay: base 500, x2, jitter 0 -> 500/1000/2000 (seeded random 0).
  assert.equal(computeRetryDelayMs({ provider: 'x', maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 30000, multiplier: 2, jitterFactor: 0 }, 1, () => 0), 500);
  assert.equal(computeRetryDelayMs({ provider: 'x', maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 30000, multiplier: 2, jitterFactor: 0 }, 2, () => 0), 1000);
  // Tran maxDelayMs.
  assert.equal(computeRetryDelayMs({ provider: 'x', maxAttempts: 9, baseDelayMs: 500, maxDelayMs: 1200, multiplier: 2, jitterFactor: 0 }, 5, () => 0), 1200);

  // seededRandom deterministic: cung seed -> cung day so.
  const r1 = seededRandom(123);
  const first = r1();
  const second = r1();
  assert.notEqual(first, second);
  const r2 = seededRandom(123);
  assert.equal(r2(), first);
  assert.equal(r2(), second);

  // Retry-After uu tien hon backoff khi lon hon.
  assert.equal(parseRetryAfterMs('120'), 120000);
  assert.equal(parseRetryAfterMs('not-a-date'), null);
  assert.equal(parseRetryAfterMs(null), null);
  assert.equal(effectiveRateLimitDelayMs('120', 500), 120000);
  assert.equal(effectiveRateLimitDelayMs(null, 500), 500);

  // Cooldown: 5 loi lien tiep -> cooldown 60s; success reset dem.
  const tracker = new ProviderCooldownTracker({ failureThreshold: 5, cooldownMs: 60000 });
  const now = 1000000;
  for (let i = 0; i < 4; i++) assert.equal(tracker.recordFailure('openai', now), false);
  assert.equal(tracker.isCoolingDown('openai', now), false);
  assert.equal(tracker.recordFailure('openai', now), true);
  assert.equal(tracker.isCoolingDown('openai', now), true);
  assert.equal(tracker.msUntilAvailable('openai', now), 60000);
  assert.equal(tracker.isCoolingDown('openai', now + 60001), false);
  tracker.recordSuccess('openai');
  assert.equal(tracker.getState('openai').consecutiveFailures, 0);
});
