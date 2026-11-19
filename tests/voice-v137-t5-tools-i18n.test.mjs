/**
 * Tests for voice v24 tools + registry wiring + i18n
 * (v1.37, Team T5).
 *
 * Covers voiceV24Tools (all 7 tools end to end against the
 * default mock instances), the v24 tools wiring into ALL_TOOLS
 * (bound replace-in-place, never duplicated), and the
 * voice.v24.* i18n keys in all 6 locales.
 *
 * All offline, deterministic, no key / network / audio.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createVoiceV24Tools,
  VOICE_V24_TOOLS,
  VOICE_V24_TOOL_NAMES,
  isVoiceV24ToolName,
} from '../packages/tools/dist/voiceV24Tools.js';
import {
  ALL_TOOLS,
  createDefaultTools,
} from '../packages/tools/dist/tools.js';
import {
  VOICE_V24_PANEL_I18N_KEYS,
} from '../packages/core/dist/voiceV24/timerPanelV24.js';

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

const CODEX_JSON = JSON.stringify({
  id: 'codex', label: 'Codex', kind: 'subscription',
  models: [{ id: 'gpt-5.2', label: 'GPT-5.2', supportsVoice: true }],
  configured: true, accountLabel: 'demo@example.com', source: 'cli',
});
const OLLAMA_JSON = JSON.stringify({
  id: 'ollama', label: 'Ollama', kind: 'local',
  models: [{ id: 'qwen3:8b', label: 'Qwen3 8B' }],
  configured: true, source: 'local',
});
const TRANSCRIPT_JSON = JSON.stringify([
  { role: 'user', text: 'xin chào', atMs: 0 },
  { role: 'assistant', text: 'chào bạn', atMs: 100 },
]);

// ---------------------------------------------------------------- tool inventory
test('voice v137-t5: voice v24 tools — 9 tools, names + factory, no dotted names', () => {
  assert.equal(VOICE_V24_TOOLS.length, 9);
  assert.deepEqual([...VOICE_V24_TOOL_NAMES], [
    'voice_v24_timers',
    'voice_v24_providers',
    'voice_v24_model',
    'voice_v24_health',
    'voice_v24_session',
    'voice_v24_panel',
    'voice_v24_report',
    'voice_v24_fallback',
    'voice_v24_budgets',
  ]);
  for (const name of VOICE_V24_TOOL_NAMES) {
    assert.match(name, /^[A-Za-z0-9_-]+$/, `${name} must not contain a dot`);
  }
  assert.equal(isVoiceV24ToolName('voice_v24_timers'), true);
  assert.equal(isVoiceV24ToolName('voice_v23_session'), false);
  assert.equal(createVoiceV24Tools().length, 9);
  for (const tool of VOICE_V24_TOOLS) {
    assert.equal(tool.needsApproval, false);
    assert.equal(typeof tool.execute, 'function');
  }
});

test('voice v137-t5: voice v24 tools are in ALL_TOOLS once, bound tools replace in place', () => {
  const names = ALL_TOOLS.map((t) => t.definition.name);
  for (const name of VOICE_V24_TOOL_NAMES) {
    assert.equal(names.filter((n) => n === name).length, 1, `${name} registered exactly once`);
  }
  // Bound tools replace the placeholders in place (same 9 names, never duplicated).
  const bound = createDefaultTools({
    getVoiceV24ToolOptions: () => ({ timerOptions: { slowThresholdMs: 1000 } }),
  });
  const boundNames = bound.map((t) => t.definition.name);
  for (const name of VOICE_V24_TOOL_NAMES) {
    assert.equal(boundNames.filter((n) => n === name).length, 1, `${name} bound exactly once`);
  }
  assert.equal(bound.length, ALL_TOOLS.length);
});

// ---------------------------------------------------------------- timers tool
test('voice v137-t5: voice_v24_timers — start/end/stats/session/alerts/check', async () => {
  const tools = createVoiceV24Tools({ timerOptions: { slowThresholdMs: 1000, timeoutMs: 5000 } });
  const started = parseOk(await run(tools, 'voice_v24_timers', { action: 'start', sessionId: 's1', toolName: 'web_search', atMs: 0 }));
  assert.equal(started.callId, 'tc-1');
  const running = parseOk(await run(tools, 'voice_v24_timers', { action: 'running', sessionId: 's1', atMs: 1500 }));
  assert.equal(running.running.length, 1);
  assert.equal(running.running[0].elapsedMs, 1500);
  assert.equal(running.running[0].overSlowThreshold, true);
  const checked = parseOk(await run(tools, 'voice_v24_timers', { action: 'check', atMs: 1500 }));
  assert.equal(checked.raised.length, 1);
  assert.equal(checked.raised[0].kind, 'slow');
  const ended = parseOk(await run(tools, 'voice_v24_timers', { action: 'end', callId: 'tc-1', atMs: 2000 }));
  assert.equal(ended.record.durationMs, 2000);
  assert.equal(ended.duration, '2.00s');
  const stats = parseOk(await run(tools, 'voice_v24_timers', { action: 'stats', toolName: 'web_search', sessionId: 's1' }));
  assert.equal(stats.calls, 1);
  assert.equal(stats.slowCalls, 1);
  const session = parseOk(await run(tools, 'voice_v24_timers', { action: 'session', sessionId: 's1' }));
  assert.equal(session.calls, 1);
  assert.equal(session.alerts, 1);
  const md = parseOk(await run(tools, 'voice_v24_timers', { action: 'markdown', sessionId: 's1' }));
  assert.match(md.markdown, /# Voice v24 tool-call timers — session s1/);
  parseErr(await run(tools, 'voice_v24_timers', { action: 'bogus' }));
  parseErr(await run(tools, 'voice_v24_timers', { action: 'end', callId: 'tc-99', atMs: 0 }));
  const failed = parseOk(await run(tools, 'voice_v24_timers', { action: 'start', sessionId: 's1', toolName: 'flaky', atMs: 3000 }));
  parseOk(await run(tools, 'voice_v24_timers', { action: 'fail', callId: failed.callId, atMs: 3100, error: 'boom' }));
  const reset = parseOk(await run(tools, 'voice_v24_timers', { action: 'reset' }));
  assert.equal(reset.reset, true);
});

// ---------------------------------------------------------------- providers tool
test('voice v137-t5: voice_v24_providers — register/probe/list/usable/models/find', async () => {
  const tools = createVoiceV24Tools();
  const empty = parseOk(await run(tools, 'voice_v24_providers', { action: 'list', atMs: 0 }));
  assert.equal(empty.providers.length, 0);
  parseOk(await run(tools, 'voice_v24_providers', { action: 'register', providerJson: CODEX_JSON, atMs: 0 }));
  parseOk(await run(tools, 'voice_v24_providers', { action: 'register', providerJson: OLLAMA_JSON, atMs: 0 }));
  parseOk(await run(tools, 'voice_v24_providers', { action: 'probe', providerId: 'codex', ok: 'true', latencyMs: 120, atMs: 100 }));
  parseOk(await run(tools, 'voice_v24_providers', { action: 'probe', providerId: 'ollama', ok: 'true', latencyMs: 2600, atMs: 100 }));
  const list = parseOk(await run(tools, 'voice_v24_providers', { action: 'list', atMs: 200 }));
  assert.equal(list.providers.length, 2);
  assert.equal(list.providers[0].status, 'online');
  assert.equal(list.providers[1].status, 'degraded');
  assert.equal(list.counts.online, 1);
  assert.equal(list.counts.degraded, 1);
  const usable = parseOk(await run(tools, 'voice_v24_providers', { action: 'usable', atMs: 200 }));
  assert.equal(usable.providers.length, 2);
  const models = parseOk(await run(tools, 'voice_v24_providers', { action: 'models', providerId: 'codex' }));
  assert.deepEqual(models.models.map((m) => m.id), ['gpt-5.2']);
  const found = parseOk(await run(tools, 'voice_v24_providers', { action: 'find', providerId: 'codex', model: 'gpt-5.2' }));
  assert.equal(found.model.label, 'GPT-5.2');
  parseErr(await run(tools, 'voice_v24_providers', { action: 'find', providerId: 'codex', model: 'nope' }));
  const status = parseOk(await run(tools, 'voice_v24_providers', { action: 'status', providerId: 'ollama', atMs: 200 }));
  assert.equal(status.provider.status, 'degraded');
  const needs = parseOk(await run(tools, 'voice_v24_providers', { action: 'needs-probe', atMs: 200000 }));
  assert.deepEqual(needs.providerIds, ['codex', 'ollama']);
  const md = parseOk(await run(tools, 'voice_v24_providers', { action: 'markdown', atMs: 200 }));
  assert.match(md.markdown, /# Voice v24 dynamic providers/);
  parseErr(await run(tools, 'voice_v24_providers', { action: 'register', providerJson: '{"id":"bad id"}' }));
  parseErr(await run(tools, 'voice_v24_providers', { action: 'probe', providerId: 'nope', ok: 'true', atMs: 0 }));
});

// ---------------------------------------------------------------- model tool
test('voice v137-t5: voice_v24_model — switch/rollback/current/history, transcript kept', async () => {
  const tools = createVoiceV24Tools();
  await run(tools, 'voice_v24_providers', { action: 'register', providerJson: CODEX_JSON, atMs: 0 });
  await run(tools, 'voice_v24_providers', { action: 'register', providerJson: OLLAMA_JSON, atMs: 0 });
  await run(tools, 'voice_v24_providers', { action: 'probe', providerId: 'codex', ok: 'true', latencyMs: 120, atMs: 100 });
  await run(tools, 'voice_v24_providers', { action: 'probe', providerId: 'ollama', ok: 'true', latencyMs: 300, atMs: 100 });
  const switched = parseOk(await run(tools, 'voice_v24_model', {
    action: 'switch', sessionId: 's1', providerId: 'codex', model: 'gpt-5.2',
    toProviderId: 'ollama', toModel: 'qwen3:8b', transcriptJson: TRANSCRIPT_JSON, atMs: 1000,
  }));
  assert.equal(switched.ok, true);
  assert.equal(switched.transcriptPreserved, true);
  assert.equal(switched.transcriptTurns, 2);
  const current = parseOk(await run(tools, 'voice_v24_model', { action: 'current', sessionId: 's1' }));
  assert.deepEqual(current.current, { providerId: 'ollama', model: 'qwen3:8b' });
  assert.equal(current.canRollback, true);
  const history = parseOk(await run(tools, 'voice_v24_model', { action: 'history', sessionId: 's1' }));
  assert.equal(history.history.length, 1);
  const modelsUsed = parseOk(await run(tools, 'voice_v24_model', { action: 'models-used', sessionId: 's1' }));
  assert.equal(modelsUsed.models.length, 2);
  const rolled = parseOk(await run(tools, 'voice_v24_model', {
    action: 'rollback', sessionId: 's1', transcriptJson: TRANSCRIPT_JSON, atMs: 2000,
  }));
  assert.equal(rolled.ok, true);
  assert.deepEqual(rolled.to, { providerId: 'codex', model: 'gpt-5.2' });
  const refused = parseErr(await run(tools, 'voice_v24_model', {
    action: 'switch', sessionId: 's1',
    toProviderId: 'nope', toModel: 'x', transcriptJson: TRANSCRIPT_JSON, atMs: 3000,
  }));
  assert.match(refused, /not in the dynamic catalogue/);
  parseErr(await run(tools, 'voice_v24_model', { action: 'switch', sessionId: 's2', toProviderId: 'codex', toModel: 'gpt-5.2' }));
});

// ---------------------------------------------------------------- health tool
test('voice v137-t5: voice_v24_health — record/score/list/degraded/mean/prune', async () => {
  const tools = createVoiceV24Tools();
  for (let i = 0; i < 5; i += 1) {
    parseOk(await run(tools, 'voice_v24_health', { action: 'record', providerId: 'codex', ok: 'true', latencyMs: 100, atMs: i * 1000 }));
  }
  const score = parseOk(await run(tools, 'voice_v24_health', { action: 'score', providerId: 'codex', atMs: 5000 }));
  assert.equal(score.score, 100);
  assert.equal(score.grade, 'A');
  assert.equal(score.degraded, false);
  for (let i = 0; i < 3; i += 1) {
    parseOk(await run(tools, 'voice_v24_health', { action: 'record', providerId: 'bad', ok: 'false', latencyMs: 0, error: 'timeout', atMs: i * 1000 }));
  }
  const degraded = parseOk(await run(tools, 'voice_v24_health', { action: 'degraded', atMs: 5000 }));
  assert.equal(degraded.providers.length, 1);
  assert.equal(degraded.providers[0].providerId, 'bad');
  const mean = parseOk(await run(tools, 'voice_v24_health', { action: 'mean', atMs: 5000 }));
  assert.ok(typeof mean.meanScore === 'number' && mean.meanScore < 100);
  const md = parseOk(await run(tools, 'voice_v24_health', { action: 'markdown', atMs: 5000 }));
  assert.match(md.markdown, /# Voice v24 provider health/);
  const pruned = parseOk(await run(tools, 'voice_v24_health', { action: 'prune', atMs: 4 * 3600000 }));
  assert.equal(pruned.dropped, 8);
  parseErr(await run(tools, 'voice_v24_health', { action: 'record', providerId: 'x', ok: 'true', atMs: 0 }));
});

// ---------------------------------------------------------------- session + panel + report tools
test('voice v137-t5: voice_v24_session + panel + report — full voice session flow', async () => {
  const tools = createVoiceV24Tools();
  await run(tools, 'voice_v24_providers', { action: 'register', providerJson: CODEX_JSON, atMs: 0 });
  await run(tools, 'voice_v24_providers', { action: 'register', providerJson: OLLAMA_JSON, atMs: 0 });
  await run(tools, 'voice_v24_providers', { action: 'probe', providerId: 'codex', ok: 'true', latencyMs: 120, atMs: 100 });
  await run(tools, 'voice_v24_providers', { action: 'probe', providerId: 'ollama', ok: 'true', latencyMs: 300, atMs: 100 });
  const opened = parseOk(await run(tools, 'voice_v24_session', {
    action: 'open', sessionId: 's1', providerId: 'codex', model: 'gpt-5.2', atMs: 0,
  }));
  assert.equal(opened.snapshot.phase, 'open');
  parseErr(await run(tools, 'voice_v24_session', {
    action: 'open', sessionId: 's1', providerId: 'codex', model: 'gpt-5.2', atMs: 0,
  }));
  parseOk(await run(tools, 'voice_v24_session', { action: 'turn', sessionId: 's1', role: 'user', text: 'xin chào', atMs: 100 }));
  const started = parseOk(await run(tools, 'voice_v24_session', { action: 'tool-start', sessionId: 's1', toolName: 'web_search', atMs: 200 }));
  const ended = parseOk(await run(tools, 'voice_v24_session', { action: 'tool-end', sessionId: 's1', callId: started.callId, atMs: 900 }));
  assert.equal(ended.record.durationMs, 700);
  const switched = parseOk(await run(tools, 'voice_v24_session', {
    action: 'switch', sessionId: 's1', toProviderId: 'ollama', toModel: 'qwen3:8b', atMs: 1000,
  }));
  assert.equal(switched.ok, true);
  assert.equal(switched.transcriptTurns, 1);
  const panel = parseOk(await run(tools, 'voice_v24_panel', { action: 'snapshot', sessionId: 's1', atMs: 1100 }));
  assert.equal(panel.providers.length, 2);
  assert.equal(panel.finished.length, 1);
  assert.equal(panel.currentModel.providerId, 'ollama');
  assert.equal(panel.switches.length, 1);
  const panelMd = parseOk(await run(tools, 'voice_v24_panel', { action: 'markdown', sessionId: 's1', atMs: 1100 }));
  assert.match(panelMd.markdown, /# Voice v24 — session s1/);
  assert.match(panelMd.markdown, /## Providers \(dynamic, at panel time\)/);
  const report = parseOk(await run(tools, 'voice_v24_report', { action: 'summary', atMs: 1100 }));
  assert.equal(report.sessions.length, 1);
  assert.equal(report.totalSwitches, 1);
  const reportMd = parseOk(await run(tools, 'voice_v24_report', { action: 'markdown', atMs: 1100 }));
  assert.match(reportMd.markdown, /# Voice v24 report/);
  const closed = parseOk(await run(tools, 'voice_v24_session', { action: 'close', sessionId: 's1', atMs: 2000 }));
  assert.equal(closed.transcriptTurns, 1);
  assert.equal(closed.snapshot.phase, 'closed');
  parseErr(await run(tools, 'voice_v24_panel', { action: 'snapshot', sessionId: 'nope', atMs: 0 }));
  parseErr(await run(tools, 'voice_v24_session', { action: 'turn', sessionId: 'nope', role: 'user', text: 'x', atMs: 0 }));
});

// ---------------------------------------------------------------- fallback + budgets + refresh tools
test('voice v137-t5: voice_v24_fallback + voice_v24_budgets + refresh — chain, pick, breach, burn-down', async () => {
  const tools = createVoiceV24Tools();
  await run(tools, 'voice_v24_providers', { action: 'register', providerJson: CODEX_JSON, atMs: 0 });
  await run(tools, 'voice_v24_providers', { action: 'register', providerJson: OLLAMA_JSON, atMs: 0 });
  await run(tools, 'voice_v24_providers', { action: 'probe', providerId: 'codex', ok: 'true', latencyMs: 120, atMs: 100 });
  await run(tools, 'voice_v24_providers', { action: 'probe', providerId: 'ollama', ok: 'true', latencyMs: 300, atMs: 100 });
  // Fallback chain: codex first, ollama second.
  const chainJson = JSON.stringify([
    { providerId: 'codex', model: 'gpt-5.2' },
    { providerId: 'ollama', model: 'qwen3:8b' },
  ]);
  parseOk(await run(tools, 'voice_v24_fallback', { action: 'set-chain', sessionId: 's1', chainJson, atMs: 0 }));
  const links = parseOk(await run(tools, 'voice_v24_fallback', { action: 'links', sessionId: 's1', atMs: 200 }));
  assert.equal(links.links.length, 2);
  assert.equal(links.links[0].usable, true);
  const picked = parseOk(await run(tools, 'voice_v24_fallback', {
    action: 'pick', sessionId: 's1', providerId: 'codex', model: 'gpt-5.2', reason: 'provider went offline', atMs: 200,
  }));
  assert.deepEqual(picked.to, { providerId: 'ollama', model: 'qwen3:8b' });
  assert.equal(picked.decision.from.model, 'gpt-5.2');
  const history = parseOk(await run(tools, 'voice_v24_fallback', { action: 'history', sessionId: 's1' }));
  assert.equal(history.history.length, 1);
  parseErr(await run(tools, 'voice_v24_fallback', { action: 'pick', sessionId: 'nope', providerId: 'codex', model: 'gpt-5.2', atMs: 0 }));
  // Budgets: a 700ms web_search call against a 500ms per-call budget breaches.
  parseOk(await run(tools, 'voice_v24_budgets', { action: 'set', toolName: 'web_search', perCallMs: 500, perSessionMs: 5000, perTurnMs: 1000 }));
  const got = parseOk(await run(tools, 'voice_v24_budgets', { action: 'get', toolName: 'web_search' }));
  assert.equal(got.budget.perCallMs, 500);
  const callJson = JSON.stringify({
    id: 'tc-1', sessionId: 's1', toolName: 'web_search', turnIndex: 0,
    startedAtMs: 0, endedAtMs: 700, durationMs: 700, status: 'completed',
  });
  const checked = parseOk(await run(tools, 'voice_v24_budgets', {
    action: 'check', callJson, sessionTotalMs: 700, turnTotalMs: 700,
  }));
  assert.equal(checked.raised.length, 1);
  assert.equal(checked.raised[0].kind, 'per-call');
  const breaches = parseOk(await run(tools, 'voice_v24_budgets', { action: 'breaches', sessionId: 's1' }));
  assert.equal(breaches.breaches.length, 1);
  const callsJson = JSON.stringify([JSON.parse(callJson)]);
  const burn = parseOk(await run(tools, 'voice_v24_budgets', { action: 'burndown', sessionId: 's1', callsJson, atMs: 1000 }));
  assert.equal(burn.burn.spentMs, 700);
  assert.equal(burn.burn.budgetMs, 120000);
  assert.equal(burn.burn.breached, false);
  const summary = parseOk(await run(tools, 'voice_v24_budgets', { action: 'summary', sessionId: 's1', callsJson, atMs: 1000 }));
  assert.match(summary.summary, /tool-time budget/);
  parseErr(await run(tools, 'voice_v24_budgets', { action: 'check', callJson: '{"id":"x"}', sessionTotalMs: 1, turnTotalMs: 1 }));
  // Refresh: both providers probed at 100ms; at 200ms nothing is due.
  const due = parseOk(await run(tools, 'voice_v24_providers', { action: 'refresh-due', atMs: 200 }));
  assert.equal(due.due.length, 0);
  assert.equal(due.freshness, 1);
  const round = parseOk(await run(tools, 'voice_v24_providers', {
    action: 'refresh-record',
    resultsJson: JSON.stringify([{ providerId: 'codex', ok: true }, { providerId: 'ollama', ok: false }]),
    atMs: 70000,
  }));
  assert.deepEqual(round.refreshed, ['codex']);
  assert.deepEqual(round.failed, ['ollama']);
  const state = parseOk(await run(tools, 'voice_v24_providers', { action: 'refresh-state', providerId: 'ollama', atMs: 70000 }));
  assert.equal(state.consecutiveFailures, 1);
  assert.equal(state.effectiveTtlMs, 90000);
});

// ---------------------------------------------------------------- i18n
test('voice v137-t5: voice.v24.* i18n keys exist in all 6 locales, non-empty', () => {
  const locales = {};
  for (const loc of LOCALES) {
    const raw = fs.readFileSync(path.join(LOCALES_DIR, `${loc}.json`), 'utf8');
    locales[loc] = JSON.parse(raw);
  }
  // Every panel key the core panel lists must exist in every locale.
  assert.ok(VOICE_V24_PANEL_I18N_KEYS.length >= 30, `panel keys: ${VOICE_V24_PANEL_I18N_KEYS.length}`);
  const required = [
    ...VOICE_V24_PANEL_I18N_KEYS,
    'voice.v24.panel.calls',
    'voice.v24.providers.title',
    'voice.v24.providers.online',
    'voice.v24.providers.offline',
    'voice.v24.providers.unconfigured',
    'voice.v24.providers.degraded',
    'voice.v24.providers.unknown',
    'voice.v24.providers.noProviders',
    'voice.v24.providers.usable',
    'voice.v24.providers.refresh',
    'voice.v24.providers.selectModel',
    'voice.v24.providers.unusableUnconfigured',
    'voice.v24.providers.unusableOffline',
    'voice.v24.providers.unusableUnknown',
    'voice.v24.providers.unusableNoModels',
    'voice.v24.model.switched',
    'voice.v24.model.switchFailed',
    'voice.v24.model.rolledBack',
    'voice.v24.model.rollbackFailed',
    'voice.v24.model.transcriptKept',
    'voice.v24.timers.errorBurstAlert',
    'voice.v24.timers.slowAlert',
    'voice.v24.timers.timeoutAlert',
    'voice.v24.health.score',
    'voice.v24.health.grade',
    'voice.v24.health.degraded',
  ];
  // v24 adds exactly 60 keys per locale (see the i18n patch).
  const v24KeysEn = Object.keys(locales.en).filter((k) => k.startsWith('voice.v24.'));
  assert.equal(v24KeysEn.length, 60);
  for (const key of required) {
    for (const loc of LOCALES) {
      assert.ok(key in locales[loc], `${key} missing in ${loc}`);
      assert.equal(typeof locales[loc][key], 'string');
      assert.ok(locales[loc][key].length > 0, `${key} empty in ${loc}`);
    }
    // All 6 locales carry the same v24 key set.
    const sets = LOCALES.map((loc) => Object.keys(locales[loc]).filter((k) => k.startsWith('voice.v24.')).sort().join(','));
    assert.equal(new Set(sets).size, 1, `v24 key sets differ across locales for ${key}`);
  }
});
