/**
 * Tests for v1.05 — voice realtime v4 (Team T5).
 *
 *   1. Latency pipeline (latencyPipeline.ts): histogram p50/p95/
 *      p99 + buckets, stage marks in order (out-of-order ignored),
 *      end-to-end turn latency, slowest stage, unmeasured stages
 *      stay null, latency modes (balanced vs low-latency config),
 *      adaptive jitter buffer (grows on jitter, shrinks when calm,
 *      clamped).
 *   2. Barge-in v4 (bargeInV4.ts): energy gate, VAD gate,
 *      debounce, state machine, TTS stop measured against the
 *      50 ms budget (breach counted), partial kept + resume
 *      prompt.
 *   3. Voice session v4 (voiceSessionV4.ts) on a fake transport:
 *      connect, turn latency (request → first audio), stage marks,
 *      mode switch, barge-in v4 end-to-end, turn history, resume
 *      partial utterance.
 *   4. Session manager v2 (voiceSessionManagerV2.ts): start /
 *      pause / resume / stop, concurrency cap refusal, reconnect
 *      with backoff (mock sessions), session log (memory + file,
 *      corrupt line tolerated).
 *   5. Voice eval (voiceEval.ts): WER on fixtures, barge-in
 *      latency scoring, markdown report.
 *   6. Voice v4 tools (packages/tools/src/voiceV4Tools.ts): 9
 *      tools, unique names, placeholder refuses, full lifecycle
 *      through the tools on a real manager (mock sessions).
 *   7. i18n: all 6 locales carry the 17 `voice.realtime.v4.*`
 *      keys. Panel: the v4 section exists in RealtimeVoicePanel.
 *
 * No network, no sound card, no live provider. Run after
 * building the core + tools packages:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/voice-v105.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  VoiceLatencyPipeline,
  AdaptiveJitterBuffer,
  LatencyHistogram,
  voiceLatencyReportMarkdown,
  VOICE_LATENCY_MODES,
} from '../packages/core/dist/voice/latencyPipeline.js';
import {
  BargeInV4Controller,
  buildResumeUtterance,
  BARGE_IN_V4_STOP_BUDGET_MS,
} from '../packages/core/dist/voice/bargeInV4.js';
import { VoiceSessionV4 } from '../packages/core/dist/voice/voiceSessionV4.js';
import {
  VoiceSessionManagerV2,
  MemoryVoiceSessionLogStore,
  FileVoiceSessionLogStore,
} from '../packages/core/dist/voice/voiceSessionManagerV2.js';
import {
  runVoiceEval,
  scoreBargeInLatency,
  voiceEvalReportMarkdown,
  VOICE_EVAL_FIXTURE_CASES,
} from '../packages/core/dist/voice/voiceEval.js';
import {
  createVoiceV4Tools,
  VOICE_V4_TOOLS,
  VOICE_V4_TOOL_NAMES,
  isVoiceV4ToolName,
} from '../packages/tools/dist/voiceV4Tools.js';
import { sinePcm16Frame } from '../packages/core/dist/voice/audio.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function makeClock(start = 1_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
}

/** Fake realtime transport (same shape as the v103 test's). */
class FakeTransport {
  constructor(callbacks) {
    this.cb = callbacks;
    this.provider = 'openai';
    this.inputSampleRateHz = 16_000;
    this.outputSampleRateHz = 24_000;
    this.handlesReconnect = true;
    this.connected = false;
    this.cancels = 0;
    this.commits = 0;
  }
  getState() {
    return this.connected ? 'connected' : 'closed';
  }
  isConnected() {
    return this.connected;
  }
  async connect() {
    this.connected = true;
    this.cb.onStateChange?.('connected');
  }
  disconnect() {
    this.connected = false;
    this.cb.onStateChange?.('closed');
  }
  sendAudio() {}
  commitAudio() {
    this.commits += 1;
  }
  requestResponse() {}
  cancelResponse() {
    this.cancels += 1;
  }
  sendToolResult() {}
  emitAudio() {
    this.cb.onAudio?.({ audio: sinePcm16Frame(2400, 0.1, 440, 24_000) });
  }
  emitTranscript(text, isFinal) {
    this.cb.onTranscript?.({ text, isFinal });
  }
  emitResponseDone() {
    this.cb.onResponseDone?.();
  }
  emitSpeechStarted() {
    this.cb.onSpeechStarted?.();
  }
}

function makeV4(events, clock, overrides = {}) {
  let transport = null;
  const v4 = new VoiceSessionV4({
    v3: {
      v2: {
        session: {
          provider: 'openai',
          transportFactory: (cb) => {
            transport = new FakeTransport(cb);
            return transport;
          },
        },
        longSession: { maxContextChars: 10_000 },
      },
      clock: clock.now,
      onEvent: undefined,
    },
    clock: clock.now,
    onEvent: (e) => events.push(e),
    ...overrides,
  });
  return { v4, getTransport: () => transport };
}

