/**
 * Tests for v1.14 — voice realtime v13 (Team T5).
 *
 *   1. Cancel scope v13 (bargeInV13.ts): register / complete /
 *      cancelAll / cancelOne, duplicate id, stats.
 *   2. Barge-in engine v13: validation, policy gate (echo, low
 *      confidence, cooldown, confirm, not speaking), cut flow
 *      (scope cancelled + played text kept + v12 record +
 *      resume strategy), recordObservedCut (inner cut), stats +
 *      markdown.
 *   3. Clause TTS v13 (ttsClauseV13.ts): pure splitter
 *      (sentence / separator / abbreviation / decimal /
 *      force-split / tail), streaming feed (clauses out
 *      immediately), flush, first-clause latency, cancel,
 *      stats + markdown.
 *   4. Smart Turn v13 (smartTurnV13.ts): pure scorer (question,
 *      trailing conjunction, filler, terminal punct, single
 *      word), detector decisions (complete-with-silence,
 *      complete-immediate, backchannel, not-yet, turn-timeout),
 *      stats + markdown.
 *   5. Latency budget v13 (latencyBudgetV13.ts): defaults,
 *      recordStage (p50/p95/over), sample + p95 alerts (once
 *      per turn, recovery re-arms), recordTurn, setBudget,
 *      stage reports, markdown.
 *   6. Wake word v13 (wakeWordV13.ts): mock engine (word
 *      boundary, diacritics folding), detector (activate /
 *      refuse / cooldown / auto-sleep / setKeywords), stats +
 *      markdown.
 *   7. Voice providers v13 (voiceProvidersV13.ts): factory,
 *      capabilities, readiness (whisper model path, realtime
 *      key), mock STT/TTS, edge-tts has no STT, registry
 *      (pickFor, custom register), summary + markdown.
 *   8. Session v13 (voiceSessionV13.ts): connect, speakReply
 *      (clauses planned), explicit interrupt (one v13 record),
 *      Smart Turn via transcript + tick, wake-word gating
 *      (frames ignored while asleep), latency record +
 *      setBudget, provider switch, stats / summary / markdown,
 *      manager registry.
 *   9. Voice v13 tools (packages/tools/src/voiceV13Tools.ts): 8
 *      tools, unique names, placeholder refuses, full lifecycle
 *      through the tools on a real manager, wired into ALL_TOOLS
 *      (828 tools).
 *  10. Renderer-local view models (voiceSessionV13View.ts): row
 *      parsing, barge-in / Smart Turn / latency dashboard /
 *      wake-word / provider / clause rows, formatters.
 *  11. i18n: 46 `voice.realtime.v13.*` keys in all 6 locales,
 *      non-empty, same key set everywhere.
 *  12. Core root re-exports: v13 classes / factories are
 *      importable from `@open-bot/core`.
 *
 * No network, no sound card, no live provider, no key. Every
 * audio path here is mock (audioMockV11 frames, scripted replies,
 * mock synth, scripted provider transcripts).
 * Run after building core + tools:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/voice-v114.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  silenceFrame,
  speechLikeFrame,
  buildMockAudioScript,
} from '../packages/core/dist/voice/audioMockV11.js';
import {
  BargeInV11Controller,
  splitWordsV11,
} from '../packages/core/dist/voice/bargeInV11.js';
import { TtsStreamV11 } from '../packages/core/dist/voice/ttsStreamV11.js';
import {
  CancelScopeV13,
  BargeInEngineV13,
  createBargeInEngineV13,
  defaultBargeInV13Options,
  validateBargeInV13Options,
  isBargeInV13Policy,
  bargeInV13Summary,
  bargeInV13Markdown,
} from '../packages/core/dist/voice/bargeInV13.js';
import {
  ClauseTtsStreamV13,
  createClauseTtsStreamV13,
  splitClausesV13,
  joinPauseForTerminatorV13,
  defaultTtsClauseV13Options,
  validateTtsClauseV13Options,
  ttsClauseV13Summary,
  ttsClauseV13Markdown,
} from '../packages/core/dist/voice/ttsClauseV13.js';
import {
  SmartTurnDetectorV13,
  createSmartTurnDetectorV13,
  scoreTurnCompletenessV13,
  defaultSmartTurnV13Options,
  validateSmartTurnV13Options,
  smartTurnV13Summary,
  smartTurnV13Markdown,
} from '../packages/core/dist/voice/smartTurnV13.js';
import {
  LatencyBudgetV13,
  createLatencyBudgetV13,
  defaultLatencyBudgetV13Budgets,
  validateLatencyBudgetV13Options,
  percentileV13,
  stageReportV13,
  latencyBudgetV13Summary,
  latencyBudgetV13Markdown,
} from '../packages/core/dist/voice/latencyBudgetV13.js';
import {
  MockWakeWordEngineV13,
  WakeWordDetectorV13,
  createWakeWordDetectorV13,
  foldDiacriticsV13,
  defaultWakeWordV13Options,
  validateWakeWordV13Options,
  wakeWordV13Summary,
  wakeWordV13Markdown,
} from '../packages/core/dist/voice/wakeWordV13.js';
import {
  MockVoiceProviderV13,
  EdgeTtsVoiceProviderV13,
  WhisperLocalVoiceProviderV13,
  RealtimeApiVoiceProviderV13,
  createVoiceProviderV13,
  VoiceProviderRegistryV13,
  createVoiceProviderRegistryV13,
  isVoiceProviderV13Kind,
  voiceProviderV13Summary,
  voiceProviderRegistryV13Markdown,
} from '../packages/core/dist/voice/voiceProvidersV13.js';
import {
  RealtimeVoiceSessionV13,
  VoiceV13Manager,
  createRealtimeVoiceSessionV13,
  createVoiceV13Manager,
  voiceSessionV13Summary,
  voiceSessionV13Markdown,
} from '../packages/core/dist/voice/voiceSessionV13.js';
import {
  BargeInEngineV13 as RootEngineV13,
  ClauseTtsStreamV13 as RootClauseV13,
  SmartTurnDetectorV13 as RootSmartTurnV13,
  LatencyBudgetV13 as RootLatencyV13,
  WakeWordDetectorV13 as RootWakeV13,
  VoiceProviderRegistryV13 as RootRegistryV13,
  RealtimeVoiceSessionV13 as RootSessionV13,
  VoiceV13Manager as RootManagerV13,
} from '../packages/core/dist/index.js';
import {
  createVoiceV13Tools,
  VOICE_V13_TOOLS,
  VOICE_V13_TOOL_NAMES,
  isVoiceV13ToolName,
} from '../packages/tools/dist/voiceV13Tools.js';
import { ALL_TOOLS } from '../packages/tools/dist/tools.js';
import {
  parseVoiceV13Status,
  parseVoiceV13BargeInPolicy,
  parseVoiceV13LatencyStage,
  parseVoiceV13WakeWordState,
  parseVoiceV13ProviderKind,
  voiceV13StatusKey,
  voiceV13LatencyStageKey,
  voiceV13ProviderKindKey,
  voiceV13WakeWordStateKey,
  parseVoiceSessionV13Row,
  parseVoiceV13BargeIn,
  parseVoiceV13SmartTurn,
  parseVoiceV13LatencyRow,
  parseVoiceV13LatencyRows,
  parseVoiceV13LatencyDashboard,
  parseVoiceV13WakeWord,
  parseVoiceV13ProviderRow,
  parseVoiceV13ProviderRows,
  parseVoiceV13ClauseRows,
  formatVoiceV13Duration,
  formatVoiceV13OverRate,
  voiceV13SummaryLines,
} from '../apps/desktop/src/renderer/voice/voiceSessionV13View.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SILENCE = silenceFrame();
const CLAUSE_OPTS = { minClauseChars: 12, maxClauseChars: 220 };
const REPLY = 'Để tôi kiểm tra lịch của bạn hôm nay, bạn có ba cuộc họp quan trọng.';

function feedSessionScript(session, segments, input) {
  for (const { frame } of buildMockAudioScript(segments)) {
    if (input) session.feedAudio(frame, input);
    else session.feedAudio(frame);
  }
}

/** Build a real v11 interrupt receipt via the v11 controller (cut mid-reply). */
function makeCutReceipt() {
  const ctrl = new BargeInV11Controller({ policy: 'immediate' });
  ctrl.startListening(0);
  ctrl.beginThinking(100);
  ctrl.beginSpeaking(splitWordsV11(REPLY, REPLY.length * 55), 200);
  ctrl.advancePlayed(400);
  const receipt = ctrl.interrupt(600);
  const tts = new TtsStreamV11();
  tts.feedTextDelta(REPLY, { final: true });
  tts.tick(400);
  const ttsReceipt = tts.cancelPending();
  return { reply: REPLY, receipt, ttsReceipt };
}

