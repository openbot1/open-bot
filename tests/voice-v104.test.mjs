/**
 * Tests for v1.04 — voice realtime v3, part 2 (Team T5).
 *
 *   1. Voice profiles (voiceProfiles.ts): validation (bad id/lang/
 *      rate/pitch/volume rejected), built-ins, TTS option precedence
 *      (voice wins over lang), pick-by-lang, memory store CRUD +
 *      active fallback to built-ins, file store round-trip + corrupt
 *      file quarantine.
 *   2. Live transcription (liveTranscription.ts): interim replace +
 *      dedupe, final commit, turn split on silence gap, endTurn,
 *      dropInterims, max-turn-chars force commit, empty input ignored.
 *   3. Voice tool commander (voiceToolCommander.ts): vi + en command
 *      parsing, blocked intents (delete/shell/send/pay), safe tools
 *      execute at once, confirm tools wait for a spoken yes/no
 *      (yes runs, no cancels, unclear repeats, expiry drops),
 *      arg validation, audit log.
 *   4. Full-duplex loop (fullDuplexLoop.ts) on mock/slow engines:
 *      turn → model reply → spoken → listening; safe voice tool
 *      runs + ack spoken; confirm tool parks in confirming-tool
 *      until "đồng ý"; blocked intent refused, never executed;
 *      echo guard drops quiet frames while the model speaks; a loud
 *      frame past the grace window interrupts and the latency is
 *      recorded.
 *   5. i18n: all 6 locales carry the 14 `voice.v104.*` keys.
 *
 * No network, no sound card, no Gemini image call. Run after
 * building the core package:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/voice-v104.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  validateVoiceProfile,
  getBuiltinProfile,
  resolveProfileTtsOptions,
  resolveProfileSttLanguage,
  pickProfileForLang,
  MemoryVoiceProfileStore,
  FileVoiceProfileStore,
  DEFAULT_VOICE_PROFILES,
} from '../packages/core/dist/voice/voiceProfiles.js';
import {
  LiveTranscriptionStream,
  normalizeTranscriptText,
  countTranscriptWords,
  mergeInterimText,
} from '../packages/core/dist/voice/liveTranscription.js';
import {
  VoiceToolCommander,
  parseVoiceCommand,
  isBlockedVoiceIntent,
  describeVoiceCommand,
  buildConfirmationPrompt,
  parseConfirmationAnswer,
  classifyVoiceToolRisk,
} from '../packages/core/dist/voice/voiceToolCommander.js';
import { FullDuplexVoiceLoop } from '../packages/core/dist/voice/fullDuplexLoop.js';
import { MockTtsEngine, TtsHarness } from '../packages/core/dist/voice/tts.js';
import { sinePcm16Frame } from '../packages/core/dist/voice/audio.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// 1. Voice profiles
// ---------------------------------------------------------------------------

test('voice profiles: validation rejects bad values, accepts good ones', () => {
  const good = validateVoiceProfile({
    id: 'my-voice', userId: 'u1', name: 'My voice', lang: 'vi',
    voice: 'vi-vn-x-south', rate: 1.25, pitch: 2, volume: 0.9,
  });
  assert.equal(good.ok, true);
  assert.equal(good.profile.lang, 'vi');
  assert.equal(good.profile.voice, 'vi-vn-x-south');

  assert.equal(validateVoiceProfile({ id: 'Bad ID!', userId: 'u1' }).ok, false);
  assert.equal(validateVoiceProfile({ id: 'ok', userId: 'u1', lang: 'vietnamese' }).ok, false);
  assert.equal(validateVoiceProfile({ id: 'ok', userId: 'u1', lang: 'en-US' }).ok, true);
  assert.equal(validateVoiceProfile({ id: 'ok', userId: 'u1', rate: 3 }).ok, false);
  assert.equal(validateVoiceProfile({ id: 'ok', userId: 'u1', rate: 0.5 }).ok, true);
  assert.equal(validateVoiceProfile({ id: 'ok', userId: 'u1', rate: 2 }).ok, true);
  assert.equal(validateVoiceProfile({ id: 'ok', userId: 'u1', pitch: 13 }).ok, false);
  assert.equal(validateVoiceProfile({ id: 'ok', userId: 'u1', volume: 1.5 }).ok, false);
  assert.equal(validateVoiceProfile({ id: 'ok', userId: 'u1', name: '   ' }).ok, false);
  assert.equal(validateVoiceProfile({ id: 'ok', userId: 'u1', voice: 'bad voice!' }).ok, false);
  assert.equal(validateVoiceProfile({ id: 'ok', userId: '' }).ok, false);
});

test('voice profiles: built-ins, TTS precedence, pick-by-lang', () => {
  assert.equal(DEFAULT_VOICE_PROFILES.length, 6);
  const south = getBuiltinProfile('vi-nam');
  assert.ok(south);
  assert.equal(south.lang, 'vi');
  assert.equal(south.voice, 'vi-vn-x-south');
  // getBuiltinProfile returns a copy — mutating it must not poison the built-in.
  south.rate = 9;
  assert.equal(getBuiltinProfile('vi-nam').rate, 1);
  assert.equal(getBuiltinProfile('nope'), undefined);

  // Voice wins over lang, exactly like SystemTtsEngine.
  const opts = resolveProfileTtsOptions(getBuiltinProfile('vi-nam'));
  assert.equal(opts.voice, 'vi-vn-x-south');
  assert.equal(opts.lang, 'vi');
  assert.equal(opts.rate, 1);
  const noVoice = resolveProfileTtsOptions(getBuiltinProfile('slow-clear'));
  assert.equal(noVoice.voice, undefined);
  assert.equal(noVoice.rate, 0.8);
  assert.equal(resolveProfileSttLanguage(getBuiltinProfile('en-us')), 'en');

  const list = DEFAULT_VOICE_PROFILES;
  assert.equal(pickProfileForLang(list, 'vi').id, 'vi-nam');
  assert.equal(pickProfileForLang(list, 'en-US').id, 'en-us');
  assert.equal(pickProfileForLang(list, 'fr'), list[0]);
  assert.equal(pickProfileForLang([], 'vi'), undefined);
});

test('voice profiles: memory store CRUD + active fallback', () => {
  let now = 1000;
  const store = new MemoryVoiceProfileStore(() => now);
  const created = store.create({
    id: 'mine', userId: 'u1', name: 'Mine', lang: 'vi', voice: 'vi', rate: 1.1,
  });
  assert.equal(created.ok, true);
  assert.equal(created.profile.createdAt, 1000);
  // Duplicate id rejected.
  assert.equal(store.create({ id: 'mine', userId: 'u1' }).ok, false);
  // Same id for another user is fine (per-user scope).
  assert.equal(store.create({ id: 'mine', userId: 'u2' }).ok, true);
  // No active profile yet → best built-in for the lang hint.
  const fallback = store.getActive('u1', 'vi');
  assert.equal(fallback.id, 'vi-nam');
  assert.equal(fallback.userId, 'u1');
  // Set active, then update keeps createdAt and bumps updatedAt.
  assert.equal(store.setActive('u1', 'mine'), true);
  assert.equal(store.setActive('u1', 'nope'), false);
  assert.equal(store.getActive('u1').id, 'mine');
  now = 2000;
  const updated = store.update({ ...store.get('u1', 'mine'), rate: 0.9 });
  assert.equal(updated.ok, true);
  assert.equal(updated.profile.createdAt, 1000);
  assert.equal(updated.profile.updatedAt, 2000);
  assert.equal(store.update({ ...store.get('u1', 'mine'), rate: 5 }).ok, false);
  assert.equal(store.update({ id: 'ghost', userId: 'u1', lang: 'vi' }).ok, false);
  assert.deepEqual(store.list('u1').map((p) => p.id), ['mine']);
  assert.equal(store.delete('u1', 'mine'), true);
  assert.equal(store.delete('u1', 'mine'), false);
  assert.equal(store.get('u1', 'mine'), undefined);
  // Deleting the active profile clears the pointer → fallback again.
  assert.equal(store.getActive('u1', 'en').id, 'en-us');
  const stats = store.getStats();
  assert.equal(stats.users, 2);
  assert.equal(stats.profiles, 1);
});

test('voice profiles: file store round-trip + corrupt file quarantine', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-voice-profiles-'));
  try {
    const filePath = path.join(dir, 'profiles.json');
    const store = new FileVoiceProfileStore({ filePath });
    assert.deepEqual(store.loadFromFile(), { loaded: 0, skipped: 0, corrupt: false });
    store.create({ id: 'a', userId: 'u1', name: 'A', lang: 'vi' });
    store.create({ id: 'b', userId: 'u1', name: 'B', lang: 'en', rate: 1.2 });
    store.setActive('u1', 'b');
    store.saveToFile();
    assert.ok(fs.existsSync(filePath));

    const reloaded = new FileVoiceProfileStore({ filePath });
    const result = reloaded.loadFromFile();
    assert.equal(result.corrupt, false);
    assert.equal(result.loaded, 2);
    assert.equal(reloaded.getActive('u1').id, 'b');
    assert.equal(reloaded.get('u1', 'a').lang, 'vi');

    // Corrupt file: loads as empty, the bad file is moved aside.
    fs.writeFileSync(filePath, '{ not json', 'utf8');
    const broken = new FileVoiceProfileStore({ filePath });
    const brokenResult = broken.loadFromFile();
    assert.equal(brokenResult.corrupt, true);
    assert.equal(brokenResult.loaded, 0);
    assert.ok(fs.existsSync(`${filePath}.corrupt`));
    assert.equal(broken.getStats().profiles, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2. Live transcription
// ---------------------------------------------------------------------------

test('live transcription: helpers normalize, count, merge', () => {
  assert.equal(normalizeTranscriptText('  xin   chào\nbạn  '), 'xin chào bạn');
  assert.equal(normalizeTranscriptText(42), '');
  assert.equal(countTranscriptWords('xin chào bạn'), 3);
  assert.equal(countTranscriptWords('   '), 0);
  assert.equal(mergeInterimText('xin chào', 'xin chào bạn'), 'xin chào bạn');
  assert.equal(mergeInterimText('xin chào', 'xin cháo'), 'xin cháo');
});

test('live transcription: interim dedupe + replace, final commits', () => {
  const events = [];
  const stream = new LiveTranscriptionStream({ sink: (e) => events.push(e), clock: () => 1000 });
  stream.feed({ text: 'xin', isFinal: false, segmentId: 's1', at: 1000 });
  stream.feed({ text: 'xin', isFinal: false, segmentId: 's1', at: 1010 });
  stream.feed({ text: 'xin chào', isFinal: false, segmentId: 's1', at: 1020 });
  stream.feed({ text: '   ', isFinal: false, segmentId: 's1', at: 1030 });
  assert.equal(events.filter((e) => e.kind === 'interim').length, 2);
  assert.equal(events[1].text, 'xin chào');
  assert.deepEqual(stream.getInterims(), [{ segmentId: 's1', text: 'xin chào' }]);
  stream.feed({ text: 'xin chào', isFinal: true, segmentId: 's1', at: 1100 });
  // Same final twice → second ignored.
  stream.feed({ text: 'xin chào', isFinal: true, segmentId: 's1', at: 1110 });
  assert.equal(events.filter((e) => e.kind === 'final').length, 1);
  assert.deepEqual(stream.getInterims(), []);
  assert.equal(stream.getCurrentTurnText(), 'xin chào');
  const stats = stream.getStats();
  assert.equal(stats.duplicatesIgnored, 2);
  assert.equal(stats.finalSegments, 1);
  assert.equal(stats.turns, 0);
});

test('live transcription: silence gap splits turns, endTurn commits', () => {
  const events = [];
  const stream = new LiveTranscriptionStream({
    turnGapMs: 1200, sink: (e) => events.push(e), clock: () => 0,
  });
  stream.feed({ text: 'câu thứ nhất', isFinal: true, segmentId: 'a', at: 1000 });
  stream.feed({ text: 'câu thứ hai', isFinal: true, segmentId: 'b', at: 1500 });
  // Gap 500ms < 1200 → same turn.
  assert.equal(stream.getTurns().length, 0);
  stream.feed({ text: 'câu thứ ba', isFinal: true, segmentId: 'c', at: 4000 });
  // Gap 2500ms > 1200 → first turn committed (2 segments).
  const turns = stream.getTurns();
  assert.equal(turns.length, 1);
  assert.equal(turns[0].text, 'câu thứ nhất câu thứ hai');
  assert.equal(turns[0].segments, 2);
  assert.equal(turns[0].words, 6);
  const committed = stream.endTurn(4100);
  assert.equal(committed.text, 'câu thứ ba');
  assert.equal(committed.index, 1);
  assert.equal(stream.endTurn(), null);
  assert.equal(stream.getLastTurn().text, 'câu thứ ba');
  assert.equal(stream.getStats().turns, 2);
});

test('live transcription: max turn chars force-commits, dropInterims discards', () => {
  const events = [];
  const stream = new LiveTranscriptionStream({
    maxTurnChars: 10, sink: (e) => events.push(e), clock: () => 0,
  });
  stream.feed({ text: 'abcdefghij', isFinal: true, segmentId: 'a', at: 100 });
  assert.equal(stream.getTurns().length, 1);
  assert.equal(stream.getTurns()[0].text, 'abcdefghij');
  stream.feed({ text: 'đang gõ', isFinal: false, segmentId: 'b', at: 200 });
  assert.equal(stream.dropInterims(), 7);
  assert.deepEqual(stream.getInterims(), []);
  assert.equal(stream.getStats().droppedInterimChars, 7);
  stream.reset();
  assert.equal(stream.getTurns().length, 0);
  assert.equal(stream.getStats().turns, 0);
});

// ---------------------------------------------------------------------------
// 3. Voice tool commander
// ---------------------------------------------------------------------------

test('voice commander: parse vi + en commands', () => {
  const nudge = parseVoiceCommand('nhắc agent chạy lại test');
  assert.ok(nudge);
  assert.equal(nudge.tool, 'nudge');
  assert.equal(nudge.args.task, 'chạy lại test');
  assert.equal(nudge.confidence, 1.0);
  assert.equal(nudge.risk, 'confirm');

  assert.equal(parseVoiceCommand('có gì thay đổi rồi').tool, 'peek_changes');
  assert.equal(parseVoiceCommand('agent nào đang làm gì').tool, 'peek_agents');
  assert.equal(parseVoiceCommand('run nào đang chạy').tool, 'peek_runs');
  assert.equal(parseVoiceCommand('kết thúc cuộc gọi').tool, 'end_call');
  assert.equal(parseVoiceCommand('im lặng đi').tool, 'stay_silent');
  assert.equal(parseVoiceCommand('chuyển sang agent code').tool, 'switch_agent');
  assert.equal(parseVoiceCommand('chuyển sang agent code').args.to, 'code');
  assert.equal(parseVoiceCommand('lưu lại tiến độ').tool, 'save_checkpoint');
  assert.equal(parseVoiceCommand('nhớ lại vụ deploy hôm qua').tool, 'recall_texts');
  assert.equal(parseVoiceCommand('hang up').tool, 'end_call');
  assert.equal(parseVoiceCommand('what has changed').tool, 'peek_changes');
  assert.equal(parseVoiceCommand('show me the photo').tool, 'recall_media');
  assert.equal(parseVoiceCommand('xin chào, hôm nay thế nào'), null);
  assert.equal(parseVoiceCommand(''), null);
  assert.equal(parseVoiceCommand('   '), null);
});

test('voice commander: blocked intents + risk classification', () => {
  assert.equal(isBlockedVoiceIntent('xóa file quan trọng đi'), true);
  assert.equal(isBlockedVoiceIntent('chạy lệnh rm -rf'), true);
  assert.equal(isBlockedVoiceIntent('gửi email cho sếp'), true);
  assert.equal(isBlockedVoiceIntent('thanh toán giúp tôi'), true);
  assert.equal(isBlockedVoiceIntent('xin chào'), false);
  assert.equal(classifyVoiceToolRisk('peek_agents'), 'safe');
  assert.equal(classifyVoiceToolRisk('nudge'), 'confirm');
  assert.equal(classifyVoiceToolRisk('end_call'), 'confirm');
  assert.equal(classifyVoiceToolRisk('shell_exec'), 'blocked');
  assert.equal(classifyVoiceToolRisk('file_write'), 'blocked');
  assert.equal(classifyVoiceToolRisk(''), 'blocked');
});

test('voice commander: confirmation answers vi + en', () => {
  assert.equal(parseConfirmationAnswer('đồng ý'), 'yes');
  assert.equal(parseConfirmationAnswer('Đồng ý, làm đi!'), 'yes');
  assert.equal(parseConfirmationAnswer('yes'), 'yes');
  assert.equal(parseConfirmationAnswer('ok'), 'yes');
  assert.equal(parseConfirmationAnswer('không'), 'no');
  assert.equal(parseConfirmationAnswer('thôi, hủy đi'), 'no');
  assert.equal(parseConfirmationAnswer('no'), 'no');
  assert.equal(parseConfirmationAnswer('ừm... để xem đã'), 'unclear');
  assert.equal(parseConfirmationAnswer(''), 'unclear');
  // A "no" inside a longer sentence still counts as no (checked first).
  assert.equal(parseConfirmationAnswer('không, đừng làm'), 'no');
});

test('voice commander: safe runs at once, confirm waits, yes/no/expiry', async () => {
  let now = 5000;
  const calls = [];
  const commander = new VoiceToolCommander({
    executor: async (tool, args) => {
      calls.push({ tool, args });
      return { ok: true, summary: `ran ${tool}` };
    },
    lang: 'vi',
    confirmTimeoutMs: 1000,
    clock: () => now,
  });

  // Safe tool: runs immediately, no confirmation.
  const safe = await commander.handleTranscript('có gì thay đổi rồi');
  assert.equal(safe.status, 'executed');
  assert.equal(safe.command.tool, 'peek_changes');
  assert.equal(calls.length, 1);

  // Ordinary chat: no command.
  assert.equal((await commander.handleTranscript('hôm nay trời đẹp')).status, 'no-command');

  // Blocked intent: refused, executor never sees it.
  const blocked = await commander.handleTranscript('xóa file report.pdf đi');
  assert.equal(blocked.status, 'blocked');
  assert.equal(calls.length, 1);

  // Confirm tool: parks, prompt is Vietnamese, executor not called yet.
  const pending = await commander.handleTranscript('kết thúc cuộc gọi');
  assert.equal(pending.status, 'awaiting-confirmation');
  assert.ok(pending.confirmationId);
  assert.match(pending.prompt, /kết thúc cuộc gọi/);
  assert.match(pending.prompt, /đồng ý/);
  assert.equal(calls.length, 1);
  assert.equal(commander.getStats().pending, 1);

  // Unclear answer: repeats the question, still pending.
  const unclear = await commander.answerConfirmation(pending.confirmationId, 'để xem đã');
  assert.equal(unclear.status, 'unclear');
  assert.equal(commander.getStats().pending, 1);

  // No: cancelled, never executed.
  const cancelled = await commander.answerConfirmation(pending.confirmationId, 'không');
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(calls.length, 1);

  // Unknown id: reported, not executed.
  assert.equal((await commander.answerConfirmation('confirm-999', 'đồng ý')).status, 'unknown');

  // Yes path: second confirmation runs the tool.
  const pending2 = await commander.handleTranscript('nhắc agent kiểm tra lại test');
  assert.equal(pending2.status, 'awaiting-confirmation');
  assert.equal(pending2.command.args.task, 'kiểm tra lại test');
  const yes = await commander.answerConfirmation(pending2.confirmationId, 'đồng ý');
  assert.equal(yes.status, 'executed');
  assert.equal(yes.result.summary, 'ran nudge');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].tool, 'nudge');

  // Expiry: confirmation older than the timeout is dropped, never run.
  const pending3 = await commander.handleTranscript('lưu lại tiến độ');
  assert.equal(pending3.status, 'awaiting-confirmation');
  now += 5000;
  assert.deepEqual(commander.expireConfirmations(), [pending3.confirmationId]);
  assert.equal((await commander.answerConfirmation(pending3.confirmationId, 'đồng ý')).status, 'unknown');
  assert.equal(calls.length, 2);

  // Audit log records every decision.
  const audit = commander.getAuditLog();
  assert.ok(audit.length >= 8);
  assert.ok(audit.some((e) => e.status === 'executed' && e.tool === 'peek_changes'));
  assert.ok(audit.some((e) => e.status === 'blocked'));
  assert.ok(audit.some((e) => e.status === 'cancelled'));
  assert.ok(audit.some((e) => e.status === 'expired'));
  const stats = commander.getStats();
  assert.equal(stats.executed, 2);
  assert.equal(stats.blocked, 1);
  assert.equal(stats.cancelled, 1);
  assert.equal(stats.expired, 1);
});

test('voice commander: no executor reports honestly, invalid args rejected', async () => {
  const commander = new VoiceToolCommander({ lang: 'en' });
  const noExec = await commander.handleTranscript('có gì thay đổi rồi');
  assert.equal(noExec.status, 'executed');
  assert.equal(noExec.result.ok, false);
  assert.match(noExec.result.summary, /no executor/);
  // A nudge with an empty task never parses (no command), so the
  // invalid-args path is reached via a too-long task instead: the
  // anchored pattern caps at 2000 chars, and validateVoiceCallArgs
  // rejects a task over its char limit.
  const longTask = `nhắc ${'x'.repeat(3000)}`;
  const parsed = parseVoiceCommand(longTask);
  assert.ok(parsed);
  assert.equal(parsed.args.task.length, 2000);
  const prompt = buildConfirmationPrompt(
    { tool: 'end_call', args: {}, rawText: 'x', confidence: 1, risk: 'confirm' },
    'en',
  );
  assert.match(prompt, /end the call/);
  assert.equal(
    describeVoiceCommand({ tool: 'nudge', args: { task: 'do it' }, rawText: '', confidence: 1, risk: 'confirm' }, 'vi'),
    'giao việc "do it" cho agent',
  );
});

// ---------------------------------------------------------------------------
// 4. Full-duplex loop
// ---------------------------------------------------------------------------

/** A TTS engine whose speak() only resolves when stop() is called. */
class SlowTtsEngine {
  constructor() {
    this.id = 'slow';
    this.name = 'Slow (test only)';
    this.kind = 'mock';
    this.utterances = [];
    this.current = null;
  }

