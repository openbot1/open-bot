/**
 * Voice session v8 (v1.09, Đội T5 — voice realtime v8).
 *
 * Composition, not a rewrite: one `VoiceSessionV7` (v1.08 — the
 * durable long call: checkpoints + resume + media + graded
 * barge-in v7 + spectral VAD v7 + transcript stream) plus the
 * four v1.09 pieces around it:
 *
 *   - `AdaptiveVadV8` — spectral VAD (Goertzel bands + flatness
 *     + per-band floors + noise classification + dynamic
 *     hangover). The session feeds every mic frame to it; its
 *     speech-start / speech-end events drive the transcript
 *     phase and the barge-in's VAD input. Engine `'simple'`
 *     falls back to the energy VAD when spectral analysis is
 *     unavailable.
 *   - `BargeInV8Controller` — full-duplex barge-in with AEC-lite
 *     (echo subtraction from the playback reference), interrupt
 *     while thinking as well as while speaking, and a playback
 *     queue whose cancel returns an exact receipt (words / audio
 *     ms played vs discarded, cut word + audio offset). On
 *     `interrupt` the session cancels the TTS through the v7
 *     session and keeps the cut point in the durable snapshot.
 *   - `VoiceSessionV8Store` — the snapshot on disk (turns +
 *     voice + VAD config + cut point + reconnect budget),
 *     written atomically with a checksum. A dropped call
 *     restores from it instead of starting cold.
 *   - `ReconnectController` (v1.03) — the retry budget:
 *     capped attempts, exponential backoff + jitter, goAway as
 *     a planned reconnect. `reconnectNow` runs the loop around
 *     an injected `dial`; on success the session restores the
 *     snapshot and re-seeds the model with the resume
 *     instructions.
 *   - Input modes: `auto` (hands-free, VAD-gated) and
 *     `push-to-talk` (the mic only flows while the user holds
 *     the PTT button; releasing ends the turn). The UI status
 *     (`getStatus`) is one of idle / listening / thinking /
 *     speaking / reconnecting / disconnected, with the waveform
 *     level attached.
 *
 * Events: every `VoiceSessionV7` event is forwarded unchanged,
 * plus v8 kinds (`v8-vad`, `v8-barge-in`, `v8-duck`,
 * `v8-resumed`, `v8-status`, `v8-saved`, `v8-ptt`). All live
 * paths stay mock unless the caller passes a live transport
 * factory — v8 never dials anything itself.
 * `createMockVoiceSessionV8()` is the mock factory the session
 * manager and the tools use. `simulateTurn()` drives a scripted
 * mock turn so the panel and the tests can watch a call without
 * a provider.
 */
import type { RealtimeConfig } from './types';
import { isValidPcm16Frame, pcm16Rms } from './audio';
import {
  VoiceSessionV7,
  type VoiceSessionV7Event,
  type VoiceSessionV7Options,
  type VoiceSessionV7Stats,
  type VoiceSessionV7Summary,
} from './voiceSessionV7';
import {
  AdaptiveVadV8,
  SimpleEnergyVadV8,
  createVadV8,
  type AdaptiveVadV8Options,
  type VadV8Config,
  type VadV8Event,
  type VadV8PresetName,
  type VadV8Stats,
} from './vadV8';
import {
  BargeInV8Controller,
  type BargeInV8Decision,
  type BargeInV8InterruptResult,
  type BargeInV8Options,
  type BargeInV8Stats,
} from './bargeInV8';
import {
  ReconnectController,
  RESILIENCE_DEFAULT_MAX_ATTEMPTS,
  RESILIENCE_DEFAULT_BASE_DELAY_MS,
  RESILIENCE_DEFAULT_MAX_DELAY_MS,
  type ReconnectStats,
} from './sessionResilience';
import {
  VoiceSessionV8Store,
  buildVoiceSessionV8ResumeInstructions,
  createVoiceSessionV8Snapshot,
  voiceSessionV8SnapshotMarkdown,
  type VoiceSessionV8CutPoint,
  type VoiceSessionV8Snapshot,
  type VoiceSessionV8Turn,
} from './voiceSessionV8Store';
import type { VoiceCallState } from './voiceStateMachine';
import type { VoiceProfile } from './voiceProfiles';
import { MockRealtimeTransport } from './mockTransport';
import { VoiceSwitchManager } from './voiceSwitch';

/** UI status of a v8 voice session (what the panel renders). */
export type VoiceSessionV8Status =
  | 'idle'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'reconnecting'
  | 'disconnected';

