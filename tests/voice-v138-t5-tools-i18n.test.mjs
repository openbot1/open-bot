/**
 * Tests for voice v25 tools + registry wiring + i18n
 * (v1.38, Team T5).
 *
 * Covers voiceV25Tools (all 7 tools end to end against the
 * default mock instances), the v25 tools wiring into ALL_TOOLS
 * (bound replace-in-place, never duplicated), and the
 * voice.v25.* i18n keys in all 6 locales.
 *
 * All offline, deterministic, no key / network / audio.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createVoiceV25Tools,
  VOICE_V25_TOOLS,
  VOICE_V25_TOOL_NAMES,
  isVoiceV25ToolName,
} from '../packages/tools/dist/voiceV25Tools.js';
import {
  ALL_TOOLS,
  createDefaultTools,
} from '../packages/tools/dist/tools.js';
import {
  VOICE_V25_PANEL_I18N_KEYS,
} from '../packages/core/dist/voiceV25/turnPanelV25.js';

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

test('v25 tools: names, count and definitions', () => {
  assert.equal(VOICE_V25_TOOLS.length, 7);
  assert.deepEqual([...VOICE_V25_TOOL_NAMES], [
    'voice_v25_bargein',
    'voice_v25_turns',
    'voice_v25_silence',
    'voice_v25_latency',
    'voice_v25_session',
    'voice_v25_panel',
    'voice_v25_report',
  ]);
  for (const tool of VOICE_V25_TOOLS) {
    assert.ok(isVoiceV25ToolName(tool.definition.name));
    assert.equal(tool.needsApproval, false);
    assert.equal(tool.definition.parameters.type, 'object');
    assert.ok(tool.definition.description.length > 50);
  }
  assert.equal(isVoiceV25ToolName('voice_v24_timers'), false);
  assert.equal(isVoiceV25ToolName('voice_v25_nope'), false);
});

test('v25 tools: wired into ALL_TOOLS once, bound replace-in-place never duplicates', async () => {
  const names = ALL_TOOLS.map((t) => t.definition.name);
  for (const name of VOICE_V25_TOOL_NAMES) {
    assert.equal(names.filter((n) => n === name).length, 1, `${name} appears exactly once in ALL_TOOLS`);
  }
  const boundOnce = createDefaultTools({ getVoiceV25ToolOptions: () => ({}) });
  const boundNames = boundOnce.map((t) => t.definition.name);
  for (const name of VOICE_V25_TOOL_NAMES) {
    assert.equal(boundNames.filter((n) => n === name).length, 1, `${name} appears exactly once when bound`);
  }
  assert.equal(boundOnce.length, ALL_TOOLS.length);
  const plain = createDefaultTools();
  assert.equal(plain.length, ALL_TOOLS.length);
});

test('v25 bargein tool: speak -> report -> stop, ducks, false positive', async () => {
  const tools = createVoiceV25Tools();
  const reply = 'Hello, I can help you plan the trip to Da Lat.';
  let out = await run(tools, 'voice_v25_bargein', { action: 'speak', sessionId: 's1', turnId: 'turn-2', turnIndex: 1, replyText: reply, atMs: 1000 });
  assert.equal(parseOk(out).speaking, true);
  out = await run(tools, 'voice_v25_bargein', { action: 'progress', sessionId: 's1', spokenChars: 20, atMs: 1800 });
  assert.equal(parseOk(out).reply.spokenChars, 20);
  out = await run(tools, 'voice_v25_bargein', {
    action: 'report', sessionId: 's1', atMs: 2000, atMsIntoReply: 1000,
    energy: 0.8, sustainMs: 600, wordsJson: '["dừng", "ngay"]', userText: 'dừng ngay',
  });
  const burst = parseOk(out);
  assert.equal(burst.decision.decision, 'interrupt');
  assert.ok(burst.bargeIn !== null);
  out = await run(tools, 'voice_v25_bargein', { action: 'stop', sessionId: 's1', spokenChars: 24, atMs: 2300 });
  const stopped = parseOk(out);
  assert.equal(stopped.bargeIn.stopLatencyMs, 300);
  assert.equal(stopped.spokenText, reply.slice(0, 24));
  assert.equal(stopped.resumeStrategy, 'resume');
  out = await run(tools, 'voice_v25_bargein', { action: 'attach', sessionId: 's1', bargeInId: stopped.bargeIn.id, turnId: 'turn-3' });
  assert.equal(parseOk(out).attached, true);
  out = await run(tools, 'voice_v25_bargein', { action: 'false-positive', sessionId: 's1', bargeInId: stopped.bargeIn.id });
  assert.equal(parseOk(out).marked, true);
  out = await run(tools, 'voice_v25_bargein', { action: 'stats', sessionId: 's1' });
  assert.equal(parseOk(out).interruptions, 1);
  assert.equal(parseOk(out).falsePositives, 1);
  out = await run(tools, 'voice_v25_bargein', { action: 'stop', sessionId: 's1', spokenChars: 1, atMs: 2400 });
  parseErr(out);
  out = await run(tools, 'voice_v25_bargein', { action: 'nope', sessionId: 's1' });
  parseErr(out);
});

test('v25 turns tool: full floor flow with timers and markdown', async () => {
  const tools = createVoiceV25Tools();
  let out = await run(tools, 'voice_v25_turns', { action: 'user-start', sessionId: 's1', text: 'xin chào', atMs: 0 });
  let res = parseOk(out);
  assert.equal(res.ok, true);
  assert.equal(res.state, 'user-speaking');
  out = await run(tools, 'voice_v25_turns', { action: 'speech-end', sessionId: 's1', atMs: 1500 });
  assert.equal(parseOk(out).state, 'user-done');
  out = await run(tools, 'voice_v25_turns', { action: 'yield', sessionId: 's1', atMs: 2700 });
  assert.equal(parseOk(out).state, 'agent-thinking');
  out = await run(tools, 'voice_v25_turns', { action: 'agent-start', sessionId: 's1', text: 'Hello there', providerId: 'codex', model: 'gpt-5.2', atMs: 3800 });
  res = parseOk(out);
  assert.equal(res.state, 'agent-speaking');
  out = await run(tools, 'voice_v25_turns', { action: 'running', sessionId: 's1', atMs: 4000 });
  res = parseOk(out);
  assert.equal(res.running.length, 1);
  assert.equal(res.running[0].phase, 'speaking');
  out = await run(tools, 'voice_v25_turns', { action: 'agent-done', sessionId: 's1', atMs: 9000 });
  assert.equal(parseOk(out).state, 'idle');
  out = await run(tools, 'voice_v25_turns', { action: 'stats', sessionId: 's1' });
  res = parseOk(out);
  assert.equal(res.taking.turns, 2);
  assert.equal(res.timers.turns, 2);
  assert.equal(res.timers.completed, 2);
  out = await run(tools, 'voice_v25_turns', { action: 'markdown', sessionId: 's1' });
  res = parseOk(out);
  assert.ok(res.markdown.includes('# Voice v25 turn timers — session s1'));
  assert.ok(res.markdown.includes('| 1 | assistant | completed |'));
  out = await run(tools, 'voice_v25_turns', { action: 'agent-done', sessionId: 's1', atMs: 9100 });
  parseErr(out);
});

test('v25 turns tool: barge-in cuts the agent turn and keeps the spoken prefix', async () => {
  const tools = createVoiceV25Tools();
  await run(tools, 'voice_v25_turns', { action: 'user-start', sessionId: 's1', text: 'hi', atMs: 0 });
  await run(tools, 'voice_v25_turns', { action: 'speech-end', sessionId: 's1', atMs: 1000 });
  await run(tools, 'voice_v25_turns', { action: 'yield', sessionId: 's1', atMs: 2000 });
  const reply = 'Hello, I can help you plan the trip to Da Lat.';
  await run(tools, 'voice_v25_turns', { action: 'agent-start', sessionId: 's1', text: reply, atMs: 2500 });
  let out = await run(tools, 'voice_v25_turns', { action: 'backchannel', sessionId: 's1', text: 'ừm', atMs: 3000 });
  assert.equal(parseOk(out).noted, true);
  out = await run(tools, 'voice_v25_turns', { action: 'barge-in', sessionId: 's1', bargeInId: 'bi-1', spokenText: 'Hello, I can', spokenChars: 12, atMs: 4000 });
  const res = parseOk(out);
  assert.equal(res.state, 'interrupted');
  assert.equal(res.turn.status, 'interrupted');
  out = await run(tools, 'voice_v25_turns', { action: 'list', sessionId: 's1' });
  const turns = parseOk(out).turns;
  assert.equal(turns[1].status, 'interrupted');
  assert.equal(turns[1].text, 'Hello, I can');
  out = await run(tools, 'voice_v25_turns', { action: 'user-start', sessionId: 's1', text: 'dừng lại', atMs: 4200 });
  assert.equal(parseOk(out).state, 'user-speaking');
});

test('v25 silence tool: feed frames, gaps, yield check, markdown', async () => {
  const tools = createVoiceV25Tools();
  let out = await run(tools, 'voice_v25_silence', { action: 'feed-speech', sessionId: 's1', isSpeech: 'true', atMs: 100 });
  assert.equal(parseOk(out).state, 'unknown');
  out = await run(tools, 'voice_v25_silence', { action: 'feed-speech', sessionId: 's1', isSpeech: 'true', atMs: 300 });
  assert.equal(parseOk(out).state, 'speech');
  await run(tools, 'voice_v25_silence', { action: 'feed-speech', sessionId: 's1', isSpeech: 'false', atMs: 1000 });
  out = await run(tools, 'voice_v25_silence', { action: 'feed-speech', sessionId: 's1', isSpeech: 'false', atMs: 1700 });
  assert.equal(parseOk(out).state, 'silence');
  out = await run(tools, 'voice_v25_silence', { action: 'yield-check', sessionId: 's1', atMs: 2000 });
  assert.equal(parseOk(out).shouldYield, false);
  out = await run(tools, 'voice_v25_silence', { action: 'feed-speech', sessionId: 's1', isSpeech: 'false', atMs: 2200 });
  assert.equal(parseOk(out).events.some((e) => e.kind === 'yield'), true);
  out = await run(tools, 'voice_v25_silence', { action: 'feed-energy', sessionId: 's1', energy: 0.9, atMs: 3000 });
  assert.ok(parseOk(out).events.some((e) => e.kind === 'silence-end'));
  out = await run(tools, 'voice_v25_silence', { action: 'stats', sessionId: 's1' });
  const stats = parseOk(out);
  assert.equal(stats.gaps, 1);
  assert.equal(stats.totalSilenceMs, 2000);
  out = await run(tools, 'voice_v25_silence', { action: 'set-floor', sessionId: 's1', noiseFloor: 0.03 });
  assert.equal(parseOk(out).noiseFloor, 0.03);
  out = await run(tools, 'voice_v25_silence', { action: 'markdown', sessionId: 's1' });
  assert.ok(parseOk(out).markdown.includes('# Voice v25 silence — session s1'));
  out = await run(tools, 'voice_v25_silence', { action: 'feed-energy', sessionId: 's1', atMs: 3100 });
  parseErr(out);
});

test('v25 latency tool: record samples, stats, ranking, fallback', async () => {
  const tools = createVoiceV25Tools();
  for (let i = 0; i < 3; i += 1) {
    let out = await run(tools, 'voice_v25_latency', {
      action: 'record', providerId: 'codex', model: 'gpt-5.2', sessionId: 's1',
      ttftMs: 1200, firstAudioMs: 2000, totalMs: 4000, ok: 'true', atMs: 1000 + i * 1000,
    });
    assert.equal(parseOk(out).sample.providerId, 'codex');
    out = await run(tools, 'voice_v25_latency', {
      action: 'record', providerId: 'ollama', model: 'qwen3:8b', sessionId: 's1',
      ttftMs: 200, firstAudioMs: 400, totalMs: 900, ok: 'true', atMs: 1000 + i * 1000,
    });
    assert.equal(parseOk(out).sample.totalMs, 900);
  }
  let out = await run(tools, 'voice_v25_latency', { action: 'stats', providerId: 'codex', sessionId: 's1' });
  let res = parseOk(out);
  assert.equal(res.isSlow, true);
  assert.equal(res.totalP95Ms, 4000);
  out = await run(tools, 'voice_v25_latency', { action: 'rank', sessionId: 's1' });
  res = parseOk(out);
  assert.equal(res.ranking[0].providerId, 'ollama');
  assert.equal(res.ranking[1].providerId, 'codex');
  out = await run(tools, 'voice_v25_latency', {
    action: 'fallback', sessionId: 's1', providerId: 'codex',
    candidatesJson: '["ollama"]', atMs: 5000,
  });
  res = parseOk(out);
  assert.equal(res.switched, true);
  assert.equal(res.toProviderId, 'ollama');
  out = await run(tools, 'voice_v25_latency', { action: 'decisions', sessionId: 's1' });
  assert.equal(parseOk(out).decisions.length, 1);
  out = await run(tools, 'voice_v25_latency', { action: 'stats', providerId: 'nope' });
  parseErr(out);
  out = await run(tools, 'voice_v25_latency', { action: 'markdown', sessionId: 's1' });
  assert.ok(parseOk(out).markdown.includes('| codex |'));
});

test('v25 session tool: open -> full flow -> latency fallback -> close', async () => {
  const tools = createVoiceV25Tools();
  let out = await run(tools, 'voice_v25_session', { action: 'open', sessionId: 's1', providerId: 'codex', model: 'gpt-5.2', atMs: 0 });
  assert.equal(parseOk(out).snapshot.phase, 'open');
  out = await run(tools, 'voice_v25_session', { action: 'open', sessionId: 's1', providerId: 'codex', model: 'gpt-5.2', atMs: 0 });
  parseErr(out);
  await run(tools, 'voice_v25_session', { action: 'user-start', sessionId: 's1', text: 'xin chào', atMs: 0 });
  await run(tools, 'voice_v25_session', { action: 'speech-end', sessionId: 's1', atMs: 1500 });
  await run(tools, 'voice_v25_session', { action: 'yield', sessionId: 's1', atMs: 2700 });
  const reply = 'Hello, I can help you plan the trip to Da Lat.';
  await run(tools, 'voice_v25_session', { action: 'agent-start', sessionId: 's1', replyText: reply, atMs: 3800 });
  out = await run(tools, 'voice_v25_session', { action: 'tool-start', sessionId: 's1', toolName: 'search', atMs: 3900 });
  const callId = parseOk(out).callId;
  await run(tools, 'voice_v25_session', { action: 'tool-end', sessionId: 's1', callId, atMs: 4500 });
  out = await run(tools, 'voice_v25_session', {
    action: 'burst', sessionId: 's1', atMs: 5000, atMsIntoReply: 1200,
    energy: 0.8, sustainMs: 600, wordsJson: '["dừng"]', userText: 'dừng lại',
  });
  assert.ok(parseOk(out).bargeIn !== null);
  out = await run(tools, 'voice_v25_session', { action: 'stop', sessionId: 's1', spokenChars: 12, atMs: 5300 });
  const stopped = parseOk(out);
  assert.equal(stopped.spokenText, reply.slice(0, 12));
  out = await run(tools, 'voice_v25_session', { action: 'snapshot', sessionId: 's1', atMs: 5400 });
  const snap = parseOk(out);
  assert.equal(snap.transcriptTurns, 2);
  assert.equal(snap.bargeIns, 1);
  assert.equal(snap.timers.toolTimeMs, 600);
  // Latency fallback with an empty catalogue has no candidate to switch to.
  out = await run(tools, 'voice_v25_session', { action: 'fallback', sessionId: 's1', atMs: 5500 });
  const fb = parseOk(out);
  assert.equal(fb.switched, false);
  out = await run(tools, 'voice_v25_session', { action: 'close', sessionId: 's1', atMs: 6000 });
  assert.equal(parseOk(out).closedAtMs, 6000);
  out = await run(tools, 'voice_v25_session', { action: 'snapshot', sessionId: 's1', atMs: 6100 });
  assert.equal(parseOk(out).phase, 'closed');
});

test('v25 panel + report tools: snapshot, markdown, aggregate report', async () => {
  const tools = createVoiceV25Tools();
  await run(tools, 'voice_v25_turns', { action: 'user-start', sessionId: 's1', text: 'hi', atMs: 0 });
  await run(tools, 'voice_v25_turns', { action: 'speech-end', sessionId: 's1', atMs: 1000 });
  await run(tools, 'voice_v25_turns', { action: 'yield', sessionId: 's1', atMs: 2000 });
  await run(tools, 'voice_v25_turns', { action: 'agent-start', sessionId: 's1', text: 'Hello', atMs: 2500 });
  let out = await run(tools, 'voice_v25_panel', { action: 'snapshot', sessionId: 's1', atMs: 3000 });
  let res = parseOk(out);
  assert.equal(res.sessionId, 's1');
  assert.equal(res.running.length, 1);
  assert.equal(res.finished.length, 1);
  assert.equal(res.floorHolder, 'agent');
  assert.equal(res.turnTakingState, 'agent-speaking');
  out = await run(tools, 'voice_v25_panel', { action: 'markdown', sessionId: 's1', atMs: 3000 });
  res = parseOk(out);
  assert.ok(res.markdown.includes('# Voice v25 — session s1'));
  assert.ok(res.markdown.includes('## Running turns'));
  out = await run(tools, 'voice_v25_report', { action: 'summary', atMs: 3000 });
  res = parseOk(out);
  assert.equal(res.turns.total, 2);
  out = await run(tools, 'voice_v25_report', { action: 'markdown', atMs: 3000 });
  assert.ok(parseOk(out).markdown.includes('# Voice v25 report'));
  out = await run(tools, 'voice_v25_panel', { action: 'nope', sessionId: 's1' });
  parseErr(out);
});

test('v25 i18n: every panel key exists in all 6 locales, non-empty, no placeholders left', () => {
  assert.ok(VOICE_V25_PANEL_I18N_KEYS.length >= 30, `expected 30+ panel keys, got ${VOICE_V25_PANEL_I18N_KEYS.length}`);
  for (const locale of LOCALES) {
    const file = path.join(LOCALES_DIR, `${locale}.json`);
    assert.ok(fs.existsSync(file), `locale file ${locale}.json exists`);
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const key of VOICE_V25_PANEL_I18N_KEYS) {
      assert.ok(key in data, `${key} missing in ${locale}`);
      assert.equal(typeof data[key], 'string');
      assert.ok(data[key].length > 0, `${key} empty in ${locale}`);
    }
  }
  // All six locales carry exactly the same v25 key set.
  const sets = LOCALES.map((locale) => {
    const data = JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, `${locale}.json`), 'utf8'));
    return new Set(Object.keys(data).filter((k) => k.startsWith('voice.v25.')));
  });
  for (const set of sets.slice(1)) {
    assert.deepEqual([...set].sort(), [...sets[0]].sort());
  }
});
