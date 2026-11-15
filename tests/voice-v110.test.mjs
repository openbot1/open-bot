/**
 * Tests for v1.10 — voice realtime v9 (Team T5).
 *
 *   1. VAD v9 (vadV9.ts): energy + ZCR, adaptive floor, presets,
 *      speech start/end, dynamic hangover, backchannel, false
 *      start, live reconfigure, invalid frames rejected.
 *   2. Barge-in v9 (bargeInV9.ts): immediate/grace/confirm
 *      policies, cooldown, echo guard, duck/resume, exact cut
 *      receipt, interrupt while thinking.
 *   3. Transcript stream v9 (transcriptStreamV9.ts): partials,
 *      commit, speaker change finalises, tool-call attach, cap,
 *      markdown.
 *   4. Session v9 (voiceSessionV9.ts) on the mock model: connect →
 *      listening, VAD-driven turn (feedAudio), scripted turn,
 *      tool call mid-speech, barge-in keeps the cut point, PTT,
 *      live-key probe gate (no key read, no dial).
 *   5. Store v9 (voiceSessionV9Store.ts): save/load, checksum +
 *      quarantine, prune, resume instructions, markdown.
 *   6. Voice v9 tools (packages/tools/src/voiceV9Tools.ts): 10
 *      tools, unique names, placeholder refuses, full lifecycle
 *      through the tools on a real manager (mock sessions).
 *   7. Renderer-local view models (voiceSessionV9View.ts): row
 *      parsing, VAD/barge-in views, transcript rows, waveform
 *      bars, PTT view.
 *   8. i18n: 73 voice.v9.* keys in all 6 locales, non-empty.
 *
 * No network, no sound card, no live provider. Run after building
 * the core + tools packages:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/voice-v110.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MockVadV9,
  createVadV9,
  defaultVadV9Options,
  validateVadV9Options,
  isVadV9PresetName,
  vadV9Summary,
  VAD_V9_PRESETS,
} from '../packages/core/dist/voice/vadV9.js';
import {
  BargeInV9Controller,
  splitWordsV9,
  validateBargeInV9Options,
  bargeInV9Summary,
} from '../packages/core/dist/voice/bargeInV9.js';
import {
  TranscriptStreamV9,
  transcriptV9LiveText,
  transcriptV9Markdown,
  transcriptV9Summary,
} from '../packages/core/dist/voice/transcriptStreamV9.js';
import {
  RealtimeVoiceSessionV9,
  VoiceV9Manager,
  createMockVoiceSessionV9,
  probeLiveVoiceV9Key,
  VOICE_V9_DEFAULT_MOCK_REPLY,
} from '../packages/core/dist/voice/voiceSessionV9.js';
import {
  VoiceSessionV9Store,
  voiceSessionV9SnapshotPath,
  createVoiceSessionV9Snapshot,
  validateVoiceSessionV9Snapshot,
  buildVoiceSessionV9ResumeInstructions,
  voiceSessionV9SnapshotMarkdown,
  VOICE_SESSION_V9_STORE_VERSION,
} from '../packages/core/dist/voice/voiceSessionV9Store.js';
import {
  createVoiceV9Tools,
  VOICE_V9_TOOLS,
  VOICE_V9_TOOL_NAMES,
  isVoiceV9ToolName,
} from '../packages/tools/dist/voiceV9Tools.js';
import {
  toVoiceSessionV9RowView,
  toVoiceSessionV9RowViews,
  toVoiceV9VadView,
  toVoiceV9BargeInView,
  toVoiceV9TranscriptRows,
  waveformBarsV9,
  appendWaveformLevelV9,
  pttViewV9,
  voiceV9StatusLabelKey,
  voiceV9StatusSummary,
  formatVoiceV9Duration,
  formatVoiceV9AudioMs,
} from '../apps/desktop/src/renderer/voice/voiceSessionV9View.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SAMPLE_RATE = 16000;
const WINDOW_SAMPLES = 320; // 20 ms at 16 kHz

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** PCM16 frame of a sine at `freqHz`, amplitude 0..1 (deterministic). */
function sineFrame(freqHz, amplitude = 0.3, samples = WINDOW_SAMPLES) {
  const buf = new Uint8Array(samples * 2);
  for (let i = 0; i < samples; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * freqHz * i) / SAMPLE_RATE) * amplitude * 32767);
    buf[i * 2] = v & 0xff;
    buf[i * 2 + 1] = (v >> 8) & 0xff;
  }
  return buf;
}

