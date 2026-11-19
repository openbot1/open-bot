/**
 * Tests for voice v28 tools + registry wiring + i18n
 * (v1.41, Team T5).
 *
 * Covers voiceV28Tools (all 6 tools end to end against the
 * default mock instances), the v28 tools wiring into
 * ALL_TOOLS (bound replace-in-place, never duplicated), and
 * the voice.v28.* i18n keys in all 6 locales (present,
 * equal counts, sorted files — no hardcoded global total,
 * only the v28 namespace and the base floor).
 *
 * All offline, deterministic, no key / network / audio.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createVoiceV28Tools,
  VOICE_V28_TOOLS,
  VOICE_V28_TOOL_NAMES,
  isVoiceV28ToolName,
} from '../packages/tools/dist/voiceV28Tools.js';
import {
  ALL_TOOLS,
  createDefaultTools,
} from '../packages/tools/dist/tools.js';
import {
  VOICE_V28_I18N_KEYS,
} from '../packages/core/dist/voiceV28/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCALES_DIR = path.join(__dirname, '..', 'apps', 'desktop', 'src', 'renderer', 'i18n', 'locales');
const LOCALES = ['en', 'es', 'fr', 'ja', 'vi', 'zh'];
/** Key count in every locale file on the merge/v141 base (before v28). */
const BASE_LOCALE_KEY_COUNT = 8579;

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

test('voice v28 tools: session lifecycle end to end', async () => {
  const tools = createVoiceV28Tools();
  const started = parseOk(await run(tools, 'voice_v28_session', { action: 'start', sessionId: 's1', botId: 'bot1', atMs: 0 }));
  assert.equal(started.state, 'listening');
  assert.equal(started.style, 'default'); // no blocks yet: fallback preset
  const reply = parseOk(await run(tools, 'voice_v28_session', {
    action: 'reply', sessionId: 's1', text: 'Hello world, this is a long reply for testing purposes', atMs: 100,
  }));
  assert.equal(reply.text.startsWith('Hello world'), true);
  assert.ok(reply.estimatedDurationMs > 0);
  const cut = parseOk(await run(tools, 'voice_v28_session', {
    action: 'barge-in', sessionId: 's1', speechMs: 500, text: 'dừng lại đi', atMs: 1500,
  }));
  assert.equal(cut.interrupted, true);
  assert.ok(cut.remainingText.length > 0);
  const resumed = parseOk(await run(tools, 'voice_v28_session', { action: 'resume-remainder', sessionId: 's1', atMs: 1600 }));
  assert.equal(resumed.text, cut.remainingText);
  const done = parseOk(await run(tools, 'voice_v28_session', { action: 'reply-done', sessionId: 's1', atMs: 5000 }));
  assert.equal(done.state, 'listening');
  const paused = parseOk(await run(tools, 'voice_v28_session', { action: 'pause', sessionId: 's1', atMs: 5100 }));
  assert.equal(paused.state, 'paused');
  const back = parseOk(await run(tools, 'voice_v28_session', { action: 'resume', sessionId: 's1', atMs: 5200 }));
  assert.equal(back.state, 'listening');
  const stats = parseOk(await run(tools, 'voice_v28_session', { action: 'stats', sessionId: 's1', atMs: 5300 }));
  assert.equal(stats.interruptions, 1);
  assert.ok(stats.chunksOut > 0);
  const log = parseOk(await run(tools, 'voice_v28_session', { action: 'log', sessionId: 's1', atMs: 5300 }));
  assert.ok(Array.isArray(log) && log.length > 0);
  const stopped = parseOk(await run(tools, 'voice_v28_session', { action: 'stop', sessionId: 's1', atMs: 6000 }));
  assert.equal(stopped.state, 'ended');
  parseErr(await run(tools, 'voice_v28_session', { action: 'status', sessionId: 'nope', atMs: 0 }));
  parseErr(await run(tools, 'voice_v28_session', { action: 'explode', sessionId: 's1', atMs: 0 }));
});

