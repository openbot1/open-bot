/**
 * Voice session v6 (v1.07, Team T5 — voice v4 + UI).
 *
 * Composition, not a rewrite: one `VoiceSessionV4` (v1.05 — the
 * durable long call: checkpoints + resume + media + barge-in v3/v4
 * + latency pipeline + turn history) plus the three v1.07 pieces
 * around it:
 *
 *   - `VoiceStateMachine` — the one explicit call state
 *     (idle/connecting/listening/speaking/interrupted/reconnecting/
 *     degraded/ended). v4 events drive it: the session's own
 *     `state` events map 1:1, `audio` means the model is speaking,
 *     a finished model `turn` means listening again, `interrupted`
 *     means interrupted, `resumed` means listening. The panel reads
 *     this state instead of guessing from the last event kind.
 *   - `VoiceSwitchManager` — mid-call voice switching (pick another
 *     profile while the call is live; revert to the previous one).
 *     The session applies the new profile's TTS options to the
 *     live call; a provider that cannot switch mid-call applies it
 *     on the next turn (`applied: 'next-turn'`).
 *   - `VoiceNetworkGuard` — network-error policy: classify the
 *     failure, retry with backoff, degrade to local-only after
 *     repeated failures, give up on auth errors or exhaustion.
 *     `connect()` retries through the guard; `error` events feed
 *     the guard; a degraded call keeps working locally and the
 *     panel says so.
 *
 * Events: every `VoiceSessionV4` event is forwarded unchanged,
 * plus v6 kinds (`voice-state`, `voice-state-rejected`,
 * `voice-switched`, `voice-switch-failed`, `network-retry`,
 * `network-degraded`, `network-give-up`, `network-recovered`).
 * All live paths stay mock unless the caller passes a live
 * transport factory — v6 never dials anything itself.
 * `createMockVoiceSessionV6()` is the mock factory the session
 * manager and the tools use.
 */
import type { RealtimeConfig, RealtimeSessionState } from './types';
import {
  VoiceSessionV4,
  createMockVoiceSessionV4,
  type VoiceSessionV4Event,
  type VoiceSessionV4Options,
  type VoiceSessionV4Stats,
} from './voiceSessionV4';
import {
  VoiceStateMachine,
  type VoiceCallState,
  type VoiceStateMachineEvent,
  type VoiceStateMachineOptions,
} from './voiceStateMachine';
import {
  VoiceSwitchManager,
  voiceSwitchSummary,
  type VoiceSwitchApplyMode,
  type VoiceSwitchEvent,
  type VoiceSwitchRecord,
  type VoiceSwitchResult,
} from './voiceSwitch';
import {
  VoiceNetworkGuard,
  voiceNetworkSummary,
  type VoiceNetworkDecision,
  type VoiceNetworkGuardEvent,
  type VoiceNetworkGuardOptions,
} from './voiceNetworkGuard';
import type { VoiceProfile } from './voiceProfiles';
import { MockRealtimeTransport } from './mockTransport';
import type { VoiceTurn } from './longSession';

/** Extra events the v6 wrapper emits (on top of the v4 events). */
export type VoiceSessionV6Event =
  | VoiceSessionV4Event
  | VoiceStateMachineEvent
  | VoiceSwitchEvent
  | VoiceNetworkGuardEvent
  | { kind: 'voice-reconnected'; attempts: number; at: number }
  | { kind: 'voice-reconnect-failed'; error: string; attempts: number; at: number };

export type VoiceSessionV6EventSink = (event: VoiceSessionV6Event) => void;

/** Stats for the panel / diagnostics. */
export interface VoiceSessionV6Stats {
  callState: VoiceCallState;
  msInState: number;
  stateTransitions: number;
  stateRejected: number;
  stateForced: number;
  voice: {
    currentId: string | null;
    currentName: string | null;
    switches: number;
    reverts: number;
    failures: number;
    midCallSwitches: number;
  };
  network: ReturnType<VoiceNetworkGuard['getStats']>;
  v4: VoiceSessionV4Stats;
}

