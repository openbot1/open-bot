/**
 * Voice v26 tools for @open-bot/tools (v1.39, Team T5).
 *
 * The agent drives the voice v26 realtime loop by tool call:
 *  - voice_v26_bargein  — frame-level barge-in: arm the agent
 *    reply, feed energy frames (suspect -> duck -> confirm),
 *    stop the TTS (measured stop latency, spoken prefix at a
 *    word boundary, resume strategy + context), false positives
 *  - voice_v26_turn     — guarded turn-taking: user start/end,
 *    agent start (queued while the user holds the floor — the
 *    anti-overlap guard), agent done, barge-in freeze,
 *    backchannel, abandon, per-phase timeout check, queued
 *    delivery, stats, markdown
 *  - voice_v26_latency  — end-to-end latency budget: record
 *    stage / turn samples, profiles, per-stage budget
 *    overrides, p50/p95, bottleneck, breaches, degraded-mode
 *    state and policy, markdown
 *  - voice_v26_providers — TTS/STT registry: list / register /
 *    enable / select by latency-quality-cost, fallback chain,
 *    rank, mock synthesize / transcribe, capability matrix
 *  - voice_v26_session  — a live session wiring all four:
 *    open, drive the whole turn flow, record latency, select
 *    + fall back providers, mock audio, snapshot, close
 *  - voice_v26_status   — live status panel: feed level
 *    samples, rows, snapshot, markdown, ui:// resource
 *  - voice_v26_audio    — deterministic level simulation
 *    (silence / speech / burst patterns, no mic, no sound
 *    card): generate frames, feed them to a panel meter
 *  - voice_v26_report   — aggregate report across the
 *    sessions opened through voice_v26_session
 *
 * SAFETY: everything here is local — clocks are virtual, audio
 * is mock/synthetic frame energy and level samples, latency
 * samples are caller-supplied measurements, providers are
 * deterministic mocks (no network, no key read or stored —
 * API-key providers carry only a Vault key *name*). No mic or
 * sound card is touched.
 *
 * Factory:
 *   createVoiceV26Tools(opts) -> Tool[]   (bound, usable)
 *   VOICE_V26_TOOLS                       (unbound placeholder, own
 *   default instances — mock sessions only)
 */