/** Silence frame (all zeros). */
function silenceFrame(samples = WINDOW_SAMPLES) {
  return new Uint8Array(samples * 2);
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

const V110_VOICE_KEYS = [
  'voice.v9.status.idle',
  'voice.v9.status.listening',
  'voice.v9.status.speaking',
  'voice.v9.status.processing',
  'voice.v9.inputMode.auto',
  'voice.v9.inputMode.push-to-talk',
  'voice.v9.ptt.press',
  'voice.v9.ptt.release',
  'voice.v9.ptt.auto',
  'voice.v9.vad.speechStart',
  'voice.v9.vad.speechEnd',
  'voice.v9.vad.backchannel',
  'voice.v9.vad.falseStart',
  'voice.v9.bargeIn.interrupted',
  'voice.v9.bargeIn.ducked',
  'voice.v9.bargeIn.cooldown',
  'voice.v9.bargeIn.echoOnly',
  'voice.v9.live.available',
  'voice.v9.live.unavailable',
  'voice.v9.live.noKey',
  'voice.v9.turn.user',
  'voice.v9.turn.agent',
  'voice.v9.turn.toolCall',
  'voice.v9.session.created',
  'voice.v9.session.stopped',
  'voice.v9.session.deleted',
];

// ---------------------------------------------------------------- VAD v9

test('vad v9: presets validate, defaults are office', () => {
  assert.equal(isVadV9PresetName('quiet'), true);
  assert.equal(isVadV9PresetName('loud'), false);
  assert.equal(defaultVadV9Options().preset, 'office');
  assert.deepEqual(Object.keys(VAD_V9_PRESETS).sort(), ['noisy', 'office', 'quiet']);
  assert.throws(() => validateVadV9Options({ preset: 'loud' }), /preset/);
  assert.throws(() => validateVadV9Options({ startRatio: 0.5 }), /startRatio/);
  assert.throws(() => validateVadV9Options({ hangoverMs: -1 }), /hangoverMs/);
});

test('vad v9: silence stays silent, speech starts and ends with hangover', () => {
  const events = [];
  const vad = new MockVadV9({ preset: 'quiet' }, (e) => events.push(e));
  for (let i = 0; i < 10; i++) assert.equal(vad.feed(silenceFrame()), false);
  assert.equal(vad.isSpeaking(), false);
  // 30 loud frames = 600 ms of speech.
  for (let i = 0; i < 30; i++) vad.feed(sineFrame(440));
  assert.equal(vad.isSpeaking(), true);
  assert.equal(events.filter((e) => e.kind === 'speech-start').length, 1);
  // Hangover is 350 ms = 18 frames of silence before speech-end.
  for (let i = 0; i < 17; i++) vad.feed(silenceFrame());
  assert.equal(vad.isSpeaking(), true);
  vad.feed(silenceFrame());
  assert.equal(vad.isSpeaking(), false);
  const end = events.find((e) => e.kind === 'speech-end');
  assert.ok(end, 'speech-end fired');
  assert.equal(end.durationMs, 600);
  const stats = vad.getStats();
  assert.equal(stats.turns, 1);
  assert.equal(stats.speechMs, 600);
  assert.ok(vadV9Summary(stats).includes('1 turns'));
});

test('vad v9: short burst is a backchannel, not a turn', () => {
  const events = [];
  const vad = new MockVadV9({ preset: 'quiet' }, (e) => events.push(e));
  for (let i = 0; i < 5; i++) vad.feed(silenceFrame());
  for (let i = 0; i < 3; i++) vad.feed(sineFrame(440)); // 60 ms burst
  assert.equal(vad.isSpeaking(), false);
  vad.feed(silenceFrame());
  assert.equal(events.filter((e) => e.kind === 'backchannel').length, 1);
  assert.equal(events.filter((e) => e.kind === 'speech-start').length, 0);
  assert.equal(vad.getStats().backchannels, 1);
  assert.equal(vad.getStats().turns, 0);
});

test('vad v9: long confident turn ends faster (dynamic hangover)', () => {
  const events = [];
  const vad = new MockVadV9({ preset: 'quiet' }, (e) => events.push(e));
  for (let i = 0; i < 5; i++) vad.feed(silenceFrame());
  for (let i = 0; i < 150; i++) vad.feed(sineFrame(440)); // 3 s of speech
  assert.equal(vad.isSpeaking(), true);
  // Dynamic hangover: max(120, 350*0.6=210) = 210 ms = 11 frames.
  for (let i = 0; i < 10; i++) vad.feed(silenceFrame());
  assert.equal(vad.isSpeaking(), true);
  vad.feed(silenceFrame());
  assert.equal(vad.isSpeaking(), false);
  assert.equal(events.filter((e) => e.kind === 'speech-end').length, 1);
});

test('vad v9: invalid frames rejected, live reconfigure works', () => {
  const vad = createVadV9('office');
  assert.throws(() => vad.feed(new Uint8Array(10)), /20 ms PCM16/);
  assert.throws(() => vad.feed(new Uint8Array(640 * 2)), /20 ms PCM16/);
  const next = vad.reconfigure({ preset: 'noisy' });
  assert.equal(next.preset, 'noisy');
  assert.equal(next.startRatio, VAD_V9_PRESETS.noisy.startRatio);
  assert.throws(() => vad.reconfigure({ preset: 'loud' }), /preset/);
  vad.reset();
  assert.equal(vad.getStats().frames, 0);
  assert.equal(vad.isSpeaking(), false);
});

// ------------------------------------------------------------- barge-in v9

test('barge-in v9: grace policy waits, then interrupts with an exact receipt', () => {
  const events = [];
  const ctrl = new BargeInV9Controller({ policy: 'grace', graceMs: 300, cooldownMs: 1500 }, (e) => events.push(e));
  ctrl.beginSpeaking(splitWordsV9('hello world test', 600));
  ctrl.advancePlayed(250);
  const first = ctrl.decideSpeechStart({ nowMs: 1000, speechMs: 200 });
  assert.equal(first.interrupt, false);
  assert.equal(first.reason, 'grace-expired');
  assert.equal(first.graceRemainingMs, 300);
  const second = ctrl.decideSpeechStart({ nowMs: 1300, speechMs: 500 });
  assert.equal(second.interrupt, true);
  const receipt = ctrl.interrupt(1300);
  assert.equal(receipt.interrupted, true);
  assert.equal(receipt.cutWord, 'world');
  assert.equal(receipt.cutWordIndex, 1);
  assert.deepEqual(receipt.wordsPlayed, ['hello']);
  assert.deepEqual(receipt.wordsDiscarded, ['world', 'test']);
  assert.equal(receipt.playedMs, 250);
  assert.equal(receipt.discardedMs, 350);
  assert.equal(receipt.wasThinking, false);
  assert.equal(events.filter((e) => e.kind === 'interrupt').length, 1);
});

test('barge-in v9: immediate interrupts at once, confirm never auto-interrupts', () => {
  const now = new BargeInV9Controller({ policy: 'immediate' });
  now.beginSpeaking(splitWordsV9('one two three', 300));
  assert.equal(now.decideSpeechStart({ nowMs: 100, speechMs: 200 }).interrupt, true);
  const confirm = new BargeInV9Controller({ policy: 'confirm' });
  confirm.beginSpeaking(splitWordsV9('one two three', 300));
  assert.deepEqual(confirm.decideSpeechStart({ nowMs: 100, speechMs: 200 }), {
    interrupt: false,
    reason: 'policy-confirm',
  });
  // ...but an explicit interrupt still cuts in.
  const receipt = confirm.interrupt(200);
  assert.equal(receipt.interrupted, true);
  assert.equal(receipt.cutWord, 'one');
});

test('barge-in v9: cooldown, echo guard, too-short speech, not-speaking', () => {
  const ctrl = new BargeInV9Controller({ policy: 'immediate', cooldownMs: 1500, minSpeechMs: 150 });
  ctrl.beginSpeaking(splitWordsV9('alpha beta', 400));
  ctrl.interrupt(1000);
  // After the interrupt the reply is gone: a new speech-start is a
  // new turn, not a barge-in attempt.
  assert.equal(ctrl.decideSpeechStart({ nowMs: 1200, speechMs: 500 }).reason, 'not-speaking');
  // A new reply starts; inside the cooldown a barge-in is ignored.
  ctrl.beginSpeaking(splitWordsV9('gamma delta', 400));
  const cooled = ctrl.decideSpeechStart({ nowMs: 1200, speechMs: 500 });
  assert.equal(cooled.reason, 'ignored-cooldown');
  assert.equal(cooled.cooldownRemainingMs, 1300);
  assert.equal(ctrl.getStats().ignoredCooldown, 1);
  // After the cooldown the same speech interrupts again.
  assert.equal(ctrl.decideSpeechStart({ nowMs: 2600, speechMs: 500 }).interrupt, true);
  assert.equal(ctrl.decideSpeechStart({ nowMs: 3000, speechMs: 500, echoOnly: true }).reason, 'ignored-echo');
  assert.equal(ctrl.decideSpeechStart({ nowMs: 3000, speechMs: 50 }).reason, 'ignored-too-short');
  const idle = new BargeInV9Controller({ policy: 'immediate' });
  assert.equal(idle.decideSpeechStart({ nowMs: 0, speechMs: 500 }).reason, 'not-speaking');
  assert.equal(idle.interrupt(0).interrupted, false);
});

test('barge-in v9: interrupt while thinking, duck and resume', () => {
  const ctrl = new BargeInV9Controller({ policy: 'grace' });
  ctrl.beginThinking();
  const receipt = ctrl.interrupt(500);
  assert.equal(receipt.interrupted, true);
  assert.equal(receipt.wasThinking, true);
  assert.equal(receipt.cutWord, '');
  assert.equal(receipt.playedMs, 0);
  assert.equal(receipt.discardedMs, 0);

  const speaking = new BargeInV9Controller({ policy: 'grace' });
  speaking.beginSpeaking(splitWordsV9('duck test', 400));
  assert.equal(speaking.duck(100), true);
  assert.equal(speaking.isDucked(), true);
  assert.equal(speaking.duck(110), false, 'second duck is a no-op');
  assert.equal(speaking.resume(200), true);
  assert.equal(speaking.isDucked(), false);
  assert.equal(speaking.resume(210), false);
  speaking.finishSpeaking();
  assert.equal(speaking.duck(300), false, 'cannot duck when not speaking');
  assert.ok(bargeInV9Summary(speaking.getStats()).includes('1 ducks'));
});

test('barge-in v9: options validate, words split evenly', () => {
  assert.throws(() => validateBargeInV9Options({ policy: 'loud' }), /policy/);
  assert.throws(() => validateBargeInV9Options({ duckFactor: 2 }), /duckFactor/);
  const words = splitWordsV9('a b c', 301);
  assert.deepEqual(words.map((w) => w.durationMs), [100, 100, 101]);
  assert.deepEqual(splitWordsV9('  ', 100), []);
});

// ------------------------------------------------------- transcript stream v9

test('transcript v9: partials stream, commit finalises, speaker change finalises', () => {
  const stream = new TranscriptStreamV9();
  assert.equal(stream.pushPartial('xin', { speakerId: 'user', atMs: 0 }), 'xin');
  assert.equal(stream.pushPartial('xin chào', { speakerId: 'user', atMs: 100 }), 'xin chào');
  assert.equal(stream.pushPartial('xin chào bạn', { speakerId: 'user', atMs: 200 }), 'xin chào bạn');
  assert.equal(stream.hasInterim(), true);
  assert.ok(transcriptV9LiveText(stream).includes('xin chào bạn …'));
  const turn = stream.commit({ atMs: 300 });
  assert.ok(turn);
  assert.equal(turn.text, 'xin chào bạn');
  assert.deepEqual(turn.partials, ['xin', 'xin chào', 'xin chào bạn']);
  assert.equal(stream.hasInterim(), false);
  assert.equal(stream.commit({ atMs: 400 }), null, 'second commit is a no-op');

  // A partial from another speaker commits the first speaker's text.
  stream.pushPartial('hello', { speakerId: 'user', atMs: 500 });
  stream.pushPartial('hi there', { speakerId: 'agent', atMs: 600 });
  assert.equal(stream.getTurns().length, 2);
  assert.equal(stream.getTurns()[1].speakerId, 'user');
  assert.equal(stream.getTurns()[1].text, 'hello');
  assert.ok(transcriptV9Markdown(stream).includes('**user**'));
  assert.ok(transcriptV9Summary(stream.getStats()).includes('2 turns'));
});

test('transcript v9: final turns, tool-call attach, cap drops oldest', () => {
  const stream = new TranscriptStreamV9({ maxTurns: 2 });
  stream.noteFinal('one', { speakerId: 'user', atMs: 0 });
  stream.noteFinal('two', { speakerId: 'agent', atMs: 100 });
  assert.equal(stream.attachToolCall({ name: 'echo', args: { text: 'hi' }, ok: true, atMs: 150 }), true);
  assert.equal(stream.getTurns()[1].toolCalls.length, 1);
  stream.noteFinal('three', { speakerId: 'user', atMs: 200 });
  assert.equal(stream.getTurns().length, 2);
  assert.equal(stream.getTurns()[0].text, 'two');
  assert.equal(stream.getStats().droppedTurns, 1);
  assert.throws(() => stream.noteFinal('  ', { atMs: 300 }), /non-empty/);
  assert.throws(() => new TranscriptStreamV9({ maxTurns: 0 }), /maxTurns/);
  const empty = new TranscriptStreamV9();
  assert.equal(empty.attachToolCall({ name: 'x', args: {}, ok: true, atMs: 0 }), false);
  // A tool call while the interim is live is held and flushed into
  // the turn on commit (not attached to the previous turn).
  const live = new TranscriptStreamV9();
  live.noteFinal('user asks', { speakerId: 'user', atMs: 0 });
  live.pushPartial('agent ans', { speakerId: 'agent', atMs: 100 });
  assert.equal(live.attachToolCall({ name: 'lookup', args: { q: 'x' }, ok: true, atMs: 150 }), true);
  assert.equal(live.getTurns()[0].toolCalls.length, 0, 'user turn keeps no agent tool call');
  const committed = live.commit({ atMs: 200 });
  assert.ok(committed);
  assert.equal(committed.toolCalls.length, 1);
  assert.equal(committed.toolCalls[0].name, 'lookup');
  stream.clear();
  assert.equal(stream.getTurns().length, 0);
});

// ------------------------------------------------------------- session v9

test('session v9: connect, scripted turn, status walk listening->processing->speaking->listening', async () => {
  const events = [];
  const session = createMockVoiceSessionV9(
    { sessionId: 's1', botId: 'b1', mockReplies: ['chào bạn nhé'] },
    (e) => events.push(e),
  );
  assert.equal(session.getStatus(), 'idle');
  assert.throws(() => session.feedAudio(sineFrame(440)), /idle/);
  session.connect();
  assert.equal(session.getStatus(), 'listening');
  assert.throws(() => session.connect(), /already listening/);
  await session.simulateTurn('xin chào', 'chào bạn nhé');
  assert.equal(session.getStatus(), 'listening');
  const stats = session.getStats();
  assert.equal(stats.userTurns, 1);
  assert.equal(stats.agentTurns, 1);
  assert.equal(stats.turns, 2);
  assert.ok(stats.partials >= 3, 'partials streamed per word');
  assert.deepEqual(
    events.filter((e) => e.kind === 'status').map((e) => e.status),
    ['listening', 'processing', 'speaking', 'listening'],
  );
  assert.equal(session.getTurns()[0].speakerId, 'user');
  assert.equal(session.getTurns()[1].speakerId, 'agent');
  assert.ok(session.getSummary().includes('s1'));
  session.disconnect();
  assert.equal(session.getStatus(), 'idle');
});

test('session v9: VAD-driven turn via feedAudio (mock transport, no timers)', async () => {
  const session = createMockVoiceSessionV9({ sessionId: 's2', vad: { preset: 'quiet' }, mockReplies: ['vâng, tôi nghe đây'] });
  session.connect();
  for (let i = 0; i < 5; i++) session.feedAudio(silenceFrame());
  for (let i = 0; i < 30; i++) session.feedAudio(sineFrame(440));
  for (let i = 0; i < 25; i++) session.feedAudio(silenceFrame());
  await flush();
  assert.equal(session.getStatus(), 'listening');
  const stats = session.getStats();
  assert.equal(stats.vad.turns, 1);
  assert.equal(stats.agentTurns, 1, 'the VAD turn produced a mock reply');
  assert.equal(session.getTurns().length, 1, 'no user text was noted, so only the agent turn is committed');
  assert.equal(session.getTurns()[0].speakerId, 'agent');
});

test('session v9: tool call mid-speech attaches to the live turn', async () => {
  const calls = [];
  const session = createMockVoiceSessionV9({
    sessionId: 's3',
    mockReplies: ['đây là kết quả tra cứu cho bạn'],
    mockToolCalls: { 0: [{ name: 'web_search', args: { q: 'thời tiết' }, afterWord: 1 }] },
    toolHandler: async (name, args) => {
      calls.push({ name, args });
      return { ok: true, result: 'nắng 30 độ' };
    },
  });
  const events = [];
  const session2 = createMockVoiceSessionV9(
    { sessionId: 's3b', mockReplies: ['đây là kết quả tra cứu cho bạn'], mockToolCalls: { 0: [{ name: 'web_search', args: { q: 'thời tiết' }, afterWord: 1 }] }, toolHandler: async () => ({ ok: true, result: 'nắng 30 độ' }) },
    (e) => events.push(e),
  );
  session.connect();
  await session.simulateTurn('thời tiết hôm nay thế nào');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'web_search');
  const agentTurn = session.getTurns().find((t) => t.speakerId === 'agent');
  assert.ok(agentTurn);
  assert.equal(agentTurn.toolCalls.length, 1);
  assert.equal(agentTurn.toolCalls[0].result, 'nắng 30 độ');

  // A tool call outside speaking/processing is refused.
  session2.connect();
  await assert.rejects(() => session2.invokeToolDuringSpeech('x', {}), /speaking or processing/);
  session.disconnect();
  session2.disconnect();
});

