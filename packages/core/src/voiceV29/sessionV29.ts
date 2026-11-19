/**
 * Full-duplex session v29 (v1.42, Team T4).
 *
 * The orchestrator that ties the v29 pieces into one
 * conversation: the audio turn detector watches the mic
 * frames, the barge-in engine owns the server-driven
 * responses, the append-only context keeps the history,
 * the delegated runner executes tool calls off the voice
 * path, proactive audio lets the agent speak first, the
 * cascaded pipeline measures every turn against its
 * latency budget, and the cost ledger meters every
 * minute.
 *
 * Rules the session enforces:
 *
 *   - only the server creates or cancels a response
 *     (`serverRespond` / barge-in engine). The client
 *     side can only *request* an interruption.
 *   - the floor belongs to exactly one side at a time;
 *     a barge-in hands it to the user, a server response
 *     hands it to the agent.
 *   - the context is append-only: turns, tool calls and
 *     proactive utterances are appended, never edited.
 *   - cost is metered per second of audio in/out; a
 *     capped session keeps talking but stops billing.
 *
 * The audio transport is v28's mock transport, reused by
 * import (v28 itself is untouched): mic frames go in as
 * synthetic tone chunks, agent speech goes out the same
 * way, so chunk counts and latency stats stay honest.
 * All clocks virtual (the caller passes `atMs`); no mic,
 * no speaker, no provider, no key, no live API.
 */

import {
  VOICE_V29_MAX_LOG_EVENTS_DEFAULT,
  VOICE_V29_STATE_TRANSITIONS,
  clampV29,
  isKnownModelV29,
  modelInfoV29,
  type VoiceV29Architecture,
  type VoiceV29AudioFrame,
  type VoiceV29BargeInConfig,
  type VoiceV29InterruptDecision,
  type VoiceV29InterruptRequester,
  type VoiceV29ModelId,
  type VoiceV29PipelineMode,
  type VoiceV29ServerResponse,
  type VoiceV29SessionLogEvent,
  type VoiceV29SessionSnapshot,
  type VoiceV29SessionState,
  type VoiceV29Turn,
  type VoiceV29DelegatedCall,
  type VoiceV29ProactiveKind,
  type VoiceV29TurnDetectorConfig,
  type VoiceV29TurnFrameResult,
} from './types';
import { AudioTurnDetectorV29, type AudioTurnDetectorV29Options } from './turnDetectorV29';
import { BargeInEngineV29, type BargeInEngineV29Options } from './bargeInV29';
import { AppendOnlyContextV29, type AppendOnlyContextV29Options } from './appendOnlyContextV29';
import { DelegatedToolRunnerV29, type DelegatedToolRunnerV29Options } from './delegatedToolsV29';
import { ProactiveAudioV29, type ProactiveAudioV29Options } from './proactiveAudioV29';
import { CascadedPipelineV29, type CascadedPipelineV29Options, type VoiceV29MeasuredStages } from './cascadedPipelineV29';
import { CostLedgerV29, type CostLedgerV29Options } from './costAccountingV29';
import {
  MockRealtimeTransportV28,
  createMockRealtimeTransportV28,
  synthToneChunkV28,
  type MockRealtimeTransportV28Options,
} from '../voiceV28/transportV28';

export interface FullDuplexSessionV29Options {
  sessionId?: string;
  botId?: string | null;
  modelId?: VoiceV29ModelId;
  turnDetector?: Partial<VoiceV29TurnDetectorConfig>;
  bargeIn?: Partial<VoiceV29BargeInConfig>;
  context?: AppendOnlyContextV29Options;
  delegate?: DelegatedToolRunnerV29Options;
  proactive?: ProactiveAudioV29Options;
  pipeline?: CascadedPipelineV29Options;
  cost?: CostLedgerV29Options;
  transport?: MockRealtimeTransportV28Options;
  /** Max session log events kept. */
  maxLogEvents?: number;
  /** Called when a delegated call result lands in the context. */
  onDelegatedResult?: (call: VoiceV29DelegatedCall) => void;
}

export interface VoiceV29SessionStats {
  state: VoiceV29SessionState;
  floor: VoiceV29SessionSnapshot['floor'];
  turns: number;
  backchannels: number;
  interruptions: number;
  ignoredInterruptions: number;
  contextItems: number;
  contextTokens: number;
  delegatedDone: number;
  delegatedFailed: number;
  proactiveFired: number;
  pipelineP95Ms: number;
  pipelineWithinBudgetPct: number;
  costUsd: number;
  minutesBilled: number;
  chunksIn: number;
  chunksOut: number;
  chunksDropped: number;
  transportLatencyP50Ms: number | null;
}

