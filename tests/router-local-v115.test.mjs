/**
 * Local model router v115 tests (v1.15, Doi T3 — node:test, no network,
 * no GPU, no real model).
 *
 * Covers (pure modules — catalogue, license, LRU, policy, budget):
 * - Catalogue: 12 models, Qwen3/Llama/Gemma only, unique ids, RAM
 *   monotone with params, default model = qwen3-4b, license of every
 *   entry validates as allowed.
 * - License validation: unknown/empty/unapproved license -> blocked;
 *   Apache-2.0 -> allowed, no warnings; Llama/Gemma community ->
 *   allowed + warnings.
 * - LRU: max-models eviction (LRU first), RAM eviction (biggest
 *   first), pinned/active never evicted, idle sweep, serialize round-trip.
 * - Policy router: small task -> local 3-4B; heavy code/reasoning +
 *   high qualityNeed -> cloud; manual override honored (and explained
 *   when infeasible); fallback order local-first then cloud; scoring
 *   weights respected.
 * - Budget: spend recording (token x price), daily/monthly windows,
 *   warn/exceeded states, gate blocks when exceeded, virtual keys
 *   (create/resolve/revoke/expire), rate limit, report aggregation,
 *   serialize round-trip.
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/router-local-v115.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ALLOWED_LICENSE_NAMES,
  DEFAULT_LOCAL_MODEL_ID,
  DEFAULT_POLICY_CONFIG,
  DEFAULT_ROUTER_MODEL_ID,
  LOCAL_MODEL_CATALOG,
  LocalBudgetTracker,
  LruModelCache,
  PolicyRouter,
  RamTracker,
  bestLocalModelFor,
  budgetWindow,
  costOfCall,
  explainDecision,
  findLocalModel,
  localModelsFittingRam,
  localModelsForUseCase,
  pricePer1kTokens,
  taskHeaviness,
  validateModelLicense,
} from '../packages/core/dist/router/local/index.js';

const GB = 1024 * 1024 * 1024;

test('catalogue: 12 models, families Qwen3/Llama/Gemma, unique ids', () => {
  assert.equal(LOCAL_MODEL_CATALOG.length, 12);
  const ids = new Set(LOCAL_MODEL_CATALOG.map((m) => m.id));
  assert.equal(ids.size, 12);
  for (const m of LOCAL_MODEL_CATALOG) {
    assert.ok(['qwen3', 'llama', 'gemma', 'qwen2.5-coder'].includes(m.family), m.id);
    assert.ok(m.paramsB > 0, m.id);
    assert.ok(m.ggufSizeBytes > 0, m.id);
    assert.ok(m.ramRequiredBytes > m.ggufSizeBytes, `${m.id}: RAM phai lon hon GGUF (KV cache)`);
    assert.ok(m.contextTokens >= 32768, m.id);
    assert.ok(m.useCases.length > 0, m.id);
    assert.ok(m.qualityTier >= 1 && m.qualityTier <= 5, m.id);
    assert.ok(m.license.name.length > 0, m.id);
    assert.ok(m.license.url.startsWith('https://'), m.id);
  }
  assert.equal(DEFAULT_LOCAL_MODEL_ID, 'qwen3-4b');
  assert.equal(DEFAULT_ROUTER_MODEL_ID, 'qwen3-0.6b');
  assert.equal(findLocalModel('qwen3-4b')?.label, 'Qwen3 4B');
  assert.equal(findLocalModel('khong-co'), undefined);
});

test('catalogue: RAM requirement grows with params inside a family', () => {
  const qwen = LOCAL_MODEL_CATALOG.filter((m) => m.family === 'qwen3').sort((a, b) => a.paramsB - b.paramsB);
  assert.ok(qwen.length >= 5);
  for (let i = 1; i < qwen.length; i++) {
    assert.ok(qwen[i].ramRequiredBytes >= qwen[i - 1].ramRequiredBytes, `${qwen[i].id} RAM phai >= ${qwen[i - 1].id}`);
  }
  // Fleet default fits in 8 GB; biggest needs >= 28 GB.
  assert.ok(findLocalModel('qwen3-4b').ramRequiredBytes <= 8 * GB);
  assert.ok(findLocalModel('qwen3-32b').ramRequiredBytes >= 28 * GB);
});

test('catalogue: every entry license validates as allowed', () => {
  for (const m of LOCAL_MODEL_CATALOG) {
    const v = validateModelLicense(m);
    assert.equal(v.allowed, true, `${m.id} (${m.license.name}) phai allowed`);
    assert.ok(v.kind === 'open-source' || v.kind === 'community', m.id);
  }
  // Apache-2.0 entries have no warnings; community ones warn.
  const qwen = validateModelLicense(findLocalModel('qwen3-4b'));
  assert.equal(qwen.kind, 'open-source');
  assert.deepEqual(qwen.warnings, []);
  const llama = validateModelLicense(findLocalModel('llama-3.2-3b'));
  assert.equal(llama.kind, 'community');
  assert.ok(llama.warnings.length > 0);
  const gemma = validateModelLicense(findLocalModel('gemma-3-4b'));
  assert.equal(gemma.kind, 'community');
  assert.ok(gemma.warnings.length > 0);
});

test('license: unknown / empty / unapproved license is blocked', () => {
  const noLicense = validateModelLicense({ id: 'x', license: { name: '', url: '', commercialUse: false, redistribution: false, openSource: false, notes: [] } });
  assert.equal(noLicense.allowed, false);
  assert.equal(noLicense.kind, 'unknown');
  assert.ok(noLicense.reasons.length > 0);
  const weird = validateModelLicense({ id: 'y', license: { name: 'Proprietary EULA v9', url: 'https://example.com', commercialUse: false, redistribution: false, openSource: false, notes: [] } });
  assert.equal(weird.allowed, false);
  assert.match(weird.reasons.join(' '), /chua duoc phe duyet/);
  // Allowlist contains exactly the known-good names.
  assert.ok((ALLOWED_LICENSE_NAMES).includes('Apache License 2.0'));
  assert.ok((ALLOWED_LICENSE_NAMES).includes('Gemma Terms of Use'));
});

test('catalogue helpers: use-case filter + RAM fit', () => {
  const code = localModelsForUseCase('code');
  assert.ok(code.length >= 4);
  assert.ok(code.every((m) => m.useCases.includes('code')));
  const fitting8 = localModelsFittingRam(8 * GB);
  assert.ok(fitting8.length > 0);
  assert.ok(fitting8.every((m) => m.ramRequiredBytes <= 8 * GB));
  assert.ok(!fitting8.some((m) => m.id === 'qwen3-32b'));
  // Sorted by quality desc.
  for (let i = 1; i < fitting8.length; i++) {
    assert.ok(fitting8[i].qualityTier <= fitting8[i - 1].qualityTier);
  }
  assert.equal(bestLocalModelFor('code', 8 * GB)?.id, 'qwen3-8b');
  assert.equal(bestLocalModelFor('code', 1 * GB), undefined);
});

test('RamTracker: budget defaults to 80% total, fits() respects budget', () => {
  const tracker = new RamTracker({ readRam: () => ({ totalBytes: 16 * GB, freeBytes: 10 * GB }) });
  assert.equal(tracker.getBudgetBytes(), Math.floor(16 * GB * 0.8));
  assert.equal(tracker.availableForModels(2 * GB), Math.floor(16 * GB * 0.8) - 2 * GB);
  assert.equal(tracker.fits(findLocalModel('qwen3-4b'), 0), true);
  assert.equal(tracker.fits(findLocalModel('qwen3-32b'), 0), false);
  const snap = tracker.snapshot(2 * GB);
  assert.equal(snap.totalBytes, 16 * GB);
  assert.equal(snap.usedByModelsBytes, 2 * GB);
});

test('LRU: max-models evicts least-recently-used first', () => {
  const cache = new LruModelCache({ maxLoadedModels: 2, maxRamBytes: 0 });
  cache.markLoaded('qwen3-0.6b', 1.2 * GB);
  cache.markLoaded('qwen3-4b', 4.5 * GB);
  // Touch 4b so 0.6b is LRU.
  cache.touch('qwen3-4b', Date.now() + 1000);
  const plan = cache.planEviction(2 * GB, Date.now() + 2000);
  assert.equal(plan.reason, 'max-models');
  assert.deepEqual(plan.toUnload, ['qwen3-0.6b']);
  assert.equal(cache.canLoadWithoutEviction(2 * GB), false);
});

test('LRU: pinned and active models are never evicted', () => {
  const cache = new LruModelCache({ maxLoadedModels: 1, maxRamBytes: 0 });
  cache.markLoaded('qwen3-4b', 4.5 * GB, { pinned: true });
  cache.setActiveTasks('qwen3-4b', 2);
  const plan = cache.planEviction(1 * GB);
  assert.deepEqual(plan.toUnload, []);
  assert.ok(plan.blocked.includes('qwen3-4b'));
  // Unpin + finish tasks -> evictable again.
  cache.pin('qwen3-4b', false);
  cache.setActiveTasks('qwen3-4b', 0);
  const plan2 = cache.planEviction(1 * GB);
  assert.deepEqual(plan2.toUnload, ['qwen3-4b']);
});

test('LRU: RAM cap evicts biggest first to free enough with fewest unloads', () => {
  const cache = new LruModelCache({ maxLoadedModels: 5, maxRamBytes: 10 * GB });
  cache.markLoaded('qwen3-0.6b', 1.2 * GB);
  cache.markLoaded('qwen3-4b', 4.5 * GB);
  cache.markLoaded('qwen3-8b', 8 * GB);
  // Total 13.7 GB; new 2 GB model -> projected 15.7 > 10, need free 5.7 GB.
  const plan = cache.planEviction(2 * GB);
  assert.equal(plan.reason, 'ram');
  assert.ok(plan.toUnload.includes('qwen3-8b'), 'phai unload model lon truoc');
  assert.ok(plan.freedBytes >= 5.7 * GB);
});

test('LRU: idle sweep only touches idle, non-pinned, non-active models', () => {
  const now = Date.now();
  const cache = new LruModelCache({ maxLoadedModels: 5, idleTimeoutMs: 60_000 });
  cache.markLoaded('a', 1 * GB);
  cache.markLoaded('b', 1 * GB);
  cache.markLoaded('c', 1 * GB);
  cache.touch('a', now - 120_000); // idle
  cache.touch('b', now - 10_000); // recent
  cache.touch('c', now - 120_000);
  cache.setActiveTasks('c', 1); // idle but busy
  const plan = cache.planIdleSweep(now);
  assert.deepEqual(plan.toUnload, ['a']);
  assert.equal(plan.reason, 'idle');
  assert.equal(plan.freedBytes, 1 * GB);
});

test('LRU: serialize round-trip keeps entries (activeTasks reset)', () => {
  const cache = new LruModelCache({ maxLoadedModels: 3 });
  cache.markLoaded('qwen3-4b', 4.5 * GB, { pinned: true });
  cache.setActiveTasks('qwen3-4b', 3);
  const restored = LruModelCache.fromJSON(cache.toJSON(), { maxLoadedModels: 3 });
  assert.equal(restored.size(), 1);
  assert.equal(restored.get('qwen3-4b')?.pinned, true);
  assert.equal(restored.get('qwen3-4b')?.activeTasks, 0);
});

test('policy: small chat task routes to a local 3-4B model', () => {
  const router = new PolicyRouter();
  const d = router.decide(
    { kind: 'simple-chat', promptTokens: 120, needsToolUse: false, needsLongContext: false, qualityNeed: 0.3 },
    { loadedModelIds: new Set(['qwen3-4b']), availableRamBytes: 8 * GB },
  );
  assert.equal(d.chosen.kind, 'local');
  assert.equal(d.manualOverride, false);
  assert.ok(d.fallbacks.length > 0);
  assert.match(d.reason, /local/);
  assert.ok(explainDecision(d).includes(d.chosen.modelId));
});

test('policy: heavy code + high qualityNeed forces cloud', () => {
  const router = new PolicyRouter();
  const d = router.decide(
    { kind: 'code', promptTokens: 12000, needsToolUse: true, needsLongContext: false, qualityNeed: 0.95 },
    { loadedModelIds: new Set(['qwen3-4b']), availableRamBytes: 8 * GB },
  );
  assert.equal(d.chosen.kind, 'cloud');
  assert.match(d.reason, /nang/);
  // Fallbacks still include local models after cloud ones.
  assert.ok(d.fallbacks.some((f) => f.kind === 'local'));
});

test('policy: taskHeaviness grows with kind + tokens + tool-use', () => {
  const light = taskHeaviness({ kind: 'simple-chat', promptTokens: 50, needsToolUse: false, needsLongContext: false, qualityNeed: 0.1 });
  const heavy = taskHeaviness({ kind: 'code', promptTokens: 12000, needsToolUse: true, needsLongContext: true, qualityNeed: 0.9 });
  assert.ok(light < 0.3, `light=${light}`);
  assert.ok(heavy > 0.8, `heavy=${heavy}`);
});

test('policy: manual override is honored; infeasible override falls back with reason', () => {
  const router = new PolicyRouter();
  const ok = router.decide(
    { kind: 'simple-chat', promptTokens: 100, needsToolUse: false, needsLongContext: false, qualityNeed: 0.3, manualModelId: 'qwen3-4b' },
    { loadedModelIds: new Set(), availableRamBytes: 8 * GB },
  );
  assert.equal(ok.manualOverride, true);
  assert.equal(ok.chosen.modelId, 'qwen3-4b');
  // Override to a model that lacks tool-use support for this task.
  const bad = router.decide(
    { kind: 'code', promptTokens: 100, needsToolUse: true, needsLongContext: false, qualityNeed: 0.3, manualModelId: 'gemma-3-12b' },
    { loadedModelIds: new Set(), availableRamBytes: 8 * GB },
  );
  assert.equal(bad.manualOverride, false);
  assert.match(bad.reason, /Override/);
  assert.match(bad.reason, /tool-use/);
  // Override to a catalogue model that does not serve this task kind.
  const wrongKind = router.decide(
    { kind: 'code', promptTokens: 100, needsToolUse: false, needsLongContext: false, qualityNeed: 0.3, manualModelId: 'qwen3-0.6b' },
    { loadedModelIds: new Set(), availableRamBytes: 8 * GB },
  );
  assert.equal(wrongKind.manualOverride, false);
  assert.match(wrongKind.reason, /khong ho tro task "code"/);
  // Override to a nonexistent model.
  const ghost = router.decide(
    { kind: 'simple-chat', promptTokens: 100, needsToolUse: false, needsLongContext: false, qualityNeed: 0.3, manualModelId: 'khong-co' },
    { loadedModelIds: new Set(), availableRamBytes: 8 * GB },
  );
  assert.equal(ghost.manualOverride, false);
  assert.match(ghost.reason, /khong co trong catalogue/);
});

test('policy: weights decide for heavy tasks (light tasks always go local first)', () => {
  // Task code 2000 token: heaviness 0.575 -> di scoring, khong bi luat task-nhe chan.
  const task = { kind: 'code', promptTokens: 2000, needsToolUse: false, needsLongContext: false, qualityNeed: 0.5 };
  const env = { loadedModelIds: new Set(), availableRamBytes: 8 * GB };
  // Bang gia cloud khong co gemini-flash sieu re — de trong so quyet dinh that.
  const priceyCloud = {
    'grok-4.7': { inputUsdPer1k: 0.003, quality: 0.97, estLatencyMs: 900 },
    'claude-sonnet-4.5': { inputUsdPer1k: 0.003, quality: 0.96, estLatencyMs: 1100 },
    'gpt-5': { inputUsdPer1k: 0.005, quality: 0.97, estLatencyMs: 1000 },
  };
  const costFirst = new PolicyRouter({ weights: { cost: 0.8, latency: 0.1, quality: 0.1 } }, priceyCloud);
  const d = costFirst.decide(task, env);
  assert.equal(d.chosen.kind, 'local');
  const qualityFirst = new PolicyRouter({ weights: { cost: 0.05, latency: 0.05, quality: 0.9 } }, priceyCloud);
  const d2 = qualityFirst.decide(task, env);
  assert.equal(d2.chosen.kind, 'cloud');
  // Task nhe thi trong so chat luong cung khong keo sang cloud.
  const light = { kind: 'summarize', promptTokens: 500, needsToolUse: false, needsLongContext: false, qualityNeed: 0.2 };
  const d3 = qualityFirst.decide(light, { loadedModelIds: new Set(['qwen3-4b']), availableRamBytes: 8 * GB });
  assert.equal(d3.chosen.kind, 'local');
  assert.match(d3.reason, /Task nhe/);
});

test('policy: no eligible candidate -> hard fallback to cheapest cloud', () => {
  const router = new PolicyRouter();
  const d = router.decide(
    { kind: 'code', promptTokens: 100, needsToolUse: true, needsLongContext: true, qualityNeed: 0.3 },
    { loadedModelIds: new Set(), availableRamBytes: 0 },
  );
  // Local models all excluded (no RAM); cloud still eligible, so this
  // path only triggers when even cloud is gone — simulate via empty prices.
  assert.ok(d.chosen);
  const empty = new PolicyRouter(undefined, {});
  const d2 = empty.decide(
    { kind: 'code', promptTokens: 100, needsToolUse: true, needsLongContext: false, qualityNeed: 0.3 },
    { loadedModelIds: new Set(), availableRamBytes: 0 },
  );
  assert.equal(d2.chosen.modelId, 'gemini-2.5-flash');
  assert.equal(d2.fallbacks.length, 0);
  assert.match(d2.reason, /fallback cung/);
});

test('budget: costOfCall + price table', () => {
  assert.equal(costOfCall(1000, 1000, 0.003), 0.006);
  assert.equal(costOfCall(0, 0, 0.003), 0);
  assert.equal(costOfCall(-5, 10, 0.001), 0.00001);
  assert.equal(pricePer1kTokens('qwen3-4b', 'local'), 0.0001);
  assert.equal(pricePer1kTokens('grok-4.7', 'cloud'), 0.003);
  assert.equal(pricePer1kTokens('model-la', 'cloud'), 0.001);
});

test('budget: windows are calendar-aligned', () => {
  const at = new Date(2026, 10, 16, 15, 30).getTime();
  const daily = budgetWindow('daily', at);
  assert.equal(new Date(daily.start).getHours(), 0);
  assert.equal(daily.end - daily.start, 24 * 60 * 60 * 1000);
  const monthly = budgetWindow('monthly', at);
  assert.equal(new Date(monthly.start).getDate(), 1);
  assert.equal(new Date(monthly.start).getMonth(), 10);
  assert.equal(new Date(monthly.end).getMonth(), 11);
});

test('budget: recordSpend + status warn/exceeded + gate', () => {
  const t = new LocalBudgetTracker();
  t.setGlobalBudget({ period: 'daily', limitUsd: 1, warnAt: 0.8, blockOnExceed: true });
  // 100k tokens cloud grok-4.7 @ $0.003/1k = $0.30.
  t.recordSpend({ botId: 'bot1', modelId: 'grok-4.7', kind: 'cloud', promptTokens: 60000, completionTokens: 40000 });
  let s = t.status();
  assert.equal(s.state, 'ok');
  assert.ok(Math.abs(s.spentUsd - 0.3) < 1e-9);
  t.recordSpend({ botId: 'bot1', modelId: 'grok-4.7', kind: 'cloud', promptTokens: 100000, completionTokens: 100000 });
  s = t.status();
  assert.equal(s.state, 'warning');
  assert.ok(s.usageRatio >= 0.8 && s.usageRatio < 1);
  assert.equal(t.gate().allowed, true);
  t.recordSpend({ botId: 'bot1', modelId: 'grok-4.7', kind: 'cloud', promptTokens: 100000, completionTokens: 100000 });
  s = t.status();
  assert.equal(s.state, 'exceeded');
  assert.equal(t.gate().allowed, false);
  assert.match(t.gate().reason, /vuot/);
  // Per-bot budget overrides global.
  t.setBotBudget('bot2', { period: 'daily', limitUsd: 100, warnAt: 0.8, blockOnExceed: true });
  assert.equal(t.status('bot2').state, 'ok');
  assert.equal(t.gate('bot2').allowed, true);
});

test('budget: blockOnExceed=false lets calls through but warns', () => {
  const t = new LocalBudgetTracker();
  t.setGlobalBudget({ period: 'daily', limitUsd: 0.01, warnAt: 0.5, blockOnExceed: false });
  t.recordSpend({ botId: 'b', modelId: 'gpt-5', kind: 'cloud', promptTokens: 10000, completionTokens: 10000 });
  assert.equal(t.status().state, 'exceeded');
  assert.equal(t.gate().allowed, true);
});

test('budget: unlimited when no budget set', () => {
  const t = new LocalBudgetTracker();
  t.recordSpend({ botId: 'b', modelId: 'qwen3-4b', kind: 'local', promptTokens: 1000, completionTokens: 1000 });
  assert.equal(t.status().state, 'unlimited');
  assert.equal(t.status().limitUsd, 0);
  assert.equal(t.gate().allowed, true);
});

test('budget: virtual keys create/resolve/revoke/expire', () => {
  const t = new LocalBudgetTracker();
  const { key, secret } = t.createVirtualKey('bot1');
  assert.ok(secret.startsWith('obk_'));
  assert.ok(key.keyHint.includes('...'));
  assert.equal(key.botId, 'bot1');
  assert.equal(t.resolveKey(secret)?.id, key.id);
  assert.equal(t.resolveKey('obk_sai'), undefined);
  assert.equal(t.revokeKey(key.id), true);
  assert.equal(t.resolveKey(secret), undefined);
  assert.equal(t.revokeKey('khong-co'), false);
  // Expired key.
  const expired = t.createVirtualKey('bot1', { expiresAt: Date.now() - 1000 });
  assert.equal(t.resolveKey(expired.secret), undefined);
  // Keys listable per bot.
  assert.equal(t.listKeys('bot1').length, 2);
  assert.equal(t.listKeys('bot-khac').length, 0);
});

test('budget: virtual key budget is enforced independently of bot budget', () => {
  const t = new LocalBudgetTracker();
  const { key, secret } = t.createVirtualKey('bot1', {
    budget: { period: 'monthly', limitUsd: 0.01, warnAt: 0.5, blockOnExceed: true },
  });
  assert.equal(t.resolveKey(secret)?.id, key.id);
  assert.equal(t.keyStatus(key).state, 'ok');
  // Spend $0.006 qua key nay (2000 token grok-4.7) -> warning (>50%).
  t.recordSpend({ botId: 'bot1', modelId: 'grok-4.7', kind: 'cloud', promptTokens: 1000, completionTokens: 1000, virtualKeyId: key.id });
  assert.equal(t.keyStatus(key).state, 'warning');
  assert.ok(Math.abs(t.spentForKey(key) - 0.006) < 1e-12);
  // Spend cua key khac / khong key khong tinh vao key nay.
  t.recordSpend({ botId: 'bot1', modelId: 'grok-4.7', kind: 'cloud', promptTokens: 10000, completionTokens: 10000 });
  assert.equal(t.keyStatus(key).state, 'warning');
  t.recordSpend({ botId: 'bot1', modelId: 'grok-4.7', kind: 'cloud', promptTokens: 1000, completionTokens: 1000, virtualKeyId: key.id });
  assert.equal(t.keyStatus(key).state, 'exceeded');
  // Bot khong dat budget -> unlimited; key bi chan rieng.
  assert.equal(t.status('bot1').state, 'unlimited');
});

test('budget: rate limit per key per minute', () => {
  const t = new LocalBudgetTracker();
  const now = Date.now();
  assert.equal(t.checkRateLimit('k1', 2, now), true);
  assert.equal(t.checkRateLimit('k1', 2, now), true);
  assert.equal(t.checkRateLimit('k1', 2, now), false);
  assert.equal(t.checkRateLimit('k1', 2, now + 61_000), true);
  assert.equal(t.checkRateLimit('k2', 0, now), true);
});

test('budget: report aggregates by model/bot + local vs cloud split', () => {
  const t = new LocalBudgetTracker();
  t.recordSpend({ botId: 'a', modelId: 'qwen3-4b', kind: 'local', promptTokens: 1000, completionTokens: 1000 });
  t.recordSpend({ botId: 'a', modelId: 'grok-4.7', kind: 'cloud', promptTokens: 1000, completionTokens: 0 });
  t.recordSpend({ botId: 'b', modelId: 'grok-4.7', kind: 'cloud', promptTokens: 2000, completionTokens: 0 });
  const r = t.report('monthly');
  assert.equal(r.totalCalls, 3);
  assert.equal(r.totalTokens, 2000 + 1000 + 2000);
  assert.equal(r.byModel.length, 2);
  assert.equal(r.byModel[0].modelId, 'grok-4.7');
  assert.equal(r.byBot.length, 2);
  assert.ok(r.cloudUsd > r.localUsd);
  assert.ok(Math.abs(r.totalUsd - (r.localUsd + r.cloudUsd)) < 1e-12);
  // Filter by bot.
  assert.equal(t.report('monthly', Date.now(), 'a').totalCalls, 2);
});

test('budget: prune + serialize round-trip', () => {
  const t = new LocalBudgetTracker();
  t.setGlobalBudget({ period: 'monthly', limitUsd: 5, warnAt: 0.8, blockOnExceed: true });
  t.recordSpend({ botId: 'a', modelId: 'qwen3-4b', kind: 'local', promptTokens: 100, completionTokens: 100, at: Date.now() - 40 * 24 * 60 * 60 * 1000 });
  t.recordSpend({ botId: 'a', modelId: 'qwen3-4b', kind: 'local', promptTokens: 100, completionTokens: 100 });
  assert.equal(t.pruneOlderThan(30 * 24 * 60 * 60 * 1000), 1);
  assert.equal(t.recordCount(), 1);
  const restored = LocalBudgetTracker.fromJSON(t.toJSON());
  assert.equal(restored.recordCount(), 1);
  assert.equal(restored.getGlobalBudget()?.limitUsd, 5);
  assert.equal(restored.status().state, 'ok');
});

test('policy config defaults are sane', () => {
  assert.deepEqual(DEFAULT_POLICY_CONFIG.weights, { cost: 0.4, latency: 0.3, quality: 0.3 });
  assert.equal(DEFAULT_POLICY_CONFIG.cloudQualityThreshold, 0.85);
});
