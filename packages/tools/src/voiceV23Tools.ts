/**
 * Voice v23 tools for @open-bot/tools (v1.36, Đội T5).
 *
 * The agent drives the voice v23 evaluation / streaming /
 * calibration stack by tool call:
 *  - voice_v23_eval       — score one transcript pair, run the
 *    transcript / latency / MOS suites, compare a v22 baseline
 *    against a v23 run, full report + markdown
 *  - voice_v23_stream     — adaptive jitter buffer (push/pull/
 *    ready/stats), buffer-target recommendation, frame pacer
 *  - voice_v23_endpoint   — endpointing v2: feed speech/energy
 *    frames, run a boolean trace, set the noise floor
 *  - voice_v23_interrupt  — interruption policy v2: decide a
 *    burst, roll a cut reply back to a word boundary, pick a
 *    resume strategy, ledger record/stats/false-positive
 *  - voice_v23_session    — session manager v2: open/feed/
 *    disconnect/reconnect-attempt/handover/close/status/list
 *  - voice_v23_calibrate  — calibration engine (noise/speech
 *    samples -> threshold/gain/environment) + per-device
 *    profiles (list/get/add/update/remove/switch/match/apply)
 *  - voice_v23_monitor    — v23 monitor panel snapshot / markdown
 *    (eval, streaming, interruptions, sessions, calibration)
 *
 * SAFETY: everything here is local — transcripts are caller
 * supplied text (no mic), audio frames are synthetic PCM,
 * reconnects and calibrations are pure computation, snapshots
 * are plain JSON, no provider is called, no key is read or
 * stored, no mic or sound card is touched.
 *
 * Factory:
 *   createVoiceV23Tools(opts) -> Tool[]   (bound, usable)
 *   VOICE_V23_TOOLS                       (unbound placeholder, own
 *   default instances — mock sessions only)
 */
import type { Tool } from '@open-bot/core';
import {
  EvalHarnessV23,
  AdaptiveJitterBufferV23,
  FramePacerV23,
  EndpointingEngineV23,
  InterruptionPolicyV23,
  InterruptionLedgerV23,
  RealtimeSessionManagerV23,
  CalibrationEngineV23,
  DeviceProfileRegistryV23,
  MonitorPanelV23,
  QualityReportV23,
  createQualityReportV23,
  QualityTrendV23,
  createQualityTrendV23,
  EVAL_CORPUS_V23_TRANSCRIPTS,
  EVAL_CORPUS_V23_LATENCY,
  EVAL_CORPUS_V23_MOS,
  EVAL_CORPUS_V23_INTERRUPTIONS,
  EVAL_CORPUS_V23_ENDPOINTS,
  werV23,
  aggregateLatencyV23,
  mosProxyV23,
  calibrateMosV23,
  compareWithBaselineV23,
  evalHarnessV23Markdown,
  recommendBufferTargetV23,
  rollbackForCutV23,
  strategyForCutV23,
  splitReplyAtCutV22,
  classifyEnvironmentV23,
  type VoiceV23EvalPair,
  type VoiceV23Baseline,
  type VoiceV23DeviceProfile,
  type VoiceV23MosFeatures,
  type VoiceV23MosSample,
  type EvalHarnessV23Options,
  type AdaptiveBufferV23Options,
  type EndpointingV23Options,
  type InterruptionV23Options,
  type SessionManagerV23Options,
  type CalibrationV23Options,
  type VoiceV23MonitorPanelOptions,
  type VoiceV23CalibrationResult,
} from '@open-bot/core';

function errorResult(message: string): string {
  return `Error: ${message}`;
}

function getStringArg(args: Record<string, unknown>, name: string, required = true): string {
  const value = args[name];
  if (value === undefined || value === null) {
    if (required) throw new Error(`Missing required argument: "${name}"`);
    return '';
  }
  if (typeof value !== 'string') throw new Error(`Argument "${name}" must be a string, got ${typeof value}`);
  return value;
}

function getOptionalStringArg(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error(`Argument "${name}" must be a string, got ${typeof value}`);
  return value;
}

