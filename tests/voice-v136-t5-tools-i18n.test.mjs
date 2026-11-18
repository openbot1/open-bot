/**
 * Tests for voice v23 tools + registry wiring + i18n
 * (v1.36, Team T5).
 *
 * Covers voiceV23Tools (all 7 tools end to end against the
 * default mock instances), the v23 tools wiring into ALL_TOOLS
 * (bound replace-in-place, never duplicated), and the
 * voice.v23.* i18n keys in all 6 locales.
 *
 * All offline, deterministic, no key / network / audio.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createVoiceV23Tools,
  VOICE_V23_TOOLS,
  VOICE_V23_TOOL_NAMES,
  isVoiceV23ToolName,
} from '../packages/tools/dist/voiceV23Tools.js';
import {
  ALL_TOOLS,
  createDefaultTools,
} from '../packages/tools/dist/tools.js';

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

// ---------------------------------------------------------------- tool inventory
test('voice v136-t5: voice v23 tools — 7 tools, names + factory, no dotted names', () => {
  assert.equal(VOICE_V23_TOOLS.length, 7);
  assert.deepEqual([...VOICE_V23_TOOL_NAMES], [
    'voice_v23_eval',
    'voice_v23_stream',
    'voice_v23_endpoint',
    'voice_v23_interrupt',
    'voice_v23_session',
    'voice_v23_calibrate',
    'voice_v23_monitor',
  ]);
  for (const name of VOICE_V23_TOOL_NAMES) {
    assert.match(name, /^[A-Za-z0-9_-]+$/, `${name} must not contain a dot`);
  }
  assert.equal(isVoiceV23ToolName('voice_v23_eval'), true);
  assert.equal(isVoiceV23ToolName('voice_v22_session'), false);
  assert.equal(createVoiceV23Tools().length, 7);
  for (const tool of VOICE_V23_TOOLS) {
    assert.equal(tool.needsApproval, false);
    assert.equal(typeof tool.execute, 'function');
  }
});

test('voice v136-t5: voice v23 tools are in ALL_TOOLS once, bound tools replace in place', () => {
  const names = ALL_TOOLS.map((t) => t.definition.name);
  for (const name of VOICE_V23_TOOL_NAMES) {
    assert.equal(names.filter((n) => n === name).length, 1, `${name} registered exactly once`);
  }
  // 825 at merge/v135 + 74 v136 = 899 on merge/v136 (was 813 in the T5 worktree).
  assert.equal(ALL_TOOLS.length, 899); // v1.36 re-pin: 825 + 74 = 899.
  assert.equal(new Set(names).size, names.length, 'no duplicate tool names');
  const bound = createDefaultTools({
    getVoiceV23ToolOptions: () => ({}),
  });
  assert.equal(bound.length, ALL_TOOLS.length);
  assert.equal(new Set(bound.map((t) => t.definition.name)).size, bound.length);
});

// ---------------------------------------------------------------- eval tool
test('voice v136-t5: voice_v23_eval — pair, corpus, latency, mos, baseline, report, markdown', async () => {
  const tools = createVoiceV23Tools();
  const pair = parseOk(await run(tools, 'voice_v23_eval', { action: 'pair', reference: 'Xin chào Hà Nội', hypothesis: 'Xin chào Hà Nội', werCeiling: 0.05 }));
  assert.equal(pair.wer, 0);
  assert.equal(pair.passes, true);
  const bad = parseOk(await run(tools, 'voice_v23_eval', { action: 'pair', reference: 'a b c', hypothesis: 'a b d', werCeiling: 0.05 }));
  assert.equal(bad.passes, false);
  const corpus = parseOk(await run(tools, 'voice_v23_eval', { action: 'corpus' }));
  assert.equal(corpus.n, 26);
  assert.equal(corpus.passed, 26);
  const latency = parseOk(await run(tools, 'voice_v23_eval', { action: 'latency' }));
  assert.equal(latency.n, 12);
  assert.equal(latency.p95FirstTokenMs, 1020.5);
  const mos = parseOk(await run(tools, 'voice_v23_eval', { action: 'mos' }));
  assert.equal(mos.n, 8);
  assert.ok(mos.meanMos >= 3.0);
  const calibrated = parseOk(await run(tools, 'voice_v23_eval', { action: 'mos-calibrate' }));
  assert.ok(Math.abs(calibrated.after.meanSignedError) <= 0.05);
  const baseline = parseOk(await run(tools, 'voice_v23_eval', {
    action: 'baseline',
    baselineJson: JSON.stringify({ version: 'v22', meanWer: 0.06, p95LatencyMs: 1150, meanMos: 3.2, bargeInLatencyMs: 420, evaluatedAtMs: 0, pairs: 26 }),
    currentJson: JSON.stringify({ version: 'v23', meanWer: 0.0184, p95LatencyMs: 1020.5, meanMos: 3.66, bargeInLatencyMs: 260, evaluatedAtMs: 1000, pairs: 26 }),
  }));
  assert.equal(baseline.regressed, false);
  assert.ok(baseline.improved.length >= 3);
  const report = parseOk(await run(tools, 'voice_v23_eval', { action: 'report', atMs: 0 }));
  assert.equal(report.passes, false, 'default corpus fails on the latency tail');
  assert.match(report.summary, /FAIL/);
  const md = parseOk(await run(tools, 'voice_v23_eval', { action: 'markdown', atMs: 0 }));
  assert.match(md.markdown, /Voice v23 eval report/);
  assert.match(md.markdown, /Verdict: \*\*FAIL\*\*/);
  const err = await run(tools, 'voice_v23_eval', { action: 'nope' });
  assert.ok(err.startsWith('Error: Unknown action'));
  const err2 = await run(tools, 'voice_v23_eval', { action: 'pair', reference: 'x' });
  assert.ok(err2.startsWith('Error: Missing required argument'));
});

