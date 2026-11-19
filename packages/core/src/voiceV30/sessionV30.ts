/**
 * Full-duplex session v30 (v1.44, Team T4).
 *
 * The session ties the v30 engines together:
 *
 *   - `AudioTurnDetectorV30` for user turns (dual-threshold,
 *     confirmation buffer, adaptive silence, confidence,
 *     echo guard);
 *   - `FullDuplexEngineV30` for the two audio lanes (jitter
 *     buffer, backpressure, degraded half-duplex, latency
 *     SLOs, crosstalk);
 *   - `BargeInEngineV30` for soft/hard interruptions with
 *     sentence-boundary resume;
 *   - `ProactiveAudioV30` for priority-queued, rate-limited,
 *     presence-gated proactive speech with text fallback;
 *   - `CostLedgerV30` for minute + token hybrid billing with
 *     budget envelopes and forecasts.
 *
 * The state machine adds one state over v29: `degraded`
 * (the duplex engine fell back to half-duplex under
 * overload). Recovery is explicit (`recoverDuplex()`).
 *
 * Floor discipline: while the agent is speaking, inbound
 * frames are flagged `agentSpeaking` for the turn detector
 * (echo guard) and fed to the barge-in scorer; a soft
 * interruption pauses the response, a hard one cancels it
 * and returns the floor to the user.
 *
 * All clocks virtual (the caller passes `atMs`); all audio
 * is mock/synthetic frame energy; no provider is dialled,
 * no key is read or stored, no live API is called.
 */

import { AudioTurnDetectorV30, createAudioTurnDetectorV30 } from './turnDetectorV30';
import { BargeInEngineV30, createBargeInEngineV30 } from './bargeInV30';
import { CostLedgerV30, createCostLedgerV30, type CostLedgerV30Options } from './costLedgerV30';
import { FullDuplexEngineV30, createFullDuplexEngineV30, type FullDuplexEngineV30Options } from './fullDuplexV30';
import { ProactiveAudioV30, createProactiveAudioV30, type ProactiveAudioV30Options } from './proactiveAudioV30';
import {
  VOICE_V30_MAX_LOG_EVENTS_DEFAULT,
  estimateTokensV30,
  isKnownModelV30,
  type VoiceV30AudioFrame,
  type VoiceV30BargeInConfig,
  type VoiceV30DegradationReason,
  type VoiceV30DuplexTurn,
  type VoiceV30InterruptDecision,
  type VoiceV30InterruptRequester,
  type VoiceV30ModelId,
  type VoiceV30ProactiveKind,
  type VoiceV30ProactivePriority,
  type VoiceV30ProactiveTrigger,
  type VoiceV30ServerResponse,
  type VoiceV30SessionLogEvent,
  type VoiceV30SessionSnapshot,
  type VoiceV30SessionState,
  type VoiceV30Turn,
  type VoiceV30TurnDetectorConfig,
  type VoiceV30TurnFrameResult,
} from './types';

export interface FullDuplexSessionV30Options {
  sessionId?: string;
  modelId?: VoiceV30ModelId;
  detectorConfig?: Partial<VoiceV30TurnDetectorConfig>;
  bargeInConfig?: Partial<VoiceV30BargeInConfig>;
  duplex?: FullDuplexEngineV30Options;
  proactive?: ProactiveAudioV30Options;
  ledger?: CostLedgerV30Options;
  /** Max log events kept. */
  maxLogEvents?: number;
}

export interface VoiceV30SessionStats {
  state: VoiceV30SessionState;
  floor: VoiceV30SessionSnapshot['floor'];
  turns: number;
  backchannels: number;
  noiseRejected: number;
  spikesRejected: number;
  interruptions: number;
  softInterruptions: number;
  hardInterruptions: number;
  proactiveFired: number;
  proactiveSuppressed: number;
  textFallbacks: number;
  costUsd: number;
  degraded: boolean;
  avgTurnConfidence: number;
  avgTotalLatencyMs: number;
  sloBreaches: number;
  logEvents: number;
}

export function defaultFullDuplexSessionV30Options(): FullDuplexSessionV30Options {
  return { modelId: 'mock-cascaded', maxLogEvents: VOICE_V30_MAX_LOG_EVENTS_DEFAULT };
}

