/**
 * Tests for v1.20 integration — voice realtime v18, Team T5
 * (merged onto the v119 voiceV18 base; branch v120-t5int).
 *
 * v120-t5 and v119 both shipped a "voice v18" module with
 * different APIs, so only the genuinely new v120-t5 parts are
 * merged here; the v119 modules (VAD v6, barge-in v6, TTS v4,
 * profiles v3, realtime v3, eval) stay as they are, and v121-t5
 * keeps building on them.
 *
 *   1. Turn-taking v6 (turnTakingV18.ts, new in v120-t5, taken
 *      verbatim): pure end-of-turn detector + overlap decision;
 *      machine: semantic end, silence end after `endSilenceMs`,
 *      backchannel while the agent speaks, overlap decisions,
 *      silence timeout with nudges + close suggestion (+
 *      auto-close), barge-in as an interrupted turn end,
 *      validation, stats / summary / markdown.
 *   2. Multi-voice profiles v3 (voiceProfilesV18.ts, v119 API —
 *      tests REWRITTEN from the v120-t5 draft, which targeted a
 *      parallel profiles v2 API that does not exist here: no
 *      switch hold / language pin / draft / panel view-model in
 *      v119): context tuning on resolve; switch policy +
 *      cooldown deferral, then apply-deferred; usage tracking +
 *      most-used; user defaults + clone; JSON round-trip with
 *      invalid entries dropped; presets; stats / summary /
 *      markdown.
 *   3. Voice budget meters (voiceBudgetV18.ts, new in v120-t5,
 *      taken verbatim; it needs `downgradeQualityV18` +
 *      `TtsV18Quality`, added additively to the v119 TTS
 *      stream): pure token/second estimates; day + session
 *      meters; warn / critical / exceeded thresholds with one
 *      event per crossing; auto-degrade (high → standard →
 *      fast → blocked); day rollover; stale-day JSON dropped;
 *      session history; stats / summary / markdown.
 *   4. Smoke tests for the v119 VAD v6 / barge-in v6 / TTS v4
 *      classes (REWRITTEN: the v120-t5 draft called pure
 *      helpers `classifyVadFrameV18`, `isEchoFrameV18`,
 *      `decideBargeInRestoreV18`, `adaptiveHangoverMsV18` that
 *      only exist in the parallel v120-t5 modules): sustained
 *      speech confirms + ends after the hangover, echo frames
 *      never start a run, echo is suppressed while loud user
 *      speech cuts with the spoken prefix kept, quality ladder
 *      downgrades one step, long-sentence splitting feeds the
 *      stream.
 *   5. Core root re-exports + i18n: v18 classes importable from
 *      the voiceV18 barrel and re-exported by the core root
 *      (`export *`); 86 `voice.realtime.v18.*` keys in all 6
 *      locales (48 from v119 + 38 new from v120-t5), non-empty,
 *      same key set everywhere; panel component file uses the
 *      v18 keys.
 *
 * No network, no sound card, no live provider, no key. Every audio
 * path is mock (synthetic PCM frames, mock synth). Run after
 * building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/voice-v120-t5.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  TurnTakingMachineV18,
  createTurnTakingMachineV18,
  defaultTurnTakingV18Options,
  validateTurnTakingV18Options,
  detectTurnEndV18,
  decideOverlapV18,
  turnTakingV18Summary,
  turnTakingV18Markdown,
  AdaptiveVadV18,
  createVadV18,
  defaultVadV18Options,
  validateVadV18Options,
  pcm16RmsV18,
  syntheticFrameV18,
  BargeInEngineV18,
  createBargeInEngineV18,
  defaultBargeInV18Options,
  validateBargeInV18Options,
  TtsStreamV18,
  createTtsStreamV18,
  defaultTtsStreamV18Options,
  validateTtsStreamV18Options,
  splitLongSentenceV18,
  downgradeQualityV18,
  VoiceProfileStoreV18,
  createVoiceProfileStoreV18,
  defaultVoiceProfileV18,
  defaultVoiceProfileV18Options,
  validateVoiceProfileV18,
  applyContextTuningV18,
  presetVoiceProfilesV18,
  voiceProfilesV18Summary,
  voiceProfilesV18Markdown,
  VoiceBudgetMeterV18,
  createVoiceBudgetMeterV18,
  defaultVoiceBudgetV18Options,
  validateVoiceBudgetV18Options,
  estimateTtsTokensV18,
  estimateSttTokensV18,
  estimateTtsSecondsV18,
  voiceBudgetDayKeyV18,
  voiceBudgetV18Summary,
  voiceBudgetV18Markdown,
} from '../packages/core/dist/voiceV18/index.js';
import { syntheticFrameV15 } from '../packages/core/dist/voiceV15/bargeInV15.js';
import { defaultVoiceProfileV15 } from '../packages/core/dist/voiceV15/ttsStreamV15.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ------------------------------------------------------- turn-taking v2

test('turn-taking v18: pure end-of-turn detector', () => {
  assert.deepEqual(detectTurnEndV18('Xin chào bạn.', true), { ended: true, reason: 'semantic', backchannel: false });
  assert.deepEqual(detectTurnEndV18('Xong rồi nhé', true), { ended: true, reason: 'semantic', backchannel: false });
  assert.deepEqual(detectTurnEndV18('Xin chào bạn.', false), { ended: false, reason: undefined, backchannel: false });
  assert.deepEqual(detectTurnEndV18('Xin chào bạn, hôm nay thế nào', true), { ended: false, reason: undefined, backchannel: false });
  assert.deepEqual(detectTurnEndV18('Xin chào bạn', true), { ended: false, reason: undefined, backchannel: true });
  assert.deepEqual(detectTurnEndV18('ừ', true), { ended: false, reason: undefined, backchannel: true });
  assert.deepEqual(detectTurnEndV18('ok', false), { ended: false, reason: undefined, backchannel: true });
  assert.deepEqual(detectTurnEndV18('  ', true), { ended: false, reason: undefined, backchannel: false });
  assert.deepEqual(detectTurnEndV18('ab', true, { minTurnChars: 5, backchannelMaxChars: 1 }), { ended: false, reason: undefined, backchannel: false });
});

test('turn-taking v18: pure overlap decision', () => {
  assert.equal(decideOverlapV18(100, 5000, 100), 'wait');
  assert.equal(decideOverlapV18(1500, 5000, 1500), 'agent-yields');
  assert.equal(decideOverlapV18(500, 4000, 400), 'user-yields');
  assert.equal(decideOverlapV18(500, 1000, 400), 'wait');
});

test('turn-taking v18: options defaults + validation', () => {
  const defs = defaultTurnTakingV18Options();
  assert.equal(defs.endSilenceMs, 800);
  assert.equal(defs.silenceTimeoutMs, 15000);
  assert.equal(defs.maxNudges, 2);
  assert.equal(defs.autoCloseOnSilence, false);
  assert.deepEqual(validateTurnTakingV18Options({}), []);
  assert.ok(validateTurnTakingV18Options({ endSilenceMs: 1 }).length > 0);
  assert.ok(validateTurnTakingV18Options({ maxNudges: 99 }).length > 0);
  assert.throws(() => createTurnTakingMachineV18({ endSilenceMs: -5 }), /invalid turn-taking v18/);
});

test('turn-taking v18: semantic end moves listening -> thinking', () => {
  const events = [];
  const m = createTurnTakingMachineV18({}, (e) => events.push(e));
  m.connect(0);
  assert.equal(m.getState(), 'listening');
  const verdict = m.feedTranscript('Cho tôi hỏi một câu.', true, 1000);
  assert.equal(verdict.ended, true);
  assert.equal(verdict.reason, 'semantic');
  assert.equal(m.getState(), 'thinking');
  assert.equal(m.stats().turnEnds.semantic, 1);
  assert.ok(events.some((e) => e.kind === 'turn-ended' && e.turnEndReason === 'semantic'));
  assert.match(turnTakingV18Summary(m), /semantic 1/);
  assert.match(turnTakingV18Markdown(m), /Turn ends: semantic 1/);
});

test('turn-taking v18: silence end after endSilenceMs, not before', () => {
  const events = [];
  const m = createTurnTakingMachineV18({ endSilenceMs: 800 }, (e) => events.push(e));
  m.connect(0);
  m.userSpeechStart(100);
  m.userSpeechEnd(500);
  assert.equal(m.getState(), 'listening');
  m.tick(1000);
  assert.equal(m.getState(), 'listening');
  assert.equal(m.stats().turnEnds.silence, undefined);
  m.tick(1300);
  assert.equal(m.getState(), 'thinking');
  assert.equal(m.stats().turnEnds.silence, 1);
  assert.ok(events.some((e) => e.kind === 'turn-ended' && e.turnEndReason === 'silence'));
  // Speaking again inside the window cancels the pending silence end.
  const m2 = createTurnTakingMachineV18({ endSilenceMs: 800 });
  m2.connect(0);
  m2.userSpeechStart(100);
  m2.userSpeechEnd(200);
  m2.userSpeechStart(500);
  m2.tick(1500);
  assert.equal(m2.getState(), 'listening');
  assert.equal(m2.stats().turnEnds.silence, undefined);
});

test('turn-taking v18: no bogus turn end after the agent reply', () => {
  const events = [];
  const m = createTurnTakingMachineV18({ endSilenceMs: 800 }, (e) => events.push(e));
  m.connect(0);
  m.agentReplyStart(100);
  assert.equal(m.getState(), 'speaking');
  m.agentReplyDone(200);
  assert.equal(m.getState(), 'listening');
  m.tick(2000);
  assert.equal(m.getState(), 'listening');
  assert.equal(events.filter((e) => e.kind === 'turn-ended').length, 0);
});

test('turn-taking v18: backchannel while speaking changes nothing', () => {
  const events = [];
  const m = createTurnTakingMachineV18({}, (e) => events.push(e));
  m.connect(0);
  m.agentReplyStart(100);
  const verdict = m.feedTranscript('ừ đúng', true, 200);
  assert.equal(verdict.backchannel, true);
  assert.equal(m.getState(), 'speaking');
  assert.equal(m.stats().backchannels, 1);
  assert.ok(events.some((e) => e.kind === 'backchannel' && e.text === 'ừ đúng'));
  // Longer speech while speaking is not a backchannel.
  const v2 = m.feedTranscript('Khoan đã, tôi muốn hỏi thêm.', true, 300);
  assert.equal(v2.backchannel, false);
  assert.equal(v2.ended, true);
});

test('turn-taking v18: overlap decisions while the agent speaks', () => {
  const events = [];
  const m = createTurnTakingMachineV18({}, (e) => events.push(e));
  m.connect(0);
  m.agentReplyStart(100);
  m.userSpeechStart(200);
  m.tick(400);
  assert.equal(events.filter((e) => e.kind === 'overlap').length, 0);
  m.tick(1400);
  const overlap = events.find((e) => e.kind === 'overlap');
  assert.ok(overlap);
  assert.equal(overlap.decision, 'agent-yields');
  assert.equal(m.stats().overlaps, 1);
  assert.equal(m.stats().yields['agent-yields'], 1);
  assert.ok(events.some((e) => e.kind === 'yield' && e.decision === 'agent-yields'));

  const events2 = [];
  const m2 = createTurnTakingMachineV18({}, (e) => events2.push(e));
  m2.connect(0);
  m2.agentReplyStart(100);
  m2.userSpeechStart(3200);
  m2.tick(3500);
  const overlap2 = events2.find((e) => e.kind === 'overlap');
  assert.ok(overlap2);
  assert.equal(overlap2.decision, 'user-yields');
});

test('turn-taking v18: silence timeout nudges, then close suggestion + auto-close', () => {
  const events = [];
  const m = createTurnTakingMachineV18(
    { endSilenceMs: 10000, silenceTimeoutMs: 5000, maxNudges: 1, autoCloseOnSilence: true },
    (e) => events.push(e),
  );
  m.connect(0);
  m.userSpeechStart(100);
  m.userSpeechEnd(200);
  m.tick(5200);
  assert.equal(events.filter((e) => e.kind === 'silence-timeout').length, 1);
  assert.equal(m.stats().nudges, 1);
  assert.equal(m.getState(), 'listening');
  m.tick(10200);
  assert.equal(events.filter((e) => e.kind === 'silence-timeout').length, 2);
  assert.ok(events.some((e) => e.kind === 'close-suggestion'));
  assert.equal(m.stats().closeSuggestions, 1);
  assert.equal(m.getState(), 'closed');
  assert.match(m.summary(), /close suggestions\)|close suggestions: 1|1 close suggestion/);
});

test('turn-taking v18: barge-in counts as an interrupted turn end', () => {
  const m = createTurnTakingMachineV18({});
  m.connect(0);
  m.agentReplyStart(100);
  m.bargeIn(200);
  assert.equal(m.getState(), 'interrupted');
  assert.equal(m.stats().turnEnds.interrupted, 1);
});

// ------------------------------------------------------- profiles v3 (v119 API)
//
// Rewritten from the v120-t5 draft: that draft tested a parallel
// profiles v2 API (switch hold with `setActiveProfile`,
// `resolveForTurn`, language pins, drafts, `buildVoiceProfilesV18PanelView`)
// which exists only in the v120-t5 branch's own voiceProfilesV18.ts.
// The v119 profiles v3 API kept here has the same ideas in
// different shapes — switch policy + cooldown + deferral instead of
// a hold, `resolve` + context tuning instead of `resolveForTurn`,
// user defaults + clone instead of drafts — so these tests cover
// the same behaviours through the API that actually ships.

test('profiles v18: options defaults + validation', () => {
  const defs = defaultVoiceProfileV18Options();
  assert.equal(defs.defaultSwitchPolicy, 'after-turn');
  assert.equal(defs.defaultSwitchCooldownMs, 0);
  const good = defaultVoiceProfileV18('bot-a');
  assert.deepEqual(validateVoiceProfileV18(good), []);
  assert.ok(validateVoiceProfileV18({ ...good, switchPolicy: 'weird' }).some((e) => e.includes('unknown switch policy')));
  assert.ok(validateVoiceProfileV18({ ...good, switchCooldownMs: -1 }).some((e) => e.includes('switchCooldownMs')));
  assert.ok(validateVoiceProfileV18({ ...good, contextTuning: { narration: { rate: 9 } } }).some((e) => e.includes('rate')));
  assert.ok(validateVoiceProfileV18({ ...good, timesUsed: -1 }).some((e) => e.includes('timesUsed')));
  assert.throws(() => {
    const store = createVoiceProfileStoreV18();
    store.set({ ...good, switchPolicy: 'weird' });
  }, /invalid voice profile v18/);
});

test('profiles v18: switch policy + cooldown defer, then apply', () => {
  const store = createVoiceProfileStoreV18();
  const a = defaultVoiceProfileV18('bot-a', { id: 'p-a', displayName: 'A', switchPolicy: 'immediate', switchCooldownMs: 0 });
  const b = defaultVoiceProfileV18('bot-a', { id: 'p-b', displayName: 'B', switchPolicy: 'immediate', switchCooldownMs: 5000 });
  store.set(a);
  store.set(b);
  const first = store.requestSwitch({ profileId: 'p-a', botId: 'bot-a', context: 'chat', atMs: 0 });
  assert.equal(first.applied, true);
  assert.equal(store.getActiveProfile()?.id, 'p-a');
  // Switching to B within B's cooldown is deferred, not dropped.
  const second = store.requestSwitch({ profileId: 'p-b', botId: 'bot-a', context: 'chat', atMs: 1000 });
  assert.equal(second.applied, false);
  assert.match(second.deferredReason ?? '', /cooldown/);
  assert.equal(store.deferredSwitchesList().length, 1);
  // An after-turn switch also waits for the turn to end.
  const c = defaultVoiceProfileV18('bot-a', { id: 'p-c', displayName: 'C', switchPolicy: 'after-turn', switchCooldownMs: 0 });
  store.set(c);
  const third = store.requestSwitch({ profileId: 'p-c', botId: 'bot-a', context: 'chat', atMs: 1500 });
  assert.equal(third.applied, false);
  assert.match(third.deferredReason ?? '', /policy after-turn/);
  const applied = store.applyDeferredSwitches(6000);
  assert.equal(applied.length, 2);
  assert.equal(store.getActiveProfile()?.id, 'p-c');
  assert.equal(store.stats().switches, 3);
  // Same-profile switch is a no-op, not a deferral.
  const same = store.requestSwitch({ profileId: 'p-c', botId: 'bot-a', context: 'chat', atMs: 7000 });
  assert.equal(same.applied, false);
  assert.equal(store.deferredSwitchesList().length, 0);
  // Unknown profile throws.
  assert.throws(() => store.requestSwitch({ profileId: 'ghost', botId: 'bot-a', context: 'chat', atMs: 8000 }), /Unknown voice profile v18/);
});

test('profiles v18: context tuning applies on resolve', () => {
  const store = createVoiceProfileStoreV18();
  const profile = defaultVoiceProfileV18('bot-a', {
    id: 'p-calm',
    displayName: 'Giọng trầm',
    rate: 1,
    contextTuning: { narration: { rate: 0.8, pitch: -3, maxChunkChars: 140 } },
  });
  store.set(profile);
  const chat = store.resolve({ botId: 'bot-a', context: 'chat' });
  assert.equal(chat.tunedProfile.rate, 1);
  assert.equal(chat.tuningApplied, undefined);
  const narration = store.resolve({ botId: 'bot-a', context: 'narration' });
  assert.equal(narration.tunedProfile.rate, 0.8);
  assert.equal(narration.tunedProfile.pitch, -3);
  assert.equal(narration.tunedProfile.maxChunkChars, 140);
  assert.equal(narration.tuningApplied?.rate, 0.8);
  // The pure helper leaves the base profile untouched.
  assert.equal(applyContextTuningV18(profile, 'narration').rate, 0.8);
  assert.equal(profile.rate, 1);
});

test('profiles v18: usage tracking, most-used, user defaults, clone', () => {
  const store = createVoiceProfileStoreV18();
  const a = defaultVoiceProfileV18('bot-a', { id: 'p-a', displayName: 'A' });
  const b = defaultVoiceProfileV18('bot-a', { id: 'p-b', displayName: 'B' });
  store.set(a);
  store.set(b);
  store.noteUsage('p-a', 100, 1000);
  store.noteUsage('p-a', 50, 2000);
  store.noteUsage('p-b', 10, 3000);
  assert.equal(store.get('p-a')?.timesUsed, 2);
  assert.equal(store.get('p-a')?.totalCharsSpoken, 150);
  assert.equal(store.get('p-a')?.lastUsedAtMs, 2000);
  assert.equal(store.mostUsedProfile()?.id, 'p-a');
  assert.throws(() => store.noteUsage('ghost', 10, 0), /Unknown voice profile v18/);
  store.setUserDefault('user-1', 'p-b');
  assert.equal(store.getUserDefault('user-1')?.id, 'p-b');
  assert.equal(store.clearUserDefault('user-1'), true);
  assert.equal(store.getUserDefault('user-1'), undefined);
  const clone = store.cloneForUser('p-a', 'user-1');
  assert.equal(clone.userId, 'user-1');
  assert.match(clone.displayName, /của user-1/);
  assert.equal(store.listForUser('user-1').length, 1);
  assert.throws(() => store.cloneForUser('ghost', 'user-1'), /unknown voice profile v17/);
  assert.throws(() => store.setUserDefault('user-1', 'ghost'), /unknown voice profile v17/);
});

test('profiles v18: presets include the two tuned v18 voices; seeded store lists them', () => {
  const presets = presetVoiceProfilesV18('bot-a');
  assert.ok(presets.length >= 6);
  assert.ok(presets.some((p) => p.id.startsWith('preset-v18-calm')));
  assert.ok(presets.some((p) => p.id.startsWith('preset-v18-brisk')));
  const store = createVoiceProfileStoreV18('bot-a');
  assert.ok(store.count() >= 4);
  assert.equal(store.listForBot('bot-a').length, store.count());
  // v17 presets carry no context, so listForContext is empty until a
  // context-bound profile is added.
  assert.equal(store.listForContext('narration').length, 0);
  const narration = defaultVoiceProfileV18('bot-a', { id: 'p-narr', displayName: 'Kể chuyện', context: 'narration' });
  store.set(narration);
  assert.equal(store.listForContext('narration').length, 1);
  assert.equal(store.listForContext('narration')[0]?.id, 'p-narr');
});

test('profiles v18: remove clears the active pin', () => {
  const store = createVoiceProfileStoreV18();
  const a = defaultVoiceProfileV18('bot-a', { id: 'p-a', displayName: 'A', switchPolicy: 'immediate' });
  store.set(a);
  store.requestSwitch({ profileId: 'p-a', botId: 'bot-a', context: 'chat', atMs: 0 });
  assert.equal(store.getActiveProfile()?.id, 'p-a');
  assert.equal(store.remove('p-a'), true);
  assert.equal(store.getActiveProfile(), undefined);
  assert.equal(store.remove('p-a'), false);
});

test('profiles v18: JSON round-trip, invalid entries dropped', () => {
  const store = createVoiceProfileStoreV18();
  const a = defaultVoiceProfileV18('bot-a', { id: 'p-a', displayName: 'A', switchPolicy: 'immediate' });
  store.set(a);
  store.requestSwitch({ profileId: 'p-a', botId: 'bot-a', context: 'chat', atMs: 0 });
  store.noteUsage('p-a', 40, 1000);
  const json = store.toJSON();
  assert.equal(json.version, 2);
  assert.equal(json.activeProfileId, 'p-a');
  const store2 = createVoiceProfileStoreV18();
  const out = store2.fromJSON(json);
  assert.ok(out.loaded >= 1);
  assert.equal(store2.get('p-a')?.timesUsed, 1);
  assert.equal(store2.get('p-a')?.totalCharsSpoken, 40);
  assert.equal(store2.getActiveProfile()?.id, 'p-a');
  assert.equal(store2.switchHistoryList().length, 1);

  const broken = JSON.parse(JSON.stringify(json));
  broken.profiles.push({ id: 42 });
  broken.profiles.push(null);
  const store3 = createVoiceProfileStoreV18();
  const out3 = store3.fromJSON(broken);
  assert.equal(store3.get('p-a')?.timesUsed, 1);
  assert.ok(out3.dropped >= 2, `expected >= 2 dropped, got ${out3.dropped}`);
  assert.throws(() => store3.fromJSON(null), /needs an object/);
  assert.match(voiceProfilesV18Summary(store), /switches applied/);
  assert.match(voiceProfilesV18Markdown(store), /# Voice profiles v18/);
  assert.match(voiceProfilesV18Markdown(store), /## Switch history/);
});

// ------------------------------------------------------- budget meters

test('budget v18: pure estimates', () => {
  assert.equal(estimateTtsTokensV18(0), 0);
  assert.equal(estimateTtsTokensV18(100), 25);
  assert.equal(estimateTtsTokensV18(101), 26);
  assert.equal(estimateSttTokensV18(0), 0);
  assert.equal(estimateSttTokensV18(10), 100);
  assert.equal(estimateTtsSecondsV18(150, 1), 10);
  assert.equal(estimateTtsSecondsV18(150, 2), 5);
  assert.equal(estimateTtsSecondsV18(0), 0);
  assert.equal(voiceBudgetDayKeyV18(0), '1970-01-01');
});

test('budget v18: options defaults + validation', () => {
  const defs = defaultVoiceBudgetV18Options();
  assert.equal(defs.warnAt, 0.8);
  assert.equal(defs.criticalAt, 0.95);
  assert.equal(defs.dailyVoiceMinutes, 0);
  assert.deepEqual(validateVoiceBudgetV18Options({}), []);
  assert.ok(validateVoiceBudgetV18Options({ warnAt: 0.99, criticalAt: 0.9 }).length > 0);
  assert.ok(validateVoiceBudgetV18Options({ dailyTtsTokens: -1 }).length > 0);
  assert.throws(() => createVoiceBudgetMeterV18({ warnAt: 2 }), /invalid voice budget v18/);
});

test('budget v18: day meters, thresholds fire once per crossing, auto-degrade', () => {
  const events = [];
  const meter = createVoiceBudgetMeterV18(
    { dailyVoiceMinutes: 10, dailyTtsTokens: 1000, dailySttTokens: 10000 },
    (e) => events.push(e),
    0,
  );
  meter.startSession('s1', 0);
  meter.recordStt(60, 1000);
  meter.recordTts(400, 1, 2000);
  assert.equal(meter.stats().dayTtsTokens, 100);
  assert.equal(meter.stats().daySttTokens, 600);
  assert.ok(Math.abs(meter.stats().dayVoiceMinutes - (60 + 400 / 15) / 60) < 0.01);
  assert.equal(meter.level(), 'ok');
  assert.deepEqual(meter.qualityFor('high', 3000), { quality: 'high', degraded: false, blocked: false, reason: 'within budget' });

  meter.recordTts(3200, 1, 4000); // 800 more TTS tokens -> 900/1000 = 90% warn
  assert.equal(meter.level(), 'warn');
  assert.equal(events.filter((e) => e.kind === 'threshold' && e.meter === 'ttsTokens' && e.level === 'warn').length, 1);
  const degraded = meter.qualityFor('high', 5000);
  assert.equal(degraded.quality, 'standard');
  assert.equal(degraded.degraded, true);
  assert.equal(meter.stats().degradedTurns, 1);

  meter.recordTts(400, 1, 6000); // 100 more -> 1000/1000 = 100% exceeded
  assert.equal(meter.level(), 'exceeded');
  assert.equal(events.filter((e) => e.kind === 'threshold' && e.level === 'exceeded').length, 1);
  const blocked = meter.qualityFor('high', 7000);
  assert.equal(blocked.blocked, true);
  assert.equal(meter.stats().blockedTurns, 1);
  const done = meter.endSession(8000);
  assert.equal(done?.sessionId, 's1');
  assert.equal(done?.ttsTokens, 1000);
  assert.ok(events.some((e) => e.kind === 'session-end' && e.sessionId === 's1'));
  assert.match(voiceBudgetV18Summary(meter), /exceeded/);
  assert.match(voiceBudgetV18Markdown(meter), /## Voice budget v18/);
});

test('budget v18: critical drops everything to fast', () => {
  const meter = createVoiceBudgetMeterV18({ dailyTtsTokens: 100 }, undefined, 0);
  meter.recordTts(380, 1, 1000); // 95 tokens = 95% -> critical
  assert.equal(meter.level(), 'critical');
  const out = meter.qualityFor('standard', 2000);
  assert.equal(out.quality, 'fast');
  assert.equal(out.degraded, true);
  assert.equal(meter.qualityFor('fast', 3000).degraded, false);
});

test('budget v18: session budget is the tighter voice-minutes meter', () => {
  const meter = createVoiceBudgetMeterV18({ dailyVoiceMinutes: 100, sessionVoiceMinutes: 1 }, undefined, 0);
  meter.startSession('s1', 0);
  meter.recordVoiceSeconds(30, 1000);
  assert.equal(meter.level(), 'ok');
  meter.recordVoiceSeconds(31, 2000);
  assert.equal(meter.meter('voiceMinutes').level, 'exceeded');
  assert.equal(meter.level(), 'exceeded');
  assert.equal(meter.stats().session?.voiceSeconds, 61);
});

test('budget v18: day rollover resets totals; stale-day JSON is dropped', () => {
  const events = [];
  const meter = createVoiceBudgetMeterV18({ dailyTtsTokens: 1000 }, (e) => events.push(e), 0);
  meter.recordStt(30, 0);
  assert.equal(meter.stats().dayVoiceSeconds, 30);
  meter.recordStt(30, 86400000 + 1000);
  assert.equal(meter.day(), '1970-01-02');
  assert.equal(meter.stats().dayVoiceSeconds, 30);
  assert.ok(events.some((e) => e.kind === 'day-rollover'));

  const json = meter.toJSON();
  const meter2 = createVoiceBudgetMeterV18({ dailyTtsTokens: 1000 }, undefined, 86400000 + 1000);
  const out = meter2.fromJSON(json, 86400000 + 1000);
  assert.equal(out.loaded, true);
  assert.equal(meter2.stats().dayVoiceSeconds, 30);
  const meter3 = createVoiceBudgetMeterV18({ dailyTtsTokens: 1000 }, undefined, 2 * 86400000);
  const out3 = meter3.fromJSON(json, 2 * 86400000);
  assert.ok(out3.dropped >= 1);
  assert.equal(meter3.stats().dayVoiceSeconds, 0);
  assert.throws(() => meter3.fromJSON({ version: 2 }), /unsupported voice budget v18/);
});

// ------------------------------------------------------- smoke: VAD v6 / barge-in v6 / TTS v4 (v119 API)
//
// Rewritten from the v120-t5 draft: that draft called pure helpers
// (`adaptiveHangoverMsV18`, `classifyVadFrameV18`, `speechLikeFrameV18`,
// `musicFrameV18`, `isEchoFrameV18`, `decideBargeInRestoreV18`) that
// only exist in the parallel v120-t5 modules. The same behaviours
// are covered here through the v119 classes that actually ship
// (`AdaptiveVadV18`, `BargeInEngineV18`, `TtsStreamV18`), following
// the proven patterns in tests/voice-v119.test.mjs.

/** Feed `count` synthetic frames (rms) through a VAD, 20 ms apart. */
function feedVadFrames(vad, count, rms, atMsStart) {
  let atMs = atMsStart;
  const events = [];
  for (let i = 0; i < count; i += 1) {
    const event = vad.feed(syntheticFrameV18(rms), atMs);
    if (event) events.push(event);
    atMs += 20;
  }
  return { events, endMs: atMs };
}

