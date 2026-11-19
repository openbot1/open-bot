/**
 * Realtime voice session for voice v26 (v1.39, Team T5).
 *
 * The session wires the v26 pieces into one live loop:
 *
 *   user speech frames ──> BargeInDetectorV26 ──> stop TTS, keep prefix
 *   floor changes ───────> TurnTakingMachineV26 ──> anti-overlap guard
 *   stage timings ───────> LatencyBudgetV26 ──────> budget + degraded mode
 *   TTS / STT ───────────> ProviderRegistryV26 ──> mock providers
 *   everything ──────────> StatusPanelV26 ──────> UI + ui:// resource
 *
 * One session is one conversation. The host drives it with
 * virtual-clock calls: `userFrame` while the user speaks,
 * `agentReply` when the model has a reply, `recordLatency`
 * when the host measures a stage, `close` at the end.
 *
 * The session never dials a provider, never reads a key, never
 * touches a mic or a sound card: provider calls go through the
 * mock registry, audio is frame energy, latency is measured by
 * the host and reported in. A session snapshot is plain JSON
 * and can be restored into a fresh session object.
 */
import { BargeInDetectorV26, createBargeInDetectorV26, type BargeInV26Options } from './bargeInV26';
import { LatencyBudgetV26, createLatencyBudgetV26, type LatencyBudgetV26Options } from './latencyBudgetV26';
import { ProviderRegistryV26, createProviderRegistryV26, type ProviderRegistryV26Options } from './providersV26';
import { TurnTakingMachineV26, createTurnTakingMachineV26, type TurnTakingV26Options } from './turnTakingV26';
import {
  type VoiceV26AudioFrame,
  type VoiceV26BargeInRecord,
  type VoiceV26BudgetProfile,
  type VoiceV26DegradedLevel,
  type VoiceV26FloorState,
  type VoiceV26LatencyStage,
  type VoiceV26MockAudioResult,
  type VoiceV26ProviderSelection,
  type VoiceV26ResumeContext,
  type VoiceV26StatusSnapshot,
  type VoiceV26TurnRecord,
} from './types';

export interface VoiceSessionV26Options {
  bargeIn?: Partial<BargeInV26Options>;
  turnTaking?: Partial<TurnTakingV26Options>;
  latency?: Partial<LatencyBudgetV26Options>;
  providers?: Partial<ProviderRegistryV26Options>;
  /** Budget profile for the latency budget (default 'balanced'). */
  profile?: VoiceV26BudgetProfile;
  /** Default STT / TTS language (default 'en'). */
  language?: string;
}

export interface VoiceV26SessionEvent {
  atMs: number;
  kind:
    | 'open'
    | 'user-start'
    | 'user-end'
    | 'agent-start'
    | 'agent-queued'
    | 'agent-done'
    | 'barge-in-suspect'
    | 'barge-in-duck'
    | 'barge-in-confirmed'
    | 'barge-in-stopped'
    | 'backchannel'
    | 'echo'
    | 'latency-breach'
    | 'degraded'
    | 'provider-selected'
    | 'provider-fallback'
    | 'timeout'
    | 'close';
  detail: string;
}

/** Plain-JSON snapshot of a whole session. */
export interface VoiceV26SessionSnapshot {
  sessionId: string;
  state: VoiceV26FloorState;
  degradedLevel: VoiceV26DegradedLevel;
  turns: VoiceV26TurnRecord[];
  bargeIns: VoiceV26BargeInRecord[];
  events: VoiceV26SessionEvent[];
  openedAtMs: number;
  closedAtMs: number | null;
  sttProviderId: string | null;
  ttsProviderId: string | null;
}

export function createVoiceSessionV26(
  sessionId: string,
  opts: VoiceSessionV26Options = {},
): VoiceSessionV26 {
  return new VoiceSessionV26(sessionId, opts);
}

