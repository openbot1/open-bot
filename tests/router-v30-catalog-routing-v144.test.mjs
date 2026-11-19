/**
 * Router v30 — catalog versioned + routing theo latency do duoc / cost
 * (v1.44, Doi T5, node:test).
 *
 * Covers (thuan, khong model that, khong network):
 * - Catalog mac dinh: 18 muc, version 30, schema 1, source bundled;
 *   du 4 nhom provider (OpenAI-compatible, Gemini, Ollama, local);
 *   local mien phi; realtime chi co gpt-realtime-2.1.
 * - Validate entry: gia am / quality ngoai 0..1 / realtime thieu
 *   realtimeVoice / embedding co toolCalling / deprecated thieu ly do.
 * - Refresh thu cong: add / update / unchanged / rejected / duplicate;
 *   removeMissing=false giu model cu, =true xoa; version +1 khi co doi,
 *   giu nguyen khi khong doi.
 * - Auto-refresh co kiem soat: tat mac dinh -> khong refresh; bat +
 *   qua minInterval + co entry stale -> refresh; chua qua interval
 *   hoac khong co entry stale -> khong refresh.
 * - Stale marking: entry qua maxAge thi stale.
 * - Latency stats: EWMA/p50/p95/mean/failureRate; cap 200 mau;
 *   effectiveLatency dung so do that khi co mau, fallback khai bao
 *   khi chua co; snapshot/restore.
 * - Routing: cheapest -> local $0; fastest + toolCalling -> model co
 *   tool; realtime -> chi realtime; maxCost loai model dat; blocklist /
 *   allowlist / deprecated; forceModel; latency do duoc thang so khai
 *   bao (model cham do that bi ha diem); explain doc duoc.
 * - Policy: validate + merge (patch sai giu policy cu).
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/router-v30-catalog-routing-v144.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_MODEL_CATALOG_VERSION_V30,
  LatencyStatsStoreV30,
  defaultCatalogAutoRefreshPolicyV30,
  defaultModelCatalogV30,
  defaultRoutingPolicyV30,
  effectiveWeightsV30,
  estimateModelCostV30,
  explainRoutingDecisionV30,
  filterCatalogV30,
  findModelV30,
  mergeRoutingPolicyV30,
  refreshModelCatalogV30,
  routeModelV30,
  shouldAutoRefreshV30,
  staleCatalogEntriesV30,
  summarizeCatalogV30,
  validateModelCatalogEntryV30,
  validateRoutingPolicyV30,
} from '../packages/core/dist/routerV30/index.js';

const catalog = (now = 1_000_000) => defaultModelCatalogV30(now);

test('catalog mac dinh: 18 muc, version 30, du 4 nhom provider', () => {
  const c = catalog();
  assert.equal(c.entries.length, 18);
  assert.equal(c.catalogVersion, DEFAULT_MODEL_CATALOG_VERSION_V30);
  assert.equal(c.catalogVersion, 30);
  assert.equal(c.schemaVersion, 1);
  assert.equal(c.source, 'bundled');
  const s = summarizeCatalogV30(c);
  assert.equal(s.total, 18);
  assert.equal(s.byProvider.ollama, 3);
  assert.equal(s.byProvider.gemini, 4);
  assert.equal(s.free, 4);
  assert.equal(s.realtime, 1);
  assert.equal(s.deprecated, 0);
  const local = findModelV30(c, 'local', 'local-echo');
  assert.ok(local);
  assert.equal(local.inputPricePerMillionUsd, 0);
  const rt = findModelV30(c, 'openai', 'gpt-realtime-2.1');
  assert.ok(rt);
  assert.equal(rt.capabilities.realtimeVoice, true);
  assert.equal(rt.contextTokens, 131072);
  const gemini = filterCatalogV30(c, { provider: 'gemini' });
  assert.equal(gemini.length, 4);
  const free = filterCatalogV30(c, { tag: 'free' });
  assert.equal(free.length, 4);
  const emb = filterCatalogV30(c, { kind: 'embedding' });
  assert.equal(emb.length, 2);
  const cost = estimateModelCostV30(rt, 1_000_000, 1_000_000);
  assert.equal(cost, 20);
});

test('validate entry: bat loi gia am, quality, realtime, embedding, deprecated', () => {
  const good = findModelV30(catalog(), 'openai', 'gpt-5.2-mini');
  assert.ok(good);
  assert.deepEqual(validateModelCatalogEntryV30(good), []);
  assert.ok(validateModelCatalogEntryV30({ ...good, inputPricePerMillionUsd: -1 }).length > 0);
  assert.ok(validateModelCatalogEntryV30({ ...good, qualityScore: 1.5 }).length > 0);
  assert.ok(
    validateModelCatalogEntryV30({
      ...good,
      kind: 'realtime',
      capabilities: { ...good.capabilities, realtimeVoice: false },
    }).length > 0,
  );
  const emb = findModelV30(catalog(), 'gemini', 'gemini-embedding-001');
  assert.ok(emb);
  assert.ok(
    validateModelCatalogEntryV30({
      ...emb,
      capabilities: { ...emb.capabilities, toolCalling: true },
    }).length > 0,
  );
  assert.ok(
    validateModelCatalogEntryV30({ ...good, deprecated: true }).length > 0,
  );
  assert.ok(
    validateModelCatalogEntryV30({
      ...good,
      deprecated: true,
      deprecatedReason: 'replaced by gpt-5.3',
    }).length === 0,
  );
  assert.ok(validateModelCatalogEntryV30(null).length > 0);
  assert.ok(validateModelCatalogEntryV30({ provider: 'x' }).length > 0);
});

test('refresh thu cong: add/update/unchanged/rejected/duplicate + version', () => {
  const base = catalog();
  const { catalog: next, report } = refreshModelCatalogV30(base, [
    { provider: 'openai', modelId: 'gpt-5.2-mini', family: 'openai', kind: 'text', contextTokens: 400000, maxOutputTokens: 128000, inputPricePerMillionUsd: 0.5, outputPricePerMillionUsd: 2, qualityScore: 0.9, estimatedLatencyMs: 1200, capabilities: findModelV30(base, 'openai', 'gpt-5.2-mini').capabilities, tags: ['cheap', 'balanced'] },
    { provider: 'openai', modelId: 'gpt-5.3', family: 'openai', kind: 'text', contextTokens: 400000, maxOutputTokens: 128000, inputPricePerMillionUsd: 6, outputPricePerMillionUsd: 18, qualityScore: 0.98, estimatedLatencyMs: 2500, capabilities: { toolCalling: true, vision: true, streaming: true, longContext: true, realtimeVoice: false, reasoning: true, jsonMode: true }, tags: ['flagship'] },
    { provider: 'openai', modelId: 'gpt-5.3', family: 'openai', kind: 'text', contextTokens: 400000, maxOutputTokens: 128000, inputPricePerMillionUsd: 6, outputPricePerMillionUsd: 18, qualityScore: 0.98, estimatedLatencyMs: 2500, tags: [] },
    { provider: 'bad', modelId: 'broken', contextTokens: -5 },
  ]);
  assert.equal(report.fromVersion, 30);
  assert.equal(report.toVersion, 31);
  assert.equal(report.changed, true);
  assert.deepEqual(report.added, ['openai::gpt-5.3']);
  assert.equal(report.updated.length, 0);
  // gpt-5.2-mini giong het cu (capabilities/tags giong) -> unchanged
  assert.ok(report.unchanged.includes('openai::gpt-5.2-mini'));
  assert.equal(report.rejected.length, 2); // duplicate + invalid
  assert.ok(report.rejected.some((r) => r.key === 'openai::gpt-5.3'));
  assert.ok(report.rejected.some((r) => r.key === 'bad::broken'));
  assert.equal(next.entries.length, 19);
  assert.equal(next.source, 'host-snapshot');
  assert.ok(findModelV30(next, 'openai', 'gpt-5.3'));

  // Refresh khong doi gi -> version giu nguyen.
  const again = refreshModelCatalogV30(next, next.entries);
  assert.equal(again.report.changed, false);
  assert.equal(again.report.toVersion, 31);
  assert.equal(again.catalog.catalogVersion, 31);
});

test('refresh: cap nhat gia + removeMissing', () => {
  const base = catalog();
  const mini = findModelV30(base, 'openai', 'gpt-5.2-mini');
  const { catalog: next, report } = refreshModelCatalogV30(base, [
    { ...mini, inputPricePerMillionUsd: 0.75 },
  ]);
  assert.deepEqual(report.updated, ['openai::gpt-5.2-mini']);
  assert.equal(report.added.length, 0);
  // removeMissing=false (mac dinh): model cu van con.
  assert.equal(next.entries.length, 18);
  assert.equal(findModelV30(next, 'openai', 'gpt-5.2-mini').inputPricePerMillionUsd, 0.75);

  const removed = refreshModelCatalogV30(base, [{ ...mini }], { removeMissing: true });
  assert.equal(removed.report.removed.length, 17);
  assert.equal(removed.catalog.entries.length, 1);
  assert.equal(removed.report.changed, true);
});

test('auto-refresh co kiem soat: tat / interval / stale', () => {
  const now = 10_000_000;
  const c = catalog(1_000_000);
  const off = defaultCatalogAutoRefreshPolicyV30();
  assert.equal(off.enabled, false);
  assert.deepEqual(shouldAutoRefreshV30(c, off, now), {
    should: false,
    reason: 'auto-refresh disabled',
  });
  const on = { ...off, enabled: true, lastAutoRefreshAt: now - 1000 };
  assert.equal(shouldAutoRefreshV30(c, on, now).should, false);
  assert.equal(shouldAutoRefreshV30(c, on, now).reason, 'min interval not reached');
  const due = { ...off, enabled: true, lastAutoRefreshAt: 0 };
  // Entry moi cap nhat luc 1_000_000, staleAfter 24h, now 10_000_000 (2.5h sau) -> chua stale.
  assert.equal(shouldAutoRefreshV30(c, due, now).should, false);
  assert.equal(shouldAutoRefreshV30(c, due, now).reason, 'no stale entries');
  // 25h sau -> stale -> duoc refresh.
  const later = now + 25 * 60 * 60 * 1000;
  assert.deepEqual(shouldAutoRefreshV30(c, due, later), {
    should: true,
    reason: 'stale entries present',
  });
  // Catalog rong -> refresh.
  const empty = { ...c, entries: [] };
  assert.equal(shouldAutoRefreshV30(empty, due, now).should, true);
});

test('stale marking: entry qua maxAge thi stale', () => {
  const c = catalog(1_000_000);
  assert.equal(staleCatalogEntriesV30(c, 60_000, 1_000_000 + 30_000).length, 0);
  assert.equal(staleCatalogEntriesV30(c, 60_000, 1_000_000 + 61_000).length, 18);
});

test('latency stats: EWMA/p50/p95/mean/failure + cap mau + snapshot', () => {
  const store = new LatencyStatsStoreV30();
  assert.equal(store.stats('openai', 'gpt-5.2-mini'), null);
  const entry = findModelV30(catalog(), 'openai', 'gpt-5.2-mini');
  const eff0 = store.effectiveLatencyMs(entry);
  assert.equal(eff0.measured, false);
  assert.equal(eff0.ms, entry.estimatedLatencyMs);
  for (let i = 0; i < 10; i += 1) {
    store.record('openai', 'gpt-5.2-mini', 100 + i * 10, true, 2000 + i);
  }
  store.record('openai', 'gpt-5.2-mini', 500, false, 3000);
  const s = store.stats('openai', 'gpt-5.2-mini');
  assert.equal(s.samples, 11);
  assert.equal(s.failures, 1);
  assert.ok(Math.abs(s.failureRate - 1 / 11) < 1e-9);
  assert.equal(s.meanMs, (100 + 110 + 120 + 130 + 140 + 150 + 160 + 170 + 180 + 190 + 500) / 11);
  assert.equal(s.p50Ms, 150);
  assert.ok(s.p95Ms !== null && s.p95Ms > 190 && s.p95Ms <= 500);
  assert.ok(s.ewmaMs > 100 && s.ewmaMs < 500);
  const eff = store.effectiveLatencyMs(entry);
  assert.equal(eff.measured, true);
  assert.equal(eff.samples, 11);
  assert.equal(eff.ms, s.ewmaMs);
  // p95 null khi chua du 10 mau.
  store.record('ollama', 'llama-4-scout', 400, true, 3000);
  assert.equal(store.stats('ollama', 'llama-4-scout').p95Ms, null);
  // Snapshot/restore.
  const snap = store.snapshotV30();
  const store2 = new LatencyStatsStoreV30();
  assert.equal(store2.restoreV30(snap), 12);
  assert.equal(store2.stats('openai', 'gpt-5.2-mini').samples, 11);
  assert.equal(store2.modelCount, 2);
  // Cap 200 mau.
  const store3 = new LatencyStatsStoreV30();
  for (let i = 0; i < 250; i += 1) store3.record('x', 'y', 10, true, i);
  assert.equal(store3.stats('x', 'y').samples, 200);
  // Mau khong hop le bi bo.
  store3.record('x', 'y', -5, true);
  store3.record('x', 'y', Number.NaN, true);
  assert.equal(store3.stats('x', 'y').samples, 200);
});

test('routing: cheapest -> local $0; fastest+tool -> co tool; realtime chi realtime', () => {
  const c = catalog();
  const cheap = routeModelV30(c, {}, { ...defaultRoutingPolicyV30(), profile: 'cheapest' });
  assert.equal(cheap.ok, true);
  // Re nhat theo diem tong hop (cost 0.7 + quality 0.2): nano $0.00025
  // thang model $0 vi quality cao hon — chi phi tuyet doi van ~0.
  assert.ok(cheap.chosen.estimatedCostUsd <= 0.001);
  assert.ok(cheap.candidates.some((x) => x.estimatedCostUsd === 0));

  const fast = routeModelV30(
    c,
    { needsToolCalling: true },
    { ...defaultRoutingPolicyV30(), profile: 'fastest' },
  );
  assert.equal(fast.ok, true);
  assert.equal(fast.chosen.entry.capabilities.toolCalling, true);
  assert.ok(!fast.candidates.some((x) => !x.entry.capabilities.toolCalling));
  // Nhanh nhat theo do tre khai bao trong so co tool: gpt-realtime-2.1 (300ms).
  assert.equal(fast.chosen.entry.modelId, 'gpt-realtime-2.1');

  const rt = routeModelV30(c, { needsRealtimeVoice: true });
  assert.equal(rt.ok, true);
  assert.equal(rt.chosen.entry.modelId, 'gpt-realtime-2.1');
  assert.equal(rt.candidates.length, 1);

  const emb = routeModelV30(c, { needsEmbedding: true });
  assert.equal(emb.ok, true);
  assert.equal(emb.chosen.entry.kind, 'embedding');
  assert.ok(emb.candidates.every((x) => x.entry.kind === 'embedding'));
});

test('routing: maxCost / blocklist / allowlist / deprecated / forceModel', () => {
  const c = catalog();
  const policy = defaultRoutingPolicyV30();
  // Tran gia rat thap ($0.0001) -> chi model $0 song.
  const capped = routeModelV30(c, {}, policy, null);
  const capped2 = routeModelV30(c, { maxCostUsd: 0.0001 }, policy);
  assert.equal(capped2.ok, true);
  assert.ok(capped2.candidates.every((x) => x.estimatedCostUsd <= 0.0001));
  assert.ok(capped2.candidates.length < capped.candidates.length || capped2.candidates.length <= 5);
  // Tran gia 0 tuyet doi -> khong model nao dat (ca model $0 cung co cost 0... chi $0 dat).
  const zero = routeModelV30(c, { maxCostUsd: 0.0000001 }, policy);
  assert.ok(zero.candidates.every((x) => x.estimatedCostUsd === 0));

  // Block local-echo + tat ca ollama thi cheapest khong con la local.
  const blocked = routeModelV30(c, {}, {
    ...policy,
    profile: 'cheapest',
    blockedModels: ['local::local-echo', 'ollama::llama-4-scout', 'ollama::qwen3-32b', 'ollama::nomic-embed-text'],
  });
  assert.ok(blocked.ok);
  assert.ok(!blocked.candidates.some((x) => x.entry.provider === 'ollama'));

  // Allowlist chi gemini.
  const allowed = routeModelV30(c, {}, { ...policy, allowedProviders: ['gemini'] });
  assert.ok(allowed.ok);
  assert.ok(allowed.candidates.every((x) => x.entry.provider === 'gemini'));
  assert.ok(allowed.rejected.some((r) => r.reason === 'provider not in allowedProviders'));

  // Deprecated bi loai tru khi allowDeprecated.
  const depEntry = { ...findModelV30(c, 'openai', 'gpt-4.1'), deprecated: true, deprecatedReason: 'old' };
  const c2 = { ...c, entries: c.entries.map((e) => (e.modelId === 'gpt-4.1' && e.provider === 'openai' ? depEntry : e)) };
  const d1 = routeModelV30(c2, { forceModel: 'openai::gpt-4.1' }, policy);
  assert.equal(d1.ok, false);
  const d2 = routeModelV30(c2, { forceModel: 'openai::gpt-4.1' }, { ...policy, allowDeprecated: true });
  assert.equal(d2.ok, true);
  assert.equal(d2.chosen.entry.modelId, 'gpt-4.1');

  // forceModel chon thang.
  const forced = routeModelV30(c, { forceModel: 'gemini::gemini-3-flash' }, policy);
  assert.equal(forced.ok, true);
  assert.equal(forced.chosen.entry.modelId, 'gemini-3-flash');
  assert.equal(forced.chosen.score, 1);

  // Khong model nao dat (context qua lon).
  const none = routeModelV30(c, { minContextTokens: 99_999_999 }, policy);
  assert.equal(none.ok, false);
  assert.equal(none.chosen, undefined);
  assert.equal(none.rejected.length, 18);
  assert.match(explainRoutingDecisionV30(none), /No model fits/);
});

test('routing: latency do duoc thang so khai bao', () => {
  const c = catalog();
  const policy = {
    ...defaultRoutingPolicyV30(),
    profile: 'fastest',
    allowedProviders: ['openai'],
  };
  // maxCostUsd 0.005 loai gpt-realtime-2.1 ($0.012) de chi con nano/mini
  // so nhau — tap trung vao latency do duoc thang so khai bao.
  const req = { needsToolCalling: true, maxCostUsd: 0.005 };
  // Chua co mau: nano nhanh nhat theo khai bao (600ms < 1200ms).
  const before = routeModelV30(c, req, policy, null);
  assert.equal(before.chosen.entry.modelId, 'gpt-5.2-nano');
  assert.equal(before.chosen.latencyMeasured, false);
  // Do that: nano cham dot ngot (5000ms x10), mini nhanh (300ms x10).
  const stats = new LatencyStatsStoreV30();
  for (let i = 0; i < 10; i += 1) {
    stats.record('openai', 'gpt-5.2-nano', 5000, true, 100 + i);
    stats.record('openai', 'gpt-5.2-mini', 300, true, 100 + i);
  }
  const after = routeModelV30(c, req, policy, stats);
  assert.equal(after.chosen.entry.modelId, 'gpt-5.2-mini');
  assert.equal(after.chosen.latencyMeasured, true);
  assert.ok(after.chosen.effectiveLatencyMs < 1000);
  assert.match(explainRoutingDecisionV30(after), /gpt-5\.2-mini/);
  assert.match(explainRoutingDecisionV30(after), /measured/);
});

test('policy: validate + merge — patch sai giu policy cu', () => {
  const base = defaultRoutingPolicyV30();
  assert.deepEqual(validateRoutingPolicyV30(base), []);
  assert.ok(validateRoutingPolicyV30({ ...base, profile: 'turbo' }).length > 0);
  assert.ok(validateRoutingPolicyV30({ ...base, maxFallbackAttempts: 99 }).length > 0);
  assert.ok(validateRoutingPolicyV30({ ...base, customWeights: { latency: 0.5, cost: 0.5, quality: -1 } }).length > 0);
  assert.ok(validateRoutingPolicyV30({ ...base, customWeights: { latency: 0, cost: 0, quality: 0 } }).length > 0);
  assert.ok(validateRoutingPolicyV30({ ...base, autoRefreshCatalog: { ...base.autoRefreshCatalog, minIntervalMs: 1000 } }).length > 0);

  const merged = mergeRoutingPolicyV30(base, { profile: 'cheapest', maxCostPerRequestUsd: 0.05 });
  assert.deepEqual(merged.errors, []);
  assert.equal(merged.policy.profile, 'cheapest');
  assert.equal(merged.policy.maxCostPerRequestUsd, 0.05);
  assert.equal(base.profile, 'balanced'); // khong doi policy cu

  const bad = mergeRoutingPolicyV30(base, { maxFallbackAttempts: 99 });
  assert.ok(bad.errors.length > 0);
  assert.equal(bad.policy, base);

  const w = effectiveWeightsV30({ ...base, profile: 'fastest' });
  assert.deepEqual(w, { latency: 0.7, cost: 0.1, quality: 0.2 });
  const custom = effectiveWeightsV30({ ...base, customWeights: { latency: 0.5, cost: 0.3, quality: 0.2 } });
  assert.deepEqual(custom, { latency: 0.5, cost: 0.3, quality: 0.2 });
});