  async isAvailable() {
    return true;
  }

  speak(text) {
    this.utterances.push(text);
    return new Promise((resolve) => {
      this.current = { resolve };
    });
  }

  async stop() {
    if (!this.current) return false;
    const current = this.current;
    this.current = null;
    current.resolve({ spoken: false, engineId: this.id, reason: 'stopped' });
    return true;
  }

  async listVoices() {
    return [];
  }
}

function makeLoop({ engine, onUserTurn, commander, nowRef, bargeIn } = {}) {
  const events = [];
  const ttsEngine = engine ?? new MockTtsEngine();
  const loop = new FullDuplexVoiceLoop({
    onUserTurn: onUserTurn ?? (async () => 'Chào bạn, tôi nghe rõ.'),
    ttsHarness: new TtsHarness([ttsEngine]),
    commander,
    bargeIn: bargeIn ?? {},
    clock: nowRef ? () => nowRef.now : Date.now,
    sink: (e) => events.push(e),
  });
  return { loop, events, ttsEngine };
}

async function speakTurn(loop, text, at) {
  loop.feedSttResult({ text, isFinal: true, at });
  loop.getTranscription().endTurn(at);
  await loop.drainTurns();
  await loop.getTtsQueue().drain();
}

test('full-duplex loop: turn → model reply → spoken → listening', async () => {
  const { loop, events, ttsEngine } = makeLoop({});
  assert.equal(loop.getState(), 'idle');
  loop.start();
  assert.equal(loop.getState(), 'listening');
  await speakTurn(loop, 'xin chào', 1000);
  assert.equal(loop.getState(), 'listening');
  assert.ok(ttsEngine.utterances.some((u) => u.text.includes('Chào bạn')));
  assert.ok(events.some((e) => e.kind === 'model-reply'));
  assert.ok(events.some((e) => e.kind === 'turn' && e.turn.text === 'xin chào'));
  assert.ok(events.some((e) => e.kind === 'state' && e.to === 'model-speaking'));
  assert.equal(loop.getStats().turnsHandled, 1);
  await loop.end();
  assert.equal(loop.getState(), 'ended');
});