// ---------------------------------------------------------------------------
// 1. Latency pipeline
// ---------------------------------------------------------------------------

test('v105 latency histogram: p50/p95/p99, buckets, bad samples ignored', () => {
  const h = new LatencyHistogram();
  assert.equal(h.summary(), null);
  for (const ms of [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]) h.record(ms);
  h.record(-5);
  h.record(NaN);
  const s = h.summary();
  assert.equal(s.count, 10);
  assert.equal(s.minMs, 10);
  assert.equal(s.maxMs, 100);
  assert.equal(s.meanMs, 55);
  assert.equal(s.p50Ms, 50);
  assert.equal(s.p95Ms, 100);
  assert.equal(s.p99Ms, 100);
  // Buckets: edges [1,5,10,25,50,100,...] — samples <= 10: 1, <= 25: 2.
  assert.equal(s.buckets[2], 1);
  assert.equal(s.buckets[3], 2);
  assert.equal(s.buckets[s.buckets.length - 1], 0);
});

test('v105 latency pipeline: stages in order, out-of-order ignored, end-to-end', () => {
  const clock = makeClock();
  const p = new VoiceLatencyPipeline({ sessionId: 's1', clock: clock.now });
  assert.equal(p.markStage('capture'), null);
  assert.equal(p.endTurn(), null);
  p.startTurn();
  clock.advance(10);
  assert.equal(p.markStage('capture'), 10);
  clock.advance(5);
  assert.equal(p.markStage('vad'), 5);
  // Out of order: capture again, and a stage before its predecessor.
  assert.equal(p.markStage('capture'), null);
  clock.advance(20);
  assert.equal(p.markStage('stt'), 20);
  clock.advance(30);
  assert.equal(p.markStage('llm'), 30);
  clock.advance(15);
  assert.equal(p.markStage('tts'), 15);
  clock.advance(5);
  assert.equal(p.markStage('playback'), 5);
  assert.equal(p.endTurn(), 85);
  assert.equal(p.getTurnCount(), 1);
  const report = p.getReport();
  assert.equal(report.turns, 1);
  assert.equal(report.stages.capture.p50Ms, 10);
  assert.equal(report.stages.vad.p50Ms, 5);
  assert.equal(report.stages.llm.p50Ms, 30);
  assert.equal(report.endToEnd.p50Ms, 85);
  assert.equal(report.endToEnd.count, 1);
  assert.deepEqual(p.getEndToEndSamples(), [85]);
  assert.equal(report.slowestStage.stage, 'llm');
  assert.match(voiceLatencyReportMarkdown(report), /Voice latency/);
  assert.match(voiceLatencyReportMarkdown(report), /\| llm \| 30 \| 30 \| 30 \| 1 \|/);
  assert.match(voiceLatencyReportMarkdown(report), /\| capture \| 10 \| 10 \| 10 \| 1 \|/);
});

test('v105 latency pipeline: unmeasured stages stay null, direct record works', () => {
  const clock = makeClock();
  const p = new VoiceLatencyPipeline({ clock: clock.now });
  p.recordStage('stt', 42);
  p.recordStage('stt', 58);
  const report = p.getReport();
  assert.equal(report.stages.capture, null);
  assert.equal(report.stages.stt.count, 2);
  assert.equal(report.stages.stt.p50Ms, 42);
  assert.equal(report.stages.stt.p95Ms, 58);
  assert.equal(report.endToEnd, null);
  assert.equal(report.slowestStage.stage, 'stt');
});

test('v105 latency modes: low-latency really changes the config', () => {
  const balanced = VOICE_LATENCY_MODES.balanced;
  const low = VOICE_LATENCY_MODES['low-latency'];
  assert.equal(balanced.chunkMs, 20);
  assert.equal(low.chunkMs, 10);
  assert.ok(low.vadHangoverMs < balanced.vadHangoverMs);
  assert.ok(low.maxJitterBufferMs < balanced.maxJitterBufferMs);
  assert.equal(low.skipLocalVad, true);
  assert.equal(low.prefetchTts, true);
  const clock = makeClock();
  const p = new VoiceLatencyPipeline({ clock: clock.now });
  assert.equal(p.getMode(), 'balanced');
  const cfg = p.setMode('low-latency');
  assert.equal(cfg.chunkMs, 10);
  assert.equal(p.getJitterBufferMs(), 60);
  assert.equal(p.setMode('nope').mode, 'low-latency');
  assert.equal(p.getMode(), 'low-latency');
  assert.equal(p.setJitterBufferMs(9999), 160);
  assert.equal(p.setJitterBufferMs(5), 5);
});