export class FullDuplexSessionV30 {
  readonly sessionId: string;
  private readonly modelId: VoiceV30ModelId;
  private readonly detector: AudioTurnDetectorV30;
  private readonly bargeIn: BargeInEngineV30;
  private readonly duplex: FullDuplexEngineV30;
  private readonly proactive: ProactiveAudioV30;
  private readonly ledger: CostLedgerV30;
  private readonly maxLogEvents: number;

  private state: VoiceV30SessionState = 'idle';
  private floor: VoiceV30SessionSnapshot['floor'] = 'none';
  private startedAtMs: number | null = null;
  private readonly log: VoiceV30SessionLogEvent[] = [];
  /** User speech ms since the last cost tick. */
  private pendingInputMs = 0;
  /** Agent speech ms since the last cost tick. */
  private pendingOutputMs = 0;
  /** Text tokens pending billing since the last cost tick. */
  private pendingTokens = 0;
  /** Proactive audio ms pending billing since the last cost tick. */
  private pendingProactiveMs = 0;
  /** Last barge-in evaluation energies (for the slope score). */
  private readonly recentEnergies: number[] = [];
  /** User speech ms in the current (uninterrupted) burst. */
  private burstSpeechMs = 0;
  private burstPeakEnergy = 0;
  private lastCostTickAtMs: number | null = null;

  constructor(opts: FullDuplexSessionV30Options = {}) {
    this.sessionId = opts.sessionId ?? `session-${Date.now()}`;
    this.modelId = opts.modelId ?? 'mock-cascaded';
    if (!isKnownModelV30(this.modelId)) throw new Error(`Unknown model: ${this.modelId}`);
    this.detector = createAudioTurnDetectorV30({
      config: opts.detectorConfig,
      onTurnStart: (turn) => this.logEvent(turn.startedAtMs, 'turn-start', `User turn ${turn.id} started`),
      onTurnEnd: (turn) => {
        this.pendingTokens += estimateTokensV30(turn.text);
        this.logEvent(turn.endedAtMs, 'turn-end', `User turn ${turn.id} ended (${turn.endReason}, confidence ${turn.confidence})`);
      },
    });
    this.bargeIn = createBargeInEngineV30({
      config: opts.bargeInConfig,
      onInterrupt: (event) => {
        this.logEvent(event.atMs, 'barge-in', `${event.verdict} on ${event.responseId ?? 'none'} (confidence ${event.confidence})`);
      },
    });
    this.duplex = createFullDuplexEngineV30({
      ...(opts.duplex ?? {}),
      onDegraded: (reason, atMs) => {
        this.state = 'degraded';
        this.logEvent(atMs, 'degraded', `Duplex degraded: ${reason}`);
      },
      onRecovered: (atMs) => {
        if (this.state === 'degraded') this.state = 'listening';
        this.logEvent(atMs, 'recovered', 'Duplex recovered to full duplex');
      },
    });
    this.proactive = createProactiveAudioV30(opts.proactive);
    this.ledger = createCostLedgerV30(opts.ledger);
    this.maxLogEvents = opts.maxLogEvents ?? VOICE_V30_MAX_LOG_EVENTS_DEFAULT;
  }

  getState(): VoiceV30SessionState {
    return this.state;
  }

  getFloor(): VoiceV30SessionSnapshot['floor'] {
    return this.floor;
  }

  detectorStats(): ReturnType<AudioTurnDetectorV30['stats']> {
    return this.detector.stats();
  }

  duplexStats(): ReturnType<FullDuplexEngineV30['stats']> {
    return this.duplex.stats();
  }

  bargeInStats(): ReturnType<BargeInEngineV30['stats']> {
    return this.bargeIn.stats();
  }

  proactiveStats(): ReturnType<ProactiveAudioV30['stats']> {
    return this.proactive.stats();
  }