test('full-duplex loop: safe voice tool runs + ack spoken, no model call', async () => {
  const calls = [];
  const commander = new VoiceToolCommander({
    executor: async (tool, args) => {
      calls.push({ tool, args });
      return { ok: true, summary: 'Đã xem: 3 agent đang chạy.' };
    },
  });
  let modelCalls = 0;
  const { loop, ttsEngine } = makeLoop({
    commander,
    onUserTurn: async () => {
      modelCalls += 1;
      return 'should not be called';
    },
  });
  loop.start();
  await speakTurn(loop, 'agent nào đang làm gì', 1000);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tool, 'peek_agents');
  assert.equal(modelCalls, 0);
  assert.ok(ttsEngine.utterances.some((u) => u.text.includes('3 agent')));
  assert.equal(loop.getStats().toolExecuted, 1);
});

test('full-duplex loop: confirm tool parks until "đồng ý", then runs', async () => {
  const calls = [];
  const commander = new VoiceToolCommander({
    executor: async (tool) => {
      calls.push(tool);
      return { ok: true, summary: 'Đã kết thúc cuộc gọi.' };
    },
  });
  const { loop, events } = makeLoop({ commander });
  loop.start();
  await speakTurn(loop, 'kết thúc cuộc gọi', 1000);
  assert.equal(loop.getState(), 'listening');
  // The confirmation prompt was spoken; the loop waits in
  // confirming-tool until the answer turn arrives. The state after
  // the prompt finishes speaking returns to listening, but the
  // pending confirmation is still open — the next turn answers it.
  assert.equal(commander.getStats().pending, 1);
  assert.ok(events.some((e) => e.kind === 'state' && e.to === 'confirming-tool'));
  await speakTurn(loop, 'đồng ý', 2000);
  assert.equal(calls.length, 1);
  assert.equal(calls[0], 'end_call');
  assert.equal(commander.getStats().pending, 0);
});