export interface VoiceSessionV6Options {
  /** Options for the inner `VoiceSessionV4`. */
  v4: VoiceSessionV4Options;
  /** Starting voice (id). Defaults to the first built-in profile. */
  initialVoiceId?: string;
  /** Switchable voices (defaults to the six built-in profiles). */
  voices?: readonly VoiceProfile[];
  /** How a mid-call switch takes effect. Default 'immediate'. */
  voiceApplyMode?: VoiceSwitchApplyMode;
  /** Network guard options. */
  network?: VoiceNetworkGuardOptions;
  /** State machine options. */
  stateMachine?: VoiceStateMachineOptions;
  /** ms to wait between guard-directed connect retries. Default: the guard's delay. */
  retrySleepMs?: (ms: number) => Promise<void>;
  /** Inject the clock (tests). Defaults to `Date.now`. */
  clock?: () => number;
  /** Event sink (v4 events + v6 events). */
  onEvent?: VoiceSessionV6EventSink;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  });

export class VoiceSessionV6 {
  private readonly v4: VoiceSessionV4;
  private readonly machine: VoiceStateMachine;
  private readonly voices: VoiceSwitchManager;
  private readonly guard: VoiceNetworkGuard;
  private readonly onEvent: VoiceSessionV6EventSink | undefined;
  private readonly clock: () => number;
  private readonly retrySleep: (ms: number) => Promise<void>;
  private lastConfig: RealtimeConfig | null = null;
  private lastSessionId = '';
  private readonly provider: string;
  /** Snapshot this session was restored from (null when fresh). */
  private restoredFrom: unknown = null;

  constructor(options: VoiceSessionV6Options) {
    this.clock = options.clock ?? Date.now;
    this.retrySleep = options.retrySleepMs ?? sleep;
    this.onEvent = options.onEvent;
    this.provider = options.v4.v3.v2.session.provider ?? 'openai';
    this.machine = new VoiceStateMachine({
      ...(options.stateMachine ?? {}),
      clock: this.clock,
      onEvent: (e) => this.emit(e),
    });
    this.voices = new VoiceSwitchManager({
      profiles: options.voices,
      initialId: options.initialVoiceId,
      applyMode: options.voiceApplyMode,
      clock: this.clock,
      onEvent: (e) => this.emit(e),
    });
    this.guard = new VoiceNetworkGuard({
      ...(options.network ?? {}),
      clock: this.clock,
      jitter: options.network?.jitter ?? (() => 0),
      onEvent: (e) => {
        this.emit(e);
        if (e.kind === 'network-degraded') this.machine.transition('degraded', 'network-degraded');
        if (e.kind === 'network-recovered') this.machine.transition('listening', 'network-recovered');
      },
    });
    this.v4 = new VoiceSessionV4({
      ...options.v4,
      clock: this.clock,
      onEvent: (e) => this.handleV4Event(e),
    });
  }

  // -- passthroughs -------------------------------------------------------

  getState(): RealtimeSessionState {
    return this.v4.getState();
  }

  /** Provider this call dials (from the v4 options). */
  getProvider(): string {
    return this.provider;
  }

  /** Snapshot this session was restored from (null when fresh). */
  getRestoredSnapshot(): unknown {
    return this.restoredFrom;
  }

  /** Attach the snapshot this session was restored from (store use). */
  attachRestoredSnapshot(snapshot: unknown): void {
    this.restoredFrom = snapshot;
  }

  /** The explicit v6 call state (what the panel shows). */
  getCallState(): VoiceCallState {
    return this.machine.getState();
  }

  isConnected(): boolean {
    return this.v4.isConnected();
  }

  getSessionId(): string {
    return this.v4.getSessionId();
  }

  getTurnCount(): number {
    return this.v4.getTurnCount();
  }

  getBargeInCount(): number {
    return this.v4.getBargeInCount();
  }

  sendAudio(frame: Uint8Array): void {
    this.v4.sendAudio(frame);
  }

  pushAudioFrame(frame: Uint8Array): void {
    this.v4.pushAudioFrame(frame);
  }

  commitAudio(): void {
    this.v4.commitAudio();
  }

  requestResponse(): void {
    this.v4.requestResponse();
  }

  sendToolResult(callId: string, output: string): void {
    this.v4.sendToolResult(callId, output);
  }

  startTalk(): boolean {
    return this.v4.startTalk();
  }

  endTalk(): boolean {
    return this.v4.endTalk();
  }

  setTurnMode(mode: Parameters<VoiceSessionV4['setTurnMode']>[0]): void {
    this.v4.setTurnMode(mode);
  }

  getLatencyReport(): ReturnType<VoiceSessionV4['getLatencyReport']> {
    return this.v4.getLatencyReport();
  }