test('session v9: barge-in cuts the reply and keeps the cut point', async () => {
  const session = createMockVoiceSessionV9({
    sessionId: 's4',
    bargeIn: { policy: 'immediate' },
    mockReplies: ['một hai ba bốn năm sáu bảy tám'],
  });
  session.connect();
  const promise = session.simulateTurn('nói dài đi');
  session.interrupt('explicit');
  await promise;
  assert.equal(session.getStatus(), 'listening');
  const last = session.getLastInterrupt();
  assert.ok(last, 'cut point kept');
  assert.equal(last.cutWordIndex, 1, 'second word was cut after the first streamed');
  assert.deepEqual(last.wordsPlayed, ['một']);
  assert.equal(session.getStats().interrupts, 1);
  const agentTurn = session.getTurns().find((t) => t.speakerId === 'agent');
  assert.ok(agentTurn, 'the cut reply is kept as a partial agent turn');
  assert.equal(agentTurn.text, 'một');
  session.disconnect();
});

test('session v9: duck/resume, PTT mode, live-key probe gate', async () => {
  const session = createMockVoiceSessionV9({
    sessionId: 's5',
    inputMode: 'push-to-talk',
    mockReplies: ['ok'],
  });
  session.connect();
  // PTT: frames are ignored until the button is held.
  assert.equal(session.feedAudio(sineFrame(440)), false);
  assert.equal(await session.ptt(true), true);
  assert.equal(session.isPttPressed(), true);
  session.notePartial('xin chào');
  assert.equal(await session.ptt(false), false);
  await flush();
  assert.equal(session.getStatus(), 'listening');
  assert.equal(session.getStats().userTurns, 1);
  assert.equal(session.getStats().pttPresses, 1);
  assert.throws(() => session.setInputMode('loud'), /input mode/);
  assert.equal(session.setInputMode('auto'), 'auto');
  await assert.rejects(() => session.ptt(true), /push-to-talk input mode/);

  // Live probe: gate only — no key read, no dial.
  assert.deepEqual(session.liveProbe(() => false), { liveAvailable: false, reason: 'no-key-in-vault', checkedAtMs: session.getNowMs() });
  assert.equal(session.liveProbe(() => true).liveAvailable, true);
  assert.deepEqual(probeLiveVoiceV9Key(() => { throw new Error('vault down'); }), {
    liveAvailable: false,
    reason: 'no-key-in-vault',
    checkedAtMs: 0,
  });

  // VAD preset + barge-in policy switch live.
  assert.equal(session.setVadPreset('noisy').preset, 'noisy');
  assert.equal(session.setBargeInPolicy('confirm').policy, 'confirm');
  assert.throws(() => session.setVadPreset('loud'), /preset/);
  assert.equal(session.getVadOptions().preset, 'noisy');
  session.disconnect();
});

