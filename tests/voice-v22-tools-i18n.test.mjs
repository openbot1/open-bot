/**
 * Tests for voice v22 tools + i18n + registry wiring (v1.35, Team T5).
 *
 * Covers voiceV22Tools (all 6 tools end to end against the
 * default mock instances), the v22 tools wiring into ALL_TOOLS,
 * and the voice.v22 i18n keys in all 6 locales.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createVoiceV22Tools,
  VOICE_V22_TOOLS,
  VOICE_V22_TOOL_NAMES,
  isVoiceV22ToolName,
  builtinProfilesV22,
  validateProfileV22,
} from '../packages/tools/dist/voiceV22Tools.js';
import {
  ALL_TOOLS,
  createDefaultTools,
} from '../packages/tools/dist/tools.js';
import { VOICE_V22_PANEL_I18N_KEYS } from '../packages/core/dist/voiceV22/monitorPanelV22.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCALES_DIR = path.join(__dirname, '..', 'apps', 'desktop', 'src', 'renderer', 'i18n', 'locales');
const LOCALES = ['en', 'es', 'fr', 'ja', 'vi', 'zh'];

function toolMap(tools) {
  const m = new Map();
  for (const t of tools) m.set(t.definition.name, t);
  return m;
}

async function run(tools, name, args) {
  const t = toolMap(tools).get(name);
  assert.ok(t, `tool ${name} exists`);
  const out = await t.execute(args);
  assert.equal(typeof out, 'string');
  return out;
}

function parseOk(out) {
  assert.ok(!out.startsWith('Error:'), `expected ok, got: ${out}`);
  return JSON.parse(out);
}

function parseErr(out) {
  assert.ok(out.startsWith('Error:'), `expected error, got: ${out}`);
  return out;
}

// ---------------------------------------------------------------- tool inventory
test('voice v22: tools — 6 tools, names + factory + registry wiring', () => {
  assert.equal(VOICE_V22_TOOLS.length, 6);
  assert.deepEqual([...VOICE_V22_TOOL_NAMES], [
    'voice_v22_session',
    'voice_v22_barge_in',
    'voice_v22_turn',
    'voice_v22_profile',
    'voice_v22_recovery',
    'voice_v22_monitor',
  ]);
  assert.equal(isVoiceV22ToolName('voice_v22_session'), true);
  assert.equal(isVoiceV22ToolName('voice_v22_profile'), true);
  assert.equal(isVoiceV22ToolName('voice_v21_session'), false);
  assert.equal(createVoiceV22Tools().length, 6);
  const names = ALL_TOOLS.map((t) => t.definition.name);
  for (const name of VOICE_V22_TOOL_NAMES) {
    assert.ok(names.includes(name), `${name} is in ALL_TOOLS`);
    assert.equal(names.filter((n) => n === name).length, 1, `${name} appears exactly once`);
  }
  const defaults = createDefaultTools();
  assert.ok(toolMap(defaults).has('voice_v22_session'));
  assert.equal(builtinProfilesV22().length, 4);
  assert.deepEqual(validateProfileV22({
    id: 'x', name: 'X', locale: 'en-US', engine: 'mock', prosody: { rate: 1, pitch: 0, volume: 1 },
  }), []);
});

// ---------------------------------------------------------------- session tool
test('voice v22: session tool — start/feed/checkpoint/disconnect/reconnect/status', async () => {
  const tools = createVoiceV22Tools();
  let out = parseOk(await run(tools, 'voice_v22_session', { action: 'start', atMs: 0 }));
  assert.equal(out.state, 'listening');
  assert.equal(out.phase, 'live');
  out = parseOk(await run(tools, 'voice_v22_session', { action: 'feed-final', text: 'hello there', atMs: 100 }));
  assert.match(out.reply, /I heard: hello there/);
  assert.equal(out.state, 'listening');
  out = parseOk(await run(tools, 'voice_v22_session', { action: 'feed-partial', text: 'how are', atMs: 200 }));
  assert.equal(out.livePartial, 'how are');
  out = parseOk(await run(tools, 'voice_v22_session', { action: 'checkpoint', atMs: 300 }));
  assert.ok(out.journalSeq > 0);
  assert.ok(typeof out.checksum === 'string' && out.checksum.length > 0);
  assert.match(out.resumeToken, /^v22-resume-default-/);
  out = parseOk(await run(tools, 'voice_v22_session', { action: 'status', atMs: 300 }));
  assert.equal(out.turns, 1);
  assert.ok(out.ttsChunksSpoken >= 1);
  assert.equal(out.durability.phase, 'live');
  out = parseOk(await run(tools, 'voice_v22_session', { action: 'snapshot', atMs: 300 }));
  const snapshotJson = out.snapshotJson;
  assert.ok(snapshotJson.includes('default'));
  out = parseOk(await run(tools, 'voice_v22_session', { action: 'disconnect', atMs: 400, message: 'wifi dropped' }));
  assert.equal(out.phase, 'disconnected');
  assert.equal(out.state, 'paused');
  out = parseOk(await run(tools, 'voice_v22_session', { action: 'reconnect', atMs: 5000, outcome: 'failure' }));
  assert.equal(out.phase, 'disconnected');
  out = parseOk(await run(tools, 'voice_v22_session', { action: 'reconnect', atMs: 6000, outcome: 'success' }));
  assert.equal(out.phase, 'live');
  assert.equal(out.report.outcome, 'resumed');
  out = parseOk(await run(tools, 'voice_v22_session', { action: 'resume-token', token: out.report ? 'v22-resume-default-0' : '', atMs: 7000 }));
  assert.ok(['resumed', 'rejected', 'fresh-start'].includes(out.report.outcome));
  parseErr(await run(tools, 'voice_v22_session', { action: 'teleport' }));
  parseErr(await run(tools, 'voice_v22_session', { action: 'feed-final' }));
  parseErr(await run(tools, 'voice_v22_session', { action: 'reconnect', outcome: 'maybe' }));
  out = parseOk(await run(tools, 'voice_v22_session', { action: 'pause', atMs: 8000 }));
  assert.equal(out.state, 'paused');
  out = parseOk(await run(tools, 'voice_v22_session', { action: 'resume-paused', atMs: 9000 }));
  assert.equal(out.state, 'listening');
  out = parseOk(await run(tools, 'voice_v22_session', { action: 'resume-queued', atMs: 9000 }));
  assert.equal(out.spoken, '');
  out = parseOk(await run(tools, 'voice_v22_session', { action: 'restore', snapshotJson, atMs: 9000 }));
  assert.equal(out.restored, true);
  parseErr(await run(tools, 'voice_v22_session', { action: 'restore', snapshotJson: 'not json', atMs: 9000 }));
  out = parseOk(await run(tools, 'voice_v22_session', { action: 'close', atMs: 9500 }));
  assert.equal(out.ok, true);
});

// ---------------------------------------------------------------- barge-in tool
test('voice v22: barge-in tool — score/cut/queued/take/drop/summarise', async () => {
  const tools = createVoiceV22Tools();
  let out = parseOk(await run(tools, 'voice_v22_barge_in', {
    action: 'score', energy: 0.9, sustainMs: 800,
    wordsJson: JSON.stringify(['stop', 'wait', 'listen', 'to', 'me']), atMs: 100,
  }));
  assert.equal(out.decision, 'interrupt');
  assert.ok(out.score.total >= 0.65);
  assert.equal(out.backchannel, false);
  out = parseOk(await run(tools, 'voice_v22_barge_in', {
    action: 'score', energy: 0.5, sustainMs: 400, wordsJson: JSON.stringify(['ừm']), atMs: 5000,
  }));
  assert.equal(out.decision, 'duck-soft');
  assert.equal(out.backchannel, true);
  out = parseOk(await run(tools, 'voice_v22_barge_in', {
    action: 'score', energy: 0.9, sustainMs: 800,
    wordsJson: JSON.stringify(['stop', 'now']), echo: 'true', atMs: 6000,
  }));
  assert.equal(out.decision, 'ignore');
  const reply = 'The quick brown fox jumps over the lazy dog and runs away to the forest.';
  out = parseOk(await run(tools, 'voice_v22_barge_in', { action: 'cut', replyText: reply, spokenChars: 10, atMs: 7000 }));
  assert.equal(out.cut.spoken, 'The quick');
  assert.equal(out.cut.disposition, 'summarise'); // long remainder → summarise, not verbatim resume
  assert.equal(out.queued.length, 1);
  out = parseOk(await run(tools, 'voice_v22_barge_in', { action: 'summarise', replyText: 'First sentence here. Second sentence follows.', spokenChars: 5 }));
  assert.equal(out.summary, 'sentence here.');
  out = parseOk(await run(tools, 'voice_v22_barge_in', { action: 'queued' }));
  assert.equal(out.queued.length, 1);
  out = parseOk(await run(tools, 'voice_v22_barge_in', { action: 'take' }));
  assert.equal(out.taken?.turnId, 'tool-turn');
  out = parseOk(await run(tools, 'voice_v22_barge_in', { action: 'take' }));
  assert.equal(out.taken, null);
  parseErr(await run(tools, 'voice_v22_barge_in', { action: 'drop' }));
  parseErr(await run(tools, 'voice_v22_barge_in', { action: 'explode' }));
});

// ---------------------------------------------------------------- turn tool
test('voice v22: turn tool — state/event/floor/silence/classify', async () => {
  const tools = createVoiceV22Tools();
  let out = parseOk(await run(tools, 'voice_v22_turn', { action: 'state', atMs: 0 }));
  assert.equal(out.state, 'idle');
  assert.equal(out.floor, 'none');
  out = parseOk(await run(tools, 'voice_v22_turn', { action: 'event', event: 'user-speech-start', atMs: 100 }));
  assert.equal(out.to, 'listening');
  out = parseOk(await run(tools, 'voice_v22_turn', { action: 'floor-request', requester: 'agent', priority: 'polite', reason: 'answer', atMs: 200 }));
  assert.equal(out.request.outcome, 'queued');
  out = parseOk(await run(tools, 'voice_v22_turn', { action: 'floor-request', requester: 'agent', priority: 'interrupt', reason: 'urgent', atMs: 300 }));
  assert.equal(out.request.outcome, 'granted');
  assert.equal(out.floor, 'agent');
  out = parseOk(await run(tools, 'voice_v22_turn', { action: 'classify-overlap', durationMs: 100 }));
  assert.equal(out.classification, 'backchannel');
  out = parseOk(await run(tools, 'voice_v22_turn', { action: 'classify-overlap', durationMs: 500 }));
  assert.equal(out.classification, 'barge-in');
  out = parseOk(await run(tools, 'voice_v22_turn', { action: 'silence', atMs: 400 }));
  assert.equal(out.result, 'none'); // listening, but only 300 ms of silence so far
  out = parseOk(await run(tools, 'voice_v22_turn', { action: 'stats', atMs: 500 }));
  assert.equal(out.state, 'listening');
  assert.ok(out.summary.includes('turn-taking v22'));
  parseErr(await run(tools, 'voice_v22_turn', { action: 'event', event: 'explode', atMs: 0 }));
  parseErr(await run(tools, 'voice_v22_turn', { action: 'floor-request', requester: 'ghost', priority: 'polite', atMs: 0 }));
  parseErr(await run(tools, 'voice_v22_turn', { action: 'classify-overlap' }));
});

// ---------------------------------------------------------------- profile tool
test('voice v22: profile tool — list/get/add/switch/user-default/resolve/stats', async () => {
  const tools = createVoiceV22Tools();
  let out = parseOk(await run(tools, 'voice_v22_profile', { action: 'list' }));
  assert.equal(out.profiles.length, 4);
  assert.equal(out.current, 'voice-v22-default');
  out = parseOk(await run(tools, 'voice_v22_profile', { action: 'list', locale: 'vi-VN' }));
  assert.equal(out.profiles.length, 1);
  out = parseOk(await run(tools, 'voice_v22_profile', { action: 'get', profileId: 'voice-v22-vi-calm' }));
  assert.equal(out.profile.name, 'An Nhiên');
  parseErr(await run(tools, 'voice_v22_profile', { action: 'get', profileId: 'ghost' }));
  out = parseOk(await run(tools, 'voice_v22_profile', {
    action: 'add',
    profileJson: JSON.stringify({
      id: 'tool-voice', name: 'Tool Voice', locale: 'en-US', engine: 'mock',
      prosody: { rate: 1.1, pitch: 1, volume: 1 }, fallbackId: 'voice-v22-default',
    }),
  }));
  assert.equal(out.profile.id, 'tool-voice');
  out = parseOk(await run(tools, 'voice_v22_profile', {
    action: 'update', profileId: 'tool-voice',
    profileJson: JSON.stringify({ prosody: { rate: 1.5 } }),
  }));
  assert.equal(out.profile.prosody.rate, 1.5);
  out = parseOk(await run(tools, 'voice_v22_profile', { action: 'switch', profileId: 'tool-voice', atMs: 100 }));
  assert.equal(out.current, 'tool-voice');
  out = parseOk(await run(tools, 'voice_v22_profile', { action: 'switch', profileId: 'voice-v22-default', agentSpeaking: 'true', atMs: 200 }));
  assert.equal(out.current, 'tool-voice');
  assert.notEqual(out.pending, null);
  out = parseOk(await run(tools, 'voice_v22_profile', { action: 'user-default', userId: 'u1', profileId: 'voice-v22-vi-calm' }));
  assert.equal(out.profileId, 'voice-v22-vi-calm');
  out = parseOk(await run(tools, 'voice_v22_profile', { action: 'user-default', userId: 'u1' }));
  assert.equal(out.profileId, 'voice-v22-vi-calm');
  assert.equal(out.profile.id, 'voice-v22-vi-calm');
  out = parseOk(await run(tools, 'voice_v22_profile', { action: 'resolve', profileId: 'ghost' }));
  assert.equal(out.profile.id, 'voice-v22-default');
  assert.equal(out.fellBack, true);
  parseErr(await run(tools, 'voice_v22_profile', { action: 'switch', profileId: 'ghost' }));
  parseErr(await run(tools, 'voice_v22_profile', { action: 'remove', profileId: 'voice-v22-default' }));
  out = parseOk(await run(tools, 'voice_v22_profile', { action: 'stats' }));
  assert.equal(out.profiles, 5);
  assert.equal(out.customs, 1);
});

// ---------------------------------------------------------------- recovery tool
test('voice v22: recovery tool — heartbeat/disconnect/attempt/backoff/status', async () => {
  const tools = createVoiceV22Tools();
  let out = parseOk(await run(tools, 'voice_v22_recovery', { action: 'heartbeat', atMs: 0, rttMs: 120 }));
  assert.equal(out.phase, 'live');
  assert.equal(out.heartbeats, 1);
  out = parseOk(await run(tools, 'voice_v22_recovery', { action: 'backoff', attempt: 1 }));
  assert.equal(out.delayMs, 1037);
  out = parseOk(await run(tools, 'voice_v22_recovery', { action: 'backoff', attempt: 3 }));
  assert.equal(out.delayMs, 4111);
  out = parseOk(await run(tools, 'voice_v22_recovery', { action: 'disconnect', atMs: 100, kind: 'transport-lost', message: 'wifi dropped' }));
  assert.equal(out.phase, 'disconnected');
  assert.equal(out.failure.kind, 'transport-lost');
  assert.equal(out.failure.recoverable, true);
  out = parseOk(await run(tools, 'voice_v22_recovery', { action: 'attempt', atMs: 200, outcome: 'failure', kind: 'transport-lost' }));
  assert.equal(out.phase, 'disconnected');
  assert.ok(out.nextAttemptAtMs !== null);
  out = parseOk(await run(tools, 'voice_v22_recovery', { action: 'attempt', atMs: out.nextAttemptAtMs, outcome: 'success' }));
  assert.equal(out.phase, 'reconnecting');
  out = parseOk(await run(tools, 'voice_v22_recovery', { action: 'status' }));
  assert.equal(out.reconnectSuccesses, 1);
  assert.ok(out.summary.includes('recovery v22'));
  parseErr(await run(tools, 'voice_v22_recovery', { action: 'disconnect', kind: 'nope' }));
  parseErr(await run(tools, 'voice_v22_recovery', { action: 'attempt', outcome: 'maybe' }));
});

// ---------------------------------------------------------------- monitor tool
test('voice v22: monitor tool — snapshot + markdown mirror the live session', async () => {
  const tools = createVoiceV22Tools();
  await run(tools, 'voice_v22_session', { action: 'start', atMs: 0 });
  await run(tools, 'voice_v22_session', { action: 'feed-final', text: 'hello', atMs: 100 });
  // Checkpoint first so the durability score is 1 and no alert fires.
  await run(tools, 'voice_v22_session', { action: 'checkpoint', atMs: 150 });
  let out = parseOk(await run(tools, 'voice_v22_monitor', { action: 'snapshot', atMs: 200 }));
  assert.equal(out.sessionId, 'default');
  assert.equal(out.turnState, 'listening');
  assert.equal(out.floor, 'user');
  assert.equal(out.profileId, 'voice-v22-default');
  assert.equal(out.durability.phase, 'live');
  assert.ok(out.durability.durabilityScore >= 0);
  assert.equal(out.bargeIns, 0);
  assert.deepEqual(out.alerts, []);
  out = parseOk(await run(tools, 'voice_v22_monitor', { action: 'markdown', atMs: 200 }));
  assert.match(out.markdown, /# Voice monitor v22/);
  assert.match(out.markdown, /Phase: live/);
  assert.equal(out.snapshot.turnState, 'listening');
  parseErr(await run(tools, 'voice_v22_monitor', { action: 'explode' }));
});

// ---------------------------------------------------------------- i18n
const VOICE_V22_KEYS = [
  'voice.v22.panel.title',
  'voice.v22.panel.listening',
  'voice.v22.panel.speaking',
  'voice.v22.panel.waiting',
  'voice.v22.panel.confirming',
  'voice.v22.panel.yielded',
  'voice.v22.panel.paused',
  'voice.v22.panel.idle',
  'voice.v22.panel.liveTranscript',
  'voice.v22.panel.latency',
  'voice.v22.panel.bargeIns',
  'voice.v22.panel.durability',
  'voice.v22.panel.phase.live',
  'voice.v22.panel.phase.degraded',
  'voice.v22.panel.phase.disconnected',
  'voice.v22.panel.phase.reconnecting',
  'voice.v22.panel.phase.resuming',
  'voice.v22.panel.phase.recovered',
  'voice.v22.panel.phase.closed',
  'voice.v22.panel.profile',
  'voice.v22.panel.queuedReplies',
  'voice.v22.panel.alerts',
  'voice.v22.panel.noAlerts',
  'voice.v22.panel.resumeClean',
  'voice.v22.panel.resumeWithGaps',
  'voice.v22.session.disconnected',
  'voice.v22.session.reconnected',
  'voice.v22.session.resumed',
  'voice.v22.session.resumedWithGaps',
  'voice.v22.session.paused',
  'voice.v22.profile.switched',
  'voice.v22.profile.current',
  'voice.v22.bargeIn.interrupted',
  'voice.v22.bargeIn.ducked',
];

test('voice v22: i18n — 34 voice.v22 keys in all 6 locales, panel keys covered', () => {
  assert.equal(VOICE_V22_KEYS.length, 34);
  for (const locale of LOCALES) {
    const data = JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, `${locale}.json`), 'utf8'));
    for (const key of VOICE_V22_KEYS) {
      assert.ok(key in data, `${locale} missing ${key}`);
      assert.equal(typeof data[key], 'string');
      assert.ok(data[key].length > 0, `${locale} ${key} is empty`);
    }
  }
  for (const key of VOICE_V22_PANEL_I18N_KEYS) {
    assert.ok(VOICE_V22_KEYS.includes(key), `panel key ${key} is in the i18n key list`);
  }
  const vi = JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, 'vi.json'), 'utf8'));
  assert.equal(vi['voice.v22.panel.title'], 'Giám sát giọng nói v22');
  assert.equal(vi['voice.v22.session.resumed'], 'Phiên đã khôi phục từ checkpoint.');
  const en = JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, 'en.json'), 'utf8'));
  assert.equal(en['voice.v22.panel.phase.disconnected'], 'Disconnected');
});