test('voice v28 tools: stream transport end to end', async () => {
  const tools = createVoiceV28Tools();
  const tone = parseOk(await run(tools, 'voice_v28_stream', { action: 'synth-tone', sessionId: 'st1', source: 'mic', atMs: 0 }));
  assert.equal(tone.accepted, true);
  assert.equal(tone.samples, 480);
  const stats = parseOk(await run(tools, 'voice_v28_stream', { action: 'stats', sessionId: 'st1', atMs: 0 }));
  assert.equal(stats.chunksIn, 1);
  assert.equal(parseOk(await run(tools, 'voice_v28_stream', { action: 'pull-in', sessionId: 'st1', atMs: 0 })).pulled, false);
  const pulled = parseOk(await run(tools, 'voice_v28_stream', { action: 'pull-in', sessionId: 'st1', atMs: 40 }));
  assert.equal(pulled.seq, 0);
  const pushed = parseOk(await run(tools, 'voice_v28_stream', {
    action: 'push-out', sessionId: 'st1', samplesJson: JSON.stringify(new Array(480).fill(0.1)), atMs: 50,
  }));
  assert.equal(pushed.accepted, true);
  const drained = parseOk(await run(tools, 'voice_v28_stream', { action: 'drain', sessionId: 'st1', atMs: 5000 }));
  assert.equal(drained.out.length, 1);
  parseErr(await run(tools, 'voice_v28_stream', { action: 'push-in', sessionId: 'st1', samplesJson: '[]', atMs: 0 }));
  parseErr(await run(tools, 'voice_v28_stream', { action: 'push-in', sessionId: 'st1', samplesJson: 'nope', atMs: 0 }));
});

test('voice v28 tools: style from memory blocks end to end', async () => {
  const tools = createVoiceV28Tools();
  const before = parseOk(await run(tools, 'voice_v28_style', { action: 'current' }));
  assert.equal(before.source, 'fallback');
  assert.equal(before.style, 'default');
  const afterSet = parseOk(await run(tools, 'voice_v28_style', {
    action: 'set-block', label: 'persona', content: 'Nói trang trọng, nói chậm.', atMs: 10,
  }));
  assert.equal(afterSet.config.style, 'formal');
  parseOk(await run(tools, 'voice_v28_style', {
    action: 'set-block', label: 'human', content: 'Tên tôi là Huy. Xưng hô: anh.', atMs: 20,
  }));
  const current = parseOk(await run(tools, 'voice_v28_style', { action: 'current' }));
  assert.equal(current.userName, 'Huy');
  assert.equal(current.addressForm, 'anh');
  assert.equal(current.language, 'vi');
  const greeting = parseOk(await run(tools, 'voice_v28_style', { action: 'greeting' }));
  assert.ok(greeting.greeting.includes('anh'));
  const preset = parseOk(await run(tools, 'voice_v28_style', { action: 'apply-preset', style: 'concise', atMs: 30 }));
  assert.equal(preset.config.style, 'concise');
  const faster = parseOk(await run(tools, 'voice_v28_style', { action: 'adjust-rate', delta: 0.1, atMs: 40 }));
  assert.equal(faster.config.rate, 1.35); // concise 1.25 + 0.1
  const refreshed = parseOk(await run(tools, 'voice_v28_style', { action: 'refresh', atMs: 50 }));
  assert.equal(refreshed.config.style, 'formal'); // blocks win again on refresh
  parseErr(await run(tools, 'voice_v28_style', { action: 'set-block', label: 'other', content: 'x', atMs: 0 }));
  parseErr(await run(tools, 'voice_v28_style', { action: 'apply-preset', style: 'nope', atMs: 0 }));
});

