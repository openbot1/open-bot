/**
 * Local model router v116 scoring tests (v1.39, Doi T3 — node:test,
 * no network, no GPU, no real model).
 *
 * Covers (pure modules — scoringV116 tren PolicyRouter V115):
 * - Profiles: 5 profile co san, trong so tong = 1, custom weights
 *   duoc chuan hoa; kind overrides thay doi trong so theo task.
 * - Ranking: ung vien bi loai co ly do (het RAM / khong tool-use /
 *   quality duoi nguong / privacy-first loai cloud); bang xep hang
 *   sap xep giam dan, ke ca ung vien bi loai (score 0, cuoi bang).
 * - decide(): giu hanh vi V115 (task nhe -> local, task nang ->
 *   cloud, manual override) + log ly do theo profile; log ghi vao
 *   DecisionLogStore (ring buffer, serialize round-trip).
 * - winnerReason(): giai thich vi sao model thang.
 *
 * Imports the BUILT core — build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/router-local-v116-scoring.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_POLICY_CONFIG,
  DecisionLogStore,
  ROUTING_PROFILES,
  ScoringPolicyV116,
  getRoutingProfile,
  normalizeWeights,
  rankCandidatesV116,
  weightsForTask,
  winnerReason,
} from '../packages/core/dist/router/local/index.js';

const GB = 1024 * 1024 * 1024;

function task(overrides = {}) {
  return {
    kind: 'simple-chat',
    promptTokens: 100,
    needsToolUse: false,
    needsLongContext: false,
    qualityNeed: 0.5,
    ...overrides,
  };
}

function env(overrides = {}) {
  return { loadedModelIds: new Set(), availableRamBytes: 8 * GB, ...overrides };
}

test('profiles: 5 built-in profiles, weights sum to 1', () => {
  const ids = Object.keys(ROUTING_PROFILES);
  assert.deepEqual(ids.sort(), ['balanced', 'cost-first', 'latency-first', 'privacy-first', 'quality-first']);
  for (const profile of Object.values(ROUTING_PROFILES)) {
    const sum = profile.weights.cost + profile.weights.latency + profile.weights.quality;
    assert.ok(Math.abs(sum - 1) < 1e-9, `${profile.id} weights sum ${sum}`);
  }
  assert.equal(ROUTING_PROFILES['privacy-first'].localOnly, true);
  assert.equal(ROUTING_PROFILES['quality-first'].minQuality, 0.8);
});

test('getRoutingProfile: custom weights normalized; unknown parts default', () => {
  const custom = getRoutingProfile('custom', { cost: 2, latency: 1, quality: 1 });
  assert.equal(custom.id, 'custom');
  const sum = custom.weights.cost + custom.weights.latency + custom.weights.quality;
  assert.ok(Math.abs(sum - 1) < 1e-9);
  assert.ok(Math.abs(custom.weights.cost - 0.5) < 1e-9);
  const zero = normalizeWeights({ cost: 0, latency: 0, quality: 0 });
  assert.ok(Math.abs(zero.cost - 1 / 3) < 1e-9);
  const negative = normalizeWeights({ cost: -1, latency: 2, quality: 1 });
  assert.equal(negative.cost, 0);
});

test('weightsForTask: kind overrides change weights (code favours quality)', () => {
  const balanced = ROUTING_PROFILES.balanced;
  const chat = weightsForTask(balanced, task({ kind: 'simple-chat' }));
  const code = weightsForTask(balanced, task({ kind: 'code' }));
  assert.ok(code.quality > chat.quality, 'code phai uu tien quality hon chat');
  const sum = code.cost + code.latency + code.quality;
  assert.ok(Math.abs(sum - 1) < 1e-9);
});

test('rankOnly: light task with a loaded local model ranks it first', () => {
  const policy = new ScoringPolicyV116();
  // qwen3-4b dang loaded: khong mat cold-start 5s -> local thang
  // (do 0.937, cloud gemini-2.5-flash 0.899 — do that, khong doan).
  const log = policy.rankOnly(task(), env({ loadedModelIds: new Set(['qwen3-4b']) }));
  assert.ok(log.chosen, 'phai co model duoc chon');
  assert.equal(log.chosen.kind, 'local');
  assert.equal(log.chosen.modelId, 'qwen3-4b');
  assert.ok(log.ranked.length >= 5, 'bang xep hang phai co nhieu ung vien');
  assert.ok(log.chosen.reasons.length >= 2, 'ung vien thang phai co ly do');
  assert.ok(log.reason.includes(log.chosen.modelId));
  assert.equal(log.profileId, 'balanced');
  assert.equal(log.manualOverride, false);
});

test('rankOnly: with nothing loaded, cold start is priced in (cloud can win on pure score)', () => {
  const policy = new ScoringPolicyV116();
  // Khong model nao loaded: moi local deu +5s cold-start -> diem
  // latency ~0 -> cloud thang theo diem thuan. Day la hanh vi dung
  // cua pure scoring (V115 decide() moi co luat rieng "task nhe ->
  // local"); test ghi lai de khong ai doc nham la bug.
  const log = policy.rankOnly(task(), env());
  assert.ok(log.chosen);
  assert.equal(log.chosen.kind, 'cloud');
  const topLocal = log.ranked.find((c) => c.kind === 'local' && !c.excluded);
  assert.ok(topLocal, 'phai co local trong bang');
  assert.ok(topLocal.estLatencyMs > 5000, `local chua load phai chiu cold-start, got ${topLocal.estLatencyMs} ms`);
});

test('rankOnly: heavy task + high qualityNeed ranks cloud first', () => {
  const policy = new ScoringPolicyV116();
  const log = policy.rankOnly(
    task({ kind: 'reasoning', promptTokens: 9000, qualityNeed: 0.9 }),
    env(),
  );
  assert.ok(log.chosen);
  assert.equal(log.chosen.kind, 'cloud');
  assert.ok(log.heaviness >= 0.8);
});

test('rankOnly: quality-first excludes models below minQuality with reason', () => {
  const policy = new ScoringPolicyV116(undefined, undefined, 'quality-first');
  const log = policy.rankOnly(task(), env());
  const excluded = log.ranked.filter((c) => c.excluded);
  assert.ok(excluded.length > 0, 'quality-first phai loai model yeu');
  assert.ok(excluded.every((c) => c.score === 0));
  assert.ok(excluded.some((c) => c.reasons[0].includes('nguong toi thieu')));
  assert.ok(log.chosen === null || log.chosen.quality >= 0.8);
});

test('rankOnly: privacy-first excludes cloud, falls back to local only', () => {
  const policy = new ScoringPolicyV116(undefined, undefined, 'privacy-first');
  const log = policy.rankOnly(task(), env());
  assert.ok(log.chosen);
  assert.equal(log.chosen.kind, 'local');
  const cloudExcluded = log.ranked.filter((c) => c.kind === 'cloud');
  assert.ok(cloudExcluded.length > 0);
  assert.ok(cloudExcluded.every((c) => c.excluded));
  assert.ok(cloudExcluded.every((c) => c.reasons[0].includes('privacy-first')));
});

test('rankOnly: cost-first prefers the cheapest candidate (loaded local)', () => {
  const policy = new ScoringPolicyV116(undefined, undefined, 'cost-first');
  const log = policy.rankOnly(task(), env({ loadedModelIds: new Set(['qwen3-4b']) }));
  assert.ok(log.chosen);
  assert.equal(log.chosen.kind, 'local');
  assert.equal(log.chosen.costPer1kTokensUsd, 0.0001);
});

test('rankCandidatesV116: excluded candidates carry reasons (no RAM / no tool-use)', () => {
  const policy = new ScoringPolicyV116();
  const candidates = policy.buildCandidates(
    task({ needsToolUse: true }),
    env({ availableRamBytes: 0 }),
  );
  const ranked = rankCandidatesV116(candidates, task({ needsToolUse: true }), ROUTING_PROFILES.balanced);
  const noRam = ranked.filter((c) => c.reasons[0]?.includes('RAM'));
  assert.ok(noRam.length > 0, 'phai co ung vien bi loai vi het RAM');
  const noTool = ranked.filter((c) => c.reasons[0]?.includes('tool-use'));
  assert.ok(noTool.length > 0, 'phai co ung vien bi loai vi khong tool-use');
  // Ung vien bi loai nam cuoi bang, score 0.
  const last = ranked[ranked.length - 1];
  assert.equal(last.excluded, true);
  assert.equal(last.score, 0);
});

test('decide: keeps V115 behaviour (light -> local) and logs the decision', () => {
  const policy = new ScoringPolicyV116();
  const log = policy.decide(task(), env());
  assert.equal(log.chosen.kind, 'local');
  assert.ok(log.fallbacks.length > 0);
  assert.equal(policy.getLogStore().size(), 1);
  assert.equal(policy.getLogStore().last().id, log.id);
  assert.ok(log.reason.includes('Cân bằng') || log.reason.includes('balanced'));
});

test('decide: profileOverride decides under another profile without changing state', () => {
  const policy = new ScoringPolicyV116();
  assert.equal(policy.getProfile().id, 'balanced');
  const log = policy.decide(task(), env(), getRoutingProfile('quality-first'));
  assert.equal(log.profileId, 'quality-first');
  assert.ok(log.chosen === null || log.chosen.quality >= 0.8);
  assert.equal(policy.getProfile().id, 'balanced', 'profile hien hanh khong doi');
});

test('decide: CLI candidate wins when it tops the ranking', () => {
  const policy = new ScoringPolicyV116();
  const candidates = policy.buildCandidates(task(), env());
  // Model chay qua login Codex san: cost 0, latency 900ms, quality 0.88
  // -> diem balanced ~0.91, cao hon cloud tot nhat (0.899) va local
  // chua load (bi tru cold-start).
  candidates.push({
    kind: 'local',
    modelId: 'cli:codex:default',
    costPer1kTokensUsd: 0,
    estLatencyMs: 900,
    quality: 0.88,
  });
  const log = policy.decide(task(), env(), undefined, candidates);
  assert.equal(log.chosen.modelId, 'cli:codex:default');
  assert.equal(log.chosen.kind, 'local');
});

test('decide: manual override refused by privacy-first is explained', () => {
  const policy = new ScoringPolicyV116(undefined, undefined, 'privacy-first');
  const log = policy.decide(task({ manualModelId: 'gemini-2.5-flash' }), env());
  assert.equal(log.chosen.kind, 'local', 'privacy-first khong duoc chon cloud du user override');
  assert.ok(log.reason.includes('khong ap dung duoc theo profile privacy-first'), log.reason);
  assert.equal(log.manualOverride, true);
});

test('decide: manual override is honoured and logged', () => {
  const policy = new ScoringPolicyV116();
  const log = policy.decide(task({ manualModelId: 'gemini-2.5-flash' }), env());
  assert.equal(log.manualOverride, true);
  assert.equal(log.chosen.modelId, 'gemini-2.5-flash');
});

test('decide: setProfile switches profile and affects the next decision', () => {
  const policy = new ScoringPolicyV116();
  policy.setProfile('quality-first');
  assert.equal(policy.getProfile().id, 'quality-first');
  const log = policy.decide(task(), env());
  assert.equal(log.profileId, 'quality-first');
  assert.ok(log.chosen === null || log.chosen.quality >= 0.8);
  policy.setProfile('custom', { cost: 1, latency: 0, quality: 0 });
  assert.equal(policy.getProfile().weights.cost, 1);
});

test('winnerReason: explains the winner vs runner-up', () => {
  const policy = new ScoringPolicyV116();
  const log = policy.rankOnly(task(), env());
  const reason = winnerReason(log.ranked);
  assert.ok(reason.includes(log.chosen.modelId));
  assert.ok(reason.includes('thang') || reason.includes('duy nhat'));
  assert.equal(winnerReason([]), 'Khong co ung vien nao du kha nang.');
});

test('DecisionLogStore: ring buffer caps at capacity, serialize round-trip', () => {
  const store = new DecisionLogStore(3);
  const policy = new ScoringPolicyV116(undefined, undefined, 'balanced', undefined, 3);
  for (let i = 0; i < 5; i += 1) policy.decide(task(), env());
  assert.equal(policy.getLogStore().size(), 3);
  const serialized = policy.getLogStore().serialize();
  assert.equal(serialized.length, 3);
  const restored = DecisionLogStore.deserialize(serialized, 3);
  assert.equal(restored.size(), 3);
  assert.equal(restored.last().id, serialized[2].id);
  store.add(serialized[0]);
  assert.equal(store.get(serialized[0].id).id, serialized[0].id);
  store.clear();
  assert.equal(store.size(), 0);
});

test('ScoringPolicyV116: config passthrough keeps V115 defaults', () => {
  const policy = new ScoringPolicyV116();
  const config = policy.getConfig();
  assert.deepEqual(config.weights, DEFAULT_POLICY_CONFIG.weights);
  assert.equal(config.cloudQualityThreshold, 0.85);
});