test('vad v18 smoke: sustained speech confirms, ends after the hangover', () => {
  const events = [];
  const vad = createVadV18({ calibrationFrames: 0 }, (e) => events.push(e));
  feedVadFrames(vad, 5, 0.005, 0);
  feedVadFrames(vad, 10, 0.25, 100); // 200 ms of speech
  assert.equal(vad.isSpeaking(), true);
  assert.equal(vad.stats().confirmedSpeechStarts, 1);
  assert.equal(events.filter((e) => e.kind === 'speech-start').length, 1);
  feedVadFrames(vad, 15, 0.005, 300); // 300 ms silence = hangover
  assert.equal(vad.isSpeaking(), false);
  assert.equal(vad.stats().confirmedSpeechEnds, 1);
  assert.ok(vad.summary().includes('false triggers'));
  assert.ok(vad.markdown().includes('False triggers'));
});

test('vad v18 smoke: echo frames never start a run; frame helpers + validation', () => {
  const vad = createVadV18({ calibrationFrames: 0 });
  const frame = syntheticFrameV18(0.25);
  // A sine frame's true RMS is param / √2.
  assert.ok(Math.abs(pcm16RmsV18(frame) - 0.25 / Math.SQRT2) < 0.02);
  assert.equal(vad.getClass(), 'silence');
  assert.equal(vad.isCalibrated(), true);
  for (let i = 0; i < 10; i += 1) vad.feed(syntheticFrameV18(0.25), i * 20, true);
  assert.equal(vad.isSpeaking(), false);
  assert.equal(vad.stats().confirmedSpeechStarts, 0);
  assert.throws(() => vad.feed(new Int16Array(100), 0), /20 ms PCM16 frame/);
  assert.deepEqual(validateVadV18Options({}), []);
  assert.ok(validateVadV18Options({ hangoverMs: -1 }).length > 0);
  assert.equal(defaultVadV18Options().adaptiveThreshold, true);
});