// ---------------------------------------------------------------- stream + endpoint tools
test('voice v136-t5: voice_v23_stream — push/pull/ready/stats/recommend/pace/reset', async () => {
  const tools = createVoiceV23Tools();
  const pushed = parseOk(await run(tools, 'voice_v23_stream', { action: 'push', seq: 0, atMs: 0, energy: 0.5 }));
  assert.equal(pushed.accepted, true);
  await run(tools, 'voice_v23_stream', { action: 'push', seq: 1, atMs: 20, energy: 0.6 });
  await run(tools, 'voice_v23_stream', { action: 'push', seq: 2, atMs: 40, energy: 0.4 });
  const ready = parseOk(await run(tools, 'voice_v23_stream', { action: 'ready' }));
  assert.equal(ready.ready, false, '3 frames (60ms) is below the 120ms target');
  const pulled = parseOk(await run(tools, 'voice_v23_stream', { action: 'pull', atMs: 60 }));
  assert.equal(pulled.frame.seq, 0);
  const rec = parseOk(await run(tools, 'voice_v23_stream', { action: 'recommend', jitterP95Ms: 100, lossPct: 5 }));
  assert.ok(rec.targetMs > 120);
  const paced = parseOk(await run(tools, 'voice_v23_stream', { action: 'pace', seq: 0, atMs: 1000 }));
  assert.equal(paced.playAtMs, 1000);
  const reset = parseOk(await run(tools, 'voice_v23_stream', { action: 'reset' }));
  assert.equal(reset.reset, true);
  const err = await run(tools, 'voice_v23_stream', { action: 'push', atMs: 0 });
  assert.ok(err.startsWith('Error: Missing required argument'));
});

test('voice v136-t5: voice_v23_endpoint — trace, feed-speech, feed-energy, set-noise-floor', async () => {
  const tools = createVoiceV23Tools();
  const trace = parseOk(await run(tools, 'voice_v23_endpoint', {
    action: 'trace',
    framesJson: JSON.stringify([...new Array(40).fill(true), ...new Array(30).fill(false)]),
    atMs: 0,
  }));
  assert.equal(trace.endFrame, 55);
  assert.equal(trace.state, 'ended');
  await run(tools, 'voice_v23_endpoint', { action: 'reset' });
  const fed = parseOk(await run(tools, 'voice_v23_endpoint', { action: 'feed-speech', speech: 'true', atMs: 0 }));
  assert.equal(fed.state, 'idle', 'one speech frame is below the 8-frame start threshold');
  const floored = parseOk(await run(tools, 'voice_v23_endpoint', { action: 'set-noise-floor', noiseFloor: 0.15 }));
  assert.equal(floored.energyThreshold, 0.45);
  const energy = parseOk(await run(tools, 'voice_v23_endpoint', { action: 'feed-energy', energy: 0.3, atMs: 20 }));
  assert.equal(energy.state, 'idle', '0.3 is below the adapted 0.45 threshold');
  const stats = parseOk(await run(tools, 'voice_v23_endpoint', { action: 'stats' }));
  assert.equal(stats.framesSeen, 2);
  const err = await run(tools, 'voice_v23_endpoint', { action: 'trace', framesJson: '[1, 2]' });
  assert.ok(err.startsWith('Error: framesJson must be a JSON array of booleans'));
});

