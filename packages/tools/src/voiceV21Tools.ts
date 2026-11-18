/**
 * Voice v21 tools for @open-bot/tools (v1.34, Đội T5).
 *
 * The agent drives the voice v21 realtime session by tool call:
 *  - voice_v21_session      — start / feed-final / feed-partial /
 *    status a realtime session (mock STT/model/TTS, virtual clock)
 *  - voice_v21_tool_call    — parse a transcript into a voice tool
 *    intent and request the call (read tools run at once, the rest
 *    wait for a spoken confirmation)
 *  - voice_v21_confirm      — confirm / decline / status the pending
 *    voice tool call
 *  - voice_v21_turn         — turn-taking state machine: event /
 *    state / stats / overlap classification
 *  - voice_v21_barge_in     — score a barge-in burst, cut a reply,
 *    keep the half-heard transcript
 *  - voice_v21_eval         — WER/CER + per-stage latency eval over
 *    the built-in corpus (or caller-supplied pairs)
 *  - voice_v21_tts_cache    — speak / synthesise through the
 *    streaming TTS cache, stats / prune / clear
 *  - voice_v21_monitor      — realtime monitor panel snapshot /
 *    markdown (turn, live transcript, tool call, latency, cache)
 *
 * SAFETY: everything here is local — transcripts are caller
 * supplied text (no mic), tool calls run through the mock
 * executor unless the host binds a real one, TTS is synthetic
 * PCM, eval scores come from the offline corpus, and
 * side-effecting voice tools need a spoken confirmation (or are
 * denied by policy) before they run. No provider is dialled, no
 * key is read or stored, no mic or sound card is touched.
 *
 * Factory:
 *   createVoiceV21Tools(opts) -> Tool[]   (bound, usable)
 *   VOICE_V21_TOOLS                       (unbound placeholder, own
 *   default instances — mock sessions only)
 */