test('barge-in v18 smoke: echo suppressed, loud user cuts, spoken prefix kept', () => {
  const cuts = [];
  const engine = createBargeInEngineV18({}, (e) => {
    if (e.kind === 'cut') cuts.push(e.cut);
  });
  const reply = 'Xin chào bạn, hôm nay trời đẹp.';
  engine.beginAgentTurn('turn-1', 'alo', reply, 0);
  engine.setTtsLevel(0.2);
  let atMs = 0;
  for (let i = 0; i < 20; i += 1) {
    engine.feed({ frame: syntheticFrameV15(0.2), atMs, echo: true });
    atMs += 20;
  }
  assert.equal(engine.stats().cuts, 0);
  assert.ok(engine.stats().echoSuppressedFrames > 0);
  engine.setSpokenProgress(12);
  for (let i = 0; i < 20; i += 1) {
    engine.feed({ frame: syntheticFrameV15(0.5), atMs, echo: false });
    atMs += 20;
  }
  assert.equal(engine.stats().cuts, 1);
  assert.equal(cuts.length, 1);
  const cut = cuts[0];
  assert.equal(cut.turnId, 'turn-1');
  assert.equal(cut.userText, 'alo');
  assert.equal(cut.replyText, reply);
  assert.equal(cut.spokenChars, 12);
  assert.equal(cut.remainingText, reply.slice(12));
  assert.ok(cut.cutLatencyMs >= 0);
  assert.equal(engine.lastCut(), cut);
  assert.ok(engine.summary().includes('cuts'));
  assert.ok(engine.markdown().includes('## Cuts'));
  assert.deepEqual(validateBargeInV18Options({}), []);
  assert.equal(defaultBargeInV18Options().earlyDetectMs, 60);
});