  /** Start the session (listening). */
  start(atMs: number): VoiceV30SessionSnapshot {
    if (this.state !== 'idle') throw new Error(`Cannot start a session in state ${this.state}`);
    this.state = 'listening';
    this.startedAtMs = atMs;
    this.lastCostTickAtMs = atMs;
    this.ledger.startSession(this.sessionId, this.modelId, atMs);
    this.logEvent(atMs, 'start', `Session started (model ${this.modelId})`);
    return this.snapshot();
  }

  /**
   * Feed one user audio frame. While the agent speaks, the
   * frame is flagged for the echo guard and scored for
   * barge-in; otherwise it drives the turn detector.
   */
  feedUserFrame(frame: VoiceV30AudioFrame): VoiceV30TurnFrameResult {
    if (this.state === 'idle' || this.state === 'ended') {
      throw new Error(`Cannot feed audio in state ${this.state}`);
    }
    this.duplex.pushInbound(frame.atMs, frame.energy, frame.text ?? null);
    const agentSpeaking = this.state === 'speaking' || this.state === 'degraded';
    const result = this.detector.feed({ ...frame, agentSpeaking: frame.agentSpeaking ?? agentSpeaking });
    // Barge-in scoring runs on the raw mic frame, not on the
    // echo-guarded detector result: while the agent speaks, a
    // loud user frame is a barge-in candidate even though it
    // cannot open a turn. Frames the caller flags as agent
    // audio are never scored (pure echo).
    const isUserAudio =
      result.kind === 'speech' ||
      result.kind === 'confirming' ||
      (frame.agentSpeaking !== true && frame.energy >= 0.3);
    if (isUserAudio) {
      this.pendingInputMs += 50;
      this.burstSpeechMs += 50;
      this.burstPeakEnergy = Math.max(this.burstPeakEnergy, frame.energy);
      this.recentEnergies.push(frame.energy);
      if (this.recentEnergies.length > 10) this.recentEnergies.shift();
    } else if (result.kind === 'silence') {
      this.burstSpeechMs = 0;
      this.burstPeakEnergy = 0;
      this.recentEnergies.length = 0;
    }
    if (result.turnStarted) {
      this.floor = this.state === 'speaking' ? 'both' : 'user';
    }
    if (result.turnEnded) {
      this.floor = this.state === 'speaking' ? 'agent' : 'none';
      if (this.state === 'listening') this.state = 'thinking';
      this.burstSpeechMs = 0;
      this.burstPeakEnergy = 0;
      this.recentEnergies.length = 0;
    }
    return result;
  }

  /**
   * Feed one agent audio frame (playback progress). Marks
   * the outbound lane and bills agent speech time.
   */
  feedAgentFrame(atMs: number, energy: number, text: string | null = null): void {
    if (this.state === 'idle' || this.state === 'ended') return;
    this.duplex.pushOutbound(atMs, energy, text);
    this.pendingOutputMs += 50;
  }

  /** End the user turn now (explicit end). */
  endUserTurnNow(atMs: number): VoiceV30Turn | null {
    const turn = this.detector.endNow(atMs, 'explicit');
    if (turn) {
      this.state = this.state === 'speaking' ? this.state : 'thinking';
      this.floor = this.state === 'speaking' ? 'agent' : 'none';
    }
    return turn;
  }

  /** Server starts an agent response (only the server creates responses). */
  serverRespond(text: string, atMs: number): VoiceV30ServerResponse {
    if (this.state === 'idle' || this.state === 'ended') {
      throw new Error(`Cannot respond in state ${this.state}`);
    }
    this.duplex.startTurn('speech-to-speech', atMs);
    const response = this.bargeIn.serverStartResponse(text, atMs, this.sessionId);
    this.pendingTokens += estimateTokensV30(text);
    this.state = 'speaking';
    this.floor = 'agent';
    this.logEvent(atMs, 'respond', `Agent response ${response.id} started (${text.length} chars)`);
    return response;
  }

  /** Mark agent response playback progress (also marks first-byte latency). */
  markResponseSpoken(responseId: string, spokenChars: number, atMs: number): VoiceV30ServerResponse | null {
    const response = this.bargeIn.serverMarkSpoken(responseId, spokenChars, atMs);
    if (response && spokenChars > 0) this.duplex.markFirstByte(atMs);
    return response;
  }