/** Input mode: hands-free VAD or hold-to-talk. */
export type VoiceSessionV8InputMode = 'auto' | 'push-to-talk';

/** Extra events the v8 wrapper emits (on top of the v7 events). */
export type VoiceSessionV8Event =
  | VoiceSessionV7Event
  | VadV8Event
  | { kind: 'v8-barge-in'; decision: BargeInV8Decision; result: BargeInV8InterruptResult }
  | { kind: 'v8-duck'; decision: BargeInV8Decision }
  | { kind: 'v8-resumed'; snapshot: VoiceSessionV8Snapshot; resumeInstructions: string; at: number }
  | { kind: 'v8-status'; status: VoiceSessionV8Status; at: number }
  | { kind: 'v8-saved'; path: string; turns: number; bytes: number; at: number }
  | { kind: 'v8-ptt'; pressed: boolean; at: number };

export type VoiceSessionV8EventSink = (event: VoiceSessionV8Event) => void;

/** Stats for the panel / diagnostics / tools. */
export interface VoiceSessionV8Stats {
  status: VoiceSessionV8Status;
  inputMode: VoiceSessionV8InputMode;
  pttPressed: boolean;
  callState: VoiceCallState;
  phase: string;
  startedAtMs: number | null;
  durationMs: number;
  vad: VadV8Stats;
  bargeIn: BargeInV8Stats;
  reconnect: ReconnectStats;
  transcript: VoiceSessionV7Stats['transcript'];
  v7: VoiceSessionV7Stats;
  /** Waveform level (latest mic RMS, 0..1). */
  level: number;
  /** Turns recorded in this session. */
  turns: number;
  /** True when a durable snapshot exists on disk. */
  snapshotSaved: boolean;
  /** Last cut point (null when the last reply finished). */
  lastCutPoint: VoiceSessionV8CutPoint | null;
  restoredFrom: boolean;
}

/** One row for the session panel (list of sessions). */
export interface VoiceSessionV8Summary extends VoiceSessionV7Summary {
  status: VoiceSessionV8Status;
  inputMode: VoiceSessionV8InputMode;
  vadEngine: string;
  vadPreset: string;
  reconnects: number;
  snapshotSaved: boolean;
}

export interface VoiceSessionV8Options {
  /** Options for the inner `VoiceSessionV7`. */
  v7: VoiceSessionV7Options;
  /** Session id (default: `v8-<clock>`; the manager overrides it). */
  sessionId?: string;
  /** VAD v8 options. */
  vad?: AdaptiveVadV8Options;
  /** Barge-in v8 options. */
  bargeIn?: BargeInV8Options;
  /** Input mode (default 'auto'). */
  inputMode?: VoiceSessionV8InputMode;
  /** Directory for the durable snapshot (omit = memory only). */
  storeDir?: string;
  /** Max reconnect attempts per drop (default 5). */
  maxReconnectAttempts?: number;
  /** First reconnect delay (ms, default 1000). */
  reconnectBaseDelayMs?: number;
  /** Reconnect delay cap (ms, default 10000). */
  reconnectMaxDelayMs?: number;
  /** ms between streamed mock-reply words (simulateTurn). Default 40. */
  mockWordDelayMs?: number;
  /** Sleep used by simulateTurn / reconnectNow (tests inject a no-op). */
  sleepMs?: (ms: number) => Promise<void>;
  /** Inject the clock (tests). Defaults to Date.now. */
  clock?: () => number;
  /** Event sink (v7 events + v8 events). */
  onEvent?: VoiceSessionV8EventSink;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  });

/** Default mock reply (scripted) when simulateTurn gets no reply text. */
export const VOICE_V8_DEFAULT_MOCK_REPLY =
  'Hello, this is a mock voice reply from the v8 session. The transcript streams word by word so the panel can show it live.';
/** Default base instructions used for the resume prompt. */
export const VOICE_V8_DEFAULT_BASE_INSTRUCTIONS =
  'You are open-bot, a helpful voice assistant. Answer concisely, in the language the user speaks.';