test('tts v18 smoke: quality ladder downgrades one step', () => {
  assert.equal(downgradeQualityV18('high'), 'standard');
  assert.equal(downgradeQualityV18('standard'), 'fast');
  assert.equal(downgradeQualityV18('fast'), 'fast');
});

test('tts v18 smoke: long sentences split and the stream speaks them', () => {
  const long = 'Đây là một câu trả lời rất dài, với nhiều mệnh đề khác nhau, và nó tiếp tục kéo dài thêm nữa, để kiểm tra việc tách câu dài thành từng đoạn nhỏ.';
  const pieces = splitLongSentenceV18(long, 60);
  assert.ok(pieces.length >= 3, `expected >= 3 clauses, got ${pieces.length}`);
  for (const piece of pieces) assert.ok(piece.length <= 60, `clause too long: ${piece.length}`);
  assert.equal(splitLongSentenceV18('Ngắn thôi.', 60).length, 1);
  assert.deepEqual(splitLongSentenceV18('', 60), []);
  const stream = createTtsStreamV18();
  const profile = defaultVoiceProfileV15('bot-1');
  stream.speak(long, profile, 'normal', 0);
  assert.ok(stream.stats().longSentencesSplit >= 1);
  assert.ok(stream.stats().clausesProduced >= 3);
  for (let i = 0; i < 1500 && stream.isSpeaking(); i += 1) stream.tick(20);
  assert.ok(stream.stats().chunksSpoken > 0);
  assert.ok(stream.summary().includes('TTS v18'));
  assert.deepEqual(validateTtsStreamV18Options({}), []);
  assert.ok(validateTtsStreamV18Options({ ageThresholdMs: -1 }).length > 0);
});