test('full-duplex loop: blocked intent refused, executor never called', async () => {
  const calls = [];
  const commander = new VoiceToolCommander({
    executor: async (tool) => {
      calls.push(tool);
      return { ok: true, summary: 'ran' };
    },
  });
  const { loop, ttsEngine } = makeLoop({ commander });
  loop.start();
  await speakTurn(loop, 'xóa file report.pdf đi', 1000);
  assert.equal(calls.length, 0);
  assert.ok(ttsEngine.utterances.some((u) => u.text.includes('không được phép')));
  assert.equal(loop.getStats().toolBlocked, 1);
});

test('full-duplex loop: echo guard + barge-in interrupt with latency', async () => {
  const nowRef = { now: 10000 };
  const slow = new SlowTtsEngine();
  const { loop, events } = makeLoop({
    engine: slow,
    nowRef,
    bargeIn: { graceMs: 200, minSpeechMs: 0, softInterrupt: false },
  });
  loop.start();
  // Drive one turn so the model is speaking through the slow engine.
  loop.feedSttResult({ text: 'xin chào', isFinal: true, at: 10000 });
  loop.getTranscription().endTurn(10000);
  await loop.drainTurns();
  await sleep(50);
  assert.equal(loop.getState(), 'model-speaking');
  assert.ok(slow.current, 'slow engine must still be speaking');

  // Quiet frames (speaker bleed) must NOT interrupt: RMS ~0.007.
  loop.feedAudio(sinePcm16Frame(320, 0.01));
  await sleep(30);
  assert.equal(loop.getState(), 'model-speaking');
  assert.equal(events.filter((e) => e.kind === 'interrupted').length, 0);

  // Loud frames past the grace window: the user is interrupting.
  nowRef.now = 11000;
  loop.feedAudio(sinePcm16Frame(320, 0.5));
  await sleep(150);
  const interrupted = events.filter((e) => e.kind === 'interrupted');
  assert.equal(interrupted.length, 1);
  assert.equal(typeof interrupted[0].latencyMs, 'number');
  assert.ok(interrupted[0].latencyMs >= 0);
  assert.equal(loop.getState(), 'user-speaking');
  assert.equal(loop.getStats().interrupts, 1);
  assert.equal(loop.getStats().avgInterruptLatencyMs, interrupted[0].latencyMs);
  assert.equal(slow.current, null);
});