  getV4Stats(): VoiceSessionV4Stats {
    return this.v4.getV4Stats();
  }

  getLongSessionTurns(): VoiceTurn[] {
    return this.v4.getLongSessionTurns();
  }

  noteUserTurn(text: string, mediaIds?: string[]): VoiceTurn | null {
    return this.v4.noteUserTurn(text, mediaIds);
  }

  noteModelSpeechStarted(partialText = ''): void {
    this.v4.noteModelSpeechStarted(partialText);
  }

  noteAudioFrameV4(input: { rms: number; vadActive?: boolean }): ReturnType<VoiceSessionV4['noteAudioFrameV4']> {
    return this.v4.noteAudioFrameV4(input);
  }

  interruptV4(): ReturnType<VoiceSessionV4['interruptV4']> {
    return this.v4.interruptV4();
  }

  /** Hand the v4 wrapper through (checkpoints, resume, media, latency). */
  getV4(): VoiceSessionV4 {
    return this.v4;
  }

  getStateMachine(): VoiceStateMachine {
    return this.machine;
  }

  getVoiceSwitchManager(): VoiceSwitchManager {
    return this.voices;
  }

  getNetworkGuard(): VoiceNetworkGuard {
    return this.guard;
  }

  // -- lifecycle ------------------------------------------------------------

  /**
   * Open the call. A failed dial goes through the network guard:
   * retryable failures retry with the guard's backoff (up to its
   * max attempts); an unretryable failure (e.g. auth) rejects at
   * once. A successful dial resets the guard's failure streak.
   */
  async connect(config: RealtimeConfig): Promise<void> {
    this.lastConfig = { ...config };
    // Most states go straight to `connecting`; a re-dial from a live
    // or degraded call goes via `reconnecting` (the only legal path
    // out of those states — see VOICE_CALL_TRANSITIONS).
    if (!this.machine.transition('connecting', 'connect').ok) {
      this.machine.transition('reconnecting', 'connect');
      this.machine.transition('connecting', 'connect');
    }
    let lastError: unknown = null;
    for (;;) {
      try {
        await this.v4.connect({ ...this.lastConfig });
        break;
      } catch (error) {
        lastError = error;
        const decision = this.guard.noteFailure(error);
        if (decision.action === 'give-up') {
          this.machine.transition('ended', 'connect-give-up');
          throw error instanceof Error ? error : new Error(String(error));
        }
        if (decision.action === 'degrade') {
          // Degraded mode keeps the call local: the session reports
          // the failure instead of hanging on a dead dial.
          this.machine.transition('degraded', 'connect-degraded');
          throw error instanceof Error ? error : new Error(String(error));
        }
        await this.retrySleep(decision.delayMs);
      }
    }
    this.lastSessionId = this.v4.getSessionId();
    this.guard.noteSuccess();
    this.machine.transition('listening', 'connected');
  }

  /**
   * Reconnect a dropped call with the last config (the tools'
   * `voice_v6_reconnect`). Returns the guard attempts spent.
   * A live call is a no-op returning 0.
   */
  async reconnect(): Promise<{ ok: boolean; attempts: number; error?: string }> {
    if (this.isConnected()) return { ok: true, attempts: 0 };
    if (!this.lastConfig) return { ok: false, attempts: 0, error: 'No previous config to reconnect with.' };
    if (this.machine.can('reconnecting')) this.machine.transition('reconnecting', 'reconnect');
    try {
      await this.connect(this.lastConfig);
      const attempts = this.guard.getStats().totalFailures;
      this.emit({ kind: 'voice-reconnected', attempts, at: this.clock() });
      return { ok: true, attempts };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emit({
        kind: 'voice-reconnect-failed',
        error: message,
        attempts: this.guard.getStats().totalFailures,
        at: this.clock(),
      });
      return { ok: false, attempts: this.guard.getStats().totalFailures, error: message };
    }
  }

  /** Hang up: the state machine ends, then the session dies. */
  disconnect(): void {
    this.machine.transition('ended', 'disconnect');
    this.v4.disconnect();
    this.machine.reset('disconnect');
  }

  dispose(): void {
    this.disconnect();
    this.v4.dispose();
  }

  // -- voice switching ------------------------------------------------------

  /** Switchable voices (current first). */
  listVoices(): VoiceProfile[] {
    return this.voices.listVoices();
  }

  getCurrentVoice(): VoiceProfile | null {
    return this.voices.getCurrent();
  }