export class VoiceSessionV26 {
  private readonly sessionId: string;
  private readonly opts: VoiceSessionV26Options;
  private readonly bargeIn: BargeInDetectorV26;
  private readonly turns: TurnTakingMachineV26;
  private readonly latency: LatencyBudgetV26;
  private readonly providers: ProviderRegistryV26;
  private readonly events: VoiceV26SessionEvent[] = [];
  private openedAtMs: number | null = null;
  private closedAtMs: number | null = null;
  private sttProviderId: string | null = null;
  private ttsProviderId: string | null = null;
  private lastResumeContext: VoiceV26ResumeContext | null = null;

  constructor(sessionId: string, opts: VoiceSessionV26Options = {}) {
    this.sessionId = sessionId;
    this.opts = opts;
    this.bargeIn = createBargeInDetectorV26(sessionId, opts.bargeIn ?? {});
    this.turns = createTurnTakingMachineV26(sessionId, opts.turnTaking ?? {});
    this.latency = createLatencyBudgetV26(sessionId, {
      ...(opts.latency ?? {}),
      profile: opts.profile ?? opts.latency?.profile ?? 'balanced',
    });
    this.providers = createProviderRegistryV26(opts.providers ?? {});
  }

  bargeInDetector(): BargeInDetectorV26 {
    return this.bargeIn;
  }

  turnTaking(): TurnTakingMachineV26 {
    return this.turns;
  }

  latencyBudget(): LatencyBudgetV26 {
    return this.latency;
  }

  providerRegistry(): ProviderRegistryV26 {
    return this.providers;
  }

  stateNow(): VoiceV26FloorState {
    return this.turns.stateNow();
  }

  degradedLevel(): VoiceV26DegradedLevel {
    return this.latency.degradedLevelNow();
  }

  isOpen(): boolean {
    return this.openedAtMs !== null && this.closedAtMs === null;
  }

  /** Open the session (virtual clock). */
  open(atMs: number): void {
    if (this.openedAtMs !== null) throw new Error(`Session ${this.sessionId} is already open`);
    this.openedAtMs = atMs;
    this.log(atMs, 'open', `session ${this.sessionId} opened`);
    // Pick default providers up front so the panel can show them.
    const stt = this.providers.select({ kind: 'stt', language: this.opts.language ?? 'en' }, atMs);
    const tts = this.providers.select({ kind: 'tts', language: this.opts.language ?? 'en' }, atMs);
    this.sttProviderId = stt ? stt.providerId : null;
    this.ttsProviderId = tts ? tts.providerId : null;
  }

  /** The user started speaking. */
  userStart(atMs: number, text = ''): VoiceV26TurnRecord {
    this.ensureOpen();
    const turn = this.turns.userStart(atMs, text);
    this.log(atMs, 'user-start', `user turn ${turn.id} started`);
    return turn;
  }

  /**
   * One user audio frame. While the agent speaks this is the
   * barge-in path: suspect -> duck -> confirm -> stop the TTS
   * and freeze the cut turn with its spoken prefix.
   */
  userFrame(frame: VoiceV26AudioFrame & { echo?: boolean; userText?: string | null }): {
    stage: string;
    confirmed: boolean;
    stopped: boolean;
    bargeInId: string | null;
  } {
    this.ensureOpen();
    if (this.turns.stateNow() === 'idle') {
      this.userStart(frame.atMs);
    }
    const result = this.bargeIn.feedFrame(frame);
    if (result.echo) this.log(frame.atMs, 'echo', 'echo frame ignored');
    if (result.backchannel) this.log(frame.atMs, 'backchannel', 'short burst noted as backchannel');
    if (result.stage === 'suspect' && result.bargeInId) {
      this.log(frame.atMs, 'barge-in-suspect', `suspect barge-in ${result.bargeInId}`);
    }
    if (result.ducking) {
      this.log(frame.atMs, 'barge-in-duck', `ducking TTS for ${result.bargeInId}`);
    }
    if (!result.confirmed) {
      return { stage: result.stage, confirmed: false, stopped: false, bargeInId: result.bargeInId };
    }
    this.log(frame.atMs, 'barge-in-confirmed', `barge-in ${result.bargeInId} confirmed`);
    const stopped = this.stopForBargeIn(frame.atMs, frame.userText ?? null);
    return { stage: 'confirmed', confirmed: true, stopped: stopped !== null, bargeInId: result.bargeInId };
  }