// ---------------------------------------------------------------- interrupt tool
test('voice v136-t5: voice_v23_interrupt — decide, rollback, strategy, record, ledger', async () => {
  const tools = createVoiceV23Tools();
  const decided = parseOk(await run(tools, 'voice_v23_interrupt', {
    action: 'decide', atMs: 5000, atMsIntoReply: 2000, energy: 0.9, sustainMs: 800,
    wordsJson: JSON.stringify(['dừng', 'lại', 'đi']),
  }));
  assert.equal(decided.decision, 'interrupt');
  assert.equal(decided.rule, 'v22-score');
  const graced = parseOk(await run(tools, 'voice_v23_interrupt', {
    action: 'decide', atMs: 50, atMsIntoReply: 50, energy: 0.9, sustainMs: 800,
    wordsJson: JSON.stringify(['dừng', 'lại']),
  }));
  assert.equal(graced.decision, 'ignore');
  assert.equal(graced.rule, 'grace-window');
  const rb = parseOk(await run(tools, 'voice_v23_interrupt', {
    action: 'rollback', replyText: 'Xin chào, hôm nay thời tiết ở Hà Nội rất đẹp', spokenChars: 20,
  }));
  assert.equal(rb.rollback.reSpeakFromChar, 14);
  assert.equal(rb.rollback.rolledBackChars, 3);
  const strat = parseOk(await run(tools, 'voice_v23_interrupt', {
    action: 'strategy', replyText: 'word '.repeat(120).trim(), spokenChars: 100,
    wordsJson: JSON.stringify(['lại']),
  }));
  assert.equal(strat.strategy, 'rephrase');
  const recorded = parseOk(await run(tools, 'voice_v23_interrupt', {
    action: 'record', atMs: 100, atMsIntoReply: 1000, energy: 0.9, sustainMs: 800,
    wordsJson: JSON.stringify(['dừng']), stopLatencyMs: 180,
  }));
  assert.equal(recorded.decision.decision, 'interrupt');
  assert.equal(recorded.record.stopLatencyMs, 180);
  const ledger = parseOk(await run(tools, 'voice_v23_interrupt', { action: 'ledger' }));
  assert.equal(ledger.total, 1);
  assert.equal(ledger.interrupts, 1);
  const marked = parseOk(await run(tools, 'voice_v23_interrupt', { action: 'mark-false-positive', recordId: recorded.record.id }));
  assert.equal(marked.marked, true);
  assert.equal(marked.falsePositives, 1);
  const err = await run(tools, 'voice_v23_interrupt', { action: 'mark-false-positive', recordId: 'v23-int-999' });
  assert.ok(err.startsWith('Error: No ledger record'));
});

// ---------------------------------------------------------------- session tool
test('voice v136-t5: voice_v23_session — open/feed/disconnect/attempt/handover/close/status/list', async () => {
  const tools = createVoiceV23Tools();
  const opened = parseOk(await run(tools, 'voice_v23_session', { action: 'open', sessionId: 's1', atMs: 0 }));
  assert.equal(opened.phase, 'live');
  const fed = parseOk(await run(tools, 'voice_v23_session', { action: 'feed-final', sessionId: 's1', text: 'hello', atMs: 100 }));
  assert.equal(fed.reply, 'I heard: hello');
  const disconnected = parseOk(await run(tools, 'voice_v23_session', { action: 'disconnect', sessionId: 's1', atMs: 1000 }));
  assert.equal(disconnected.phase, 'reconnecting');
  assert.ok(disconnected.nextAttemptInMs > 0);
  const failed = parseOk(await run(tools, 'voice_v23_session', {
    action: 'attempt', sessionId: 's1', outcome: 'failure', atMs: 1000 + disconnected.nextAttemptInMs,
  }));
  assert.equal(failed.phase, 'reconnecting');
  assert.ok(failed.nextAttemptAtMs > 1000);
  const ok = parseOk(await run(tools, 'voice_v23_session', { action: 'attempt', sessionId: 's1', outcome: 'success', atMs: failed.nextAttemptAtMs }));
  assert.equal(ok.phase, 'live');
  assert.notEqual(ok.report, null);
  const status = parseOk(await run(tools, 'voice_v23_session', { action: 'status', sessionId: 's1', atMs: failed.nextAttemptAtMs }));
  assert.equal(status.managed.phase, 'live');
  assert.ok(status.managed.resumeToken.startsWith('v22-resume-s1-'));
  const handed = parseOk(await run(tools, 'voice_v23_session', { action: 'handover', sessionId: 's1', toId: 's2', atMs: 5000 }));
  assert.equal(handed.to, 's2');
  assert.equal(handed.phase, 'live');
  const listed = parseOk(await run(tools, 'voice_v23_session', { action: 'list' }));
  assert.deepEqual(listed.ids, ['s1', 's2']);
  assert.equal(listed.sessions, 2);
  const closed = parseOk(await run(tools, 'voice_v23_session', { action: 'close', sessionId: 's2', atMs: 6000 }));
  assert.equal(closed.phase, 'closed');
  const err = await run(tools, 'voice_v23_session', { action: 'status', sessionId: 'gone' });
  assert.ok(err.startsWith('Error: No session'));
  const err2 = await run(tools, 'voice_v23_session', { action: 'attempt', sessionId: 's1', outcome: 'maybe' });
  assert.ok(err2.startsWith('Error: outcome must be'));
});