function getOptionalNumberArg(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Argument "${name}" must be a finite number, got ${String(value)}`);
  }
  return value;
}

function getOptionalBooleanArg(args: Record<string, unknown>, name: string): boolean | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value === 'true') return true;
    if (value === 'false') return false;
  }
  throw new Error(`Argument "${name}" must be a boolean, got ${String(value)}`);
}

function toolDef(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
): Tool['definition'] {
  return {
    name,
    description,
    parameters: { type: 'object', properties, required, additionalProperties: false },
  };
}

function parseJsonArg(value: string | undefined, name: string): unknown {
  if (value === undefined || value === '') return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`Argument "${name}" is not valid JSON`);
  }
}

function parseNumberArray(value: string | undefined, name: string): number[] {
  const raw = parseJsonArg(value, name);
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || !raw.every((v) => typeof v === 'number')) {
    throw new Error(`Argument "${name}" must be a JSON array of numbers`);
  }
  return raw as number[];
}

function parseStringArray(value: string | undefined, name: string): string[] {
  const raw = parseJsonArg(value, name);
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || !raw.every((v) => typeof v === 'string')) {
    throw new Error(`Argument "${name}" must be a JSON array of strings`);
  }
  return raw as string[];
}

export interface VoiceV23ToolOptions {
  /** Eval harness accessor. */
  getHarness?: () => EvalHarnessV23 | null;
  /** Adaptive buffer accessor. */
  getBuffer?: () => AdaptiveJitterBufferV23 | null;
  /** Frame pacer accessor. */
  getPacer?: () => FramePacerV23 | null;
  /** Endpointing engine accessor. */
  getEndpointing?: () => EndpointingEngineV23 | null;
  /** Interruption policy accessor. */
  getPolicy?: () => InterruptionPolicyV23 | null;
  /** Interruption ledger accessor. */
  getLedger?: () => InterruptionLedgerV23 | null;
  /** Session manager accessor. */
  getManager?: () => RealtimeSessionManagerV23 | null;
  /** Calibration engine accessor. */
  getCalibration?: () => CalibrationEngineV23 | null;
  /** Device profile registry accessor. */
  getDevices?: () => DeviceProfileRegistryV23 | null;
  /** Monitor panel accessor. */
  getPanel?: () => MonitorPanelV23 | null;
  /** Quality report accessor. */
  getQuality?: () => QualityReportV23 | null;
  /** Quality trend accessor. */
  getTrend?: () => QualityTrendV23 | null;
  harnessOptions?: Partial<EvalHarnessV23Options>;
  bufferOptions?: Partial<AdaptiveBufferV23Options>;
  endpointOptions?: Partial<EndpointingV23Options>;
  policyOptions?: Partial<InterruptionV23Options>;
  managerOptions?: Partial<SessionManagerV23Options>;
  calibrationOptions?: Partial<CalibrationV23Options>;
  panelOptions?: Partial<VoiceV23MonitorPanelOptions>;
}

const EVAL_ACTIONS = ['pair', 'corpus', 'latency', 'mos', 'mos-calibrate', 'baseline', 'report', 'markdown'] as const;
const STREAM_ACTIONS = ['push', 'pull', 'ready', 'stats', 'recommend', 'pace', 'reset'] as const;
const ENDPOINT_ACTIONS = ['feed-speech', 'feed-energy', 'trace', 'stats', 'reset', 'set-noise-floor'] as const;
const INTERRUPT_ACTIONS = ['decide', 'rollback', 'strategy', 'record', 'ledger', 'mark-false-positive'] as const;
const SESSION_ACTIONS = ['open', 'feed-final', 'disconnect', 'attempt', 'handover', 'close', 'status', 'list'] as const;
const CALIBRATE_ACTIONS = ['calibrate', 'classify', 'device-list', 'device-get', 'device-add', 'device-update', 'device-remove', 'device-switch', 'device-match', 'device-apply', 'device-stats'] as const;
const MONITOR_ACTIONS = ['snapshot', 'markdown', 'quality', 'trend'] as const;

function isAction(list: readonly string[], v: string): boolean {
  return (list as readonly string[]).includes(v);
}

export function createVoiceV23Tools(opts: VoiceV23ToolOptions = {}): Tool[] {
  const defaultHarness = new EvalHarnessV23(opts.harnessOptions);
  const defaultBuffer = new AdaptiveJitterBufferV23(opts.bufferOptions);
  const defaultPacer = new FramePacerV23();
  const defaultEndpointing = new EndpointingEngineV23(opts.endpointOptions);
  const defaultPolicy = new InterruptionPolicyV23(opts.policyOptions);
  const defaultLedger = new InterruptionLedgerV23();
  const defaultManager = new RealtimeSessionManagerV23(opts.managerOptions);
  const defaultCalibration = new CalibrationEngineV23(opts.calibrationOptions);
  const defaultDevices = new DeviceProfileRegistryV23();
  const defaultPanel = new MonitorPanelV23(opts.panelOptions);
  const defaultQuality = createQualityReportV23();
  const defaultTrend = createQualityTrendV23();
  let lastCalibration: VoiceV23CalibrationResult | null = null;
  const needHarness = (): EvalHarnessV23 => opts.getHarness?.() ?? defaultHarness;
  const needBuffer = (): AdaptiveJitterBufferV23 => opts.getBuffer?.() ?? defaultBuffer;
  const needPacer = (): FramePacerV23 => opts.getPacer?.() ?? defaultPacer;
  const needEndpointing = (): EndpointingEngineV23 => opts.getEndpointing?.() ?? defaultEndpointing;
  const needPolicy = (): InterruptionPolicyV23 => opts.getPolicy?.() ?? defaultPolicy;
  const needLedger = (): InterruptionLedgerV23 => opts.getLedger?.() ?? defaultLedger;
  const needManager = (): RealtimeSessionManagerV23 => opts.getManager?.() ?? defaultManager;
  const needCalibration = (): CalibrationEngineV23 => opts.getCalibration?.() ?? defaultCalibration;
  const needDevices = (): DeviceProfileRegistryV23 => opts.getDevices?.() ?? defaultDevices;
  const needPanel = (): MonitorPanelV23 => opts.getPanel?.() ?? defaultPanel;

  const evalTool: Tool = {
    definition: toolDef(
      'voice_v23_eval',
      'Voice v23 eval harness (local action): score one transcript pair (WER), run the transcript/latency/MOS suites over the expanded corpus, calibrate the MOS-proxy against labelled cases, compare a v22 baseline against a v23 run, or render the full report/markdown. All offline, deterministic, no audio.',
      {
        action: { type: 'string', description: 'pair, corpus, latency, mos, mos-calibrate, baseline, report or markdown.' },
        reference: { type: 'string', description: 'Reference transcript (pair).' },
        hypothesis: { type: 'string', description: 'Hypothesis transcript (pair).' },
        werCeiling: { type: 'number', description: 'WER ceiling for the pair (pair, optional).' },
        baselineJson: { type: 'string', description: 'Baseline (v22) as JSON {version, meanWer, p95LatencyMs, meanMos, bargeInLatencyMs, evaluatedAtMs, pairs} (baseline).' },
        currentJson: { type: 'string', description: 'Current (v23) run as JSON, same shape as baselineJson (baseline).' },
        atMs: { type: 'number', description: 'Virtual clock in ms (default 0).' },
      },
      ['action'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        if (!isAction(EVAL_ACTIONS, action)) return errorResult(`Unknown action "${action}" (${EVAL_ACTIONS.join(', ')})`);
        const harness = needHarness();
        if (action === 'pair') {
          const reference = getStringArg(args, 'reference');
          const hypothesis = getStringArg(args, 'hypothesis');
          const ceiling = getOptionalNumberArg(args, 'werCeiling') ?? 1;
          const pair: VoiceV23EvalPair = { id: 'tool-pair', locale: 'other', condition: 'clean', reference, hypothesis, werCeiling: ceiling };
          return JSON.stringify({ ok: true, ...harness.runPair(pair) });
        }
        if (action === 'corpus') {
          return JSON.stringify({ ok: true, ...harness.runTranscriptCorpus() });
        }
        if (action === 'latency') {
          return JSON.stringify({ ok: true, ...aggregateLatencyV23(EVAL_CORPUS_V23_LATENCY, harness.options().latencyBudgetMs) });
        }
        if (action === 'mos') {
          const scores = EVAL_CORPUS_V23_MOS.map((s) => ({ labelledMos: s.labelledMos, ...mosProxyV23(s.features) }));
          return JSON.stringify({ ok: true, ...harness.runMosSuite(), scores });
        }
        if (action === 'mos-calibrate') {
          const samples: VoiceV23MosSample[] = [...EVAL_CORPUS_V23_MOS];
          return JSON.stringify({ ok: true, ...calibrateMosV23(samples) });
        }
        if (action === 'baseline') {
          const baselineRaw = parseJsonArg(getOptionalStringArg(args, 'baselineJson'), 'baselineJson');
          const currentRaw = parseJsonArg(getOptionalStringArg(args, 'currentJson'), 'currentJson');
          if (typeof baselineRaw !== 'object' || baselineRaw === null) return errorResult('baselineJson must be a JSON object');
          if (typeof currentRaw !== 'object' || currentRaw === null) return errorResult('currentJson must be a JSON object');
          const delta = compareWithBaselineV23(baselineRaw as VoiceV23Baseline, currentRaw as VoiceV23Baseline, harness.options());
          return JSON.stringify({ ok: true, ...delta });
        }
        const atMs = getOptionalNumberArg(args, 'atMs') ?? 0;
        const report = harness.runAll(atMs);
        if (action === 'markdown') {
          return JSON.stringify({ ok: true, markdown: evalHarnessV23Markdown(report), report });
        }
        return JSON.stringify({ ok: true, ...report });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const streamTool: Tool = {
    definition: toolDef(
      'voice_v23_stream',
      'Adaptive realtime streaming v2 (local action): push a synthetic 20ms frame into the adaptive jitter buffer, pull the next frame for playout, check playout readiness, read buffer stats, recommend a buffer target from jitter/loss, or schedule a playout slot with the frame pacer. No audio device is touched.',
      {
        action: { type: 'string', description: 'push, pull, ready, stats, recommend, pace or reset.' },
        seq: { type: 'number', description: 'Frame sequence number (push / pace).' },
        atMs: { type: 'number', description: 'Virtual clock in ms (default 0).' },
        energy: { type: 'number', description: 'Frame speech energy 0..1 (push, optional).' },
        jitterP95Ms: { type: 'number', description: 'Measured jitter p95, ms (recommend).' },
        lossPct: { type: 'number', description: 'Measured frame loss, percent (recommend).' },
      },
      ['action'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        if (!isAction(STREAM_ACTIONS, action)) return errorResult(`Unknown action "${action}" (${STREAM_ACTIONS.join(', ')})`);
        const buffer = needBuffer();
        const pacer = needPacer();
        const atMs = getOptionalNumberArg(args, 'atMs') ?? 0;
        if (action === 'stats') return JSON.stringify({ ok: true, ...buffer.stats(), pacer: pacer.stats() });
        if (action === 'reset') {
          buffer.reset();
          pacer.reset();
          return JSON.stringify({ ok: true, reset: true });
        }
        if (action === 'ready') return JSON.stringify({ ok: true, ready: buffer.readyToPlay(), ...buffer.stats() });
        if (action === 'recommend') {
          const jitterP95Ms = getOptionalNumberArg(args, 'jitterP95Ms') ?? 0;
          const lossPct = getOptionalNumberArg(args, 'lossPct') ?? 0;
          return JSON.stringify({ ok: true, ...recommendBufferTargetV23(jitterP95Ms, lossPct, buffer.options()) });
        }
        if (action === 'pace') {
          const seq = getOptionalNumberArg(args, 'seq') ?? 0;
          return JSON.stringify({ ok: true, ...pacer.schedule(seq, atMs), stats: pacer.stats() });
        }
        if (action === 'pull') {
          const frame = buffer.pull(atMs);
          return JSON.stringify({ ok: true, frame: frame === null ? null : { seq: frame.seq, atMs: frame.atMs, energy: frame.energy ?? null }, ...buffer.stats() });
        }
        // push
        const seq = getOptionalNumberArg(args, 'seq');
        if (seq === undefined) return errorResult('Missing required argument: "seq"');
        const energy = getOptionalNumberArg(args, 'energy') ?? 0;
        const accepted = buffer.push({ seq, atMs, samples: new Int16Array(320), energy });
        return JSON.stringify({ ok: true, accepted, ...buffer.stats() });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const endpointTool: Tool = {
    definition: toolDef(
      'voice_v23_endpoint',
      'Endpointing v2 (local action): feed one speech/energy frame, run a whole boolean speech/silence trace, set the noise floor (adaptive threshold), or read endpointing stats. Frames are caller-supplied booleans/numbers, no mic.',
      {
        action: { type: 'string', description: 'feed-speech, feed-energy, trace, stats, reset or set-noise-floor.' },
        speech: { type: 'string', description: '"true" when the frame is speech (feed-speech).' },
        energy: { type: 'number', description: 'Frame energy 0..1 (feed-energy).' },
        framesJson: { type: 'string', description: 'Boolean speech/silence trace as JSON (trace).' },
        noiseFloor: { type: 'number', description: 'Measured noise floor RMS 0..1 (set-noise-floor).' },
        atMs: { type: 'number', description: 'Virtual clock in ms (default 0).' },
      },
      ['action'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        if (!isAction(ENDPOINT_ACTIONS, action)) return errorResult(`Unknown action "${action}" (${ENDPOINT_ACTIONS.join(', ')})`);
        const engine = needEndpointing();
        const atMs = getOptionalNumberArg(args, 'atMs') ?? 0;
        if (action === 'stats') return JSON.stringify({ ok: true, ...engine.stats(), events: engine.eventsHistory() });
        if (action === 'reset') {
          engine.reset();
          return JSON.stringify({ ok: true, reset: true });
        }
        if (action === 'set-noise-floor') {
          const floor = getOptionalNumberArg(args, 'noiseFloor');
          if (floor === undefined) return errorResult('Missing required argument: "noiseFloor"');
          return JSON.stringify({ ok: true, ...engine.setNoiseFloor(floor), stats: engine.stats() });
        }
        if (action === 'trace') {
          const raw = parseJsonArg(getOptionalStringArg(args, 'framesJson'), 'framesJson');
          if (!Array.isArray(raw) || !raw.every((v) => typeof v === 'boolean')) {
            return errorResult('framesJson must be a JSON array of booleans');
          }
          const endFrame = engine.runTrace(raw as boolean[], atMs);
          return JSON.stringify({ ok: true, endFrame, ...engine.stats(), events: engine.eventsHistory() });
        }
        if (action === 'feed-speech') {
          const speech = getOptionalBooleanArg(args, 'speech');
          if (speech === undefined) return errorResult('Missing required argument: "speech"');
          const events = engine.feedSpeech(speech, atMs);
          return JSON.stringify({ ok: true, events, ...engine.stats() });
        }
        // feed-energy
        const energy = getOptionalNumberArg(args, 'energy');
        if (energy === undefined) return errorResult('Missing required argument: "energy"');
        const events = engine.feedEnergy(energy, atMs);
        return JSON.stringify({ ok: true, events, ...engine.stats() });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const interruptTool: Tool = {
    definition: toolDef(
      'voice_v23_interrupt',
      'Interruption handling v2 (local action): decide a barge-in burst (grace window, backchannel rule, v22 score), roll a cut reply back to a word boundary, pick a resume strategy (resume/drop/summarise/rephrase), or read the interruption ledger.',
      {
        action: { type: 'string', description: 'decide, rollback, strategy, record, ledger or mark-false-positive.' },
        atMs: { type: 'number', description: 'Virtual clock in ms (default 0).' },
        atMsIntoReply: { type: 'number', description: 'ms into the agent reply when the burst arrived (decide).' },
        energy: { type: 'number', description: 'Burst energy 0..1 (decide).' },
        sustainMs: { type: 'number', description: 'Burst sustain in ms (decide).' },
        wordsJson: { type: 'string', description: 'Burst words as a JSON array (decide / strategy).' },
        echo: { type: 'string', description: '"true" when the burst is known agent echo (decide, optional).' },
        agentSpeaking: { type: 'string', description: '"true" when the agent is speaking (decide, optional, default true).' },
        replyText: { type: 'string', description: 'Agent reply text (rollback / strategy).' },
        spokenChars: { type: 'number', description: 'Chars already spoken (rollback).' },
        stopLatencyMs: { type: 'number', description: 'ms from burst to agent silence (record, optional).' },
        recordId: { type: 'string', description: 'Ledger record id (mark-false-positive).' },
      },
      ['action'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        if (!isAction(INTERRUPT_ACTIONS, action)) return errorResult(`Unknown action "${action}" (${INTERRUPT_ACTIONS.join(', ')})`);
        const policy = needPolicy();
        const ledger = needLedger();
        const atMs = getOptionalNumberArg(args, 'atMs') ?? 0;
        if (action === 'ledger') {
          return JSON.stringify({ ok: true, ...ledger.stats(), records: ledger.history() });
        }
        if (action === 'mark-false-positive') {
          const id = getStringArg(args, 'recordId');
          const marked = ledger.markFalsePositive(id);
          if (!marked) return errorResult(`No ledger record "${id}".`);
          return JSON.stringify({ ok: true, marked: true, ...ledger.stats() });
        }
        if (action === 'rollback') {
          const replyText = getStringArg(args, 'replyText');
          const spokenChars = getOptionalNumberArg(args, 'spokenChars') ?? 0;
          const cut = splitReplyAtCutV22(replyText, spokenChars);
          return JSON.stringify({ ok: true, cut, rollback: rollbackForCutV23(replyText, spokenChars) });
        }
        if (action === 'strategy') {
          const replyText = getStringArg(args, 'replyText');
          const spokenChars = getOptionalNumberArg(args, 'spokenChars') ?? 0;
          const cut = splitReplyAtCutV22(replyText, spokenChars);
          const words = parseStringArray(getOptionalStringArg(args, 'wordsJson'), 'wordsJson');
          return JSON.stringify({ ok: true, cut, strategy: strategyForCutV23(cut, words, policy.options()) });
        }
        if (action === 'record') {
          const decision = policy.decide({
            atMs,
            atMsIntoReply: getOptionalNumberArg(args, 'atMsIntoReply') ?? 0,
            energy: getOptionalNumberArg(args, 'energy') ?? 0,
            sustainMs: getOptionalNumberArg(args, 'sustainMs') ?? 0,
            words: parseStringArray(getOptionalStringArg(args, 'wordsJson'), 'wordsJson'),
            echo: getOptionalBooleanArg(args, 'echo') ?? false,
            agentSpeaking: getOptionalBooleanArg(args, 'agentSpeaking') ?? true,
          });
          const record = ledger.record(decision, atMs, getOptionalNumberArg(args, 'stopLatencyMs') ?? 0);
          return JSON.stringify({ ok: true, decision, record });
        }
        // decide
        const decision = policy.decide({
          atMs,
          atMsIntoReply: getOptionalNumberArg(args, 'atMsIntoReply') ?? 0,
          energy: getOptionalNumberArg(args, 'energy') ?? 0,
          sustainMs: getOptionalNumberArg(args, 'sustainMs') ?? 0,
          words: parseStringArray(getOptionalStringArg(args, 'wordsJson'), 'wordsJson'),
          echo: getOptionalBooleanArg(args, 'echo') ?? false,
          agentSpeaking: getOptionalBooleanArg(args, 'agentSpeaking') ?? true,
        });
        return JSON.stringify({ ok: true, ...decision });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const sessionTool: Tool = {
    definition: toolDef(
      'voice_v23_session',
      'Realtime session manager v2 (local action): open a managed v22 session, feed a final transcript, simulate a disconnect and schedule reconnect attempts, report an attempt outcome (success resumes from checkpoint + refreshes the token), hand a session over to a new id, close, or read status/list. Mock transport, virtual clock.',
      {
        action: { type: 'string', description: 'open, feed-final, disconnect, attempt, handover, close, status or list.' },
        sessionId: { type: 'string', description: 'Session id.' },
        toId: { type: 'string', description: 'New session id (handover).' },
        text: { type: 'string', description: 'Final transcript text (feed-final).' },
        outcome: { type: 'string', description: '"success" or "failure" (attempt).' },
        atMs: { type: 'number', description: 'Virtual clock in ms (default 0).' },
        message: { type: 'string', description: 'Disconnect message (disconnect, optional).' },
      },
      ['action'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        if (!isAction(SESSION_ACTIONS, action)) return errorResult(`Unknown action "${action}" (${SESSION_ACTIONS.join(', ')})`);
        const manager = needManager();
        const atMs = getOptionalNumberArg(args, 'atMs') ?? 0;
        if (action === 'list') {
          return JSON.stringify({ ok: true, ids: manager.ids(), ...manager.stats() });
        }
        const sessionId = getStringArg(args, 'sessionId');
        if (action === 'open') {
          const session = manager.open(sessionId, {}, atMs);
          return JSON.stringify({ ok: true, sessionId, phase: manager.phaseOf(sessionId), state: session.state() });
        }
        if (action === 'status') {
          const session = manager.get(sessionId);
          if (session === null) return errorResult(`No session "${sessionId}".`);
          return JSON.stringify({
            ok: true,
            managed: manager.managedState(sessionId),
            durability: manager.durabilityReport(sessionId, atMs),
            stats: session.stats(),
          });
        }
        if (action === 'feed-final') {
          const session = manager.get(sessionId);
          if (session === null) return errorResult(`No session "${sessionId}".`);
          const reply = await session.feedFinal(getStringArg(args, 'text'), atMs);
          return JSON.stringify({ ok: true, reply, state: session.state(), phase: session.phase() });
        }
        if (action === 'disconnect') {
          const delayMs = manager.disconnect(sessionId, atMs, getOptionalStringArg(args, 'message'));
          return JSON.stringify({ ok: true, sessionId, phase: manager.phaseOf(sessionId), nextAttemptInMs: delayMs });
        }
        if (action === 'attempt') {
          const outcome = getOptionalStringArg(args, 'outcome') ?? 'success';
          if (outcome !== 'success' && outcome !== 'failure') return errorResult(`outcome must be "success" or "failure", got "${outcome}"`);
          const result = await manager.reportAttempt(sessionId, atMs, outcome);
          return JSON.stringify({ ok: true, sessionId, outcome, ...result });
        }
        if (action === 'handover') {
          const toId = getStringArg(args, 'toId');
          const session = await manager.handover(sessionId, toId, atMs);
          return JSON.stringify({ ok: true, from: sessionId, to: toId, phase: manager.phaseOf(toId), state: session.state() });
        }
        // close
        manager.close(sessionId, atMs);
        return JSON.stringify({ ok: true, sessionId, phase: manager.phaseOf(sessionId) });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const calibrateTool: Tool = {
    definition: toolDef(
      'voice_v23_calibrate',
      'Automatic calibration + per-device profiles (local action): fit gain/noise-threshold/environment from noise + speech RMS samples, classify a room from a noise floor, or manage device profiles (list/get/add/update/remove/switch/match/apply-calibration/stats). No mic is opened; samples are caller-supplied numbers.',
      {
        action: { type: 'string', description: 'calibrate, classify, device-list, device-get, device-add, device-update, device-remove, device-switch, device-match, device-apply or device-stats.' },
        noiseJson: { type: 'string', description: 'Noise RMS samples as a JSON array (calibrate).' },
        speechJson: { type: 'string', description: 'Speech RMS samples as a JSON array (calibrate).' },
        noiseFloor: { type: 'number', description: 'Noise floor RMS 0..1 (classify).' },
        profileId: { type: 'string', description: 'Device profile id (device-*).' },
        profileJson: { type: 'string', description: 'Device profile as JSON (device-add / device-update).' },
        kind: { type: 'string', description: 'Device kind (device-match): laptop, desktop, phone, headset, speaker, car or unknown.' },
        echoCancellation: { type: 'string', description: '"true" when the device cancels echo (device-match, optional).' },
        sampleRate: { type: 'number', description: 'Capture sample rate Hz (device-match, optional).' },
        userId: { type: 'string', description: 'User id (device-switch reads the per-user default when set, optional).' },
      },
      ['action'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        if (!isAction(CALIBRATE_ACTIONS, action)) return errorResult(`Unknown action "${action}" (${CALIBRATE_ACTIONS.join(', ')})`);
        const engine = needCalibration();
        const devices = needDevices();
        if (action === 'calibrate') {
          const noise = parseNumberArray(getOptionalStringArg(args, 'noiseJson'), 'noiseJson');
          const speech = parseNumberArray(getOptionalStringArg(args, 'speechJson'), 'speechJson');
          lastCalibration = engine.calibrate({ noiseSamples: noise, speechSamples: speech });
          return JSON.stringify({ ok: true, ...lastCalibration });
        }
        if (action === 'classify') {
          const floor = getOptionalNumberArg(args, 'noiseFloor');
          if (floor === undefined) return errorResult('Missing required argument: "noiseFloor"');
          return JSON.stringify({ ok: true, noiseFloor: floor, environment: classifyEnvironmentV23(floor) });
        }
        if (action === 'device-list') {
          return JSON.stringify({ ok: true, current: devices.current(), profiles: devices.list(), stats: devices.stats() });
        }
        if (action === 'device-stats') {
          return JSON.stringify({ ok: true, ...devices.stats(), summary: devices.summary(), current: devices.current() });
        }
        if (action === 'device-match') {
          const kind = getStringArg(args, 'kind');
          const valid = ['laptop', 'desktop', 'phone', 'headset', 'speaker', 'car', 'unknown'] as const;
          if (!(valid as readonly string[]).includes(kind)) return errorResult(`Unknown kind "${kind}"`);
          const matched = devices.match({
            kind: kind as (typeof valid)[number],
            echoCancellation: getOptionalBooleanArg(args, 'echoCancellation'),
            sampleRate: getOptionalNumberArg(args, 'sampleRate'),
          });
          return JSON.stringify({ ok: true, ...matched });
        }
        if (action === 'device-apply') {
          if (lastCalibration === null) return errorResult('No calibration run yet in this tool instance — run "calibrate" first.');
          const errors = devices.applyCalibration(getStringArg(args, 'profileId'), lastCalibration);
          if (errors.length > 0) return errorResult(errors.join('; '));
          return JSON.stringify({ ok: true, profile: devices.get(getStringArg(args, 'profileId')), calibration: lastCalibration });
        }
        if (action === 'device-get') {
          const profile = devices.get(getStringArg(args, 'profileId'));
          if (profile === null) return errorResult(`No device profile "${getStringArg(args, 'profileId')}".`);
          return JSON.stringify({ ok: true, profile });
        }
        if (action === 'device-switch') {
          const errors = devices.switchTo(getStringArg(args, 'profileId'));
          if (errors.length > 0) return errorResult(errors.join('; '));
          return JSON.stringify({ ok: true, current: devices.current(), profile: devices.currentProfile() });
        }
        if (action === 'device-remove') {
          const errors = devices.remove(getStringArg(args, 'profileId'));
          if (errors.length > 0) return errorResult(errors.join('; '));
          return JSON.stringify({ ok: true, removed: true, profiles: devices.list() });
        }
        // device-add / device-update
        const profileRaw = parseJsonArg(getOptionalStringArg(args, 'profileJson'), 'profileJson');
        if (typeof profileRaw !== 'object' || profileRaw === null) return errorResult('profileJson must be a JSON object');
        if (action === 'device-add') {
          const errors = devices.add(profileRaw as VoiceV23DeviceProfile);
          if (errors.length > 0) return errorResult(errors.join('; '));
          return JSON.stringify({ ok: true, profile: devices.get((profileRaw as VoiceV23DeviceProfile).id) });
        }
        const errors = devices.update(getStringArg(args, 'profileId'), profileRaw as Partial<VoiceV23DeviceProfile>);
        if (errors.length > 0) return errorResult(errors.join('; '));
        return JSON.stringify({ ok: true, profile: devices.get(getStringArg(args, 'profileId')) });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const monitorTool: Tool = {
    definition: toolDef(
      'voice_v23_monitor',
      'Voice v23 monitor panel (local action): snapshot of eval (WER/latency/MOS-proxy), streaming (buffer target/jitter/underruns), interruptions, managed sessions and calibration — its markdown rendering — the 0..100 voice quality report (grade + recommendations) — or the quality trend (records the current score, then reports mean / slope / weakest sub-score).',
      {
        action: { type: 'string', description: 'snapshot, markdown, quality or trend.' },
        atMs: { type: 'number', description: 'Virtual clock in ms (default 0).' },
      },
      ['action'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        if (!isAction(MONITOR_ACTIONS, action)) return errorResult(`Unknown action "${action}" (${MONITOR_ACTIONS.join(', ')})`);
        const atMs = getOptionalNumberArg(args, 'atMs') ?? 0;
        const panel = needPanel();
        const harness = needHarness();
        const buffer = needBuffer();
        const ledger = needLedger();
        const manager = needManager();
        panel.setEval(harness.runAll(atMs), atMs);
        panel.setStreaming(buffer.stats(), atMs);
        panel.setInterruptions(ledger.stats(), atMs);
        panel.setSessions(manager.stats(), atMs);
        if (lastCalibration !== null) panel.setCalibration(lastCalibration, atMs);
        if (action === 'quality') {
          const quality: QualityReportV23 = opts.getQuality?.() ?? defaultQuality;
          quality.setEval(harness.runAll(atMs), atMs);
          quality.setStreaming(buffer.stats(), atMs);
          quality.setInterruptions(ledger.stats(), atMs);
          quality.setSessions(manager.stats(), atMs);
          if (lastCalibration !== null) quality.setCalibration(lastCalibration, atMs);
          const score = quality.score();
          return JSON.stringify({ ok: true, ...score, markdown: quality.markdown(atMs) });
        }
        if (action === 'trend') {
          const quality: QualityReportV23 = opts.getQuality?.() ?? defaultQuality;
          quality.setEval(harness.runAll(atMs), atMs);
          quality.setStreaming(buffer.stats(), atMs);
          quality.setInterruptions(ledger.stats(), atMs);
          quality.setSessions(manager.stats(), atMs);
          if (lastCalibration !== null) quality.setCalibration(lastCalibration, atMs);
          const trend: QualityTrendV23 = opts.getTrend?.() ?? defaultTrend;
          const point = trend.record(quality.score(), atMs);
          return JSON.stringify({
            ok: true,
            point,
            count: trend.count(),
            meanTotal: trend.meanTotal(),
            trend: trend.trend(),
            slopePerMinute: trend.slopePerMinute(),
            worstSubscore: trend.worstSubscore(),
            summary: trend.summary(),
            markdown: trend.markdown(),
          });
        }
        if (action === 'markdown') {
          return JSON.stringify({ ok: true, markdown: panel.markdown(atMs), snapshot: panel.snapshot(atMs) });
        }
        return JSON.stringify({ ok: true, ...panel.snapshot(atMs) });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  return [evalTool, streamTool, endpointTool, interruptTool, sessionTool, calibrateTool, monitorTool];
}

/** Unbound placeholder (own default instances — mock sessions only). */
export const VOICE_V23_TOOLS: Tool[] = createVoiceV23Tools();

export const VOICE_V23_TOOL_NAMES = [
  'voice_v23_eval',
  'voice_v23_stream',
  'voice_v23_endpoint',
  'voice_v23_interrupt',
  'voice_v23_session',
  'voice_v23_calibrate',
  'voice_v23_monitor',
] as const;

export function isVoiceV23ToolName(name: string): name is (typeof VOICE_V23_TOOL_NAMES)[number] {
  return (VOICE_V23_TOOL_NAMES as readonly string[]).includes(name);
}

/** Corpus sizes, re-exported for the tools layer. */
export { EVAL_CORPUS_V23_TRANSCRIPTS, EVAL_CORPUS_V23_LATENCY, EVAL_CORPUS_V23_MOS };