test('v105 adaptive jitter buffer: grows on jitter, shrinks when calm, clamped', () => {
  const buf = new AdaptiveJitterBuffer({ startMs: 120, minMs: 40, maxMs: 200 });
  assert.equal(buf.getDepthMs(), 120);
  // Steady 20 ms gaps: calm, shrinks toward the floor.
  for (let i = 0; i < 40; i += 1) buf.observeGap(20);
  assert.ok(buf.getDepthMs() < 120);
  assert.ok(buf.getDepthMs() >= 40);
  assert.equal(buf.getStats().shrinks > 0, true);
  // Wild gaps: jitter grows the buffer toward the ceiling.
  const growsBefore = buf.getStats().grows;
  for (let i = 0; i < 60; i += 1) buf.observeGap(i % 2 === 0 ? 5 : 120);
  assert.ok(buf.getStats().grows > growsBefore);
  assert.ok(buf.getDepthMs() <= 200);
  assert.ok(buf.getJitterMs() > 10);
  assert.equal(buf.observeGap(-1), buf.getDepthMs());
});

// ---------------------------------------------------------------------------
// 2. Barge-in v4
// ---------------------------------------------------------------------------

test('v105 barge-in v4: energy gate, VAD gate, debounce, then interrupt', () => {
  const clock = makeClock();
  const c = new BargeInV4Controller({ clock: clock.now });
  assert.equal(c.getState(), 'idle');
  // Not speaking: everything is ignored as not-speaking.
  assert.equal(c.noteAudioFrame({ rms: 0.5, vadActive: true }).reason, 'not-speaking');
  c.modelSpeechStarted('hello there, this is a long reply');
  // Quiet frame: below the energy gate, streak resets.
  assert.equal(c.noteAudioFrame({ rms: 0.001, vadActive: true }).reason, 'below-energy');
  // Loud but no VAD: ignored.
  assert.equal(c.noteAudioFrame({ rms: 0.5, vadActive: false }).reason, 'no-vad');
  // Loud + VAD: debounce — first two frames only count.
  const d1 = c.noteAudioFrame({ rms: 0.5, vadActive: true });
  assert.equal(d1.action, 'ignore');
  assert.equal(d1.reason, 'debouncing');
  assert.equal(d1.frames, 1);
  const d2 = c.noteAudioFrame({ rms: 0.5, vadActive: true });
  assert.equal(d2.action, 'ignore');
  assert.equal(d2.frames, 2);
  const d3 = c.noteAudioFrame({ rms: 0.5, vadActive: true });
  assert.equal(d3.action, 'interrupt');
  assert.equal(d3.reason, 'confirmed');
  assert.equal(c.getStats().ignored.debouncing, 2);
  assert.equal(c.getStats().ignored['below-energy'], 1);
  assert.equal(c.getStats().ignored['no-vad'], 1);
});

test('v105 barge-in v4: stop measured against the 50 ms budget, partial kept + resume', async () => {
  const clock = makeClock();
  const c = new BargeInV4Controller({ clock: clock.now });
  assert.equal(BARGE_IN_V4_STOP_BUDGET_MS, 50);
  c.modelSpeechStarted('the answer is forty two, and the reason is');
  // Fast stop: 12 ms, inside the budget.
  const fast = await c.interrupt(async () => {
    clock.advance(12);
    return 12;
  });
  assert.equal(fast.stopped, true);
  assert.equal(fast.stopLatencyMs, 12);
  assert.equal(fast.withinBudget, true);
  assert.equal(fast.partialText, 'the answer is forty two, and the reason is');
  assert.equal(c.getState(), 'interrupted');
  // Slow stop: 80 ms, a breach.
  c.modelSpeechStarted('another reply here');
  const slow = await c.interrupt(async () => {
    clock.advance(80);
    return 80;
  });
  assert.equal(slow.withinBudget, false);
  const stats = c.getStats();
  assert.equal(stats.interrupts, 2);
  assert.equal(stats.stopBreaches, 1);
  assert.equal(stats.stopLatency.count, 2);
  assert.equal(stats.stopLatency.p95Ms, 80);
  assert.equal(stats.partials, 2);
  // Resume: the last partial comes back with a continue prompt.
  const resumed = c.resumePartial();
  assert.ok(resumed);
  assert.equal(resumed.partial.text, 'another reply here');
  assert.match(resumed.resumePrompt, /Continue exactly where you left off/);
  assert.match(resumed.resumePrompt, /another reply here/);
  assert.equal(c.getState(), 'listening');
  // Empty partial: no resume.
  const empty = new BargeInV4Controller({ clock: clock.now });
  assert.equal(empty.resumePartial(), null);
  assert.equal(buildResumeUtterance(''), 'The previous reply was interrupted before it started. Please answer the user again, briefly.');
  assert.match(buildResumeUtterance('half a sentence'), /half a sentence/);
});

