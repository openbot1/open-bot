/**
 * Tests for v1.13 — voice realtime v12 (Team T5).
 *
 *   1. Interrupt context v12 (bargeInV12.ts): strategy choice
 *      (continue / restart / summarize / drop), remainder
 *      summariser, resume prompt, recordInterrupt with a real
 *      v11 receipt + TTS receipt, user interruption words,
 *      setStrategy, stats + markdown.
 *   2. TTS stream v12 (ttsStreamV12.ts): Vietnamese boundaries
 *      (TS./BS. abbreviations, em-dash split, trailing ellipsis
 *      flush), prosody pauses, word timings, pacing factor,
 *      planned streaming through the inner v11 stream, urgent
 *      chunks, cancel receipt.
 *   3. Turn machine v12 (turnTakingV12.ts): guarded state machine
 *      (legal/illegal transitions, transition log), user/agent
 *      turns, interrupt → cooldown → listening, listening
 *      silence timeout + nudges + call-idle, thinking timeout.
 *   4. End-of-turn detector v12: turn ends after trailing
 *      silence, backchannel, false-start, merged pause,
 *      turn-timeout, late speech-start finalises the old turn.
 *   5. Overlap tracker v12 (overlapV12.ts): ducking envelope
 *      ramps (volumeAt), user-wins / agent-keeps / confirm
 *      policies, backchannels, agent words lost, stats + markdown.
 *   6. Session v12 (voiceSessionV12.ts): connect, user turn +
 *      auto mock reply, planned chunks, full barge-in round-trip
 *      over real audio frames (interrupt context recorded,
 *      resumeReply speaks the remainder), overlap recorded,
 *      end-of-turn decisions, manager registry.
 *   7. Voice v12 tools (packages/tools/src/voiceV12Tools.ts): 8
 *      tools, unique names, placeholder refuses, full lifecycle
 *      through the tools on a real manager (wired into ALL_TOOLS
 *      by the coordinator at merge time).
 *   8. Renderer-local view models (voiceSessionV12View.ts): row
 *      parsing, overlap rows, interrupt-context card, planned
 *      chunk rows with current word, status/strategy keys,
 *      formatters.
 *   9. i18n: 40 `voice.realtime.v12.*` keys in all 6 locales,
 *      non-empty, same key set everywhere.
 *  10. Core root re-exports: v12 classes / factories are
 *      importable from `@open-bot/core`.
 *
 * No network, no sound card, no live provider, no key. Every
 * audio path here is mock (audioMockV11 frames, scripted replies,
 * mock sine TTS synth).
 * Run after building core + tools:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/voice-v113.test.mjs
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
import {
  TtsStreamV11,
} from '../packages/core/dist/voice/ttsStreamV11.js';
import {
  InterruptContextV12,
  createInterruptContextV12,
  chooseResumeStrategyV12,
  summarizeRemainderV12,
  buildResumePromptV12,
  defaultBargeInV12Options,
  validateBargeInV12Options,
  isBargeInV12ResumeStrategy,
  bargeInV12Summary,
  bargeInV12Markdown,
} from '../packages/core/dist/voice/bargeInV12.js';
import {
  TtsStreamV12,
  createTtsStreamV12,
  splitTtsStreamChunksV12,
  prosodyForChunkV12,
  wordTimingsV12,
  pacingFactorV12,
  defaultTtsStreamV12Options,
  validateTtsStreamV12Options,
  ttsStreamV12Summary,
  ttsStreamV12Markdown,
} from '../packages/core/dist/voice/ttsStreamV12.js';
import {
  TurnMachineV12,
  EndOfTurnDetectorV12,
  defaultTurnMachineV12Options,
  validateTurnMachineV12Options,
  turnMachineV12Summary,
  turnMachineV12Markdown,
  endOfTurnDetectorV12Summary,
  TURN_V12_TRANSITIONS,
  isTurnV12State,
} from '../packages/core/dist/voice/turnTakingV12.js';
import {
  OverlapTrackerV12,
  DuckEnvelopeV12,
  createOverlapTrackerV12,
  defaultOverlapV12Options,
  validateOverlapV12Options,
  isOverlapV12Policy,
  overlapV12Summary,
  overlapV12Markdown,
} from '../packages/core/dist/voice/overlapV12.js';
import {
  RealtimeVoiceSessionV12,
  VoiceV12Manager,
  createMockVoiceSessionV12,
  voiceSessionV12Summary,
  voiceSessionV12Markdown,
} from '../packages/core/dist/voice/voiceSessionV12.js';
import {
  InterruptContextV12 as RootInterruptContextV12,
  TtsStreamV12 as RootTtsStreamV12,
  TurnMachineV12 as RootTurnMachineV12,
  EndOfTurnDetectorV12 as RootEndOfTurnDetectorV12,
  OverlapTrackerV12 as RootOverlapTrackerV12,
  RealtimeVoiceSessionV12 as RootSessionV12,
  VoiceV12Manager as RootManagerV12,
} from '../packages/core/dist/index.js';
import {
  createVoiceV12Tools,
  VOICE_V12_TOOLS,
  VOICE_V12_TOOL_NAMES,
  isVoiceV12ToolName,
} from '../packages/tools/dist/voiceV12Tools.js';
import { ALL_TOOLS } from '../packages/tools/dist/tools.js';
import {
  parseVoiceSessionV12Row,
  parseVoiceV12Status,
  parseVoiceV12ResumeStrategy,
  parseVoiceV12OverlapPolicy,
  parseVoiceV12TurnMachine,
  parseVoiceV12EndOfTurn,
  parseVoiceV12Overlap,
  parseVoiceV12OverlapRow,
  parseVoiceV12OverlapRows,
  parseVoiceV12InterruptContext,
  parseVoiceV12PlannedChunkRows,
  formatVoiceV12Duration,
  formatVoiceV12Volume,
  voiceV12StatusKey,
  voiceV12ResumeStrategyKey,
  voiceV12OverlapWinnerKey,
  voiceV12SummaryLines,
} from '../apps/desktop/src/renderer/voice/voiceSessionV12View.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SILENCE = silenceFrame();
const SPLIT_OPTS = { minChunkChars: 8, maxChunkChars: 160 };
const TIMING_OPTS = { msPerChar: 55, commaPauseMs: 120, clausePauseMs: 180, ellipsisPauseMs: 350, dashPauseMs: 300 };

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
  const reply = 'Để tôi kiểm tra lịch của bạn hôm nay, bạn có ba cuộc họp quan trọng.';
  ctrl.beginSpeaking(splitWordsV11(reply, reply.length * 55), 200);
  ctrl.advancePlayed(400);
  const receipt = ctrl.interrupt(600);
  const tts = new TtsStreamV11();
  tts.feedTextDelta(reply, { final: true });
  tts.tick(400);
  const ttsReceipt = tts.cancelPending();
  return { reply, receipt, ttsReceipt };
}

// ---------------------------------------------------------------------------
// 1. Interrupt context v12
// ---------------------------------------------------------------------------

test('barge-in v12: validation rejects bad options', () => {
  assert.throws(() => validateBargeInV12Options({ continueMaxChars: -1 }), /continueMaxChars/);
  assert.throws(() => validateBargeInV12Options({ summarizeMinChars: 10, continueMaxChars: 40 }), /summarizeMinChars/);
  assert.throws(() => validateBargeInV12Options({ maxHistory: 0 }), /maxHistory/);
  assert.deepEqual(defaultBargeInV12Options(), {
    continueMaxChars: 40, summarizeMinChars: 200, restartMaxCutIndex: 2, maxHistory: 50,
  });
  assert.equal(isBargeInV12ResumeStrategy('continue'), true);
  assert.equal(isBargeInV12ResumeStrategy('nope'), false);
});

test('barge-in v12: strategy choice covers continue / restart / summarize / drop', () => {
  const opts = defaultBargeInV12Options();
  // Short remainder, cut late → continue.
  assert.equal(chooseResumeStrategyV12({
    wasThinking: false, cutWordIndex: 8, remainingText: 'ba cuộc họp.', userText: '', options: opts,
  }).strategy, 'continue');
  // Cut in the first words → restart.
  assert.equal(chooseResumeStrategyV12({
    wasThinking: false, cutWordIndex: 1, remainingText: 'còn rất nhiều điều để nói ở đây.', userText: '', options: opts,
  }).strategy, 'restart');
  // Still thinking → restart (nothing was heard).
  assert.equal(chooseResumeStrategyV12({
    wasThinking: true, cutWordIndex: -1, remainingText: 'toàn bộ câu trả lời.', userText: '', options: opts,
  }).strategy, 'restart');
  // Long remainder → summarize.
  const long = 'bạn có ba cuộc họp quan trọng, đầu tiên là lúc chín giờ với Lan, sau đó là họp nhóm lúc mười một giờ, và cuối cùng là buổi tổng kết lúc ba giờ chiều tại phòng họp lớn ở tầng hai của tòa nhà văn phòng phía đông thành phố.';
  assert.ok(long.length >= 200, `test remainder is ${long.length} chars`);
  assert.equal(chooseResumeStrategyV12({
    wasThinking: false, cutWordIndex: 8, remainingText: long, userText: '', options: opts,
  }).strategy, 'summarize');
  // New question → drop.
  assert.equal(chooseResumeStrategyV12({
    wasThinking: false, cutWordIndex: 8, remainingText: 'ba cuộc họp.', userText: 'Khoan, chỉ họp với Lan thôi', options: opts,
  }).strategy, 'drop');
  assert.equal(chooseResumeStrategyV12({
    wasThinking: false, cutWordIndex: 8, remainingText: 'ba cuộc họp.', userText: 'Mấy giờ họp?', options: opts,
  }).strategy, 'drop');
  // Nothing left → drop.
  assert.equal(chooseResumeStrategyV12({
    wasThinking: false, cutWordIndex: 8, remainingText: '   ', userText: '', options: opts,
  }).strategy, 'drop');
});

test('barge-in v12: summarizeRemainder keeps the first sentence, truncates at a word', () => {
  assert.equal(summarizeRemainderV12(''), '');
  assert.equal(
    summarizeRemainderV12('Bạn có ba cuộc họp quan trọng hôm nay. Đầu tiên lúc chín giờ. Sau đó lúc mười một giờ.'),
    'Bạn có ba cuộc họp quan trọng hôm nay.',
  );
  assert.equal(summarizeRemainderV12('Ngắn thôi.'), 'Ngắn thôi.');
  const noSentence = 'a'.repeat(50) + ' ' + 'b'.repeat(100);
  const out = summarizeRemainderV12(noSentence);
  assert.ok(out.endsWith('…'), 'long tail without a sentence ends with an ellipsis');
  assert.ok(out.length <= 121);
});

test('barge-in v12: recordInterrupt keeps the cut sentence + user words + resume prompt', () => {
  const { reply, receipt, ttsReceipt } = makeCutReceipt();
  assert.equal(receipt.interrupted, true);
  assert.ok(receipt.cutWord.length > 0);
  assert.ok(receipt.wordsDiscarded.length > 0, 'words remain unheard');
  const ctx = new InterruptContextV12();
  ctx.noteUserWord('Khoan', 550, 0.9);
  ctx.noteUserWord('đã', 570, 0.85);
  assert.equal(ctx.getPendingUserWords().length, 2);
  const record = ctx.recordInterrupt({ receipt, tts: ttsReceipt, replyText: reply });
  assert.equal(ctx.getPendingUserWords().length, 0, 'pending words are consumed');
  assert.equal(record.replyText, reply);
  assert.equal(record.cutWord, receipt.cutWord);
  assert.equal(record.playedText, receipt.wordsPlayed.join(' '));
  assert.equal(record.remainingText, receipt.wordsDiscarded.join(' '));
  assert.equal(record.userInterruption.text, 'Khoan đã');
  assert.equal(record.userInterruption.confidence, 0.88);
  assert.equal(record.ttsChunksCancelled, ttsReceipt.chunksCancelled);
  assert.ok(record.resumePrompt.includes(record.cutWord), 'prompt names the cut word');
  assert.ok(record.resumePrompt.includes(record.remainingText), 'prompt keeps the unheard tail');
  assert.ok(record.resumePrompt.includes('Khoan đã'), 'prompt keeps what the user said');
  // 'Khoan' opens a new turn, so this record drops the old reply.
  assert.equal(record.resumeStrategy, 'drop');
  assert.equal(record.resumeText, '');
  // Without user words the same cut restarts (cut at word 1, too early to resume mid-sentence).
  const ctx3 = new InterruptContextV12();
  const { receipt: receipt3, ttsReceipt: tts3 } = makeCutReceipt();
  const record3 = ctx3.recordInterrupt({ receipt: receipt3, tts: tts3, replyText: reply });
  assert.equal(record3.resumeStrategy, 'restart');
  assert.equal(record3.resumeText, reply);
  assert.equal(ctx.getStats().interrupts, 1);
  assert.equal(ctx.getLast()?.id, record.id);
  assert.ok(bargeInV12Summary(ctx.getStats()).includes('1 interrupts'));
  assert.ok(bargeInV12Markdown(ctx.getStats()).includes('## Barge-in v12'));
  // A new-question interruption drops the old reply.
  const ctx2 = new InterruptContextV12();
  ctx2.noteUserWord('Khoan,', 550, 0.95);
  ctx2.noteUserWord('chỉ', 570, 0.9);
  ctx2.noteUserWord('họp', 590, 0.9);
  ctx2.noteUserWord('với', 610, 0.9);
  ctx2.noteUserWord('Lan', 630, 0.95);
  ctx2.noteUserWord('thôi', 650, 0.9);
  const { receipt: receipt2, ttsReceipt: tts2 } = makeCutReceipt();
  const record2 = ctx2.recordInterrupt({ receipt: receipt2, tts: tts2, replyText: reply });
  assert.equal(record2.resumeStrategy, 'drop');
  assert.equal(record2.resumeText, '');
  // Override the strategy afterwards.
  const updated = ctx2.setStrategy(record2.id, 'continue', 700);
  assert.ok(updated !== null && updated.resumeStrategy === 'continue');
  assert.equal(updated.resumeText, record2.remainingText);
  assert.equal(ctx2.setStrategy(999, 'continue', 700), null);
  assert.throws(() => ctx2.setStrategy(record2.id, 'nope', 700), /strategy/);
  assert.throws(() => ctx.noteUserWord('x', 0, 2), /confidence/);
  const prompt = buildResumePromptV12(record2);
  assert.ok(prompt.includes('Drop this reply'));
  ctx.reset();
  assert.equal(ctx.getStats().interrupts, 0);
  assert.equal(createInterruptContextV12() instanceof InterruptContextV12, true);
});

// ---------------------------------------------------------------------------
// 2. TTS stream v12
// ---------------------------------------------------------------------------

test('tts stream v12: validation rejects bad options', () => {
  assert.throws(() => validateTtsStreamV12Options({ commaPauseMs: -1 }), /commaPauseMs/);
  assert.throws(() => validateTtsStreamV12Options({ maxPacingFactor: 3 }), /maxPacingFactor/);
  assert.throws(() => validateTtsStreamV12Options({ minChunkChars: 50, maxChunkChars: 10 }), /maxChunkChars/);
  assert.equal(defaultTtsStreamV12Options().commaPauseMs, 120);
  assert.equal(defaultTtsStreamV12Options().maxPacingFactor, 1.15);
});

test('tts stream v12: Vietnamese boundaries — abbreviations, dash split, ellipsis flush', () => {
  // TS. / BS. never split a sentence.
  const abbr = splitTtsStreamChunksV12('TS. Lan nói rằng BS. Hùng sẽ đến. Sau đó họ họp.', SPLIT_OPTS);
  assert.deepEqual(abbr.chunks, ['TS. Lan nói rằng BS. Hùng sẽ đến.', 'Sau đó họ họp.']);
  assert.equal(abbr.leftover, '');
  // Em dash closes a chunk (aside break).
  const dash = splitTtsStreamChunksV12('Xin chào — tôi là bot trợ lý. Bạn cần gì?', SPLIT_OPTS);
  assert.deepEqual(dash.chunks, ['Xin chào —', 'tôi là bot trợ lý.', 'Bạn cần gì?']);
  // Trailing ellipsis closes even a short chunk (deliberate pause).
  const ell = splitTtsStreamChunksV12('Để tôi xem…', SPLIT_OPTS);
  assert.deepEqual(ell.chunks, ['Để tôi xem…']);
  assert.equal(ell.leftover, '');
  // Unterminated tail stays buffered.
  const tail = splitTtsStreamChunksV12('Xin chào bạn', SPLIT_OPTS);
  assert.deepEqual(tail.chunks, []);
  assert.equal(tail.leftover, 'Xin chào bạn');
  // Short sentences accumulate until minChunkChars ("Ừ." + " Vâng." = 8 chars closes).
  const short = splitTtsStreamChunksV12('Ừ. Vâng. Tôi nghe đây.', SPLIT_OPTS);
  assert.deepEqual(short.chunks, ['Ừ. Vâng.', 'Tôi nghe đây.']);
  // Long unterminated text splits at commas without duplicating.
  const long = 'Đây là một câu rất dài, có nhiều mệnh đề, kéo dài mãi, vẫn chưa kết thúc, cứ tiếp tục như vậy, thêm nữa, và thêm nữa, vẫn chưa hết, còn tiếp tục kéo dài thêm một đoạn nữa cho đủ dài';
  assert.ok(long.length > 160, `test text is ${long.length} chars`);
  const split = splitTtsStreamChunksV12(long, SPLIT_OPTS);
  assert.ok(split.chunks.length >= 2, `expected splits, got ${JSON.stringify(split.chunks)}`);
  assert.ok(split.leftover.length > 0, 'the last part stays buffered as leftover');
  const rejoined = split.chunks.join(' ') + (split.leftover ? ` ${split.leftover}` : '');
  assert.equal(rejoined.replace(/\s+/g, ' ').trim(), long, 'split is lossless');
});

test('tts stream v12: prosody pauses + word timings are exact and monotonic', () => {
  const text = 'Xin chào bạn, hôm nay trời đẹp… Tôi sẽ giúp bạn.';
  const prosody = prosodyForChunkV12(text, TIMING_OPTS);
  assert.ok(prosody.some((p) => p.mark === ',' && p.pauseMs === 120), 'comma pause 120 ms');
  assert.ok(prosody.some((p) => p.mark === '…' && p.pauseMs === 350), 'ellipsis pause 350 ms');
  const timings = wordTimingsV12('Xin chào, bạn nhé.', TIMING_OPTS);
  assert.deepEqual(timings.map((w) => w.word), ['Xin', 'chào,', 'bạn', 'nhé.']);
  for (let i = 0; i < timings.length; i += 1) {
    const w = timings[i];
    assert.ok(w.endMs > w.startMs, 'word has positive duration');
    if (i > 0) assert.ok(w.startMs >= timings[i - 1].endMs, 'timings are monotonic');
  }
  // The comma pause lands between "chào," and "bạn".
  const gap = timings[2].startMs - timings[1].endMs;
  assert.equal(gap, 120, `comma pause gap ${gap} ms`);
  // Word timings cover the whole chunk text.
  const total = timings[timings.length - 1].endMs;
  assert.ok(total > 0 && total <= text.length * 55 + 1000);
});

test('tts stream v12: pacing factor grows with queue depth', () => {
  assert.equal(pacingFactorV12(0, 1.15), 1);
  assert.equal(pacingFactorV12(2, 1.15), 1);
  assert.equal(pacingFactorV12(3, 1.15), 1.05);
  assert.equal(pacingFactorV12(6, 1.15), 1.15);
  assert.equal(pacingFactorV12(20, 1.15), 1.15);
});

test('tts stream v12: streaming deltas plan chunks, play through the inner stream, urgent jumps ahead', () => {
  const events = [];
  const stream = new TtsStreamV12({}, (e) => events.push(e));
  const fed = stream.feedTextDelta('Xin chào bạn. Hôm nay trời rất đẹp, phải không?');
  assert.ok(fed.chunksReady >= 2, `chunksReady ${fed.chunksReady}`);
  assert.ok(events.some((e) => e.kind === 'chunk-planned'), 'chunk-planned events fire');
  const planned = stream.getPlannedChunks();
  assert.ok(planned.length >= 2);
  assert.ok(planned.every((c) => c.wordTimings.length > 0), 'every planned chunk has word timings');
  assert.ok(planned.every((c) => c.estDurationMs > 0), 'every planned chunk has an estimate');
  // Playback drains on the virtual clock.
  stream.tick(20000);
  assert.equal(stream.isDrained(), true);
  assert.ok(stream.getStats().chunksDone >= 2, `chunksDone ${stream.getStats().chunksDone}`);
  assert.ok(ttsStreamV12Summary(stream.getStats()).includes('planned'));
  assert.ok(ttsStreamV12Markdown(stream.getStats()).includes('## TTS stream v12'));
  // Urgent: an acknowledgement jumps ahead of buffered reply text.
  const stream2 = new TtsStreamV12({}, (e) => events.push(e));
  stream2.feedTextDelta('Đây là câu trả lời dài chưa nói hết');
  const urgent = stream2.feedUrgent('Vâng, tôi nghe đây.');
  assert.ok(urgent !== null && urgent.urgent === true);
  assert.equal(stream2.getStats().urgentChunks, 1);
  assert.ok(events.some((e) => e.kind === 'urgent-planned'));
  assert.equal(stream2.feedUrgent('   '), null);
  // Cancel receipt.
  const stream3 = new TtsStreamV12();
  stream3.feedTextDelta('Một hai ba bốn năm sáu bảy tám chín mười. Câu thứ hai đây.');
  stream3.tick(100);
  const cancelled = stream3.cancelPending();
  assert.equal(cancelled.cancelled, true);
  assert.ok(cancelled.chunksCancelled >= 1);
  assert.ok(cancelled.charsDiscarded > 0);
  assert.throws(() => stream3.feedTextDelta(123), /string/);
  assert.throws(() => stream3.tick(-5), /tick/);
  assert.equal(createTtsStreamV12() instanceof TtsStreamV12, true);
});

test('tts stream v12: planChunks matches the inner stream for plain replies', () => {
  const stream = new TtsStreamV12();
  const reply = 'Hello mock reply one two three. Second sentence here.';
  const planned = stream.planChunks(reply);
  assert.deepEqual(planned.map((c) => c.text), ['Hello mock reply one two three.', 'Second sentence here.']);
  stream.feedTextDelta(reply, { final: true });
  const innerChunks = stream.getInner().getQueuedChunks().map((c) => c.text);
  assert.deepEqual(innerChunks, planned.map((c) => c.text), 'planned chunks feed 1:1 into the inner stream');
});

// ---------------------------------------------------------------------------
// 3. Turn machine v12
// ---------------------------------------------------------------------------

test('turn machine v12: validation + guarded transitions count illegal moves', () => {
  assert.throws(() => validateTurnMachineV12Options({ listeningSilenceMs: 10 }), /listeningSilenceMs/);
  assert.throws(() => validateTurnMachineV12Options({ maxNudges: -1 }), /maxNudges/);
  assert.deepEqual(defaultTurnMachineV12Options().listeningSilenceMs, 8000);
  assert.equal(isTurnV12State('speaking'), true);
  assert.equal(isTurnV12State('ducked'), false, 'ducked is a v11 state, not a v12 turn state');
  assert.ok(TURN_V12_TRANSITIONS['speaking'].includes('interrupted'));
  const machine = new TurnMachineV12();
  assert.equal(machine.getState(), 'idle');
  // Illegal: speak from idle — beginAgentTurn refuses without
  // touching the guarded table (no illegal transition counted).
  assert.equal(machine.beginAgentTurn(0), null);
  assert.equal(machine.getStats(0).illegalTransitions, 0);
  assert.equal(machine.transitionTo('speaking', 'test', 0), false);
  assert.equal(machine.getStats(0).illegalTransitions, 1);
  assert.equal(machine.getTransitions().filter((t) => !t.ok).length, 1);
});

test('turn machine v12: full call — listen, user turn, think, speak, interrupt, cooldown, listen', () => {
  const events = [];
  const machine = new TurnMachineV12({}, (e) => events.push(e));
  assert.equal(machine.start(0), true);
  assert.equal(machine.getState(), 'listening');
  const userTurn = machine.beginUserTurn(100);
  assert.ok(userTurn !== null && userTurn.speaker === 'user');
  const sameTurn = machine.beginUserTurn(150);
  assert.ok(sameTurn !== null && sameTurn.id === userTurn.id, 'a second start returns the open user turn');
  const closed = machine.endUserTurn(900, 'speech-end');
  assert.ok(closed !== null && closed.durationMs === 800);
  assert.equal(machine.getState(), 'thinking');
  const agentTurn = machine.beginAgentTurn(1000);
  assert.ok(agentTurn !== null && agentTurn.speaker === 'agent');
  assert.equal(machine.getState(), 'speaking');
  assert.equal(machine.interrupt(1500), true);
  assert.equal(machine.getState(), 'interrupted');
  assert.equal(machine.getStats(1500).interrupts, 1);
  assert.equal(machine.tick(1600), 'cooldown', 'interrupted settles into cooldown');
  assert.equal(machine.tick(4000), 'listening', 'cooldown expires back to listening');
  assert.equal(machine.getHistory().length, 2, 'user + agent turns recorded');
  assert.equal(machine.getHistory()[1].endedBy, 'barge-in');
  assert.ok(events.some((e) => e.kind === 'turn-started'));
  assert.ok(events.some((e) => e.kind === 'turn-ended'));
  assert.ok(turnMachineV12Summary(machine.getStats(4000)).includes('listening'));
  assert.ok(turnMachineV12Markdown(machine.getStats(4000)).includes('## Turn machine v12'));
  assert.equal(machine.endCall(5000), true);
  assert.equal(machine.getState(), 'idle');
  machine.reset();
  assert.equal(machine.getHistory().length, 0);
});

test('turn machine v12: listening silence timeout nudges then goes call-idle, thinking times out', () => {
  const events = [];
  const machine = new TurnMachineV12(
    { listeningSilenceMs: 2000, maxNudges: 2, thinkingTimeoutMs: 1000 },
    (e) => events.push(e),
  );
  machine.start(0);
  machine.tick(2000);
  assert.equal(machine.getStats(2000).silenceTimeouts, 1);
  assert.equal(machine.getStats(2000).nudges, 1);
  assert.ok(events.some((e) => e.kind === 'silence-timeout' && e.nudge === 1));
  assert.ok(events.some((e) => e.kind === 'nudge'));
  machine.tick(4000);
  assert.equal(machine.getStats(4000).nudges, 2);
  machine.tick(6000);
  assert.ok(events.some((e) => e.kind === 'call-idle'), 'third silence stretch goes call-idle');
  assert.equal(machine.getStats(6000).nudges, 2, 'no more nudges after call-idle');
  // Thinking timeout: user turn ends → thinking → timeout → listening.
  machine.beginUserTurn(7000);
  machine.endUserTurn(7100, 'speech-end');
  assert.equal(machine.getState(), 'thinking');
  machine.tick(8100);
  assert.equal(machine.getState(), 'listening');
  assert.equal(machine.getStats(8100).thinkingTimeouts, 1);
  assert.ok(events.some((e) => e.kind === 'thinking-timeout'));
});

// ---------------------------------------------------------------------------
// 4. End-of-turn detector v12
// ---------------------------------------------------------------------------

test('end-of-turn v12: turn ends after trailing silence, not on speech-end alone', () => {
  const decisions = [];
  const detector = new EndOfTurnDetectorV12({ trailingSilenceMs: 700, minSpeechMs: 300 }, (d) => decisions.push(d));
  const started = detector.speechStart(0);
  assert.equal(started?.kind, 'turn-started');
  detector.speechEnd(1000);
  assert.equal(detector.tick(1500), null, 'only 500 ms of silence — turn stays open');
  const ended = detector.tick(1700);
  assert.ok(ended !== null && ended.kind === 'turn-ended');
  assert.equal(ended.speechMs, 1000);
  assert.equal(ended.silenceMs, 700);
  assert.equal(detector.getStats(1700).turns, 1);
  assert.ok(endOfTurnDetectorV12Summary(detector.getStats(1700)).includes('1 turns'));
});

test('end-of-turn v12: backchannel, false-start, merged pause, timeout', () => {
  const decisions = [];
  const detector = new EndOfTurnDetectorV12(
    { trailingSilenceMs: 700, minSpeechMs: 300, mergePauseMs: 500, maxTurnMs: 2000 },
    (d) => decisions.push(d),
  );
  // Very short burst → backchannel.
  detector.speechStart(0);
  detector.speechEnd(100);
  const bc = detector.tick(800);
  assert.ok(bc !== null && bc.kind === 'backchannel');
  assert.equal(detector.getStats(800).backchannels, 1);
  // Mid-length burst that stops early → false-start.
  detector.speechStart(1000);
  detector.speechEnd(1200);
  const fs = detector.tick(1900);
  assert.ok(fs !== null && fs.kind === 'false-start');
  assert.equal(detector.getStats(1900).falseStarts, 1);
  // Short pause merges into the same turn.
  detector.speechStart(2000);
  detector.speechEnd(2500);
  const merged = detector.speechStart(2800);
  assert.ok(merged !== null && merged.kind === 'turn-merged', `got ${merged?.kind}`);
  assert.equal(merged.turnId, 3, 'same turn id continues (backchannel/false-start do not count as turns)');
  assert.equal(detector.getStats(2800).merged, 1);
  detector.speechEnd(3500);
  const ended = detector.tick(4200);
  assert.ok(ended !== null && ended.kind === 'turn-ended');
  assert.equal(ended.speechMs, 1200, 'speech before + after the pause counts');
  // A pause past mergePauseMs but below trailing silence still continues the turn silently.
  detector.speechStart(5000);
  detector.speechEnd(5500);
  const resumed = detector.speechStart(6100);
  assert.equal(resumed, null, '600 ms pause continues without a merge event');
  detector.speechEnd(6600);
  const ended2 = detector.tick(7300);
  assert.ok(ended2 !== null && ended2.kind === 'turn-ended');
  // Max turn force-ends a monologue.
  detector.speechStart(8000);
  const timeout = detector.tick(10000);
  assert.ok(timeout !== null && timeout.kind === 'turn-timeout');
  assert.equal(detector.getStats(10000).timeouts, 1);
  // Late speech-start finalises the old turn first.
  const detector2 = new EndOfTurnDetectorV12({ trailingSilenceMs: 700, minSpeechMs: 300 });
  detector2.speechStart(0);
  detector2.speechEnd(1000);
  const late = detector2.speechStart(3000);
  assert.ok(late !== null && late.kind === 'turn-started', 'new turn opens after the old one ended');
  assert.equal(detector2.getStats(3000).turns, 1, 'the old turn was finalised');
  assert.throws(() => new EndOfTurnDetectorV12({ mergePauseMs: 700, trailingSilenceMs: 700 }), /mergePauseMs/);
});

// ---------------------------------------------------------------------------
// 5. Overlap tracker v12
// ---------------------------------------------------------------------------

test('overlap v12: validation + ducking envelope ramps down and back up', () => {
  assert.throws(() => validateOverlapV12Options({ policy: 'nope' }), /policy/);
  assert.throws(() => validateOverlapV12Options({ duckFactor: 2 }), /duckFactor/);
  assert.equal(defaultOverlapV12Options().policy, 'user-wins');
  assert.equal(isOverlapV12Policy('confirm'), true);
  assert.equal(isOverlapV12Policy('user'), false);
  const env = new DuckEnvelopeV12({ duckFactor: 0.35, duckRampMs: 120, resumeRampMs: 250 });
  assert.equal(env.volumeAt(0), 1);
  env.duckAt(100);
  assert.equal(env.volumeAt(100), 1);
  const mid = env.volumeAt(160);
  assert.ok(mid > 0.35 && mid < 1, `mid-ramp volume ${mid}`);
  assert.equal(env.volumeAt(220), 0.35, 'ramp bottoms out at the duck factor');
  assert.equal(env.volumeAt(1000), 0.35, 'holds while the user speaks');
  env.resumeAt(1000);
  const up = env.volumeAt(1125);
  assert.ok(up > 0.35 && up < 1, `mid-rise volume ${up}`);
  assert.equal(env.volumeAt(1250), 1, 'back to full volume after the resume ramp');
  assert.equal(env.isDucked(1100), true);
  assert.equal(env.isDucked(2000), false);
  env.reset();
  assert.equal(env.volumeAt(3000), 1);
});

test('overlap v12: user-wins resolves at speech-start, agent words lost are logged', () => {
  const events = [];
  const tracker = new OverlapTrackerV12({ policy: 'user-wins' }, (e) => events.push(e));
  tracker.noteAgentSpeaking('Hello mock reply one two three four five.', 0);
  tracker.noteUserSpeechStart(1000, 0.9);
  // user-wins resolves immediately on confirmed speech.
  assert.equal(tracker.isOverlapping(), false);
  const segments = tracker.getSegments();
  assert.equal(segments.length, 1);
  assert.equal(segments[0].winner, 'user');
  assert.equal(tracker.getStats(1200).userWins, 1);
  assert.ok(events.some((e) => e.kind === 'overlap-opened'));
  assert.ok(events.some((e) => e.kind === 'overlap-resolved'));
  assert.ok(events.some((e) => e.kind === 'duck-start'));
  // user-wins cuts the reply instead of ducking it: the volume
  // never drops (the duck ramp starts and is resumed from 1.0
  // in the same instant). Ducking is visible on the confirm
  // tracker below, where the overlap stays open.
  assert.equal(tracker.volumeAt(1050), 1, 'cut, not ducked: full volume after a user-wins resolve');
  tracker.noteUserSpeechEnd(1300);
  assert.equal(tracker.volumeAt(2000), 1, 'volume restored after the overlap');
  tracker.noteAgentStopped();
  // Agent words lost: resolve with a cut index.
  const tracker2 = new OverlapTrackerV12({ policy: 'confirm' });
  tracker2.noteAgentSpeaking('Hello mock reply one two three four five.', 0);
  tracker2.noteUserSpeechStart(1000, 0.9);
  assert.ok(tracker2.volumeAt(1050) < 1, 'ducking while the overlap is open');
  assert.equal(tracker2.isOverlapping(), true, 'confirm policy waits for an explicit resolve');
  tracker2.noteUserWord('Khoan');
  tracker2.noteUserWord('đã');
  const resolved = tracker2.resolveOverlap('user', 1400, 'host decided', 4);
  assert.ok(resolved !== null);
  assert.deepEqual(resolved.agentWordsLost, ['two', 'three', 'four', 'five.']);
  assert.deepEqual(resolved.userWords, ['Khoan', 'đã']);
  assert.equal(resolved.durationMs, 400);
  assert.equal(tracker2.getStats(1400).agentWordsLost, 4);
  assert.ok(overlapV12Summary(tracker2.getStats(1400)).includes('1 overlaps'));
  assert.ok(overlapV12Markdown(tracker2.getStats(1400), tracker2.getSegments()).includes('agent lost "two three four five."'));
  assert.equal(tracker2.resolveOverlap('user', 1500, 'nothing open'), null);
  assert.equal(createOverlapTrackerV12() instanceof OverlapTrackerV12, true);
});

test('overlap v12: agent-keeps treats short bursts as backchannels', () => {
  const events = [];
  const tracker = new OverlapTrackerV12({ policy: 'agent-keeps', backchannelMs: 400 }, (e) => events.push(e));
  tracker.noteAgentSpeaking('Hello mock reply one two three.', 0);
  tracker.noteUserSpeechStart(1000, 0.9);
  assert.equal(tracker.isOverlapping(), true, 'agent-keeps waits for speech-end');
  tracker.noteUserSpeechEnd(1200);
  assert.equal(tracker.getStats(1200).backchannels, 1);
  assert.equal(tracker.getStats(1200).agentKeeps, 1);
  assert.ok(events.some((e) => e.kind === 'backchannel'));
  // Sustained confident speech hands the floor to the user.
  tracker.noteUserSpeechStart(2000, 0.9);
  tracker.noteUserSpeechEnd(2600);
  assert.equal(tracker.getStats(2600).userWins, 1);
  assert.equal(tracker.getStats(2600).overlaps, 2);
  assert.equal(tracker.getStats(2600).totalOverlapMs, 800);
  assert.equal(tracker.getStats(2600).meanOverlapMs, 400);
  assert.equal(tracker.getStats(2600).maxOverlapMs, 600);
  // Low confidence never wins under agent-keeps.
  const tracker2 = new OverlapTrackerV12({ policy: 'agent-keeps', minConfidence: 0.9 });
  tracker2.noteAgentSpeaking('Hello world.', 0);
  tracker2.noteUserSpeechStart(1000, 0.5);
  tracker2.noteUserSpeechEnd(2000);
  assert.equal(tracker2.getStats(2000).agentKeeps, 1);
});

// ---------------------------------------------------------------------------
// 6. Session v12
// ---------------------------------------------------------------------------

test('session v12: connect, user turn, auto mock reply, planned chunks, drain back to listening', async () => {
  const events = [];
  const session = createMockVoiceSessionV12({ sessionId: 'v12-s1', language: 'vi' }, (e) => events.push(e));
  await session.connect();
  assert.equal(session.getStatus(), 'listening');
  assert.equal(session.getTurnMachine().getState(), 'listening');
  feedSessionScript(session, [{ label: 'silence', durationMs: 600 }]);
  assert.equal(session.getInner().getVad().isCalibrated(), true);
  feedSessionScript(session, [{ label: 'speech', durationMs: 600, amplitude: 0.25 }]);
  assert.equal(session.getInner().getTurnTaking().getFloor(), 'user');
  feedSessionScript(session, [{ label: 'silence', durationMs: 1200 }]);
  assert.equal(session.getStatus(), 'speaking');
  assert.equal(session.getStats().replies, 1);
  assert.ok(session.getStats().tts.chunks >= 1, 'reply chunked into the TTS stream');
  const plan = session.getLastPlan();
  assert.ok(plan.length >= 1, 'reply planned with word timings');
  assert.ok(plan.every((c) => c.wordTimings.length > 0), 'every planned chunk has word timings');
  assert.ok(events.some((e) => e.kind === 'v11' && e.event.kind === 'reply-started'));
  assert.ok(events.some((e) => e.kind === 'state' && e.state === 'speaking'));
  session.tick(8000);
  assert.equal(session.getStatus(), 'listening');
  assert.equal(session.getStats().agentTurns, 1);
  assert.equal(session.getStats().userTurns, 1);
  assert.ok(session.getSummary().includes('listening'));
  assert.ok(voiceSessionV12Summary(session.getStats()).includes('v12-s1'));
  assert.ok(voiceSessionV12Markdown(session.getStats()).includes('# Voice session v12'));
  assert.ok(session.transcriptMarkdown().includes('## Turn machine v12'));
  assert.ok(session.transcriptMarkdown().includes('## Overlap v12'));
  session.disconnect();
  assert.equal(session.getStatus(), 'closed');
  assert.equal(session.getTurnMachine().getState(), 'idle');
  assert.throws(() => new RealtimeVoiceSessionV12({ sessionId: 'bad id!' }), /slug/);
});

test('session v12: barge-in over real audio records interrupt context and resumeReply speaks the remainder', async () => {
  const events = [];
  const reply = 'Hello mock reply one two three four five six seven eight nine ten eleven twelve.';
  const session = createMockVoiceSessionV12(
    { sessionId: 'v12-s2', mockReplies: [reply] },
    (e) => events.push(e),
  );
  await session.connect();
  feedSessionScript(session, [{ label: 'silence', durationMs: 600 }]);
  const started = await session.simulateTurn('xin chào', reply);
  assert.equal(started, true);
  assert.equal(session.getStatus(), 'speaking');
  session.tick(300);
  // The user barges in: keep talking until the smart policy cuts.
  feedSessionScript(session, [{ label: 'speech', durationMs: 800, amplitude: 0.25 }]);
  const stats = session.getStats();
  assert.equal(stats.repliesCut, 1, `repliesCut ${stats.repliesCut}, state ${stats.state}`);
  assert.ok(stats.interrupts >= 1);
  const last = session.getLastInterrupt();
  assert.ok(last !== null, 'interrupt context recorded');
  assert.equal(last.replyText, reply);
  assert.ok(last.cutWord.length > 0, `cut word "${last.cutWord}"`);
  assert.ok(last.remainingText.length > 0, 'unfinished sentence kept');
  assert.ok(last.playedText.length >= 0);
  assert.ok(last.resumePrompt.includes(last.cutWord));
  assert.ok(['continue', 'restart', 'summarize', 'drop'].includes(last.resumeStrategy));
  assert.ok(stats.overlap.overlaps >= 1, 'the overlap was recorded');
  assert.ok(stats.bargeInV12.interrupts >= 1);
  assert.ok(events.some((e) => e.kind === 'barge-in-v12' && e.event.kind === 'interrupt-recorded'));
  assert.ok(events.some((e) => e.kind === 'overlap'));
  // Cooldown returns the machine to listening.
  session.tick(3000);
  assert.equal(session.getStatus(), 'listening');
  assert.equal(session.getTurnMachine().getState(), 'listening');
  // Resume the unfinished reply under its recorded strategy.
  const resumed = session.resumeReply();
  assert.equal(resumed, true, `resume strategy ${last.resumeStrategy}`);
  assert.equal(session.getStatus(), 'speaking');
  assert.equal(session.getStats().resumes, 1);
  assert.ok(events.some((e) => e.kind === 'reply-resumed'));
  session.tick(20000);
  assert.equal(session.getStatus(), 'listening');
  // Nothing left to resume a second time without a new interrupt.
  session.disconnect();
});

test('session v12: drop strategy resumes nothing, user words feed the context', async () => {
  const session = createMockVoiceSessionV12(
    { sessionId: 'v12-s3', mockReplies: ['Hello mock reply one two three four five six seven eight.'] },
    null,
  );
  await session.connect();
  feedSessionScript(session, [{ label: 'silence', durationMs: 600 }]);
  await session.simulateTurn('xin chào', 'Hello mock reply one two three four five six seven eight.');
  assert.equal(session.getStatus(), 'speaking');
  // Feed the interruption words before cutting (partial STT).
  session.noteUserWord('Khoan,', undefined, 0.95);
  session.noteUserWord('chỉ', undefined, 0.9);
  session.noteUserWord('họp', undefined, 0.9);
  session.noteUserWord('với', undefined, 0.9);
  session.noteUserWord('Lan', undefined, 0.95);
  session.noteUserWord('thôi', undefined, 0.9);
  const result = session.interrupt('user');
  assert.ok(result !== null && result.interrupted);
  const last = session.getLastInterrupt();
  assert.ok(last !== null);
  assert.equal(last.userInterruption.text, 'Khoan, chỉ họp với Lan thôi');
  assert.equal(last.resumeStrategy, 'drop', 'a new question drops the old reply');
  assert.equal(session.resumeReply(), false, 'drop resumes nothing');
  assert.equal(session.getStats().drops, 1);
  // Overriding to continue speaks the remainder.
  session.tick(3000);
  assert.equal(session.getStatus(), 'listening');
  assert.equal(session.resumeReply('continue'), true);
  assert.equal(session.getStatus(), 'speaking');
  assert.equal(session.getStats().resumes, 1);
  session.disconnect();
});

test('session v12: end-of-turn decisions fire on the virtual clock; manager registry works', async () => {
  const decisions = [];
  const session = createMockVoiceSessionV12(
    { sessionId: 'v12-s4', autoReply: false },
    (e) => { if (e.kind === 'end-of-turn') decisions.push(e.decision); },
  );
  await session.connect();
  feedSessionScript(session, [{ label: 'silence', durationMs: 600 }]);
  feedSessionScript(session, [{ label: 'speech', durationMs: 600, amplitude: 0.25 }]);
  feedSessionScript(session, [{ label: 'silence', durationMs: 1200 }]);
  // The detector fires turn-ended after the trailing silence.
  session.tick(1000);
  assert.ok(decisions.some((d) => d.kind === 'turn-ended'), `decisions: ${JSON.stringify(decisions)}`);
  assert.equal(session.getStats().endOfTurn.turns, 1);
  assert.equal(session.getVolume(), 1, 'full volume while nobody overlaps');
  session.disconnect();

  const manager = new VoiceV12Manager();
  const created = manager.create({ sessionId: 'm12', connectNow: false });
  assert.equal(manager.size(), 1);
  assert.equal(manager.get('m12'), created);
  assert.deepEqual(manager.ids(), ['m12']);
  assert.throws(() => manager.create({ sessionId: 'm12' }), /already exists/);
  await created.connect();
  assert.equal(created.interrupt(), null, 'nothing to interrupt while listening');
  await created.simulateTurn('hi', 'One two three four five six seven eight nine ten.');
  assert.equal(created.getStatus(), 'speaking');
  assert.ok(created.getLastPlan().length >= 1);
  assert.equal(created.duck(), true);
  // v12 has no `ducked` turn state: the inner v11 machine ducks
  // while the v12 turn machine stays `speaking`.
  assert.equal(created.getInner().getStatus(), 'ducked');
  assert.equal(created.getStatus(), 'speaking');
  assert.equal(created.resumePlayback(), true);
  assert.equal(created.getInner().getStatus(), 'speaking');
  const cut = created.interrupt('user');
  assert.ok(cut !== null && cut.interrupted);
  assert.equal(created.getStatus(), 'interrupted');
  assert.ok(created.getLastInterrupt() !== null);
  created.tick(3000);
  assert.equal(created.getStatus(), 'listening');
  assert.equal(manager.remove('m12'), true);
  assert.equal(manager.size(), 0);
  assert.equal(manager.remove('m12'), false);
});

// ---------------------------------------------------------------------------
// 7. Voice v12 tools
// ---------------------------------------------------------------------------

test('voice v12 tools: 8 tools, unique names, placeholder refuses, full lifecycle on a real manager', async () => {
  assert.equal(VOICE_V12_TOOL_NAMES.length, 8);
  assert.equal(new Set(VOICE_V12_TOOL_NAMES).size, 8);
  assert.equal(VOICE_V12_TOOLS.length, 8);
  assert.deepEqual(VOICE_V12_TOOLS.map((t) => t.definition.name), [...VOICE_V12_TOOL_NAMES]);
  assert.equal(isVoiceV12ToolName('voice_v12_session_create'), true);
  assert.equal(isVoiceV12ToolName('voice_v11_session_create'), false);
  // Wired into the central registry by the coordinator at merge time
  // (merge/v113 fix round 1: ...VOICE_V12_TOOLS in ALL_TOOLS).
  assert.ok(ALL_TOOLS.some((t) => t.definition.name.startsWith('voice_v12_')), 'v12 tools are wired into ALL_TOOLS by the coordinator');
  // Placeholder (no manager) refuses.
  const placeholder = createVoiceV12Tools();
  const byName = new Map(placeholder.map((t) => [t.definition.name, t]));
  const refused = await byName.get('voice_v12_session_list').execute({});
  assert.match(refused, /not available/);

  const manager = new VoiceV12Manager();
  const tools = createVoiceV12Tools({ getManager: () => manager });
  const bound = new Map(tools.map((t) => [t.definition.name, t]));
  const run = async (name, args) => JSON.parse(await bound.get(name).execute(args));

  const created = await run('voice_v12_session_create', {
    sessionId: 't12', language: 'vi', overlapPolicy: 'user-wins', mockReply: 'Hello tool reply one two three.', connect: true,
  });
  assert.equal(created.created, true);
  assert.match(created.summary, /listening/);
  assert.equal(manager.size(), 1);
  const bad = await bound.get('voice_v12_session_create').execute({ sessionId: 't12b', overlapPolicy: 'nope' });
  assert.match(bad, /Unknown overlap v12 policy/);

  const listed = await run('voice_v12_session_list', {});
  assert.equal(listed.count, 1);
  assert.equal(listed.sessions[0].sessionId, 't12');
  assert.equal(listed.sessions[0].status, 'listening');

  const session = manager.get('t12');
  await session.simulateTurn('hi', 'Hello tool reply one two three four five six seven eight.');
  assert.equal(session.getStatus(), 'speaking');
  const turnStatus = await run('voice_v12_turn_status', { sessionId: 't12' });
  assert.equal(turnStatus.status, 'speaking');
  assert.equal(turnStatus.turnMachine.state, 'speaking');
  assert.ok(Array.isArray(turnStatus.plannedChunks) && turnStatus.plannedChunks.length >= 1);
  assert.ok(turnStatus.plannedChunks[0].wordTimings.length > 0, 'planned chunks carry word timings');

  const cut = session.interrupt('user');
  assert.ok(cut !== null && cut.interrupted);
  const ctx = await run('voice_v12_interrupt_context', { sessionId: 't12' });
  assert.ok(ctx.interrupt !== undefined);
  assert.equal(ctx.interrupt.replyText, 'Hello tool reply one two three four five six seven eight.');
  assert.ok(ctx.interrupt.resumePrompt.length > 0);
  const overlap = await run('voice_v12_overlap_report', { sessionId: 't12' });
  assert.equal(typeof overlap.volume, 'number');
  session.tick(3000);
  const resumed = await run('voice_v12_interrupt_context', { sessionId: 't12', resume: true });
  assert.equal(resumed.resumed, true);
  const stats = await run('voice_v12_session_stats', { sessionId: 't12' });
  assert.equal(stats.stats.resumes, 1);
  assert.ok(stats.stats.turnMachine !== undefined);
  assert.ok(stats.stats.overlap !== undefined);
  const stopped = await run('voice_v12_session_stop', { sessionId: 't12' });
  assert.equal(stopped.stopped, true);
  assert.equal(stopped.status, 'closed');
  const deleted = await run('voice_v12_session_delete', { sessionId: 't12' });
  assert.equal(deleted.deleted, true);
  assert.equal(deleted.remaining, 0);
  const unknown = await bound.get('voice_v12_session_stats').execute({ sessionId: 'nope' });
  assert.match(unknown, /Unknown voice v12 session/);
});

// ---------------------------------------------------------------------------
// 8. Renderer-local view models
// ---------------------------------------------------------------------------

test('voice v12 view: row parsing, overlap rows, interrupt card, planned chunks, formatters', () => {
  assert.equal(parseVoiceV12Status('speaking'), 'speaking');
  assert.equal(parseVoiceV12Status('nope'), 'idle');
  assert.equal(parseVoiceV12ResumeStrategy('summarize'), 'summarize');
  assert.equal(parseVoiceV12ResumeStrategy('nope'), 'drop');
  assert.equal(parseVoiceV12OverlapPolicy('confirm'), 'confirm');
  assert.equal(parseVoiceV12OverlapPolicy('nope'), 'user-wins');
  assert.equal(voiceV12StatusKey('interrupted'), 'voice.realtime.v12.status.interrupted');
  assert.equal(voiceV12ResumeStrategyKey('restart'), 'voice.realtime.v12.resume.restart');
  assert.equal(voiceV12OverlapWinnerKey('user'), 'voice.realtime.v12.overlap.user');

  const row = parseVoiceSessionV12Row({
    sessionId: 'v1', status: 'speaking', botId: 'b1', language: 'vi', connected: true,
    stats: { nowMs: 5000, turns: 3, userTurns: 2, agentTurns: 1, interrupts: 1, resumes: 1, drops: 0, overlap: { overlaps: 2, volume: 0.35 } },
  });
  assert.equal(row.id, 'v1');
  assert.equal(row.status, 'speaking');
  assert.equal(row.turns, 3);
  assert.equal(row.overlaps, 2);
  assert.equal(row.volume, 0.35);
  assert.deepEqual(parseVoiceSessionV12Row(null).status, 'idle');

  const machine = parseVoiceV12TurnMachine({ state: 'thinking', turns: 2, thinkingTimeouts: 1 });
  assert.equal(machine.state, 'thinking');
  assert.equal(machine.thinkingTimeouts, 1);
  const eot = parseVoiceV12EndOfTurn({ turns: 2, backchannels: 1, falseStarts: 0, merged: 1, speaking: true });
  assert.equal(eot.merged, 1);
  assert.equal(eot.speaking, true);
  const overlap = parseVoiceV12Overlap({ overlaps: 2, userWins: 1, agentKeeps: 1, volume: 0.35 });
  assert.equal(overlap.volumePct, 35);
  const overlapRow = parseVoiceV12OverlapRow({
    id: 3, startedAtMs: 1000, endedAtMs: 1420, durationMs: 420, winner: 'user',
    resolutionReason: 'user-wins policy', agentWordsLost: ['two', 'three'], userWords: ['Khoan'], minVolume: 0.35,
  });
  assert.equal(overlapRow.label, '#3 · 420 ms · user');
  assert.equal(overlapRow.duckDepthPct, 65);
  assert.deepEqual(parseVoiceV12OverlapRows([{ id: 1 }]).length, 1);
  assert.deepEqual(parseVoiceV12OverlapRows('nope'), []);

  const ctx = parseVoiceV12InterruptContext({
    id: 1, atMs: 600, cutWord: 'ba', cutWordIndex: 9, playedText: 'Để tôi kiểm tra',
    remainingText: 'ba cuộc họp.', playedMs: 400, discardedMs: 800, wasThinking: false, latencyMs: 250,
    userInterruption: { text: 'Khoan đã', confidence: 0.9 },
    resumeStrategy: 'continue', resumeReason: 'short remainder', resumeText: 'ba cuộc họp.',
    resumePrompt: 'Resume…', ttsChunksCancelled: 2, ttsCharsDiscarded: 12,
  });
  assert.ok(ctx !== null);
  assert.equal(ctx.cutWord, 'ba');
  assert.equal(ctx.userText, 'Khoan đã');
  assert.equal(ctx.resumeStrategy, 'continue');
  assert.equal(parseVoiceV12InterruptContext({}), null);
  assert.equal(parseVoiceV12InterruptContext(null), null);

  const chunks = parseVoiceV12PlannedChunkRows([
    { id: 1, text: 'Xin chào bạn.', estDurationMs: 600, urgent: false, pacingFactor: 1,
      wordTimings: [{ word: 'Xin', startMs: 0, endMs: 165 }, { word: 'chào', startMs: 165, endMs: 385 }, { word: 'bạn.', startMs: 385, endMs: 605 }],
      prosody: [{ afterCharIndex: 8, mark: ',', pauseMs: 120 }] },
  ], 200);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].currentWord, 'chào');
  assert.equal(chunks[0].words.length, 3);
  assert.equal(chunks[0].pauses.length, 1);
  assert.deepEqual(parseVoiceV12PlannedChunkRows('nope'), []);
  assert.equal(parseVoiceV12PlannedChunkRows([{ id: 1, text: 'Hi.', wordTimings: [{ word: 'Hi.', startMs: 0, endMs: 100 }] }], 500)[0].currentWord, '');

  assert.equal(formatVoiceV12Duration(340), '340 ms');
  assert.equal(formatVoiceV12Duration(1500), '1,5s');
  assert.equal(formatVoiceV12Duration(-5), '0 ms');
  assert.equal(formatVoiceV12Volume(0.35), '35%');
  assert.equal(formatVoiceV12Volume(2), '100%');
  assert.deepEqual(voiceV12SummaryLines({ state: 'speaking', turns: 3, interrupts: 1, overlaps: 2, resumes: 1 }).length, 5);
});

// ---------------------------------------------------------------------------
// 9. i18n
// ---------------------------------------------------------------------------

test('i18n v12: 40 voice.realtime.v12.* keys in all 6 locales, non-empty, same key set', () => {
  const locales = ['vi', 'en', 'zh', 'ja', 'es', 'fr'];
  const sets = locales.map((loc) => {
    const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps/desktop/src/renderer/i18n/locales', `${loc}.json`), 'utf8'));
    const keys = Object.keys(data).filter((k) => k.startsWith('voice.realtime.v12.'));
    assert.equal(keys.length, 40, `${loc}: expected 40 v12 keys, got ${keys.length}`);
    for (const key of keys) {
      assert.equal(typeof data[key], 'string', `${loc} ${key} must be a string`);
      assert.ok(data[key].length > 0, `${loc} ${key} must be non-empty`);
    }
    return new Set(keys);
  });
  for (let i = 1; i < sets.length; i += 1) {
    assert.deepEqual([...sets[i]].sort(), [...sets[0]].sort(), `${locales[i]} key set differs from vi`);
  }
  // Every key the panel + view reference exists.
  const vi = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps/desktop/src/renderer/i18n/locales/vi.json'), 'utf8'));
  for (const key of [
    'voice.realtime.v12.title', 'voice.realtime.v12.subtitle',
    'voice.realtime.v12.status.listening', 'voice.realtime.v12.status.interrupted',
    'voice.realtime.v12.resume.continue', 'voice.realtime.v12.resume.drop',
    'voice.realtime.v12.overlap.user', 'voice.realtime.v12.cutAt', 'voice.realtime.v12.resumeReply',
  ]) {
    assert.ok(key in vi, `missing ${key}`);
  }
});

// ---------------------------------------------------------------------------
// 10. Core root re-exports
// ---------------------------------------------------------------------------

test('core root: v12 classes are importable from @open-bot/core', () => {
  assert.equal(typeof RootInterruptContextV12, 'function');
  assert.equal(typeof RootTtsStreamV12, 'function');
  assert.equal(typeof RootTurnMachineV12, 'function');
  assert.equal(typeof RootEndOfTurnDetectorV12, 'function');
  assert.equal(typeof RootOverlapTrackerV12, 'function');
  assert.equal(typeof RootSessionV12, 'function');
  assert.equal(typeof RootManagerV12, 'function');
  assert.equal(new RootTurnMachineV12().getState(), 'idle');
  assert.equal(new RootEndOfTurnDetectorV12().getStats(0).turns, 0);
});