// ---------------------------------------------------------------- calibrate tool
test('voice v136-t5: voice_v23_calibrate — calibrate, classify, device CRUD + match + apply', async () => {
  const tools = createVoiceV23Tools();
  const noCal = await run(tools, 'voice_v23_calibrate', { action: 'device-apply', profileId: 'device-headset' });
  assert.ok(noCal.startsWith('Error: No calibration run yet'));
  const cal = parseOk(await run(tools, 'voice_v23_calibrate', {
    action: 'calibrate',
    noiseJson: JSON.stringify(Array.from({ length: 100 }, () => 0.05)),
    speechJson: JSON.stringify(Array.from({ length: 100 }, () => 0.3)),
  }));
  assert.equal(cal.environment, 'office');
  assert.equal(cal.confidence, 1);
  const classified = parseOk(await run(tools, 'voice_v23_calibrate', { action: 'classify', noiseFloor: 0.01 }));
  assert.equal(classified.environment, 'quiet');
  const list = parseOk(await run(tools, 'voice_v23_calibrate', { action: 'device-list' }));
  assert.equal(list.profiles.length, 6);
  assert.equal(list.current, 'device-laptop');
  const matched = parseOk(await run(tools, 'voice_v23_calibrate', { action: 'device-match', kind: 'headset', echoCancellation: 'true', sampleRate: 16000 }));
  assert.equal(matched.profile.id, 'device-headset');
  const applied = parseOk(await run(tools, 'voice_v23_calibrate', { action: 'device-apply', profileId: 'device-headset' }));
  assert.equal(applied.profile.calibrated, true);
  assert.equal(applied.profile.environment, 'office');
  const added = parseOk(await run(tools, 'voice_v23_calibrate', {
    action: 'device-add',
    profileJson: JSON.stringify({ id: 'device-usb', kind: 'desktop', label: 'USB mic', gain: 1.3, noiseThreshold: 0.2, echoCancellation: false, sampleRate: 48000, environment: null, calibrated: false, builtin: false }),
  }));
  assert.equal(added.profile.id, 'device-usb');
  const switched = parseOk(await run(tools, 'voice_v23_calibrate', { action: 'device-switch', profileId: 'device-usb' }));
  assert.equal(switched.current, 'device-usb');
  const updated = parseOk(await run(tools, 'voice_v23_calibrate', {
    action: 'device-update', profileId: 'device-usb',
    profileJson: JSON.stringify({ gain: 9 }),
  }));
  assert.equal(updated.profile.gain, 4, 'gain clamps at 4');
  const removed = parseOk(await run(tools, 'voice_v23_calibrate', { action: 'device-remove', profileId: 'device-usb' }));
  assert.equal(removed.removed, true);
  assert.equal(removed.profiles.length, 6);
  const stats = parseOk(await run(tools, 'voice_v23_calibrate', { action: 'device-stats' }));
  assert.equal(stats.total, 6);
  assert.equal(stats.calibrated, 1);
  const err = await run(tools, 'voice_v23_calibrate', { action: 'device-match', kind: 'toaster' });
  assert.ok(err.startsWith('Error: Unknown kind'));
});