test('session v9: manager create/list/remove, duplicate id refused', () => {
  const manager = new VoiceV9Manager();
  const a = manager.create({ sessionId: 'm1', connectNow: true });
  assert.equal(a.getStatus(), 'listening');
  assert.throws(() => manager.create({ sessionId: 'm1' }), /already exists/);
  manager.create({ sessionId: 'm2' });
  assert.deepEqual(manager.ids().sort(), ['m1', 'm2']);
  assert.equal(manager.size(), 2);
  assert.equal(manager.get('m2')?.getStatus(), 'idle');
  assert.equal(manager.remove('m2'), true);
  assert.equal(manager.remove('m2'), false);
  assert.equal(manager.size(), 1);
  assert.throws(() => new RealtimeVoiceSessionV9({ sessionId: 'bad id!' }), /sessionId/);
});

// ------------------------------------------------------------- store v9

test('store v9: save/load round-trip, checksum quarantine, prune, resume', () => {
  const dir = tmpDir('voice-v9-store-');
  const store = new VoiceSessionV9Store(dir);
  const session = createMockVoiceSessionV9({ sessionId: 'store1', botId: 'b1', mockReplies: ['ok'] });
  session.connect();
  const snapshot = createVoiceSessionV9Snapshot({
    sessionId: 'store1',
    botId: 'b1',
    language: 'vi',
    voice: 'default',
    status: 'listening',
    savedAtMs: 1000,
    connectedMs: 500,
    turns: session.getTurns(),
    cutPoint: {
      interrupted: true, cutWord: 'ba', cutWordIndex: 2, playedMs: 240, discardedMs: 360,
      wordsPlayed: ['một', 'hai'], wordsDiscarded: ['ba', 'bốn'], wasThinking: false, atMs: 900,
    },
    stats: { userTurns: 1, agentTurns: 1, partials: 5, toolCalls: 0, interrupts: 1 },
    vadPreset: 'office',
    bargeInPolicy: 'grace',
  });
  assert.equal(snapshot.version, VOICE_SESSION_V9_STORE_VERSION);
  const saved = store.save(snapshot);
  assert.equal(saved.ok, true);
  assert.equal(saved.path, voiceSessionV9SnapshotPath(dir, 'store1'));
  const loaded = store.load('store1');
  assert.equal(loaded.ok, true);
  assert.equal(loaded.snapshot.sessionId, 'store1');
  assert.equal(loaded.snapshot.cutPoint.cutWord, 'ba');
  assert.deepEqual(store.list(), ['store1']);
  const instructions = buildVoiceSessionV9ResumeInstructions(loaded.snapshot);
  assert.ok(instructions.includes('cut at word "ba"'));
  assert.ok(instructions.includes('do not restart the sentence'));
  assert.ok(voiceSessionV9SnapshotMarkdown(loaded.snapshot).includes('store1'));

  // Tamper: checksum mismatch -> load fails and the file is quarantined.
  const file = voiceSessionV9SnapshotPath(dir, 'store1');
  const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
  raw.stats.userTurns = 99;
  fs.writeFileSync(file, JSON.stringify(raw));
  const bad = store.load('store1');
  assert.equal(bad.ok, false);
  assert.ok(fs.existsSync(`${file}.corrupt`), 'corrupt file quarantined');
  assert.deepEqual(store.list(), [], 'quarantined file no longer lists');

  // Validation rejects a wrong version and a non-object.
  assert.equal(validateVoiceSessionV9Snapshot({ version: 99 }).ok, false);
  assert.equal(validateVoiceSessionV9Snapshot(null).ok, false);

  // Prune keeps the newest N.
  for (let i = 0; i < 5; i++) {
    store.save(createVoiceSessionV9Snapshot({
      sessionId: `p${i}`, botId: 'b', language: 'en', voice: 'd', status: 'idle',
      savedAtMs: i, connectedMs: 0, turns: [], cutPoint: null,
      stats: { userTurns: 0, agentTurns: 0, partials: 0, toolCalls: 0, interrupts: 0 },
      vadPreset: 'office', bargeInPolicy: 'grace',
    }));
  }
  const pruned = store.prune(3);
  assert.equal(pruned.kept, 3);
  assert.equal(pruned.removed, 2);
  assert.equal(store.delete('p4'), true);
  assert.equal(store.delete('p4'), false);
  assert.deepEqual(new VoiceSessionV9Store(path.join(dir, 'missing')).list(), []);
});

