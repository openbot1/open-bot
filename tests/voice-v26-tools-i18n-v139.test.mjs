/**
 * Tests for voice v26 tools + registry wiring + i18n
 * (v1.39, Team T5).
 *
 * Covers voiceV26Tools (all 8 tools end to end against the
 * default mock instances), the v26 tools wiring into ALL_TOOLS
 * (bound replace-in-place, never duplicated), and the
 * voice.v26.* i18n keys in all 6 locales.
 *
 * All offline, deterministic, no key / network / audio.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createVoiceV26Tools,
  VOICE_V26_TOOLS,
  VOICE_V26_TOOL_NAMES,
  isVoiceV26ToolName,
} from '../packages/tools/dist/voiceV26Tools.js';
import {
  ALL_TOOLS,
  createDefaultTools,
} from '../packages/tools/dist/tools.js';
import {
  VOICE_V26_I18N_KEYS,
  VOICE_V26_PANEL_I18N_KEYS,
} from '../packages/core/dist/voiceV26/statusPanelV26.js';

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

test('voice v26 tools: names, placeholders and factory', () => {
  assert.equal(VOICE_V26_TOOL_NAMES.length, 8);
  assert.deepEqual([...VOICE_V26_TOOL_NAMES], [
    'voice_v26_bargein',
    'voice_v26_turn',
    'voice_v26_latency',
    'voice_v26_providers',
    'voice_v26_session',
    'voice_v26_status',
    'voice_v26_audio',
    'voice_v26_report',
  ]);
  assert.equal(VOICE_V26_TOOLS.length, 8);
  assert.ok(isVoiceV26ToolName('voice_v26_session'));
  assert.equal(isVoiceV26ToolName('voice_v25_session'), false);
  assert.equal(createVoiceV26Tools().length, 8);
  const names = new Set(VOICE_V26_TOOLS.map((t) => t.definition.name));
  assert.equal(names.size, 8);
});

test('voice v26 tools: barge-in + turn flow end to end', async () => {
  const tools = createVoiceV26Tools();
  const reply = 'The quick brown fox jumps over the lazy dog.';
  parseOk(await run(tools, 'voice_v26_bargein', { action: 'speak', sessionId: 't1', turnId: 'turn26-1', turnIndex: 0, replyText: reply, atMs: 0 }));
  parseOk(await run(tools, 'voice_v26_bargein', { action: 'progress', sessionId: 't1', spokenChars: 10, atMs: 500 }));
  let frame = parseOk(await run(tools, 'voice_v26_bargein', { action: 'frame', sessionId: 't1', energy: 0.7, atMs: 1000 }));
  assert.equal(frame.stage, 'suspect');
  for (let at = 1050; at <= 1400; at += 50) {
    frame = parseOk(await run(tools, 'voice_v26_bargein', { action: 'frame', sessionId: 't1', energy: 0.7, atMs: at }));
  }
  assert.equal(frame.confirmed, true);
  const stopped = parseOk(await run(tools, 'voice_v26_bargein', { action: 'stop', sessionId: 't1', spokenChars: 10, userText: 'hold on', atMs: 1450 }));
  assert.equal(stopped.spokenText, 'The quick');
  assert.equal(stopped.resumeStrategy, 'ask-clarify');
  const stats = parseOk(await run(tools, 'voice_v26_bargein', { action: 'stats', sessionId: 't1' }));
  assert.equal(stats.stopped, 1);
  const md = await run(tools, 'voice_v26_bargein', { action: 'markdown', sessionId: 't1' });
  assert.match(md, /Barge-in v26/);
  const bad = await run(tools, 'voice_v26_bargein', { action: 'nope', sessionId: 't1' });
  assert.ok(bad.startsWith('Error:'));

  parseOk(await run(tools, 'voice_v26_turn', { action: 'user-start', sessionId: 't2', text: 'hello', atMs: 0 }));
  const queued = parseOk(await run(tools, 'voice_v26_turn', { action: 'agent-start', sessionId: 't2', text: 'Hi!', atMs: 100 }));
  assert.equal(queued.outcome, 'queued');
  parseOk(await run(tools, 'voice_v26_turn', { action: 'user-end', sessionId: 't2', text: 'hello', atMs: 500 }));
  const delivered = parseOk(await run(tools, 'voice_v26_turn', { action: 'deliver-queued', sessionId: 't2', atMs: 600 }));
  assert.equal(delivered.outcome, 'started');
  const turnStats = parseOk(await run(tools, 'voice_v26_turn', { action: 'stats', sessionId: 't2' }));
  assert.equal(turnStats.turns, 2);
  assert.equal(turnStats.state, 'speaking');
});

test('voice v26 tools: latency budget + degraded mode end to end', async () => {
  const tools = createVoiceV26Tools();
  parseOk(await run(tools, 'voice_v26_latency', { action: 'profile', sessionId: 't1', profile: 'realtime', atMs: 0 }));
  const turn = parseOk(await run(tools, 'voice_v26_latency', {
    action: 'record-turn', sessionId: 't1', turnId: 'turn1', sttMs: 300, modelMs: 700, ttsMs: 500, atMs: 1000,
  }));
  assert.equal(turn.breached, false);
  assert.equal(turn.totalMs, 1500);
  const bad = parseOk(await run(tools, 'voice_v26_latency', {
    action: 'record-turn', sessionId: 't1', turnId: 'turn2', sttMs: 300, modelMs: 2000, ttsMs: 500, atMs: 2000,
  }));
  assert.equal(bad.breached, true);
  assert.ok(bad.breachedStages.includes('model'));
  const stages = parseOk(await run(tools, 'voice_v26_latency', { action: 'stages', sessionId: 't1' }));
  assert.equal(stages.length, 4);
  const bottleneck = parseOk(await run(tools, 'voice_v26_latency', { action: 'bottleneck', sessionId: 't1' }));
  assert.equal(bottleneck.stage, 'model');
  const degraded = parseOk(await run(tools, 'voice_v26_latency', { action: 'degraded', sessionId: 't1' }));
  assert.equal(degraded.level, 'off');
  const md = await run(tools, 'voice_v26_latency', { action: 'markdown', sessionId: 't1' });
  assert.match(md, /Latency budget v26/);
  const badProfile = await run(tools, 'voice_v26_latency', { action: 'profile', sessionId: 't1', profile: 'warp', atMs: 0 });
  assert.ok(badProfile.startsWith('Error:'));
});

test('voice v26 tools: providers select + mock audio + Vault-ref-only config', async () => {
  const tools = createVoiceV26Tools();
  const list = parseOk(await run(tools, 'voice_v26_providers', { action: 'list', kind: 'tts' }));
  assert.equal(list.length, 3);
  const selected = parseOk(await run(tools, 'voice_v26_providers', { action: 'select', kind: 'tts', language: 'en', atMs: 0 }));
  assert.equal(selected.providerId, 'mock-local-tts');
  const synth = parseOk(await run(tools, 'voice_v26_providers', {
    action: 'synthesize', providerId: 'mock-local-tts', text: 'Hello there.', atMs: 0,
  }));
  assert.equal(synth.chars, 12);
  assert.ok(synth.durationMs > 0);
  const transcript = parseOk(await run(tools, 'voice_v26_providers', {
    action: 'transcribe', providerId: 'mock-local-stt', audioPayload: 'payload-1', atMs: 0,
  }));
  assert.ok(transcript.text.length > 0);
  const transcript2 = parseOk(await run(tools, 'voice_v26_providers', {
    action: 'transcribe', providerId: 'mock-local-stt', audioPayload: 'payload-1', atMs: 0,
  }));
  assert.deepEqual(transcript, transcript2);
  const matrix = parseOk(await run(tools, 'voice_v26_providers', { action: 'matrix' }));
  assert.ok(matrix.some((row) => row.kind === 'tts' && row.language === 'vi'));
  const md = await run(tools, 'voice_v26_providers', { action: 'markdown' });
  assert.match(md, /Vault key refs/);
  // Registering an api-key provider without a Vault ref fails.
  const bad = await run(tools, 'voice_v26_providers', {
    action: 'register',
    definitionJson: JSON.stringify({
      id: 'bad-api', kind: 'tts', origin: 'api-key', name: 'Bad', model: 'm',
      languages: ['en'], voices: ['v'], streaming: true, latencyClass: 'fast',
      qualityClass: 'balanced', costClass: 'fast', maxInput: 100, vaultKeyRef: null, mock: true, enabled: true,
    }),
  });
  assert.ok(bad.startsWith('Error:'));
});

test('voice v26 tools: session + status + audio + report end to end', async () => {
  const tools = createVoiceV26Tools();
  parseOk(await run(tools, 'voice_v26_session', { action: 'open', sessionId: 's1', atMs: 0 }));
  parseOk(await run(tools, 'voice_v26_session', { action: 'user-start', sessionId: 's1', text: 'hi', atMs: 100 }));
  parseOk(await run(tools, 'voice_v26_session', { action: 'user-end', sessionId: 's1', text: 'hi', atMs: 500 }));
  const reply = parseOk(await run(tools, 'voice_v26_session', { action: 'agent-reply', sessionId: 's1', text: 'Hello, how can I help?', atMs: 600 }));
  assert.equal(reply.outcome, 'started');
  parseOk(await run(tools, 'voice_v26_session', { action: 'progress', sessionId: 's1', spokenChars: 5, atMs: 700 }));
  const status = parseOk(await run(tools, 'voice_v26_session', { action: 'status', sessionId: 's1', atMs: 800 }));
  assert.equal(status.floor, 'speaking');
  assert.equal(status.budgetMs, 4000);
  const done = parseOk(await run(tools, 'voice_v26_session', { action: 'agent-done', sessionId: 's1', spokenChars: 24, atMs: 2000 }));
  assert.equal(done.status, 'completed');

  const sim = parseOk(await run(tools, 'voice_v26_audio', { action: 'simulate', sessionId: 's1', pattern: 'speech', frames: 10, frameMs: 50, atMs: 0 }));
  assert.equal(sim.frames, 10);
  assert.ok(sim.last.smoothed > 0);
  const meter = parseOk(await run(tools, 'voice_v26_audio', { action: 'meter', sessionId: 's1' }));
  assert.equal(meter.levels.length, 10);

  const snap = parseOk(await run(tools, 'voice_v26_status', {
    action: 'snapshot', sessionId: 's1', floor: 'speaking', latencyMs: 1500, budgetMs: 4000, atMs: 2100,
  }));
  assert.equal(snap.state, 'speaking');
  const resource = parseOk(await run(tools, 'voice_v26_status', {
    action: 'ui-resource', sessionId: 's1', floor: 'speaking', latencyMs: 1500, budgetMs: 4000, atMs: 2100,
  }));
  assert.equal(resource.uri, 'ui://voice-v26/status?session=s1');
  assert.equal(resource.kind, 'voice-status');
  const uri = parseOk(await run(tools, 'voice_v26_status', { action: 'ui-uri', sessionId: 's1' }));
  assert.equal(uri.uri, 'ui://voice-v26/status?session=s1');

  const closed = parseOk(await run(tools, 'voice_v26_session', { action: 'close', sessionId: 's1', atMs: 3000 }));
  assert.equal(closed.closedAtMs, 3000);
  const report = parseOk(await run(tools, 'voice_v26_report', { action: 'summary' }));
  assert.equal(report.totals.sessions, 1);
  assert.equal(report.totals.turns, 2);
  const reportMd = await run(tools, 'voice_v26_report', { action: 'markdown' });
  assert.match(reportMd, /Voice report v26/);
});

test('voice v26 tools: ALL_TOOLS wiring (bound replace-in-place, never duplicated)', () => {
  const names = ALL_TOOLS.map((t) => t.definition.name);
  for (const name of VOICE_V26_TOOL_NAMES) {
    assert.equal(names.filter((n) => n === name).length, 1, `${name} appears exactly once in ALL_TOOLS`);
  }
  const bound = createDefaultTools({
    getVoiceV26ToolOptions: () => ({ latencyOptions: { profile: 'realtime' } }),
  });
  const boundNames = bound.map((t) => t.definition.name);
  for (const name of VOICE_V26_TOOL_NAMES) {
    assert.equal(boundNames.filter((n) => n === name).length, 1, `${name} appears exactly once when bound`);
  }
  assert.equal(boundNames.length, names.length);
});

test('voice v26 i18n: all keys present in all 6 locales with equal counts', () => {
  assert.ok(VOICE_V26_PANEL_I18N_KEYS.length >= 24);
  assert.ok(VOICE_V26_I18N_KEYS.length >= 50);
  assert.ok(VOICE_V26_I18N_KEYS.length > VOICE_V26_PANEL_I18N_KEYS.length);
  for (const key of VOICE_V26_I18N_KEYS) {
    assert.ok(key.startsWith('voice.v26.'), key);
  }
  assert.equal(new Set(VOICE_V26_I18N_KEYS).size, VOICE_V26_I18N_KEYS.length, 'no duplicate i18n keys');
  const counts = [];
  for (const locale of LOCALES) {
    const data = JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, `${locale}.json`), 'utf8'));
    counts.push(Object.keys(data).length);
    for (const key of VOICE_V26_I18N_KEYS) {
      assert.ok(typeof data[key] === 'string' && data[key].length > 0, `${locale} missing ${key}`);
    }
  }
  assert.equal(new Set(counts).size, 1, `locale key counts differ: ${counts.join(', ')}`);
});