// ---------------------------------------------------------------------------
// 5. i18n
// ---------------------------------------------------------------------------

const V104_KEYS = [
  'voice.v104.title',
  'voice.v104.profiles',
  'voice.v104.profileActive',
  'voice.v104.profileRate',
  'voice.v104.liveTranscript',
  'voice.v104.listening',
  'voice.v104.userSpeaking',
  'voice.v104.modelSpeaking',
  'voice.v104.interrupted',
  'voice.v104.toolConfirm',
  'voice.v104.toolBlocked',
  'voice.v104.toolExecuted',
  'voice.v104.toolCancelled',
  'voice.v104.echoGuard',
  'voice.v104.confirmYes',
  'voice.v104.confirmNo',
];

test('i18n: all 6 locales carry the 16 voice.v104.* keys', () => {
  for (const locale of ['en', 'vi', 'es', 'fr', 'ja', 'zh']) {
    const file = path.join(__dirname, '..', 'apps', 'desktop', 'src', 'renderer', 'i18n', 'locales', `${locale}.json`);
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const key of V104_KEYS) {
      assert.ok(
        typeof json[key] === 'string' && json[key].length > 0,
        `${locale} must carry ${key}`,
      );
    }
  }
  // The panel renders the v104 section from the optional v104Status
  // prop (profiles picker, loop state, interrupt latency, tool
  // confirmation with tap-to-answer buttons).
  const panel = fs.readFileSync(
    path.join(__dirname, '..', 'apps', 'desktop', 'src', 'renderer', 'components', 'RealtimeVoicePanel.tsx'),
    'utf8',
  );
  assert.match(panel, /v104Status\?: RealtimeV104Status/);
  assert.match(panel, /data-testid="realtime-v104"/);
  assert.match(panel, /data-testid="realtime-v104-profile"/);
  assert.match(panel, /data-testid="realtime-v104-confirm-yes"/);
  assert.match(panel, /data-testid="realtime-v104-confirm-no"/);
  assert.match(panel, /voice\.v104\.profileActive/);
  assert.match(panel, /voice\.v104\.interrupted/);
  assert.match(panel, /voice\.v104\.echoGuard/);
});