// ------------------------------------------------------- core re-exports + i18n + panel

test('core root re-exports v18 classes', async () => {
  // The built voiceV18 barrel must export the classes, and the
  // core root index must re-export them. The root is checked
  // statically here: a live `import` of the whole core index
  // pulls in every module of the repo.
  const v18 = await import('../packages/core/dist/voiceV18/index.js');
  for (const name of [
    'AdaptiveVadV18',
    'BargeInEngineV18',
    'TtsStreamV18',
    'TurnTakingMachineV18',
    'VoiceProfileStoreV18',
    'VoiceBudgetMeterV18',
  ]) {
    assert.equal(typeof v18[name], 'function', `${name} should be exported from voiceV18/index`);
  }
  const rootSrc = fs.readFileSync(path.join(__dirname, '..', 'packages', 'core', 'src', 'index.ts'), 'utf8');
  assert.ok(rootSrc.includes("export * from './voiceV18/index';"), 'core index should re-export voiceV18');
});

test('i18n: 86 voice.realtime.v18.* keys in all 6 locales, non-empty, same set', () => {
  // 48 keys from v119 + 38 new keys from v120-t5 (turn-taking,
  // budget, and the parallel-module labels). The 10 keys both
  // waves defined keep the v119 wording.
  const locales = ['vi', 'en', 'es', 'fr', 'ja', 'zh'];
  const dir = path.join(__dirname, '..', 'apps', 'desktop', 'src', 'renderer', 'i18n', 'locales');
  const sets = [];
  for (const locale of locales) {
    const data = JSON.parse(fs.readFileSync(path.join(dir, `${locale}.json`), 'utf8'));
    const keys = Object.keys(data).filter((k) => k.startsWith('voice.realtime.v18.')).sort();
    assert.equal(keys.length, 86, `${locale} should have 86 v18 keys, got ${keys.length}`);
    for (const key of keys) {
      assert.equal(typeof data[key], 'string', `${locale}.${key} should be a string`);
      assert.ok(data[key].trim().length > 0, `${locale}.${key} should not be empty`);
    }
    sets.push(keys);
  }
  for (let i = 1; i < sets.length; i += 1) {
    assert.deepEqual(sets[i], sets[0], `locale ${locales[i]} key set should match vi`);
  }
});

test('panel: VoiceProfilesV18Panel exists and uses v18 keys', () => {
  const panel = fs.readFileSync(
    path.join(__dirname, '..', 'apps', 'desktop', 'src', 'renderer', 'components', 'VoiceProfilesV18Panel.tsx'),
    'utf8',
  );
  assert.ok(panel.includes('voice.realtime.v18.profiles.title'));
  assert.ok(panel.includes('voice.realtime.v18.budget.title'));
  assert.ok(panel.includes('demoVoiceProfilesV18Panel'));
  assert.ok(panel.includes('demoVoiceBudgetV18Panel'));
});