export function defaultFullDuplexSessionV29Options(): FullDuplexSessionV29Options {
  return { sessionId: '', botId: null, modelId: 'mock-cascaded' };
}

export class FullDuplexSessionV29 {
  readonly sessionId: string;
  readonly botId: string | null;
  readonly modelId: VoiceV29ModelId;
  readonly architecture: VoiceV29Architecture;

  readonly turnDetector: AudioTurnDetectorV29;
  readonly bargeIn: BargeInEngineV29;
  readonly context: AppendOnlyContextV29;
  readonly delegate: DelegatedToolRunnerV29;
  readonly proactive: ProactiveAudioV29;
  readonly pipeline: CascadedPipelineV29;
  readonly costs: CostLedgerV29;
  readonly transport: MockRealtimeTransportV28;

  private state: VoiceV29SessionState = 'idle';
  private floor: VoiceV29SessionSnapshot['floor'] = 'none';
  private readonly logEvents: VoiceV29SessionLogEvent[] = [];
  private readonly maxLogEvents: number;
  private startedAtMs: number | null = null;
  private updatedAtMs = 0;
  private endedAtMs: number | null = null;
  private turnIndex = 0;
  private backchannels = 0;
  private ignoredInterruptions = 0;
  private userSpeechMs = 0;
  private agentSpeechMs = 0;
  private lastCostTickAtMs: number | null = null;
  private costInputSinceTickMs = 0;
  private costOutputSinceTickMs = 0;
  private inSeq = 0;
  private outSeq = 0;
  private readonly onDelegatedResult?: (call: VoiceV29DelegatedCall) => void;

  constructor(opts: FullDuplexSessionV29Options = {}) {
    this.sessionId = opts.sessionId ?? '';
    this.botId = opts.botId ?? null;
    this.modelId = opts.modelId ?? 'mock-cascaded';
    if (!isKnownModelV29(this.modelId)) throw new Error(`Unknown voice model: ${this.modelId}`);
    this.architecture = modelInfoV29(this.modelId)?.architecture ?? 'cascaded';
    this.maxLogEvents = opts.maxLogEvents ?? VOICE_V29_MAX_LOG_EVENTS_DEFAULT;
    this.onDelegatedResult = opts.onDelegatedResult;

    this.turnDetector = new AudioTurnDetectorV29({
      config: opts.turnDetector,
      onTurnStart: () => {
        this.floor = 'user';
        this.log('user-turn-start', `User started speaking (turn ${this.turnIndex})`);
      },
      onTurnEnd: (turn) => {
        this.floor = 'none';
        this.log('user-turn-end', `User turn ${turn.index} ended (${turn.durationMs}ms, ${turn.endReason})`);
      },
      onBackchannel: () => {
        this.backchannels += 1;
      },
    } as AudioTurnDetectorV29Options);
    this.bargeIn = new BargeInEngineV29({
      config: opts.bargeIn,
      onInterrupted: (decision) => {
        this.floor = 'user';
        this.setState('listening', decision.atMs);
        this.log('barge-in', `Interrupted response ${decision.responseId ?? '?'} (${decision.confidence} confidence)`);
      },
      onIgnored: (decision) => {
        this.ignoredInterruptions += 1;
        this.log('barge-in-ignored', `Interruption ignored: ${decision.reason}`);
      },
    } as BargeInEngineV29Options);
    this.context = new AppendOnlyContextV29({ sessionId: this.sessionId, ...(opts.context ?? {}) });
    this.delegate = new DelegatedToolRunnerV29({
      ...(opts.delegate ?? {}),
      onResultReady: (call) => {
        this.context.appendToolCall(call.toolName, JSON.stringify(call.args), call.result ?? '', call.finishedAtMs ?? this.updatedAtMs, call.turnIndex);
        this.log('tool-result', `Delegated ${call.toolName} finished (${call.state})`);
        this.onDelegatedResult?.(call);
      },
    });
    this.proactive = new ProactiveAudioV29(opts.proactive);
    this.pipeline = new CascadedPipelineV29(opts.pipeline);
    this.costs = new CostLedgerV29(opts.cost);
    this.transport = createMockRealtimeTransportV28(opts.transport);
  }

  getState(): VoiceV29SessionState {
    return this.state;
  }

  getFloor(): VoiceV29SessionSnapshot['floor'] {
    return this.floor;
  }