test('voice v28 tools: commands + transcript + casting end to end', async () => {
  const tools = createVoiceV28Tools();
  const stop = parseOk(await run(tools, 'voice_v28_commands', { action: 'route', transcript: 'dừng lại', atMs: 0 }));
  assert.equal(stop.kind, 'stop-session');
  assert.equal(stop.execution, 'confirm-first');
  const style = parseOk(await run(tools, 'voice_v28_commands', { action: 'route', transcript: 'nói trang trọng hơn', atMs: 10 }));
  assert.equal(style.kind, 'switch-style');
  const unknown = parseOk(await run(tools, 'voice_v28_commands', { action: 'route', transcript: 'hello there', atMs: 20 }));
  assert.equal(unknown.kind, 'unknown');
  const stats = parseOk(await run(tools, 'voice_v28_commands', { action: 'stats', atMs: 30 }));
  assert.equal(stats.matches, 3);
  assert.equal(stats.unknowns, 1);

  const recorded = parseOk(await run(tools, 'voice_v28_transcript', {
    action: 'record', sessionId: 't1', speaker: 'user', text: 'Deploy the release please.', startedAtMs: 0, endedAtMs: 1000,
  }));
  assert.equal(recorded.text, 'Deploy the release please.');
  const summary = parseOk(await run(tools, 'voice_v28_transcript', { action: 'summary', sessionId: 't1', atMs: 1000 }));
  assert.equal(summary.turns, 1);
  assert.equal(summary.words, 4);
  const md = await run(tools, 'voice_v28_transcript', { action: 'export-markdown', sessionId: 't1', atMs: 1000 });
  assert.ok(md.includes('# Voice session t1'));

  const assigned = parseOk(await run(tools, 'voice_v28_casting', {
    action: 'assign', botId: 'bot1', role: 'narrator', voiceId: 'voice-a', atMs: 0,
  }));
  assert.equal(assigned.voiceId, 'voice-a');
  const resolved = parseOk(await run(tools, 'voice_v28_casting', { action: 'resolve', botId: 'bot1', role: 'narrator', atMs: 0 }));
  assert.equal(resolved.voiceId, 'voice-a');
  const cast = parseOk(await run(tools, 'voice_v28_casting', { action: 'cast', botId: 'bot1', atMs: 0 }));
  assert.equal(cast.assistant.voiceId, 'mock-default');
  parseErr(await run(tools, 'voice_v28_casting', { action: 'resolve', botId: 'bot1', role: 'singer', atMs: 0 }));
});

test('voice v28 tools: aggregate report end to end', async () => {
  const tools = createVoiceV28Tools();
  const empty = parseOk(await run(tools, 'voice_v28_report', { action: 'report', atMs: 0 }));
  assert.equal(empty.sessions, 0);
  assert.equal(empty.turns, 0);
  parseOk(await run(tools, 'voice_v28_session', { action: 'start', sessionId: 'r1', botId: 'bot1', atMs: 0 }));
  parseOk(await run(tools, 'voice_v28_session', { action: 'reply', sessionId: 'r1', text: 'Hello world, this is a reply', atMs: 100 }));
  parseOk(await run(tools, 'voice_v28_session', { action: 'reply-done', sessionId: 'r1', atMs: 2000 }));
  parseOk(await run(tools, 'voice_v28_session', { action: 'start', sessionId: 'r2', botId: 'bot2', atMs: 0 }));
  parseOk(await run(tools, 'voice_v28_session', { action: 'stop', sessionId: 'r2', atMs: 500 }));
  const report = parseOk(await run(tools, 'voice_v28_report', { action: 'report', atMs: 3000 }));
  assert.equal(report.sessions, 2);
  assert.equal(report.openSessions, 1);
  assert.equal(report.endedSessions, 1);
  assert.equal(report.turns, 1);
  assert.equal(report.byBot.bot1.sessions, 1);
  assert.equal(report.byBot.bot2.sessions, 1);
  assert.equal(report.rollups.length, 2);
  const one = parseOk(await run(tools, 'voice_v28_report', { action: 'rollup', sessionId: 'r1', atMs: 3000 }));
  assert.equal(one.sessionId, 'r1');
  assert.equal(one.turns, 1);
  assert.deepEqual(parseOk(await run(tools, 'voice_v28_report', { action: 'list', atMs: 3000 })), ['r1', 'r2']);
  const md = await run(tools, 'voice_v28_report', { action: 'markdown', atMs: 3000 });
  assert.ok(md.includes('# Voice report v28'));
  assert.ok(md.includes('| bot1 | 1 |'));
  parseErr(await run(tools, 'voice_v28_report', { action: 'rollup', sessionId: 'nope', atMs: 0 }));
  assert.deepEqual(parseOk(await run(tools, 'voice_v28_report', { action: 'unregister', sessionId: 'r2', atMs: 0 })), { removed: true });
  assert.deepEqual(parseOk(await run(tools, 'voice_v28_report', { action: 'unregister', sessionId: 'r2', atMs: 0 })), { removed: false });
});

