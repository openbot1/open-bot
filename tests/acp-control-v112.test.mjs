/**
 * Tests for v1.12 Team T4: ACP Control Center (core).
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/acp-control-v112.test.mjs
 *
 * Real ACP subprocess only through the repo's fake agent
 * (tests/fixtures/fake-acp-agent-v103.mjs — strict JSON-RPC 2.0,
 * no network, no real CLI, no credential). Discovery tests inject
 * mock probers / login snapshots, so no binary needs to be on PATH.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AcpControlAlertStore,
  AcpControlCenter,
  AcpControlError,
  AcpControlUsageStore,
  buildAcpControlReport,
  discoverControlCenterAgents,
  evaluateBudget,
  evaluateDimension,
  extractUsageNumbers,
  formatWallMs,
  summarizeTurns,
  validateBudget,
} from '../packages/core/dist/acp/control/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_AGENT = path.join(here, 'fixtures', 'fake-acp-agent-v103.mjs');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'acp-control-v112-'));
}

function centerWithFake(t, stateDir) {
  const center = new AcpControlCenter({ stateDir });
  // Always kill the fake agent, even when the test throws first —
  // otherwise the child keeps the test file's event loop alive.
  t.after(() => center.dispose());
  const record = center.register({
    backendId: 'custom',
    name: 'Fake ACP agent',
    command: process.execPath,
    args: [FAKE_AGENT, 'acp'],
    speaksAcp: true,
    loggedIn: true,
  });
  center.setEnabled(record.id, true);
  return { center, record };
}

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

test('budgets: unlimited dimension never warns or blocks', () => {
  const ev = evaluateBudget('a', {}, { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, calls: 0, unpricedCalls: 0, wallMs: 0, toolCalls: 0 });
  assert.equal(ev.blocked, false);
  assert.equal(ev.warned, false);
  assert.deepEqual(ev.reasons, []);
  assert.equal(ev.dimensions.every((d) => d.fractionUsed === null), true);
});

test('budgets: warn at 80%, blocked at 100% (tokens + calls)', () => {
  const summary = (totalTokens, calls) => ({
    inputTokens: totalTokens, outputTokens: 0, totalTokens, costUsd: 0, calls, unpricedCalls: 0, wallMs: 0, toolCalls: 0,
  });
  const warn = evaluateBudget('a', { maxTokensPerDay: 100, maxCallsPerDay: 10 }, summary(80, 5));
  assert.equal(warn.blocked, false);
  assert.equal(warn.warned, true);
  assert.equal(warn.reasons.length, 1);
  assert.match(warn.reasons[0], /tokens at 80%/);
  const blocked = evaluateBudget('a', { maxTokensPerDay: 100, maxCallsPerDay: 10 }, summary(100, 10));
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.reasons.length, 2);
  const over = evaluateBudget('a', { maxTokensPerDay: 100 }, summary(150, 1));
  assert.equal(over.blocked, true);
  assert.match(over.reasons[0], /tokens exceeded: 150 of 100/);
});

test('budgets: cost counts 0 for unpriced turns but they stay visible', () => {
  const ev = evaluateBudget('a', { maxCostUsdPerDay: 1 }, {
    inputTokens: 10, outputTokens: 5, totalTokens: 15, costUsd: null, calls: 1, unpricedCalls: 1, wallMs: 100, toolCalls: 0,
  });
  assert.equal(ev.blocked, false);
  const dim = ev.dimensions.find((d) => d.dimension === 'cost');
  assert.equal(dim.used, 0);
});

test('budgets: custom warn fraction + validation errors', () => {
  const dim = evaluateDimension('tokens', 50, 100, 0.5);
  assert.equal(dim.warned, true);
  assert.equal(dim.exceeded, false);
  assert.deepEqual(validateBudget({ maxTokensPerDay: 100, maxCostUsdPerDay: 0.5, warnAtFraction: 0.8 }), []);
  assert.ok(validateBudget({ maxTokensPerDay: -5 }).length > 0);
  assert.ok(validateBudget({ maxTokensPerDay: 0 }).length > 0);
  assert.ok(validateBudget({ maxCallsPerDay: 1.5 }).length > 0);
  assert.ok(validateBudget({ warnAtFraction: 1.5 }).length > 0);
  assert.ok(validateBudget({ warnAtFraction: 0 }).length > 0);
});

test('budgets: formatWallMs', () => {
  assert.equal(formatWallMs(500), '500ms');
  assert.equal(formatWallMs(45_000), '45s');
  assert.equal(formatWallMs(90_000), '1m 30s');
  assert.equal(formatWallMs(3_600_000), '1h 0m');
});

test('budgets: extractUsageNumbers tolerates key spellings', () => {
  assert.deepEqual(extractUsageNumbers({ inputTokens: 3, outputTokens: 4 }), { inputTokens: 3, outputTokens: 4, costUsd: null });
  assert.deepEqual(extractUsageNumbers({ input_tokens: 7, output_tokens: 8, cost_usd: 0.02 }), { inputTokens: 7, outputTokens: 8, costUsd: 0.02 });
  assert.deepEqual(extractUsageNumbers({ promptTokens: 5, completionTokens: 6 }), { inputTokens: 5, outputTokens: 6, costUsd: null });
  assert.deepEqual(extractUsageNumbers({ totalTokens: 9 }), { inputTokens: 9, outputTokens: 0, costUsd: null });
  assert.deepEqual(extractUsageNumbers({ tokens: { input: 2, output: 3 } }), { inputTokens: 2, outputTokens: 3, costUsd: null });
  assert.deepEqual(extractUsageNumbers(null), { inputTokens: 0, outputTokens: 0, costUsd: null });
  assert.deepEqual(extractUsageNumbers('garbage'), { inputTokens: 0, outputTokens: 0, costUsd: null });
});

// ---------------------------------------------------------------------------
// Usage store
// ---------------------------------------------------------------------------

test('usage store: record + today/total summaries, unpriced cost stays null', () => {
  const store = new AcpControlUsageStore({});
  const today = new Date().toISOString();
  store.recordTurn({ agentId: 'a', sessionId: 's1', inputTokens: 10, outputTokens: 5, costUsd: 0.01, durationMs: 120, stopReason: 'end_turn', at: today });
  store.recordTurn({ agentId: 'a', sessionId: 's1', inputTokens: 4, outputTokens: 2, durationMs: 80, stopReason: 'end_turn', toolCalls: 2, at: today });
  store.recordTurn({ agentId: 'b', sessionId: 's2', inputTokens: 100, outputTokens: 50, costUsd: 0.5, durationMs: 10, stopReason: 'end_turn', at: today });
  const a = store.today('a');
  assert.equal(a.totalTokens, 21);
  assert.equal(a.calls, 2);
  assert.equal(a.costUsd, null);
  assert.equal(a.unpricedCalls, 1);
  assert.equal(a.toolCalls, 2);
  assert.equal(a.wallMs, 200);
  assert.equal(store.summary('b').totalTokens, 150);
  assert.equal(store.summary('b').costUsd, 0.5);
  assert.equal(store.summaryAll().calls, 3);
  assert.equal(store.history('a').length, 2);
  assert.equal(store.history('a', 1).length, 1);
  assert.equal(store.size, 3);
});

test('usage store: persistence round-trips + corrupt file starts empty', () => {
  const dir = tmpDir();
  const store = new AcpControlUsageStore({ stateDir: dir });
  store.recordTurn({ agentId: 'a', sessionId: 's', inputTokens: 1, outputTokens: 1, costUsd: 0.001, durationMs: 5, stopReason: 'end_turn' });
  assert.ok(fs.existsSync(path.join(dir, 'acp-control-usage.json')));
  const again = new AcpControlUsageStore({ stateDir: dir });
  assert.equal(again.today('a').calls, 1);
  fs.writeFileSync(path.join(dir, 'acp-control-usage.json'), '{not json');
  const corrupt = new AcpControlUsageStore({ stateDir: dir });
  assert.equal(corrupt.size, 0);
});

test('usage store: prune + clearAgent', () => {
  const store = new AcpControlUsageStore({});
  const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
  store.recordTurn({ agentId: 'a', sessionId: 's', inputTokens: 1, outputTokens: 1, durationMs: 1, stopReason: 'end_turn', at: old });
  store.recordTurn({ agentId: 'a', sessionId: 's', inputTokens: 1, outputTokens: 1, durationMs: 1, stopReason: 'end_turn' });
  store.recordTurn({ agentId: 'b', sessionId: 's', inputTokens: 1, outputTokens: 1, durationMs: 1, stopReason: 'end_turn' });
  assert.equal(store.prune(30), 1);
  assert.equal(store.size, 2);
  assert.equal(store.clearAgent('b'), 1);
  assert.equal(store.size, 1);
});

test('usage store: summarizeTurns is pure', () => {
  assert.deepEqual(summarizeTurns([]), {
    inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, calls: 0, unpricedCalls: 0, wallMs: 0, toolCalls: 0,
  });
});

// ---------------------------------------------------------------------------
// Discovery (injected mocks — no real binary)
// ---------------------------------------------------------------------------

test('discovery: installed binary + mock probe + mock login, alreadyRegistered flagged', async () => {
  const binDir = tmpDir();
  const fake = path.join(binDir, 'gemini');
  fs.writeFileSync(fake, '#!/bin/sh\necho hi\n', { mode: 0o755 });
  const savedPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${savedPath ?? ''}`;
  try {
    const found = await discoverControlCenterAgents(
      { probeAcp: true, registeredBackendIds: ['gemini'] },
      {
        probe: async () => ({ id: 'gemini', name: 'Gemini CLI', command: 'gemini', resolvedPath: fake, speaksAcp: true, agentName: 'gemini-cli', agentVersion: '2.0.0' }),
        loginSnapshots: async () => new Map([['gemini', { kind: 'gemini', status: 'available', account: { label: 'user@example.com', method: 'oauth' } }]]),
      },
    );
    const gemini = found.find((f) => f.backendId === 'gemini');
    assert.ok(gemini);
    assert.equal(gemini.installed, true);
    assert.equal(gemini.speaksAcp, true);
    assert.equal(gemini.agentVersion, '2.0.0');
    assert.equal(gemini.loggedIn, true);
    assert.equal(gemini.loginLabel, 'user@example.com');
    assert.equal(gemini.alreadyRegistered, true);
    const claude = found.find((f) => f.backendId === 'claude');
    assert.ok(claude);
    assert.equal(claude.installed, false);
    assert.equal(claude.error, 'not installed (binary not found on PATH)');
  } finally {
    process.env.PATH = savedPath;
  }
});

test('discovery: probe failure is reported, never thrown', async () => {
  const binDir = tmpDir();
  fs.writeFileSync(path.join(binDir, 'codex'), '#!/bin/sh\n', { mode: 0o755 });
  const savedPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${savedPath ?? ''}`;
  try {
    const found = await discoverControlCenterAgents(
      { probeAcp: true },
      {
        probe: async () => { throw new Error('probe crashed'); },
        loginSnapshots: async () => new Map(),
      },
    );
    const codex = found.find((f) => f.backendId === 'codex');
    assert.ok(codex);
    assert.equal(codex.installed, true);
    assert.equal(codex.speaksAcp, false);
    assert.match(codex.error ?? '', /probe crashed/);
  } finally {
    process.env.PATH = savedPath;
  }
});

// ---------------------------------------------------------------------------
// Manager: registry + budgets + lifecycle (fake ACP agent)
// ---------------------------------------------------------------------------

test('manager: register / duplicate / disabled start / invalid budget', () => {
  const center = new AcpControlCenter({});
  const rec = center.register({ backendId: 'claude', name: 'Claude Code', command: 'claude', args: ['--acp'] });
  assert.equal(rec.id, 'cc-claude');
  assert.equal(rec.enabled, false);
  assert.equal(rec.status, 'registered');
  assert.throws(() => center.register({ backendId: 'claude', name: 'Claude Code', command: 'claude' }), /already registered/);
  assert.throws(
    () => center.register({ backendId: 'codex', name: 'Codex', command: 'codex', budget: { maxTokensPerDay: -1 } }),
    /invalid budget/,
  );
  assert.throws(() => center.register({ backendId: 'codex', name: 'Codex', command: '  ' }), /non-empty/);
  return assert.rejects(center.start(rec.id), /disabled/);
});

test('manager: setBudget validates + un-blocks after raising the cap', () => {
  const center = new AcpControlCenter({});
  const rec = center.register({ backendId: 'gemini', name: 'Gemini CLI', command: 'gemini', budget: { maxCallsPerDay: 1 } });
  center.usageStore.recordTurn({ agentId: rec.id, sessionId: 's', durationMs: 10, stopReason: 'end_turn' });
  assert.equal(center.evaluate(rec.id).blocked, true);
  assert.throws(() => center.setBudget(rec.id, { maxCallsPerDay: 0 }), /invalid budget/);
  const { evaluation } = center.setBudget(rec.id, { maxCallsPerDay: 10 });
  assert.equal(evaluation.blocked, false);
  assert.equal(center.get(rec.id).budget.maxCallsPerDay, 10);
});

test('manager: start + session + prompt records usage from usage_update (fake agent)', async (t) => {
  const { center, record } = centerWithFake(t, tmpDir());
  const events = [];
  center.on((e) => events.push(e));
  const started = await center.start(record.id);
  assert.equal(started.status, 'running');
  assert.equal(started.speaksAcp, true);
  assert.equal(started.agentName, 'fake-acp-v103');
  const session = await center.newSession(record.id, os.tmpdir());
  assert.equal(session.sessionId, 'session-fake-v103-1');
  const result = await center.prompt(record.id, session.sessionId, 'hello fake');
  assert.equal(result.stopReason, 'end_turn');
  assert.match(result.text, /Fake reply to: hello fake/);
  assert.equal(result.turn.inputTokens, 11);
  assert.equal(result.turn.outputTokens, 6);
  assert.equal(result.turn.status, 'completed');
  assert.equal(center.todayUsage(record.id).totalTokens, 17);
  assert.equal(center.todayUsage(record.id).calls, 1);
  assert.ok(events.some((e) => e.type === 'agent-started'));
  assert.ok(events.some((e) => e.type === 'turn-recorded'));
  assert.equal(center.stop(record.id), true);
  assert.equal(center.get(record.id).status, 'stopped');
  center.dispose();
});

test('manager: prompt blocked by budget records a blocked turn and throws', async (t) => {
  const { center, record } = centerWithFake(t, tmpDir());
  center.setBudget(record.id, { maxCallsPerDay: 1 });
  await center.start(record.id);
  const session = await center.newSession(record.id, os.tmpdir());
  // Fill the daily call budget with a turn recorded out-of-band, then
  // the next prompt must be refused (and recorded as blocked).
  center.usageStore.recordTurn({ agentId: record.id, sessionId: session.sessionId, durationMs: 5, stopReason: 'end_turn' });
  await assert.rejects(center.prompt(record.id, session.sessionId, 'nope'), (err) => {
    assert.ok(err instanceof AcpControlError);
    assert.equal(err.code, 'budget-blocked');
    return true;
  });
  assert.equal(center.get(record.id).status, 'blocked');
  const blockedTurns = center.history(record.id).filter((t) => t.status === 'blocked');
  assert.equal(blockedTurns.length, 1);
  center.dispose();
});

test('manager: start blocked by budget before spawning', async (t) => {
  const { center, record } = centerWithFake(t, tmpDir());
  center.setBudget(record.id, { maxTokensPerDay: 1 });
  center.usageStore.recordTurn({ agentId: record.id, sessionId: 's', inputTokens: 5, outputTokens: 0, durationMs: 5, stopReason: 'end_turn' });
  await assert.rejects(center.start(record.id), (err) => {
    assert.ok(err instanceof AcpControlError);
    assert.equal(err.code, 'budget-blocked');
    return true;
  });
  assert.equal(center.get(record.id).status, 'blocked');
  center.dispose();
});

test('manager: prompt on a stopped agent throws not-running; unknown agent throws not-found', async (t) => {
  const { center, record } = centerWithFake(t, tmpDir());
  await assert.rejects(center.prompt(record.id, 'nope', 'x'), /not running/);
  assert.equal(center.get('cc-nope'), undefined);
  assert.throws(() => center.evaluate('cc-nope'), /unknown managed agent/);
  assert.equal(center.deregister('cc-nope'), false);
  center.dispose();
});

test('manager: persistence round-trips registrations; running resets to stopped on load', () => {
  const dir = tmpDir();
  const first = new AcpControlCenter({ stateDir: dir });
  const rec = first.register({ backendId: 'claude', name: 'Claude Code', command: 'claude', budget: { maxTokensPerDay: 500 } });
  first.setEnabled(rec.id, true);
  assert.ok(fs.existsSync(path.join(dir, 'acp-control-agents.json')));
  const second = new AcpControlCenter({ stateDir: dir });
  const loaded = second.get(rec.id);
  assert.ok(loaded);
  assert.equal(loaded.budget.maxTokensPerDay, 500);
  assert.equal(loaded.enabled, true);
  // Simulate a crash: mark running in the file, reload must reset it.
  const file = JSON.parse(fs.readFileSync(path.join(dir, 'acp-control-agents.json'), 'utf8'));
  file.agents[0].status = 'running';
  fs.writeFileSync(path.join(dir, 'acp-control-agents.json'), JSON.stringify(file));
  const third = new AcpControlCenter({ stateDir: dir });
  assert.equal(third.get(rec.id).status, 'stopped');
  assert.match(third.get(rec.id).lastError ?? '', /did not survive restart/);
  first.dispose();
  second.dispose();
  third.dispose();
});

test('manager: views + totals aggregate across agents', () => {
  const center = new AcpControlCenter({});
  const a = center.register({ backendId: 'claude', name: 'Claude Code', command: 'claude' });
  const b = center.register({ backendId: 'codex', name: 'Codex', command: 'codex' });
  center.usageStore.recordTurn({ agentId: a.id, sessionId: 's', inputTokens: 10, outputTokens: 10, costUsd: 0.02, durationMs: 100, stopReason: 'end_turn' });
  center.usageStore.recordTurn({ agentId: b.id, sessionId: 's', inputTokens: 5, outputTokens: 5, costUsd: 0.01, durationMs: 50, stopReason: 'end_turn' });
  const views = center.views();
  assert.equal(views.length, 2);
  assert.equal(views.find((v) => v.record.id === a.id).today.totalTokens, 20);
  assert.equal(views.find((v) => v.record.id === b.id).budget.blocked, false);
  assert.equal(center.totals().today.totalTokens, 30);
  assert.equal(center.totals().total.calls, 2);
  center.dispose();
});

test('manager: deregister stops a running agent and clears usage on request', async (t) => {
  const { center, record } = centerWithFake(t, tmpDir());
  await center.start(record.id);
  center.usageStore.recordTurn({ agentId: record.id, sessionId: 's', durationMs: 5, stopReason: 'end_turn' });
  assert.equal(center.deregister(record.id, { clearUsage: true }), true);
  assert.equal(center.get(record.id), undefined);
  assert.equal(center.usageStore.size, 0);
  center.dispose();
});

test('alerts: record + 60s dedup + forAgent newest-first + persistence', () => {
  const dir = tmpDir();
  const store = new AcpControlAlertStore({ stateDir: dir });
  const day = new Date().toISOString().slice(0, 10);
  const a1 = store.record({ agentId: 'a', kind: 'warned', reasons: ['tokens at 80% of 100'], day });
  const a2 = store.record({ agentId: 'a', kind: 'warned', reasons: ['tokens at 80% of 100'], day });
  assert.equal(a1.id, a2.id, 'same alert within 60s must dedup');
  store.record({ agentId: 'a', kind: 'exceeded', reasons: ['tokens exceeded: 120 of 100'], day });
  store.record({ agentId: 'b', kind: 'blocked', reasons: ['calls exceeded: 2 of 1'], day });
  assert.equal(store.size, 3);
  assert.equal(store.forAgent('a').length, 2);
  assert.equal(store.forAgent('a')[0].kind, 'exceeded');
  assert.equal(store.all(2).length, 2);
  assert.equal(store.clearAgent('b'), 1);
  const again = new AcpControlAlertStore({ stateDir: dir });
  assert.equal(again.size, 2);
});

test('manager: usageReport covers empty days + flags blocked days from alerts', () => {
  const center = new AcpControlCenter({});
  const rec = center.register({ backendId: 'claude', name: 'Claude Code', command: 'claude' });
  const report = center.usageReport(rec.id, 3);
  assert.equal(report.days.length, 3);
  assert.equal(report.days[2].summary.calls, 0);
  assert.equal(report.days[2].blocked, false);
  center.usageStore.recordTurn({ agentId: rec.id, sessionId: 's', inputTokens: 5, outputTokens: 5, durationMs: 10, stopReason: 'end_turn' });
  center.alertStore.record({ agentId: rec.id, kind: 'exceeded', reasons: ['tokens exceeded: 10 of 5'], day: report.days[2].day });
  const after = center.usageReport(rec.id, 3);
  assert.equal(after.days[2].summary.totalTokens, 10);
  assert.equal(after.days[2].blocked, true);
  assert.equal(after.total.calls, 1);
  center.dispose();
});

test('manager: listSessions / closeSession / cancelTurn go through the fake agent', async (t) => {
  const { center, record } = centerWithFake(t, tmpDir());
  await center.start(record.id);
  const session = await center.newSession(record.id, os.tmpdir());
  const sessions = await center.listSessions(record.id);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].sessionId, 'session-fake-v103-1');
  assert.equal(await center.cancelTurn(record.id, session.sessionId), true);
  assert.equal(await center.closeSession(record.id, session.sessionId), true);
  center.dispose();
});

test('manager: stopOnExceed stops the agent the moment a turn pushes it over budget', async (t) => {
  const { center, record } = centerWithFake(t, tmpDir());
  center.setBudget(record.id, { maxCallsPerDay: 1, stopOnExceed: true });
  await center.start(record.id);
  const session = await center.newSession(record.id, os.tmpdir());
  const result = await center.prompt(record.id, session.sessionId, 'one');
  assert.equal(result.stopReason, 'end_turn');
  assert.equal(center.get(record.id).status, 'blocked');
  assert.equal(center.isRunning(record.id), false);
  assert.equal(center.alertsFor(record.id).length, 1);
  assert.equal(center.alertsFor(record.id)[0].kind, 'exceeded');
  center.dispose();
});

test('manager: warn alert is recorded but the agent keeps running', async (t) => {
  const { center, record } = centerWithFake(t, tmpDir());
  center.setBudget(record.id, { maxCallsPerDay: 10, warnAtFraction: 0.1 });
  await center.start(record.id);
  const session = await center.newSession(record.id, os.tmpdir());
  await center.prompt(record.id, session.sessionId, 'one');
  assert.equal(center.get(record.id).status, 'running');
  assert.equal(center.alertsFor(record.id).length, 1);
  assert.equal(center.alertsFor(record.id)[0].kind, 'warned');
  center.dispose();
});

test('discovery: argv variants are tried in order until one answers ACP', async () => {
  const binDir = tmpDir();
  fs.writeFileSync(path.join(binDir, 'gemini'), '#!/bin/sh\n', { mode: 0o755 });
  const savedPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${savedPath ?? ''}`;
  try {
    const calls = [];
    const found = await discoverControlCenterAgents(
      { probeAcp: true },
      {
        probe: async (command, args) => {
          // Only gemini's argv sequence is asserted; other backends
          // installed on this machine are probed too (mock: no answer).
          if (command === 'gemini') calls.push(args);
          if (command !== 'gemini') {
            return { id: command, name: command, command, resolvedPath: '', speaksAcp: false, error: 'not the backend under test' };
          }
          if (args[0] === '--acp') return { id: 'gemini', name: 'Gemini CLI', command, resolvedPath: path.join(binDir, 'gemini'), speaksAcp: false, error: 'nope' };
          return { id: 'gemini', name: 'Gemini CLI', command, resolvedPath: path.join(binDir, 'gemini'), speaksAcp: true, agentName: 'gemini-cli', agentVersion: '2.0.0' };
        },
        loginSnapshots: async () => new Map(),
      },
    );
    const gemini = found.find((f) => f.backendId === 'gemini');
    assert.ok(gemini);
    assert.equal(gemini.speaksAcp, true);
    assert.deepEqual(gemini.args, ['--experimental-acp']);
    assert.deepEqual(calls, [['--acp'], ['--experimental-acp']]);
  } finally {
    process.env.PATH = savedPath;
  }
});

test('manager: buildAcpControlReport snapshot is plain JSON', () => {
  const center = new AcpControlCenter({});
  const rec = center.register({ backendId: 'codex', name: 'Codex', command: 'codex' });
  center.usageStore.recordTurn({ agentId: rec.id, sessionId: 's', inputTokens: 3, outputTokens: 2, durationMs: 5, stopReason: 'end_turn' });
  const report = buildAcpControlReport(center, rec.id, 2);
  assert.equal(report.agentId, rec.id);
  assert.equal(report.days.length, 2);
  assert.equal(report.total.calls, 1);
  assert.deepEqual(report.alerts, []);
  assert.deepEqual(JSON.parse(JSON.stringify(report)).agentId, rec.id);
  center.dispose();
});

test('budgets: stopOnExceed must be a boolean', () => {
  assert.deepEqual(validateBudget({ stopOnExceed: true }), []);
  assert.ok(validateBudget({ stopOnExceed: 'yes' }).length > 0);
});
