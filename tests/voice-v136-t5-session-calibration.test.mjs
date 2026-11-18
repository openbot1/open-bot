/**
 * Tests for voice v23 session manager v2, calibration engine,
 * per-device profiles and the v23 monitor panel (v1.36, Team T5).
 *
 * All offline, deterministic, no key / network / audio.
 * Sessions use the mock v22 session (virtual clock, scripted
 * replies); reconnect attempts are reported by the test, no
 * socket is dialled.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RealtimeSessionManagerV23,
  createRealtimeSessionManagerV23,
  defaultSessionManagerV23Options,
  validateSessionManagerV23Options,
} from '../packages/core/dist/voiceV23/sessionManagerV23.js';
import {
  CalibrationEngineV23,
  createCalibrationEngineV23,
  classifyEnvironmentV23,
  snrDbV23,
  calibrationV23Summary,
  defaultCalibrationV23Options,
  validateCalibrationV23Options,
} from '../packages/core/dist/voiceV23/calibrationV23.js';
import {
  DeviceProfileRegistryV23,
  createDeviceProfileRegistryV23,
  builtinDeviceProfilesV23,
  clampDeviceProfileV23,
  validateDeviceProfileV23,
} from '../packages/core/dist/voiceV23/deviceProfilesV23.js';
import {
  MonitorPanelV23,
  createMonitorPanelV23,
  defaultMonitorPanelV23Options,
  validateMonitorPanelV23Options,
  VOICE_V23_PANEL_I18N_KEYS,
} from '../packages/core/dist/voiceV23/monitorPanelV23.js';
import { EvalHarnessV23 } from '../packages/core/dist/voiceV23/evalHarnessV23.js';
import { AdaptiveJitterBufferV23 } from '../packages/core/dist/voiceV23/streamingV23.js';
import { InterruptionLedgerV23 } from '../packages/core/dist/voiceV23/interruptionV23.js';

// ---------------------------------------------------------------- session manager
test('voice v136-t5: session manager — open/feed/close + duplicate open rejected', async () => {
  const manager = createRealtimeSessionManagerV23();
  const session = manager.open('s1', { scriptedReplies: { 'xin chào': 'Chào bạn, tôi có thể giúp gì?' } }, 0);
  assert.equal(manager.phaseOf('s1'), 'live');
  assert.equal(session.state(), 'listening');
  const reply = await session.feedFinal('Xin chào', 100);
  assert.equal(reply, 'Chào bạn, tôi có thể giúp gì?');
  assert.equal(manager.ids().length, 1);
  assert.throws(() => manager.open('s1'), /already exists/);
  assert.equal(manager.get('missing'), null);
  assert.equal(manager.phaseOf('missing'), null);
  manager.close('s1', 200);
  assert.equal(manager.phaseOf('s1'), 'closed');
  assert.throws(() => manager.close('missing', 200), /No session/);
  const stats = manager.stats();
  assert.equal(stats.sessions, 1);
  assert.equal(stats.live, 0);
  assert.equal(stats.closed, 1);
  assert.match(manager.summary(), /session manager v2/);
  assert.deepEqual(validateSessionManagerV23Options({ maxAttempts: 0 }), ['maxAttempts must be an integer 1..20']);
  assert.equal(defaultSessionManagerV23Options().maxAttempts, 5);
});

test('voice v136-t5: session manager — disconnect schedules reconnect, success resumes + refreshes token', async () => {
  const manager = new RealtimeSessionManagerV23();
  manager.open('s1', { scriptedReplies: { hello: 'Hi there' } }, 0);
  const session = manager.get('s1');
  await session.feedFinal('hello', 100);
  const delay = manager.disconnect('s1', 1000);
  assert.ok(delay > 0, `first backoff ${delay}ms should be positive`);
  assert.equal(manager.phaseOf('s1'), 'reconnecting');
  assert.equal(manager.attemptDue('s1', 1000), false);
  assert.equal(manager.attemptDue('s1', 1000 + delay), true);
  const result = await manager.reportAttempt('s1', 1000 + delay, 'success');
  assert.equal(result.phase, 'live');
  assert.notEqual(result.report, null);
  assert.equal(manager.phaseOf('s1'), 'live');
  const managed = manager.managedState('s1');
  assert.notEqual(managed.resumeToken, null, 'token refreshed after a successful resume');
  assert.ok(managed.resumeToken.startsWith('v22-resume-s1-'));
  assert.equal(manager.attemptsHistory().length, 1);
  assert.equal(manager.attemptsHistory()[0].outcome, 'success');
  assert.equal(manager.stats().totalResumes, 1);
});

test('voice v136-t5: session manager — failures back off, give up after maxAttempts', async () => {
  const manager = new RealtimeSessionManagerV23({ maxAttempts: 3 });
  manager.open('s1', {}, 0);
  manager.disconnect('s1', 0);
  let atMs = manager.managedState('s1').nextAttemptAtMs;
  const r1 = await manager.reportAttempt('s1', atMs, 'failure');
  assert.equal(r1.phase, 'reconnecting');
  assert.ok(r1.nextAttemptAtMs > atMs, 'next attempt scheduled later');
  atMs = r1.nextAttemptAtMs;
  const r2 = await manager.reportAttempt('s1', atMs, 'failure');
  assert.equal(r2.phase, 'reconnecting');
  atMs = r2.nextAttemptAtMs;
  const r3 = await manager.reportAttempt('s1', atMs, 'failure');
  assert.equal(r3.phase, 'failed');
  assert.equal(r3.nextAttemptAtMs, null);
  assert.equal(manager.stats().failed, 1);
  assert.equal(manager.attemptsHistory().length, 3);
  await assert.rejects(() => manager.reportAttempt('s1', atMs + 1000, 'success'), /not reconnecting/);
  // Backoff grows with the attempt number (v22 exponential + jitter).
  assert.ok(manager.backoffFor(3) > manager.backoffFor(1), 'backoff grows');
  assert.equal(manager.backoffFor(1), manager.backoffFor(1), 'backoff is deterministic');
});

test('voice v136-t5: session manager — handover keeps the transcript, old session closes', async () => {
  const manager = new RealtimeSessionManagerV23();
  manager.open('old', { scriptedReplies: { hello: 'Hi there' } }, 0);
  const oldSession = manager.get('old');
  await oldSession.feedFinal('hello', 100);
  assert.equal(oldSession.turnHistory().length, 2, 'user + agent turns before handover');
  const next = await manager.handover('old', 'new', 500);
  assert.equal(manager.phaseOf('old'), 'handed-over');
  assert.equal(manager.phaseOf('new'), 'live');
  assert.equal(next.turnHistory().length, 2, 'turns survive the handover');
  assert.equal(next.transcriptHistory().length, 1, 'transcript survives the handover');
  assert.equal(next.transcriptHistory()[0].text, 'hello');
  assert.equal(manager.stats().totalHandovers, 1);
  await assert.rejects(() => manager.handover('new', 'new', 600), /already exists/);
  await assert.rejects(() => manager.handover('gone', 'x', 600), /No session/);
  const report = manager.durabilityReport('new', 600);
  assert.equal(report.sessionId, 'new');
});

// ---------------------------------------------------------------- calibration
test('voice v136-t5: calibration — quiet room fits a low threshold, noisy room a high one', () => {
  const engine = createCalibrationEngineV23();
  const quiet = engine.calibrate({
    noiseSamples: [0.005, 0.008, 0.007, 0.006, 0.009, 0.005, 0.007, 0.006],
    speechSamples: [0.3, 0.32, 0.28, 0.31, 0.29],
  });
  assert.equal(quiet.environment, 'quiet');
  assert.ok(quiet.noiseFloor <= 0.02, `quiet floor ${quiet.noiseFloor}`);
  assert.equal(quiet.speechThreshold, 0.05, 'threshold clamps at the minimum');
  assert.ok(quiet.gain >= 0.9 && quiet.gain <= 1.1, `quiet gain ~1x, got ${quiet.gain}`);
  assert.ok(quiet.snrDb > 20, `quiet SNR ${quiet.snrDb}dB should be high`);
  assert.ok(quiet.confidence < 1, 'few samples means low confidence');
  const noisy = engine.calibrate({
    noiseSamples: Array.from({ length: 60 }, (_, i) => 0.12 + (i % 5) * 0.01),
    speechSamples: Array.from({ length: 60 }, () => 0.35),
  });
  assert.equal(noisy.environment, 'noisy');
  assert.ok(noisy.speechThreshold > 0.3, `noisy threshold ${noisy.speechThreshold} should be high`);
  assert.ok(noisy.confidence > 0.5, 'many samples means higher confidence');
  assert.match(calibrationV23Summary(noisy), /noisy room/);
  // Empty samples: floor 0, gain 1, low confidence — never crashes.
  const empty = engine.calibrate({ noiseSamples: [], speechSamples: [] });
  assert.equal(empty.noiseFloor, 0);
  assert.equal(empty.gain, 1);
  assert.equal(empty.confidence, 0);
  assert.match(empty.explanation, /no noise samples/);
  assert.deepEqual(validateCalibrationV23Options({ noisePercentile: 10 }), ['noisePercentile must be 50..99']);
  assert.equal(defaultCalibrationV23Options().targetSpeechRms, 0.3);
  assert.throws(() => new CalibrationEngineV23({ noisePercentile: 10 }), /Invalid CalibrationV23 options/);
});

test('voice v136-t5: environment classification + SNR at the boundaries', () => {
  assert.equal(classifyEnvironmentV23(0), 'quiet');
  assert.equal(classifyEnvironmentV23(0.02), 'quiet');
  assert.equal(classifyEnvironmentV23(0.05), 'office');
  assert.equal(classifyEnvironmentV23(0.08), 'office');
  assert.equal(classifyEnvironmentV23(0.15), 'noisy');
  assert.equal(classifyEnvironmentV23(0.2), 'noisy');
  assert.equal(classifyEnvironmentV23(0.5), 'very-noisy');
  assert.equal(snrDbV23(0.3, 0.01), 29.54);
  assert.equal(snrDbV23(0.3, 0), 60);
  assert.equal(snrDbV23(0, 0.01), 0);
});

test('voice v136-t5: recalibration blends the old floor with fresh samples', () => {
  const engine = new CalibrationEngineV23();
  const first = engine.calibrate({
    noiseSamples: Array.from({ length: 50 }, () => 0.01),
    speechSamples: Array.from({ length: 50 }, () => 0.3),
  });
  assert.equal(first.environment, 'quiet');
  const second = engine.recalibrate(first, Array.from({ length: 50 }, () => 0.15), Array.from({ length: 50 }, () => 0.35));
  assert.equal(second.environment, 'office', 'blended floor 0.08 lands in office');
  assert.equal(second.noiseSamples, 100);
  assert.ok(second.confidence >= first.confidence, 'more samples, no less confidence');
});

// ---------------------------------------------------------------- device profiles
test('voice v136-t5: device profiles — 6 built-ins, match by fingerprint, custom add/update/remove', () => {
  const registry = createDeviceProfileRegistryV23();
  assert.equal(builtinDeviceProfilesV23().length, 6);
  assert.equal(registry.list().length, 6);
  assert.equal(registry.current(), 'device-laptop');
  assert.equal(registry.get('device-headset').kind, 'headset');
  assert.equal(registry.get('nope'), null);
  assert.equal(registry.listByKind('phone').length, 1);
  // Headset fingerprint matches the headset preset.
  const matched = registry.match({ kind: 'headset', echoCancellation: true, sampleRate: 16000 });
  assert.equal(matched.profile.id, 'device-headset');
  assert.ok(matched.score >= 15);
  // Unknown kind falls back to a preset (never throws).
  assert.equal(registry.match({ kind: 'unknown' }).profile.id, 'device-laptop');
  // Custom profile lifecycle.
  assert.deepEqual(registry.add({
    id: 'device-usb-mic', kind: 'desktop', label: 'USB mic', gain: 1.3,
    noiseThreshold: 0.2, echoCancellation: false, sampleRate: 48000,
    environment: null, calibrated: false, builtin: false,
  }), []);
  assert.equal(registry.list().length, 7);
  assert.deepEqual(registry.update('device-usb-mic', { gain: 9 }), []);
  assert.equal(registry.get('device-usb-mic').gain, 4, 'gain clamps at 4');
  assert.deepEqual(registry.switchTo('device-usb-mic'), []);
  assert.equal(registry.current(), 'device-usb-mic');
  assert.deepEqual(registry.remove('device-usb-mic'), []);
  assert.equal(registry.current(), 'device-laptop', 'removing the current profile falls back to laptop');
  assert.equal(registry.remove('device-laptop').length, 1, 'built-ins cannot be removed');
  assert.equal(registry.remove('nope').length, 1);
  assert.equal(registry.add({ id: 'bad id!', kind: 'laptop', label: 'x', gain: 1, noiseThreshold: 0.2, echoCancellation: false, sampleRate: 16000, environment: null, calibrated: false, builtin: false }).length, 1);
  assert.deepEqual(validateDeviceProfileV23({ id: 'ok', label: 'x', sampleRate: 12345 }), ['sampleRate 12345 is not supported']);
  assert.deepEqual(clampDeviceProfileV23({ gain: 9, noiseThreshold: 0.001, sampleRate: 12345 }), { gain: 4, noiseThreshold: 0.05, sampleRate: 16000 });
  const stats = registry.stats();
  assert.equal(stats.total, 6);
  assert.equal(stats.builtin, 6);
  assert.equal(stats.custom, 0);
  assert.match(registry.summary(), /device profiles: 6/);
});

test('voice v136-t5: device profiles — per-user defaults + calibration applies to a profile', () => {
  const registry = new DeviceProfileRegistryV23();
  const engine = new CalibrationEngineV23();
  assert.deepEqual(registry.setUserDefault('huy', 'device-headset'), []);
  assert.equal(registry.userDefault('huy'), 'device-headset');
  assert.equal(registry.profileForUser('huy').id, 'device-headset');
  assert.equal(registry.profileForUser('stranger').id, 'device-laptop', 'no default -> current profile');
  assert.equal(registry.setUserDefault('huy', 'nope').length, 1);
  const result = engine.calibrate({
    noiseSamples: Array.from({ length: 100 }, () => 0.05),
    speechSamples: Array.from({ length: 100 }, () => 0.3),
  });
  assert.deepEqual(registry.applyCalibration('device-headset', result), []);
  const applied = registry.get('device-headset');
  assert.equal(applied.calibrated, true);
  assert.equal(applied.environment, 'office');
  assert.equal(applied.noiseThreshold, result.speechThreshold);
  assert.equal(applied.gain, result.gain);
  assert.equal(registry.stats().calibrated, 1);
  assert.equal(registry.applyCalibration('nope', result).length, 1);
});

// ---------------------------------------------------------------- monitor panel
test('voice v136-t5: monitor panel — snapshot + alerts + markdown across eval/stream/session/calibration', () => {
  // The panel's alert thresholds must match the harness budget used here.
  const panel = createMonitorPanelV23({ latencyAlertMs: 1200 });
  assert.deepEqual(panel.alerts(), [], 'empty panel has no alerts');
  const harness = new EvalHarnessV23({ latencyBudgetMs: 1200 });
  panel.setEval(harness.runAll(0), 0);
  const buffer = new AdaptiveJitterBufferV23();
  panel.setStreaming(buffer.stats(), 0);
  const ledger = new InterruptionLedgerV23();
  panel.setInterruptions(ledger.stats(), 0);
  const manager = new RealtimeSessionManagerV23();
  panel.setSessions(manager.stats(), 0);
  const engine = new CalibrationEngineV23();
  const calibration = engine.calibrate({
    noiseSamples: Array.from({ length: 100 }, () => 0.01),
    speechSamples: Array.from({ length: 100 }, () => 0.3),
  });
  panel.setCalibration(calibration, 0);
  const snap = panel.snapshot(1000);
  assert.equal(snap.eval.passes, true);
  assert.equal(snap.streaming.targetMs, 120);
  assert.equal(snap.calibration.environment, 'quiet');
  assert.deepEqual(snap.alerts, []);
  const md = panel.markdown(1000);
  assert.match(md, /# Voice v23 monitor/);
  assert.match(md, /Eval: WER/);
  assert.match(md, /Streaming: buffer target/);
  assert.match(md, /Calibration: quiet room/);
  assert.match(md, /Alerts: none/);
  assert.match(panel.summary(), /voice v23 panel: eval PASS, 0 alert/);
  // A breaching eval raises alerts.
  const strict = new EvalHarnessV23();
  panel.setEval(strict.runAll(0), 0);
  assert.ok(panel.alerts().some((a) => a.includes('p95 first-token')), `alerts: ${panel.alerts().join('; ')}`);
  assert.match(panel.markdown(0), /p95 first-token/);
  assert.deepEqual(validateMonitorPanelV23Options({ mosAlert: 9 }), ['mosAlert must be 1..5']);
  assert.equal(defaultMonitorPanelV23Options().mosAlert, 3.0);
  assert.throws(() => new MonitorPanelV23({ mosAlert: 9 }), /Invalid MonitorPanelV23 options/);
});

test('voice v136-t5: monitor panel i18n keys — all 19 voice.v23.panel.* keys exist', () => {
  assert.equal(VOICE_V23_PANEL_I18N_KEYS.length, 19);
  assert.ok(VOICE_V23_PANEL_I18N_KEYS.every((k) => k.startsWith('voice.v23.panel.')));
  assert.ok(VOICE_V23_PANEL_I18N_KEYS.includes('voice.v23.panel.title'));
  assert.ok(VOICE_V23_PANEL_I18N_KEYS.includes('voice.v23.panel.mos'));
  assert.ok(VOICE_V23_PANEL_I18N_KEYS.includes('voice.v23.panel.underruns'));
});