// ------------------------------------------------------------- tools v9

function toolByName(tools, name) {
  const tool = tools.find((t) => t.definition.name === name);
  assert.ok(tool, `missing tool ${name}`);
  return tool;
}

async function runTool(tools, name, args = {}) {
  const out = await toolByName(tools, name).execute(args);
  return JSON.parse(out);
}

test('tools v9: 10 tools, unique names, placeholder refuses without a manager', async () => {
  assert.equal(VOICE_V9_TOOLS.length, 10);
  assert.deepEqual([...VOICE_V9_TOOL_NAMES].sort(), VOICE_V9_TOOLS.map((t) => t.definition.name).sort());
  assert.equal(new Set(VOICE_V9_TOOL_NAMES).size, 10);
  assert.equal(isVoiceV9ToolName('voice_v9_session_create'), true);
  assert.equal(isVoiceV9ToolName('voice_v8_session_create'), false);
  const out = await VOICE_V9_TOOLS[0].execute({ sessionId: 'x' });
  assert.ok(out.startsWith('Error: voice v9 session manager is not available'));
});

test('tools v9: full lifecycle through the tools on a real manager', async () => {
  const manager = new VoiceV9Manager();
  const tools = createVoiceV9Tools({ getManager: () => manager });
  assert.equal(tools.length, 10);

  const created = await runTool(tools, 'voice_v9_session_create', {
    sessionId: 't1', botId: 'b1', language: 'vi', vadPreset: 'quiet',
    bargeInPolicy: 'immediate', inputMode: 'auto', mockReply: 'chào bạn', connect: true,
  });
  assert.equal(created.created, true);
  assert.ok(created.summary.includes('t1'));

  const listed = await runTool(tools, 'voice_v9_session_list');
  assert.equal(listed.count, 1);
  assert.equal(listed.sessions[0].status, 'listening');

  const turned = await runTool(tools, 'voice_v9_simulate_turn', { sessionId: 't1', userText: 'xin chào' });
  assert.equal(turned.simulated, true);
  assert.equal(turned.turns.length, 2);

  const stats = await runTool(tools, 'voice_v9_session_stats', { sessionId: 't1' });
  assert.equal(stats.stats.userTurns, 1);
  assert.equal(stats.stats.agentTurns, 1);
  assert.ok(stats.transcriptMarkdown.includes('xin chào'));

  const vad = await runTool(tools, 'voice_v9_vad', { sessionId: 't1', preset: 'noisy' });
  assert.equal(vad.action, 'preset');
  assert.equal(vad.preset, 'noisy');
  const vadStatus = await runTool(tools, 'voice_v9_vad', { sessionId: 't1' });
  assert.equal(vadStatus.action, 'status');

  const barge = await runTool(tools, 'voice_v9_barge_in', { sessionId: 't1', action: 'status' });
  assert.equal(barge.options.policy, 'immediate');
  const ducked = await runTool(tools, 'voice_v9_barge_in', { sessionId: 't1', action: 'duck' });
  assert.equal(ducked.ducked, false, 'nothing is speaking, so duck is a no-op');

  const probe = await runTool(tools, 'voice_v9_live_probe', { sessionId: 't1' });
  assert.equal(probe.liveAvailable, false);
  assert.equal(probe.reason, 'no-key-in-vault');

  const stopped = await runTool(tools, 'voice_v9_session_stop', { sessionId: 't1' });
  assert.equal(stopped.stopped, true);
  const deleted = await runTool(tools, 'voice_v9_session_delete', { sessionId: 't1' });
  assert.equal(deleted.deleted, true);
  assert.equal(deleted.remaining, 0);

  // Errors are returned, not thrown.
  const missing = await toolByName(tools, 'voice_v9_session_stats').execute({ sessionId: 'nope' });
  assert.ok(missing.startsWith('Error: Unknown voice v9 session'));
  const badPreset = await toolByName(tools, 'voice_v9_session_create').execute({ sessionId: 't2', vadPreset: 'loud' });
  assert.ok(badPreset.startsWith('Error: Unknown VAD v9 preset'));
});

