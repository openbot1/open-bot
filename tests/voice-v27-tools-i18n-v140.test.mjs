/**
 * Tests for voice v27 tools + registry wiring + i18n
 * (v1.40, Team T5).
 *
 * Covers voiceV27Tools (all 6 tools end to end against the
 * default mock instances, with session files in a fresh temp
 * dir), the v27 tools wiring into ALL_TOOLS (bound
 * replace-in-place, never duplicated), and the voice.v27.*
 * i18n keys in all 6 locales (present, equal counts, sorted
 * files — no hardcoded global total, only the base floor).
 *
 * All offline, deterministic, no key / network / audio.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createVoiceV27Tools,
  VOICE_V27_TOOLS,
  VOICE_V27_TOOL_NAMES,
  isVoiceV27ToolName,
} from '../packages/tools/dist/voiceV27Tools.js';
import {
  ALL_TOOLS,
  createDefaultTools,
} from '../packages/tools/dist/tools.js';
import {
  VOICE_V27_I18N_KEYS,
} from '../packages/core/dist/voiceV27/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCALES_DIR = path.join(__dirname, '..', 'apps', 'desktop', 'src', 'renderer', 'i18n', 'locales');
const LOCALES = ['en', 'es', 'fr', 'ja', 'vi', 'zh'];
/** Key count in every locale file on the merge/v140 base (before v27). */
const BASE_LOCALE_KEY_COUNT = 8322;

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'voice-v27-tools-'));
}

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
  assert.ok(!out.startsWith('Error:'), `expected ok, got ${out}`);
  return JSON.parse(out);
}

function parseErr(out) {
  assert.ok(out.startsWith('Error:'), `expected error, got ${out}`);
  return out;
}

test('voice v27 tools: interrupt end to end', async () => {
  const tools = createVoiceV27Tools({ getBaseDir: () => tmpDir() });
  const armed = parseOk(await run(tools, 'voice_v27_interrupt', {
    action: 'arm', sessionId: 's1', turnId: 't1', replyText: 'Hello world this is a long reply', atMs: 0,
  }));
  assert.equal(armed.turnId, 't1');
  const policy = parseOk(await run(tools, 'voice_v27_interrupt', { action: 'policy', sessionId: 's1' }));
  assert.equal(policy.mode, 'always');
  const feed = parseOk(await run(tools, 'voice_v27_interrupt', {
    action: 'feed', sessionId: 's1', speechMs: 500, energy: 0.8, atMs: 1000,
  }));
  assert.equal(feed.decision, 'confirmed');
  const stopped = parseOk(await run(tools, 'voice_v27_interrupt', {
    action: 'stop', sessionId: 's1', eventId: feed.eventId, spokenChars: 5, stopLatencyMs: 120, atMs: 1120,
  }));
  assert.equal(stopped.resume, 'resume-remaining');
  assert.equal(stopped.spokenText, 'Hello');
  const stats = parseOk(await run(tools, 'voice_v27_interrupt', { action: 'stats', sessionId: 's1', atMs: 1200 }));
  assert.equal(stats.confirmed, 1);
  assert.equal(stats.meanStopLatencyMs, 120);
  const listed = parseOk(await run(tools, 'voice_v27_interrupt', { action: 'list', sessionId: 's1' }));
  assert.equal(listed.length, 1);
  const marked = parseOk(await run(tools, 'voice_v27_interrupt', {
    action: 'false-positive', sessionId: 's1', eventId: feed.eventId,
  }));
  assert.equal(marked.ok, true);
  const set = parseOk(await run(tools, 'voice_v27_interrupt', {
    action: 'set-policy', sessionId: 's1', policyJson: JSON.stringify({ mode: 'keyword-only' }),
  }));
  assert.equal(set.mode, 'keyword-only');
  const md = await run(tools, 'voice_v27_interrupt', { action: 'markdown', sessionId: 's1' });
  assert.match(md, /Interrupt policy v27/);
  parseErr(await run(tools, 'voice_v27_interrupt', { action: 'nope', sessionId: 's1' }));
  parseErr(await run(tools, 'voice_v27_interrupt', {
    action: 'stop', sessionId: 's1', eventId: 'v27-int-99', atMs: 1300,
  }));
  const reset = parseOk(await run(tools, 'voice_v27_interrupt', { action: 'reset', sessionId: 's1' }));
  assert.equal(reset.ok, true);
});

