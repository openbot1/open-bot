/**
 * Voice session v25 (v1.38, Team T5).
 *
 * One live voice session that ties the v25 pieces together:
 * the turn-taking floor machine, the per-turn timers, the
 * barge-in manager, the silence detector, the per-provider
 * latency tracker, the turn panel, and the v24 tool-call
 * timers (attached, so each turn shows its tool time).
 *
 * The session is the unit the UI renders: one row per
 * session with its current model, its floor state, its
 * running turn (live phase timers), its finished-turn
 * aggregates, its barge-ins and its provider latency.
 *
 * Rules the session enforces:
 *   - the transcript is append-only: turns are added, never
 *     edited — except a barge-in truncates the *assistant*
 *     turn to what was actually spoken (the spoken prefix
 *     replaces the planned reply, and the checksum is taken
 *     over the truncated turns);
 *   - the floor machine and the timer registry always talk
 *     about the same turn: the session passes the floor
 *     machine's turn id into the timer registry, so the
 *     panel, the timers and the floor state never disagree
 *     about which turn is running;
 *   - a barge-in closes the floor turn at decision time
 *     (the floor is handed to the user immediately) but
 *     closes the timer turn at stop time (when the agent
 *     actually stopped speaking) — the two clocks measure
 *     different things, and the panel shows both;
 *   - latency fallback moves the session: when the tracker
 *     recommends a switch, `applyLatencyFallback` changes
 *     the current provider (same model id when the target
 *     has it, otherwise its first voice model) and the next
 *     turn uses the new provider;
 *   - closing a session abandons its running turns (they
 *     are recorded as `abandoned`, not left running forever)
 *     and freezes the transcript;
 *   - the session never dials a provider: latency samples
 *     are host-measured, switching only changes the pointer
 *     the host will use for the next turn.
 *
 * All clocks virtual; all audio mock/synthetic.
 */
import { DynamicProviderCatalogV24 } from '../voiceV24/providerCatalogV24';
import { ToolCallTimerRegistryV24 } from '../voiceV24/toolCallTimersV24';
import {
  transcriptChecksumV24,
  type VoiceV24ModelRef,
  type VoiceV24TranscriptTurn,
} from '../voiceV24/types';
import { BargeInManagerV25, type VoiceV25BurstResult, type VoiceV25StopResult } from './bargeInV25';
import { ProviderLatencyTrackerV25, type ProviderLatencyV25Options } from './latencyProbeV25';
import { SilenceDetectorV25, type VoiceV25SilenceEvent } from './silenceDetectionV25';
import { TurnPanelV25, createTurnPanelV25, type VoiceV25PanelSnapshot } from './turnPanelV25';
import { TurnTakingManagerV25, type VoiceV25Transition } from './turnTakingV25';
import {
  TurnTimerRegistryV25,
  type TurnTimerV25Options,
  type VoiceV25SessionTurnStats,
} from './turnTimersV25';
import {
  formatDurationV25,
  turnChecksumV25,
  type VoiceV25BargeInKind,
  type VoiceV25FloorHolder,
  type VoiceV25LatencyFallbackDecision,
  type VoiceV25LatencySample,
  type VoiceV25TurnRecord,
  type VoiceV25TurnTakingState,
} from './types';

export type VoiceV25SessionPhase = 'open' | 'closed';

export interface VoiceSessionV25Options {
  timerOptions?: Partial<TurnTimerV25Options>;
  silenceOptions?: ConstructorParameters<typeof SilenceDetectorV25>[1];
  bargeInOptions?: ConstructorParameters<typeof BargeInManagerV25>[1];
  latencyOptions?: Partial<ProviderLatencyV25Options>;
  turnTakingOptions?: ConstructorParameters<typeof TurnTakingManagerV25>[1];
}

export interface VoiceV25SessionSnapshot {
  sessionId: string;
  phase: VoiceV25SessionPhase;
  openedAtMs: number;
  closedAtMs: number | null;
  currentModel: VoiceV24ModelRef;
  transcriptTurns: number;
  transcriptChecksum: string;
  floorHolder: VoiceV25FloorHolder;
  turnTakingState: VoiceV25TurnTakingState;
  currentTurn: VoiceV25TurnRecord | null;
  timers: VoiceV25SessionTurnStats;
  bargeIns: number;
  ducks: number;
  silence: { gaps: number; totalSilenceMs: number; longestSilenceMs: number; state: string };
  latency: string;
  switches: number;
}