test('tools v9: PTT tool drives press/release and mode switch', async () => {
  const manager = new VoiceV9Manager();
  const tools = createVoiceV9Tools({ getManager: () => manager });
  await runTool(tools, 'voice_v9_session_create', { sessionId: 'ptt1', inputMode: 'push-to-talk', connect: true });
  const pressed = await runTool(tools, 'voice_v9_ptt', { sessionId: 'ptt1', action: 'press' });
  assert.equal(pressed.pressed, true);
  const released = await runTool(tools, 'voice_v9_ptt', { sessionId: 'ptt1', action: 'release' });
  assert.equal(released.pressed, false);
  const switched = await runTool(tools, 'voice_v9_ptt', { sessionId: 'ptt1', action: 'set-mode', inputMode: 'auto' });
  assert.equal(switched.inputMode, 'auto');
  const status = await runTool(tools, 'voice_v9_ptt', { sessionId: 'ptt1' });
  assert.equal(status.action, 'status');
});

// ------------------------------------------------------------- view models

test('view v9: row parsing is defensive, label keys follow the i18n contract', () => {
  assert.equal(toVoiceSessionV9RowView(null), null);
  assert.equal(toVoiceSessionV9RowView({}), null);
  const row = toVoiceSessionV9RowView({
    sessionId: 'v1', status: 'speaking', inputMode: 'auto', botId: 'b1', language: 'vi',
    connectedMs: 61000, userTurns: 2, agentTurns: 2, turns: 4, partials: 10, toolCalls: 1,
    interrupts: 1, level: 0.5, vad: { preset: 'quiet', floor: 0.01, speaking: true, turns: 2 },
    bargeIn: { policy: 'grace', ducked: false },
  });
  assert.ok(row);
  assert.equal(row.id, 'v1');
  assert.equal(row.status, 'speaking');
  assert.equal(row.vadPreset, 'quiet');
  assert.equal(row.bargeInPolicy, 'grace');
  assert.equal(voiceV9StatusLabelKey('speaking'), 'voice.v9.status.speaking');
  assert.ok(voiceV9StatusSummary(row).includes('v1: speaking'));
  assert.equal(formatVoiceV9Duration(61000), '1:01');
  assert.equal(formatVoiceV9AudioMs(250), '0.3s');
  assert.equal(toVoiceSessionV9RowViews([{ sessionId: 'a' }, null, { bad: 1 }]).length, 1);
  assert.equal(pttViewV9('push-to-talk', true).labelKey, 'voice.v9.ptt.release');
  assert.equal(pttViewV9('push-to-talk', false).labelKey, 'voice.v9.ptt.press');
  assert.equal(pttViewV9('auto', false).visible, false);
});