test('voice v27 tools: VAD tuning + VAD-driven turns end to end', async () => {
  const tools = createVoiceV27Tools({ getBaseDir: () => tmpDir() });
  const configured = parseOk(await run(tools, 'voice_v27_vad', {
    action: 'configure', sessionId: 's1', configJson: JSON.stringify({ endSilenceMs: 500 }),
  }));
  assert.equal(configured.endSilenceMs, 500);
  const preset = parseOk(await run(tools, 'voice_v27_vad', { action: 'preset', sessionId: 's1', preset: 'balanced' }));
  assert.equal(preset.endSilenceMs, 700);
  const samples = [...Array(20).fill(0.03), ...Array(10).fill(0.7)];
  const cal = parseOk(await run(tools, 'voice_v27_vad', {
    action: 'calibrate', sessionId: 's1', samplesJson: JSON.stringify(samples), apply: 'false',
  }));
  assert.equal(cal.suggestedThreshold, 0.365);
  assert.equal(cal.suggestedPreset, 'sensitive');

  const started = parseOk(await run(tools, 'voice_v27_vad', {
    action: 'turn-start', sessionId: 's1', text: 'hello', atMs: 0,
  }));
  assert.equal(started.role, 'user');
  for (let i = 0; i < 6; i++) {
    const r = parseOk(await run(tools, 'voice_v27_vad', {
      action: 'turn-frame', sessionId: 's1', energy: 0.6, isSpeech: 'true', atMs: 100 + i * 50,
    }));
    assert.equal(r.frame.kind, 'speech');
  }
  let ended = null;
  for (let i = 0; i < 14; i++) {
    const r = parseOk(await run(tools, 'voice_v27_vad', {
      action: 'turn-frame', sessionId: 's1', energy: 0.02, atMs: 400 + i * 50,
    }));
    if (r.turn !== null && r.turn.status === 'completed') ended = r.turn;
  }
  assert.ok(ended);
  assert.equal(ended.endReason, 'silence');
  const turns = parseOk(await run(tools, 'voice_v27_vad', { action: 'turns', sessionId: 's1' }));
  assert.equal(turns.length, 1);
  const got = parseOk(await run(tools, 'voice_v27_vad', { action: 'get-turn', sessionId: 's1', turnId: ended.id }));
  assert.equal(got.id, ended.id);
  const stats = parseOk(await run(tools, 'voice_v27_vad', { action: 'stats', sessionId: 's1' }));
  assert.equal(stats.turns, 1);
  assert.equal(stats.completed, 1);
  const vadStats = parseOk(await run(tools, 'voice_v27_vad', { action: 'vad-stats', sessionId: 's1' }));
  assert.equal(vadStats.turnsEnded, 1);
  const md = await run(tools, 'voice_v27_vad', { action: 'markdown', sessionId: 's1' });
  assert.match(md, /Turn-taking v27/);
  parseErr(await run(tools, 'voice_v27_vad', { action: 'preset', sessionId: 's1', preset: 'nope' }));
  parseErr(await run(tools, 'voice_v27_vad', { action: 'get-turn', sessionId: 's1', turnId: 'nope' }));
});

test('voice v27 tools: personas end to end', async () => {
  const tools = createVoiceV27Tools({ getBaseDir: () => tmpDir() });
  const listed = parseOk(await run(tools, 'voice_v27_personas', { action: 'list' }));
  assert.equal(listed.length, 8);
  const vi = parseOk(await run(tools, 'voice_v27_personas', { action: 'list', language: 'vi' }));
  assert.equal(vi.length, 2);
  const got = parseOk(await run(tools, 'voice_v27_personas', { action: 'get', personaId: 'v27-calm' }));
  assert.equal(got.voice, 'mock-calm');
  const registered = parseOk(await run(tools, 'voice_v27_personas', {
    action: 'register',
    definitionJson: JSON.stringify({
      id: 'custom-hera', name: 'Hera', language: 'en', voice: 'mock-hera',
      rate: 1.1, pitch: 3, styles: ['warm'], description: 'test', builtin: false,
    }),
  }));
  assert.equal(registered.id, 'custom-hera');
  parseErr(await run(tools, 'voice_v27_personas', {
    action: 'register',
    definitionJson: JSON.stringify({ id: 'bad id', name: 'x', language: 'en', voice: 'v', rate: 1, pitch: 0, styles: ['warm'], description: '', builtin: false }),
  }));
  const assigned = parseOk(await run(tools, 'voice_v27_personas', {
    action: 'assign', botId: 'bot-1', personaId: 'custom-hera', atMs: 100,
  }));
  assert.equal(assigned.personaId, 'custom-hera');
  const assignment = parseOk(await run(tools, 'voice_v27_personas', { action: 'assignment', botId: 'bot-1' }));
  assert.equal(assignment.personaId, 'custom-hera');
  const switched = parseOk(await run(tools, 'voice_v27_personas', {
    action: 'switch', botId: 'bot-1', personaId: 'v27-calm', midSession: 'true', atMs: 200,
  }));
  assert.equal(switched.previousPersonaId, 'custom-hera');
  assert.equal(switched.midSession, true);
  const preview = parseOk(await run(tools, 'voice_v27_personas', {
    action: 'preview', personaId: 'v27-calm', text: 'Hello world',
  }));
  assert.equal(preview.mock, true);
  assert.ok(preview.durationEstimateMs > 0);
  const fallback = parseOk(await run(tools, 'voice_v27_personas', {
    action: 'fallback', language: 'vi', style: 'formal',
  }));
  assert.equal(fallback[0].id, 'v27-formal-vi');
  const stats = parseOk(await run(tools, 'voice_v27_personas', { action: 'stats' }));
  assert.equal(stats.personas, 9);
  assert.equal(stats.assignments, 1);
  const removed = parseOk(await run(tools, 'voice_v27_personas', { action: 'remove', personaId: 'custom-hera' }));
  assert.equal(removed.removed, true);
  const md = await run(tools, 'voice_v27_personas', { action: 'markdown' });
  assert.match(md, /Voice personas v27/);
  parseErr(await run(tools, 'voice_v27_personas', { action: 'get', personaId: 'nope' }));
  parseErr(await run(tools, 'voice_v27_personas', { action: 'assignment', botId: 'ghost-bot' }));
});

