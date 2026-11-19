/**
 * Voice v25 tools for @open-bot/tools (v1.38, Đội T5).
 *
 * The agent drives the voice v25 conversation-flow stack by tool call:
 *  - voice_v25_bargein  — turn-level barge-in: register the agent
 *    reply being spoken, report a user-speech burst (v23 decides),
 *    finalise the stop (measured stop latency, spoken prefix,
 *    resume strategy), ducks, false positives, burst alerts
 *  - voice_v25_turns    — turn-taking floor machine + per-turn
 *    timers: user start / speech end / silence yield / agent
 *    reply / done / barge-in / backchannel / abandon /
 *    timeout check, live running turns with phase timers,
 *    per-session turn aggregates, slow-turn alerts
 *  - voice_v25_silence  — silence detection: feed frame energies
 *    or boolean VAD frames, speech/silence state, silence gaps,
 *    yield checks, per-turn silence statistics, markdown
 *  - voice_v25_latency  — real per-provider voice latency: record
 *    host-measured TTFT / first-audio / total samples, rolling
 *    p50/p95 per provider, fastest-first ranking, latency
 *    -threshold fallback recommendations with cooldown
 *  - voice_v25_session  — a live voice session: open, drive the
 *    whole turn flow (user/agent/barge-in/silence/latency/tool
 *    calls), apply a latency fallback, snapshot, close
 *  - voice_v25_panel    — turn panel snapshot / markdown for one
 *    session (running turns, finished-turn table, floor state,
 *    barge-ins, silence, provider latency, alerts)
 *  - voice_v25_report   — aggregate report across sessions: turn
 *    totals, barge-in counts, silence totals, latency ranking,
 *    fallback decisions, markdown
 *
 * SAFETY: everything here is local — clocks are virtual, audio
 * is mock/synthetic, latency samples and bursts are
 * caller-supplied measurements. No provider is dialled, no key
 * is read or stored, no mic or sound card is touched.
 *
 * Factory:
 *   createVoiceV25Tools(opts) -> Tool[]   (bound, usable)
 *   VOICE_V25_TOOLS                       (unbound placeholder, own
 *   default instances — mock sessions only)
 */