  /** Start the session (idle -> connecting -> listening). */
  start(atMs: number): VoiceV29SessionSnapshot {
    if (this.state !== 'idle') throw new Error(`Cannot start a session in state ${this.state}`);
    this.setState('connecting', atMs);
    this.startedAtMs = atMs;
    this.updatedAtMs = atMs;
    this.lastCostTickAtMs = atMs;
    this.costs.startSession(this.sessionId, this.modelId, atMs);
    this.log('connect', `Connected with ${this.modelId} (${this.architecture})`);
    this.setState('listening', atMs);
    this.log('start', 'Full-duplex session started');
    return this.snapshot();
  }

  /** Feed one user audio frame (energy 0..1, or a speech verdict). */
  feedUserFrame(frame: VoiceV29AudioFrame): VoiceV29TurnFrameResult {
    if (this.state === 'ended') throw new Error('Session has ended');
    if (this.state === 'idle') throw new Error('Session has not started');
    const atMs = frame.atMs;
    this.updatedAtMs = atMs;
    this.transport.pushIn(synthToneChunkV28(this.inSeq, atMs, 'mic', { amplitude: clampV29(frame.energy, 0, 1) }));
    this.inSeq += 1;
    const result = this.turnDetector.feed(frame);
    if (frame.isSpeech ?? frame.energy >= 0.18) {
      this.userSpeechMs += 50;
      this.costInputSinceTickMs += 50;
    }
    if (result.turnEnded) {
      const turn = this.turnDetector.lastTurn();
      if (turn && !turn.backchannel) {
        this.context.appendUserTurn(turn.text || `(speech ${turn.durationMs}ms)`, atMs);
        this.turnIndex += 1;
        if (this.state === 'listening') this.setState('thinking', atMs);
      }
    }
    // While the agent speaks, sustained user speech is an interruption *request*.
    if (this.state === 'speaking' && result.speechMs > 0) {
      this.bargeIn.requestInterrupt(atMs, 'user-speech', result.speechMs, frame.energy, result.backchannel);
    }
    return result;
  }

  /** End the current user turn explicitly (e.g. push-to-talk release). */
  endUserTurnNow(atMs: number): VoiceV29Turn | null {
    const turn = this.turnDetector.endNow(atMs, 'explicit');
    if (turn && !turn.backchannel) {
      this.context.appendUserTurn(turn.text || `(speech ${turn.durationMs}ms)`, atMs);
      this.turnIndex += 1;
      if (this.state === 'listening') this.setState('thinking', atMs);
    }
    return turn;
  }

  /**
   * Server starts a response (the only way a response is
   * created). Speaks the text through the mock transport
   * and appends the agent turn to the context.
   */
  serverRespond(text: string, atMs: number): VoiceV29ServerResponse {
    if (this.state === 'ended') throw new Error('Session has ended');
    if (this.state === 'idle') throw new Error('Session has not started');
    const response = this.bargeIn.serverStartResponse(this.sessionId, text, atMs, this.turnIndex);
    this.transport.pushOut(synthToneChunkV28(this.outSeq, atMs, 'tts', { amplitude: 0.5 }));
    this.outSeq += 1;
    const spokenMs = Math.max(50, text.length * 60);
    this.agentSpeechMs += spokenMs;
    this.costOutputSinceTickMs += spokenMs;
    this.context.appendAgentTurn(text, atMs, { model: this.modelId, responseId: response.id });
    this.floor = 'agent';
    this.setState('speaking', atMs);
    this.log('server-response-start', `Server response ${response.id} started (${text.length} chars)`);
    return { ...response };
  }

  /** Server marks part of the active response as spoken. */
  markResponseSpoken(responseId: string, spokenChars: number, atMs: number): VoiceV29ServerResponse | null {
    this.updatedAtMs = atMs;
    return this.bargeIn.serverMarkSpoken(responseId, spokenChars, atMs);
  }

  /** Server completes the active response (fully spoken). */
  completeResponse(responseId: string, atMs: number): VoiceV29ServerResponse | null {
    const done = this.bargeIn.serverCompleteResponse(responseId, atMs);
    if (done) {
      this.floor = 'none';
      if (this.state === 'speaking') this.setState('listening', atMs);
      this.log('server-response-done', `Server response ${responseId} completed`);
    }
    return done;
  }

