/**
 * Tests for v1.15 — voice realtime v14 (Team T5).
 *
 *   1. Latency budget v2 (latencyBudgetV14.ts): profiles
 *      (local/cloud/realtime), per-session p50/p95/p99,
 *      network stage, warn/critical alerts, session report
 *      (compliance rate, worst stage), setBudget, markdown.
 *   2. Voice providers v2 (voiceProvidersV14.ts): split
 *      STT/TTS, Deepgram (key-gated, streaming partials),
 *      Cartesia (first-audio), Whisper local (binary probe +
 *      fallback), Pocket TTS (first-audio metric), realtime
 *      API, registry pick by goal (latency/quality/cost),
 *      pickPair, hourly cost estimate, v13 wrap.
 *   3. Semantic turn-taking v2 (smartTurnV14.ts): clause
 *      splitter, open/closed question classifier, filler
 *      detection, backchannel classification, sensitivity
 *      presets, detector hold-backs (open-question wait,
 *      mid-clause wait, filler-thinking) + release, stats +
 *      markdown. Compatible with the v13 scorer.
 *   4. Wake word v2 (wakeWordV14.ts): per-word configs,
 *      pending-confirm + VAD confirmation, expiry suppression,
 *      near-miss suppression, low-confidence suppression,
 *      per-word cooldown, setWords, test-set evaluation
 *      (TP/FP/FN/TN, false-accept / false-reject rates).
 *   5. Barge-in v2 (bargeInV14.ts): stage queues (capacity /
 *      drop-oldest / drop-newest / reject / flush), pipeline
 *      cut (per-queue discards + cut latency + scope cancel),
 *      mid-sentence split (mid-word / boundary / terminal),
 *      engine v2 (VAD cut flushes pipeline, gated, mid-
 *      sentence cut), stats + markdown.
 *   6. Session v14 (voiceSessionV14.ts): connect, speakReply
 *      (pipeline items queued), latency record (network +
 *      e2e), provider pick/switch, Smart Turn v2 via
 *      transcript, wake-word v2 gating, interrupt (pipeline
 *      flush + mid-sentence split), stats / summary /
 *      markdown, manager registry.
 *   7. Voice v14 tools (packages/tools/src/voiceV14Tools.ts):
 *      9 tools, unique names, placeholder refuses, full
 *      lifecycle through the tools on a real manager, wired
 *      into ALL_TOOLS (500 tools).
 *   8. Renderer-local view models (voiceSessionV14View.ts):
 *      row parsing, latency rows (p99 + network), provider
 *      rows (split caps + pick scores), Smart Turn v2 row,
 *      wake-word rows, pipeline rows, evaluation rows,
 *      formatters.
 *   9. i18n: 50 `voice.realtime.v14.*` keys in all 6 locales,
 *      non-empty, same key set everywhere.
 *  10. Core root re-exports: v14 classes / factories are
 *      importable from `@open-bot/core`.
 *
 * No network, no sound card, no live provider, no key. Every
 * audio path here is mock (audioMockV11 frames, scripted replies,
 * mock synth, scripted provider transcripts).
 * Run after building core + tools:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/voice-v115.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  silenceFrame,
  speechLikeFrame,
} from '../packages/core/dist/voice/audioMockV11.js';
import {
  LatencyBudgetV14,
  createLatencyBudgetV14,
  latencyBudgetV14ProfileBudgets,
  defaultLatencyBudgetV14Options,
  validateLatencyBudgetV14Options,
  sessionStageReportV14,
  isLatencyBudgetV14Profile,
  latencyBudgetV14Summary,
  latencyBudgetV14SessionMarkdown,
  LATENCY_BUDGET_V14_STAGES,
} from '../packages/core/dist/voice/latencyBudgetV14.js';
import {
  MockVoiceProviderV14,
  DeepgramVoiceProviderV14,
  CartesiaVoiceProviderV14,
  WhisperLocalVoiceProviderV14,
  PocketTtsVoiceProviderV14,
  RealtimeApiVoiceProviderV14,
  createVoiceProviderV14,
  wrapVoiceProviderV13,
  VoiceProviderRegistryV14,
  createVoiceProviderRegistryV14,
  scoreVoiceProviderV14,
  estimateVoiceProviderV14HourlyCost,
  isVoiceProviderV14Kind,
  voiceProviderV14Summary,
  voiceProviderRegistryV14Markdown,
} from '../packages/core/dist/voice/voiceProvidersV14.js';
import { MockVoiceProviderV13 } from '../packages/core/dist/voice/voiceProvidersV13.js';
import {
  SmartTurnDetectorV14,
  createSmartTurnDetectorV14,
  scoreTurnCompletenessV14,
  splitClausesV14,
  classifyQuestionV14,
  findFillersV14,
  classifyBackchannelV14,
  sensitivityPresetV14,
  defaultSmartTurnV14Options,
  validateSmartTurnV14Options,
  smartTurnV14Summary,
  smartTurnV14Markdown,
} from '../packages/core/dist/voice/smartTurnV14.js';
import {
  WakeWordDetectorV14,
  createWakeWordDetectorV14,
  defaultWakeWordV14WordConfig,
  validateWakeWordV14WordConfig,
  evaluateWakeWordV14,
  wakeWordV14Summary,
  wakeWordV14Markdown,
  wakeWordV14EvaluationMarkdown,
} from '../packages/core/dist/voice/wakeWordV14.js';
import {
  StageQueueV14,
  VoicePipelineV14,
  createVoicePipelineV14,
  cutMidSentenceV14,
  defaultDropPolicyV14,
  BargeInEngineV14,
  createBargeInEngineV14,
  bargeInV14Summary,
  bargeInV14Markdown,
} from '../packages/core/dist/voice/bargeInV14.js';
import {
  RealtimeVoiceSessionV14,
  VoiceV14Manager,
  createRealtimeVoiceSessionV14,
  createVoiceV14Manager,
  voiceSessionV14Summary,
  voiceSessionV14Markdown,
} from '../packages/core/dist/voice/voiceSessionV14.js';
import {
  LatencyBudgetV14 as RootLatencyV14,
  VoiceProviderRegistryV14 as RootRegistryV14,
  SmartTurnDetectorV14 as RootSmartTurnV14,
  WakeWordDetectorV14 as RootWakeV14,
  BargeInEngineV14 as RootEngineV14,
  RealtimeVoiceSessionV14 as RootSessionV14,
  VoiceV14Manager as RootManagerV14,
} from '../packages/core/dist/index.js';
import {
  createVoiceV14Tools,
  VOICE_V14_TOOLS,
  VOICE_V14_TOOL_NAMES,
  isVoiceV14ToolName,
} from '../packages/tools/dist/voiceV14Tools.js';
import { ALL_TOOLS } from '../packages/tools/dist/tools.js';
import {
  parseVoiceV14Status,
  parseVoiceV14LatencyStage,
  parseVoiceV14LatencyProfile,
  parseVoiceV14ProviderKind,
  parseVoiceV14WakeWordState,
  parseVoiceSessionV14Row,
  parseVoiceSessionV14Rows,
  parseVoiceV14LatencyRows,
  parseVoiceV14AlertRows,
  parseVoiceV14ProviderRows,
  scoreVoiceV14ProviderRow,
  parseVoiceV14SmartTurnRow,
  parseVoiceV14WakeWordRows,
  parseVoiceV14PipelineRows,
  parseVoiceV14EvalRows,
  formatVoiceV14Ms,
  formatVoiceV14Rate,
  formatVoiceV14Usd,
} from '../apps/desktop/src/renderer/voice/voiceSessionV14View.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPLY = 'Để tôi kiểm tra lịch của bạn hôm nay, bạn có ba cuộc họp quan trọng.';
const FRAMES = (n) => Array.from({ length: n }, () => new Uint8Array(20));

// ---------------------------------------------------------------------------
// 1. Latency budget v2
// ---------------------------------------------------------------------------

test('latency budget v14: profiles, validation, per-stage budgets', () => {
  assert.equal(isLatencyBudgetV14Profile('realtime'), true);
  assert.equal(isLatencyBudgetV14Profile('nope'), false);
  const local = latencyBudgetV14ProfileBudgets('local');
  assert.equal(local.network, 0);
  assert.ok(local.e2e < latencyBudgetV14ProfileBudgets('cloud').e2e);
  const realtime = latencyBudgetV14ProfileBudgets('realtime');
  assert.equal(realtime.e2e, 700);
  assert.equal(realtime.network, 150);
  assert.throws(() => latencyBudgetV14ProfileBudgets('nope'), /unknown profile/);
  assert.throws(() => validateLatencyBudgetV14Options({ profile: 'nope' }), /profile must be/);
  assert.throws(() => validateLatencyBudgetV14Options({ budgets: { nope: 1 } }), /unknown stage/);
  assert.throws(() => validateLatencyBudgetV14Options({ budgets: { stt: -5 } }), /must be a finite number/);
  assert.throws(() => validateLatencyBudgetV14Options({ criticalFactor: 0.5 }), /criticalFactor/);
  const defaults = defaultLatencyBudgetV14Options();
  assert.equal(defaults.profile, 'cloud');
  assert.equal(defaults.criticalFactor, 1.5);
  assert.deepEqual(LATENCY_BUDGET_V14_STAGES, ['capture', 'vad', 'stt', 'llm', 'tts', 'playback', 'network', 'e2e']);
});

test('latency budget v14: per-session percentiles, network stage, compliance', () => {
  const dash = createLatencyBudgetV14({ profile: 'cloud' });
  assert.equal(dash.getProfile(), 'cloud');
  assert.equal(dash.getBudgets().network, 250);
  // Session s1: 10 turns, all inside budget except one slow STT turn.
  for (let i = 0; i < 10; i++) {
    dash.recordTurn('s1', `t${i}`, { vad: 80, stt: i === 5 ? 900 : 300, llm: 1000, tts: 400, network: 120, e2e: 2000 }, i * 1000);
  }
  const report = dash.getSessionReport('s1');
  assert.equal(report.turns, 10);
  assert.equal(report.turnsInBudget, 9);
  assert.equal(report.complianceRate, 0.9);
  assert.equal(report.worstStage, 'stt');
  const stt = report.stages.find((r) => r.stage === 'stt');
  assert.equal(stt.samples, 10);
  assert.equal(stt.p50Ms, 300);
  assert.ok((stt.p95Ms ?? 0) > 300);
  assert.ok((stt.p99Ms ?? 0) >= (stt.p95Ms ?? 0));
  assert.equal(stt.maxMs, 900);
  assert.equal(stt.over, 1);
  const network = report.stages.find((r) => r.stage === 'network');
  assert.equal(network.samples, 10);
  assert.equal(network.over, 0);
  assert.equal(report.e2eP50Ms, 2000);
  assert.equal(report.e2eP95Ms, 2000);
  // A second session stays independent.
  dash.recordTurn('s2', 'x1', { stt: 100, e2e: 500 }, 0);
  assert.equal(dash.getSessionReport('s2').turns, 1);
  assert.equal(dash.getSessionReport('s2').complianceRate, 1);
  assert.equal(dash.getAllSessionReports().length, 2);
  const stats = dash.getStats();
  assert.equal(stats.sessions, 2);
  assert.equal(stats.turns, 11);
  assert.equal(stats.sessionsWithOverruns, 1);
  assert.equal(stats.worstSessionId, 's1');
  assert.ok(latencyBudgetV14Summary(stats).includes('2 sessions'));
  const md = latencyBudgetV14SessionMarkdown(report);
  assert.ok(md.includes('session s1'));
  assert.ok(md.includes('p99'));
  assert.ok(md.includes('| stt |'));
});

test('latency budget v14: warn vs critical alerts, network alerts, recovery', () => {
  const events = [];
  const dash = new LatencyBudgetV14({ profile: 'cloud', criticalFactor: 1.5 }, (e) => events.push(e));
  // Slightly over STT budget (400): warn. 3x over: critical.
  dash.recordStage({ sessionId: 's1', turnId: 't1', stage: 'stt', ms: 450, atMs: 0 });
  dash.recordStage({ sessionId: 's1', turnId: 't2', stage: 'stt', ms: 1200, atMs: 1000 });
  // Network over budget (250): warn; 2x over: critical.
  dash.recordStage({ sessionId: 's1', turnId: 't3', stage: 'network', ms: 300, atMs: 2000 });
  dash.recordStage({ sessionId: 's1', turnId: 't4', stage: 'network', ms: 600, atMs: 3000 });
  const alerts = dash.getAlerts('s1');
  assert.ok(alerts.length >= 4, `expected >= 4 alerts, got ${alerts.length}`);
  assert.ok(alerts.some((a) => a.level === 'warn' && a.stage === 'stt' && a.ms === 450));
  assert.ok(alerts.some((a) => a.level === 'critical' && a.stage === 'stt' && a.ms === 1200));
  assert.ok(alerts.some((a) => a.level === 'warn' && a.stage === 'network'));
  assert.ok(alerts.some((a) => a.level === 'critical' && a.stage === 'network' && a.ms === 600));
  assert.ok(dash.getCriticalAlerts('s1').every((a) => a.level === 'critical'));
  assert.equal(dash.getStats().criticalAlerts, dash.getCriticalAlerts().length);
  assert.throws(() => dash.recordStage({ sessionId: '', turnId: 't', stage: 'stt', ms: 1, atMs: 0 }), /non-empty sessionId/);
  assert.throws(() => dash.recordStage({ sessionId: 's', turnId: 't', stage: 'nope', ms: 1, atMs: 0 }), /unknown stage/);
  assert.equal(dash.setBudget('network', 500), 500);
  assert.equal(dash.getBudgets().network, 500);
  // Pure helper: p99 on a known list.
  const r = sessionStageReportV14('tts', [100, 200, 300, 400, 500], 600);
  assert.equal(r.p50Ms, 300);
  assert.equal(r.p99Ms, 496);
  assert.equal(r.over, 0);
});

test('latency budget v14: local profile is tighter than cloud; realtime e2e alerts fast', () => {
  const dash = createLatencyBudgetV14({ profile: 'realtime' });
  dash.recordStage({ sessionId: 's', turnId: 't1', stage: 'e2e', ms: 800, atMs: 0 });
  const report = dash.getSessionReport('s');
  assert.equal(report.e2eP50Ms, 800);
  assert.equal(report.stages.find((s) => s.stage === 'e2e').over, 1);
  assert.equal(report.complianceRate, 0);
  dash.reset();
  assert.equal(dash.getStats().sessions, 0);
  assert.equal(dash.getAlerts().length, 0);
});

// ---------------------------------------------------------------------------
// 2. Voice providers v2
// ---------------------------------------------------------------------------

test('voice providers v14: factory, split capabilities, readiness', () => {
  assert.equal(isVoiceProviderV14Kind('deepgram'), true);
  assert.equal(isVoiceProviderV14Kind('edge-tts'), false);
  const mock = createVoiceProviderV14('mock', { mockTranscripts: ['xin chào'] });
  assert.equal(mock.capabilities.stt, true);
  assert.equal(mock.capabilities.streamingStt, true);
  assert.equal(mock.capabilities.tts, true);
  assert.equal(mock.isReady(), true);
  const frames = FRAMES(5);
  assert.equal(mock.transcribe({ frames, atMs: 0 }).text, 'xin chào');
  const partials = mock.transcribeStream({ frames, atMs: 0 });
  assert.equal(partials.length, 2);
  assert.equal(partials[0].isFinal, false);
  assert.equal(partials[1].isFinal, true);
  assert.equal(partials[1].text, 'xin chào');
  const tts = mock.synthesize({ text: 'chào bạn', atMs: 0 });
  assert.equal(tts.firstAudioMs, 50);
  assert.ok(tts.chunks >= 1);
  assert.throws(() => mock.synthesize({ text: '  ', atMs: 0 }), /cannot synthesise empty text/);

  const dg = new DeepgramVoiceProviderV14({ hasKey: false, mockTranscripts: ['a'] });
  assert.equal(dg.isReady(), false);
  assert.match(dg.readinessReason(), /Deepgram API key/);
  assert.equal(dg.getModel(), 'nova-3');
  assert.throws(() => dg.transcribe({ frames, atMs: 0 }), /not ready/);
  assert.throws(() => dg.synthesize({ text: 'x', atMs: 0 }), /no TTS/);
  const dgReady = new DeepgramVoiceProviderV14({ hasKey: true, deepgramModel: 'flux', mockTranscripts: ['flux here'] });
  assert.equal(dgReady.getModel(), 'flux');
  assert.equal(dgReady.transcribe({ frames, atMs: 0 }).text, 'flux here');
  assert.equal(dgReady.capabilities.streamingStt, true);
  assert.equal(dgReady.capabilities.tts, false);

  const cart = new CartesiaVoiceProviderV14({ hasKey: true });
  assert.equal(cart.getModel(), 'sonic-3');
  assert.equal(cart.capabilities.stt, false);
  assert.equal(cart.synthesize({ text: 'xin chào các bạn', atMs: 0 }).firstAudioMs, 90);
  assert.throws(() => cart.transcribe({ frames, atMs: 0 }), /no STT/);
  const cartNoKey = new CartesiaVoiceProviderV14({});
  assert.throws(() => cartNoKey.synthesize({ text: 'x', atMs: 0 }), /not ready/);
});

test('voice providers v14: Whisper local probe + fallback, Pocket TTS first audio', () => {
  const tmpModel = path.join(ROOT, 'tests', 'voice-v115.test.mjs');
  const whisperMissing = new WhisperLocalVoiceProviderV14({ binaryPath: '/nonexistent/whisper-cli', modelPath: '/nonexistent/tiny.bin' });
  assert.equal(whisperMissing.isReady(), false);
  assert.match(whisperMissing.readinessReason(), /not found/);
  // Mock transcripts still work (fallback engine) even when not ready.
  assert.equal(whisperMissing.transcribe({ frames: FRAMES(2), atMs: 0 }).audioMs, 40);
  const whisperFound = new WhisperLocalVoiceProviderV14({ binaryPath: tmpModel, modelPath: tmpModel, modelSize: 'small' });
  assert.equal(whisperFound.hasRealBinary(), true);
  assert.equal(whisperFound.isReady(), true);
  assert.equal(whisperFound.getModelSize(), 'small');
  assert.equal(whisperFound.profile.sttLatencyMsPerSecond, 420);
  assert.equal(whisperFound.profile.quality, 0.88);
  const tiny = new WhisperLocalVoiceProviderV14({ binaryPath: '/x', modelPath: tmpModel, modelSize: 'tiny' });
  assert.equal(tiny.profile.sttLatencyMsPerSecond, 120);
  assert.throws(() => createVoiceProviderV14('whisper-local-v14', { modelSize: 'huge' }), /modelSize must be/);

  const pocket = new PocketTtsVoiceProviderV14({ pocketFirstAudioMs: 200 });
  assert.equal(pocket.isReady(), true);
  assert.equal(pocket.getParams(), 100_000_000);
  assert.equal(pocket.capabilities.local, true);
  assert.equal(pocket.capabilities.requiresKey, false);
  const res = pocket.synthesize({ text: 'a'.repeat(300), atMs: 0 });
  assert.equal(res.firstAudioMs, 200);
  assert.equal(res.chunks, 3);
  assert.throws(() => pocket.transcribe({ frames: FRAMES(1), atMs: 0 }), /no STT/);

  const rt = new RealtimeApiVoiceProviderV14({ hasKey: true });
  assert.equal(rt.capabilities.realtime, true);
  assert.equal(rt.transcribe({ frames: FRAMES(1), atMs: 0 }).text, '');
});

test('voice providers v14: registry pick by goal, pair, cost, v13 wrap', () => {
  const registry = createVoiceProviderRegistryV14({ hasKey: true, mockTranscripts: ['hi'] });
  assert.equal(registry.size(), 6);
  assert.deepEqual(registry.readyKinds(), ['mock', 'deepgram', 'cartesia', 'pocket-tts', 'realtime-api']);
  // Quality: Deepgram (0.95) wins for STT.
  assert.equal(registry.pick({ goal: 'quality', capability: 'stt' }).kind, 'deepgram');
  // Latency: Cartesia Sonic (90 ms first audio) wins for TTS;
  // cost: the free local Pocket TTS wins.
  assert.equal(registry.pick({ goal: 'latency', capability: 'tts' }).kind, 'cartesia');
  // Cost: local providers (free) beat cloud ones.
  const costPick = registry.pick({ goal: 'cost', capability: 'tts' });
  assert.equal(costPick.kind, 'pocket-tts');
  assert.equal(costPick.profile.ttsCostUsdPer1kChars, 0);
  // Local-only STT: mock (Whisper has no binary here).
  assert.equal(registry.pick({ goal: 'balanced', capability: 'stt', localOnly: true }).kind, 'mock');
  assert.equal(registry.pick({ goal: 'balanced', capability: 'stt', noKeyOnly: true }).kind, 'mock');
  const pair = registry.pickPair('quality');
  assert.equal(pair.stt.kind, 'deepgram');
  assert.equal(pair.tts.kind, 'cartesia');
  assert.equal(registry.sttProviders().length, 3); // mock, deepgram, realtime-api (Whisper has no binary here)
  assert.equal(registry.ttsProviders().length, 4);
  // Cost estimate: Deepgram $0.0043/min STT.
  const dg = registry.get('deepgram');
  assert.equal(estimateVoiceProviderV14HourlyCost(dg, 30, 0), 0.129);
  const pocket = registry.get('pocket-tts');
  assert.equal(estimateVoiceProviderV14HourlyCost(pocket, 30, 6000), 0);
  assert.throws(() => estimateVoiceProviderV14HourlyCost(dg, -1, 0), /audioMinutesPerHour/);
  // Scoring is deterministic and bounded.
  for (const goal of ['latency', 'quality', 'cost', 'balanced']) {
    const s = scoreVoiceProviderV14(dg, goal);
    assert.ok(s >= 0 && s <= 1, `${goal} score ${s}`);
  }
  assert.throws(() => scoreVoiceProviderV14(dg, 'nope'), /unknown pick goal/);
  // v13 wrap: no streaming, single final partial.
  const wrapped = wrapVoiceProviderV13(new MockVoiceProviderV13({ mockTranscripts: ['wrapped'] }));
  assert.equal(wrapped.transcribeStream({ frames: FRAMES(1), atMs: 0 })[0].text, 'wrapped');
  assert.equal(wrapped.transcribeStream({ frames: FRAMES(1), atMs: 0 }).length, 1);
  registry.registerV13(new MockVoiceProviderV13({}));
  assert.equal(registry.get('mock').kind, 'mock');
  assert.throws(() => registry.register({ kind: '', transcribe: () => ({}), synthesize: () => ({}), isReady: () => true }), /non-empty kind/);
  assert.ok(voiceProviderV14Summary(dg).includes('Deepgram'));
  assert.ok(voiceProviderRegistryV14Markdown(registry).includes('## Voice providers v14'));
  assert.ok(voiceProviderRegistryV14Markdown(registry).includes('Pocket TTS'));
});

// ---------------------------------------------------------------------------
// 3. Semantic turn-taking v2
// ---------------------------------------------------------------------------

test('smart turn v14: clause splitter, question classifier, fillers, backchannels', () => {
  const clauses = splitClausesV14('Tôi muốn đặt lịch vào thứ sáu, và nhắc tôi trước một giờ.');
  assert.equal(clauses.length, 2);
  assert.equal(clauses[0].endsAtBoundary, true);
  assert.equal(clauses[1].endsAtBoundary, true);
  assert.deepEqual(splitClausesV14(''), []);
  assert.equal(splitClausesV14('Mấy giờ họp?').length, 1);
  assert.equal(splitClausesV14('Mấy giờ họp?')[0].endsAtBoundary, true);
  const mid = splitClausesV14('Tôi muốn đặt lịch vào thứ sáu');
  assert.equal(mid[0].endsAtBoundary, false);

  assert.equal(classifyQuestionV14('Bạn nghĩ sao về kế hoạch này?'), 'open');
  assert.equal(classifyQuestionV14('Mấy giờ họp?'), 'open');
  assert.equal(classifyQuestionV14('Bạn đi không?'), 'closed');
  assert.equal(classifyQuestionV14('Bạn có đi không'), 'closed');
  assert.equal(classifyQuestionV14('What do you think about this?'), 'open');
  assert.equal(classifyQuestionV14('Đặt lịch giúp tôi.'), 'none');
  assert.equal(classifyQuestionV14(''), 'none');

  assert.deepEqual(findFillersV14('ừm à thì tôi nghĩ là'), ['ừm', 'à', 'thì', 'là']);
  assert.deepEqual(findFillersV14('Đặt lịch giúp tôi.'), []);
  assert.equal(classifyBackchannelV14('ừ'), 'ack');
  assert.equal(classifyBackchannelV14('vâng đúng rồi'), 'ack');
  assert.equal(classifyBackchannelV14('rồi sao nữa'), 'continue');
  assert.equal(classifyBackchannelV14('ừm'), 'filler');
  assert.equal(classifyBackchannelV14('Đặt lịch giúp tôi nhé'), 'none');
  assert.equal(classifyBackchannelV14(''), 'none');
});

test('smart turn v14: scorer reuses v13 + adds clause/question/filler signals', () => {
  const closed = scoreTurnCompletenessV14('Bạn đi không?');
  assert.equal(closed.questionKind, 'closed');
  assert.equal(closed.v13.complete, true);
  assert.equal(closed.complete, true);
  const open = scoreTurnCompletenessV14('Bạn nghĩ sao về kế hoạch này?');
  assert.equal(open.questionKind, 'open');
  assert.ok(open.signals.some((s) => s.name === 'open-question'));
  const midClause = scoreTurnCompletenessV14('Tôi muốn đặt lịch vào thứ sáu');
  assert.equal(midClause.endsAtClauseBoundary, false);
  assert.ok(midClause.signals.some((s) => s.name === 'mid-clause'));
  assert.ok(midClause.score < midClause.v13.score);
  const boundary = scoreTurnCompletenessV14('Tôi muốn đặt lịch vào thứ sáu, và nhắc tôi trước một giờ.');
  assert.equal(boundary.endsAtClauseBoundary, true);
  assert.ok(boundary.signals.some((s) => s.name === 'clause-boundary'));
  const filler = scoreTurnCompletenessV14('ừm à thì tôi nghĩ là');
  assert.equal(filler.fillerDensity, 0.67);
  assert.ok(filler.signals.some((s) => s.name === 'filler-thinking'));
  const ack = scoreTurnCompletenessV14('ừ');
  assert.equal(ack.backchannel, 'ack');
  // Sensitivity presets change the thresholds.
  const low = sensitivityPresetV14('low');
  const high = sensitivityPresetV14('high');
  assert.ok(low.completenessThreshold > high.completenessThreshold);
  assert.ok(low.silenceCompleteMs > high.silenceCompleteMs);
  assert.throws(() => validateSmartTurnV14Options({ sensitivity: 'nope' }), /sensitivity must be/);
  assert.throws(() => validateSmartTurnV14Options({ incompleteThreshold: 0.9, completenessThreshold: 0.5 }), /must be <=/);
  const opts = defaultSmartTurnV14Options();
  assert.equal(opts.sensitivity, 'balanced');
  assert.equal(opts.fillerDensityThreshold, 0.25);
});

test('smart turn v14: detector hold-backs then releases (open question, mid-clause, filler)', () => {
  // Open question: v13 would end at 300 ms silence; v14 waits the extra 400 ms.
  const det = createSmartTurnDetectorV14({});
  det.notePartialText('Bạn nghĩ sao về kế hoạch này?', 0);
  det.noteSpeech(800, 0);
  det.noteSilence(400);
  const held = det.decide(400);
  assert.equal(held.ended, false);
  assert.equal(held.reason, 'open-question-wait');
  det.noteSilence(400);
  const ended = det.decide(800);
  assert.equal(ended.ended, true);
  assert.equal(ended.analysis.questionKind, 'open');
  assert.equal(det.getStats().openQuestionWaits, 1);
  assert.equal(det.getStats().openQuestions, 1);
  assert.equal(det.getStats().turns, 1, 'held-back turn counted once');

  // Mid-clause: hold at 800 ms silence, release past the incomplete threshold (1500 ms).
  const det2 = createSmartTurnDetectorV14({});
  det2.notePartialText('Tôi muốn đặt lịch vào thứ sáu', 0);
  det2.noteSpeech(1000, 0);
  det2.noteSilence(800);
  assert.equal(det2.decide(800).reason, 'mid-clause-wait');
  det2.noteSilence(800);
  const ended2 = det2.decide(1600);
  assert.equal(ended2.ended, true);
  assert.equal(det2.getStats().midClauseWaits, 1);
  assert.equal(det2.getStats().turns, 1);

  // Filler-heavy: hold while thinking, then the inner timeout still ends it.
  const det3 = createSmartTurnDetectorV14({ maxTurnMs: 5000 });
  det3.notePartialText('ừm à thì tôi nghĩ là', 0);
  det3.noteSpeech(600, 0);
  det3.noteSilence(300);
  assert.equal(det3.decide(300).reason, 'filler-thinking');
  assert.equal(det3.getStats().fillerThinking, 1);

  // Ack backchannel never ends a turn.
  const det4 = createSmartTurnDetectorV14({});
  det4.notePartialText('ừ', 0);
  det4.noteSpeech(300, 0);
  det4.noteSilence(200);
  const bc = det4.decide(200);
  assert.equal(bc.ended, false);
  assert.equal(bc.analysis.backchannel, 'ack');
  assert.equal(det4.getStats().backchannelAck, 1);

  // High sensitivity ends faster than low sensitivity on the same input.
  const mk = (sensitivity) => {
    const d = createSmartTurnDetectorV14({ sensitivity });
    d.notePartialText('Đặt lịch giúp tôi.', 0);
    d.noteSpeech(800, 0);
    d.noteSilence(200);
    return d.decide(200);
  };
  assert.equal(mk('high').ended, true);
  assert.equal(mk('low').ended, false);

  const stats = det.getStats();
  assert.ok(smartTurnV14Summary(stats).includes('Smart Turn v14'));
  assert.ok(smartTurnV14Markdown(stats).includes('questions: open 1, closed 0'));
  det.reset();
  assert.equal(det.getStats().turns, 0);
});

// ---------------------------------------------------------------------------
// 4. Wake word v2
// ---------------------------------------------------------------------------

test('wake word v14: pending-confirm + VAD confirmation activates; expiry suppresses', () => {
  const det = createWakeWordDetectorV14({
    words: [{ keyword: 'hey bot' }, { keyword: 'này bot', minConfidence: 0.9 }],
  });
  assert.equal(det.getState(), 'asleep');
  assert.deepEqual(det.getKeywords(), ['hey bot', 'này bot']);
  assert.equal(det.noteTranscript('hey bot giúp tôi', 0), null);
  assert.equal(det.getState(), 'pending-confirm');
  const activation = det.noteVadSpeech(300, 400);
  assert.ok(activation);
  assert.equal(activation.keyword, 'hey bot');
  assert.equal(activation.vadConfirmed, true);
  assert.equal(activation.confirmMs, 400);
  assert.equal(det.getState(), 'active');
  assert.equal(det.getStats().vadConfirmedActivations, 1);

  // No VAD speech: the pending hit expires into a suppression.
  const det2 = createWakeWordDetectorV14({ words: [{ keyword: 'hey bot', confirmWindowMs: 1000 }] });
  det2.noteTranscript('hey bot', 0);
  assert.equal(det2.getState(), 'pending-confirm');
  det2.tick(1500);
  assert.equal(det2.getState(), 'asleep');
  assert.equal(det2.getStats().suppressed, 1);
  assert.equal(det2.getSuppressed()[0].reason, 'no-vad-confirmation');

  // A word that needs no confirmation wakes immediately.
  const det3 = createWakeWordDetectorV14({ words: [{ keyword: 'hey bot', requireVadConfirm: false }] });
  const direct = det3.noteTranscript('hey bot', 0);
  assert.ok(direct);
  assert.equal(direct.vadConfirmed, false);
  assert.equal(direct.confirmMs, 0);
});

test('wake word v14: near-miss + low-confidence suppression, per-word cooldown, setWords', () => {
  const det = createWakeWordDetectorV14({
    words: [{ keyword: 'hey bot', minConfidence: 0.99 }, { keyword: 'này bot' }],
    nearMisses: [{ phrase: 'hey bot ơi', confusedWith: 'này bot' }],
  });
  // minConfidence 0.99 > engine 0.95: suppressed as low-confidence.
  det.noteTranscript('hey bot', 0);
  assert.equal(det.getStats().suppressed, 1);
  assert.equal(det.getSuppressed()[0].reason, 'low-confidence');

  // Near-miss phrase suppresses the 'này bot' word.
  const det2 = createWakeWordDetectorV14({
    words: [{ keyword: 'này bot', requireVadConfirm: false }],
    nearMisses: [{ phrase: 'nay bot oi', confusedWith: 'này bot' }],
  });
  det2.noteTranscript('nay bot oi, chào bạn', 0);
  assert.equal(det2.getState(), 'asleep');
  assert.equal(det2.getSuppressed()[0].reason, 'near-miss');

  // Per-word cooldown: 'hey bot' cools down, 'này bot' still wakes.
  const det3 = createWakeWordDetectorV14({
    words: [
      { keyword: 'hey bot', requireVadConfirm: false, cooldownMs: 5000 },
      { keyword: 'này bot', requireVadConfirm: false, cooldownMs: 0 },
    ],
    autoSleepMs: 0,
  });
  det3.noteTranscript('hey bot', 0);
  det3.sleep(100, 'test');
  det3.enterCooldown(100);
  assert.equal(det3.noteTranscript('hey bot', 200), null);
  assert.equal(det3.getStats().refused, 1);
  det3.sleep(6000, 'test');
  det3.tick(6000);
  assert.equal(det3.getState(), 'asleep');

  // setWords + setWordConfig.
  const det4 = createWakeWordDetectorV14({});
  det4.setWords([{ keyword: 'ok bot' }, { keyword: 'hey bot' }], 0);
  assert.deepEqual(det4.getKeywords(), ['ok bot', 'hey bot']);
  assert.equal(det4.setWordConfig('ok bot', { minConfidence: 0.8 }), true);
  assert.equal(det4.setWordConfig('unknown', { minConfidence: 0.8 }), false);
  assert.equal(det4.getWords()[0].minConfidence, 0.8);
  assert.throws(() => createWakeWordDetectorV14({ words: [] }), /non-empty array/);
  assert.throws(() => createWakeWordDetectorV14({ words: [{ keyword: 'a' }, { keyword: 'A' }] }), /unique/);
  assert.throws(() => validateWakeWordV14WordConfig({ keyword: '' }), /non-empty string/);
  assert.equal(defaultWakeWordV14WordConfig('hey bot').confirmWindowMs, 2000);
  const stats = det3.getStats();
  assert.ok(wakeWordV14Summary(stats).includes('Wake word v14'));
  assert.ok(wakeWordV14Markdown(stats).includes('## Wake word v14'));
});

test('wake word v14: test-set evaluation reports FAR/FRR per keyword', () => {
  const evaluation = evaluateWakeWordV14(
    { words: [{ keyword: 'hey bot' }, { keyword: 'này bot' }] },
    [
      { transcript: 'hey bot giúp tôi', expectedKeyword: 'hey bot', vadSpeechMs: 500, atMs: 0 },
      { transcript: 'hey bot', expectedKeyword: 'hey bot', vadSpeechMs: 0, atMs: 1000 },
      { transcript: 'hey bot', expectedKeyword: null, vadSpeechMs: 500, atMs: 2000 },
      { transcript: 'xin chào, hôm nay trời đẹp', expectedKeyword: null, vadSpeechMs: 0, atMs: 3000 },
      { transcript: 'này bot ơi', expectedKeyword: 'này bot', vadSpeechMs: 400, atMs: 4000 },
    ],
  );
  assert.equal(evaluation.samples, 5);
  assert.deepEqual(
    { tp: evaluation.overall.tp, fp: evaluation.overall.fp, fn: evaluation.overall.fn, tn: evaluation.overall.tn },
    { tp: 2, fp: 1, fn: 1, tn: 1 },
  );
  assert.equal(evaluation.overall.falseAcceptRate, 0.5);
  assert.equal(evaluation.overall.falseRejectRate, 0.333);
  assert.equal(evaluation.overall.accuracy, 0.6);
  const heyBot = evaluation.perKeyword.find((r) => r.keyword === 'hey bot');
  assert.equal(heyBot.tp, 1);
  assert.equal(heyBot.fn, 1);
  const nayBot = evaluation.perKeyword.find((r) => r.keyword === 'này bot');
  assert.equal(nayBot.tp, 1);
  assert.equal(nayBot.falseRejectRate, 0);
  const md = wakeWordV14EvaluationMarkdown(evaluation);
  assert.ok(md.includes('false-accept rate: 0.5'));
  assert.ok(md.includes('| hey bot |'));
  assert.throws(() => evaluateWakeWordV14({}, []), /non-empty array/);
});

// ---------------------------------------------------------------------------
// 5. Barge-in v2
// ---------------------------------------------------------------------------

test('barge-in v14: stage queues — capacity, drop policies, reject, flush', () => {
  assert.equal(defaultDropPolicyV14('vad'), 'drop-oldest');
  assert.equal(defaultDropPolicyV14('llm'), 'drop-newest');
  assert.equal(defaultDropPolicyV14('tts'), 'reject');

  const vad = new StageQueueV14('vad', { capacity: 2 });
  assert.deepEqual(vad.enqueue({ id: 'a', payload: 1, atMs: 0, cost: 20 }), { accepted: true, dropped: null });
  vad.enqueue({ id: 'b', payload: 2, atMs: 0, cost: 20 });
  const dropped = vad.enqueue({ id: 'c', payload: 3, atMs: 0, cost: 20 });
  assert.equal(dropped.accepted, true);
  assert.equal(dropped.dropped.id, 'a');
  assert.equal(vad.depth(), 2);
  assert.equal(vad.dequeue().id, 'b');
  assert.equal(vad.peek().id, 'c');

  const llm = new StageQueueV14('llm', { capacity: 1 });
  llm.enqueue({ id: 't1', payload: 'x', atMs: 0, cost: 5 });
  const llmDrop = llm.enqueue({ id: 't2', payload: 'y', atMs: 0, cost: 5 });
  assert.equal(llmDrop.dropped.id, 't2');
  assert.equal(llm.depth(), 1);

  const tts = new StageQueueV14('tts', { capacity: 1 });
  tts.enqueue({ id: 'c1', payload: 'x', atMs: 0, cost: 10 });
  const rejected = tts.enqueue({ id: 'c2', payload: 'y', atMs: 0, cost: 10 });
  assert.equal(rejected.accepted, false);
  assert.match(rejected.reason, /is full/);
  assert.equal(tts.getStats().rejected, 1);
  const flushed = tts.flush();
  assert.equal(flushed.length, 1);
  assert.equal(tts.depth(), 0);
  assert.equal(tts.getStats().flushed, 1);
  assert.throws(() => tts.enqueue({ id: ' ', payload: 1, atMs: 0, cost: 1 }), /non-empty string/);
  assert.throws(() => new StageQueueV14('vad', { capacity: 0 }), /capacity must be/);
  assert.throws(() => new StageQueueV14('vad', { dropPolicy: 'nope' }), /dropPolicy must be/);
});

test('barge-in v14: pipeline cut flushes all queues + scope, measures latency', () => {
  const pipeline = createVoicePipelineV14({ vad: { capacity: 10 }, tts: { capacity: 2 } });
  pipeline.enqueue('vad', { id: 'v1', payload: 1, atMs: 0, cost: 20 });
  pipeline.enqueue('vad', { id: 'v2', payload: 1, atMs: 0, cost: 20 });
  pipeline.enqueue('stt', { id: 's1', payload: 'x', atMs: 0, cost: 100 });
  pipeline.enqueue('llm', { id: 'l1', payload: 'tok', atMs: 0, cost: 5 });
  pipeline.enqueue('tts', { id: 't1', payload: 'chunk', atMs: 0, cost: 50 });
  pipeline.getScope().register({ id: 'llm-gen', label: 'LLM generation', cancel: () => true }, 0);
  pipeline.getScope().register({ id: 'resume', label: 'queued resume', cancel: () => false }, 0);
  assert.equal(pipeline.totalDepth(), 5);
  const cut = pipeline.cut(500, 300, 'vad-speech-start');
  assert.equal(cut.cutLatencyMs, 200);
  assert.equal(cut.discarded.vad, 2);
  assert.equal(cut.discarded.stt, 1);
  assert.equal(cut.discarded.llm, 1);
  assert.equal(cut.discarded.tts, 1);
  assert.equal(cut.totalDiscarded, 5);
  assert.equal(cut.staleWorkCancelled, 1);
  assert.equal(pipeline.totalDepth(), 0);
  const stats = pipeline.getStats();
  assert.equal(stats.cuts, 1);
  assert.equal(stats.cutDiscarded, 5);
  assert.equal(stats.meanCutLatencyMs, 200);
  assert.equal(stats.maxCutLatencyMs, 200);
  assert.equal(stats.scope.cancelled, 1);
  assert.equal(stats.scope.alreadyDone, 1);
  pipeline.reset();
  assert.equal(pipeline.getStats().cuts, 0);
});

test('barge-in v14: mid-sentence split (mid-word, boundary, terminal, edges)', () => {
  // 10 chars lands inside 'các': back off to the word start.
  const split = cutMidSentenceV14('Xin chào các bạn, hôm nay trời đẹp.', 10);
  assert.equal(split.playedText, 'Xin chào');
  assert.equal(split.remainderText, 'các bạn, hôm nay trời đẹp.');
  assert.equal(split.cutWord, 'các');
  assert.equal(split.midSentence, true);
  // 12 chars is exactly 'Xin chào các' (word boundary): keep it.
  const onWord = cutMidSentenceV14('Xin chào các bạn, hôm nay trời đẹp.', 12);
  assert.equal(onWord.playedText, 'Xin chào các');
  assert.equal(onWord.cutWord, '');
  assert.equal(onWord.midSentence, true);
  // 17 chars is 'Xin chào các bạn.' (terminal punct): sentence done.
  const boundary = cutMidSentenceV14('Xin chào các bạn. Hôm nay trời đẹp.', 17);
  assert.equal(boundary.playedText, 'Xin chào các bạn.');
  assert.equal(boundary.remainderText, 'Hôm nay trời đẹp.');
  assert.equal(boundary.midSentence, false);
  assert.equal(boundary.cutWord, '');
  assert.deepEqual(cutMidSentenceV14(REPLY, 0), {
    playedText: '', remainderText: REPLY, playedChars: 0,
    remainderChars: REPLY.length, midSentence: false, cutWord: '',
  });
  const full = cutMidSentenceV14(REPLY, REPLY.length + 10);
  assert.equal(full.remainderText, '');
  assert.equal(full.playedChars, REPLY.length);
});

test('barge-in v14: engine cuts mid-sentence, flushes pipeline, gates echo/cooldown', async () => {
  const engine = createBargeInEngineV14({});
  engine.beginSpeaking(REPLY, 0);
  engine.getPipeline().enqueue('llm', { id: 'l1', payload: 'tok', atMs: 0, cost: 5 });
  engine.getPipeline().enqueue('tts', { id: 't1', payload: 'chunk', atMs: 0, cost: 50 });
  engine.getScope().register({ id: 'llm-gen', label: 'LLM generation', cancel: () => true }, 0);
  engine.advancePlayed(300);
  // Echo-only speech must not cut.
  assert.equal(engine.onVadSpeechStart({ atMs: 100, speechMs: 200, confidence: 0.9, echoOnly: true }), null);
  assert.equal(engine.getStats().v13.echoIgnored, 1);
  // Real speech cuts: pipeline flushed, scope cancelled, played text kept.
  const cut = engine.onVadSpeechStart({ atMs: 500, speechMs: 200, confidence: 0.9 });
  assert.ok(cut);
  assert.equal(cut.pipeline.cutLatencyMs, 200);
  assert.equal(cut.pipeline.discarded.llm, 1);
  assert.equal(cut.pipeline.discarded.tts, 1);
  assert.equal(cut.pipeline.staleWorkCancelled, 1);
  assert.ok(cut.v13.playedText.length > 0);
  assert.equal(engine.getPlayedTranscript(), cut.v13.playedText);
  assert.equal(engine.getStats().v13.cuts, 1);
  // Cooldown: an immediate second cut is gated.
  engine.beginSpeaking(REPLY, 600);
  assert.equal(engine.onVadSpeechStart({ atMs: 700, speechMs: 200, confidence: 0.9 }), null);
  assert.ok(engine.getStats().v13.gated >= 1);
  // Mid-sentence cut path: split + cut in one call.
  const engine2 = createBargeInEngineV14({});
  engine2.beginSpeaking(REPLY, 0);
  const mid = engine2.cutMidSentence(REPLY, 10, 500, 300);
  assert.ok(mid);
  assert.equal(mid.midSentence.playedText, 'Để tôi');
  assert.equal(mid.midSentence.cutWord, 'kiểm');
  assert.equal(mid.midSentence.midSentence, true);
  assert.equal(mid.pipeline.cutLatencyMs, 200);
  assert.equal(engine2.getStats().midSentenceCuts, 1);
  assert.equal(engine2.getStats().midSentenceInside, 1);
  // Nothing to cut when idle.
  const engine3 = createBargeInEngineV14({});
  assert.equal(engine3.cutNow(0), null);
  assert.equal(engine3.onVadSpeechStart({ atMs: 0, speechMs: 100 }), null);
  const stats = engine.getStats();
  assert.ok(bargeInV14Summary(stats).includes('Barge-in v14'));
  assert.ok(bargeInV14Markdown(stats).includes('mean cut latency 200 ms'));
  engine.reset();
  assert.equal(engine.getStats().v13.cuts, 0);
});

// ---------------------------------------------------------------------------
// 6. Session v14
// ---------------------------------------------------------------------------

test('voice session v14: lifecycle, providers, latency, smart turn, barge-in', async () => {
  const manager = createVoiceV14Manager({ mockReplies: [REPLY] });
  const session = manager.create({
    sessionId: 's14',
    botId: 'bot-1',
    language: 'vi',
    providerKindV14: 'pocket-tts',
    latencyBudgetV14: { profile: 'realtime' },
    smartTurnV14: { sensitivity: 'balanced' },
    connectNow: false,
  });
  assert.equal(session.getSessionId(), 's14');
  assert.equal(session.getLatencyProfile(), 'realtime');
  assert.equal(session.getProviderV14().kind, 'pocket-tts');
  assert.equal(session.getProviderV14().isReady(), true);
  await session.connect();
  assert.equal(session.isConnected(), true);
  // Provider pick: latency goal over ready providers picks Pocket TTS.
  const picked = session.pickProviderV14('latency', 'tts');
  assert.equal(picked.kind, 'pocket-tts');
  const pair = session.pickProviderPairV14('quality');
  assert.equal(pair.stt.kind, 'mock');
  // Switch provider (Deepgram is not ready without a key, but the selection still stands).
  session.setProviderV14('deepgram');
  assert.equal(session.getProviderV14().kind, 'deepgram');
  assert.equal(session.getProviderV14().isReady(), false);
  session.setProviderV14('pocket-tts');
  // Latency: record stages incl. network + a full turn (all
  // inside the realtime profile budgets: stt 150 < 200).
  session.recordLatencyStage('turn-1', 'stt', 150);
  session.recordLatencyStage('turn-1', 'network', 120);
  session.recordLatencyStage('turn-1', 'e2e', 650);
  const report = session.getSessionLatencyReport();
  assert.equal(report.turns, 1);
  assert.equal(report.complianceRate, 1);
  assert.equal(report.e2eP50Ms, 650);
  assert.equal(session.getLatencyReportsV14().find((r) => r.stage === 'network').samples, 1);
  assert.equal(session.getLatencyAlertsV14().length, 0);
  session.setLatencyBudgetV14('network', 100);
  session.recordLatencyStage('turn-2', 'network', 300);
  assert.equal(session.getLatencyAlertsV14().length, 1);
  assert.equal(session.getLatencyAlertsV14()[0].level, 'critical');
  // Smart Turn v2 via transcript: open question holds, then ends.
  session.noteTranscript('Bạn nghĩ sao về kế hoạch này?', 0);
  const decision = session.getSmartTurnV14().decide(0);
  assert.ok(decision);
  // Speak + interrupt: pipeline flush + mid-sentence split.
  assert.equal(session.speakReply(REPLY), true);
  assert.equal(session.getBargeInEngineV14().getPipeline().totalDepth(), 2);
  const cut = session.interrupt('test');
  assert.ok(cut);
  assert.equal(cut.pipeline.totalDiscarded, 2);
  assert.ok(cut.midSentence);
  assert.equal(cut.midSentence.playedText, session.getPlayedTranscript());
  const stats = session.getStats();
  assert.equal(stats.providerKindV14, 'pocket-tts');
  assert.equal(stats.bargeInV14.v13.cuts, 1);
  assert.equal(stats.smartTurnV14.turns, 0);
  assert.ok(voiceSessionV14Summary(stats).includes('Voice v14 session s14'));
  assert.ok(voiceSessionV14Markdown(stats).includes('## Voice session v14 — s14'));
  assert.equal(manager.size(), 1);
  assert.equal(manager.ids()[0], 's14');
  assert.equal(manager.remove('s14'), true);
  assert.equal(manager.remove('s14'), false);
  assert.throws(() => manager.create({ sessionId: 'dup' }) === manager.create({ sessionId: 'dup' }), /already exists/);
});

test('voice session v14: wake-word v2 gate ignores frames while asleep, feedAudio queues VAD', async () => {
  const manager = new VoiceV14Manager();
  const session = manager.create({
    sessionId: 's14w',
    wakeWordV14Enabled: true,
    wakeWordV14: { words: [{ keyword: 'hey bot', requireVadConfirm: false }] },
    connectNow: false,
  });
  await session.connect();
  // Asleep: frames are ignored, not queued.
  session.feedAudio(speechLikeFrame());
  assert.equal(session.getStats().wakeV14IgnoredFrames, 1);
  assert.equal(session.getBargeInEngineV14().getPipeline().totalDepth(), 0);
  // Wake via transcript, then frames flow into the pipeline.
  session.noteTranscript('hey bot', 0);
  assert.equal(session.getWakeWordV14().getState(), 'active');
  session.feedAudio(speechLikeFrame());
  session.feedAudio(silenceFrame());
  assert.equal(session.getStats().wakeV14IgnoredFrames, 1);
  assert.equal(session.getBargeInEngineV14().getPipeline().getQueue('vad').depth(), 2);
  // VAD-confirmation wake path.
  const session2 = manager.create({
    sessionId: 's14w2',
    wakeWordV14Enabled: true,
    wakeWordV14: { words: [{ keyword: 'hey bot' }] },
    connectNow: false,
  });
  await session2.connect();
  session2.noteTranscript('hey bot', 0);
  assert.equal(session2.getWakeWordV14().getState(), 'pending-confirm');
  const activation = session2.noteVadSpeech(300, 300);
  assert.ok(activation);
  assert.equal(activation.vadConfirmed, true);
  session2.sleepNowV14(400);
  assert.equal(session2.getWakeWordV14().getState(), 'asleep');
  manager.remove('s14w');
  manager.remove('s14w2');
});

// ---------------------------------------------------------------------------
// 7. Voice v14 tools
// ---------------------------------------------------------------------------

test('voice v14 tools: 9 tools, unique names, placeholder refuses, full lifecycle', async () => {
  assert.equal(VOICE_V14_TOOL_NAMES.length, 9);
  assert.equal(new Set(VOICE_V14_TOOL_NAMES).size, 9);
  assert.equal(VOICE_V14_TOOLS.length, 9);
  assert.equal(isVoiceV14ToolName('voice_v14_session_create'), true);
  assert.equal(isVoiceV14ToolName('voice_v13_session_create'), false);
  assert.ok(ALL_TOOLS.some((t) => t.definition.name === 'voice_v14_session_create'), 'v14 tools are wired into ALL_TOOLS');
  assert.ok(ALL_TOOLS.length >= 1078, `expected at least 1078 tools, got ${ALL_TOOLS.length}`); // v1.39 fix round 4b: floor >= 1078 (was v1.38 re-pin 1078).
  assert.equal(new Set(ALL_TOOLS.map((t) => t.definition.name)).size, ALL_TOOLS.length, 'duplicate tool names in ALL_TOOLS');

  const placeholder = createVoiceV14Tools();
  const run = async (tools, name, args) => {
    const tool = tools.find((t) => t.definition.name === name);
    assert.ok(tool, `missing tool ${name}`);
    return tool.execute(args);
  };
  const refused = await run(placeholder, 'voice_v14_session_create', { sessionId: 'x' });
  assert.match(refused, /not available/);

  const manager = new VoiceV14Manager({ mockReplies: [REPLY] });
  const tools = createVoiceV14Tools({ getManager: () => manager });
  const created = JSON.parse(await run(tools, 'voice_v14_session_create', {
    sessionId: 't1', botId: 'bot-1', language: 'vi', providerKind: 'pocket-tts',
    latencyProfile: 'realtime', sensitivity: 'high', connect: true,
  }));
  assert.equal(created.created, true);
  assert.match(created.summary, /Realtime v14/);
  const badKind = await run(tools, 'voice_v14_session_create', { sessionId: 't2', providerKind: 'nope' });
  assert.match(badKind, /Unknown voice provider kind/);
  const badProfile = await run(tools, 'voice_v14_session_create', { sessionId: 't2', latencyProfile: 'nope' });
  assert.match(badProfile, /Unknown latency profile/);
  const list = JSON.parse(await run(tools, 'voice_v14_session_list', {}));
  assert.equal(list.count, 1);
  assert.equal(list.sessions[0].providerKind, 'pocket-tts');
  const stats = JSON.parse(await run(tools, 'voice_v14_session_stats', { sessionId: 't1' }));
  assert.equal(stats.sessionId, 't1');
  assert.ok(stats.sessionLatencyReport);
  assert.ok(stats.latencyReportsV14.some((r) => r.stage === 'network'));

  // Provider pick + set.
  const pick = JSON.parse(await run(tools, 'voice_v14_provider', { sessionId: 't1', action: 'pick', goal: 'latency', capability: 'tts' }));
  assert.equal(pick.acted.picked.kind, 'pocket-tts');
  assert.equal(pick.acted.pair.tts, 'pocket-tts');
  const set = JSON.parse(await run(tools, 'voice_v14_provider', { sessionId: 't1', action: 'set', kind: 'cartesia' }));
  assert.equal(set.acted.kind, 'cartesia');
  const badGoal = await run(tools, 'voice_v14_provider', { sessionId: 't1', action: 'pick', goal: 'nope' });
  assert.match(badGoal, /Unknown provider pick goal/);

  // Latency budget set + read.
  const budget = JSON.parse(await run(tools, 'voice_v14_latency_budget', { sessionId: 't1', stage: 'network', budgetMs: 100 }));
  assert.equal(budget.updated.budgetMs, 100);
  const badStage = await run(tools, 'voice_v14_latency_budget', { sessionId: 't1', stage: 'nope', budgetMs: 1 });
  assert.match(badStage, /Unknown latency stage/);

  // Wake word: set words, evaluate, wake, sleep.
  const setWords = JSON.parse(await run(tools, 'voice_v14_wake_word', { sessionId: 't1', action: 'set-words', keywords: ['hey bot', 'này bot'] }));
  assert.deepEqual(setWords.acted.keywords, ['hey bot', 'này bot']);
  const evaluation = JSON.parse(await run(tools, 'voice_v14_wake_word', {
    sessionId: 't1',
    action: 'evaluate',
    samples: [
      { transcript: 'hey bot giúp tôi', expectedKeyword: 'hey bot', vadSpeechMs: 500, atMs: 0 },
      { transcript: 'xin chào', expectedKeyword: null, atMs: 1000 },
    ],
  }));
  assert.equal(evaluation.acted.evaluation.overall.tp, 1);
  assert.equal(evaluation.acted.evaluation.overall.tn, 1);
  const wake = JSON.parse(await run(tools, 'voice_v14_wake_word', { sessionId: 't1', action: 'wake' }));
  assert.ok(wake.acted.activation || wake.acted.activation === null);
  await run(tools, 'voice_v14_wake_word', { sessionId: 't1', action: 'sleep' });
  const badAction = await run(tools, 'voice_v14_wake_word', { sessionId: 't1', action: 'nope' });
  assert.match(badAction, /Unknown wake word v14 action/);

  // Barge-in: speak then cut mid-sentence through the tools.
  const session = manager.get('t1');
  assert.equal(session.speakReply(REPLY), true);
  const cut = JSON.parse(await run(tools, 'voice_v14_barge_in', { sessionId: 't1', action: 'cut-mid-sentence', playedChars: 10 }));
  assert.ok(cut.cut);
  assert.equal(cut.cut.midSentence.playedText, 'Để tôi');
  assert.equal(cut.cut.midSentence.cutWord, 'kiểm');
  const badCut = await run(tools, 'voice_v14_barge_in', { sessionId: 't1', action: 'cut-mid-sentence' });
  assert.match(badCut, /needs "playedChars"/);
  const unknown = await run(tools, 'voice_v14_session_stats', { sessionId: 'nope' });
  assert.match(unknown, /Unknown voice v14 session/);

  const stopped = JSON.parse(await run(tools, 'voice_v14_session_stop', { sessionId: 't1' }));
  assert.equal(stopped.stopped, true);
  const deleted = JSON.parse(await run(tools, 'voice_v14_session_delete', { sessionId: 't1' }));
  assert.equal(deleted.deleted, true);
  assert.equal(manager.size(), 0);
});

// ---------------------------------------------------------------------------
// 8. Renderer-local view models
// ---------------------------------------------------------------------------

test('voice v14 view: rows, latency, providers, smart turn, wake, pipeline, eval, formatters', () => {
  assert.equal(parseVoiceV14Status('speaking'), 'speaking');
  assert.equal(parseVoiceV14Status('nope'), 'idle');
  assert.equal(parseVoiceV14LatencyStage('network'), 'network');
  assert.equal(parseVoiceV14LatencyStage('nope'), null);
  assert.equal(parseVoiceV14LatencyProfile('realtime'), 'realtime');
  assert.equal(parseVoiceV14LatencyProfile('nope'), 'cloud');
  assert.equal(parseVoiceV14ProviderKind('cartesia'), 'cartesia');
  assert.equal(parseVoiceV14ProviderKind('edge-tts'), 'mock');
  assert.equal(parseVoiceV14WakeWordState('pending-confirm'), 'pending-confirm');
  assert.equal(parseVoiceV14WakeWordState('nope'), 'asleep');

  const row = parseVoiceSessionV14Row({
    sessionId: 's1', status: 'speaking', connected: true,
    stats: {
      botId: 'b', language: 'vi', voice: 'v', turns: 3, userTurns: 2, agentTurns: 1,
      interrupts: 1, clauses: 4,
      bargeInV14: { v13: { cuts: 2 }, pipeline: { cutDiscarded: 5, meanCutLatencyMs: 180 } },
      smartTurn: { turns: 2 }, smartTurnV14: { turns: 3 },
      wakeWordV14: { state: 'active', activations: 1, suppressed: 2 },
      latencyBudgetV14: { alerts: 3, criticalAlerts: 1 },
      providerKindV14: 'deepgram', providerReadyV14: false,
    },
    latencyProfile: 'realtime',
  });
  assert.equal(row.id, 's1');
  assert.equal(row.bargeInCuts, 2);
  assert.equal(row.pipelineDiscarded, 5);
  assert.equal(row.meanCutLatencyMs, 180);
  assert.equal(row.smartTurnsV14, 3);
  assert.equal(row.wakeSuppressed, 2);
  assert.equal(row.latencyCriticalAlerts, 1);
  assert.equal(row.providerReady, false);
  assert.equal(parseVoiceSessionV14Row(null), null);
  assert.equal(parseVoiceSessionV14Rows([{ sessionId: 'a' }, null, { sessionId: 'b' }]).length, 2);

  const latencyRows = parseVoiceV14LatencyRows({
    stages: [
      { stage: 'network', budgetMs: 250, samples: 4, p50Ms: 100, p95Ms: 200, p99Ms: 220, maxMs: 230, over: 0, overRate: 0, overBudget: false },
      { stage: 'nope', budgetMs: 1 },
    ],
  });
  assert.equal(latencyRows.length, 1);
  assert.equal(latencyRows[0].p99Ms, 220);
  const alertRows = parseVoiceV14AlertRows([
    { sessionId: 's', turnId: 't', stage: 'stt', ms: 900, budgetMs: 400, overMs: 500, level: 'critical', kind: 'sample', atMs: 0 },
    { sessionId: 's', turnId: 't', stage: 'nope', ms: 1 },
  ]);
  assert.equal(alertRows.length, 1);
  assert.equal(alertRows[0].level, 'critical');

  const providerRows = parseVoiceV14ProviderRows([
    {
      kind: 'deepgram', name: 'Deepgram', ready: true,
      capabilities: { stt: true, streamingStt: true, tts: false, streamingTts: false, realtime: true, local: false, requiresKey: true },
      profile: { quality: 0.95, ttsFirstAudioMs: 0, sttLatencyMsPerSecond: 80, sttCostUsdPerMinute: 0.0043, ttsCostUsdPer1kChars: 0 },
    },
    { kind: 'pocket-tts', name: 'Pocket', ready: true, capabilities: { tts: true }, profile: { quality: 0.75, ttsFirstAudioMs: 200 } },
  ]);
  assert.equal(providerRows.length, 2);
  assert.equal(providerRows[0].stt, true);
  assert.equal(providerRows[0].tts, false);
  assert.ok(providerRows[0].scoreQuality > providerRows[1].scoreQuality);
  assert.equal(scoreVoiceV14ProviderRow(providerRows[0], 'quality'), providerRows[0].scoreQuality);

  const smart = parseVoiceV14SmartTurnRow({
    score: 0.8, complete: true,
    clauses: [{ text: 'a' }, { text: 'b' }], endsAtClauseBoundary: true,
    questionKind: 'open', fillerDensity: 0.1, backchannel: 'ack',
    signals: [{ name: 'clause-boundary' }, { name: 'open-question' }],
  });
  assert.equal(smart.clauses, 2);
  assert.equal(smart.questionKind, 'open');
  assert.deepEqual(smart.signals, ['clause-boundary', 'open-question']);
  assert.equal(parseVoiceV14SmartTurnRow(null), null);

  const wakeRows = parseVoiceV14WakeWordRows({
    words: [{ keyword: 'hey bot', minConfidence: 0.5, cooldownMs: 3000, requireVadConfirm: true, confirmWindowMs: 2000 }],
    byKeyword: { 'hey bot': 3 },
    suppressedByKeyword: { 'hey bot': 1 },
  });
  assert.equal(wakeRows.length, 1);
  assert.equal(wakeRows[0].activations, 3);
  assert.equal(wakeRows[0].suppressed, 1);

  const pipelineRows = parseVoiceV14PipelineRows({
    pipeline: { queues: { vad: { depth: 2, maxDepth: 5, enqueued: 10, dequeued: 8, dropped: 1, rejected: 0, flushed: 0, queuedCost: 40 } } },
  });
  assert.equal(pipelineRows.length, 4);
  assert.equal(pipelineRows[0].stage, 'vad');
  assert.equal(pipelineRows[0].depth, 2);
  assert.equal(pipelineRows[1].stage, 'stt');
  assert.equal(pipelineRows[1].depth, 0);

  const evalRows = parseVoiceV14EvalRows({
    overall: { tp: 2, fp: 1, fn: 1, tn: 1, falseAcceptRate: 0.5, falseRejectRate: 0.333, accuracy: 0.6, samples: 5 },
    perKeyword: [{ keyword: 'hey bot', tp: 1, fp: 1, fn: 1, tn: 1, falseAcceptRate: 0.5, falseRejectRate: 0.5, accuracy: 0.5, samples: 4 }],
  });
  assert.equal(evalRows.length, 2);
  assert.equal(evalRows[0].keyword, 'overall');
  assert.equal(evalRows[1].accuracy, 0.5);

  assert.equal(formatVoiceV14Ms(650), '650 ms');
  assert.equal(formatVoiceV14Ms(null), '-');
  assert.equal(formatVoiceV14Rate(0.85), '85%');
  assert.equal(formatVoiceV14Usd(0.0043), '$0.0043');
});

// ---------------------------------------------------------------------------
// 9. i18n
// ---------------------------------------------------------------------------

test('i18n v14: 50 keys in all 6 locales, non-empty, same key set', () => {
  const locales = ['vi', 'en', 'es', 'fr', 'ja', 'zh'];
  const sets = [];
  for (const locale of locales) {
    const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps/desktop/src/renderer/i18n/locales', `${locale}.json`), 'utf8'));
    const keys = Object.keys(data).filter((k) => k.startsWith('voice.realtime.v14.')).sort();
    assert.equal(keys.length, 50, `${locale}: expected 50 v14 keys, got ${keys.length}`);
    for (const key of keys) {
      assert.equal(typeof data[key], 'string', `${locale}:${key} must be a string`);
      assert.ok(data[key].trim().length > 0, `${locale}:${key} must be non-empty`);
    }
    sets.push(new Set(keys));
  }
  for (let i = 1; i < sets.length; i++) {
    assert.deepEqual([...sets[i]].sort(), [...sets[0]].sort(), `locale ${locales[i]} key set differs from vi`);
  }
  const vi = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps/desktop/src/renderer/i18n/locales/vi.json'), 'utf8'));
  assert.equal(vi['voice.realtime.v14.latency.stage.network'], 'Mạng');
  assert.equal(vi['voice.realtime.v14.wakeWord.state.pending-confirm'], 'Chờ xác nhận VAD');
  assert.equal(vi['voice.realtime.v14.bargeIn.midSentence'], 'Cắt giữa câu');
});

// ---------------------------------------------------------------------------
// 10. Core root re-exports
// ---------------------------------------------------------------------------

test('core root re-exports: v14 classes / factories importable from @open-bot/core', () => {
  assert.equal(typeof RootLatencyV14, 'function');
  assert.equal(typeof RootRegistryV14, 'function');
  assert.equal(typeof RootSmartTurnV14, 'function');
  assert.equal(typeof RootWakeV14, 'function');
  assert.equal(typeof RootEngineV14, 'function');
  assert.equal(typeof RootSessionV14, 'function');
  assert.equal(typeof RootManagerV14, 'function');
  const dash = new RootLatencyV14({ profile: 'local' });
  assert.equal(dash.getProfile(), 'local');
  const registry = new RootRegistryV14({ hasKey: true });
  assert.equal(registry.pick({ goal: 'quality', capability: 'stt' }).kind, 'deepgram');
});