// ---------------------------------------------------------------------------
// 1. Cancel scope v13
// ---------------------------------------------------------------------------

test('cancel scope v13: register / complete / cancelAll / cancelOne, duplicate id', () => {
  const scope = new CancelScopeV13();
  assert.deepEqual(scope.getStats(), { registered: 0, cancelled: 0, alreadyDone: 0, pending: 0, cancels: 0 });
  scope.register({ id: 'llm-1', label: 'LLM generation', cancel: () => true }, 0);
  scope.register({ id: 'resume-1', label: 'Queued resume', cancel: () => false }, 10);
  assert.throws(() => scope.register({ id: 'llm-1', label: 'dup', cancel: () => true }), /already registered/);
  assert.deepEqual(scope.pendingIds(), ['llm-1', 'resume-1']);
  assert.equal(scope.complete('llm-1', 20), true);
  assert.equal(scope.complete('llm-1', 20), false);
  assert.deepEqual(scope.pendingIds(), ['resume-1']);
  const one = scope.cancelOne('resume-1', 30);
  assert.equal(one.cancelled, false);
  assert.equal(scope.getStats().alreadyDone, 1);
  assert.equal(scope.cancelOne('missing', 30), null);
  scope.register({ id: 'a', label: 'A', cancel: () => true }, 40);
  scope.register({ id: 'b', label: 'B', cancel: () => true }, 40);
  const all = scope.cancelAll(50, 'barge-in');
  assert.equal(all.cancelled, 2);
  assert.equal(all.alreadyDone, 0);
  assert.equal(all.reason, 'barge-in');
  assert.equal(all.receipts.length, 2);
  assert.equal(scope.getStats().cancels, 1);
  const empty = scope.cancelAll(60);
  assert.deepEqual(empty.receipts, []);
  assert.throws(() => scope.register({ id: ' ', label: 'x', cancel: () => true }), /non-empty/);
});

// ---------------------------------------------------------------------------
// 2. Barge-in engine v13
// ---------------------------------------------------------------------------

test('barge-in v13: validation rejects bad options', () => {
  assert.throws(() => validateBargeInV13Options({ policy: 'nope' }), /policy/);
  assert.throws(() => validateBargeInV13Options({ minSpeechMs: -1 }), /minSpeechMs/);
  assert.throws(() => validateBargeInV13Options({ minConfidence: 1.5 }), /minConfidence/);
  assert.throws(() => validateBargeInV13Options({ cooldownMs: -5 }), /cooldownMs/);
  assert.deepEqual(defaultBargeInV13Options(), {
    policy: 'immediate', minSpeechMs: 150, minConfidence: 0.5,
    cooldownMs: 500, ignoreEchoOnly: true, maxHistory: 50, bargeInV12: {},
  });
  assert.equal(isBargeInV13Policy('immediate'), true);
  assert.equal(isBargeInV13Policy('smart'), false);
});