import type { Tool } from '@open-bot/core';
import {
  VoiceSessionV21,
  VoiceToolCallEngineV21,
  TurnTakingMachineV21,
  BargeInEngineV21,
  VoiceEvalV21,
  TtsCacheV21,
  MonitorPanelV21,
  parseVoiceIntentV21,
  defaultVoiceToolDescriptorsV21,
  splitReplyAtCutV21,
  isBackchannelBurstV21,
  scorePairV21,
  aggregateEvalV21,
  evalReportMarkdownV21,
  pairScoreSummaryV21,
  defaultVoiceEvalV21Options,
  VOICE_V21_EVAL_SAMPLES,
  defaultVoiceToolPolicyV21,
  decideVoiceToolPolicyV21,
  ttsCacheKeyV21,
  splitTtsTextV21,
  type VoiceV21ToolCallEngineOptions,
  type VoiceV21ToolPolicy,
  type VoiceV21TurnTakingOptions,
  type VoiceV21BargeInOptions,
  type VoiceV21EvalOptions,
  type VoiceV21TtsCacheOptions,
  type VoiceV21SessionOptions,
  type VoiceV21MonitorPanelOptions,
  type VoiceV21LatencyStage,
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

export interface VoiceV21ToolOptions {
  /** Session accessor (the host binds its session). */
  getSession?: () => VoiceSessionV21 | null;
  /** Tool-call engine accessor. */
  getToolCallEngine?: () => VoiceToolCallEngineV21 | null;
  /** Turn-taking machine accessor. */
  getTurnMachine?: () => TurnTakingMachineV21 | null;
  /** Barge-in engine accessor. */
  getBargeInEngine?: () => BargeInEngineV21 | null;
  /** Eval harness accessor. */
  getEval?: () => VoiceEvalV21 | null;
  /** TTS cache accessor. */
  getTtsCache?: () => TtsCacheV21 | null;
  /** Monitor panel accessor. */
  getMonitorPanel?: () => MonitorPanelV21 | null;
  /** Voice tool-call policy for the default engine. */
  policy?: VoiceV21ToolPolicy;
  /** Options for the default tool-call engine. */
  toolCallOptions?: Partial<VoiceV21ToolCallEngineOptions>;
  /** Options for the default turn machine. */
  turnOptions?: Partial<VoiceV21TurnTakingOptions>;
  /** Options for the default barge-in engine. */
  bargeInOptions?: Partial<VoiceV21BargeInOptions>;
  /** Options for the default eval harness. */
  evalOptions?: Partial<VoiceV21EvalOptions>;
  /** Options for the default TTS cache. */
  ttsCacheOptions?: Partial<VoiceV21TtsCacheOptions>;
  /** Options for the default session. */
  sessionOptions?: Partial<VoiceV21SessionOptions>;
  /** Options for the default monitor panel. */
  panelOptions?: Partial<VoiceV21MonitorPanelOptions>;
}

const SESSION_ACTIONS = ['start', 'feed-final', 'feed-partial', 'barge-in', 'status', 'close'] as const;
const CONFIRM_ACTIONS = ['confirm', 'decline', 'status'] as const;
const TURN_ACTIONS = ['state', 'event', 'stats', 'classify-overlap'] as const;
const EVAL_ACTIONS = ['run', 'score-one'] as const;
const TTS_ACTIONS = ['speak', 'stats', 'prune', 'clear', 'key'] as const;
const MONITOR_ACTIONS = ['snapshot', 'markdown'] as const;
const LATENCY_STAGES: VoiceV21LatencyStage[] = ['vad', 'stt', 'intent', 'model', 'tool', 'tts'];

function isSessionAction(v: string): v is (typeof SESSION_ACTIONS)[number] {
  return (SESSION_ACTIONS as readonly string[]).includes(v);
}
function isConfirmAction(v: string): v is (typeof CONFIRM_ACTIONS)[number] {
  return (CONFIRM_ACTIONS as readonly string[]).includes(v);
}
function isTurnAction(v: string): v is (typeof TURN_ACTIONS)[number] {
  return (TURN_ACTIONS as readonly string[]).includes(v);
}
function isEvalAction(v: string): v is (typeof EVAL_ACTIONS)[number] {
  return (EVAL_ACTIONS as readonly string[]).includes(v);
}
function isTtsAction(v: string): v is (typeof TTS_ACTIONS)[number] {
  return (TTS_ACTIONS as readonly string[]).includes(v);
}
function isMonitorAction(v: string): v is (typeof MONITOR_ACTIONS)[number] {
  return (MONITOR_ACTIONS as readonly string[]).includes(v);
}

export function createVoiceV21Tools(opts: VoiceV21ToolOptions = {}): Tool[] {
  const policy = opts.policy ?? defaultVoiceToolPolicyV21();
  const defaultSession = new VoiceSessionV21('default', {
    ...(opts.sessionOptions ?? {}),
    toolCall: { policy, ...(opts.toolCallOptions ?? {}) },
  });
  const defaultEngine = new VoiceToolCallEngineV21('default', { policy, ...(opts.toolCallOptions ?? {}) });
  const defaultTurns = new TurnTakingMachineV21('default', opts.turnOptions);
  const defaultBargeIn = new BargeInEngineV21('default', opts.bargeInOptions);
  const defaultEval = new VoiceEvalV21(opts.evalOptions);
  const defaultTts = new TtsCacheV21('default', opts.ttsCacheOptions);
  const defaultPanel = new MonitorPanelV21('default', opts.panelOptions);
  const needSession = (): VoiceSessionV21 => opts.getSession?.() ?? defaultSession;
  const needEngine = (): VoiceToolCallEngineV21 => opts.getToolCallEngine?.() ?? defaultEngine;
  const needTurns = (): TurnTakingMachineV21 => opts.getTurnMachine?.() ?? defaultTurns;
  const needBargeIn = (): BargeInEngineV21 => opts.getBargeInEngine?.() ?? defaultBargeIn;
  const needEval = (): VoiceEvalV21 => opts.getEval?.() ?? defaultEval;
  const needTts = (): TtsCacheV21 => opts.getTtsCache?.() ?? defaultTts;
  const needPanel = (): MonitorPanelV21 => opts.getMonitorPanel?.() ?? defaultPanel;

  const sessionTool: Tool = {
    definition: toolDef(
      'voice_v21_session',
      'Drive a voice v21 realtime session (local action): start, feed a final/partial transcript, inject a barge-in burst, or read status. STT/model/TTS are mock (scripted), the clock is virtual, no mic or network.',
      {
        action: { type: 'string', description: 'start, feed-final, feed-partial, barge-in, status or close.' },
        sessionId: { type: 'string', description: 'Session id (default session when omitted).' },
        text: { type: 'string', description: 'Transcript text (feed-final / feed-partial).' },
        atMs: { type: 'number', description: 'Virtual clock in ms (default: session clock).' },
        energy: { type: 'number', description: 'Barge-in burst energy 0..1 (barge-in).' },
        sustainMs: { type: 'number', description: 'Barge-in burst sustain in ms (barge-in).' },
        wordsJson: { type: 'string', description: 'Barge-in burst words as a JSON array (barge-in).' },
      },
      ['action'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        if (!isSessionAction(action)) return errorResult(`Unknown action "${action}" (${SESSION_ACTIONS.join(', ')})`);
        const session = needSession();
        const atMs = getOptionalNumberArg(args, 'atMs') ?? session.nowMs();
        if (action === 'start') {
          session.start(atMs);
          return JSON.stringify({ ok: true, action, sessionId: session.sessionId, state: session.state(), atMs });
        }
        if (action === 'status') {
          return JSON.stringify({ ok: true, sessionId: session.sessionId, ...session.stats(), state: session.state() });
        }
        if (action === 'close') {
          session.close(atMs);
          return JSON.stringify({ ok: true, action, sessionId: session.sessionId });
        }
        if (action === 'feed-partial') {
          const text = getStringArg(args, 'text');
          await session.feedPartial(text, atMs);
          return JSON.stringify({ ok: true, action, state: session.state(), livePartial: text });
        }
        if (action === 'feed-final') {
          const text = getStringArg(args, 'text');
          const record = await session.feedFinal(text, atMs);
          return JSON.stringify({
            ok: true,
            action,
            state: session.state(),
            toolCall: record === null ? null : { id: record.id, toolName: record.toolName, status: record.status, resultText: record.resultText },
          });
        }
        // barge-in
        const energy = getOptionalNumberArg(args, 'energy') ?? 0.8;
        const sustainMs = getOptionalNumberArg(args, 'sustainMs') ?? 500;
        const wordsRaw = parseJsonArg(getOptionalStringArg(args, 'wordsJson'), 'wordsJson');
        const words = Array.isArray(wordsRaw) ? wordsRaw.filter((w): w is string => typeof w === 'string') : [];
        const { decision, cut } = await session.feedBargeIn({ atMs, energy, sustainMs, words }, atMs);
        return JSON.stringify({ ok: true, action, decision, cut, state: session.state() });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const toolCallTool: Tool = {
    definition: toolDef(
      'voice_v21_tool_call',
      'Parse a voice transcript into a tool intent and request the call (local action): read tools run at once, side-effecting tools park in pending-confirmation until voice_v21_confirm confirms them, denied tools never run.',
      {
        transcript: { type: 'string', description: 'Final transcript text, e.g. "search the web for cats".' },
        sessionId: { type: 'string', description: 'Session id (for the record).' },
        atMs: { type: 'number', description: 'Virtual clock in ms (default 0).' },
        toolName: { type: 'string', description: 'Force a tool name instead of parsing the transcript (optional).' },
        argsJson: { type: 'string', description: 'Arguments as JSON (used with toolName, optional).' },
      },
      ['transcript'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const transcript = getStringArg(args, 'transcript');
        const atMs = getOptionalNumberArg(args, 'atMs') ?? 0;
        const engine = needEngine();
        const forcedName = getOptionalStringArg(args, 'toolName');
        const forcedArgsRaw = parseJsonArg(getOptionalStringArg(args, 'argsJson'), 'argsJson');
        const intent = forcedName !== undefined
          ? {
              toolName: forcedName,
              args: (forcedArgsRaw !== undefined && typeof forcedArgsRaw === 'object' && !Array.isArray(forcedArgsRaw)
                ? (forcedArgsRaw as Record<string, unknown>)
                : {}),
              confidence: 1,
              transcript,
            }
          : parseVoiceIntentV21(transcript, defaultVoiceToolDescriptorsV21());
        if (intent.toolName === '') {
          return JSON.stringify({ ok: true, recognised: false, transcript, hint: 'No tool trigger matched; treat as plain conversation.' });
        }
        const record = await engine.request(intent, `tool-${atMs}`, atMs);
        if (record === null) return errorResult('No tool call record was created.');
        return JSON.stringify({
          ok: true,
          recognised: true,
          toolName: record.toolName,
          status: record.status,
          callId: record.id,
          effect: record.effect,
          confirmationRequired: record.confirmationRequired,
          confirmationPrompt: record.status === 'pending-confirmation' ? engine.confirmationPrompt(record) : undefined,
          resultText: record.resultText,
          denialReason: record.denialReason,
        });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const confirmTool: Tool = {
    definition: toolDef(
      'voice_v21_confirm',
      'Answer a pending voice tool call (local action): confirm runs it, decline cancels it, status shows the pending call and policy for a tool.',
      {
        action: { type: 'string', description: 'confirm, decline or status.' },
        callId: { type: 'string', description: 'Tool-call id (confirm / decline).' },
        atMs: { type: 'number', description: 'Virtual clock in ms (default 0).' },
        toolName: { type: 'string', description: 'Tool name to check policy for (status).' },
      },
      ['action'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        if (!isConfirmAction(action)) return errorResult(`Unknown action "${action}" (${CONFIRM_ACTIONS.join(', ')})`);
        const engine = needEngine();
        const atMs = getOptionalNumberArg(args, 'atMs') ?? 0;
        if (action === 'status') {
          const pending = engine.pending(atMs);
          const toolName = getOptionalStringArg(args, 'toolName');
          const descriptor = toolName === undefined ? undefined : engine.descriptorFor(toolName);
          return JSON.stringify({
            ok: true,
            pending: pending === undefined ? null : { id: pending.id, toolName: pending.toolName, status: pending.status, args: pending.args },
            policy: descriptor === undefined ? undefined : decideVoiceToolPolicyV21(descriptor, policy),
            stats: engine.stats(atMs),
          });
        }
        const callId = getStringArg(args, 'callId');
        if (action === 'confirm') {
          const record = await engine.confirm(callId, atMs);
          if (record === null) return errorResult(`No pending confirmation with id "${callId}".`);
          return JSON.stringify({ ok: true, action, callId, toolName: record.toolName, status: record.status, resultText: record.resultText });
        }
        const record = engine.decline(callId, atMs);
        if (record === null) return errorResult(`No pending confirmation with id "${callId}".`);
        return JSON.stringify({ ok: true, action, callId, toolName: record.toolName, status: record.status });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const turnTool: Tool = {
    definition: toolDef(
      'voice_v21_turn',
      'Turn-taking state machine (local action): read the current state/stats, feed one turn event, or classify an overlap duration (backchannel / overlap / barge-in).',
      {
        action: { type: 'string', description: 'state, event, stats or classify-overlap.' },
        event: { type: 'string', description: 'Turn event (event action): user-speech-start, user-speech-end, agent-speak-start, agent-speak-end, barge-in, confirm-requested, confirm-resolved, timeout, reset.' },
        atMs: { type: 'number', description: 'Virtual clock in ms (default 0).' },
        text: { type: 'string', description: 'Turn text (event action, optional).' },
        durationMs: { type: 'number', description: 'Overlap duration in ms (classify-overlap).' },
      },
      ['action'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        if (!isTurnAction(action)) return errorResult(`Unknown action "${action}" (${TURN_ACTIONS.join(', ')})`);
        const machine = needTurns();
        const atMs = getOptionalNumberArg(args, 'atMs') ?? 0;
        if (action === 'state') {
          return JSON.stringify({ ok: true, state: machine.currentState(), msInState: machine.msInState(atMs) });
        }
        if (action === 'stats') {
          return JSON.stringify({ ok: true, ...machine.stats(), summary: machine.summary() });
        }
        if (action === 'classify-overlap') {
          const durationMs = getOptionalNumberArg(args, 'durationMs');
          if (durationMs === undefined) return errorResult('Missing required argument: "durationMs"');
          return JSON.stringify({ ok: true, durationMs, classification: machine.classifyOverlap(durationMs) });
        }
        const event = getStringArg(args, 'event');
        const valid = ['user-speech-start', 'user-speech-end', 'agent-speak-start', 'agent-speak-end', 'barge-in', 'confirm-requested', 'confirm-resolved', 'timeout', 'reset'] as const;
        if (!(valid as readonly string[]).includes(event)) return errorResult(`Unknown event "${event}"`);
        const text = getOptionalStringArg(args, 'text');
        const transition = machine.handle(event as (typeof valid)[number], atMs, text === undefined ? undefined : { text });
        return JSON.stringify({ ok: true, ...transition });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const bargeInTool: Tool = {
    definition: toolDef(
      'voice_v21_barge_in',
      'Barge-in scoring and reply cutting (local action): score a burst of user audio while the agent speaks (ignore / duck / interrupt) and cut a reply at the spoken point, preserving the half-heard transcript.',
      {
        energy: { type: 'number', description: 'Burst energy 0..1.' },
        sustainMs: { type: 'number', description: 'Burst sustain in ms.' },
        wordsJson: { type: 'string', description: 'Burst words as a JSON array.' },
        atMs: { type: 'number', description: 'Virtual clock in ms (default 0).' },
        echo: { type: 'string', description: '"true" when the burst is known agent echo (optional).' },
        replyText: { type: 'string', description: 'Agent reply text to cut (optional — when given, returns the spoken/remaining split).' },
        spokenChars: { type: 'number', description: 'Chars already spoken (used with replyText).' },
      },
      ['energy', 'sustainMs'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const energy = getOptionalNumberArg(args, 'energy') ?? 0;
        const sustainMs = getOptionalNumberArg(args, 'sustainMs') ?? 0;
        const atMs = getOptionalNumberArg(args, 'atMs') ?? 0;
        const wordsRaw = parseJsonArg(getOptionalStringArg(args, 'wordsJson'), 'wordsJson');
        const words = Array.isArray(wordsRaw) ? wordsRaw.filter((w): w is string => typeof w === 'string') : [];
        const echo = getOptionalStringArg(args, 'echo') === 'true';
        const engine = needBargeIn();
        const { decision, score } = engine.observe({ atMs, energy, sustainMs, words, echo, agentSpeaking: true });
        const replyText = getOptionalStringArg(args, 'replyText');
        const spokenChars = getOptionalNumberArg(args, 'spokenChars') ?? 0;
        const cut = replyText === undefined ? undefined : splitReplyAtCutV21(replyText, spokenChars);
        return JSON.stringify({
          ok: true,
          decision,
          score,
          backchannel: isBackchannelBurstV21(words),
          cut,
          stats: engine.stats(),
        });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const evalTool: Tool = {
    definition: toolDef(
      'voice_v21_eval',
      'Voice eval (local action): run WER/CER + per-stage latency eval over the built-in offline corpus (or caller-supplied pairs), or score one reference/hypothesis pair.',
      {
        action: { type: 'string', description: 'run or score-one.' },
        pairsJson: { type: 'string', description: 'Extra pairs as JSON [{id, reference, hypothesis}] (run, optional).' },
        reference: { type: 'string', description: 'Reference transcript (score-one).' },
        hypothesis: { type: 'string', description: 'STT hypothesis (score-one).' },
        latencyJson: { type: 'string', description: 'Latency samples as JSON [{stage, turnId, durationMs, atMs}] (run, optional).' },
      },
      ['action'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        if (!isEvalAction(action)) return errorResult(`Unknown action "${action}" (${EVAL_ACTIONS.join(', ')})`);
        const harness = needEval();
        if (action === 'score-one') {
          const reference = getStringArg(args, 'reference');
          const hypothesis = getStringArg(args, 'hypothesis');
          const score = scorePairV21(reference, hypothesis);
          return JSON.stringify({ ok: true, ...score, summary: pairScoreSummaryV21(score) });
        }
        const pairsRaw = parseJsonArg(getOptionalStringArg(args, 'pairsJson'), 'pairsJson');
        const latencyRaw = parseJsonArg(getOptionalStringArg(args, 'latencyJson'), 'latencyJson');
        const scores = VOICE_V21_EVAL_SAMPLES.map((s) => scorePairV21(s.reference, s.hypothesis));
        if (Array.isArray(pairsRaw)) {
          for (const p of pairsRaw) {
            if (typeof p === 'object' && p !== null) {
              const o = p as Record<string, unknown>;
              if (typeof o.reference === 'string' && typeof o.hypothesis === 'string') {
                scores.push(scorePairV21(o.reference, o.hypothesis));
              }
            }
          }
        }
        const latency: { stage: VoiceV21LatencyStage; turnId: string; durationMs: number; atMs: number }[] = [];
        if (Array.isArray(latencyRaw)) {
          for (const s of latencyRaw) {
            if (typeof s === 'object' && s !== null) {
              const o = s as Record<string, unknown>;
              if (typeof o.stage === 'string' && LATENCY_STAGES.includes(o.stage as VoiceV21LatencyStage)
                && typeof o.turnId === 'string' && typeof o.durationMs === 'number' && typeof o.atMs === 'number') {
                latency.push({ stage: o.stage as VoiceV21LatencyStage, turnId: o.turnId, durationMs: o.durationMs, atMs: o.atMs });
              }
            }
          }
        }
        void harness;
        const report = aggregateEvalV21(scores, latency, defaultVoiceEvalV21Options());
        return JSON.stringify({ ok: true, ...report, markdown: evalReportMarkdownV21(report) });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const ttsCacheTool: Tool = {
    definition: toolDef(
      'voice_v21_tts_cache',
      'Streaming TTS cache (local action): speak/synthesise text through the cache (mock PCM, chunked), or read stats / prune expired entries / clear / compute a cache key.',
      {
        action: { type: 'string', description: 'speak, stats, prune, clear or key.' },
        text: { type: 'string', description: 'Text to speak (speak) or to key (key).' },
        voice: { type: 'string', description: 'Voice id (speak / key, default voice-v21-default).' },
        atMs: { type: 'number', description: 'Virtual clock in ms (default 0).' },
      },
      ['action'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        if (!isTtsAction(action)) return errorResult(`Unknown action "${action}" (${TTS_ACTIONS.join(', ')})`);
        const cache = needTts();
        const atMs = getOptionalNumberArg(args, 'atMs') ?? 0;
        const voice = getOptionalStringArg(args, 'voice') ?? 'voice-v21-default';
        if (action === 'stats') {
          return JSON.stringify({ ok: true, ...cache.stats(), summary: cache.summary() });
        }
        if (action === 'prune') {
          const dropped = cache.prune(atMs);
          return JSON.stringify({ ok: true, dropped, ...cache.stats() });
        }
        if (action === 'clear') {
          cache.clear();
          return JSON.stringify({ ok: true, cleared: true, ...cache.stats() });
        }
        if (action === 'key') {
          const text = getStringArg(args, 'text');
          return JSON.stringify({ ok: true, key: ttsCacheKeyV21(text, voice), chunks: splitTtsTextV21(text, 120) });
        }
        const text = getStringArg(args, 'text');
        const result = await cache.synthesize(text, voice, atMs);
        return JSON.stringify({
          ok: true,
          key: result.key,
          hit: result.hit,
          chunks: result.chunks.length,
          // Khác với stats.bytes (tổng byte đang lưu trong cache): đây là byte của lần synthesize này.
          bytesSynthesized: result.chunks.reduce((s, c) => s + c.byteLength, 0),
          durationMs: result.durationMs,
          ...cache.stats(),
        });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const monitorTool: Tool = {
    definition: toolDef(
      'voice_v21_monitor',
      'Realtime monitor panel (local action): snapshot of the session (turn state, live transcript, running tool call, latency, TTS cache hit rate) or its markdown rendering.',
      {
        action: { type: 'string', description: 'snapshot or markdown.' },
        atMs: { type: 'number', description: 'Virtual clock in ms (default 0).' },
        sessionId: { type: 'string', description: 'Session id to mirror from the live session (optional).' },
      },
      ['action'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        if (!isMonitorAction(action)) return errorResult(`Unknown action "${action}" (${MONITOR_ACTIONS.join(', ')})`);
        const atMs = getOptionalNumberArg(args, 'atMs') ?? 0;
        const session = needSession();
        const live = session.monitor(atMs);
        if (action === 'markdown') {
          // The session's own panel holds the live data; the
          // bound panel (getMonitorPanel) is the host's mirror.
          return JSON.stringify({ ok: true, markdown: session.panel.markdown(atMs), live });
        }
        return JSON.stringify({ ok: true, ...live });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  return [sessionTool, toolCallTool, confirmTool, turnTool, bargeInTool, evalTool, ttsCacheTool, monitorTool];
}

/** Unbound placeholder (own default instances — mock sessions only). */
export const VOICE_V21_TOOLS: Tool[] = createVoiceV21Tools();

export const VOICE_V21_TOOL_NAMES = [
  'voice_v21_session',
  'voice_v21_tool_call',
  'voice_v21_confirm',
  'voice_v21_turn',
  'voice_v21_barge_in',
  'voice_v21_eval',
  'voice_v21_tts_cache',
  'voice_v21_monitor',
] as const;

export function isVoiceV21ToolName(name: string): name is (typeof VOICE_V21_TOOL_NAMES)[number] {
  return (VOICE_V21_TOOL_NAMES as readonly string[]).includes(name);
}