test('voice v27 tools: durable session + state store + report end to end', async () => {
  const dir = tmpDir();
  const tools = createVoiceV27Tools({ getBaseDir: () => dir });
  const opened = parseOk(await run(tools, 'voice_v27_session', {
    action: 'open', sessionId: 's1', botId: 'bot-1', personaId: 'v27-friendly', atMs: 0,
  }));
  assert.equal(opened.state, 'listening');
  assert.equal(opened.persona.id, 'v27-friendly');
  assert.ok(fs.existsSync(path.join(dir, 's1.json')));

  parseOk(await run(tools, 'voice_v27_session', { action: 'user-start', sessionId: 's1', text: 'hi', atMs: 100 }));
  for (let i = 0; i < 6; i++) {
    await run(tools, 'voice_v27_session', {
      action: 'user-frame', sessionId: 's1', energy: 0.6, isSpeech: 'true', atMs: 200 + i * 50,
    });
  }
  for (let i = 0; i < 14; i++) {
    await run(tools, 'voice_v27_session', {
      action: 'user-frame', sessionId: 's1', energy: 0.02, atMs: 500 + i * 50,
    });
  }
  const reply = parseOk(await run(tools, 'voice_v27_session', {
    action: 'agent-reply', sessionId: 's1', text: 'Hello, how can I help you today?', atMs: 1600,
  }));
  assert.equal(reply.state, 'speaking');
  const cut = parseOk(await run(tools, 'voice_v27_session', {
    action: 'user-frame', sessionId: 's1', energy: 0.8, speechMs: 500, stopLatencyMs: 90, atMs: 2500,
  }));
  assert.equal(cut.interrupt.decision, 'confirmed');
  assert.equal(cut.snapshot.state, 'listening');
  assert.equal(cut.snapshot.interrupts, 1);
  parseOk(await run(tools, 'voice_v27_session', {
    action: 'agent-reply', sessionId: 's1', text: 'Of course.', atMs: 2600,
  }));
  const done = parseOk(await run(tools, 'voice_v27_session', {
    action: 'agent-done', sessionId: 's1', spokenChars: 11, atMs: 3000,
  }));
  assert.equal(done.state, 'listening');
  assert.equal(done.turns, 3);

  // The durable store sees the same session (same baseDir).
  const verified = parseOk(await run(tools, 'voice_v27_state', { action: 'verify', sessionId: 's1' }));
  assert.equal(verified.ok, true);
  assert.equal(verified.state, 'listening');
  const loaded = parseOk(await run(tools, 'voice_v27_state', { action: 'load', sessionId: 's1' }));
  assert.equal(loaded.turns, 3);
  assert.equal(loaded.interrupts, 1);
  const listed = parseOk(await run(tools, 'voice_v27_state', { action: 'list' }));
  assert.equal(listed.length, 1);

  // Pause / resume / checkpoint / close through the session tool.
  assert.equal(parseOk(await run(tools, 'voice_v27_session', { action: 'pause', sessionId: 's1', atMs: 3100 })).state, 'paused');
  assert.equal(parseOk(await run(tools, 'voice_v27_session', { action: 'resume', sessionId: 's1', atMs: 3200 })).state, 'listening');
  const checkpointed = parseOk(await run(tools, 'voice_v27_session', {
    action: 'checkpoint', sessionId: 's1', label: 'mid', atMs: 3300,
  }));
  assert.equal(checkpointed.checkpoints.length, 1);
  const state = parseOk(await run(tools, 'voice_v27_session', { action: 'state', sessionId: 's1' }));
  assert.equal(state.state, 'listening');
  const summary = await run(tools, 'voice_v27_session', { action: 'summary', sessionId: 's1' });
  assert.match(summary, /Voice session v27 s1/);
  const closed = parseOk(await run(tools, 'voice_v27_session', { action: 'close', sessionId: 's1', atMs: 4000 }));
  assert.equal(closed.state, 'ended');

  // Ended is terminal through the tools as well.
  parseErr(await run(tools, 'voice_v27_session', {
    action: 'agent-reply', sessionId: 's1', text: 'hi', atMs: 4100,
  }));
  parseErr(await run(tools, 'voice_v27_session', { action: 'restore', sessionId: 'ghost' }));
  parseErr(await run(tools, 'voice_v27_state', { action: 'load', sessionId: 'ghost' }));
  parseErr(await run(tools, 'voice_v27_state', {
    action: 'transition', sessionId: 's1', to: 'listening', atMs: 4200,
  }));

  const report = parseOk(await run(tools, 'voice_v27_report', { action: 'summary' }));
  assert.equal(report.totals.sessions, 1);
  assert.equal(report.totals.turns, 3);
  assert.equal(report.totals.interrupts, 1);
  const reportMd = await run(tools, 'voice_v27_report', { action: 'markdown' });
  assert.match(reportMd, /Voice report v27/);

  // Recovery + purge through the state tool on a crashed session.
  const tools2 = createVoiceV27Tools({ getBaseDir: () => dir });
  parseOk(await run(tools2, 'voice_v27_session', {
    action: 'open', sessionId: 's2', botId: 'bot-1', atMs: 0,
  }));
  const recovered = parseOk(await run(tools2, 'voice_v27_state', { action: 'recover', atMs: 5000 }));
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].sessionId, 's2');
  assert.equal(recovered[0].state, 'paused');
  const restored = parseOk(await run(tools2, 'voice_v27_session', { action: 'restore', sessionId: 's2', atMs: 5100 }));
  assert.equal(restored.state, 'paused');
  assert.equal(restored.recovered, true);
});

