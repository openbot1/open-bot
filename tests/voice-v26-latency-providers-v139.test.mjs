/**
 * Tests for voice v26 latency budget + provider registry
 * (v1.39, Team T5).
 *
 * Covers LatencyBudgetV26 (per-stage + total budgets, profiles,
 * p50/p95, bottleneck, breach alerts, degraded-mode escalation
 * and recovery) and ProviderRegistryV26 (mock providers,
 * selection by latency/quality/cost, health, fallback chain,
 * deterministic mock synthesize/transcribe, capability matrix,
 * Vault-ref-only config).
 *
 * All offline, deterministic, virtual clocks. No key / network /
 * mic / sound card. No key value is ever stored or logged.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LatencyBudgetV26,
  ProviderRegistryV26,
  VOICE_V26_BUDGET_PROFILES,
  VOICE_V26_DEGRADED_POLICIES,
} from '../packages/core/dist/voiceV26/index.js';

test('latency: budget profiles have sane values; recordTurn detects breaches per stage', () => {
  assert.deepEqual(VOICE_V26_BUDGET_PROFILES.realtime, { sttMs: 400, modelMs: 800, ttsMs: 600, totalMs: 1800 });
  assert.ok(VOICE_V26_BUDGET_PROFILES.quality.totalMs > VOICE_V26_BUDGET_PROFILES.balanced.totalMs);
  const b = new LatencyBudgetV26('s1', { profile: 'realtime' });
  assert.equal(b.budgetsNow().totalMs, 1800);
  const ok = b.recordTurn({ turnId: 't1', turnIndex: 0, sttMs: 300, modelMs: 700, ttsMs: 500, atMs: 1000 });
  assert.equal(ok.breached, false);
  assert.equal(ok.totalMs, 1500);
  assert.equal(ok.degradedLevel, 'off');
  const bad = b.recordTurn({ turnId: 't2', turnIndex: 1, sttMs: 300, modelMs: 1200, ttsMs: 500, atMs: 2000 });
  assert.equal(bad.breached, true);
  assert.deepEqual(bad.breachedStages, ['model', 'total']);
  assert.equal(bad.totalMs, 2000);
  const stats = b.stats();
  assert.equal(stats.turns, 2);
  assert.equal(stats.breachedTurns, 1);
  assert.equal(stats.breachRate, 0.5);
  assert.equal(stats.breaches, 2);
});

test('latency: recordStage returns the breach with over-pct; stage stats carry p50/p95', () => {
  const b = new LatencyBudgetV26('s2', { profile: 'balanced' });
  for (let i = 0; i < 10; i++) {
    b.recordStage({ stage: 'stt', ms: 100 + i * 10, atMs: i * 100 });
  }
  const breach = b.recordStage({ stage: 'stt', ms: 2000, atMs: 2000 });
  assert.ok(breach);
  assert.equal(breach.stage, 'stt');
  assert.equal(breach.budgetMs, 800);
  assert.equal(breach.overMs, 1200);
  assert.equal(breach.overPct, 150);
  const stt = b.stageStats('stt');
  assert.equal(stt.samples, 11);
  assert.equal(stt.p50Ms, 150);
  assert.equal(stt.maxMs, 2000);
  assert.equal(stt.breaches, 1);
  const bottleneck = b.bottleneck();
  assert.ok(bottleneck);
  assert.equal(bottleneck.stage, 'stt');
  assert.match(b.markdown(), /Latency budget v26/);
});

test('latency: degraded mode escalates after consecutive breaches and recovers after clean turns', () => {
  const b = new LatencyBudgetV26('s3', {
    profile: 'realtime',
    consecutiveBreachesToEscalate: 2,
    consecutiveCleanToRecover: 2,
  });
  assert.equal(b.degradedLevelNow(), 'off');
  b.recordTurn({ turnId: 't1', sttMs: 100, modelMs: 100, ttsMs: 100, atMs: 0 });
  assert.equal(b.degradedLevelNow(), 'off');
  // Two breaching turns -> light.
  b.recordTurn({ turnId: 't2', sttMs: 500, modelMs: 100, ttsMs: 100, atMs: 1000 });
  b.recordTurn({ turnId: 't3', sttMs: 500, modelMs: 100, ttsMs: 100, atMs: 2000 });
  assert.equal(b.degradedLevelNow(), 'light');
  const light = b.policyNow();
  assert.equal(light.maxReplyChars, 600);
  assert.equal(light.fastVoice, true);
  assert.equal(light.skipProsody, true);
  // Two more breaching turns -> heavy.
  b.recordTurn({ turnId: 't4', sttMs: 500, modelMs: 100, ttsMs: 100, atMs: 3000 });
  b.recordTurn({ turnId: 't5', sttMs: 500, modelMs: 100, ttsMs: 100, atMs: 4000 });
  assert.equal(b.degradedLevelNow(), 'heavy');
  assert.equal(b.policyNow().lightStt, true);
  assert.equal(b.policyNow().maxReplyChars, 240);
  // Clean turns step back down: heavy -> light -> off.
  b.recordTurn({ turnId: 't6', sttMs: 100, modelMs: 100, ttsMs: 100, atMs: 5000 });
  b.recordTurn({ turnId: 't7', sttMs: 100, modelMs: 100, ttsMs: 100, atMs: 6000 });
  assert.equal(b.degradedLevelNow(), 'light');
  b.recordTurn({ turnId: 't8', sttMs: 100, modelMs: 100, ttsMs: 100, atMs: 7000 });
  b.recordTurn({ turnId: 't9', sttMs: 100, modelMs: 100, ttsMs: 100, atMs: 8000 });
  assert.equal(b.degradedLevelNow(), 'off');
  assert.equal(VOICE_V26_DEGRADED_POLICIES.off.maxReplyChars, null);
  const events = b.degradedEventsList();
  assert.equal(events.length, 4);
  assert.equal(events[0].from, 'off');
  assert.equal(events[0].to, 'light');
  assert.ok(events[0].consecutiveBreaches >= 2);
});

test('latency: profile switch + budget override; invalid options throw', () => {
  const b = new LatencyBudgetV26('s4');
  assert.equal(b.profile(), 'balanced');
  const budgets = b.setProfile('realtime', 0);
  assert.equal(budgets.totalMs, 1800);
  const overridden = b.setBudget('model', 500);
  assert.equal(overridden.modelMs, 500);
  assert.throws(() => b.setBudget('model', 10), /budget must be/);
  assert.throws(() => new LatencyBudgetV26('bad', { profile: 'warp' }), /Invalid LatencyBudgetV26Options/);
  assert.throws(() => b.recordStage({ stage: 'stt', ms: -5, atMs: 0 }), /finite number/);
});

test('providers: built-in mocks present; selection prefers fast + healthy; health drops on failure', () => {
  const r = new ProviderRegistryV26();
  assert.equal(r.count(), 5);
  assert.equal(r.list({ kind: 'tts' }).length, 3);
  assert.equal(r.list({ kind: 'stt' }).length, 2);
  const tts = r.select({ kind: 'tts', language: 'en' }, 0);
  assert.ok(tts);
  assert.equal(tts.providerId, 'mock-local-tts');
  const stt = r.select({ kind: 'stt', language: 'vi' }, 0);
  assert.ok(stt);
  assert.equal(stt.providerId, 'mock-local-stt');
  // Quality-weighted selection picks the neural mock.
  const quality = r.select({ kind: 'tts', language: 'en', weights: { latency: 0.1, quality: 0.8, cost: 0.1 } }, 0);
  assert.equal(quality.providerId, 'mock-api-tts');
  // Failures drop health; 5 failures exclude the provider.
  for (let i = 0; i < 5; i++) r.markFailure('mock-local-tts');
  assert.equal(r.healthOf('mock-local-tts'), 0);
  const after = r.select({ kind: 'tts', language: 'en' }, 0);
  assert.notEqual(after.providerId, 'mock-local-tts');
  r.markSuccess('mock-local-tts');
  assert.equal(r.healthOf('mock-local-tts'), 5);
  const chain = r.fallbackChain({ kind: 'tts', language: 'en' }, 0);
  assert.ok(chain.length >= 1);
  assert.ok(!chain.some((c) => c.providerId === after.providerId));
});

test('providers: language/voice/streaming filters; heavy degraded forces fastest class', () => {
  const r = new ProviderRegistryV26();
  const zh = r.select({ kind: 'tts', language: 'zh' }, 0);
  assert.equal(zh.providerId, 'mock-api-tts');
  const voiced = r.select({ kind: 'tts', language: 'en', voice: 'mock-neural-b' }, 0);
  assert.equal(voiced.providerId, 'mock-api-tts');
  const none = r.select({ kind: 'tts', language: 'sw' }, 0);
  assert.equal(none, null);
  const heavy = r.select({ kind: 'tts', language: 'en', degradedLevel: 'heavy' }, 0);
  assert.equal(heavy.providerId, 'mock-local-tts');
  const ranked = r.rank({ kind: 'tts', language: 'en' });
  assert.ok(ranked.length >= 2);
  assert.ok(ranked[0].score >= ranked[1].score);
});

test('providers: mock synthesize/transcribe are deterministic; register validates Vault refs', () => {
  const r = new ProviderRegistryV26();
  const a = r.synthesize({ providerId: 'mock-local-tts', text: 'Hello world, this is a test.', atMs: 0 });
  const b = r.synthesize({ providerId: 'mock-local-tts', text: 'Hello world, this is a test.', atMs: 0 });
  assert.deepEqual(a, b);
  assert.equal(a.chars, 28);
  assert.ok(a.durationMs > 0);
  assert.equal(a.firstChunkMs, 80);
  assert.equal(a.voice, 'mock-voice-a');
  const t1 = r.transcribe({ providerId: 'mock-local-stt', audioPayload: 'fake-audio-bytes-1', atMs: 0 });
  const t2 = r.transcribe({ providerId: 'mock-local-stt', audioPayload: 'fake-audio-bytes-1', atMs: 0 });
  assert.deepEqual(t1, t2);
  assert.ok(t1.text.length > 0);
  assert.throws(() => r.synthesize({ providerId: 'mock-local-stt', text: 'x', atMs: 0 }), /not a TTS provider/);
  assert.throws(() => r.transcribe({ providerId: 'mock-local-tts', audioPayload: 'x', atMs: 0 }), /not an STT provider/);
  // API-key providers must carry a Vault key *name* (never a value).
  assert.throws(
    () => r.register({
      id: 'bad-api-tts', kind: 'tts', origin: 'api-key', name: 'Bad', model: 'm',
      languages: ['en'], voices: ['v'], streaming: true, latencyClass: 'fast',
      qualityClass: 'balanced', costClass: 'fast', maxInput: 100, vaultKeyRef: null, mock: true, enabled: true,
    }),
    /vaultKeyRef/,
  );
  const good = r.register({
    id: 'my-api-tts', kind: 'tts', origin: 'api-key', name: 'My API TTS', model: 'my-neural',
    languages: ['en', 'vi'], voices: ['my-voice'], streaming: true, latencyClass: 'balanced',
    qualityClass: 'quality', costClass: 'quality', maxInput: 5000, vaultKeyRef: 'my-vault-key-name', mock: false, enabled: true,
  });
  assert.equal(good.vaultKeyRef, 'my-vault-key-name');
  assert.equal(r.get('my-api-tts').origin, 'api-key');
  const matrix = r.capabilityMatrix();
  assert.ok(matrix.some((row) => row.kind === 'tts' && row.language === 'vi' && row.providers.includes('my-api-tts')));
  assert.match(r.markdown(), /mock-api-tts -> voice-v26-api-tts-key/);
  assert.equal(r.stats().apiKey, 3);
});