  /** Server completes a response; the duplex turn is measured. */
  completeResponse(responseId: string, atMs: number): VoiceV30ServerResponse | null {
    const response = this.bargeIn.serverCompleteResponse(responseId, atMs);
    if (response) {
      const turn = this.duplex.endTurn(atMs);
      this.state = this.duplex.isDegraded() ? 'degraded' : 'listening';
      this.floor = 'none';
      this.logEvent(atMs, 'response-done', `Response ${responseId} completed${turn ? ` (total latency ${turn.totalLatencyMs}ms, within SLO: ${turn.withinTotalSlo})` : ''}`);
    }
    return response;
  }

  /** Request a barge-in (user speech, button, server or system). */
  requestBargeIn(
    requester: VoiceV30InterruptRequester,
    atMs: number,
  ): VoiceV30InterruptDecision {
    const decision = this.bargeIn.requestInterrupt(
      requester,
      atMs,
      requester === 'user-speech' ? this.burstSpeechMs : 0,
      requester === 'user-speech' ? this.burstPeakEnergy : 0,
      [...this.recentEnergies],
    );
    if (decision.verdict === 'interrupt-soft') {
      this.state = 'paused';
      this.floor = 'user';
      this.duplex.endTurn(atMs);
    } else if (decision.verdict === 'interrupt-hard') {
      this.state = 'listening';
      this.floor = 'user';
      this.duplex.endTurn(atMs);
      this.burstSpeechMs = 0;
      this.burstPeakEnergy = 0;
      this.recentEnergies.length = 0;
    }
    return decision;
  }

  /** Resume a paused response from its sentence boundary. */
  resumeRemainder(responseId: string, atMs: number): VoiceV30ServerResponse | null {
    const resumed = this.bargeIn.resumeRemainder(responseId, atMs, this.sessionId);
    if (resumed) {
      this.state = 'speaking';
      this.floor = 'agent';
      this.duplex.startTurn('speech-to-speech', atMs);
      this.logEvent(atMs, 'resume', `Resumed response as ${resumed.id} from sentence boundary`);
    }
    return resumed;
  }

  /** Discard the remainder of a paused response for good. */
  discardRemainder(responseId: string, atMs: number): boolean {
    const ok = this.bargeIn.discardRemainder(responseId, atMs);
    if (ok) {
      this.state = 'listening';
      this.floor = 'none';
    }
    return ok;
  }

  /** Mark the most recent interruption as a false positive (host feedback). */
  markBargeInFalsePositive(atMs: number): number {
    return this.bargeIn.markFalsePositive(atMs);
  }

  /** Schedule a proactive trigger (task-complete, alert, reminder, ...). */
  scheduleProactive(
    kind: VoiceV30ProactiveKind,
    text: string,
    atMs: number,
    opts: {
      priority?: VoiceV30ProactivePriority;
      delayMs?: number;
      ttlMs?: number;
      dedupeKey?: string | null;
      payload?: Record<string, string>;
      allowTextFallback?: boolean;
    } = {},
  ): VoiceV30ProactiveTrigger | null {
    return this.proactive.schedule(kind, text, atMs, opts);
  }

  /**
   * Tick the proactive queue. A fired trigger bills
   * estimated proactive audio time (text length at ~15
   * chars/second of speech) into the cost ledger.
   */
  proactiveTick(atMs: number): VoiceV30ProactiveTrigger | null {
    const fired = this.proactive.tick(atMs, this.detector.isSpeaking());
    if (fired) {
      // ~15 chars per second of spoken audio.
      this.pendingProactiveMs += Math.round((fired.text.length / 15) * 1000);
      this.pendingTokens += estimateTokensV30(fired.text);
      this.logEvent(atMs, 'proactive', `Proactive ${fired.kind} fired (${fired.priority}): ${fired.text}`);
    }
    return fired;
  }

  /** Bill pending audio minutes + tokens into the ledger. */
  tickCost(atMs: number): ReturnType<CostLedgerV30['tick']> {
    const entries = this.ledger.tick(this.sessionId, {
      inputMs: this.pendingInputMs,
      outputMs: this.pendingOutputMs,
      proactiveMs: this.pendingProactiveMs,
      tokens: this.pendingTokens,
    }, atMs);
    this.pendingInputMs = 0;
    this.pendingOutputMs = 0;
    this.pendingProactiveMs = 0;
    this.pendingTokens = 0;
    this.lastCostTickAtMs = atMs;
    return entries;
  }