export function createVoiceSessionV25(
  sessionId: string,
  initialModel: VoiceV24ModelRef,
  catalog: DynamicProviderCatalogV24,
  opts: VoiceSessionV25Options = {},
): VoiceSessionV25 {
  return new VoiceSessionV25(sessionId, initialModel, catalog, opts);
}

export class VoiceSessionV25 {
  readonly sessionId: string;
  private readonly catalog: DynamicProviderCatalogV24;
  private readonly turnTaking: TurnTakingManagerV25;
  private readonly timers: TurnTimerRegistryV25;
  private readonly toolTimers: ToolCallTimerRegistryV24;
  private readonly bargeIn: BargeInManagerV25;
  private readonly silence: SilenceDetectorV25;
  private readonly latency: ProviderLatencyTrackerV25;
  private readonly panel: TurnPanelV25;
  private readonly transcript: VoiceV24TranscriptTurn[] = [];
  private currentModel: VoiceV24ModelRef;
  private phase: VoiceV25SessionPhase = 'open';
  private openedAt = 0;
  private closedAtMs: number | null = null;
  private latencySwitches = 0;
  /** When the current thinking phase started (set by silenceYielded). */
  private thinkingStartedAtMs: number | null = null;

  constructor(
    sessionId: string,
    initialModel: VoiceV24ModelRef,
    catalog: DynamicProviderCatalogV24,
    opts: VoiceSessionV25Options = {},
  ) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new Error('sessionId must be a non-empty string');
    }
    this.sessionId = sessionId;
    this.catalog = catalog;
    this.currentModel = { ...initialModel };
    this.turnTaking = new TurnTakingManagerV25(sessionId, opts.turnTakingOptions ?? {});
    this.timers = new TurnTimerRegistryV25(opts.timerOptions ?? {});
    this.toolTimers = new ToolCallTimerRegistryV24();
    this.timers.attachToolTimers(this.toolTimers);
    this.bargeIn = new BargeInManagerV25(sessionId, opts.bargeInOptions ?? {});
    this.silence = new SilenceDetectorV25(sessionId, opts.silenceOptions ?? {});
    this.latency = new ProviderLatencyTrackerV25(opts.latencyOptions ?? {});
    this.panel = createTurnPanelV25();
  }

  /** Open the session at a virtual time (also records the open time). */
  static open(
    sessionId: string,
    initialModel: VoiceV24ModelRef,
    catalog: DynamicProviderCatalogV24,
    atMs: number,
    opts: VoiceSessionV25Options = {},
  ): VoiceSessionV25 {
    const session = new VoiceSessionV25(sessionId, initialModel, catalog, opts);
    session.openedAt = atMs;
    return session;
  }

  phaseOf(): VoiceV25SessionPhase {
    return this.phase;
  }

  currentModelRef(): VoiceV24ModelRef {
    return { ...this.currentModel };
  }

  turnTakingManager(): TurnTakingManagerV25 {
    return this.turnTaking;
  }

  turnTimerRegistry(): TurnTimerRegistryV25 {
    return this.timers;
  }

  toolTimerRegistry(): ToolCallTimerRegistryV24 {
    return this.toolTimers;
  }

  bargeInManager(): BargeInManagerV25 {
    return this.bargeIn;
  }

  silenceDetector(): SilenceDetectorV25 {
    return this.silence;
  }

  latencyTracker(): ProviderLatencyTrackerV25 {
    return this.latency;
  }

  transcriptCount(): number {
    return this.transcript.length;
  }

  transcriptChecksum(): string {
    return transcriptChecksumV24(this.transcript);
  }

  turnChecksum(): string {
    // The timer registry is the timing source of truth for turns.
    return turnChecksumV25(this.timers.list({ sessionId: this.sessionId }));
  }

  /** The user starts speaking: opens a user turn on both machines. */
  userStarted(atMs: number, text = ''): VoiceV25Transition {
    this.assertOpen();
    const transition = this.turnTaking.userStarted(atMs, text);
    if (transition.ok && transition.turn !== null) {
      this.timers.startTurn(this.sessionId, 'user', atMs, {
        turnId: transition.turn.id,
        index: transition.turn.index,
        text,
      });
    }
    return transition;
  }

  /** The user's speech ended; silence-wait begins. */
  userSpeechEnded(atMs: number): VoiceV25Transition {
    this.assertOpen();
    const transition = this.turnTaking.userSpeechEnded(atMs);
    const current = this.turnTaking.currentTurnRecord();
    if (transition.ok && current !== null) {
      this.timers.enterPhase(current.id, 'silence-wait', atMs);
    }
    return transition;
  }

  /** The silence yielded the floor; the agent starts thinking. */
  silenceYielded(atMs: number): VoiceV25Transition {
    this.assertOpen();
    const before = this.turnTaking.currentTurnRecord();
    const transition = this.turnTaking.silenceYielded(atMs);
    if (transition.ok && before !== null) {
      this.timers.endTurn(before.id, atMs);
      this.transcript.push({ role: 'user', text: before.text, atMs });
      this.thinkingStartedAtMs = atMs;
    }
    return transition;
  }

  /** The agent starts speaking its reply. */
  agentStartedReply(atMs: number, replyText: string): VoiceV25Transition {
    this.assertOpen();
    const providerId = this.currentModel.providerId;
    const model = this.currentModel.model;
    const transition = this.turnTaking.agentStartedReply(atMs, replyText, providerId, model);
    if (transition.ok && transition.turn !== null) {
      // The timer turn starts when thinking started (the yield),
      // so the thinking phase has its real duration; the
      // speaking phase opens now.
      const timerStartMs = this.thinkingStartedAtMs ?? atMs;
      this.timers.startTurn(this.sessionId, 'assistant', timerStartMs, {
        turnId: transition.turn.id,
        index: transition.turn.index,
        providerId,
        model,
        text: replyText,
      });
      this.timers.enterPhase(transition.turn.id, 'speaking', atMs);
      this.bargeIn.agentStartedSpeaking(transition.turn.id, transition.turn.index, replyText, atMs);
      this.thinkingStartedAtMs = null;
    }
    return transition;
  }

  /** The agent finished its reply; the floor is released. */
  agentFinishedReply(atMs: number): VoiceV25Transition {
    this.assertOpen();
    const before = this.turnTaking.currentTurnRecord();
    const transition = this.turnTaking.agentFinishedReply(atMs);
    if (transition.ok && before !== null) {
      this.timers.endTurn(before.id, atMs);
      this.transcript.push({ role: 'assistant', text: before.text, atMs });
    }
    return transition;
  }

  /** Report a user-speech burst while the agent may be speaking. */
  reportBurst(input: {
    atMs: number;
    atMsIntoReply: number;
    energy: number;
    sustainMs: number;
    words: string[];
    echo?: boolean;
    confidence?: number;
    kind?: VoiceV25BargeInKind;
    userText?: string;
  }): VoiceV25BurstResult {
    this.assertOpen();
    const result = this.bargeIn.reportBurst(input);
    if (result.bargeIn !== null) {
      // Floor handoff now; the timer turn closes when the
      // agent actually stops (agentStopped).
      this.turnTaking.bargeIn(input.atMs, result.bargeIn.id);
    }
    return result;
  }

  /**
   * The host reports the agent actually stopped speaking.
   * Finalises the pending barge-in and the timer turn.
   */
  agentStopped(atMs: number, spokenChars: number): VoiceV25StopResult | null {
    this.assertOpen();
    const result = this.bargeIn.agentStopped(atMs, spokenChars);
    if (result === null) return null;
    const turnId = result.bargeIn.turnId;
    this.timers.interruptTurn(turnId, atMs, result.bargeIn.id, result.spokenText, spokenChars);
    this.turnTaking.recordInterruption(turnId, result.spokenText, spokenChars, atMs);
    this.transcript.push({ role: 'assistant', text: result.spokenText, atMs });
    return result;
  }

  /** Attach the interrupting user turn to its barge-in record. */
  attachInterruptingTurn(bargeInId: string, turnId: string): boolean {
    return this.bargeIn.attachInterruptingTurn(bargeInId, turnId);
  }

  /** Note a backchannel on the current turn (state never changes). */
  userBackchannel(atMs: number, text: string): boolean {
    this.assertOpen();
    return this.turnTaking.userBackchannel(atMs, text);
  }

  /** Feed one frame's energy to the silence detector (auto-drives yields). */
  feedEnergy(energy: number, atMs: number): VoiceV25SilenceEvent[] {
    this.assertOpen();
    const current = this.turnTaking.currentTurnRecord();
    const events = this.silence.feedEnergy(energy, atMs, current?.id ?? null);
    return this.applySilenceEvents(events);
  }

  /** Feed one boolean VAD frame to the silence detector (auto-drives yields). */
  feedSpeech(isSpeech: boolean, atMs: number): VoiceV25SilenceEvent[] {
    this.assertOpen();
    const current = this.turnTaking.currentTurnRecord();
    const events = this.silence.feedSpeech(isSpeech, atMs, current?.id ?? null);
    return this.applySilenceEvents(events);
  }

  private applySilenceEvents(events: VoiceV25SilenceEvent[]): VoiceV25SilenceEvent[] {
    for (const event of events) {
      const turnId = event.turnId ?? this.turnTaking.currentTurnRecord()?.id ?? null;
      if (turnId !== null && event.kind === 'silence-end') {
        this.timers.addAudio(turnId, event.durationMs, 0, event.durationMs);
        this.turnTaking.addTurnAudio(turnId, event.durationMs, 0);
        this.turnTaking.noteLongestSilence(turnId, event.durationMs);
      }
      if (event.kind === 'yield' && this.turnTaking.stateOf() === 'user-done') {
        this.silenceYielded(event.atMs);
      }
    }
    return events;
  }

  /** Record a host-measured voice latency sample. */
  recordLatency(sample: {
    providerId: string;
    model: string;
    turnId?: string | null;
    atMs: number;
    ttftMs?: number | null;
    firstAudioMs?: number | null;
    totalMs?: number | null;
    ok: boolean;
    error?: string;
  }): VoiceV25LatencySample {
    this.assertOpen();
    return this.latency.record({ ...sample, sessionId: this.sessionId });
  }

  /**
   * Ask the latency tracker whether the session should leave
   * its current provider, and apply the switch when it says
   * so. Candidates come from the dynamic catalogue (usable
   * providers only). Returns the decision.
   */
  applyLatencyFallback(atMs: number): VoiceV25LatencyFallbackDecision {
    this.assertOpen();
    const candidates = this.catalog.usable(atMs).map((p) => p.id);
    const decision = this.latency.recommendFallback(
      this.sessionId,
      this.currentModel.providerId,
      candidates,
      atMs,
    );
    if (decision.switched && decision.toProviderId !== null) {
      const target = this.catalog.get(decision.toProviderId);
      const models = target?.models ?? [];
      const sameModel = models.find((m) => m.id === this.currentModel.model);
      const voiceModel = models.find((m) => m.supportsVoice === true);
      const picked = sameModel ?? voiceModel ?? models[0];
      if (picked !== undefined) {
        this.currentModel = { providerId: decision.toProviderId, model: picked.id };
        this.latencySwitches += 1;
      }
    }
    return decision;
  }

  /** Start a v24 tool-call timer inside the current turn. */
  startToolCall(toolName: string, atMs: number): string {
    this.assertOpen();
    const current = this.turnTaking.currentTurnRecord();
    return this.toolTimers.start(this.sessionId, toolName, atMs, current?.index ?? 0);
  }

  /** Finish a tool call successfully. */
  endToolCall(callId: string, atMs: number): void {
    this.assertOpen();
    this.toolTimers.end(callId, atMs);
  }

  /** Finish a tool call as failed. */
  failToolCall(callId: string, atMs: number, error: string): void {
    this.assertOpen();
    this.toolTimers.fail(callId, atMs, error);
  }

  /** Check the current turn against its max duration. */
  timeoutCheck(atMs: number): VoiceV25TurnRecord | null {
    this.assertOpen();
    const timedOut = this.turnTaking.timeoutCheck(atMs);
    if (timedOut !== null) {
      this.timers.timeoutTurn(timedOut.id, atMs);
    }
    return timedOut;
  }

  /** Live threshold check across running turns. */
  checkRunning(atMs: number): ReturnType<TurnTimerRegistryV25['checkRunning']> {
    this.assertOpen();
    return this.timers.checkRunning(atMs);
  }

  snapshot(atMs: number): VoiceV25SessionSnapshot {
    const timers = this.timers.sessionStats(this.sessionId);
    const silence = this.silence.stats(undefined, atMs);
    const current = this.turnTaking.currentTurnRecord();
    return {
      sessionId: this.sessionId,
      phase: this.phase,
      openedAtMs: this.openedAt,
      closedAtMs: this.closedAtMs,
      currentModel: { ...this.currentModel },
      transcriptTurns: this.transcript.length,
      transcriptChecksum: this.transcriptChecksum(),
      floorHolder: this.turnTaking.floorHolder(),
      turnTakingState: this.turnTaking.stateOf(),
      currentTurn: current,
      timers,
      bargeIns: this.bargeIn.count(),
      ducks: this.bargeIn.ducksList().length,
      silence: {
        gaps: silence.gaps,
        totalSilenceMs: silence.totalSilenceMs,
        longestSilenceMs: silence.longestSilenceMs,
        state: silence.state,
      },
      latency: this.latency.summary(this.sessionId),
      switches: this.latencySwitches,
    };
  }

  panelSnapshot(atMs: number): VoiceV25PanelSnapshot {
    return this.panel.snapshot({
      sessionId: this.sessionId,
      timers: this.timers,
      atMs,
      turnTaking: this.turnTaking,
      bargeIn: this.bargeIn,
      silence: this.silence,
      latency: this.latency,
    });
  }

  summary(atMs: number): string {
    const snap = this.snapshot(atMs);
    return (
      `Session ${this.sessionId} (${snap.phase}): model ${snap.currentModel.providerId}/${snap.currentModel.model}, ` +
      `${snap.transcriptTurns} transcript turns, floor ${snap.floorHolder} (${snap.turnTakingState}), ` +
      `${snap.timers.turns} turns (${formatDurationV25(snap.timers.totalMs)} total, ` +
      `mean ${formatDurationV25(snap.timers.meanMs)}, p95 ${formatDurationV25(snap.timers.p95Ms)}), ` +
      `${snap.bargeIns} barge-ins, ${snap.ducks} ducks, silence ${formatDurationV25(snap.silence.totalSilenceMs)}, ` +
      `${snap.switches} latency switches.`
    );
  }

  markdown(atMs: number): string {
    const lines: string[] = [`# Voice v25 session — ${this.sessionId}`, ''];
    lines.push(this.summary(atMs));
    lines.push('');
    lines.push(this.panel.markdown(this.panelSnapshot(atMs)));
    return lines.join('\n');
  }

  /** Close the session: abandon running turns, freeze the transcript. */
  close(atMs: number): { closedAtMs: number; abandonedTurns: number; cancelledToolCalls: number } {
    if (this.phase === 'closed') {
      return { closedAtMs: this.closedAtMs ?? atMs, abandonedTurns: 0, cancelledToolCalls: 0 };
    }
    this.phase = 'closed';
    this.closedAtMs = atMs;
    const abandonedTurns = this.timers.closeSession(this.sessionId, atMs);
    if (this.turnTaking.currentTurnRecord() !== null) {
      this.turnTaking.abandonTurn(atMs);
    }
    const cancelledToolCalls = this.toolTimers.cancelSession(this.sessionId, atMs);
    this.silence.endTurn(atMs);
    return { closedAtMs: atMs, abandonedTurns, cancelledToolCalls };
  }

  private assertOpen(): void {
    if (this.phase !== 'open') throw new Error(`Session "${this.sessionId}" is closed`);
  }
}