test('voice v27 tools: ALL_TOOLS wiring (bound replace-in-place, never duplicated)', () => {
  const names = ALL_TOOLS.map((t) => t.definition.name);
  for (const name of VOICE_V27_TOOL_NAMES) {
    assert.equal(names.filter((n) => n === name).length, 1, `${name} appears exactly once in ALL_TOOLS`);
  }
  assert.equal(VOICE_V27_TOOL_NAMES.length, 6);
  assert.equal(VOICE_V27_TOOLS.length, 6);
  for (const tool of VOICE_V27_TOOLS) {
    assert.ok(isVoiceV27ToolName(tool.definition.name));
    assert.equal(tool.needsApproval, false);
  }
  assert.equal(isVoiceV27ToolName('voice_v27_session'), true);
  assert.equal(isVoiceV27ToolName('voice_v26_session'), false);
  const bound = createDefaultTools({
    getVoiceV27ToolOptions: () => ({ interruptOptions: { mode: 'keyword-only' } }),
  });
  const boundNames = bound.map((t) => t.definition.name);
  for (const name of VOICE_V27_TOOL_NAMES) {
    assert.equal(boundNames.filter((n) => n === name).length, 1, `${name} appears exactly once when bound`);
  }
  assert.equal(boundNames.length, names.length);
});

test('voice v27 i18n: all keys present in all 6 locales, equal counts, sorted files', () => {
  assert.equal(VOICE_V27_I18N_KEYS.length, 63);
  assert.deepEqual([...VOICE_V27_I18N_KEYS], [...VOICE_V27_I18N_KEYS].sort(), 'v27 keys sorted');
  for (const key of VOICE_V27_I18N_KEYS) {
    assert.ok(key.startsWith('voice.v27.'), key);
  }
  assert.equal(new Set(VOICE_V27_I18N_KEYS).size, VOICE_V27_I18N_KEYS.length, 'no duplicate i18n keys');
  const counts = [];
  for (const locale of LOCALES) {
    const data = JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, `${locale}.json`), 'utf8'));
    const keys = Object.keys(data);
    assert.deepEqual(keys, [...keys].sort(), `${locale} keys must stay sorted`);
    counts.push(keys.length);
    assert.ok(keys.length >= BASE_LOCALE_KEY_COUNT, `${locale} lost keys vs base`);
    for (const key of VOICE_V27_I18N_KEYS) {
      assert.ok(typeof data[key] === 'string' && data[key].length > 0, `${locale} missing ${key}`);
    }
  }
  assert.equal(new Set(counts).size, 1, `locale key counts differ: ${counts.join(', ')}`);
});
