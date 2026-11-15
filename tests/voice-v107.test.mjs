/**
 * Tests for v1.07 — voice realtime v6 + UI (Team T5).
 *
 *   1. Voice call state machine (voiceStateMachine.ts): legal /
 *      illegal transitions, same-state no-op, force (counted
 *      separately), reset via ended, bounded history, stats,
 *      live/user-turn/speaking helpers.
 *   2. Mid-call voice switching (voiceSwitch.ts): default voice,
 *      switch + history, unknown / already-active failures,
 *      revert (+ revert with no history), invalid custom profile
 *      rejected, TTS options, summary + markdown.
 *   3. Network guard (voiceNetworkGuard.ts): error classification
 *      (timeout / reset / dns / rate-limited / auth / server /
 *      unknown), retry → degrade → give-up, auth gives up at once,
 *      server retry-after wins over backoff, backoff cap,
 *      success recovers degraded mode, probe ok/fail.
 *   4. Voice session v6 (voiceSessionV6.ts) on the mock transport:
 *      connect → listening, switch voice mid-call, revert,
 *      disconnect → idle, reconnect no-op while live / fails
 *      without config, manager create/list/remove + bad ids,
 *      failing transport goes through the guard (auth → give-up
 *      at once, reset → degrade).
 *   5. Conversation budget meter view contract
 *      (conversation/budgetMeterView.ts): levels at 70/80/90/100,
 *      segments with cap / over cap / no cap, view (remaining +
 *      per-model breakdown, largest first), summary, markdown,
 *      voice token estimate.
 *   6. Voice v6 tools (packages/tools/src/voiceV6Tools.ts): 7
 *      tools, unique names, placeholder refuses, full lifecycle
 *      through the tools on a real manager (mock sessions),
 *      registry: all 7 in defaultToolFactory, total 396.
 *   7. Paper theme + UI wiring: theme.ts paper mode
 *      (resolve/apply/read/save), paper CSS block, Settings paper
 *      option, BudgetMeter renders the core contract (segments +
 *      remaining + breakdown), RealtimeVoicePanel wires v6 status
 *      + VoiceStateBadge.
 *   8. i18n: the 21 new keys live in tests/i18n-v107.test.mjs.
 *
 * No network, no sound card, no live provider. Run after building
 * the core + tools packages:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/voice-v107.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  VoiceStateMachine,
  VOICE_CALL_STATES,
  VOICE_CALL_TRANSITIONS,
  isVoiceCallLive,
  isVoiceCallUserTurn,
  isVoiceCallModelSpeaking,
  voiceStateSummary,
} from '../packages/core/dist/voice/voiceStateMachine.js';
import {
  VoiceSwitchManager,
  voiceSwitchSummary,
  voiceSwitchHistoryMarkdown,
} from '../packages/core/dist/voice/voiceSwitch.js';
import {
  VoiceNetworkGuard,
  classifyVoiceNetworkError,
  voiceNetworkSummary,
} from '../packages/core/dist/voice/voiceNetworkGuard.js';
import {
  VoiceSessionV6,
  VoiceV6Manager,
  createMockVoiceSessionV6,
} from '../packages/core/dist/voice/voiceSessionV6.js';
import {
  budgetMeterLevel,
  buildBudgetMeterSegments,
  toBudgetMeterView,
  formatBudgetTokens,
  formatBudgetCost,
  budgetMeterSummary,
  budgetMeterMarkdown,
  estimateVoiceTokens,
  BUDGET_METER_WATCH_PERCENT,
  BUDGET_METER_WARNING_PERCENT,
  BUDGET_METER_CRITICAL_PERCENT,
  VOICE_BUDGET_MODEL_KEY,
} from '../packages/core/dist/conversation/budgetMeterView.js';
import {
  createVoiceV6Tools,
  VOICE_V6_TOOLS,
  VOICE_V6_TOOL_NAMES,
  isVoiceV6ToolName,
} from '../packages/tools/dist/voiceV6Tools.js';
import { BotMemory, defaultToolFactory } from '../packages/core/dist/index.js';
import {
  isThemeMode,
  readThemeMode,
  saveThemeMode,
  resolveTheme,
  applyThemeMode,
  THEME_MODES,
} from '../apps/desktop/src/renderer/components/theme.ts';
import { ConversationBudgetMeter } from '../packages/core/dist/risk/budget.js';
import {
  VoiceBudgetLink,
  voiceBudgetSummary,
} from '../packages/core/dist/voice/voiceBudgetLink.js';
import {
  FileVoiceSessionV6Store,
  snapshotVoiceSessionV6,
  validateVoiceSessionV6Snapshot,
  restoreVoiceSessionV6,
  voiceSessionV6SnapshotSummary,
  voiceSessionV6SnapshotMarkdown,
} from '../packages/core/dist/voice/voiceSessionV6Store.js';
import { BudgetMeterHistory } from '../packages/core/dist/conversation/budgetMeterHistory.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function tmpDir(prefix = 'open-bot-voice-v107-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Fake clock: tests advance it by hand. */
function fakeClock(start = 1_000_000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms) => {
      now += ms;
    },
  };
}

const CTX = { botId: 'bot-a', runId: 'run-1', workspaceDir: '' };

function makeV6Tools() {
  const manager = new VoiceV6Manager();
  const tools = createVoiceV6Tools({ getManager: () => manager });
  const byName = new Map(tools.map((t) => [t.definition.name, t]));
  return { manager, tools, byName };
}