  /** The user finished their utterance. */
  userEnd(atMs: number, text?: string): VoiceV26TurnRecord | null {
    this.ensureOpen();
    const turn = this.turns.userEnd(atMs, text);
    if (turn) this.log(atMs, 'user-end', `user turn ${turn.id} ended, thinking`);
    const delivered = this.turns.deliverQueued(atMs);
    if (delivered && delivered.outcome === 'started') {
      this.log(atMs, 'agent-start', `queued reply ${delivered.turnId} delivered`);
      this.armTtsForTurn(delivered.turnId, atMs);
    }
    return turn;
  }

  /**
   * The model produced a reply. Guarded by the turn-taking
   * machine: queued while the user holds the floor.
   */
  agentReply(input: {
    atMs: number;
    text: string;
    providerId?: string | null;
    model?: string | null;
  }): { outcome: string; turnId: string | null; reason: string } {
    this.ensureOpen();
    const degraded = this.latency.policyNow();
    let text = input.text;
    if (degraded.maxReplyChars !== null && text.length > degraded.maxReplyChars) {
      text = `${text.slice(0, degraded.maxReplyChars).trimEnd()}…`;
    }
    const result = this.turns.agentStart({ atMs: input.atMs, text, providerId: input.providerId, model: input.model });
    if (result.outcome === 'started' && result.turnId) {
      this.log(input.atMs, 'agent-start', `agent turn ${result.turnId} started`);
      this.armTtsForTurn(result.turnId, input.atMs, text);
    } else if (result.outcome === 'queued') {
      this.log(input.atMs, 'agent-queued', `reply queued (${result.reason})`);
    } else {
      this.log(input.atMs, 'agent-start', `agent start rejected (${result.reason})`);
    }
    return { outcome: result.outcome, turnId: result.turnId, reason: result.reason };
  }

  /** TTS progress for the current agent turn. */
  agentSpeechProgress(atMs: number, spokenChars: number): void {
    this.bargeIn.agentSpeechProgress(atMs, spokenChars);
  }

  /** The agent finished speaking its reply. */
  agentDone(atMs: number, spokenChars?: number): VoiceV26TurnRecord | null {
    this.ensureOpen();
    const turn = this.turns.agentDone(atMs, spokenChars);
    if (turn) {
      this.bargeIn.agentStoppedSpeaking(atMs);
      this.log(atMs, 'agent-done', `agent turn ${turn.id} done`);
    }
    return turn;
  }

  /** Record one measured stage latency (host-measured). */
  recordLatency(input: {
    stage: VoiceV26LatencyStage;
    ms: number;
    turnId?: string | null;
    turnIndex?: number | null;
    providerId?: string | null;
    atMs: number;
  }): { breach: boolean; overMs: number | null } {
    this.ensureOpen();
    const before = this.latency.degradedLevelNow();
    const breach = this.latency.recordStage(input);
    if (breach) {
      this.log(input.atMs, 'latency-breach', `${input.stage} ${input.ms}ms > budget ${breach.budgetMs}ms (+${breach.overMs}ms)`);
    }
    const after = this.latency.degradedLevelNow();
    if (after !== before) {
      this.log(input.atMs, 'degraded', `degraded mode ${before} -> ${after}`);
    }
    return { breach: breach !== null, overMs: breach ? breach.overMs : null };
  }