test('voice v28 tools: tool names + ALL_TOOLS wiring (bound replace-in-place, never duplicated)', () => {
  assert.deepEqual([...VOICE_V28_TOOL_NAMES], [
    'voice_v28_session',
    'voice_v28_stream',
    'voice_v28_style',
    'voice_v28_commands',
    'voice_v28_transcript',
    'voice_v28_casting',
    'voice_v28_report',
  ]);
  for (const name of VOICE_V28_TOOL_NAMES) assert.equal(isVoiceV28ToolName(name), true);
  assert.equal(isVoiceV28ToolName('voice_v27_session'), false);
  assert.equal(VOICE_V28_TOOLS.length, 7);
  assert.deepEqual(VOICE_V28_TOOLS.map((t) => t.definition.name), [...VOICE_V28_TOOL_NAMES]);
  for (const tool of VOICE_V28_TOOLS) assert.equal(tool.needsApproval, false);

  const unboundCount = ALL_TOOLS.filter((t) => isVoiceV28ToolName(t.definition.name)).length;
  assert.equal(unboundCount, 7);

  const bound = createDefaultTools({ getVoiceV28ToolOptions: () => ({}) });
  const boundNames = bound.filter((t) => isVoiceV28ToolName(t.definition.name)).map((t) => t.definition.name);
  assert.deepEqual(boundNames, [...VOICE_V28_TOOL_NAMES]);
  // No duplicates anywhere in the bound list.
  const seen = new Set();
  for (const t of bound) {
    assert.equal(seen.has(t.definition.name), false, `duplicate tool: ${t.definition.name}`);
    seen.add(t.definition.name);
  }
});

test('voice v28 i18n: all keys present in all 6 locales, equal counts, sorted files', () => {
  assert.equal(VOICE_V28_I18N_KEYS.length, 90);
  assert.deepEqual([...VOICE_V28_I18N_KEYS], [...VOICE_V28_I18N_KEYS].sort());
  const counts = [];
  for (const locale of LOCALES) {
    const data = JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, `${locale}.json`), 'utf-8'));
    const keys = Object.keys(data);
    assert.deepEqual(keys, [...keys].sort(), `${locale}.json is not sorted`);
    counts.push(keys.length);
    // Floor, not exact: other v1.41 teams add keys too (merge/v141 total is
    // base 8579 + 90 v28 + keys from T1/T2/T3/T4/T6); the exact total is not
    // this test's business — namespace checks below are.
    assert.ok(keys.length >= BASE_LOCALE_KEY_COUNT + VOICE_V28_I18N_KEYS.length, `${locale} key count`);
    for (const key of VOICE_V28_I18N_KEYS) {
      assert.ok(key in data, `${locale} is missing ${key}`);
      assert.equal(typeof data[key], 'string');
      assert.ok(data[key].length > 0, `${locale}:${key} is empty`);
    }
    const v28Count = keys.filter((k) => k.startsWith('voice.v28.')).length;
    assert.equal(v28Count, VOICE_V28_I18N_KEYS.length);
  }
  assert.equal(new Set(counts).size, 1, 'locale key counts differ');
});