  /** Client requests an interruption (button, system, or user speech). */
  requestBargeIn(
    atMs: number,
    requester: VoiceV29InterruptRequester,
    speechMs: number,
    energy: number,
  ): VoiceV29InterruptDecision {
    this.updatedAtMs = atMs;
    this.log('barge-in-request', `Interruption requested by ${requester}`);
    return this.bargeIn.requestInterrupt(atMs, requester, speechMs, energy, false);
  }

  /** Resume the unspoken remainder of an interrupted response. */
  resumeRemainder(responseId: string, atMs: number): VoiceV29ServerResponse | null {
    const resumed = this.bargeIn.resumeRemainder(responseId, atMs, this.sessionId);
    if (resumed) {
      this.floor = 'agent';
      this.setState('speaking', atMs);
      this.log('response-resume', `Resumed remainder of ${responseId} as ${resumed.id}`);
    }
    return resumed;
  }

  /** Run one cascaded pipeline turn (mock stages, measured on the virtual clock). */
  async runPipelineTurn(
    input: string,
    atMs: number,
    mode: VoiceV29PipelineMode = 'cascaded',
    stageDurations: VoiceV29MeasuredStages = {},
  ): Promise<{ turn: import('./types').VoiceV29PipelineTurn; response: VoiceV29ServerResponse }> {
    const turn =
      mode === 'speech-to-speech'
        ? await this.pipeline.runSpeechToSpeech(input, atMs, stageDurations['s2s-direct'] ?? 180)
        : await this.pipeline.runCascaded(input, atMs, stageDurations);
    this.log('pipeline', `Pipeline ${mode} turn ${turn.id}: ${turn.totalMs}ms (${turn.withinBudget ? 'within' : 'OVER'} budget)`);
    const response = this.serverRespond(turn.outputText, turn.endedAtMs);
    return { turn, response };
  }

  /** Queue a delegated tool call from the current turn. */
  delegateTool(
    toolName: string,
    args: Record<string, unknown>,
    atMs: number,
    opts: { mode?: 'async' | 'sync'; turnIndex?: number } = {},
  ): VoiceV29DelegatedCall {
    const call = this.delegate.delegate(this.sessionId, toolName, args, atMs, {
      mode: opts.mode ?? 'async',
      turnIndex: opts.turnIndex ?? this.turnIndex,
    });
    this.log('tool-delegated', `Delegated ${toolName} (${call.id}, ${call.mode})`);
    return call;
  }

  /** Drive the delegated queue at virtual time `atMs`. */
  async pumpDelegated(atMs: number): Promise<VoiceV29DelegatedCall[]> {
    return this.delegate.pump(atMs);
  }

  /** Schedule a proactive trigger (greeting, nudge, reminder, ...). */
  scheduleProactive(
    kind: VoiceV29ProactiveKind,
    text: string,
    dueAtMs: number,
    opts: { priority?: number; cooldownMs?: number; repeat?: boolean; repeatMs?: number } = {},
  ): import('./types').VoiceV29ProactiveTrigger {
    return this.proactive.schedule(kind, text, dueAtMs, { ...opts, createdAtMs: this.updatedAtMs });
  }

  /** Tick proactive audio; a fired trigger is spoken as a server response. */
  proactiveTick(atMs: number): import('./types').VoiceV29ProactiveTrigger | null {
    const { fired } = this.proactive.tick(atMs, {
      userSpeaking: this.turnDetector.isSpeaking(),
      agentSpeaking: this.state === 'speaking',
    });
    if (fired) {
      this.log('proactive', `Proactive ${fired.kind} fired: "${fired.text.slice(0, 60)}"`);
      this.serverRespond(fired.text, atMs);
    }
    return fired;
  }

  /** Meter accumulated audio minutes into the cost ledger. */
  tickCost(atMs: number): import('./types').VoiceV29CostEntry | null {
    if (this.lastCostTickAtMs === null) return null;
    const entry = this.costs.tick(this.sessionId, this.costInputSinceTickMs, this.costOutputSinceTickMs, atMs);
    if (entry && entry.usd > 0) this.log('cost-alert', `Billed $${entry.usd.toFixed(4)} for ${entry.inputMinutes + entry.outputMinutes} min`);
    if (entry && (this.costs.getMeter(this.sessionId)?.capped ?? false)) {
      this.log('cost-alert', `Session ${this.sessionId} hit its cost cap`);
    }
    this.costInputSinceTickMs = 0;
    this.costOutputSinceTickMs = 0;
    this.lastCostTickAtMs = atMs;
    return entry;
  }