  /** Record a whole turn's latencies at once (drives degraded mode). */
  recordTurnLatency(input: {
    turnId?: string | null;
    turnIndex?: number | null;
    sttMs?: number | null;
    modelMs?: number | null;
    ttsMs?: number | null;
    providerId?: string | null;
    atMs: number;
  }): { breached: boolean; breachedStages: VoiceV26LatencyStage[]; degradedLevel: VoiceV26DegradedLevel } {
    this.ensureOpen();
    const before = this.latency.degradedLevelNow();
    const rollup = this.latency.recordTurn(input);
    if (rollup.breached) {
      this.log(input.atMs, 'latency-breach', `turn ${input.turnId ?? '?'} breached: ${rollup.breachedStages.join(', ')}`);
    }
    const after = this.latency.degradedLevelNow();
    if (after !== before) this.log(input.atMs, 'degraded', `degraded mode ${before} -> ${after}`);
    return { breached: rollup.breached, breachedStages: rollup.breachedStages, degradedLevel: rollup.degradedLevel };
  }

  /** Select a provider for a turn (records the selection). */
  selectProvider(input: {
    kind: 'stt' | 'tts';
    language?: string | null;
    voice?: string | null;
    atMs: number;
  }): VoiceV26ProviderSelection | null {
    this.ensureOpen();
    const selection = this.providers.select(
      {
        kind: input.kind,
        language: input.language ?? this.opts.language ?? 'en',
        voice: input.voice ?? null,
        degradedLevel: this.latency.degradedLevelNow(),
      },
      input.atMs,
    );
    if (selection) {
      if (input.kind === 'stt') this.sttProviderId = selection.providerId;
      else this.ttsProviderId = selection.providerId;
      this.log(input.atMs, 'provider-selected', `${input.kind} -> ${selection.providerId} (${selection.reason})`);
    }
    return selection;
  }

  /** Fallback chain for a kind (after the current provider failed). */
  fallbackProviders(kind: 'stt' | 'tts', atMs: number): VoiceV26ProviderSelection[] {
    this.ensureOpen();
    const chain = this.providers.fallbackChain(
      { kind, language: this.opts.language ?? 'en', degradedLevel: this.latency.degradedLevelNow() },
      atMs,
    );
    if (chain.length > 0) {
      this.log(atMs, 'provider-fallback', `${kind} fallback: ${chain.map((c) => c.providerId).join(' -> ')}`);
    }
    return chain;
  }

  /** Mock TTS through the registry (deterministic, no audio hardware). */
  mockSynthesize(input: { text: string; voice?: string | null; language?: string | null; atMs: number }): VoiceV26MockAudioResult {
    this.ensureOpen();
    const providerId = this.ttsProviderId ?? 'mock-local-tts';
    return this.providers.synthesize({ providerId, text: input.text, voice: input.voice, language: input.language, atMs: input.atMs });
  }

  /** Mock STT through the registry (deterministic, no audio hardware). */
  mockTranscribe(input: { audioPayload: string; language?: string | null; atMs: number }): VoiceV26MockAudioResult {
    this.ensureOpen();
    const providerId = this.sttProviderId ?? 'mock-local-stt';
    return this.providers.transcribe({ providerId, audioPayload: input.audioPayload, language: input.language, atMs: input.atMs });
  }

  /** Per-phase timeout check (releases a stuck floor). */
  timeoutCheck(atMs: number): VoiceV26TurnRecord | null {
    this.ensureOpen();
    const timedOut = this.turns.timeoutCheck(atMs);
    if (timedOut) this.log(atMs, 'timeout', `turn ${timedOut.id} timed out (${timedOut.status})`);
    return timedOut;
  }

  /** The resume context kept from the last barge-in stop, if any. */
  lastResume(): VoiceV26ResumeContext | null {
    return this.lastResumeContext ? { ...this.lastResumeContext } : null;
  }