// ---------------------------------------------------------------------------
// 3. Voice session v4
// ---------------------------------------------------------------------------

test('v105 session v4: connect, turn latency request -> first audio, stage marks', async () => {
  const events = [];
  const clock = makeClock();
  const { v4, getTransport } = makeV4(events, clock);
  await v4.connect({ instructions: 'You are helpful.' });
  assert.equal(v4.isConnected(), true);
  assert.equal(v4.getState(), 'listening');
  assert.equal(v4.getV4Stats().lastConnectMs, 0);
  v4.requestResponse();
  clock.advance(10);
  assert.equal(v4.markStage('capture'), 10);
  clock.advance(5);
  assert.equal(v4.markStage('vad'), 5);
  clock.advance(20);
  assert.equal(v4.markStage('stt'), 20);
  clock.advance(30);
  assert.equal(v4.markStage('llm'), 30);
  clock.advance(15);
  assert.equal(v4.markStage('tts'), 15);
  clock.advance(5);
  assert.equal(v4.markStage('playback'), 5);
  getTransport().emitAudio();
  const report = v4.getLatencyReport();
  assert.equal(report.turns, 1);
  assert.equal(report.endToEnd.p50Ms, 85);
  assert.equal(report.stages.llm.p50Ms, 30);
  assert.equal(report.slowestStage.stage, 'llm');
  assert.ok(events.find((e) => e.kind === 'latency-report'));
  v4.disconnect();
  assert.equal(v4.isConnected(), false);
});

test('v105 session v4: mode switch emits an event, turn history records turns', async () => {
  const events = [];
  const clock = makeClock();
  const { v4, getTransport } = makeV4(events, clock);
  await v4.connect({ instructions: 'You are helpful.' });
  assert.equal(v4.getLatencyMode(), 'balanced');
  const cfg = v4.setLatencyMode('low-latency');
  assert.equal(cfg.chunkMs, 10);
  assert.equal(v4.getLatencyMode(), 'low-latency');
  assert.ok(events.find((e) => e.kind === 'latency-mode'));
  v4.noteUserTurn('xin chào');
  getTransport().emitTranscript('Chào bạn, tôi có thể giúp gì?', true);
  const history = v4.getTurnHistory();
  assert.equal(history.length, 2);
  assert.equal(history[0].speaker, 'user');
  assert.equal(history[0].text, 'xin chào');
  assert.equal(history[1].speaker, 'model');
  assert.equal(history[1].interrupted, false);
  v4.disconnect();
});

test('v105 session v4: barge-in v4 end-to-end, partial resume prompt', async () => {
  const events = [];
  const clock = makeClock();
  const { v4, getTransport } = makeV4(events, clock, {
    stopTts: () => {
      clock.advance(12);
      return 12;
    },
  });
  await v4.connect({ instructions: 'You are helpful.' });
  getTransport().emitAudio();
  getTransport().emitTranscript('the capital of France is Paris, and', false);
  // Two frames: still debouncing.
  const first = await v4.noteAudioFrameV4({ rms: 0.5, vadActive: true });
  assert.equal(first.decision.action, 'ignore');
  assert.equal(first.result, null);
  const second = await v4.noteAudioFrameV4({ rms: 0.5, vadActive: true });
  assert.equal(second.decision.action, 'ignore');
  // Third frame: interrupt, stop measured at 12 ms, inside budget.
  const third = await v4.noteAudioFrameV4({ rms: 0.5, vadActive: true });
  assert.equal(third.decision.action, 'interrupt');
  assert.ok(third.result);
  assert.equal(third.result.stopLatencyMs, 12);
  assert.equal(third.result.withinBudget, true);
  assert.equal(third.result.partialText, 'the capital of France is Paris, and');
  assert.ok(events.find((e) => e.kind === 'barge-in-v4'));
  const stats = v4.getBargeInV4Stats();
  assert.equal(stats.interrupts, 1);
  assert.equal(stats.stopBreaches, 0);
  assert.equal(stats.lastPartialText, 'the capital of France is Paris, and');
  // History kept the cut model turn as a partial.
  assert.ok(v4.getTurnHistory().some((h) => h.partial && h.interrupted));
  // Resume prompt continues the cut sentence.
  const resumed = v4.resumePartialUtterance();
  assert.ok(resumed);
  assert.match(resumed.resumePrompt, /the capital of France is Paris, and/);
  assert.equal(v4.buildResumeUtterance().includes('Paris'), true);
  v4.disconnect();
});

// ---------------------------------------------------------------------------
// 4. Session manager v2
// ---------------------------------------------------------------------------