  getCurrentVoiceId(): string | null {
    return this.voices.getCurrentId();
  }

  /**
   * Switch voice. Allowed any time: before the call it picks the
   * voice the call will use, mid-call it switches live (the new
   * profile's TTS options are what the call speaks with from here
   * on). The record says whether a call was live (`midCall`), so
   * the history tells a pre-call pick apart from a live switch.
   */
  switchVoice(profileId: string, reason = 'user pick'): VoiceSwitchResult {
    const live =
      this.machine.getState() === 'listening' ||
      this.machine.getState() === 'speaking' ||
      this.machine.getState() === 'interrupted' ||
      this.machine.getState() === 'reconnecting' ||
      this.machine.getState() === 'degraded';
    const result = this.voices.switchTo(profileId, { midCall: live, reason });
    if (!result.ok) return result;
    // The new profile's TTS options are what the live call speaks
    // with from here on; the transport reads them per utterance.
    return result;
  }

  /** Back to the voice before the last switch. */
  revertVoice(): VoiceSwitchResult {
    return this.voices.revert({ midCall: this.isConnected() });
  }

  getVoiceSwitchHistory(): VoiceSwitchRecord[] {
    return this.voices.getHistory();
  }

  // -- network --------------------------------------------------------------

  getNetworkStats(): ReturnType<VoiceNetworkGuard['getStats']> {
    return this.guard.getStats();
  }

  getNetworkDecisions(): VoiceNetworkDecision[] {
    return this.guard.getDecisions();
  }

  /** Run a recovery probe (see `VoiceNetworkGuard.probe`). */
  probeNetwork(check: () => boolean | Promise<boolean>): Promise<{ ok: boolean; decision: VoiceNetworkDecision | null }> {
    return this.guard.probe(check);
  }

  // -- stats ------------------------------------------------------------------

  getV6Stats(): VoiceSessionV6Stats {
    const v4 = this.v4.getV4Stats();
    const voice = this.voices.getStats();
    const current = this.voices.getCurrent();
    const machineStats = this.machine.getStats();
    return {
      callState: machineStats.state,
      msInState: machineStats.msInState,
      stateTransitions: machineStats.transitions,
      stateRejected: machineStats.rejected,
      stateForced: machineStats.forced,
      voice: {
        currentId: voice.currentId,
        currentName: current?.name ?? null,
        switches: voice.switches,
        reverts: voice.reverts,
        failures: voice.failures,
        midCallSwitches: voice.midCallSwitches,
      },
      network: this.guard.getStats(),
      v4,
    };
  }

  /** One-line summary for the panel / session log. */
  summary(): string {
    const stats = this.getV6Stats();
    return (
      `v6 call=${stats.callState} voice=${voiceSwitchSummary(this.voices)} ` +
      `network[${voiceNetworkSummary(this.guard)}] turns=${stats.v4.turns}`
    );
  }

  // -- internals ------------------------------------------------------------

  private handleV4Event(event: VoiceSessionV4Event): void {
    switch (event.kind) {
      case 'state': {
        const map: Record<RealtimeSessionState, VoiceCallState> = {
          idle: 'idle',
          connecting: 'connecting',
          listening: 'listening',
          speaking: 'speaking',
          interrupted: 'interrupted',
          reconnecting: 'reconnecting',
          closed: 'ended',
        };
        this.machine.transition(map[event.state], `session-state:${event.state}`);
        break;
      }
      case 'audio': {
        this.machine.transition('speaking', 'audio');
        break;
      }
      case 'turn': {
        if (event.speaker === 'model') this.machine.transition('listening', 'turn:model');
        break;
      }
      case 'interrupted': {
        this.machine.transition('interrupted', 'interrupted');
        break;
      }
      case 'reconnecting': {
        this.machine.transition('reconnecting', 'reconnecting');
        break;
      }
      case 'resumed': {
        this.guard.noteSuccess();
        this.machine.transition('listening', 'resumed');
        break;
      }
      case 'error': {
        const decision = this.guard.noteFailure(new Error(event.message));
        if (decision.action === 'give-up') {
          // The guard gave up retrying; the call stays where it is
          // (degraded or live) and the panel shows the give-up in
          // the network stats — v6 never kills a live call on one
          // error event, the transport decides that.
          void decision;
        }
        break;
      }
      default:
        break;
    }
    this.emit(event);
  }

