/**
 * Tests for voice v24 per-tool-call timers + session + panel
 * (v1.37, Team T5).
 *
 * Covers ToolCallTimerRegistryV24 (start/end/fail/cancel,
 * per-tool and per-session aggregates, slow/timeout/
 * error-burst alerts, live running-call checks), the
 * formatting helpers, VoiceSessionV24 (transcript +
 * timers + model switch together) and TimerPanelV24
 * (snapshot + markdown).
 *
 * All offline, deterministic, no key / network / audio.
 * All clocks virtual (atMs passed by the test).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ToolCallTimerRegistryV24,
  createToolCallTimerRegistryV24,
  defaultToolCallTimerV24Options,
  validateToolCallTimerV24Options,
} from '../packages/core/dist/voiceV24/toolCallTimersV24.js';
import {
  DynamicProviderCatalogV24,
  createDynamicProviderCatalogV24,
} from '../packages/core/dist/voiceV24/providerCatalogV24.js';
import {
  VoiceSessionV24,
  createVoiceSessionV24,
} from '../packages/core/dist/voiceV24/voiceSessionV24.js';
import {
  TimerPanelV24,
  createTimerPanelV24,
  defaultTimerPanelV24Options,
  validateTimerPanelV24Options,
  VOICE_V24_PANEL_I18N_KEYS,
} from '../packages/core/dist/voiceV24/timerPanelV24.js';
import {
  formatDurationV24,
  formatDurationShortV24,
  durationBucketV24,
  transcriptChecksumV24,
  isValidVoiceV24Id,
} from '../packages/core/dist/voiceV24/types.js';

function catalogWithTwoProviders() {
  const catalog = createDynamicProviderCatalogV24();
  catalog.register({
    id: 'codex', label: 'Codex', kind: 'subscription',
    models: [{ id: 'gpt-5.2', label: 'GPT-5.2', supportsVoice: true }],
    configured: true, accountLabel: 'demo@example.com', source: 'cli',
  }, 0);
  catalog.register({
    id: 'ollama', label: 'Ollama', kind: 'local',
    models: [{ id: 'qwen3:8b', label: 'Qwen3 8B' }],
    configured: true, source: 'local',
  }, 0);
  catalog.recordProbe({ providerId: 'codex', atMs: 100, ok: true, latencyMs: 120 });
  catalog.recordProbe({ providerId: 'ollama', atMs: 100, ok: true, latencyMs: 2600 });
  return catalog;
}

// ---------------------------------------------------------------- helpers
test('voice v137-t5: duration formatting + buckets + ids + checksum', () => {
  assert.equal(formatDurationV24(850), '850ms');
  assert.equal(formatDurationV24(1230), '1.23s');
  assert.equal(formatDurationV24(125000), '2m 05s');
  assert.equal(formatDurationV24(Number.NaN), '—');
  assert.equal(formatDurationV24(-5), '0ms');
  assert.equal(formatDurationShortV24(125000), '2m05s');
  assert.equal(formatDurationShortV24(1500), '1.5s');
  assert.equal(durationBucketV24(100, 5000, 30000), 'fast');
  assert.equal(durationBucketV24(2000, 5000, 30000), 'normal');
  assert.equal(durationBucketV24(6000, 5000, 30000), 'slow');
  assert.equal(durationBucketV24(40000, 5000, 30000), 'very-slow');
  assert.equal(isValidVoiceV24Id('s-1_x'), true);
  assert.equal(isValidVoiceV24Id('bad id'), false);
  assert.equal(isValidVoiceV24Id('bad.id'), false);
  assert.equal(isValidVoiceV24Id(''), false);
  const turns = [
    { role: 'user', text: 'xin chào', atMs: 0 },
    { role: 'assistant', text: 'chào bạn', atMs: 100 },
  ];
  assert.equal(transcriptChecksumV24(turns), transcriptChecksumV24(turns));
  assert.notEqual(
    transcriptChecksumV24(turns),
    transcriptChecksumV24([{ role: 'user', text: 'xin chào!', atMs: 0 }]),
  );
});

// ---------------------------------------------------------------- options
test('voice v137-t5: timer options — defaults + validation', () => {
  assert.deepEqual(defaultToolCallTimerV24Options(), {
    slowThresholdMs: 5000, timeoutMs: 30000, maxRecords: 1000, errorBurstCount: 3,
  });
  assert.deepEqual(validateToolCallTimerV24Options({}), []);
  assert.ok(validateToolCallTimerV24Options({ slowThresholdMs: 0 }).length > 0);
  assert.ok(validateToolCallTimerV24Options({ timeoutMs: 100, slowThresholdMs: 5000 }).length > 0);
  assert.ok(validateToolCallTimerV24Options({ maxRecords: 5 }).length > 0);
  assert.ok(validateToolCallTimerV24Options({ errorBurstCount: 1 }).length > 0);
  assert.throws(() => new ToolCallTimerRegistryV24({ slowThresholdMs: 5000, timeoutMs: 5000 }), /timeoutMs/);
  assert.deepEqual(defaultTimerPanelV24Options(), { maxAlerts: 20, maxSwitches: 20 });
  assert.ok(validateTimerPanelV24Options({ maxAlerts: 0 }).length > 0);
  assert.ok(validateTimerPanelV24Options({ maxSwitches: 500 }).length > 0);
});

// ---------------------------------------------------------------- registry basics
test('voice v137-t5: timers — start/end/fail/cancel + double-finish + unknown id', () => {
  const timers = createToolCallTimerRegistryV24();
  const id = timers.start('s1', 'web_search', 1000, 0);
  assert.equal(id, 'tc-1');
  const running = timers.get(id);
  assert.equal(running.status, 'running');
  assert.equal(running.durationMs, null);
  const done = timers.end(id, 2500);
  assert.equal(done.status, 'completed');
  assert.equal(done.durationMs, 1500);
  assert.throws(() => timers.end(id, 2600), /already finished/);
  assert.throws(() => timers.end('tc-99', 2600), /No tool call/);
  assert.throws(() => timers.end(timers.start('s1', 'x', 3000), 2000), /before start/);
  const failId = timers.start('s1', 'calendar_read', 4000);
  const failed = timers.fail(failId, 4300, 'timeout from provider');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error, 'timeout from provider');
  const cancelId = timers.start('s1', 'file_read', 5000);
  assert.equal(timers.cancel(cancelId, 5100).status, 'cancelled');
  assert.equal(timers.count(), 4);
  assert.throws(() => timers.start('bad id', 'x', 0), /Invalid sessionId/);
  assert.throws(() => timers.start('s1', '', 0), /toolName/);
});

// ---------------------------------------------------------------- aggregates
test('voice v137-t5: timers — per-tool + per-session aggregates', () => {
  const timers = createToolCallTimerRegistryV24();
  const durations = [800, 1200, 6000, 900];
  for (const d of durations) {
    const id = timers.start('s1', 'web_search', 0);
    timers.end(id, d);
  }
  const id2 = timers.start('s1', 'calendar_read', 0);
  timers.end(id2, 300);
  const stats = timers.toolStats('web_search', 's1');
  assert.equal(stats.calls, 4);
  assert.equal(stats.completed, 4);
  assert.equal(stats.maxMs, 6000);
  assert.equal(stats.totalMs, 8900);
  assert.equal(stats.slowCalls, 1);
  assert.equal(stats.slowRate, 0.25);
  assert.equal(stats.p95Ms, 5280);
  const session = timers.sessionStats('s1');
  assert.equal(session.calls, 5);
  assert.equal(session.totalMs, 9200);
  assert.equal(session.slowest.toolName, 'web_search');
  assert.equal(session.slowest.durationMs, 6000);
  assert.equal(session.byTool[0].toolName, 'web_search');
  assert.equal(session.byTool[1].toolName, 'calendar_read');
  assert.match(timers.summary('s1'), /Session s1: 5 tool calls/);
  assert.match(timers.summary(), /5 tool calls across 2 tools/);
  assert.equal(timers.toolStats('nope', 's1').calls, 0);
});

// ---------------------------------------------------------------- alerts
test('voice v137-t5: timers — slow/timeout alerts on finish + live check while running', () => {
  const timers = createToolCallTimerRegistryV24({ slowThresholdMs: 1000, timeoutMs: 5000 });
  const slowId = timers.start('s1', 'web_search', 0);
  timers.end(slowId, 1500);
  const timeoutId = timers.start('s1', 'file_read', 0);
  timers.end(timeoutId, 8000);
  const alerts = timers.alertsList('s1');
  assert.equal(alerts.length, 2);
  assert.equal(alerts[0].kind, 'slow');
  assert.equal(alerts[0].thresholdMs, 1000);
  assert.equal(alerts[1].kind, 'timeout');
  assert.match(alerts[0].message, /ran slow after 1.50s/);
  // Live check: a running call past the slow line raises an alert now, not at end.
  const liveId = timers.start('s1', 'calendar_read', 10000);
  const raised = timers.checkRunning(12500);
  assert.equal(raised.length, 1);
  assert.equal(raised[0].kind, 'slow');
  assert.match(raised[0].message, /still running after/);
  // Same call must not raise twice.
  assert.equal(timers.checkRunning(13000).length, 0);
  const live = timers.running('s1', 13000);
  assert.equal(live.length, 1);
  assert.equal(live[0].elapsedMs, 3000);
  assert.equal(live[0].overSlowThreshold, true);
  assert.equal(live[0].overTimeout, false);
  assert.equal(live[0].bucket, 'slow');
  timers.end(liveId, 14000);
  // Finishing after a live alert must not duplicate it.
  assert.equal(timers.alertsList('s1').filter((a) => a.callId === liveId).length, 1);
});

test('voice v137-t5: timers — error-burst alert after 3 failures of one tool', () => {
  const timers = createToolCallTimerRegistryV24();
  for (let i = 0; i < 3; i += 1) {
    const id = timers.start('s1', 'flaky_tool', i * 100);
    timers.fail(id, i * 100 + 50, `boom ${i}`);
  }
  const bursts = timers.alertsList('s1').filter((a) => a.kind === 'error-burst');
  assert.equal(bursts.length, 1);
  assert.match(bursts[0].message, /flaky_tool failed 3 times/);
  // A 4th failure does not raise a second burst for the same tool+session.
  const id = timers.start('s1', 'flaky_tool', 1000);
  timers.fail(id, 1050, 'boom 3');
  assert.equal(timers.alertsList('s1').filter((a) => a.kind === 'error-burst').length, 1);
  assert.equal(timers.clearAlerts('s1'), 1);
  assert.equal(timers.alertsList('s1').length, 0);
});

test('voice v137-t5: timers — prune keeps running calls, markdown renders', () => {
  const timers = createToolCallTimerRegistryV24({ maxRecords: 10 });
  const runningId = timers.start('s1', 'long_tool', 0);
  for (let i = 0; i < 12; i += 1) {
    const id = timers.start('s1', 'quick_tool', i);
    timers.end(id, i + 1);
  }
  assert.equal(timers.get(runningId).status, 'running');
  assert.equal(timers.count(), 10);
  const md = timers.markdown('s1');
  assert.match(md, /# Voice v24 tool-call timers — session s1/);
  assert.match(md, /\| long_tool \|/);
  timers.cancelSession('s1', 5000);
  assert.equal(timers.get(runningId).status, 'cancelled');
});

// ---------------------------------------------------------------- session
test('voice v137-t5: session — transcript + timers + model switch, checksum preserved', () => {
  const catalog = catalogWithTwoProviders();
  const session = VoiceSessionV24.open('s1', { providerId: 'codex', model: 'gpt-5.2' }, catalog, 0);
  assert.equal(session.phaseOf(), 'open');
  session.addTurn('user', 'xin chào', 100);
  session.addTurn('assistant', 'chào bạn', 200);
  const checksumBefore = session.transcriptChecksum();
  const callId = session.startToolCall('web_search', 300);
  session.endToolCall(callId, 900);
  const switched = session.switchModel({ providerId: 'ollama', model: 'qwen3:8b' }, 1000);
  assert.equal(switched.ok, true);
  assert.equal(switched.transcriptPreserved, true);
  assert.equal(session.transcriptChecksum(), checksumBefore);
  assert.equal(session.currentModel().providerId, 'ollama');
  assert.equal(session.transcriptCount(), 2);
  const snapshot = session.snapshot(1100);
  assert.equal(snapshot.timers.calls, 1);
  assert.equal(snapshot.switches, 1);
  assert.equal(snapshot.currentModel.model, 'qwen3:8b');
  assert.match(session.summary(1100), /model ollama\/qwen3:8b/);
  assert.match(session.markdown(1100), /# Voice v24 session s1/);
  const rolled = session.rollbackModel(1200);
  assert.equal(rolled.ok, true);
  assert.equal(session.currentModel().providerId, 'codex');
  const closed = session.close(2000);
  assert.equal(closed.transcriptTurns, 2);
  assert.throws(() => session.addTurn('user', 'nữa', 2100), /is closed/);
  assert.throws(() => session.switchModel({ providerId: 'ollama', model: 'qwen3:8b' }, 2100), /is closed/);
});

test('voice v137-t5: session — close cancels running calls; factory create works', () => {
  const catalog = catalogWithTwoProviders();
  const session = createVoiceSessionV24('s2', { providerId: 'codex', model: 'gpt-5.2' }, catalog);
  const callId = session.startToolCall('web_search', 100);
  const closed = session.close(500);
  assert.equal(closed.cancelledCalls, 1);
  assert.equal(session.timerRegistry().get(callId).status, 'cancelled');
  assert.equal(session.close(600).cancelledCalls, 0);
  assert.throws(() => session.addTurn('user', '', 700), /is closed/);
});

// ---------------------------------------------------------------- panel
test('voice v137-t5: panel — snapshot + markdown + i18n keys', () => {
  const catalog = catalogWithTwoProviders();
  const session = VoiceSessionV24.open('s1', { providerId: 'codex', model: 'gpt-5.2' }, catalog, 0);
  session.addTurn('user', 'hello', 10);
  const callId = session.startToolCall('web_search', 20);
  session.endToolCall(callId, 6200);
  const panel = createTimerPanelV24();
  const snapshot = panel.snapshot({
    sessionId: 's1',
    timers: session.timerRegistry(),
    catalog,
    atMs: 7000,
    switcher: session.modelSwitcher(),
  });
  assert.equal(snapshot.providers.length, 2);
  assert.equal(snapshot.providers[0].status, 'online');
  assert.equal(snapshot.usableProviders, 2);
  assert.equal(snapshot.finished.length, 1);
  assert.equal(snapshot.finished[0].toolName, 'web_search');
  assert.equal(snapshot.alerts.length, 1);
  assert.equal(snapshot.alerts[0].kind, 'slow');
  assert.equal(snapshot.currentModel.providerId, 'codex');
  assert.match(panel.summary(snapshot), /Session s1: model codex\/gpt-5.2/);
  const md = panel.markdown(snapshot);
  assert.match(md, /# Voice v24 — session s1/);
  assert.match(md, /## Running tool calls/);
  assert.match(md, /## Finished tool calls/);
  assert.match(md, /## Alerts/);
  assert.match(md, /## Providers \(dynamic, at panel time\)/);
  assert.ok(VOICE_V24_PANEL_I18N_KEYS.length >= 30);
  assert.ok(VOICE_V24_PANEL_I18N_KEYS.includes('voice.v24.panel.title'));
  assert.ok(VOICE_V24_PANEL_I18N_KEYS.includes('voice.v24.panel.transcriptKept'));
  assert.equal(validateTimerPanelV24Options({ maxAlerts: 5 }).length, 0);
});
