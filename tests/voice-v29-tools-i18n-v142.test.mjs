/**
 * Tests for voice v29 tools + i18n (v1.42, Team T4).
 *
 * Covers: the 7 voice_v29_* tools are registered with the right
 * names, the session tool drives a full-duplex session end to
 * end (start, feed, respond, barge-in, stats), the cost tool
 * prices minutes, the pipeline tool enforces budgets, unknown
 * actions fail cleanly, and all 60 voice.v29 i18n keys exist in
 * all 6 locales (floor on the total, never an exact pin).
 *
 * All offline, deterministic, no key / network / audio.
 * Only the v29 namespace is asserted — no global totals.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  VOICE_V29_TOOL_NAMES,
  VOICE_V29_TOOLS,
  createVoiceV29Tools,
  isVoiceV29ToolName,
} from '../packages/tools/dist/voiceV29Tools.js';
import { VOICE_V29_I18N_KEYS } from '../packages/core/dist/voiceV29/index.js';

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

test('v29 tools: 7 tools registered with the expected names', () => {
  assert.equal(VOICE_V29_TOOLS.length, 7);
  assert.deepEqual([...VOICE_V29_TOOL_NAMES], [
    'voice_v29_session',
    'voice_v29_turns',
    'voice_v29_context',
    'voice_v29_delegate',
    'voice_v29_proactive',
    'voice_v29_pipeline',
    'voice_v29_cost',
  ]);
  assert.deepEqual(
    VOICE_V29_TOOLS.map((t) => t.definition.name),
    [...VOICE_V29_TOOL_NAMES],
  );
  assert.equal(isVoiceV29ToolName('voice_v29_session'), true);
  assert.equal(isVoiceV29ToolName('voice_v28_session'), false);
  assert.equal(isVoiceV29ToolName('nope'), false);
  for (const tool of VOICE_V29_TOOLS) {
    assert.equal(tool.needsApproval, false);
    assert.equal(tool.definition.parameters.type, 'object');
    assert.ok(tool.definition.description.length > 40);
  }
});

test('v29 session tool: start, feed, respond, barge-in, stats end to end', async () => {
  const tools = createVoiceV29Tools();
  const session = toolByName(tools, 'voice_v29_session');
  const started = await runJson(session, { action: 'start', sessionId: 't1', modelId: 'gpt-live', atMs: 0 });
  assert.equal(started.state, 'listening');
  assert.equal(started.modelId, 'gpt-live');
  // Starting twice is an error, not a crash.
  const twice = await run(session, { action: 'start', sessionId: 't1', atMs: 0 });
  assert.ok(twice.startsWith('Error:'));
  // Feed speech frames, then silence until the turn ends.
  for (let i = 0; i < 10; i += 1) {
    await runJson(session, { action: 'feed-frame', sessionId: 't1', energy: 0.8, atMs: 100 + i * 50 });
  }
  let ended = false;
  for (let i = 0; i < 18; i += 1) {
    const result = await runJson(session, { action: 'feed-frame', sessionId: 't1', energy: 0.02, atMs: 600 + i * 50 });
    if (result.turnEnded) ended = true;
  }
  assert.equal(ended, true);
  const response = await runJson(session, {
    action: 'respond',
    sessionId: 't1',
    text: 'Hello, this is a long reply that keeps going on and on.',
    atMs: 2000,
  });
  assert.equal(typeof response.id, 'string');
  const decision = await runJson(session, {
    action: 'barge-in',
    sessionId: 't1',
    requester: 'user-speech',
    speechMs: 600,
    energy: 0.8,
    atMs: 3000,
  });
  assert.equal(decision.verdict, 'interrupt');
  const resumed = await runJson(session, { action: 'resume-remainder', sessionId: 't1', responseId: response.id, atMs: 3100 });
  assert.notEqual(resumed, null);
  assert.ok((resumed.remainingText?.length ?? 0) > 0);
  const stats = await runJson(session, { action: 'stats', sessionId: 't1', atMs: 3200 });
  assert.equal(stats.turns, 1);
  assert.equal(stats.interruptions, 1);
  const stopped = await runJson(session, { action: 'stop', sessionId: 't1', atMs: 4000 });
  assert.equal(stopped.state, 'ended');
  // Unknown sessions and actions fail cleanly.
  const unknown = await run(session, { action: 'stats', sessionId: 'ghost', atMs: 0 });
  assert.ok(unknown.startsWith('Error:'));
  const badAction = await run(session, { action: 'explode', sessionId: 't1', atMs: 0 });
  assert.ok(badAction.startsWith('Error:'));
});

test('v29 session tool: models and i18n-keys actions', async () => {
  const tools = createVoiceV29Tools();
  const session = toolByName(tools, 'voice_v29_session');
  const models = await runJson(session, { action: 'models', sessionId: 'x', atMs: 0 });
  assert.equal(models.length, 6);
  assert.equal(models.find((m) => m.modelId === 'gpt-live')?.contextTokens, 128000);
  assert.equal(models.find((m) => m.modelId === 'gemini-3.8-live')?.contextTokens, 131000);
  const keys = await runJson(session, { action: 'i18n-keys', sessionId: 'x', atMs: 0 });
  assert.equal(keys.length, 60);
  assert.deepEqual(keys, [...VOICE_V29_I18N_KEYS]);
});

test('v29 cost tool: estimate, rate-for and cost-for-minutes', async () => {
  const tools = createVoiceV29Tools();
  const cost = toolByName(tools, 'voice_v29_cost');
  const estimate = await runJson(cost, { action: 'estimate', modelId: 'gpt-live', minutes: 10, atMs: 0 });
  assert.equal(estimate.estimatedUsd, 0.5);
  const rate = await runJson(cost, { action: 'rate-for', modelId: 'gpt-realtime-2.1', atMs: 0 });
  assert.equal(rate.usdPerMinute, 0.08);
  const priced = await runJson(cost, { action: 'cost-for-minutes', minutes: 2, usdPerMinute: 0.05, atMs: 0 });
  assert.equal(priced.usd, 0.1);
  const bad = await run(cost, { action: 'estimate', modelId: 'gpt-99', minutes: 1, atMs: 0 });
  assert.ok(bad.startsWith('Error:'));
});

test('v29 cost tool: meter lifecycle on the shared ledger', async () => {
  const tools = createVoiceV29Tools();
  const cost = toolByName(tools, 'voice_v29_cost');
  const meter = await runJson(cost, { action: 'start', sessionId: 'm1', modelId: 'gpt-live', atMs: 0 });
  assert.equal(meter.modelId, 'gpt-live');
  const entry = await runJson(cost, { action: 'tick', sessionId: 'm1', inputMs: 60_000, outputMs: 60_000, atMs: 60_000 });
  assert.equal(entry.usd, 0.1);
  const read = await runJson(cost, { action: 'meter', sessionId: 'm1', atMs: 60_000 });
  assert.equal(read.usd, 0.1);
  const stopped = await runJson(cost, { action: 'stop', sessionId: 'm1', atMs: 61_000 });
  assert.equal(stopped.sessionId, 'm1');
  const report = await runJson(cost, { action: 'report', atMs: 61_000 });
  assert.equal(report.sessions, 1);
  assert.equal(report.totalUsd, 0.1);
});

test('v29 pipeline tool: run, budgets and report', async () => {
  const tools = createVoiceV29Tools();
  const pipeline = toolByName(tools, 'voice_v29_pipeline');
  const budgets = await runJson(pipeline, { action: 'budgets', sessionId: 'p1', atMs: 0 });
  assert.equal(budgets.cascadedTotalMs, 800);
  assert.equal(budgets.s2sTotalMs, 300);
  const turn = await runJson(pipeline, {
    action: 'run-cascaded',
    sessionId: 'p1',
    input: 'hello',
    sttMs: 120,
    llmMs: 280,
    ttsMs: 140,
    atMs: 0,
  });
  assert.equal(turn.totalMs, 540);
  assert.equal(turn.withinBudget, true);
  const over = await runJson(pipeline, {
    action: 'run-cascaded',
    sessionId: 'p1',
    input: 'hello',
    sttMs: 300,
    llmMs: 500,
    ttsMs: 300,
    atMs: 2000,
  });
  assert.equal(over.withinBudget, false);
  const stats = await runJson(pipeline, { action: 'stats', sessionId: 'p1', atMs: 3000 });
  assert.equal(stats.turns, 2);
  const bad = await run(pipeline, { action: 'set-budget', sessionId: 'p1', stage: 'nope', budgetMs: 1, atMs: 0 });
  assert.ok(bad.startsWith('Error:'));
});

test('v29 delegate tool: register, delegate, pump', async () => {
  const tools = createVoiceV29Tools();
  const delegate = toolByName(tools, 'voice_v29_delegate');
  await runJson(delegate, { action: 'register', sessionId: 'd1', toolName: 'lookup', description: 'Mock.', atMs: 0 });
  const call = await runJson(delegate, {
    action: 'delegate',
    sessionId: 'd1',
    toolName: 'lookup',
    argsJson: JSON.stringify({ q: 'x' }),
    mode: 'async',
    atMs: 100,
  });
  assert.equal(call.state, 'queued');
  const finished = await runJson(delegate, { action: 'pump', sessionId: 'd1', atMs: 200 });
  assert.equal(finished.length, 1);
  assert.equal(finished[0].state, 'done');
  assert.match(finished[0].result ?? '', /lookup/);
  const stats = await runJson(delegate, { action: 'stats', sessionId: 'd1', atMs: 200 });
  assert.equal(stats.done, 1);
  assert.ok(stats.registeredTools >= 2);
});

test('v29 context tool: append, compact, as-of', async () => {
  const tools = createVoiceV29Tools();
  const context = toolByName(tools, 'voice_v29_context');
  await runJson(context, { action: 'user-turn', sessionId: 'c1', text: 'hello', atMs: 100 });
  await runJson(context, { action: 'agent-turn', sessionId: 'c1', text: 'hi there', atMs: 200 });
  const all = await runJson(context, { action: 'all', sessionId: 'c1', atMs: 300 });
  assert.equal(all.length, 2);
  const asOf = await runJson(context, { action: 'as-of', sessionId: 'c1', atMs: 150 });
  assert.equal(asOf.length, 1);
  const compacted = await runJson(context, { action: 'compact', sessionId: 'c1', atMs: 400 });
  assert.equal(compacted.supersededCount, 2);
  const live = await runJson(context, { action: 'live', sessionId: 'c1', atMs: 400 });
  assert.equal(live.length, 1);
  assert.equal(live[0].kind, 'summary');
});

test('v29 i18n: all 60 keys exist in all 6 locales, totals use a floor', () => {
  assert.equal(VOICE_V29_I18N_KEYS.length, 60);
  const counts = {};
  for (const locale of LOCALES) {
    const data = loadLocale(locale);
    counts[locale] = Object.keys(data).length;
    for (const key of VOICE_V29_I18N_KEYS) {
      assert.equal(typeof data[key], 'string', `${locale} is missing ${key}`);
      assert.ok(data[key].length > 0, `${locale}:${key} is empty`);
    }
  }
  // All locales carry the same total, at least the floor (base 8935 + 60 v29 keys).
  // NOTE: total is NOT pinned exactly — later waves add keys (v142 merged total is 9245).
  assert.ok(new Set(Object.values(counts)).size === 1, `locale totals differ: ${JSON.stringify(counts)}`);
  for (const locale of LOCALES) {
    assert.ok(counts[locale] >= 8935 + 60, `${locale} total ${counts[locale]} below floor`);
  }
});