async function runTool(byName, name, args, ctx = CTX) {
  const tool = byName.get(name);
  assert.ok(tool, `tool ${name} should exist`);
  const raw = await tool.execute(args, { ...ctx, workspaceDir: ctx.workspaceDir || '' });
  assert.equal(typeof raw, 'string');
  assert.ok(!raw.startsWith('Error:'), `tool ${name} failed: ${raw}`);
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

async function runToolRaw(byName, name, args, ctx = CTX) {
  const tool = byName.get(name);
  assert.ok(tool, `tool ${name} should exist`);
  return tool.execute(args, { ...ctx, workspaceDir: ctx.workspaceDir || '' });
}

/** A harness-meter snapshot shape, built by hand (no meter needed). */
function snapshot(overrides = {}) {
  return {
    conversationId: 'conv-1',
    model: 'gpt-test',
    inputTokens: 600,
    outputTokens: 400,
    totalTokens: 1000,
    costUsd: 0.01,
    hasUnknownCost: false,
    tokenLimit: 10000,
    costLimitUsd: null,
    tokenPercentUsed: 10,
    costPercentUsed: null,
    percentUsed: 10,
    status: 'ok',
    modelCount: 1,
    byModel: { 'gpt-test': { inputTokens: 600, outputTokens: 400, costUsd: 0.01 } },
    lastRecordedAtMs: 123,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Voice call state machine
// ---------------------------------------------------------------------------

test('v107 state machine: legal path, illegal rejected, same-state no-op', () => {
  const clock = fakeClock();
  const machine = new VoiceStateMachine({ clock: clock.now });
  assert.equal(machine.getState(), 'idle');
  assert.equal(machine.can('connecting'), true);
  assert.equal(machine.can('speaking'), false);

  const ok = machine.transition('connecting', 'connect');
  assert.equal(ok.ok, true);
  assert.equal(machine.getState(), 'connecting');

  // Same-state transition succeeds without recording.
  const noop = machine.transition('connecting', 'connect again');
  assert.equal(noop.ok, true);
  assert.equal(machine.getStats().transitions, 1);

  // Illegal: connecting -> interrupted is not in the table.
  const bad = machine.transition('interrupted', 'oops');
  assert.equal(bad.ok, false);
  assert.equal(machine.getState(), 'connecting');
  assert.equal(machine.getStats().rejected, 1);

  assert.equal(machine.transition('listening', 'connected').ok, true);
  assert.equal(machine.transition('speaking', 'audio').ok, true);
  assert.equal(machine.transition('interrupted', 'barge-in').ok, true);
  assert.equal(machine.transition('listening', 'turn done').ok, true);
  assert.equal(machine.transition('reconnecting', 'drop').ok, true);
  assert.equal(machine.transition('listening', 'recovered').ok, true);
  assert.equal(machine.transition('degraded', 'network down').ok, true);
  assert.equal(machine.transition('listening', 'recovered').ok, true);
  assert.equal(machine.transition('ended', 'hang up').ok, true);
  const reset = machine.reset('new call');
  assert.equal(reset.ok, true);
  assert.equal(machine.getState(), 'idle');
  assert.equal(machine.getHistory().at(-1).to, 'idle');
});

test('v107 state machine: force is counted separately; history is bounded; msInState', () => {
  const clock = fakeClock();
  const machine = new VoiceStateMachine({ clock: clock.now, maxHistoryEntries: 3 });
  machine.transition('connecting', 'connect');
  clock.advance(250);
  assert.equal(machine.msInState(), 250);
  // ended -> speaking is illegal; force does it and counts it.
  machine.transition('ended', 'hang up');
  const forced = machine.force('speaking', 'recovery knows better');
  assert.equal(forced.forced, true);
  assert.equal(machine.getState(), 'speaking');
  assert.equal(machine.getStats().forced, 1);
  assert.equal(machine.getStats().rejected, 0);
  // History capped at 3 despite 4 transitions (connecting, ended, speaking + reset path).
  machine.transition('listening', 'turn');
  machine.transition('speaking', 'audio');
  assert.equal(machine.getHistory().length, 3);
  assert.equal(machine.getHistory().at(-1).to, 'speaking');
  const summary = voiceStateSummary(machine);
  assert.match(summary, /state=speaking/);
  assert.match(summary, /forced=1/);
});

test('v107 state machine: helpers + transition table covers all 8 states', () => {
  assert.deepEqual([...VOICE_CALL_STATES].sort(), [
    'connecting',
    'degraded',
    'ended',
    'idle',
    'interrupted',
    'listening',
    'reconnecting',
    'speaking',
  ]);
  for (const state of VOICE_CALL_STATES) {
    assert.ok(Array.isArray(VOICE_CALL_TRANSITIONS[state]), state);
  }
  assert.equal(isVoiceCallLive('idle'), false);
  assert.equal(isVoiceCallLive('ended'), false);
  assert.equal(isVoiceCallLive('listening'), true);
  assert.equal(isVoiceCallLive('degraded'), true);
  assert.equal(isVoiceCallUserTurn('listening'), true);
  assert.equal(isVoiceCallUserTurn('interrupted'), true);
  assert.equal(isVoiceCallUserTurn('speaking'), false);
  assert.equal(isVoiceCallModelSpeaking('speaking'), true);
  assert.equal(isVoiceCallModelSpeaking('listening'), false);
});

// ---------------------------------------------------------------------------
// 2. Voice switching
// ---------------------------------------------------------------------------

test('v107 voice switch: default, switch, already-active, unknown, revert', () => {
  const clock = fakeClock();
  const manager = new VoiceSwitchManager({ clock: clock.now });
  assert.equal(manager.getCurrentId(), 'vi-nam');
  assert.equal(manager.listVoiceIds().length, 6);

  const switched = manager.switchTo('en-us', { midCall: true, reason: 'user pick' });
  assert.equal(switched.ok, true);
  assert.equal(switched.current.id, 'en-us');
  assert.equal(switched.previous.id, 'vi-nam');
  assert.equal(switched.record.midCall, true);
  assert.equal(switched.record.applied, 'immediate');
  assert.equal(manager.getCurrentId(), 'en-us');

  const same = manager.switchTo('en-us');
  assert.equal(same.ok, false);
  assert.match(same.reason, /already active/);

  const unknown = manager.switchTo('no-such-voice');
  assert.equal(unknown.ok, false);
  assert.match(unknown.reason, /Unknown voice/);

  const empty = manager.switchTo('  ');
  assert.equal(empty.ok, false);

  const reverted = manager.revert({ midCall: true });
  assert.equal(reverted.ok, true);
  assert.equal(reverted.current.id, 'vi-nam');
  assert.equal(reverted.record.reason, 'revert');
  assert.equal(manager.getStats().reverts, 1);
  assert.equal(manager.getStats().midCallSwitches, 2);
  assert.equal(manager.getHistory().length, 2);

  const summary = voiceSwitchSummary(manager);
  assert.match(summary, /Tiếng Việt — miền Nam/);
  assert.match(summary, /2 switch/);
  const md = voiceSwitchHistoryMarkdown(manager);
  assert.match(md, /# Voice switches \(2\)/);
  assert.match(md, /en-us/);
});

test('v107 voice switch: revert with no history fails; bad custom profile rejected; TTS options', () => {
  const fresh = new VoiceSwitchManager({ profiles: [] });
  assert.equal(fresh.getCurrent(), null);
  assert.equal(fresh.revert().ok, false);
  assert.equal(fresh.switchTo('vi-nam').ok, false);

  const badProfile = {
    id: 'bad-rate',
    userId: 'local-user',
    name: 'Bad rate',
    lang: 'vi',
    voice: null,
    rate: 99,
    pitch: 0,
    volume: 1,
    createdAt: 0,
    updatedAt: 0,
  };
  const manager = new VoiceSwitchManager({ profiles: [badProfile] });
  assert.equal(manager.listVoiceIds().length, 0);
  assert.equal(manager.getCurrent(), null);

  const good = new VoiceSwitchManager({ initialId: 'slow-clear' });
  assert.equal(good.getCurrentId(), 'slow-clear');
  assert.deepEqual(good.currentTtsOptions(), { voice: null, rate: 0.8, pitch: 0, volume: 1 });
  assert.equal(good.getStats().failures, 0);
  good.switchTo('nope');
  assert.equal(good.getStats().failures, 1);
  const emptyMd = voiceSwitchHistoryMarkdown(new VoiceSwitchManager());
  assert.match(emptyMd, /No switches yet/);
});

// ---------------------------------------------------------------------------
// 3. Network guard
// ---------------------------------------------------------------------------

test('v107 network guard: classification of every kind', () => {
  assert.equal(classifyVoiceNetworkError(new Error('request timed out')).kind, 'timeout');
  assert.equal(classifyVoiceNetworkError(new Error('socket hang up')).kind, 'reset');
  assert.equal(classifyVoiceNetworkError(Object.assign(new Error('x'), { code: 'ECONNRESET' })).kind, 'reset');
  assert.equal(classifyVoiceNetworkError(Object.assign(new Error('x'), { code: 'ENOTFOUND' })).kind, 'dns');
  assert.equal(classifyVoiceNetworkError(Object.assign(new Error('Too many requests'), { status: 429 })).kind, 'rate-limited');
  assert.equal(classifyVoiceNetworkError(Object.assign(new Error('bad key'), { status: 401 })).kind, 'auth');
  assert.equal(classifyVoiceNetworkError(new Error('invalid api key')).kind, 'auth');
  assert.equal(classifyVoiceNetworkError(Object.assign(new Error('bad gateway'), { status: 502 })).kind, 'server');
  assert.equal(classifyVoiceNetworkError(new Error('something weird')).kind, 'unknown');
  assert.equal(classifyVoiceNetworkError('plain string failure').kind, 'unknown');
  assert.equal(classifyVoiceNetworkError(Object.assign(new Error('slow'), { retryAfterMs: 2500 })).retryAfterMs, 2500);
  assert.equal(classifyVoiceNetworkError(new Error('auth')).retryable, false);
  assert.equal(classifyVoiceNetworkError(new Error('timeout')).retryable, true);
  // 'author' contains 'auth' but is not an auth failure (word-boundary check).
  assert.equal(classifyVoiceNetworkError(new Error('author unknown')).kind, 'unknown');
});

test('v107 network guard: retry → degrade → give-up; auth gives up at once', () => {
  const clock = fakeClock();
  const guard = new VoiceNetworkGuard({
    maxAttempts: 4,
    degradeAfterAttempts: 2,
    baseDelayMs: 100,
    maxDelayMs: 1000,
    jitter: () => 0,
    clock: clock.now,
  });
  const first = guard.noteFailure(new Error('socket hang up'));
  assert.equal(first.action, 'retry');
  assert.equal(first.delayMs, 100);
  assert.equal(first.attempt, 1);
  const second = guard.noteFailure(new Error('socket hang up'));
  assert.equal(second.action, 'degrade');
  assert.equal(guard.isDegraded(), true);
  assert.equal(guard.getStats().consecutiveFailures, 2);
  const third = guard.noteFailure(new Error('socket hang up'));
  assert.equal(third.action, 'retry');
  assert.equal(third.delayMs, 400);
  const fourth = guard.noteFailure(new Error('socket hang up'));
  assert.equal(fourth.action, 'give-up');
  assert.equal(guard.hasGivenUp(), true);
  assert.equal(guard.getDecisions().length, 4);
  assert.match(voiceNetworkSummary(guard), /gaveUp=yes/);

  // Success recovers degraded mode.
  const recovered = guard.noteSuccess();
  assert.equal(recovered, true);
  assert.equal(guard.isDegraded(), false);
  assert.equal(guard.hasGivenUp(), false);
  assert.equal(guard.getConsecutiveFailures(), 0);
  assert.equal(guard.getStats().totalRecoveries, 1);

  // Auth never retries.
  const authGuard = new VoiceNetworkGuard({ clock: clock.now, jitter: () => 0 });
  const auth = authGuard.noteFailure(Object.assign(new Error('bad key'), { status: 401 }));
  assert.equal(auth.action, 'give-up');
  assert.equal(auth.attempt, 1);
});

test('v107 network guard: server retry-after wins; backoff capped; probe', async () => {
  const clock = fakeClock();
  const guard = new VoiceNetworkGuard({
    maxAttempts: 5,
    degradeAfterAttempts: 5,
    baseDelayMs: 500,
    maxDelayMs: 800,
    jitter: () => 0,
    clock: clock.now,
  });
  const rate = guard.noteFailure(Object.assign(new Error('slow down'), { retryAfterMs: 3000 }));
  assert.equal(rate.action, 'retry');
  assert.equal(rate.delayMs, 3000);
  const second = guard.noteFailure(new Error('timeout'));
  assert.equal(second.delayMs, 800, 'exponential 1000 capped at 800');
  assert.equal(guard.backoffDelayMs(10), 800);

  const probeOk = await guard.probe(() => true);
  assert.equal(probeOk.ok, true);
  assert.equal(guard.getConsecutiveFailures(), 0);

  const probeFail = await guard.probe(() => false);
  assert.equal(probeFail.ok, false);
  assert.equal(probeFail.decision.action, 'retry');
  const probeThrow = await guard.probe(() => {
    throw new Error('boom');
  });
  assert.equal(probeThrow.ok, false);
  assert.equal(guard.getStats().totalFailures, 4);

  const direct = new VoiceNetworkGuard({ clock: clock.now });
  direct.enterDegraded('caller saw the outage');
  assert.equal(direct.isDegraded(), true);
  assert.equal(direct.enterDegraded('again').reason, 'Already degraded.');
  assert.equal(direct.exitDegraded(), true);
  assert.equal(direct.exitDegraded(), false);
});

// ---------------------------------------------------------------------------
// 4. Voice session v6 (mock transport)
// ---------------------------------------------------------------------------

test('v107 session v6: connect → listening, switch mid-call, revert, disconnect → idle', async () => {
  const clock = fakeClock();
  const events = [];
  const session = createMockVoiceSessionV6({
    initialVoiceId: 'vi-nam',
    clock: clock.now,
    onEvent: (e) => events.push(e),
  });
  assert.equal(session.getCallState(), 'idle');
  assert.equal(session.getCurrentVoiceId(), 'vi-nam');

  await session.connect({ instructions: 'You are helpful.' });
  assert.equal(session.isConnected(), true);
  assert.equal(session.getCallState(), 'listening');

  const switched = session.switchVoice('en-gb');
  assert.equal(switched.ok, true);
  assert.equal(session.getCurrentVoiceId(), 'en-gb');
  assert.equal(session.getVoiceSwitchHistory().length, 1);
  assert.equal(session.getVoiceSwitchHistory()[0].midCall, true);

  const reverted = session.revertVoice();
  assert.equal(reverted.ok, true);
  assert.equal(session.getCurrentVoiceId(), 'vi-nam');

  const stats = session.getV6Stats();
  assert.equal(stats.callState, 'listening');
  assert.equal(stats.voice.switches, 2);
  assert.equal(stats.voice.reverts, 1);
  assert.equal(stats.network.totalFailures, 0);
  assert.equal(stats.network.degraded, false);
  assert.match(session.summary(), /v6 call=listening/);
  assert.ok(events.some((e) => e.kind === 'voice-state'), 'state events flow through the sink');
  assert.ok(events.some((e) => e.kind === 'voice-switched'), 'switch events flow through the sink');

  session.disconnect();
  assert.equal(session.isConnected(), false);
  assert.equal(session.getCallState(), 'idle');
  session.dispose();
});

test('v107 session v6: reconnect no-op while live, fails without config', async () => {
  const session = createMockVoiceSessionV6();
  const noConfig = await session.reconnect();
  assert.equal(noConfig.ok, false);
  assert.match(noConfig.error, /No previous config/);

  await session.connect({ instructions: 'Hi.' });
  const live = await session.reconnect();
  assert.deepEqual(live, { ok: true, attempts: 0 });
  session.disconnect();
  session.dispose();
});

test('v107 session v6: failing transport goes through the guard', async () => {
  const clock = fakeClock();
  // Auth failure: the guard gives up at once — one attempt, no retries.
  const authSession = new VoiceSessionV6({
    v4: {
      v3: {
        v2: {
          session: {
            provider: 'openai',
            transportFactory: () => {
              throw Object.assign(new Error('invalid api key'), { status: 401 });
            },
          },
          longSession: { maxContextChars: 1000 },
        },
      },
    },
    network: { maxAttempts: 5, baseDelayMs: 0, jitter: () => 0 },
    clock: clock.now,
    retrySleepMs: async () => {},
  });
  await assert.rejects(() => authSession.connect({ instructions: 'Hi.' }), /invalid api key/);
  assert.equal(authSession.getNetworkStats().totalFailures, 1);
  assert.equal(authSession.getNetworkStats().gaveUp, true);
  assert.equal(authSession.getCallState(), 'ended');

  // Reset failure: retry once, then degrade (degradeAfterAttempts 2).
  const resetSession = new VoiceSessionV6({
    v4: {
      v3: {
        v2: {
          session: {
            provider: 'openai',
            transportFactory: () => {
              throw new Error('socket hang up');
            },
          },
          longSession: { maxContextChars: 1000 },
        },
      },
    },
    network: { maxAttempts: 5, degradeAfterAttempts: 2, baseDelayMs: 0, jitter: () => 0 },
    clock: clock.now,
    retrySleepMs: async () => {},
  });
  await assert.rejects(() => resetSession.connect({ instructions: 'Hi.' }), /socket hang up/);
  assert.equal(resetSession.getNetworkStats().totalFailures, 2);
  assert.equal(resetSession.getNetworkStats().degraded, true);
  assert.equal(resetSession.getCallState(), 'degraded');
});

test('v107 session v6 manager: create/list/remove, bad ids, duplicate refused', () => {
  const manager = new VoiceV6Manager();
  const session = manager.createSession('call-1', { initialVoiceId: 'en-us' });
  assert.equal(session.getCurrentVoiceId(), 'en-us');
  assert.equal(manager.hasSession('call-1'), true);
  assert.deepEqual(manager.listSessions(), [
    { id: 'call-1', callState: 'idle', voiceId: 'en-us', connected: false },
  ]);
  assert.deepEqual(manager.listVoices().map((v) => v.id), [
    'vi-nam',
    'vi-bac',
    'en-us',
    'en-gb',
    'slow-clear',
    'fast',
  ]);
  assert.equal(manager.getStats().sessions, 1);
  assert.throws(() => manager.createSession('call-1'), /already exists/);
  assert.throws(() => manager.createSession('bad id!'), /Invalid voice v6 session id/);
  assert.equal(manager.removeSession('call-1'), true);
  assert.equal(manager.removeSession('call-1'), false);
  assert.equal(manager.getSession('call-1'), undefined);
});

// ---------------------------------------------------------------------------
// 5. Budget meter view contract
// ---------------------------------------------------------------------------

test('v107 budget view: levels at 70/80/90/100 (percent scale, like the harness)', () => {
  assert.equal(BUDGET_METER_WATCH_PERCENT, 70);
  assert.equal(BUDGET_METER_WARNING_PERCENT, 80);
  assert.equal(BUDGET_METER_CRITICAL_PERCENT, 90);
  assert.equal(budgetMeterLevel(null), 'ok');
  assert.equal(budgetMeterLevel(0), 'ok');
  assert.equal(budgetMeterLevel(69.9), 'ok');
  assert.equal(budgetMeterLevel(70), 'watch');
  assert.equal(budgetMeterLevel(79.9), 'watch');
  assert.equal(budgetMeterLevel(80), 'warning');
  assert.equal(budgetMeterLevel(89.9), 'warning');
  assert.equal(budgetMeterLevel(90), 'critical');
  assert.equal(budgetMeterLevel(99.9), 'critical');
  assert.equal(budgetMeterLevel(100), 'exceeded');
  assert.equal(budgetMeterLevel(140), 'exceeded');
});

test('v107 budget view: segments with cap, over cap, and no cap', () => {
  const capped = buildBudgetMeterSegments(snapshot());
  assert.deepEqual(
    capped.map((s) => s.key),
    ['input', 'output', 'free'],
  );
  assert.equal(capped[0].ratio, 0.06);
  assert.equal(capped[1].ratio, 0.04);
  assert.equal(capped[2].ratio, 0.9);
  assert.equal(capped[2].tokens, 9000);

  const over = buildBudgetMeterSegments(
    snapshot({ inputTokens: 8000, outputTokens: 4000, totalTokens: 12000 }),
  );
  assert.deepEqual(
    over.map((s) => s.key),
    ['input', 'output', 'over'],
  );
  assert.equal(over[2].tokens, 2000);

  const noCap = buildBudgetMeterSegments(
    snapshot({ tokenLimit: null, tokenPercentUsed: null, percentUsed: null }),
  );
  assert.deepEqual(
    noCap.map((s) => s.key),
    ['input', 'output'],
  );
  assert.equal(noCap[0].ratio, 0.6);
  assert.equal(noCap[1].ratio, 0.4);
});

test('v107 budget view: toBudgetMeterView — remaining, breakdown, level; summary + markdown', () => {
  const view = toBudgetMeterView(
    snapshot({
      inputTokens: 7000,
      outputTokens: 1000,
      totalTokens: 8000,
      costUsd: 0.008,
      tokenPercentUsed: 80,
      percentUsed: 80,
      status: 'warning',
      byModel: {
        'gpt-test': { inputTokens: 7000, outputTokens: 1000, costUsd: 0.008 },
        other: { inputTokens: 0, outputTokens: 0, costUsd: null },
      },
    }),
  );
  assert.equal(view.level, 'warning');
  assert.equal(view.status, 'warning');
  assert.equal(view.remainingTokens, 2000);
  assert.equal(view.remainingCostUsd, null);
  assert.equal(view.byModel[0].model, 'gpt-test');
  assert.equal(view.byModel[0].share, 1);
  assert.equal(view.segments.length, 3);
  assert.equal(budgetMeterSummary(view), '8,000/10,000 tokens (80.0%), $0.0080 — warning');
  const md = budgetMeterMarkdown(view);
  assert.match(md, /# Conversation budget — conv-1/);
  assert.match(md, /Remaining: 2,000 tokens/);
  assert.match(md, /Level: warning/);
  assert.match(md, /\| gpt-test \| 7,000 \| 1,000 \| 100\.0% \| \$0\.0080 \|/);

  const empty = toBudgetMeterView(snapshot({ totalTokens: 0, inputTokens: 0, outputTokens: 0, byModel: {} }));
  assert.match(budgetMeterMarkdown(empty), /No usage recorded yet/);
  assert.equal(formatBudgetTokens(1234567), '1,234,567');
  assert.equal(formatBudgetCost(null), '?');
  assert.equal(formatBudgetCost(0), '$0.0000');
});

test('v107 budget view: voice token estimate is labelled, never mixed into text models', () => {
  assert.equal(VOICE_BUDGET_MODEL_KEY, 'voice');
  assert.equal(estimateVoiceTokens(0), 0);
  assert.equal(estimateVoiceTokens(-5), 0);
  assert.equal(estimateVoiceTokens(1), 800);
  assert.equal(estimateVoiceTokens(2.5), 2000);
});

// ---------------------------------------------------------------------------
// 6. Voice v6 tools
// ---------------------------------------------------------------------------

test('v107 tools: 7 tools, unique names, placeholder shape, approval flags', async () => {
  assert.equal(VOICE_V6_TOOLS.length, 7);
  assert.deepEqual([...VOICE_V6_TOOL_NAMES], [
    'voice_v6_state',
    'voice_v6_list_voices',
    'voice_v6_switch_voice',
    'voice_v6_revert_voice',
    'voice_v6_network_status',
    'voice_v6_reconnect',
    'voice_v6_session_stats',
  ]);
  assert.equal(new Set(VOICE_V6_TOOL_NAMES).size, 7);
  assert.equal(isVoiceV6ToolName('voice_v6_state'), true);
  assert.equal(isVoiceV6ToolName('voice_v5_state'), false);
  const { tools } = makeV6Tools();
  assert.equal(tools.length, 7);
  assert.deepEqual(
    tools.map((t) => t.definition.name),
    [...VOICE_V6_TOOL_NAMES],
  );
  for (const tool of tools) {
    assert.equal(tool.definition.parameters.type, 'object');
    assert.ok(tool.definition.description.length > 20, tool.definition.name);
    assert.equal(typeof tool.needsApproval, 'boolean');
  }
  // Placeholder (no manager bound) refuses every tool with an error, never throws.
  const placeholder = new Map(VOICE_V6_TOOLS.map((t) => [t.definition.name, t]));
  assert.match(await runToolRaw(placeholder, 'voice_v6_state', { sessionId: 'x' }), /^Error: voice v6 session manager is not available/);
});

test('v107 tools: full lifecycle on a real manager (mock sessions)', async () => {
  const { manager, byName } = makeV6Tools();
  manager.createSession('call-1', { initialVoiceId: 'vi-nam' });

  const state = await runTool(byName, 'voice_v6_state', { sessionId: 'call-1' });
  assert.equal(state.callState, 'idle');
  assert.equal(state.voiceId, 'vi-nam');
  assert.equal(state.connected, false);
  assert.equal(state.networkDegraded, false);

  const voices = await runTool(byName, 'voice_v6_list_voices', { sessionId: 'call-1' });
  assert.equal(voices.voices.length, 6);
  assert.equal(voices.currentId, 'vi-nam');
  const allVoices = await runTool(byName, 'voice_v6_list_voices', {});
  assert.equal(allVoices.voices.length, 6);
  assert.equal(allVoices.sessionId, null);

  const switched = await runTool(byName, 'voice_v6_switch_voice', {
    sessionId: 'call-1',
    profileId: 'en-us',
  });
  assert.equal(switched.switched, true);
  assert.equal(switched.record.toId, 'en-us');
  const again = await runTool(byName, 'voice_v6_switch_voice', {
    sessionId: 'call-1',
    profileId: 'en-us',
  });
  assert.equal(again.switched, false);
  assert.match(again.reason, /already active/);
  const unknown = await runTool(byName, 'voice_v6_switch_voice', {
    sessionId: 'call-1',
    profileId: 'nope',
  });
  assert.equal(unknown.switched, false);

  const reverted = await runTool(byName, 'voice_v6_revert_voice', { sessionId: 'call-1' });
  assert.equal(reverted.reverted, true);
  assert.equal(reverted.record.toId, 'vi-nam');
  // A second revert goes back again (revert = previous voice, so it toggles).
  const revertedAgain = await runTool(byName, 'voice_v6_revert_voice', { sessionId: 'call-1' });
  assert.equal(revertedAgain.reverted, true);
  assert.equal(revertedAgain.record.toId, 'en-us');

  const net = await runTool(byName, 'voice_v6_network_status', { sessionId: 'call-1' });
  assert.equal(net.network.totalFailures, 0);
  assert.equal(net.network.degraded, false);
  const netAll = await runTool(byName, 'voice_v6_network_status', {});
  assert.equal(netAll.manager.sessions, 1);

  const reconnected = await runTool(byName, 'voice_v6_reconnect', { sessionId: 'call-1' });
  assert.equal(reconnected.ok, false);
  assert.match(reconnected.error, /No previous config/);

  const stats = await runTool(byName, 'voice_v6_session_stats', { sessionId: 'call-1' });
  assert.equal(stats.stats.callState, 'idle');
  assert.equal(stats.stats.voice.switches, 3);
  assert.equal(stats.stats.voice.reverts, 2);

  assert.match(await runToolRaw(byName, 'voice_v6_state', { sessionId: 'missing' }), /^Error: Unknown voice v6 session/);
  assert.match(await runToolRaw(byName, 'voice_v6_state', {}), /^Error: Missing required argument/);
});

test('v107 registry: all 7 voice_v6 tools in defaultToolFactory, total 649', () => {
  const ws = tmpDir('open-bot-voice-v107-registry-');
  const mem = new BotMemory(ws);
  try {
    const tools = defaultToolFactory(mem, ws, 'bot-1');
    const names = tools.map((t) => t.definition.name);
    assert.equal(names.length, 710, `expected 710 tools, got ${names.length}`); // v1.09 merge: 500 + 11 teams + 23 letta + 10 fleet_v6 + 10 voice_v8 + 2 a2a_v11 = 556; v1.10 merge: 556 + 9 memory_v10 + 10 mcp_v110 + 18 teams_v2 + 12 coding_v3 + 21 voice_v9/agui_v2/dashboard + 14 fleet_v7/cerebras = 640; v1.11 merge: 640 + 70 = 710; / v1.07 merge: 389 + 12 + 3 + 4 + 8 + 7 + 5 = 428
    assert.equal(new Set(names).size, names.length, 'duplicate tool names in the agent registry');
    for (const name of VOICE_V6_TOOL_NAMES) {
      assert.ok(names.includes(name), `${name} must be registered`);
      assert.equal(names.filter((n) => n === name).length, 1, `${name} exactly once`);
    }
  } finally {
    mem.close();
  }
});

// ---------------------------------------------------------------------------
// 7. Paper theme + UI wiring
// ---------------------------------------------------------------------------

test('v107 theme: paper is a first-class mode (resolve/apply/read/save)', () => {
  assert.ok(THEME_MODES.includes('paper'));
  assert.deepEqual([...THEME_MODES].sort(), ['dark', 'light', 'paper', 'system']);
  assert.equal(isThemeMode('paper'), true);
  assert.equal(isThemeMode('sepia'), false);
  assert.equal(resolveTheme('paper', true), 'paper');
  assert.equal(resolveTheme('paper', false), 'paper');
  assert.equal(resolveTheme('system', true), 'dark');
  assert.equal(resolveTheme('system', false), 'light');

  const store = new Map();
  const storage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, v),
  };
  saveThemeMode(storage, 'paper');
  assert.equal(readThemeMode(storage), 'paper');
  saveThemeMode(storage, 'dark');
  assert.equal(readThemeMode(storage), 'dark');

  const attrs = new Map();
  const root = {
    setAttribute: (k, v) => attrs.set(k, v),
    removeAttribute: (k) => attrs.delete(k),
  };
  applyThemeMode('paper', root);
  assert.equal(attrs.get('data-theme'), 'paper');
  applyThemeMode('system', root);
  assert.equal(attrs.has('data-theme'), false);
  applyThemeMode('paper', null);
});

test('v107 theme: paper CSS block + Settings paper option', () => {
  const css = fs.readFileSync(path.join(ROOT, 'apps/desktop/src/renderer/styles.css'), 'utf8');
  assert.match(css, /:root\[data-theme="paper"\]/);
  assert.match(css, /--bg: #f7f2e7/);
  assert.match(css, /--accent: #96692f/);
  assert.match(css, /--bubble-bot: #f0e8d5/);
  const tab = fs.readFileSync(
    path.join(ROOT, 'apps/desktop/src/renderer/components/SettingsGeneralTab.tsx'),
    'utf8',
  );
  assert.match(tab, /<option value="paper">/);
  assert.match(tab, /settings\.themePaper/);
});

test('v107 UI: BudgetMeter renders the core contract; panel wires v6 badge', () => {
  const meter = fs.readFileSync(
    path.join(ROOT, 'apps/desktop/src/renderer/components/BudgetMeter.tsx'),
    'utf8',
  );
  assert.match(meter, /toBudgetMeterView/);
  assert.match(meter, /view\.segments/);
  assert.match(meter, /budget\.meter\.remaining/);
  assert.match(meter, /budget\.meter\.byModel/);
  assert.match(meter, /budget\.meter\.noCap/);
  assert.match(meter, /role="progressbar"/);
  assert.match(meter, /data-testid="budget-meter"/);

  const badge = fs.readFileSync(
    path.join(ROOT, 'apps/desktop/src/renderer/components/VoiceStateBadge.tsx'),
    'utf8',
  );
  assert.match(badge, /data-testid="voice-state-badge"/);
  assert.match(badge, /data-testid="voice-v6-switch"/);
  assert.match(badge, /voice\.realtime\.v6\.stateDegraded/);
  assert.match(badge, /voice\.v6\.networkDegraded/);

  const panel = fs.readFileSync(
    path.join(ROOT, 'apps/desktop/src/renderer/components/RealtimeVoicePanel.tsx'),
    'utf8',
  );
  assert.match(panel, /RealtimeV6Status/);
  assert.match(panel, /v6Status\?/);
  assert.match(panel, /onVoiceSwitch\?/);
  assert.match(panel, /<VoiceStateBadge/);
  assert.match(panel, /voiceName=\{v6Status\.voiceName\}/);
});

// ---------------------------------------------------------------------------
// 9. Voice session v6 snapshots
// ---------------------------------------------------------------------------

test('v107 v6 snapshots: snapshot, validate, file store, restore, prune', async () => {
  const dir = tmpDir('open-bot-voice-v107-v6store-');
  const store = new FileVoiceSessionV6Store(dir);
  const manager = new VoiceV6Manager();
  const session = manager.createSession('call-9', { initialVoiceId: 'vi-nam' });
  await session.connect({ instructions: 'Hi.' });
  session.switchVoice('en-us');
  session.disconnect();

  const snap = snapshotVoiceSessionV6('call-9', session);
  assert.equal(snap.version, 1);
  assert.equal(snap.sessionId, 'call-9');
  assert.equal(snap.provider, 'openai');
  assert.equal(snap.voiceId, 'en-us');
  assert.equal(snap.switchHistory.length, 1);
  assert.equal(snap.stats.voice.switches, 1);
  assert.match(voiceSessionV6SnapshotSummary(snap), /call-9 \(openai, voice English — US/);
  const md = voiceSessionV6SnapshotMarkdown(snap);
  assert.match(md, /# Voice v6 session — call-9/);
  assert.match(md, /## Voice switches/);

  assert.equal(validateVoiceSessionV6Snapshot(null), null);
  assert.equal(validateVoiceSessionV6Snapshot({ version: 2 }), null);
  assert.equal(validateVoiceSessionV6Snapshot({ ...snap, sessionId: 'bad id!' }), null);
  assert.deepEqual(validateVoiceSessionV6Snapshot(JSON.parse(JSON.stringify(snap))), snap);

  const saved = store.save('call-9', session);
  assert.equal(saved.sessionId, 'call-9');
  const loaded = store.load('call-9');
  assert.equal(loaded.sessionId, 'call-9');
  assert.equal(loaded.voiceId, 'en-us');
  assert.equal(store.load('missing'), null);
  const listed = store.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].switches, 1);
  assert.equal(listed[0].degraded, false);

  // Restore into a fresh manager: same voice, history attached, counters fresh.
  const manager2 = new VoiceV6Manager();
  const restored = restoreVoiceSessionV6(manager2, loaded);
  assert.ok(restored);
  assert.equal(restored.session.getCurrentVoiceId(), 'en-us');
  assert.equal(restored.session.getRestoredSnapshot().sessionId, 'call-9');
  assert.equal(restored.session.getV6Stats().voice.switches, 0, 'live counters restart at 0');
  assert.equal(restoreVoiceSessionV6(manager2, loaded), null, 'refuses to overwrite a live session');

  // Corrupt file: loads as null, skipped by list.
  fs.writeFileSync(path.join(dir, 'broken.v6.json'), '{not json', 'utf8');
  assert.equal(store.list().length, 1);
  assert.equal(store.delete('call-9'), true);
  assert.equal(store.delete('call-9'), false);
  assert.equal(store.list().length, 0);

  // Prune: an old snapshot goes, a fresh one stays.
  const old = { ...snap, sessionId: 'old-call', savedAtMs: Date.now() - 40 * 24 * 60 * 60 * 1000 };
  store.saveSnapshot(old);
  store.saveSnapshot({ ...snap, sessionId: 'fresh-call', savedAtMs: Date.now() });
  assert.equal(store.prune(), 1);
  assert.deepEqual(store.list().map((i) => i.sessionId), ['fresh-call']);
  session.dispose();
});

// ---------------------------------------------------------------------------
// 10. Voice → budget link
// ---------------------------------------------------------------------------

test('v107 voice budget link: call minutes land in the meter under the voice key', async () => {
  const meter = new ConversationBudgetMeter('conv-voice', { tokenLimit: 100000 });
  const link = new VoiceBudgetLink(meter);
  const record = link.recordCall('call-1', 2.5);
  assert.equal(record.estimatedTokens, 2000);
  assert.equal(record.inputTokens, 1000);
  assert.equal(record.outputTokens, 1000);
  assert.equal(record.snapshot.byModel['voice'].inputTokens, 1000);
  assert.equal(record.snapshot.totalTokens, 2000);
  assert.equal(link.getVoiceShare().tokens, 2000);
  assert.equal(link.getVoiceShare().share, 1);

  // Zero minutes record nothing.
  const zero = link.recordCall('call-2', 0);
  assert.equal(zero.estimatedTokens, 0);
  assert.equal(link.getStats().calls, 1);

  // A session's turns convert at ~30s per turn (4 turns = 2 min).
  const session = createMockVoiceSessionV6();
  await session.connect({ instructions: 'Hi.' });
  session.noteUserTurn('hello');
  session.noteUserTurn('tell me more');
  session.noteUserTurn('and then?');
  session.noteUserTurn('bye');
  const fromSession = link.recordSession(session, 'call-3');
  assert.equal(fromSession.minutes, 2);
  assert.equal(fromSession.estimatedTokens, 1600);
  assert.equal(link.getStats().calls, 2);
  assert.equal(link.getStats().tokens, 3600);
  const share = link.getVoiceShare();
  assert.equal(share.tokens, 3600);
  assert.match(voiceBudgetSummary(link), /voice: 2 call\(s\)/);
  assert.match(voiceBudgetSummary(link), /~3,600 estimated tokens/);
  session.disconnect();
  session.dispose();
});

// ---------------------------------------------------------------------------
// 11. Budget history
// ---------------------------------------------------------------------------

test('v107 budget history: dedupe, peak, growth, sparkline, JSON round-trip', () => {
  const history = new BudgetMeterHistory('conv-h', { maxPoints: 3 });
  assert.equal(history.count, 0);
  assert.equal(history.sparkline(), '(no data)');
  assert.equal(history.growthPerHour(), null);
  assert.equal(history.peakLevel(), 'ok');

  const p1 = history.record(snapshot({ totalTokens: 1000, percentUsed: 10 }), 1000);
  assert.ok(p1);
  assert.equal(history.record(snapshot({ totalTokens: 1000, percentUsed: 10 }), 2000), null, 'unchanged snapshot is skipped');
  history.record(snapshot({ totalTokens: 5000, percentUsed: 50 }), 1000 + 3600000);
  history.record(snapshot({ totalTokens: 8000, percentUsed: 80 }), 1000 + 7200000);
  assert.equal(history.count, 3);
  assert.equal(history.peakPercentUsed(), 80);
  assert.equal(history.peakLevel(), 'warning');
  assert.equal(history.growthPerHour(), 3500);
  assert.equal(history.latest().totalTokens, 8000);
  const spark = history.sparkline();
  assert.equal(spark.length, 3);
  assert.match(spark, /^[▁▂▃▄▅▆▇█]{3}$/);

  // Bounded: the 4th point drops the oldest.
  history.record(snapshot({ totalTokens: 9000, percentUsed: 90 }), 1000 + 10800000);
  assert.equal(history.count, 3);
  assert.equal(history.points()[0].totalTokens, 5000);

  const json = history.toJSON();
  const restored = BudgetMeterHistory.fromJSON(json);
  assert.equal(restored.id, 'conv-h');
  assert.equal(restored.count, 3);
  assert.equal(restored.peakPercentUsed(), 90);
  assert.equal(BudgetMeterHistory.fromJSON(null).count, 0);
  assert.equal(BudgetMeterHistory.fromJSON({ points: 'nope' }).count, 0);
  const md = history.toMarkdown();
  assert.match(md, /# Budget history — conv-h \(3 point\(s\)\)/);
  assert.match(md, /Peak: 90\.0% \(critical\)/);
  assert.match(md, /Growth: ~2,000 tokens\/hour/);
});