/** Deterministic managed session (no transport, no timers). */
class FakeManagedSession {
  constructor() {
    this.connected = false;
    this.connectCalls = 0;
    this.failConnect = 0;
    this.disposed = false;
  }
  getSessionId() {
    return 'fake';
  }
  isConnected() {
    return this.connected;
  }
  async connect() {
    this.connectCalls += 1;
    if (this.failConnect > 0) {
      this.failConnect -= 1;
      throw new Error('dial failed');
    }
    this.connected = true;
  }
  disconnect() {
    this.connected = false;
  }
  dispose() {
    this.disposed = true;
    this.connected = false;
  }
}

function makeManager(overrides = {}) {
  const clock = makeClock();
  const sessions = [];
  const manager = new VoiceSessionManagerV2({
    sessionFactory: () => {
      const s = new FakeManagedSession();
      sessions.push(s);
      return s;
    },
    sleep: async () => {},
    clock: clock.now,
    ...overrides,
  });
  return { manager, clock, sessions };
}

test('v105 manager: start / pause / resume / stop + session log', async () => {
  const { manager } = makeManager();
  const started = await manager.startSession('call-1', { instructions: 'Be helpful.' });
  assert.equal(started.ok, true);
  assert.equal(manager.getActiveCount(), 1);
  assert.equal(manager.getSession('call-1').status, 'active');
  // A non-v4 session has no mode switch: null, not a crash.
  assert.equal(manager.setSessionLatencyMode('call-1', 'low-latency'), null);
  assert.equal(manager.setSessionLatencyMode('missing', 'low-latency'), null);
  assert.equal(manager.pauseSession('call-1'), true);
  assert.equal(manager.getSession('call-1').status, 'paused');
  assert.equal(manager.getActiveCount(), 0);
  assert.equal(manager.pauseSession('call-1'), false);
  assert.equal(await manager.resumeSession('call-1'), true);
  assert.equal(manager.getSession('call-1').status, 'active');
  assert.equal(await manager.resumeSession('call-1'), false);
  assert.equal(manager.stopSession('call-1'), true);
  assert.equal(manager.getSession('call-1'), null);
  assert.equal(manager.stopSession('call-1'), false);
  const kinds = manager.getSessionLog('call-1').map((e) => e.kind);
  assert.deepEqual(kinds, ['start', 'pause', 'resume', 'stop']);
  assert.equal(manager.getSessionLog('call-1').every((e) => e.seq > 0), true);
  const stats = manager.getStats();
  assert.equal(stats.total, 0);
  assert.equal(stats.logEntries, 4);
  assert.equal(stats.maxConcurrentSessions, 3);
});

test('v105 manager: concurrency cap refuses and names the active sessions', async () => {
  const { manager } = makeManager({ maxConcurrentSessions: 2 });
  assert.equal((await manager.startSession('a')).ok, true);
  assert.equal((await manager.startSession('b')).ok, true);
  const third = await manager.startSession('c');
  assert.equal(third.ok, false);
  assert.match(third.reason, /Concurrency cap reached/);
  assert.match(third.reason, /a/);
  assert.match(third.reason, /b/);
  // Pausing frees a slot; a duplicate id is refused too.
  assert.equal(manager.pauseSession('a'), true);
  assert.equal((await manager.startSession('c')).ok, true);
  assert.equal((await manager.startSession('c')).ok, false);
  assert.match((await manager.startSession('c')).reason, /already exists/);
  assert.equal((await manager.startSession('  ')).ok, false);
  manager.stopAll();
  assert.equal(manager.getStats().total, 0);
});

test('v105 manager: reconnect retries with backoff, gives up honestly', async () => {
  const { manager, sessions } = makeManager({ maxReconnectAttempts: 3 });
  await manager.startSession('drop-1');
  const session = sessions[0];
  session.failConnect = 1;
  assert.equal(await manager.reconnectSession('drop-1'), true);
  assert.equal(session.connectCalls, 3);
  assert.equal(manager.getSession('drop-1').status, 'active');
  assert.equal(manager.getSession('drop-1').reconnectAttempts, 2);
  assert.ok(manager.getSessionLog('drop-1').some((e) => e.kind === 'reconnect'));
  // Always failing: 3 attempts, then error + reconnect-failed.
  session.failConnect = 99;
  assert.equal(await manager.reconnectSession('drop-1'), false);
  assert.equal(session.connectCalls, 6);
  assert.equal(manager.getSession('drop-1').status, 'error');
  assert.ok(manager.getSessionLog('drop-1').some((e) => e.kind === 'reconnect-failed'));
  assert.equal(await manager.reconnectSession('missing'), false);
});