  /** Status snapshot for the panel / ui:// resource. */
  statusSnapshot(atMs: number): VoiceV26StatusSnapshot {
    const turn = this.turns.currentTurnNow();
    const total = this.latency.stageStats('total');
    const state = this.turns.stateNow();
    return {
      sessionId: this.sessionId,
      state: state === 'done' ? 'idle' : state,
      floor: state,
      floorHolder: this.turns.floorHolder(),
      level: null,
      latencyMs: total.samples > 0 ? total.p50Ms : null,
      latencyP50Ms: total.samples > 0 ? total.p50Ms : null,
      budgetMs: this.latency.budgetsNow().totalMs,
      overBudget: total.samples > 0 && total.p50Ms > this.latency.budgetsNow().totalMs,
      degradedLevel: this.latency.degradedLevelNow(),
      providerId: this.ttsProviderId,
      providerName: this.ttsProviderId ? this.providers.get(this.ttsProviderId)?.name ?? null : null,
      turnId: turn ? turn.id : null,
      turnIndex: turn ? turn.index : null,
      bargeIns: this.bargeIn.count(),
      turns: this.turns.listTurns().length,
      updatedAtMs: atMs,
    };
  }

  snapshot(): VoiceV26SessionSnapshot {
    return {
      sessionId: this.sessionId,
      state: this.turns.stateNow(),
      degradedLevel: this.latency.degradedLevelNow(),
      turns: this.turns.listTurns(),
      bargeIns: this.bargeIn.list(),
      events: this.events.map((e) => ({ ...e })),
      openedAtMs: this.openedAtMs ?? 0,
      closedAtMs: this.closedAtMs,
      sttProviderId: this.sttProviderId,
      ttsProviderId: this.ttsProviderId,
    };
  }

  eventsList(): VoiceV26SessionEvent[] {
    return this.events.map((e) => ({ ...e }));
  }

  close(atMs: number): VoiceV26SessionSnapshot {
    if (this.closedAtMs !== null) return this.snapshot();
    if (this.turns.currentTurnNow()) this.turns.abandon(atMs, 'session closed');
    this.closedAtMs = atMs;
    this.log(atMs, 'close', `session ${this.sessionId} closed`);
    return this.snapshot();
  }

  summary(): string {
    const turns = this.turns.stats();
    const latencyStats = this.latency.stats();
    return (
      `session v26 ${this.sessionId}: state ${turns.state}, ${turns.turns} turns, ` +
      `${this.bargeIn.count()} barge-ins, latency ${latencyStats.breachedTurns}/${latencyStats.turns} breached turns, ` +
      `degraded ${latencyStats.degradedLevel}, providers stt=${this.sttProviderId ?? '-'} tts=${this.ttsProviderId ?? '-'}`
    );
  }

  private stopForBargeIn(atMs: number, userText: string | null): VoiceV26ResumeContext | null {
    const stopped = this.bargeIn.stop({ atMs, userText });
    if (!stopped) return null;
    this.lastResumeContext = stopped.context;
    const turn = this.turns.bargeIn({
      atMs,
      bargeInId: stopped.bargeInId,
      spokenText: stopped.spokenText,
      spokenChars: stopped.spokenChars,
    });
    this.log(
      atMs,
      'barge-in-stopped',
      `stopped ${stopped.bargeInId} after ${stopped.stopLatencyMs}ms, spoke ${stopped.spokenChars} chars, ` +
      `resume ${stopped.resumeStrategy}${turn ? ` (turn ${turn.id})` : ''}`,
    );
    return stopped.context;
  }

  private armTtsForTurn(turnId: string | null, atMs: number, text?: string): void {
    if (!turnId) return;
    const turn = this.turns.getTurn(turnId);
    if (!turn) return;
    this.bargeIn.agentStartedSpeaking({
      turnId,
      turnIndex: turn.index,
      replyText: text ?? turn.text,
      atMs,
    });
  }

  private ensureOpen(): void {
    if (this.openedAtMs === null) throw new Error(`Session ${this.sessionId} is not open yet`);
    if (this.closedAtMs !== null) throw new Error(`Session ${this.sessionId} is closed`);
  }

  private log(atMs: number, kind: VoiceV26SessionEvent['kind'], detail: string): void {
    this.events.push({ atMs, kind, detail });
    if (this.events.length > 5000) this.events.shift();
  }
}