import type { Tool } from '@open-bot/core';
import {
  BargeInDetectorV26,
  LatencyBudgetV26,
  ProviderRegistryV26,
  StatusPanelV26,
  TurnTakingMachineV26,
  VoiceSessionV26,
  buildStatusSnapshotV26,
  createBargeInDetectorV26,
  createLatencyBudgetV26,
  createProviderRegistryV26,
  createStatusPanelV26,
  createTurnTakingMachineV26,
  createVoiceSessionV26,
  type BargeInV26Options,
  type LatencyBudgetV26Options,
  type ProviderRegistryV26Options,
  type StatusPanelV26Options,
  type TurnTakingV26Options,
  type VoiceV26BudgetProfile,
  type VoiceV26DegradedLevel,
  type VoiceV26LatencyStage,
  type VoiceV26ProviderKind,
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

function parseStringArray(value: string | undefined, name: string): string[] {
  const raw = parseJsonArg(value, name);
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error(`${name} must be a JSON array of strings`);
  for (const item of raw) {
    if (typeof item !== 'string') throw new Error(`${name} entries must be strings`);
  }
  return raw as string[];
}

function isAction(list: readonly string[], v: string): boolean {
  return (list as readonly string[]).includes(v);
}

export interface VoiceV26ToolOptions {
  /** Shared barge-in detector accessor (per session). */
  getBargeIn?: (sessionId: string) => BargeInDetectorV26 | null;
  /** Shared turn-taking machine accessor (per session). */
  getTurnTaking?: (sessionId: string) => TurnTakingMachineV26 | null;
  /** Shared latency budget accessor (per session). */
  getLatency?: (sessionId: string) => LatencyBudgetV26 | null;
  /** Shared provider registry accessor. */
  getProviders?: () => ProviderRegistryV26 | null;
  /** Shared status panel accessor (per session). */
  getPanel?: (sessionId: string) => StatusPanelV26 | null;
  /** Shared session accessor (per session). */
  getSession?: (sessionId: string) => VoiceSessionV26 | null;
  bargeInOptions?: Partial<BargeInV26Options>;
  turnTakingOptions?: Partial<TurnTakingV26Options>;
  latencyOptions?: Partial<LatencyBudgetV26Options>;
  providersOptions?: Partial<ProviderRegistryV26Options>;
  panelOptions?: Partial<StatusPanelV26Options>;
}

const BARGEIN_ACTIONS = ['speak', 'progress', 'frame', 'stop', 'current', 'list', 'ducks', 'backchannels', 'stats', 'false-positive', 'markdown', 'reset'] as const;
const TURN_ACTIONS = ['user-start', 'user-end', 'agent-start', 'agent-done', 'barge-in', 'backchannel', 'abandon', 'timeout-check', 'deliver-queued', 'current', 'list', 'queued', 'stats', 'markdown', 'reset'] as const;
const LATENCY_ACTIONS = ['record-stage', 'record-turn', 'profile', 'set-budget', 'stats', 'stages', 'breaches', 'bottleneck', 'degraded', 'turns', 'markdown', 'reset'] as const;
const PROVIDER_ACTIONS = ['list', 'get', 'register', 'remove', 'enable', 'select', 'fallback', 'rank', 'synthesize', 'transcribe', 'matrix', 'stats', 'markdown'] as const;
const SESSION_ACTIONS = ['open', 'user-start', 'frame', 'user-end', 'agent-reply', 'progress', 'agent-done', 'latency', 'turn-latency', 'select-provider', 'fallback', 'synthesize', 'transcribe', 'timeout-check', 'status', 'snapshot', 'close', 'summary'] as const;
const STATUS_ACTIONS = ['feed-level', 'snapshot', 'rows', 'ui-resource', 'ui-uri', 'markdown', 'summary', 'reset-meter'] as const;
const AUDIO_ACTIONS = ['simulate', 'meter', 'reset'] as const;
const REPORT_ACTIONS = ['summary', 'markdown'] as const;

export function createVoiceV26Tools(opts: VoiceV26ToolOptions = {}): Tool[] {
  const defaultProviders = createProviderRegistryV26(opts.providersOptions ?? {});
  const needProviders = (): ProviderRegistryV26 => opts.getProviders?.() ?? defaultProviders;
  const detectors = new Map<string, BargeInDetectorV26>();
  const machines = new Map<string, TurnTakingMachineV26>();
  const budgets = new Map<string, LatencyBudgetV26>();
  const panels = new Map<string, StatusPanelV26>();
  const sessions = new Map<string, VoiceSessionV26>();

  const needBargeIn = (sessionId: string): BargeInDetectorV26 => {
    const shared = opts.getBargeIn?.(sessionId);
    if (shared !== null && shared !== undefined) return shared;
    let found = detectors.get(sessionId);
    if (found === undefined) {
      found = createBargeInDetectorV26(sessionId, opts.bargeInOptions ?? {});
      detectors.set(sessionId, found);
    }
    return found;
  };
  const needTurnTaking = (sessionId: string): TurnTakingMachineV26 => {
    const shared = opts.getTurnTaking?.(sessionId);
    if (shared !== null && shared !== undefined) return shared;
    let found = machines.get(sessionId);
    if (found === undefined) {
      found = createTurnTakingMachineV26(sessionId, opts.turnTakingOptions ?? {});
      machines.set(sessionId, found);
    }
    return found;
  };
  const needLatency = (sessionId: string): LatencyBudgetV26 => {
    const shared = opts.getLatency?.(sessionId);
    if (shared !== null && shared !== undefined) return shared;
    let found = budgets.get(sessionId);
    if (found === undefined) {
      found = createLatencyBudgetV26(sessionId, opts.latencyOptions ?? {});
      budgets.set(sessionId, found);
    }
    return found;
  };
  const needPanel = (sessionId: string): StatusPanelV26 => {
    const shared = opts.getPanel?.(sessionId);
    if (shared !== null && shared !== undefined) return shared;
    let found = panels.get(sessionId);
    if (found === undefined) {
      found = createStatusPanelV26(sessionId, opts.panelOptions ?? {});
      panels.set(sessionId, found);
    }
    return found;
  };
  const needSession = (sessionId: string): VoiceSessionV26 => {
    const shared = opts.getSession?.(sessionId);
    if (shared !== null && shared !== undefined) return shared;
    let found = sessions.get(sessionId);
    if (found === undefined) {
      found = createVoiceSessionV26(sessionId, {
        bargeIn: opts.bargeInOptions,
        turnTaking: opts.turnTakingOptions,
        latency: opts.latencyOptions,
        providers: opts.providersOptions,
      });
      sessions.set(sessionId, found);
    }
    return found;
  };

  const bargeInTool: Tool = {
    definition: toolDef(
      'voice_v26_bargein',
      'Frame-level barge-in detection for a voice session (local action): arm the agent reply being spoken, feed audio energy frames (suspect -> duck -> confirm), stop the TTS when confirmed (measured stop latency, spoken prefix cut at a word boundary, resume strategy + context), list records, or mark a false positive. Short bursts are backchannels; echo frames are ignored; no mic or sound card is touched.',
      {
        action: { type: 'string', description: 'speak, progress, frame, stop, current, list, ducks, backchannels, stats, false-positive, markdown or reset.' },
        sessionId: { type: 'string', description: 'Voice session id.' },
        turnId: { type: 'string', description: 'Assistant turn id (speak).' },
        turnIndex: { type: 'number', description: 'Assistant turn index (speak, optional, default 0).' },
        replyText: { type: 'string', description: 'Planned agent reply text (speak).' },
        spokenChars: { type: 'number', description: 'Chars the TTS engine has spoken (progress / stop).' },
        energy: { type: 'number', description: 'Frame energy 0..1 (frame).' },
        isSpeech: { type: 'string', description: '"true" when the frame is speech (frame, optional).' },
        echo: { type: 'string', description: '"true" when the frame is TTS echo (frame, optional).' },
        userText: { type: 'string', description: 'What the user said (frame / stop, optional).' },
        bargeInId: { type: 'string', description: 'Barge-in id (false-positive).' },
        atMs: { type: 'number', description: 'Virtual clock in ms (default 0).' },
      },
      ['action', 'sessionId'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const action = getStringArg(args, 'action');
        if (!isAction(BARGEIN_ACTIONS, action)) return errorResult(`Unknown action: "${action}"`);
        const sessionId = getStringArg(args, 'sessionId');
        const atMs = getOptionalNumberArg(args, 'atMs') ?? 0;
        const detector = needBargeIn(sessionId);
        switch (action) {
          case 'speak': {
            detector.agentStartedSpeaking({
              turnId: getStringArg(args, 'turnId'),
              turnIndex: getOptionalNumberArg(args, 'turnIndex') ?? 0,
              replyText: getStringArg(args, 'replyText'),
              atMs,
            });
            return JSON.stringify({ ok: true, sessionId, stage: detector.currentStage() });
          }
          case 'progress': {
            detector.agentSpeechProgress(atMs, getOptionalNumberArg(args, 'spokenChars') ?? 0);
            return JSON.stringify({ ok: true, sessionId, speaking: detector.isAgentSpeaking() });
          }
          case 'frame': {
            const result = detector.feedFrame({
              atMs,
              energy: getOptionalNumberArg(args, 'energy') ?? 0,
              isSpeech: getOptionalBooleanArg(args, 'isSpeech'),
              echo: getOptionalBooleanArg(args, 'echo'),
              userText: getOptionalStringArg(args, 'userText') ?? null,
            });
            return JSON.stringify(result);
          }
          case 'stop': {
            const stopped = detector.stop({
              atMs,
              spokenChars: getOptionalNumberArg(args, 'spokenChars'),
              userText: getOptionalStringArg(args, 'userText') ?? null,
            });
            if (!stopped) return errorResult('No confirmed barge-in to stop');
            return JSON.stringify(stopped);
          }
          case 'current':
            return JSON.stringify(detector.currentRecord() ?? { stage: detector.currentStage(), record: null });
          case 'list':
            return JSON.stringify(detector.list());
          case 'ducks':
            return JSON.stringify(detector.ducksList());
          case 'backchannels':
            return JSON.stringify(detector.backchannelsList());
          case 'stats':
            return JSON.stringify(detector.stats());
          case 'false-positive': {
            const ok = detector.markFalsePositive(getStringArg(args, 'bargeInId'));
            return JSON.stringify({ ok, bargeInId: getStringArg(args, 'bargeInId') });
          }
          case 'markdown':
            return detector.markdown();
          case 'reset':
            detector.reset();
            return JSON.stringify({ ok: true, sessionId });
          default:
            return errorResult(`Unknown action: "${action}"`);
        }
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const turnTool: Tool = {
    definition: toolDef(
      'voice_v26_turn',
      'Guarded turn-taking floor machine for a voice session (local action): user start/end, agent start (queued while the user holds the floor — the anti-overlap guard, never spoken over the user), agent done, barge-in freeze, backchannel, abandon, per-phase timeout check, deliver queued replies, stats and markdown.',
      {
        action: { type: 'string', description: 'user-start, user-end, agent-start, agent-done, barge-in, backchannel, abandon, timeout-check, deliver-queued, current, list, queued, stats, markdown or reset.' },
        sessionId: { type: 'string', description: 'Voice session id.' },
        text: { type: 'string', description: 'Turn text (user-start / user-end / agent-start / backchannel).' },
        providerId: { type: 'string', description: 'Provider serving the reply (agent-start, optional).' },
        model: { type: 'string', description: 'Model serving the reply (agent-start, optional).' },
        bargeInId: { type: 'string', description: 'Barge-in id cutting the reply (barge-in).' },
        spokenText: { type: 'string', description: 'Spoken prefix of the cut reply (barge-in).' },
        spokenChars: { type: 'number', description: 'Chars spoken before the cut (barge-in / agent-done).' },
        atMs: { type: 'number', description: 'Virtual clock in ms (default 0).' },
      },
      ['action', 'sessionId'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const action = getStringArg(args, 'action');
        if (!isAction(TURN_ACTIONS, action)) return errorResult(`Unknown action: "${action}"`);
        const sessionId = getStringArg(args, 'sessionId');
        const atMs = getOptionalNumberArg(args, 'atMs') ?? 0;
        const machine = needTurnTaking(sessionId);
        switch (action) {
          case 'user-start':
            return JSON.stringify(machine.userStart(atMs, getOptionalStringArg(args, 'text') ?? ''));
          case 'user-end': {
            const turn = machine.userEnd(atMs, getOptionalStringArg(args, 'text'));
            return JSON.stringify(turn ?? { ended: false });
          }
          case 'agent-start':
            return JSON.stringify(machine.agentStart({
              atMs,
              text: getStringArg(args, 'text'),
              providerId: getOptionalStringArg(args, 'providerId') ?? null,
              model: getOptionalStringArg(args, 'model') ?? null,
            }));
          case 'agent-done': {
            const turn = machine.agentDone(atMs, getOptionalNumberArg(args, 'spokenChars'));
            return JSON.stringify(turn ?? { ended: false });
          }
          case 'barge-in': {
            const turn = machine.bargeIn({
              atMs,
              bargeInId: getStringArg(args, 'bargeInId'),
              spokenText: getStringArg(args, 'spokenText'),
              spokenChars: getOptionalNumberArg(args, 'spokenChars') ?? 0,
            });
            return JSON.stringify(turn ?? { frozen: false });
          }
          case 'backchannel':
            machine.backchannel(atMs, getStringArg(args, 'text'));
            return JSON.stringify({ ok: true, sessionId });
          case 'abandon': {
            const turn = machine.abandon(atMs);
            return JSON.stringify(turn ?? { abandoned: false });
          }
          case 'timeout-check': {
            const turn = machine.timeoutCheck(atMs);
            return JSON.stringify(turn ?? { timedOut: false });
          }
          case 'deliver-queued': {
            const result = machine.deliverQueued(atMs);
            return JSON.stringify(result ?? { delivered: false });
          }
          case 'current':
            return JSON.stringify(machine.currentTurnNow() ?? { state: machine.stateNow(), turn: null });
          case 'list':
            return JSON.stringify(machine.listTurns());
          case 'queued':
            return JSON.stringify(machine.queuedReplies());
          case 'stats':
            return JSON.stringify(machine.stats());
          case 'markdown':
            return machine.markdown();
          case 'reset':
            machine.reset();
            return JSON.stringify({ ok: true, sessionId });
          default:
            return errorResult(`Unknown action: "${action}"`);
        }
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const latencyTool: Tool = {
    definition: toolDef(
      'voice_v26_latency',
      'End-to-end latency budget for a voice session (local action): record STT / model / TTS / total stage samples against per-stage budgets, record whole turns, switch budget profiles (realtime / balanced / quality), override a stage budget, rolling p50/p95, bottleneck, breaches, degraded-mode state and policy (quality traded for latency when the budget keeps breaking). Samples are caller-supplied measurements.',
      {
        action: { type: 'string', description: 'record-stage, record-turn, profile, set-budget, stats, stages, breaches, bottleneck, degraded, turns, markdown or reset.' },
        sessionId: { type: 'string', description: 'Voice session id.' },
        stage: { type: 'string', description: 'Latency stage: stt | model | tts | total (record-stage / set-budget / breaches).' },
        ms: { type: 'number', description: 'Measured ms (record-stage) or new budget ms (set-budget).' },
        sttMs: { type: 'number', description: 'STT ms (record-turn, optional).' },
        modelMs: { type: 'number', description: 'Model ms (record-turn, optional).' },
        ttsMs: { type: 'number', description: 'TTS ms (record-turn, optional).' },
        turnId: { type: 'string', description: 'Turn id (record-stage / record-turn, optional).' },
        turnIndex: { type: 'number', description: 'Turn index (record-stage / record-turn, optional).' },
        providerId: { type: 'string', description: 'Provider measured (optional).' },
        profile: { type: 'string', description: 'Budget profile: realtime | balanced | quality (profile).' },
        atMs: { type: 'number', description: 'Virtual clock in ms (default 0).' },
      },
      ['action', 'sessionId'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const action = getStringArg(args, 'action');
        if (!isAction(LATENCY_ACTIONS, action)) return errorResult(`Unknown action: "${action}"`);
        const sessionId = getStringArg(args, 'sessionId');
        const atMs = getOptionalNumberArg(args, 'atMs') ?? 0;
        const budget = needLatency(sessionId);
        switch (action) {
          case 'record-stage': {
            const stage = getStringArg(args, 'stage') as VoiceV26LatencyStage;
            if (stage !== 'stt' && stage !== 'model' && stage !== 'tts' && stage !== 'total') {
              return errorResult(`Unknown stage: "${stage}"`);
            }
            const breach = budget.recordStage({
              stage,
              ms: getOptionalNumberArg(args, 'ms') ?? 0,
              turnId: getOptionalStringArg(args, 'turnId') ?? null,
              turnIndex: getOptionalNumberArg(args, 'turnIndex') ?? null,
              providerId: getOptionalStringArg(args, 'providerId') ?? null,
              atMs,
            });
            return JSON.stringify({ breached: breach !== null, breach, degradedLevel: budget.degradedLevelNow() });
          }
          case 'record-turn': {
            const rollup = budget.recordTurn({
              turnId: getOptionalStringArg(args, 'turnId') ?? null,
              turnIndex: getOptionalNumberArg(args, 'turnIndex') ?? null,
              sttMs: getOptionalNumberArg(args, 'sttMs') ?? null,
              modelMs: getOptionalNumberArg(args, 'modelMs') ?? null,
              ttsMs: getOptionalNumberArg(args, 'ttsMs') ?? null,
              providerId: getOptionalStringArg(args, 'providerId') ?? null,
              atMs,
            });
            return JSON.stringify(rollup);
          }
          case 'profile': {
            const profile = getStringArg(args, 'profile') as VoiceV26BudgetProfile;
            if (profile !== 'realtime' && profile !== 'balanced' && profile !== 'quality') {
              return errorResult(`Unknown profile: "${profile}"`);
            }
            return JSON.stringify({ profile, budgets: budget.setProfile(profile, atMs) });
          }
          case 'set-budget': {
            const stage = getStringArg(args, 'stage') as VoiceV26LatencyStage;
            if (stage !== 'stt' && stage !== 'model' && stage !== 'tts' && stage !== 'total') {
              return errorResult(`Unknown stage: "${stage}"`);
            }
            return JSON.stringify({ budgets: budget.setBudget(stage, getOptionalNumberArg(args, 'ms') ?? 0) });
          }
          case 'stats':
            return JSON.stringify(budget.stats());
          case 'stages':
            return JSON.stringify(budget.allStageStats());
          case 'breaches':
            return JSON.stringify(budget.breachesList({
              stage: getOptionalStringArg(args, 'stage') as VoiceV26LatencyStage | undefined,
            }));
          case 'bottleneck': {
            const bottleneck = budget.bottleneck();
            return JSON.stringify(bottleneck ?? { bottleneck: null });
          }
          case 'degraded':
            return JSON.stringify({ level: budget.degradedLevelNow(), policy: budget.policyNow() });
          case 'turns':
            return JSON.stringify(budget.turnLatenciesList());
          case 'markdown':
            return budget.markdown();
          case 'reset':
            budget.reset();
            return JSON.stringify({ ok: true, sessionId });
          default:
            return errorResult(`Unknown action: "${action}"`);
        }
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const providersTool: Tool = {
    definition: toolDef(
      'voice_v26_providers',
      'TTS/STT provider registry (local action): list / register / enable providers (local, system, API-key via a Vault key *name* only — never a key value — or deterministic mock), select by latency/quality/cost, fallback chain, rank, mock synthesize / transcribe (deterministic, no network, no sound card), capability matrix.',
      {
        action: { type: 'string', description: 'list, get, register, remove, enable, select, fallback, rank, synthesize, transcribe, matrix, stats or markdown.' },
        providerId: { type: 'string', description: 'Provider id (get / remove / enable / synthesize / transcribe).' },
        kind: { type: 'string', description: 'Provider kind: stt | tts (list / select / fallback / rank).' },
        origin: { type: 'string', description: 'Provider origin: local | system | api-key | mock (list, optional).' },
        language: { type: 'string', description: 'Language BCP-47 tag (list / select / rank / synthesize / transcribe, optional).' },
        voice: { type: 'string', description: 'Voice name (select / rank / synthesize, optional).' },
        streaming: { type: 'string', description: '"true" to require streaming (select / rank, optional).' },
        enabled: { type: 'string', description: '"true" / "false" (enable).' },
        text: { type: 'string', description: 'Text to synthesize (synthesize).' },
        audioPayload: { type: 'string', description: 'Fake audio payload for mock transcription (transcribe).' },
        definitionJson: { type: 'string', description: 'Provider definition as JSON (register).' },
        excludeIdsJson: { type: 'string', description: 'Provider ids to skip, as JSON array (select / rank, optional).' },
        degradedLevel: { type: 'string', description: 'Degraded level: off | light | heavy (select / rank, optional).' },
        atMs: { type: 'number', description: 'Virtual clock in ms (default 0).' },
      },
      ['action'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const action = getStringArg(args, 'action');
        if (!isAction(PROVIDER_ACTIONS, action)) return errorResult(`Unknown action: "${action}"`);
        const atMs = getOptionalNumberArg(args, 'atMs') ?? 0;
        const registry = needProviders();
        const kindArg = (getOptionalStringArg(args, 'kind') ?? '') as VoiceV26ProviderKind;
        const degraded = (getOptionalStringArg(args, 'degradedLevel') ?? 'off') as VoiceV26DegradedLevel;
        switch (action) {
          case 'list':
            return JSON.stringify(registry.list({
              kind: kindArg === 'stt' || kindArg === 'tts' ? kindArg : undefined,
              origin: getOptionalStringArg(args, 'origin') as 'local' | 'system' | 'api-key' | 'mock' | undefined,
              language: getOptionalStringArg(args, 'language'),
            }));
          case 'get': {
            const provider = registry.get(getStringArg(args, 'providerId'));
            if (!provider) return errorResult(`Unknown provider: "${getStringArg(args, 'providerId')}"`);
            return JSON.stringify(provider);
          }
          case 'register': {
            const raw = parseJsonArg(getOptionalStringArg(args, 'definitionJson'), 'definitionJson') as Record<string, unknown> | undefined;
            if (!raw || typeof raw !== 'object') return errorResult('definitionJson must be a provider definition object');
            const registered = registry.register(raw as unknown as Parameters<ProviderRegistryV26['register']>[0]);
            return JSON.stringify(registered);
          }
          case 'remove':
            return JSON.stringify({ removed: registry.remove(getStringArg(args, 'providerId')) });
          case 'enable':
            return JSON.stringify({ ok: registry.setEnabled(getStringArg(args, 'providerId'), getOptionalBooleanArg(args, 'enabled') ?? true) });
          case 'select': {
            if (kindArg !== 'stt' && kindArg !== 'tts') return errorResult(`Unknown kind: "${kindArg}"`);
            const selection = registry.select({
              kind: kindArg,
              language: getOptionalStringArg(args, 'language') ?? null,
              voice: getOptionalStringArg(args, 'voice') ?? null,
              streaming: getOptionalBooleanArg(args, 'streaming') ?? null,
              degradedLevel: degraded,
              excludeIds: parseStringArray(getOptionalStringArg(args, 'excludeIdsJson'), 'excludeIdsJson'),
            }, atMs);
            if (!selection) return errorResult('No eligible provider');
            return JSON.stringify(selection);
          }
          case 'fallback': {
            if (kindArg !== 'stt' && kindArg !== 'tts') return errorResult(`Unknown kind: "${kindArg}"`);
            return JSON.stringify(registry.fallbackChain({
              kind: kindArg,
              language: getOptionalStringArg(args, 'language') ?? null,
              degradedLevel: degraded,
            }, atMs));
          }
          case 'rank': {
            if (kindArg !== 'stt' && kindArg !== 'tts') return errorResult(`Unknown kind: "${kindArg}"`);
            return JSON.stringify(registry.rank({
              kind: kindArg,
              language: getOptionalStringArg(args, 'language') ?? null,
              voice: getOptionalStringArg(args, 'voice') ?? null,
              streaming: getOptionalBooleanArg(args, 'streaming') ?? null,
              degradedLevel: degraded,
              excludeIds: parseStringArray(getOptionalStringArg(args, 'excludeIdsJson'), 'excludeIdsJson'),
            }));
          }
          case 'synthesize':
            return JSON.stringify(registry.synthesize({
              providerId: getStringArg(args, 'providerId'),
              text: getStringArg(args, 'text'),
              voice: getOptionalStringArg(args, 'voice') ?? null,
              language: getOptionalStringArg(args, 'language') ?? null,
              atMs,
            }));
          case 'transcribe':
            return JSON.stringify(registry.transcribe({
              providerId: getStringArg(args, 'providerId'),
              audioPayload: getStringArg(args, 'audioPayload'),
              language: getOptionalStringArg(args, 'language') ?? null,
              atMs,
            }));
          case 'matrix':
            return JSON.stringify(registry.capabilityMatrix());
          case 'stats':
            return JSON.stringify(registry.stats());
          case 'markdown':
            return registry.markdown();
          default:
            return errorResult(`Unknown action: "${action}"`);
        }
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const sessionTool: Tool = {
    definition: toolDef(
      'voice_v26_session',
      'A live realtime voice session wiring barge-in + turn-taking + latency budget + providers (local action): open, drive the whole turn flow (user frames, agent replies, barge-in stops with resume context), record latency, select / fall back providers, mock audio, snapshot, close. Virtual clock, mock audio, no network, no key, no mic.',
      {
        action: { type: 'string', description: 'open, user-start, frame, user-end, agent-reply, progress, agent-done, latency, turn-latency, select-provider, fallback, synthesize, transcribe, timeout-check, status, snapshot, close or summary.' },
        sessionId: { type: 'string', description: 'Voice session id.' },
        text: { type: 'string', description: 'Turn text / reply text / user text (user-start / agent-reply, optional).' },
        energy: { type: 'number', description: 'Frame energy 0..1 (frame).' },
        isSpeech: { type: 'string', description: '"true" when the frame is speech (frame, optional).' },
        echo: { type: 'string', description: '"true" when the frame is TTS echo (frame, optional).' },
        userText: { type: 'string', description: 'What the user said (frame, optional).' },
        spokenChars: { type: 'number', description: 'Chars spoken (progress / agent-done).' },
        stage: { type: 'string', description: 'Latency stage: stt | model | tts | total (latency).' },
        ms: { type: 'number', description: 'Measured ms (latency).' },
        sttMs: { type: 'number', description: 'STT ms (turn-latency, optional).' },
        modelMs: { type: 'number', description: 'Model ms (turn-latency, optional).' },
        ttsMs: { type: 'number', description: 'TTS ms (turn-latency, optional).' },
        turnId: { type: 'string', description: 'Turn id (latency / turn-latency, optional).' },
        kind: { type: 'string', description: 'Provider kind: stt | tts (select-provider / fallback).' },
        language: { type: 'string', description: 'Language (select-provider / synthesize / transcribe, optional).' },
        voice: { type: 'string', description: 'Voice name (synthesize, optional).' },
        audioPayload: { type: 'string', description: 'Fake audio payload (transcribe).' },
        atMs: { type: 'number', description: 'Virtual clock in ms (default 0).' },
      },
      ['action', 'sessionId'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const action = getStringArg(args, 'action');
        if (!isAction(SESSION_ACTIONS, action)) return errorResult(`Unknown action: "${action}"`);
        const sessionId = getStringArg(args, 'sessionId');
        const atMs = getOptionalNumberArg(args, 'atMs') ?? 0;
        const session = needSession(sessionId);
        switch (action) {
          case 'open':
            session.open(atMs);
            return JSON.stringify({ ok: true, sessionId, state: session.stateNow() });
          case 'user-start':
            return JSON.stringify(session.userStart(atMs, getOptionalStringArg(args, 'text') ?? ''));
          case 'frame':
            return JSON.stringify(session.userFrame({
              atMs,
              energy: getOptionalNumberArg(args, 'energy') ?? 0,
              isSpeech: getOptionalBooleanArg(args, 'isSpeech'),
              echo: getOptionalBooleanArg(args, 'echo'),
              userText: getOptionalStringArg(args, 'userText') ?? null,
            }));
          case 'user-end':
            return JSON.stringify(session.userEnd(atMs, getOptionalStringArg(args, 'text')) ?? { ended: false });
          case 'agent-reply':
            return JSON.stringify(session.agentReply({
              atMs,
              text: getStringArg(args, 'text'),
            }));
          case 'progress':
            session.agentSpeechProgress(atMs, getOptionalNumberArg(args, 'spokenChars') ?? 0);
            return JSON.stringify({ ok: true, sessionId });
          case 'agent-done':
            return JSON.stringify(session.agentDone(atMs, getOptionalNumberArg(args, 'spokenChars')) ?? { ended: false });
          case 'latency': {
            const stage = getStringArg(args, 'stage') as VoiceV26LatencyStage;
            if (stage !== 'stt' && stage !== 'model' && stage !== 'tts' && stage !== 'total') {
              return errorResult(`Unknown stage: "${stage}"`);
            }
            return JSON.stringify(session.recordLatency({
              stage,
              ms: getOptionalNumberArg(args, 'ms') ?? 0,
              turnId: getOptionalStringArg(args, 'turnId') ?? null,
              atMs,
            }));
          }
          case 'turn-latency':
            return JSON.stringify(session.recordTurnLatency({
              turnId: getOptionalStringArg(args, 'turnId') ?? null,
              sttMs: getOptionalNumberArg(args, 'sttMs') ?? null,
              modelMs: getOptionalNumberArg(args, 'modelMs') ?? null,
              ttsMs: getOptionalNumberArg(args, 'ttsMs') ?? null,
              atMs,
            }));
          case 'select-provider': {
            const kind = getStringArg(args, 'kind') as VoiceV26ProviderKind;
            if (kind !== 'stt' && kind !== 'tts') return errorResult(`Unknown kind: "${kind}"`);
            const selection = session.selectProvider({ kind, language: getOptionalStringArg(args, 'language') ?? null, atMs });
            if (!selection) return errorResult('No eligible provider');
            return JSON.stringify(selection);
          }
          case 'fallback': {
            const kind = getStringArg(args, 'kind') as VoiceV26ProviderKind;
            if (kind !== 'stt' && kind !== 'tts') return errorResult(`Unknown kind: "${kind}"`);
            return JSON.stringify(session.fallbackProviders(kind, atMs));
          }
          case 'synthesize':
            return JSON.stringify(session.mockSynthesize({
              text: getStringArg(args, 'text'),
              voice: getOptionalStringArg(args, 'voice') ?? null,
              language: getOptionalStringArg(args, 'language') ?? null,
              atMs,
            }));
          case 'transcribe':
            return JSON.stringify(session.mockTranscribe({
              audioPayload: getStringArg(args, 'audioPayload'),
              language: getOptionalStringArg(args, 'language') ?? null,
              atMs,
            }));
          case 'timeout-check':
            return JSON.stringify(session.timeoutCheck(atMs) ?? { timedOut: false });
          case 'status':
            return JSON.stringify(session.statusSnapshot(atMs));
          case 'snapshot':
            return JSON.stringify(session.snapshot());
          case 'close':
            return JSON.stringify(session.close(atMs));
          case 'summary':
            return session.summary();
          default:
            return errorResult(`Unknown action: "${action}"`);
        }
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const statusTool: Tool = {
    definition: toolDef(
      'voice_v26_status',
      'Live voice status panel for a session (local action): feed audio-level samples (synthetic, caller-supplied — no mic), render rows, snapshot, markdown, or the MCP Apps ui:// resource descriptor (ui://voice-v26/status) so the same panel renders as a desktop panel or as a ui:// resource.',
      {
        action: { type: 'string', description: 'feed-level, snapshot, rows, ui-resource, ui-uri, markdown, summary or reset-meter.' },
        sessionId: { type: 'string', description: 'Voice session id.' },
        level: { type: 'number', description: 'Audio level 0..1 (feed-level).' },
        speaking: { type: 'string', description: '"true" while the agent is speaking (feed-level, optional).' },
        snapshotJson: { type: 'string', description: 'Status snapshot as JSON (snapshot / rows / ui-resource / markdown, optional — builds one from fields when omitted).' },
        floor: { type: 'string', description: 'Floor state: idle | listening | thinking | speaking | interrupted | done (snapshot build, optional).' },
        latencyMs: { type: 'number', description: 'Current turn latency ms (snapshot build, optional).' },
        budgetMs: { type: 'number', description: 'Total budget ms (snapshot build, default 4000).' },
        atMs: { type: 'number', description: 'Virtual clock in ms (default 0).' },
      },
      ['action', 'sessionId'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const action = getStringArg(args, 'action');
        if (!isAction(STATUS_ACTIONS, action)) return errorResult(`Unknown action: "${action}"`);
        const sessionId = getStringArg(args, 'sessionId');
        const atMs = getOptionalNumberArg(args, 'atMs') ?? 0;
        const panel = needPanel(sessionId);
        const loadSnapshot = (): void => {
          const raw = parseJsonArg(getOptionalStringArg(args, 'snapshotJson'), 'snapshotJson') as Record<string, unknown> | undefined;
          if (raw && typeof raw === 'object') {
            panel.update(raw as unknown as Parameters<StatusPanelV26['update']>[0]);
            return;
          }
          const floor = (getOptionalStringArg(args, 'floor') ?? 'idle') as Parameters<typeof buildStatusSnapshotV26>[0]['floor'];
          panel.update(buildStatusSnapshotV26({
            sessionId,
            floor,
            latencyMs: getOptionalNumberArg(args, 'latencyMs') ?? null,
            budgetMs: getOptionalNumberArg(args, 'budgetMs') ?? 4000,
            atMs,
          }));
        };
        switch (action) {
          case 'feed-level':
            return JSON.stringify(panel.feedLevel({
              atMs,
              level: getOptionalNumberArg(args, 'level') ?? 0,
              speaking: getOptionalBooleanArg(args, 'speaking') ?? false,
            }));
          case 'snapshot':
            loadSnapshot();
            return JSON.stringify(panel.snapshotNow() ?? { snapshot: null });
          case 'rows':
            loadSnapshot();
            return JSON.stringify(panel.rows());
          case 'ui-resource': {
            loadSnapshot();
            const resource = panel.uiResource();
            if (!resource) return errorResult('No snapshot yet');
            return JSON.stringify(resource);
          }
          case 'ui-uri':
            return JSON.stringify({ uri: panel.uiUri() });
          case 'markdown':
            loadSnapshot();
            return panel.markdown();
          case 'summary':
            return panel.summary();
          case 'reset-meter':
            panel.resetMeter();
            return JSON.stringify({ ok: true, sessionId });
          default:
            return errorResult(`Unknown action: "${action}"`);
        }
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const audioTool: Tool = {
    definition: toolDef(
      'voice_v26_audio',
      'Deterministic audio-level simulation for voice tests and the status meter (local action): generate synthetic level frames for silence / speech / burst patterns (a sine tone with noise, no mic, no sound card, no audio hardware) and feed them to a session status panel meter.',
      {
        action: { type: 'string', description: 'simulate, meter or reset.' },
        sessionId: { type: 'string', description: 'Voice session id.' },
        pattern: { type: 'string', description: 'Level pattern: silence | speech | burst | conversation (simulate).' },
        frames: { type: 'number', description: 'How many frames to generate (simulate, default 20).' },
        frameMs: { type: 'number', description: 'Ms per frame (simulate, default 50).' },
        speaking: { type: 'string', description: '"true" while the agent is speaking (simulate, optional).' },
        atMs: { type: 'number', description: 'Virtual clock in ms (default 0).' },
      },
      ['action', 'sessionId'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const action = getStringArg(args, 'action');
        if (!isAction(AUDIO_ACTIONS, action)) return errorResult(`Unknown action: "${action}"`);
        const sessionId = getStringArg(args, 'sessionId');
        const atMs = getOptionalNumberArg(args, 'atMs') ?? 0;
        const panel = needPanel(sessionId);
        switch (action) {
          case 'simulate': {
            const pattern = getOptionalStringArg(args, 'pattern') ?? 'speech';
            if (pattern !== 'silence' && pattern !== 'speech' && pattern !== 'burst' && pattern !== 'conversation') {
              return errorResult(`Unknown pattern: "${pattern}"`);
            }
            const frames = getOptionalNumberArg(args, 'frames') ?? 20;
            const frameMs = getOptionalNumberArg(args, 'frameMs') ?? 50;
            const speaking = getOptionalBooleanArg(args, 'speaking') ?? false;
            const generated = [];
            for (let i = 0; i < frames; i++) {
              const t = i / Math.max(1, frames - 1);
              let level: number;
              if (pattern === 'silence') level = 0.02 + 0.02 * Math.sin(i * 1.7);
              else if (pattern === 'speech') level = 0.45 + 0.25 * Math.sin(i * 0.9) + 0.1 * Math.sin(i * 2.3);
              else if (pattern === 'burst') level = t < 0.3 ? 0.05 : 0.75 + 0.15 * Math.sin(i * 1.3);
              else level = (i % 10 < 5 ? 0.55 : 0.08) + 0.1 * Math.sin(i * 1.1);
              const sample = panel.feedLevel({ atMs: atMs + i * frameMs, level: Math.max(0, Math.min(1, level)), speaking });
              generated.push(sample);
            }
            return JSON.stringify({ pattern, frames: generated.length, last: generated[generated.length - 1] ?? null });
          }
          case 'meter':
            return JSON.stringify({ levels: panel.levelsList(), current: panel.currentLevel() });
          case 'reset':
            panel.resetMeter();
            return JSON.stringify({ ok: true, sessionId });
          default:
            return errorResult(`Unknown action: "${action}"`);
        }
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const reportTool: Tool = {
    definition: toolDef(
      'voice_v26_report',
      'Aggregate report across the voice sessions opened through voice_v26_session (local action): turn totals, barge-in counts, breach counts, degraded levels, active providers, and markdown. Sessions opened outside this tool set are not visible here.',
      {
        action: { type: 'string', description: 'summary or markdown.' },
      },
      ['action'],
    ),
    needsApproval: false,
    execute: async (args) => {
      try {
        const action = getStringArg(args, 'action');
        if (!isAction(REPORT_ACTIONS, action)) return errorResult(`Unknown action: "${action}"`);
        const rows = [...sessions.values()].map((s) => {
          const snap = s.snapshot();
          return {
            sessionId: snap.sessionId,
            state: snap.state,
            degradedLevel: snap.degradedLevel,
            turns: snap.turns.length,
            bargeIns: snap.bargeIns.length,
            events: snap.events.length,
            sttProviderId: snap.sttProviderId,
            ttsProviderId: snap.ttsProviderId,
            open: snap.closedAtMs === null,
          };
        });
        const totals = {
          sessions: rows.length,
          open: rows.filter((r) => r.open).length,
          turns: rows.reduce((a, r) => a + r.turns, 0),
          bargeIns: rows.reduce((a, r) => a + r.bargeIns, 0),
          events: rows.reduce((a, r) => a + r.events, 0),
          degraded: rows.filter((r) => r.degradedLevel !== 'off').length,
        };
        if (action === 'summary') {
          return JSON.stringify({ totals, sessions: rows });
        }
        const lines = [
          '# Voice report v26',
          '',
          `- Sessions: ${totals.sessions} (${totals.open} open)`,
          `- Turns: ${totals.turns}`,
          `- Barge-ins: ${totals.bargeIns}`,
          `- Events: ${totals.events}`,
          `- Sessions degraded: ${totals.degraded}`,
          '',
          '| session | state | degraded | turns | barge-ins | stt | tts | open |',
          '| --- | --- | --- | --- | --- | --- | --- | --- |',
        ];
        for (const r of rows) {
          lines.push(`| ${r.sessionId} | ${r.state} | ${r.degradedLevel} | ${r.turns} | ${r.bargeIns} | ${r.sttProviderId ?? '-'} | ${r.ttsProviderId ?? '-'} | ${r.open} |`);
        }
        return lines.join('\n');
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  return [bargeInTool, turnTool, latencyTool, providersTool, sessionTool, statusTool, audioTool, reportTool];
}

export const VOICE_V26_TOOLS: Tool[] = createVoiceV26Tools();

export const VOICE_V26_TOOL_NAMES = [
  'voice_v26_bargein',
  'voice_v26_turn',
  'voice_v26_latency',
  'voice_v26_providers',
  'voice_v26_session',
  'voice_v26_status',
  'voice_v26_audio',
  'voice_v26_report',
] as const;

export function isVoiceV26ToolName(name: string): name is (typeof VOICE_V26_TOOL_NAMES)[number] {
  return (VOICE_V26_TOOL_NAMES as readonly string[]).includes(name);
}
