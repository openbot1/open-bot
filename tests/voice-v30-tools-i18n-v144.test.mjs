/**
 * Tests for voice v30 tools + i18n + session end to end (v1.44, Team T4).
 *
 * Covers: the 6 voice_v30_* tools are registered with the right
 * names, the session tool drives a full-duplex session v2 end to
 * end (start, feed a user turn, respond, barge in soft while the
 * agent speaks, resume from a sentence boundary, complete,
 * proactive task-complete, cost tick + forecast, degrade +
 * recover), the turns/duplex/barge-in/proactive/cost tools work
 * standalone, unknown actions fail cleanly, and all 61
 * voice.v30 i18n keys exist in all 6 locales (floor on the
 * total, never an exact pin).
 *
 * All offline, deterministic, no key / network / audio.
 * Only the v30 namespace is asserted — no global totals.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  VOICE_V30_TOOL_NAMES,
  VOICE_V30_TOOLS,
  createVoiceV30Tools,
  isVoiceV30ToolName,
} from '../packages/tools/dist/voiceV30Tools.js';
import { VOICE_V30_I18N_KEYS } from '../packages/core/dist/voiceV30/index.js';

const LOCALES = ['en', 'es', 'fr', 'ja', 'vi', 'zh'];

function loadLocale(locale) {
  return JSON.parse(readFileSync(new URL(`../apps/desktop/src/renderer/i18n/locales/${locale}.json`, import.meta.url), 'utf8'));
}

function toolByName(tools, name) {
  const tool = tools.find((t) => t.definition.name === name);
  assert.notEqual(tool, undefined, `missing tool ${name}`);
  return tool;
}

async function run(tool, args) {
  const raw = await tool.execute(args);
  assert.equal(typeof raw, 'string');
  return raw;
}

function runJson(tool, args) {
  return run(tool, args).then((raw) => {
    assert.ok(!raw.startsWith('Error:'), `tool failed: ${raw}`);
    return JSON.parse(raw);
  });
}

test('v30 tools: 6 tools registered with the expected names', () => {
  assert.equal(VOICE_V30_TOOLS.length, 6);
  assert.deepEqual([...VOICE_V30_TOOL_NAMES], [
    'voice_v30_session',
    'voice_v30_turns',
    'voice_v30_duplex',
    'voice_v30_bargein',
    'voice_v30_proactive',
    'voice_v30_cost',
  ]);
  assert.deepEqual(
    VOICE_V30_TOOLS.map((t) => t.definition.name),
    [...VOICE_V30_TOOL_NAMES],
  );
  assert.equal(isVoiceV30ToolName('voice_v30_session'), true);
  assert.equal(isVoiceV30ToolName('voice_v29_session'), false);
  assert.equal(isVoiceV30ToolName('nope'), false);
  for (const tool of VOICE_V30_TOOLS) {
    assert.equal(tool.needsApproval, false);
    assert.equal(tool.definition.parameters.type, 'object');
    assert.ok(tool.definition.description.length > 40);
  }
});

test('v30 session tool: full-duplex v2 end to end', async () => {
  const tools = createVoiceV30Tools();
  const session = toolByName(tools, 'voice_v30_session');
  const started = await runJson(session, { action: 'start', sessionId: 't1', modelId: 'gpt-live', atMs: 0 });
  assert.equal(started.state, 'listening');
  assert.equal(started.modelId, 'gpt-live');

  // User turn: 10 speech frames, then silence ends the turn.
  for (let i = 0; i < 10; i += 1) {
    await runJson(session, { action: 'feed-frame', sessionId: 't1', atMs: i * 50, energy: 0.8, text: 'hello' });
  }
  let stats = await runJson(session, { action: 'stats', sessionId: 't1', atMs: 500 });
  assert.equal(stats.turns, 0); // not ended yet
  for (let i = 0; i < 18; i += 1) {
    await runJson(session, { action: 'feed-frame', sessionId: 't1', atMs: 500 + i * 50, energy: 0.02 });
  }
  stats = await runJson(session, { action: 'stats', sessionId: 't1', atMs: 1400 });
  assert.equal(stats.turns, 1);
  assert.equal(stats.state, 'thinking');

  // Agent responds; user barges in mid-sentence (soft).
  const response = await runJson(session, {
    action: 'respond', sessionId: 't1', atMs: 1500,
    text: 'Here is the first sentence. Here is the second sentence.',
  });
  assert.equal(response.state, 'active');
  await runJson(session, { action: 'response-spoken', sessionId: 't1', responseId: response.id, spokenChars: 10, atMs: 1600 });
  for (let i = 0; i < 6; i += 1) {
    await runJson(session, { action: 'feed-frame', sessionId: 't1', atMs: 2000 + i * 50, energy: 0.8 });
  }
  const decision = await runJson(session, { action: 'barge-in', sessionId: 't1', requester: 'user-speech', atMs: 2300 });
  assert.equal(decision.verdict, 'interrupt-soft');
  stats = await runJson(session, { action: 'stats', sessionId: 't1', atMs: 2300 });
  assert.equal(stats.state, 'paused');
  assert.equal(stats.softInterruptions, 1);
  // The user turn never opened while the agent spoke (echo guard).
  assert.equal(stats.turns, 1);

  // Resume from the sentence boundary, then complete.
  const resumed = await runJson(session, { action: 'resume-remainder', sessionId: 't1', responseId: response.id, atMs: 2400 });
  assert.notEqual(resumed, null);
  assert.ok(resumed.text.startsWith('Here is the second sentence.'));
  const done = await runJson(session, { action: 'response-done', sessionId: 't1', responseId: resumed.id, atMs: 3000 });
  assert.equal(done.state, 'completed');
  stats = await runJson(session, { action: 'stats', sessionId: 't1', atMs: 3000 });
  assert.equal(stats.state, 'listening');

  // Proactive task-complete fires; cost ticks and forecasts.
  await runJson(session, { action: 'schedule-proactive', sessionId: 't1', kind: 'task-complete', text: 'Your report is ready.', atMs: 3000 });
  const fired = await runJson(session, { action: 'proactive-tick', sessionId: 't1', atMs: 3000 });
  assert.notEqual(fired, null);
  assert.equal(fired.kind, 'task-complete');
  const entries = await runJson(session, { action: 'tick-cost', sessionId: 't1', atMs: 3000 });
  assert.ok(Array.isArray(entries));
  assert.ok(entries.length >= 1);
  const forecast = await runJson(session, { action: 'forecast', sessionId: 't1', atMs: 3000 });
  assert.equal(typeof forecast.projectedDayUsd, 'number');

  // Degrade and recover the duplex engine.
  const degraded = await runJson(session, { action: 'degrade-duplex', sessionId: 't1', reason: 'manual', atMs: 3100 });
  assert.equal(degraded.degraded, true);
  assert.equal(degraded.state, 'degraded');
  const recovered = await runJson(session, { action: 'recover-duplex', sessionId: 't1', atMs: 3200 });
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.snapshot.state, 'listening');

  const stopped = await runJson(session, { action: 'stop', sessionId: 't1', atMs: 3300 });
  assert.equal(stopped.state, 'ended');
});

test('v30 turns tool: detector standalone with presets', async () => {
  const tools = createVoiceV30Tools();
  const turns = toolByName(tools, 'voice_v30_turns');
  const presets = await runJson(turns, { action: 'presets', sessionId: 'd1' });
  assert.ok(presets.includes('noisy-room'));
  const applied = await runJson(turns, { action: 'preset', sessionId: 'd1', preset: 'noisy-room' });
  assert.equal(applied.highThreshold, 0.35);
  for (let i = 0; i < 8; i += 1) {
    await runJson(turns, { action: 'feed', sessionId: 'd1', atMs: i * 50, energy: 0.8, text: 'hi' });
  }
  // Noisy-room preset: 150ms hangover + 900ms silence timeout, so the
  // turn needs ~30 silence frames to end.
  for (let i = 0; i < 30; i += 1) {
    await runJson(turns, { action: 'feed', sessionId: 'd1', atMs: 400 + i * 50, energy: 0.02 });
  }
  const stats = await runJson(turns, { action: 'stats', sessionId: 'd1' });
  assert.equal(stats.turns, 1);
  const bad = await run(turns, { action: 'preset', sessionId: 'd1', preset: 'nope' });
  assert.ok(bad.startsWith('Error:'));
});

test('v30 duplex tool: lanes, SLO turn, degrade and recover', async () => {
  const tools = createVoiceV30Tools();
  const duplex = toolByName(tools, 'voice_v30_duplex');
  await runJson(duplex, { action: 'push-inbound', sessionId: 'x1', atMs: 100, energy: 0.8, text: 'second' });
  await runJson(duplex, { action: 'push-inbound', sessionId: 'x1', atMs: 0, energy: 0.8, text: 'first' });
  const drained = await runJson(duplex, { action: 'drain-inbound', sessionId: 'x1', maxFrames: 10 });
  assert.deepEqual(drained.map((f) => f.text), ['first', 'second']);
  await runJson(duplex, { action: 'start-turn', sessionId: 'x1', atMs: 0, mode: 'speech-to-speech' });
  await runJson(duplex, { action: 'first-byte', sessionId: 'x1', atMs: 150 });
  const turn = await runJson(duplex, { action: 'end-turn', sessionId: 'x1', atMs: 500 });
  assert.equal(turn.withinTotalSlo, true);
  await runJson(duplex, { action: 'degrade', sessionId: 'x1', reason: 'manual', atMs: 600 });
  const stats = await runJson(duplex, { action: 'stats', sessionId: 'x1' });
  assert.equal(stats.degraded, true);
  const recovered = await runJson(duplex, { action: 'recover', sessionId: 'x1', atMs: 700 });
  assert.equal(recovered.recovered, true);
});

test('v30 barge-in tool: score, soft interrupt, resume', async () => {
  const tools = createVoiceV30Tools();
  const barge = toolByName(tools, 'voice_v30_bargein');
  const response = await runJson(barge, { action: 'start-response', sessionId: 'b1', text: 'One. Two. Three.', atMs: 0 });
  await runJson(barge, { action: 'mark-spoken', sessionId: 'b1', responseId: response.id, spokenChars: 2, atMs: 500 });
  const scored = await runJson(barge, { action: 'score', sessionId: 'b1', speechMs: 300, peakEnergy: 0.6, energiesJson: '[0.4,0.5,0.55,0.6]' });
  assert.ok(scored.confidence >= 0.55 && scored.confidence < 0.8);
  const decision = await runJson(barge, {
    action: 'request-interrupt', sessionId: 'b1', requester: 'user-speech', atMs: 1000,
    speechMs: 300, peakEnergy: 0.6, energiesJson: '[0.4,0.5,0.55,0.6]',
  });
  assert.equal(decision.verdict, 'interrupt-soft');
  const resumed = await runJson(barge, { action: 'resume-remainder', sessionId: 'b1', responseId: response.id, atMs: 1200 });
  assert.ok(resumed.text.startsWith('Two.'));
  const stats = await runJson(barge, { action: 'stats', sessionId: 'b1' });
  assert.equal(stats.resumes, 1);
});

test('v30 proactive tool: schedule, dedupe, tick, quiet hours', async () => {
  const tools = createVoiceV30Tools();
  const pro = toolByName(tools, 'voice_v30_proactive');
  const first = await runJson(pro, { action: 'schedule', sessionId: 'p1', kind: 'task-complete', text: 'Done', atMs: 0, dedupeKey: 'k1' });
  assert.equal(first.state, 'scheduled');
  const dup = await runJson(pro, { action: 'schedule', sessionId: 'p1', kind: 'task-complete', text: 'Done again', atMs: 100, dedupeKey: 'k1' });
  assert.equal(dup.state, 'deduplicated');
  const fired = await runJson(pro, { action: 'tick', sessionId: 'p1', atMs: 0 });
  assert.equal(fired.text, 'Done');
  const stats = await runJson(pro, { action: 'stats', sessionId: 'p1' });
  assert.equal(stats.fired, 1);
  assert.equal(stats.deduplicated, 1);
  const unknown = await run(pro, { action: 'explode', sessionId: 'p1' });
  assert.ok(unknown.startsWith('Error:'));
});

test('v30 cost tool: estimate, tick, report, statement', async () => {
  const tools = createVoiceV30Tools();
  const cost = toolByName(tools, 'voice_v30_cost');
  const est = await runJson(cost, { action: 'estimate', modelId: 'gpt-live', minutes: 2, tokens: 1000, atMs: 0 });
  assert.equal(est.estimatedUsd, 0.11);
  await runJson(cost, { action: 'start', sessionId: 'c1', modelId: 'gpt-live', atMs: 0 });
  const entries = await runJson(cost, { action: 'tick', sessionId: 'c1', inputMs: 60000, tokens: 1000, atMs: 60000 });
  assert.equal(entries.length, 2);
  const report = await runJson(cost, { action: 'report' });
  assert.equal(report.totalUsd, 0.06);
  const md = await run(cost, { action: 'statement-md', sessionId: 'c1' });
  assert.ok(md.includes('# Voice cost statement (v30) — c1'));
  const csv = await run(cost, { action: 'statement-csv', sessionId: 'c1' });
  assert.ok(csv.startsWith('sessionId,modelId,kind,'));
  const bad = await run(cost, { action: 'tick', sessionId: 'c1', inputMs: -5, atMs: 70000 });
  assert.ok(bad.startsWith('Error:'));
});

test('v30 i18n: all keys exist in all 6 locales', () => {
  assert.ok(VOICE_V30_I18N_KEYS.length >= 60, `expected at least 60 keys, got ${VOICE_V30_I18N_KEYS.length}`);
  for (const locale of LOCALES) {
    const data = loadLocale(locale);
    for (const key of VOICE_V30_I18N_KEYS) {
      assert.ok(
        typeof data[key] === 'string' && data[key].length > 0,
        `missing voice.v30 key ${key} in locale ${locale}`,
      );
    }
  }
  // The total key count only grows (floor, never an exact pin).
  const en = loadLocale('en');
  assert.ok(Object.keys(en).length >= 9245);
});