test('barge-in v13: cut flow keeps played text, cancels scope, records v12 context', () => {
  const events = [];
  const engine = new BargeInEngineV13({}, (e) => events.push(e.kind));
  const clause = new ClauseTtsStreamV13();
  clause.feedTextDelta(REPLY, { final: true, atMs: 100 });
  engine.setTtsQueue(clause);
  let llmStopped = false;
  engine.getScope().register({ id: 'llm-1', label: 'LLM generation', cancel: () => { llmStopped = true; return true; } }, 0);
  engine.beginThinking(0);
  engine.beginSpeaking(REPLY, 100);
  engine.advancePlayed(400);
  engine.noteUserWord('Nhanh', 550, 0.9);
  const cut = engine.onVadSpeechStart({ atMs: 600, speechMs: 300, confidence: 0.9 });
  assert.ok(cut, 'expected a cut');
  assert.equal(llmStopped, true);
  assert.equal(cut.scope.cancelled, 1);
  assert.ok(cut.ttsFlush !== null, 'TTS queue should have been flushed');
  assert.ok(cut.record, 'expected a v12 record');
  assert.equal(cut.playedText, 'Để');
  assert.equal(cut.record.playedText, 'Để');
  assert.equal(cut.record.resumeStrategy, 'restart');
  assert.equal(engine.getPlayedTranscript(), 'Để');
  assert.equal(engine.getLastInterrupt().id, cut.record.id);
  assert.equal(engine.getStats().cuts, 1);
  assert.equal(engine.getStats().playedCharsKept, 'Để'.length);
  assert.equal(engine.getStats().staleWorkCancelled, 1);
  assert.ok(events.includes('cut'));
  assert.match(bargeInV13Summary(engine.getStats()), /1 cuts/);
  assert.match(bargeInV13Markdown(engine.getStats()), /## Barge-in v13/);
  // Second speech-start: nothing left to cut.
  const again = engine.onVadSpeechStart({ atMs: 700, speechMs: 300, confidence: 0.9 });
  assert.equal(again, null);
  assert.equal(engine.getStats().notSpeaking, 1);
});

test('barge-in v13: policy gate — echo, low confidence, cooldown, confirm, not speaking', () => {
  const engine = new BargeInEngineV13({ cooldownMs: 500 });
  assert.equal(engine.onVadSpeechStart({ atMs: 0, speechMs: 300, confidence: 0.9 }), null);
  assert.equal(engine.getStats().notSpeaking, 1);
  engine.beginSpeaking(REPLY, 0);
  assert.equal(engine.onVadSpeechStart({ atMs: 100, speechMs: 300, confidence: 0.9, echoOnly: true }), null);
  assert.equal(engine.getStats().echoIgnored, 1);
  assert.equal(engine.onVadSpeechStart({ atMs: 100, speechMs: 300, confidence: 0.1 }), null);
  assert.equal(engine.getStats().gated, 1);
  const first = engine.onVadSpeechStart({ atMs: 200, speechMs: 300, confidence: 0.9 });
  assert.ok(first);
  engine.beginSpeaking(REPLY, 300);
  assert.equal(engine.onVadSpeechStart({ atMs: 400, speechMs: 300, confidence: 0.9 }), null, 'in cooldown');
  assert.equal(engine.getStats().gated, 2);
  const second = engine.onVadSpeechStart({ atMs: 800, speechMs: 300, confidence: 0.9 });
  assert.ok(second, 'cooldown expired');

  const confirm = new BargeInEngineV13({ policy: 'confirm' });
  confirm.beginSpeaking(REPLY, 0);
  assert.equal(confirm.onVadSpeechStart({ atMs: 100, speechMs: 300, confidence: 0.9 }), null);
  assert.equal(confirm.getStats().gated, 1);
  const explicit = confirm.cutNow(200, 'user-pressed-stop');
  assert.ok(explicit);
  assert.equal(explicit.wasThinking, false);

  const minSpeech = new BargeInEngineV13({ policy: 'after-min-speech', minSpeechMs: 150 });
  minSpeech.beginSpeaking(REPLY, 0);
  assert.equal(minSpeech.onVadSpeechStart({ atMs: 100, speechMs: 50, confidence: 0.9 }), null);
  assert.ok(minSpeech.onVadSpeechStart({ atMs: 200, speechMs: 200, confidence: 0.9 }));
});

test('barge-in v13: recordObservedCut syncs a cut the inner session already made', () => {
  const { reply, receipt, ttsReceipt } = makeCutReceipt();
  assert.equal(receipt.interrupted, true);
  const engine = new BargeInEngineV13();
  engine.beginSpeaking(reply, 200);
  const cut = engine.recordObservedCut({ receipt, tts: ttsReceipt, replyText: reply, atMs: 600 });
  assert.ok(cut);
  assert.equal(cut.record.playedText, receipt.wordsPlayed.join(' '));
  assert.equal(cut.record.resumeStrategy, 'restart');
  assert.equal(engine.getStats().cuts, 1);
  assert.equal(engine.getLastCut().atMs, 600);
  // A receipt that cut nothing records nothing.
  const idle = new BargeInV11Controller({ policy: 'immediate' });
  idle.startListening(0);
  const nothing = idle.interrupt(100);
  assert.equal(nothing.interrupted, false);
  assert.equal(engine.recordObservedCut({ receipt: nothing, tts: ttsReceipt, replyText: reply, atMs: 700 }), null);
  // Re-arming after an observed cut works (controller reset to idle).
  engine.beginSpeaking(reply, 800);
  assert.ok(engine.cutNow(900));
  assert.equal(engine.getStats().cuts, 2);
});

// ---------------------------------------------------------------------------
// 3. Clause TTS v13
// ---------------------------------------------------------------------------

test('clause TTS v13: pure splitter — sentence, separator, abbreviation, decimal, tail', () => {
  const { clauses, tail } = splitClausesV13('Để tôi kiểm tra lịch, bạn có ba cuộc họp. Đầu tiên lúc chín giờ.', CLAUSE_OPTS);
  assert.deepEqual(clauses.map((c) => c.text), [
    'Để tôi kiểm tra lịch,',
    ' bạn có ba cuộc họp.',
    ' Đầu tiên lúc chín giờ.',
  ]);
  assert.equal(tail, '');
  assert.equal(clauses[0].terminator, ',');
  assert.equal(clauses[1].terminator, '.');

  // Vietnamese abbreviation must not split.
  const abbr = splitClausesV13('TS. Lan nói rằng cô ấy sẽ đến.', CLAUSE_OPTS);
  assert.equal(abbr.clauses.length, 1);
  assert.equal(abbr.clauses[0].text, 'TS. Lan nói rằng cô ấy sẽ đến.');

  // Decimal must not split.
  const dec = splitClausesV13('Giá là 3.5 triệu, rất rẻ.', CLAUSE_OPTS);
  assert.deepEqual(dec.clauses.map((c) => c.text), ['Giá là 3.5 triệu,', ' rất rẻ.']);

  // Short clause stays in the tail until flushed.
  const short = splitClausesV13('Xin chào', CLAUSE_OPTS);
  assert.deepEqual(short.clauses, []);
  assert.equal(short.tail, 'Xin chào');

  // Separator below minClauseChars does not close a clause.
  const tiny = splitClausesV13('Ừ, tôi nghe.', { minClauseChars: 12, maxClauseChars: 220 });
  assert.equal(tiny.clauses.length, 1);
  assert.equal(tiny.clauses[0].terminator, '.');

  // Long clause force-splits at a space.
  const long = 'a '.repeat(150).trim() + '.';
  const forced = splitClausesV13(long, { minClauseChars: 12, maxClauseChars: 50 });
  assert.ok(forced.clauses.length >= 3);
  assert.equal(forced.clauses[0].terminator, 'end');

  assert.equal(joinPauseForTerminatorV13(','), 120);
  assert.equal(joinPauseForTerminatorV13(';'), 180);
  assert.equal(joinPauseForTerminatorV13('—'), 300);
  assert.equal(joinPauseForTerminatorV13('.'), 250);
  assert.equal(joinPauseForTerminatorV13('end'), 0);
});

test('clause TTS v13: streaming feed emits clauses immediately, flush speaks the tail', () => {
  const events = [];
  const stream = new ClauseTtsStreamV13({}, (e) => events.push(e.kind));
  const first = stream.feedTextDelta('Để tôi kiểm tra lịch,', { atMs: 0 });
  assert.equal(first.clauses.length, 1);
  assert.equal(first.clauses[0].text, 'Để tôi kiểm tra lịch,');
  assert.equal(first.clauses[0].terminator, ',');
  assert.equal(stream.getStats().firstClauseLatencyMs, 0);
  const second = stream.feedTextDelta(' bạn có ba', { atMs: 100 });
  assert.equal(second.clauses.length, 0, 'no terminator yet');
  assert.equal(stream.getBufferedText(), ' bạn có ba');
  const third = stream.feedTextDelta(' cuộc họp quan trọng.', { final: true, atMs: 200 });
  assert.equal(third.clauses.length, 1, 'sentence clause (no tail left)');
  assert.equal(third.clauses[0].terminator, '.');
  const fourth = stream.feedTextDelta(' Hẹn gặp lại', { final: true, atMs: 300 });
  assert.equal(fourth.clauses.length, 1, 'tail clause');
  assert.equal(fourth.clauses[0].isTail, true);
  assert.equal(stream.getBufferedText(), '');
  const stats = stream.getStats();
  assert.equal(stats.clauses, 3);
  assert.equal(stats.sentenceClauses, 1);
  assert.equal(stats.separatorClauses, 1);
  assert.equal(stats.tailClauses, 1);
  assert.ok(stats.totalJoinPauseMs > 0);
  assert.ok(events.includes('clause-ready'));
  assert.match(ttsClauseV13Summary(stats), /3 clauses/);
  assert.match(ttsClauseV13Markdown(stats), /## TTS clause v13/);
  assert.throws(() => validateTtsClauseV13Options({ minClauseChars: 0 }), /minClauseChars/);
  assert.throws(() => validateTtsClauseV13Options({ maxClauseChars: 5, minClauseChars: 10 }), /maxClauseChars/);
  assert.deepEqual(defaultTtsClauseV13Options(), { minClauseChars: 12, maxClauseChars: 220, ttsV12: {} });
});

test('clause TTS v13: cancel flushes the queue like a barge-in', () => {
  const stream = createClauseTtsStreamV13();
  stream.feedTextDelta('Một câu trả lời rất dài, có nhiều mệnh đề, để kiểm tra việc hủy.', { final: true, atMs: 0 });
  assert.ok(stream.getClauses().length >= 2);
  const cancelled = stream.cancelPending();
  assert.equal(typeof cancelled.chunksCancelled, 'number');
  assert.equal(stream.getBufferedText(), '');
  assert.equal(stream.isDrained(), true);
});

// ---------------------------------------------------------------------------
// 4. Smart Turn v13
// ---------------------------------------------------------------------------

test('smart turn v13: pure scorer — question, trailing conjunction, filler, terminal', () => {
  const q = scoreTurnCompletenessV13('Mấy giờ họp?');
  assert.equal(q.score, 1);
  assert.equal(q.complete, true);
  assert.ok(q.signals.some((s) => s.name === 'question-shape'));
  assert.ok(q.signals.some((s) => s.name === 'terminal-punct'));

  const mid = scoreTurnCompletenessV13('Tôi muốn đặt lịch và');
  assert.equal(mid.complete, false);
  assert.ok(mid.score < 0.3);
  assert.ok(mid.signals.some((s) => s.name === 'trailing-conjunction'));

  const filler = scoreTurnCompletenessV13('ừ');
  assert.equal(filler.complete, false);
  assert.ok(filler.signals.some((s) => s.name === 'filler-only'));

  const done = scoreTurnCompletenessV13('Tôi sẽ gửi báo cáo cho bạn.');
  assert.equal(done.complete, true);
  assert.ok(done.score >= 0.8);

  const empty = scoreTurnCompletenessV13('   ');
  assert.equal(empty.score, 0);
  assert.equal(empty.complete, false);

  const yesNo = scoreTurnCompletenessV13('Bạn có rảnh không');
  assert.equal(yesNo.complete, true, 'yes/no ending closes the turn');
  assert.throws(() => validateSmartTurnV13Options({ completenessThreshold: 2 }), /completenessThreshold/);
  assert.throws(
    () => validateSmartTurnV13Options({ incompleteThreshold: 0.8, completenessThreshold: 0.6 }),
    /incompleteThreshold/,
  );
  assert.equal(defaultSmartTurnV13Options().silenceCompleteMs, 300);
});

test('smart turn v13: detector decisions — content, immediate question, backchannel, timeout', () => {
  const d = new SmartTurnDetectorV13();
  d.noteSpeech(600, 0);
  d.notePartialText('Mấy giờ họp?', 100);
  d.noteSilence(400);
  const ended = d.decide(500);
  assert.equal(ended.ended, true);
  assert.equal(ended.reason, 'complete-with-silence');
  assert.ok(ended.confidence >= 0.9);
  assert.equal(d.getStats().turns, 1);
  assert.equal(d.getStats().endedByContent, 1);

  const q = createSmartTurnDetectorV13();
  q.noteSpeech(600, 0);
  q.notePartialText('Mấy giờ họp?', 100);
  q.noteSilence(150);
  const fast = q.decide(250);
  assert.equal(fast.ended, true);
  assert.equal(fast.reason, 'complete-immediate');

  const b = new SmartTurnDetectorV13();
  b.noteSpeech(300, 0);
  b.notePartialText('ừ', 100);
  b.noteSilence(200);
  const back = b.decide(300);
  assert.equal(back.ended, false);
  assert.equal(back.reason, 'backchannel');
  assert.equal(b.getStats().backchannels, 1);
  assert.equal(b.getText(), '', 'backchannel resets the turn');

  const n = new SmartTurnDetectorV13();
  n.noteSpeech(100, 0);
  n.notePartialText('Tôi muốn', 100);
  const notYet = n.decide(200);
  assert.equal(notYet.ended, false);
  assert.equal(notYet.reason, 'not-yet');

  const t = new SmartTurnDetectorV13();
  t.noteSpeech(600, 0);
  t.notePartialText('Tôi đang nghĩ về việc này', 100);
  const timeout = t.decide(40000);
  assert.equal(timeout.ended, true);
  assert.equal(timeout.reason, 'turn-timeout');
  assert.match(smartTurnV13Summary(t.getStats()), /1 turns ended/);
  assert.match(smartTurnV13Markdown(t.getStats()), /## Smart Turn v13/);
});

// ---------------------------------------------------------------------------
// 5. Latency budget v13
// ---------------------------------------------------------------------------

test('latency budget v13: defaults, percentiles, stage reports', () => {
  assert.deepEqual(defaultLatencyBudgetV13Budgets(), {
    capture: 50, vad: 120, stt: 400, llm: 1500, tts: 600, playback: 150, e2e: 2500,
  });
  assert.equal(percentileV13([], 50), null);
  assert.equal(percentileV13([100, 200, 300], 50), 200);
  assert.equal(percentileV13([100, 200, 300], 100), 300);
  const report = stageReportV13('stt', [300, 400, 500], 400);
  assert.equal(report.p50Ms, 400);
  assert.equal(report.maxMs, 500);
  assert.equal(report.over, 1);
  assert.equal(report.overRate, 0.33);
  assert.equal(report.overBudget, true, 'p95 490 > 400');
  const empty = stageReportV13('llm', [], 1500);
  assert.equal(empty.p50Ms, null);
  assert.equal(empty.overBudget, false);
  assert.throws(() => validateLatencyBudgetV13Options({ budgets: { stt: 0 } }), /budget/);
  assert.throws(() => validateLatencyBudgetV13Options({ budgets: { nope: 100 } }), /budget/);
});

test('latency budget v13: alerts fire once per turn, p95 alert re-arms after recovery', () => {
  const alerts = [];
  const dash = new LatencyBudgetV13({}, (e) => { if (e.kind === 'alert') alerts.push(e.alert); });
  dash.recordStage({ turnId: 't1', stage: 'stt', ms: 520, atMs: 100 });
  assert.equal(alerts.length, 2, 'one sample alert + one p95 alert');
  assert.equal(alerts[0].kind, 'sample');
  assert.equal(alerts[0].overMs, 120);
  assert.equal(alerts[1].kind, 'p95');
  // Same turn + stage again: no new sample alert.
  dash.recordStage({ turnId: 't1', stage: 'stt', ms: 530, atMs: 200 });
  assert.equal(alerts.length, 2);
  // A new turn over budget alerts again.
  dash.recordStage({ turnId: 't2', stage: 'stt', ms: 510, atMs: 300 });
  assert.equal(alerts.length, 3);
  assert.equal(alerts[2].turnId, 't2');
  // Recovery: fast samples bring p95 back under budget, re-arming the p95 alert.
  for (let i = 0; i < 60; i += 1) dash.recordStage({ turnId: `fast-${i}`, stage: 'stt', ms: 100, atMs: 400 + i });
  assert.equal(dash.getStageReport('stt').overBudget, false);
  dash.recordStage({ turnId: 't3', stage: 'stt', ms: 900, atMs: 1000 });
  assert.ok(alerts.some((a) => a.kind === 'p95' && a.turnId === 't3'), 'p95 alert re-armed after recovery');
  assert.equal(dash.setBudget('stt', 1000), 1000);
  assert.equal(dash.getStageReport('stt').budgetMs, 1000);
  assert.throws(() => dash.setBudget('nope', 100), /unknown stage/);
  assert.throws(() => dash.recordStage({ turnId: 't', stage: 'stt', ms: -1, atMs: 0 }), /ms/);
});

test('latency budget v13: recordTurn rolls up per-turn overruns', () => {
  const dash = createLatencyBudgetV13();
  const ok = dash.recordTurn('ok-1', { vad: 40, stt: 300, llm: 900, tts: 400, playback: 100, e2e: 1800 }, 100);
  assert.equal(ok.hasOverrun, false);
  assert.deepEqual(ok.over, []);
  assert.equal(ok.e2eMs, 1800);
  const bad = dash.recordTurn('bad-1', { stt: 900, llm: 2000 }, 200);
  assert.equal(bad.hasOverrun, true);
  assert.deepEqual(bad.over, ['stt', 'llm']);
  assert.equal(dash.getStats().turns, 2);
  assert.equal(dash.getStats().overrunTurns, 1);
  assert.equal(dash.getStats().worstStage, 'stt');
  assert.equal(dash.getLastTurn().turnId, 'bad-1');
  assert.match(latencyBudgetV13Summary(dash.getStats()), /2 turns/);
  const md = latencyBudgetV13Markdown(dash.getStageReports());
  assert.match(md, /\| stage \| budget \| p50 \| p95 \| max \| over \|/);
  assert.match(md, /\| stt \| 400 ms \|/);
});

// ---------------------------------------------------------------------------
// 6. Wake word v13
// ---------------------------------------------------------------------------

test('wake word v13: diacritics folding', () => {
  assert.equal(foldDiacriticsV13('Này Bót'), 'nay bot');
  assert.equal(foldDiacriticsV13('Đi đâu'), 'di dau');
  assert.equal(foldDiacriticsV13('HELLO'), 'hello');
});

test('wake word v13: mock engine — word boundary + diacritics', () => {
  const engine = new MockWakeWordEngineV13({ keywords: ['hey bot'] });
  assert.equal(engine.isReady(), true);
  const hit = engine.detect('hey bot, giúp tôi với', 0);
  assert.equal(hit.matched, true);
  assert.equal(hit.keyword, 'hey bot');
  assert.equal(hit.confidence, 0.95);
  assert.equal(hit.atChar, 0);
  assert.equal(engine.detect('they bought a boat', 0).matched, false, 'no substring match');
  assert.equal(engine.detect('hey botanist', 0).matched, false, 'no prefix match');
  assert.equal(engine.detect('nói hey bot nhé', 0).matched, true);

  const vn = new MockWakeWordEngineV13({ keywords: ['này bot'] });
  assert.equal(vn.detect('nay bot oi', 0).matched, true, 'diacritics-insensitive');
  const strict = new MockWakeWordEngineV13({ keywords: ['này bot'], foldDiacritics: false });
  assert.equal(strict.detect('nay bot oi', 0).matched, false);
  assert.equal(strict.detect('này bot oi', 0).matched, true);
  assert.throws(() => new MockWakeWordEngineV13({ keywords: [] }), /non-empty/);
  assert.throws(() => new MockWakeWordEngineV13({ matchConfidence: 2 }), /matchConfidence/);
});

test('wake word v13: detector — activate, refuse in cooldown, auto-sleep, keywords', () => {
  const detector = new WakeWordDetectorV13({ keywords: ['hey bot'] });
  assert.equal(detector.getState(), 'asleep');
  assert.equal(detector.noteTranscript('xin chào', 0), null);
  assert.equal(detector.getStats().checked, 1);
  const first = detector.noteTranscript('hey bot giúp tôi', 100);
  assert.ok(first);
  assert.equal(first.keyword, 'hey bot');
  assert.equal(detector.getState(), 'active');
  assert.equal(detector.noteTranscript('hey bot nữa', 200), null, 'already awake');
  detector.sleep(1000, 'explicit');
  assert.equal(detector.getState(), 'asleep');
  detector.enterCooldown(1500);
  const refused = detector.noteTranscript('hey bot', 2000);
  assert.equal(refused, null, 'in cooldown');
  assert.equal(detector.getStats().refused, 1);
  detector.tick(5000);
  assert.equal(detector.getState(), 'asleep', 'cooldown expired');
  const second = detector.noteTranscript('hey bot', 5100);
  assert.ok(second);
  assert.equal(detector.getStats().activations, 2);

  // Auto-sleep after silence.
  const auto = new WakeWordDetectorV13({ startAsleep: false, autoSleepMs: 1000 });
  assert.equal(auto.getState(), 'active');
  auto.noteTranscript('hello', 0);
  auto.tick(500);
  assert.equal(auto.getState(), 'active');
  auto.tick(1500);
  assert.equal(auto.getState(), 'asleep');

  // Low-confidence engine hits are refused.
  const weak = new WakeWordDetectorV13({
    engine: new MockWakeWordEngineV13({ keywords: ['hey bot'], matchConfidence: 0.4 }),
    minConfidence: 0.5,
  });
  assert.equal(weak.noteTranscript('hey bot', 0), null);
  assert.equal(weak.getStats().refused, 1);

  // Keywords change.
  detector.setKeywords(['ok bot'], 6000);
  assert.deepEqual(detector.getKeywords(), ['ok bot']);
  detector.sleep(6100, 'explicit');
  assert.equal(detector.noteTranscript('hey bot', 6200), null);
  assert.ok(detector.noteTranscript('ok bot', 6300));
  assert.match(wakeWordV13Summary(detector.getStats()), /ok bot/);
  assert.match(wakeWordV13Markdown(detector.getStats()), /## Wake word v13/);
  assert.throws(() => validateWakeWordV13Options({ keywords: [] }), /non-empty/);
  assert.throws(() => validateWakeWordV13Options({ keywords: ['a', 'A'] }), /unique/);
  assert.deepEqual(defaultWakeWordV13Options().keywords, ['hey bot']);
});

// ---------------------------------------------------------------------------
// 7. Voice providers v13
// ---------------------------------------------------------------------------

test('voice providers v13: factory, capabilities, mock STT/TTS', () => {
  assert.equal(isVoiceProviderV13Kind('edge-tts'), true);
  assert.equal(isVoiceProviderV13Kind('openai'), false);
  assert.throws(() => createVoiceProviderV13('nope'), /unknown kind/);
  const mock = createVoiceProviderV13('mock', { mockTranscripts: ['xin chào', 'tạm biệt'] });
  assert.deepEqual(mock.capabilities, { stt: true, tts: true, realtime: false, local: true, requiresKey: false });
  assert.equal(mock.isReady(), true);
  assert.equal(mock.readinessReason(), '');
  const frames = [new Uint8Array(640), new Uint8Array(640)];
  assert.deepEqual(mock.transcribe({ frames, atMs: 0 }), { text: 'xin chào', confidence: 0.9, isFinal: true, audioMs: 40 });
  assert.deepEqual(mock.transcribe({ frames, atMs: 20 }).text, 'tạm biệt');
  assert.deepEqual(mock.transcribe({ frames, atMs: 40 }).text, 'tạm biệt', 'last transcript repeats');
  assert.equal(mock.transcribe({ frames: [], atMs: 0 }).text, '');
  const synth = mock.synthesize({ text: 'hello', atMs: 0 });
  assert.equal(synth.audioMs, 275);
  assert.equal(synth.chars, 5);
  assert.equal(synth.voice, 'default');
  assert.throws(() => mock.synthesize({ text: '  ', atMs: 0 }), /empty text/);
  assert.match(voiceProviderV13Summary(mock), /Mock \(scripted\).*ready/);
});

test('voice providers v13: readiness gates — whisper model path, realtime key, edge has no STT', () => {
  const edge = new EdgeTtsVoiceProviderV13();
  assert.equal(edge.isReady(), true);
  assert.equal(edge.capabilities.stt, false);
  assert.throws(() => edge.transcribe({ frames: [], atMs: 0 }), /no STT/);
  assert.equal(edge.synthesize({ text: 'hi', atMs: 0 }).audioMs, 110);

  const whisper = new WhisperLocalVoiceProviderV13();
  assert.equal(whisper.isReady(), false);
  assert.match(whisper.readinessReason(), /model path/);
  const whisperReady = new WhisperLocalVoiceProviderV13({ modelPath: '/tmp/ggml-tiny.bin' });
  assert.equal(whisperReady.isReady(), true);

  const realtime = new RealtimeApiVoiceProviderV13();
  assert.equal(realtime.isReady(), false);
  assert.match(realtime.readinessReason(), /API key/);
  assert.throws(() => realtime.transcribe({ frames: [], atMs: 0 }), /not ready/);
  assert.throws(() => realtime.synthesize({ text: 'hi', atMs: 0 }), /not ready/);
  const realtimeKey = new RealtimeApiVoiceProviderV13({ hasKey: true });
  assert.equal(realtimeKey.isReady(), true);
  assert.equal(realtimeKey.capabilities.realtime, true);
});

test('voice providers v13: registry — defaults, pickFor, custom register', () => {
  const registry = createVoiceProviderRegistryV13();
  assert.equal(registry.size(), 4);
  assert.deepEqual(registry.readyKinds(), ['mock', 'edge-tts']);
  assert.equal(registry.pickFor('stt').kind, 'mock');
  assert.equal(registry.pickFor('realtime'), null, 'realtime-api has no key');
  assert.equal(registry.get('nope'), undefined);
  const keyed = createVoiceProviderRegistryV13({ hasKey: true });
  assert.equal(keyed.pickFor('realtime').kind, 'realtime-api');
  const custom = new MockVoiceProviderV13();
  const customProvider = {
    kind: 'custom-x',
    name: 'Custom X',
    capabilities: { stt: true, tts: false, realtime: false, local: true, requiresKey: false },
    isReady: () => true,
    readinessReason: () => '',
    transcribe: (input) => ({ text: 'custom', confidence: 1, isFinal: true, audioMs: input.frames.length * 20 }),
    synthesize: () => { throw new Error('no TTS'); },
  };
  registry.register(customProvider);
  assert.equal(registry.size(), 5);
  assert.equal(registry.get('custom-x').name, 'Custom X');
  assert.throws(() => registry.register({ kind: '', transcribe: () => ({}), synthesize: () => ({}), isReady: () => true }), /non-empty kind/);
  assert.match(voiceProviderRegistryV13Markdown(registry), /## Voice providers v13/);
  assert.match(voiceProviderRegistryV13Markdown(registry), /custom-x/);
});

// ---------------------------------------------------------------------------
// 8. Session v13
// ---------------------------------------------------------------------------

test('session v13: connect, speakReply plans clauses, explicit interrupt records once', async () => {
  const manager = new VoiceV13Manager();
  const session = manager.create({ sessionId: 's1', language: 'vi', mockReplies: [REPLY] });
  await session.connect();
  assert.equal(session.getStatus(), 'listening');
  const started = session.speakReply(REPLY);
  assert.equal(started, true);
  const clauses = session.getClauses();
  assert.ok(clauses.length >= 2, `expected >= 2 clauses, got ${clauses.length}`);
  assert.equal(clauses.map((c) => c.text).join(''), REPLY);
  assert.equal(session.getStats().clauseTts.clauses, clauses.length);
  assert.equal(session.getStats().providerKind, 'mock');
  assert.equal(session.getStats().providerReady, true);
  const cut = session.interrupt('user');
  assert.ok(cut, 'expected a v13 cut result');
  assert.ok(cut.record, 'expected a v12 record');
  assert.equal(session.getLastInterrupt().id, cut.record.id);
  assert.equal(session.getStats().bargeInV13.cuts, 1, 'exactly one v13 cut, not two');
  assert.equal(session.getStats().interrupts, 1, 'exactly one v12 interrupt underneath');
  assert.match(session.getSummary(), /Realtime v13/);
  assert.match(voiceSessionV13Summary(session.getStats()), /Voice v13 session s1/);
  assert.match(voiceSessionV13Markdown(session.getStats()), /# Voice session v13/);
  session.disconnect();
  assert.equal(manager.remove('s1'), true);
  assert.equal(manager.size(), 0);
});

test('session v13: Smart Turn decides from transcript after silence', async () => {
  const session = new RealtimeVoiceSessionV13({ sessionId: 's2', language: 'vi' });
  await session.connect();
  session.getSmartTurn().noteSpeech(600, 0);
  const first = session.noteTranscript('Mấy giờ họp?', 100);
  assert.equal(first.ended, false, 'no silence yet');
  session.tick(400);
  const decided = session.getSmartTurn().decide(session.getNowMs());
  assert.equal(decided.ended, true);
  assert.equal(decided.reason, 'complete-with-silence');
  assert.equal(session.getStats().smartTurn.turns, 1);
  session.disconnect();
});

test('session v13: wake-word gate ignores frames while asleep, forwards after wake', async () => {
  const session = new RealtimeVoiceSessionV13({
    sessionId: 's3',
    wakeWordEnabled: true,
    wakeWordV13: { keywords: ['hey bot'] },
  });
  await session.connect();
  session.feedAudio(SILENCE);
  session.feedAudio(SILENCE);
  session.feedAudio(SILENCE);
  assert.equal(session.getStats().wakeIgnoredFrames, 3);
  assert.equal(session.getNowMs(), 0, 'inner clock did not advance while asleep');
  const decision = session.noteTranscript('hey bot, mở nhạc giúp tôi', 0);
  assert.ok(decision !== null);
  assert.equal(session.getWakeWord().getState(), 'active');
  session.feedAudio(SILENCE);
  session.feedAudio(SILENCE);
  assert.equal(session.getNowMs(), 40);
  assert.equal(session.getStats().wakeIgnoredFrames, 3);
  session.sleepNow();
  assert.equal(session.getWakeWord().getState(), 'asleep');
  session.feedAudio(SILENCE);
  assert.equal(session.getStats().wakeIgnoredFrames, 4);
  session.disconnect();
});

test('session v13: latency record + budget, provider switch, manager registry', async () => {
  const manager = createVoiceV13Manager();
  const session = manager.create({ sessionId: 's4', providerKind: 'edge-tts' });
  assert.equal(session.getProvider().kind, 'edge-tts');
  assert.equal(session.getProvider().isReady(), true);
  session.setProvider('whisper-local');
  assert.equal(session.getProvider().kind, 'whisper-local');
  assert.equal(session.getProvider().isReady(), false, 'no model path configured');
  assert.throws(() => session.setProvider('nope'), /unknown provider kind/);
  session.setProvider('mock');
  const report = session.recordLatencyStage('turn-1', 'stt', 520);
  assert.equal(report.stage, 'stt');
  assert.equal(report.over, 1);
  assert.equal(session.setLatencyBudget('stt', 1000), 1000);
  assert.equal(session.getLatencyReports().find((r) => r.stage === 'stt').budgetMs, 1000);
  const turn = session.recordLatencyTurn('turn-1', { vad: 40, stt: 300, llm: 900 });
  assert.equal(turn.hasOverrun, false);
  assert.equal(manager.ids().length, 1);
  assert.equal(manager.get('s4'), session);
  assert.equal(manager.list().length, 1);
  assert.throws(() => manager.create({ sessionId: 's4' }), /already exists/);
  assert.equal(manager.remove('missing'), false);
  assert.equal(session.getStats().latencyBudget.samples, 4);
});

// ---------------------------------------------------------------------------
// 9. Voice v13 tools
// ---------------------------------------------------------------------------

test('voice v13 tools: 8 tools, unique names, placeholder refuses, full lifecycle', async () => {
  assert.equal(VOICE_V13_TOOL_NAMES.length, 8);
  assert.equal(new Set(VOICE_V13_TOOL_NAMES).size, 8);
  assert.equal(VOICE_V13_TOOLS.length, 8);
  assert.equal(isVoiceV13ToolName('voice_v13_session_create'), true);
  assert.equal(isVoiceV13ToolName('voice_v12_session_create'), false);
  assert.ok(ALL_TOOLS.some((t) => t.definition.name === 'voice_v13_session_create'), 'v13 tools are wired into ALL_TOOLS');
  assert.equal(ALL_TOOLS.length, 899, `expected 825 tools, got ${ALL_TOOLS.length}`); // v1.36 re-pin: 825 + 74 = 899.  assert.equal(new Set(ALL_TOOLS.map((t) => t.definition.name)).size, ALL_TOOLS.length, 'duplicate tool names in ALL_TOOLS');

  // Placeholder (no manager) refuses.
  const placeholder = createVoiceV13Tools();
  const byName = new Map(placeholder.map((t) => [t.definition.name, t]));
  const refused = await byName.get('voice_v13_session_list').execute({});
  assert.match(refused, /not available/);

  const manager = new VoiceV13Manager();
  const tools = createVoiceV13Tools({ getManager: () => manager });
  const bound = new Map(tools.map((t) => [t.definition.name, t]));
  const run = async (name, args) => JSON.parse(await bound.get(name).execute(args));

  const bad = await bound.get('voice_v13_session_create').execute({ sessionId: 't13b', providerKind: 'nope' });
  assert.match(bad, /Unknown voice provider kind/);

  const created = await run('voice_v13_session_create', {
    sessionId: 't13', language: 'vi', providerKind: 'mock',
    wakeWordEnabled: true, keywords: ['hey bot'], bargeInPolicy: 'immediate',
    mockReply: 'Hello tool reply one two three.', connect: true,
  });
  assert.equal(created.created, true);
  assert.match(created.summary, /listening/);
  assert.equal(manager.size(), 1);

  const listed = await run('voice_v13_session_list', {});
  assert.equal(listed.count, 1);
  assert.equal(listed.sessions[0].sessionId, 't13');
  assert.equal(listed.sessions[0].status, 'listening');
  assert.equal(listed.sessions[0].providerKind, 'mock');
  assert.equal(listed.sessions[0].wakeWordState, 'asleep');

  const stats = await run('voice_v13_session_stats', { sessionId: 't13' });
  assert.equal(stats.sessionId, 't13');
  assert.equal(stats.stats.providerKind, 'mock');
  assert.ok(stats.stats.bargeInV13);
  assert.ok(stats.stats.clauseTts);
  assert.ok(stats.stats.smartTurn);
  assert.ok(stats.stats.latencyBudget);
  assert.ok(stats.stats.wakeWord);

  const wake = await run('voice_v13_wake_word', { sessionId: 't13' });
  assert.equal(wake.state, 'asleep');
  assert.deepEqual(wake.keywords, ['hey bot']);
  const woken = await run('voice_v13_wake_word', { sessionId: 't13', action: 'wake' });
  assert.equal(woken.acted.action, 'wake');
  assert.ok(woken.acted.activation);
  const rekeyed = await run('voice_v13_wake_word', { sessionId: 't13', action: 'set-keywords', keywords: ['ok bot'] });
  assert.deepEqual(rekeyed.keywords, ['ok bot']);
  const slept = await run('voice_v13_wake_word', { sessionId: 't13', action: 'sleep' });
  assert.equal(slept.state, 'asleep');
  const badWake = await bound.get('voice_v13_wake_word').execute({ sessionId: 't13', action: 'nope' });
  assert.match(badWake, /Unknown wake word v13 action/);

  const budget = await run('voice_v13_latency_budget', { sessionId: 't13' });
  assert.ok(Array.isArray(budget.reports));
  assert.equal(budget.reports.length, 7);
  assert.equal(budget.reports[0].stage, 'capture');
  const set = await run('voice_v13_latency_budget', { sessionId: 't13', stage: 'stt', budgetMs: 1000 });
  assert.equal(set.updated.budgetMs, 1000);
  assert.equal(set.reports.find((r) => r.stage === 'stt').budgetMs, 1000);
  const badBudget = await bound.get('voice_v13_latency_budget').execute({ sessionId: 't13', stage: 'nope', budgetMs: 100 });
  assert.match(badBudget, /Unknown latency stage/);

  const barge = await run('voice_v13_barge_in', { sessionId: 't13' });
  assert.equal(barge.lastInterrupt, null);
  assert.equal(barge.engine.cuts, 0);
  const badBarge = await bound.get('voice_v13_barge_in').execute({ sessionId: 't13', action: 'nope' });
  assert.match(badBarge, /Unknown barge-in v13 action/);

  const stopped = await run('voice_v13_session_stop', { sessionId: 't13' });
  assert.equal(stopped.stopped, true);
  assert.equal(manager.size(), 1);
  const deleted = await run('voice_v13_session_delete', { sessionId: 't13' });
  assert.equal(deleted.deleted, true);
  assert.equal(manager.size(), 0);
  const unknown = await bound.get('voice_v13_session_stats').execute({ sessionId: 'nope' });
  assert.match(unknown, /Unknown voice v13 session/);
});

// ---------------------------------------------------------------------------
// 10. Renderer-local view models v13
// ---------------------------------------------------------------------------

test('voice v13 view: parsing, keys, formatters', () => {
  assert.equal(parseVoiceV13Status('speaking'), 'speaking');
  assert.equal(parseVoiceV13Status('nope'), 'idle');
  assert.equal(parseVoiceV13BargeInPolicy('confirm'), 'confirm');
  assert.equal(parseVoiceV13BargeInPolicy('smart'), 'immediate');
  assert.equal(parseVoiceV13LatencyStage('llm'), 'llm');
  assert.equal(parseVoiceV13LatencyStage('nope'), 'e2e');
  assert.equal(parseVoiceV13WakeWordState('active'), 'active');
  assert.equal(parseVoiceV13WakeWordState('nope'), 'asleep');
  assert.equal(parseVoiceV13ProviderKind('realtime-api'), 'realtime-api');
  assert.equal(parseVoiceV13ProviderKind('nope'), 'mock');
  assert.equal(voiceV13StatusKey('listening'), 'voice.realtime.v13.status.listening');
  assert.equal(voiceV13LatencyStageKey('stt'), 'voice.realtime.v13.latency.stage.stt');
  assert.equal(voiceV13ProviderKindKey('edge-tts'), 'voice.realtime.v13.provider.edge-tts');
  assert.equal(voiceV13WakeWordStateKey('asleep'), 'voice.realtime.v13.wakeWord.state.asleep');

  const row = parseVoiceSessionV13Row({
    sessionId: 'r1', status: 'speaking', botId: 'b1', language: 'vi', voice: 'v1',
    stats: {
      turns: 3, userTurns: 2, agentTurns: 1, interrupts: 1, clauses: 5,
      bargeInV13: { cuts: 1 }, smartTurn: { turns: 2 },
      providerKind: 'edge-tts', providerReady: true,
      wakeWord: { state: 'active' }, wakeIgnoredFrames: 4, nowMs: 1234,
    },
  });
  assert.equal(row.id, 'r1');
  assert.equal(row.status, 'speaking');
  assert.equal(row.bargeInCuts, 1);
  assert.equal(row.clauses, 5);
  assert.equal(row.providerKind, 'edge-tts');
  assert.equal(row.wakeWordState, 'active');
  assert.equal(row.durationMs, 1234);
  const emptyRow = parseVoiceSessionV13Row(null);
  assert.equal(emptyRow.status, 'idle');
  assert.equal(emptyRow.providerKind, 'mock');

  const barge = parseVoiceV13BargeIn({ speechStarts: 5, cuts: 2, ignored: 3, gated: 1, notSpeaking: 1, echoIgnored: 1, lastCutAtMs: 600, playedCharsKept: 10, ttsCharsDiscarded: 20, staleWorkCancelled: 2, scope: { pending: 1, cancelled: 2 }, context: { interrupts: 2 } });
  assert.equal(barge.cuts, 2);
  assert.equal(barge.scopePending, 1);

  const smart = parseVoiceV13SmartTurn({ turns: 4, endedByContent: 3, endedBySilence: 1, backchannels: 2, meanScore: 0.8, meanConfidence: 0.9 });
  assert.equal(smart.turns, 4);
  assert.equal(smart.meanScore, 0.8);

  const rows = parseVoiceV13LatencyRows([
    { stage: 'tts', budgetMs: 600, samples: 2, p50Ms: 400, p95Ms: 580, maxMs: 600, meanMs: 490, over: 0, overRate: 0, overBudget: false },
    { stage: 'stt', budgetMs: 400, samples: 2, p50Ms: 300, p95Ms: 520, maxMs: 530, meanMs: 410, over: 1, overRate: 0.5, overBudget: true },
  ]);
  assert.deepEqual(rows.map((r) => r.stage), ['stt', 'tts'], 'rows sort into stage order');
  assert.equal(rows[0].label, 'stt · 520 / 400 ms · 1 over');
  assert.equal(rows[0].p95VsBudgetPct, 100, 'capped at 100');
  const single = parseVoiceV13LatencyRow({ stage: 'vad', budgetMs: 120, samples: 1, p50Ms: 80, p95Ms: 80, maxMs: 80, meanMs: 80, over: 0, overRate: 0, overBudget: false });
  assert.equal(single.p95VsBudgetPct, 67);
  const dash = parseVoiceV13LatencyDashboard({ reports: rows, stats: { samples: 4, turns: 1, alerts: 2, overrunTurns: 1 } });
  assert.equal(dash.worstStage, 'stt');
  assert.equal(dash.samples, 4);
  assert.equal(parseVoiceV13LatencyRows(null).length, 0);

  const wake = parseVoiceV13WakeWord({ state: 'active', keywords: ['hey bot'], activations: 2, refused: 1, checked: 10, lastActivation: { keyword: 'hey bot', confidence: 0.95, atMs: 500 } });
  assert.equal(wake.lastKeyword, 'hey bot');
  assert.equal(wake.lastAtMs, 500);

  const providers = parseVoiceV13ProviderRows([
    { kind: 'mock', name: 'Mock (scripted)', capabilities: { stt: true, tts: true, realtime: false, local: true, requiresKey: false }, ready: true, readinessReason: '' },
    { kind: 'realtime-api', name: 'Realtime API', capabilities: { stt: true, tts: true, realtime: true, local: false, requiresKey: true }, ready: false, readinessReason: 'no API key' },
  ]);
  assert.equal(providers.length, 2);
  assert.equal(providers[0].label, 'Mock (scripted) · STT + TTS · ready');
  assert.equal(providers[1].ready, false);
  assert.equal(parseVoiceV13ProviderRow(null).kind, 'mock');

  const clauseRows = parseVoiceV13ClauseRows([
    { index: 1, text: 'Để tôi kiểm tra lịch,', terminator: ',', isTail: false, joinPauseMs: 120, completedAtMs: 0, endChar: 22 },
  ]);
  assert.equal(clauseRows[0].shortText, 'Để tôi kiểm tra lịch,');
  assert.equal(parseVoiceV13ClauseRows(null).length, 0);

  assert.equal(formatVoiceV13Duration(350), '350 ms');
  assert.equal(formatVoiceV13Duration(1500), '1.5 s');
  assert.equal(formatVoiceV13Duration(-1), '-');
  assert.equal(formatVoiceV13OverRate(0.5), '50%');
  assert.deepEqual(voiceV13SummaryLines({ state: 'listening', turns: 2, bargeInCuts: 1, clauses: 3, providerKind: 'mock', providerReady: true, wakeWordState: 'asleep' }), [
    'state: listening', 'turns: 2', 'barge-in cuts: 1', 'clauses: 3', 'provider: mock', 'wake word: asleep',
  ]);
});

// ---------------------------------------------------------------------------
// 11. i18n v13
// ---------------------------------------------------------------------------

test('i18n v13: 46 keys in all 6 locales, non-empty, same key set', () => {
  const locales = ['vi', 'en', 'es', 'fr', 'ja', 'zh'];
  const byLocale = {};
  for (const locale of locales) {
    const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps/desktop/src/renderer/i18n/locales', `${locale}.json`), 'utf8'));
    const keys = Object.keys(data).filter((k) => k.startsWith('voice.realtime.v13.'));
    byLocale[locale] = new Set(keys);
    assert.equal(keys.length, 46, `${locale}: expected 46 v13 keys, got ${keys.length}`);
    for (const key of keys) {
      assert.equal(typeof data[key], 'string', `${locale}:${key} must be a string`);
      assert.ok(data[key].length > 0, `${locale}:${key} must be non-empty`);
    }
  }
  for (const locale of locales.slice(1)) {
    assert.deepEqual([...byLocale[locale]].sort(), [...byLocale.vi].sort(), `v13 key set differs in ${locale}`);
  }
  const vi = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps/desktop/src/renderer/i18n/locales/vi.json'), 'utf8'));
  assert.equal(vi['voice.realtime.v13.title'], 'Voice realtime v13');
  assert.equal(vi['voice.realtime.v13.latency.stage.stt'], 'Nhận dạng giọng nói');
  assert.equal(vi['voice.realtime.v13.wakeWord.state.asleep'], 'Đang ngủ');
});

// ---------------------------------------------------------------------------
// 12. Core root re-exports v13
// ---------------------------------------------------------------------------

test('core root re-exports v13: classes and factories importable from @open-bot/core', () => {
  assert.equal(typeof RootEngineV13, 'function');
  assert.equal(typeof RootClauseV13, 'function');
  assert.equal(typeof RootSmartTurnV13, 'function');
  assert.equal(typeof RootLatencyV13, 'function');
  assert.equal(typeof RootWakeV13, 'function');
  assert.equal(typeof RootRegistryV13, 'function');
  assert.equal(typeof RootSessionV13, 'function');
  assert.equal(typeof RootManagerV13, 'function');
  const engine = new RootEngineV13();
  assert.equal(engine.getStats().cuts, 0);
  const session = new RootSessionV13({ sessionId: 'root-1' });
  assert.equal(session.getProvider().kind, 'mock');
});