test('view v9: VAD/barge-in/transcript views and waveform bars', () => {
  const vad = toVoiceV9VadView({ preset: 'noisy', floor: 0.03, speaking: true, turns: 3, backchannels: 1, falseStarts: 0, speechMs: 1200 });
  assert.ok(vad);
  assert.equal(vad.preset, 'noisy');
  assert.equal(vad.speechMs, 1200);
  assert.equal(toVoiceV9VadView('nope'), null);
  const barge = toVoiceV9BargeInView({
    policy: 'immediate', interrupts: 2, lastInterruptAtMs: 5000,
    lastInterrupt: { cutWord: 'ba', playedMs: 240, discardedMs: 360 },
  });
  assert.ok(barge);
  assert.equal(barge.lastCutWord, 'ba');
  assert.equal(barge.lastPlayedMs, 240);
  assert.equal(toVoiceV9BargeInView(null), null);
  const rows = toVoiceV9TranscriptRows({
    turns: [
      { id: 't1', speakerId: 'user', text: 'xin chào', startedAtMs: 0, endedAtMs: 100, toolCalls: [{ name: 'echo', ok: true }] },
    ],
    interim: { speakerId: 'agent', text: 'chào', startedAtMs: 200 },
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[1].interim, true);
  assert.equal(rows[0].toolCalls.length, 1);
  assert.deepEqual(toVoiceV9TranscriptRows(null), []);
  const bars = waveformBarsV9([0, 0.5, 1, 0.25], 4);
  assert.deepEqual(bars.map((b) => b.level), [0, 0.5, 1, 0.25]);
  assert.equal(appendWaveformLevelV9([0.1, 0.2], 0.9, 3).length, 3);
});

// ------------------------------------------------------------- i18n

test('i18n v1.10: 73 voice.v9.* keys in all 6 locales, non-empty', () => {
  const localesDir = path.join(ROOT, 'apps/desktop/src/renderer/i18n/locales');
  const names = ['en', 'vi', 'es', 'fr', 'ja', 'zh'];
  const locales = Object.fromEntries(
    names.map((name) => [name, JSON.parse(fs.readFileSync(path.join(localesDir, `${name}.json`), 'utf-8'))]),
  );
  const counts = names.map((name) => Object.keys(locales[name]).length);
  assert.ok(counts.every((c) => c === counts[0]), `locales must agree on key count, got ${counts.join(', ')}`);
  for (const key of V110_VOICE_KEYS) {
    for (const name of names) {
      const value = locales[name][key];
      assert.equal(typeof value, 'string', `${key} missing in ${name}`);
      assert.ok(value.trim().length > 0, `${key} empty in ${name}`);
    }
  }
  // The default mock reply is exported and says plainly it is mock mode.
  assert.ok(VOICE_V9_DEFAULT_MOCK_REPLY.includes('mock'));
});
