/**
 * Tests for v1.27 — voice realtime v19 (Team T5).
 *
 * NOTE ON NUMBERING: the wave brief asked for "voice realtime v24,
 * continuing v23", but the code on base merge/v126 tops out at voice
 * v18 — there is no v19–v24 in the tree. v19 is the correct next
 * number, and these tests pin it.
 *
 *   1. Session manager v19 (sessionV19.ts): options validation;
 *      create → idle snapshot (age/idle/expiresIn/expiresBy);
 *      connect → listening; duplicate create + max-sessions throw;
 *      tick + sweep expires by idle-timeout and by max-duration
 *      (and never re-expires a closed session); close keeps the
 *      record, delete drops it; UI-sync subscribe receives
 *      created/connected/expired; export → delete → restore
 *      re-applies the v18 resume token; stats/summary/markdown.
 *   2. Prosody v19 (prosodyV19.ts): presets differ per emotion;
 *      context → emotion defaults; override clamping (rate 5 →
 *      2.0, pitch -30 → -12); clause splitting (sentences + long
 *      comma sentences); plan pauses (first/last) + timing;
 *      SSML rendering + XML escaping; controller emotion/context/
 *      override/history.
 *   3. Open-turn resume v19 (turnResumeV19.ts): segment dedupe
 *      (same seq, exact duplicate, overlap merge); merged text;
 *      interrupt snapshots spoken prefix + remaining; request →
 *      confirm (resume / restart / summarise / drop) / decline;
 *      confirm without request is refused; confirmation expiry
 *      via tick; export/import round trip (imported open turn
 *      comes back interrupted).
 *   4. Voice eval v19 (voiceEvalV19.ts): naturalness + clarity
 *      scoring (flat pitch is neutral, not bad; breathless
 *      single clause scores low; numbers/acronyms/URLs hurt
 *      clarity); the default eval passes end to end; baseline
 *      comparison flags regressions beyond tolerance only.
 *   5. Tools (voiceV19Tools.ts): 13 tools, unique names, full
 *      lifecycle through the tools (create → list → snapshot →
 *      prosody → turn save/interrupt/resume → eval run/compare →
 *      sweep → close → delete → restore).
 *   6. Core root re-exports + i18n: v19 classes importable from
 *      `@open-bot/core`; 48 `voice.realtime.v19.*` keys in all 6
 *      locales, non-empty, same key set everywhere.
 *
 * No network, no sound card, no live provider, no key. Every audio
 * path is mock (synthetic PCM frames, scripted replies, mock TTS).
 * Run after building core + tools:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/voice-v127.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  VoiceSessionManagerV19,
  createVoiceSessionManagerV19,
  defaultVoiceSessionV19Options,
  validateVoiceSessionV19Options,
  mapV18StateToV19,
  ProsodyControllerV19,
  createProsodyControllerV19,
  defaultProsodyV19Settings,
  presetProsodyV19Settings,
  defaultEmotionForContextV19,
  validateProsodyV19Settings,
  clampProsodyV19Settings,
  applyProsodyV19Override,
  estimateProsodyV19Ms,
  splitProsodyV19Clauses,
  applyProsodyToTextV19,
  prosodySsmlV19,
  prosodyPlanStatsV19,
  OpenTurnStoreV19,
  createOpenTurnStoreV19,
  textOverlapV19,
  mergeSegmentsV19,
  summariseSpokenV19,
  VoiceEvalV19,
  createVoiceEvalV19,
  defaultVoiceEvalV19Scenarios,
  runDefaultVoiceEvalV19,
  scoreNaturalnessV19,
  scoreClarityV19,
  compareWithBaselineV19,
} from '../packages/core/dist/voiceV19/index.js';
import {
  createVoiceV19Tools,
  VOICE_V19_TOOLS,
  VOICE_V19_TOOL_NAMES,
  isVoiceV19ToolName,
} from '../packages/tools/dist/voiceV19Tools.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --------------------------------------------------------------------- session

test('session v19: options validation', () => {
  assert.deepEqual(validateVoiceSessionV19Options({}), []);
  assert.deepEqual(defaultVoiceSessionV19Options(), {
    maxSessionMs: 1_800_000,
    maxIdleMs: 300_000,
    maxSessions: 20,
    maxTombstones: 20,
  });
  assert.ok(validateVoiceSessionV19Options({ maxSessionMs: 0 }).length > 0);
  assert.ok(validateVoiceSessionV19Options({ maxIdleMs: 999 }).length > 0);
  assert.ok(validateVoiceSessionV19Options({ maxSessions: 0 }).length > 0);
  assert.throws(
    () => createVoiceSessionManagerV19({ maxSessionMs: -5 }),
    /invalid voice session v19 options/,
  );
});

test('session v19: map v18 state to v19 UI state', () => {
  assert.equal(mapV18StateToV19('idle', 'connected', false), 'idle');
  assert.equal(mapV18StateToV19('listening', 'connected', false), 'listening');
  assert.equal(mapV18StateToV19('thinking', 'connected', false), 'listening');
  assert.equal(mapV18StateToV19('speaking', 'connected', false), 'speaking');
  assert.equal(mapV18StateToV19('interrupted', 'connected', false), 'interrupted');
  assert.equal(mapV18StateToV19('speaking', 'closed', false), 'closed');
  assert.equal(mapV18StateToV19('idle', 'connected', true), 'closed');
});

test('session v19: create → idle snapshot, connect → listening', async () => {
  const manager = createVoiceSessionManagerV19({ maxSessionMs: 60_000, maxIdleMs: 30_000 });
  assert.equal(manager.now(), 0);
  const session = manager.create('s1', { botId: 'bot-a', language: 'vi' });
  assert.equal(session.id, 's1');
  const snap = manager.uiSnapshot('s1');
  assert.ok(snap);
  assert.equal(snap.state, 'idle');
  assert.equal(snap.botId, 'bot-a');
  assert.equal(snap.language, 'vi');
  assert.equal(snap.ageMs, 0);
  assert.equal(snap.idleMs, 0);
  assert.equal(snap.expiresInMs, 30_000);
  assert.equal(snap.expiresBy, 'idle');
  assert.equal(snap.hasResumeToken, false);
  assert.equal(manager.liveCount(), 1);
  assert.equal(manager.count(), 1);

  await manager.connect('s1');
  const after = manager.uiSnapshot('s1');
  assert.equal(after.state, 'listening');
  assert.equal(after.connection, 'connected');

  assert.throws(() => manager.create('s1'), /already exists/);
  assert.throws(() => manager.create(''), /non-empty string/);
  assert.equal(manager.uiSnapshot('nope'), undefined);
  assert.equal(manager.record('nope'), undefined);
});

test('session v19: max-sessions limit throws', () => {
  const manager = createVoiceSessionManagerV19({ maxSessions: 2 });
  manager.create('a');
  manager.create('b');
  assert.throws(() => manager.create('c'), /limit reached/);
  manager.close('a');
  manager.create('c');
  assert.equal(manager.liveCount(), 2);
});

test('session v19: sweep expires by idle-timeout, then by max-duration', async () => {
  const manager = createVoiceSessionManagerV19({ maxSessionMs: 10_000, maxIdleMs: 5_000 });
  manager.create('idle-one');
  manager.create('long-one');
  await manager.connect('idle-one');
  // 6 s of silence: idle-one is past the idle limit, long-one too
  // (both were created at 0 and never did anything).
  manager.tick(6_000);
  const report = manager.sweep();
  assert.equal(report.examined, 2);
  assert.equal(report.expired.length, 2);
  assert.deepEqual(
    report.expired.map((e) => e.reason),
    ['idle-timeout', 'idle-timeout'],
  );
  assert.equal(manager.uiSnapshot('idle-one').state, 'expired');
  assert.equal(manager.stats().expired, 2);
  assert.equal(manager.stats().totalSwept, 2);
  // A second sweep reaps nothing (expired sessions are not re-expired).
  assert.equal(manager.sweep().expired.length, 0);

  const manager2 = createVoiceSessionManagerV19({ maxSessionMs: 10_000, maxIdleMs: 60_000 });
  manager2.create('durable');
  await manager2.connect('durable');
  manager2.tick(9_000);
  assert.equal(manager2.sweep().expired.length, 0);
  // Activity resets the idle clock but not the duration clock.
  manager2.get('durable').feedTranscriptFinal('xin chào');
  manager2.tick(2_000);
  const report2 = manager2.sweep();
  assert.equal(report2.expired.length, 1);
  assert.equal(report2.expired[0].reason, 'max-duration');
});

test('session v19: close keeps the record, delete drops it, sweep skips closed', async () => {
  const manager = createVoiceSessionManagerV19({ maxSessionMs: 1_000, maxIdleMs: 1_000 });
  manager.create('x');
  await manager.connect('x');
  assert.equal(manager.close('x'), true);
  assert.equal(manager.close('x'), false);
  assert.equal(manager.uiSnapshot('x').state, 'closed');
  assert.equal(manager.uiSnapshot('x').closeReason, 'client-close');
  manager.tick(5_000);
  assert.equal(manager.sweep().expired.length, 0);
  assert.equal(manager.uiSnapshot('x').state, 'closed');
  assert.equal(manager.delete('x'), true);
  assert.equal(manager.delete('x'), false);
  assert.equal(manager.uiSnapshot('x'), undefined);
  assert.equal(manager.close('nope'), false);
});

test('session v19: UI-sync subscribe receives lifecycle events', async () => {
  const manager = createVoiceSessionManagerV19({ maxSessionMs: 1_000, maxIdleMs: 1_000 });
  const seen = [];
  const unsubscribe = manager.subscribe((event) => seen.push(event));
  manager.create('sub-1');
  await manager.connect('sub-1');
  manager.tick(2_000);
  manager.sweep();
  assert.ok(seen.some((e) => e.kind === 'created' && e.sessionId === 'sub-1'));
  assert.ok(seen.some((e) => e.kind === 'connected' && e.sessionId === 'sub-1'));
  assert.ok(seen.some((e) => e.kind === 'expired' && e.sessionId === 'sub-1'));
  assert.ok(seen.every((e) => typeof e.atMs === 'number' && typeof e.state === 'string'));
  unsubscribe();
  manager.create('sub-2');
  assert.equal(seen.filter((e) => e.sessionId === 'sub-2').length, 0);
  assert.ok(manager.eventsList().length >= seen.length);
});

test('session v19: export → delete → restore re-applies the resume token', async () => {
  const manager = createVoiceSessionManagerV19();
  const session = manager.create('r1', { botId: 'bot-r', language: 'vi' });
  await manager.connect('r1');
  session.feedTranscriptFinal('Xin chào, hôm nay trời đẹp.');
  await Promise.resolve();
  await Promise.resolve();
  assert.ok(session.turnsList().length >= 1);
  const exported = manager.exportSession('r1');
  assert.ok(exported);
  assert.equal(exported.version, 1);
  assert.equal(exported.botId, 'bot-r');
  assert.ok(exported.resumeToken);
  assert.ok(exported.lastCheckpoint);
  assert.equal(manager.delete('r1'), true);

  const restored = manager.restore(exported);
  assert.ok(restored);
  assert.equal(restored.id, 'r1');
  assert.equal(manager.stats().totalRestored, 1);
  assert.equal(manager.uiSnapshot('r1').state, 'idle');
  assert.ok(restored.lastCheckpoint());
  assert.equal(restored.lastCheckpoint().turnId, exported.lastCheckpoint.turnId);
  // Restoring the same export twice, or a bogus export, refuses.
  assert.equal(manager.restore(exported), undefined);
  assert.equal(manager.restore({ version: 2, id: 'bad' }), undefined);
  assert.equal(manager.restore(null), undefined);
  // Restoring into a fresh manager works too (crash recovery).
  const manager2 = createVoiceSessionManagerV19();
  const restored2 = manager2.restore(exported);
  assert.ok(restored2);
  assert.equal(manager2.stats().totalRestored, 1);
});

test('session v19: stats, summary, markdown', async () => {
  const manager = createVoiceSessionManagerV19();
  manager.create('m1');
  manager.create('m2');
  await manager.connect('m1');
  manager.close('m2');
  const stats = manager.stats();
  assert.equal(stats.live, 1);
  assert.equal(stats.closed, 1);
  assert.equal(stats.totalCreated, 2);
  assert.match(manager.summary(), /1 live, 1 closed/);
  const md = manager.markdown();
  assert.match(md, /## Voice sessions v19/);
  assert.match(md, /\| m1 \| listening \|/);
  assert.match(md, /\| m2 \| closed \|/);
  assert.equal(manager.uiSnapshots().length, 2);
  assert.equal(manager.uiSnapshots()[0].id, 'm1');
});

// --------------------------------------------------------------------- prosody

test('prosody v19: presets differ per emotion, context has a default emotion', () => {
  const calm = presetProsodyV19Settings('calm');
  const urgent = presetProsodyV19Settings('urgent');
  const neutral = presetProsodyV19Settings('neutral');
  assert.ok(urgent.rate > calm.rate);
  assert.ok(urgent.pitchSt > calm.pitchSt);
  assert.ok(urgent.pauseAfterMs < calm.pauseAfterMs);
  assert.equal(neutral.rate, 1.0);
  assert.equal(neutral.pitchSt, 0);
  assert.deepEqual(defaultProsodyV19Settings(), neutral);
  assert.equal(defaultEmotionForContextV19('alert'), 'urgent');
  assert.equal(defaultEmotionForContextV19('announcement'), 'formal');
  assert.equal(defaultEmotionForContextV19('narration'), 'calm');
  assert.equal(defaultEmotionForContextV19('whisper'), 'calm');
  assert.equal(defaultEmotionForContextV19('chat'), 'neutral');
});

test('prosody v19: validation + clamping', () => {
  assert.deepEqual(validateProsodyV19Settings(defaultProsodyV19Settings()), []);
  assert.ok(validateProsodyV19Settings({ ...defaultProsodyV19Settings(), rate: 3 }).length > 0);
  assert.ok(validateProsodyV19Settings({ ...defaultProsodyV19Settings(), emphasis: 'wild' }).length > 0);
  const clamped = clampProsodyV19Settings({
    ...defaultProsodyV19Settings(),
    rate: 5,
    pitchSt: -30,
    pauseBeforeMs: -10,
    volumeDb: 99,
    emphasis: 'wild',
  });
  assert.equal(clamped.rate, 2.0);
  assert.equal(clamped.pitchSt, -12);
  assert.equal(clamped.pauseBeforeMs, 0);
  assert.equal(clamped.volumeDb, 6);
  assert.equal(clamped.emphasis, 'none');
  const merged = applyProsodyV19Override(defaultProsodyV19Settings(), { rate: 1.5 });
  assert.equal(merged.rate, 1.5);
  assert.equal(merged.pitchSt, 0);
});

test('prosody v19: clause splitting', () => {
  assert.deepEqual(splitProsodyV19Clauses(''), []);
  assert.deepEqual(splitProsodyV19Clauses('   '), []);
  assert.deepEqual(splitProsodyV19Clauses('Xin chào.'), ['Xin chào.']);
  const two = splitProsodyV19Clauses('Xin chào. Hôm nay trời đẹp lắm!');
  assert.equal(two.length, 2);
  // Long comma sentence splits at commas.
  const long =
    'Buổi họp bắt đầu lúc chín giờ sáng, với ba nội dung chính là tổng kết tuần, kế hoạch tuần tới, và phân công nhiệm vụ cho từng nhóm, trong đó nhóm của bạn phụ trách phần trình bày cuối cùng.';
  assert.ok(splitProsodyV19Clauses(long).length >= 3);
  // Short comma sentence stays whole.
  assert.equal(splitProsodyV19Clauses('Tôi thích cà phê, trà và nước lọc.').length, 1);
});

test('prosody v19: plan pauses + timing, faster rate is shorter', () => {
  const settings = presetProsodyV19Settings('calm');
  const segments = applyProsodyToTextV19('Xin chào. Hôm nay trời đẹp.', settings);
  assert.equal(segments.length, 2);
  assert.equal(segments[0].pauseBeforeMs, settings.pauseBeforeMs);
  assert.equal(segments[0].pauseAfterMs, settings.clausePauseMs);
  assert.equal(segments[1].pauseAfterMs, settings.pauseAfterMs);
  assert.ok(segments.every((s) => s.estimatedMs > 0));
  const stats = prosodyPlanStatsV19(segments);
  assert.equal(stats.segments, 2);
  assert.ok(stats.estimatedTotalMs > stats.estimatedSpeechMs);
  assert.equal(stats.rateDeviation, 0);
  assert.ok(estimateProsodyV19Ms(140, 2.0) < estimateProsodyV19Ms(140, 0.5));
  assert.equal(estimateProsodyV19Ms(0, 1.0), 0);
  assert.deepEqual(prosodyPlanStatsV19([]).segments, 0);
});

test('prosody v19: SSML rendering + escaping', () => {
  const ssml = prosodySsmlV19('Xin chào & hẹn gặp lại.', presetProsodyV19Settings('happy'));
  assert.match(ssml, /^<speak>/);
  assert.match(ssml, /<\/speak>$/);
  assert.match(ssml, /<prosody rate="112%" pitch="\+3st">/);
  assert.match(ssml, /<break time="\d+ms"\/>/);
  assert.match(ssml, /Xin chào &amp; hẹn gặp lại\./);
  assert.ok(!ssml.includes(' & '));
  const escaped = prosodySsmlV19('a <b> "c"', defaultProsodyV19Settings());
  assert.match(escaped, /a &lt;b&gt; &quot;c&quot;/);
  assert.equal(prosodySsmlV19('   ', defaultProsodyV19Settings()), '<speak></speak>');
  const strong = prosodySsmlV19('Cẩn thận!', presetProsodyV19Settings('urgent'));
  assert.match(strong, /<emphasis level="strong">/);
});

test('prosody v19: controller emotion / context / override / history', () => {
  const controller = createProsodyControllerV19({ context: 'chat' });
  assert.equal(controller.getEmotion(), 'neutral');
  controller.setContext('alert');
  assert.equal(controller.getContext(), 'alert');
  assert.equal(controller.getEmotion(), 'urgent');
  controller.setEmotion('calm');
  assert.equal(controller.resolve().rate, presetProsodyV19Settings('calm').rate);
  controller.setOverride({ rate: 1.5, pitchSt: 2 });
  assert.equal(controller.resolve().rate, 1.5);
  assert.equal(controller.resolve().pitchSt, 2);
  controller.clearOverride();
  assert.equal(controller.resolve().rate, presetProsodyV19Settings('calm').rate);
  assert.throws(() => controller.setEmotion('wild'), /Unknown prosody emotion/);
  assert.throws(() => controller.setContext('weird'), /Unknown voice context/);

  const plan = controller.plan('Xin chào. Hôm nay trời đẹp.');
  assert.equal(plan.segments.length, 2);
  assert.ok(plan.stats.estimatedTotalMs > 0);
  assert.match(controller.ssml('Xin chào.'), /<speak>/);
  assert.match(controller.summary(), /prosody v19: calm \(alert\)/);
  assert.match(controller.markdown(), /## Prosody v19/);

  // History is bounded at 50.
  for (let i = 0; i < 60; i += 1) controller.resolve();
  assert.equal(controller.historyList().length, 50);
});

// ------------------------------------------------------------------ turn resume

test('turn resume v19: text overlap + merge', () => {
  assert.equal(textOverlapV19('Tôi đang nói', 'nói dở câu'), 3);
  assert.equal(textOverlapV19('abc', 'xyz'), 0);
  assert.equal(textOverlapV19('', 'abc'), 0);
  assert.equal(mergeSegmentsV19([]), '');
  const merged = mergeSegmentsV19([
    { seq: 1, turnId: 't', speaker: 'user', text: 'Tôi đang nói', startMs: 0, endMs: 500, final: false },
    { seq: 2, turnId: 't', speaker: 'user', text: 'nói dở câu này', startMs: 500, endMs: 1000, final: true },
  ]);
  assert.equal(merged, 'Tôi đang nói dở câu này');
  // Same seq: the final fragment wins; a replayed flush is dropped.
  const deduped = mergeSegmentsV19([
    { seq: 1, turnId: 't', speaker: 'user', text: 'Xin', startMs: 0, endMs: 200, final: false },
    { seq: 1, turnId: 't', speaker: 'user', text: 'Xin chào', startMs: 0, endMs: 400, final: true },
    { seq: 2, turnId: 't', speaker: 'user', text: 'Xin chào', startMs: 400, endMs: 600, final: true },
  ]);
  assert.equal(deduped, 'Xin chào');
  assert.equal(summariseSpokenV19(''), '');
  assert.equal(summariseSpokenV19('Ngắn thôi.'), 'Ngắn thôi.');
  assert.ok(summariseSpokenV19('a'.repeat(200)).endsWith('…'));
  assert.ok(summariseSpokenV19('a'.repeat(200)).length <= 121);
});

test('turn resume v19: append dedupes same-seq, exact duplicate, overlap', () => {
  const store = createOpenTurnStoreV19();
  store.openTurn('turn-1', 's1');
  const first = store.appendSegment({ seq: 1, turnId: 'turn-1', speaker: 'user', text: 'Tôi đang nói', startMs: 0, endMs: 500, final: false });
  assert.equal(first.accepted, true);
  assert.equal(first.deduped, 'none');
  const replay = store.appendSegment({ seq: 1, turnId: 'turn-1', speaker: 'user', text: 'Tôi đang nói', startMs: 0, endMs: 500, final: false });
  assert.equal(replay.accepted, false);
  assert.equal(replay.deduped, 'same-seq');
  const overlap = store.appendSegment({ seq: 2, turnId: 'turn-1', speaker: 'user', text: 'nói dở câu này', startMs: 500, endMs: 1000, final: true });
  assert.equal(overlap.accepted, true);
  assert.equal(overlap.deduped, 'overlap-merged');
  assert.equal(overlap.mergedText, 'Tôi đang nói dở câu này');
  const dup = store.appendSegment({ seq: 3, turnId: 'turn-1', speaker: 'user', text: 'Tôi đang nói', startMs: 1000, endMs: 1200, final: false });
  assert.equal(dup.accepted, false);
  assert.equal(dup.deduped, 'exact-duplicate');
  const empty = store.appendSegment({ seq: 4, turnId: 'turn-1', speaker: 'user', text: '   ', startMs: 1200, endMs: 1300, final: false });
  assert.equal(empty.accepted, false);
  const stats = store.stats();
  assert.equal(stats.duplicatesDropped, 2);
  assert.equal(stats.overlapsMerged, 1);
  assert.equal(stats.segments, 2);
});

test('turn resume v19: interrupt → request → confirm resume keeps the cut point', () => {
  const store = createOpenTurnStoreV19();
  store.openTurn('t1', 's1');
  store.appendSegment({ seq: 1, turnId: 't1', speaker: 'user', text: 'Tôi muốn hỏi về', startMs: 0, endMs: 400, final: false });
  store.appendSegment({ seq: 2, turnId: 't1', speaker: 'user', text: 'về kế hoạch ngày mai', startMs: 400, endMs: 900, final: true });
  const reply = 'Ngày mai bạn có ba việc cần làm: kiểm tra email, họp lúc mười giờ, và gửi báo cáo cuối ngày.';
  store.setReply('t1', reply, 20);
  const interrupted = store.interruptTurn('t1', 'network-lost');
  assert.ok(interrupted);
  assert.equal(interrupted.state, 'interrupted');
  assert.equal(interrupted.interruptReason, 'network-lost');
  assert.equal(interrupted.userText, 'Tôi muốn hỏi về kế hoạch ngày mai');
  assert.equal(interrupted.spokenChars, 20);
  assert.equal(interrupted.remainingText, reply.slice(20));
  // Confirming before requesting is refused.
  assert.equal(store.confirmResume('t1', 'resume'), undefined);
  const confirmation = store.requestResume('t1');
  assert.ok(confirmation);
  assert.equal(confirmation.turnId, 't1');
  assert.match(confirmation.question, /mất mạng/);
  assert.match(confirmation.question, /Tôi muốn hỏi về kế hoạch ngày mai/);
  assert.deepEqual([...confirmation.actions], ['resume', 'restart', 'summarise', 'drop']);
  assert.equal(store.getTurn('t1').state, 'awaiting-confirmation');
  // Requesting twice is refused (no longer interrupted).
  assert.equal(store.requestResume('t1'), undefined);
  const plan = store.confirmResume('t1', 'resume');
  assert.ok(plan);
  assert.equal(plan.action, 'resume');
  assert.equal(plan.speakText, reply.slice(20));
  assert.equal(plan.resumeAtChars, 20);
  assert.equal(plan.userText, 'Tôi muốn hỏi về kế hoạch ngày mai');
  assert.equal(store.getTurn('t1').state, 'resumed');
  const done = store.completeTurn('t1');
  assert.equal(done.state, 'completed');
});

test('turn resume v19: confirm restart / summarise / drop + decline', () => {
  const store = createOpenTurnStoreV19();
  const reply = 'Đây là một câu trả lời khá dài để kiểm tra việc tóm tắt phần đã nói trước khi tiếp tục phần còn lại.';
  const setup = (id) => {
    store.openTurn(id, 's1');
    store.appendSegment({ seq: 1, turnId: id, speaker: 'user', text: 'Hỏi gì đó', startMs: 0, endMs: 300, final: true });
    store.setReply(id, reply, 30);
    store.interruptTurn(id, 'crash');
    store.requestResume(id);
  };
  setup('r-restart');
  const restart = store.confirmResume('r-restart', 'restart');
  assert.equal(restart.speakText, reply);
  assert.equal(restart.resumeAtChars, 0);

  setup('r-sum');
  const sum = store.confirmResume('r-sum', 'summarise');
  assert.ok(sum.summary);
  assert.match(sum.summary, /^Đã nói: /);
  assert.equal(sum.speakText, reply.slice(30));

  setup('r-drop');
  const drop = store.confirmResume('r-drop', 'drop');
  assert.equal(drop.speakText, '');
  assert.equal(store.getTurn('r-drop').state, 'dropped');

  setup('r-decline');
  const declined = store.declineResume('r-decline');
  assert.equal(declined.state, 'dropped');
  assert.equal(declined.resumeAction, 'drop');
  // Declining a turn that is not awaiting confirmation is refused.
  assert.equal(store.declineResume('r-decline'), undefined);
  assert.equal(store.interruptTurn('nope', 'crash'), undefined);
  assert.equal(store.requestResume('nope'), undefined);
});

test('turn resume v19: confirmation expires back to interrupted', () => {
  const store = createOpenTurnStoreV19({ confirmTimeoutMs: 5_000 });
  store.openTurn('exp', 's1');
  store.appendSegment({ seq: 1, turnId: 'exp', speaker: 'user', text: 'Chào', startMs: 0, endMs: 200, final: true });
  store.interruptTurn('exp', 'timeout');
  store.requestResume('exp');
  assert.equal(store.getTurn('exp').state, 'awaiting-confirmation');
  store.tick(4_000);
  assert.equal(store.getTurn('exp').state, 'awaiting-confirmation');
  store.tick(2_000);
  assert.equal(store.getTurn('exp').state, 'interrupted');
  assert.equal(store.stats().confirmationsExpired, 1);
  // The turn is not lost: it can be requested again.
  assert.ok(store.requestResume('exp'));
});

test('turn resume v19: export/import round trip, open turns come back interrupted', () => {
  const store = createOpenTurnStoreV19();
  store.openTurn('imp', 's1');
  store.appendSegment({ seq: 1, turnId: 'imp', speaker: 'user', text: 'Nửa câu', startMs: 0, endMs: 300, final: false });
  const exported = store.exportTurn('imp');
  assert.ok(exported);
  const store2 = createOpenTurnStoreV19();
  assert.equal(store2.importTurn(exported), true);
  assert.equal(store2.importTurn(exported), false);
  const imported = store2.getTurn('imp');
  assert.equal(imported.state, 'interrupted');
  assert.equal(imported.userText, 'Nửa câu');
  assert.equal(store2.importTurn({ id: '', state: 'open' }), false);
  assert.equal(store2.importTurn({ id: 'x', state: 'weird' }), false);
  assert.match(store.summary(), /open-turn resume v19/);
  assert.match(store.markdown(), /## Open-turn resume v19/);
  assert.equal(store.listOpenTurns().length, 1);
});

// ------------------------------------------------------------------------- eval

test('eval v19: naturalness scoring', () => {
  const calm = scoreNaturalnessV19(
    'Chào bạn, tôi đã nghe rõ. Bạn cứ nói chậm thôi.',
    presetProsodyV19Settings('calm'),
  );
  assert.ok(calm.naturalness >= 0.7, `calm greeting should be natural, got ${calm.naturalness}`);
  assert.equal(calm.pausePlacement, 1);
  assert.equal(calm.pitchUse, 1);
  // Flat pitch (formal, 0st) is neutral, not bad.
  const formal = scoreNaturalnessV19(
    'Buổi họp bắt đầu lúc chín giờ sáng.',
    presetProsodyV19Settings('formal'),
  );
  assert.equal(formal.pitchUse, 0.5);
  assert.ok(formal.naturalness >= 0.7);
  // One long breathless clause scores low on pause placement.
  const breathless = scoreNaturalnessV19(
    'a'.repeat(160),
    presetProsodyV19Settings('neutral'),
  );
  assert.equal(breathless.segments, 1);
  assert.ok(breathless.pausePlacement < 0.7);
  assert.ok(breathless.naturalness < 0.7);
});

test('eval v19: clarity scoring', () => {
  const plain = scoreClarityV19('Xin chào, hôm nay trời đẹp và chúng ta sẽ đi dạo.');
  assert.ok(plain.clarity >= 0.9, `plain text should be clear, got ${plain.clarity}`);
  assert.equal(plain.hardTokens, 0);
  const hard = scoreClarityV19('Xem https://example.com/x?v=123 lúc 09:30 với mã ABC123 và từ supercalifragilistic dài ngoằng');
  assert.ok(hard.hardTokens >= 3, `expected hard tokens, got ${hard.hardTokens}`);
  assert.ok(hard.clarity < plain.clarity);
  assert.equal(scoreClarityV19('').clarity, 0);
  assert.equal(scoreClarityV19('').tokens, 0);
});

test('eval v19: default eval passes end to end', async () => {
  const report = await runDefaultVoiceEvalV19();
  assert.equal(report.passed, true);
  assert.deepEqual(report.failures, []);
  assert.equal(report.naturalness.cases.length, 4);
  assert.equal(report.clarity.cases.length, 4);
  assert.equal(report.turnTaking.cases.length, 2);
  assert.equal(report.bargeIn.cases.length, 2);
  assert.ok(report.naturalness.mean >= 0.7);
  assert.ok(report.clarity.mean >= 0.7);
  assert.ok(report.turnTaking.meanMs <= 1200);
  assert.equal(report.bargeIn.f1, 1);
  assert.ok(report.tts.meanFirstChunkMs <= 300);
  const direct = await createVoiceEvalV19().runAll();
  assert.equal(direct.passed, true);
  assert.throws(() => createVoiceEvalV19({ minNaturalness: 2 }), /invalid voice eval v19 options/);
});

test('eval v19: baseline comparison flags regressions beyond tolerance only', async () => {
  const baseline = await runDefaultVoiceEvalV19();
  const same = compareWithBaselineV19(baseline, baseline);
  assert.equal(same.length, 5);
  assert.ok(same.every((r) => r.regressed === false));
  assert.ok(same.every((r) => r.delta === 0));
  const worse = JSON.parse(JSON.stringify(baseline));
  worse.naturalness.mean = baseline.naturalness.mean - 0.2;
  worse.turnTaking.meanMs = (baseline.turnTaking.meanMs ?? 0) + 500;
  const flagged = compareWithBaselineV19(worse, baseline, 0.05);
  const byDim = new Map(flagged.map((r) => [r.dimension, r]));
  assert.equal(byDim.get('naturalness').regressed, true);
  assert.equal(byDim.get('turnTakingMs').regressed, true);
  assert.equal(byDim.get('clarity').regressed, false);
  assert.equal(byDim.get('bargeInF1').regressed, false);
  // A small wobble inside tolerance is not a regression.
  const wobble = JSON.parse(JSON.stringify(baseline));
  wobble.clarity.mean = baseline.clarity.mean - 0.01;
  const wobbled = compareWithBaselineV19(wobble, baseline, 0.05);
  assert.equal(wobbled.find((r) => r.dimension === 'clarity').regressed, false);
  assert.ok(defaultVoiceEvalV19Scenarios().voice.length >= 4);
});

// ------------------------------------------------------------------------ tools

test('tools v19: 13 tools, unique names, full lifecycle', async () => {
  const tools = createVoiceV19Tools();
  assert.equal(tools.length, 13);
  assert.deepEqual(tools.map((t) => t.definition.name), [...VOICE_V19_TOOL_NAMES]);
  assert.equal(new Set(VOICE_V19_TOOL_NAMES).size, 13);
  for (const name of VOICE_V19_TOOL_NAMES) assert.equal(isVoiceV19ToolName(name), true);
  assert.equal(isVoiceV19ToolName('voice_v18_session_create'), false);
  assert.equal(VOICE_V19_TOOLS.length, 13);
  const byName = new Map(tools.map((t) => [t.definition.name, t]));
  const run = async (name, args) => JSON.parse(await byName.get(name).execute(args));

  const created = await run('voice_v19_session_create', { sessionId: 't1', language: 'vi', mockReply: 'Chào bạn.', connect: true });
  assert.equal(created.created, true);
  assert.equal(created.snapshot.state, 'listening');
  const listed = await run('voice_v19_session_list', {});
  assert.equal(listed.sessions.length, 1);
  assert.equal(listed.stats.live, 1);
  const snap = await run('voice_v19_session_snapshot', { sessionId: 't1' });
  assert.equal(snap.snapshot.id, 't1');
  assert.ok(snap.stats.turnTaking);

  const prosodyGet = await run('voice_v19_prosody', { action: 'get' });
  assert.equal(prosodyGet.emotion, 'neutral');
  const prosodySet = await run('voice_v19_prosody', { action: 'set-emotion', emotion: 'urgent' });
  assert.equal(prosodySet.settings.rate, presetProsodyV19Settings('urgent').rate);
  const plan = await run('voice_v19_prosody', { action: 'plan', text: 'Cẩn thận! Dừng lại ngay.' });
  assert.equal(plan.segments.length, 2);
  const ssml = await run('voice_v19_prosody', { action: 'ssml', text: 'Xin chào.' });
  assert.match(ssml.ssml, /<speak>/);
  const badEmotion = await byName.get('voice_v19_prosody').execute({ action: 'set-emotion', emotion: 'wild' });
  assert.match(badEmotion, /Unknown emotion/);

  const saved = await run('voice_v19_turn_save', { turnId: 'turn-1', sessionId: 't1', speaker: 'user', seq: 1, text: 'Tôi muốn hỏi', startMs: 0, endMs: 400, final: false });
  assert.equal(saved.saved, true);
  const saved2 = await run('voice_v19_turn_save', { turnId: 'turn-1', speaker: 'user', seq: 2, text: 'hỏi về ngày mai', startMs: 400, endMs: 900, final: true });
  assert.equal(saved2.turn.userText, 'Tôi muốn hỏi về ngày mai');
  const replySaved = await run('voice_v19_turn_save', { turnId: 'turn-1', replyText: 'Ngày mai bạn có ba việc.', spokenChars: 10 });
  assert.equal(replySaved.turn.remainingText, 'Ngày mai bạn có ba việc.'.slice(10));
  const interrupted = await run('voice_v19_turn_interrupt', { turnId: 'turn-1', reason: 'network-lost' });
  assert.equal(interrupted.interrupted, true);
  const requested = await run('voice_v19_turn_resume', { turnId: 'turn-1', action: 'request' });
  assert.equal(requested.requested, true);
  assert.match(requested.confirmation.question, /tiếp tục/i);
  const confirmed = await run('voice_v19_turn_resume', { turnId: 'turn-1', action: 'confirm', resumeAction: 'resume' });
  assert.equal(confirmed.confirmed, true);
  assert.equal(confirmed.plan.speakText, 'Ngày mai bạn có ba việc.'.slice(10));
  const completed = await run('voice_v19_turn_resume', { turnId: 'turn-1', action: 'complete' });
  assert.equal(completed.completed, true);
  const turns = await run('voice_v19_turn_list', {});
  assert.equal(turns.turns.length, 1);
  assert.equal(turns.stats.completed, 1);

  const evaluated = await run('voice_v19_eval', { action: 'run' });
  assert.equal(evaluated.report.passed, true);
  assert.equal(evaluated.report.naturalness.cases.length, 4);
  const compared = await run('voice_v19_eval', {
    action: 'compare',
    currentJson: JSON.stringify(evaluated.report),
    baselineJson: JSON.stringify(evaluated.report),
  });
  assert.equal(compared.regressed.length, 0);

  const swept = await run('voice_v19_session_sweep', { advanceMs: 0 });
  assert.equal(swept.expired.length, 0);
  const closed = await run('voice_v19_session_close', { sessionId: 't1' });
  assert.equal(closed.closed, true);
  assert.equal(closed.snapshot.state, 'closed');
  const deleted = await run('voice_v19_session_delete', { sessionId: 't1' });
  assert.equal(deleted.deleted, true);
  const unknown = await byName.get('voice_v19_session_snapshot').execute({ sessionId: 'nope' });
  assert.match(unknown, /Unknown voice v19 session/);
});

test('tools v19: bound manager restore + validation errors', async () => {
  const manager = createVoiceSessionManagerV19();
  const tools = createVoiceV19Tools({ getManager: () => manager });
  const byName = new Map(tools.map((t) => [t.definition.name, t]));
  const run = async (name, args) => JSON.parse(await byName.get(name).execute(args));
  await run('voice_v19_session_create', { sessionId: 'b1', connect: true });
  manager.get('b1').feedTranscriptFinal('Xin chào.');
  await Promise.resolve();
  await Promise.resolve();
  const exported = manager.exportSession('b1');
  assert.ok(exported.resumeToken);
  await run('voice_v19_session_delete', { sessionId: 'b1' });
  const restored = await run('voice_v19_session_restore', { exportedJson: JSON.stringify(exported) });
  assert.equal(restored.restored, true);
  assert.equal(restored.sessionId, 'b1');
  const badJson = await byName.get('voice_v19_session_restore').execute({ exportedJson: 'not json' });
  assert.match(badJson, /not valid JSON/);
  const badContext = await byName.get('voice_v19_session_create').execute({ sessionId: 'x', voiceContext: 'weird' });
  assert.match(badContext, /Unknown voice context/);
  const badReason = await byName.get('voice_v19_session_close').execute({ sessionId: 'b1', reason: 'weird' });
  assert.match(badReason, /Unknown close reason/);
  const badInterrupt = await byName.get('voice_v19_turn_interrupt').execute({ turnId: 'nope', reason: 'weird' });
  assert.match(badInterrupt, /Unknown interrupt reason/);
  const badResume = await byName.get('voice_v19_turn_resume').execute({ turnId: 'nope', action: 'confirm', resumeAction: 'weird' });
  assert.match(badResume, /Unknown resume action/);
});

// ------------------------------------------------------- core re-exports + i18n

test('core root re-exports v19 classes', async () => {
  const core = await import('../packages/core/dist/index.js');
  for (const name of [
    'VoiceSessionManagerV19',
    'ProsodyControllerV19',
    'OpenTurnStoreV19',
    'VoiceEvalV19',
    'createVoiceSessionManagerV19',
    'createProsodyControllerV19',
    'createOpenTurnStoreV19',
    'createVoiceEvalV19',
  ]) {
    assert.equal(typeof core[name], 'function', `${name} should be exported from @open-bot/core`);
  }
});

test('i18n: voice.realtime.v19.* keys — v19 is core-only, no realtime panel strings', () => {
  // v19 (v1.27, Đội T5) shipped core-only: session/prosody/eval/turn-resume
  // tools in ALL_TOOLS, no renderer panel and no voice.realtime.v19.* strings
  // ever landed (git log -S finds no such key in any locale file). The
  // previous assertion (48 keys) described a UI surface that was never
  // built; inventing 48 unused strings would be filler. If a v19 panel is
  // built later, add its real keys here and re-pin the count then.
  const locales = ['en', 'vi', 'es', 'fr', 'ja', 'zh'];
  for (const locale of locales) {
    const data = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', 'apps', 'desktop', 'src', 'renderer', 'i18n', 'locales', `${locale}.json`), 'utf8'),
    );
    const keys = Object.keys(data).filter((k) => k.startsWith('voice.realtime.v19.'));
    assert.equal(keys.length, 0, `${locale} should have 0 v19 realtime keys, got ${keys.length}`);
  }
});