import type { Tool } from '@open-bot/core';
import {
  BargeInManagerV25,
  ProviderLatencyTrackerV25,
  SilenceDetectorV25,
  TurnPanelV25,
  TurnTakingManagerV25,
  TurnTimerRegistryV25,
  VoiceSessionV25,
  createBargeInManagerV25,
  createProviderLatencyTrackerV25,
  createSilenceDetectorV25,
  createTurnPanelV25,
  createTurnTakingManagerV25,
  createTurnTimerRegistryV25,
  formatDurationV25,
  type BargeInV25Options,
  type ProviderLatencyV25Options,
  type SilenceDetectorV25Options,
  type TurnPanelV25Options,
  type TurnTakingV25Options,
  type TurnTimerV25Options,
  type VoiceV25BargeInKind,
  type VoiceV25LatencyFallbackDecision,
} from '@open-bot/core';
import {
  DynamicProviderCatalogV24,
  createDynamicProviderCatalogV24,
  type VoiceV24ModelRef,
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

export interface VoiceV25ToolOptions {
  /** Shared dynamic provider catalogue accessor (for latency fallback). */
  getCatalog?: () => DynamicProviderCatalogV24 | null;
  /** Shared barge-in manager accessor (per session). */
  getBargeIn?: (sessionId: string) => BargeInManagerV25 | null;
  /** Shared turn-taking manager accessor (per session). */
  getTurnTaking?: (sessionId: string) => TurnTakingManagerV25 | null;
  /** Shared turn-timer registry accessor (per session). */
  getTurnTimers?: (sessionId: string) => TurnTimerRegistryV25 | null;
  /** Shared silence detector accessor (per session). */
  getSilence?: (sessionId: string) => SilenceDetectorV25 | null;
  /** Shared latency tracker accessor. */
  getLatency?: () => ProviderLatencyTrackerV25 | null;
  /** Shared panel accessor. */
  getPanel?: () => TurnPanelV25 | null;
  bargeInOptions?: Partial<BargeInV25Options>;
  turnTakingOptions?: Partial<TurnTakingV25Options>;
  timerOptions?: Partial<TurnTimerV25Options>;
  silenceOptions?: Partial<SilenceDetectorV25Options>;
  latencyOptions?: Partial<ProviderLatencyV25Options>;
  panelOptions?: Partial<TurnPanelV25Options>;
}

const BARGEIN_ACTIONS = ['speak', 'progress', 'report', 'stop', 'current', 'pending', 'list', 'ducks', 'stats', 'attach', 'false-positive', 'markdown', 'reset'] as const;
const TURNS_ACTIONS = ['user-start', 'speech-end', 'yield', 'agent-start', 'agent-done', 'barge-in', 'backchannel', 'abandon', 'timeout-check', 'current', 'list', 'stats', 'running', 'check', 'alerts', 'markdown', 'reset'] as const;
const SILENCE_ACTIONS = ['feed-energy', 'feed-speech', 'state', 'stats', 'gaps', 'yield-check', 'set-floor', 'end-turn', 'markdown', 'reset'] as const;
const LATENCY_ACTIONS = ['record', 'stats', 'rank', 'all', 'fallback', 'decisions', 'prune', 'markdown', 'reset'] as const;
const SESSION_ACTIONS = ['open', 'user-start', 'speech-end', 'yield', 'agent-start', 'agent-done', 'burst', 'stop', 'backchannel', 'feed-energy', 'feed-speech', 'latency', 'fallback', 'tool-start', 'tool-end', 'tool-fail', 'timeout-check', 'snapshot', 'close', 'summary', 'markdown'] as const;
const PANEL_ACTIONS = ['snapshot', 'markdown'] as const;
const REPORT_ACTIONS = ['summary', 'markdown'] as const;

function isAction(list: readonly string[], v: string): boolean {
  return (list as readonly string[]).includes(v);
}

export function createVoiceV25Tools(opts: VoiceV25ToolOptions = {}): Tool[] {
  const defaultCatalog = createDynamicProviderCatalogV24();
  const defaultLatency = createProviderLatencyTrackerV25(opts.latencyOptions);
  const defaultPanel = createTurnPanelV25(opts.panelOptions);
  const needCatalog = (): DynamicProviderCatalogV24 => opts.getCatalog?.() ?? defaultCatalog;
  const needLatency = (): ProviderLatencyTrackerV25 => opts.getLatency?.() ?? defaultLatency;
  const needPanel = (): TurnPanelV25 => opts.getPanel?.() ?? defaultPanel;
  /** Per-session managers, created on first use (own defaults). */
  const bargeIns = new Map<string, BargeInManagerV25>();
  const turnTakings = new Map<string, TurnTakingManagerV25>();
  const turnTimers = new Map<string, TurnTimerRegistryV25>();
  const silences = new Map<string, SilenceDetectorV25>();
  /** Live voice sessions opened through voice_v25_session. */
  const sessions = new Map<string, VoiceSessionV25>();

  const needBargeIn = (sessionId: string): BargeInManagerV25 => {
    const shared = opts.getBargeIn?.(sessionId);
    if (shared !== null && shared !== undefined) return shared;
    let found = bargeIns.get(sessionId);
    if (found === undefined) {
      found = createBargeInManagerV25(sessionId, opts.bargeInOptions ?? {});
      bargeIns.set(sessionId, found);
    }
    return found;
  };
  const needTurnTaking = (sessionId: string): TurnTakingManagerV25 => {
    const shared = opts.getTurnTaking?.(sessionId);
    if (shared !== null && shared !== undefined) return shared;
    let found = turnTakings.get(sessionId);
    if (found === undefined) {
      found = createTurnTakingManagerV25(sessionId, opts.turnTakingOptions ?? {});
      turnTakings.set(sessionId, found);
    }
    return found;
  };
  const needTurnTimers = (sessionId: string): TurnTimerRegistryV25 => {
    const shared = opts.getTurnTimers?.(sessionId);
    if (shared !== null && shared !== undefined) return shared;
    let found = turnTimers.get(sessionId);
    if (found === undefined) {
      found = createTurnTimerRegistryV25(opts.timerOptions ?? {});
      turnTimers.set(sessionId, found);
    }
    return found;
  };
  const needSilence = (sessionId: string): SilenceDetectorV25 => {
    const shared = opts.getSilence?.(sessionId);
    if (shared !== null && shared !== undefined) return shared;
    let found = silences.get(sessionId);
    if (found === undefined) {
      found = createSilenceDetectorV25(sessionId, opts.silenceOptions ?? {});
      silences.set(sessionId, found);
    }
    return found;
  };

  /**
   * Drive the floor machine and the timer registry together so
   * they always talk about the same turn (same id, same index).
   */
  const syncUserStart = (sessionId: string, atMs: number, text: string) => {
    const taking = needTurnTaking(sessionId);
    const transition = taking.userStarted(atMs, text);
    if (transition.ok && transition.turn !== null) {
      needTurnTimers(sessionId).startTurn(sessionId, 'user', atMs, {
        turnId: transition.turn.id,
        index: transition.turn.index,
        text,
      });
    }
    return transition;
  };
  const syncAgentStart = (sessionId: string, atMs: number, replyText: string, providerId: string | null, model: string | null) => {
    const taking = needTurnTaking(sessionId);
    const transition = taking.agentStartedReply(atMs, replyText, providerId, model);
    if (transition.ok && transition.turn !== null) {
      needTurnTimers(sessionId).startTurn(sessionId, 'assistant', atMs, {
        turnId: transition.turn.id,
        index: transition.turn.index,
        providerId,
        model,
        text: replyText,
      });
      needTurnTimers(sessionId).enterPhase(transition.turn.id, 'speaking', atMs);
    }
    return transition;
  };

  const bargeInTool: Tool = {
    definition: toolDef(
      'voice_v25_bargein',
      'Turn-level barge-in handling for a voice session (local action): register the agent reply being spoken, update TTS progress, report a user-speech burst (the v23 policy decides interrupt / duck / ignore), finalise the stop when the host reports the agent actually stopped (measured stop latency, spoken prefix, word-start rollback, resume strategy), attach the interrupting user turn, or mark a false positive. A burst shorter than minUserSpeechMs is ignored.',
      {
        action: { type: 'string', description: 'speak, progress, report, stop, current, pending, list, ducks, stats, attach, false-positive, markdown or reset.' },
        sessionId: { type: 'string', description: 'Voice session id.' },
        turnId: { type: 'string', description: 'Assistant turn id (speak / attach).' },
        turnIndex: { type: 'number', description: 'Assistant turn index (speak, optional, default 0).' },
        replyText: { type: 'string', description: 'Planned agent reply text (speak).' },
        spokenChars: { type: 'number', description: 'Chars the TTS engine has spoken (progress / stop).' },
        bargeInId: { type: 'string', description: 'Barge-in id (attach / false-positive).' },
        atMs: { type: 'number', description: 'Virtual clock in ms (default 0).' },
        atMsIntoReply: { type: 'number', description: 'ms into the current agent reply (report).' },
        energy: { type: 'number', description: 'Burst energy 0..1 (report).' },
        sustainMs: { type: 'number', description: 'ms of user speech in the burst (report).' },
        wordsJson: { type: 'string', description: 'Burst words as JSON array (report).' },
        echo: { type: 'string', description: '"true" when the burst is echo (report, optional).' },
        confidence: { type: 'number', description: 'Burst confidence 0..1 (report, optional).' },
        kind: { type: 'string', description: 'speech | backchannel-sustained | keyword | unknown (report, optional).' },
        userText: { type: 'string', description: 'What the user said to interrupt (report, optional).' },
      },
      ['action'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        if (!isAction(BARGEIN_ACTIONS, action)) return errorResult(`Unknown action "${action}" (${BARGEIN_ACTIONS.join(', ')})`);
        const sessionId = getStringArg(args, 'sessionId');
        const manager = needBargeIn(sessionId);
        const atMs = getOptionalNumberArg(args, 'atMs') ?? 0;
        if (action === 'reset') {
          manager.reset();
          return JSON.stringify({ ok: true, reset: true });
        }
        if (action === 'stats') {
          return JSON.stringify({ ok: true, ...manager.stats() });
        }
        if (action === 'list') {
          return JSON.stringify({ ok: true, bargeIns: manager.list() });
        }
        if (action === 'ducks') {
          return JSON.stringify({ ok: true, ducks: manager.ducksList() });
        }
        if (action === 'markdown') {
          return JSON.stringify({ ok: true, markdown: manager.markdown(), stats: manager.stats() });
        }
        if (action === 'current') {
          return JSON.stringify({ ok: true, speaking: manager.isAgentSpeaking(), reply: manager.currentReply(), pending: manager.pendingBargeIn() });
        }
        if (action === 'pending') {
          return JSON.stringify({ ok: true, pending: manager.pendingBargeIn() });
        }
        if (action === 'speak') {
          const turnId = getStringArg(args, 'turnId');
          const turnIndex = getOptionalNumberArg(args, 'turnIndex') ?? 0;
          manager.agentStartedSpeaking(turnId, turnIndex, getStringArg(args, 'replyText'), atMs);
          return JSON.stringify({ ok: true, speaking: true, reply: manager.currentReply() });
        }
        if (action === 'progress') {
          const spokenChars = getOptionalNumberArg(args, 'spokenChars');
          if (spokenChars === undefined) return errorResult('Missing required argument: "spokenChars"');
          manager.agentSpeechProgress(atMs, spokenChars);
          return JSON.stringify({ ok: true, reply: manager.currentReply() });
        }
        if (action === 'report') {
          const words = parseStringArray(getOptionalStringArg(args, 'wordsJson'), 'wordsJson');
          const result = manager.reportBurst({
            atMs,
            atMsIntoReply: getOptionalNumberArg(args, 'atMsIntoReply') ?? 0,
            energy: getOptionalNumberArg(args, 'energy') ?? 0.5,
            sustainMs: getOptionalNumberArg(args, 'sustainMs') ?? 0,
            words,
            echo: getOptionalBooleanArg(args, 'echo'),
            confidence: getOptionalNumberArg(args, 'confidence'),
            kind: getOptionalStringArg(args, 'kind') as VoiceV25BargeInKind | undefined,
            userText: getOptionalStringArg(args, 'userText'),
          });
          return JSON.stringify({ ok: true, ...result });
        }
        if (action === 'stop') {
          const spokenChars = getOptionalNumberArg(args, 'spokenChars');
          if (spokenChars === undefined) return errorResult('Missing required argument: "spokenChars"');
          const result = manager.agentStopped(atMs, spokenChars);
          if (result === null) return errorResult('No barge-in pending — report a burst first');
          return JSON.stringify({ ok: true, ...result });
        }
        if (action === 'attach') {
          const attached = manager.attachInterruptingTurn(getStringArg(args, 'bargeInId'), getStringArg(args, 'turnId'));
          if (!attached) return errorResult(`No barge-in "${getStringArg(args, 'bargeInId')}"`);
          return JSON.stringify({ ok: true, attached: true, bargeIn: manager.get(getStringArg(args, 'bargeInId')) });
        }
        // false-positive
        const marked = manager.markFalsePositive(getStringArg(args, 'bargeInId'));
        if (!marked) return errorResult(`No barge-in "${getStringArg(args, 'bargeInId')}"`);
        return JSON.stringify({ ok: true, marked: true, bargeIn: manager.get(getStringArg(args, 'bargeInId')) });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const turnsTool: Tool = {
    definition: toolDef(
      'voice_v25_turns',
      'Turn-taking floor machine + per-voice-turn timers (local action): open a user turn, end user speech (silence-wait starts), yield the floor to the agent, start/finish an agent reply, cut the reply on a barge-in, note a backchannel, abandon a turn, check timeouts, or read the live running turns (elapsed time + current phase), per-session turn aggregates (mean/p95, think/speak/listen/silence-wait), slow-turn alerts, and a markdown turn table.',
      {
        action: { type: 'string', description: 'user-start, speech-end, yield, agent-start, agent-done, barge-in, backchannel, abandon, timeout-check, current, list, stats, running, check, alerts, markdown or reset.' },
        sessionId: { type: 'string', description: 'Voice session id.' },
        text: { type: 'string', description: 'Turn text (user-start / agent-start / backchannel).' },
        providerId: { type: 'string', description: 'Provider serving the reply (agent-start, optional).' },
        model: { type: 'string', description: 'Model serving the reply (agent-start, optional).' },
        bargeInId: { type: 'string', description: 'Barge-in id cutting the reply (barge-in).' },
        turnId: { type: 'string', description: 'Turn id (barge-in record / markdown rows use it internally).' },
        spokenText: { type: 'string', description: 'Spoken prefix of the cut reply (barge-in).' },
        spokenChars: { type: 'number', description: 'Chars spoken before the cut (barge-in).' },
        atMs: { type: 'number', description: 'Virtual clock in ms (default 0).' },
      },
      ['action'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        if (!isAction(TURNS_ACTIONS, action)) return errorResult(`Unknown action "${action}" (${TURNS_ACTIONS.join(', ')})`);
        const sessionId = getStringArg(args, 'sessionId');
        const taking = needTurnTaking(sessionId);
        const timers = needTurnTimers(sessionId);
        const atMs = getOptionalNumberArg(args, 'atMs') ?? 0;
        if (action === 'reset') {
          taking.reset();
          timers.reset();
          return JSON.stringify({ ok: true, reset: true });
        }
        if (action === 'stats') {
          return JSON.stringify({ ok: true, taking: taking.stats(), timers: timers.sessionStats(sessionId) });
        }
        if (action === 'list') {
          return JSON.stringify({ ok: true, turns: timers.list({ sessionId }) });
        }
        if (action === 'current') {
          return JSON.stringify({ ok: true, state: taking.stateOf(), floor: taking.floorHolder(), turn: taking.currentTurnRecord(), running: timers.running(sessionId, atMs) });
        }
        if (action === 'running') {
          return JSON.stringify({ ok: true, running: timers.running(sessionId, atMs) });
        }
        if (action === 'check') {
          const raised = timers.checkRunning(atMs);
          return JSON.stringify({ ok: true, raised, alerts: timers.alertsList(sessionId) });
        }
        if (action === 'alerts') {
          return JSON.stringify({ ok: true, alerts: timers.alertsList(sessionId) });
        }
        if (action === 'markdown') {
          return JSON.stringify({ ok: true, markdown: timers.markdown(sessionId), stats: timers.sessionStats(sessionId) });
        }
        if (action === 'user-start') {
          const transition = syncUserStart(sessionId, atMs, getOptionalStringArg(args, 'text') ?? '');
          if (!transition.ok) return errorResult(transition.reason ?? 'user-start failed');
          return JSON.stringify({ ...transition });
        }
        if (action === 'speech-end') {
          const before = taking.currentTurnRecord();
          const transition = taking.userSpeechEnded(atMs);
          if (!transition.ok) return errorResult(transition.reason ?? 'speech-end failed');
          if (before !== null) timers.enterPhase(before.id, 'silence-wait', atMs);
          return JSON.stringify({ ...transition });
        }
        if (action === 'yield') {
          const before = taking.currentTurnRecord();
          const transition = taking.silenceYielded(atMs);
          if (!transition.ok) return errorResult(transition.reason ?? 'yield failed');
          if (before !== null) timers.endTurn(before.id, atMs);
          return JSON.stringify({ ...transition });
        }
        if (action === 'agent-start') {
          const transition = syncAgentStart(
            sessionId,
            atMs,
            getStringArg(args, 'text'),
            getOptionalStringArg(args, 'providerId') ?? null,
            getOptionalStringArg(args, 'model') ?? null,
          );
          if (!transition.ok) return errorResult(transition.reason ?? 'agent-start failed');
          return JSON.stringify({ ...transition });
        }
        if (action === 'agent-done') {
          const before = taking.currentTurnRecord();
          const transition = taking.agentFinishedReply(atMs);
          if (!transition.ok) return errorResult(transition.reason ?? 'agent-done failed');
          if (before !== null) timers.endTurn(before.id, atMs);
          return JSON.stringify({ ...transition });
        }
        if (action === 'barge-in') {
          const before = taking.currentTurnRecord();
          const transition = taking.bargeIn(atMs, getStringArg(args, 'bargeInId'));
          if (!transition.ok) return errorResult(transition.reason ?? 'barge-in failed');
          if (before !== null) {
            timers.interruptTurn(
              before.id,
              atMs,
              getStringArg(args, 'bargeInId'),
              getOptionalStringArg(args, 'spokenText') ?? before.text,
              getOptionalNumberArg(args, 'spokenChars') ?? before.spokenChars ?? 0,
            );
          }
          return JSON.stringify({ ...transition });
        }
        if (action === 'backchannel') {
          const noted = taking.userBackchannel(atMs, getStringArg(args, 'text'));
          return JSON.stringify({ ok: true, noted, backchannels: taking.backchannelsList() });
        }
        if (action === 'abandon') {
          const before = taking.currentTurnRecord();
          const transition = taking.abandonTurn(atMs);
          if (!transition.ok) return errorResult(transition.reason ?? 'abandon failed');
          if (before !== null) timers.abandonTurn(before.id, atMs);
          return JSON.stringify({ ...transition });
        }
        // timeout-check
        const timedOut = taking.timeoutCheck(atMs);
        if (timedOut !== null) timers.timeoutTurn(timedOut.id, atMs);
        return JSON.stringify({ ok: true, timedOut, state: taking.stateOf(), floor: taking.floorHolder() });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const silenceTool: Tool = {
    definition: toolDef(
      'voice_v25_silence',
      'Silence detection for turn-taking (local action): feed frame energies (0..1 RMS, mock/synthetic) or boolean VAD frames from the host, read the current speech/silence state and noise floor, list silence gaps, check whether the current silence has yielded the floor, set the noise floor directly, end the turn (closes the open gap), or render silence statistics / markdown. Short blips never flip the state.',
      {
        action: { type: 'string', description: 'feed-energy, feed-speech, state, stats, gaps, yield-check, set-floor, end-turn, markdown or reset.' },
        sessionId: { type: 'string', description: 'Voice session id.' },
        energy: { type: 'number', description: 'Frame energy 0..1 (feed-energy).' },
        isSpeech: { type: 'string', description: '"true" when the frame is speech (feed-speech).' },
        turnId: { type: 'string', description: 'Turn the frame belongs to (feed-energy / feed-speech / gaps, optional).' },
        noiseFloor: { type: 'number', description: 'Noise floor 0..0.5 (set-floor).' },
        atMs: { type: 'number', description: 'Virtual clock in ms (default 0).' },
      },
      ['action'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        if (!isAction(SILENCE_ACTIONS, action)) return errorResult(`Unknown action "${action}" (${SILENCE_ACTIONS.join(', ')})`);
        const sessionId = getStringArg(args, 'sessionId');
        const detector = needSilence(sessionId);
        const atMs = getOptionalNumberArg(args, 'atMs') ?? 0;
        if (action === 'reset') {
          detector.reset();
          return JSON.stringify({ ok: true, reset: true });
        }
        if (action === 'state') {
          return JSON.stringify({ ok: true, state: detector.stateOf(), noiseFloor: detector.noiseFloorOf(), threshold: detector.thresholdOf(), currentSilenceMs: detector.currentSilenceMs(atMs) });
        }
        if (action === 'stats') {
          return JSON.stringify({ ok: true, ...detector.stats(getOptionalStringArg(args, 'turnId'), atMs) });
        }
        if (action === 'gaps') {
          return JSON.stringify({ ok: true, gaps: detector.gapsList(getOptionalStringArg(args, 'turnId')) });
        }
        if (action === 'yield-check') {
          return JSON.stringify({ ok: true, shouldYield: detector.shouldYield(atMs), currentSilenceMs: detector.currentSilenceMs(atMs) });
        }
        if (action === 'markdown') {
          return JSON.stringify({ ok: true, markdown: detector.markdown(getOptionalStringArg(args, 'turnId'), atMs), stats: detector.stats(getOptionalStringArg(args, 'turnId'), atMs) });
        }
        if (action === 'set-floor') {
          const noiseFloor = getOptionalNumberArg(args, 'noiseFloor');
          if (noiseFloor === undefined) return errorResult('Missing required argument: "noiseFloor"');
          detector.setNoiseFloor(noiseFloor);
          return JSON.stringify({ ok: true, noiseFloor: detector.noiseFloorOf(), threshold: detector.thresholdOf() });
        }
        if (action === 'end-turn') {
          const events = detector.endTurn(atMs, getOptionalStringArg(args, 'turnId'));
          return JSON.stringify({ ok: true, events, state: detector.stateOf() });
        }
        const turnId = getOptionalStringArg(args, 'turnId') ?? null;
        if (action === 'feed-energy') {
          const energy = getOptionalNumberArg(args, 'energy');
          if (energy === undefined) return errorResult('Missing required argument: "energy"');
          const events = detector.feedEnergy(energy, atMs, turnId);
          return JSON.stringify({ ok: true, events, state: detector.stateOf(), currentSilenceMs: detector.currentSilenceMs(atMs) });
        }
        // feed-speech
        const isSpeech = getOptionalBooleanArg(args, 'isSpeech');
        if (isSpeech === undefined) return errorResult('Missing required argument: "isSpeech"');
        const events = detector.feedSpeech(isSpeech, atMs, turnId);
        return JSON.stringify({ ok: true, events, state: detector.stateOf(), currentSilenceMs: detector.currentSilenceMs(atMs) });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const latencyTool: Tool = {
    definition: toolDef(
      'voice_v25_latency',
      'Real per-provider voice latency (local action): record a host-measured latency sample (TTFT / first-audio / turn total, ok or failed), read rolling statistics per provider (mean / p50 / p95 per kind, consecutive slow / failed turns, slow/failing flags), rank providers fastest-first by p95 total, ask for a latency-threshold fallback recommendation (with per-session cooldown, never picks a slow/failing provider), list fallback decisions, prune old samples, or render markdown. No samples means no stats, never a made-up p95.',
      {
        action: { type: 'string', description: 'record, stats, rank, all, fallback, decisions, prune, markdown or reset.' },
        providerId: { type: 'string', description: 'Provider id.' },
        model: { type: 'string', description: 'Model id (record).' },
        sessionId: { type: 'string', description: 'Voice session id (record / fallback / decisions).' },
        turnId: { type: 'string', description: 'Turn id (record, optional).' },
        ttftMs: { type: 'number', description: 'ms to first token (record, optional).' },
        firstAudioMs: { type: 'number', description: 'ms to first audio frame (record, optional).' },
        totalMs: { type: 'number', description: 'ms for the whole turn (record, optional).' },
        ok: { type: 'string', description: '"true" when the turn succeeded (record).' },
        error: { type: 'string', description: 'Error text (record, optional).' },
        candidatesJson: { type: 'string', description: 'Candidate provider ids as JSON array (fallback).' },
        olderThanMs: { type: 'number', description: 'Prune samples older than this (prune).' },
        atMs: { type: 'number', description: 'Virtual clock in ms (default 0).' },
      },
      ['action'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        if (!isAction(LATENCY_ACTIONS, action)) return errorResult(`Unknown action "${action}" (${LATENCY_ACTIONS.join(', ')})`);
        const tracker = needLatency();
        const atMs = getOptionalNumberArg(args, 'atMs') ?? 0;
        if (action === 'reset') {
          tracker.reset();
          return JSON.stringify({ ok: true, reset: true });
        }
        if (action === 'rank') {
          const sessionId = getOptionalStringArg(args, 'sessionId');
          return JSON.stringify({ ok: true, ranking: tracker.rankProviders(sessionId), summary: tracker.summary(sessionId) });
        }
        if (action === 'all') {
          const sessionId = getOptionalStringArg(args, 'sessionId');
          return JSON.stringify({ ok: true, providers: tracker.allStats(sessionId), summary: tracker.summary(sessionId) });
        }
        if (action === 'markdown') {
          const sessionId = getOptionalStringArg(args, 'sessionId');
          return JSON.stringify({ ok: true, markdown: tracker.markdown(sessionId), summary: tracker.summary(sessionId) });
        }
        if (action === 'prune') {
          const olderThanMs = getOptionalNumberArg(args, 'olderThanMs');
          if (olderThanMs === undefined) return errorResult('Missing required argument: "olderThanMs"');
          return JSON.stringify({ ok: true, dropped: tracker.prune(atMs, olderThanMs), samples: tracker.count() });
        }
        if (action === 'decisions') {
          const sessionId = getStringArg(args, 'sessionId');
          return JSON.stringify({ ok: true, sessionId, decisions: tracker.decisionsFor(sessionId) });
        }
        if (action === 'stats') {
          const providerId = getStringArg(args, 'providerId');
          const stats = tracker.stats(providerId, getOptionalStringArg(args, 'sessionId'));
          if (stats === null) return errorResult(`No latency samples for provider "${providerId}"`);
          return JSON.stringify({ ok: true, ...stats });
        }
        if (action === 'fallback') {
          const sessionId = getStringArg(args, 'sessionId');
          const currentProviderId = getStringArg(args, 'providerId');
          const candidates = parseStringArray(getOptionalStringArg(args, 'candidatesJson'), 'candidatesJson');
          const decision: VoiceV25LatencyFallbackDecision = tracker.recommendFallback(sessionId, currentProviderId, candidates, atMs);
          return JSON.stringify({ ok: true, ...decision });
        }
        // record
        const ok = getOptionalBooleanArg(args, 'ok');
        if (ok === undefined) return errorResult('Missing required argument: "ok"');
        const sample = tracker.record({
          providerId: getStringArg(args, 'providerId'),
          model: getStringArg(args, 'model'),
          sessionId: getStringArg(args, 'sessionId'),
          turnId: getOptionalStringArg(args, 'turnId'),
          atMs,
          ttftMs: getOptionalNumberArg(args, 'ttftMs'),
          firstAudioMs: getOptionalNumberArg(args, 'firstAudioMs'),
          totalMs: getOptionalNumberArg(args, 'totalMs'),
          ok,
          error: getOptionalStringArg(args, 'error'),
        });
        return JSON.stringify({ ok: true, sample, stats: tracker.stats(sample.providerId, sample.sessionId) });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const sessionTool: Tool = {
    definition: toolDef(
      'voice_v25_session',
      'A live voice session with the full v25 flow (local action): open a session on a model, drive user/agent turns (user-start, speech-end, yield, agent-start, agent-done), report a barge-in burst and finalise the stop, note a backchannel, feed silence frames (yields drive the floor automatically), record host-measured latency, apply a latency fallback (moves the session to a faster provider from the dynamic catalogue), run tool calls inside the current turn, check timeouts, read a snapshot, close the session (running turns abandoned), or render summary/markdown. No provider is dialled.',
      {
        action: { type: 'string', description: 'open, user-start, speech-end, yield, agent-start, agent-done, burst, stop, backchannel, feed-energy, feed-speech, latency, fallback, tool-start, tool-end, tool-fail, timeout-check, snapshot, close, summary or markdown.' },
        sessionId: { type: 'string', description: 'Voice session id.' },
        providerId: { type: 'string', description: 'Initial provider id (open).' },
        model: { type: 'string', description: 'Initial model id (open).' },
        text: { type: 'string', description: 'Turn text (user-start / agent-start / backchannel).' },
        replyText: { type: 'string', description: 'Planned agent reply text (agent-start).' },
        bargeInId: { type: 'string', description: 'Barge-in id (stop / attach uses the pending one).' },
        turnId: { type: 'string', description: 'Turn id (burst attach / tool context).' },
        toolName: { type: 'string', description: 'Tool name (tool-start).' },
        callId: { type: 'string', description: 'Tool-call timer id (tool-end / tool-fail).' },
        error: { type: 'string', description: 'Error text (tool-fail / latency).' },
        energy: { type: 'number', description: 'Frame energy 0..1 (feed-energy).' },
        isSpeech: { type: 'string', description: '"true" when the frame is speech (feed-speech).' },
        atMsIntoReply: { type: 'number', description: 'ms into the current agent reply (burst).' },
        sustainMs: { type: 'number', description: 'ms of user speech in the burst (burst).' },
        wordsJson: { type: 'string', description: 'Burst words as JSON array (burst).' },
        echo: { type: 'string', description: '"true" when the burst is echo (burst, optional).' },
        userText: { type: 'string', description: 'What the user said to interrupt (burst, optional).' },
        spokenChars: { type: 'number', description: 'Chars spoken before the stop (stop).' },
        ttftMs: { type: 'number', description: 'ms to first token (latency, optional).' },
        firstAudioMs: { type: 'number', description: 'ms to first audio frame (latency, optional).' },
        totalMs: { type: 'number', description: 'ms for the whole turn (latency, optional).' },
        ok: { type: 'string', description: '"true" when the turn succeeded (latency).' },
        atMs: { type: 'number', description: 'Virtual clock in ms (default 0).' },
      },
      ['action'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        if (!isAction(SESSION_ACTIONS, action)) return errorResult(`Unknown action "${action}" (${SESSION_ACTIONS.join(', ')})`);
        const atMs = getOptionalNumberArg(args, 'atMs') ?? 0;
        const sessionId = getStringArg(args, 'sessionId');
        if (action === 'open') {
          if (sessions.has(sessionId)) return errorResult(`Session "${sessionId}" is already open`);
          const initial: VoiceV24ModelRef = {
            providerId: getStringArg(args, 'providerId'),
            model: getStringArg(args, 'model'),
          };
          const session = VoiceSessionV25.open(sessionId, initial, needCatalog(), atMs);
          sessions.set(sessionId, session);
          return JSON.stringify({ ok: true, snapshot: session.snapshot(atMs) });
        }
        const session = sessions.get(sessionId);
        if (session === undefined) return errorResult(`No session "${sessionId}" — open it first`);
        if (action === 'snapshot') {
          return JSON.stringify({ ok: true, ...session.snapshot(atMs) });
        }
        if (action === 'summary') {
          return JSON.stringify({ ok: true, summary: session.summary(atMs), snapshot: session.snapshot(atMs) });
        }
        if (action === 'markdown') {
          return JSON.stringify({ ok: true, markdown: session.markdown(atMs) });
        }
        if (action === 'user-start') {
          const transition = session.userStarted(atMs, getOptionalStringArg(args, 'text') ?? '');
          if (!transition.ok) return errorResult(transition.reason ?? 'user-start failed');
          return JSON.stringify({ ...transition });
        }
        if (action === 'speech-end') {
          const transition = session.userSpeechEnded(atMs);
          if (!transition.ok) return errorResult(transition.reason ?? 'speech-end failed');
          return JSON.stringify({ ...transition });
        }
        if (action === 'yield') {
          const transition = session.silenceYielded(atMs);
          if (!transition.ok) return errorResult(transition.reason ?? 'yield failed');
          return JSON.stringify({ ...transition });
        }
        if (action === 'agent-start') {
          const transition = session.agentStartedReply(atMs, getStringArg(args, 'replyText'));
          if (!transition.ok) return errorResult(transition.reason ?? 'agent-start failed');
          return JSON.stringify({ ...transition });
        }
        if (action === 'agent-done') {
          const transition = session.agentFinishedReply(atMs);
          if (!transition.ok) return errorResult(transition.reason ?? 'agent-done failed');
          return JSON.stringify({ ...transition });
        }
        if (action === 'burst') {
          const words = parseStringArray(getOptionalStringArg(args, 'wordsJson'), 'wordsJson');
          const result = session.reportBurst({
            atMs,
            atMsIntoReply: getOptionalNumberArg(args, 'atMsIntoReply') ?? 0,
            energy: getOptionalNumberArg(args, 'energy') ?? 0.5,
            sustainMs: getOptionalNumberArg(args, 'sustainMs') ?? 0,
            words,
            echo: getOptionalBooleanArg(args, 'echo'),
            userText: getOptionalStringArg(args, 'userText'),
          });
          return JSON.stringify({ ok: true, ...result });
        }
        if (action === 'stop') {
          const spokenChars = getOptionalNumberArg(args, 'spokenChars');
          if (spokenChars === undefined) return errorResult('Missing required argument: "spokenChars"');
          const result = session.agentStopped(atMs, spokenChars);
          if (result === null) return errorResult('No barge-in pending — report a burst first');
          return JSON.stringify({ ok: true, ...result });
        }
        if (action === 'backchannel') {
          const noted = session.userBackchannel(atMs, getStringArg(args, 'text'));
          return JSON.stringify({ ok: true, noted });
        }
        if (action === 'feed-energy') {
          const energy = getOptionalNumberArg(args, 'energy');
          if (energy === undefined) return errorResult('Missing required argument: "energy"');
          const events = session.feedEnergy(energy, atMs);
          return JSON.stringify({ ok: true, events, snapshot: session.snapshot(atMs) });
        }
        if (action === 'feed-speech') {
          const isSpeech = getOptionalBooleanArg(args, 'isSpeech');
          if (isSpeech === undefined) return errorResult('Missing required argument: "isSpeech"');
          const events = session.feedSpeech(isSpeech, atMs);
          return JSON.stringify({ ok: true, events, snapshot: session.snapshot(atMs) });
        }
        if (action === 'latency') {
          const ok = getOptionalBooleanArg(args, 'ok');
          if (ok === undefined) return errorResult('Missing required argument: "ok"');
          const current = session.currentModelRef();
          const sample = session.recordLatency({
            providerId: current.providerId,
            model: current.model,
            atMs,
            ttftMs: getOptionalNumberArg(args, 'ttftMs'),
            firstAudioMs: getOptionalNumberArg(args, 'firstAudioMs'),
            totalMs: getOptionalNumberArg(args, 'totalMs'),
            ok,
            error: getOptionalStringArg(args, 'error'),
          });
          return JSON.stringify({ ok: true, sample, stats: session.latencyTracker().stats(current.providerId, sessionId) });
        }
        if (action === 'fallback') {
          const decision = session.applyLatencyFallback(atMs);
          return JSON.stringify({ ok: true, ...decision, currentModel: session.currentModelRef() });
        }
        if (action === 'tool-start') {
          const callId = session.startToolCall(getStringArg(args, 'toolName'), atMs);
          return JSON.stringify({ ok: true, callId });
        }
        if (action === 'tool-end') {
          session.endToolCall(getStringArg(args, 'callId'), atMs);
          return JSON.stringify({ ok: true, ended: true });
        }
        if (action === 'tool-fail') {
          session.failToolCall(getStringArg(args, 'callId'), atMs, getStringArg(args, 'error'));
          return JSON.stringify({ ok: true, failed: true });
        }
        if (action === 'timeout-check') {
          const timedOut = session.timeoutCheck(atMs);
          return JSON.stringify({ ok: true, timedOut, snapshot: session.snapshot(atMs) });
        }
        // close
        const closed = session.close(atMs);
        return JSON.stringify({ ok: true, ...closed, snapshot: session.snapshot(atMs) });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const panelTool: Tool = {
    definition: toolDef(
      'voice_v25_panel',
      'Voice v25 turn panel (local action): snapshot or markdown for one session — live running turns with elapsed time and current phase, the finished-turn table (listen / silence-wait / think / speak / silence / tool time per turn), the floor state, barge-ins with stop latency and resume strategy, silence statistics, and the provider latency ranking. Uses the shared turn timers / turn-taking / barge-in / silence / latency of the session.',
      {
        action: { type: 'string', description: 'snapshot or markdown.' },
        sessionId: { type: 'string', description: 'Voice session id.' },
        atMs: { type: 'number', description: 'Virtual clock in ms (default 0).' },
      },
      ['action'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        if (!isAction(PANEL_ACTIONS, action)) return errorResult(`Unknown action "${action}" (${PANEL_ACTIONS.join(', ')})`);
        const sessionId = getStringArg(args, 'sessionId');
        const atMs = getOptionalNumberArg(args, 'atMs') ?? 0;
        const panel = needPanel();
        const snapshot = panel.snapshot({
          sessionId,
          timers: needTurnTimers(sessionId),
          atMs,
          turnTaking: needTurnTaking(sessionId),
          bargeIn: needBargeIn(sessionId),
          silence: needSilence(sessionId),
          latency: needLatency(),
        });
        if (action === 'markdown') {
          return JSON.stringify({ ok: true, markdown: panel.markdown(snapshot), snapshot });
        }
        return JSON.stringify({ ok: true, ...snapshot, summary: panel.summary(snapshot) });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const reportTool: Tool = {
    definition: toolDef(
      'voice_v25_report',
      'Aggregate voice v25 report (local action): totals across all sessions opened through voice_v25_session and all standalone managers — turn counts and durations, barge-in counts and stop latencies, silence totals, the provider latency ranking, and fallback decisions. Summary text or markdown.',
      {
        action: { type: 'string', description: 'summary or markdown.' },
        atMs: { type: 'number', description: 'Virtual clock in ms (default 0).' },
      },
      ['action'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const action = getStringArg(args, 'action');
        if (!isAction(REPORT_ACTIONS, action)) return errorResult(`Unknown action "${action}" (${REPORT_ACTIONS.join(', ')})`);
        const atMs = getOptionalNumberArg(args, 'atMs') ?? 0;
        const latency = needLatency();
        let turns = 0;
        let interrupted = 0;
        let totalMs = 0;
        let bargeInCount = 0;
        let ducks = 0;
        let silenceMs = 0;
        for (const timers of turnTimers.values()) {
          for (const t of timers.list()) {
            turns += 1;
            if (t.status === 'interrupted') interrupted += 1;
            totalMs += t.durationMs ?? 0;
            silenceMs += t.silenceMs;
          }
        }
        for (const manager of bargeIns.values()) {
          const s = manager.stats();
          bargeInCount += s.interruptions;
          ducks += s.ducks;
        }
        const sessionSummaries = [...sessions.values()].map((s) => ({
          sessionId: s.sessionId,
          phase: s.phaseOf(),
          currentModel: s.currentModelRef(),
          transcriptTurns: s.transcriptCount(),
          timers: s.turnTimerRegistry().sessionStats(s.sessionId),
        }));
        const report = {
          atMs,
          turns: { total: turns, interrupted, totalMs, totalFormatted: formatDurationV25(totalMs), silenceMs, silenceFormatted: formatDurationV25(silenceMs) },
          bargeIns: { interruptions: bargeInCount, ducks },
          latency: { ranking: latency.rankProviders(), summary: latency.summary() },
          sessions: sessionSummaries,
          fallbackDecisions: [...sessions.values()].flatMap((s) => latency.decisionsFor(s.sessionId)),
        };
        if (action === 'markdown') {
          const lines: string[] = ['# Voice v25 report', '', `At ${atMs}ms.`];
          lines.push(
            `Turns: ${turns} (${interrupted} interrupted, ${formatDurationV25(totalMs)} total turn time, ${formatDurationV25(silenceMs)} silence inside turns).`,
          );
          lines.push(`Barge-ins: ${bargeInCount} interruptions, ${ducks} ducks.`);
          lines.push(`Latency: ${latency.summary()}`);
          lines.push(`Sessions: ${sessionSummaries.length}.`);
          for (const s of sessionSummaries) {
            lines.push(`- ${s.sessionId} (${s.phase}): ${s.currentModel.providerId}/${s.currentModel.model}, ${s.transcriptTurns} transcript turns, ${s.timers.turns} turns, ${s.timers.interrupted} interrupted.`);
          }
          return JSON.stringify({ ok: true, markdown: lines.join('\n'), ...report });
        }
        return JSON.stringify({ ok: true, ...report });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };

  return [bargeInTool, turnsTool, silenceTool, latencyTool, sessionTool, panelTool, reportTool];
}

/** Unbound placeholder (own default instances — mock sessions only). */
export const VOICE_V25_TOOLS: Tool[] = createVoiceV25Tools();

export const VOICE_V25_TOOL_NAMES = [
  'voice_v25_bargein',
  'voice_v25_turns',
  'voice_v25_silence',
  'voice_v25_latency',
  'voice_v25_session',
  'voice_v25_panel',
  'voice_v25_report',
] as const;

export function isVoiceV25ToolName(name: string): name is (typeof VOICE_V25_TOOL_NAMES)[number] {
  return (VOICE_V25_TOOL_NAMES as readonly string[]).includes(name);
}