  /** Pause the session (frames are rejected until resumed). */
  pause(atMs: number): VoiceV29SessionSnapshot {
    this.setState('paused', atMs);
    this.log('pause', 'Session paused');
    return this.snapshot();
  }

  /** Resume a paused session. */
  resume(atMs: number): VoiceV29SessionSnapshot {
    if (this.state !== 'paused') throw new Error(`Cannot resume a session in state ${this.state}`);
    this.setState('listening', atMs);
    this.log('resume', 'Session resumed');
    return this.snapshot();
  }

  /** Stop the session for good (bills the final slice first). */
  stop(atMs: number): VoiceV29SessionSnapshot {
    if (this.state !== 'ended') {
      this.tickCost(atMs);
      this.transport.close(atMs);
      this.setState('ended', atMs);
      this.endedAtMs = atMs;
      this.floor = 'none';
      this.log('stop', 'Session stopped');
    }
    return this.snapshot();
  }

  snapshot(): VoiceV29SessionSnapshot {
    const active = this.bargeIn.activeResponse();
    const pipe = this.pipeline.stats();
    const meter = this.costs.getMeter(this.sessionId);
    const ctx = this.context.stats();
    const del = this.delegate.stats();
    return {
      sessionId: this.sessionId,
      botId: this.botId,
      modelId: this.modelId,
      architecture: this.architecture,
      state: this.state,
      floor: this.floor,
      turnIndex: this.turnIndex,
      turns: this.turnDetector.stats().turns,
      backchannels: this.backchannels,
      interruptions: this.bargeIn.stats().interruptions,
      ignoredInterruptions: this.ignoredInterruptions,
      activeResponseId: active?.id ?? null,
      activeResponseRemainingChars: active?.remainingText.length ?? 0,
      contextItems: ctx.items,
      contextTokens: ctx.liveTokens,
      delegatedCalls: del.calls,
      delegatedDone: del.done,
      delegatedFailed: del.failed + del.timedOut,
      proactiveFired: this.proactive.stats().fired,
      pipelineTurns: pipe.turns,
      pipelineP95Ms: pipe.p95Ms,
      pipelineWithinBudgetPct: pipe.withinBudgetPct,
      costUsd: meter?.usd ?? 0,
      minutesBilled: meter ? round2((meter.inputMs + meter.outputMs) / 60_000) : 0,
      startedAtMs: this.startedAtMs,
      updatedAtMs: this.updatedAtMs,
      endedAtMs: this.endedAtMs,
      events: this.logEvents.length,
    };
  }

  stats(): VoiceV29SessionStats {
    const snap = this.snapshot();
    const tstats = this.transport.stats();
    return {
      state: snap.state,
      floor: snap.floor,
      turns: snap.turns,
      backchannels: snap.backchannels,
      interruptions: snap.interruptions,
      ignoredInterruptions: snap.ignoredInterruptions,
      contextItems: snap.contextItems,
      contextTokens: snap.contextTokens,
      delegatedDone: snap.delegatedDone,
      delegatedFailed: snap.delegatedFailed,
      proactiveFired: snap.proactiveFired,
      pipelineP95Ms: snap.pipelineP95Ms,
      pipelineWithinBudgetPct: snap.pipelineWithinBudgetPct,
      costUsd: snap.costUsd,
      minutesBilled: snap.minutesBilled,
      chunksIn: tstats.chunksIn,
      chunksOut: tstats.chunksOut,
      chunksDropped: tstats.droppedIn + tstats.droppedOut,
      transportLatencyP50Ms: tstats.latencyP50Ms,
    };
  }

  logEventsSoFar(): VoiceV29SessionLogEvent[] {
    return this.logEvents.map((e) => ({ ...e }));
  }

  private setState(next: VoiceV29SessionState, atMs: number): void {
    const allowed = VOICE_V29_STATE_TRANSITIONS[this.state] ?? [];
    if (next !== this.state && !allowed.includes(next)) {
      throw new Error(`Invalid voice v29 transition: ${this.state} -> ${next}`);
    }
    this.state = next;
    this.updatedAtMs = atMs;
  }

  private log(kind: VoiceV29SessionLogEvent['kind'], detail: string): void {
    this.logEvents.push({ atMs: this.updatedAtMs, kind, detail });
    if (this.logEvents.length > this.maxLogEvents) {
      this.logEvents.splice(0, this.logEvents.length - this.maxLogEvents);
    }
  }
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function createFullDuplexSessionV29(opts: FullDuplexSessionV29Options = {}): FullDuplexSessionV29 {
  return new FullDuplexSessionV29(opts);
}
