/**
 * Tests for voice v21 eval (WER/latency), the streaming TTS
 * cache, the monitor panel, the tools layer and i18n
 * (v1.34, Team T5).
 *
 * All offline, deterministic, no key / network / audio.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  VoiceEvalV21,
  createVoiceEvalV21,
  scorePairV21,
  pairPassesV21,
  aggregateEvalV21,
  tokenizeEvalV21,
  evalCharsV21,
  pairScoreSummaryV21,
  evalReportMarkdownV21,
  defaultVoiceEvalV21Options,
  validateVoiceEvalV21Options,
  VOICE_V21_EVAL_SAMPLES,
} from '../packages/core/dist/voiceV21/evalV21.js';
import {
  TtsCacheV21,
  createTtsCacheV21,
  fnv1aV21,
  ttsCacheKeyV21,
  splitTtsTextV21,
  estimateTtsDurationMsV21,
  defaultTtsCacheV21Options,
  validateTtsCacheV21Options,
} from '../packages/core/dist/voiceV21/ttsCacheV21.js';
import {
  MonitorPanelV21,
  createMonitorPanelV21,
  cacheHitRateV21,
  defaultMonitorPanelV21Options,
  validateMonitorPanelV21Options,
  VOICE_V21_PANEL_I18N_KEYS,
} from '../packages/core/dist/voiceV21/monitorPanelV21.js';
import {
  createVoiceV21Tools,
  VOICE_V21_TOOLS,
  VOICE_V21_TOOL_NAMES,
  isVoiceV21ToolName,
} from '../packages/tools/dist/voiceV21Tools.js';
import {
  ALL_TOOLS,
  createDefaultTools,
} from '../packages/tools/dist/tools.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCALES_DIR = path.join(__dirname, '..', 'apps', 'desktop', 'src', 'renderer', 'i18n', 'locales');
const LOCALES = ['en', 'es', 'fr', 'ja', 'vi', 'zh'];

function toolMap(tools) {
  const m = new Map();
  for (const t of tools) m.set(t.definition.name, t);
  return m;
}

async function runTool(tools, name, args) {
  const tool = toolMap(tools).get(name);
  assert.ok(tool, `missing tool ${name}`);
  const raw = await tool.execute(args);
  assert.equal(typeof raw, 'string');
  return raw;
}

function runToolJson(tools, name, args) {
  return runTool(tools, name, args).then((raw) => {
    assert.ok(!raw.startsWith('Error:'), `tool ${name} errored: ${raw}`);
    return JSON.parse(raw);
  });
}

// ---------------------------------------------------------------- WER / CER
test('voice v21: WER/CER — identical pair scores 0, one wrong word scores 1/N', () => {
  const perfect = scorePairV21('Hà Nội là thủ đô', 'Hà Nội là thủ đô');
  assert.equal(perfect.wer, 0);
  assert.equal(perfect.cer, 0);
  assert.equal(perfect.matches, 5); // 'Hà Nội là thủ đô' tokenises to 5 words
  const oneWrong = scorePairV21('năm nay tôi ba mươi tuổi', 'nam nay tôi ba mươi tuổi');
  assert.equal(oneWrong.substitutions, 1);
  assert.equal(oneWrong.wer, 0.1667); // scorePairV21 rounds WER to 4 decimals (1/6 → 0.1667)
  assert.equal(oneWrong.refWords, 6);
  const missing = scorePairV21('mua sữa và bánh mì', 'mua sữa bánh mì');
  assert.equal(missing.deletions, 1);
  assert.equal(missing.wer, 0.2);
  const extra = scorePairV21('xin chào', 'xin chào bạn nhé');
  assert.equal(extra.insertions, 2);
  assert.equal(extra.wer, 1);
  assert.equal(pairPassesV21(perfect), true);
  assert.equal(pairPassesV21(oneWrong), false);
  assert.deepEqual(tokenizeEvalV21('Hà Nội, ĐẸP quá!'), ['hà', 'nội', 'đẹp', 'quá']);
  assert.equal(evalCharsV21('ab c').length, 3);
  assert.match(pairScoreSummaryV21(oneWrong), /WER 16.7%/);
});

test('voice v21: eval harness aggregates the built-in corpus with warnings', () => {
  const harness = createVoiceEvalV21();
  harness.addBuiltInSamples();
  assert.equal(harness.sampleCount(), VOICE_V21_EVAL_SAMPLES.length);
  assert.ok(VOICE_V21_EVAL_SAMPLES.length >= 10);
  const report = harness.run();
  assert.equal(report.pairs, VOICE_V21_EVAL_SAMPLES.length);
  assert.ok(report.meanWer > 0 && report.meanWer < 0.1);
  assert.ok(report.topConfusions.some((c) => c.reference === 'năm' && c.hypothesis === 'nam'));
  assert.equal(report.accuracyPass, false); // the năm/nam pair breaches WER on its own
  assert.equal(report.overallPass, false);
  assert.ok(report.warnings.length >= 1);
  const md = evalReportMarkdownV21(report);
  assert.match(md, /Voice eval v21/);
  assert.match(md, /Top confusions/);
  // A clean corpus passes.
  const clean = createVoiceEvalV21();
  clean.addPair({ id: 'c1', reference: 'hello world', hypothesis: 'hello world' });
  clean.addPair({ id: 'c2', reference: 'xin chào', hypothesis: 'xin chào' });
  const cleanReport = clean.run();
  assert.equal(cleanReport.overallPass, true);
  assert.equal(cleanReport.meanWer, 0);
  assert.deepEqual(validateVoiceEvalV21Options({ werBudget: 2 }), ['werBudget must be 0..1']);
  assert.deepEqual(validateVoiceEvalV21Options({}), []);
  assert.equal(defaultVoiceEvalV21Options().werBudget, 0.15);
});

test('voice v21: latency aggregation flags breached stages and end-to-end', () => {
  const scores = [scorePairV21('hello world', 'hello world')];
  const latency = [
    { stage: 'vad', turnId: 't1', durationMs: 20, atMs: 100 },
    { stage: 'stt', turnId: 't1', durationMs: 300, atMs: 200 },
    { stage: 'model', turnId: 't1', durationMs: 900, atMs: 300 },
    { stage: 'tts', turnId: 't1', durationMs: 100, atMs: 400 },
  ];
  const report = aggregateEvalV21(scores, latency, {});
  const model = report.stages.find((s) => s.stage === 'model');
  assert.equal(model?.breached, true);
  assert.equal(model?.p95Ms, 900);
  assert.equal(report.endToEndMeanMs, 1320);
  assert.equal(report.latencyPass, false);
  assert.ok(report.warnings.some((w) => w.includes('model')));
  const fast = aggregateEvalV21(scores, [
    { stage: 'vad', turnId: 't1', durationMs: 20, atMs: 100 },
    { stage: 'stt', turnId: 't1', durationMs: 200, atMs: 200 },
  ], {});
  assert.equal(fast.latencyPass, true);
});

// ---------------------------------------------------------------- TTS cache
test('voice v21: TTS cache key is stable per text+voice and differs per voice', () => {
  assert.equal(ttsCacheKeyV21('hello', 'v1'), ttsCacheKeyV21('hello', 'v1'));
  assert.notEqual(ttsCacheKeyV21('hello', 'v1'), ttsCacheKeyV21('hello', 'v2'));
  assert.notEqual(ttsCacheKeyV21('hello', 'v1'), ttsCacheKeyV21('goodbye', 'v1'));
  assert.equal(fnv1aV21(''), fnv1aV21(''));
  assert.notEqual(fnv1aV21('a'), fnv1aV21('b'));
  assert.deepEqual(splitTtsTextV21('Hello world. Goodbye moon.', 120), ['Hello world.', 'Goodbye moon.']);
  assert.ok(splitTtsTextV21('word '.repeat(100), 120).every((c) => c.length <= 120));
  assert.ok(estimateTtsDurationMsV21('hello world', 1) > 0);
  assert.deepEqual(validateTtsCacheV21Options({ rate: 5 }), ['rate must be 0.5..2']);
  assert.deepEqual(validateTtsCacheV21Options({}), []);
  assert.equal(defaultTtsCacheV21Options().ttlMs, 3_600_000);
});

test('voice v21: TTS cache — first speak misses, second hits, chunks stream', async () => {
  const cache = createTtsCacheV21('s1');
  const first = await cache.synthesize('Hello world, this is a test.', 'voice-a', 1000);
  assert.equal(first.hit, false);
  assert.ok(first.chunks.length >= 1);
  assert.ok(first.durationMs > 0);
  const second = await cache.synthesize('Hello world, this is a test.', 'voice-a', 2000);
  assert.equal(second.hit, true);
  assert.equal(second.chunks.length, first.chunks.length);
  const stats = cache.stats();
  assert.equal(stats.hits, 1);
  assert.equal(stats.misses, 1);
  assert.equal(stats.hitRate, 0.5);
  assert.equal(stats.entries, 1);
  assert.match(cache.summary(), /hit rate 50.0%/);
  // Streaming: chunks arrive one by one from the generator.
  const seen = [];
  const gen = cache.speak('Another sentence here.', 'voice-a', 3000);
  let result;
  while (true) {
    const next = await gen.next();
    if (next.done) { result = next.value; break; }
    seen.push(next.value);
  }
  assert.ok(seen.length >= 1);
  assert.equal(result?.hit, false);
});

test('voice v21: TTS cache — TTL expiry and LRU eviction under capacity', async () => {
  const cache = createTtsCacheV21('s1', { ttlMs: 1000, maxEntries: 2, maxBytes: 1024 * 1024 });
  await cache.synthesize('first sentence', 'v', 0);
  await cache.synthesize('second sentence', 'v', 0);
  assert.equal(cache.stats().entries, 2);
  await cache.synthesize('third sentence', 'v', 0);
  assert.equal(cache.stats().entries, 2);
  assert.equal(cache.stats().evictions, 1);
  assert.equal(cache.has(ttsCacheKeyV21('first sentence', 'v', 1), 0), false);
  assert.equal(cache.has(ttsCacheKeyV21('second sentence', 'v', 1), 0), true);
  // TTL: expired entries are dropped on access.
  assert.equal(cache.has(ttsCacheKeyV21('second sentence', 'v', 1), 5000), false);
  assert.equal(cache.stats().expired, 1);
  const dropped = cache.prune(5000);
  assert.equal(dropped, 1);
  assert.equal(cache.stats().entries, 0);
  cache.clear();
});

// ---------------------------------------------------------------- monitor panel
test('voice v21: monitor panel snapshot tracks turn, transcript, tool, latency, cache', () => {
  const panel = createMonitorPanelV21('sess-1');
  panel.setTurnState('listening', 1000);
  panel.setLivePartial('xin ch', 1100);
  panel.addFinalTranscript('xin chào', 1200);
  panel.addFinalTranscript('tìm kiếm mèo', 1300);
  panel.recordResponseLatency(300, 1400);
  panel.recordLatency({ stage: 'stt', turnId: 't1', durationMs: 250, atMs: 1400 });
  panel.recordLatency({ stage: 'model', turnId: 't1', durationMs: 700, atMs: 1400 });
  panel.setCache({ entries: 3, bytes: 9000, hitRate: 0.75, hits: 3, misses: 1, evictions: 0 }, 1400);
  panel.recordBargeIn('interrupt', 1500);
  panel.recordBargeIn('duck', 1600);
  const snap = panel.snapshot(2000);
  assert.equal(snap.sessionId, 'sess-1');
  assert.equal(snap.turnState, 'listening');
  assert.equal(snap.msInState, 1000);
  assert.equal(snap.livePartial, '');
  assert.deepEqual(snap.finalTranscript, ['xin chào', 'tìm kiếm mèo']);
  assert.equal(snap.latency.meanResponseMs, 300);
  assert.equal(snap.latency.stageMeanMs.stt, 250);
  assert.equal(snap.cache.hitRate, 0.75);
  assert.equal(snap.bargeIns, 1);
  assert.equal(snap.ducks, 1);
  assert.equal(snap.lastBargeInDecision, 'duck');
  assert.deepEqual(snap.alerts, []);
  assert.match(panel.markdown(2000), /Voice monitor v21/);
  assert.match(panel.summary(2000), /listening/);
  assert.equal(cacheHitRateV21(3, 1), 0.75);
  assert.equal(cacheHitRateV21(0, 0), 0);
  assert.deepEqual(validateMonitorPanelV21Options({ lowHitRateThreshold: 2 }), ['lowHitRateThreshold must be 0..1']);
  assert.deepEqual(validateMonitorPanelV21Options({}), []);
  assert.equal(defaultMonitorPanelV21Options().maxTranscriptLines, 10);
});

test('voice v21: monitor panel raises alerts — stale confirmation, breached stage, low hit rate, failing eval', () => {
  const panel = createMonitorPanelV21('sess-1', { staleConfirmationMs: 1000, lowHitRateThreshold: 0.5 });
  panel.setTurnState('confirming', 0);
  panel.setToolCall({
    id: 'vtc-1', sessionId: 'sess-1', turnId: 't1', toolName: 'delete_note', args: {},
    effect: 'delete', status: 'pending-confirmation', requestedAtMs: 0, confirmationRequired: true,
  }, 0);
  panel.setBreachedStages(['model'], 0);
  panel.setCache({ entries: 1, bytes: 100, hitRate: 0.1, hits: 1, misses: 9, evictions: 0 }, 0);
  panel.setEval({
    pairs: 2, totalRefWords: 4, meanWer: 0.5, p95Wer: 0.5, maxWer: 0.5, meanCer: 0.2, p95Cer: 0.2,
    maxCer: 0.2, passCount: 0, passRate: 0, topConfusions: [], stages: [], endToEndMeanMs: 100,
    endToEndP95Ms: 100, endToEndBreached: false, accuracyPass: false, latencyPass: true,
    overallPass: false, warnings: ['Mean WER 50.0% exceeds budget 15.0%.'],
  }, 0);
  const snap = panel.snapshot(5000);
  assert.equal(snap.alerts.length, 4);
  assert.ok(snap.alerts.some((a) => a.includes('delete_note')));
  assert.ok(snap.alerts.some((a) => a.includes('model')));
  assert.ok(snap.alerts.some((a) => a.includes('hit rate')));
  assert.ok(snap.alerts.some((a) => a.includes('eval')));
  assert.ok(VOICE_V21_PANEL_I18N_KEYS.includes('voice.v21.panel.title'));
});

// ---------------------------------------------------------------- tools layer
test('voice v21: tools — all 8 registered, names stable, wired into ALL_TOOLS', () => {
  assert.equal(VOICE_V21_TOOLS.length, 8);
  assert.deepEqual(VOICE_V21_TOOLS.map((t) => t.definition.name), [...VOICE_V21_TOOL_NAMES]);
  for (const name of VOICE_V21_TOOL_NAMES) assert.equal(isVoiceV21ToolName(name), true);
  assert.equal(isVoiceV21ToolName('voice_v20_eval_extended'), false);
  const names = new Set(ALL_TOOLS.map((t) => t.definition.name));
  for (const name of VOICE_V21_TOOL_NAMES) assert.ok(names.has(name), `ALL_TOOLS missing ${name}`);
  assert.equal(new Set(ALL_TOOLS.map((t) => t.definition.name)).size, ALL_TOOLS.length);
  const bound = createVoiceV21Tools();
  assert.equal(bound.length, 8);
  const viaFactory = createDefaultTools();
  assert.ok(viaFactory.some((t) => t.definition.name === 'voice_v21_session'));
});

test('voice v21: tools — session + tool call + confirm end to end', async () => {
  const tools = createVoiceV21Tools();
  const started = await runToolJson(tools, 'voice_v21_session', { action: 'start', atMs: 0 });
  assert.equal(started.state, 'listening');
  const called = await runToolJson(tools, 'voice_v21_tool_call', { transcript: 'take a note buy milk', atMs: 1000 });
  assert.equal(called.toolName, 'take_note');
  assert.equal(called.status, 'pending-confirmation');
  assert.match(called.confirmationPrompt, /take_note|buy milk/);
  const status = await runToolJson(tools, 'voice_v21_confirm', { action: 'status', atMs: 1500 });
  assert.equal(status.pending.toolName, 'take_note');
  const confirmed = await runToolJson(tools, 'voice_v21_confirm', { action: 'confirm', callId: called.callId, atMs: 2000 });
  assert.equal(confirmed.status, 'succeeded');
  assert.match(confirmed.resultText, /buy milk/);
  const read = await runToolJson(tools, 'voice_v21_tool_call', { transcript: 'search the web for cats', atMs: 3000 });
  assert.equal(read.status, 'succeeded');
  const bad = await runTool(tools, 'voice_v21_tool_call', { transcript: 'hello there' });
  assert.match(bad, /recognised":false/);
});

test('voice v21: tools — turn, barge-in, eval, TTS cache, monitor', async () => {
  const tools = createVoiceV21Tools();
  const state = await runToolJson(tools, 'voice_v21_turn', { action: 'state', atMs: 0 });
  assert.equal(state.state, 'idle');
  const classified = await runToolJson(tools, 'voice_v21_turn', { action: 'classify-overlap', durationMs: 500 });
  assert.equal(classified.classification, 'barge-in');
  const burst = await runToolJson(tools, 'voice_v21_barge_in', {
    energy: 0.9, sustainMs: 800, wordsJson: JSON.stringify(['stop', 'wait']), atMs: 100,
    replyText: 'Hello world, this is long.', spokenChars: 5,
  });
  assert.equal(burst.decision, 'interrupt');
  assert.equal(burst.cut.spoken, 'Hello');
  const evaled = await runToolJson(tools, 'voice_v21_eval', { action: 'run' });
  assert.equal(evaled.pairs, VOICE_V21_EVAL_SAMPLES.length);
  assert.match(evaled.markdown, /Voice eval v21/);
  const one = await runToolJson(tools, 'voice_v21_eval', { action: 'score-one', reference: 'hello world', hypothesis: 'hello world' });
  assert.equal(one.wer, 0);
  const keyed = await runToolJson(tools, 'voice_v21_tts_cache', { action: 'key', text: 'hello', voice: 'v1' });
  assert.ok(keyed.key.length > 0);
  const spoken = await runToolJson(tools, 'voice_v21_tts_cache', { action: 'speak', text: 'Hello world.', voice: 'v1', atMs: 100 });
  assert.equal(spoken.hit, false);
  const spokenAgain = await runToolJson(tools, 'voice_v21_tts_cache', { action: 'speak', text: 'Hello world.', voice: 'v1', atMs: 200 });
  assert.equal(spokenAgain.hit, true);
  const cacheStats = await runToolJson(tools, 'voice_v21_tts_cache', { action: 'stats' });
  assert.equal(cacheStats.hitRate, 0.5);
  const monitor = await runToolJson(tools, 'voice_v21_monitor', { action: 'snapshot', atMs: 300 });
  assert.equal(monitor.sessionId, 'default');
  const md = await runToolJson(tools, 'voice_v21_monitor', { action: 'markdown', atMs: 300 });
  assert.match(md.markdown, /Voice monitor v21/);
  const err = await runTool(tools, 'voice_v21_turn', { action: 'nope' });
  assert.ok(err.startsWith('Error:'));
});

// ---------------------------------------------------------------- i18n
test('voice v21: voice.v21.* keys exist in all 6 locales, non-empty, no missing keys', () => {
  const keys = [
    'voice.v21.panel.title',
    'voice.v21.panel.listening',
    'voice.v21.panel.speaking',
    'voice.v21.panel.waiting',
    'voice.v21.panel.confirming',
    'voice.v21.panel.idle',
    'voice.v21.panel.liveTranscript',
    'voice.v21.panel.toolCall',
    'voice.v21.panel.latency',
    'voice.v21.panel.cacheHitRate',
    'voice.v21.panel.bargeIns',
    'voice.v21.panel.eval',
    'voice.v21.panel.alerts',
    'voice.v21.panel.noAlerts',
    'voice.v21.panel.pendingConfirmation',
    'voice.v21.panel.noToolCall',
    'voice.v21.confirm.prompt',
    'voice.v21.confirm.yes',
    'voice.v21.confirm.no',
    'voice.v21.toolCall.denied',
    'voice.v21.toolCall.failed',
    'voice.v21.toolCall.succeeded',
    'voice.v21.toolCall.cancelled',
    'voice.v21.eval.pass',
    'voice.v21.eval.fail',
  ];
  for (const locale of LOCALES) {
    const file = path.join(LOCALES_DIR, `${locale}.json`);
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const key of keys) {
      assert.ok(typeof data[key] === 'string' && data[key].trim() !== '', `${locale} missing/empty ${key}`);
    }
  }
});