  private emit(event: VoiceSessionV6Event): void {
    try {
      this.onEvent?.(event);
    } catch {
      // A throwing sink must not break the call.
    }
  }
}

/** Session id pattern (same shape as the v5 manager). */
export const VOICE_V6_SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Default mock reply delay (ms) for mock v6 sessions. */
export const VOICE_V6_MOCK_REPLY_DELAY_MS = 10;

export function createMockVoiceSessionV6(
  options: {
    sessionId?: string;
    provider?: 'openai' | 'gemini' | 'openai-compatible';
    initialVoiceId?: string;
    voices?: readonly VoiceProfile[];
    network?: VoiceNetworkGuardOptions;
    clock?: () => number;
    onEvent?: VoiceSessionV6EventSink;
    replyDelayMs?: number;
  } = {},
): VoiceSessionV6 {
  const provider = options.provider ?? 'openai';
  void options.sessionId;
  return new VoiceSessionV6({
    v4: {
      v3: {
        v2: {
          session: {
            provider,
            transportFactory: (cb) =>
              new MockRealtimeTransport(cb, { replyDelayMs: options.replyDelayMs ?? VOICE_V6_MOCK_REPLY_DELAY_MS }, provider),
          },
          longSession: { maxContextChars: 10_000 },
        },
        clock: options.clock,
        onEvent: undefined,
      },
      latencyMode: 'balanced',
      clock: options.clock,
      onEvent: undefined,
    },
    initialVoiceId: options.initialVoiceId,
    voices: options.voices,
    network: options.network,
    clock: options.clock,
    onEvent: options.onEvent,
  });
}

/**
 * In-memory registry the tools bind to: creates mock v6 sessions,
 * holds them by id, lists / removes them, switches voices and
 * reports network status. Everything is local: sessions run on
 * mock transports unless the host wires a live one; no key is ever
 * read here.
 */
export class VoiceV6Manager {
  private readonly sessions = new Map<string, VoiceSessionV6>();
  private readonly clock: () => number;

  constructor(options: { clock?: () => number } = {}) {
    this.clock = options.clock ?? Date.now;
  }

  createSession(
    id: string,
    options: {
      provider?: 'openai' | 'gemini' | 'openai-compatible';
      initialVoiceId?: string;
      network?: VoiceNetworkGuardOptions;
    } = {},
  ): VoiceSessionV6 {
    const cleanId = String(id ?? '').trim();
    if (!VOICE_V6_SESSION_ID_RE.test(cleanId)) {
      throw new Error(`Invalid voice v6 session id "${id}".`);
    }
    if (this.sessions.has(cleanId)) {
      throw new Error(`Voice v6 session "${cleanId}" already exists.`);
    }
    const session = createMockVoiceSessionV6({
      provider: options.provider,
      initialVoiceId: options.initialVoiceId,
      network: options.network,
      clock: this.clock,
    });
    this.sessions.set(cleanId, session);
    return session;
  }

  getSession(id: string): VoiceSessionV6 | undefined {
    return this.sessions.get(String(id ?? '').trim());
  }

  hasSession(id: string): boolean {
    return this.sessions.has(String(id ?? '').trim());
  }

  /** Disconnect + drop the session. False when there was none. */
  removeSession(id: string): boolean {
    const session = this.sessions.get(String(id ?? '').trim());
    if (!session) return false;
    try {
      session.disconnect();
    } catch {
      // Best-effort — the session is being dropped either way.
    }
    return this.sessions.delete(String(id ?? '').trim());
  }

  listSessions(): Array<{ id: string; callState: VoiceCallState; voiceId: string | null; connected: boolean }> {
    return [...this.sessions.entries()].map(([id, session]) => ({
      id,
      callState: session.getCallState(),
      voiceId: session.getCurrentVoiceId(),
      connected: session.isConnected(),
    }));
  }

  /** Switchable voices (the built-ins, current first is per-session). */
  listVoices(): VoiceProfile[] {
    return new VoiceSwitchManager({ clock: this.clock }).listVoices();
  }

  getStats(): { sessions: number; live: number; degraded: number; switches: number } {
    let live = 0;
    let degraded = 0;
    let switches = 0;
    for (const session of this.sessions.values()) {
      if (session.isConnected()) live += 1;
      if (session.getCallState() === 'degraded') degraded += 1;
      switches += session.getV6Stats().voice.switches;
    }
    return { sessions: this.sessions.size, live, degraded, switches };
  }
}