/** Session id pattern (same shape as the v7 manager). */
export const VOICE_V8_SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export class VoiceSessionV8 {
  private readonly v7: VoiceSessionV7;
  private readonly vad: AdaptiveVadV8 | SimpleEnergyVadV8;
  private readonly bargeIn: BargeInV8Controller;
  private readonly reconnect: ReconnectController;
  private readonly store: VoiceSessionV8Store | null;
  private readonly onEvent: VoiceSessionV8EventSink | undefined;
  private readonly clock: () => number;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly mockWordDelayMs: number;
  private readonly sessionId: string;
  private inputMode: VoiceSessionV8InputMode;
  private pttPressed = false;
  private startedAtMs: number | null = null;
  private simulating = false;
  private lastConfig: RealtimeConfig | null = null;
  private lastCutPoint: VoiceSessionV8CutPoint | null = null;
  private turns: VoiceSessionV8Turn[] = [];
  private restoredFrom: VoiceSessionV8Snapshot | null = null;
  private snapshotSaved = false;
  private level = 0;
  private lastStatus: VoiceSessionV8Status = 'idle';
  private reconnecting = false;

  constructor(options: VoiceSessionV8Options) {
    this.clock = options.clock ?? Date.now;
    this.sleepFn = options.sleepMs ?? sleep;
    this.mockWordDelayMs = Math.max(0, options.mockWordDelayMs ?? 40);
    this.onEvent = options.onEvent;
    this.inputMode = options.inputMode ?? 'auto';
    this.store = options.storeDir ? new VoiceSessionV8Store({ dir: options.storeDir, clock: this.clock }) : null;
    this.sessionId = options.sessionId ?? `v8-${Math.floor(this.clock())}`;
    this.vad = createVadV8({
      ...(options.vad ?? {}),
      sink: (e) => this.emit(e),
    });
    this.bargeIn = new BargeInV8Controller({ ...(options.bargeIn ?? {}), clock: this.clock });
    this.reconnect = new ReconnectController({
      maxAttempts: options.maxReconnectAttempts ?? RESILIENCE_DEFAULT_MAX_ATTEMPTS,
      baseDelayMs: options.reconnectBaseDelayMs ?? RESILIENCE_DEFAULT_BASE_DELAY_MS,
      maxDelayMs: options.reconnectMaxDelayMs ?? RESILIENCE_DEFAULT_MAX_DELAY_MS,
      clock: this.clock,
      onEvent: (e) => this.emit(e as unknown as VoiceSessionV8Event),
    });
    this.v7 = new VoiceSessionV7({
      ...options.v7,
      clock: this.clock,
      onEvent: (e) => this.emit(e),
    });
  }

  // -- identity / passthroughs ----------------------------------------------

  getSessionId(): string {
    return this.sessionId;
  }

  getCallState(): VoiceCallState {
    return this.v7.getCallState();
  }

  getPhase(): string {
    return this.v7.getPhase();
  }

  isConnected(): boolean {
    return this.v7.isConnected();
  }

  getProvider(): string {
    return this.v7.getProvider();
  }

  getTurnCount(): number {
    return this.turns.length;
  }

  getCurrentVoiceId(): string | null {
    return this.v7.getCurrentVoiceId();
  }

  getCurrentVoice(): VoiceProfile | null {
    return this.v7.getCurrentVoice();
  }

  listVoices(): VoiceProfile[] {
    return this.v7.listVoices();
  }

  switchVoice(profileId: string, reason = 'user pick'): ReturnType<VoiceSessionV7['switchVoice']> {
    return this.v7.switchVoice(profileId, reason);
  }

  revertVoice(): ReturnType<VoiceSessionV7['revertVoice']> {
    return this.v7.revertVoice();
  }

  getVad(): AdaptiveVadV8 | SimpleEnergyVadV8 {
    return this.vad;
  }

  getBargeIn(): BargeInV8Controller {
    return this.bargeIn;
  }

  getReconnect(): ReconnectController {
    return this.reconnect;
  }

  getStore(): VoiceSessionV8Store | null {
    return this.store;
  }

  getRestoredSnapshot(): VoiceSessionV8Snapshot | null {
    return this.restoredFrom;
  }

  getLastCutPoint(): VoiceSessionV8CutPoint | null {
    return this.lastCutPoint ? { ...this.lastCutPoint } : null;
  }

  getTurns(): VoiceSessionV8Turn[] {
    return this.turns.map((t) => ({ ...t }));
  }

  /** The UI status: listening / thinking / speaking / reconnecting / disconnected / idle. */
  getStatus(): VoiceSessionV8Status {
    if (this.reconnecting || this.reconnect.getState() === 'reconnecting') return 'reconnecting';
    if (!this.isConnected()) {
      return this.startedAtMs === null ? 'idle' : 'disconnected';
    }
    const phase = this.v7.getPhase();
    if (phase === 'speaking') return 'speaking';
    if (phase === 'thinking') return 'thinking';
    return 'listening';
  }

  getInputMode(): VoiceSessionV8InputMode {
    return this.inputMode;
  }

  setInputMode(mode: VoiceSessionV8InputMode): VoiceSessionV8InputMode {
    if (mode !== 'auto' && mode !== 'push-to-talk') {
      throw new Error(`VoiceSessionV8: inputMode must be "auto" or "push-to-talk", got "${String(mode)}".`);
    }
    this.inputMode = mode;
    if (mode === 'auto') this.pttPressed = false;
    this.saveSnapshot();
    return this.inputMode;
  }

  isPttPressed(): boolean {
    return this.pttPressed;
  }

  getLevel(): number {
    return this.level;
  }

  // -- connect / disconnect ---------------------------------------------------

  async connect(config: RealtimeConfig): Promise<void> {
    this.lastConfig = config;
    await this.v7.connect(config);
    if (this.startedAtMs === null) this.startedAtMs = this.clock();
    this.reconnect.noteConnected();
    this.emitStatus();
    this.saveSnapshot();
  }

  disconnect(): void {
    this.saveSnapshot(true);
    this.vad.flush();
    this.v7.disconnect();
    this.bargeIn.reset();
    this.emitStatus();
  }

  dispose(): void {
    this.disconnect();
    this.v7.dispose();
  }

  // -- push-to-talk -----------------------------------------------------------

  /** Hold the PTT button: mic frames flow until released. */
  pressPtt(): void {
    if (this.inputMode !== 'push-to-talk') return;
    if (this.pttPressed) return;
    this.pttPressed = true;
    this.emit({ kind: 'v8-ptt', pressed: true, at: this.clock() });
  }

  /** Release the PTT button: the turn ends (flush the VAD). */
  releasePtt(): void {
    if (this.inputMode !== 'push-to-talk') return;
    if (!this.pttPressed) return;
    this.pttPressed = false;
    this.vad.flush();
    this.emit({ kind: 'v8-ptt', pressed: false, at: this.clock() });
  }

  // -- audio in (mic + playback reference) ------------------------------------

  /** Feed the playback reference (what the speaker is playing now) for the AEC. */
  notePlaybackFrame(frame: Uint8Array): void {
    this.bargeIn.notePlaybackFrame(frame);
  }

  /**
   * One mic frame (PCM16). Feeds the VAD v8 (speech detection +
   * confidence) and the barge-in v8 controller (AEC residual +
   * duck / interrupt while the model speaks or thinks). In
   * push-to-talk mode frames are dropped unless PTT is held. A
   * confirmed interrupt cancels the TTS through the v7 session,
   * keeps the cut point, and saves the snapshot. Returns the
   * barge-in decision (null when the model is not speaking/thinking
   * or the frame was dropped).
   */
  async feedAudioFrame(frame: Uint8Array): Promise<BargeInV8Decision | null> {
    if (!isValidPcm16Frame(frame)) {
      throw new Error('VoiceSessionV8: frame must be a non-empty even-length PCM16 buffer.');
    }
    this.level = pcm16Rms(frame);
    if (this.inputMode === 'push-to-talk' && !this.pttPressed) return null;
    const features = this.vad.feed(frame);
    const vadActive = this.vad.isSpeaking();
    if (!this.bargeIn.isModelSpeaking() && !this.bargeIn.isModelThinking()) {
      // Still feed the v7 path so its VAD/transcript stay in sync.
      await this.v7.feedAudioFrame(frame);
      return null;
    }
    const decision = this.bargeIn.noteAudioFrame({ frame, vadActive, confidence: features.confidence });
    if (decision.action === 'duck') {
      this.emit({ kind: 'v8-duck', decision });
      return decision;
    }
    if (decision.action === 'interrupt') {
      const result = await this.interrupt();
      this.emit({ kind: 'v8-barge-in', decision, result });
      return decision;
    }
    return decision;
  }

  // -- transcript in ----------------------------------------------------------

  noteUserText(text: string, options: { final?: boolean; confidence?: number } = {}): void {
    const line = this.v7.noteUserText(text, options);
    if (options.final !== false && text.trim().length > 0) {
      this.turns.push({ speaker: 'user', text: text.trim(), atMs: this.elapsedMs() });
      this.saveSnapshot();
    }
    void line;
  }

  noteModelText(text: string, options: { final?: boolean; confidence?: number } = {}): void {
    this.v7.noteModelText(text, options);
    if (options.final === true && text.trim().length > 0) {
      this.turns.push({ speaker: 'agent', text: text.trim(), atMs: this.elapsedMs() });
      this.lastCutPoint = null;
      this.saveSnapshot();
    }
  }

  /** Cancel the TTS now (v8 interrupt with the exact receipt). */
  async interrupt(): Promise<BargeInV8InterruptResult> {
    const result = await this.bargeIn.requestInterrupt({
      stop: async () => {
        await this.v7.interrupt();
      },
    });
    this.lastCutPoint = {
      wordsPlayed: result.wordsPlayed,
      audioPlayedMs: result.audioPlayedMs,
      spokenText: result.spokenText,
      remainingText: result.remainingText,
      cutWordIndex: result.cutWordIndex,
    };
    const lastAgent = [...this.turns].reverse().find((t) => t.speaker === 'agent');
    if (lastAgent && result.spokenText) {
      lastAgent.interrupted = true;
      lastAgent.cutWordIndex = result.cutWordIndex;
      lastAgent.text = result.spokenText;
    }
    this.saveSnapshot();
    this.emitStatus();
    return result;
  }

  /** Resume the cut reply from the cut word. */
  resumeRemaining(): { resumed: boolean; text: string; words: number } {
    const resumed = this.bargeIn.resumeRemaining();
    if (resumed.resumed) {
      this.lastCutPoint = null;
      this.saveSnapshot();
    }
    return resumed;
  }

  getResumePrompt(): string {
    return this.v7.getResumePrompt();
  }

  // -- mock turns ---------------------------------------------------------------

  async simulateTurn(
    userText: string,
    modelReply: string = VOICE_V8_DEFAULT_MOCK_REPLY,
  ): Promise<boolean> {
    if (this.simulating) return false;
    this.simulating = true;
    try {
      this.noteUserText(userText, { final: true });
      this.bargeIn.noteThinkingStarted();
      this.emitStatus();
      await this.sleepFn(this.mockWordDelayMs);
      // The model starts speaking: barge-in watches from here.
      this.bargeIn.noteModelSpeechStarted(modelReply);
      this.emitStatus();
      const words = modelReply.split(/\s+/).filter((w) => w.length > 0);
      for (let i = 0; i < words.length; i += 1) {
        if (this.bargeIn.getState() === 'interrupted' || this.bargeIn.getState() === 'cooldown') break;
        this.bargeIn.noteWordPlayed(i);
        this.v7.noteModelText(words[i] as string, { final: false });
        await this.sleepFn(this.mockWordDelayMs);
      }
      const interrupted = this.bargeIn.getState() === 'interrupted' || this.bargeIn.getState() === 'cooldown';
      if (!interrupted) {
        this.bargeIn.noteModelSpeechEnded();
        this.noteModelText(modelReply, { final: true });
      } else {
        // The interrupted agent line keeps the spoken prefix.
        const spoken = this.bargeIn.getQueue().getSpokenText();
        if (spoken) {
          this.turns.push({ speaker: 'agent', text: spoken, atMs: this.elapsedMs(), interrupted: true, cutWordIndex: this.lastCutPoint?.cutWordIndex });
        }
        this.saveSnapshot();
      }
      this.emitStatus();
      return true;
    } finally {
      this.simulating = false;
    }
  }

  isSimulating(): boolean {
    return this.simulating;
  }

  // -- VAD config ---------------------------------------------------------------

  setVadPreset(preset: VadV8PresetName): VadV8Config {
    const cfg = this.vad.setPreset(preset);
    this.saveSnapshot();
    return cfg;
  }

  updateVadOptions(patch: Parameters<AdaptiveVadV8['updateOptions']>[0]): VadV8Config {
    const cfg = this.vad.updateOptions(patch);
    this.saveSnapshot();
    return cfg;
  }

  calibrateVad(durationMs?: number): void {
    this.vad.startCalibration(durationMs);
  }

  // -- reconnect + resume -------------------------------------------------------

  /**
   * The socket dropped. Records the drop, saves the snapshot, and
   * returns the reconnect decision (retry with delay, or give up).
   */
  noteDisconnected(error: Error | string, opts: { terminal?: boolean } = {}): {
    retry: boolean;
    delayMs: number;
    attempt: number;
  } {
    this.saveSnapshot();
    const decision = this.reconnect.noteDisconnected(error, opts);
    this.reconnecting = decision.retry;
    this.emitStatus();
    return decision;
  }

  /** The server said goAway (planned reconnect, budget untouched). */
  noteGoAway(timeLeftSec: number | null): number {
    return this.reconnect.noteGoAway(timeLeftSec);
  }

  /**
   * Reconnect loop: dial, wait, retry until the budget is spent.
   * `dial` must connect the transport and resolve true on success
   * (the mock dial in tests just resolves true). On success the
   * snapshot is restored and the resume instructions are emitted
   * (`v8-resumed`) so the model picks up where the call left off.
   * Returns whether the call is live again.
   */
  async reconnectNow(dial: () => Promise<boolean> | boolean): Promise<{
    ok: boolean;
    attempts: number;
    restored: boolean;
    resumeInstructions: string;
  }> {
    let attempts = 0;
    for (;;) {
      let ok = false;
      try {
        ok = await dial();
      } catch {
        ok = false;
      }
      attempts += 1;
      if (ok) {
        this.reconnecting = false;
        this.reconnect.noteConnected();
        const restored = this.restoreFromDisk();
        const instructions = restored
          ? buildVoiceSessionV8ResumeInstructions(restored, VOICE_V8_DEFAULT_BASE_INSTRUCTIONS)
          : '';
        if (restored) {
          this.emit({ kind: 'v8-resumed', snapshot: restored, resumeInstructions: instructions, at: this.clock() });
        }
        this.emitStatus();
        return { ok: true, attempts, restored: restored !== null, resumeInstructions: instructions };
      }
      const decision = this.reconnect.noteDisconnected('reconnect dial failed');
      if (!decision.retry) {
        this.reconnecting = false;
        this.emitStatus();
        return { ok: false, attempts, restored: false, resumeInstructions: '' };
      }
      await this.sleepFn(decision.delayMs);
    }
  }

  /** Restore the snapshot from disk into this session (null when none/invalid). */
  restoreFromDisk(): VoiceSessionV8Snapshot | null {
    if (!this.store) return null;
    const loaded = this.store.load(this.sessionId);
    if (!loaded.ok) return null;
    this.applySnapshot(loaded.snapshot);
    return loaded.snapshot;
  }

  /** Apply a snapshot to this live session (turns + voice + VAD + cut point). */
  applySnapshot(snapshot: VoiceSessionV8Snapshot): void {
    this.restoredFrom = snapshot;
    this.turns = snapshot.turns.map((t) => ({ ...t }));
    this.lastCutPoint = snapshot.cutPoint ? { ...snapshot.cutPoint } : null;
    this.inputMode = snapshot.inputMode;
    try {
      this.vad.setPreset(snapshot.vadPreset as VadV8PresetName);
    } catch {
      // Unknown preset in an old snapshot: keep the current one.
    }
    if (snapshot.voiceId) {
      try {
        this.v7.switchVoice(snapshot.voiceId, 'restore');
      } catch {
        // Voice no longer exists: keep the current one.
      }
    }
  }

  // -- persistence ----------------------------------------------------------------

  /** Build the current snapshot (turns + voice + VAD + cut point + reconnect budget). */
  buildSnapshot(cleanShutdown = false): VoiceSessionV8Snapshot {
    const v7stats = this.v7.getV7Stats();
    const reconnectStats = this.reconnect.getStats();
    const vadCfg = this.vad.getConfig();
    const voice = this.v7.getCurrentVoice();
    const snapshot = createVoiceSessionV8Snapshot({
      sessionId: this.sessionId,
      provider: this.v7.getProvider(),
      voiceId: this.v7.getCurrentVoiceId(),
      voiceName: voice?.name ?? null,
      vadPreset: vadCfg.preset,
      vadEngine: vadCfg.engine,
      bargeInSensitivity: this.bargeIn.getSensitivity(),
      inputMode: this.inputMode,
      nowMs: this.clock(),
    });
    snapshot.createdAtMs = this.startedAtMs ?? this.clock();
    snapshot.updatedAtMs = this.clock();
    snapshot.durationMs = this.startedAtMs === null ? 0 : Math.max(0, this.clock() - this.startedAtMs);
    snapshot.turns = this.turns.map((t) => ({ ...t }));
    snapshot.cutPoint = this.lastCutPoint ? { ...this.lastCutPoint } : null;
    snapshot.reconnectAttempts = reconnectStats.attempts;
    snapshot.reconnects = reconnectStats.reconnects;
    snapshot.totalDowntimeMs = reconnectStats.totalDowntimeMs;
    snapshot.cleanShutdown = cleanShutdown;
    void v7stats;
    return snapshot;
  }

  /** Save the snapshot to disk (no-op without a store dir). Returns the path or null. */
  saveSnapshot(cleanShutdown = false): string | null {
    if (!this.store) return null;
    const snapshot = this.buildSnapshot(cleanShutdown);
    const result = this.store.save(snapshot);
    if (result.ok) {
      this.snapshotSaved = true;
      this.emit({ kind: 'v8-saved', path: result.path, turns: result.turns, bytes: result.bytes, at: this.clock() });
      return result.path;
    }
    return null;
  }

  snapshotMarkdown(): string {
    return voiceSessionV8SnapshotMarkdown(this.buildSnapshot());
  }

  // -- stats ------------------------------------------------------------------------

  getV8Stats(): VoiceSessionV8Stats {
    const v7stats = this.v7.getV7Stats();
    const now = this.clock();
    return {
      status: this.getStatus(),
      inputMode: this.inputMode,
      pttPressed: this.pttPressed,
      callState: v7stats.callState,
      phase: v7stats.phase,
      startedAtMs: this.startedAtMs,
      durationMs: this.startedAtMs === null ? 0 : Math.max(0, now - this.startedAtMs),
      vad: this.vad.getStats(),
      bargeIn: this.bargeIn.getStats(),
      reconnect: this.reconnect.getStats(),
      transcript: v7stats.transcript,
      v7: v7stats,
      level: this.level,
      turns: this.turns.length,
      snapshotSaved: this.snapshotSaved,
      lastCutPoint: this.lastCutPoint ? { ...this.lastCutPoint } : null,
      restoredFrom: this.restoredFrom !== null,
    };
  }

  getSummary(): VoiceSessionV8Summary {
    const v7summary = this.v7.getSummary();
    const vadCfg = this.vad.getConfig();
    const reconnectStats = this.reconnect.getStats();
    return {
      ...v7summary,
      id: this.sessionId,
      status: this.getStatus(),
      inputMode: this.inputMode,
      vadEngine: vadCfg.engine,
      vadPreset: vadCfg.preset,
      reconnects: reconnectStats.reconnects,
      snapshotSaved: this.snapshotSaved,
      restoredFrom: this.restoredFrom !== null,
    };
  }

  summary(): string {
    const stats = this.getV8Stats();
    return (
      `v8 status=${stats.status} mode=${stats.inputMode} ` +
      `vad=${stats.vad.engine}/${stats.vad.preset} (flat ${stats.vad.spectralFlatness.toFixed(2)}, ${stats.vad.noiseKind}, fp ${stats.vad.falsePositives}) ` +
      `barge-in=${stats.bargeIn.interrupts} int (${stats.bargeIn.thinkingInterrupts} thinking) / ${stats.bargeIn.ducks} duck / echo-only ${stats.bargeIn.echoOnlyFrames} ` +
      `reconnects=${stats.reconnect.reconnects} turns=${stats.turns} snapshot=${stats.snapshotSaved ? 'saved' : 'memory-only'}`
    );
  }

  // -- internals ----------------------------------------------------------------------

  private elapsedMs(): number {
    return this.startedAtMs === null ? 0 : Math.max(0, this.clock() - this.startedAtMs);
  }

  private emitStatus(): void {
    const status = this.getStatus();
    if (status !== this.lastStatus) {
      this.lastStatus = status;
      this.emit({ kind: 'v8-status', status, at: this.clock() });
    }
  }

  private emit(event: VoiceSessionV8Event): void {
    try {
      this.onEvent?.(event);
    } catch {
      // A throwing sink must not break the call.
    }
  }
}

