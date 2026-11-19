/**
 * Tests for voice v28 command routing + transcript/summary +
 * multi-voice casting (v1.41, Team T5).
 *
 * Covers the VoiceCommandRouterV28 (English + Vietnamese
 * intents, switch-voice/style with parameters, confirm-first
 * stop, rejected unknown voice), the TranscriptRecorderV28
 * (record/open/append/close, interruptions, extractive
 * summary, JSON + Markdown export) and the VoiceCastingV28
 * (assign/switch/unassign, fallback chains, snapshot,
 * switch history, clone).
 *
 * All offline, deterministic, no key / network / audio.
 * Only the v28 namespace is asserted — no global totals.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TranscriptRecorderV28,
  VoiceCastingV28,
  VoiceCommandRouterV28,
  detectCommandLanguageV28,
  normalizeTranscriptV28,
} from '../packages/core/dist/voiceV28/index.js';

// --- command routing ----------------------------------------------------

test('voice v28 commands: stop is confirm-first unless confirmed', () => {
  const router = new VoiceCommandRouterV28();
  const m = router.route('dừng lại', 0);
  assert.equal(m.kind, 'stop-session');
  assert.equal(m.toolName, 'voice_v28_session');
  assert.deepEqual(m.toolArgs, { action: 'stop' });
  assert.equal(m.execution, 'confirm-first');
  assert.equal(m.confidence, 1.0);
  assert.equal(m.language, 'vi');

  const confirmed = new VoiceCommandRouterV28({ confirmStop: true });
  const m2 = confirmed.route('stop', 0);
  assert.equal(m2.kind, 'stop-session');
  assert.equal(m2.execution, 'direct');
});

test('voice v28 commands: pause / resume / repeat / summarise (en + vi)', () => {
  const router = new VoiceCommandRouterV28();
  assert.equal(router.route('tạm dừng', 0).kind, 'pause-session');
  assert.equal(router.route('pause the session', 10).kind, 'pause-session');
  assert.equal(router.route('tiếp tục', 20).kind, 'resume-session');
  assert.equal(router.route('resume', 30).kind, 'resume-session');
  assert.equal(router.route('nói lại', 40).kind, 'repeat-last');
  assert.equal(router.route('say that again', 50).kind, 'repeat-last');
  const sum = router.route('tóm tắt', 60);
  assert.equal(sum.kind, 'summarise-session');
  assert.equal(sum.toolName, 'voice_v28_transcript');
  assert.equal(router.route('open settings', 70).kind, 'open-settings');
  assert.equal(router.route('mở cài đặt', 80).kind, 'open-settings');
});

test('voice v28 commands: speak slower/faster/softer/louder route to style', () => {
  const router = new VoiceCommandRouterV28();
  const slower = router.route('nói chậm lại', 0);
  assert.equal(slower.kind, 'speak-slower');
  assert.equal(slower.toolName, 'voice_v28_style');
  assert.equal(slower.toolArgs.delta, -0.15);
  assert.equal(router.route('speak faster', 10).kind, 'speak-faster');
  assert.equal(router.route('nói to lên', 20).kind, 'speak-louder');
  assert.equal(router.route('speak softer', 30).kind, 'speak-softer');
});

test('voice v28 commands: switch-style and switch-voice with parameters', () => {
  const router = new VoiceCommandRouterV28({ knownVoices: ['lan', 'mai'] });
  const style = router.route('nói trang trọng hơn', 0);
  assert.equal(style.kind, 'switch-style');
  assert.equal(style.toolArgs.style, 'formal');
  assert.equal(style.toolName, 'voice_v28_style');
  assert.equal(style.execution, 'direct');

  const voice = router.route('đổi giọng Lan', 10);
  assert.equal(voice.kind, 'switch-voice');
  assert.equal(voice.toolArgs.voiceId, 'lan');
  assert.equal(voice.toolName, 'voice_v28_casting');
  assert.equal(voice.execution, 'direct');

  const unknown = router.route('đổi giọng Hùng', 20);
  assert.equal(unknown.kind, 'switch-voice');
  assert.equal(unknown.execution, 'rejected');
  assert.ok((unknown.reason ?? '').includes('unknown voice'));
  assert.equal(router.stats().rejected, 1);
});

test('voice v28 commands: unknown transcript + language detection + log', () => {
  const router = new VoiceCommandRouterV28();
  const m = router.route('hello there, nice weather today', 0);
  assert.equal(m.kind, 'unknown');
  assert.equal(m.confidence, 0);
  assert.equal(m.toolName, null);
  assert.equal(router.stats().unknowns, 1);
  assert.equal(router.route('', 10).kind, 'unknown');
  assert.equal(router.commandLog().length, 2);

  assert.equal(detectCommandLanguageV28('dừng lại đi'), 'vi');
  assert.equal(detectCommandLanguageV28('please stop the session'), 'en');
  assert.equal(detectCommandLanguageV28(''), 'other');
  assert.equal(normalizeTranscriptV28('  Dừng, Lại!  '), 'dừng lại');
  const many = router.routeMany(['pause', 'resume', 'gibberish xyz'], 100);
  assert.deepEqual(many.map((x) => x.kind), ['pause-session', 'resume-session', 'unknown']);
});

// --- transcript + summary -------------------------------------------------

test('voice v28 transcript: record turns, summary counts, top phrases, key sentences', () => {
  const rec = new TranscriptRecorderV28({ sessionId: 't1', botId: 'bot1' });
  rec.recordTurn('user', 'Please deploy the new release to production today.', 0, 2000);
  rec.recordTurn('agent', 'Deploying the release now. The deploy will take five minutes.', 2000, 5000);
  rec.recordTurn('user', 'Thanks, let me know when the deploy finishes.', 5000, 7000, { interrupted: true });
  assert.equal(rec.turnCount, 3);
  assert.equal(rec.interruptionCount, 1);

  const summary = rec.summarise(7000, { style: 'formal', voiceId: 'mock-formal' });
  assert.equal(summary.turns, 3);
  assert.equal(summary.userTurns, 2);
  assert.equal(summary.agentTurns, 1);
  assert.equal(summary.interruptions, 1);
  assert.equal(summary.durationMs, 7000);
  assert.equal(summary.words, 26); // 8 + 10 + 8
  assert.equal(summary.style, 'formal');
  assert.equal(summary.voiceId, 'mock-formal');
  // 'deploy' appears 3x (user turn 1 has 'deploy', agent has 'deploying' + 'deploy', user turn 3 has 'deploy').
  const deploy = summary.topPhrases.find((p) => p.phrase === 'deploy');
  assert.ok(deploy);
  assert.equal(deploy.count, 3);
  // Stopwords never make the list.
  assert.equal(summary.topPhrases.some((p) => p.phrase === 'the'), false);
  assert.equal(summary.keySentences.length, 3);
  assert.ok(summary.keySentences[0].startsWith('Please deploy'));

  const exported = rec.exportJson(7000);
  assert.equal(exported.version, 28);
  assert.equal(exported.sessionId, 't1');
  assert.equal(exported.turns.length, 3);
  assert.equal(exported.summary.turns, 3);

  const md = rec.exportMarkdown(7000);
  assert.ok(md.includes('# Voice session t1'));
  assert.ok(md.includes('## Key sentences'));
  assert.ok(md.includes('## Top phrases'));
  assert.ok(md.includes('### 1. user'));
  assert.ok(md.includes('[interrupted]'));
  assert.ok(md.includes('Please deploy the new release'));
});

test('voice v28 transcript: open/append/close flow + empty session summary', () => {
  const rec = new TranscriptRecorderV28({ sessionId: 't2' });
  const empty = rec.summarise(0);
  assert.equal(empty.turns, 0);
  assert.equal(empty.durationMs, null);
  assert.deepEqual(empty.topPhrases, []);
  assert.deepEqual(empty.keySentences, []);

  const turn = rec.openTurn('user', 100);
  rec.appendText('hello', 150, 'user');
  rec.appendText('world', 200, 'user');
  assert.equal(turn.text, 'hello world');
  assert.equal(rec.open.id, turn.id);
  const closed = rec.closeTurn(300, false);
  assert.equal(closed.durationMs, 200);
  assert.equal(closed.interrupted, false);
  assert.equal(rec.open, null);
  assert.equal(rec.closeTurn(400, false), null); // nothing open
  assert.equal(rec.fullText(), 'user: hello world');

  // Appending with a different speaker closes the old turn and opens a new one.
  rec.appendText('hi there', 500, 'user');
  rec.appendText('hello back', 600, 'agent');
  assert.equal(rec.turnCount, 3);
  assert.equal(rec.turnsBySpeaker('agent').length, 1);
});

// --- casting ---------------------------------------------------------------

test('voice v28 casting: assign, resolve, switch, unassign, snapshot', () => {
  const casting = new VoiceCastingV28();
  assert.deepEqual(casting.assignments('bot1'), []);
  const a = casting.assign('bot1', 'narrator', 'voice-a', 100);
  assert.equal(a.voiceId, 'voice-a');
  assert.equal(a.switches, 0);
  assert.equal(casting.voiceFor('bot1', 'narrator').voiceId, 'voice-a');
  assert.equal(casting.voiceFor('bot1', 'narrator').fallbackUsed, false);
  // No assignment -> builtin default voice for the role.
  assert.equal(casting.voiceFor('bot1', 'assistant').voiceId, 'mock-default');
  assert.equal(casting.voiceFor('bot1', 'assistant').assignedVoiceId, null);

  const switched = casting.switchRole('bot1', 'narrator', 'voice-b', 200, 'user asked');
  assert.equal(switched.voiceId, 'voice-b');
  assert.equal(switched.switches, 1);
  assert.equal(switched.lastSwitchedAtMs, 200);
  assert.equal(casting.switchEvents('bot1').length, 2);
  assert.equal(casting.switchEvents('bot1')[1].reason, 'user asked');

  assert.equal(casting.unassign('bot1', 'narrator', 300), true);
  // Unassigned: the fallback chain speaks (first available),
  // not the builtin default (which is last in the chain).
  assert.equal(casting.voiceFor('bot1', 'narrator').voiceId, 'mock-storyteller');
  assert.equal(casting.voiceFor('bot1', 'narrator').fallbackUsed, true);
  assert.equal(casting.unassign('bot1', 'narrator', 400), false);

  const snap = casting.snapshot('bot1');
  assert.equal(snap.botId, 'bot1');
  assert.equal(snap.roles.narrator.voiceId, 'mock-storyteller');
  assert.equal(snap.roles.narrator.switches, 0); // unassigned: no assignment left
  assert.equal(snap.switchEvents.length, 3);
});

test('voice v28 casting: fallback chain when the assigned voice is unavailable', () => {
  const casting = new VoiceCastingV28({ isAvailable: (v) => v !== 'voice-gone' });
  casting.assign('bot1', 'assistant', 'voice-gone', 0);
  const resolved = casting.voiceFor('bot1', 'assistant');
  assert.equal(resolved.fallbackUsed, true);
  assert.equal(resolved.assignedVoiceId, 'voice-gone');
  assert.equal(resolved.voiceId, 'mock-default'); // first available in the chain
  assert.ok(resolved.reason.includes('unavailable'));

  const noneAvailable = new VoiceCastingV28({ isAvailable: () => false });
  noneAvailable.assign('bot1', 'alert', 'voice-x', 0);
  const last = noneAvailable.voiceFor('bot1', 'alert');
  assert.equal(last.voiceId, 'mock-alert'); // builtin default, always returned
  assert.equal(last.fallbackUsed, true);
});

test('voice v28 casting: clone cast + remove bot', () => {
  const casting = new VoiceCastingV28();
  casting.assign('bot1', 'assistant', 'voice-a', 0);
  casting.assign('bot1', 'narrator', 'voice-b', 10);
  const cloned = casting.cloneCast('bot1', 'bot2', 100);
  assert.equal(cloned.length, 2);
  assert.equal(casting.voiceFor('bot2', 'assistant').voiceId, 'voice-a');
  assert.equal(casting.voiceFor('bot2', 'narrator').voiceId, 'voice-b');
  assert.deepEqual(casting.cloneCast('bot-none', 'bot3', 200), []);
  assert.equal(casting.removeBot('bot2'), true);
  assert.equal(casting.voiceFor('bot2', 'assistant').voiceId, 'mock-default');
  assert.equal(casting.removeBot('bot2'), false);
  assert.throws(() => casting.assign('', 'assistant', 'v', 0), /botId/);
  assert.throws(() => casting.assign('b', 'singer', 'v', 0), /unknown cast role/);
});