// ---------------------------------------------------------------- monitor tool
test('voice v136-t5: voice_v23_monitor — snapshot + markdown + quality mirror the live stack', async () => {
  const tools = createVoiceV23Tools();
  const snap = parseOk(await run(tools, 'voice_v23_monitor', { action: 'snapshot', atMs: 0 }));
  assert.equal(snap.eval.passes, false, 'default eval fails on the latency tail');
  assert.equal(snap.streaming.targetMs, 120);
  assert.equal(snap.sessions.sessions, 0);
  assert.ok(snap.alerts.some((a) => a.includes('p95 first-token')));
  const md = parseOk(await run(tools, 'voice_v23_monitor', { action: 'markdown', atMs: 0 }));
  assert.match(md.markdown, /# Voice v23 monitor/);
  assert.match(md.markdown, /Eval: WER/);
  assert.match(md.markdown, /Alert: /);
  const quality = parseOk(await run(tools, 'voice_v23_monitor', { action: 'quality', atMs: 0 }));
  assert.equal(typeof quality.total, 'number');
  assert.ok(quality.total >= 0 && quality.total <= 100);
  assert.ok(['A', 'B', 'C', 'D', 'F'].includes(quality.grade));
  assert.ok(Array.isArray(quality.recommendations));
  assert.ok(quality.recommendations.some((r) => r.includes('p95 first-token')), 'latency tail shows up as a recommendation');
  assert.match(quality.markdown, /# Voice v23 quality report/);
  const trend1 = parseOk(await run(tools, 'voice_v23_monitor', { action: 'trend', atMs: 0 }));
  assert.equal(trend1.count, 1);
  assert.equal(trend1.trend, 'unknown', 'one point is not a trend');
  const trend2 = parseOk(await run(tools, 'voice_v23_monitor', { action: 'trend', atMs: 60000 }));
  assert.equal(trend2.count, 2);
  assert.equal(trend2.trend, 'stable', 'same score twice means a flat slope');
  assert.match(trend2.markdown, /# Voice v23 quality trend/);
  assert.match(trend2.summary, /voice quality trend:/);
  const bad = await run(tools, 'voice_v23_monitor', { action: 'nope', atMs: 0 });
  assert.ok(bad.startsWith('Error: Unknown action'));
});

// ---------------------------------------------------------------- i18n
test('voice v136-t5: 38 voice.v23.* keys in all 6 locales, non-empty, totals 7540, keys sorted', () => {
  const expected = [
    'voice.v23.calibration.done',
    'voice.v23.calibration.environment.noisy',
    'voice.v23.calibration.environment.office',
    'voice.v23.calibration.environment.quiet',
    'voice.v23.calibration.environment.veryNoisy',
    'voice.v23.eval.baseline',
    'voice.v23.eval.fail',
    'voice.v23.eval.latency',
    'voice.v23.eval.mos',
    'voice.v23.eval.pass',
    'voice.v23.eval.regression',
    'voice.v23.eval.wer',
    'voice.v23.interrupt.ducked',
    'voice.v23.interrupt.ignored',
    'voice.v23.interrupt.interrupted',
    'voice.v23.panel.alerts',
    'voice.v23.panel.buffer',
    'voice.v23.panel.calibration',
    'voice.v23.panel.environment',
    'voice.v23.panel.eval',
    'voice.v23.panel.fail',
    'voice.v23.panel.gain',
    'voice.v23.panel.interruptions',
    'voice.v23.panel.jitter',
    'voice.v23.panel.latency',
    'voice.v23.panel.mos',
    'voice.v23.panel.noAlerts',
    'voice.v23.panel.pass',
    'voice.v23.panel.sessions',
    'voice.v23.panel.streaming',
    'voice.v23.panel.threshold',
    'voice.v23.panel.title',
    'voice.v23.panel.underruns',
    'voice.v23.panel.wer',
    'voice.v23.session.failed',
    'voice.v23.session.handover',
    'voice.v23.session.reconnected',
    'voice.v23.session.resumed',
  ];
  assert.equal(expected.length, 38);
  for (const locale of LOCALES) {
    const data = JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, `${locale}.json`), 'utf8'));
    const keys = Object.keys(data);
    assert.equal(keys.length, 7540, `${locale} total keys`); // v1.36 re-pin: 7540.
    assert.deepEqual(keys, [...keys].sort(), `${locale} keys must stay sorted`);
    for (const key of expected) {
      assert.equal(typeof data[key], 'string', `${locale} missing ${key}`);
      assert.ok(data[key].length > 0, `${locale} ${key} must be non-empty`);
    }
  }
  const vi = JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, 'vi.json'), 'utf8'));
  assert.equal(vi['voice.v23.panel.title'], 'Giám sát giọng nói v23');
  assert.equal(vi['voice.v23.eval.wer'], 'Tỉ lệ lỗi từ (WER)');
  assert.equal(vi['voice.v23.session.resumed'], 'Phiên đã khôi phục từ checkpoint.');
});