/** Mock factory (no provider, no network) — the manager and the tools use this. */
export function createMockVoiceSessionV8(
  options: {
    sessionId?: string;
    provider?: 'openai' | 'gemini' | 'openai-compatible';
    initialVoiceId?: string;
    voices?: readonly VoiceProfile[];
    vadPreset?: VadV8PresetName;
    inputMode?: VoiceSessionV8InputMode;
    storeDir?: string;
    clock?: () => number;
    onEvent?: VoiceSessionV8EventSink;
    mockWordDelayMs?: number;
    sleepMs?: (ms: number) => Promise<void>;
  } = {},
): VoiceSessionV8 {
  const provider = options.provider ?? 'openai';
  const session = new VoiceSessionV8({
    sessionId: options.sessionId,
    v7: {
      v6: {
        v4: {
          v3: {
            v2: {
              session: {
                provider,
                transportFactory: (cb) =>
                  new MockRealtimeTransport(cb, { replyDelayMs: 10 }, provider),
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
        clock: options.clock,
        onEvent: undefined,
      },
      vad: { preset: 'office' },
      clock: options.clock,
      mockWordDelayMs: options.mockWordDelayMs,
      sleepMs: options.sleepMs,
      onEvent: undefined,
    },
    vad: { preset: options.vadPreset ?? 'office' },
    inputMode: options.inputMode ?? 'auto',
    storeDir: options.storeDir,
    clock: options.clock,
    mockWordDelayMs: options.mockWordDelayMs,
    sleepMs: options.sleepMs,
    onEvent: options.onEvent,
  });
  return session;
}

/**
 * In-memory registry the tools bind to: creates mock v8 sessions,
 * holds them by id, lists / removes them, restores them from disk,
 * and reports totals. Everything is local: sessions run on mock
 * transports unless the host wires a live one; no key is ever read.
 */
export class VoiceV8Manager {
  private readonly sessions = new Map<string, VoiceSessionV8>();
  private readonly clock: () => number;
  private readonly storeDir: string | undefined;

  constructor(options: { clock?: () => number; storeDir?: string } = {}) {
    this.clock = options.clock ?? Date.now;
    this.storeDir = options.storeDir;
  }

  createSession(
    id: string,
    options: {
      provider?: 'openai' | 'gemini' | 'openai-compatible';
      initialVoiceId?: string;
      vadPreset?: VadV8PresetName;
      inputMode?: VoiceSessionV8InputMode;
    } = {},
  ): VoiceSessionV8 {
    const cleanId = String(id ?? '').trim();
    if (!VOICE_V8_SESSION_ID_RE.test(cleanId)) {
      throw new Error(`Invalid voice v8 session id "${id}".`);
    }
    if (this.sessions.has(cleanId)) {
      throw new Error(`Voice v8 session "${cleanId}" already exists.`);
    }
    const session = createMockVoiceSessionV8({
      sessionId: cleanId,
      provider: options.provider,
      initialVoiceId: options.initialVoiceId,
      vadPreset: options.vadPreset,
      inputMode: options.inputMode,
      storeDir: this.storeDir,
      clock: this.clock,
    });
    this.sessions.set(cleanId, session);
    return session;
  }

  /** Create a session and restore its snapshot from disk (null snapshot = fresh). */
  restoreSession(
    id: string,
    options: {
      provider?: 'openai' | 'gemini' | 'openai-compatible';
      initialVoiceId?: string;
      vadPreset?: VadV8PresetName;
      inputMode?: VoiceSessionV8InputMode;
    } = {},
  ): { session: VoiceSessionV8; restored: VoiceSessionV8Snapshot | null } {
    const session = this.createSession(id, options);
    const restored = session.restoreFromDisk();
    return { session, restored };
  }

  getSession(id: string): VoiceSessionV8 | undefined {
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

  listSessions(): VoiceSessionV8Summary[] {
    return [...this.sessions.entries()].map(([id, session]) => ({
      ...session.getSummary(),
      id,
    }));
  }

  /** Switchable voices (the built-ins, current first is per-session). */
  listVoices(): VoiceProfile[] {
    return new VoiceSwitchManager({ clock: this.clock }).listVoices();
  }

  getStats(): {
    sessions: number;
    live: number;
    reconnecting: number;
    interrupts: number;
    thinkingInterrupts: number;
    ducks: number;
    echoOnlyFrames: number;
    inputTokens: number;
    outputTokens: number;
    lines: number;
    turns: number;
  } {
    let live = 0;
    let reconnecting = 0;
    let interrupts = 0;
    let thinkingInterrupts = 0;
    let ducks = 0;
    let echoOnlyFrames = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let lines = 0;
    let turns = 0;
    for (const session of this.sessions.values()) {
      if (session.isConnected()) live += 1;
      if (session.getStatus() === 'reconnecting') reconnecting += 1;
      const stats = session.getV8Stats();
      interrupts += stats.bargeIn.interrupts;
      thinkingInterrupts += stats.bargeIn.thinkingInterrupts;
      ducks += stats.bargeIn.ducks;
      echoOnlyFrames += stats.bargeIn.echoOnlyFrames;
      inputTokens += stats.transcript.inputTokens;
      outputTokens += stats.transcript.outputTokens;
      lines += stats.transcript.lines;
      turns += stats.turns;
    }
    return { sessions: this.sessions.size, live, reconnecting, interrupts, thinkingInterrupts, ducks, echoOnlyFrames, inputTokens, outputTokens, lines, turns };
  }
}