test('v105 manager: file log store round-trips, corrupt line tolerated', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-voice-v105-log-'));
  try {
    const store = new FileVoiceSessionLogStore(dir, 10);
    assert.ok(store.getFilePath().endsWith('session-log.jsonl'));
    store.append({ seq: 1, sessionId: 's1', kind: 'start', at: 1000, detail: 'started' });
    store.append({ seq: 2, sessionId: 's1', kind: 'stop', at: 2000, detail: 'stopped' });
    store.append({ seq: 3, sessionId: 's2', kind: 'start', at: 3000, detail: 'started' });
    assert.equal(store.list().length, 3);
    assert.equal(store.list('s1').length, 2);
    assert.equal(store.list('s1')[0].kind, 'start');
    // A corrupt line does not kill the log.
    fs.appendFileSync(store.getFilePath(), '{not json\n', 'utf8');
    assert.equal(store.list().length, 3);
    // A fresh store reads the same file back.
    const reopened = new FileVoiceSessionLogStore(dir, 10);
    assert.equal(reopened.list('s2').length, 1);
    reopened.clear();
    assert.equal(reopened.list().length, 0);
    // Memory store caps + filters.
    const mem = new MemoryVoiceSessionLogStore(2);
    mem.append({ seq: 1, sessionId: 'a', kind: 'start', at: 1, detail: '' });
    mem.append({ seq: 2, sessionId: 'a', kind: 'stop', at: 2, detail: '' });
    mem.append({ seq: 3, sessionId: 'a', kind: 'start', at: 3, detail: '' });
    assert.equal(mem.list().length, 2);
    assert.equal(mem.list()[0].seq, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 5. Voice eval
// ---------------------------------------------------------------------------

test('v105 eval: fixtures score WER, barge-in latency scored vs 50 ms', () => {
  const report = runVoiceEval([...VOICE_EVAL_FIXTURE_CASES], { sessionId: 's1' });
  assert.equal(report.cases, 4);
  // en-2 drops "o clock" (WER 2/7) and vi-2 adds "chiều" (WER 1/6):
  // both miss the 0.2 bar, the two exact matches pass.
  assert.equal(report.passed, 3);
  assert.equal(report.passRate, 0.75);
  assert.equal(report.maxWer, 0.286);
  assert.ok(report.meanWer > 0.1 && report.meanWer < 0.12);
  assert.equal(report.werThreshold, 0.2);
  assert.equal(report.sessionId, 's1');
  const en2 = report.results.find((r) => r.id === 'eval-en-2');
  assert.equal(en2.wer.deletions, 2);
  assert.equal(en2.passed, false);
  // Empty hypothesis is a failure (WER 1), never a skip.
  const empty = runVoiceEval([{ id: 'x', reference: 'hello world', hypothesis: '' }]);
  assert.equal(empty.results[0].wer.wer, 1);
  assert.equal(empty.passed, 0);
  // Per-language breakdown: en 1/2, vi 2/2.
  assert.equal(report.byLang.en.cases, 2);
  assert.equal(report.byLang.en.passed, 1);
  assert.equal(report.byLang.vi.cases, 2);
  assert.equal(report.byLang.vi.passed, 2);
  assert.ok(report.byLang.en.meanWer > report.byLang.vi.meanWer);
  // Barge-in scoring: 1 of 3 stops over the budget.
  const scored = scoreBargeInLatency([10, 20, 120], 50);
  assert.equal(scored.samples, 3);
  assert.equal(scored.breaches, 1);
  assert.equal(scored.withinBudgetRate, 0.667);
  assert.equal(scored.p50Ms, 20);
  assert.equal(scored.p95Ms, 120);
  assert.equal(scoreBargeInLatency([], 50).withinBudgetRate, 0);
  // Markdown renders the report.
  const md = voiceEvalReportMarkdown(report);
  assert.match(md, /Voice eval/);
  assert.match(md, /eval-en-2/);
  assert.match(md, /Barge-in stops/);
  assert.match(md, /en: 1\/2 passed/);
  assert.match(md, /vi: 2\/2 passed/);
});

// ---------------------------------------------------------------------------
// 6. Voice v4 tools
// ---------------------------------------------------------------------------

const CTX = { botId: 'bot-a', runId: 'run-1', workspaceDir: '' };

function makeV4Tools() {
  const manager = new VoiceSessionManagerV2();
  const tools = createVoiceV4Tools({ getManager: () => manager });
  const byName = new Map(tools.map((t) => [t.definition.name, t]));
  return { manager, tools, byName };
}

async function runTool(byName, name, args, ctx = CTX) {
  const tool = byName.get(name);
  assert.ok(tool, `tool ${name} should exist`);
  const raw = await tool.execute(args, { ...ctx, workspaceDir: ctx.workspaceDir || '' });
  assert.equal(typeof raw, 'string');
  assert.ok(!raw.startsWith('Error:'), `tool ${name} failed: ${raw}`);
  return JSON.parse(raw);
}

async function runToolRaw(byName, name, args, ctx = CTX) {
  const tool = byName.get(name);
  assert.ok(tool, `tool ${name} should exist`);
  return tool.execute(args, { ...ctx, workspaceDir: ctx.workspaceDir || '' });
}

test('v105 tools: 9 tools, unique names, no approval needed (all local)', () => {
  assert.equal(VOICE_V4_TOOLS.length, 9);
  assert.equal(VOICE_V4_TOOL_NAMES.length, 9);
  const names = VOICE_V4_TOOLS.map((t) => t.definition.name);
  assert.equal(new Set(names).size, 9);
  assert.deepEqual([...names].sort(), [...VOICE_V4_TOOL_NAMES].sort());
  for (const name of VOICE_V4_TOOL_NAMES) {
    assert.equal(isVoiceV4ToolName(name), true);
  }
  assert.equal(isVoiceV4ToolName('voice_v4_nope'), false);
  for (const tool of VOICE_V4_TOOLS) {
    assert.equal(tool.needsApproval, false);
    assert.ok(tool.definition.description.length > 20);
    assert.equal(tool.definition.parameters.additionalProperties, false);
  }
});

test('v105 tools: placeholder (no manager) refuses with a clear error', async () => {
  const byName = new Map(createVoiceV4Tools().map((t) => [t.definition.name, t]));
  const raw = await runToolRaw(byName, 'voice_v4_session_log', {});
  assert.ok(raw.startsWith('Error:'));
  assert.match(raw, /session manager is not available/);
});

test('v105 tools: full lifecycle through the tools on mock sessions', async () => {
  const { manager, byName } = makeV4Tools();
  const started = await runTool(byName, 'voice_v4_start_session', {
    sessionId: 'tool-call-1',
    latencyMode: 'low-latency',
  });
  assert.equal(started.started, true);
  assert.equal(started.latencyMode, 'low-latency');
  // Duplicate start is refused, not a crash.
  const dup = await runTool(byName, 'voice_v4_start_session', { sessionId: 'tool-call-1' });
  assert.equal(dup.started, false);
  assert.match(dup.reason, /already exists/);
  // Bad latency mode is refused.
  const badMode = await runToolRaw(byName, 'voice_v4_start_session', {
    sessionId: 'tool-call-2',
    latencyMode: 'ultra',
  });
  assert.ok(badMode.startsWith('Error:'));
  assert.match(badMode, /latencyMode/);
  // Latency report: mode + unmeasured stages stay null.
  const latency = await runTool(byName, 'voice_v4_latency_report', { sessionId: 'tool-call-1' });
  assert.equal(latency.sessionId, 'tool-call-1');
  assert.equal(latency.report.mode, 'low-latency');
  assert.equal(latency.report.stages.capture, null);
  assert.equal(latency.report.turns, 0);
  assert.match(latency.markdown, /Voice latency/);
  assert.match(latency.markdown, /low-latency/);
  // Switch the mode mid-call through the tool.
  const switched = await runTool(byName, 'voice_v4_set_latency_mode', {
    sessionId: 'tool-call-1',
    latencyMode: 'balanced',
  });
  assert.equal(switched.latencyMode, 'balanced');
  const latency2 = await runTool(byName, 'voice_v4_latency_report', { sessionId: 'tool-call-1' });
  assert.equal(latency2.report.mode, 'balanced');
  const badSwitch = await runToolRaw(byName, 'voice_v4_set_latency_mode', {
    sessionId: 'tool-call-1',
    latencyMode: 'ultra',
  });
  assert.ok(badSwitch.startsWith('Error:'));
  const missingSwitch = await runTool(byName, 'voice_v4_set_latency_mode', {
    sessionId: 'nope',
    latencyMode: 'balanced',
  });
  assert.equal(missingSwitch.latencyMode, null);
  assert.match(missingSwitch.reason, /not found/);
  // Barge-in test: simulated model speech + loud frames interrupt.
  const barge = await runTool(byName, 'voice_v4_barge_in_test', { sessionId: 'tool-call-1' });
  assert.equal(barge.interrupted, true);
  assert.equal(typeof barge.stopLatencyMs, 'number');
  assert.ok(barge.stopLatencyMs <= 50);
  assert.equal(barge.withinBudget, true);
  assert.match(barge.partialText, /interrupted mid-sentence/);
  // Eval run on the fixtures.
  const evalOut = await runTool(byName, 'voice_v4_eval_run', { sessionId: 'tool-call-1' });
  assert.equal(evalOut.report.cases, 4);
  assert.equal(evalOut.report.passed, 3);
  assert.match(evalOut.markdown, /Voice eval/);
  // Custom cases.
  const custom = await runTool(byName, 'voice_v4_eval_run', {
    cases: [{ id: 'c1', reference: 'hello world', hypothesis: 'hello world' }],
  });
  assert.equal(custom.report.cases, 1);
  assert.equal(custom.report.passed, 1);
  // Pause + resume + stop.
  assert.deepEqual(await runTool(byName, 'voice_v4_pause_session', { sessionId: 'tool-call-1' }), {
    paused: true,
    sessionId: 'tool-call-1',
  });
  assert.deepEqual(await runTool(byName, 'voice_v4_resume_session', { sessionId: 'tool-call-1' }), {
    resumed: true,
    sessionId: 'tool-call-1',
  });
  // Session log shows the whole lifecycle.
  const log = await runTool(byName, 'voice_v4_session_log', { sessionId: 'tool-call-1' });
  assert.ok(log.entries.length >= 3);
  assert.ok(log.entries.some((e) => e.kind === 'start'));
  assert.ok(log.entries.some((e) => e.kind === 'pause'));
  assert.ok(log.entries.some((e) => e.kind === 'resume'));
  assert.equal(log.manager.total, 1);
  assert.deepEqual(await runTool(byName, 'voice_v4_stop_session', { sessionId: 'tool-call-1' }), {
    stopped: true,
    sessionId: 'tool-call-1',
  });
  assert.equal(manager.getSession('tool-call-1'), null);
  // Unknown session: clear error, not a crash.
  const missing = await runToolRaw(byName, 'voice_v4_latency_report', { sessionId: 'nope' });
  assert.ok(missing.startsWith('Error:'));
  assert.match(missing, /No voice session/);
});

// ---------------------------------------------------------------------------
// 7. i18n + panel
// ---------------------------------------------------------------------------

const V4_KEYS = [
  'voice.realtime.v4.title',
  'voice.realtime.v4.latencyMode',
  'voice.realtime.v4.modeBalanced',
  'voice.realtime.v4.modeLowLatency',
  'voice.realtime.v4.turnLatency',
  'voice.realtime.v4.slowestStage',
  'voice.realtime.v4.stageNotMeasured',
  'voice.realtime.v4.jitterBuffer',
  'voice.realtime.v4.bargeInState',
  'voice.realtime.v4.bargeInTest',
  'voice.realtime.v4.bargeInStop',
  'voice.realtime.v4.bargeInBreaches',
  'voice.realtime.v4.partialResume',
  'voice.realtime.v4.turnHistory',
  'voice.realtime.v4.turnHistoryEmpty',
  'voice.realtime.v4.waveform',
  'voice.realtime.v4.interruptedTurn',
];

test('v105 i18n: all 6 locales carry the 17 voice.realtime.v4.* keys', () => {
  const locales = ['en', 'vi', 'zh', 'ja', 'es', 'fr'];
  const sets = [];
  for (const locale of locales) {
    const data = JSON.parse(
      fs.readFileSync(
        path.join(ROOT, 'apps/desktop/src/renderer/i18n/locales', `${locale}.json`),
        'utf8',
      ),
    );
    const found = V4_KEYS.filter((k) => typeof data[k] === 'string' && data[k].length > 0);
    assert.equal(found.length, 17, `${locale} is missing v4 keys`);
    sets.push(new Set(Object.keys(data).filter((k) => k.startsWith('voice.realtime.v4.'))));
  }
  for (const set of sets.slice(1)) {
    assert.deepEqual([...set].sort(), [...sets[0]].sort());
  }
});

test('v105 panel: RealtimeVoicePanel has the v4 section', () => {
  const src = fs.readFileSync(
    path.join(ROOT, 'apps/desktop/src/renderer/components/RealtimeVoicePanel.tsx'),
    'utf8',
  );
  for (const marker of [
    'data-testid="realtime-v4"',
    'data-testid="realtime-v4-latency-mode"',
    'data-testid="realtime-v4-turn-latency"',
    'data-testid="realtime-v4-stages"',
    'data-testid="realtime-v4-bargein-test"',
    'data-testid="realtime-v4-resume-partial"',
    'data-testid="realtime-v4-waveform"',
    'data-testid="realtime-v4-turn-history"',
    'RealtimeV4Status',
    'onLatencyModeChange',
    'onBargeInTest',
    'onResumePartial',
  ]) {
    assert.ok(src.includes(marker), `panel is missing ${marker}`);
  }
});

test('v105 registry: coordinator binds the voice v4 tools', () => {
  const src = fs.readFileSync(
    path.join(ROOT, 'packages/core/src/coordinator/coordinator.ts'),
    'utf8',
  );
  assert.ok(src.includes('createVoiceV4Tools'));
  assert.ok(src.includes('VoiceSessionManagerV2'));
  assert.ok(src.includes('FileVoiceSessionLogStore'));
});