  /** Cost forecast from the ledger (run-rate projection). */
  forecastCost(atMs: number): ReturnType<CostLedgerV30['forecast']> {
    return this.ledger.forecast(atMs);
  }

  /** Recover the duplex engine from degraded mode. */
  recoverDuplex(atMs: number): boolean {
    return this.duplex.recover(atMs);
  }

  /** Force degraded mode (host-measured overload). */
  degradeDuplex(reason: VoiceV30DegradationReason, atMs: number): void {
    this.duplex.degrade(reason, atMs);
  }

  pause(atMs: number): VoiceV30SessionSnapshot {
    if (this.state === 'speaking' || this.state === 'listening' || this.state === 'thinking') {
      this.state = 'paused';
      this.logEvent(atMs, 'pause', 'Session paused');
    }
    return this.snapshot();
  }

  resume(atMs: number): VoiceV30SessionSnapshot {
    if (this.state === 'paused') {
      this.state = 'listening';
      this.logEvent(atMs, 'resume', 'Session resumed');
    }
    return this.snapshot();
  }

  stop(atMs: number): VoiceV30SessionSnapshot {
    this.tickCost(atMs);
    this.state = 'ended';
    this.floor = 'none';
    this.logEvent(atMs, 'stop', 'Session ended');
    return this.snapshot();
  }

  snapshot(): VoiceV30SessionSnapshot {
    const meter = this.ledger.getMeter(this.sessionId);
    return {
      sessionId: this.sessionId,
      modelId: this.modelId,
      state: this.state,
      floor: this.floor,
      startedAtMs: this.startedAtMs,
      turns: this.detector.stats().turns,
      interruptions: this.bargeIn.stats().interruptions,
      proactiveFired: this.proactive.stats().fired,
      costUsd: meter?.usd ?? 0,
      degraded: this.duplex.isDegraded(),
      degradationReason: this.duplex.getDegradationReason(),
    };
  }

  stats(): VoiceV30SessionStats {
    const dStats = this.detector.stats();
    const bStats = this.bargeIn.stats();
    const pStats = this.proactive.stats();
    const xStats = this.duplex.stats();
    const meter = this.ledger.getMeter(this.sessionId);
    return {
      state: this.state,
      floor: this.floor,
      turns: dStats.turns,
      backchannels: dStats.backchannels,
      noiseRejected: dStats.noiseRejected,
      spikesRejected: dStats.spikesRejected,
      interruptions: bStats.interruptions,
      softInterruptions: bStats.softInterruptions,
      hardInterruptions: bStats.hardInterruptions,
      proactiveFired: pStats.fired,
      proactiveSuppressed: pStats.suppressed,
      textFallbacks: pStats.textFallbacks,
      costUsd: meter?.usd ?? 0,
      degraded: xStats.degraded,
      avgTurnConfidence: dStats.avgConfidence,
      avgTotalLatencyMs: xStats.avgTotalLatencyMs,
      sloBreaches: xStats.sloBreaches,
      logEvents: this.log.length,
    };
  }

  logEventsSoFar(): VoiceV30SessionLogEvent[] {
    return this.log.map((e) => ({ ...e }));
  }

  /** Last measured duplex turn (latency SLOs). */
  lastDuplexTurn(): VoiceV30DuplexTurn | null {
    return this.duplex.lastTurn();
  }

  costReport(): ReturnType<CostLedgerV30['report']> {
    return this.ledger.report();
  }

  private logEvent(atMs: number, kind: string, detail: string): void {
    this.log.push({ atMs, kind, detail });
    if (this.log.length > this.maxLogEvents) this.log.splice(0, this.log.length - this.maxLogEvents);
  }
}

export function createFullDuplexSessionV30(opts: FullDuplexSessionV30Options = {}): FullDuplexSessionV30 {
  return new FullDuplexSessionV30(opts);
}
